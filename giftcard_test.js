process.env.TZ = "Europe/Brussels";

const path = require("path");
const fs = require("fs");
const EmbeddedPostgres = require("embedded-postgres").default || require("embedded-postgres");

const PROJECT = __dirname;
const DATA_DIR = "/tmp/embedded-pg-data-giftcard";

function log(label, ok, extra) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}${extra ? " :: " + extra : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: "postgres",
    password: "postgres",
    port: 54329,
    persistent: false
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase("booking_test");

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:54329/booking_test`;

  try {
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    const schemaSql = fs.readFileSync(path.join(PROJECT, "db/schema.sql"), "utf8");
    await pool.query(schemaSql);
    console.log("Schema loaded OK.");

    const seedSql = fs.readFileSync(path.join(PROJECT, "db/seed.sql"), "utf8");
    await pool.query(seedSql);
    console.log("Seed loaded OK.");

    const importSql = fs.readFileSync(path.join(PROJECT, "db/import-gift-cards.sql"), "utf8");
    await pool.query(importSql);
    const { rows: countRows } = await pool.query("SELECT COUNT(*)::int AS cnt FROM gift_cards");
    log("Import script inserts gift cards", countRows[0].cnt > 300, `count=${countRows[0].cnt}`);

    // Fresh pg module cache so lib/db.js picks up DATABASE_URL set above.
    delete require.cache[require.resolve(path.join(PROJECT, "lib/db.js"))];
    delete require.cache[require.resolve(path.join(PROJECT, "lib/store-sql.js"))];
    const store = require(path.join(PROJECT, "lib/store-sql.js"));

    // Sanity: Fluid Art price is 60 now.
    const services = await store.getServices();
    const fluid = services.find(s => s.code === "fluid_art");
    log("Fluid Art price is 60/person", fluid && fluid.pricePerPerson === 60, JSON.stringify(fluid));

    // --- Test 1: manual gift card, fully covers a booking (immediate paid, no Mollie) ---
    // €150 op de bon: Action Painting 2p (€120) volledig dekken, dan blijft
    // €30 over voor een gedeeltelijke dekking van de Fluid Art-boeking verderop.
    const card1 = await store.createManualGiftCard({
      amount: 150, purchaserName: "Test Koper", purchaserEmail: "koper@test.be", note: "test"
    });
    log("createManualGiftCard returns active card w/ code", card1.status === "active" && /^AAR-/.test(card1.code), card1.code);

    // Find a bookable Action Painting slot in the near future.
    const today = new Date();
    let bookingDateISO = null, bookingSlot = null;
    for (let i = 1; i <= 21 && !bookingSlot; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const avail = await store.getAvailability("action_painting", iso, 2);
      const bookable = avail.find(s => s.bookable);
      if (bookable) { bookingDateISO = iso; bookingSlot = bookable.start; }
    }
    log("Found a bookable Action Painting slot", !!bookingSlot, `${bookingDateISO} ${bookingSlot}`);

    const { booking: b1, payment: p1 } = await store.createBooking({
      serviceCode: "action_painting", dateISO: bookingDateISO, start: bookingSlot, partySize: 2,
      customer: { name: "Klant Een", email: "klant1@test.be", phone: "0470000001", birthDate: "1990-01-01" },
      note: "", termsAccepted: true, marketingOptIn: false,
      giftCardCode: card1.code
    });
    log("Booking fully covered by gift card => amountDue 0", b1.amountDue === 0, `amountDue=${b1.amountDue}`);
    log("Payment marked coveredByGiftCard, no checkout needed", p1.coveredByGiftCard === true && p1.checkoutUrl === null);

    const { rows: cardAfter1 } = await pool.query("SELECT * FROM gift_cards WHERE id = $1", [card1.id]);
    log("Gift card balance deducted immediately (150 -> 30)", Number(cardAfter1[0].remaining_amount) === 30, cardAfter1[0].remaining_amount);
    log("Gift card still active (not depleted)", cardAfter1[0].status === "active");

    const { rows: bookingRow1 } = await pool.query("SELECT * FROM bookings WHERE id = $1", [b1.id]);
    log("Booking payment_status is paid", bookingRow1[0].payment_status === "paid");
    log("Booking gift_card_redeemed_at is set", !!bookingRow1[0].gift_card_redeemed_at);

    const { rows: redemptions1 } = await pool.query("SELECT * FROM discount_redemptions WHERE booking_id = $1", [b1.id]);
    log("discount_redemptions row created (gift_voucher, €120)", redemptions1.length === 1 && redemptions1[0].type === "gift_voucher" && Number(redemptions1[0].amount) === 120, JSON.stringify(redemptions1[0]));

    // --- Test 2: partial coverage, deferred redemption via markBookingPaid ---
    let bookingDateISO2 = null, bookingSlot2 = null;
    for (let i = 1; i <= 21 && !bookingSlot2; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      if (iso === bookingDateISO) continue;
      const avail = await store.getAvailability("fluid_art", iso, 2);
      const bookable = avail.find(s => s.bookable);
      if (bookable) { bookingDateISO2 = iso; bookingSlot2 = bookable.start; }
    }
    log("Found a bookable Fluid Art slot", !!bookingSlot2, `${bookingDateISO2} ${bookingSlot2}`);

    // Fluid Art @ 60/person x 2 = 120. Card1 has 40 left -> partial coverage, 80 due via Mollie.
    const { booking: b2, payment: p2 } = await store.createBooking({
      serviceCode: "fluid_art", dateISO: bookingDateISO2, start: bookingSlot2, partySize: 2,
      customer: { name: "Klant Twee", email: "klant2@test.be", phone: "0470000002", birthDate: "1990-01-01" },
      note: "", termsAccepted: true, marketingOptIn: false,
      giftCardCode: card1.code
    });
    log("Partial coverage: amountDue = 90 (120 - 30 remaining)", b2.amountDue === 90, `amountDue=${b2.amountDue}`);
    log("Mollie payment created (mock) for remainder", !!p2.id && !!p2.checkoutUrl);

    const { rows: cardAfter2 } = await pool.query("SELECT * FROM gift_cards WHERE id = $1", [card1.id]);
    log("Gift card NOT yet deducted before payment confirmation (still 30)", Number(cardAfter2[0].remaining_amount) === 30);

    const { rows: bookingRow2 } = await pool.query("SELECT * FROM bookings WHERE id = $1", [b2.id]);
    log("Booking2 payment_status still pending", bookingRow2[0].payment_status === "pending");
    log("Booking2 has gift_card_amount stored for deferred redemption", Number(bookingRow2[0].gift_card_amount) === 30);

    // Now confirm payment (as the Mollie webhook would).
    await store.markBookingPaid(b2.id);

    const { rows: cardAfter3 } = await pool.query("SELECT * FROM gift_cards WHERE id = $1", [card1.id]);
    log("Gift card depleted after markBookingPaid (30 -> 0)", Number(cardAfter3[0].remaining_amount) === 0, cardAfter3[0].remaining_amount);
    log("Gift card status flipped to depleted", cardAfter3[0].status === "depleted", cardAfter3[0].status);

    // Idempotency: calling markBookingPaid again must not double-deduct.
    await store.markBookingPaid(b2.id);
    const { rows: cardAfter4 } = await pool.query("SELECT * FROM gift_cards WHERE id = $1", [card1.id]);
    log("Idempotent: repeated markBookingPaid does not go negative", Number(cardAfter4[0].remaining_amount) === 0);
    const { rows: redemptions2 } = await pool.query("SELECT * FROM discount_redemptions WHERE booking_id = $1", [b2.id]);
    log("Idempotent: exactly one redemption row for booking2", redemptions2.length === 1, redemptions2.length);

    // Nieuwe, nog volledig vrije dag/slot voor de resterende validatietests
    // (los van bookingDateISO/bookingDateISO2, die al bezet zijn).
    let bookingDateISO3 = null, bookingSlot3 = null;
    for (let i = 1; i <= 28 && !bookingSlot3; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      if (iso === bookingDateISO || iso === bookingDateISO2) continue;
      const avail = await store.getAvailability("fluid_art", iso, 1);
      const bookable = avail.find(s => s.bookable);
      if (bookable) { bookingDateISO3 = iso; bookingSlot3 = bookable.start; }
    }
    log("Found a third, fresh bookable slot for validation tests", !!bookingSlot3, `${bookingDateISO3} ${bookingSlot3}`);

    // --- Test 3: depleted card can no longer be used ---
    let threw = false;
    try {
      await store.createManualBooking({
        serviceCode: "fluid_art", dateISO: bookingDateISO3, start: bookingSlot3,
        partySize: 1, customer: { name: "X", email: "x@test.be" }, giftCardCode: card1.code
      });
    } catch (err) {
      // Een opgebruikte kaart heeft status 'depleted' (niet 'active'), dus
      // de status-check in validateGiftCard() vuurt vóór de saldo-check --
      // beide foutmeldingen zijn hier een geldige afwijzing.
      threw = /saldo|actief/.test(err.message);
    }
    log("Depleted card rejected on reuse", threw);

    // --- Test 4: disabled card rejected ---
    const card2 = await store.createManualGiftCard({ amount: 30 });
    await store.setGiftCardStatus(card2.id, "disabled");
    let threw2 = false;
    try {
      await store.createManualBooking({
        serviceCode: "fluid_art", dateISO: bookingDateISO3, start: bookingSlot3,
        partySize: 1, customer: { name: "Y", email: "y@test.be" }, giftCardCode: card2.code
      });
    } catch (err) {
      threw2 = /actief/.test(err.message);
    }
    log("Disabled card rejected", threw2);

    // Re-enable and confirm it works again.
    const reactivated = await store.setGiftCardStatus(card2.id, "active");
    log("Card can be reactivated", reactivated.status === "active");

    // --- Test 5: unknown code rejected ---
    let threw3 = false;
    try {
      await store.createManualBooking({
        serviceCode: "fluid_art", dateISO: bookingDateISO3, start: bookingSlot3,
        partySize: 1, customer: { name: "Z", email: "z@test.be" }, giftCardCode: "AAR-NOPE0000"
      });
    } catch (err) {
      threw3 = /niet gekend/.test(err.message);
    }
    log("Unknown gift card code rejected", threw3);

    // --- Test 6: search ---
    const searchByCode = await store.searchGiftCards(card1.code);
    log("Search by exact code finds card1", searchByCode.some(c => c.id === card1.id));
    const searchByName = await store.searchGiftCards("Test Koper");
    log("Search by purchaser name finds card1", searchByName.some(c => c.id === card1.id));
    const searchImported = await store.searchGiftCards("");
    log("Search with empty query returns recent list (<=100)", searchImported.length <= 100 && searchImported.length > 0, searchImported.length);

    // --- Test 7: online purchase flow (mock Mollie) + webhook fulfillment ---
    const { payment: purchasePayment } = await store.createGiftCardPurchase({
      amount: 45, purchaser: { name: "Online Koper", email: "online@test.be", note: "voor Marie" }
    });
    log("Gift card purchase creates a mock Mollie payment", !!purchasePayment.id && !!purchasePayment.checkoutUrl);

    const mollie = require(path.join(PROJECT, "lib/mollie.js"));
    const purchaseStatus = await mollie.getPaymentStatus(purchasePayment.id);
    const fulfilled = await store.fulfillGiftCardPurchase({
      amount: purchaseStatus.metadata.amount,
      purchaserName: purchaseStatus.metadata.purchaserName,
      purchaserEmail: purchaseStatus.metadata.purchaserEmail,
      recipientNote: purchaseStatus.metadata.recipientNote,
      molliePaymentId: purchaseStatus.id
    });
    log("Fulfilled purchase creates a new active gift card", fulfilled.status === "active" && Number(fulfilled.initial_amount) === 45, fulfilled.code);

    // Idempotency: fulfilling twice must not create a duplicate card.
    const fulfilledAgain = await store.fulfillGiftCardPurchase({
      amount: purchaseStatus.metadata.amount,
      purchaserName: purchaseStatus.metadata.purchaserName,
      purchaserEmail: purchaseStatus.metadata.purchaserEmail,
      recipientNote: purchaseStatus.metadata.recipientNote,
      molliePaymentId: purchaseStatus.id
    });
    log("Idempotent: repeated webhook does not duplicate the card", fulfilledAgain.id === fulfilled.id);
    const { rows: dupCheck } = await pool.query("SELECT COUNT(*)::int AS cnt FROM gift_cards WHERE mollie_payment_id = $1", [purchaseStatus.id]);
    log("Exactly one gift_cards row per mollie_payment_id", dupCheck[0].cnt === 1, dupCheck[0].cnt);

    // --- Test 8: expiry default is ~1 year out ---
    const created = new Date(fulfilled.created_at);
    const expires = new Date(fulfilled.expires_at);
    const days = Math.round((expires - created) / 86400000);
    log("New gift card expires ~1 year later", days >= 360 && days <= 370, `days=${days}`);

    await pool.end();
    // lib/db.js houdt zijn eigen (singleton) pool bij — die moet ook netjes
    // sluiten vóór de embedded Postgres-server stopt, anders gooit de
    // achterliggende `pg`-Pool een onafgevangen 'error'-event zodra de
    // server de resterende verbindingen hard afsluit.
    const dbModule = require(path.join(PROJECT, "lib/db.js"));
    const internalPool = await dbModule.getPool();
    await internalPool.end();
    console.log("\nAll gift card tests executed.");
  } finally {
    await pg.stop();
  }
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
