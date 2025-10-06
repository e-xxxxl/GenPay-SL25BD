// controllers/eventController.js
const Event = require('../models/event');
const Host = require('../models/host');
const jwt = require('jsonwebtoken');
const cloudinary = require('../config/cloudinary');
const multer = require('multer');
const { Readable } = require('stream');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/user');
const Ticket = require('../models/ticket');
const Payout = require('../models/payout');
const Transaction = require('../models/transaction');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');

// Zoho Mail Transporter Configuration
const transporter = nodemailer.createTransport({
  host: 'smtp.zoho.com',
  port: 465, // SSL port
  secure: true,
  auth: {
    user: process.env.ZOHO_EMAIL,
    pass: process.env.ZOHO_APP_PASSWORD,
  }
});


// Create a new event
exports.createEvent = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        status: 'fail',
        message: 'No authentication token provided',
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({
        status: 'fail',
        message: 'Invalid or expired token',
      });
    }

    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(404).json({
        status: 'fail',
        message: 'Host not found',
      });
    }

    if (!host.isVerified) {
      return res.status(403).json({
        status: 'fail',
        message: 'Please verify your email before creating events',
      });
    }

    const {
      eventName,
      eventDescription,
      eventLocation,
      eventLocationTips,
      eventUrl,
      eventCategory,
      startDateTime,
      endDateTime,
      socialLinks,
      headerImage,
      images,
    } = req.body;

    const requiredFields = {
      eventName: 'Event name',
      eventDescription: 'Event description',
      eventLocation: 'Event location',
      eventCategory: 'Event category',
      startDateTime: 'Start date and time',
      endDateTime: 'End date and time',
    };

    const missingFields = Object.keys(requiredFields).filter(
      (field) => !req.body[field]
    );
    if (missingFields.length > 0) {
      return res.status(400).json({
        status: 'fail',
        message: `Please provide: ${missingFields
          .map((f) => requiredFields[f])
          .join(', ')}`,
        fields: missingFields,
      });
    }

    if (headerImage) {
      try {
        new URL(headerImage);
      } catch {
        return res.status(400).json({
          status: 'fail',
          message: 'Invalid header image URL',
          field: 'headerImage',
        });
      }
    }

    if (images && Array.isArray(images)) {
      for (const url of images) {
        try {
          new URL(url);
        } catch {
          return res.status(400).json({
            status: 'fail',
            message: `Invalid gallery image URL: ${url}`,
            field: 'images',
          });
        }
      }
    }

    const urlFields = [
      'eventUrl',
      'instagram',
      'twitter',
      'snapchat',
      'tiktok',
      'website',
    ];
    for (const field of urlFields) {
      const url = field === 'eventUrl' ? eventUrl : socialLinks?.[field];
      if (url && url.trim()) {
        try {
          new URL(url);
        } catch {
          return res.status(400).json({
            status: 'fail',
            message: `Invalid URL for ${field}`,
            field,
          });
        }
      }
    }

    const start = new Date(startDateTime);
    const end = new Date(endDateTime);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        status: 'fail',
        message: 'Invalid date format',
        fields: ['startDateTime', 'endDateTime'],
      });
    }

    const eventData = {
      host: host._id,
      eventName: eventName.trim(),
      eventDescription: eventDescription.trim(),
      eventCategory,
      startDateTime: start,
      endDateTime: end,
      eventLocation: {
        venue: eventLocation.trim(),
        locationTips: eventLocationTips?.trim() || undefined,
      },
      eventUrl: eventUrl?.trim() || undefined,
      socialLinks: {
        instagram: socialLinks?.instagram?.trim() || undefined,
        twitter: socialLinks?.twitter?.trim() || undefined,
        snapchat: socialLinks?.snapchat?.trim() || undefined,
        tiktok: socialLinks?.tiktok?.trim() || undefined,
        website: socialLinks?.website?.trim() || undefined,
      },
      headerImage: headerImage?.trim() || undefined,
      images: images || [],
      tickets: [], // Initialize tickets array
    };

    const newEvent = await Event.create(eventData);

    host.events = host.events || [];
    host.events.push(newEvent._id);
    await host.save({ validateBeforeSave: false });

    res.status(201).json({
      status: 'success',
      data: {
        event: newEvent,
      },
      message: 'Event created successfully',
    });
  } catch (err) {
    console.error('Create event error:', err);
    if (err.name === 'ValidationError') {
      const errors = Object.values(err.errors).map((el) => ({
        field: el.path,
        message: el.message,
      }));
      return res.status(400).json({
        status: 'fail',
        message: 'Validation failed',
        errors,
      });
    }
    res.status(500).json({
      status: 'error',
      message: 'An unexpected error occurred. Please try again later.',
      error: err.message,
    });
  }
};

// Set up Multer for file handling
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'), false);
    }
    cb(null, true);
  },
}).single('eventImage'); // Match the field name from frontend FormData

// Get all events for the authenticated host
exports.getEvents = async (req, res) => {
  try {
    // 1) Verify authentication
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        status: 'fail',
        message: 'No authentication token provided',
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({
        status: 'fail',
        message: 'Invalid or expired token',
      });
    }

    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(404).json({
        status: 'fail',
        message: 'Host not found',
      });
    }

    // 2) Fetch events with pagination
    const page = parseInt(req.query.page) || 1;
    const limit = 30; // Number of events per page
    const skip = (page - 1) * limit;

    const events = await Event.find({ host: host._id })
      .populate('host', 'displayName userType firstName lastName organizationName')
      .select(
        'eventName eventDescription eventCategory startDateTime endDateTime eventLocation eventUrl socialLinks headerImage images capacity tickets isPublished createdAt ticketPolicy'
      )
      .skip(skip)
      .limit(limit);

    // 3) Validate and map events
    const formattedEvents = await Promise.all(
      events.map(async (event) => {
        if (!event.eventName) {
          console.warn(`Event ${event._id} is missing eventName, using fallback`);
        }
        return {
          id: event._id.toString(),
          title: event.eventName || `Unnamed Event ${event._id.toString().slice(-6)}`,
          description: event.eventDescription || 'No description',
          category: event.eventCategory,
          date: event.startDateTime,
          endDate: event.endDateTime,
          location: event.eventLocation?.venue || 'Unknown Location',
          locationTips: event.eventLocation?.locationTips || null,
          url: event.eventUrl || null,
          image: event.headerImage || null,
          poster: event.headerImage || null,
          attendees: await Ticket.countDocuments({ event: event._id }), // Await the ticket count
          socialLinks: {
            instagram: event.socialLinks?.instagram || null,
            twitter: event.socialLinks?.twitter || null,
            snapchat: event.socialLinks?.snapchat || null,
            tiktok: event.socialLinks?.tiktok || null,
            website: event.socialLinks?.website || null,
          },
          host: {
            id: event.host._id.toString(),
            displayName: event.host.displayName,
            userType: event.host.userType,
            firstName: event.host.firstName || null,
            lastName: event.host.lastName || null,
            organizationName: event.host.organizationName || null,
          },
          isPublished: event.isPublished,
          createdAt: event.createdAt,
          ticketPolicy: {
            refundPolicy: event.ticketPolicy?.refundPolicy || null,
            transferPolicy: event.ticketPolicy?.transferPolicy || null,
            otherRules: event.ticketPolicy?.otherRules || null,
          },
          tickets: event.tickets || [], // Include tickets array
        };
      })
    );

    const totalEvents = await Event.countDocuments({ host: host._id });
    const totalPages = Math.ceil(totalEvents / limit);

    res.status(200).json({
      status: 'success',
      data: {
        events: formattedEvents,
        totalPages,
        currentPage: page,
      },
    });
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch events',
      error: error.message,
    });
  }
};

// Set ticket policy
exports.setTicketPolicy = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        status: 'fail',
        message: 'No authentication token provided',
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({
        status: 'fail',
        message: 'Invalid or expired token',
      });
    }

    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(404).json({
        status: 'fail',
        message: 'Host not found',
      });
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        status: 'fail',
        message: 'Invalid event ID',
      });
    }

    const event = await Event.findById(id).select('host ticketPolicy').populate('host', '_id');
    if (!event) {
      return res.status(404).json({
        status: 'fail',
        message: 'Event not found',
      });
    }

    if (!event.host || !event.host._id) {
      return res.status(400).json({
        status: 'fail',
        message: 'Event host data is missing or invalid',
      });
    }

    if (event.host._id.toString() !== host._id.toString()) {
      return res.status(403).json({
        status: 'fail',
        message: 'You are not authorized to set the ticket policy for this event',
      });
    }

    const { refundPolicy, transferPolicy, otherRules } = req.body;
    if (!refundPolicy && !transferPolicy && !otherRules) {
      return res.status(400).json({
        status: 'fail',
        message: 'At least one ticket policy field (refundPolicy, transferPolicy, otherRules) is required',
      });
    }

    const ticketPolicy = {
      refundPolicy: refundPolicy?.trim() || null,
      transferPolicy: transferPolicy?.trim() || null,
      otherRules: otherRules?.trim() || null,
    };

    const updatedEvent = await Event.findByIdAndUpdate(
      id,
      { ticketPolicy, isPublished: true },
      { new: true, runValidators: true }
    );

    res.status(200).json({
      status: 'success',
      data: {
        event: {
          id: updatedEvent._id.toString(),
          title: updatedEvent.eventName,
          ticketPolicy: updatedEvent.ticketPolicy,
          isPublished: updatedEvent.isPublished,
        },
      },
      message: 'Ticket policy set successfully',
    });
  } catch (error) {
    console.error('Error setting ticket policy:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to set ticket policy',
      error: error.message,
    });
  }
};

// Upload event image
exports.uploadEventImage = async (req, res) => {
  upload(req, res, async (err) => {
    try {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            status: 'fail',
            message: 'Image size should be less than 10MB',
          });
        }
        return res.status(400).json({
          status: 'fail',
          message: err.message,
        });
      } else if (err) {
        return res.status(400).json({
          status: 'fail',
          message: err.message,
        });
      }

      const token = req.headers.authorization?.split(' ')[1];
      if (!token) {
        return res.status(401).json({
          status: 'fail',
          message: 'No authentication token provided',
        });
      }

      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
      } catch (error) {
        return res.status(401).json({
          status: 'fail',
          message: 'Invalid or expired token',
        });
      }

      const host = await Host.findById(decoded.id);
      if (!host) {
        return res.status(404).json({
          status: 'fail',
          message: 'Host not found',
        });
      }

      if (!host.isVerified) {
        return res.status(403).json({
          status: 'fail',
          message: 'Please verify your email before uploading images',
        });
      }

      if (!req.file) {
        return res.status(400).json({
          status: 'fail',
          message: 'No image file provided',
        });
      }

      const { imageType, eventId } = req.body;
      if (!imageType || imageType !== 'header') {
        return res.status(400).json({
          status: 'fail',
          message: 'Invalid or missing imageType. Must be "header".',
        });
      }
      if (!eventId) {
        return res.status(400).json({
          status: 'fail',
          message: 'Event ID is required',
        });
      }

      const event = await Event.findById(eventId).select('host headerImage').populate('host', '_id');
      if (!event) {
        return res.status(404).json({
          status: 'fail',
          message: 'Event not found',
        });
      }

      if (!event.host || !event.host._id) {
        return res.status(400).json({
          status: 'fail',
          message: 'Event host data is missing or invalid',
        });
      }

      if (event.host._id.toString() !== host._id.toString()) {
        return res.status(403).json({
          status: 'fail',
          message: 'You are not authorized to upload images for this event',
        });
      }

      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'genpay/events',
          public_id: `header_${Date.now()}_${req.file.originalname}`,
          resource_type: 'image',
        },
        async (error, result) => {
          if (error) {
            console.error('Cloudinary upload error:', error);
            return res.status(500).json({
              status: 'error',
              message: 'Failed to upload image to storage',
            });
          }

          try {
            await Event.findByIdAndUpdate(
              eventId,
              { headerImage: result.secure_url },
              { new: true, runValidators: true }
            );

            res.status(200).json({
              status: 'success',
              data: {
                imageUrl: result.secure_url,
                uploadId: result.public_id,
                eventId,
              },
              message: 'Header image uploaded and saved successfully',
            });
          } catch (updateError) {
            console.error('Event update error:', updateError);
            return res.status(500).json({
              status: 'error',
              message: 'Failed to save image URL to database',
            });
          }
        }
      );

      const stream = Readable.from(req.file.buffer);
      stream.pipe(uploadStream);
    } catch (error) {
      console.error('Upload image error:', error);
      res.status(500).json({
        status: 'error',
        message: 'An unexpected error occurred. Please try again later.',
        error: error.message,
      });
    }
  });
};

// Upload gallery image
exports.uploadGalleryImage = async (req, res) => {
  upload(req, res, async (err) => {
    try {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            status: 'fail',
            message: 'Image size should be less than 10MB',
          });
        }
        return res.status(400).json({
          status: 'fail',
          message: err.message,
        });
      } else if (err) {
        return res.status(400).json({
          status: 'fail',
          message: err.message,
        });
      }

      const token = req.headers.authorization?.split(' ')[1];
      if (!token) {
        return res.status(401).json({
          status: 'fail',
          message: 'No authentication token provided',
        });
      }

      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
      } catch (error) {
        return res.status(401).json({
          status: 'fail',
          message: 'Invalid or expired token',
        });
      }

      const host = await Host.findById(decoded.id);
      if (!host) {
        return res.status(404).json({
          status: 'fail',
          message: 'Host not found',
        });
      }

      if (!host.isVerified) {
        return res.status(403).json({
          status: 'fail',
          message: 'Please verify your email before uploading images',
        });
      }

      if (!req.file) {
        return res.status(400).json({
          status: 'fail',
          message: 'No image file provided',
        });
      }

      const { imageType, eventId } = req.body;
      if (!imageType || imageType !== 'gallery') {
        return res.status(400).json({
          status: 'fail',
          message: 'Invalid or missing imageType. Must be "gallery".',
        });
      }
      if (!eventId) {
        return res.status(400).json({
          status: 'fail',
          message: 'Event ID is required',
        });
      }

      const event = await Event.findById(eventId).select('host images').populate('host', '_id');
      if (!event) {
        return res.status(404).json({
          status: 'fail',
          message: 'Event not found',
        });
      }

      if (!event.host || !event.host._id) {
        return res.status(400).json({
          status: 'fail',
          message: 'Event host data is missing or invalid',
        });
      }

      if (event.host._id.toString() !== host._id.toString()) {
        return res.status(403).json({
          status: 'fail',
          message: 'You are not authorized to upload images for this event',
        });
      }

      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'genpay/events/gallery',
          public_id: `gallery_${Date.now()}_${req.file.originalname}`,
          resource_type: 'image',
          transformation: [{ width: 1080, height: 1080, crop: 'fill' }],
        },
        async (error, result) => {
          if (error) {
            console.error('Cloudinary upload error:', error);
            return res.status(500).json({
              status: 'error',
              message: `Failed to upload ${req.file.originalname} to storage`,
            });
          }

          try {
            await Event.findByIdAndUpdate(
              eventId,
              { $push: { images: result.secure_url } },
              { new: true, runValidators: true }
            );

            res.status(200).json({
              status: 'success',
              data: {
                imageUrl: result.secure_url,
                uploadId: result.public_id,
                eventId,
              },
              message: `${req.file.originalname} uploaded successfully`,
            });
          } catch (updateError) {
            console.error('Event update error:', updateError);
            return res.status(500).json({
              status: 'error',
              message: 'Failed to save gallery image URL to database',
            });
          }
        }
      );

      const stream = Readable.from(req.file.buffer);
      stream.pipe(uploadStream);
    } catch (error) {
      console.error('Upload gallery image error:', error);
      res.status(500).json({
        status: 'error',
        message: 'An unexpected error occurred. Please try again later.',
        error: error.message,
      });
    }
  });
};

// Get event by ID
exports.getEventById = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    console.log("Received token:", token);
    if (!token) {
      return res.status(401).json({ status: 'fail', message: 'No authentication token provided' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
      console.log("Decoded token:", decoded);
    } catch (err) {
      return res.status(401).json({ status: 'fail', message: 'Invalid or expired token' });
    }

    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(404).json({ status: 'fail', message: 'Host not found' });
    }

    const event = await Event.findById(req.params.id).populate('host', 'displayName userType firstName lastName organizationName _id');
    console.log("Requested event ID:", req.params.id);
    if (!event) {
      return res.status(404).json({ status: 'fail', message: 'Event not found' });
    }

    if (!event.host || !event.host._id) {
      return res.status(400).json({
        status: 'fail',
        message: 'Event host data is missing or invalid',
      });
    }

    console.log("Event host object:", event.host, "Event host ID:", event.host._id.toString());
    console.log("Requesting host object:", host, "Requesting host ID:", host._id.toString());
    if (event.host._id.toString() !== host._id.toString()) {
      return res.status(403).json({ status: 'fail', message: 'You are not authorized to view this event' });
    }

    res.status(200).json({
      status: 'success',
      data: { event },
    });
  } catch (error) {
    console.error('Error fetching event:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch event',
      error: error.message,
    });
  }
};

// Update event
exports.updateEvent = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ status: 'fail', message: 'No authentication token provided' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ status: 'fail', message: 'Invalid or expired token' });
    }

    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(404).json({ status: 'fail', message: 'Host not found' });
    }

    const event = await Event.findById(req.params.id).select('host').populate('host', '_id');
    if (!event) {
      return res.status(404).json({ status: 'fail', message: 'Event not found' });
    }

    if (!event.host || !event.host._id) {
      return res.status(400).json({
        status: 'fail',
        message: 'Event host data is missing or invalid',
      });
    }

    if (event.host._id.toString() !== host._id.toString()) {
      return res.status(403).json({ status: 'fail', message: 'You are not authorized to update this event' });
    }

    const {
      eventName,
      eventDescription,
      eventLocation,
      eventUrl,
      eventCategory,
      startDateTime,
      endDateTime,
      socialLinks,
      ticketTiers,
    } = req.body;

    if (!eventLocation || typeof eventLocation !== 'object' || !eventLocation.venue) {
      return res.status(400).json({
        status: 'fail',
        message: 'Event location must be an object with a valid venue',
      });
    }

    const updatedEvent = await Event.findByIdAndUpdate(
      req.params.id,
      {
        eventName: eventName?.trim(),
        eventDescription: eventDescription?.trim(),
        eventCategory,
        startDateTime: startDateTime ? new Date(startDateTime) : event.startDateTime,
        endDateTime: endDateTime ? new Date(endDateTime) : event.endDateTime,
        eventLocation: {
          venue: eventLocation.venue?.trim(),
          locationTips: eventLocation.locationTips?.trim() || null,
        },
        eventUrl: eventUrl?.trim() || null,
        socialLinks: {
          instagram: socialLinks?.instagram?.trim() || null,
          twitter: socialLinks?.twitter?.trim() || null,
          snapchat: socialLinks?.snapchat?.trim() || null,
          tiktok: socialLinks?.tiktok?.trim() || null,
          website: socialLinks?.website?.trim() || null,
        },
        tickets: ticketTiers || event.tickets || [],
      },
      { new: true, runValidators: true }
    );

    res.status(200).json({
      status: 'success',
      data: { event: updatedEvent },
      message: 'Event updated successfully',
    });
  } catch (error) {
    console.error('Error updating event:', error);
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map((el) => ({
        field: el.path,
        message: el.message,
      }));
      return res.status(400).json({ status: 'fail', message: 'Validation failed', errors });
    }
    if (error.name === 'CastError') {
      return res.status(400).json({
        status: 'fail',
        message: `Invalid data for ${error.path}: ${error.value}`,
      });
    }
    res.status(500).json({
      status: 'error',
      message: 'Failed to update event',
      error: error.message,
    });
  }
};

// Add ticket
exports.addTicket = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ status: 'fail', message: 'No authentication token provided' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ status: 'fail', message: 'Invalid or expired token' });
    }

    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(404).json({ status: 'fail', message: 'Host not found' });
    }

    const event = await Event.findById(req.params.id).select('tickets host').populate('host', '_id');
    if (!event) {
      return res.status(404).json({ status: 'fail', message: 'Event not found' });
    }

    if (!event.host || !event.host._id) {
      return res.status(400).json({
        status: 'fail',
        message: 'Event host data is missing or invalid',
      });
    }

    if (event.host._id.toString() !== host._id.toString()) {
      return res.status(403).json({ status: 'fail', message: 'You are not authorized to add tickets to this event' });
    }

    const ticketData = req.body;
    const requiredFields = ['name', 'ticketType', 'quantity'];
    const missingFields = requiredFields.filter(field => !ticketData[field]);
    if (missingFields.length > 0) {
      return res.status(400).json({
        status: 'fail',
        message: `Missing required fields: ${missingFields.join(', ')}`,
      });
    }

    if (!['Individual', 'Group'].includes(ticketData.ticketType)) {
      return res.status(400).json({
        status: 'fail',
        message: 'Ticket type must be either "Individual" or "Group"',
      });
    }

    if (ticketData.ticketType === 'Individual') {
      if (!Number.isFinite(ticketData.perTicketPrice) || ticketData.perTicketPrice < 0) {
        return res.status(400).json({
          status: 'fail',
          message: 'Per ticket price is required for individual tickets and must be non-negative',
        });
      }
      if (!['USD', 'NGN', 'GBP', 'EUR'].includes(ticketData.perTicketCurrency)) {
        return res.status(400).json({
          status: 'fail',
          message: 'Invalid per ticket currency. Must be USD, NGN, GBP, or EUR',
        });
      }
    } else if (ticketData.ticketType === 'Group') {
      if (!Number.isFinite(ticketData.groupPrice) || ticketData.groupPrice < 0) {
        return res.status(400).json({
          status: 'fail',
          message: 'Group price is required for group tickets and must be non-negative',
        });
      }
      if (!['USD', 'NGN', 'GBP', 'EUR'].includes(ticketData.groupPriceCurrency)) {
        return res.status(400).json({
          status: 'fail',
          message: 'Invalid group price currency. Must be USD, NGN, GBP, or EUR',
        });
      }
      if (!ticketData.groupSize || (ticketData.groupSize !== 'Unlimited Quantity' && !Number.isFinite(Number(ticketData.groupSize)))) {
        return res.status(400).json({
          status: 'fail',
          message: 'Group size must be "Unlimited Quantity" or a valid number',
        });
      }
    }

    if (!Number.isFinite(ticketData.quantity) || ticketData.quantity < 0) {
      return res.status(400).json({
        status: 'fail',
        message: 'Quantity must be a non-negative number',
      });
    }

    ticketData.id = ticketData.id || uuidv4();

    const newTicket = {
      id: ticketData.id,
      name: ticketData.name.trim(),
      ticketType: ticketData.ticketType,
      quantity: ticketData.quantity,
      price: ticketData.ticketType === 'Individual' ? ticketData.perTicketPrice : ticketData.groupPrice,
      perTicketPrice: ticketData.ticketType === 'Individual' ? ticketData.perTicketPrice : null,
      perTicketCurrency: ticketData.ticketType === 'Individual' ? ticketData.perTicketCurrency : null,
      groupPrice: ticketData.ticketType === 'Group' ? ticketData.groupPrice : null,
      groupPriceCurrency: ticketData.ticketType === 'Group' ? ticketData.groupPriceCurrency : null,
      groupSize: ticketData.groupSize || 'Unlimited Quantity',
      ticketDescription: ticketData.ticketDescription?.trim() || null,
      perks: ticketData.perks || [],
      transferFees: ticketData.transferFees || false,
      purchaseLimit: ticketData.purchaseLimit || null,
    };

    event.tickets = event.tickets || [];
    event.tickets.push(newTicket);
    await event.save({ validateBeforeSave: true });

    res.status(201).json({
      status: 'success',
      data: { ticket: newTicket },
      message: 'Ticket added successfully',
    });
  } catch (error) {
    console.error('Error adding ticket:', error);
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map((el) => ({
        field: el.path,
        message: el.message,
      }));
      return res.status(400).json({ status: 'fail', message: 'Validation failed', errors });
    }
    res.status(500).json({
      status: 'error',
      message: 'Failed to add ticket',
      error: error.message,
    });
  }
};

// Edit ticket
exports.editTicket = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ status: 'fail', message: 'No authentication token provided' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ status: 'fail', message: 'Invalid or expired token' });
    }

    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(404).json({ status: 'fail', message: 'Host not found' });
    }

    const event = await Event.findById(req.params.id).select('tickets host').populate('host', '_id');
    if (!event) {
      return res.status(404).json({ status: 'fail', message: 'Event not found' });
    }

    if (!event.host || !event.host._id) {
      return res.status(400).json({
        status: 'fail',
        message: 'Event host data is missing or invalid',
      });
    }

    if (event.host._id.toString() !== host._id.toString()) {
      return res.status(403).json({ status: 'fail', message: 'You are not authorized to edit tickets for this event' });
    }

    const ticketId = req.params.ticketId;
    const ticketData = req.body;
    const requiredFields = ['name', 'ticketType', 'quantity'];
    const missingFields = requiredFields.filter(field => !ticketData[field]);
    if (missingFields.length > 0) {
      return res.status(400).json({
        status: 'fail',
        message: `Missing required fields: ${missingFields.join(', ')}`,
      });
    }

    if (!['Individual', 'Group'].includes(ticketData.ticketType)) {
      return res.status(400).json({
        status: 'fail',
        message: 'Ticket type must be either "Individual" or "Group"',
      });
    }

    if (ticketData.ticketType === 'Individual') {
      if (!Number.isFinite(ticketData.perTicketPrice) || ticketData.perTicketPrice < 0) {
        return res.status(400).json({
          status: 'fail',
          message: 'Per ticket price is required for individual tickets and must be non-negative',
        });
      }
      if (!['USD', 'NGN', 'GBP', 'EUR'].includes(ticketData.perTicketCurrency)) {
        return res.status(400).json({
          status: 'fail',
          message: 'Invalid per ticket currency. Must be USD, NGN, GBP, or EUR',
        });
      }
    } else if (ticketData.ticketType === 'Group') {
      if (!Number.isFinite(ticketData.groupPrice) || ticketData.groupPrice < 0) {
        return res.status(400).json({
          status: 'fail',
          message: 'Group price is required for group tickets and must be non-negative',
        });
      }
      if (!['USD', 'NGN', 'GBP', 'EUR'].includes(ticketData.groupPriceCurrency)) {
        return res.status(400).json({
          status: 'fail',
          message: 'Invalid group price currency. Must be USD, NGN, GBP, or EUR',
        });
      }
      if (!ticketData.groupSize || (ticketData.groupSize !== 'Unlimited Quantity' && !Number.isFinite(Number(ticketData.groupSize)))) {
        return res.status(400).json({
          status: 'fail',
          message: 'Group size must be "Unlimited Quantity" or a valid number',
        });
      }
    }

    if (!Number.isFinite(ticketData.quantity) || ticketData.quantity < 0) {
      return res.status(400).json({
        status: 'fail',
        message: 'Quantity must be a non-negative number',
      });
    }

    event.tickets = event.tickets || [];
    const ticketIndex = event.tickets.findIndex(ticket => ticket.id === ticketId);
    if (ticketIndex === -1) {
      return res.status(404).json({ status: 'fail', message: 'Ticket not found' });
    }

    event.tickets[ticketIndex] = {
      id: ticketId,
      name: ticketData.name.trim(),
      ticketType: ticketData.ticketType,
      quantity: ticketData.quantity,
      price: ticketData.ticketType === 'Individual' ? ticketData.perTicketPrice : ticketData.groupPrice,
      perTicketPrice: ticketData.ticketType === 'Individual' ? ticketData.perTicketPrice : null,
      perTicketCurrency: ticketData.ticketType === 'Individual' ? ticketData.perTicketCurrency : null,
      groupPrice: ticketData.ticketType === 'Group' ? ticketData.groupPrice : null,
      groupPriceCurrency: ticketData.ticketType === 'Group' ? ticketData.groupPriceCurrency : null,
      groupSize: ticketData.groupSize || 'Unlimited Quantity',
      ticketDescription: ticketData.ticketDescription?.trim() || null,
      perks: ticketData.perks || [],
      transferFees: ticketData.transferFees || false,
      purchaseLimit: ticketData.purchaseLimit || null,
    };

    await event.save({ validateBeforeSave: true });

    res.status(200).json({
      status: 'success',
      data: { ticket: event.tickets[ticketIndex] },
      message: 'Ticket updated successfully',
    });
  } catch (error) {
    console.error('Error editing ticket:', error);
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map((el) => ({
        field: el.path,
        message: el.message,
      }));
      return res.status(400).json({ status: 'fail', message: 'Validation failed', errors });
    }
    res.status(500).json({
      status: 'error',
      message: 'Failed to edit ticket',
      error: error.message,
    });
  }
};

// Delete ticket
exports.deleteTicket = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ status: 'fail', message: 'No authentication token provided' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ status: 'fail', message: 'Invalid or expired token' });
    }

    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(404).json({ status: 'fail', message: 'Host not found' });
    }

    const event = await Event.findById(req.params.id).select('tickets host').populate('host', '_id');
    if (!event) {
      return res.status(404).json({ status: 'fail', message: 'Event not found' });
    }

    if (!event.host || !event.host._id) {
      return res.status(400).json({
        status: 'fail',
        message: 'Event host data is missing or invalid',
      });
    }

    if (event.host._id.toString() !== host._id.toString()) {
      return res.status(403).json({ status: 'fail', message: 'You are not authorized to delete tickets for this event' });
    }

    event.tickets = event.tickets || [];
    const ticketIndex = event.tickets.findIndex(ticket => ticket.id === req.params.ticketId);
    if (ticketIndex === -1) {
      return res.status(404).json({ status: 'fail', message: 'Ticket not found' });
    }

    event.tickets.splice(ticketIndex, 1);
    await event.save({ validateBeforeSave: true });

    res.status(200).json({
      status: 'success',
      message: 'Ticket deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting ticket:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to delete ticket',
      error: error.message,
    });
  }
};

// Get event tickets
exports.getEventTickets = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ status: 'fail', message: 'No authentication token provided' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ status: 'fail', message: 'Invalid or expired token' });
    }

    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(404).json({ status: 'fail', message: 'Host not found' });
    }

    const event = await Event.findById(req.params.id).select('tickets host').populate('host', '_id');
    if (!event) {
      return res.status(404).json({ status: 'fail', message: 'Event not found' });
    }

    if (!event.host || !event.host._id) {
      return res.status(400).json({
        status: 'fail',
        message: 'Event host data is missing or invalid',
      });
    }

    if (event.host._id.toString() !== host._id.toString()) {
      return res.status(403).json({
        status: 'fail',
        message: 'You are not authorized to view tickets for this event',
      });
    }

    res.status(200).json({
      status: 'success',
      data: { tickets: event.tickets || [] },
    });
  } catch (error) {
    console.error('Error fetching tickets:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch tickets',
      error: error.message,
    });
  }
};

// Delete header image
exports.deleteHeaderImage = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ status: 'fail', message: 'No authentication token provided' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ status: 'fail', message: 'Invalid or expired token' });
    }

    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(404).json({ status: 'fail', message: 'Host not found' });
    }

    const { eventId, imageUrl } = req.body;
    if (!eventId || !imageUrl) {
      return res.status(400).json({ status: 'fail', message: 'Event ID and image URL are required' });
    }

    const event = await Event.findById(eventId).select('host headerImage').populate('host', '_id');
    if (!event) {
      return res.status(404).json({ status: 'fail', message: 'Event not found' });
    }

    if (!event.host || !event.host._id) {
      return res.status(400).json({
        status: 'fail',
        message: 'Event host data is missing or invalid',
      });
    }

    if (event.host._id.toString() !== host._id.toString()) {
      return res.status(403).json({ status: 'fail', message: 'You are not authorized to delete images for this event' });
    }

    if (event.headerImage !== imageUrl) {
      return res.status(400).json({ status: 'fail', message: 'Image URL does not match header image' });
    }

    const publicId = imageUrl.split('/').pop().split('.')[0];
    await cloudinary.uploader.destroy(`genpay/events/${publicId}`);

    await Event.findByIdAndUpdate(eventId, { headerImage: null }, { new: true });

    res.status(200).json({
      status: 'success',
      message: 'Header image deleted successfully',
    });
  } catch (error) {
    console.error('Delete header image error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to delete header image',
      error: error.message,
    });
  }
};

// Delete gallery image
exports.deleteGalleryImage = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ status: 'fail', message: 'No authentication token provided' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ status: 'fail', message: 'Invalid or expired token' });
    }

    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(404).json({ status: 'fail', message: 'Host not found' });
    }

    const { eventId, imageUrl } = req.body;
    if (!eventId || !imageUrl) {
      return res.status(400).json({ status: 'fail', message: 'Event ID and image URL are required' });
    }

    const event = await Event.findById(eventId).select('host images').populate('host', '_id');
    if (!event) {
      return res.status(404).json({ status: 'fail', message: 'Event not found' });
    }

    if (!event.host || !event.host._id) {
      return res.status(400).json({
        status: 'fail',
        message: 'Event host data is missing or invalid',
      });
    }

    if (event.host._id.toString() !== host._id.toString()) {
      return res.status(403).json({ status: 'fail', message: 'You are not authorized to delete images for this event' });
    }

    const publicId = imageUrl.split('/').pop().split('.')[0];
    await cloudinary.uploader.destroy(`genpay/events/gallery/${publicId}`);

    await Event.findByIdAndUpdate(eventId, { $pull: { images: imageUrl } }, { new: true });

    res.status(200).json({
      status: 'success',
      message: 'Gallery image deleted successfully',
    });
  } catch (error) {
    console.error('Delete gallery image error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to delete gallery image',
      error: error.message,
    });
  }
};

// Get public events
// Get public events
exports.getPublicEvents = async (req, res) => {
  try {
    // Get current date and time in WAT (UTC+1)
    const now = new Date();
    now.setHours(now.getHours() + 1); // Adjust to WAT (UTC+1)

    // Query for published events starting from now or later, sorted by startDateTime
    const events = await Event.find({
      isPublished: true,
      startDateTime: { $gte: now }, // Only include current or future events
    })
      .sort({ startDateTime: 1 }) // Sort by startDateTime in ascending order
      .select(
        'eventName eventDescription eventCategory startDateTime endDateTime eventLocation eventUrl socialLinks headerImage images tickets slug' // Added slug
      )
      .populate('host', 'displayName');

    const formattedEvents = events.map(event => ({
      _id: event._id.toString(),
      eventName: event.eventName || `Unnamed Event ${event._id.toString().slice(-6)}`,
      eventDescription: event.eventDescription || 'No description',
      eventCategory: event.eventCategory,
      startDateTime: event.startDateTime,
      endDateTime: event.endDateTime,
      eventLocation: {
        venue: event.eventLocation.venue || 'Unknown Location',
        locationTips: event.eventLocation.locationTips || null,
        address: event.eventLocation.address || {},
      },
      eventUrl: event.eventUrl || null,
      headerImage: event.headerImage || null,
      images: event.images || [],
      socialLinks: event.socialLinks || {},
      tickets: event.tickets || [],
      host: {
        displayName: event.host?.displayName || 'Unknown Host',
      },
      slug: event.slug || event.eventName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .trim(), // Fallback for legacy events
    }));

    res.status(200).json({
      status: 'success',
      data: {
        events: formattedEvents,
        totalEvents: formattedEvents.length,
      },
    });
  } catch (error) {
    console.error('Error fetching public events:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch public events',
      error: error.message,
    });
  }
};
// Get public event by sanitized eventName
// exports.getPublicEventByName = async (req, res) => {
//   try {
//     const { eventName } = req.params;

//     // Get current date and time in WAT (UTC+1)
//     const now = new Date();
//     now.setHours(now.getHours() + 1); // Adjust to WAT

//     // Find the event by eventName (case-insensitive) and ensure it's published and not expired
//     const event = await Event.findOne({
//       isPublished: true,
//       startDateTime: { $gte: now },
//       eventName: { $regex: `^${eventName.replace(/-/g, ' ')}$`, $options: 'i' }, // Reverse sanitization for matching
//     })
//       .select(
//         'eventName eventDescription eventCategory startDateTime endDateTime eventLocation eventUrl socialLinks headerImage images tickets'
//       )
//       .populate('host', 'displayName');

//     if (!event) {
//       return res.status(404).json({
//         status: 'error',
//         message: 'Event not found or not available',
//       });
//     }

//     const formattedEvent = {
//       _id: event._id.toString(),
//       eventName: event.eventName || `Unnamed Event ${event._id.toString().slice(-6)}`,
//       eventDescription: event.eventDescription || 'No description',
//       eventCategory: event.eventCategory,
//       startDateTime: event.startDateTime,
//       endDateTime: event.endDateTime,
//       eventLocation: {
//         venue: event.eventLocation?.venue || 'Unknown Location',
//         locationTips: event.eventLocation?.locationTips || null,
//         address: event.eventLocation?.address || {},
//       },
//       eventUrl: event.eventUrl || null,
//       headerImage: event.headerImage || null,
//       images: event.images || [],
//       socialLinks: event.socialLinks || {},
//       tickets: event.tickets || [],
//       host: {
//         displayName: event.host?.displayName || 'Unknown Host',
//       },
//     };

//     res.status(200).json({
//       status: 'success',
//       data: {
//         event: formattedEvent,
//       },
//     });
//   } catch (error) {
//     console.error('Error fetching event by name:', error);
//     res.status(500).json({
//       status: 'error',
//       message: 'Failed to fetch event',
//       error: error.message,
//     });
//   }
// };


// Purchase ticket
// Purchase ticket
exports.purchaseTicket = async (req, res) => {
  try {
    const { eventId, tickets, reference, fees } = req.body; // Add fees to request body

    // Validate input
    if (!eventId || !tickets || !Array.isArray(tickets) || tickets.length === 0 || typeof fees !== 'number') {
      return res.status(400).json({
        status: 'fail',
        message: 'Missing required fields: eventId, tickets array, or fees',
      });
    }

    console.log('Purchase ticket request body:', JSON.stringify(req.body, null, 2));

    // Find event
    const event = await Event.findById(eventId).select(
      'eventName startDateTime endDateTime eventLocation tickets host'
    );
    if (!event) {
      return res.status(404).json({
        status: 'fail',
        message: 'Event not found',
      });
    }

    if (!event.host) {
      return res.status(400).json({
        status: 'fail',
        message: 'Event has no associated host',
      });
    }

    // Validate tickets and calculate subtotal
    let subtotal = 0;
    const createdTickets = [];
    const emailTicketsMap = {};

    for (const ticketPurchase of tickets) {
      const { ticketId, customer, quantity = 1 } = ticketPurchase;
      if (!ticketId || !customer?.email || !customer.firstName || !customer.lastName) {
        console.error('Invalid ticket purchase:', { ticketId, customer });
        return res.status(400).json({
          status: 'fail',
          message: 'Invalid ticketId or missing customer data (email, firstName, lastName)',
        });
      }

      const eventTicket = event.tickets.find((t) => t.id === ticketId);
      if (!eventTicket) {
        return res.status(404).json({
          status: 'fail',
          message: `Ticket with ID ${ticketId} not found in event`,
        });
      }

      console.log('Event ticket:', JSON.stringify(eventTicket, null, 2));

      // Validate price and quantity
      const price = Number(eventTicket.price);
      if (!Number.isFinite(price) || price < 0) {
        console.error('Invalid price for ticket:', { ticketId, price: eventTicket.price });
        return res.status(400).json({
          status: 'fail',
          message: `Invalid price for ticket ID ${ticketId}`,
        });
      }

      if (!Number.isInteger(eventTicket.quantity) || eventTicket.quantity < quantity) {
        return res.status(400).json({
          status: 'fail',
          message: `Not enough ${eventTicket.name} tickets available`,
        });
      }

      // Calculate ticket amount
      const ticketAmount = price * quantity;
      console.log(`Calculating: ${price} * ${quantity} = ${ticketAmount}`);
      if (!Number.isFinite(ticketAmount)) {
        console.error('Invalid ticket amount:', { ticketId, price, quantity });
        return res.status(400).json({
          status: 'fail',
          message: `Invalid ticket amount for ticket ID ${ticketId}`,
        });
      }
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
        const ticketUUID = uuidv4(); // Generate unique ID for each ticketx
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
                public_id: `ticket_${ticketUUID}_${i}`, // Add index to avoid conflicts for multiple purchases
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
          ticketId: ticketUUID, // Use the original ticketId
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
          groupSize: eventTicket.groupSize || null, // Add groupSize to ticket data
        });
      }
    }

    console.log('Subtotal:', subtotal, 'Fees:', fees, 'Total:', subtotal + fees);

    // Validate total
    const totalAmount = subtotal + fees;
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      return res.status(400).json({
        status: 'fail',
        message: 'Invalid total amount calculated',
      });
    }

    // Save updated event
    await event.save({ validateBeforeSave: true });

    // Update host balance
    console.log('Updating host balance for host ID:', event.host, 'with amount:', subtotal);
    const hostUpdate = await Host.findByIdAndUpdate(
      event.host,
      { $inc: { availableBalance: subtotal } }, // Only ticket amount (excl. fees) goes to host
      { new: true, runValidators: true }
    );
    if (!hostUpdate) {
      console.error('Host not found for ID:', event.host);
      return res.status(404).json({
        status: 'fail',
        message: 'Host not found',
      });
    }
    console.log('Host updated:', JSON.stringify(hostUpdate, null, 2));

    // Create transaction record
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

    // Format date and time
    const startDateTime = new Date(event.startDateTime);
    const endDateTime = new Date(event.endDateTime);
    const formattedDate = startDateTime.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'Africa/Lagos',
    });
    const formattedStartTime = startDateTime.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
      timeZone: 'Africa/Lagos',
    });
    const formattedEndTime = endDateTime.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
      timeZone: 'Africa/Lagos',
    });

    // Send emails to each unique email address
    for (const [email, { customer, tickets }] of Object.entries(emailTicketsMap)) {
      const mailOptions = {
        from: `"Genpay Events" <${process.env.ZOHO_EMAIL}>`,
        to: email,
        subject: `Ticket Confirmation for ${event.eventName}`,
        html: `
          <h1>Ticket Confirmation</h1>
          <p>Dear ${customer.firstName} ${customer.lastName},</p>
          <p>Thank you for purchasing tickets for <strong>${event.eventName}</strong>!</p>
          <h2>Event Details</h2>
          <p><strong>Event:</strong> ${event.eventName}</p>
          <p><strong>Date:</strong> ${formattedDate}</p>
          <p><strong>Time:</strong> ${formattedStartTime} - ${formattedEndTime}</p>
          <p><strong>Venue:</strong> ${event.eventLocation.venue}</p>
          <h2>Ticket Details</h2>
          ${tickets
            .map(
              (t) => `
            <p>
              <strong>Ticket Type:</strong> ${t.type}<br>
              <strong>Ticket ID:</strong> ${t.ticketId}<br>
              <strong>Price:</strong> ₦${t.price.toLocaleString('en-NG')}<br>
              ${t.groupSize ? `<strong>Group Size:</strong> ${t.groupSize} people<br>` : ''} <!-- Show group size if it exists -->
              <strong>Buyer:</strong> ${t.buyerName}<br>
              <strong>Event:</strong> ${t.eventName}<br>
              <strong>Venue:</strong> ${t.venue}<br>
              <strong>Date:</strong> ${formattedDate}<br>
              <strong>Time:</strong> ${formattedStartTime} - ${formattedEndTime}<br>
              <img src="${t.qrCode}" alt="QR Code" style="width: 150px; height: 150px; margin-top: 10px;">
            </p>
          `
            )
            .join('')}
          <h2>Transaction Details</h2>
          <p><strong>Reference:</strong> ${reference || 'N/A'}</p>
          <p><strong>Subtotal:</strong> ₦${subtotal.toLocaleString('en-NG')}</p>
          <p><strong>Fees:</strong> ₦${fees.toLocaleString('en-NG')}</p>
          <p><strong>Total Amount:</strong> ₦${totalAmount.toLocaleString('en-NG')}</p>
          <p>Please present the QR code(s) at the event for entry. Save this email or download the QR codes.</p>
          <p>If you have any questions, contact us at <a href="mailto:${process.env.ZOHO_EMAIL}">${process.env.ZOHO_EMAIL}</a>.</p>
          <p>Enjoy the event!</p>
          <p>Best regards,<br>The Genpay Events Team</p>
        `,
        attachments: tickets.map((t, index) => ({
          filename: `ticket_${t.ticketId}.png`,
          path: t.qrCode,
          cid: `qrcode${index}`,
        })),
      };

      try {
        await transporter.sendMail(mailOptions);
      } catch (emailError) {
        console.error(`Failed to send confirmation email to ${email}:`, emailError);
      }
    }

    // Populate buyer details for response
    const populatedTickets = await Ticket.find({ _id: { $in: createdTickets.map(t => t._id) } })
      .populate('buyer', 'firstName lastName email');

    // Format response tickets
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
      date: formattedDate,
      time: `${formattedStartTime} - ${formattedEndTime}`,
    }));

    res.status(201).json({
      status: 'success',
      data: {
        tickets: responseTickets,
        transaction: {
          _id: transaction._id.toString(),
          reference: transaction.reference,
          amount: transaction.amount,
          fees: transaction.fees,
          total: transaction.total,
          paymentProvider: transaction.paymentProvider,
          createdAt: transaction.createdAt,
        },
      },
      message: 'Tickets purchased successfully and confirmation emails sent',
    });
  } catch (error) {
    console.error('Error purchasing ticket:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to purchase tickets or send confirmation emails',
      error: error.message,
    });
  }
};
// Search ticket
exports.searchTicket = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({ status: "fail", message: "No authentication token provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(404).json({ status: "fail", message: "Host not found" });
    }

    const { id } = req.params; // eventId
    const { search } = req.body;
    if (!search) {
      return res.status(400).json({ status: "fail", message: "Search query is required" });
    }

    console.log("Searching for:", search, "in event:", id);
    const event = await Event.findById(id).select("host tickets");
    if (!event) {
      return res.status(404).json({ status: "fail", message: "Event not found" });
    }

    if (event.host.toString() !== host._id.toString()) {
      return res.status(403).json({
        status: "fail",
        message: "You are not authorized to search tickets for this event",
      });
    }

    const tickets = await Ticket.find({
      event: id,
      $or: [
        { ticketId: search },
        ...(mongoose.Types.ObjectId.isValid(search) ? [{ _id: search }] : []),
      ],
    })
      .populate('buyer', 'email firstName lastName')
      .populate('event', 'eventName')
      .limit(10);

    // Additional search by buyer email
    if (!tickets.length) {
      const users = await User.find({ email: { $regex: search, $options: 'i' } }).select('_id');
      if (users.length) {
        const userIds = users.map(user => user._id);
        const ticketsByEmail = await Ticket.find({
          event: id,
          buyer: { $in: userIds },
        })
          .populate('buyer', 'email firstName lastName')
          .populate('event', 'eventName')
          .limit(10);
        tickets.push(...ticketsByEmail);
      }
    }

    if (!tickets.length) {
      return res.status(404).json({ status: "fail", message: "No tickets found for the provided email or ticket ID" });
    }

    // Fetch groupSize from the original event ticket definition
    const formattedTickets = tickets.map((ticket) => {
      const originalTicket = event.tickets.find(t => t.id === ticket.ticketId);
      const groupSize = originalTicket && originalTicket.ticketType === 'Group' ? originalTicket.groupSize : null;
      return {
        id: ticket.ticketId || ticket._id.toString(),
        event: {
          id: ticket.event._id.toString(),
          eventName: ticket.event.eventName,
        },
        buyer: {
          email: ticket.buyer.email,
          firstName: ticket.buyer.firstName,
          lastName: ticket.buyer.lastName,
        },
        type: ticket.type,
        usedAt: ticket.usedAt,
        status: ticket.isUsed ? "used" : "valid",
        groupSize: groupSize, // Include groupSize only for Group tickets
      };
    });

    res.status(200).json({
      status: "success",
      data: { tickets: formattedTickets },
      message: "Tickets found",
    });
  } catch (error) {
    console.error("Error searching ticket:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to search ticket",
      error: error.message,
    });
  }
};
// Check-in ticket
// controllers/eventController.js
exports.checkInTicket = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({ status: "fail", message: "No authentication token provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(404).json({ status: "fail", message: "Host not found" });
    }

    const { id } = req.params; // eventId
    const { ticketId } = req.body;
    if (!ticketId) {
      return res.status(400).json({ status: "fail", message: "Ticket ID is required" });
    }

    console.log("Checking in ticket:", ticketId, "for event:", id);

    const event = await Event.findById(id).select("host");
    if (!event) {
      return res.status(404).json({ status: "fail", message: "Event not found" });
    }

    if (event.host.toString() !== host._id.toString()) {
      return res.status(403).json({
        status: "fail",
        message: "You are not authorized to check in tickets for this event",
      });
    }

    const query = {
      event: id,
      $or: [
        { ticketId: ticketId },
        ...(mongoose.Types.ObjectId.isValid(ticketId) ? [{ _id: ticketId }] : []),
      ],
    };

    const ticket = await Ticket.findOne(query).populate('buyer', 'email firstName lastName');
    if (!ticket) {
      return res.status(404).json({ status: "fail", message: "Ticket not found" });
    }

    if (ticket.isUsed) {
      return res.status(400).json({ status: "fail", message: "Ticket already used" });
    }

    if (!ticket.ticketId) {
      ticket.ticketId = uuidv4();
    }

    ticket.isUsed = true;
    ticket.usedAt = new Date();
    await ticket.save();

    console.log("Ticket checked in:", {
      ticketId: ticket.ticketId || ticket._id.toString(),
      buyer: ticket.buyer.email,
      eventId: ticket.event.toString(),
    });

    res.status(200).json({
      status: "success",
      data: {
        ticket: {
          id: ticket.ticketId || ticket._id.toString(),
          buyer: {
            email: ticket.buyer.email,
            firstName: ticket.buyer.firstName,
            lastName: ticket.buyer.lastName,
          },
          status: "used",
          usedAt: ticket.usedAt,
        },
      },
      message: "Ticket checked in successfully",
    });
  } catch (error) {
    console.error("Error checking in ticket:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to check in ticket",
      error: error.message,
    });
  }
};
// Get check-ins
exports.getCheckins = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ status: 'fail', message: 'No authentication token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(404).json({ status: 'fail', message: 'Host not found' });
    }

    const event = await Event.findById(req.params.id).select('host');
    if (!event) {
      return res.status(404).json({ status: 'fail', message: 'Event not found' });
    }

    if (event.host.toString() !== host._id.toString()) {
      return res.status(403).json({
        status: 'fail',
        message: 'You are not authorized to view check-ins for this event',
      });
    }

    const checkins = await Ticket.find({
      event: req.params.id,
      isUsed: true
    })
      .populate('buyer', 'email firstName lastName')
      .select('usedAt price type');

    const formattedCheckins = checkins.map(ticket => ({
      guestEmail: ticket.buyer.email,
      dateTime: ticket.usedAt,
      count: 1, // Individual ticket
      amount: ticket.price,
      status: 'Used'
    }));

    res.status(200).json({
      status: 'success',
      data: { checkins: formattedCheckins },
    });
  } catch (error) {
    console.error('Error fetching check-ins:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch check-ins',
      error: error.message,
    });
  }
};

// Get ticket buyers
exports.getTicketBuyers = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ status: 'fail', message: 'No authentication token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(404).json({ status: 'fail', message: 'Host not found' });
    }

    const event = await Event.findById(req.params.id).select('host');
    if (!event) {
      return res.status(404).json({ status: 'fail', message: 'Event not found' });
    }

    if (event.host.toString() !== host._id.toString()) {
      return res.status(403).json({
        status: 'fail',
        message: 'You are not authorized to view ticket buyers for this event',
      });
    }

    const tickets = await Ticket.find({ event: req.params.id })
      .populate('buyer', 'firstName lastName email phone location')
      .select('isUsed type price');

    const guests = tickets.map(ticket => ({
      name: `${ticket.buyer.firstName} ${ticket.buyer.lastName}`,
      email: ticket.buyer.email,
      phone: ticket.buyer.phone || '—',
      location: ticket.buyer.location || '—',
      checkedIn: ticket.isUsed,
    }));

    res.status(200).json({
      status: 'success',
      data: { guests },
    });
  } catch (error) {
    console.error('Error fetching ticket buyers:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch ticket buyers',
      error: error.message,
    });
  }
};

// Get payouts
exports.getPayouts = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ status: 'fail', message: 'No authentication token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(404).json({ status: 'fail', message: 'Host not found' });
    }

    const { id } = req.params;
    const event = await Event.findById(id).select('host');
    if (!event) {
      return res.status(404).json({ status: 'fail', message: 'Event not found' });
    }

    if (event.host.toString() !== host._id.toString()) {
      return res.status(403).json({
        status: 'fail',
        message: 'You are not authorized to view payouts for this event',
      });
    }

    const payouts = await Payout.find({ event: id });
    console.log("Payouts fetched:", payouts);

    res.status(200).json({
      status: 'success',
      data: { payouts },
      message: 'Payouts retrieved successfully',
    });
  } catch (error) {
    console.error('Error fetching payouts:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch payouts',
      error: error.message,
    });
  }
};
exports.deleteEvent = async (req, res) => {
  try {
    // 1) Verify authentication
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        status: 'fail',
        message: 'No authentication token provided',
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({
        status: 'fail',
        message: 'Invalid or expired token',
      });
    }

    const host = await Host.findById(decoded.id);
    if (!host) {
      return res.status(404).json({
        status: 'fail',
        message: 'Host not found',
      });
    }

    // 2) Validate event ID
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        status: 'fail',
        message: 'Invalid event ID',
      });
    }

    // 3) Find the event and verify ownership
    const event = await Event.findById(id).select('host');
    if (!event) {
      return res.status(404).json({
        status: 'fail',
        message: 'Event not found',
      });
    }

    if (!event.host || event.host.toString() !== host._id.toString()) {
      return res.status(403).json({
        status: 'fail',
        message: 'You are not authorized to delete this event',
      });
    }

    // 4) Check for purchased tickets
    const ticketCount = await Ticket.countDocuments({ event: id });
    if (ticketCount > 0) {
      return res.status(403).json({
        status: 'fail',
        message: 'Cannot delete event: Tickets have already been purchased',
      });
    }

    // 5) Delete associated tickets (should be none due to the check above, but included for robustness)
    await Ticket.deleteMany({ event: id });

    // 6) Remove event from host's events array
    host.events = host.events.filter((eventId) => eventId.toString() !== id);
    await host.save({ validateBeforeSave: false });

    // 7) Delete the event
    await Event.findByIdAndDelete(id);

    res.status(200).json({
      status: 'success',
      message: 'Event deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting event:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to delete event',
      error: error.message,
    });
  }
};

exports.getEventByName = async (req, res) => {
  try {
    const { eventName } = req.params;

    // Get current date and time in WAT (UTC+1)
    const now = new Date();
    now.setHours(now.getHours() + 1); // Adjust to WAT

    // Find the event by slug (case-insensitive)
    const event = await Event.findOne({
      slug: { $regex: `^${eventName}$`, $options: 'i' },
      isPublished: true,
      startDateTime: { $gte: now },
    })
      .select(
        'eventName eventDescription eventCategory startDateTime endDateTime eventLocation eventUrl socialLinks headerImage images tickets slug attendeesCount'
      )
      .populate('host', 'displayName');

    if (!event) {
      return res.status(404).json({
        status: 'error',
        message: `Event with slug "${eventName}" not found or not available`,
      });
    }

    const formattedEvent = {
      _id: event._id.toString(),
      eventName: event.eventName || `Unnamed Event ${event._id.toString().slice(-6)}`,
      eventDescription: event.eventDescription || 'No description',
      eventCategory: event.eventCategory || 'Other',
      startDateTime: event.startDateTime,
      endDateTime: event.endDateTime,
      eventLocation: {
        venue: event.eventLocation?.venue || 'Unknown Location',
        locationTips: event.eventLocation?.locationTips || null,
        address: event.eventLocation?.address || {},
      },
      eventUrl: event.eventUrl || null,
      headerImage: event.headerImage || null,
      images: Array.isArray(event.images) ? event.images : [],
      socialLinks: event.socialLinks || {},
      tickets: Array.isArray(event.tickets) ? event.tickets : [],
      slug: event.slug,
      attendeesCount: event.attendeesCount || 0,
      host: {
        displayName: event.host?.displayName || 'Unknown Host',
      },
    };

    res.status(200).json({
      status: 'success',
      data: { event: formattedEvent },
    });
  } catch (error) {
    console.error('Error fetching event by slug:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch event',
      error: error.message,
    });
  }
};

exports.ping = async (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Server is awake',
  });
};
