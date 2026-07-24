const store = require("../../../lib/store-sql");
const { requireStaff } = require("../../../lib/auth");

// POST /api/admin/personal — voegt een persoonlijke afspraak toe (bv.
// "Dokter"). Altijd privé, nooit een klant of prijs — zie
// schema-boekingssysteem.sql (kind = 'personal').
// body: { title, dateISO, start, end }
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!requireStaff(req, res)) return;

  try {
    const appt = await store.addPersonalAppointment(req.body);
    res.status(201).json({ appointment: appt });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
