const store = require("../../../lib/store-sql");
const { requireStaff } = require("../../../lib/auth");

// GET /api/admin/availability?service=action_painting&date=2026-08-26&partySize=15
//
// Dezelfde beschikbaarheid als /api/availability, maar met de regels van de
// backoffice: een groep die niet in één room past mag hier wél geboekt worden
// — die neemt dan automatisch een tweede room in (Robin, aug 2026). Vandaar
// een aparte route: het publieke endpoint moet die grotere groepen blijven
// weigeren, anders kan iemand via de widget alsnog 15 personen boeken.
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!requireStaff(req, res)) return;

  const { service, date, partySize } = req.query;
  if (!service || !date) {
    return res.status(400).json({ error: "service en date zijn verplicht" });
  }

  try {
    const slots = await store.getAvailability(service, date, partySize ? Number(partySize) : undefined, true);
    res.status(200).json({ date, service, slots });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
