const billit = require("../../../lib/billit");
const { requireStaff } = require("../../../lib/auth");
const { toISODate } = require("../../../lib/dateUtils");

// Billit-koppeling nakijken vanuit de backoffice.
//
//   GET  /api/admin/billit-test    zegt of de sleutels ingesteld zijn en op
//                                  welke omgeving ze wijzen. Raakt Billit niet aan.
//   POST /api/admin/billit-test    maakt een echte testfactuur van €1 aan en
//                                  geeft het factuurnummer terug.
//
// Waarom dit bestaat: "er komt geen factuur in Billit" kan drie dingen
// betekenen — de sleutels ontbreken, ze wijzen naar de verkeerde omgeving, of
// Billit weigert de factuur. Een testboeking maken om dat te weten te komen is
// omslachtig (en laat rommel achter in de agenda). Deze knop zegt het meteen.
//
// Enkel Admin: de sleutels zijn bedrijfsgegevens en een POST maakt een echt
// document aan.
export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const session = requireStaff(req, res);
  if (!session) return;
  if (session.role !== "admin") {
    return res.status(403).json({ error: "Enkel toegankelijk voor Admin." });
  }

  const sandbox = /sandbox/i.test(billit.BASE_URL);
  const status = {
    geconfigureerd: billit.isConfigured(),
    omgeving: sandbox ? "sandbox" : "productie",
    basisUrl: billit.BASE_URL,
    btwPercentage: Number(process.env.BILLIT_VAT_PERCENTAGE || 21)
  };

  if (req.method === "GET") {
    return res.status(200).json(status);
  }

  if (!status.geconfigureerd) {
    return res.status(400).json({
      ...status,
      error: "BILLIT_API_KEY en/of BILLIT_PARTY_ID ontbreken in de omgevingsvariabelen."
    });
  }

  // Een testfactuur op de productie-omgeving is een ECHT document in de
  // boekhouding. Dat mag alleen als het uitdrukkelijk bevestigd wordt.
  if (!sandbox && req.body?.bevestigProductie !== true) {
    return res.status(400).json({
      ...status,
      error: "Dit wijst naar de PRODUCTIE-omgeving van Billit. Een testfactuur is daar een echt document."
    });
  }

  try {
    const vandaag = toISODate(new Date());
    const { orderId, raw } = await billit.createSalesInvoice({
      bookingId: `TEST${Date.now().toString().slice(-6)}`,
      orderDate: vandaag,
      description: `TESTFACTUUR — koppeling nakijken (${vandaag}). Geen echte boeking.`,
      amountIncl: 1,
      customerName: "TEST — Atelier Doen",
      customerEmail: "info.atelierdoen@gmail.com",
      customerPhone: null,
      invoiceCompanyName: "TEST — Atelier Doen",
      invoiceVatNumber: process.env.BILLIT_TEST_VAT_NUMBER || "BE0123456749"
    });
    res.status(200).json({ ...status, ok: true, orderId, raw });
  } catch (err) {
    res.status(502).json({ ...status, ok: false, error: err.message });
  }
}
