// export-users.js - Fixed version with .env support
const mongoose = require('mongoose');
const User = require('./models/user');
const fs = require('fs');
require('dotenv').config(); // Make sure this is at the top!

async function exportUsers() {
  try {
    const MONGODB_URI = process.env.MONGODB_URI;
    
    // Check if URI exists
    if (!MONGODB_URI) {
      console.error('❌ MONGODB_URI not found in .env file!');
      console.log('Make sure your .env file has: MONGODB_URI=your-connection-string');
      return;
    }
    
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB successfully');
    
    const writeStream = fs.createWriteStream('./genpayusers_export.csv');
    
    // Add UTF-8 BOM for Excel compatibility
    writeStream.write('\uFEFF');
    
    // Write headers
    writeStream.write('Full Name,Last Name,Phone Number,Email\n');
    
    let count = 0;
    const cursor = User.find({}).lean().cursor();
    
    for await (const user of cursor) {
      // Force phone number to be treated as text in Excel
      const phoneText = `"="${user.phone}""`;
      
      writeStream.write(`"${user.firstName} ${user.lastName}","${user.lastName}",${phoneText},"${user.email}"\n`);
      count++;
      
      if (count % 1000 === 0) console.log(`Exported ${count} users...`);
    }
    
    writeStream.end();
    console.log(`✅ Done! Exported ${count} users to users_export.csv`);
    await mongoose.disconnect();
    
  } catch (error) {
    console.error('Export failed:', error);
  }
}

exportUsers();