const test = require('node:test');
const assert = require('node:assert/strict');

const orders = require('../services/orderService');
const { createFakeDeps } = require('./helpers/fakeDb');
const { makeEvent, attendee, cart } = require('./helpers/fixtures');

// Notifications are fire-and-forget, so wait (up to 3s) for a condition instead of sleeping a fixed time.
const until = async (check, timeoutMs = 3000) => {
  const start = Date.now();
  while (!(await check()) && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 10));
};
const settled = () => new Promise((r) => setTimeout(r, 150)); // for "nothing should happen" assertions

async function setup({ host = { _id: 'host1', email: 'host@example.com', firstName: 'Tolu' } } = {}) {
  const fake = createFakeDeps();
  Object.assign(orders.deps, fake.deps);
  fake.deps.Event.docs.push(makeEvent());
  if (host) fake.deps.Host.docs.push(host);
  fake.paidFor = (ref) => ({ status: 'success', reference: ref, currency: 'NGN', amount: fake.deps.Order.docs.find((o) => o.reference === ref).amountKobo });
  fake.stub.verify = async (ref) => fake.paidFor(ref);
  fake.toHost = () => fake.sent.filter((m) => m.to === 'host@example.com');
  return fake;
}
const newOrder = (fake, tickets, provider = 'paystack') => {
  const event = fake.deps.Event.docs[0];
  const c = orders.buildCart(event, tickets);
  return orders.createOrder(event, c, { provider, email: c.lines[0].customer.email });
};

test('the host is emailed once when a ticket order completes, separately from the buyer', async () => {
  const fake = await setup();
  const order = await newOrder(fake, [...cart('t2', 1), ...cart('t1', 2)]);
  await orders.settleOrder(order.reference);
  await until(() => fake.toHost().length >= 1 && fake.sent.some((m) => m.to === 'ada1@example.com'));

  assert.equal(fake.toHost().length, 1);
  const mail = fake.toHost()[0];
  assert.match(mail.subject, /New ticket sale: 1 x VIP, 2 x Regular for Lagos Night/);
  assert.match(mail.html, /Hi Tolu/);
  assert.match(mail.html, /Sold so far/);
  assert.match(mail.html, /\/sales\/64b7f0f0f0f0f0f0f0f0f0f1/, 'links to the host\'s sales page for this event');
  assert.match(mail.html, /You earn/);
  assert.ok(mail.attachments.some((a) => a.contentId === 'genpay-logo'));
  assert.ok(mail.text.includes(order.reference));
  // buyers still get theirs
  assert.ok(fake.sent.some((m) => m.to === 'ada1@example.com'));
});

test('it is sent only once even if settlement and the sweeper both run', async () => {
  const fake = await setup();
  const order = await newOrder(fake, cart('t1', 1));
  await Promise.all([orders.settleOrder(order.reference), orders.settleOrder(order.reference)]);
  await until(() => fake.toHost().length >= 1);
  await orders.sendHostNotification(fake.deps.Order.docs[0]._id);
  await orders.sendHostNotification(fake.deps.Order.docs[0]._id);
  await settled();
  assert.equal(fake.toHost().length, 1);
  assert.ok(fake.deps.Order.docs[0].hostNotifiedAt);
});

test('attendee contact details are not put in the host notification, and event/attendee text is escaped', async () => {
  const fake = await setup();
  fake.deps.Event.docs[0].eventName = '<b>Night</b>';
  const evil = [{ ticketId: 't1', quantity: 1, customer: { ...attendee(1), firstName: '<script>x</script>', phone: '08099998888' } }];
  const order = await newOrder(fake, evil);
  await orders.settleOrder(order.reference);
  await until(() => fake.toHost().length >= 1);
  const html = fake.toHost()[0].html;
  assert.doesNotMatch(html, /<script>|<b>Night/);
  assert.doesNotMatch(html, /ada1@example\.com|08099998888/);
  assert.match(html, /&lt;script&gt;/);
});

test('free reservations are described as reservations, with no earnings line', async () => {
  const fake = await setup();
  const order = await newOrder(fake, cart('free', 2), 'free');
  await orders.settleOrder(order.reference);
  await until(() => fake.toHost().length >= 1);
  const mail = fake.toHost()[0];
  assert.match(mail.subject, /^New reservation:/);
  assert.doesNotMatch(mail.html, /You earn/);
});

test('a failed host email is retried later, and never affects the buyer\'s tickets', async () => {
  const fake = await setup();
  const realSend = orders.deps.sendEmail;
  let failures = 1;
  orders.deps.sendEmail = async (msg) => {
    if (msg.to === 'host@example.com' && failures-- > 0) throw new Error('provider down');
    return realSend(msg);
  };
  const order = await newOrder(fake, cart('t1', 1));
  const out = await orders.settleOrder(order.reference);
  await until(() => fake.sent.some((m) => m.to === 'ada1@example.com'));
  await settled();
  assert.equal(out.state, 'completed');
  assert.equal(fake.deps.Ticket.docs.length, 1);
  assert.equal(fake.toHost().length, 0);
  assert.ok(!fake.deps.Order.docs[0].hostNotifiedAt);

  fake.deps.Order.docs[0].hostNotifyClaimedAt = new Date(Date.now() - 10 * 60 * 1000); // claim expired
  await orders.sendHostNotification(fake.deps.Order.docs[0]._id);
  assert.equal(fake.toHost().length, 1);
});

test('a host without an email address is skipped quietly (no retry loop)', async () => {
  const fake = await setup({ host: { _id: 'host1', email: '' } });
  const order = await newOrder(fake, cart('t1', 1));
  await orders.settleOrder(order.reference);
  await until(() => fake.deps.Order.docs[0].hostNotifiedAt);
  assert.equal(fake.toHost().length, 0);
  assert.ok(fake.deps.Order.docs[0].hostNotifiedAt, 'marked done so it is not retried');
});

test('purchases fulfilled before this feature are not announced retroactively', async () => {
  const fake = await setup();
  const ticket = await fake.deps.Ticket.create({ event: fake.deps.Event.docs[0]._id, name: 'Regular', type: 'Individual', price: 5000, quantity: 1, buyer: 'u1', ticketId: 'old', qrCode: 'x' });
  await fake.deps.Transaction.create({ event: fake.deps.Event.docs[0]._id, tickets: [ticket._id], reference: 'GENPAY_old', amount: 5000, fees: 250, total: 5250, paymentProvider: 'paystack' });
  fake.stub.verify = async () => ({ status: 'success', reference: 'GENPAY_old', currency: 'NGN', amount: 525000 });
  await orders.settleOrder('GENPAY_old');
  await settled();
  assert.equal(fake.toHost().length, 0);
});
