// controllers/adminAuthController.js
const Admin = require('../models/admin');
const jwt = require('jsonwebtoken');

// Create initial admin users (run once)
exports.createAdminUsers = async () => {
  try {
    const adminUsers = [
      {
        name: 'Toluwanimi',
        username: 'toluwanimi@genpay.ng',
        password: 'Toluwanimi123!', // Change to unique passwords
        role: 'super_admin'
      },
      {
        name: 'Oluwatosin',
        username: 'oluwatosin@genpay.ng',
        password: 'Oluwatosin123!',
        role: 'admin'
      },
      {
        name: 'Emmanuel',
        username: 'emmanuel@genpay.ng',
        password: 'Emmanuel123!',
        role: 'admin'
      },
      {
        name: 'Kolapo',
        username: 'kolapo@genpay.ng',
        password: 'Kolapo123!',
        role: 'admin'
      }
    ];

    for (const userData of adminUsers) {
      const existingAdmin = await Admin.findOne({ username: userData.username });
      if (!existingAdmin) {
        await Admin.create(userData);
        console.log(`Admin user ${userData.name} created successfully`);
      }
    }
  } catch (error) {
    console.error('Error creating admin users:', error);
  }
};

// Admin login
exports.adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        status: 'fail',
        message: 'Email and password are required'
      });
    }

    // Find admin by username (which is the email)
    const admin = await Admin.findOne({ username: email.toLowerCase() }).select('+password');
    if (!admin) {
      return res.status(401).json({
        status: 'fail',
        message: 'Invalid credentials'
      });
    }

    // Check password
    const isPasswordValid = await admin.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        status: 'fail',
        message: 'Invalid credentials'
      });
    }

    // Update online status and login history
    await admin.updateOnlineStatus(true);
    admin.loginHistory.push({
      loginTime: new Date(),
      ipAddress: req.ip,
      userAgent: req.get('User-Agent')
    });
    await admin.save();

    // Generate JWT token
    const token = jwt.sign(
      { id: admin._id, role: admin.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    res.status(200).json({
      status: 'success',
      data: {
        token,
        admin: {
          id: admin._id,
          name: admin.name,
          username: admin.username,
          role: admin.role,
          isOnline: admin.isOnline
        }
      },
      message: 'Login successful'
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({
      status: 'error',
      message: 'An unexpected error occurred'
    });
  }
};

// Admin logout
exports.adminLogout = async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (admin) {
      await admin.updateOnlineStatus(false);
    }

    res.status(200).json({
      status: 'success',
      message: 'Logout successful'
    });
  } catch (error) {
    console.error('Admin logout error:', error);
    res.status(500).json({
      status: 'error',
      message: 'An unexpected error occurred'
    });
  }
};

// Get current admin
exports.getCurrentAdmin = async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin.id).select('-password');
    
    res.status(200).json({
      status: 'success',
      data: { admin }
    });
  } catch (error) {
    console.error('Get current admin error:', error);
    res.status(500).json({
      status: 'error',
      message: 'An unexpected error occurred'
    });
  }
};

// Protect middleware for admin routes
exports.protect = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        status: 'fail',
        message: 'You are not logged in. Please log in to get access.'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const currentAdmin = await Admin.findById(decoded.id);
    if (!currentAdmin) {
      return res.status(401).json({
        status: 'fail',
        message: 'The admin belonging to this token does no longer exist.'
      });
    }

    req.admin = currentAdmin;
    next();
  } catch (error) {
    console.error('Admin protect middleware error:', error);
    res.status(401).json({
      status: 'fail',
      message: 'Invalid token'
    });
  }
};

// Restrict to certain roles
exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.admin.role)) {
      return res.status(403).json({
        status: 'fail',
        message: 'You do not have permission to perform this action'
      });
    }
    next();
  };
};