// Minimal in-memory stand-in for the Mongoose operations used by services/orderService.
// Each operation runs synchronously after a single event-loop yield, so — like a single MongoDB
// update — it is atomic with respect to other callers. It is NOT a MongoDB emulator; it only
// implements the operators the service uses. See the report: real-Mongo concurrency is untested.
let seq = 0;
const newId = () => `id${(seq += 1)}`;
const yieldTurn = () => new Promise((r) => setImmediate(r));
const clone = (v) => (v === undefined ? v : structuredClone(v));

function values(doc, path) {
  let cur = [doc];
  for (const part of path.split('.')) {
    cur = cur.flatMap((c) => {
      if (c == null) return [];
      const v = c[part];
      return Array.isArray(v) ? v : [v];
    });
  }
  return cur;
}

const eq = (a, b) => (a instanceof Date || b instanceof Date ? +a === +b : String(a) === String(b));
const isOps = (c) => c && typeof c === 'object' && !(c instanceof Date) && Object.keys(c).some((k) => k.startsWith('$'));

function matchCond(list, cond) {
  if (!isOps(cond)) {
    if (cond === null) return list.every((v) => v == null);
    return list.some((v) => eq(v, cond));
  }
  return Object.entries(cond).every(([op, arg]) => {
    switch (op) {
      case '$in': return list.some((v) => arg.some((a) => eq(v, a)));
      case '$ne': return !list.some((v) => eq(v, arg));
      case '$lt': return list.some((v) => v != null && +v < +arg);
      case '$lte': return list.some((v) => v != null && +v <= +arg);
      case '$gt': return list.some((v) => v != null && +v > +arg);
      case '$gte': return list.some((v) => v != null && +v >= +arg);
      case '$elemMatch': return list.some((el) => match(el, arg));
      default: throw new Error(`fakeDb: unsupported operator ${op}`);
    }
  });
}

function match(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return cond.some((f) => match(doc, f));
    return matchCond(values(doc, key), cond);
  });
}

function setPath(doc, path, value) {
  const parts = path.split('.');
  let cur = doc;
  parts.slice(0, -1).forEach((p) => { cur[p] ??= {}; cur = cur[p]; });
  cur[parts.at(-1)] = value;
}
const getPath = (doc, path) => path.split('.').reduce((c, p) => (c == null ? c : c[p]), doc);

// Index of the first element of `tickets` that satisfied the filter (for the positional `$`).
function positionalIndex(doc, filter) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === 'tickets' && cond.$elemMatch) return doc.tickets.findIndex((el) => match(el, cond.$elemMatch));
    if (key.startsWith('tickets.')) {
      const sub = key.slice('tickets.'.length);
      return doc.tickets.findIndex((el) => matchCond(values(el, sub), cond));
    }
  }
  return -1;
}

function applyUpdate(doc, update, filter) {
  const idx = positionalIndex(doc, filter);
  const resolve = (path) => path.replace('.$.', `.${idx}.`);
  for (const [path, v] of Object.entries(update.$set || {})) setPath(doc, resolve(path), clone(v));
  for (const [path, v] of Object.entries(update.$inc || {})) setPath(doc, resolve(path), (getPath(doc, resolve(path)) || 0) + v);
  for (const [path, v] of Object.entries(update.$push || {})) setPath(doc, path, [...(getPath(doc, path) || []), v]);
  for (const [path, v] of Object.entries(update.$addToSet || {})) {
    const arr = getPath(doc, path) || [];
    if (!arr.some((x) => eq(x, v))) setPath(doc, path, [...arr, v]);
  }
  for (const [path, v] of Object.entries(update.$pull || {})) setPath(doc, path, (getPath(doc, path) || []).filter((x) => !eq(x, v)));
  for (const [path, v] of Object.entries(update.$setOnInsert || {})) if (doc.__inserted) setPath(doc, path, clone(v));
}

// Thenable that also tolerates the Mongoose chain methods the service calls.
function query(promiseFn) {
  const q = { select: () => q, lean: () => q, populate: () => q, then: (a, b) => promiseFn().then(a, b) };
  return q;
}

class Collection {
  constructor({ unique = [], defaults = {} } = {}) {
    this.docs = [];
    this.unique = unique;
    this.defaults = defaults;
  }
  _insert(data) {
    for (const field of this.unique) {
      if (this.docs.some((d) => eq(d[field], data[field]))) {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
    }
    const doc = { _id: newId(), createdAt: new Date(), ...clone(this.defaults), ...clone(data) };
    this.docs.push(doc);
    return doc;
  }
  async create(data) { await yieldTurn(); return clone(this._insert(data)); }
  findOne(filter) { return query(async () => { await yieldTurn(); return clone(this.docs.find((d) => match(d, filter))) || null; }); }
  findById(id) { return this.findOne({ _id: id }); }
  find(filter) {
    return query(async () => { await yieldTurn(); return this.docs.filter((d) => match(d, filter)).map(clone); });
  }
  async exists(filter) { await yieldTurn(); return this.docs.some((d) => match(d, filter)) ? { _id: 1 } : null; }
  async updateOne(filter, update) {
    await yieldTurn();
    const doc = this.docs.find((d) => match(d, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    applyUpdate(doc, update, filter);
    return { matchedCount: 1, modifiedCount: 1 };
  }
  async findOneAndUpdate(filter, update, opts = {}) {
    await yieldTurn();
    let doc = this.docs.find((d) => match(d, filter));
    if (!doc && opts.upsert) {
      const base = Object.fromEntries(Object.entries(filter).filter(([k, v]) => !k.startsWith('$') && !isOps(v)));
      doc = this._insert({ ...base, ...clone(this.defaults) });
      doc.__inserted = true;
    }
    if (!doc) return null;
    const before = clone(doc);
    applyUpdate(doc, update, filter);
    delete doc.__inserted;
    return opts.new ? clone(doc) : before;
  }
}

function createFakeDeps() {
  const users = new Collection();
  const tickets = new Collection({ unique: ['ticketId'] });
  const populateBuyer = (list) => list.map((t) => ({ ...t, buyer: users.docs.find((u) => u._id === t.buyer) }));
  const Ticket = Object.assign(tickets, {
    find: (filter) => query(async () => { await yieldTurn(); return populateBuyer(tickets.docs.filter((d) => match(d, filter)).map(clone)); }),
  });
  const Event = new Collection();
  const sent = [];
  const stub = { verify: async () => null, init: async () => ({ authorization_url: 'https://pay.test/x', access_code: 'ac' }) };
  return {
    stub,
    sent,
    deps: {
      Event,
      Order: new Collection({ unique: ['reference'], defaults: { status: 'pending', hostCredited: false, emailAttempts: 0, ticketIds: [] } }),
      Ticket,
      Transaction: new Collection({ unique: ['reference'] }),
      User: users,
      Host: new Collection(),
      paystack: {
        verifyTransaction: (ref) => stub.verify(ref),
        initializeTransaction: (args) => stub.init(args),
      },
      uploadQr: async (_buf, id) => `https://cdn.test/${id}.png`,
      sendEmail: async (msg) => { sent.push(msg); },
    },
  };
}

module.exports = { createFakeDeps };
