const store = require("../../lib/store-sql");

// POST /api/bookings
// body: { serviceCode, dateISO, start, partySize, customer:{name,email,phone,birthDate},
//         note, termsAccepted, marketingOptIn, applyLoyaltyDiscount,
//         invoiceRequested, invoiceDetails }
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { booking, payment } = await store.createBooking(req.body);

    // TODO productie: bevestigingsmail (incl. notitie) naar
    // info.atelierdoen@gmail.com pas versturen via de Mollie-webhook zodra
    // de betaling effectief bevestigd is (zie pages/api/mollie-webhook.js).

    res.status(201).json({
      bookingId: booking.id,
      amountDue: booking.amountDue,
      checkoutUrl: payment.checkoutUrl,
      mocked: !!payment.mocked
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
