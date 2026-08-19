const store = require("../../../lib/store-sql");
const { requireStaff } = require("../../../lib/auth");

// GET  /api/admin/gift-cards?q=... — zoeken op code/naam/e-mail (leeg = laatste 100)
// POST /api/admin/gift-cards — manueel een cadeaubon aanmaken (bv. cash verkocht)
//   body: { amount, purchaserName, purchaserEmail, note, expiresAtISO }
//
// Enkel Admin. Een cadeauboncode is een waardepapier: wie de lijst kan
// opvragen, ziet honderd geldige codes mét restsaldo staan en kan die zelf
// gaan opgebruiken in de widget. Hier stond eerder alleen requireStaff(),
// waardoor het gast-wachtwoord — dat per definitie breder gedeeld wordt —
// daar volledige toegang toe had. Zie het veiligheidsrapport van 19-08-2026.
export default async function handler(req, res) {
  const session = requireStaff(req, res);
  if (!session) return;
  if (session.role !== "admin") {
    return res.status(403).json({ error: "Enkel toegankelijk voor Admin." });
  }

  if (req.method === "GET") {
    try {
      const cards = await store.searchGiftCards(req.query.q || "");
      return res.status(200).json({ cards });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  if (req.method === "POST") {
    try {
      const card = await store.createManualGiftCard(req.body);
      return res.status(201).json({ card });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
