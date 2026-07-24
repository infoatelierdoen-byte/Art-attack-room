const store = require("../../../lib/store-sql");
const { requireStaff } = require("../../../lib/auth");

// POST /api/admin/manual-booking
// body: { serviceCode, dateISO, start, partySize, customer:{name,email,phone,birthDate},
//         note, paymentMethod, invoiceRequested, invoiceDetails }
//
// Voor boekingen die het team zelf ingeeft (bv. na een telefoontje) — geen
// Mollie-betaallink, wordt meteen als betaald weggeschreven. Zie
// lib/store-sql.js: createManualBooking().
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!requireStaff(req, res)) return;

  try {
    const { booking } = await store.createManualBooking(req.body);
    res.status(201).json({ bookingId: booking.id, amountDue: booking.amountDue });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
