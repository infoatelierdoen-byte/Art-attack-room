const store = require("../../../lib/store-sql");

// GET  /api/admin/gift-cards?q=... — zoeken op code/naam/e-mail (leeg = laatste 100)
// POST /api/admin/gift-cards — manueel een cadeaubon aanmaken (bv. cash verkocht)
//   body: { amount, purchaserName, purchaserEmail, note, expiresAtISO }
export default async function handler(req, res) {
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
