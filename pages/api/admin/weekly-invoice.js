const store = require("../../../lib/store-sql");
const { toISODate, addDaysISO } = require("../../../lib/dateUtils");
const { requireStaff } = require("../../../lib/auth");

// POST /api/admin/weekly-invoice?week=2026-08-03
// Genereert de wekelijkse verzamelfactuur voor de week waarin die datum
// valt (maandag t.e.m. zondag). Zonder ?week= wordt de vorige (net
// afgelopen) week gebruikt — dit endpoint is bedoeld om elke week eenmalig
// aangeroepen te worden door een externe scheduler (zie README).
// Idempotent: een tweede aanroep voor dezelfde week doet niets opnieuw.
//
// Dit endpoint wordt niet door een ingelogde medewerker in de browser
// aangeroepen, maar door Vercel's cron-scheduler (zie vercel.json) — dus
// geen sessie-cookie beschikbaar. Vercel stuurt bij een cron-aanroep zelf
// een "Authorization: Bearer <CRON_SECRET>"-header mee zodra CRON_SECRET
// als omgevingsvariabele ingesteld staat; dat wordt hier geverifieerd i.p.v.
// de gewone staff-login. Is er geen CRON_SECRET ingesteld, dan valt dit
// terug op een gewone (ingelogde) staff-sessie — zo blijft dit endpoint
// nooit volledig open.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const cronSecret = process.env.CRON_SECRET;
  const authorizedByCron = cronSecret && req.headers.authorization === `Bearer ${cronSecret}`;
  if (!authorizedByCron && !requireStaff(req, res)) return;

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
