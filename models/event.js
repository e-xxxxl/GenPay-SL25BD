const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema(
  {
    host: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Host',
      required: true,
    },
    eventName: {
      type: String,
      required: [true, 'Event name is required'],
      trim: true,
    },
    eventDescription: {
      type: String,
      required: [true, 'Event description is required'],
      trim: true,
    },
    eventCategory: {
      type: String,
      required: [true, 'Event category is required'],
      enum: [
        'Music',
        'Sports',
        'Business',
        'Technology',
        'Art & Culture',
        'Food & Drink',
        'Health & Wellness',
        'Education',
        'Entertainment',
        'Networking',
        'Other',
      ],
    },
    startDateTime: {
      type: Date,
      required: [true, 'Start date and time are required'],
    },
    endDateTime: {
      type: Date,
      required: [true, 'End date and time are required'],
    },
    eventLocation: {
      venue: {
        type: String,
        required: [true, 'Event location is required'],
        trim: true,
      },
      locationTips: {
        type: String,
        trim: true,
      },
      address: {
        street: String,
        city: String,
        state: String,
        country: String,
        zipCode: String,
      },
    },
    eventUrl: {
      type: String,
      trim: true,
    },
    socialLinks: {
      instagram: { type: String, trim: true },
      twitter: { type: String, trim: true },
      snapchat: { type: String, trim: true },
      tiktok: { type: String, trim: true },
      website: { type: String, trim: true },
    },
    headerImage: {
      type: String,
      trim: true,
    },
     images: {
      type: [String],
      validate: {
        validator: function (arr) {
          return arr.length <= 10; // Max 10 gallery images
        },
        message: 'Gallery cannot contain more than 10 images',
      },
    }, // Array for additional image URLs (e.g., gallery)
    capacity: {
      type: Number,
      min: [1, 'Capacity must be at least 1'],
    },
    isPublished: {
      type: Boolean,
      default: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    tickets: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Ticket',
      },
    ],
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual for remaining tickets
eventSchema.virtual('remainingTickets').get(function () {
  return this.capacity ? this.capacity - this.tickets.length : null;
});

// Validate that endDateTime is after startDateTime
eventSchema.pre('validate', function (next) {
  if (this.endDateTime <= this.startDateTime) {
    next(new Error('End date and time must be after start date and time'));
  } else {
    next();
  }
});

const Event = mongoose.model('Event', eventSchema);
module.exports = Event;