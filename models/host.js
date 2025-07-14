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
      }
    },
    lastName: {
      type: String,
      required: function() {
        return this.userType === 'individual';
      }
    },
    organizationName: {
      type: String,
      required: function() {
        return this.userType === 'organization';
      }
    },
    fullName: {  // New field for organization contact person
      type: String,
      required: function() {
        return this.userType === 'organization';
      }
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
      required: true
    },
    location: {
      type: String,
      required: true
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
    passwordResetExpires: Date
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

const Host = mongoose.model('Host', hostSchema);

module.exports = Host;