const Host = require('../models/host');
const Event = require('../models/event');
const Ticket = require('../models/ticket');
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
      fullName: 'Contact person full name', // New field label
    };

    const requiredFields = ['email', 'password', 'phoneNumber', 'location'];
    if (req.body.userType === 'individual') {
      requiredFields.push('firstName', 'lastName');
    } else if (req.body.userType === 'organization') {
      requiredFields.push('firstName', 'fullName'); // Require both org name and contact name
    }

    const missingFields = requiredFields.filter((field) => !req.body[field]);
    if (missingFields.length > 0) {
      return res.status(400).json({
        status: 'fail',
        message: `Please provide: ${missingFields.map((f) => fieldLabels[f]).join(', ')}`,
        fields: missingFields,
      });
    }

    // 2) Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(req.body.email)) {
      return res.status(400).json({
        status: 'fail',
        message: 'Please provide a valid email address',
        field: 'email',
      });
    }

    // 3) Check for existing user
    const existingHost = await Host.findOne({
      $or: [{ email: req.body.email.toLowerCase() }, { phoneNumber: req.body.phoneNumber }],
    });

    if (existingHost) {
      const conflictField = existingHost.email === req.body.email.toLowerCase() ? 'email' : 'phoneNumber';
      return res.status(409).json({
        status: 'fail',
        message: `${fieldLabels[conflictField]} is already in use`,
        field: conflictField,
      });
    }

    // 4) Hash password
    const hashedPassword = req.body.password; // Note: Password hashing should be implemented properly

    // 5) Create host with additional validation
    const hostData = {
      userType: req.body.userType,
      email: req.body.email.toLowerCase(),
      password: hashedPassword,
      phoneNumber: req.body.phoneNumber,
      location: req.body.location,
      isVerified: false, // Default to false until email verification
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

    // 7) Send verification email using Resend
    const verificationUrl = `${process.env.SECOND_FRONTEND_URL}/verified-email/${verificationToken}`;
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    console.log('Sending verification email to:', newHost.email);

    try {
      const data = await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL, // e.g., noreply@yourdomain.com
        to: [newHost.email],
        subject: 'Verify Your Genpay Account',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
            <!-- Logo Section -->
            <div style="text-align: center; margin-bottom: 20px;">
              <img src="https://res.cloudinary.com/dhkzg2gfk/image/upload/v1752669123/genpaylogo_l4sfd7.png" alt="Genpayng Logo" style="max-width: 150px; height: auto;" />
            </div>

            <!-- Header -->
            <h2 style="color: #1a73e8; text-align: center;">Welcome to Genpay!</h2>

            <!-- Main Content -->
            <div style="background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
              <p style="font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
                Thank you for joining Genpay! Please verify your email address to activate your account and start exploring all our features.
              </p>

              <!-- CTA Button -->
              <div style="text-align: center; margin: 20px 0;">
                <a href="${verificationUrl}" 
                   style="display: inline-block; padding: 12px 24px; background: linear-gradient(90deg, #A228AF 0%, #FF0000 100%); color: white; text-decoration: none; border-radius: 5px; font-size: 16px; font-weight: 600;">
                  Verify Email Address
                </a>
              </div>

              <!-- Security Notice -->
              <p style="font-size: 14px; color: #555; margin: 20px 0;">
                <strong>Security Notice:</strong> This verification link expires in 24 hours for your security.
              </p>

              <p style="font-size: 14px; color: #555;">
                If you didn’t create this account, please ignore this email. Your account will remain inactive until verified.
              </p>
            </div>

            <!-- Footer -->
            <div style="text-align: center; margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd;">
              <p style="font-size: 12px; color: #666; margin: 0;">
                © ${new Date().getFullYear()} Genpay Nigeria. All rights reserved.
              </p>
              <p style="font-size: 12px; color: #666; margin: 10px 0 0;">
                Need help? Contact us at <a href="mailto:support@genpay.ng" style="color: #1a73e8; text-decoration: none;">support@genpay.ng</a>
              </p>
            </div>
          </div>
        `,
        text: `Please verify your email by visiting this link: ${verificationUrl}\n\nThis link expires in 24 hours.`,
      });

      console.log(`Verification email sent to ${newHost.email} via Resend (ID: ${data?.data?.id || 'Unknown'})`);

      // 8) Prepare response data
      const responseData = {
        _id: newHost._id,
        userType: newHost.userType,
        email: newHost.email,
        ...(newHost.userType === 'individual'
          ? {
              firstName: newHost.firstName,
              lastName: newHost.lastName,
            }
          : {
              organizationName: newHost.organizationName,
              fullName: newHost.fullName,
            }),
        phoneNumber: newHost.phoneNumber,
        location: newHost.location,
      };

      res.status(201).json({
        status: 'success',
        token: authToken,
        data: {
          host: responseData,
        },
        message: 'Account created successfully! Please check your email for verification.',
      });
    } catch (emailError) {
      console.error(`Failed to send verification email to ${newHost.email}:`, emailError);
      // Prepare response data for partial success
      const responseData = {
        _id: newHost._id,
        userType: newHost.userType,
        email: newHost.email,
        ...(newHost.userType === 'individual'
          ? {
              firstName: newHost.firstName,
              lastName: newHost.lastName,
            }
          : {
              organizationName: newHost.organizationName,
              fullName: newHost.fullName,
            }),
        phoneNumber: newHost.phoneNumber,
        location: newHost.location,
      };

      res.status(207).json({
        status: 'partial_success',
        token: authToken,
        data: {
          host: responseData,
          emailError: emailError.message,
        },
        message: 'Account created successfully, but failed to send verification email. Please contact support.',
      });
    }
  } catch (err) {
    console.error('Signup error:', err);

    // Handle duplicate fields (even if they slipped through initial check)
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern)[0];
      const fieldName = field === 'email' ? 'Email address' : field === 'phoneNumber' ? 'Phone number' : field;
      return res.status(409).json({
        status: 'fail',
        message: `${fieldName} is already in use`,
        field: field,
      });
    }

    // Handle validation errors
    if (err.name === 'ValidationError') {
      const errors = Object.values(err.errors).map((el) => ({
        field: el.path,
        message: el.message,
      }));
      return res.status(400).json({
        status: 'fail',
        message: 'Validation failed',
        errors: errors,
      });
    }

    // Generic server error
    res.status(500).json({
      status: 'error',
      message: 'An unexpected error occurred. Please try again later.',
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
       const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    console.log('Sending verification email to:', host.email);

     const data = await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL, // e.g., noreply@yourdomain.com
        to: [host.email],
        subject: 'Verify Your Genpay Account',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
            <!-- Logo Section -->
            <div style="text-align: center; margin-bottom: 20px;">
              <img src="https://res.cloudinary.com/dhkzg2gfk/image/upload/v1752669123/genpaylogo_l4sfd7.png" alt="Genpayng Logo" style="max-width: 150px; height: auto;" />
            </div>

            <!-- Header -->
            <h2 style="color: #1a73e8; text-align: center;">Welcome to Genpay!</h2>

            <!-- Main Content -->
            <div style="background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
              <p style="font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
                Thank you for joining Genpay! Please verify your email address to activate your account and start exploring all our features.
              </p>

              <!-- CTA Button -->
              <div style="text-align: center; margin: 20px 0;">
                <a href="${verificationUrl}" 
                   style="display: inline-block; padding: 12px 24px; background: linear-gradient(90deg, #A228AF 0%, #FF0000 100%); color: white; text-decoration: none; border-radius: 5px; font-size: 16px; font-weight: 600;">
                  Verify Email Address
                </a>
              </div>

              <!-- Security Notice -->
              <p style="font-size: 14px; color: #555; margin: 20px 0;">
                <strong>Security Notice:</strong> This verification link expires in 24 hours for your security.
              </p>

              <p style="font-size: 14px; color: #555;">
                If you didn’t create this account, please ignore this email. Your account will remain inactive until verified.
              </p>
            </div>

            <!-- Footer -->
            <div style="text-align: center; margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd;">
              <p style="font-size: 12px; color: #666; margin: 0;">
                © ${new Date().getFullYear()} Genpay Nigeria. All rights reserved.
              </p>
              <p style="font-size: 12px; color: #666; margin: 10px 0 0;">
                Need help? Contact us at <a href="mailto:support@genpay.ng" style="color: #1a73e8; text-decoration: none;">support@genpay.ng</a>
              </p>
            </div>
          </div>
        `,
        text: `Please verify your email by visiting this link: ${verificationUrl}\n\nThis link expires in 24 hours.`,
      });

 console.log(`Verification email sent to ${host.email} via Resend (ID: ${data?.data?.id || 'Unknown'})`);
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




exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    // 1) Validate email presence & format
    if (!email) {
      return res.status(400).json({
        status: 'fail',
        message: 'Please provide your email address'
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        status: 'fail',
        message: 'Please provide a valid email address'
      });
    }

    // 2) Check if user exists
    const user = await Host.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({
        status: 'fail',
        message: 'No account found with that email'
      });
    }

    // 3) Generate reset token
    const resetToken = jwt.sign(
      { id: user._id },
      process.env.JWT_RESET_SECRET,
      { expiresIn: '1h' } // Token expires in 1 hour
    );

    // Optionally, store reset token in DB with expiry if you want to
    user.passwordResetToken = resetToken;
    user.passwordResetExpires = Date.now() + 60 * 60 * 1000; // 1 hour
    await user.save({ validateBeforeSave: false });

    // 4) Send email
    const resetUrl = `${process.env.SECOND_FRONTEND_URL}/reset-password/${resetToken}`;
  const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    console.log('Sending Password reset email to:', user.email);

     const data = await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL, // e.g., noreply@yourdomain.com
        to: [user.email],
  subject: 'Password Reset Request',
  html: `
    <div style="font-family: 'Poppins', Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0f0f0f; color: #ffffff; padding: 30px; border-radius: 8px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #ffffff; margin-bottom: 20px; font-size: 24px;">Reset Your Password</h1>
        <div style="background: linear-gradient(135deg, #A228AF 0%, #FF0000 100%); width: 60px; height: 4px; margin: 0 auto;"></div>
      </div>
      
      <p style="margin-bottom: 20px;">You requested to reset your password for your GenPayng account.</p>
      
      <p style="margin-bottom: 30px;">Click the button below to set a new password:</p>
      
      <div style="text-align: center; margin-bottom: 30px;">
        <a href="${resetUrl}"
           style="display: inline-block; padding: 12px 30px; 
                  background: linear-gradient(135deg, #A228AF 0%, #FF0000 100%); 
                  color: white; text-decoration: none; border-radius: 15px 15px 15px 0px;
                  font-weight: 500; font-size: 16px;">
          Reset Password
        </a>
      </div>
      
      <p style="margin-bottom: 10px; font-size: 12px; color: #aaaaaa;">
        This link will expire in 1 hour. If you didn't request this, please ignore this email.
      </p>
      
      <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #333333; text-align: center;">
        <p style="font-size: 12px; color: #777777;">
          © ${new Date().getFullYear()} GenPayng. All rights reserved.
        </p>
      </div>
    </div>
  `,
  text: `Reset your password by visiting this link: ${resetUrl}\n\nThis link expires in 1 hour.`
});
    console.log(`Verification email sent to ${user.email} via Resend (ID: ${data?.data?.id || 'Unknown'})`);

    res.status(200).json({
      status: 'success',
      message: 'Password reset link sent to your email'
    });

  } catch (err) {
    console.error('Forgot password error:', err);

    res.status(500).json({
      status: 'error',
      message: 'An unexpected error occurred. Please try again later.'
    });
  }
};



exports.resetPassword = async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({
        status: 'fail',
        message: 'Token and new password are required'
      });
    }

    // 1) Verify token without checking database first
    const decoded = jwt.verify(token, process.env.JWT_RESET_SECRET);
    
    // 2) Find user and verify token match
    const user = await Host.findOne({
      _id: decoded.id,
      passwordResetToken: token,
      passwordResetExpires: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(401).json({
        status: 'fail',
        message: 'Token is invalid or has expired'
      });
    }

    // 3) Update password
    user.password = newPassword;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    // 4) Send success response
    res.status(200).json({
      status: 'success',
      message: 'Password updated successfully'
    });

  } catch (err) {
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({
        status: 'fail',
        message: 'Invalid token'
      });
    }
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        status: 'fail',
        message: 'Token has expired'
      });
    }
    
    console.error('Reset password error:', err);
    res.status(500).json({
      status: 'error',
      message: 'An error occurred while resetting password'
    });
  }
};


// Get current user details
exports.getMe = async (req, res) => {
  try {
    // User is already available from the protect middleware
    const user = req.user;
    
    // Prepare response data based on user type
    const responseData = {
      _id: user._id,
      userType: user.userType,
      email: user.email,
      ...(user.userType === 'individual'
        ? { 
            firstName: user.firstName, 
            lastName: user.lastName,
            fullName: `${user.firstName} ${user.lastName}`
          }
        : { 
            organizationName: user.organizationName,
            fullName: user.fullName 
          }),
      phoneNumber: user.phoneNumber,
      location: user.location,
      isVerified: user.isVerified
    };

    res.status(200).json({
      status: 'success',
      data: {
        user: responseData
      }
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({
      status: 'error',
      message: 'An unexpected error occurred.'
    });
  }
};




exports.updateProfile = async (req, res) => {
  try {
    const user = req.user;
    const updates = req.body;

    // Validate required fields based on user type
    if (!updates.firstName) {
      return res.status(400).json({
        status: 'fail',
        message: updates.userType === 'individual' 
          ? 'First name is required' 
          : 'Brand name is required',
        field: 'firstName'
      });
    }

    if (updates.userType === 'individual' && !updates.lastName) {
      return res.status(400).json({
        status: 'fail',
        message: 'Last name is required',
        field: 'lastName'
      });
    }

    if (updates.userType === 'organization' && !updates.fullName) {
      return res.status(400).json({
        status: 'fail',
        message: 'Full name is required',
        field: 'fullName'
      });
    }

    // Email validation
    if (updates.email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(updates.email)) {
        return res.status(400).json({
          status: 'fail',
          message: 'Please provide a valid email address',
          field: 'email'
        });
      }

      // Check if email is already taken by another user
      const existingUser = await Host.findOne({ 
        email: updates.email.toLowerCase(),
        _id: { $ne: user._id }
      });

      if (existingUser) {
        return res.status(409).json({
          status: 'fail',
          message: 'Email is already in use',
          field: 'email'
        });
      }
    }

    // Phone number validation
    if (updates.phoneNumber) {
      const existingPhone = await Host.findOne({
        phoneNumber: updates.phoneNumber,
        _id: { $ne: user._id }
      });

      if (existingPhone) {
        return res.status(409).json({
          status: 'fail',
          message: 'Phone number is already in use',
          field: 'phoneNumber'
        });
      }
    }

    // Prepare update object based on user type
    const updateData = {
      email: updates.email || user.email,
      phoneNumber: updates.phoneNumber || user.phoneNumber,
      location: updates.location || user.location,
      ...(user.userType === 'individual'
        ? {
            firstName: updates.firstName,
            lastName: updates.lastName
          }
        : {
            organizationName: updates.firstName, // Note: frontend sends as firstName for both types
            fullName: updates.fullName
          })
    };

    // Update user in database
    const updatedUser = await Host.findByIdAndUpdate(
      user._id,
      updateData,
      { new: true, runValidators: true }
    );

    // Prepare response
    const responseData = {
      _id: updatedUser._id,
      userType: updatedUser.userType,
      email: updatedUser.email,
      ...(updatedUser.userType === 'individual'
        ? { 
            firstName: updatedUser.firstName, 
            lastName: updatedUser.lastName,
            fullName: `${updatedUser.firstName} ${updatedUser.lastName}`
          }
        : { 
            organizationName: updatedUser.organizationName,
            fullName: updatedUser.fullName 
          }),
      phoneNumber: updatedUser.phoneNumber,
      location: updatedUser.location,
      isVerified: updatedUser.isVerified
    };

    res.status(200).json({
      status: 'success',
      data: {
        user: responseData
      },
      message: 'Profile updated successfully'
    });

  } catch (err) {
    console.error('Update profile error:', err);
    
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

    // Handle duplicate field errors
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

    res.status(500).json({
      status: 'error',
      message: 'An unexpected error occurred. Please try again later.'
    });
  }
};


exports.sendSupportMessage = async (req, res) => {
  try {
    const { firstName, lastName, email, issueCategory, message } = req.body;

    // Basic validation
    if (!firstName || !lastName || !email || !issueCategory || !message) {
      return res.status(400).json({
        status: 'fail',
        message: 'All fields are required'
      });
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        status: 'fail',
        message: 'Please provide a valid email address',
        field: 'email'
      });
    }
  const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
 
      

    
    // Create email content
   const data = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: 'support@genpay.ng',
      subject: `New Support Request: ${issueCategory} - ${firstName} ${lastName}`,
      html: `
        <div style="font-family: 'Poppins', sans-serif; max-width: 600px; margin: 0 auto; background-color: #0f0f0f; color: #ffffff; padding: 30px; border-radius: 8px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #ffffff; margin-bottom: 20px; font-size: 24px;">New Support Request</h1>
            <div style="background: linear-gradient(135deg, #A228AF 0%, #FF0000 100%); width: 60px; height: 4px; margin: 0 auto;"></div>
          </div>
          
          <div style="margin-bottom: 20px;">
            <p><strong>From:</strong> ${firstName} ${lastName}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Category:</strong> ${issueCategory}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
          </div>
          
          <div style="background: rgba(162, 40, 175, 0.1); padding: 20px; border-radius: 8px; border-left: 4px solid #A228AF;">
            <p style="margin: 0;"><strong>Message:</strong></p>
            <p style="margin-top: 10px; white-space: pre-line;">${message}</p>
          </div>
          
          <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #333333; text-align: center;">
            <p style="font-size: 12px; color: #777777;">
              © ${new Date().getFullYear()} Genpay Nigeria. All rights reserved.
            </p>
          </div>
        </div>
      `,
      text: `New support request from ${firstName} ${lastName} (${email}):
      
Category: ${issueCategory}
Message:
${message}
      
Received: ${new Date().toLocaleString()}
      `
    });

    // Send email
   console.log(` Support email sent  via Resend (ID: ${data?.data?.id || 'Unknown'})`);

    // Send confirmation email to user

      const dataa = await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL, // e.g., noreply@yourdomain.com
        to: [email],
      subject: 'We\'ve received your message',
      html: `
        <div style="font-family: 'Poppins', sans-serif; max-width: 600px; margin: 0 auto; background-color: #0f0f0f; color: #ffffff; padding: 30px; border-radius: 8px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #ffffff; margin-bottom: 20px; font-size: 24px;">Thank you for contacting us</h1>
            <div style="background: linear-gradient(135deg, #A228AF 0%, #FF0000 100%); width: 60px; height: 4px; margin: 0 auto;"></div>
          </div>
          
          <p style="margin-bottom: 20px;">Hello ${firstName},</p>
          
          <p style="margin-bottom: 20px;">We've received your message regarding <strong>${issueCategory}</strong> and our support team will get back to you as soon as possible.</p>
          
          <div style="background: rgba(162, 40, 175, 0.1); padding: 20px; border-radius: 8px; border-left: 4px solid #A228AF; margin-bottom: 20px;">
            <p style="margin: 0;"><strong>Your message:</strong></p>
            <p style="margin-top: 10px; white-space: pre-line;">${message}</p>
          </div>
          
          <p style="margin-bottom: 20px;">For your reference, here are our support details:</p>
          
          <ul style="margin-bottom: 20px; padding-left: 20px;">
            <li>Support Email: support@genpay.ng</li>
            <li>Business Hours: Mon-Fri 9AM-6PM (WAT)</li>
            <li>Response Time: Typically within 24 hours</li>
          </ul>
          
          <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #333333; text-align: center;">
            <p style="font-size: 12px; color: #777777;">
              © ${new Date().getFullYear()} Genpay Nigeria. All rights reserved.
            </p>
          </div>
        </div>
      `,
      text: `Thank you for contacting Genpay Nigeria support.

We've received your message regarding ${issueCategory} and our team will get back to you soon.

Your message:
${message}

Support Email: support@genpay.ng
Business Hours: Mon-Fri 9AM-6PM (WAT)

© ${new Date().getFullYear()} Genpay Nigeria
      `
    });

   console.log(` email sent to ${email} via Resend (ID: ${dataa?.dataa?.id || 'Unknown'})`);

    res.status(200).json({
      status: 'success',
      message: 'Your message has been sent successfully!'
    });

  } catch (err) {
    console.error('Error sending support message:', err);
    
    if (err.code === 'EENVELOPE' || err.code === 'ECONNECTION') {
      return res.status(500).json({
        status: 'error',
        message: 'Failed to send message. Please try again later.'
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'An unexpected error occurred. Please try again later.'
    });
  }
};

// Authentication Middleware
exports.protect = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        status: 'fail',
        message: 'No authentication token provided',
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      console.error('JWT verification error:', err.message);
      return res.status(401).json({
        status: 'fail',
        message: 'Invalid or expired token',
      });
    }

    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(401).json({
        status: 'fail',
        message: 'The user belonging to this token no longer exists',
      });
    }

    req.user = host;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Authentication error',
    });
  }
};

exports.refreshToken = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        status: 'fail',
        message: 'No token provided',
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
    } catch (err) {
      return res.status(401).json({
        status: 'fail',
        message: 'Invalid token',
      });
    }

    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(401).json({
        status: 'fail',
        message: 'User no longer exists',
      });
    }

    const newToken = jwt.sign({ id: host._id }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });

    res.status(200).json({
      status: 'success',
      token: newToken,
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to refresh token',
    });
  }
};