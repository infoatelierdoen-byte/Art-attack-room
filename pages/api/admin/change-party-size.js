const store = require("../../../lib/store-sql");
const { requireStaff } = require("../../../lib/auth");

// POST /api/admin/change-party-size
// body: { bookingId, partySize, recalculatePrice }
//
// Past het aantal personen van een bestaande boeking aan en kiest meteen
// opnieuw de best passende room (A=10, VL=7, VR=7, M=5). Nodig omdat het echte
// aantal personen bij geïmporteerde Wix-boekingen niet bekend was, en omdat een
// groep na de boeking nog kan wijzigen.
//
// De prijs blijft standaard staan — bij een al betaalde boeking is het bedrag
// wat de klant effectief betaald heeft. Zet recalculatePrice op true om het
// tarief voor de nieuwe groepsgrootte toe te passen.
//
// Enkel Admin: dit verschuift rooms en kan omzetcijfers raken.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const session = requireStaff(req, res);
  if (!session) return;
  if (session.role !== "admin") {
    return res.status(403).json({ error: "Enkel toegankelijk voor Admin." });
  }

  try {
    const { bookingId, partySize, recalculatePrice } = req.body;
    if (!bookingId) return res.status(400).json({ error: "bookingId is verplicht." });
    const result = await store.changePartySize(bookingId, {
      partySize,
      recalculatePrice: !!recalculatePrice
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
