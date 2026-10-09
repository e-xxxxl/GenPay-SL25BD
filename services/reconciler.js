// services/reconciler.js
// Safety net for payments whose callback/webhook never arrived (buyer closed the tab, webhook
// delivery failed, a worker crashed mid-fulfilment) and for confirmation emails that failed.
// Everything it calls is idempotent, so running on several instances at once is safe.
const orders = require('./orderService');

const SWEEP_MS = 5 * 60 * 1000;
const FRESH_WINDOW_MS = 60 * 60 * 1000; // check unpaid orders every 5 min for the first hour...
const SLOW_CHECK_MS = 60 * 60 * 1000; //   ...then hourly
const EXPIRE_AFTER_MS = 48 * 60 * 60 * 1000;
const BATCH = 50;

async function sweepOnce(now = Date.now()) {
  const { Order } = orders.deps;
  const ago = (ms) => new Date(now - ms);

  const due = await Order.find({
    provider: 'paystack',
    createdAt: { $gt: ago(EXPIRE_AFTER_MS), $lt: ago(3 * 60 * 1000) }, // give the buyer's own callback/webhook first
    $or: [
      { status: 'processing', lockedAt: { $lt: ago(orders.LOCK_MS) } },
      {
        status: 'pending',
        $or: [
          { createdAt: { $gt: ago(FRESH_WINDOW_MS) }, lastCheckedAt: { $lt: ago(SWEEP_MS - 30000) } },
          { createdAt: { $lte: ago(FRESH_WINDOW_MS) }, lastCheckedAt: { $lt: ago(SLOW_CHECK_MS) } },
        ],
      },
    ],
  })
    .limit(BATCH)
    .select('reference');

  for (const { reference } of due) {
    try {
      await orders.settleOrder(reference);
    } catch (err) {
      console.error(`[reconciler] ${reference}:`, err.message);
    }
  }

  // Free orders left half-done by a crash.
  const stuckFree = await Order.find({ provider: 'free', status: { $in: ['pending', 'processing'] }, createdAt: { $lt: ago(5 * 60 * 1000), $gt: ago(EXPIRE_AFTER_MS) } })
    .limit(BATCH)
    .select('reference');
  for (const { reference } of stuckFree) {
    try {
      await orders.settleOrder(reference);
    } catch (err) {
      console.error(`[reconciler] ${reference}:`, err.message);
    }
  }

  await Order.updateMany(
    { status: 'pending', createdAt: { $lt: ago(EXPIRE_AFTER_MS) } },
    { $set: { status: 'expired' } }
  );

  const unemailed = await Order.find({ status: 'completed', emailSentAt: null, emailAttempts: { $lt: 5 }, completedAt: { $gt: ago(24 * 60 * 60 * 1000) } })
    .limit(BATCH)
    .select('_id');
  for (const { _id } of unemailed) {
    await orders.sendConfirmationEmails(_id).catch((err) => console.error('[reconciler] email:', err.message));
  }
}

function start() {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepOnce();
    } catch (err) {
      console.error('[reconciler] sweep failed:', err.message);
    } finally {
      running = false;
    }
  }, SWEEP_MS);
  timer.unref();
  return timer;
}

module.exports = { start, sweepOnce };
