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
const withHost = (e, host = { userType: 'organization', organizationName: 'Host Co' }) => ({ ...e, host, attendeesCount: 42 });

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

test('links that are not web URLs (e.g. javascript:) are rejected when updating an event', async () => {
  const token = jwt.sign({ id: 'hostA' }, process.env.JWT_SECRET);
  const origHost = Host.findById;
  const origEvent = Event.findById;
  const origUpdate = Event.findByIdAndUpdate;
  let updated = false;
  Host.findById = async () => ({ _id: 'hostA' });
  Event.findById = () => chain({ host: { _id: 'hostA' } });
  Event.findByIdAndUpdate = async () => { updated = true; return {}; };
  try {
    for (const socialLinks of [{ instagram: 'javascript:alert(1)' }, { website: 'data:text/html,<script>1</script>' }]) {
      const r = res();
      await eventController.updateEvent(
        { headers: { authorization: `Bearer ${token}` }, params: { id: 'e1' }, body: { eventLocation: { venue: 'x' }, socialLinks } },
        r
      );
      assert.equal(r.code, 400, JSON.stringify(socialLinks));
    }
    assert.equal(updated, false);

    const ok = res();
    await eventController.updateEvent(
      { headers: { authorization: `Bearer ${token}` }, params: { id: 'e1' }, body: { eventLocation: { venue: 'x' }, eventUrl: 'https://genpay.ng/explore/x', socialLinks: { instagram: 'https://instagram.com/a' } } },
      ok
    );
    assert.equal(ok.code, 200);
  } finally {
    Host.findById = origHost;
    Event.findById = origEvent;
    Event.findByIdAndUpdate = origUpdate;
  }
});

test('public events show the real host name (the old code showed "Unknown Host" for everyone)', async () => {
  const cases = [
    [{ userType: 'individual', firstName: 'Ada', lastName: 'Okafor', email: 'ada@example.com', availableBalance: 5000 }, 'Ada Okafor'],
    [{ userType: 'organization', organizationName: 'Sporting Lagos' }, 'Sporting Lagos'],
    [{ userType: 'individual', firstName: 'Tunde' }, 'Tunde'],
    [{ userType: 'organization', firstName: 'Ada', lastName: 'Okafor' }, 'Ada Okafor'],
    [null, ''],
  ];
  const orig = Event.find;
  const origOne = Event.findOne;
  try {
    for (const [host, expected] of cases) {
      Event.find = () => chain([withHost(makeEvent(), host)]);
      const list = res();
      await eventController.getPublicEvents({}, list);
      assert.equal(list.body.data.events[0].host.displayName, expected, JSON.stringify(host));
      assert.deepEqual(Object.keys(list.body.data.events[0].host), ['displayName'], 'no other host fields are exposed');

      Event.findOne = () => chain(withHost(makeEvent(), host));
      const one = res();
      await eventController.getEventByName({ params: { eventName: 'lagos-night' } }, one);
      assert.equal(one.body.data.event.host.displayName, expected);
    }
  } finally {
    Event.find = orig;
    Event.findOne = origOne;
  }
});
