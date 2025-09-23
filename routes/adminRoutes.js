// routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const adminAuthController = require('../controllers/adminAuthController');
const adminDashboardController = require('../controllers/adminDashboardController');
const adminPayoutController = require('../controllers/adminPayoutController');
const rateLimit = require('express-rate-limit');

// Rate limiting
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many login attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Auth routes
router.post('/login', loginLimiter, adminAuthController.adminLogin);
router.post('/logout', adminAuthController.protect, adminAuthController.adminLogout);
router.get('/me', adminAuthController.protect, adminAuthController.getCurrentAdmin);

// Dashboard routes
router.get('/dashboard/stats', adminAuthController.protect, adminDashboardController.getDashboardStats);
router.get('/hosts', adminAuthController.protect, adminDashboardController.getAllHosts);
router.get('/hosts/:hostId', adminAuthController.protect, adminDashboardController.getHostDetails);

// Payout management routes
router.get('/payouts/pending', adminAuthController.protect, adminPayoutController.getPendingPayouts);
router.get('/payouts', adminAuthController.protect, adminPayoutController.getAllPayouts);
router.post('/payouts/approve', adminAuthController.protect, adminPayoutController.uploadProof, adminPayoutController.approvePayout);
router.post('/payouts/reject', adminAuthController.protect, adminPayoutController.rejectPayout);
router.get('/payouts/approval-history', adminAuthController.protect, adminPayoutController.getPayoutApprovalHistory);

module.exports = router;