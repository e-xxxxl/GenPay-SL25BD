// controllers/adminPayoutController.js
const Payout = require('../models/payout');
const PayoutApproval = require('../models/payoutApproval');
const Host = require('../models/host');
const nodemailer = require('nodemailer');

// Zoho Mail Transporter Configuration
const transporter = nodemailer.createTransport({
  host: 'smtp.zoho.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.ZOHO_EMAIL,
    pass: process.env.ZOHO_APP_PASSWORD,
  },
  tls: {
    rejectUnauthorized: false
  }
});


const multer = require('multer');
const cloudinary = require('../config/cloudinary'); // Make sure you have this

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  },
});



// Get all pending payouts
exports.getPendingPayouts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const payouts = await Payout.find({ status: 'pending' })
      .populate('host', 'displayName email payoutInfo')
      .populate('event', 'eventName')
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit);

    const totalPayouts = await Payout.countDocuments({ status: 'pending' });

    res.status(200).json({
      status: 'success',
      data: {
        payouts,
        totalPages: Math.ceil(totalPayouts / limit),
        currentPage: page,
        totalPayouts
      }
    });
  } catch (error) {
    console.error('Get pending payouts error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch pending payouts'
    });
  }
};

// Get all payouts with filters
exports.getAllPayouts = async (req, res) => {
  try {
    const { status, page = 1, limit = 10, hostId } = req.query;
    const skip = (page - 1) * limit;

    let filter = {};
    if (status && status !== 'all') filter.status = status;
    if (hostId) filter.host = hostId;

    const payouts = await Payout.find(filter)
      .populate('host', 'displayName email')
      .populate('event', 'eventName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalPayouts = await Payout.countDocuments(filter);

    res.status(200).json({
      status: 'success',
      data: {
        payouts,
        totalPages: Math.ceil(totalPayouts / limit),
        currentPage: parseInt(page),
        totalPayouts
      }
    });
  } catch (error) {
    console.error('Get all payouts error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch payouts'
    });
  }
};

// Approve payout and upload proof of payment
exports.approvePayout = async (req, res) => {
  try {
    // For form-data requests, fields are available in req.body but file is in req.file
    const { payoutId, approvedAmount, notes } = req.body;
    const proofOfPayment = req.file;

    console.log('Received approve payout request:', {
      payoutId,
      approvedAmount,
      notes,
      hasFile: !!proofOfPayment,
      file: proofOfPayment ? proofOfPayment.originalname : 'No file'
    });

    if (!payoutId || !approvedAmount) {
      return res.status(400).json({
        status: 'fail',
        message: 'Payout ID and approved amount are required'
      });
    }

    const payout = await Payout.findById(payoutId).populate('host');
    if (!payout) {
      return res.status(404).json({
        status: 'fail',
        message: 'Payout not found'
      });
    }

    if (payout.status !== 'pending') {
      return res.status(400).json({
        status: 'fail',
        message: 'Payout has already been processed'
      });
    }

    // Handle file upload to Cloudinary if proof of payment is provided
    let proofOfPaymentUrl = null;
    if (proofOfPayment) {
      try {
        const uploadResult = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            {
              folder: 'genpay/payout-proofs',
              resource_type: 'image',
            },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );
          
          // Convert buffer to stream
          const { Readable } = require('stream');
          const stream = Readable.from(proofOfPayment.buffer);
          stream.pipe(uploadStream);
        });
        
        proofOfPaymentUrl = uploadResult.secure_url;
      } catch (uploadError) {
        console.error('Proof of payment upload failed:', uploadError);
        return res.status(500).json({
          status: 'error',
          message: 'Failed to upload proof of payment'
        });
      }
    }

    // Create payout approval record
    const payoutApproval = await PayoutApproval.create({
      payout: payoutId,
      approvedBy: req.admin._id,
      approvedAmount: parseFloat(approvedAmount),
      proofOfPayment: proofOfPaymentUrl ? {
        imageUrl: proofOfPaymentUrl,
        description: `Proof of payment for payout ${payoutId}`
      } : undefined,
      notes: notes || '',
      status: 'approved'
    });

    // Update host balance (deduct the approved amount)
    await Host.findByIdAndUpdate(
      payout.host._id,
      { $inc: { availableBalance: -parseFloat(approvedAmount) } },
      { new: true, runValidators: true }
    );

    // Update the payout status to completed
    payout.status = 'completed';
    payout.updatedAt = new Date();
    await payout.save();

    // Send email notification to host
    const mailOptions = {
      from: process.env.ZOHO_EMAIL,
      to: payout.host.email,
      subject: 'Payout Request Approved',
      html: `
        <h2>Payout Request Approved</h2>
        <p>Dear ${payout.host.displayName},</p>
        <p>Your payout request has been approved and processed successfully.</p>
        <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
          <h3 style="margin-top: 0;">Payout Details:</h3>
          <p><strong>Requested Amount:</strong> ₦${payout.amount.toLocaleString()}</p>
          <p><strong>Approved Amount:</strong> ₦${parseFloat(approvedAmount).toLocaleString()}</p>
          <p><strong>Fee:</strong> ₦${payout.fee.toLocaleString()}</p>
          <p><strong>Net Amount:</strong> ₦${(parseFloat(approvedAmount) - payout.fee).toLocaleString()}</p>
          <p><strong>Bank:</strong> ${payout.bankDetails.bankName}</p>
          <p><strong>Account Number:</strong> ${payout.bankDetails.accountNumber}</p>
          <p><strong>Approval Date:</strong> ${new Date().toLocaleDateString()}</p>
          ${notes ? `<p><strong>Notes:</strong> ${notes}</p>` : ''}
        </div>
        <p>The funds should reflect in your account within 2-3 business days.</p>
        <p>If you have any questions, please contact our support team.</p>
        <p>Best regards,<br>The Genpay Team</p>
      `
    };

    await transporter.sendMail(mailOptions);

    res.status(200).json({
      status: 'success',
      data: {
        payoutApproval,
        payout: await Payout.findById(payoutId).populate('host')
      },
      message: 'Payout approved successfully and host notified via email'
    });
  } catch (error) {
    console.error('Approve payout error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to approve payout'
    });
  }
};

// Reject payout
exports.rejectPayout = async (req, res) => {
  try {
    const { payoutId, reason } = req.body;

    if (!payoutId) {
      return res.status(400).json({
        status: 'fail',
        message: 'Payout ID is required'
      });
    }

    const payout = await Payout.findById(payoutId).populate('host');
    if (!payout) {
      return res.status(404).json({
        status: 'fail',
        message: 'Payout not found'
      });
    }

    // Create rejection record
    const payoutRejection = await PayoutApproval.create({
      payout: payoutId,
      approvedBy: req.admin._id,
      approvedAmount: 0,
      notes: reason || 'Payout request rejected',
      status: 'rejected'
    });

    // Send rejection email to host
    const mailOptions = {
      from: process.env.ZOHO_EMAIL,
      to: payout.host.email,
      subject: 'Payout Request Update',
      html: `
        <h2>Payout Request Update</h2>
        <p>Dear ${payout.host.displayName},</p>
        <p>Your payout request has been reviewed and unfortunately could not be approved at this time.</p>
        <div style="background: #fff3cd; padding: 15px; border-radius: 5px; margin: 15px 0;">
          <h3 style="margin-top: 0;">Request Details:</h3>
          <p><strong>Requested Amount:</strong> ₦${payout.amount.toLocaleString()}</p>
          <p><strong>Status:</strong> Rejected</p>
          <p><strong>Reason:</strong> ${reason || 'Please contact support for more information.'}</p>
        </div>
        <p>Your funds remain in your Genpay wallet and you can submit a new payout request when eligible.</p>
        <p>If you have any questions, please contact our support team.</p>
        <p>Best regards,<br>The Genpay Team</p>
      `
    };

    await transporter.sendMail(mailOptions);

    res.status(200).json({
      status: 'success',
      data: {
        payoutRejection,
        payout: await Payout.findById(payoutId)
      },
      message: 'Payout rejected successfully and host notified via email'
    });
  } catch (error) {
    console.error('Reject payout error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to reject payout'
    });
  }
};

// Get payout approval history
exports.getPayoutApprovalHistory = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const approvals = await PayoutApproval.find()
      .populate('payout')
      .populate('approvedBy', 'name')
      .sort({ approvalDate: -1 })
      .skip(skip)
      .limit(limit);

    const totalApprovals = await PayoutApproval.countDocuments();

    res.status(200).json({
      status: 'success',
      data: {
        approvals,
        totalPages: Math.ceil(totalApprovals / limit),
        currentPage: page,
        totalApprovals
      }
    });
  } catch (error) {
    console.error('Get payout approval history error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch payout approval history'
    });
  }
};


// Export the upload middleware
exports.uploadProof = upload.single('proofOfPayment');