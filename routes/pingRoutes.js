const express = require('express');
const router = express.Router();
const pingController = require('../controllers/pingController');
const rateLimit = require('express-rate-limit');

const pingLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 100, // Allow 100 requests per 10 minutes
  message: 'Too many ping requests, please try again later.',
});

router.get('/',pingLimiter, pingController.ping);


module.exports = router;