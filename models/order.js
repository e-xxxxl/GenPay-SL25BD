// models/order.js
// An Order is the server-side record of a checkout. It is created BEFORE the buyer is
// sent to the payment provider, holds the server-computed price, and is the only thing a
// payment confirmation is ever matched against.
const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true, index: true },
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
    provider: { type: String, enum: ['paystack', 'free'], required: true },
    // pending     -> created, awaiting confirmed payment (or free order awaiting fulfilment)
    // processing  -> a worker holds the fulfilment lock
    // completed   -> paid (or free) and tickets issued
    // unfulfillable -> payment confirmed but stock ran out; needs a manual refund
    // mismatch    -> provider amount/currency did not match the order; never fulfilled
    // failed      -> the provider reported the payment as failed/reversed, or init failed
    // expired     -> no payment seen for a long time (a late payment can still be settled)
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'unfulfillable', 'mismatch', 'failed', 'expired'],
      default: 'pending',
      index: true,
    },
    email: { type: String, required: true },
    lines: { type: [mongoose.Schema.Types.Mixed], default: [] },
    subtotal: { type: Number, required: true, min: 0 },
    fees: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
    amountKobo: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'NGN' },
    paystackStatus: String,
    paidAt: Date,
    lockedAt: Date,
    lastCheckedAt: { type: Date, default: Date.now },
    hostCredited: { type: Boolean, default: false },
    ticketIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Ticket' }],
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
    completedAt: Date,
    failureReason: String,
    lastError: String,
    legacy: { type: Boolean, default: false },
    emailSentAt: Date,
    emailClaimedAt: Date,
    emailedTo: [String],
    emailAttempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

orderSchema.index({ status: 1, lastCheckedAt: 1 });
orderSchema.index({ event: 1, status: 1 });

module.exports = mongoose.models.Order || mongoose.model('Order', orderSchema);
