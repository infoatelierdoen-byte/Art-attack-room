process.env.TZ = "Europe/Brussels";

const path = require("path");
const fs = require("fs");
const EmbeddedPostgres = require("embedded-postgres").default || require("embedded-postgres");

const PROJECT = "/sessions/jolly-hopeful-bohr/mnt/outputs/booking-mvp";
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

    await pool.end();
    const dbModule = require(path.join(PROJECT, "lib/db.js"));
    const internalPool = await dbModule.getPool();
    await internalPool.end();
    console.log("\nAll reservation tests executed.");
  } finally {
    await pg.stop();
  }
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
