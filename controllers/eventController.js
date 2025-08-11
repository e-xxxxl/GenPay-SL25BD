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
const Payout = require('../models/payout')
const QRCode = require('qrcode');

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

    // 2) Fetch events for the authenticated host
    const events = await Event.find({ host: host._id })
      .populate('host', 'displayName userType firstName lastName organizationName')
      .select(
        'eventName eventDescription eventCategory startDateTime endDateTime eventLocation eventUrl socialLinks headerImage images capacity tickets isPublished createdAt ticketPolicy'
      );

    // 3) Map events to match the format expected by ThirdSection
    const formattedEvents = events.map((event) => ({
      id: event._id.toString(),
      title: event.eventName,
      description: event.eventDescription,
      category: event.eventCategory,
      date: event.startDateTime,
      endDate: event.endDateTime,
      location: event.eventLocation.venue,
      locationTips: event.eventLocation.locationTips || null,
      url: event.eventUrl || null,
      image: event.headerImage || null,
      poster: event.headerImage || null,
      attendees: event.tickets ? event.tickets.length : 0,
      socialLinks: {
        instagram: event.socialLinks.instagram || null,
        twitter: event.socialLinks.twitter || null,
        snapchat: event.socialLinks.snapchat || null,
        tiktok: event.socialLinks.tiktok || null,
        website: event.socialLinks.website || null,
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
    }));

    res.status(200).json({
      status: 'success',
      data: {
        events: formattedEvents,
      },
    });
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch events',
    });
  }
};


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
    const limit = 6; // Number of events per page
    const skip = (page - 1) * limit;

    const events = await Event.find({ host: host._id })
      .populate('host', 'displayName userType firstName lastName organizationName')
      .select(
        'eventName eventDescription eventCategory startDateTime endDateTime eventLocation eventUrl socialLinks headerImage images capacity tickets isPublished createdAt'
      )
      .skip(skip)
      .limit(limit);

    // 3) Validate and map events
    const formattedEvents = events.map((event) => {
      if (!event.eventName) {
        console.warn(`Event ${event._id} is missing eventName, using fallback`);
      }
      return {
        id: event._id.toString(),
        title: event.eventName || `Unnamed Event ${event._id.toString().slice(-6)}`, // More specific fallback
        description: event.eventDescription || 'No description',
        category: event.eventCategory,
        date: event.startDateTime,
        endDate: event.endDateTime,
        location: event.eventLocation?.venue || 'Unknown Location',
        locationTips: event.eventLocation?.locationTips || null,
        url: event.eventUrl || null,
        image: event.headerImage || null,
        poster: event.headerImage || null,
        attendees: event.tickets ? event.tickets.length : 0,
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
      };
    });

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
    });
  }
};

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
};;

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

// controllers/eventController.js
// controllers/eventController.js
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

// Edit Ticket
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

// Delete Ticket
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

// Get Event Tickets
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

    // Include 'host' in select and populate it
    const event = await Event.findById(req.params.id).select('tickets host').populate('host', '_id');
    if (!event) {
      return res.status(404).json({ status: 'fail', message: 'Event not found' });
    }

    // Validate host field
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


exports.getPublicEvents = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 12;
    const skip = (page - 1) * limit;

    const events = await Event.find({ isPublished: true })
      .select(
        'eventName eventDescription eventCategory startDateTime endDateTime eventLocation eventUrl socialLinks headerImage images tickets'
      )
      .skip(skip)
      .limit(limit)
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
      images: event.images || [], // Ensured
      socialLinks: event.socialLinks || {}, // Ensured
      tickets: event.tickets || [],
      host: {
        displayName: event.host?.displayName || 'Unknown Host',
      },
    }));

    const totalEvents = await Event.countDocuments({ isPublished: true });
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
    console.error('Error fetching public events:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch public events',
    });
  }
};

// controllers/eventController.js
exports.purchaseTicket = async (req, res) => {
  try {
    const { eventId, tickets, customer } = req.body;
    if (!eventId || !tickets || !Array.isArray(tickets) || !customer) {
      return res.status(400).json({
        status: 'fail',
        message: 'Event ID, tickets array, and customer details are required',
      });
    }

    const { firstName, lastName, email, phone, location } = customer;
    if (!firstName || !lastName || !email || !phone || !location) {
      return res.status(400).json({
        status: 'fail',
        message: 'Customer details (firstName, lastName, email, phone, location) are required',
      });
    }

    // Find or create user by email
    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({ firstName, lastName, email, phone, location });
    }

    const event = await Event.findById(eventId).populate('host', 'displayName firstName lastName organizationName');
    if (!event) {
      return res.status(404).json({ status: 'fail', message: 'Event not found' });
    }

    const purchasedTickets = [];
    for (const { ticketId, quantity } of tickets) {
      const ticket = event.tickets.find((t) => t.id === ticketId);
      if (!ticket) {
        return res.status(404).json({ status: 'fail', message: `Ticket ${ticketId} not found` });
      }
      if (ticket.quantity < quantity) {
        return res.status(400).json({
          status: 'fail',
          message: `Insufficient quantity for ticket ${ticket.name}`,
        });
      }

      for (let i = 0; i < quantity; i++) {
        const qrCodeData = {
          ticketId: uuidv4(), // Generate ticketId
          eventId: event._id,
          eventName: event.eventName,
          ticketType: ticket.name,
          customer: {
            firstName,
            lastName,
            email,
            phone,
            location,
          },
          host: {
            displayName: event.host.displayName,
            firstName: event.host.firstName || null,
            lastName: event.host.lastName || null,
            organizationName: event.host.organizationName || null,
          },
          purchaseDate: new Date(),
        };
        const qrCodeUrl = await QRCode.toDataURL(JSON.stringify(qrCodeData));

        const newTicket = await Ticket.create({
          event: eventId,
          owner: user._id,
          type: ticket.name.toLowerCase().replace(/\s+/g, '-'),
          price: ticket.price,
          qrCode: qrCodeUrl,
          ticketId: qrCodeData.ticketId, // Set ticketId
        });

        purchasedTickets.push(newTicket);
      }

      ticket.quantity -= quantity;
    }

    await event.save({ validateBeforeSave: true });

    res.status(201).json({
      status: 'success',
      data: { tickets: purchasedTickets },
      message: 'Tickets purchased successfully',
    });
  } catch (error) {
    console.error('Error purchasing tickets:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to purchase tickets',
      error: error.message,
    });
  }
};

// controllers/eventController.js

// controllers/eventController.js
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

    const { id } = req.params;
    const { search } = req.body;
    if (!search) {
      return res.status(400).json({ status: "fail", message: "Search query is required" });
    }

    console.log("Searching for:", search, "in event:", id);
    const event = await Event.findById(id).select("host");
    if (!event) {
      return res.status(404).json({ status: "fail", message: "Event not found" });
    }

    if (event.host.toString() !== host._id.toString()) {
      return res.status(403).json({
        status: "fail",
        message: "You are not authorized to search tickets for this event",
      });
    }

    // Find users matching the email
    const users = await User.find({ email: { $regex: search, $options: "i" } }).select("_id email firstName lastName phone location");
    console.log("Found users:", users.map(u => ({ id: u._id.toString(), email: u.email })));

    if (!users.length) {
      return res.status(404).json({ status: "fail", message: "No users found with the provided email" });
    }

    // Find tickets for the event where owner is in the matched users or ticketId matches
    const tickets = await Ticket.find({
      event: id,
      $or: [
        { owner: { $in: users.map(u => u._id) } },
        { ticketId: search },
        ...(mongoose.Types.ObjectId.isValid(search) ? [{ _id: search }] : []),
      ],
    })
      .populate("event", "eventName")
      .populate("owner", "firstName lastName email phone location")
      .limit(10);

    console.log("Found tickets:", tickets.map(t => ({
      ticketId: t.ticketId || t._id.toString(),
      owner: t.owner ? t.owner.email : "No owner",
      eventId: t.event._id.toString(),
    })));

    if (!tickets.length) {
      return res.status(404).json({ status: "fail", message: "No tickets found for the provided email or ticket ID" });
    }

    const formattedTickets = tickets.map((ticket) => ({
      id: ticket.ticketId || ticket._id.toString(),
      event: {
        id: ticket.event._id.toString(),
        eventName: ticket.event.eventName,
      },
      owner: {
        firstName: ticket.owner?.firstName || "Unknown",
        lastName: ticket.owner?.lastName || "Unknown",
        email: ticket.owner?.email || "Unknown",
        phone: ticket.owner?.phone || "—",
        location: ticket.owner?.location || "—",
      },
      type: ticket.type,
      usedAt: ticket.usedAt,
      status: ticket.isUsed ? "used" : "valid",
    }));

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

    // Find ticket by ticketId or _id
    const query = {
      event: id,
      $or: [
        { ticketId: ticketId },
        ...(mongoose.Types.ObjectId.isValid(ticketId) ? [{ _id: ticketId }] : []),
      ],
    };

    const ticket = await Ticket.findOne(query).populate("owner", "email firstName lastName phone location");
    if (!ticket) {
      return res.status(404).json({ status: "fail", message: "Ticket not found" });
    }

    if (ticket.isUsed) {
      return res.status(400).json({ status: "fail", message: "Ticket already used" });
    }

    // Set ticketId if missing to avoid validation error
    if (!ticket.ticketId) {
      ticket.ticketId = uuidv4();
    }

    // Update ticket to mark as used
    ticket.isUsed = true;
    ticket.usedAt = new Date();
    await ticket.save();

    console.log("Ticket checked in:", {
      ticketId: ticket.ticketId || ticket._id.toString(),
      ownerEmail: ticket.owner?.email,
      eventId: ticket.event.toString(),
    });

    res.status(200).json({
      status: "success",
      data: {
        ticket: {
          id: ticket.ticketId || ticket._id.toString(),
          owner: {
            email: ticket.owner?.email || "Unknown",
            firstName: ticket.owner?.firstName || "Unknown",
            lastName: ticket.owner?.lastName || "Unknown",
            phone: ticket.owner?.phone || "—",
            location: ticket.owner?.location || "—",
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
// controllers/eventController.js


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
      .populate('owner', 'email firstName lastName')
      .select('usedAt price type');

    const formattedCheckins = checkins.map(ticket => ({
      guestEmail: ticket.owner.email,
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


// controllers/eventController.js
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
      .populate('owner', 'firstName lastName email phone location')
      .select('isUsed type price');

    const guests = tickets.map(ticket => ({
      name: `${ticket.owner.firstName} ${ticket.owner.lastName}`,
      email: ticket.owner.email,
      phone: ticket.owner.phone || '—',
      location: ticket.owner.location || '—',
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


// controllers/eventController.js
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