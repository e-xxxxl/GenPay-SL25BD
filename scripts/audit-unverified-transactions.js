#!/usr/bin/env node
/**
 * READ-ONLY audit of historical paid transactions.
 *
 * Before the payment-verification fix, POST /api/events/:id/purchase-ticket issued tickets for any
 * client-supplied `reference` without confirming it with Paystack. This script lists completed
 * Paystack transactions whose reference Paystack does not confirm (missing / unsuccessful) or whose
 * amount differs from what was recorded. It writes NOTHING to the database and never charges anyone.
 *
 *   node scripts/audit-unverified-transactions.js [--limit=500] [--event=<eventId>] [--since=2025-01-01]
 *
 * Needs MONGODB_URI and PAYSTACK_SECRET_KEY in the environment (.env is loaded). Run it against a
 * copy/staging database first if you can; against production it only reads.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Transaction = require('../models/transaction');
const paystack = require('../services/paystack');

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const limit = Number(arg('limit')) || 0;
  const filter = { paymentProvider: 'paystack', total: { $gt: 0 } };
  if (arg('event')) filter.event = arg('event');
  if (arg('since')) filter.createdAt = { $gte: new Date(arg('since')) };

  await mongoose.connect(process.env.MONGODB_URI);
  const query = Transaction.find(filter).sort({ createdAt: -1 }).select('reference total event createdAt').lean();
  if (limit) query.limit(limit);
  const transactions = await query;
  console.log(`Auditing ${transactions.length} transactions (read-only)...`);

  const suspicious = [];
  for (const t of transactions) {
    try {
      const tx = await paystack.verifyTransaction(t.reference);
      if (!tx) suspicious.push({ ...t, problem: 'reference not found at Paystack' });
      else if (tx.status !== 'success') suspicious.push({ ...t, problem: `Paystack status: ${tx.status}` });
      else if (Number(tx.amount) !== Math.round(t.total * 100)) {
        suspicious.push({ ...t, problem: `amount mismatch: recorded ${t.total}, Paystack ${tx.amount / 100}` });
      }
    } catch (err) {
      suspicious.push({ ...t, problem: `could not verify (${err.message})` });
    }
    await sleep(250); // stay well under Paystack's rate limits
  }

  console.log(`\n${suspicious.length} transaction(s) need review:`);
  for (const s of suspicious) {
    console.log(`- ${s.reference} | event ${s.event} | ${new Date(s.createdAt).toISOString()} | total ${s.total} | ${s.problem}`);
  }
  await mongoose.disconnect();
})().catch((err) => {
  console.error('Audit failed:', err.message);
  process.exit(1);
});
