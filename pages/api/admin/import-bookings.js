const store = require("../../../lib/store-sql");
const { parseWixBookingsCsv } = require("../../../lib/wixImport");
const { requireStaff } = require("../../../lib/auth");

// POST /api/admin/import-bookings
// body: { csv: "<ruwe CSV-tekst>" }
//
// Importeert een Wix-boekingslijst (CSV-export) — blokkeert de betrokken
// tijdsloten in dit systeem (zodat er niet dubbel geboekt kan worden via de
// widget) en bouwt de klantendatabase op. Enkel Admin. Zie
// lib/wixImport.js (parsen) en lib/store-sql.js: importWixBooking().
export const config = {
  api: { bodyParser: { sizeLimit: "5mb" } }
};

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

  const { csv } = req.body || {};
  if (!csv || typeof csv !== "string") {
    return res.status(400).json({ error: "csv (tekst) is verplicht." });
  }

  let parsed;
  try {
    parsed = parseWixBookingsCsv(csv);
  } catch (err) {
    return res.status(400).json({ error: `Kon het CSV-bestand niet lezen: ${err.message}` });
  }

  // imported_new_session = geboekt, maar het tijdslot stond niet in het vaste
  // uurrooster en is als eenmalige sessie aangemaakt. Apart geteld zodat je na
  // de import ziet welke uren je nog moet nakijken.
  const results = { imported: 0, imported_new_session: 0, duplicate: 0, no_session: 0, full: 0, error: 0 };
  const details = [];

  for (const row of parsed.rows) {
    const outcome = await store.importWixBooking(row);
    results[outcome.status] = (results[outcome.status] || 0) + 1;
    if (outcome.status !== "imported") {
      details.push({
        line: row.sourceLine,
        customer: row.customer.name,
        dateISO: row.dateISO,
        start: row.start,
        status: outcome.status,
        message: outcome.message
      });
    }
  }

  res.status(200).json({
    totalRows: parsed.rows.length,
    parseErrors: parsed.parseErrors,
    results,
    details
  });
}
