const { SESSION_COOKIE } = require("../../../lib/auth");

// POST /api/auth/logout — wist de sessie-cookie.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.status(200).json({ ok: true });
}
