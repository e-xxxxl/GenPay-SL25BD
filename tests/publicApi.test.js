const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const Event = require('../models/event');
const Host = require('../models/host');
const eventController = require('../controllers/eventController');
const { makeEvent } = require('./helpers/fixtures');

process.env.JWT_SECRET = 'test-secret';

// Chainable stand-in for a Mongoose query that resolves to `value`.
const chain = (value) => {
  const q = { sort: () => q, select: () => q, populate: () => q, lean: () => q, then: (a, b) => Promise.resolve(value).then(a, b) };
  return q;
};
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const withHost = (e) => ({ ...e, host: { displayName: 'Host Co' }, attendeesCount: 42 });

test('public list: hidden events expose no counts, visible events keep them', async () => {
  const hidden = withHost(makeEvent({ showTicketQuantity: false }));
  const shown = withHost({ ...makeEvent({ _id: 'e2', slug: 'b' }), showTicketQuantity: true });
  const orig = Event.find;
  Event.find = () => chain([hidden, shown]);
  try {
    const r = res();
    await eventController.getPublicEvents({}, r);
    const [h, s] = r.body.data.events;
    assert.doesNotMatch(JSON.stringify(h), /"quantity"|"attendeesCount"|processedRefs/);
    assert.equal(h.showTicketQuantity, false);
    assert.equal(s.tickets[0].quantity, 3);
    assert.equal(s.showTicketQuantity, true);
  } finally {
    Event.find = orig;
  }
});

test('public by-slug: hidden event hides quantity and attendee count; lookup is exact, not a regex', async () => {
  const orig = Event.findOne;
  let seenQuery;
  Event.findOne = (q) => { seenQuery = q; return chain(withHost(makeEvent({ showTicketQuantity: false }))); };
  try {
    const r = res();
    await eventController.getEventByName({ params: { eventName: 'Lagos-Night' } }, r);
    assert.doesNotMatch(JSON.stringify(r.body), /"quantity"|attendeesCount/);
    assert.equal(seenQuery.slug, 'lagos-night');
    assert.equal(typeof seenQuery.slug, 'string', 'no $regex operator reachable from user input');

    await eventController.getEventByName({ params: { eventName: { $ne: 'x' } } }, res());
    assert.equal(typeof seenQuery.slug, 'string');
  } finally {
    Event.findOne = orig;
  }
});

test('only the owning host can change the quantity-visibility setting', async () => {
  const token = jwt.sign({ id: 'hostB' }, process.env.JWT_SECRET);
  const origHost = Host.findById;
  const origEvent = Event.findById;
  const origUpdate = Event.findByIdAndUpdate;
  let updated = false;
  Host.findById = async () => ({ _id: 'hostB' });
  Event.findById = () => chain({ host: { _id: 'hostA' } });
  Event.findByIdAndUpdate = async () => { updated = true; return {}; };
  try {
    const r = res();
    await eventController.updateEvent(
      { headers: { authorization: `Bearer ${token}` }, params: { id: 'e1' }, body: { eventLocation: { venue: 'x' }, showTicketQuantity: false } },
      r
    );
    assert.equal(r.code, 403);
    assert.equal(updated, false);
  } finally {
    Host.findById = origHost;
    Event.findById = origEvent;
    Event.findByIdAndUpdate = origUpdate;
  }
});

test('owner update persists the flag and never writes ticket tiers (cannot clobber stock)', async () => {
  const token = jwt.sign({ id: 'hostA' }, process.env.JWT_SECRET);
  const origHost = Host.findById;
  const origEvent = Event.findById;
  const origUpdate = Event.findByIdAndUpdate;
  let written;
  Host.findById = async () => ({ _id: 'hostA' });
  Event.findById = () => chain({ host: { _id: 'hostA' } });
  Event.findByIdAndUpdate = async (_id, update) => { written = update; return { ...update }; };
  try {
    const r = res();
    await eventController.updateEvent(
      {
        headers: { authorization: `Bearer ${token}` },
        params: { id: 'e1' },
        body: { eventLocation: { venue: 'x' }, showTicketQuantity: false, ticketTiers: [{ id: 't1', quantity: 9999 }] },
      },
      r
    );
    assert.equal(r.code, 200);
    assert.equal(written.showTicketQuantity, false);
    assert.equal('tickets' in written, false, 'stale ticketTiers from the edit form must not overwrite live stock');
  } finally {
    Host.findById = origHost;
    Event.findById = origEvent;
    Event.findByIdAndUpdate = origUpdate;
  }
});
