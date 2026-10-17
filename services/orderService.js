// services/orderService.js
// Checkout + fulfilment engine. Guarantees:
//  * prices are computed here from the event in the database, never taken from the client;
//  * an order is only fulfilled after Paystack confirms the same reference, amount and currency;
//  * fulfilment is idempotent: repeated verify calls / webhooks / sweeper runs / crashes mid-way
//    never produce duplicate tickets, double stock deductions or double host credit;
//  * stock is deducted with a single atomic conditional update, so concurrent buyers cannot
//    oversell. A paid order that cannot be served (stock gone) is flagged `unfulfillable`.
const crypto = require('crypto');
const mongoose = require('mongoose');
const { v5: uuidv5 } = require('uuid');
const QRCode = require('qrcode');
const { Readable } = require('stream');
const { Resend } = require('resend');

const { calculateFees, roundMoney, MAX_TICKETS_PER_ORDER } = require('../utils/pricing');
const { buildTicketEmail, buildTicketText, eventWhen, logoAttachment, qrAttachments, SUPPORT_EMAIL } = require('../utils/ticketEmail');

const TICKET_NAMESPACE = '6f1d3c5e-8a41-4d3b-9b8e-2c7a5f0d1e42';
const LOCK_MS = 2 * 60 * 1000;
const EMAIL_RETRY_MS = 5 * 60 * 1000;
const MAX_EMAIL_ATTEMPTS = 5;
const QR_CONCURRENCY = 4;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

class OrderError extends Error {
  constructor(status, message, code, data) {
    super(message);
    this.name = 'OrderError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

// Collaborators live on one object so tests can substitute them.
const deps = {
  Event: require('../models/event'),
  Order: require('../models/order'),
  Ticket: require('../models/ticket'),
  Transaction: require('../models/transaction'),
  User: require('../models/user'),
  Host: require('../models/host'),
  paystack: require('./paystack'),
  uploadQr(buffer, publicId) {
    const cloudinary = require('../config/cloudinary');
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'genpay/tickets', public_id: `ticket_${publicId}`, resource_type: 'image', overwrite: true },
        (err, result) => (err ? reject(err) : resolve(result.secure_url))
      );
      Readable.from(buffer).pipe(stream);
    });
  },
  async sendEmail({ to, subject, html, text, attachments }) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: [to],
      replyTo: SUPPORT_EMAIL,
      subject,
      html,
      text,
      attachments,
    });
    if (error) throw new Error(error.message || 'Email provider rejected the message');
  },
};

// ---------------------------------------------------------------- validation & pricing

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function normalizeCustomer(raw) {
  if (!raw || typeof raw !== 'object') throw new OrderError(400, 'Attendee details are missing.');
  const customer = {
    firstName: str(raw.firstName, 60),
    lastName: str(raw.lastName, 60),
    email: str(raw.email, 254).toLowerCase(),
    phone: str(raw.phone, 30),
    location: str(raw.location, 120),
  };
  if (!customer.firstName || !customer.lastName) {
    throw new OrderError(400, 'Each attendee needs a first and last name.');
  }
  if (!EMAIL_RE.test(customer.email)) {
    throw new OrderError(400, 'Each attendee needs a valid email address.');
  }
  return customer;
}

// Custom answers are keyed by question index.
function normalizeAnswers(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= 20) break;
    if (!/^\d{1,2}$/.test(key)) continue;
    out[key] = str(typeof value === 'string' ? value : String(value ?? ''), 500);
    count += 1;
  }
  return out;
}

/**
 * Validates a client-submitted cart against the event and prices it from the event's own data.
 * `event` must include `tickets`. Throws OrderError on anything invalid.
 */
function buildCart(event, rawTickets, { checkStock = true } = {}) {
  if (!Array.isArray(rawTickets) || rawTickets.length === 0) {
    throw new OrderError(400, 'Select at least one ticket.');
  }
  if (rawTickets.length > MAX_TICKETS_PER_ORDER) {
    throw new OrderError(400, `You can buy at most ${MAX_TICKETS_PER_ORDER} tickets per order.`);
  }

  const lines = [];
  const perTier = new Map();
  let totalTickets = 0;

  for (const raw of rawTickets) {
    const ticketId = str(raw?.ticketId, 100);
    const tier = event.tickets.find((t) => t.id === ticketId);
    if (!tier) throw new OrderError(400, 'One of the selected ticket types is no longer available.');

    const quantity = raw.quantity === undefined ? 1 : Number(raw.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_TICKETS_PER_ORDER) {
      throw new OrderError(400, 'Invalid ticket quantity.');
    }
    const price = Number(tier.price);
    if (!Number.isFinite(price) || price < 0) {
      throw new OrderError(400, 'This ticket is not currently available for purchase.');
    }

    totalTickets += quantity;
    perTier.set(ticketId, (perTier.get(ticketId) || 0) + quantity);
    lines.push({
      ticketId,
      name: tier.name,
      ticketType: tier.ticketType,
      groupSize: tier.groupSize || null,
      price,
      quantity,
      customer: normalizeCustomer(raw.customer),
      customAnswers: normalizeAnswers(raw.customAnswers),
    });
  }

  if (totalTickets > MAX_TICKETS_PER_ORDER) {
    throw new OrderError(400, `You can buy at most ${MAX_TICKETS_PER_ORDER} tickets per order.`);
  }

  for (const [ticketId, qty] of perTier) {
    const tier = event.tickets.find((t) => t.id === ticketId);
    if (tier.purchaseLimit > 0 && qty > tier.purchaseLimit) {
      throw new OrderError(400, `You can buy at most ${tier.purchaseLimit} "${tier.name}" tickets per order.`);
    }
    // Deliberately does not disclose the remaining count (it may be hidden by the host).
    if (checkStock && !(Number.isInteger(tier.quantity) && tier.quantity >= qty)) {
      throw new OrderError(409, `Not enough "${tier.name}" tickets are available. Please reduce the quantity or choose another ticket.`, 'insufficient_stock');
    }
  }

  const subtotal = roundMoney(lines.reduce((sum, l) => sum + l.price * l.quantity, 0));
  const fees = calculateFees(subtotal);
  const total = roundMoney(subtotal + fees);
  return { lines, perTier, subtotal, fees, total, amountKobo: Math.round(total * 100) };
}

function assertSellable(event) {
  if (!event || !event.isPublished) throw new OrderError(404, 'This event is not available for ticket sales.');
  if (new Date(event.endDateTime) <= new Date()) throw new OrderError(400, 'This event has already ended.');
}

const newReference = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;

async function createOrder(event, cart, { provider, email }) {
  return deps.Order.create({
    reference: newReference(provider === 'free' ? 'FREE' : 'GP'),
    event: event._id,
    provider,
    email,
    lines: cart.lines,
    subtotal: cart.subtotal,
    fees: cart.fees,
    total: cart.total,
    amountKobo: cart.amountKobo,
    currency: 'NGN',
  });
}

// ---------------------------------------------------------------- fulfilment

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const tierKey = (order, tierId) => `${order.reference}:${tierId}`;

function quantityByTier(order) {
  const map = new Map();
  for (const line of order.lines) map.set(line.ticketId, (map.get(line.ticketId) || 0) + line.quantity);
  return map;
}

// Atomically deducts stock for one tier. The same update records the ledger key, so a retry
// after a crash can tell "already deducted" apart from "not enough stock".
async function deductTier(order, tierId, qty) {
  const key = tierKey(order, tierId);
  const res = await deps.Event.updateOne(
    {
      _id: order.event,
      processedRefs: { $ne: key },
      tickets: { $elemMatch: { id: tierId, quantity: { $gte: qty } } },
    },
    { $inc: { 'tickets.$.quantity': -qty }, $push: { processedRefs: key } }
  );
  if (res.modifiedCount === 1) return 'deducted';
  const already = await deps.Event.exists({ _id: order.event, processedRefs: key });
  return already ? 'already' : 'insufficient';
}

async function restoreTier(order, tierId, qty) {
  const key = tierKey(order, tierId);
  await deps.Event.updateOne(
    { _id: order.event, processedRefs: key, 'tickets.id': tierId },
    { $inc: { 'tickets.$.quantity': qty }, $pull: { processedRefs: key } }
  );
}

async function deductInventory(order) {
  const done = [];
  for (const [tierId, qty] of quantityByTier(order)) {
    const outcome = await deductTier(order, tierId, qty);
    if (outcome === 'insufficient') {
      for (const [doneId, doneQty] of done) await restoreTier(order, doneId, doneQty);
      return false;
    }
    done.push([tierId, qty]);
  }
  return true;
}

async function findOrCreateUser(customer) {
  return deps.User.findOneAndUpdate(
    { email: customer.email },
    {
      $setOnInsert: {
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        phone: customer.phone,
        location: customer.location,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function ensureTicket(order, event, line, lineIdx, unitIdx, user) {
  // Deterministic id => a retried fulfilment finds the ticket it already created.
  const ticketId = uuidv5(`${order.reference}:${lineIdx}:${unitIdx}`, TICKET_NAMESPACE);
  const existing = await deps.Ticket.findOne({ ticketId });
  if (existing) return existing;

  const qrPayload = JSON.stringify({
    eventId: String(event._id),
    eventName: event.eventName,
    ticketId,
    ticketName: line.name,
    ticketType: line.ticketType,
    price: line.price,
    buyerName: `${user.firstName} ${user.lastName}`,
    buyerEmail: user.email,
    startDateTime: event.startDateTime,
    venue: event.eventLocation?.venue,
  });
  const qrBuffer = await QRCode.toBuffer(qrPayload, { errorCorrectionLevel: 'H' });
  const qrCode = await deps.uploadQr(qrBuffer, ticketId);

  try {
    return await deps.Ticket.create({
      event: event._id,
      name: line.name,
      type: line.ticketType || 'Individual',
      price: line.price,
      quantity: 1,
      buyer: user._id,
      ticketId,
      tierId: line.ticketId,
      qrCode,
      customAnswers: line.customAnswers || {},
    });
  } catch (err) {
    if (err.code === 11000) return deps.Ticket.findOne({ ticketId });
    throw err;
  }
}

async function issueTickets(order, event) {
  const units = [];
  order.lines.forEach((line, lineIdx) => {
    for (let unitIdx = 0; unitIdx < line.quantity; unitIdx += 1) units.push({ line, lineIdx, unitIdx });
  });
  const userByEmail = new Map();
  for (const { line } of units) {
    if (!userByEmail.has(line.customer.email)) {
      userByEmail.set(line.customer.email, await findOrCreateUser(line.customer));
    }
  }
  return mapLimit(units, QR_CONCURRENCY, ({ line, lineIdx, unitIdx }) =>
    ensureTicket(order, event, line, lineIdx, unitIdx, userByEmail.get(line.customer.email))
  );
}

async function creditHost(order, event) {
  if (order.provider !== 'paystack' || !(order.subtotal > 0)) return;
  const claimed = await deps.Order.findOneAndUpdate(
    { _id: order._id, hostCredited: false },
    { $set: { hostCredited: true } }
  );
  if (!claimed) return;
  try {
    await deps.Host.updateOne({ _id: event.host }, { $inc: { availableBalance: order.subtotal } });
  } catch (err) {
    await deps.Order.updateOne({ _id: order._id }, { $set: { hostCredited: false } });
    throw err;
  }
}

async function runFulfilment(order) {
  const event = await deps.Event.findById(order.event)
    .select('eventName startDateTime endDateTime eventLocation host')
    .lean();
  if (!event) {
    await deps.Order.updateOne({ _id: order._id }, { $set: { status: 'unfulfillable', failureReason: 'event_missing' } });
    return { state: 'unfulfillable' };
  }

  if (!(await deductInventory(order))) {
    await deps.Order.updateOne(
      { _id: order._id },
      { $set: { status: 'unfulfillable', failureReason: 'insufficient_inventory' } }
    );
    console.error(`[orders] ${order.reference} paid but stock exhausted - refund required`);
    return { state: 'unfulfillable' };
  }

  const tickets = await issueTickets(order, event);
  await creditHost(order, event);

  const transaction = await deps.Transaction.findOneAndUpdate(
    { reference: order.reference },
    {
      $setOnInsert: {
        event: order.event,
        tickets: tickets.map((t) => t._id),
        reference: order.reference,
        amount: order.subtotal,
        fees: order.fees,
        total: order.total,
        paymentProvider: order.provider,
        status: 'completed',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const completed = await deps.Order.findOneAndUpdate(
    { _id: order._id },
    {
      $set: {
        status: 'completed',
        completedAt: new Date(),
        ticketIds: tickets.map((t) => t._id),
        transaction: transaction._id,
        lastError: null,
      },
    },
    { new: true }
  );
  return { state: 'completed', order: completed };
}

/**
 * Settles an order by reference: verifies payment with the provider (paystack orders),
 * then fulfils exactly once. Safe to call repeatedly and concurrently.
 * Resolves to { state, order?, result? }. Throws ProviderError if the provider is unreachable.
 */
async function settleOrder(reference) {
  let order = await deps.Order.findOne({ reference });
  if (!order) order = await adoptLegacyTransaction(reference);
  if (!order) return { state: 'not_found' };

  if (order.status === 'completed') return withResult({ state: 'completed', order });
  if (['unfulfillable', 'mismatch'].includes(order.status)) return { state: order.status, order };

  await deps.Order.updateOne({ _id: order._id }, { $set: { lastCheckedAt: new Date() } });

  if (order.provider === 'paystack') {
    const tx = await deps.paystack.verifyTransaction(reference);
    if (!tx) return { state: 'pending', order };
    await deps.Order.updateOne({ _id: order._id }, { $set: { paystackStatus: tx.status } });

    if (tx.status !== 'success') {
      const failed = ['failed', 'reversed'].includes(tx.status);
      if (failed && order.status === 'pending') {
        await deps.Order.updateOne({ _id: order._id, status: 'pending' }, { $set: { status: 'failed' } });
      }
      return { state: failed ? 'failed' : 'pending', order };
    }

    const amountOk = Number(tx.amount) === order.amountKobo;
    const currencyOk = String(tx.currency || '').toUpperCase() === order.currency;
    const referenceOk = tx.reference === order.reference;
    if (!amountOk || !currencyOk || !referenceOk) {
      await deps.Order.updateOne(
        { _id: order._id },
        { $set: { status: 'mismatch', failureReason: `expected ${order.amountKobo} ${order.currency}, provider reported ${tx.amount} ${tx.currency}` } }
      );
      console.error(`[orders] payment mismatch for ${order.reference}`);
      return { state: 'mismatch', order };
    }
  }

  // Claim the fulfilment lock. Only one worker can win; a stale lock (crashed worker) is taken over.
  const claimed = await deps.Order.findOneAndUpdate(
    {
      _id: order._id,
      $or: [
        { status: { $in: ['pending', 'expired', 'failed'] } },
        { status: 'processing', lockedAt: { $lt: new Date(Date.now() - LOCK_MS) } },
      ],
    },
    { $set: { status: 'processing', lockedAt: new Date(), paidAt: order.paidAt || new Date() } },
    { new: true }
  );
  if (!claimed) {
    const fresh = await deps.Order.findById(order._id);
    if (fresh?.status === 'completed') return withResult({ state: 'completed', order: fresh });
    return { state: fresh?.status === 'processing' ? 'processing' : fresh?.status || 'processing', order: fresh };
  }

  try {
    const outcome = await runFulfilment(claimed);
    if (outcome.state !== 'completed') return { ...outcome, order: await deps.Order.findById(order._id) };
    scheduleEmail(outcome.order._id);
    return withResult(outcome);
  } catch (err) {
    // Release the lock so the sweeper / next verify resumes from where we stopped.
    console.error(`[orders] fulfilment error for ${order.reference}:`, err.message);
    await deps.Order.updateOne(
      { _id: order._id, status: 'processing' },
      { $set: { status: 'pending', lockedAt: null, lastError: String(err.message).slice(0, 300) } }
    );
    return { state: 'error', order };
  }
}

// ---------------------------------------------------------------- results & email

async function buildResult(order) {
  const [event, tickets, transaction] = await Promise.all([
    deps.Event.findById(order.event).select('eventName startDateTime endDateTime eventLocation').lean(),
    deps.Ticket.find({ _id: { $in: order.ticketIds } }).populate('buyer', 'firstName lastName email').lean(),
    order.transaction ? deps.Transaction.findById(order.transaction).lean() : null,
  ]);
  const when = event ? eventWhen(event) : { date: '', time: '' };
  const index = new Map(order.ticketIds.map((id, i) => [String(id), i]));
  tickets.sort((a, b) => index.get(String(a._id)) - index.get(String(b._id)));
  return {
    tickets: tickets.map((t) => ({
      _id: String(t._id),
      type: t.name,
      price: t.price,
      qrCode: t.qrCode,
      ticketId: t.ticketId,
      buyerName: t.buyer ? `${t.buyer.firstName} ${t.buyer.lastName}` : 'Unknown',
      buyerEmail: t.buyer ? t.buyer.email : 'Unknown',
      eventName: event?.eventName,
      venue: event?.eventLocation?.venue,
      date: when.date,
      time: when.time,
    })),
    transaction: {
      _id: transaction ? String(transaction._id) : undefined,
      reference: order.reference,
      amount: order.subtotal,
      fees: order.fees,
      total: order.total,
      paymentProvider: order.provider,
      createdAt: transaction?.createdAt || order.completedAt,
    },
  };
}

async function withResult(outcome) {
  return { ...outcome, result: await buildResult(outcome.order) };
}

function scheduleEmail(orderId) {
  // Fire and forget: the buyer's response never waits on the email provider. Failures are
  // recorded on the order and retried by the sweeper.
  sendConfirmationEmails(orderId).catch((err) => console.error('[orders] email error:', err.message));
}

async function sendConfirmationEmails(orderId) {
  const claimed = await deps.Order.findOneAndUpdate(
    {
      _id: orderId,
      status: 'completed',
      emailSentAt: null,
      emailAttempts: { $lt: MAX_EMAIL_ATTEMPTS },
      $or: [{ emailClaimedAt: null }, { emailClaimedAt: { $lt: new Date(Date.now() - EMAIL_RETRY_MS) } }],
    },
    { $set: { emailClaimedAt: new Date() }, $inc: { emailAttempts: 1 } },
    { new: true }
  );
  if (!claimed) return;

  const event = await deps.Event.findById(claimed.event).select('eventName slug startDateTime endDateTime eventLocation').lean();
  const tickets = await deps.Ticket.find({ _id: { $in: claimed.ticketIds } }).populate('buyer', 'email').lean();
  const lineByTicketId = new Map();
  claimed.lines.forEach((line, lineIdx) => {
    for (let u = 0; u < line.quantity; u += 1) {
      lineByTicketId.set(uuidv5(`${claimed.reference}:${lineIdx}:${u}`, TICKET_NAMESPACE), line);
    }
  });

  const byEmail = new Map();
  for (const t of tickets) {
    const line = lineByTicketId.get(t.ticketId);
    if (!line) continue;
    const entry = byEmail.get(line.customer.email) || { customer: line.customer, tickets: [] };
    entry.tickets.push({ ...t, groupSize: line.groupSize, attendeeName: `${line.customer.firstName} ${line.customer.lastName}` });
    byEmail.set(line.customer.email, entry);
  }

  const sent = new Set(claimed.emailedTo || []);
  let failures = 0;
  for (const [email, { customer, tickets: list }] of byEmail) {
    if (sent.has(email)) continue;
    try {
      const content = { order: claimed, event, customer, tickets: list };
      await deps.sendEmail({
        to: email,
        subject: `Your tickets for ${event.eventName}`,
        html: buildTicketEmail(content),
        text: buildTicketText(content),
        attachments: [logoAttachment(), ...qrAttachments(list)].filter(Boolean),
      });
      await deps.Order.updateOne({ _id: claimed._id }, { $addToSet: { emailedTo: email } });
    } catch (err) {
      failures += 1;
      console.error(`[orders] confirmation email failed for order ${claimed.reference}:`, err.message);
    }
  }
  if (failures === 0) await deps.Order.updateOne({ _id: claimed._id }, { $set: { emailSentAt: new Date() } });
}

// ---------------------------------------------------------------- legacy in-flight payments

/**
 * Payments started by the previous version of the checkout (before Orders existed) carry their
 * cart in Paystack metadata. Rebuild an Order from it, but price it from the database; the
 * settle step still requires Paystack's amount to equal that price.
 */
async function adoptLegacyTransaction(reference) {
  if (!/^GENPAY_/.test(reference)) return null;
  const tx = await deps.paystack.verifyTransaction(reference);
  if (!tx || tx.status !== 'success') return null;
  const md = tx.metadata || {};
  if (!mongoose.Types.ObjectId.isValid(md.eventId)) return null;
  const event = await deps.Event.findById(md.eventId).select('eventName isPublished endDateTime tickets host').lean();
  if (!event) return null;
  let cart;
  try {
    cart = buildCart(event, typeof md.tickets === 'string' ? JSON.parse(md.tickets) : md.tickets, { checkStock: false });
  } catch (err) {
    console.error(`[orders] legacy ${reference} could not be rebuilt:`, err.message);
    return null;
  }
  try {
    return await deps.Order.create({
      reference,
      event: event._id,
      provider: 'paystack',
      email: cart.lines[0].customer.email,
      lines: cart.lines,
      subtotal: cart.subtotal,
      fees: cart.fees,
      total: cart.total,
      amountKobo: cart.amountKobo,
      currency: 'NGN',
      legacy: true,
    });
  } catch (err) {
    if (err.code === 11000) return deps.Order.findOne({ reference });
    throw err;
  }
}

module.exports = {
  OrderError,
  deps,
  buildCart,
  assertSellable,
  createOrder,
  settleOrder,
  buildResult,
  sendConfirmationEmails,
  newReference,
  LOCK_MS,
};
