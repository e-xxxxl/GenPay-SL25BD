const test = require('node:test');
const assert = require('node:assert/strict');

const Event = require('../models/event');
const Ticket = require('../models/ticket');
const User = require('../models/user');
const eventController = require('../controllers/eventController');
const { createFakeDeps } = require('./helpers/fakeDb');
const { EVENT_ID, makeEvent } = require('./helpers/fixtures');

const OTHER_EVENT = '64b7f0f0f0f0f0f0f0f0f0f2';
const OWNER = { _id: 'host1' };

// Wraps a promise so Mongoose-style chaining (.populate/.select/...) keeps working.
const chain = (promise) => {
  const q = { populate: () => q, select: () => q, sort: () => q, limit: () => q, lean: () => q, then: (a, b) => promise.then(a, b) };
  return q;
};

// Puts the fake database behind the real models for the duration of one test.
async function setup() {
  const fake = createFakeDeps();
  const db = fake.deps;
  db.Event.docs.push(makeEvent({ host: 'host1', eventName: 'Lagos Night' }));
  const ada = await db.User.create({ _id: 'u1', firstName: 'Ada', lastName: 'Okafor', email: 'ada@example.com', phone: '0801' });
  const tunde = await db.User.create({ _id: 'u2', firstName: 'Tunde', lastName: 'Bello', email: 'tunde@example.com' });
  const mk = (over) => db.Ticket.create({ event: EVENT_ID, name: 'Regular', tierId: 't1', type: 'Individual', price: 5000, quantity: 1, qrCode: 'x', isUsed: false, ...over });
  const t1 = await mk({ ticketId: 'aaaa1111-2222-3333-4444-555566667777', buyer: ada._id });
  const t2 = await mk({ ticketId: 'bbbb1111-2222-3333-4444-555566667777', buyer: tunde._id });
  const foreign = await db.Ticket.create({ event: OTHER_EVENT, name: 'Other', type: 'Individual', price: 1, quantity: 1, qrCode: 'x', isUsed: false, ticketId: 'cccc1111-2222-3333-4444-555566667777', buyer: ada._id });

  const orig = {
    eventFind: Event.findById, upd: Ticket.findOneAndUpdate, one: Ticket.findOne, exists: Ticket.exists, find: Ticket.find, distinct: Ticket.distinct, userFind: User.find,
  };
  Event.findById = (id) => db.Event.findById(id);
  Ticket.findOneAndUpdate = (f, u, o) => chain(db.Ticket.findOneAndUpdate(f, u, o).then((doc) => (doc ? { ...doc, buyer: db.User.docs.find((x) => x._id === doc.buyer) } : doc)));
  Ticket.findOne = (f) => db.Ticket.findOne(f);
  Ticket.exists = (f) => db.Ticket.exists(f);
  Ticket.find = (f) => db.Ticket.find(f);
  Ticket.distinct = (field, f) => db.Ticket.distinct(field, f);
  User.find = (f) => db.User.find(f);
  const restore = () => Object.assign(Event, { findById: orig.eventFind }) && Object.assign(Ticket, { findOneAndUpdate: orig.upd, findOne: orig.one, exists: orig.exists, find: orig.find, distinct: orig.distinct }) && Object.assign(User, { find: orig.userFind });
  return { db, restore, t1, t2, foreign };
}

const run = async (handler, { params = { id: EVENT_ID }, body = {}, user = OWNER } = {}) => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ params, body, user }, res);
  return res;
};
const withDb = (name, fn) =>
  test(name, async () => {
    const ctx = await setup();
    try {
      await fn(ctx);
    } finally {
      ctx.restore();
    }
  });

withDb('a valid ticket is checked in and the guest\'s details come back', async ({ t1, db }) => {
  const r = await run(eventController.checkInTicket, { body: { ticketId: t1.ticketId } });
  assert.equal(r.code, 200);
  assert.equal(r.body.data.ticket.status, 'used');
  assert.equal(r.body.data.ticket.buyer.firstName, 'Ada');
  assert.equal(r.body.data.ticket.name, 'Regular');
  assert.ok(db.Ticket.docs.find((t) => t.ticketId === t1.ticketId).usedAt);
  assert.equal(db.Ticket.docs.find((t) => t.ticketId === t1.ticketId).checkedInBy, 'host1', 'who scanned is recorded');
});

withDb('two scanners reading the same ticket at the same instant admit the guest only once', async ({ t1, db }) => {
  const results = await Promise.all([1, 2, 3, 4].map(() => run(eventController.checkInTicket, { body: { ticketId: t1.ticketId } })));
  const codes = results.map((r) => r.code).sort();
  assert.deepEqual(codes, [200, 409, 409, 409]);
  const rejected = results.find((r) => r.code === 409);
  assert.equal(rejected.body.code, 'already_used');
  assert.equal(rejected.body.data.ticket.buyer.firstName, 'Ada', 'the door can see who it was');
  assert.ok(rejected.body.data.ticket.usedAt, 'and when they were admitted');
  assert.equal(db.Ticket.docs.filter((t) => t.isUsed).length, 1);
});

withDb('a scanned QR (JSON) works, and a QR from another event is refused with a clear reason', async ({ t1 }) => {
  const qr = (extra) => JSON.stringify({ eventId: EVENT_ID, ticketId: t1.ticketId, ticketName: 'Regular', ...extra });
  assert.equal((await run(eventController.checkInTicket, { body: { ticketId: qr() } })).code, 200);

  const other = await run(eventController.checkInTicket, { body: { ticketId: qr({ eventId: OTHER_EVENT, ticketId: 'zzzz' }) } });
  assert.equal(other.code, 404);
  assert.equal(other.body.code, 'wrong_event');
});

withDb('tickets for another event, and unknown tickets, are told apart', async ({ foreign }) => {
  const wrong = await run(eventController.checkInTicket, { body: { ticketId: foreign.ticketId } });
  assert.equal(wrong.body.code, 'wrong_event');
  assert.equal(wrong.body.message, 'This ticket is for a different event');
  const unknown = await run(eventController.checkInTicket, { body: { ticketId: 'does-not-exist' } });
  assert.equal(unknown.code, 404);
  assert.equal(unknown.body.code, 'not_found');
});

withDb('only the event owner can check in, and bad input is rejected', async ({ t1, db }) => {
  const stranger = await run(eventController.checkInTicket, { body: { ticketId: t1.ticketId }, user: { _id: 'someone-else' } });
  assert.equal(stranger.code, 403);
  assert.equal(db.Ticket.docs.filter((t) => t.isUsed).length, 0);
  assert.equal((await run(eventController.checkInTicket, { body: {} })).code, 400);
  assert.equal((await run(eventController.checkInTicket, { body: { ticketId: { $ne: null } } })).code, 400, 'objects (NoSQL injection) are not treated as ids');
  assert.equal((await run(eventController.checkInTicket, { params: { id: 'nope' }, body: { ticketId: 'x' } })).code, 400);
});

withDb('a ticket whose buyer record was deleted can still be checked in (no crash after marking it used)', async ({ t1, db }) => {
  db.User.docs.splice(0, db.User.docs.length);
  const r = await run(eventController.checkInTicket, { body: { ticketId: t1.ticketId } });
  assert.equal(r.code, 200);
  assert.equal(r.body.data.ticket.buyer.firstName, '');
});

withDb('a mistaken check-in can be undone once, and the guest can then be checked in again', async ({ t1, db }) => {
  assert.equal((await run(eventController.undoCheckIn, { body: { ticketId: t1.ticketId } })).code, 409, 'nothing to undo yet');
  await run(eventController.checkInTicket, { body: { ticketId: t1.ticketId } });
  const undone = await run(eventController.undoCheckIn, { body: { ticketId: t1.ticketId } });
  assert.equal(undone.code, 200);
  assert.equal(undone.body.data.ticket.status, 'valid');
  const row = db.Ticket.docs.find((t) => t.ticketId === t1.ticketId);
  assert.equal(row.isUsed, false);
  assert.equal(row.usedAt, undefined);
  assert.equal((await run(eventController.checkInTicket, { body: { ticketId: t1.ticketId } })).code, 200);
  assert.equal((await run(eventController.undoCheckIn, { body: { ticketId: 'nope' } })).code, 404);
  assert.equal((await run(eventController.undoCheckIn, { body: { ticketId: t1.ticketId }, user: { _id: 'x' } })).code, 403);
});

withDb('search finds by full id, id prefix, email and name, only within this event', async ({ t1 }) => {
  const find = async (search) => run(eventController.searchTicket, { body: { search } });
  assert.equal((await find(t1.ticketId)).body.data.tickets[0].buyer.firstName, 'Ada');
  assert.equal((await find('aaaa1111')).body.data.tickets.length, 1, 'prefix of an id');
  assert.equal((await find('tunde@')).body.data.tickets[0].buyer.firstName, 'Tunde', 'by email');
  assert.equal((await find('ada okafor')).body.data.tickets.length, 1, 'by full name');
  assert.equal((await find('okafor')).body.data.tickets[0].buyer.phone, '0801');
  const none = await find('nobody');
  assert.equal(none.code, 404);
  // Ada also holds a ticket for a different event; it must not appear here.
  assert.equal((await find('ada')).body.data.tickets.length, 1);
});

withDb('search treats user input literally (regex characters cannot break or slow it down)', async () => {
  for (const evil of ['(a+)+$', '.*', '[', '\\']) {
    const r = await run(eventController.searchTicket, { body: { search: evil } });
    assert.ok([200, 404].includes(r.code), `search "${evil}" -> ${r.code}`);
    assert.notEqual(r.code, 500);
  }
  assert.equal((await run(eventController.searchTicket, { body: { search: { $ne: '' } } })).code, 400);
  assert.equal((await run(eventController.searchTicket, { body: { search: '   ' } })).code, 400);
});

withDb('recent check-ins ask for newest first and survive a deleted buyer', async ({ t1, t2, db }) => {
  await run(eventController.checkInTicket, { body: { ticketId: t1.ticketId } });
  await run(eventController.checkInTicket, { body: { ticketId: t2.ticketId } });
  db.User.docs = db.User.docs.filter((u) => u._id !== 'u1'); // Ada's record disappears

  let sortRequested;
  const baseFind = Ticket.find;
  Ticket.find = (f) => {
    const q = baseFind(f);
    const baseSort = q.sort;
    q.sort = (arg) => {
      sortRequested = arg;
      return baseSort(arg);
    };
    return q;
  };
  const r = await run(eventController.getCheckins);
  assert.equal(r.code, 200);
  assert.deepEqual(sortRequested, { usedAt: -1 });
  assert.deepEqual(r.body.data.checkins.map((c) => c.guestEmail).sort(), [null, 'tunde@example.com']);
  assert.equal(r.body.data.checkins[0].ticketName, 'Regular');
});
