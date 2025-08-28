// routes/payoutRoutes.js
const express = require('express');
const router = express.Router();
const payoutController = require('../controllers/payoutController');
const authController = require('../controllers/authController');
const rateLimit = require('express-rate-limit');

const payoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: 'Too many payout requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/', authController.protect, payoutController.getAllPayouts);
router.get('/banks', authController.protect, payoutController.getBanks);
router.get('/payout-info', authController.protect, payoutController.getPayoutInfo);
router.post('/payout-info', authController.protect, payoutLimiter, payoutController.savePayoutInfo);
router.post('/resolve-bank', authController.protect, payoutLimiter, payoutController.resolveBankAccount);
router.delete('/payout-info', authController.protect, payoutLimiter, payoutController.deletePayoutInfo);
router.get('/wallet', authController.protect, payoutController.getWalletData);
router.post('/withdraw', authController.protect, payoutLimiter, payoutController.requestWithdrawal);
router.post('/update-payout-status', authController.protect, payoutController.updatePayoutStatus);
router.get('/host-balances', authController.protect, payoutController.getAllHostBalances);

module.exports = router;