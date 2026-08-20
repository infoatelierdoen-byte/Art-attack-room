const store = require("../../../lib/store-sql");
const { requireStaff } = require("../../../lib/auth");
const { mondayOfISO, toISODate, addDaysISO } = require("../../../lib/dateUtils");
const { bouwRijen, bouwCsv } = require("../../../lib/agendaExport");

// GET /api/admin/agenda-export?week=2026-08-17[&weken=4][&alleen=geboekt]
//
// De agenda als CSV — rijen en kolommen, opgebouwd zoals de Wix-boekingslijst
// (Robin, aug 2026). Eén rij per room per tijdslot, met een kolom "Status"
// (Geboekt / Vrij / Gesloten) om in Excel op te filteren. De opbouw van de
// rijen zelf staat in lib/agendaExport.js, zodat de test die kan nakijken.
//
//   weken=4          exporteer 4 weken vanaf die maandag (standaard 1, max 26)
//   alleen=geboekt   laat de vrije en gesloten rijen weg
//
// Enkel Admin: het bestand bevat klantnamen, e-mailadressen en bedragen.
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const session = requireStaff(req, res);
  if (!session) return;
  if (session.role !== "admin") {
    return res.status(403).json({ error: "Enkel toegankelijk voor Admin." });
  }

  try {
    const week = req.query.week || toISODate(new Date());
    const eersteMaandag = mondayOfISO(week);
    const aantalWeken = Math.min(Math.max(parseInt(req.query.weken, 10) || 1, 1), 26);
    const alleenGeboekt = req.query.alleen === "geboekt";
    const laatsteDag = addDaysISO(eersteMaandag, aantalWeken * 7 - 1);

    const [rooms, data] = await Promise.all([
      store.getRoomsList(),
      store.getAgendaExportRows(eersteMaandag, laatsteDag)
    ]);

    const csv = bouwCsv(bouwRijen({ ...data, rooms, alleenGeboekt }));
    const naam = aantalWeken === 1
      ? `agenda-week-${eersteMaandag}.csv`
      : `agenda-${eersteMaandag}-tot-${laatsteDag}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${naam}"`);
    // BOM zodat Excel de accenten (é, ë) correct toont in plaats van Ã©.
    res.status(200).send("﻿" + csv);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
