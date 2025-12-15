const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const QUIZ_PATH = path.join(__dirname, "quiz.json");

function readQuiz() {
  return JSON.parse(fs.readFileSync(QUIZ_PATH, "utf-8"));
}
function writeQuiz(data) {
  fs.writeFileSync(QUIZ_PATH, JSON.stringify(data, null, 2), "utf-8");
}
function requireAdmin(req, res, next) {
  const key = req.header("x-admin-key");
  if (!process.env.ADMIN_KEY) return res.status(500).json({ error: "Chưa cấu hình ADMIN_KEY" });
  if (key !== process.env.ADMIN_KEY) return res.status(401).json({ error: "Sai admin key" });
  next();
}

// ===== REST API (giữ lại để admin sửa quiz) =====
app.get("/api/quiz", (req, res) => {
  const quiz = readQuiz();
  res.json({
    title: quiz.title,
    questions: quiz.questions.map(q => ({ id: q.id, text: q.text, options: q.options }))
  });
});

app.post("/api/submit", (req, res) => {
  const { answers } = req.body || {};
  const quiz = readQuiz();
  let score = 0;
  const details = quiz.questions.map(q => {
    const picked = answers?.[q.id];
    const correct = picked === q.correctIndex;
    if (correct) score++;
    return { id: q.id, correct };
  });
  res.json({ score, total: quiz.questions.length, details });
});

app.get("/api/admin/quiz", requireAdmin, (req, res) => res.json(readQuiz()));
app.post("/api/admin/quiz", requireAdmin, (req, res) => {
  const data = req.body;
  if (!data?.title || !Array.isArray(data.questions)) return res.status(400).json({ error: "JSON không hợp lệ" });
  writeQuiz(data);
  res.json({ ok: true });
});

// ===== Kahoot realtime =====
const rooms = new Map(); // roomCode -> roomState

function makeRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
}
function safeQuestion(q) {
  return { id: q.id, text: q.text, options: q.options };
}
function leaderboard(room) {
  return Object.values(room.players)
    .map(p => ({ id: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

io.on("connection", (socket) => {
  // HOST tạo phòng
  socket.on("host:createRoom", () => {
    const quiz = readQuiz();
    const code = makeRoomCode();

    rooms.set(code, {
      code,
      quizTitle: quiz.title,
      questions: quiz.questions,
      hostSocketId: socket.id,
      started: false,
      qIndex: -1,
      revealed: false,
      players: {}, // socketId -> {id,name,score,answeredThisQ:boolean}
      answersThisQ: {} // socketId -> choice
    });

    socket.join(code);
    socket.emit("room:created", {
      roomCode: code,
      title: quiz.title,
      total: quiz.questions.length
    });
  });

  // PLAYER join phòng
  socket.on("player:join", ({ roomCode, name }) => {
    const room = rooms.get(String(roomCode || ""));
    if (!room) return socket.emit("join:error", "Phòng không tồn tại.");

    const playerName = String(name || "").trim().slice(0, 24);
    if (!playerName) return socket.emit("join:error", "Bạn chưa nhập tên.");

    socket.join(room.code);
    room.players[socket.id] = { id: socket.id, name: playerName, score: 0, answeredThisQ: false };

    socket.emit("join:ok", {
      roomCode: room.code,
      title: room.quizTitle,
      started: room.started
    });

    io.to(room.code).emit("room:players", { count: Object.keys(room.players).length, list: leaderboard(room) });

    // Nếu game đang ở giữa chừng, gửi lại câu hiện tại (nếu có)
    if (room.started && room.qIndex >= 0) {
      const q = room.questions[room.qIndex];
      socket.emit("game:question", {
        index: room.qIndex + 1,
        total: room.questions.length,
        question: safeQuestion(q),
      });
      if (room.revealed) {
        socket.emit("game:reveal", {
          correctIndex: q.correctIndex,
          leaderboard: leaderboard(room)
        });
      }
    }
  });

  // HOST bắt đầu
  socket.on("host:start", ({ roomCode }) => {
    const room = rooms.get(String(roomCode || ""));
    if (!room) return;
    if (room.hostSocketId !== socket.id) return;

    room.started = true;
    room.qIndex = -1;
    room.revealed = false;
    io.to(room.code).emit("game:started", { title: room.quizTitle });
  });

  // HOST sang câu tiếp theo
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
    // reset answered flag
    Object.values(room.players).forEach(p => (p.answeredThisQ = false));

    const q = room.questions[room.qIndex];
    io.to(room.code).emit("game:question", {
      index: room.qIndex + 1,
      total: room.questions.length,
      question: safeQuestion(q),
    });
  });

  // PLAYER trả lời
  socket.on("player:answer", ({ roomCode, choice }) => {
    const room = rooms.get(String(roomCode || ""));
    if (!room) return;
    if (!room.started || room.qIndex < 0) return;

    const p = room.players[socket.id];
    if (!p) return;

    if (p.answeredThisQ) return; // chỉ được trả lời 1 lần/câu
    const q = room.questions[room.qIndex];

    const c = Number(choice);
    if (!Number.isInteger(c) || c < 0 || c >= q.options.length) return;

    p.answeredThisQ = true;
    room.answersThisQ[socket.id] = c;

    // Chấm điểm ngay (giống Kahoot: trả lời đúng +1)
    if (c === q.correctIndex) p.score += 1;

    // feedback riêng cho người trả lời
    socket.emit("answer:received", { ok: true });

    // update bảng điểm realtime cho host/xem
    io.to(room.code).emit("room:players", { count: Object.keys(room.players).length, list: leaderboard(room) });
  });

  // HOST reveal đáp án + leaderboard
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

  // HOST kết thúc
  socket.on("host:end", ({ roomCode }) => {
    const room = rooms.get(String(roomCode || ""));
    if (!room) return;
    if (room.hostSocketId !== socket.id) return;
    io.to(room.code).emit("game:ended", { leaderboard: leaderboard(room) });
  });

  socket.on("disconnect", () => {
    // nếu là player: xóa khỏi phòng
    for (const [code, room] of rooms.entries()) {
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        io.to(code).emit("room:players", { count: Object.keys(room.players).length, list: leaderboard(room) });
      }
      // nếu là host: đóng phòng
      if (room.hostSocketId === socket.id) {
        io.to(code).emit("join:error", "Host đã thoát. Phòng đóng.");
        rooms.delete(code);
      }
    }
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log("Server running: http://localhost:" + port));
