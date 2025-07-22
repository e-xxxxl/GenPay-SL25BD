require('dotenv').config(); // Load environment variables first
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const app = express();

// ======================
// 1. Middleware Setup
// ======================
const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.SECOND_FRONTEND_URL,
  'http://localhost:5173',
  'https://genpaysl.vercel.app' // Add other dev URLs as needed
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
}));


app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded forms

// ======================
// 2. Database Connection
// ======================
connectDB(); 


// 3. Routes (Example)
// ======================
app.get('/', (req, res) => {
  res.json({ message: 'GENPAY NIGERIA' });
});
const authRouter = require('./routes/authRoutes');
app.use('/api/auth', authRouter);

const eventRoutes = require('./routes/eventRoutes');
app.use('/api/events', eventRoutes);
// // Auth Routes
// app.use('/api/auth', require('./routes/authRoutes'));

// // Ticket Routes
// app.use('/api/tickets', require('./routes/ticketRoutes'));


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});