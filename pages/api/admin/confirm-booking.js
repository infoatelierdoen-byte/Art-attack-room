const store = require("../../../lib/store-sql");
const { requireStaff } = require("../../../lib/auth");

// POST /api/admin/confirm-booking
// body: { bookingId, paymentMethod }
//
// Bevestigt een manuele boeking die eerder als "enkel reservering"
// (nog niet betaald/definitief) werd aangemaakt. Zie
// lib/store-sql.js: confirmManualBooking().
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!requireStaff(req, res)) return;

  try {
    const { bookingId, paymentMethod } = req.body;
    const result = await store.confirmManualBooking(bookingId, { paymentMethod });
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
