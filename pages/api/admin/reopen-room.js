const store = require("../../../lib/store-sql");
const { requireStaff } = require("../../../lib/auth");

// POST /api/admin/reopen-room
// body: { dateISO, start, roomId, allRooms, allDay }
//
// Heft een room-sluiting weer op — de tegenhanger van /api/admin/close-room.
// Tot nu toe kon je een room wel dichtzetten maar niet meer openen; dat kon
// alleen rechtstreeks in de database.
//
// Raakt uitsluitend sluitingen (block_type = 'closed'). Een room die bezet is
// door een echte boeking komt hier niet vrij — die geef je vrij door de boeking
// te annuleren of te verplaatsen.
//
// Enkel Admin, net als het sluiten zelf.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const session = requireStaff(req, res);
  if (!session) return;
  if (session.role !== "admin") {
    return res.status(403).json({ error: "Enkel toegankelijk voor Admin." });
  }

  try {
    const { dateISO, start, roomId, allRooms, allDay } = req.body || {};
    const result = await store.reopenRoom({ dateISO, start, roomId, allRooms: !!allRooms, allDay: !!allDay });
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
