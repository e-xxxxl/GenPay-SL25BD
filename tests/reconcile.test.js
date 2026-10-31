const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const orders = require('../services/orderService');
const reconcile = require('../services/reconcileService');
const payments = require('../controllers/paymentController');
const { createFakeDeps } = require('./helpers/fakeDb');
const { EVENT_ID, makeEvent, cart } = require('./helpers/fixtures');

process.env.PAYSTACK_SECRET_KEY = 'sk_test_unit';

function setup() {
  const fake = createFakeDeps();
  Object.assign(orders.deps, fake.deps);
  fake.deps.Event.docs.push(makeEvent());
  fake.stock = (id) => fake.deps.Event.docs[0].tickets.find((t) => t.id === id).quantity;
  fake.paid = new Map(); // what Paystack says about each reference
  fake.stub.verify = async (ref) => fake.paid.get(ref) || null;
  return fake;
}
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const legacyTx = (reference, n = 2) => ({
  reference, status: 'success', currency: 'NGN', amount: 1050000, channel: 'card', customer: { email: 'ada1@example.com' },
  metadata: { eventId: EVENT_ID, tickets: cart('t1', n), fees: 500 },
});
const logOf = (fake, reference) => fake.deps.PaymentLog.docs.find((d) => d.reference === reference);
const signed = (data) => {
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data }));
  const sig = crypto.createHmac('sha512', 'sk_test_unit').update(raw).digest('hex');
  return { rawBody: raw, body: JSON.parse(raw), headers: { 'x-paystack-signature': sig } };
};

test('an old-flow purchase that WAS fulfilled is recorded, not issued a second time', async () => {
  const fake = setup();
  const ticket = await fake.deps.Ticket.create({ event: EVENT_ID, name: 'Regular', type: 'Individual', price: 5000, quantity: 1, buyer: 'u1', ticketId: 'old-1', qrCode: 'x' });
  await fake.deps.User.create({ _id: 'u1', email: 'ada1@example.com' });
  await fake.deps.Transaction.create({ event: EVENT_ID, tickets: [ticket._id], reference: 'GENPAY_old', amount: 5000, fees: 250, total: 5250, paymentProvider: 'paystack', status: 'completed' });
  fake.paid.set('GENPAY_old', legacyTx('GENPAY_old', 1));
  const stockBefore = fake.stock('t1');

  const out = await orders.settleOrder('GENPAY_old');
  assert.equal(out.state, 'completed');
  assert.equal(fake.deps.Ticket.docs.length, 1, 'no new tickets');
  assert.equal(fake.stock('t1'), stockBefore, 'stock untouched');
  assert.equal(fake.deps.Order.docs[0].legacy, true);
  assert.equal(fake.deps.Order.docs[0].status, 'completed');
  assert.equal(fake.sent.length, 0, 'no second confirmation email');
});

test('an old-flow payment that never reached our server is recovered exactly once', async () => {
  const fake = setup();
  const tx = legacyTx('GENPAY_lost');
  fake.paid.set('GENPAY_lost', tx);

  const first = await reconcile.reconcileTransaction(tx, 'reconcile');
  assert.equal(first.status, 'recovered');
  assert.equal(fake.deps.Ticket.docs.length, 2);
  assert.equal(fake.stock('t1'), 1);
  assert.equal(logOf(fake, 'GENPAY_lost').status, 'recovered');

  const again = await reconcile.reconcileTransaction(tx, 'webhook');
  assert.equal(again.skipped, true);
  assert.equal(fake.deps.Ticket.docs.length, 2, 'running it again changes nothing');
});

test('a payment we cannot match is recorded and flagged, never silently dropped', async () => {
  const fake = setup();
  const tx = { reference: 'MYSTERY_1', status: 'success', amount: 500000, currency: 'NGN', customer: { email: 'who@example.com' } };
  fake.paid.set('MYSTERY_1', tx);
  const out = await reconcile.reconcileTransaction(tx, 'reconcile');
  assert.equal(out.status, 'needs_action');
  const log = logOf(fake, 'MYSTERY_1');
  assert.equal(log.status, 'needs_action');
  assert.equal(log.amountKobo, 500000);
  assert.equal(log.email, 'who@example.com');
  assert.match(log.reason, /No matching order/);
});

test('webhook for an unknown payment answers 200 but leaves a trace', async () => {
  const fake = setup();
  const r = res();
  await payments.paystackWebhook(signed({ reference: 'MYSTERY_2', amount: 123400, currency: 'NGN', status: 'success', customer: { email: 'x@example.com' } }), r);
  assert.equal(r.code, 200);
  assert.equal(logOf(fake, 'MYSTERY_2')?.status, 'needs_action');
});

test('webhook for a normal paid order fulfils it and marks the payment as handled', async () => {
  const fake = setup();
  const event = fake.deps.Event.docs[0];
  const order = await orders.createOrder(event, orders.buildCart(event, cart('t1', 2)), { provider: 'paystack', email: 'ada1@example.com' });
  fake.paid.set(order.reference, { reference: order.reference, status: 'success', currency: 'NGN', amount: order.amountKobo });
  const r = res();
  await payments.paystackWebhook(signed({ reference: order.reference, amount: order.amountKobo, currency: 'NGN', status: 'success' }), r);
  assert.equal(r.code, 200);
  assert.equal(fake.deps.Ticket.docs.length, 2);
  assert.equal(logOf(fake, order.reference).status, 'recovered');
});

test('the sweep reads Paystack and settles anything the browser/webhook missed', async () => {
  const fake = setup();
  const event = fake.deps.Event.docs[0];
  const make = (ticket, email) => orders.createOrder(event, orders.buildCart(event, cart(ticket, 1)), { provider: 'paystack', email });
  const paidTx = (o, amount) => ({ reference: o.reference, status: 'success', currency: 'NGN', amount: amount ?? o.amountKobo });

  const done = await make('t1', 'a@example.com');
  fake.paid.set(done.reference, paidTx(done));
  await orders.settleOrder(done.reference); // fulfilled normally
  const missed = await make('t2', 'b@example.com');
  fake.paid.set(missed.reference, paidTx(missed));
  const underpaid = await make('t2', 'c@example.com');
  fake.paid.set(underpaid.reference, paidTx(underpaid, 100));

  const stray = { reference: 'STRAY', status: 'success', currency: 'NGN', amount: 5 };
  fake.stub.list = async ({ page }) =>
    page === 1
      ? { transactions: [paidTx(done), paidTx(missed)], page: 1, pageCount: 2, total: 4 }
      : { transactions: [paidTx(underpaid, 100), stray], page: 2, pageCount: 2, total: 4 };

  const summary = await reconcile.reconcileWindow({ from: new Date(Date.now() - 864e5) });
  assert.deepEqual(
    { checked: summary.checked, matched: summary.matched, recovered: summary.recovered, needsAction: summary.needsAction, complete: summary.complete },
    { checked: 4, matched: 1, recovered: 1, needsAction: 2, complete: true }
  );
  assert.equal(fake.deps.Order.docs.find((o) => o.reference === missed.reference).status, 'completed');
  assert.equal(fake.deps.Order.docs.find((o) => o.reference === underpaid.reference).status, 'mismatch');
  assert.match(logOf(fake, underpaid.reference).reason, /order expected/);
  assert.equal(logOf(fake, 'STRAY').status, 'needs_action');
});

test('the sweep reports a partial result instead of failing when Paystack is unreachable', async () => {
  const fake = setup();
  fake.stub.list = async () => {
    throw new (require('../services/paystack').ProviderError)('down');
  };
  const summary = await reconcile.reconcileWindow({ from: new Date(Date.now() - 864e5) });
  assert.equal(summary.complete, false);
  assert.match(summary.error, /Could not read transactions/);
});
