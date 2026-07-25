const store = require("../../lib/store-sql");

// GET /api/availability-month?service=art_attack_room&year=2026&month=7&partySize=2
// `month` is 0-based (JS Date-conventie, zoals viewMonth in de widget).
// Geeft enkel een lijst ISO-datums terug die minstens 1 boekbaar tijdstip
// hebben — voor het groen markeren van dagen in de maandkalender. Nooit
// tijdslot- of roomdetails, net als /api/availability.
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { service, year, month, partySize } = req.query;
  if (!service || year === undefined || month === undefined) {
    return res.status(400).json({ error: "service, year en month zijn verplicht" });
  }

  try {
    const dates = await store.getMonthAvailability(
      service,
      Number(year),
      Number(month),
      partySize ? Number(partySize) : undefined
    );
    res.status(200).json({ year: Number(year), month: Number(month), dates });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
