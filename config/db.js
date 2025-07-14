const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    // 1. Get MongoDB URI from .env (throw error if missing)
    const mongoURI = process.env.MONGODB_URI;
    if (!mongoURI) throw new Error('MONGODB_URI is not defined in .env');

    // 2. Connection options
    const options = {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    };

    // 3. Connect to MongoDB
    await mongoose.connect(mongoURI, options);
    console.log(`MongoDB Connected: ${mongoose.connection.host}`);

    // 4. Event listeners for reconnection/disconnects
    mongoose.connection.on('error', (err) => {
      console.error(`MongoDB Connection Error: ${err.message}`);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('MongoDB Disconnected. Reconnecting in 5s...');
      setTimeout(connectDB, 5000); // Auto-reconnect after 5s
    });

  } catch (err) {
    console.error(`MongoDB Initial Connection Failed: ${err.message}`);
    process.exit(1); // Exit if DB connection fails
  }
};

module.exports = connectDB;