// Mollie-koppeling. Zonder MOLLIE_API_KEY (lokale ontwikkeling) wordt een
// mock-checkout teruggegeven zodat de volledige boekingsflow te testen is
// zonder een echte betaling. Met een echte key (test_... of live_...) wordt
// de officiële @mollie/api-client gebruikt.
//
// BELANGRIJK — hoe de Mollie-webhook werkt (zie ook pages/api/mollie-webhook.js):
// Mollie stuurt naar webhookUrl ENKEL het payment-ID toe (form-urlencoded,
// veld "id") — nooit onze eigen bookingId. Daarom wordt bookingId bij het
// aanmaken van de betaling meegegeven als `metadata`, en bij de webhook
// altijd opnieuw opgevraagd via getPaymentStatus(id).metadata.bookingId,
// nooit vertrouwd op wat in de webhook-request zelf zou staan.
//
// BELANGRIJK — lokaal testen: Mollie kan geen webhook naar localhost sturen.
// Met een echte (test_) API-key krijg je dus wel een echte test-checkout-URL,
// maar de webhook komt pas binnen zodra de app op een publiek bereikbaar
// adres draait (bv. via ngrok, of eenmaal live). Zie README.

const API_KEY = process.env.MOLLIE_API_KEY;
const hasRealKey = !!API_KEY;

// Enkel gebruikt in mock-modus (geen API-key): houdt de metadata per
// mock-betaling bij, zodat de webhook-simulatie dezelfde
// "haal metadata op via het payment-ID"-weg volgt als de echte Mollie-flow.
const mockPayments = new Map();

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    const { createMollieClient } = require("@mollie/api-client");
    clientPromise = createMollieClient({ apiKey: API_KEY });
  }
  return clientPromise;
}

// Zonder MOLLIE_API_KEY draait alles in mock-modus, en daar geeft
// getPaymentStatus() voor ELK id "paid" terug. Lokaal is dat handig; in
// productie zou het betekenen dat iedereen gratis boekt zodra die variabele
// wegvalt bij een redeploy. Vandaar deze harde stop bij het opstarten van een
// betaling.
function assertNotMockedInProduction() {
  if (!hasRealKey && process.env.NODE_ENV === "production") {
    throw new Error(
      "MOLLIE_API_KEY ontbreekt in productie. Betalingen worden geweigerd in " +
      "plaats van als 'betaald' behandeld — zet de sleutel in de Vercel-omgevingsvariabelen."
    );
  }
}

async function createPayment({ amount, description, redirectUrl, webhookUrl, metadata }) {
  assertNotMockedInProduction();
  if (!hasRealKey) {
    const mockId = "tr_mock_" + Math.random().toString(36).slice(2, 10);
    const separator = redirectUrl.includes("?") ? "&" : "?";
    mockPayments.set(mockId, { status: "paid", metadata }); // dev: meteen "betaald" bij opvragen
    return {
      id: mockId,
      status: "open",
      checkoutUrl: `${redirectUrl}${separator}mock_payment=${mockId}&amount=${amount.toFixed(2)}`,
      amount,
      description,
      mocked: true
    };
  }

  const client = getClient();
  const payment = await client.payments.create({
    amount: { currency: "EUR", value: amount.toFixed(2) }, // Mollie verwacht een string met 2 decimalen
    description,
    redirectUrl,
    webhookUrl,
    metadata
  });
  return { id: payment.id, status: payment.status, checkoutUrl: payment.getCheckoutUrl(), amount, description };
}

/**
 * Haalt de actuele status (+ metadata, incl. onze bookingId) rechtstreeks
 * bij Mollie op — nooit vertrouwen op statusinformatie die in een
 * inkomend verzoek zelf zou staan.
 */
async function getPaymentStatus(paymentId) {
  assertNotMockedInProduction();
  if (!hasRealKey) {
    // Let op de fallback naar "paid" voor een onbekend id: dat is precies wat
    // deze functie in productie levensgevaarlijk maakt, vandaar de check
    // hierboven. Lokaal is het bedoeld gedrag (mock_payment=... uit de widget).
    const mock = mockPayments.get(paymentId);
    return { id: paymentId, status: mock ? mock.status : "paid", metadata: mock ? mock.metadata : null };
  }
  const client = getClient();
  const payment = await client.payments.get(paymentId);
  return { id: payment.id, status: payment.status, metadata: payment.metadata };
}

module.exports = { createPayment, getPaymentStatus, hasRealKey };
