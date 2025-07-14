const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
  event: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event',
    required: true
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', // Assuming you have a general User model
    required: true
  },
  type: {
    type: String,
    enum: ['general', 'vip', 'early-bird'],
    required: true
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  purchaseDate: {
    type: Date,
    default: Date.now
  },
  seatNumber: String,
  qrCode: { // For digital tickets
    type: String,
    unique: true
  },
  isUsed: {
    type: Boolean,
    default: false
  }
});

const Ticket = mongoose.model('Ticket', ticketSchema);
module.exports = Ticket;