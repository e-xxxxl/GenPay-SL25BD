const express = require('express');
const router = express.Router();
const eventController = require('../controllers/eventController');
const authController = require('../controllers/authController');
const rateLimit = require('express-rate-limit');


// Rate limiting configuration
const ticketLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit each IP to 50 requests per window
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

const pingLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 100, // Allow 100 requests per 10 minutes
  message: 'Too many ping requests, please try again later.',
});

router
  .route('/create')
  .post(authController.protect, ticketLimiter, eventController.createEvent);

router
  .route('/upload-image')
  .post(authController.protect, ticketLimiter, eventController.uploadEventImage);

router
  .route('/upload-gallery')
  .post(authController.protect, ticketLimiter, eventController.uploadGalleryImage);
  router.post('/:id/purchase-ticket', ticketLimiter, eventController.purchaseTicket); // No auth required

// routes/event.js

  router.get('/public',eventController.getPublicEvents);
router.get('/public/slug/:eventName', eventController.getEventByName);
router.get('/', authController.protect, eventController.getEvents);
router.get('/:id', authController.protect, eventController.getEventById); // Protected endpoint
router.put('/:id', authController.protect, eventController.updateEvent); // Protected endpoint
router.post('/:id/ticket-policy', authController.protect, eventController.setTicketPolicy);
router.post('/:id/tickets', authController.protect, eventController.addTicket);
router.put('/:id/tickets/:ticketId', authController.protect, eventController.editTicket);
router.get('/:id/getTickets', authController.protect, eventController.getEventTickets);
router.delete('/:id/tickets/:ticketId', authController.protect, eventController.deleteTicket);

router.post("/:id/check-in-ticket", eventController.checkInTicket);
// routes/eventRouter.js
router.post('/:id/search-ticket', authController.protect, eventController.searchTicket);
// routes/eventRouter.js
router.get('/:id/checkins', authController.protect, eventController.getCheckins);
router.delete('/:id', eventController.deleteEvent,ticketLimiter,);
// routes/eventRouter.js
router.get('/:id/ticket-buyers', authController.protect, eventController.getTicketBuyers);
router.get('/:id/export-ticket-buyers', eventController.exportTicketBuyersCSV); // NEW
router.get('/:id/payouts', authController.protect, eventController.getPayouts);

router
  .route('/delete-header-image')
  .delete(authController.protect, eventController.deleteHeaderImage)
  router
  .route('/delete-gallery-image')
  .delete(authController.protect, eventController.deleteGalleryImage)

  // router.post('/withdraw', authController.protect, ticketLimiter, eventController.requestWithdrawal);

  
module.exports = router;