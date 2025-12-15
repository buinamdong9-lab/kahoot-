const mongoose = require("mongoose");

async function connectDB() {
  if (!process.env.MONGO_URI) throw new Error("Thiếu MONGO_URI trong .env");
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ MongoDB connected");
}
module.exports = { connectDB };
