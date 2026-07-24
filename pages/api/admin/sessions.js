const store = require("../../../lib/store-sql");
const { mondayOfISO, toISODate } = require("../../../lib/dateUtils");
const { requireStaff } = require("../../../lib/auth");

// GET /api/admin/sessions?week=2026-08-03  (elke datum in die week is prima,
// de maandag wordt automatisch berekend)
//
// Privé-items (persoonlijke afspraken, bv. "Dokter") worden hier serverside
// geredigeerd voor de "gast"-rol — enkel "Bezet"/"Privé" te zien, nooit de
// echte titel — vóór de data de server verlaat. De front-end (pages/backend/
// index.js) toont enkel wat ze effectief ontvangt; ze kan dus niet "om de
// redactie heen" iets tonen dat nooit verzonden werd.
function redactForGuest(ev) {
  if (ev.visibility !== "private") return ev;
  if (ev.kind === "personal") {
    return { kind: "personal", dateISO: ev.dateISO, start: ev.start, end: ev.end, status: ev.status, visibility: ev.visibility, redacted: true };
  }
  return { kind: "service", service: ev.service, dateISO: ev.dateISO, start: ev.start, durationMin: ev.durationMin, status: ev.status, visibility: ev.visibility, redacted: true };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const session = requireStaff(req, res);
  if (!session) return;

  const week = req.query.week || toISODate(new Date());
  const monday = mondayOfISO(week);
  const events = await store.getWeekSessions(monday);
  const finalEvents = session.role === "guest" ? events.map(redactForGuest) : events;
  res.status(200).json({ monday, events: finalEvents, role: session.role });
}
