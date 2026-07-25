const store = require("../../../lib/store-sql");
const { requireStaff } = require("../../../lib/auth");

function csvEscape(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

// GET /api/admin/customers-export
// CSV-download van klant-e-mailadressen verzameld via boekingen (widget +
// backoffice), beperkt tot wie toestemming gaf voor nieuws/promoties
// (marketing_opt_in). Bedoeld om samen te voegen met de Wix-abonneelijst
// voor een nieuwsbrief. Bevat persoonsgegevens — daarom enkel voor Admin,
// niet voor de Gast-rol.
export default async function handler(req, res) {
  const session = requireStaff(req, res);
  if (!session) return;
  if (session.role !== "admin") {
    return res.status(403).json({ error: "Enkel toegankelijk voor Admin." });
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const customers = await store.listMarketingEmails();
    const header = "naam,email,telefoon,klant_sinds";
    const lines = customers.map(c =>
      [c.name, c.email, c.phone || "", c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : ""]
        .map(csvEscape)
        .join(",")
    );
    const csv = [header, ...lines].join("\n");
    const today = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="aar-emaillijst-${today}.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}
