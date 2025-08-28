// routes/ticketRouter.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const Ticket = require('../models/ticket');
const mongoose = require('mongoose');
router.get('/event/:id', authController.protect, async (req, res) => {
  try {
    const eventId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(eventId)) {
      return res.status(400).json({
        status: 'fail',
        message: 'Invalid event ID',
      });
    }

    const tickets = await Ticket.find({ event: eventId }).select('price');
    res.status(200).json({
      status: 'success',
      data: { tickets },
    });
  } catch (error) {
    console.error('Error fetching tickets for event:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch tickets',
      error: error.message,
    });
  }
});

module.exports = router;