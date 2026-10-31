// models/paymentLog.js
// A durable record of every successful provider payment we have SEEN (webhook, verify or the
// reconciliation sweep), written before we try to match it to an order. If anything later fails,
// the money is still traceable here and shows up on the admin Payments screen.
const mongoose = require('mongoose');

const paymentLogSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true, index: true },
    provider: { type: String, default: 'paystack' },
    amountKobo: Number,
    currency: String,
    email: String,
    channel: String,
    paidAt: Date,
    // Only the identifiers we put there ourselves; never card or customer details.
    metadata: { orderId: String, eventId: String },
    source: { type: String, enum: ['webhook', 'verify', 'reconcile'], default: 'webhook' },
    // unresolved   -> seen, not yet matched/fulfilled (retry pending)
    // matched      -> already had a completed order/ticket purchase
    // recovered    -> we found no tickets, rebuilt the purchase and fulfilled it
    // needs_action -> money received but tickets cannot be issued automatically
    // dismissed    -> an admin decided it needs no action (e.g. not a ticket payment)
    status: { type: String, enum: ['unresolved', 'matched', 'recovered', 'needs_action', 'dismissed'], default: 'unresolved', index: true },
    reason: String,
    lastState: String,
    attempts: { type: Number, default: 0 },
    firstSeenAt: { type: Date, default: Date.now },
    lastAttemptAt: Date,
    resolvedAt: Date,
    note: String,
  },
  { timestamps: true }
);

module.exports = mongoose.models.PaymentLog || mongoose.model('PaymentLog', paymentLogSchema);
