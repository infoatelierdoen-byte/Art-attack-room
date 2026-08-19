const store = require("../../lib/store-sql");

// POST /api/bookings
// body: { serviceCode, dateISO, start, partySize, customer:{name,email,phone,birthDate},
//         note, termsAccepted, marketingOptIn,
//         invoiceRequested, invoiceDetails, giftCardCode }
//
// Let op: kortingen mogen NOOIT uit deze body komen. Hier stond eerder een
// applyLoyaltyDiscount-vlag die ongecontroleerd 10% korting gaf aan wie ze zelf
// meestuurde. Komt er een loyaliteitssysteem, bepaal de korting dan serverside
// uit de klantgeschiedenis.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { booking, payment } = await store.createBooking(req.body);

    res.status(201).json({
      bookingId: booking.id,
      amountDue: booking.amountDue,
      checkoutUrl: payment.checkoutUrl,
      mocked: !!payment.mocked,
      coveredByGiftCard: !!payment.coveredByGiftCard
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
