const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running: http://localhost:" + port));
