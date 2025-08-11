// models/payoutModel.js
const mongoose = require('mongoose');

const payoutSchema = new mongoose.Schema({
  event: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event',
    required: true,
  },
  dateTime: {
    type: Date,
    default: Date.now,
  },
  account: {
    type: String,
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
});

module.exports = mongoose.model('Payout', payoutSchema);