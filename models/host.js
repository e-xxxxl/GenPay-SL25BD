// models/host.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const hostSchema = new mongoose.Schema(
  {
    userType: {
      type: String,
      required: true,
      enum: ['individual', 'organization'],
      default: 'individual'
    },
    firstName: {
      type: String,
      required: function() {
        return this.userType === 'individual';
      },
      trim: true
    },
    lastName: {
      type: String,
      required: function() {
        return this.userType === 'individual';
      },
      trim: true
    },
    organizationName: {
      type: String,
      required: function() {
        return this.userType === 'organization';
      },
      trim: true
    },
    fullName: {
      type: String,
      required: function() {
        return this.userType === 'organization';
      },
      trim: true
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: [/\S+@\S+\.\S+/, 'is invalid']
    },
    phoneNumber: {
      type: String,
      required: true,
      trim: true
    },
    location: {
      type: String,
      required: true,
      trim: true
    },
    password: {
      type: String,
      required: true,
      minlength: 8,
      select: false
    },
    profileImage: {
      type: String,
      default: ''
    },
    events: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event'
    }],
    socialMedia: {
      instagram: String,
      twitter: String,
      facebook: String,
      tiktok: String
    },
    isVerified: {
      type: Boolean,
      default: false
    },
    verificationToken: String,
    passwordResetToken: String,
    passwordResetExpires: Date,
    payoutInfo: {
      bankName: {
        type: String,
        trim: true
      },
      bankCode: {
        type: String,
        trim: true
      },
      accountNumber: {
        type: String,
        trim: true,
        match: [/^\d{10}$/, 'Account number must be 10 digits']
      },
      accountName: {
        type: String,
        trim: true
      }
    },
    availableBalance: {
      type: Number,
      default: 0,
      min: [0, 'Balance cannot be negative']
    }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Virtual for display name
hostSchema.virtual('displayName').get(function() {
  return this.userType === 'individual' 
    ? `${this.firstName} ${this.lastName}`
    : this.organizationName;
});

// Password hashing middleware
hostSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// Method to compare passwords
hostSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('Host', hostSchema);