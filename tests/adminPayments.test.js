const test = require('node:test');
const assert = require('node:assert/strict');

const Order = require('../models/order');
const PaymentLog = require('../models/paymentLog');
const paystack = require('../services/paystack');
const reconcile = require('../services/reconcileService');
const admin = require('../controllers/adminPaymentController');

const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const chain = (value) => {
  const q = { sort: () => q, skip: () => q, limit: () => q, populate: () => q, select: () => q, lean: () => q, then: (a, b) => Promise.resolve(value).then(a, b) };
  return q;
};

test('the default list is "paid but not working", and search is escaped and combined with it', async () => {
  const orig = { find: Order.find, count: Order.countDocuments };
  let seen;
  Order.find = (filter) => { seen = filter; return chain([{ reference: 'GP_1', status: 'mismatch', lines: [{ quantity: 2 }], total: 1000, event: { eventName: 'Night' } }]); };
  Order.countDocuments = async () => 1;
  try {
    const r = res();
    await admin.listOrders({ query: {} }, r);
    const kinds = seen.$or.map((c) => JSON.stringify(c));
    assert.ok(kinds.some((k) => k.includes('mismatch') && k.includes('unfulfillable')));
    assert.ok(kinds.some((k) => k.includes('paystackStatus') && k.includes('success')), 'paid-but-not-completed orders are included');
    assert.equal(r.body.data.orders[0].tickets, 2);
    assert.equal(r.body.data.orders[0].event, 'Night');

    await admin.listOrders({ query: { q: '.*(a+)+$' } }, res());
    const rx = seen.$and[1].$or[0].reference;
    assert.equal(rx.test('anything'), false, 'regex characters are matched literally');
    assert.ok(seen.$and[0].$or, 'the attention filter still applies');

    await admin.listOrders({ query: { view: 'all' } }, res());
    assert.deepEqual(seen, {});
  } finally {
    Order.find = orig.find;
    Order.countDocuments = orig.count;
  }
});

test('marking a payment as handled needs a reason', async () => {
  const orig = PaymentLog.updateOne;
  let updated = null;
  PaymentLog.updateOne = async (filter, update) => { updated = { filter, update }; return { matchedCount: 1 }; };
  try {
    const bad = res();
    await admin.dismiss({ params: { reference: 'R1' }, body: { note: ' ' } }, bad);
    assert.equal(bad.code, 400);
    assert.equal(updated, null);

    const ok = res();
    await admin.dismiss({ params: { reference: 'R1' }, body: { note: 'Wallet top-up, not a ticket' } }, ok);
    assert.equal(ok.code, 200);
    assert.equal(updated.update.$set.status, 'dismissed');
  } finally {
    PaymentLog.updateOne = orig;
  }
});

test('retry re-checks Paystack and forces a fresh settle even for previously handled payments', async () => {
  const orig = { verify: paystack.verifyTransaction, rec: reconcile.reconcileTransaction };
  let forced;
  paystack.verifyTransaction = async () => ({ reference: 'R9', status: 'success', amount: 100 });
  reconcile.reconcileTransaction = async (tx, source, opts) => { forced = { source, opts }; return { settlement: { state: 'completed' } }; };
  try {
    const r = res();
    await admin.retry({ params: { reference: 'R9' } }, r);
    assert.equal(r.code, 200);
    assert.equal(r.body.data.state, 'completed');
    assert.deepEqual(forced.opts, { force: true });

    paystack.verifyTransaction = async () => null;
    const none = res();
    await admin.retry({ params: { reference: 'R9' } }, none);
    assert.equal(none.body.data.state, 'not_found_at_paystack');

    paystack.verifyTransaction = async () => { throw new paystack.ProviderError('down'); };
    const down = res();
    await admin.retry({ params: { reference: 'R9' } }, down);
    assert.equal(down.code, 503);
  } finally {
    paystack.verifyTransaction = orig.verify;
    reconcile.reconcileTransaction = orig.rec;
  }
});
