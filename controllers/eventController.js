const Event = require('../models/event');
const Host = require('../models/host');
const jwt = require('jsonwebtoken');
const cloudinary = require('../config/cloudinary');
const multer = require('multer');
const { Readable } = require('stream');


// Create a new event
exports.createEvent = async (req, res) => {
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

    if (!host.isVerified) {
      return res.status(403).json({
        status: 'fail',
        message: 'Please verify your email before creating events',
      });
    }

    // 2) Validate required fields
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
       images, // Add this
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

     // Validate headerImage URL if provided
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

    // Validate gallery image URLs if provided
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

    // 3) Validate URL fields
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

    // 4) Validate date format and logic
    const start = new Date(startDateTime);
    const end = new Date(endDateTime);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        status: 'fail',
        message: 'Invalid date format',
        fields: ['startDateTime', 'endDateTime'],
      });
    }

    // 5) Create event
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
      headerImage: headerImage?.trim() || undefined, // Add this
        images: images || [], // Add this
    };

    const newEvent = await Event.create(eventData);

    // 6) Update host's events array
    host.events.push(newEvent._id);
    await host.save({ validateBeforeSave: false });

    // 7) Send response
    res.status(201).json({
      status: 'success',
      data: {
        event: newEvent,
      },
      message: 'Event created successfully',
    });
  } catch (err) {
    console.error('Create event error:', err);

    // Handle validation errors
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

    // Handle other errors
    res.status(500).json({
      status: 'error',
      message: 'An unexpected error occurred. Please try again later.',
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

      // 2) Validate file presence
      if (!req.file) {
        return res.status(400).json({
          status: 'fail',
          message: 'No image file provided',
        });
      }

      // 3) Validate imageType and eventId
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

      // 4) Verify the event exists and belongs to the host
      const event = await Event.findById(eventId);
      if (!event) {
        return res.status(404).json({
          status: 'fail',
          message: 'Event not found',
        });
      }
      if (event.host.toString() !== host._id.toString()) {
        return res.status(403).json({
          status: 'fail',
          message: 'You are not authorized to upload images for this event',
        });
      }

      // 5) Upload to Cloudinary
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

          // 6) Update the event with the header image URL
          try {
            await Event.findByIdAndUpdate(
              eventId,
              { headerImage: result.secure_url },
              { new: true, runValidators: true }
            );

            // 7) Return success response
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

      // Convert buffer to stream and pipe to Cloudinary
      const stream = Readable.from(req.file.buffer);
      stream.pipe(uploadStream);
    } catch (error) {
      console.error('Upload image error:', error);
      res.status(500).json({
        status: 'error',
        message: 'An unexpected error occurred. Please try again later.',
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

      // 2) Validate file presence
      if (!req.file) {
        return res.status(400).json({
          status: 'fail',
          message: 'No image file provided',
        });
      }

      // 3) Validate imageType and eventId
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

      // 4) Verify the event exists and belongs to the host
      const event = await Event.findById(eventId);
      if (!event) {
        return res.status(404).json({
          status: 'fail',
          message: 'Event not found',
        });
      }
      if (event.host.toString() !== host._id.toString()) {
        return res.status(403).json({
          status: 'fail',
          message: 'You are not authorized to upload images for this event',
        });
      }

      // 5) Upload to Cloudinary
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

          // 6) Update the event by appending the gallery image URL
          try {
            await Event.findByIdAndUpdate(
              eventId,
              { $push: { images: result.secure_url } },
              { new: true, runValidators: true }
            );

            // 7) Return success response
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

      // Convert buffer to stream and pipe to Cloudinary
      const stream = Readable.from(req.file.buffer);
      stream.pipe(uploadStream);
    } catch (error) {
      console.error('Upload gallery image error:', error);
      res.status(500).json({
        status: 'error',
        message: 'An unexpected error occurred. Please try again later.',
      });
    }
  });
};