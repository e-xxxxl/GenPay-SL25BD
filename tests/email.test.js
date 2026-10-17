const test = require('node:test');
const assert = require('node:assert/strict');

const email = require('../utils/ticketEmail');
const orders = require('../services/orderService');
const { createFakeDeps } = require('./helpers/fakeDb');
const { makeEvent, attendee, cart } = require('./helpers/fixtures');

const order = { reference: 'GP_abc123', provider: 'paystack', email: 'ada1@example.com', subtotal: 10000, fees: 500, total: 10500 };
const event = { ...makeEvent(), slug: 'lagos-night' };
const ticket = (n, over = {}) => ({
  name: 'Regular', ticketId: `tid-${n}`, price: 5000, qrCode: `https://cdn.test/tid-${n}.png`, attendeeName: `Ada Buyer${n}`, groupSize: null, ...over,
});

test('email references inline logo and QR attachments by content id', () => {
  const tickets = [ticket(1), ticket(2)];
  const html = email.buildTicketEmail({ order, event, customer: attendee(1), tickets });
  assert.match(html, /src="cid:genpay-logo"/);
  for (const a of email.qrAttachments(tickets)) {
    assert.ok(a.contentId, 'inline attachments need contentId (the Resend field), not cid');
    assert.match(html, new RegExp(`src="cid:${a.contentId}"`));
  }
  const logo = email.logoAttachment();
  assert.equal(logo.contentId, 'genpay-logo');
  assert.ok(Buffer.from(logo.content, 'base64').subarray(1, 4).toString() === 'PNG', 'logo is a real PNG');
});

test('email escapes attendee and event text', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = email.buildTicketEmail({
    order,
    event: { ...event, eventName: evil },
    customer: { ...attendee(1), firstName: evil },
    tickets: [ticket(1, { name: evil, attendeeName: evil })],
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test('only the buyer sees the order total; other attendees see just the reference', () => {
  const tickets = [ticket(2)];
  const payer = email.buildTicketEmail({ order, event, customer: attendee(1), tickets });
  const guest = email.buildTicketEmail({ order, event, customer: attendee(2), tickets });
  assert.match(payer, /Total paid/);
  assert.doesNotMatch(guest, /Total paid|Subtotal/);
  assert.match(guest, /GP_abc123/);
  const guestText = email.buildTicketText({ order, event, customer: attendee(2), tickets });
  assert.doesNotMatch(guestText, /Total paid|Subtotal/);
});

test('free reservations say so and never claim a payment', () => {
  const free = { ...order, provider: 'free', subtotal: 0, fees: 0, total: 0 };
  const html = email.buildTicketEmail({ order: free, event, customer: attendee(1), tickets: [ticket(1, { price: 0 })] });
  assert.match(html, /Your reservation is confirmed/);
  assert.doesNotMatch(html, /Total paid|thank you for your purchase/i);
});

test('plain-text part carries the essentials', () => {
  const text = email.buildTicketText({ order, event, customer: attendee(1), tickets: [ticket(1)] });
  for (const needle of ['Lagos Night', 'Main Hall', 'tid-1', 'https://cdn.test/tid-1.png', 'GP_abc123', 'support@genpay.ng']) {
    assert.ok(text.includes(needle), needle);
  }
});

test('sending passes html, text and inline attachments to the mail provider', async () => {
  const fake = createFakeDeps();
  Object.assign(orders.deps, fake.deps);
  fake.deps.Event.docs.push(makeEvent());
  const o = await orders.createOrder(fake.deps.Event.docs[0], orders.buildCart(fake.deps.Event.docs[0], cart('t1', 2)), { provider: 'paystack', email: 'ada1@example.com' });
  fake.stub.verify = async (ref) => ({ status: 'success', reference: ref, amount: o.amountKobo, currency: 'NGN' });
  await orders.settleOrder(o.reference);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.sent.length, 2, 'one email per attendee address');
  const msg = fake.sent[0];
  assert.ok(msg.text && msg.html);
  assert.match(msg.subject, /^Your tickets for /);
  assert.ok(msg.attachments.some((a) => a.contentId === 'genpay-logo'));
  assert.ok(msg.attachments.filter((a) => a.contentId?.startsWith('qr-')).length === 1);
});
