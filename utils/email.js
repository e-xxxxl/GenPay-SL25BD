const nodemailer = require('nodemailer');

// Zoho Mail transporter
const transporter = nodemailer.createTransport({
  host: 'smtp.zoho.com',
  port: 465, // or 587 for TLS
  secure: true, // true for 465, false for other ports
  auth: {
    user: process.env.ZOHO_EMAIL, // Your full Zoho email (e.g., no-reply@yourdomain.com)
    pass: process.env.ZOHO_APP_PASSWORD, // App-specific password
  },
});

// Example: Send verification email
exports.sendEmail = async (to, subject, html) => {
  try {
    await transporter.sendMail({
      from: `"EventTick" <${process.env.ZOHO_EMAIL}>`, // Sender address
      to,
      subject,
      html,
    });
    console.log('Email sent to:', to);
  } catch (error) {
    console.error('Email send error:', error);
    throw new Error('Failed to send email');
  }
};