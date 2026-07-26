const store = require("../../../lib/store-sql");
const { generateWeekBookingsPdf } = require("../../../lib/pdf");
const { requireStaff } = require("../../../lib/auth");
const { mondayOfISO, toISODate } = require("../../../lib/dateUtils");

// GET /api/admin/week-export-pdf?week=2026-08-03
// Download van alle boekingen in de week waarin die datum valt, als 1 PDF —
// voor extern bewaren/doorsturen. Enkel Admin. Geen vervanging van de
// wekelijkse Billit-verzamelfactuur (zie /api/admin/weekly-invoice), enkel
// een leesbaar overzicht.
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

  try {
    const week = req.query.week || toISODate(new Date());
    const monday = mondayOfISO(week);
    const events = await store.getWeekSessions(monday);
    const bookings = events.filter(e => e.kind === "service" && e.bookingId);

    const pdfBuffer = await generateWeekBookingsPdf(monday, bookings);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="boekingen-week-${monday}.pdf"`);
    res.status(200).send(pdfBuffer);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
