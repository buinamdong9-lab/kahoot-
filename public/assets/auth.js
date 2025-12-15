export function setToken(t){ localStorage.setItem("token", t); }
export function getToken(){ return localStorage.getItem("token"); }
export function logout(){ localStorage.removeItem("token"); location.href="/login.html"; }

export async function apiLogin(username, password){
  const res = await fetch("/api/auth/login", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if(!res.ok) throw new Error(data.error || "Login fail");
  setToken(data.token);
  return data.token;
}
