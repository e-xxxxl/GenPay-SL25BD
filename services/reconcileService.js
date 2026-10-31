// services/reconcileService.js
// Paystack is the source of truth for what was paid. This service makes sure that every
// successful payment it reports ends up as (a) a PaymentLog row, so it can always be traced, and
// (b) a completed order with tickets, or a clearly flagged item for a person to resolve.
// It does not depend on the buyer's browser returning or on webhook delivery.
const orders = require('./orderService');

const settle = (reference) => orders.settleOrder(reference);

// Maps what happened when we tried to settle a payment to the PaymentLog status.
function classify(wasCompleted, settlement) {
  switch (settlement.state) {
    case 'completed':
      return wasCompleted
        ? { status: 'matched' }
        : { status: 'recovered', reason: 'Tickets were issued by the reconciliation process.' };
    case 'unfulfillable':
      return { status: 'needs_action', reason: 'Payment received but the tickets sold out. Refund the buyer.' };
    case 'mismatch':
      return { status: 'needs_action', reason: settlement.detail || settlement.order?.failureReason || 'Amount paid does not match the order.' };
    case 'not_found':
      return { status: 'needs_action', reason: 'No matching order or ticket purchase was found for this payment.' };
    case 'failed':
      return { status: 'needs_action', reason: 'Provider reports this payment as failed after it was confirmed.' };
    default:
      return { status: 'unresolved', reason: `Not settled yet (${settlement.state}); will be retried.` };
  }
}

async function writeLog(tx, source, patch = {}) {
  const { PaymentLog } = orders.deps;
  return PaymentLog.findOneAndUpdate(
    { reference: tx.reference },
    {
      $setOnInsert: {
        reference: tx.reference,
        firstSeenAt: new Date(),
        source,
        amountKobo: tx.amount,
        currency: tx.currency,
        email: tx.customer?.email,
        channel: tx.channel,
        paidAt: tx.paid_at ? new Date(tx.paid_at) : undefined,
        metadata: { orderId: tx.metadata?.orderId && String(tx.metadata.orderId), eventId: tx.metadata?.eventId && String(tx.metadata.eventId) },
      },
      $set: { lastAttemptAt: new Date(), ...patch },
      $inc: { attempts: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/**
 * Brings one successful provider payment to a final state. `tx` is Paystack's transaction object
 * (from the webhook or the list API). Never throws for provider outages: the payment stays
 * "unresolved" and is retried by the next sweep.
 */
async function reconcileTransaction(tx, source = 'reconcile', { force = false } = {}) {
  const { Order, PaymentLog } = orders.deps;
  const reference = tx?.reference;
  if (!reference) throw new Error('Transaction has no reference');

  const existing = await PaymentLog.findOne({ reference }).lean();
  if (!force && existing && ['matched', 'recovered', 'dismissed'].includes(existing.status)) {
    return { status: existing.status, settlement: { state: 'completed' }, skipped: true };
  }

  const before = await Order.findOne({ reference }).select('status').lean();
  await writeLog(tx, source);

  let settlement;
  try {
    settlement = await settle(reference);
  } catch (err) {
    console.error(`[reconcile] ${reference}: ${err.message}`);
    settlement = { state: 'error' };
  }

  const outcome = classify(before?.status === 'completed', settlement);
  await orders.deps.PaymentLog.updateOne(
    { reference },
    {
      $set: {
        status: outcome.status,
        reason: outcome.reason || null,
        lastState: settlement.state,
        resolvedAt: ['matched', 'recovered'].includes(outcome.status) ? new Date() : null,
      },
    }
  );
  if (outcome.status === 'needs_action') console.error(`[reconcile] ACTION NEEDED ${reference}: ${outcome.reason}`);
  return { ...outcome, settlement };
}

/**
 * Walks Paystack's successful transactions in [from, to] and reconciles each one.
 * Stops early (reporting partial results) if the provider is unreachable.
 */
async function reconcileWindow({ from, to = new Date(), maxPages = 10, perPage = 100 } = {}) {
  const summary = { checked: 0, matched: 0, recovered: 0, needsAction: 0, unresolved: 0, skipped: 0, pages: 0, complete: true, error: null };
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();

  for (let page = 1; page <= maxPages; page += 1) {
    let batch;
    try {
      batch = await orders.deps.paystack.listTransactions({ status: 'success', from: fromIso, to: toIso, page, perPage });
    } catch (err) {
      summary.complete = false;
      summary.error = 'Could not read transactions from Paystack. Try again shortly.';
      console.error('[reconcile] list failed:', err.message);
      return summary;
    }
    summary.pages = page;

    for (const tx of batch.transactions) {
      summary.checked += 1;
      const result = await reconcileTransaction(tx, 'reconcile');
      if (result.skipped) summary.skipped += 1;
      else if (result.status === 'matched') summary.matched += 1;
      else if (result.status === 'recovered') summary.recovered += 1;
      else if (result.status === 'needs_action') summary.needsAction += 1;
      else summary.unresolved += 1;
    }
    if (page >= batch.pageCount) return summary;
  }
  summary.complete = false; // more pages exist than we were allowed to read
  return summary;
}

module.exports = { reconcileTransaction, reconcileWindow, classify };
