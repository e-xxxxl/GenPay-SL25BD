const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  event: {
    type: mongoose.Schema.ObjectId,
    ref: 'Event',
    required: [true, 'Transaction must be associated with an event'],
  },
  tickets: [
    {
      type: mongoose.Schema.ObjectId,
      ref: 'Ticket',
      required: [true, 'Transaction must include at least one ticket'],
    },
  ],
  reference: {
    type: String,
    required: [true, 'Transaction must have a payment reference'],
    unique: true,
  },
  amount: {
    type: Number,
    required: [true, 'Transaction must have an amount'],
    min: [0, 'Amount must be non-negative'],
  },
  fees: {
    type: Number,
    required: [true, 'Transaction must include fees'],
    min: [0, 'Fees must be non-negative'],
  },
  total: {
    type: Number,
    required: [true, 'Transaction must have a total amount'],
    min: [0, 'Total must be non-negative'],
  },
  paymentProvider: {
    type: String,
    enum: ['paystack', 'other'], // Add other providers as needed
    required: [true, 'Transaction must specify a payment provider'],
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    default: 'completed',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

transactionSchema.index({ event: 1, reference: 1 }); // Index for faster queries

const Transaction = mongoose.model('Transaction', transactionSchema);

module.exports = Transaction;