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
      file: proofOfPayment ? proofOfPayment.originalname : 'No file',
    });

    // Validate input
    if (!payoutId || !approvedAmount) {
      return res.status(400).json({
        status: 'fail',
        message: 'Payout ID and approved amount are required',
      });
    }

    const payout = await Payout.findById(payoutId).populate('host');
    if (!payout) {
      return res.status(404).json({
        status: 'fail',
        message: 'Payout not found',
      });
    }

    if (payout.status !== 'pending') {
      return res.status(400).json({
        status: 'fail',
        message: 'Payout has already been processed',
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
          message: 'Failed to upload proof of payment',
        });
      }
    }

    // Create payout approval record
    const payoutApproval = await PayoutApproval.create({
      payout: payoutId,
      approvedBy: req.admin._id,
      approvedAmount: parseFloat(approvedAmount),
      proofOfPayment: proofOfPaymentUrl
        ? {
            imageUrl: proofOfPaymentUrl,
            description: `Proof of payment for payout ${payoutId}`,
          }
        : undefined,
      notes: notes || '',
      status: 'approved',
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

    // Send email notification to host using Resend
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    console.log('Sending completion email to:', payout.host.email);

    try {
      const data = await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL, // e.g., noreply@yourdomain.com
        to: [payout.host.email],
        subject: 'Your Payout Has Been Approved',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
            <h2 style="color: #1a73e8;">Payout Approved</h2>
            <p style="font-size: 16px;">Dear ${payout.host.displayName},</p>
            <p style="font-size: 16px;">Great news! Your payout request has been approved and processed.</p>

            <h3 style="color: #333; margin-top: 20px;">Payout Details</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
              <tr>
                <td style="padding: 8px; font-weight: bold;">Requested Amount</td>
                <td style="padding: 8px;">₦${payout.amount.toLocaleString('en-NG')}</td>
              </tr>
              <tr>
                <td style="padding: 8px; font-weight: bold;">Approved Amount</td>
                <td style="padding: 8px;">₦${parseFloat(approvedAmount).toLocaleString('en-NG')}</td>
              </tr>
              <tr>
                <td style="padding: 8px; font-weight: bold;">Fee</td>
                <td style="padding: 8px;">₦${payout.fee.toLocaleString('en-NG')}</td>
              </tr>
              <tr>
                <td style="padding: 8px; font-weight: bold;">Net Amount</td>
                <td style="padding: 8px;">₦${(parseFloat(approvedAmount) - payout.fee).toLocaleString('en-NG')}</td>
              </tr>
              <tr>
                <td style="padding: 8px; font-weight: bold;">Bank</td>
                <td style="padding: 8px;">${payout.bankDetails.bankName}</td>
              </tr>
              <tr>
                <td style="padding: 8px; font-weight: bold;">Account Number</td>
                <td style="padding: 8px;">${payout.bankDetails.accountNumber}</td>
              </tr>
              <tr>
                <td style="padding: 8px; font-weight: bold;">Account Name</td>
                <td style="padding: 8px;">${payout.bankDetails.accountName}</td>
              </tr>
              <tr>
                <td style="padding: 8px; font-weight: bold;">Approval Date</td>
                <td style="padding: 8px;">${new Date().toLocaleDateString('en-US', {
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}</td>
              </tr>
              ${notes ? `
                <tr>
                  <td style="padding: 8px; font-weight: bold;">Notes</td>
                  <td style="padding: 8px;">${notes}</td>
                </tr>
              ` : ''}
            </table>

            <p style="font-size: 14px; margin-top: 20px;">
              The funds should reflect in your account within 2-3 business days.
            </p>
            <p style="font-size: 14px;">
              Questions? Contact us at <a href="mailto:${process.env.RESEND_FROM_EMAIL}" style="color: #1a73e8; text-decoration: none;">${process.env.RESEND_FROM_EMAIL}</a>.
            </p>
            <p style="font-size: 14px; color: #555; margin-top: 20px; text-align: center;">
              Thank you,<br>The Genpay Events Team
            </p>
          </div>
        `,
      });

      console.log(`Completion email sent to ${payout.host.email} via Resend (ID: ${data?.data?.id || 'Unknown'})`);
      res.status(200).json({
        status: 'success',
        data: {
          payoutApproval,
          payout: await Payout.findById(payoutId).populate('host'),
        },
        message: 'Payout approved successfully and host notified via email',
      });
    } catch (emailError) {
      console.error(`Failed to send completion email to ${payout.host.email}:`, emailError);
      res.status(207).json({
        status: 'partial_success',
        message: 'Payout approved, but email notification failed to send',
        data: {
          payoutApproval,
          payout: await Payout.findById(payoutId).populate('host'),
          emailError: emailError.message,
        },
      });
    }
  } catch (error) {
    console.error('Approve payout error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to approve payout',
    });
  }
};
exports.rejectPayout = async (req, res) => {
  try {
    const { payoutId, reason } = req.body;

    // Validate input
    if (!payoutId) {
      return res.status(400).json({
        status: 'fail',
        message: 'Payout ID is required',
      });
    }

    const payout = await Payout.findById(payoutId).populate('host');
    if (!payout) {
      return res.status(404).json({
        status: 'fail',
        message: 'Payout not found',
      });
    }

    // Update payout status to rejected
    payout.status = 'rejected';
    payout.updatedAt = new Date();
    await payout.save();

    // Create rejection record
    const payoutRejection = await PayoutApproval.create({
      payout: payoutId,
      approvedBy: req.admin._id,
      approvedAmount: 0,
      notes: reason || 'Payout request rejected',
      status: 'rejected',
    });

    // Send rejection email to host using Resend
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    console.log('Sending rejection email to:', payout.host.email);

    try {
      const data = await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL, // e.g., noreply@yourdomain.com
        to: [payout.host.email],
        subject: 'Your Payout Request Update',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
            <h2 style="color: #1a73e8;">Payout Request Update</h2>
            <p style="font-size: 16px;">Dear ${payout.host.displayName},</p>
            <p style="font-size: 16px;">We’ve reviewed your payout request, and unfortunately, it could not be approved at this time.</p>

            <h3 style="color: #333; margin-top: 20px;">Request Details</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px; background: #fff3cd; border-radius: 5px;">
              <tr>
                <td style="padding: 8px; font-weight: bold;">Requested Amount</td>
                <td style="padding: 8px;">₦${payout.amount.toLocaleString('en-NG')}</td>
              </tr>
              <tr>
                <td style="padding: 8px; font-weight: bold;">Status</td>
                <td style="padding: 8px;">Rejected</td>
              </tr>
              <tr>
                <td style="padding: 8px; font-weight: bold;">Reason</td>
                <td style="padding: 8px;">${reason || 'Please contact support for more information.'}</td>
              </tr>
            </table>

            <p style="font-size: 14px; margin-top: 20px;">
              Your funds remain in your Genpay wallet, and you can submit a new payout request when eligible.
            </p>
            <p style="font-size: 14px;">
              Questions? Contact us at <a href="mailto:${process.env.RESEND_FROM_EMAIL}" style="color: #1a73e8; text-decoration: none;">${process.env.RESEND_FROM_EMAIL}</a>.
            </p>
            <p style="font-size: 14px; color: #555; margin-top: 20px; text-align: center;">
              Thank you,<br>The Genpay Events Team
            </p>
          </div>
        `,
      });

      console.log(`Rejection email sent to ${payout.host.email} via Resend (ID: ${data?.data?.id || 'Unknown'})`);
      res.status(200).json({
        status: 'success',
        data: {
          payoutRejection,
          payout: await Payout.findById(payoutId),
        },
        message: 'Payout rejected successfully and host notified via email',
      });
    } catch (emailError) {
      console.error(`Failed to send rejection email to ${payout.host.email}:`, emailError);
      res.status(207).json({
        status: 'partial_success',
        message: 'Payout rejected, but email notification failed to send',
        data: {
          payoutRejection,
          payout: await Payout.findById(payoutId),
          emailError: emailError.message,
        },
      });
    }
  } catch (error) {
    console.error('Reject payout error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to reject payout',
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