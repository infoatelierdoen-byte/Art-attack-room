const store = require("../../../lib/store-sql");
const { requireStaff } = require("../../../lib/auth");

// POST /api/admin/extra-session
// body: { serviceCode, dateISO, start, capacity (optioneel) }
//
// Voegt een eenmalige, extra sessie toe buiten het vaste uurrooster om —
// bv. een extra Fluid Art-sessie de week nadien omdat de normale sessie
// volzet zit. Verschijnt meteen als boekbaar tijdstip in de klant-widget.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!requireStaff(req, res)) return;

  try {
    const session = await store.addExtraSession(req.body);
    res.status(201).json(session);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
