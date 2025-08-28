// models/payout.js
const mongoose = require('mongoose');

const payoutSchema = new mongoose.Schema({
  host: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Host',
    required: [true, 'Host is required'],
  },
  event: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event',
    default: null, // Optional, for event-specific payouts
  },
  amount: {
    type: Number,
    required: [true, 'Withdrawal amount is required'],
    min: [150, 'Withdrawal amount must be at least 150 NGN to cover fees'],
  },
  fee: {
    type: Number,
    default: 150, // Fixed 150 NGN fee
  },
  netAmount: {
    type: Number,
    required: [true, 'Net amount is required'],
  },
  bankDetails: {
    bankName: {
      type: String,
      required: [true, 'Bank name is required'],
      trim: true,
    },
    bankCode: {
      type: String,
      required: [true, 'Bank code is required'],
      trim: true,
    },
    accountNumber: {
      type: String,
      required: [true, 'Account number is required'],
      trim: true,
      match: [/^\d{10}$/, 'Account number must be 10 digits'],
    },
    accountName: {
      type: String,
      required: [true, 'Account name is required'],
      trim: true,
    },
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'completed'],
    default: 'pending',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

payoutSchema.pre('save', function (next) {
  this.netAmount = this.amount - this.fee;
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Payout', payoutSchema);