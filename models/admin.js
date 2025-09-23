// models/admin.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      enum: ['Toluwanimi', 'Oluwatosin', 'Emmanuel', 'Kolapo']
    },
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      enum: ['toluwanimi@genpay.ng', 'oluwatosin@genpay.ng', 'emmanuel@genpay.ng', 'kolapo@genpay.ng']
    },
    password: {
      type: String,
      required: true,
      minlength: 8,
      select: false
    },
    role: {
      type: String,
      required: true,
      enum: ['super_admin', 'admin'],
      default: 'admin'
    },
    isOnline: {
      type: Boolean,
      default: false
    },
    lastLogin: {
      type: Date
    },
    loginHistory: [{
      loginTime: Date,
      ipAddress: String,
      userAgent: String
    }]
  },
  {
    timestamps: true
  }
);

// Password hashing middleware
adminSchema.pre('save', async function(next) {
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
adminSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Method to update online status
adminSchema.methods.updateOnlineStatus = async function(isOnline) {
  this.isOnline = isOnline;
  this.lastLogin = isOnline ? new Date() : this.lastLogin;
  return this.save();
};

module.exports = mongoose.model('Admin', adminSchema);