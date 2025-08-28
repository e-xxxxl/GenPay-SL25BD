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
      unique: true,
    },
    slug: {
      type: String,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
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
          return arr.length <= 10;
        },
        message: 'Gallery cannot contain more than 10 images',
      },
    },
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
        name: { type: String, required: true },
        price: { type: Number, required: true, min: 0 },
        quantity: { type: Number, required: true, min: 0 },
        ticketType: { type: String, enum: ['Individual', 'Group'], default: 'Individual' },
        ticketDescription: { type: String },
        groupSize: { type: String, default: 'Unlimited Quantity' },
        groupPrice: { type: Number, min: 0 },
        groupPriceCurrency: { type: String, default: 'USD' },
        perTicketPrice: { type: Number, min: 0 },
        perTicketCurrency: { type: String, default: 'USD' },
        purchaseLimit: { type: Number, min: 0 },
        perks: [{ type: String }],
        transferFees: { type: Boolean, default: false },
        id: { type: String, required: true },
      },
    ],
    ticketPolicy: {
      refundPolicy: { type: String, trim: true, default: null },
      transferPolicy: { type: String, trim: true, default: null },
      otherRules: { type: String, trim: true, default: null },
    },
    attendeesCount: {
      type: Number,
      default: 0,
      min: [0, 'Attendees count cannot be negative'],
    },
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual for remaining tickets
eventSchema.virtual('remainingTickets').get(function () {
  return this.capacity ? this.capacity - this.tickets.reduce((sum, tier) => sum + tier.quantity, 0) : null;
});

// Validate that endDateTime is after startDateTime
eventSchema.pre('validate', function (next) {
  if (this.endDateTime <= this.startDateTime) {
    next(new Error('End date and time must be after start date and time'));
  } else {
    next();
  }
});

// Pre-save hook to set isPublished and generate slug
eventSchema.pre('save', function (next) {
  this.isPublished = this.tickets && this.tickets.length > 0;
  if (this.eventName && (!this.slug || this.isModified('eventName'))) {
    this.slug = this.eventName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  }
  next();
});

const Event = mongoose.model('Event', eventSchema);
module.exports = Event;