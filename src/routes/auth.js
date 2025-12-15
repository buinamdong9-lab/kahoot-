const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const router = express.Router();

function sign(user) {
  return jwt.sign(
    { uid: user._id.toString(), username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

// tạo tài khoản (để đơn giản: mở luôn, bạn có thể khóa sau)
router.post("/register", async (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "Thiếu username/password" });

    const exists = await User.findOne({ username });
    if (exists) return res.status(409).json({ error: "Username đã tồn tại" });

    const passwordHash = await bcrypt.hash(password, 10);
    const safeRole = role === "admin" ? "admin" : "host";

    const user = await User.create({ username, passwordHash, role: safeRole });
    res.json({ token: sign(user) });
  } catch (e) {
    res.status(500).json({ error: "Lỗi register" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "Thiếu username/password" });

    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: "Sai tài khoản hoặc mật khẩu" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Sai tài khoản hoặc mật khẩu" });

    res.json({ token: sign(user) });
  } catch (e) {
    res.status(500).json({ error: "Lỗi login" });
  }
});

module.exports = { authRouter: router };
