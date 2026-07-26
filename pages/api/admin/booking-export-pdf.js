const store = require("../../../lib/store-sql");
const { generateBookingPdf } = require("../../../lib/pdf");
const { requireStaff } = require("../../../lib/auth");

// GET /api/admin/booking-export-pdf?bookingId=...
// Download van 1 boeking als PDF, voor extern bewaren/doorsturen. Enkel
// Admin (bevat volledige klantgegevens + betaalinfo). Zie
// lib/store-sql.js: getBookingDetail(), lib/pdf.js: generateBookingPdf().
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const session = requireStaff(req, res);
  if (!session) return;
  if (session.role !== "admin") {
    return res.status(403).json({ error: "Enkel toegankelijk voor Admin." });
  }

  const { bookingId } = req.query;
  if (!bookingId) return res.status(400).json({ error: "bookingId is verplicht." });

  try {
    const booking = await store.getBookingDetail(bookingId);
    if (!booking) return res.status(404).json({ error: "Boeking niet gevonden." });

    const pdfBuffer = await generateBookingPdf(booking);
    const safeName = (booking.customerName || "boeking").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="boeking-${booking.dateISO}-${safeName}.pdf"`);
    res.status(200).send(pdfBuffer);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
