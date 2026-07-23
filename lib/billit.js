// Billit-koppeling: maakt een verkoopfactuur aan via POST /v1/orders.
// Documentatie: https://docs.billit.be/docs/create-first-invoice
//
// Auth: dit is een niet-commerciële integratie (automatiseert enkel de
// eigen administratie van Art Attack Room, wordt niet doorverkocht aan
// derden) — daarom volstaat de eenvoudige ApiKey + PartyID header-auth,
// geen OAuth nodig (zie https://docs.billit.be/docs/partyid-and-key).
//
// BELANGRIJK: sandbox (api.sandbox.billit.be) en productie (api.billit.be)
// hebben elk hun EIGEN ApiKey en PartyID. Welke omgeving gebruikt wordt,
// hangt volledig af van BILLIT_API_BASE in .env.local — nooit hardcoded.

const BASE_URL = process.env.BILLIT_API_BASE || "https://api.sandbox.billit.be";
const API_KEY = process.env.BILLIT_API_KEY;
const PARTY_ID = process.env.BILLIT_PARTY_ID;
const VAT_PERCENTAGE = Number(process.env.BILLIT_VAT_PERCENTAGE || 21);

function isConfigured() {
  return !!API_KEY && !!PARTY_ID;
}

/**
 * Bouwt de Billit Customer-sectie.
 * - Met bedrijfsgegevens (BTW-nummer ingevuld bij "ik wens een factuur"):
 *   een normale bedrijfsklant, VATLiable true.
 * - Zonder bedrijfsgegevens: een privépersoon, zoals beschreven in
 *   https://docs.billit.be/docs/customer-is-private-person — geen
 *   BTW-nummer, VATLiable false. Naam + e-mail (uniek) volstaan om
 *   dubbele klanten in Billit te vermijden.
 */
function buildCustomer({ name, email, phone, companyName, vatNumber }) {
  if (vatNumber) {
    return {
      PartyType: "Customer",
      Name: companyName || name,
      VATNumber: vatNumber,
      Email: email,
      Phone: phone || undefined,
      Language: "NL",
      CountryCode: "BE",
      VATLiable: true
    };
  }
  return {
    PartyType: "Customer",
    Name: name,
    Email: email,
    Phone: phone || undefined,
    Language: "NL",
    CountryCode: "BE",
    VATLiable: false
  };
}

/**
 * Rekent een BTW-inclusief bedrag terug naar het nettobedrag (excl. BTW)
 * dat Billit per regel verwacht. Onze prijzen (widget, prijstrap) zijn
 * altijd BTW-inclusief.
 */
function toExclVat(amountIncl, vatPercentage = VAT_PERCENTAGE) {
  return Math.round((amountIncl / (1 + vatPercentage / 100)) * 10000) / 10000;
}

/**
 * Lage-niveau POST naar /v1/orders — gedeeld door createSalesInvoice
 * (1 lijn, per boeking) en createSummaryInvoice (meerdere lijnen, de
 * wekelijkse verzamelfactuur).
 * @returns {Promise<{orderId: string|number, raw: any}>}
 */
async function postOrder(body) {
  if (!isConfigured()) {
    throw new Error(
      "Billit is niet geconfigureerd — BILLIT_API_KEY en BILLIT_PARTY_ID ontbreken in .env.local."
    );
  }

  const res = await fetch(`${BASE_URL}/v1/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ApiKey: API_KEY,
      PartyID: PARTY_ID
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }

  if (!res.ok) {
    const message =
      (parsed && parsed.errors && parsed.errors[0] && parsed.errors[0].Description) ||
      text ||
      `Billit gaf status ${res.status} terug`;
    throw new Error(`Billit-fout: ${message}`);
  }

  // De docs beschrijven de response als "INT (Unique OrderID)" — in de
  // praktijk soms een kaal getal, soms een object. Beide opvangen.
  const orderId = typeof parsed === "object" && parsed !== null
    ? (parsed.OrderID ?? parsed.id ?? parsed.Id ?? parsed)
    : parsed;

  return { orderId, raw: parsed };
}

/**
 * Maakt een verkoopfactuur aan voor 1 boeking. amountIncl is het bedrag
 * zoals de klant het betaald heeft (BTW inbegrepen) — wordt hier
 * teruggerekend naar het nettobedrag dat Billit verwacht.
 *
 * @returns {Promise<{orderId: string|number, raw: any}>}
 */
async function createSalesInvoice({
  bookingId, orderDate, description, amountIncl,
  customerName, customerEmail, customerPhone,
  invoiceCompanyName, invoiceVatNumber
}) {
  const body = {
    OrderType: "Invoice",
    OrderDirection: "Income",
    OrderNumber: `AAR-${String(bookingId).slice(0, 8)}`,
    OrderDate: orderDate, // "YYYY-MM-DD"
    ExpiryDate: orderDate, // al betaald via Mollie vóór de factuur gemaakt wordt
    Customer: buildCustomer({
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
      companyName: invoiceCompanyName,
      vatNumber: invoiceVatNumber
    }),
    OrderLines: [
      {
        Quantity: 1,
        UnitPriceExcl: toExclVat(amountIncl),
        Description: description,
        VATPercentage: VAT_PERCENTAGE
      }
    ]
  };

  return postOrder(body);
}

/**
 * Maakt de wekelijkse verzamelfactuur aan: 1 factuur met 1 lijn per dienst,
 * voor de omzet van boekingen die NIET al individueel gefactureerd werden
 * (zie lib/store-sql.js: generateWeeklyRevenueInvoice). Er is geen echte
 * klant aan gekoppeld — dit is een interne boekhoudkundige registratie van
 * de kassa-/particuliere omzet, vandaar de vaste generieke "klant".
 *
 * @param {{orderNumber:string, periodStartISO:string, periodEndISO:string,
 *           lines: Array<{label:string, amountIncl:number, count:number}>}} params
 * @returns {Promise<{orderId: string|number, raw: any}>}
 */
async function createSummaryInvoice({ orderNumber, periodStartISO, periodEndISO, lines }) {
  const body = {
    OrderType: "Invoice",
    OrderDirection: "Income",
    OrderNumber: orderNumber,
    OrderDate: periodEndISO,
    ExpiryDate: periodEndISO,
    Customer: {
      PartyType: "Customer",
      Name: "Particuliere klanten — kassaomzet",
      Language: "NL",
      CountryCode: "BE",
      VATLiable: false
    },
    OrderLines: lines.map(line => ({
      Quantity: 1,
      UnitPriceExcl: toExclVat(line.amountIncl),
      Description: `${line.label} — week ${periodStartISO} t.e.m. ${periodEndISO} (${line.count} boeking${line.count === 1 ? "" : "en"})`,
      VATPercentage: VAT_PERCENTAGE
    }))
  };

  return postOrder(body);
}

module.exports = { createSalesInvoice, createSummaryInvoice, isConfigured, BASE_URL, toExclVat };
