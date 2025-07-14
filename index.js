require('dotenv').config(); // Load environment variables first
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const app = express();

// ======================
// 1. Middleware Setup
// ======================
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173', // Lock down CORS in production
  credentials: true // Enable cookies/auth headers if needed
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
  res.json({ message: 'Event Ticketing API' });
});
const authRouter = require('./routes/authRoutes');
app.use('/api/auth', authRouter);
// // Auth Routes
// app.use('/api/auth', require('./routes/authRoutes'));

// // Ticket Routes
// app.use('/api/tickets', require('./routes/ticketRoutes'));


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});