const store = require("../../lib/store-sql");
const mollie = require("../../lib/mollie");

// POST /api/mollie-webhook — Mollie roept dit aan bij elke statuswijziging
// van een betaling. De echte Mollie stuurt hier ENKEL het payment-ID naartoe
// (form-urlencoded, veld "id") — nooit onze eigen bookingId. Next.js'
// ingebouwde bodyParser ontleedt zowel JSON als x-www-form-urlencoded
// automatisch op basis van de Content-Type header, dus req.body.id werkt
// in beide gevallen.
//
// De bookingId halen we dus altijd op via Mollie zelf (payment.metadata),
// nooit vertrouwen op wat in de inkomende request zelf zou staan — dat zou
// door eender wie vervalst kunnen worden.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { id } = req.body || {};
  if (!id) {
    return res.status(400).json({ error: "Geen payment-ID meegegeven." });
  }

  try {
    const payment = await mollie.getPaymentStatus(id);
    const meta = payment.metadata || {};

    if (payment.status === "paid" && meta.giftCardPurchase) {
      // Aankoop van een cadeaubon (niet gekoppeld aan een boeking) — de
      // gift_cards-rij (met gegenereerde code) wordt hier pas aangemaakt,
      // en fulfillGiftCardPurchase() is zelf idempotent (mollie_payment_id
      // als unieke sleutel) mocht Mollie deze webhook dubbel afvuren.
      await store.fulfillGiftCardPurchase({
        amount: meta.amount,
        purchaserName: meta.purchaserName,
        purchaserEmail: meta.purchaserEmail,
        recipientNote: meta.recipientNote,
        molliePaymentId: payment.id
      });
    } else if (payment.status === "paid" && meta.bookingId) {
      await store.markBookingPaid(meta.bookingId);
      // De bevestigingsmail (klant + team), de Billit-factuur (bij "ik
      // wens een factuur"), en het afschrijven van een eventueel gebruikte
      // cadeaubon gebeuren alle drie automatisch binnen markBookingPaid(),
      // zie lib/store-sql.js.
      // TODO productie: loyaltypunten (+10) toekennen via Wix Members/Loyalty Program.
    }
    res.status(200).json({ received: true });
  } catch (err) {
    // Mollie verwacht bij een mislukte verwerking toch een 200, anders blijft
    // het retries sturen voor iets dat aan onze kant structureel faalt — hier
    // bewust 200 + gelogde fout i.p.v. 400, zodat Mollie's retry-mechanisme
    // niet nodeloos blijft proberen op een permanente fout.
    console.error("Mollie-webhook fout:", err.message);
    res.status(200).json({ received: true, error: err.message });
  }
}
