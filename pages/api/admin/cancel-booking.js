const store = require("../../../lib/store-sql");
const { requireStaff } = require("../../../lib/auth");

// POST /api/admin/cancel-booking
// body: { bookingId, refundAmount, reason }
//
// Annuleert een boeking vanuit de agenda (bv. een klant die annuleert, of
// foute testdata opruimen). refundAmount mag 0 (geen terugbetaling), het
// volledige amount_due, of iets ertussenin zijn (bv. annuleringskost
// ingehouden) — zie lib/store-sql.js: cancelBooking(). Enkel Admin, dit is
// een destructieve actie op omzet-/klantdata.
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
    const { bookingId, refundAmount, reason } = req.body;
    if (!bookingId) return res.status(400).json({ error: "bookingId is verplicht." });
    const result = await store.cancelBooking(bookingId, { refundAmount, reason });
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
