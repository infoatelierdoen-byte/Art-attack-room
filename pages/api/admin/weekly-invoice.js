const store = require("../../../lib/store-sql");
const { toISODate, addDaysISO } = require("../../../lib/dateUtils");

// POST /api/admin/weekly-invoice?week=2026-08-03
// Genereert de wekelijkse verzamelfactuur voor de week waarin die datum
// valt (maandag t.e.m. zondag). Zonder ?week= wordt de vorige (net
// afgelopen) week gebruikt — dit endpoint is bedoeld om elke week eenmalig
// aangeroepen te worden door een externe scheduler (zie README).
// Idempotent: een tweede aanroep voor dezelfde week doet niets opnieuw.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const week = req.query.week || addDaysISO(toISODate(new Date()), -7);

  try {
    const result = await store.generateWeeklyRevenueInvoice(week);
    res.status(200).json({
      periodStart: result.period_start,
      periodEnd: result.period_end,
      totalAmount: Number(result.total_amount),
      excludedBookingCount: result.excluded_booking_count,
      billitInvoiceId: result.billit_invoice_id,
      alreadyExisted: !!result.alreadyExisted
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
