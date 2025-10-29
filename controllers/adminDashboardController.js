// controllers/adminDashboardController.js
const Host = require('../models/host');
const Event = require('../models/event');
const Payout = require('../models/payout');
const Ticket = require('../models/ticket');
const Admin = require('../models/admin');
const Transaction = require('../models/transaction');

// Get dashboard statistics
// exports.getDashboardStats = async (req, res) => {
//   try {
//     const today = new Date();
//     today.setHours(0, 0, 0, 0);
//     const tomorrow = new Date(today);
//     tomorrow.setDate(tomorrow.getDate() + 1);

//     // Total payouts today
//     const totalPayoutsToday = await Payout.countDocuments({
//       createdAt: { $gte: today, $lt: tomorrow },
//       status: 'completed'
//     });

//     // Pending payouts
//     const pendingPayouts = await Payout.countDocuments({
//       status: 'pending'
//     });

//     // Total earnings today (from transactions)
//     const todayTransactions = await Transaction.find({
//       createdAt: { $gte: today, $lt: tomorrow },
//       status: 'completed'
//     });
//     const totalEarningsToday = todayTransactions.reduce((sum, transaction) => sum + transaction.total, 0);

//     // Genpay cut (assuming 7.5% of total earnings)
//     const genpaycut = totalEarningsToday * 0.075;

//     // Paystack cut (assuming 1.5% + ₦100 per transaction)
//     const paystackCut = todayTransactions.reduce((sum, transaction) => {
//       return sum + (transaction.total * 0.015) + 100;
//     }, 0);

//     // Net holding
//     const netHolding = totalEarningsToday - genpaycut - paystackCut;

//     // Active hosts (hosts with events)
//     const activeHosts = await Host.countDocuments({
//       events: { $exists: true, $ne: [] }
//     });

//     // Live events (events happening today)
//     const liveEvents = await Event.countDocuments({
//       startDateTime: { $lte: new Date() },
//       endDateTime: { $gte: new Date() },
//       isPublished: true
//     });

//     // Past events
//     const pastEvents = await Event.countDocuments({
//       endDateTime: { $lt: new Date() },
//       isPublished: true
//     });

//     // Users logged in now (hosts with recent activity)
//     const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
//     const usersLoggedIn = await Host.countDocuments({
//       lastLogin: { $gte: thirtyMinutesAgo }
//     });

//     // Staff members online status
//     const staffMembers = await Admin.find().select('name role isOnline lastLogin');

//     res.status(200).json({
//       status: 'success',
//       data: {
//         totalPayoutsToday,
//         pendingPayouts,
//         totalEarningsToday,
//         genpaycut,
//         paystackCut,
//         netHolding,
//         activeHosts,
//         liveEvents,
//         pastEvents,
//         usersLoggedIn,
//         staffMembers: staffMembers.map(staff => ({
//           name: staff.name,
//           role: staff.role === 'super_admin' ? 'CEO' : 
//                 staff.name === 'Oluwatosin' ? 'Sales Manager' :
//                 staff.name === 'Emmanuel' ? 'Head Developer' : 'Admin',
//           isOnline: staff.isOnline,
//           lastLogin: staff.lastLogin
//         }))
//       }
//     });
//   } catch (error) {
//     console.error('Get dashboard stats error:', error);
//     res.status(500).json({
//       status: 'error',
//       message: 'Failed to fetch dashboard statistics'
//     });
//   }
// };

exports.getDashboardStats = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Total payouts today
    const totalPayoutsToday = await Payout.countDocuments({
      createdAt: { $gte: today, $lt: tomorrow },
      status: 'completed'
    });

    // Pending payouts
    const pendingPayouts = await Payout.countDocuments({
      status: 'pending'
    });

    // Fetch completed transactions today
    const todayTransactions = await Transaction.find({
      createdAt: { $gte: today, $lt: tomorrow },
      status: 'completed'
    }).lean(); // .lean() for speed

    // Total earnings today (gross amount paid by customer)
    const totalEarningsToday = todayTransactions.reduce((sum, t) => sum + Number(t.total || 0), 0);

    // === CALCULATE PAYSTACK & GENPAY CUTS ===
    let paystackCut = 0;
    let genpayCut = 0;

    // DEBUG: Log every transaction
    console.log('=== FEE CALCULATION DEBUG START ===');
    console.log(`Found ${todayTransactions.length} completed transaction(s) today.\n`);

    todayTransactions.forEach((transaction, index) => {
      const rawTotal = transaction.total;
      const amount = Number(rawTotal);

      console.log(`--- Transaction ${index + 1} ---`);
      console.log(`Raw total:`, rawTotal);
      console.log(`Parsed amount:`, amount);

      if (isNaN(amount) || amount <= 0) {
        console.log(`Skipping: Invalid amount`);
        return;
      }

      let paystackFee = 0;
      let genpayFee = 0;

      if (amount <= 2499) {
        // Tier 1: ≤ ₦2,499
        paystackFee = Math.round((amount * 0.015) * 100) / 100;  // 1.5%
        genpayFee = Math.round((amount * 0.02) * 100) / 100;     // 2.0%
        console.log(`Tier: ≤2499 → Paystack: ₦${paystackFee}, Genpay: ₦${genpayFee}`);

      } else if (amount <= 126666) {
        // Tier 2: ₦2,500 - ₦126,666
        paystackFee = Math.round((amount * 0.015) * 100) / 100 + 100;
        genpayFee = Math.round((amount * 0.02) * 100) / 100;
        console.log(`Tier: 2500–126666 → Paystack: ₦${paystackFee}, Genpay: ₦${genpayFee}`);

      } else if (amount <= 399999) {
        paystackFee = 2000;
        genpayFee = 2000;
        console.log(`Tier: 126667–399999 → ₦4,000 total (₦2,000 each)`);

      } else if (amount <= 599999) {
        paystackFee = 2000;
        genpayFee = 3000;
        console.log(`Tier: 400000–599999 → ₦5,000 total`);

      } else if (amount <= 1999999) {
        paystackFee = 2000;
        genpayFee = 4000;
        console.log(`Tier: 600000–1999999 → ₦6,000 total`);

      } else if (amount <= 4999999) {
        paystackFee = 2000;
        genpayFee = 5500;
        console.log(`Tier: 2000000–4999999 → ₦7,500 total`);

      } else if (amount <= 7999999) {
        paystackFee = 2000;
        genpayFee = 8000;
        console.log(`Tier: 5000000–7999999 → ₦10,000 total`);

      } else {
        paystackFee = 2000;
        genpayFee = 10000;
        console.log(`Tier: 8000000+ → ₦12,000 total`);
      }

      paystackCut += paystackFee;
      genpayCut += genpayFee;

      console.log(`→ Added: Paystack +₦${paystackFee}, Genpay +₦${genpayFee}\n`);
    });

    console.log(`=== FINAL TOTALS ===`);
    console.log(`Total Earnings: ₦${totalEarningsToday}`);
    console.log(`Paystack Cut: ₦${paystackCut}`);
    console.log(`Genpay Cut: ₦${genpayCut}`);
    console.log(`Net Holding: ₦${totalEarningsToday - paystackCut - genpayCut}`);
    console.log(`=== DEBUG END ===\n`);

    const netHolding = totalEarningsToday - paystackCut - genpayCut;

    // Active hosts
    const activeHosts = await Host.countDocuments({
      events: { $exists: true, $ne: [] }
    });

    // Live events
    const liveEvents = await Event.countDocuments({
      startDateTime: { $lte: new Date() },
      endDateTime: { $gte: new Date() },
      isPublished: true
    });

    // Past events
    const pastEvents = await Event.countDocuments({
      endDateTime: { $lt: new Date() },
      isPublished: true
    });

    // Users logged in now
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const usersLoggedIn = await Host.countDocuments({
      lastLogin: { $gte: thirtyMinutesAgo }
    });

    // Staff members
    const staffMembers = await Admin.find().select('name role isOnline lastLogin');

    // Final response with rounded values
    res.status(200).json({
      status: 'success',
      data: {
        totalPayoutsToday,
        pendingPayouts,
        totalEarningsToday,
        genpayCut: Math.round(genpayCut),
        paystackCut: Math.round(paystackCut),
        netHolding: Math.round(netHolding),
        activeHosts,
        liveEvents,
        pastEvents,
        usersLoggedIn,
        staffMembers: staffMembers.map(staff => ({
          name: staff.name,
          role: staff.role === 'super_admin' ? 'CEO' :
                staff.name === 'Oluwatosin' ? 'Sales Manager' :
                staff.name === 'Emmanuel' ? 'Head Developer' : 'Admin',
          isOnline: staff.isOnline,
          lastLogin: staff.lastLogin
        }))
      }
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch dashboard statistics'
    });
  }
};

// Get all hosts with their events and balances
exports.getAllHosts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const hosts = await Host.find()
      .populate('events')
      .select('displayName email phoneNumber location events availableBalance payoutInfo createdAt')
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });

    const totalHosts = await Host.countDocuments();

    const hostsWithStats = await Promise.all(
      hosts.map(async (host) => {
        const events = await Event.find({ host: host._id });
        const totalRevenue = events.reduce((sum, event) => {
          const eventRevenue = event.tickets.reduce((eventSum, ticket) => {
            return eventSum + (ticket.price * ticket.quantity);
          }, 0);
          return sum + eventRevenue;
        }, 0);

        const payouts = await Payout.find({ host: host._id, status: 'completed' });
        const totalPayouts = payouts.reduce((sum, payout) => sum + payout.amount, 0);

        return {
          ...host.toObject(),
          totalRevenue,
          totalPayouts,
          currentBalance: host.availableBalance,
          totalEvents: events.length
        };
      })
    );

    res.status(200).json({
      status: 'success',
      data: {
        hosts: hostsWithStats,
        totalPages: Math.ceil(totalHosts / limit),
        currentPage: page,
        totalHosts
      }
    });
  } catch (error) {
    console.error('Get all hosts error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch hosts'
    });
  }
};

// Get host details by ID
exports.getHostDetails = async (req, res) => {
  try {
    const { hostId } = req.params;

    const host = await Host.findById(hostId)
      .populate({
        path: 'events',
        select: 'eventName eventCategory startDateTime endDateTime eventLocation tickets isPublished'
      })
      .select('displayName email phoneNumber location payoutInfo availableBalance createdAt');

    if (!host) {
      return res.status(404).json({
        status: 'fail',
        message: 'Host not found'
      });
    }

    // Calculate host statistics
    const payouts = await Payout.find({ host: hostId });
    const transactions = await Transaction.find({ 
      event: { $in: host.events.map(e => e._id) } 
    });

    const hostStats = {
      totalEvents: host.events.length,
      totalRevenue: transactions.reduce((sum, t) => sum + t.amount, 0),
      totalPayouts: payouts.reduce((sum, p) => sum + p.amount, 0),
      pendingPayouts: payouts.filter(p => p.status === 'pending').length,
      completedPayouts: payouts.filter(p => p.status === 'completed').length
    };

    res.status(200).json({
      status: 'success',
      data: {
        host,
        stats: hostStats,
        payouts,
        events: host.events
      }
    });
  } catch (error) {
    console.error('Get host details error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch host details'
    });
  }
};