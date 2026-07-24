const store = require("../../../lib/store-sql");

// POST /api/admin/close-room
// body: { dateISO, start (optioneel), roomId (optioneel), allRooms (bool),
//         allDay (bool), reason }
//
// Sluit één room, of alle rooms (allRooms=true), voor één tijdslot (start)
// of de volledige dag (allDay=true) — enkel van toepassing op Art Attack
// Room (de enige dienst met roomtoewijzing). Zie lib/store-sql.js: closeRoom().
// Een room die al een klantboeking heeft voor dat tijdslot wordt nooit
// overschreven (ON CONFLICT DO NOTHING in closeRoom()).
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { dateISO, start, roomId, allRooms, allDay, reason } = req.body || {};
  if (!dateISO) {
    return res.status(400).json({ error: "Datum is verplicht." });
  }
  if (!allDay && !start) {
    return res.status(400).json({ error: "Kies een tijdstip, of vink 'hele dag' aan." });
  }
  if (!allRooms && !roomId) {
    return res.status(400).json({ error: "Kies een room, of vink 'alle rooms' aan." });
  }

  try {
    await store.closeRoom({ dateISO, start, roomId, allRooms: !!allRooms, allDay: !!allDay, reason });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
