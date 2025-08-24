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


  router.get('/public',ticketLimiter,ticketLimiter, eventController.getPublicEvents); // Public endpoint for all users
router.get('/', authController.protect,ticketLimiter, eventController.getEvents);
router.get('/:id', authController.protect,ticketLimiter, eventController.getEventById); // Protected endpoint
router.put('/:id', authController.protect, eventController.updateEvent); // Protected endpoint
router.post('/:id/ticket-policy', authController.protect, eventController.setTicketPolicy);
router.post('/:id/tickets', authController.protect,ticketLimiter, eventController.addTicket);
router.put('/:id/tickets/:ticketId', authController.protect,ticketLimiter, eventController.editTicket);
router.get('/:id/getTickets', authController.protect,ticketLimiter, eventController.getEventTickets);
router.delete('/:id/tickets/:ticketId', authController.protect,ticketLimiter, eventController.deleteTicket);

router.post("/:id/check-in-ticket",ticketLimiter, eventController.checkInTicket);
// routes/eventRouter.js
router.post('/:id/search-ticket', authController.protect,ticketLimiter, eventController.searchTicket);
// routes/eventRouter.js
router.get('/:id/checkins', authController.protect,ticketLimiter, eventController.getCheckins);
router.delete('/:id', eventController.deleteEvent,ticketLimiter,);
// routes/eventRouter.js
router.get('/:id/ticket-buyers', authController.protect, eventController.getTicketBuyers);
router.get('/:id/payouts', authController.protect, eventController.getPayouts);

router
  .route('/delete-header-image')
  .delete(authController.protect, eventController.deleteHeaderImage)
  router
  .route('/delete-gallery-image')
  .delete(authController.protect, eventController.deleteGalleryImage)

  
module.exports = router;