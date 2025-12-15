require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const http = require("http");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

// Nếu bạn đã làm phần Mongo/User/Auth trước đó:
const { connectDB } = require("./src/db");
const { authRouter } = require("./src/routes/auth");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(helmet());
app.use(rateLimit({ windowMs: 60_000, max: 240 }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ===== REST AUTH (Host/Admin login) =====
app.use("/api/auth", authRouter);

// ===== QUIZ (file) =====
const QUIZ_PATH = path.join(__dirname, "quiz.json");
function readQuiz() {
  return JSON.parse(fs.readFileSync(QUIZ_PATH, "utf-8"));
}

// ===== JWT helper =====
function tryVerifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

// ===== Socket Auth: OPTIONAL =====
// - Nếu có token hợp lệ => socket.user = {uid, username, role}
// - Nếu không có token => guest player vẫn được connect
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const u = tryVerifyToken(token);
  if (u) socket.user = u;
  next();
});

// ===== In-memory rooms =====
const rooms = new Map();

function makeRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 số
}
function safeQuestion(q) {
  return { id: q.id, text: q.text, options: q.options };
}
function leaderboard(room) {
  return Object.values(room.players)
    .map(p => ({ id: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
function isHostOrAdmin(socket) {
  const role = socket.user?.role;
  return role === "host" || role === "admin";
}
function cleanName(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 24);
}

io.on("connection", (socket) => {
  // ===== HOST create room (login bắt buộc) =====
  socket.on("host:createRoom", () => {
    if (!isHostOrAdmin(socket)) return socket.emit("host:error", "Bạn chưa đăng nhập (host/admin).");

    const quiz = readQuiz();
    const code = makeRoomCode();

    rooms.set(code, {
      code,
      quizTitle: quiz.title,
      questions: quiz.questions || [],
      hostSocketId: socket.id,
      started: false,
      qIndex: -1,
      revealed: false,
      players: {},     // socketId -> {id,name,score,answeredThisQ}
      answersThisQ: {} // socketId -> choice
    });

    socket.join(code);
    socket.emit("room:created", {
      roomCode: code,
      title: quiz.title,
      total: (quiz.questions || []).length
    });
  });

  // ===== PLAYER join (guest) =====
  socket.on("player:join", ({ roomCode, name }) => {
    const room = rooms.get(String(roomCode || ""));
    if (!room) return socket.emit("join:error", "Phòng không tồn tại.");

    const playerName = cleanName(name);
    if (!playerName) return socket.emit("join:error", "Bạn chưa nhập tên.");

    // chặn trùng tên trong phòng (tùy chọn)
    const exists = Object.values(room.players).some(p => p.name.toLowerCase() === playerName.toLowerCase());
    if (exists) return socket.emit("join:error", "Tên này đã có trong phòng. Hãy đổi tên khác.");

    socket.join(room.code);
    room.players[socket.id] = { id: socket.id, name: playerName, score: 0, answeredThisQ: false };

    socket.emit("join:ok", {
      roomCode: room.code,
      title: room.quizTitle,
      started: room.started
    });

    io.to(room.code).emit("room:players", {
      count: Object.keys(room.players).length,
      list: leaderboard(room)
    });

    // Nếu game đang diễn ra thì gửi lại câu hiện tại
    if (room.started && room.qIndex >= 0) {
      const q = room.questions[room.qIndex];
      socket.emit("game:question", {
        index: room.qIndex + 1,
        total: room.questions.length,
        question: safeQuestion(q)
      });
      if (room.revealed) {
        socket.emit("game:reveal", {
          correctIndex: q.correctIndex,
          leaderboard: leaderboard(room)
        });
      }
    }
  });

  // ===== HOST start/next/reveal/end (login bắt buộc & đúng host) =====
  socket.on("host:start", ({ roomCode }) => {
    const room = rooms.get(String(roomCode || ""));
    if (!room) return;
    if (room.hostSocketId !== socket.id) return;

    room.started = true;
    room.qIndex = -1;
    room.revealed = false;

    io.to(room.code).emit("game:started", { title: room.quizTitle });
  });

  socket.on("host:next", ({ roomCode }) => {
    const room = rooms.get(String(roomCode || ""));
    if (!room) return;
    if (room.hostSocketId !== socket.id) return;

    const nextIndex = room.qIndex + 1;
    if (nextIndex >= room.questions.length) {
      io.to(room.code).emit("game:ended", { leaderboard: leaderboard(room) });
      return;
    }

    room.qIndex = nextIndex;
    room.revealed = false;
    room.answersThisQ = {};
    Object.values(room.players).forEach(p => (p.answeredThisQ = false));

    const q = room.questions[room.qIndex];
    io.to(room.code).emit("game:question", {
      index: room.qIndex + 1,
      total: room.questions.length,
      question: safeQuestion(q)
    });
  });

  socket.on("host:reveal", ({ roomCode }) => {
    const room = rooms.get(String(roomCode || ""));
    if (!room) return;
    if (room.hostSocketId !== socket.id) return;
    if (!room.started || room.qIndex < 0) return;

    room.revealed = true;
    const q = room.questions[room.qIndex];
    io.to(room.code).emit("game:reveal", {
      correctIndex: q.correctIndex,
      leaderboard: leaderboard(room)
    });
  });

  socket.on("host:end", ({ roomCode }) => {
    const room = rooms.get(String(roomCode || ""));
    if (!room) return;
    if (room.hostSocketId !== socket.id) return;

    io.to(room.code).emit("game:ended", { leaderboard: leaderboard(room) });
  });

  // ===== PLAYER answer (guest) =====
  socket.on("player:answer", ({ roomCode, choice }) => {
    const room = rooms.get(String(roomCode || ""));
    if (!room) return;
    if (!room.started || room.qIndex < 0) return;

    const p = room.players[socket.id];
    if (!p) return;
    if (p.answeredThisQ) return;

    const q = room.questions[room.qIndex];
    const c = Number(choice);
    if (!Number.isInteger(c) || c < 0 || c >= q.options.length) return;

    p.answeredThisQ = true;
    room.answersThisQ[socket.id] = c;
    if (c === q.correctIndex) p.score += 1;

    socket.emit("answer:received", { ok: true });

    io.to(room.code).emit("room:players", {
      count: Object.keys(room.players).length,
      list: leaderboard(room)
    });
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms.entries()) {
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        io.to(code).emit("room:players", {
          count: Object.keys(room.players).length,
          list: leaderboard(room)
        });
      }

      // host rời -> đóng phòng
      if (room.hostSocketId === socket.id) {
        io.to(code).emit("join:error", "Host đã thoát. Phòng đóng.");
        rooms.delete(code);
      }
    }
  });
});

(async () => {
  await connectDB(); // nếu bạn dùng Mongo cho auth
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log("Server running: http://localhost:" + port));
})();
