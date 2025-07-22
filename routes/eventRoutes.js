const express = require('express');
const router = express.Router();
const eventController = require('../controllers/eventController');
const authController = require('../controllers/authController');

router
  .route('/create')
  .post(authController.protect, eventController.createEvent);

router
  .route('/upload-image')
  .post(authController.protect, eventController.uploadEventImage);

  router
  .route('/upload-gallery')
  .post(authController.protect, eventController.uploadGalleryImage);
module.exports = router;