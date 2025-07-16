const Host = require('../models/host');
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

    const hashedPassword = req.body.password;

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
    const verificationUrl = `${process.env.SECOND_FRONTEND_URL}/verified-email/${verificationToken}`;
    const mailOptions = {
      from: `"Genpay Nigeria" <${process.env.ZOHO_EMAIL}>`,
      to: newHost.email,
      subject: 'Verify Your Genpay Account',
 html: `
<div style="font-family: 'Poppins', sans-serif; max-width: 600px; margin: 0 auto; background-color: #000000; padding: 40px 20px; border-radius:20px;">
  <!-- Logo Section -->
  <div style="text-align: center; margin-bottom: 30px;">
    <img src="https://res.cloudinary.com/dhkzg2gfk/image/upload/v1752669123/genpaylogo_l4sfd7.png" alt="Genpayng Logo" style="max-width: 150px; height: auto; margin-bottom: 20px;" />
  </div>
  
  <!-- Header -->
  <div style="text-align: center; margin-bottom: 40px;">
    <h1 style="color: #FFFFFF; margin: 0; font-size: 32px; font-weight: 700; text-shadow: 0 2px 4px rgba(162, 40, 175, 0.3);">
      Welcome to Genpay!
    </h1>
  </div>
  
  <!-- Main Content -->
  <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%); padding: 40px; border-radius: 20px; box-shadow: 0 8px 32px rgba(162, 40, 175, 0.2); border: 1px solid #333;">
    <p style="color: #E0E0E0; font-size: 16px; line-height: 1.6; margin-bottom: 24px; font-weight: 400;">
      Thank you for creating an account with us! We're excited to have you on board. Please verify your email address to get started and unlock all the amazing features Genpayng has to offer.
    </p>
    
    <!-- CTA Button -->
    <div style="text-align: center; margin: 40px 0;">
      <a href="${verificationUrl}" 
         style="display: inline-block; 
                padding: 16px 32px; 
                background: linear-gradient(90deg, #A228AF 0%, #FF0000 100%);
                color: white; 
                text-decoration: none; 
                border-radius: 10px 10px 10px 0px;
                font-family: 'Poppins', sans-serif;
                font-weight: 600;
                font-size: 16px;
                letter-spacing: 0.5px;
                text-transform: uppercase;
                box-shadow: 0 4px 15px rgba(162, 40, 175, 0.4);">
        ✨ Verify Email Address
      </a>
    </div>
    
    <!-- Security Notice -->
    <div style="background: rgba(162, 40, 175, 0.1); padding: 20px; border-radius: 12px; border-left: 4px solid #A228AF; margin: 30px 0;">
      <p style="color: #FFFFFF; font-size: 14px; margin: 0; font-weight: 500;">
        🔒 <strong>Security Notice:</strong> This verification link will expire in 24 hours for your security.
      </p>
    </div>
    
    <p style="color: #B0B0B0; font-size: 14px; line-height: 1.5; margin-bottom: 0;">
      If you didn't create this account, please ignore this email. Your account will remain inactive until verified.
    </p>
  </div>
  
  <!-- Footer -->
  <div style="margin-top: 40px; padding-top: 30px; border-top: 1px solid #333;">
    <div style="text-align: center;">
      <p style="color: #666; font-size: 12px; margin: 0; font-weight: 300;">
        © ${new Date().getFullYear()} Genpay Nigeria. All rights reserved.
      </p>
      <p style="color: #555; font-size: 11px; margin: 10px 0 0 0;">
        Need help? Contact our support team at support@genpay.ng
      </p>
    </div>
  </div>
  
  <!-- Decorative Elements -->
  <div style="width: 100%; height: 2px; background: linear-gradient(90deg, #A228AF 0%, #FF0000 100%); margin-bottom: 20px;"></div>
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

    const verificationUrl = `${process.env.SECOND_FRONTEND_URL}/verified-email/${verificationToken}`;
    const mailOptions = {
      from: `"Genpay Nigeria" <${process.env.ZOHO_EMAIL}>`,
      to: host.email,
      subject: 'Verify Your Genpay Nigeria Account',
       html: `
<div style="font-family: 'Poppins', sans-serif; max-width: 600px; margin: 0 auto; background-color: #000000; padding: 40px 20px; border-radius:20px;">
  <!-- Logo Section -->
  <div style="text-align: center; margin-bottom: 30px;">
    <img src="https://res.cloudinary.com/dhkzg2gfk/image/upload/v1752669123/genpaylogo_l4sfd7.png" alt="Genpayng Logo" style="max-width: 150px; height: auto; margin-bottom: 20px;" />
  </div>
  
  <!-- Header -->
  <div style="text-align: center; margin-bottom: 40px;">
    <h1 style="color: #FFFFFF; margin: 0; font-size: 32px; font-weight: 700; text-shadow: 0 2px 4px rgba(162, 40, 175, 0.3);">
      Welcome to Genpay!
    </h1>
  </div>
  
  <!-- Main Content -->
  <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%); padding: 40px; border-radius: 20px; box-shadow: 0 8px 32px rgba(162, 40, 175, 0.2); border: 1px solid #333;">
    <p style="color: #E0E0E0; font-size: 16px; line-height: 1.6; margin-bottom: 24px; font-weight: 400;">
      Thank you for creating an account with us! We're excited to have you on board. Please verify your email address to get started and unlock all the amazing features Genpayng has to offer.
    </p>
    
    <!-- CTA Button -->
    <div style="text-align: center; margin: 40px 0;">
      <a href="${verificationUrl}" 
         style="display: inline-block; 
                padding: 16px 32px; 
                background: linear-gradient(90deg, #A228AF 0%, #FF0000 100%);
                color: white; 
                text-decoration: none; 
                border-radius: 10px 10px 10px 0px;
                font-family: 'Poppins', sans-serif;
                font-weight: 600;
                font-size: 16px;
                letter-spacing: 0.5px;
                text-transform: uppercase;
                box-shadow: 0 4px 15px rgba(162, 40, 175, 0.4);">
        ✨ Verify Email Address
      </a>
    </div>
    
    <!-- Security Notice -->
    <div style="background: rgba(162, 40, 175, 0.1); padding: 20px; border-radius: 12px; border-left: 4px solid #A228AF; margin: 30px 0;">
      <p style="color: #FFFFFF; font-size: 14px; margin: 0; font-weight: 500;">
        🔒 <strong>Security Notice:</strong> This verification link will expire in 24 hours for your security.
      </p>
    </div>
    
    <p style="color: #B0B0B0; font-size: 14px; line-height: 1.5; margin-bottom: 0;">
      If you didn't create this account, please ignore this email. Your account will remain inactive until verified.
    </p>
  </div>
  
  <!-- Footer -->
  <div style="margin-top: 40px; padding-top: 30px; border-top: 1px solid #333;">
    <div style="text-align: center;">
      <p style="color: #666; font-size: 12px; margin: 0; font-weight: 300;">
        © ${new Date().getFullYear()} Genpay Nigeria. All rights reserved.
      </p>
      <p style="color: #555; font-size: 11px; margin: 10px 0 0 0;">
        Need help? Contact our support team at support@genpay.ng
      </p>
    </div>
  </div>
  
  <!-- Decorative Elements -->
  <div style="width: 100%; height: 2px; background: linear-gradient(90deg, #A228AF 0%, #FF0000 100%); margin-bottom: 20px;"></div>
</div>
`,
    };

    await transporter.sendMail(mailOptions);

    res.status(200).json({ status: 'success', message: 'Verification email resent' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
};


exports.login = async (req, res) => {
  try {
    // 1) Validate required fields
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        status: 'fail',
        message: 'Please provide both email and password.'
      });
    }

    // 2) Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        status: 'fail',
        message: 'Please provide a valid email address.',
        field: 'email'
      });
    }

// 3) Find host by email and include password
const host = await Host.findOne({ email: email.toLowerCase() }).select('+password');

if (!host) {
  return res.status(401).json({
    status: 'fail',
    message: 'Invalid email or password.'
  });
}
    // 4) Compare passwords
    const isMatch = await bcrypt.compare(password, host.password);

    if (!isMatch) {
      return res.status(401).json({
        status: 'fail',
        message: 'Invalid email or password.'
      });
    }

    // 5) Generate JWT auth token
    const authToken = jwt.sign(
      { id: host._id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // 6) Prepare response data
    const responseData = {
      _id: host._id,
      userType: host.userType,
      email: host.email,
      ...(host.userType === 'individual'
        ? { firstName: host.firstName, lastName: host.lastName }
        : { organizationName: host.organizationName, fullName: host.fullName }),
      phoneNumber: host.phoneNumber,
      location: host.location,
      isVerified: host.isVerified
    };

    // 7) Return success
    res.status(200).json({
      status: 'success',
      token: authToken,
      data: {
        host: responseData
      },
      isVerified: host.isVerified,
      message: 'Login successful.'
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({
      status: 'error',
      message: 'An unexpected error occurred. Please try again later.'
    });
  }
};


// Authentication Middleware
exports.protect = async (req, res, next) => {
  try {
    // 1) Getting token and check if it's there
    let token;
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith('Bearer')
    ) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        status: 'fail',
        message: 'You are not logged in! Please log in to get access'
      });
    }

    // 2) Verification token
    const decoded = await jwt.verify(token, process.env.JWT_SECRET);

    // 3) Check if user still exists
    const currentHost = await Host.findById(decoded.id);
    if (!currentHost) {
      return res.status(401).json({
        status: 'fail',
        message: 'The user belonging to this token no longer exists'
      });
    }

    // 4) Grant access to protected route
    req.user = currentHost;
    next();
  } catch (err) {
    console.error('Authentication error:', err);
    res.status(401).json({
      status: 'fail',
      message: 'Invalid token. Please log in again'
    });
  }
};