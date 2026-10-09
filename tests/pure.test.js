const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { calculateFees } = require('../utils/pricing');
const { toPublicTickets } = require('../utils/publicEvent');
const { buildCart, OrderError } = require('../services/orderService');
const { signatureMatches } = require('../controllers/paymentController');
const { makeEvent, attendee, cart } = require('./helpers/fixtures');

// The fee schedule the checkout UI used before pricing moved server-side (Buyticket.jsx).
const legacyClientFees = (s) => {
  if (s >= 1 && s <= 2499) return Math.round(s * 0.05);
  if (s >= 2500 && s <= 126666) return Math.round(s * 0.05);
  if (s >= 126667 && s <= 399999) return 6000;
  if (s >= 400000 && s <= 599999) return 12000;
  if (s >= 600000 && s <= 1999999) return 18000;
  if (s >= 2000000 && s <= 4999999) return 24000;
  if (s >= 5000000 && s <= 7999999) return 30000;
  if (s >= 8000000) return 36000;
  return 0;
};

test('server fee schedule matches the schedule the UI displayed', () => {
  const samples = [0, 1, 100, 2499, 2500, 5000, 126666, 126667, 399999, 400000, 599999, 600000, 1999999, 2000000, 4999999, 5000000, 7999999, 8000000, 20000000];
  for (let s = 1; s < 130000; s += 997) samples.push(s);
  for (const s of samples) assert.equal(calculateFees(s), legacyClientFees(s), `subtotal ${s}`);
});

test('buildCart prices from the event, ignoring any client-supplied price fields', () => {
  const event = makeEvent();
  const tampered = cart('t1', 2).map((l) => ({ ...l, price: 1, total: 1, amount: 1 }));
  const c = buildCart(event, tampered);
  assert.equal(c.subtotal, 10000);
  assert.equal(c.fees, 500);
  assert.equal(c.total, 10500);
  assert.equal(c.amountKobo, 1050000);
});

test('buildCart rejects invalid input', () => {
  const event = makeEvent();
  const bad = (tickets, status) =>
    assert.throws(() => buildCart(event, tickets), (e) => e instanceof OrderError && (!status || e.status === status));
  bad([], 400);
  bad('nope', 400);
  bad([{ ticketId: 'ghost', customer: attendee() }], 400);
  bad([{ ticketId: 't1', quantity: -1, customer: attendee() }], 400);
  bad([{ ticketId: 't1', quantity: 1.5, customer: attendee() }], 400);
  bad([{ ticketId: 't1', quantity: 1 }], 400); // no attendee
  bad([{ ticketId: 't1', quantity: 1, customer: { ...attendee(), email: 'not-an-email' } }], 400);
  bad(cart('t1', 6), 400); // purchaseLimit 5
  bad(cart('t1', 4).concat(cart('t1', 0)), 409); // only 3 in stock
});

test('stock errors never reveal the remaining count', () => {
  try {
    buildCart(makeEvent({ showTicketQuantity: false }), cart('t1', 4));
    assert.fail('expected throw');
  } catch (e) {
    assert.equal(e.code, 'insufficient_stock');
    assert.doesNotMatch(e.message, /\b3\b/);
  }
});

test('hidden quantity: no quantity anywhere in the serialised public tickets', () => {
  const hidden = JSON.stringify(toPublicTickets(makeEvent({ showTicketQuantity: false })));
  assert.doesNotMatch(hidden, /"quantity"/);
  const parsed = JSON.parse(hidden);
  assert.equal(parsed[0].soldOut, false);
  assert.equal(parsed[0].maxPerOrder, 5); // host purchase limit
  assert.equal(parsed[1].maxPerOrder, 10); // default cap when hidden
});

test('visible quantity: quantity is present; sold-out tiers are flagged', () => {
  const shown = toPublicTickets(makeEvent({ tickets: [{ id: 'a', name: 'A', price: 1, quantity: 0 }] }));
  assert.equal(shown[0].quantity, 0);
  assert.equal(shown[0].soldOut, true);
});

test('events saved before the setting existed keep showing quantities', () => {
  const legacy = makeEvent();
  delete legacy.showTicketQuantity;
  assert.equal(toPublicTickets(legacy)[0].quantity, 3);
});

test('public tickets use an allowlist (no internal fields leak)', () => {
  const ev = makeEvent();
  ev.tickets[0].processedRefs = ['x'];
  ev.tickets[0].internalNote = 'secret';
  const out = JSON.stringify(toPublicTickets(ev));
  assert.doesNotMatch(out, /internalNote|processedRefs/);
});

test('webhook signature check', () => {
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_unit';
  const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'r' } }));
  const good = crypto.createHmac('sha512', 'sk_test_unit').update(body).digest('hex');
  assert.equal(signatureMatches(body, good), true);
  assert.equal(signatureMatches(body, good.replace(/.$/, good.endsWith('0') ? '1' : '0')), false);
  assert.equal(signatureMatches(body, 'zz'), false);
  assert.equal(signatureMatches(body, undefined), false);
  assert.equal(signatureMatches(undefined, good), false);
  assert.equal(signatureMatches(Buffer.from(`${body} `), good), false); // altered body
});
