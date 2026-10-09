const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const orders = require('../services/orderService');
const payments = require('../controllers/paymentController');
const { createFakeDeps } = require('./helpers/fakeDb');
const { EVENT_ID, makeEvent, attendee, cart } = require('./helpers/fixtures');

process.env.PAYSTACK_SECRET_KEY = 'sk_test_unit';
process.env.FRONTEND_URL = 'https://genpay.ng';

// Installs fresh fakes into the service for each test.
function setup(eventOver) {
  const fake = createFakeDeps();
  Object.assign(orders.deps, fake.deps);
  fake.deps.Event.docs.push(makeEvent(eventOver));
  const paidFor = (reference, overrides = {}) => {
    const order = fake.deps.Order.docs.find((o) => o.reference === reference);
    return { status: 'success', reference, amount: order.amountKobo, currency: 'NGN', ...overrides };
  };
  fake.stub.verify = async (reference) => paidFor(reference);
  fake.paidFor = paidFor;
  fake.event = () => fake.deps.Event.docs[0];
  fake.stock = (id) => fake.event().tickets.find((t) => t.id === id).quantity;
  return fake;
}

async function newOrder(fake, tickets, provider = 'paystack') {
  const event = fake.event();
  const c = orders.buildCart(event, tickets);
  return orders.createOrder(event, c, { provider, email: c.lines[0].customer.email });
}

const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

test('successful payment issues the right tickets exactly once', async () => {
  const fake = setup();
  const order = await newOrder(fake, cart('t1', 2));
  const out = await orders.settleOrder(order.reference);
  assert.equal(out.state, 'completed');
  assert.equal(out.result.tickets.length, 2);
  assert.equal(fake.deps.Ticket.docs.length, 2);
  assert.equal(fake.stock('t1'), 1);
  assert.equal(fake.deps.Transaction.docs.length, 1);
  assert.equal(fake.deps.Order.docs[0].status, 'completed');
});

test('repeated verification / webhooks do not duplicate fulfilment', async () => {
  const fake = setup();
  const order = await newOrder(fake, cart('t1', 2));
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => orders.settleOrder(order.reference)));
  await orders.settleOrder(order.reference);
  assert.ok(results.every((r) => ['completed', 'processing'].includes(r.state)));
  assert.equal(fake.deps.Ticket.docs.length, 2);
  assert.equal(fake.stock('t1'), 1, 'stock deducted once');
  assert.equal(fake.deps.Transaction.docs.length, 1);
  assert.equal(fake.deps.Host.docs.length, 0); // host credit is an $inc, no doc created by the fake
  assert.equal(fake.deps.Order.docs[0].hostCredited, true);
});

test('a failed or abandoned payment creates no tickets and takes no stock', async () => {
  const fake = setup();
  const order = await newOrder(fake, cart('t1', 2));
  fake.stub.verify = async (ref) => fake.paidFor(ref, { status: 'abandoned' });
  assert.equal((await orders.settleOrder(order.reference)).state, 'pending');
  fake.stub.verify = async (ref) => fake.paidFor(ref, { status: 'failed' });
  assert.equal((await orders.settleOrder(order.reference)).state, 'failed');
  assert.equal(fake.deps.Ticket.docs.length, 0);
  assert.equal(fake.stock('t1'), 3);

  // A buyer who never reached the provider: Paystack has no such transaction yet.
  const untouched = await newOrder(fake, cart('t1', 1));
  fake.stub.verify = async () => null;
  assert.equal((await orders.settleOrder(untouched.reference)).state, 'pending');

  // Paystack lets a buyer retry a failed card on the same reference; a later success must still settle.
  fake.stub.verify = async (ref) => fake.paidFor(ref);
  assert.equal((await orders.settleOrder(order.reference)).state, 'completed');
});

test('amount, currency or reference mismatch is never fulfilled', async () => {
  for (const override of [{ amount: 100 }, { currency: 'USD' }, { reference: 'someone-else' }]) {
    const fake = setup();
    const order = await newOrder(fake, cart('t1', 2));
    fake.stub.verify = async (ref) => fake.paidFor(ref, override);
    const out = await orders.settleOrder(order.reference);
    assert.equal(out.state, 'mismatch', JSON.stringify(override));
    assert.equal(fake.deps.Ticket.docs.length, 0);
    assert.equal(fake.stock('t1'), 3);
    // and it stays mismatched even if the provider later "agrees"
    fake.stub.verify = async (ref) => fake.paidFor(ref);
    assert.equal((await orders.settleOrder(order.reference)).state, 'mismatch');
  }
});

test('concurrent purchases of the last tickets cannot oversell', async () => {
  const fake = setup(); // 3 Regular in stock
  const a = await newOrder(fake, cart('t1', 2));
  const b = await newOrder(fake, cart('t1', 2));
  const c = await newOrder(fake, cart('t1', 1));
  const states = (await Promise.all([a, b, c].map((o) => orders.settleOrder(o.reference)))).map((r) => r.state).sort();
  assert.deepEqual(states, ['completed', 'completed', 'unfulfillable']);
  assert.ok(fake.stock('t1') >= 0);
  assert.equal(fake.deps.Ticket.docs.length, 3, 'never more tickets than stock');
});

test('a paid order that no longer fits is flagged for refund, with partial stock restored', async () => {
  const fake = setup();
  const mixed = [...cart('t2', 1), ...cart('t1', 3)];
  const order = await newOrder(fake, mixed);
  fake.event().tickets.find((t) => t.id === 't1').quantity = 1; // someone else bought most of them
  const out = await orders.settleOrder(order.reference);
  assert.equal(out.state, 'unfulfillable');
  assert.equal(fake.stock('t2'), 10, 'VIP stock restored after rollback');
  assert.equal(fake.stock('t1'), 1);
  assert.equal(fake.deps.Ticket.docs.length, 0);
  assert.equal(fake.deps.Order.docs[0].failureReason, 'insufficient_inventory');
});

test('a crash half-way through fulfilment resumes without duplicating anything', async () => {
  const fake = setup();
  const order = await newOrder(fake, cart('t1', 2));
  const realCreate = fake.deps.Ticket.create.bind(fake.deps.Ticket);
  let calls = 0;
  fake.deps.Ticket.create = async (data) => {
    calls += 1;
    if (calls === 2) throw new Error('db blip');
    return realCreate(data);
  };
  const first = await orders.settleOrder(order.reference);
  assert.equal(first.state, 'error');
  assert.equal(fake.deps.Order.docs[0].status, 'pending', 'lock released for retry');
  const second = await orders.settleOrder(order.reference);
  assert.equal(second.state, 'completed');
  assert.equal(fake.deps.Ticket.docs.length, 2);
  assert.equal(fake.stock('t1'), 1, 'stock deducted exactly once across both attempts');
  assert.equal(new Set(fake.deps.Ticket.docs.map((t) => t.ticketId)).size, 2);
});

test('provider outage surfaces as an error and leaves the order retryable', async () => {
  const fake = setup();
  const order = await newOrder(fake, cart('t1', 1));
  fake.stub.verify = async () => { throw new (require('../services/paystack').ProviderError)('down'); };
  await assert.rejects(orders.settleOrder(order.reference), /down/);
  fake.stub.verify = async (ref) => fake.paidFor(ref);
  assert.equal((await orders.settleOrder(order.reference)).state, 'completed');
});

test('confirmation email is sent once, with HTML-escaped attendee data', async () => {
  const fake = setup();
  const evil = [{ ticketId: 't1', quantity: 1, customer: { ...attendee(), firstName: '<script>x</script>' } }];
  const order = await newOrder(fake, evil);
  await orders.settleOrder(order.reference);
  await orders.sendConfirmationEmails(order._id);
  await orders.sendConfirmationEmails(order._id);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fake.sent.length, 1);
  assert.doesNotMatch(fake.sent[0].html, /<script>/);
  assert.match(fake.sent[0].html, /&lt;script&gt;/);
});

// ------------------------------------------------------------------ HTTP handlers

test('initialize-payment ignores client amounts and charges the server-computed total', async () => {
  const fake = setup();
  let sent;
  fake.stub.init = async (args) => { sent = args; return { authorization_url: 'https://checkout.paystack.com/x', access_code: 'ac' }; };
  const r = res();
  await payments.initializePayment({ body: { eventId: EVENT_ID, amount: 1, total: 1, fees: 0, tickets: cart('t2', 2), callbackUrl: 'https://evil.example/steal' } }, r);
  assert.equal(r.code, 200);
  assert.equal(sent.amountKobo, (40000 + 2000) * 100);
  assert.equal(r.body.data.total, 42000);
  assert.equal(sent.callbackUrl, 'https://genpay.ng/checkout/success', 'unknown callback origins are replaced');
  assert.equal(fake.deps.Order.docs.length, 1);
  assert.equal(fake.deps.Order.docs[0].status, 'pending');
});

test('initialize-payment rejects unpublished events, ended events, stale prices and free carts', async () => {
  for (const [over, body, code] of [
    [{ isPublished: false }, { tickets: cart('t1') }, 404],
    [{ endDateTime: new Date(Date.now() - 1000) }, { tickets: cart('t1') }, 400],
    [{}, { tickets: cart('t1'), expectedTotal: 1 }, 409],
    [{}, { tickets: cart('free') }, 400],
    [{}, { tickets: cart('t1', 99) }, 400],
  ]) {
    setup(over);
    const r = res();
    await payments.initializePayment({ body: { eventId: EVENT_ID, ...body } }, r);
    assert.equal(r.code, code, JSON.stringify([over, body]));
  }
});

test('forged "isFree" reservations on a paid event are refused', async () => {
  const fake = setup();
  const r = res();
  await payments.purchaseTicket({ params: { id: EVENT_ID }, body: { tickets: cart('t2', 2), isFree: true, reference: 'FREE_123', fees: 0 } }, r);
  assert.equal(r.code, 402);
  assert.equal(fake.deps.Ticket.docs.length, 0);
});

test('genuinely free events can still be reserved', async () => {
  const fake = setup();
  const r = res();
  await payments.purchaseTicket({ params: { id: EVENT_ID }, body: { tickets: cart('free', 2) } }, r);
  assert.equal(r.code, 201);
  assert.equal(r.body.data.tickets.length, 2);
  assert.equal(fake.stock('free'), 2);
  assert.equal(fake.deps.Order.docs[0].provider, 'free');
});

test('purchase-ticket with an unknown payment reference does not issue tickets', async () => {
  const fake = setup();
  fake.stub.verify = async () => null;
  const r = res();
  await payments.purchaseTicket({ params: { id: EVENT_ID }, body: { tickets: cart('t2', 2), reference: 'made-up-by-attacker' } }, r);
  assert.equal(r.code, 404);
  assert.equal(fake.deps.Ticket.docs.length, 0);
});

test('verify-payment returns 202 while unconfirmed, then tickets once paid', async () => {
  const fake = setup();
  const order = await newOrder(fake, cart('t1', 1));
  fake.stub.verify = async () => null;
  let r = res();
  await payments.verifyPayment({ params: { reference: order.reference } }, r);
  assert.equal(r.code, 202);
  fake.stub.verify = async (ref) => fake.paidFor(ref);
  r = res();
  await payments.verifyPayment({ params: { reference: order.reference } }, r);
  assert.equal(r.code, 200);
  assert.equal(r.body.data.tickets.length, 1);
});

test('webhook: bad signature rejected; good signature fulfils once even if delivered twice', async () => {
  const fake = setup();
  const order = await newOrder(fake, cart('t1', 2));
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: order.reference, amount: 1 } }));
  const sig = crypto.createHmac('sha512', 'sk_test_unit').update(raw).digest('hex');
  const req = (signature) => ({ rawBody: raw, body: JSON.parse(raw), headers: { 'x-paystack-signature': signature } });

  let r = res();
  await payments.paystackWebhook(req('0'.repeat(128)), r);
  assert.equal(r.code, 401);
  assert.equal(fake.deps.Ticket.docs.length, 0);

  r = res();
  await payments.paystackWebhook(req(sig), r);
  assert.equal(r.code, 200);
  r = res();
  await payments.paystackWebhook(req(sig), r);
  assert.equal(r.code, 200);
  assert.equal(fake.deps.Ticket.docs.length, 2);
  assert.equal(fake.stock('t1'), 1);
});

test('webhook cannot be used to mark an order paid when the provider disagrees', async () => {
  const fake = setup();
  const order = await newOrder(fake, cart('t1', 2));
  fake.stub.verify = async (ref) => fake.paidFor(ref, { amount: 500 }); // underpaid
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: order.reference, amount: 999999 } }));
  const sig = crypto.createHmac('sha512', 'sk_test_unit').update(raw).digest('hex');
  const r = res();
  await payments.paystackWebhook({ rawBody: raw, body: JSON.parse(raw), headers: { 'x-paystack-signature': sig } }, r);
  assert.equal(fake.deps.Ticket.docs.length, 0);
  assert.equal(fake.deps.Order.docs[0].status, 'mismatch');
});

test('in-flight payments from the old checkout are adopted only at the server-computed price', async () => {
  const fake = setup();
  const legacyTx = (amount) => ({
    status: 'success', reference: 'GENPAY_old1', amount, currency: 'NGN',
    metadata: { eventId: EVENT_ID, tickets: JSON.stringify(cart('t1', 2)), fees: 0 },
  });
  fake.stub.verify = async () => legacyTx(1050000);
  let r = res();
  await payments.verifyPayment({ params: { reference: 'GENPAY_old1' } }, r);
  assert.equal(r.code, 200);
  assert.equal(fake.deps.Ticket.docs.length, 2);

  const fake2 = setup();
  fake2.stub.verify = async () => ({ ...legacyTx(1000), reference: 'GENPAY_old2' }); // paid ₦10 for ₦10,500 of tickets
  r = res();
  await payments.verifyPayment({ params: { reference: 'GENPAY_old2' } }, r);
  assert.equal(r.code, 409);
  assert.equal(fake2.deps.Ticket.docs.length, 0);
});
