const axios = require('axios');
const Event = require('../models/event');
const Host = require('../models/host');
const User = require('../models/user');
const Ticket = require('../models/ticket');
const Transaction = require('../models/transaction');
const QRCode = require('qrcode');
const cloudinary = require('../config/cloudinary');
const { v4: uuidv4 } = require('uuid');

// Initialize Paystack Transaction
exports.initializePaystackTransaction = async (req, res) => {
  try {
    const { email, amount, eventId, tickets, fees, metadata } = req.body;

    // Validate required fields
    if (!email || !amount || amount <= 0) {
      return res.status(400).json({
        status: 'fail',
        message: 'Email and valid amount are required'
      });
    }

    if (!eventId) {
      return res.status(400).json({
        status: 'fail',
        message: 'Event ID is required'
      });
    }

    // Verify event exists
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        status: 'fail',
        message: 'Event not found'
      });
    }

    // Generate unique reference
    const reference = `PAY_${eventId}_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Prepare metadata with your custom data
    const customMetadata = {
      eventId,
      tickets: JSON.stringify(tickets),
      fees: fees || 0,
      custom_fields: metadata?.custom_fields || [],
      timestamp: new Date().toISOString()
    };

    // Call Paystack initialize endpoint
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: Math.round(amount * 100), // Convert to kobo
        reference,
        metadata: customMetadata,
        callback_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/checkout/verify`
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    if (response.data.status) {
      return res.status(200).json({
        status: 'success',
        data: {
          access_code: response.data.data.access_code,
          reference: response.data.data.reference,
          authorization_url: response.data.data.authorization_url
        }
      });
    } else {
      throw new Error(response.data.message || 'Failed to initialize transaction');
    }
  } catch (error) {
    console.error('Paystack initialization error:', error.response?.data || error.message);
    res.status(500).json({
      status: 'error',
      message: error.response?.data?.message || 'Failed to initialize payment. Please try again.'
    });
  }
};

// Verify Paystack Transaction
exports.verifyPaystackTransaction = async (req, res) => {
  try {
    const { reference } = req.params;

    if (!reference) {
      return res.status(400).json({
        status: 'fail',
        message: 'Transaction reference is required'
      });
    }

    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        },
        timeout: 30000
      }
    );

    if (response.data.status && response.data.data.status === 'success') {
      // Transaction is successful
      const { metadata, amount, reference: txRef } = response.data.data;
      
      // Process the ticket purchase using the stored metadata
      const eventId = metadata.eventId;
      const tickets = JSON.parse(metadata.tickets || '[]');
      const fees = parseFloat(metadata.fees || 0);
      
      // Call your existing purchaseTicket logic
      const purchaseResult = await processSuccessfulPayment({
        eventId,
        tickets,
        reference: txRef,
        fees,
        amount: amount / 100 // Convert back from kobo
      });
      
      return res.status(200).json({
        status: 'success',
        data: {
          transaction: response.data.data,
          purchase: purchaseResult
        }
      });
    } else {
      return res.status(400).json({
        status: 'fail',
        message: response.data.message || 'Transaction verification failed'
      });
    }
  } catch (error) {
    console.error('Verification error:', error.response?.data || error.message);
    res.status(500).json({
      status: 'error',
      message: error.response?.data?.message || 'Failed to verify transaction'
    });
  }
};

// Helper function to process successful payment
async function processSuccessfulPayment({ eventId, tickets, reference, fees, amount }) {
  try {
    // Find event
    const event = await Event.findById(eventId).select(
      'eventName startDateTime endDateTime eventLocation tickets host'
    );
    
    if (!event) {
      throw new Error('Event not found');
    }

    if (!event.host) {
      throw new Error('Event has no associated host');
    }

    // Validate tickets and calculate subtotal
    let subtotal = 0;
    const createdTickets = [];
    const emailTicketsMap = {};

    for (const ticketPurchase of tickets) {
      const { ticketId, customer, quantity = 1 } = ticketPurchase;
      
      const eventTicket = event.tickets.find((t) => t.id === ticketId);
      if (!eventTicket) {
        throw new Error(`Ticket with ID ${ticketId} not found in event`);
      }

      const price = Number(eventTicket.price);
      if (!Number.isFinite(price) || price < 0) {
        throw new Error(`Invalid price for ticket ID ${ticketId}`);
      }

      if (!Number.isInteger(eventTicket.quantity) || eventTicket.quantity < quantity) {
        throw new Error(`Not enough ${eventTicket.name} tickets available`);
      }

      const ticketAmount = price * quantity;
      subtotal += ticketAmount;

      // Update ticket quantity
      eventTicket.quantity -= quantity;

      // Find or create User for this attendee
      let user = await User.findOne({ email: customer.email });
      if (!user) {
        user = await User.create({
          firstName: customer.firstName,
          lastName: customer.lastName,
          email: customer.email,
          phone: customer.phone || '',
          location: customer.location || '',
        });
      }

      // Generate QR codes and create ticket records
      for (let i = 0; i < quantity; i++) {
        const ticketUUID = uuidv4();
        const qrCodeData = JSON.stringify({
          eventId: eventId,
          eventName: event.eventName,
          ticketId: ticketUUID,
          ticketName: eventTicket.name,
          ticketType: eventTicket.ticketType,
          price: price,
          buyerName: `${user.firstName} ${user.lastName}`,
          buyerEmail: user.email,
          startDateTime: event.startDateTime,
          venue: event.eventLocation.venue,
        });

        const qrCodeUrl = await new Promise((resolve, reject) => {
          QRCode.toBuffer(qrCodeData, { errorCorrectionLevel: 'H' }, (err, buffer) => {
            if (err) return reject(err);
            const uploadStream = cloudinary.uploader.upload_stream(
              {
                folder: 'genpay/tickets',
                public_id: `ticket_${ticketUUID}_${i}`,
                resource_type: 'image',
              },
              (error, result) => {
                if (error) return reject(error);
                resolve(result.secure_url);
              }
            );
            require('stream').Readable.from(buffer).pipe(uploadStream);
          });
        });

        const newTicket = await Ticket.create({
          event: eventId,
          name: eventTicket.name,
          type: eventTicket.ticketType,
          price: price,
          quantity: 1,
          buyer: user._id,
          ticketId: ticketUUID,
          qrCode: qrCodeUrl,
        });

        createdTickets.push(newTicket);

        // Group tickets by email for sending emails
        if (!emailTicketsMap[customer.email]) {
          emailTicketsMap[customer.email] = {
            customer: {
              firstName: customer.firstName,
              lastName: customer.lastName,
              email: customer.email,
            },
            tickets: [],
          };
        }
        emailTicketsMap[customer.email].tickets.push({
          type: newTicket.name.toUpperCase(),
          price: newTicket.price,
          qrCode: newTicket.qrCode,
          ticketId: newTicket.ticketId,
          buyerName: `${user.firstName} ${user.lastName}`,
          eventName: event.eventName,
          venue: event.eventLocation.venue,
          groupSize: eventTicket.groupSize || null,
        });
      }
    }

    // Save updated event
    await event.save({ validateBeforeSave: true });

    // Update host balance
    console.log('Updating host balance for host ID:', event.host, 'with amount:', subtotal);
    const hostUpdate = await Host.findByIdAndUpdate(
      event.host,
      { $inc: { availableBalance: subtotal } },
      { new: true, runValidators: true }
    );
    
    if (!hostUpdate) {
      console.error('Host not found for ID:', event.host);
    }

    // Create transaction record
    const totalAmount = subtotal + fees;
    const transaction = await Transaction.create({
      event: eventId,
      tickets: createdTickets.map((t) => t._id),
      reference,
      amount: subtotal,
      fees,
      total: totalAmount,
      paymentProvider: 'paystack',
      status: 'completed',
    });

    // Format response tickets
    const populatedTickets = await Ticket.find({ _id: { $in: createdTickets.map(t => t._id) } })
      .populate('buyer', 'firstName lastName email');

    const responseTickets = populatedTickets.map((ticket) => ({
      _id: ticket._id.toString(),
      type: ticket.name,
      price: ticket.price,
      qrCode: ticket.qrCode,
      ticketId: ticket.ticketId,
      buyerName: ticket.buyer ? `${ticket.buyer.firstName} ${ticket.buyer.lastName}` : 'Unknown',
      buyerEmail: ticket.buyer ? ticket.buyer.email : 'Unknown',
      eventName: event.eventName,
      venue: event.eventLocation.venue,
    }));

    // Send emails (simplified - you can keep your existing email logic)
    console.log(`Tickets created successfully. Sending confirmation emails...`);

    return {
      tickets: responseTickets,
      transaction: {
        _id: transaction._id.toString(),
        reference: transaction.reference,
        amount: transaction.amount,
        fees: transaction.fees,
        total: transaction.total,
        paymentProvider: transaction.paymentProvider,
        createdAt: transaction.createdAt,
      }
    };
  } catch (error) {
    console.error('Error processing payment:', error);
    throw error;
  }
}

// Webhook endpoint for Paystack to send charge.success events
exports.paystackWebhook = async (req, res) => {
  try {
    // Verify webhook signature
    const signature = req.headers['x-paystack-signature'];
    const secret = process.env.PAYSTACK_SECRET_KEY;
    
    const crypto = require('crypto');
    const hash = crypto
      .createHmac('sha512', secret)
      .update(JSON.stringify(req.body))
      .digest('hex');
    
    if (hash !== signature) {
      return res.status(401).json({ status: 'error', message: 'Invalid signature' });
    }

    const event = req.body;
    
    // Handle charge.success event
    if (event.event === 'charge.success') {
      const { reference, metadata, amount } = event.data;
      
      // Check if transaction already processed
      const existingTransaction = await Transaction.findOne({ reference });
      if (existingTransaction) {
        return res.status(200).json({ status: 'success', message: 'Transaction already processed' });
      }
      
      // Process the ticket purchase
      const eventId = metadata.eventId;
      const tickets = JSON.parse(metadata.tickets || '[]');
      const fees = parseFloat(metadata.fees || 0);
      
      await processSuccessfulPayment({
        eventId,
        tickets,
        reference,
        fees,
        amount: amount / 100
      });
      
      console.log(`Webhook processed successfully for reference: ${reference}`);
    }
    
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
};