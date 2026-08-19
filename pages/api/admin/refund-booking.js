const store = require("../../../lib/store-sql");
const { requireStaff } = require("../../../lib/auth");

// POST /api/admin/refund-booking
// body: { bookingId, refundAmount, reason }
//
// Betaalt (een deel van) een boeking terug ZONDER ze te annuleren: de boeking
// blijft staan, de room blijft gereserveerd, de klant komt gewoon langs. Voor
// een prijscorrectie of een commercieel gebaar. Wil je de plaats wél vrijgeven,
// gebruik dan /api/admin/cancel-booking.
//
// Meerdere gedeeltelijke terugbetalingen tellen op en kunnen samen nooit meer
// worden dan het betaalde bedrag — zie lib/store-sql.js: refundBooking().
//
// Enkel Admin: dit raakt rechtstreeks aan omzetcijfers.
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
    const result = await store.refundBooking(bookingId, { refundAmount, reason });
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
