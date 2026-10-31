#!/usr/bin/env node
/**
 * Finds successful Paystack payments that have no tickets in the database, and (optionally)
 * recovers them.
 *
 *   node scripts/reconcile-paystack.js --from=2026-09-01 [--to=2026-10-31]          # DRY RUN
 *   node scripts/reconcile-paystack.js --from=2026-09-01 --apply                    # recover
 *
 * DRY RUN (default) only READS: it lists each payment and what the database knows about it.
 * --apply settles each missing payment through the same code the live server uses (verifies with
 * Paystack, checks the amount, deducts stock once, issues tickets, emails the buyer). Payments
 * that were already fulfilled are never issued twice. Payments it cannot fix are written to the
 * PaymentLog so they appear on the admin Payments screen.
 *
 * Needs MONGODB_URI, PAYSTACK_SECRET_KEY (and Cloudinary/Resend settings when using --apply).
 */
require('dotenv').config();
const mongoose = require('mongoose');

const apply = process.argv.includes('--apply');
// A dry run must not write anything, including the collections/indexes Mongoose would otherwise create.
if (!apply) {
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
}

const Order = require('../models/order');
const Transaction = require('../models/transaction');
const paystack = require('../services/paystack');
const reconcile = require('../services/reconcileService');

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1];
const naira = (kobo) => `₦${(Number(kobo) / 100).toLocaleString('en-NG')}`;

async function classify(tx) {
  const order = await Order.findOne({ reference: tx.reference }).select('status failureReason lastError').lean();
  if (order?.status === 'completed') return { label: 'OK', fixable: false };
  if (order) return { label: `STUCK (${order.status})`, fixable: true, detail: order.failureReason || order.lastError };
  if (await Transaction.exists({ reference: tx.reference })) return { label: 'OK (earlier purchase)', fixable: false };
  const md = tx.metadata || {};
  const recoverable = md.eventId && md.tickets;
  return { label: recoverable ? 'MISSING (recoverable)' : 'MISSING (no ticket details)', fixable: Boolean(recoverable) };
}

(async () => {
  const from = arg('from');
  if (!from || Number.isNaN(Date.parse(from))) {
    console.error('Usage: node scripts/reconcile-paystack.js --from=YYYY-MM-DD [--to=YYYY-MM-DD] [--apply]');
    process.exit(1);
  }
  const to = arg('to') ? new Date(arg('to')) : new Date();
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`${apply ? 'APPLYING' : 'DRY RUN (read-only)'}: successful Paystack payments ${new Date(from).toISOString()} -> ${to.toISOString()}\n`);

  const counts = {};
  let recovered = 0;
  for (let page = 1; page <= 200; page += 1) {
    const batch = await paystack.listTransactions({ status: 'success', from: new Date(from).toISOString(), to: to.toISOString(), page, perPage: 100 });
    for (const tx of batch.transactions) {
      const verdict = await classify(tx);
      counts[verdict.label] = (counts[verdict.label] || 0) + 1;
      if (verdict.label.startsWith('OK')) continue;
      console.log(`${verdict.label.padEnd(30)} ${tx.reference}  ${naira(tx.amount).padStart(12)}  ${tx.paid_at?.slice(0, 16) || ''}  ${tx.customer?.email || ''}${verdict.detail ? `  [${verdict.detail}]` : ''}`);
      if (apply) {
        const result = await reconcile.reconcileTransaction(tx, 'reconcile', { force: true });
        console.log(`    -> ${result.status}${result.reason ? `: ${result.reason}` : ''}`);
        if (result.status === 'recovered') recovered += 1;
      }
    }
    if (page >= batch.pageCount) break;
  }

  console.log('\nSummary:');
  Object.entries(counts).forEach(([label, n]) => console.log(`  ${label.padEnd(30)} ${n}`));
  if (apply) console.log(`  recovered this run: ${recovered}`);
  else console.log('\nNothing was changed. Re-run with --apply to recover the MISSING / STUCK payments above.');
  await mongoose.disconnect();
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
