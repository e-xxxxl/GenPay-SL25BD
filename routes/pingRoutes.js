const express = require('express');
const router = express.Router();
const pingController = require('../controllers/pingController');
const rateLimit = require('express-rate-limit');



router.get('/', pingController.ping);


module.exports = router;