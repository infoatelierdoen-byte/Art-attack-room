const store = require("../../../lib/store-sql");
const { mondayOfISO, toISODate } = require("../../../lib/dateUtils");

// GET /api/admin/sessions?week=2026-08-03  (elke datum in die week is prima,
// de maandag wordt automatisch berekend)
//
// LET OP: dit endpoint geeft ALLE details terug (klant, notitie, bedrag).
// De redactie voor de "gast"-rol (privé => enkel "bezet" tonen) gebeurt
// bewust in de front-end van de back-end (pages/backend/index.js) zodat de
// rolwissel in de demo meteen zichtbaar is — in productie moet dit ook
// serverside afgedwongen worden zodra er echte authenticatie/rollen zijn.
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const week = req.query.week || toISODate(new Date());
  const monday = mondayOfISO(week);
  const events = await store.getWeekSessions(monday);
  res.status(200).json({ monday, events });
}
