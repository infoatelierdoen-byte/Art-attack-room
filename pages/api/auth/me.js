const { requireStaff } = require("../../../lib/auth");

// GET /api/auth/me — geeft de huidige rol terug als er een geldige sessie
// is (401 anders), zodat /backend bij het laden kan weten of er al
// ingelogd is (bv. na een pagina-herlaad) zonder het wachtwoord opnieuw te
// moeten vragen.
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const session = requireStaff(req, res);
  if (!session) return;
  res.status(200).json({ role: session.role });
}
