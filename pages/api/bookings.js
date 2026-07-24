const store = require("../../lib/store-sql");

// POST /api/bookings
// body: { serviceCode, dateISO, start, partySize, customer:{name,email,phone,birthDate},
//         note, termsAccepted, marketingOptIn, applyLoyaltyDiscount,
//         invoiceRequested, invoiceDetails, giftCardCode }
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
