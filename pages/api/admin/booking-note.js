const store = require("../../../lib/store-sql");
const { requireStaff } = require("../../../lib/auth");

// POST /api/admin/booking-note
// body: { bookingId, note }
//
// Bewaart of wijzigt de notitie bij een boeking. De klant kan er zelf een
// meegeven bij het boeken; hiermee kan het team er ook eentje bijzetten of
// aanpassen ("belt terug", "brengt eigen canvas mee", ...).
//
// De notitie is zichtbaar in de weekagenda, de PDF-export en de interne
// bevestigingsmail — dus geen plek voor gevoelige gegevens.
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
    const { bookingId, note } = req.body || {};
    if (!bookingId) return res.status(400).json({ error: "bookingId is verplicht." });
    const result = await store.updateBookingNote(bookingId, note);
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
