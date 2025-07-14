const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
  host: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Host',
    required: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true
  },
  eventType: {
    type: String,
    enum: ['concert', 'conference', 'workshop', 'exhibition', 'festival'],
    required: true
  },
  dateTime: {
    start: { type: Date, required: true },
    end: { type: Date, required: true }
  },
  location: {
    venue: { type: String, required: true },
    address: {
      street: String,
      city: String,
      state: String,
      country: String,
      zipCode: String
    },
    onlineUrl: String // For hybrid/virtual events
  },
  tickets: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Ticket'
  }],
  socialMedia: {
    instagram: String,
    twitter: String,
    facebook: String,
    hashtag: String
  },
  images: [String], // Array of image URLs
  capacity: {
    type: Number,
    min: 1
  },
  isPublished: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, { 
  toJSON: { virtuals: true }, 
  toObject: { virtuals: true } 
});

// Virtual for remaining tickets (calculated on-the-fly)
eventSchema.virtual('remainingTickets').get(function() {
  return this.capacity - this.tickets.length;
});

const Event = mongoose.model('Event', eventSchema);
module.exports = Event;