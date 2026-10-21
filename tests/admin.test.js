const test = require('node:test');
const assert = require('node:assert/strict');

const Host = require('../models/host');
const Event = require('../models/event');
const Payout = require('../models/payout');
const admin = require('../controllers/adminDashboardController');

const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const chain = (value, spy = {}) => {
  const q = {
    select: (f) => { spy.select = f; return q; },
    sort: () => q, skip: () => q, limit: () => q, lean: () => q,
    then: (a, b) => Promise.resolve(value).then(a, b),
  };
  return q;
};
const hostDoc = (over) => {
  const data = { _id: 'h1', userType: 'individual', firstName: 'Ada', lastName: 'Okafor', email: 'ada@example.com', isVerified: true, availableBalance: 5000, ...over };
  return { ...data, toObject: () => ({ ...data }) };
};

function stubModels({ hosts, events = [], payouts = [] }) {
  const calls = { hostFilter: null, hostSelect: null, eventFinds: 0, payoutFinds: 0 };
  const orig = { hf: Host.find, hc: Host.countDocuments, ef: Event.find, pf: Payout.find };
  Host.find = (filter) => { calls.hostFilter = filter; const spy = {}; const q = chain(hosts, spy); const sel = q.select; q.select = (f) => { calls.hostSelect = f; return sel(f); }; return q; };
  Host.countDocuments = async () => hosts.length;
  Event.find = () => { calls.eventFinds += 1; return chain(events); };
  Payout.find = () => { calls.payoutFinds += 1; return chain(payouts); };
  return { calls, restore: () => { Host.find = orig.hf; Host.countDocuments = orig.hc; Event.find = orig.ef; Payout.find = orig.pf; } };
}

test('hosts list shows real names and verification status, with per-host stats from batched queries', async () => {
  const hosts = [hostDoc({}), hostDoc({ _id: 'h2', userType: 'organization', organizationName: 'Sporting Lagos', isVerified: false })];
  const m = stubModels({
    hosts,
    events: [
      { host: 'h1', tickets: [{ price: 1000, quantity: 3 }, { price: 500, quantity: 2 }] },
      { host: 'h1', tickets: [{ price: 200, quantity: 5 }] },
      { host: 'h2', tickets: [] },
    ],
    payouts: [{ host: 'h1', amount: 700 }],
  });
  try {
    const r = res();
    await admin.getAllHosts({ query: {} }, r);
    const [ada, org] = r.body.data.hosts;
    assert.equal(ada.displayName, 'Ada Okafor');
    assert.equal(org.displayName, 'Sporting Lagos');
    assert.equal(ada.isVerified, true);
    assert.equal(org.isVerified, false);
    assert.deepEqual([ada.totalEvents, ada.totalRevenue, ada.totalPayouts], [2, 5000, 700]);
    assert.deepEqual([org.totalEvents, org.totalRevenue, org.totalPayouts], [1, 0, 0]);
    assert.equal(m.calls.eventFinds, 1, 'one events query for the page, not one per host');
    assert.equal(m.calls.payoutFinds, 1);
    for (const field of ['firstName', 'lastName', 'organizationName', 'userType', 'isVerified']) {
      assert.match(m.calls.hostSelect, new RegExp(field), `${field} must be selected for displayName and the status badge`);
    }
  } finally {
    m.restore();
  }
});

test('hosts search is escaped (cannot inject a regex) and status filters are applied', async () => {
  const m = stubModels({ hosts: [] });
  try {
    await admin.getAllHosts({ query: { q: '.*(a+)+$', status: 'pending' } }, res());
    const rx = m.calls.hostFilter.$or[0].firstName;
    assert.ok(rx instanceof RegExp);
    assert.equal(rx.test('anything at all'), false, 'regex metacharacters are matched literally');
    assert.equal(rx.test('x.*(a+)+$x'), true);
    assert.deepEqual(m.calls.hostFilter.isVerified, { $ne: true });

    await admin.getAllHosts({ query: { status: 'verified' } }, res());
    assert.equal(m.calls.hostFilter.isVerified, true);

    await admin.getAllHosts({ query: { limit: '100000', page: '-4' } }, res());
  } finally {
    m.restore();
  }
});
