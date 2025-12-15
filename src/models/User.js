const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    username: { type: String, unique: true, required: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["admin", "host"], default: "host" }
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", UserSchema);
