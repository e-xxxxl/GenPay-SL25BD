// controllers/payoutController.js
const Host = require('../models/host');
const Event = require('../models/event');
const Ticket = require('../models/ticket');
const axios = require('axios');
const Payout = require('../models/payout');

const nodemailer = require('nodemailer');
const sslRootCAs = require('ssl-root-cas');
sslRootCAs.inject();

// const transporter = nodemailer.createTransport({
//   host: 'smtp.zoho.com',
//   port: 465,
//   secure: true,
//   auth: {
//     user: process.env.ZOHO_EMAIL,
//     pass: process.env.ZOHO_PASSWORD,
//   },
// });

// Zoho Mail Transporter Configuration
const transporter = nodemailer.createTransport({
  host: 'smtp.zoho.com',
  port: 465, // SSL port
  secure: true,
  auth: {
    user: process.env.ZOHO_EMAIL,
    pass: process.env.ZOHO_APP_PASSWORD,
  },
  tls: {
    rejectUnauthorized: false // Only for development/testing
  }
});


exports.getBanks = async (req, res) => {
  try {
    const response = await axios.get('https://api.paystack.co/bank?country=nigeria', {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
      timeout: 15000,
    });

    // Log full response for debugging
    console.log('Paystack API response:', {
      status: response.data.status,
      message: response.data.message,
      data: response.data.data ? response.data.data.slice(0, 5) : null,
    });

    // Validate response
    if (!response.data.status || !Array.isArray(response.data.data)) {
      console.error('Invalid Paystack response:', {
        status: response.data.status,
        message: response.data.message,
        data: response.data.data,
      });
      throw new Error(response.data.message || 'Invalid response from Paystack');
    }

    // Filter banks with case-insensitive country check
    const banks = response.data.data
      .filter(bank => {
        try {
          const isNigeria = bank.country && bank.country.toLowerCase() === 'nigeria' || bank.country === 'NG';
          const isActive = bank.active !== false; // Default to true if active is undefined
          return isNigeria && isActive;
        } catch (filterErr) {
          console.error('Error filtering bank:', { bank, error: filterErr.message });
          return false; // Skip problematic bank entries
        }
      })
      .map(bank => {
        try {
          return {
            name: bank.name,
            code: bank.code,
          };
        } catch (mapErr) {
          console.error('Error mapping bank:', { bank, error: mapErr.message });
          return null;
        }
      })
      .filter(bank => bank !== null) // Remove null entries from mapping errors
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!banks.length) {
      console.warn('No banks after filtering:', response.data.data.slice(0, 5));
      throw new Error('No active Nigerian banks available');
    }

    res.status(200).json({
      status: 'success',
      data: banks,
    });
  } catch (err) {
    console.error('Get banks error:', {
      message: err.message,
      status: err.response?.status,
      data: err.response?.data,
      axiosError: err.code || null,
    });

    let statusCode = err.response?.status || 500;
    let errorMessage = 'Failed to fetch bank list. Please try again later.';

    if (err.response) {
      if (statusCode === 401) {
        errorMessage = 'Invalid Paystack API key. Please check your configuration.';
      } else if (statusCode === 429) {
        errorMessage = 'Rate limit exceeded. Please try again later.';
      } else if (statusCode >= 500) {
        errorMessage = 'Paystack service unavailable. Please try again later.';
      } else {
        errorMessage = err.response.data?.message || errorMessage;
      }
    } else if (err.code === 'ECONNABORTED') {
      errorMessage = 'Request to Paystack timed out. Please try again.';
    }

    res.status(statusCode).json({
      status: 'error',
      message: errorMessage,
    });
  }
};


// Resolve bank account name using Paystack
exports.resolveBankAccount = async (req, res) => {
  try {
    const { accountNumber, bankCode } = req.body;

    if (!accountNumber || !bankCode) {
      return res.status(400).json({
        status: 'fail',
        message: 'Account number and bank code are required',
        fields: ['accountNumber', 'bankCode']
      });
    }

    if (!/^\d{10}$/.test(accountNumber)) {
      return res.status(400).json({
        status: 'fail',
        message: 'Account number must be 10 digits',
        field: 'accountNumber'
      });
    }

    const response = await axios.get(
      `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
        timeout: 10000
      }
    );

    if (!response.data.status) {
      console.error('Paystack resolve error:', response.data.message);
      return res.status(400).json({
        status: 'fail',
        message: response.data.message || 'Failed to resolve bank account'
      });
    }

    res.status(200).json({
      status: 'success',
      data: {
        accountName: response.data.data.account_name
      }
    });
  } catch (err) {
    console.error('Resolve bank account error:', {
      message: err.message,
      status: err.response?.status,
      data: err.response?.data
    });
    res.status(err.response?.status || 400).json({
      status: 'fail',
      message: err.response?.data?.message || 'Failed to resolve bank account'
    });
  }
};

// Save or update payout information
exports.savePayoutInfo = async (req, res) => {
  try {
    const { bankName, bankCode, accountNumber, accountName } = req.body;
    const user = req.user;

    if (!bankName || !bankCode || !accountNumber || !accountName) {
      return res.status(400).json({
        status: 'fail',
        message: 'All fields are required',
        fields: ['bankName', 'bankCode', 'accountNumber', 'accountName']
      });
    }

    if (!/^\d{10}$/.test(accountNumber)) {
      return res.status(400).json({
        status: 'fail',
        message: 'Account number must be 10 digits',
        field: 'accountNumber'
      });
    }

    const updatedHost = await Host.findByIdAndUpdate(
      user._id,
      {
        payoutInfo: {
          bankName: bankName.trim(),
          bankCode: bankCode.trim(),
          accountNumber: accountNumber.trim(),
          accountName: accountName.trim()
        }
      },
      { new: true, runValidators: true }
    );

    if (!updatedHost) {
      return res.status(404).json({
        status: 'fail',
        message: 'User not found'
      });
    }

    res.status(200).json({
      status: 'success',
      data: {
        payoutInfo: updatedHost.payoutInfo
      },
      message: 'Payout information saved successfully'
    });
  } catch (err) {
    console.error('Save payout info error:', err.message);
    if (err.name === 'ValidationError') {
      const errors = Object.values(err.errors).map(el => ({
        field: el.path,
        message: el.message
      }));
      return res.status(400).json({
        status: 'fail',
        message: 'Validation failed',
        errors
      });
    }
    res.status(500).json({
      status: 'error',
      message: 'An unexpected error occurred. Please try again later.'
    });
  }
};

// Get payout information
exports.getPayoutInfo = async (req, res) => {
  try {
    const user = req.user;
    const host = await Host.findById(user._id).select('payoutInfo');

    if (!host) {
      return res.status(404).json({
        status: 'fail',
        message: 'User not found'
      });
    }

    res.status(200).json({
      status: 'success',
      data: host.payoutInfo || null
    });
  } catch (err) {
    console.error('Get payout info error:', err.message);
    res.status(500).json({
      status: 'error',
      message: 'An unexpected error occurred. Please try again later.'
    });
  }
};

// Delete payout information
exports.deletePayoutInfo = async (req, res) => {
  try {
    const user = req.user;
    const updatedHost = await Host.findByIdAndUpdate(
      user._id,
      { $unset: { payoutInfo: '' } },
      { new: true }
    );

    if (!updatedHost) {
      return res.status(404).json({
        status: 'fail',
        message: 'User not found'
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'Payout information deleted successfully'
    });
  } catch (err) {
    console.error('Delete payout info error:', err.message);
    res.status(500).json({
      status: 'error',
      message: 'An unexpected error occurred. Please try again later.'
    });
  }
};

exports.getAllPayouts = async (req, res) => {
  try {
    const payouts = await Payout.find({ host: req.user._id }).select('amount status createdAt event');
    console.log('All payouts fetched for host:', req.user._id, payouts);

    res.status(200).json({
      status: 'success',
      data: { payouts },
      message: 'Payouts retrieved successfully',
    });
  } catch (error) {
    console.error('Error fetching all payouts:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch payouts',
      error: error.message,
    });
  }
};



// Helper function to update host balance

const updateHostBalance = async (hostId) => {
  try {
    const events = await Event.find({ host: hostId }).distinct('_id');
    const tickets = await Ticket.find({ event: { $in: events } });
    
    // Calculate total revenue with validation
    const totalRevenue = tickets.reduce((sum, ticket) => {
      const price = Number(ticket.price);
      const quantity = Number(ticket.quantity);
      
      if (!Number.isFinite(price) || price < 0 || !Number.isInteger(quantity) || quantity < 0) {
        console.error('Invalid ticket data:', {
          ticketId: ticket._id.toString(),
          eventId: ticket.event.toString(),
          price: ticket.price,
          quantity: ticket.quantity,
        });
        return sum; // Skip invalid ticket
      }
      
      const ticketRevenue = price * quantity;
      console.log(`Ticket revenue: ${price} * ${quantity} = ${ticketRevenue}`);
      return sum + ticketRevenue;
    }, 0);

    // Only deduct completed payouts
    const payouts = await Payout.find({ host: hostId, status: 'completed' });
    const totalWithdrawn = payouts.reduce((sum, payout) => {
      const payoutAmount = Number(payout.amount);
      if (!Number.isFinite(payoutAmount) || payoutAmount < 0) {
        console.error('Invalid payout amount:', {
          payoutId: payout._id.toString(),
          amount: payout.amount,
        });
        return sum;
      }
      return sum + payoutAmount;
    }, 0);

    const availableBalance = totalRevenue - totalWithdrawn;
    
    if (!Number.isFinite(availableBalance)) {
      console.error('Invalid availableBalance calculated:', {
        totalRevenue,
        totalWithdrawn,
        availableBalance,
      });
      throw new Error('Invalid balance calculation');
    }

    // Update Host document with the calculated balance
    console.log(`Updating host balance for hostId: ${hostId}, availableBalance: ${availableBalance}`);
    await Host.findByIdAndUpdate(hostId, { availableBalance }, { runValidators: true });
    return availableBalance;
  } catch (error) {
    console.error('Error updating host balance:', {
      hostId,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
};
// Get wallet data (events, tickets, payouts, balance)
exports.getWalletData = async (req, res) => {
  try {
    const host = req.user;

    // Update host balance
    const availableBalance = await updateHostBalance(host._id);

    // Fetch events for the host
    const events = await Event.find({ host: host._id }).lean();

    // Fetch tickets for each event with detailed info
    const eventData = await Promise.all(
      events.map(async (event) => {
        const tickets = await Ticket.find({ event: event._id }).select('name type price quantity');
        const ticketCount = tickets.reduce((sum, ticket) => sum + ticket.quantity, 0);
        const revenue = tickets.reduce((sum, ticket) => sum + ticket.price * ticket.quantity, 0);
        return {
          ...event,
          tickets: tickets.map((ticket) => ({
            name: ticket.name,
            type: ticket.type,
            price: ticket.price,
            quantity: ticket.quantity,
          })),
          ticketCount,
          revenue,
        };
      })
    );

    // Fetch payouts
    const payouts = await Payout.find({ host: host._id }).select('amount netAmount status createdAt event').lean();

    // Get total tickets
    const totalTickets = eventData.reduce((sum, event) => sum + event.ticketCount, 0);

    res.status(200).json({
      status: 'success',
      data: {
        events: eventData,
        payouts,
        totalTickets,
        balance: availableBalance,
      },
      message: 'Wallet data retrieved successfully',
    });
  } catch (error) {
    console.error('Error fetching wallet data:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch wallet data',
      error: error.message,
    });
  }
};

// Request withdrawal
exports.requestWithdrawal = async (req, res) => {
  try {
    const host = req.user;
    const { amount } = req.body;

    if (!Number.isFinite(amount) || amount < 150) {
      return res.status(400).json({
        status: 'fail',
        message: 'Withdrawal amount must be at least 150 NGN to cover the withdrawal fee',
      });
    }

    // Check payout info
    if (!host.payoutInfo || !host.payoutInfo.bankName || !host.payoutInfo.bankCode || !host.payoutInfo.accountNumber || !host.payoutInfo.accountName) {
      return res.status(400).json({
        status: 'fail',
        message: 'Payout information is missing. Please update your bank details in the account settings.',
      });
    }

    // Verify balance without updating
    const events = await Event.find({ host: host._id }).distinct('_id');
    const tickets = await Ticket.find({ event: { $in: events } });
    const totalRevenue = tickets.reduce((sum, ticket) => sum + ticket.price * ticket.quantity, 0);
    const payouts = await Payout.find({ host: host._id, status: 'completed' });
    const totalWithdrawn = payouts.reduce((sum, payout) => sum + payout.amount, 0);
    const availableBalance = totalRevenue - totalWithdrawn;

    if (amount > availableBalance) {
      return res.status(400).json({
        status: 'fail',
        message: `Requested amount (${amount} NGN) exceeds available balance (${availableBalance} NGN)`,
      });
    }

    // Create payout without deducting balance
    const payout = await Payout.create({
      host: host._id,
      amount,
      fee: 150,
      netAmount: amount - 150,
      bankDetails: {
        bankName: host.payoutInfo.bankName,
        bankCode: host.payoutInfo.bankCode,
        accountNumber: host.payoutInfo.accountNumber,
        accountName: host.payoutInfo.accountName,
      },
      status: 'pending',
    });

    // Send email notification
    console.log('Sending email to:', host.email);
    const mailOptions = {
      from: process.env.ZOHO_EMAIL,
      to: host.email,
      subject: 'Withdrawal Request Submitted',
      html: `
        <h2>Withdrawal Request Confirmation</h2>
        <p>Dear ${host.displayName},</p>
        <p>Your withdrawal request has been submitted successfully.</p>
        <ul>
          <li><strong>Amount:</strong> ${amount} NGN</li>
          <li><strong>Fee:</strong> 150 NGN</li>
          <li><strong>Net Amount:</strong> ${amount - 150} NGN</li>
          <li><strong>Bank:</strong> ${host.payoutInfo.bankName}</li>
          <li><strong>Account Number:</strong> ${host.payoutInfo.accountNumber}</li>
          <li><strong>Account Name:</strong> ${host.payoutInfo.accountName}</li>
          <li><strong>Status:</strong> Pending</li>
        </ul>
        <p>Processing takes 2-3 business days. You'll receive another email once the withdrawal is completed.</p>
        <p>Thank you,<br>Genpay Team</p>
      `,
    };

    await transporter.sendMail(mailOptions);
    console.log('Email sent successfully');

    res.status(201).json({
      status: 'success',
      data: { payout, balance: availableBalance },
      message: 'Withdrawal request submitted successfully. You will be notified via email once processed.',
    });
  } catch (error) {
    console.error('Error requesting withdrawal:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to process withdrawal request',
      error: error.message,
    });
  }
};

// Update payout status (admin only)
exports.updatePayoutStatus = async (req, res) => {
  try {
    const { payoutId, status } = req.body;
    if (!payoutId || !['pending', 'approved', 'rejected', 'completed'].includes(status)) {
      return res.status(400).json({
        status: 'fail',
        message: 'Invalid payout ID or status',
      });
    }

    const payout = await Payout.findById(payoutId);
    if (!payout) {
      return res.status(404).json({
        status: 'fail',
        message: 'Payout not found',
      });
    }

    // If status is changing to 'completed', deduct amount from host's availableBalance
    if (status === 'completed' && payout.status !== 'completed') {
      const host = await Host.findById(payout.host);
      if (!host) {
        return res.status(404).json({
          status: 'fail',
          message: 'Host not found',
        });
      }

      // Verify sufficient balance
      const events = await Event.find({ host: host._id }).distinct('_id');
      const tickets = await Ticket.find({ event: { $in: events } });
      const totalRevenue = tickets.reduce((sum, ticket) => sum + ticket.price * ticket.quantity, 0);
      const payouts = await Payout.find({ host: host._id, status: 'completed' });
      const totalWithdrawn = payouts.reduce((sum, payout) => sum + payout.amount, 0);
      const availableBalance = totalRevenue - totalWithdrawn;

      if (payout.amount > availableBalance) {
        return res.status(400).json({
          status: 'fail',
          message: `Payout amount (${payout.amount} NGN) exceeds available balance (${availableBalance} NGN)`,
        });
      }

      // Deduct amount from availableBalance
      await Host.findByIdAndUpdate(
        host._id,
        { $inc: { availableBalance: -payout.amount } },
        { new: true, runValidators: true }
      );
    }

    // Update payout status
    payout.status = status;
    payout.updatedAt = Date.now();
    await payout.save();

    // Send email notification if completed
    if (status === 'completed') {
      const host = await Host.findById(payout.host).select('email displayName');
      const mailOptions = {
        from: process.env.ZOHO_EMAIL,
        to: host.email,
        subject: 'Withdrawal Request Completed',
        html: `
          <h2>Withdrawal Request Completed</h2>
          <p>Dear ${host.displayName},</p>
          <p>Your withdrawal request has been successfully processed.</p>
          <ul>
            <li><strong>Amount:</strong> ${payout.amount} NGN</li>
            <li><strong>Fee:</strong> ${payout.fee} NGN</li>
            <li><strong>Net Amount:</strong> ${payout.netAmount} NGN</li>
            <li><strong>Bank:</strong> ${payout.bankDetails.bankName}</li>
            <li><strong>Account Number:</strong> ${payout.bankDetails.accountNumber}</li>
            <li><strong>Account Name:</strong> ${payout.bankDetails.accountName}</li>
            <li><strong>Status:</strong> Completed</li>
          </ul>
          <p>Thank you,<br>Genpay Team</p>
        `,
      };
      console.log('Sending completion email to:', host.email);
      await transporter.sendMail(mailOptions);
      console.log('Completion email sent successfully');
    }

    res.status(200).json({
      status: 'success',
      data: { payout },
      message: 'Payout status updated successfully',
    });
  } catch (error) {
    console.error('Error updating payout status:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to update payout status',
      error: error.message,
    });
  }
};

// Admin: Get all hosts' balances and withdrawals
exports.getAllHostBalances = async (req, res) => {
  try {
    const hosts = await Host.find().select('email displayName availableBalance');
    const hostData = await Promise.all(
      hosts.map(async (host) => {
        // Ensure balance is up-to-date
        const availableBalance = await updateHostBalance(host._id);
        const payouts = await Payout.find({ host: host._id }).select('amount netAmount status createdAt');
        return {
          hostId: host._id,
          email: host.email,
          displayName: host.displayName,
          availableBalance,
          payouts,
        };
      })
    );

    res.status(200).json({
      status: 'success',
      data: { hosts: hostData },
      message: 'Host balances retrieved successfully',
    });
  } catch (error) {
    console.error('Error fetching host balances:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch host balances',
      error: error.message,
    });
  }
};