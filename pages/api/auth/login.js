const { createSessionToken, verifyPassword, SESSION_COOKIE, SESSION_MAX_AGE_SEC } = require("../../../lib/auth");

// POST /api/auth/login — body: { password }
// Vergelijkt met STAFF_ADMIN_PASSWORD / STAFF_GUEST_PASSWORD en zet bij een
// match een ondertekende, HttpOnly sessie-cookie (30 dagen geldig).
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { password } = req.body || {};
  const role = verifyPassword(password);
  if (!role) {
    return res.status(401).json({ error: "Onjuist wachtwoord." });
  }

  const token = createSessionToken(role);
  const isProd = process.env.NODE_ENV === "production";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}${isProd ? "; Secure" : ""}`
  );
  res.status(200).json({ role });
}
