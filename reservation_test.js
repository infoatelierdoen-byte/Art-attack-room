process.env.TZ = "Europe/Brussels";

const path = require("path");
const fs = require("fs");
const EmbeddedPostgres = require("embedded-postgres").default || require("embedded-postgres");

const PROJECT = __dirname;
const DATA_DIR = "/tmp/embedded-pg-data-reservation";

function log(label, ok, extra) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}${extra ? " :: " + extra : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR, user: "postgres", password: "postgres", port: 54331, persistent: false
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("booking_test2");
  process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:54331/booking_test2";

  try {
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(fs.readFileSync(path.join(PROJECT, "db/schema.sql"), "utf8"));
    await pool.query(fs.readFileSync(path.join(PROJECT, "db/seed.sql"), "utf8"));
    console.log("Schema + seed loaded OK.");

    const store = require(path.join(PROJECT, "lib/store-sql.js"));

    // Find a bookable Action Painting slot.
    const today = new Date();
    let dateISO = null, slot = null;
    for (let i = 1; i <= 21 && !slot; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const avail = await store.getAvailability("action_painting", iso, 2);
      const bookable = avail.find(s => s.bookable);
      if (bookable) { dateISO = iso; slot = bookable.start; }
    }
    log("Found a bookable slot", !!slot, `${dateISO} ${slot}`);

    // Test 1: reserveOnly=true manual booking never touches Mollie and stays pending.
    const { booking: b1 } = await store.createManualBooking({
      serviceCode: "action_painting", dateISO, start: slot, partySize: 2,
      customer: { name: "Reservering Klant", email: "reserve@test.be", phone: "0470000009" },
      note: "belt later terug", paymentMethod: "cash", reserveOnly: true,
      invoiceRequested: true, invoiceDetails: { vatNumber: "BE0123456789", companyName: "Test BV" }
    });
    log("Manual reservation created", b1.reserved === true, JSON.stringify(b1));

    const { rows: bookingRow1 } = await pool.query("SELECT * FROM bookings WHERE id = $1", [b1.id]);
    log("Booking payment_status is pending", bookingRow1[0].payment_status === "pending", bookingRow1[0].payment_status);
    log("Booking billit_invoice_id NOT set yet (deferred)", !bookingRow1[0].billit_invoice_id);

    const { rows: paymentRow1 } = await pool.query("SELECT * FROM payments WHERE booking_id = $1", [b1.id]);
    log("Payments row is pending, no paid_at", paymentRow1[0].status === "pending" && paymentRow1[0].paid_at === null);

    // getWeekSessions should flag this as pendingConfirmation.
    const { mondayOfISO } = require(path.join(PROJECT, "lib/dateUtils.js"));
    const monday = mondayOfISO(dateISO);
    const weekEvents = await store.getWeekSessions(monday);
    const ev = weekEvents.find(e => e.bookingId === b1.id);
    log("getWeekSessions flags it pendingConfirmation", !!ev && ev.pendingConfirmation === true, JSON.stringify(ev));

    // Test 2: reject confirming a non-existent booking.
    let threw = false;
    try { await store.confirmManualBooking("00000000-0000-0000-0000-000000000000", {}); }
    catch (err) { threw = /niet gevonden/.test(err.message); }
    log("confirmManualBooking rejects unknown booking id", threw);

    // Test 3: reject confirming an online (non-backoffice) booking.
    let b2DateISO = null, b2Slot = null;
    for (let i = 1; i <= 21 && !b2Slot; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      if (iso === dateISO) continue;
      const avail = await store.getAvailability("action_painting", iso, 2);
      const bookable = avail.find(s => s.bookable);
      if (bookable) { b2DateISO = iso; b2Slot = bookable.start; }
    }
    const { booking: b2 } = await store.createBooking({
      serviceCode: "action_painting", dateISO: b2DateISO, start: b2Slot, partySize: 2,
      customer: { name: "Online Klant", email: "online2@test.be", phone: "0470000010", birthDate: "1990-01-01" },
      note: "", termsAccepted: true, marketingOptIn: false
    });
    let threw2 = false;
    try { await store.confirmManualBooking(b2.id, {}); }
    catch (err) { threw2 = /Enkel manuele/.test(err.message); }
    log("confirmManualBooking rejects a non-backoffice booking", threw2);

    // Test 4: confirm the reservation -> paid, Billit invoice attempted, no email sent.
    const before = console.warn;
    let billitAttempted = false;
    console.warn = (...args) => { if (/Billit niet geconfigureerd/.test(args[0] || "")) billitAttempted = true; before(...args); };
    const confirmResult = await store.confirmManualBooking(b1.id, { paymentMethod: "bank_transfer" });
    console.warn = before;
    log("confirmManualBooking succeeds", confirmResult.booking.id === b1.id);
    log("Billit invoice attempted at confirmation time (not at reservation time)", billitAttempted);

    const { rows: bookingRow2 } = await pool.query("SELECT * FROM bookings WHERE id = $1", [b1.id]);
    log("Booking now payment_status paid", bookingRow2[0].payment_status === "paid");

    const { rows: paymentRow2 } = await pool.query("SELECT * FROM payments WHERE booking_id = $1", [b1.id]);
    log("Payments row now paid with correct (overridden) provider", paymentRow2[0].status === "paid" && paymentRow2[0].provider === "bank_transfer" && !!paymentRow2[0].paid_at);

    // Test 5: confirming again is a no-op (idempotent), doesn't error.
    const confirmAgain = await store.confirmManualBooking(b1.id, {});
    log("Re-confirming an already-paid reservation is a safe no-op", confirmAgain.alreadyConfirmed === true);

    // Test 6: reservation + gift card is deferred until confirmation.
    const card = await store.createManualGiftCard({ amount: 50 });
    let b3DateISO = null, b3Slot = null;
    for (let i = 1; i <= 28 && !b3Slot; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      if (iso === dateISO || iso === b2DateISO) continue;
      const avail = await store.getAvailability("fluid_art", iso, 1);
      const bookable = avail.find(s => s.bookable);
      if (bookable) { b3DateISO = iso; b3Slot = bookable.start; }
    }
    const { booking: b3 } = await store.createManualBooking({
      serviceCode: "fluid_art", dateISO: b3DateISO, start: b3Slot, partySize: 1,
      customer: { name: "Reservering Met Bon", email: "reservebon@test.be" },
      reserveOnly: true, giftCardCode: card.code
    });
    const { rows: cardMid } = await pool.query("SELECT * FROM gift_cards WHERE id = $1", [card.id]);
    log("Gift card NOT yet deducted while reservation is pending", Number(cardMid[0].remaining_amount) === 50, cardMid[0].remaining_amount);

    await store.confirmManualBooking(b3.id, {});
    const { rows: cardAfter } = await pool.query("SELECT * FROM gift_cards WHERE id = $1", [card.id]);
    log("Gift card deducted only after confirmation", Number(cardAfter[0].remaining_amount) === 50 - Number(b3.amountDue) - 0 || Number(cardAfter[0].remaining_amount) < 50, cardAfter[0].remaining_amount);

    // ================================================================
    // Terugbetalen ZONDER annuleren (nieuw, aug 2026)
    // ================================================================
    // Nieuwe, betaalde manuele boeking om op te testen.
    let refSlot = null;
    for (let i = 1; i <= 40 && !refSlot; i++) {
      const d = new Date(); d.setDate(d.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const av = await store.getAvailability("action_painting", iso, 2);
      const free = av.find(sl => sl.bookable);
      if (free) refSlot = { iso, start: free.start };
    }
    const { booking: refB } = await store.createManualBooking({
      serviceCode: "action_painting", dateISO: refSlot.iso, start: refSlot.start, partySize: 2,
      customer: { name: "Terugbetaal Klant", email: "refund@test.be", phone: "0470000020" },
      note: "", paymentMethod: "cash"
    });
    log("Testboeking voor terugbetaling aangemaakt (betaald)", refB.amountDue === 120, `amountDue=${refB.amountDue}`);

    // Onbetaalde boeking mag niet terugbetaald worden.
    const { booking: unpaid } = await store.createManualBooking({
      serviceCode: "action_painting", dateISO: refSlot.iso, start: refSlot.start, partySize: 2,
      customer: { name: "Onbetaald", email: "unpaid@test.be", phone: "0470000021" },
      note: "", paymentMethod: "transfer", reserveOnly: true
    });
    let unpaidRejected = false;
    try { await store.refundBooking(unpaid.id, { refundAmount: 10 }); }
    catch (err) { unpaidRejected = /betaalde boeking/i.test(err.message); }
    log("Terugbetaling geweigerd op een nog niet betaalde boeking", unpaidRejected);

    // Gedeeltelijke terugbetaling.
    const r1 = await store.refundBooking(refB.id, { refundAmount: 20, reason: "kleinere groep" });
    log("Gedeeltelijke terugbetaling van €20 geslaagd", r1.refundedTotal === 20, `totaal=${r1.refundedTotal}`);
    const { rows: afterR1 } = await pool.query("SELECT * FROM bookings WHERE id = $1", [refB.id]);
    log("Boeking blijft 'confirmed' (niet geannuleerd)", afterR1[0].status === "confirmed", afterR1[0].status);
    log("Boeking blijft 'paid' na gedeeltelijke terugbetaling", afterR1[0].payment_status === "paid", afterR1[0].payment_status);
    const { rows: roomStill } = await pool.query("SELECT COUNT(*)::int c FROM room_bookings WHERE booking_id = $1", [refB.id]);
    log("Room blijft gereserveerd (plaats komt NIET vrij)", roomStill[0].c === 1);
    const { rows: negPay } = await pool.query("SELECT * FROM payments WHERE booking_id = $1 AND provider = 'refund'", [refB.id]);
    log("Negatieve betaalregel geboekt", negPay.length === 1 && Number(negPay[0].amount) === -20, negPay[0] && negPay[0].amount);

    // Tweede gedeeltelijke terugbetaling telt op.
    const r2 = await store.refundBooking(refB.id, { refundAmount: 30 });
    log("Tweede terugbetaling telt op tot €50", r2.refundedTotal === 50, `totaal=${r2.refundedTotal}`);
    log("Resterend terugbetaalbaar bedrag klopt (€70)", r2.remainingRefundable === 70, `rest=${r2.remainingRefundable}`);

    // Meer dan het resterende bedrag mag niet.
    let overRejected = false;
    try { await store.refundBooking(refB.id, { refundAmount: 999 }); }
    catch (err) { overRejected = /maximaal/i.test(err.message); }
    log("Terugbetaling boven het resterende bedrag geweigerd", overRejected);

    // Nul of negatief mag niet.
    let zeroRejected = false;
    try { await store.refundBooking(refB.id, { refundAmount: 0 }); }
    catch (err) { zeroRejected = /groter dan 0/i.test(err.message); }
    log("Terugbetaling van €0 geweigerd", zeroRejected);

    // Volledig terugbetalen: status blijft confirmed, payment_status wordt refunded.
    await store.refundBooking(refB.id, { refundAmount: 70 });
    const { rows: full } = await pool.query("SELECT * FROM bookings WHERE id = $1", [refB.id]);
    log("Volledig terugbetaald: payment_status 'refunded'", full[0].payment_status === "refunded", full[0].payment_status);
    log("Volledig terugbetaald: boeking blijft toch 'confirmed'", full[0].status === "confirmed", full[0].status);
    let againRejected = false;
    try { await store.refundBooking(refB.id, { refundAmount: 1 }); }
    catch (err) { againRejected = /volledig terugbetaald|betaalde boeking/i.test(err.message); }
    log("Nog een terugbetaling daarna geweigerd", againRejected);

    // De weekagenda geeft het terugbetaalde bedrag mee (voor de backoffice-UI).
    const refWeek = await store.getWeekSessions(mondayOfISO(refSlot.iso));
    const refEv = refWeek.find(e => e.bookingId === refB.id);
    log("Weekagenda geeft refundedAmount mee", refEv && refEv.refundedAmount === 120, refEv && refEv.refundedAmount);
    log("Weekagenda geeft partySize mee voor het personen-badge", refEv && refEv.partySize === 2, refEv && refEv.partySize);

    // Bij het afsluiten sluit embedded-postgres de server terwijl `pg` soms nog
    // een inactieve verbinding openhoudt. Die gooit dan een niet-afgevangen
    // 'error'-event ('terminating connection due to administrator command'),
    // waardoor het proces met exit-code 1 stopt hoewel alle tests geslaagd zijn —
    // en bij `npm test` de volgende suite door de && nooit meer draaide.
    pool.on("error", () => {});
    await pool.end();
    const dbModule = require(path.join(PROJECT, "lib/db.js"));
    const internalPool = await dbModule.getPool();
    internalPool.on("error", () => {});
    await internalPool.end();
    await new Promise(r => setTimeout(r, 250)); // verbindingen echt laten sluiten
    console.log("\nAll reservation tests executed.");
  } finally {
    await pg.stop();
  }
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
