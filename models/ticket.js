// models/ticket.js
const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
  event: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event',
    required: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  type: {
    type: String,
    enum: ['Individual', 'Group'], // Must match Event.tickets.ticketType values
    required: true,
  },
  price: {
    type: Number,
    required: true,
    min: 0,
  },
  quantity: {
    type: Number,
    required: true,
    min: 1,
  },
  buyer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  ticketId: {
    type: String,
    required: true,
    unique: true,
  },
  qrCode: {
    type: String,
    required: true,
  },
  isUsed: {
    type: Boolean,
    default: false,
  },
  usedAt: {
    type: Date,
  },
}, { timestamps: true });

module.exports = mongoose.models.Ticket || mongoose.model('Ticket', ticketSchema);