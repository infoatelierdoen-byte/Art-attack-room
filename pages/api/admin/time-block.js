const store = require("../../../lib/store-sql");
const { requireStaff } = require("../../../lib/auth");

// Tijdsblokken in de agenda — een eigen blok dat het team zelf inplant
// (bv. "Kamp voorbereiden"), zichtbaar in het paars.
//
//   POST   /api/admin/time-block   { title, dateISO, start, end }
//   PATCH  /api/admin/time-block   { id, title, dateISO, start, end }
//   DELETE /api/admin/time-block   { id }
//
// Een tijdsblok neemt bewust geen rooms in en blokkeert geen online
// boekingen (Robin, aug 2026) — daarvoor bestaat "Room(s) sluiten".
//
// Aanmaken en aanpassen mag elke medewerker, net als een persoonlijke
// afspraak. Verwijderen ook: er hangt geen klant, geld of boeking aan.
export default async function handler(req, res) {
  if (!["POST", "PATCH", "DELETE"].includes(req.method)) {
    res.setHeader("Allow", "POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!requireStaff(req, res)) return;

  try {
    if (req.method === "POST") {
      const blok = await store.addTimeBlock(req.body || {});
      return res.status(201).json({ block: blok });
    }
    if (req.method === "PATCH") {
      const { id, ...rest } = req.body || {};
      if (!id) return res.status(400).json({ error: "id is verplicht." });
      const blok = await store.updateTimeBlock(id, rest);
      return res.status(200).json({ block: blok });
    }
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "id is verplicht." });
    const result = await store.deleteTimeBlock(id);
    return res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
