const store = require("../../lib/store-sql");

// GET /api/availability?service=art_attack_room&date=2026-08-05&partySize=4
// Geeft nooit roomdetails terug — enkel of een tijdslot boekbaar is.
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { service, date, partySize } = req.query;
  if (!service || !date) {
    return res.status(400).json({ error: "service en date zijn verplicht" });
  }

  try {
    const slots = await store.getAvailability(service, date, partySize ? Number(partySize) : undefined);
    res.status(200).json({ date, service, slots });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
