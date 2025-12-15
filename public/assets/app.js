export async function apiGetQuiz() {
  const res = await fetch("/api/quiz");
  if (!res.ok) throw new Error("Không tải được quiz");
  return res.json();
}

export async function apiSubmit(answers) {
  const res = await fetch("/api/submit", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ answers })
  });
  if (!res.ok) throw new Error("Nộp bài thất bại");
  return res.json();
}
