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
// router.get('/dashboard', authController.protect, dashboardController);
// router.post('/login', authLimiter, authController.login);
// router.post('/forgot-password', authLimiter, authController.forgotPassword);
// router.patch('/reset-password/:token', authLimiter, authController.resetPassword);

// // Protected routes (require authentication)
// router.use(authController.protect); // This applies to all routes below
// router.get('/me', authController.getMe);
// router.patch('/update-me', authController.updateMe);
// router.delete('/delete-me', authController.deleteMe);
// router.patch('/update-password', authController.updatePassword);

module.exports = router;