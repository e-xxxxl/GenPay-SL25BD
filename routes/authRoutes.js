const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const authController = require('../controllers/authController');

// Rate limiting configuration
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit each IP to 50 requests per window
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

// Login rate limiter (5 attempts per 15 minutes)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: 'Too many login attempts from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});


// Public routes
router.post('/signup', authLimiter, authController.signup);
router.get('/verify-email/:token', authLimiter, authController.verifyEmail);
router.post('/resend-verification', authLimiter, authController.resendVerification);
router.post('/login', loginLimiter, authController.login);
router.post('/refresh', authController.refreshToken);
router.post('/forgot-password',loginLimiter, authController.forgotPassword);
router.post('/reset-password', loginLimiter,authController.resetPassword);
router.get('/me', authController.protect, authController.getMe);
router.put('/update-profile', authController.protect, authController.updateProfile);
router.post('/send-support-message', authController.sendSupportMessage);


module.exports = router;