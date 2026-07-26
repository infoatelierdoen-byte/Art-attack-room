const store = require("../../../lib/store-sql");
const { requireStaff } = require("../../../lib/auth");

// POST /api/admin/reschedule-booking
// body: { bookingId, dateISO, start }
//
// Verplaatst een boeking naar een ander tijdslot. Enkel Admin, net als
// cancel-booking. Zie lib/store-sql.js: rescheduleBooking().
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
    const { bookingId, dateISO, start } = req.body;
    if (!bookingId || !dateISO || !start) {
      return res.status(400).json({ error: "bookingId, dateISO en start zijn verplicht." });
    }
    const result = await store.rescheduleBooking(bookingId, { dateISO, start });
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
