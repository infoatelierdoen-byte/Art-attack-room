// Billit-koppeling nakijken vanaf de commandolijn.
//
//   node scripts/billit-controle.js          echt verzoek naar Billit
//   node scripts/billit-controle.js --droog  toont enkel wat er verstuurd ZOU worden
//
// Leest de sleutels uit .env.local. Voor dezelfde controle vanuit de
// backoffice: "Meer acties" -> "Facturatie nakijken (Billit)".
//
// Let op: dit maakt een echte factuur aan in de omgeving waar BILLIT_API_BASE
// naar wijst. Op de sandbox is dat onschuldig, op productie niet.
{
  const fs = require("fs");
  for (const regel of fs.readFileSync(require("path").join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
    const m = regel.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
// De sandbox is vanuit deze omgeving niet bereikbaar (netwerkregels), dus
// onderscheppen we het verzoek en tonen we exact wat er naar Billit zou gaan.
const droogloop = process.argv.includes("--droog");
if (droogloop) {
  global.fetch = async (url, opties) => {
    console.log("URL:", url);
    console.log("HEADERS:", JSON.stringify(Object.keys(opties.headers)));
    console.log("BODY:", JSON.stringify(JSON.parse(opties.body), null, 2));
    return { ok: true, status: 200, text: async () => JSON.stringify({ OrderID: 999999 }) };
  };
}
const billit = require("../lib/billit");
(async () => {
  console.log("OMGEVING:", billit.BASE_URL);
  console.log("GECONFIGUREERD:", billit.isConfigured());
  const vandaag = new Date().toISOString().slice(0, 10);
  try {
    const r = await billit.createSalesInvoice({
      bookingId: "TESTPROBE",
      orderDate: vandaag,
      description: `TESTFACTUUR koppeling — ${vandaag}`,
      amountIncl: 120,
      customerName: "TEST — Atelier Doen",
      customerEmail: "info.atelierdoen@gmail.com",
      customerPhone: null,
      invoiceCompanyName: "TEST — Atelier Doen",
      invoiceVatNumber: "BE0123456749"
    });
    console.log("RESULTAAT: gelukt, OrderID =", JSON.stringify(r.orderId));
    console.log("RUW:", JSON.stringify(r.raw).slice(0, 400));
  } catch (e) {
    console.log("RESULTAAT: mislukt —", e.message.slice(0, 500));
  }
})();
