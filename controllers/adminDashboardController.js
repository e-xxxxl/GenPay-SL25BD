// controllers/adminDashboardController.js
const Host = require('../models/host');
const Event = require('../models/event');
const Payout = require('../models/payout');
const Ticket = require('../models/ticket');
const Admin = require('../models/admin');
const Transaction = require('../models/transaction');
const { hostDisplayName, HOST_NAME_FIELDS } = require('../utils/hostName');

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

// Get all hosts with their events and balances.
// Query: page, limit, q (name/email/organisation search), status (verified | pending)
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

exports.getAllHosts = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);
    const skip = (page - 1) * limit;

    const filter = {};
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ firstName: rx }, { lastName: rx }, { organizationName: rx }, { email: rx }];
    }
    if (req.query.status === 'verified') filter.isVerified = true;
    if (req.query.status === 'pending') filter.isVerified = { $ne: true };

    // displayName is a virtual built from these fields, so they must be selected explicitly.
    const [hosts, totalHosts] = await Promise.all([
      Host.find(filter)
        .select(`${HOST_NAME_FIELDS} email phoneNumber location isVerified availableBalance createdAt`)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Host.countDocuments(filter),
    ]);

    // Per-host figures in two queries for the whole page (was two queries per host).
    const ids = hosts.map((h) => h._id);
    const [events, completedPayouts] = await Promise.all([
      Event.find({ host: { $in: ids } }).select('host tickets').lean(),
      Payout.find({ host: { $in: ids }, status: 'completed' }).select('host amount').lean(),
    ]);
    const stats = new Map(ids.map((id) => [String(id), { totalEvents: 0, totalRevenue: 0, totalPayouts: 0 }]));
    for (const event of events) {
      const row = stats.get(String(event.host));
      row.totalEvents += 1;
      row.totalRevenue += (event.tickets || []).reduce((sum, t) => sum + t.price * t.quantity, 0);
    }
    for (const payout of completedPayouts) stats.get(String(payout.host)).totalPayouts += payout.amount;

    const hostsWithStats = hosts.map((host) => ({
      ...host.toObject(),
      displayName: hostDisplayName(host),
      ...stats.get(String(host._id)),
      currentBalance: host.availableBalance,
    }));

    res.status(200).json({
      status: 'success',
      data: {
        hosts: hostsWithStats,
        totalPages: Math.max(Math.ceil(totalHosts / limit), 1),
        currentPage: page,
        totalHosts,
      },
    });
  } catch (error) {
    console.error('Get all hosts error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch hosts',
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
      .select(`${HOST_NAME_FIELDS} email phoneNumber location isVerified payoutInfo availableBalance createdAt`);

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