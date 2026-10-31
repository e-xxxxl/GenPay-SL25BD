// controllers/adminPaymentController.js
// Back-office view of payments: anything money-related that needs a person, lookup by
// reference/email for support, and tools to retry or re-sweep Paystack.
const Order = require('../models/order');
const PaymentLog = require('../models/paymentLog');
const Ticket = require('../models/ticket');
const Transaction = require('../models/transaction');
const paystack = require('../services/paystack');
const reconcile = require('../services/reconcileService');

const STUCK_MS = 5 * 60 * 1000;
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Orders where money was (or may have been) taken but the buyer does not have working tickets.
const attentionFilter = (now = Date.now()) => ({
  $or: [
    { status: { $in: ['mismatch', 'unfulfillable'] } },
    { paystackStatus: 'success', status: { $ne: 'completed' } },
    { status: 'processing', lockedAt: { $lt: new Date(now - STUCK_MS) } },
    { status: 'completed', emailSentAt: null, emailAttempts: { $gte: 5 } },
  ],
});
const unmatchedFilter = { status: { $in: ['needs_action', 'unresolved'] } };

const fail = (res, error, message, code = 500) => {
  console.error(message, error?.message || error);
  return res.status(code).json({ status: 'error', message });
};

const describe = (order) => ({
  reference: order.reference,
  status: order.status,
  provider: order.provider,
  email: order.email,
  event: order.event?.eventName || null,
  eventId: order.event?._id || order.event || null,
  tickets: (order.lines || []).reduce((sum, line) => sum + (line.quantity || 0), 0),
  total: order.total,
  amountKobo: order.amountKobo,
  paystackStatus: order.paystackStatus || null,
  reason: order.failureReason || order.lastError || null,
  legacy: Boolean(order.legacy),
  emailed: Boolean(order.emailSentAt),
  createdAt: order.createdAt,
  completedAt: order.completedAt || null,
});

// GET /api/admin/payments/summary
exports.summary = async (req, res) => {
  try {
    const [attention, unmatched] = await Promise.all([Order.countDocuments(attentionFilter()), PaymentLog.countDocuments(unmatchedFilter)]);
    res.status(200).json({ status: 'success', data: { attention, unmatched } });
  } catch (error) {
    fail(res, error, 'Failed to load payment summary');
  }
};

// GET /api/admin/payments/orders?view=attention|all&q=&page=&limit=
exports.listOrders = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
    const base = req.query.view === 'all' ? {} : attentionFilter();
    const q = String(req.query.q || '').trim().slice(0, 100);
    const rx = q ? new RegExp(escapeRegex(q), 'i') : null;
    const filter = rx ? { $and: [base, { $or: [{ reference: rx }, { email: rx }] }] } : base;

    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('event', 'eventName').lean(),
      Order.countDocuments(filter),
    ]);
    res.status(200).json({
      status: 'success',
      data: { orders: orders.map(describe), total, totalPages: Math.max(Math.ceil(total / limit), 1), currentPage: page },
    });
  } catch (error) {
    fail(res, error, 'Failed to load payments');
  }
};

// GET /api/admin/payments/orders/:reference  (everything support needs about one payment)
exports.getOrder = async (req, res) => {
  try {
    const reference = String(req.params.reference).slice(0, 100);
    const [order, log] = await Promise.all([
      Order.findOne({ reference }).populate('event', 'eventName startDateTime').lean(),
      PaymentLog.findOne({ reference }).lean(),
    ]);
    if (!order && !log) return res.status(404).json({ status: 'fail', message: 'No payment found with this reference.' });

    const [tickets, transaction] = order
      ? await Promise.all([
          Ticket.find({ _id: { $in: order.ticketIds || [] } }).populate('buyer', 'firstName lastName email').select('ticketId name price isUsed buyer').lean(),
          order.transaction ? Transaction.findById(order.transaction).lean() : null,
        ])
      : [[], null];

    res.status(200).json({
      status: 'success',
      data: {
        order: order ? { ...describe(order), attendees: (order.lines || []).map((l) => ({ name: `${l.customer?.firstName} ${l.customer?.lastName}`, email: l.customer?.email, ticket: l.name, quantity: l.quantity })) } : null,
        payment: log || null,
        tickets: tickets.map((t) => ({ ticketId: t.ticketId, name: t.name, price: t.price, checkedIn: t.isUsed, holder: t.buyer ? `${t.buyer.firstName} ${t.buyer.lastName}`.trim() : null, email: t.buyer?.email })),
        transaction: transaction ? { reference: transaction.reference, total: transaction.total, status: transaction.status, createdAt: transaction.createdAt } : null,
      },
    });
  } catch (error) {
    fail(res, error, 'Failed to load this payment');
  }
};

// POST /api/admin/payments/:reference/retry
exports.retry = async (req, res) => {
  try {
    const reference = String(req.params.reference).slice(0, 100);
    const tx = await paystack.verifyTransaction(reference);
    let state;
    if (tx && tx.status === 'success') {
      ({ settlement: { state } } = await reconcile.reconcileTransaction(tx, 'verify', { force: true }));
    } else {
      state = tx ? `paystack_${tx.status}` : 'not_found_at_paystack';
    }
    const message =
      state === 'completed'
        ? 'Settled: the buyer now has their tickets.'
        : state === 'unfulfillable'
        ? 'Paid, but the tickets are sold out. This needs a refund.'
        : state === 'mismatch'
        ? 'The amount paid does not match the order. Check it in Paystack.'
        : `Not settled (${state}).`;
    res.status(200).json({ status: 'success', data: { state }, message });
  } catch (error) {
    if (error.name === 'ProviderError') return res.status(503).json({ status: 'error', message: 'Paystack could not be reached. Try again in a moment.' });
    fail(res, error, 'Failed to retry this payment');
  }
};

// GET /api/admin/payments/unmatched
exports.listUnmatched = async (req, res) => {
  try {
    const payments = await PaymentLog.find(unmatchedFilter).sort({ firstSeenAt: -1 }).limit(100).lean();
    res.status(200).json({ status: 'success', data: { payments } });
  } catch (error) {
    fail(res, error, 'Failed to load unmatched payments');
  }
};

// POST /api/admin/payments/:reference/dismiss  { note }
exports.dismiss = async (req, res) => {
  try {
    const note = String(req.body?.note || '').trim().slice(0, 300);
    if (note.length < 3) return res.status(400).json({ status: 'fail', message: 'Add a short note explaining why this needs no action.' });
    const result = await PaymentLog.updateOne(
      { reference: String(req.params.reference).slice(0, 100), status: { $ne: 'dismissed' } },
      { $set: { status: 'dismissed', note, resolvedAt: new Date() } }
    );
    if (!result.matchedCount) return res.status(404).json({ status: 'fail', message: 'No open payment with this reference.' });
    res.status(200).json({ status: 'success', message: 'Marked as handled.' });
  } catch (error) {
    fail(res, error, 'Failed to update this payment');
  }
};

let sweeping = false;

// POST /api/admin/payments/reconcile  { days }
exports.runReconcile = async (req, res) => {
  if (sweeping) return res.status(409).json({ status: 'fail', message: 'A sweep is already running. Try again in a minute.' });
  sweeping = true;
  try {
    const days = Math.min(Math.max(parseInt(req.body?.days) || 3, 1), 14);
    const summary = await reconcile.reconcileWindow({ from: new Date(Date.now() - days * 864e5), maxPages: 5 });
    res.status(200).json({ status: 'success', data: { ...summary, days } });
  } catch (error) {
    fail(res, error, 'Failed to run the sweep');
  } finally {
    sweeping = false;
  }
};

exports._attentionFilter = attentionFilter;
