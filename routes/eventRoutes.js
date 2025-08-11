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
  router.post('/:id/purchase-ticket', eventController.purchaseTicket); // No auth required


  router.get('/public', eventController.getPublicEvents); // Public endpoint for all users
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