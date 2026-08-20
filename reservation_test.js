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
    // Notitie bij een boeking (nieuw, aug 2026)
    // ================================================================
    let ntSlot = null;
    for (let i = 1; i <= 40 && !ntSlot; i++) {
      const d = new Date(); d.setDate(d.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const av = await store.getAvailability("action_painting", iso, 2);
      const free = av.find(sl => sl.bookable);
      if (free) ntSlot = { iso, start: free.start };
    }
    const { booking: ntB } = await store.createManualBooking({
      serviceCode: "action_painting", dateISO: ntSlot.iso, start: ntSlot.start, partySize: 2,
      customer: { name: "Notitie Klant", email: "notitie@test.be", phone: "047" },
      note: "oorspronkelijke notitie", paymentMethod: "cash"
    });
    const bewaard = await store.updateBookingNote(ntB.id, "belt nog terug over het formaat");
    log("Notitie aanpassen lukt", bewaard.note === "belt nog terug over het formaat", bewaard.note);
    const ntWeek = await store.getWeekSessions(mondayOfISO(ntSlot.iso));
    const ntEv = ntWeek.find(e => e.bookingId === ntB.id);
    log("De nieuwe notitie komt mee in de weekagenda", ntEv && ntEv.note === "belt nog terug over het formaat", ntEv && ntEv.note);
    await store.updateBookingNote(ntB.id, "");
    const { rows: leeg } = await pool.query("SELECT customer_note FROM bookings WHERE id = $1", [ntB.id]);
    log("Notitie kan ook leeggemaakt worden", leeg[0].customer_note === "", JSON.stringify(leeg[0].customer_note));
    const lang = await store.updateBookingNote(ntB.id, "x".repeat(5000));
    log("Een te lange notitie wordt afgekapt op 2000 tekens", lang.note.length === 2000, lang.note.length);
    let ntWeg = false;
    try { await store.updateBookingNote("00000000-0000-0000-0000-000000000000", "test"); }
    catch (e) { ntWeg = /niet gevonden/i.test(e.message); }
    log("Notitie op een onbestaande boeking wordt geweigerd", ntWeg);

    // ================================================================
    // Rooms sluiten en weer heropenen (nieuw, aug 2026)
    // ================================================================
    let slSlot = null;
    for (let i = 1; i <= 40 && !slSlot; i++) {
      const d = new Date(); d.setDate(d.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const av = await store.getAvailability("action_painting", iso, 2);
      const free = av.find(sl => sl.bookable && sl.roomsLeft === 4);
      if (free) slSlot = { iso, start: free.start };
    }
    const vrijeRooms = async () => {
      const av = await store.getAvailability("action_painting", slSlot.iso, 2);
      return (av.find(x => x.start === slSlot.start) || {}).roomsLeft;
    };
    log("Uitgangspunt: 4 rooms vrij", (await vrijeRooms()) === 4);

    await store.closeRoom({ dateISO: slSlot.iso, start: slSlot.start, roomId: "VL", reason: "vloer wordt gelakt" });
    log("Eén room sluiten laat er 3 over", (await vrijeRooms()) === 3, await vrijeRooms());

    const her1 = await store.reopenRoom({ dateISO: slSlot.iso, start: slSlot.start, roomId: "VL" });
    log("Diezelfde room heropenen geeft hem terug vrij", (await vrijeRooms()) === 4, `${her1.heropend} sluiting(en) opgeheven`);

    // Hele tijdslot sluiten en in één keer heropenen.
    await store.closeRoom({ dateISO: slSlot.iso, start: slSlot.start, allRooms: true, reason: "verlof" });
    log("Alle rooms sluiten laat er 0 over", (await vrijeRooms()) === 0, await vrijeRooms());
    const her2 = await store.reopenRoom({ dateISO: slSlot.iso, start: slSlot.start, allRooms: true });
    log("Hele tijdslot heropenen zet alles terug open", (await vrijeRooms()) === 4, `${her2.heropend} sluitingen opgeheven`);

    // Een room die bezet is door een ECHTE boeking mag niet vrijkomen door te heropenen.
    const { booking: slB } = await store.createManualBooking({
      serviceCode: "action_painting", dateISO: slSlot.iso, start: slSlot.start, partySize: 2,
      customer: { name: "Blijft Geboekt", email: "blijft2@test.be", phone: "047" },
      note: "", paymentMethod: "cash"
    });
    log("Boeking bezet één room", (await vrijeRooms()) === 3, await vrijeRooms());
    await store.reopenRoom({ dateISO: slSlot.iso, start: slSlot.start, allRooms: true });
    log("Heropenen raakt een echte boeking NIET aan", (await vrijeRooms()) === 3, await vrijeRooms());
    const { rows: nogGeboekt } = await pool.query(
      "SELECT COUNT(*)::int c FROM room_bookings WHERE booking_id = $1", [slB.id]);
    log("De boeking heeft nog steeds haar room", nogGeboekt[0].c === 1);

    // Verplaatsen naar een tijdstip waar nog GEEN sessie staat.
    const raarUur = "20:15";
    const { rows: bestaatNiet } = await pool.query(
      `SELECT COUNT(*)::int c FROM sessions s JOIN services sv ON sv.id = s.service_id
        WHERE sv.name = 'Action Painting' AND s.start_datetime = $1`,
      [new Date(`${slSlot.iso}T${raarUur}:00`)]);
    log(`Uitgangspunt: om ${raarUur} staat er nog geen sessie`, bestaatNiet[0].c === 0);
    const verplaatst = await store.rescheduleBooking(slB.id, { dateISO: slSlot.iso, start: raarUur });
    // rescheduleBooking maakt een NIEUWE boeking aan en markeert de oude als
    // 'rescheduled' — vandaar newBookingId in plaats van bookingId.
    log("Verplaatsen naar een onbestaand tijdslot lukt", !!verplaatst.newBookingId, JSON.stringify(verplaatst));
    const { rows: nuWel } = await pool.query(
      `SELECT s.recurrence_rule_id, COUNT(b.id)::int AS boekingen
         FROM sessions s JOIN services sv ON sv.id = s.service_id
         LEFT JOIN bookings b ON b.session_id = s.id AND b.status NOT IN ('cancelled','rescheduled')
        WHERE sv.name = 'Action Painting' AND s.start_datetime = $1
        GROUP BY s.id, s.recurrence_rule_id`,
      [new Date(`${slSlot.iso}T${raarUur}:00`)]);
    log(`Er staat nu een sessie om ${raarUur} met de boeking erop`, nuWel.length === 1 && nuWel[0].boekingen === 1);
    log("Die sessie hangt niet aan het vaste rooster (eenmalig)", nuWel[0].recurrence_rule_id === null);

    // ================================================================
    // Aantal personen aanpassen + room opnieuw kiezen (nieuw, aug 2026)
    // ================================================================
    let psSlot = null;
    for (let i = 1; i <= 40 && !psSlot; i++) {
      const d = new Date(); d.setDate(d.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const av = await store.getAvailability("action_painting", iso, 2);
      // Bewust een tijdslot waar ALLE vier de rooms nog vrij zijn: anders hangt
      // de best-fit-uitkomst af van wat eerdere tests al bezet hebben.
      const free = av.find(sl => sl.bookable && sl.roomsLeft === 4);
      if (free) psSlot = { iso, start: free.start };
    }
    const { booking: psB } = await store.createManualBooking({
      serviceCode: "action_painting", dateISO: psSlot.iso, start: psSlot.start, partySize: 2,
      customer: { name: "Room Klant", email: "room@test.be", phone: "0470000030" },
      note: "", paymentMethod: "cash"
    });
    const roomVan = async id => (await pool.query(
      "SELECT r.code FROM room_bookings rb JOIN rooms r ON r.id = rb.room_id WHERE rb.booking_id = $1", [id]
    )).rows[0]?.code;
    const room2p = await roomVan(psB.id);
    log("Boeking van 2 personen krijgt de kleinste passende room (M, capaciteit 5)", room2p === "M", room2p);

    // Naar 6 personen: M (capaciteit 5) past niet meer, VL of VR (7) wel.
    // Action Painting staat op maximaal 7 personen online (db/seed.sql), dus
    // room A (10) komt hier pas in beeld als VL en VR al bezet zijn.
    const ps6 = await store.changePartySize(psB.id, { partySize: 6 });
    const room6p = await roomVan(psB.id);
    log("6 personen verhuist uit M naar een room van 7", ["VL","VR"].includes(room6p), room6p);
    log("changePartySize geeft de nieuwe room terug", ps6.roomCode === room6p, ps6.roomCode);
    const { rows: psRow } = await pool.query("SELECT party_size, amount_due FROM bookings WHERE id = $1", [psB.id]);
    log("Aantal personen staat op 6", psRow[0].party_size === 6, psRow[0].party_size);
    log("Prijs blijft ongewijzigd zonder recalculatePrice", Number(psRow[0].amount_due) === 120, psRow[0].amount_due);
    const { rows: psRooms } = await pool.query("SELECT COUNT(*)::int c FROM room_bookings WHERE booking_id = $1", [psB.id]);
    log("Nog steeds precies 1 room bezet (oude niet blijven staan)", psRooms[0].c === 1, psRooms[0].c);

    // Terug naar 3: past weer in M (5), de kleinste passende room.
    await store.changePartySize(psB.id, { partySize: 3 });
    const room3p = await roomVan(psB.id);
    log("3 personen valt terug naar de kleinste passende room (M)", room3p === "M", room3p);

    // Met prijsherrekening: 5 personen kost meer dan 2.
    const psPrijs = await store.changePartySize(psB.id, { partySize: 5, recalculatePrice: true });
    const { rows: psRow2 } = await pool.query("SELECT amount_due FROM bookings WHERE id = $1", [psB.id]);
    log("Met recalculatePrice schuift het bedrag mee", Number(psRow2[0].amount_due) > 120, psRow2[0].amount_due);
    log("changePartySize meldt dat de prijs herrekend is", psPrijs.priceRecalculated === true);

    // Ongeldige invoer wordt geweigerd.
    let psNul = false;
    try { await store.changePartySize(psB.id, { partySize: 0 }); } catch (e) { psNul = /geldig aantal/i.test(e.message); }
    log("Nul personen geweigerd", psNul);
    let psVeel = false;
    try { await store.changePartySize(psB.id, { partySize: 99 }); } catch (e) { psVeel = /maximum/i.test(e.message); }
    log("99 personen geweigerd (boven het maximum van de dienst)", psVeel);

    // Volle sessie: alle rooms bezet -> geen plaats meer voor een grotere groep.
    const psExtra = [];
    for (let i = 0; i < 3; i++) {
      const { booking } = await store.createManualBooking({
        serviceCode: "action_painting", dateISO: psSlot.iso, start: psSlot.start, partySize: 2,
        customer: { name: `Vuller ${i}`, email: `vul${i}@test.be`, phone: "0470" },
        note: "", paymentMethod: "cash"
      });
      psExtra.push(booking.id);
    }
    // psB zit in M (capaciteit 5) en de drie vullers hebben VL, VR en A. Naar 7
    // gaan kan dan nergens: de eigen room is te klein en de andere zijn bezet.
    let psVol = false;
    try { await store.changePartySize(psB.id, { partySize: 7 }); }
    catch (e) { psVol = /geen vrije room/i.test(e.message); }
    log("Geen vrije room voor 7 personen op een volle sessie -> duidelijke fout", psVol);
    const { rows: psOnaangeroerd } = await pool.query("SELECT party_size FROM bookings WHERE id = $1", [psB.id]);
    log("Mislukte aanpassing laat de boeking ongewijzigd (blijft 5)", psOnaangeroerd[0].party_size === 5, psOnaangeroerd[0].party_size);
    const psRoomNa = await roomVan(psB.id);
    log("Mislukte aanpassing laat ook de room ongemoeid (blijft M)", psRoomNa === "M", psRoomNa);

    // Een vuller die WEL past mag nog steeds groeien binnen zijn eigen room:
    // de eigen room telt niet als bezet mee.
    const psEigen = await store.changePartySize(psExtra[0], { partySize: 6 });
    log("Groeien binnen de eigen room blijft mogelijk (eigen room telt niet als bezet)", !!psEigen.roomCode, psEigen.roomCode);

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

    // ================================================================
    // Boeking zonder e-mailadres (aug 2026)
    // ================================================================
    // Aan de balie of aan de telefoon heeft niet elke klant een e-mailadres.
    // Enkel de naam is nog verplicht.
    const { toISODate: naarISO } = require(path.join(PROJECT, "lib/dateUtils.js"));
    let geenMailSlot = null;
    for (let i = 1; i <= 40 && !geenMailSlot; i++) {
      const d = new Date(); d.setDate(d.getDate() + i);
      const iso = naarISO(d);
      const av = await store.getAvailability("action_painting", iso, 2);
      const free = av.find(sl => sl.bookable);
      if (free) geenMailSlot = { iso, start: free.start };
    }
    const { booking: zonderMail } = await store.createManualBooking({
      serviceCode: "action_painting", dateISO: geenMailSlot.iso, start: geenMailSlot.start,
      partySize: 2, customer: { name: "Klant Zonder Mail" }, note: ""
    });
    log("Boeking zonder e-mailadres slaagt", !!zonderMail.id);
    const { rows: klantZM } = await pool.query(
      "SELECT c.* FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.id = $1", [zonderMail.id]);
    log("Klant is opgeslagen met een lege e-mail (NULL, geen lege tekst)",
        klantZM[0] && klantZM[0].email === null, JSON.stringify(klantZM[0] && klantZM[0].email));
    log("De naam is wél bewaard", klantZM[0] && klantZM[0].full_name === "Klant Zonder Mail");

    // Een tweede naamloze-mail-boeking mag NIET op dezelfde klantrij belanden:
    // zonder e-mail valt er niets te herkennen.
    const { booking: zonderMail2 } = await store.createManualBooking({
      serviceCode: "action_painting", dateISO: geenMailSlot.iso, start: geenMailSlot.start,
      partySize: 2, customer: { name: "Andere Klant Zonder Mail" }, note: ""
    });
    const { rows: klantZM2 } = await pool.query(
      "SELECT customer_id FROM bookings WHERE id = ANY($1::uuid[])", [[zonderMail.id, zonderMail2.id]]);
    log("Twee boekingen zonder e-mail krijgen elk een eigen klantrij",
        klantZM2.length === 2 && klantZM2[0].customer_id !== klantZM2[1].customer_id);

    // Een lege string telt als "geen e-mail", niet als een adres "".
    const { booking: legeMail } = await store.createManualBooking({
      serviceCode: "action_painting", dateISO: geenMailSlot.iso, start: geenMailSlot.start,
      partySize: 2, customer: { name: "Lege Mail", email: "   " }, note: ""
    });
    const { rows: klantLM } = await pool.query(
      "SELECT c.email FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.id = $1", [legeMail.id]);
    log("Een lege e-mail wordt NULL, geen lege tekst", klantLM[0] && klantLM[0].email === null);

    // Mét e-mail blijft het oude gedrag: dezelfde klant wordt herkend.
    const { rows: bestaandeKlant } = await pool.query(
      "SELECT COUNT(*)::int c FROM customers WHERE email = $1", ["refund@test.be"]);
    log("Klanten mét e-mail blijven samengevoegd op adres", bestaandeKlant[0].c === 1);

    // Zonder naam blijft het wél een fout.
    let naamloosGeweigerd = false;
    try {
      await store.createManualBooking({
        serviceCode: "action_painting", dateISO: geenMailSlot.iso, start: geenMailSlot.start,
        partySize: 2, customer: { email: "iemand@test.be" }, note: ""
      });
    } catch (err) { naamloosGeweigerd = /naam/i.test(err.message); }
    log("Een boeking zonder naam wordt nog steeds geweigerd", naamloosGeweigerd);

    // ================================================================
    // Tijdsblok in de agenda (aug 2026)
    // ================================================================
    const blokDag = geenMailSlot.iso;
    const blok = await store.addTimeBlock({ title: "Kamp voorbereiden", dateISO: blokDag, start: "09:00", end: "11:00" });
    log("Tijdsblok aangemaakt", !!blok.id && blok.kind === "block");

    const blokWeek = await store.getWeekSessions(mondayOfISO(blokDag));
    const blokEv = blokWeek.find(e => e.kind === "block" && e.dateISO === blokDag);
    log("Tijdsblok verschijnt in de weekagenda", !!blokEv);
    log("Tijdsblok toont zijn titel (niet geredigeerd zoals een privé-afspraak)",
        blokEv && blokEv.title === "Kamp voorbereiden", blokEv && blokEv.title);
    log("Tijdsblok geeft start én einde mee", blokEv && blokEv.start === "09:00" && blokEv.end === "11:00",
        blokEv && `${blokEv.start}–${blokEv.end}`);
    log("Tijdsblok geeft zijn sessie-id mee (nodig om het te verwijderen)", !!(blokEv && blokEv.sessionId));
    log("Tijdsblok is zichtbaar, niet privé", blokEv && blokEv.visibility === "standard", blokEv && blokEv.visibility);

    // Bewuste keuze: een tijdsblok blokkeert NIETS. Een blok over een sessie
    // heen mag de boekbaarheid van die sessie niet veranderen.
    // Uitdrukkelijk een slot kiezen dat NU boekbaar is — anders bewijst deze
    // test niets (een al volzet slot blijft ook zonder blok onboekbaar).
    let vrijDag = null, vrijSlot = null;
    for (let i = 1; i <= 40 && !vrijSlot; i++) {
      const d = new Date(); d.setDate(d.getDate() + i);
      const iso = naarISO(d);
      const av = await store.getAvailability("action_painting", iso, 2);
      const free = av.find(sl => sl.bookable);
      if (free) { vrijDag = iso; vrijSlot = free.start; }
    }
    await store.addTimeBlock({ title: "Overlappend blok", dateISO: vrijDag, start: vrijSlot, end: "23:30" });
    const naBlok = await store.getAvailability("action_painting", vrijDag, 2);
    const zelfdeSlot = naBlok.find(sl => sl.start === vrijSlot);
    log("Een tijdsblok blokkeert géén online boekingen (bewuste keuze)",
        !!(zelfdeSlot && zelfdeSlot.bookable),
        `slot ${vrijDag} ${vrijSlot}, boekbaar na het blok = ${zelfdeSlot && zelfdeSlot.bookable}`);
    log("Een tijdsblok neemt geen room in", (await pool.query(
      "SELECT COUNT(*)::int c FROM room_bookings rb JOIN sessions s ON s.id = rb.session_id WHERE s.kind = 'block'"
    )).rows[0].c === 0);

    // Aanpassen en verwijderen.
    await store.updateTimeBlock(blok.id, { title: "Kamp klaarzetten", dateISO: blokDag, start: "09:30", end: "11:30" });
    const naWijziging = (await store.getWeekSessions(mondayOfISO(blokDag)))
      .find(e => e.kind === "block" && e.sessionId === blok.id);
    log("Tijdsblok aanpassen werkt", naWijziging && naWijziging.title === "Kamp klaarzetten" && naWijziging.start === "09:30",
        naWijziging && `${naWijziging.title} ${naWijziging.start}`);

    let omgekeerdGeweigerd = false;
    try { await store.updateTimeBlock(blok.id, { title: "Fout", dateISO: blokDag, start: "12:00", end: "10:00" }); }
    catch (err) { omgekeerdGeweigerd = /einduur/i.test(err.message); }
    log("Een einduur vóór het startuur wordt geweigerd", omgekeerdGeweigerd);

    // Een workshopsessie mag NOOIT via deze weg verdwijnen.
    const { rows: echteSessie } = await pool.query("SELECT id FROM sessions WHERE kind = 'service' LIMIT 1");
    let sessieBeschermd = false;
    try { await store.deleteTimeBlock(echteSessie[0].id); }
    catch (err) { sessieBeschermd = /niet gevonden/i.test(err.message); }
    log("deleteTimeBlock raakt een gewone sessie niet aan", sessieBeschermd);
    const { rows: nogSteeds } = await pool.query("SELECT COUNT(*)::int c FROM sessions WHERE id = $1", [echteSessie[0].id]);
    log("Die sessie staat er nog", nogSteeds[0].c === 1);

    await store.deleteTimeBlock(blok.id);
    const naVerwijderen = (await store.getWeekSessions(mondayOfISO(blokDag)))
      .find(e => e.kind === "block" && e.sessionId === blok.id);
    log("Tijdsblok verwijderen werkt", !naVerwijderen);

    // ================================================================
    // Agenda-export als CSV — rijen en kolommen (aug 2026)
    // ================================================================
    // De PDF-variant leek in de code correct en gaf tóch elke room als "vrij"
    // terug (room.code bestaat niet, het is room.id). Daarom hier niet enkel
    // de query testen maar de échte CSV-rijen, zoals ze in Excel belanden.
    const { addDaysISO } = require(path.join(PROJECT, "lib/dateUtils.js"));
    const expMaandag = mondayOfISO(refSlot.iso);
    const expZondag = addDaysISO(expMaandag, 6);
    const expData = await store.getAgendaExportRows(expMaandag, expZondag);
    const expRooms = await store.getRoomsList();
    const { bouwRijen, bouwCsv, csvVeld, KOLOMMEN } = require(path.join(PROJECT, "lib/agendaExport.js"));

    const expBoeking = expData.sessies.find(s => s.bookingId === refB.id);
    log("Export geeft klant-e-mail mee (getWeekSessions doet dat niet)",
        expBoeking && expBoeking.customerEmail === "refund@test.be", expBoeking && expBoeking.customerEmail);
    log("Export geeft telefoon mee", expBoeking && expBoeking.customerPhone === "0470000020", expBoeking && expBoeking.customerPhone);
    log("Export geeft een einduur mee", !!(expBoeking && /^\d{2}:\d{2}$/.test(expBoeking.end)), expBoeking && expBoeking.end);
    log("Export geeft de room-code mee", !!(expBoeking && expBoeking.roomCode), expBoeking && expBoeking.roomCode);

    const expRijen = bouwRijen({ ...expData, rooms: expRooms, alleenGeboekt: false });
    log("Elke rij heeft evenveel kolommen als de kop",
        expRijen.every(r => r.length === KOLOMMEN.length),
        `kop=${KOLOMMEN.length}, min=${Math.min(...expRijen.map(r => r.length))}, max=${Math.max(...expRijen.map(r => r.length))}`);

    const statusKol = KOLOMMEN.indexOf("Status");
    const roomKol = KOLOMMEN.indexOf("Room");
    const naamKol = KOLOMMEN.indexOf("Boeking Contactnaam");
    const geboekteRijen = expRijen.filter(r => r[statusKol] === "Geboekt");
    log("De testboeking staat als 'Geboekt' in de export",
        geboekteRijen.some(r => r[naamKol] === "Terugbetaal Klant"));
    log("Een geboekte rij heeft een room ingevuld (niet allemaal 'vrij', zoals de PDF-bug)",
        geboekteRijen.filter(r => r[naamKol]).every(r => !!r[roomKol]));
    log("Er staan óók vrije rooms in de export",
        expRijen.some(r => r[statusKol] === "Vrij"));

    // Action Painting heeft vier rooms: elk tijdslot moet vier rijen geven.
    const apSlot = expData.sessies.find(s => s.usesRoomAssignment && s.dateISO === refSlot.iso && s.start === refSlot.start);
    const apRijen = expRijen.filter(r => r[0] === `${refSlot.iso.slice(8,10)}/${refSlot.iso.slice(5,7)}/${refSlot.iso.slice(0,4)}` && r[2] === refSlot.start);
    log("Eén rij per room per tijdslot (4 rooms = 4 rijen)",
        !apSlot || apRijen.length === expRooms.length, `${apRijen.length} rijen, ${expRooms.length} rooms`);

    // alleen=geboekt laat de vrije rijen weg maar behoudt de boekingen.
    const enkelGeboekt = bouwRijen({ ...expData, rooms: expRooms, alleenGeboekt: true });
    log("alleen=geboekt laat de vrije rijen weg",
        enkelGeboekt.every(r => r[statusKol] === "Geboekt") && enkelGeboekt.length === geboekteRijen.length,
        `${enkelGeboekt.length} van ${expRijen.length}`);

    // Formule-injectie: een klantnaam uit het publieke formulier mag in Excel
    // nooit als formule uitgevoerd worden.
    // Let op: dit veld bevat óók aanhalingstekens, dus het resultaat is
    // gequote — de apostrof staat dan binnen de quotes: "'=HYPERLINK(...)".
    // Excel ziet de cel daardoor als tekst en voert niets uit.
    log("CSV-veld neutraliseert een formule", csvVeld('=HYPERLINK("http://kwaad")').startsWith(`"'=`),
        csvVeld('=HYPERLINK("http://kwaad")'));
    log("CSV-veld neutraliseert een formule zonder quotes", csvVeld("=1+1") === "'=1+1", csvVeld("=1+1"));
    log("CSV-veld quoot een puntkomma (Excel-NL splitst daarop)", csvVeld("a;b") === '"a;b"', csvVeld("a;b"));
    log("CSV-veld verdubbelt aanhalingstekens", csvVeld('zeg "hallo"') === '"zeg ""hallo"""', csvVeld('zeg "hallo"'));

    // En tenslotte: de samengestelde CSV terug inlezen met dezelfde parser als
    // de Wix-import, zodat we zeker weten dat Excel hetzelfde rooster ziet.
    const { parse } = require("csv-parse/sync");
    const heringelezen = parse(bouwCsv(expRijen), { columns: true, skip_empty_lines: true });
    log("CSV leest terug in met evenveel rijen", heringelezen.length === expRijen.length,
        `${heringelezen.length} vs ${expRijen.length}`);
    log("CSV leest terug in met alle kolomkoppen",
        Object.keys(heringelezen[0] || {}).join("|") === KOLOMMEN.join("|"));
    log("Klantnaam staat in de juiste kolom na herinlezen",
        heringelezen.some(r => r["Boeking Contactnaam"] === "Terugbetaal Klant" && r["Status"] === "Geboekt"));

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
