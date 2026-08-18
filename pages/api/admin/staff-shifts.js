const store = require("../../../lib/store-sql");
const { mondayOfISO, toISODate } = require("../../../lib/dateUtils");
const { requireStaff } = require("../../../lib/auth");

// GET  /api/admin/staff-shifts?week=2026-08-03  (elke datum in die week is
//      prima, de maandag wordt automatisch berekend) -> { monday, shifts }
// POST /api/admin/staff-shifts  body: { dateISO, staffName, start, end, note }
//
// Personeelsplanning: wie werkt wanneer, van/tot hoe laat — bewust volledig
// los van de login/staff_users (geen account per medewerker nodig om in het
// rooster te verschijnen). Zichtbaar voor zowel admin als gast (net als de
// rest van de agenda), zie pages/backend/index.js. Zie lib/store-sql.js:
// getStaffShifts() / addStaffShift().
export default async function handler(req, res) {
  const session = requireStaff(req, res);
  if (!session) return;

  if (req.method === "GET") {
    const week = req.query.week || toISODate(new Date());
    const monday = mondayOfISO(week);
    const shifts = await store.getStaffShifts(monday);
    return res.status(200).json({ monday, shifts });
  }

  if (req.method === "POST") {
    const { dateISO, staffName, start, end, note } = req.body || {};
    try {
      const shift = await store.addStaffShift({ dateISO, staffName, start, end, note });
      return res.status(200).json(shift);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
