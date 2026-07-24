const store = require("../../../lib/store-sql");

// POST /api/gift-cards/purchase
// body: { amount, purchaser: { name, email, note } }
// Maakt enkel de Mollie-betaling aan — de gift_cards-rij zelf (met de
// effectieve code) wordt pas aangemaakt zodra de betaling bevestigd is, zie
// pages/api/mollie-webhook.js -> store.fulfillGiftCardPurchase().
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { amount, purchaser } = req.body;
    const { payment } = await store.createGiftCardPurchase({ amount, purchaser });
    res.status(201).json({
      checkoutUrl: payment.checkoutUrl,
      mocked: !!payment.mocked
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
