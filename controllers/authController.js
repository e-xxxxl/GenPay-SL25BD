const Host = require('../models/Host');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');

// Generate JWT Token
const signToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '90d',
  });
};

// Zoho Mail Transporter Configuration
const transporter = nodemailer.createTransport({
  host: 'smtp.zoho.com',
  port: 465, // SSL port
  secure: true,
  auth: {
    user: process.env.ZOHO_EMAIL,
    pass: process.env.ZOHO_APP_PASSWORD,
  },
  tls: {
    rejectUnauthorized: false // Only for development/testing
  }
});

// Enhanced Signup Controller
exports.signup = async (req, res) => {
  try {
    // 1) Validate required fields with better error messages
    const fieldLabels = {
      email: 'Email address',
      password: 'Password',
      phoneNumber: 'Phone number',
      location: 'Location',
      firstName: req.body.userType === 'individual' ? 'First name' : 'Organization name',
      lastName: req.body.userType === 'individual' ? 'Last name' : '',
      fullName: 'Contact person full name' // New field label
    };

    const requiredFields = ['email', 'password', 'phoneNumber', 'location'];
    if (req.body.userType === 'individual') {
      requiredFields.push('firstName', 'lastName');
    } else if (req.body.userType === 'organization') {
      requiredFields.push('firstName', 'fullName'); // Require both org name and contact name
    }

    const missingFields = requiredFields.filter(field => !req.body[field]);
    if (missingFields.length > 0) {
      return res.status(400).json({
        status: 'fail',
        message: `Please provide: ${missingFields.map(f => fieldLabels[f]).join(', ')}`,
        fields: missingFields
      });
    }

    // 2) Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(req.body.email)) {
      return res.status(400).json({
        status: 'fail',
        message: 'Please provide a valid email address',
        field: 'email'
      });
    }

    // 3) Check for existing user
    const existingHost = await Host.findOne({ 
      $or: [
        { email: req.body.email.toLowerCase() },
        { phoneNumber: req.body.phoneNumber }
      ]
    });

    if (existingHost) {
      const conflictField = existingHost.email === req.body.email.toLowerCase() 
        ? 'email' 
        : 'phoneNumber';
      return res.status(409).json({
        status: 'fail',
        message: `${fieldLabels[conflictField]} is already in use`,
        field: conflictField
      });
    }

    // 4) Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(req.body.password, salt);

    // 5) Create host with additional validation
    const hostData = {
      userType: req.body.userType,
      email: req.body.email.toLowerCase(),
      password: hashedPassword,
      phoneNumber: req.body.phoneNumber,
      location: req.body.location,
      isVerified: false // Default to false until email verification
    };

    if (req.body.userType === 'individual') {
      hostData.firstName = req.body.firstName;
      hostData.lastName = req.body.lastName;
    } else {
      hostData.organizationName = req.body.firstName;
      hostData.fullName = req.body.fullName; // Add contact person's full name
    }

    const newHost = await Host.create(hostData);

    // 6) Generate tokens
    const authToken = signToken(newHost._id);
    const verificationToken = jwt.sign(
      { id: newHost._id },
      process.env.JWT_VERIFICATION_SECRET,
      { expiresIn: '24h' } // Shorter expiry for verification
    );

    // 7) Send verification email with better template
    const verificationUrl = `${process.env.FRONTEND_URL}/verified-email/${verificationToken}`;
    const mailOptions = {
      from: `"Genpayng" <${process.env.ZOHO_EMAIL}>`,
      to: newHost.email,
      subject: 'Verify Your Genpayng Account',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #6C63FF;">Welcome to Genpayng!</h1>
          <p>Thank you for creating an account. Please verify your email address to get started:</p>
          <a href="${verificationUrl}" 
             style="display: inline-block; padding: 12px 24px; background-color: #6C63FF; 
                    color: white; text-decoration: none; border-radius: 4px; margin: 20px 0;">
            Verify Email
          </a>
          <p>This link will expire in 24 hours.</p>
          <p>If you didn't create this account, please ignore this email.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
          <p style="font-size: 12px; color: #777;">
            © ${new Date().getFullYear()} Genpayng. All rights reserved.
          </p>
        </div>
      `,
      text: `Please verify your email by visiting this link: ${verificationUrl}\n\nThis link expires in 24 hours.`
    };

    await transporter.sendMail(mailOptions);

    // 8) Prepare response data
    const responseData = {
      _id: newHost._id,
      userType: newHost.userType,
      email: newHost.email,
      ...(newHost.userType === 'individual' 
        ? { 
            firstName: newHost.firstName, 
            lastName: newHost.lastName 
          }
        : { 
            organizationName: newHost.organizationName,
            fullName: newHost.fullName 
          }),
      phoneNumber: newHost.phoneNumber,
      location: newHost.location
    };

    res.status(201).json({
      status: 'success',
      token: authToken,
      data: {
        host: responseData
      },
      message: 'Account created successfully! Please check your email for verification.'
    });

  } catch (err) {
    console.error('Signup error:', err);

    // Handle duplicate fields (even if they slipped through initial check)
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern)[0];
      const fieldName = field === 'email' ? 'Email address' : 
                       field === 'phoneNumber' ? 'Phone number' : field;
      return res.status(409).json({
        status: 'fail',
        message: `${fieldName} is already in use`,
        field: field
      });
    }

    // Handle validation errors
    if (err.name === 'ValidationError') {
      const errors = Object.values(err.errors).map(el => ({
        field: el.path,
        message: el.message
      }));
      return res.status(400).json({
        status: 'fail',
        message: 'Validation failed',
        errors: errors
      });
    }

    // Handle email sending errors
    if (err.code === 'EENVELOPE' || err.code === 'ECONNECTION') {
      return res.status(500).json({
        status: 'error',
        message: 'Failed to send verification email. Please contact support.'
      });
    }

    // Generic server error
    res.status(500).json({
      status: 'error',
      message: 'An unexpected error occurred. Please try again later.'
    });
  }
};


exports.verifyEmail = async (req, res) => {
  try {
    console.log("Received token:", req.params.token); // Debug log
    
    const decoded = jwt.verify(
      req.params.token,
      process.env.JWT_VERIFICATION_SECRET
    );
    console.log("Decoded token:", decoded); // Debug log

    const updatedHost = await Host.findByIdAndUpdate(
      decoded.id,
      { isVerified: true },
      { new: true }
    );

    if (!updatedHost) {
      console.log("User not found for ID:", decoded.id); // Debug log
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }

    const token = signToken(updatedHost._id);
    console.log("Generated new token:", token); // Debug log

    res.status(200).json({
      status: 'success',
      token,
      isVerified: true // Explicitly send verification status
    });

  } catch (err) {
    console.error("Verification error:", err); // Detailed error logging
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        status: 'fail', 
        message: 'Link expired. Please request a new verification email.' 
      });
    }
    res.status(400).json({ 
      status: 'fail', 
      message: 'Invalid verification link' 
    });
  }
};


// controller
exports.resendVerification = async (req, res) => {
  try {
    const { email } = req.body;

    const host = await Host.findOne({ email: email.toLowerCase() });
    if (!host) {
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }

    if (host.isVerified) {
      return res.status(400).json({ status: 'fail', message: 'Email already verified' });
    }

    const verificationToken = jwt.sign(
      { id: host._id },
      process.env.JWT_VERIFICATION_SECRET,
      { expiresIn: '24h' }
    );

    const verificationUrl = `${process.env.FRONTEND_URL}/verified-email/${verificationToken}`;
    const mailOptions = {
      from: `"Genpayng" <${process.env.ZOHO_EMAIL}>`,
      to: host.email,
      subject: 'Verify Your Genpayng Account',
      html: `Click to verify: <a href="${verificationUrl}">${verificationUrl}</a>`,
    };

    await transporter.sendMail(mailOptions);

    res.status(200).json({ status: 'success', message: 'Verification email resent' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
};