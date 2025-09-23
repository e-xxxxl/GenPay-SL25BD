// models/payoutApproval.js
const mongoose = require('mongoose');

const payoutApprovalSchema = new mongoose.Schema({
  payout: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payout',
    required: true
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    required: true
  },
  approvedAmount: {
    type: Number,
    required: true,
    min: 0
  },
  proofOfPayment: {
    imageUrl: String,
    description: String,
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  },
  approvalDate: {
    type: Date,
    default: Date.now
  },
  notes: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: ['approved', 'rejected', 'pending'],
    default: 'approved'
  }
}, {
  timestamps: true
});

// Update the original payout status when approval is created
payoutApprovalSchema.post('save', async function(doc) {
  try {
    const Payout = mongoose.model('Payout');
    await Payout.findByIdAndUpdate(doc.payout, { 
      status: doc.status === 'approved' ? 'completed' : doc.status
    });
  } catch (error) {
    console.error('Error updating payout status:', error);
  }
});

module.exports = mongoose.model('PayoutApproval', payoutApprovalSchema);