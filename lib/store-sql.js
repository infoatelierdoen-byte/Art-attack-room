// Echte SQL-backed implementatie van dezelfde functies als lib/store.js —
// tegen db/schema.sql, via de pool uit lib/db.js (pg-mem lokaal, echte
// PostgreSQL in productie met DATABASE_URL). Dit is de opvolger van
// lib/store.js: geen in-memory arrays meer, maar echte tabellen, en
// recurrence_rules/sessions worden "gematerialiseerd" (concrete rijen
// aangemaakt naarmate ze nodig zijn) i.p.v. enkel berekend in het geheugen.
//
// Belangrijk over tijdzones: alle datum/tijd-berekeningen gaan uit van
// lokale (Europe/Brussels) klokttijd, forceert in lib/db.js
// (process.env.TZ). start_datetime/end_datetime worden altijd als JS
// Date-objecten doorgegeven aan de query (nooit als kale datumstrings die
// Postgres zelf in zijn eigen sessie-tijdzone zou interpreteren) om exact
// dezelfde klasse tijdzonebug te vermijden die eerder in lib/scheduling.js
// werd gevonden en gefixt.

const crypto = require("crypto");
const { getPool } = require("./db");
const { bestFitRoom } = require("./rooms");
const { toISODate, parseISODate, addDaysISO } = require("./dateUtils");
const mollie = require("./mollie");
const billit = require("./billit");
const email = require("./email");

const SESSION_DURATION_MIN = 90; // valt terug op dit als er geen service-rij gevonden wordt

function codeFromName(name) {
  return name.toLowerCase().replace(/\s+/g, "_");
}

function hhmm(date) {
  // Lokale (Europe/Brussels, zie lib/db.js) klokttijd — bewust getHours()/
  // getMinutes(), niet toISOString().
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function localDateTime(dateISO, hhmmStr) {
  // "2026-08-05" + "14:00" -> lokale Date, geen UTC-omzetting.
  return new Date(`${dateISO}T${hhmmStr}:00`);
}

// LET OP — dit was eerder fout gedocumenteerd en is pas aan het licht
// gekomen bij het testen tegen een ECHTE PostgreSQL (pg-mem verborg de bug):
// pg-mem geeft een DATE-kolom terug als JS Date op UTC-middernacht, maar de
// echte node-postgres driver geeft een DATE-kolom terug als de LOKALE
// middernacht (in de tijdzone van dit proces) omgezet naar UTC — bv.
// 2026-07-28 wordt dan 2026-07-27T22:00:00.000Z bij TZ=Europe/Brussels
// (UTC+2). UTC-getters zouden dan een dag te vroeg uitkomen tegen een echte
// database. Lokale getters kloppen wél in BEIDE gevallen, zolang
// process.env.TZ vastgezet blijft op Europe/Brussels (zie lib/db.js): bij
// pg-mem's UTC-middernacht valt de lokale tijd (UTC+1/+2) altijd nog op
// dezelfde kalenderdag, en bij de echte driver is het per definitie al de
// lokale middernacht. Vandaar hier bewust dezelfde lokale-getters-aanpak als
// toISODate() in lib/dateUtils.js, niet de UTC-variant.
function pgDateToISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Mollie kent eigen statuswaarden (open, paid, failed, canceled, expired, ...)
// die niet 1-op-1 overeenkomen met het payment_status-ENUM in schema.sql
// (pending, paid, failed, refunded). Hier expliciet naar mappen i.p.v. de
// Mollie-waarde blind door te geven aan de database.
function mollieStatusToDbEnum(mollieStatus) {
  if (mollieStatus === "paid") return "paid";
  if (mollieStatus === "failed" || mollieStatus === "canceled" || mollieStatus === "expired") return "failed";
  return "pending"; // "open", "pending", ...
}

async function getServiceRow(pool, serviceCode) {
  // Matchen gebeurt bewust in JS (niet met SQL replace()/lower()) — pg-mem
  // ondersteunt niet elke ingebouwde Postgres-functie, en dit is even
  // correct en werkt overal.
  const { rows } = await pool.query("SELECT * FROM services WHERE is_active = TRUE");
  const match = rows.find(s => codeFromName(s.name) === serviceCode);
  if (!match) throw new Error(`Onbekende dienst: ${serviceCode}`);
  return match;
}

async function getServices() {
  const pool = await getPool();
  const { rows: services } = await pool.query("SELECT * FROM services WHERE is_active = TRUE ORDER BY name");
  const result = [];
  for (const s of services) {
    const base = {
      code: codeFromName(s.name),
      label: s.name,
      usesRoomAssignment: s.uses_room_assignment,
      minOnlinePartySize: s.min_online_party_size,
      maxOnlinePartySize: s.max_online_party_size
    };
    if (s.uses_room_assignment) {
      const { rows: pricing } = await pool.query(
        "SELECT party_size, total_price FROM service_party_pricing WHERE service_id = $1 ORDER BY party_size",
        [s.id]
      );
      const pricingTable = {};
      pricing.forEach(p => { pricingTable[p.party_size] = Number(p.total_price); });
      result.push({ ...base, pricingType: "party_tier", pricingTable });
    } else {
      result.push({ ...base, pricingType: "per_person", pricePerPerson: Number(s.price) });
    }
  }
  return result;
}

async function getRooms(pool) {
  const { rows } = await pool.query("SELECT id, code, capacity FROM rooms WHERE is_active = TRUE ORDER BY capacity");
  // id = echte DB-uuid (voor room_bookings), code = "A"/"M"/... (voor bestFitRoom,
  // dat met leesbare codes werkt zodat er nooit een uuid naar de klant lekt).
  return rows.map(r => ({ id: r.code, label: r.code, capacity: r.capacity, dbId: r.id }));
}

// Publieke (admin-)variant van getRooms(), voor het room-sluiten-scherm in
// /backend — geeft bewust geen dbId mee (enkel intern nodig).
async function getRoomsList() {
  const pool = await getPool();
  const rooms = await getRooms(pool);
  return rooms.map(({ id, label, capacity }) => ({ id, label, capacity }));
}

function schemaWeekday(date) {
  // JS Date#getDay(): 0=zo..6=za. schema.sql: 0=ma..6=zo (zie recurrence_rules).
  return (date.getDay() + 6) % 7;
}

function ruleAppliesOn(rule, dateISO) {
  const d = parseISODate(dateISO);
  if (schemaWeekday(d) !== rule.weekday) return false;
  if (rule.end_date && dateISO > rule.end_date) return false;
  if (dateISO < rule.anchor_date) return false;

  // BUGFIX (juli 2026): meerdere weekdag-regels kunnen dezelfde
  // anchor_date delen (bv. alle Action Painting-dagen ankeren op dezelfde
  // datum) zonder dat die anchor zelf op rule.weekday valt. De oude check
  // (diffDays vanaf de rauwe anchor_date deelbaar door 7) klopte dan enkel
  // toevallig voor de ene weekdag die wél samenvalt met de anchor — voor
  // alle andere weekdagen was diffDays nooit een veelvoud van 7, dus die
  // regel vuurde NOOIT (geen enkele sessie werd ooit gematerialiseerd).
  // Eerst de eerste effectieve occurrence van déze weekdag op/na de anchor
  // bepalen ("week 0" voor dit patroon), en pas dán interval_weeks toetsen.
  const anchor = parseISODate(rule.anchor_date);
  const anchorWeekday = schemaWeekday(anchor);
  const daysToFirstOccurrence = (rule.weekday - anchorWeekday + 7) % 7;
  const firstOccurrence = new Date(anchor);
  firstOccurrence.setDate(firstOccurrence.getDate() + daysToFirstOccurrence);

  const diffDays = Math.round((d - firstOccurrence) / 86400000);
  if (diffDays < 0) return false;
  const diffWeeks = diffDays / 7;
  return Number.isInteger(diffWeeks) && diffWeeks % rule.interval_weeks === 0;
}

/**
 * Zorgt dat er voor elke actieve recurrence_rule een concrete rij in
 * `sessions` bestaat voor elke dag in [fromISO, toISO). Idempotent: bestaat
 * de rij al (zelfde service_id + start_datetime), dan gebeurt er niets.
 */
async function ensureSessionsMaterialized(pool, fromISO, toISO) {
  // Let op: geen ::text-casts hier — pg-mem ondersteunt die niet voor
  // date/time. TIME-kolommen komen sowieso al als "HH:MM:SS"-string terug;
  // DATE-kolommen komen als een JS Date (UTC-middernacht) terug en worden
  // via pgDateToISO() naar "YYYY-MM-DD" omgezet.
  const { rows: rawRules } = await pool.query(`
    SELECT rr.id AS rule_id, rr.service_id, rr.weekday, rr.start_time,
           rr.interval_weeks, rr.anchor_date, rr.end_date,
           sv.duration_minutes, sv.default_capacity, sv.uses_room_assignment
    FROM recurrence_rules rr
    JOIN services sv ON sv.id = rr.service_id
    WHERE rr.active = TRUE AND sv.is_active = TRUE
  `);
  const rules = rawRules.map(r => ({
    ...r,
    anchor_date: pgDateToISO(r.anchor_date),
    end_date: r.end_date ? pgDateToISO(r.end_date) : null
  }));

  for (let dateISO = fromISO; dateISO < toISO; dateISO = addDaysISO(dateISO, 1)) {
    for (const rule of rules) {
      if (!ruleAppliesOn(rule, dateISO)) continue;
      const startTime = rule.start_time.slice(0, 5); // "14:00:00" -> "14:00"
      const start = localDateTime(dateISO, startTime);
      const end = new Date(start.getTime() + rule.duration_minutes * 60000);

      const { rows: existing } = await pool.query(
        "SELECT id FROM sessions WHERE service_id = $1 AND start_datetime = $2",
        [rule.service_id, start]
      );
      if (existing.length > 0) continue;

      const capacity = rule.uses_room_assignment ? null : rule.default_capacity;
      await pool.query(
        `INSERT INTO sessions (kind, service_id, recurrence_rule_id, start_datetime, end_datetime, capacity)
         VALUES ('service', $1, $2, $3, $4, $5)`,
        [rule.service_id, rule.rule_id, start, end, capacity]
      );
    }
  }
}

async function occupiedRoomCodes(pool, sessionId, dbRooms) {
  const { rows } = await pool.query("SELECT room_id FROM room_bookings WHERE session_id = $1", [sessionId]);
  return rows
    .map(rb => dbRooms.find(r => r.dbId === rb.room_id))
    .filter(Boolean)
    .map(r => r.id);
}

async function getAvailability(serviceCode, dateISO, partySize) {
  const pool = await getPool();
  const service = await getServiceRow(pool, serviceCode);
  await ensureSessionsMaterialized(pool, dateISO, addDaysISO(dateISO, 1));

  const dayStart = localDateTime(dateISO, "00:00");
  const dayEnd = localDateTime(dateISO, "23:59");
  const { rows: sessions } = await pool.query(
    `SELECT id, start_datetime, end_datetime, capacity FROM sessions
     WHERE service_id = $1 AND kind = 'service' AND status = 'scheduled'
       AND start_datetime >= $2 AND start_datetime <= $3
     ORDER BY start_datetime`,
    [service.id, dayStart, dayEnd]
  );

  const dbRooms = service.uses_room_assignment ? await getRooms(pool) : null;

  const results = [];
  for (const s of sessions) {
    let bookable;
    let roomsLeft = null;
    if (service.uses_room_assignment) {
      const occ = await occupiedRoomCodes(pool, s.id, dbRooms);
      bookable = partySize ? bestFitRoom(partySize, occ, dbRooms) !== null : dbRooms.some(r => !occ.includes(r.id));
      // Enkel het AANTAL vrije rooms, geen roomdetails (welke/capaciteit) —
      // dat blijft intern, zie ook README. Gebruikt in de widget om bij
      // precies 1 vrije room een kleine "Nog 1 room beschikbaar"-melding te
      // tonen.
      roomsLeft = dbRooms.length - occ.length;
    } else {
      const { rows: bookings } = await pool.query(
        "SELECT COALESCE(SUM(party_size),0) AS total FROM bookings WHERE session_id = $1 AND status NOT IN ('cancelled','rescheduled')",
        [s.id]
      );
      const remaining = s.capacity - Number(bookings[0].total);
      bookable = partySize ? remaining >= partySize : remaining > 0;
    }
    results.push({
      start: hhmm(s.start_datetime),
      durationMin: Math.round((s.end_datetime - s.start_datetime) / 60000),
      bookable,
      roomsLeft
    });
  }
  return results;
}

// Geeft, voor een volledige kalendermaand, enkel de lijst ISO-datums terug
// die minstens 1 boekbaar tijdstip hebben — voor het groen markeren van
// dagen in de maandkalender van de widget. `month` is 0-based (JS
// Date-conventie), zoals viewMonth in pages/widget.js. Bewust geen
// tijdslot- of roomdetails hier, enkel welke dagen "iets boekbaars" hebben.
async function getMonthAvailability(serviceCode, year, month, partySize) {
  const pool = await getPool();
  const service = await getServiceRow(pool, serviceCode);

  const monthStartISO = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthEndExclusiveISO = addDaysISO(monthStartISO, daysInMonth);

  await ensureSessionsMaterialized(pool, monthStartISO, monthEndExclusiveISO);

  const rangeStart = localDateTime(monthStartISO, "00:00");
  const rangeEnd = localDateTime(monthEndExclusiveISO, "00:00");
  const { rows: sessions } = await pool.query(
    `SELECT id, start_datetime, capacity FROM sessions
     WHERE service_id = $1 AND kind = 'service' AND status = 'scheduled'
       AND start_datetime >= $2 AND start_datetime < $3
     ORDER BY start_datetime`,
    [service.id, rangeStart, rangeEnd]
  );

  const dbRooms = service.uses_room_assignment ? await getRooms(pool) : null;
  const availableDates = new Set();

  for (const s of sessions) {
    const dISO = pgDateToISO(s.start_datetime);
    if (availableDates.has(dISO)) continue; // deze dag staat al als beschikbaar gemarkeerd

    let bookable;
    if (service.uses_room_assignment) {
      const occ = await occupiedRoomCodes(pool, s.id, dbRooms);
      bookable = partySize ? bestFitRoom(partySize, occ, dbRooms) !== null : dbRooms.some(r => !occ.includes(r.id));
    } else {
      const { rows: bookings } = await pool.query(
        "SELECT COALESCE(SUM(party_size),0) AS total FROM bookings WHERE session_id = $1 AND status NOT IN ('cancelled','rescheduled')",
        [s.id]
      );
      const remaining = s.capacity - Number(bookings[0].total);
      bookable = partySize ? remaining >= partySize : remaining > 0;
    }
    if (bookable) availableDates.add(dISO);
  }
  return Array.from(availableDates).sort();
}

async function priceForPartySize(pool, service, partySize) {
  if (partySize < service.min_online_party_size) {
    throw new Error(
      `Minimum groepsgrootte is ${service.min_online_party_size}${service.min_online_party_size === 2 ? ' ("als duo")' : ""}.`
    );
  }
  if (service.max_online_party_size && partySize > service.max_online_party_size) {
    throw new Error(
      `Groepen groter dan ${service.max_online_party_size} personen kunnen niet online geboekt worden. ` +
      "Verwijs door naar het contactformulier of artattackroom@gmail.com."
    );
  }
  if (service.uses_room_assignment) {
    const { rows } = await pool.query(
      "SELECT total_price FROM service_party_pricing WHERE service_id = $1 AND party_size = $2",
      [service.id, partySize]
    );
    if (!rows[0]) throw new Error(`Geen prijs gekend voor groepsgrootte ${partySize} bij ${service.name}.`);
    return Number(rows[0].total_price);
  }
  return Number(service.price) * partySize;
}

async function upsertCustomer(pool, { name, email, phone, birthDate, marketingOptIn }) {
  const { rows: existing } = await pool.query("SELECT id FROM customers WHERE email = $1", [email]);
  if (existing[0]) {
    await pool.query(
      "UPDATE customers SET full_name=$1, phone=$2, birth_date=$3, marketing_opt_in=$4, terms_accepted_at=now() WHERE id=$5",
      [name, phone, birthDate, marketingOptIn !== false, existing[0].id]
    );
    return existing[0].id;
  }
  const { rows } = await pool.query(
    `INSERT INTO customers (full_name, email, phone, birth_date, marketing_opt_in, terms_accepted_at)
     VALUES ($1,$2,$3,$4,$5, now()) RETURNING id`,
    [name, email, phone, birthDate, marketingOptIn !== false]
  );
  return rows[0].id;
}

// Cadeaubon-codes: leesbaar formaat "AAR-XXXXXXXX" met een beperkt alfabet
// (geen 0/O, 1/I/l, ...) zodat een klant de code telefonisch of van een
// fysiek kaartje probleemloos kan overtypen.
// Bewust crypto.randomInt() en niet Math.random(): een cadeaubon is een
// waardepapier — wie de code heeft, heeft het geld. Math.random() is in V8 een
// xorshift128+ PRNG waarvan de interne toestand uit een handvol waargenomen
// codes af te leiden is; wie twee bonnen koopt zou zo de codes van volgende
// aankopen kunnen voorspellen. randomInt() gebruikt de cryptografische
// generator van het besturingssysteem.
const GIFT_CARD_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const GIFT_CARD_CODE_LENGTH = 10; // 32^10 ≈ 1,1e15 combinaties
// Bovengrens per bon, zowel online als handmatig door het team.
const MAX_GIFT_CARD_AMOUNT = 500;
function generateGiftCardCode() {
  let code = "AAR-";
  for (let i = 0; i < GIFT_CARD_CODE_LENGTH; i++) {
    code += GIFT_CARD_CODE_CHARS[crypto.randomInt(0, GIFT_CARD_CODE_CHARS.length)];
  }
  return code;
}

async function validateGiftCard(pool, rawCode) {
  const code = String(rawCode).trim().toUpperCase();
  const { rows } = await pool.query("SELECT * FROM gift_cards WHERE code = $1", [code]);
  return rows[0] || null;
}

/**
 * Reserveert (= schrijft meteen af) een bedrag van een cadeaubon.
 *
 * Dit is BEWUST één enkele UPDATE met alle voorwaarden in de WHERE-clausule,
 * en geen SELECT-dan-UPDATE. De database beslist in één atomaire stap of de
 * bon op dat moment nog actief, niet vervallen én toereikend is. Twee
 * gelijktijdige boekingen met dezelfde bon kunnen elkaar zo niet overlappen:
 * de tweede krijgt nul gewijzigde rijen terug en faalt netjes.
 *
 * Geeft het nieuwe saldo terug, of null als de bon niet (meer) bruikbaar is.
 */
async function reserveGiftCardAmount(pool, cardId, amount) {
  const { rows } = await pool.query(
    `UPDATE gift_cards
        SET remaining_amount = remaining_amount - $2::numeric,
            status = CASE WHEN remaining_amount - $2::numeric <= 0 THEN 'depleted' ELSE status END
      WHERE id = $1
        AND status = 'active'
        AND remaining_amount >= $2::numeric
        AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)
      RETURNING remaining_amount`,
    [cardId, amount]
  );
  return rows[0] ? Number(rows[0].remaining_amount) : null;
}

/**
 * Zet een eerder gereserveerd bedrag terug op de cadeaubon — gebruikt wanneer
 * het aanmaken van de boeking daarna alsnog mislukt, en bij annulering.
 * Een bon die door de reservering op 'depleted' kwam te staan wordt weer
 * 'active'; een handmatig uitgeschakelde bon ('disabled') blijft uitgeschakeld.
 */
async function releaseGiftCardAmount(pool, cardId, amount) {
  await pool.query(
    `UPDATE gift_cards
        SET remaining_amount = remaining_amount + $2::numeric,
            status = CASE WHEN status = 'depleted' THEN 'active' ELSE status END
      WHERE id = $1`,
    [cardId, amount]
  );
}

/**
 * Schrijft het effectief gebruikte bedrag van een cadeaubon af — enkel
 * wanneer de boeking die het gebruikt daadwerkelijk (volledig) betaald is.
 * Idempotent via gift_card_redeemed_at: wordt bv. de Mollie-webhook per
 * ongeluk twee keer aangeroepen, dan wordt hier maar één keer afgeschreven.
 * Faalt dit (bv. door een db-hik), dan wordt dit enkel gelogd — zelfde
 * "nooit de betaling zelf blokkeren"-patroon als Billit/e-mail hierboven.
 */
async function maybeRedeemGiftCard(pool, bookingId) {
  const { rows } = await pool.query(
    "SELECT gift_card_id, gift_card_amount, gift_card_redeemed_at FROM bookings WHERE id = $1",
    [bookingId]
  );
  const booking = rows[0];
  if (!booking || !booking.gift_card_id || booking.gift_card_redeemed_at) return;

  try {
    const { rows: cardRows } = await pool.query("SELECT * FROM gift_cards WHERE id = $1", [booking.gift_card_id]);
    const card = cardRows[0];
    if (!card) return;

    const amount = Number(booking.gift_card_amount);

    // Dezelfde atomaire afschrijving als bij een online boeking. Hier stond
    // eerder een lees-dan-schrijf met Math.max(0, ...) eromheen: bij een
    // tekort werd het saldo stilletjes op nul gezet, zodat een dubbel gebruikte
    // bon achteraf niet uit de cijfers af te leiden was. Slaagt de UPDATE niet,
    // dan blijft gift_card_redeemed_at leeg en is dat zichtbaar in de logs.
    const newRemaining = await reserveGiftCardAmount(pool, card.id, amount);
    if (newRemaining === null) {
      console.error(
        `Cadeaubon-verzilvering geweigerd voor boeking ${bookingId}: kaart ${card.id} ` +
        `is niet meer actief, vervallen of heeft onvoldoende saldo voor €${amount}.`
      );
      return;
    }

    await pool.query(
      `INSERT INTO discount_redemptions (booking_id, type, code, amount, validated_via)
       VALUES ($1, 'gift_voucher', $2, $3, 'internal')`,
      [bookingId, card.code, amount]
    );
    await pool.query("UPDATE bookings SET gift_card_redeemed_at = now() WHERE id = $1", [bookingId]);
  } catch (err) {
    console.error(`Cadeaubon-verzilvering mislukt voor boeking ${bookingId}:`, err.message);
  }
}

/**
 * Klant koopt zelf een cadeaubon voor een zelfgekozen bedrag, via Mollie.
 * De gift_cards-rij wordt pas aangemaakt zodra de betaling bevestigd is
 * (zie pages/api/mollie-webhook.js) — vóór die bevestiging bestaat de code
 * dus nog niet, net zoals een boeking pas na betaling "paid" wordt.
 */
async function createGiftCardPurchase({ amount, purchaser }) {
  const amt = Number(amount);
  if (!amt || amt < 5) throw new Error("Minimumbedrag voor een cadeaubon is €5.");
  if (amt > MAX_GIFT_CARD_AMOUNT) throw new Error(`Maximumbedrag voor een cadeaubon online is €${MAX_GIFT_CARD_AMOUNT}. Neem contact op voor een hoger bedrag.`);
  if (!purchaser || !purchaser.name || !purchaser.email) {
    throw new Error("Naam en e-mail zijn verplicht.");
  }

  const payment = await mollie.createPayment({
    amount: Math.round(amt * 100) / 100,
    description: `Cadeaubon Art Attack Room — €${amt.toFixed(2)}`,
    // Geen paymentId nodig in deze URL: de code zelf wordt gemaild zodra de
    // betaling bevestigd is (zie fulfillGiftCardPurchase()) — deze pagina
    // toont enkel een statische "bedankt, je krijgt de code via e-mail".
    redirectUrl: `${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/widget/cadeaubon-bevestiging`,
    webhookUrl: `${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/mollie-webhook`,
    metadata: {
      giftCardPurchase: true,
      amount: amt,
      purchaserName: purchaser.name,
      purchaserEmail: purchaser.email,
      recipientNote: purchaser.note || ""
    }
  });

  return { payment };
}

/**
 * Rondt een online cadeaubon-aankoop af nadat Mollie de betaling bevestigt
 * (aangeroepen vanuit de webhook, o.b.v. payment.metadata). Genereert een
 * unieke code (met een kleine retry-lus voor het zeldzame geval van een
 * botsing) en mailt die naar de koper.
 */
async function fulfillGiftCardPurchase({ amount, purchaserName, purchaserEmail, recipientNote, molliePaymentId }) {
  const pool = await getPool();

  const { rows: already } = await pool.query("SELECT id, code FROM gift_cards WHERE mollie_payment_id = $1", [molliePaymentId]);
  if (already[0]) return already[0]; // idempotent bij herhaalde webhook-call

  let code;
  for (let attempt = 0; attempt < 5; attempt++) {
    code = generateGiftCardCode();
    const { rows: existing } = await pool.query("SELECT id FROM gift_cards WHERE code = $1", [code]);
    if (existing.length === 0) break;
    code = null;
  }
  if (!code) throw new Error("Kon geen unieke cadeaubon-code genereren, probeer opnieuw.");

  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);

  // ON CONFLICT op de unieke index van mollie_payment_id: de vorige SELECT is
  // een snelkoppeling voor het normale geval, maar twee webhook-aanroepen die
  // tegelijk binnenkomen halen die allebei zonder resultaat op. Pas de database
  // kan hier definitief beslissen — vandaar dat de tweede insert niets doet en
  // we daarna de bestaande bon ophalen. Zie migratie 004.
  const { rows } = await pool.query(
    `INSERT INTO gift_cards (
       code, initial_amount, remaining_amount, status, purchaser_name, purchaser_email,
       recipient_note, source, mollie_payment_id, expires_at
     ) VALUES ($1,$2,$2,'active',$3,$4,$5,'purchased',$6,$7)
     ON CONFLICT (mollie_payment_id) WHERE mollie_payment_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [code, amount, purchaserName, purchaserEmail, recipientNote || null, molliePaymentId, toISODate(expiresAt)]
  );

  if (!rows[0]) {
    // Een gelijktijdige webhook was ons voor. Die heeft de bon aangemaakt en
    // mailt hem ook — hier dus niets meer doen, enkel teruggeven.
    const { rows: winner } = await pool.query(
      "SELECT id, code FROM gift_cards WHERE mollie_payment_id = $1", [molliePaymentId]
    );
    if (winner[0]) return winner[0];
    throw new Error("Kon de cadeaubon niet aanmaken.");
  }

  const card = rows[0];

  try {
    await email.sendGiftCardCode({
      purchaserName,
      purchaserEmail,
      code: card.code,
      amount: Number(card.initial_amount),
      expiresAtISO: pgDateToISO(card.expires_at)
    });
  } catch (err) {
    // Bewust card.id en niet card.code: Vercel-logs zijn breed leesbaar en
    // een cadeauboncode is inwisselbaar geld.
    console.error(`Cadeaubon-mail mislukt voor kaart ${card.id}:`, err.message);
  }

  return card;
}

/**
 * Backoffice: manueel een cadeaubon toevoegen (bv. cash verkocht in de
 * winkel) — zelfde tabel, source='manual', geen Mollie-betaling.
 */
async function createManualGiftCard({ amount, purchaserName, purchaserEmail, note, expiresAtISO }) {
  const amt = Number(amount);
  if (!amt || amt <= 0) throw new Error("Geef een geldig bedrag op.");
  // Bovengrens, net als online. Die ontbrak hier, waardoor via de backoffice een
  // bon van eender welk bedrag aangemaakt kon worden. Een hogere waarde blijft
  // mogelijk door meerdere bonnen te maken — bewust een drempel, geen blokkade.
  if (amt > MAX_GIFT_CARD_AMOUNT) {
    throw new Error(`Maximumbedrag per cadeaubon is €${MAX_GIFT_CARD_AMOUNT}. Maak er meerdere aan voor een hoger bedrag.`);
  }

  const pool = await getPool();
  let code;
  for (let attempt = 0; attempt < 5; attempt++) {
    code = generateGiftCardCode();
    const { rows: existing } = await pool.query("SELECT id FROM gift_cards WHERE code = $1", [code]);
    if (existing.length === 0) break;
    code = null;
  }
  if (!code) throw new Error("Kon geen unieke cadeaubon-code genereren, probeer opnieuw.");

  let expires = expiresAtISO;
  if (!expires) {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    expires = toISODate(d);
  }

  const { rows } = await pool.query(
    `INSERT INTO gift_cards (
       code, initial_amount, remaining_amount, status, purchaser_name, purchaser_email,
       recipient_note, source, expires_at
     ) VALUES ($1,$2,$2,'active',$3,$4,$5,'manual',$6) RETURNING *`,
    [code, amt, purchaserName || null, purchaserEmail || null, note || null, expires]
  );
  return mapGiftCardRow(rows[0]);
}

/**
 * Backoffice: cadeaubonnen opzoeken (code, naam of e-mail) en/of activeren/
 * uitschakelen — met zoekfunctie, zoals gevraagd.
 */
async function searchGiftCards(query) {
  const pool = await getPool();
  if (!query || !query.trim()) {
    const { rows } = await pool.query("SELECT * FROM gift_cards ORDER BY created_at DESC LIMIT 100");
    return rows.map(mapGiftCardRow);
  }
  const like = `%${query.trim()}%`;
  const { rows } = await pool.query(
    `SELECT * FROM gift_cards
     WHERE code ILIKE $1 OR purchaser_name ILIKE $1 OR purchaser_email ILIKE $1
     ORDER BY created_at DESC LIMIT 100`,
    [like]
  );
  return rows.map(mapGiftCardRow);
}

async function setGiftCardStatus(id, status) {
  if (!["active", "disabled"].includes(status)) {
    throw new Error("Status moet 'active' of 'disabled' zijn.");
  }
  const pool = await getPool();
  const { rows } = await pool.query("SELECT * FROM gift_cards WHERE id = $1", [id]);
  if (!rows[0]) throw new Error("Cadeaubon niet gevonden.");
  if (rows[0].status === "depleted") {
    throw new Error("Deze cadeaubon is volledig opgebruikt en kan niet meer geactiveerd worden.");
  }
  // disabled_at in JS berekend i.p.v. via een CASE WHEN $1 = '...' in SQL —
  // Postgres kan voor éénzelfde bind-parameter geen twee verschillende
  // types afleiden (hier: gift_card_status via de kolomtoewijzing, én text
  // via de vergelijking), zelfs niet met een expliciete cast.
  const disabledAt = status === "disabled" ? new Date() : null;
  const { rows: updated } = await pool.query(
    `UPDATE gift_cards SET status = $1, disabled_at = $2 WHERE id = $3 RETURNING *`,
    [status, disabledAt, id]
  );
  return mapGiftCardRow(updated[0]);
}

function mapGiftCardRow(row) {
  return {
    id: row.id,
    code: row.code,
    initialAmount: Number(row.initial_amount),
    remainingAmount: Number(row.remaining_amount),
    status: row.status,
    purchaserName: row.purchaser_name,
    purchaserEmail: row.purchaser_email,
    recipientNote: row.recipient_note,
    source: row.source,
    expiresAt: row.expires_at ? pgDateToISO(row.expires_at) : null,
    createdAt: row.created_at
  };
}

async function createBooking(payload) {
  const {
    serviceCode, dateISO, start, partySize, customer, note,
    termsAccepted, marketingOptIn,
    invoiceRequested, invoiceDetails, giftCardCode
  } = payload;

  if (!termsAccepted) throw new Error("Akkoord met de algemene voorwaarden is verplicht.");
  if (!customer || !customer.name || !customer.email || !customer.birthDate) {
    throw new Error("Naam, e-mail en geboortedatum zijn verplicht.");
  }

  const pool = await getPool();
  const service = await getServiceRow(pool, serviceCode);
  await ensureSessionsMaterialized(pool, dateISO, addDaysISO(dateISO, 1));

  const startDate = localDateTime(dateISO, start);
  const { rows: sessRows } = await pool.query(
    "SELECT * FROM sessions WHERE service_id = $1 AND start_datetime = $2 AND kind = 'service'",
    [service.id, startDate]
  );
  if (!sessRows[0]) throw new Error("Dit tijdslot bestaat niet (geen sessie gepland op dit moment).");
  const session = sessRows[0];

  let roomDbId = null;
  const dbRooms = service.uses_room_assignment ? await getRooms(pool) : null;
  if (service.uses_room_assignment) {
    const occ = await occupiedRoomCodes(pool, session.id, dbRooms);
    const room = bestFitRoom(partySize, occ, dbRooms);
    if (!room) throw new Error("Dit tijdslot is helaas volzet voor deze groepsgrootte.");
    roomDbId = room.dbId;
  } else {
    const { rows: booked } = await pool.query(
      "SELECT COALESCE(SUM(party_size),0) AS total FROM bookings WHERE session_id = $1 AND status NOT IN ('cancelled','rescheduled')",
      [session.id]
    );
    if (Number(booked[0].total) + partySize > session.capacity) {
      throw new Error("Dit tijdslot is helaas volzet.");
    }
  }

  let amount = await priceForPartySize(pool, service, partySize);
  const subtotal = amount;
  // Kortingen worden hier bewust NIET uit de payload overgenomen. Er stond
  // eerder een `applyLoyaltyDiscount`-vlag die rechtstreeks uit de request-body
  // kwam en nergens gecontroleerd werd: wie dat veld zelf meestuurde kreeg 10%
  // korting. Het loyaliteitssysteem bestaat nog niet — komt het er, dan moet de
  // korting SERVERSIDE bepaald worden (uit de klantgeschiedenis in de
  // database), nooit uit wat de browser opstuurt.
  const discountAmount = 0;

  // Cadeaubon: het saldo wordt hier METEEN afgeschreven, niet pas bij betaling.
  //
  // Dat was eerder omgekeerd, en dat maakte dezelfde bon onbeperkt herbruikbaar:
  // wie eerst vijf boekingen aanmaakte en pas daarna betaalde, kreeg vijf keer
  // dezelfde korting. Reserveren op het moment van boeken is de enige volgorde
  // die dat uitsluit. Mislukt het aanmaken van de boeking hierna alsnog, dan
  // wordt het bedrag teruggezet (zie de catch verderop); wordt de boeking later
  // geannuleerd, dan gebeurt dat in cancelBooking().
  let giftCard = null;
  let giftCardAmount = 0;
  if (giftCardCode) {
    giftCard = await validateGiftCard(pool, giftCardCode);
    if (!giftCard) throw new Error("Deze cadeaubon-code is niet gekend.");
    if (giftCard.status !== "active") throw new Error("Deze cadeaubon is niet (meer) actief.");
    if (Number(giftCard.remaining_amount) <= 0) throw new Error("Deze cadeaubon heeft geen resterend saldo meer.");
    if (giftCard.expires_at && pgDateToISO(giftCard.expires_at) < toISODate(new Date())) {
      throw new Error(`Deze cadeaubon is vervallen op ${pgDateToISO(giftCard.expires_at)}.`);
    }

    giftCardAmount = Math.round(Math.min(Number(giftCard.remaining_amount), amount) * 100) / 100;

    // De echte controle: één atomaire UPDATE die alleen slaagt als de bon op
    // dít moment nog actief, niet vervallen én toereikend is.
    const newRemaining = await reserveGiftCardAmount(pool, giftCard.id, giftCardAmount);
    if (newRemaining === null) {
      throw new Error("Deze cadeaubon kon niet gebruikt worden (niet meer actief, vervallen of onvoldoende saldo).");
    }

    amount = Math.round((amount - giftCardAmount) * 100) / 100;
  }

  // Vanaf hier is het cadeaubonsaldo al afgeschreven. Gaat er hierna iets mis
  // (databasefout, Mollie onbereikbaar, ...), dan moet dat bedrag terug op de
  // bon — anders verliest de klant geld door een fout die niet de zijne is.
  let booking;
  try {
    const customerId = await upsertCustomer(pool, { ...customer, marketingOptIn });

    const { rows: bookingRows } = await pool.query(
      `INSERT INTO bookings (
         session_id, customer_id, party_size, customer_note, subtotal_amount,
         discount_amount, amount_due, invoice_requested, invoice_vat_number, invoice_company_name,
         gift_card_id, gift_card_amount, gift_card_redeemed_at, payment_status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        session.id, customerId, partySize, note || "", subtotal, discountAmount, amount,
        !!invoiceRequested, invoiceRequested ? invoiceDetails?.vatNumber || null : null,
        invoiceRequested ? invoiceDetails?.companyName || null : null,
        giftCard ? giftCard.id : null, giftCardAmount || null,
        giftCard ? new Date() : null,
        amount === 0 && giftCardAmount > 0 ? "paid" : "pending"
      ]
    );
    booking = bookingRows[0];

    // Spoor van de verzilvering, meteen mee vastgelegd — het saldo is immers
    // al van de bon af. maybeRedeemGiftCard() ziet gift_card_redeemed_at staan
    // en doet daarna niets meer, dus dubbel afschrijven kan niet.
    if (giftCard) {
      await pool.query(
        `INSERT INTO discount_redemptions (booking_id, type, code, amount, validated_via)
         VALUES ($1, 'gift_voucher', $2, $3, 'internal')`,
        [booking.id, giftCard.code, giftCardAmount]
      );
    }

    if (service.uses_room_assignment) {
      await pool.query(
        "INSERT INTO room_bookings (session_id, room_id, booking_id, block_type) VALUES ($1,$2,$3,'booking')",
        [session.id, roomDbId, booking.id]
      );
    }
  } catch (err) {
    if (giftCard && giftCardAmount > 0) {
      try {
        await releaseGiftCardAmount(pool, giftCard.id, giftCardAmount);
      } catch (releaseErr) {
        // Loggen met de id, nooit met de code zelf: Vercel-logs zijn breed
        // leesbaar en een code is inwisselbaar geld.
        console.error(`Cadeaubonsaldo terugzetten mislukt voor kaart ${giftCard.id}:`, releaseErr.message);
      }
    }
    throw err;
  }

  // Volledig gedekt door de cadeaubon: geen Mollie-betaling nodig, meteen
  // afronden (zelfde patroon als createManualBooking()).
  if (amount === 0 && giftCardAmount > 0) {
    await pool.query(
      "INSERT INTO payments (booking_id, amount, provider, status, paid_at) VALUES ($1,$2,'gift_card','paid',now())",
      [booking.id, subtotal - discountAmount]
    );
    await maybeCreateBillitInvoice(pool, booking.id);
    await maybeSendConfirmationEmail(pool, booking.id);
    await maybeRedeemGiftCard(pool, booking.id);
    return {
      booking: { id: booking.id, amountDue: 0 },
      payment: { id: null, status: "paid", checkoutUrl: null, mocked: false, coveredByGiftCard: true }
    };
  }

  const payment = await mollie.createPayment({
    amount,
    description: `${service.name} — ${dateISO} ${start} (${partySize}p)`,
    redirectUrl: `${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/widget/bevestiging?booking=${booking.id}`,
    webhookUrl: `${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/mollie-webhook`,
    metadata: { bookingId: booking.id }
  });

  await pool.query(
    "INSERT INTO payments (booking_id, amount, provider, provider_payment_id, status) VALUES ($1,$2,'mollie',$3,$4)",
    [booking.id, amount, payment.id, mollieStatusToDbEnum(payment.status)]
  );

  // De bevestigingsmail, Billit-factuur, en het effectief afschrijven van
  // de cadeaubon (indien gebruikt voor het restbedrag) gebeuren pas zodra
  // de Mollie-webhook effectief "paid" bevestigt, zie markBookingPaid()
  // hieronder — niet hier, want op dit punt is er nog geen bevestigde
  // betaling.

  return {
    booking: { id: booking.id, amountDue: Number(booking.amount_due) },
    payment
  };
}

/**
 * Terugbetalen ZONDER te annuleren.
 *
 * Het verschil met cancelBooking(): de boeking blijft gewoon staan, de room
 * blijft gereserveerd en de klant komt gewoon langs — er gaat enkel geld terug.
 * Bedoeld voor een prijscorrectie of een commercieel gebaar (kleinere groep dan
 * geboekt, iets misgelopen tijdens de workshop, ...).
 *
 * Meerdere gedeeltelijke terugbetalingen na elkaar zijn toegestaan; ze tellen op
 * en kunnen samen nooit meer worden dan het betaalde bedrag.
 *
 * De wekelijkse omzetfactuur rekent met (amount_due - refunded_amount) en houdt
 * hier dus vanzelf rekening mee — zie generateWeeklyRevenueInvoice().
 *
 * Een gebruikte cadeaubon blijft bewust ongemoeid: de boeking gaat door, dus de
 * bon is wel degelijk verzilverd. Enkel het effectief betaalde geld gaat terug.
 */
async function refundBooking(bookingId, { refundAmount, reason } = {}) {
  const pool = await getPool();
  const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [bookingId]);
  const booking = rows[0];
  if (!booking) throw new Error("Boeking niet gevonden.");
  if (booking.status === "cancelled") {
    throw new Error("Deze boeking is geannuleerd — gebruik de annulering zelf om terug te betalen.");
  }
  if (booking.payment_status !== "paid") {
    throw new Error("Enkel een betaalde boeking kan terugbetaald worden.");
  }

  const amountDue = Number(booking.amount_due);
  const alreadyRefunded = Number(booking.refunded_amount || 0);
  const room = Math.round((amountDue - alreadyRefunded) * 100) / 100;
  if (room <= 0) throw new Error("Deze boeking is al volledig terugbetaald.");

  const refund = Math.round((Number(refundAmount) || 0) * 100) / 100;
  if (refund <= 0) throw new Error("Geef een terugbetaalbedrag groter dan 0 op.");
  if (refund > room) {
    throw new Error(`Maximaal €${room.toFixed(2)} terug te betalen (€${alreadyRefunded.toFixed(2)} is al terugbetaald).`);
  }

  const totalRefunded = Math.round((alreadyRefunded + refund) * 100) / 100;
  // Volledig terugbetaald maar niet geannuleerd: payment_status wordt
  // 'refunded' zodat het zichtbaar is in de agenda, maar status blijft
  // 'confirmed' — de klant komt nog steeds.
  const newPaymentStatus = totalRefunded >= amountDue ? "refunded" : booking.payment_status;

  await pool.query(
    `UPDATE bookings
        SET refunded_amount = $2::numeric,
            refund_reason = COALESCE($3, refund_reason),
            refunded_at = now(),
            payment_status = $4
      WHERE id = $1`,
    [bookingId, totalRefunded, reason || null, newPaymentStatus]
  );

  await pool.query(
    "INSERT INTO payments (booking_id, amount, provider, status, paid_at) VALUES ($1,$2,'refund','refunded',now())",
    [bookingId, -refund]
  );

  return {
    ok: true,
    refundedNow: refund,
    refundedTotal: totalRefunded,
    remainingRefundable: Math.round((amountDue - totalRefunded) * 100) / 100,
    paymentStatus: newPaymentStatus
  };
}

/**
 * Variant van createBooking() voor boekingen die het team zelf ingeeft (bv.
 * na een telefoontje) — geen Mollie-betaallink, want de betaling gebeurt via
 * een ander kanaal (cash, overschrijving, ...). Wordt daarom meteen als
 * "paid" weggeschreven (booked_via = 'backoffice'), en triggert — net als
 * een online betaalde boeking — meteen de Billit-factuur (indien
 * aangevraagd) en de bevestigingsmail.
 *
 * Geboortedatum is hier bewust optioneel (in tegenstelling tot de
 * klant-widget): een medewerker heeft die niet altijd meteen bij de hand
 * tijdens een telefoongesprek.
 */
async function createManualBooking(payload) {
  const {
    serviceCode, dateISO, start, partySize, customer, note,
    paymentMethod, invoiceRequested, invoiceDetails, giftCardCode,
    reserveOnly
  } = payload;

  if (!customer || !customer.name || !customer.email) {
    throw new Error("Naam en e-mail zijn verplicht.");
  }

  const pool = await getPool();
  const service = await getServiceRow(pool, serviceCode);
  await ensureSessionsMaterialized(pool, dateISO, addDaysISO(dateISO, 1));

  const startDate = localDateTime(dateISO, start);
  const { rows: sessRows } = await pool.query(
    "SELECT * FROM sessions WHERE service_id = $1 AND start_datetime = $2 AND kind = 'service'",
    [service.id, startDate]
  );
  if (!sessRows[0]) throw new Error("Dit tijdslot bestaat niet (geen sessie gepland op dit moment).");
  const session = sessRows[0];

  let roomDbId = null;
  const dbRooms = service.uses_room_assignment ? await getRooms(pool) : null;
  if (service.uses_room_assignment) {
    const occ = await occupiedRoomCodes(pool, session.id, dbRooms);
    const room = bestFitRoom(partySize, occ, dbRooms);
    if (!room) throw new Error("Dit tijdslot is helaas volzet voor deze groepsgrootte.");
    roomDbId = room.dbId;
  } else {
    const { rows: booked } = await pool.query(
      "SELECT COALESCE(SUM(party_size),0) AS total FROM bookings WHERE session_id = $1 AND status NOT IN ('cancelled','rescheduled')",
      [session.id]
    );
    if (Number(booked[0].total) + partySize > session.capacity) {
      throw new Error("Dit tijdslot is helaas volzet.");
    }
  }

  let amount = await priceForPartySize(pool, service, partySize);
  const subtotal = amount;

  // Ook aan de telefoon/balie kan een klant een cadeaubon inbrengen. Bij een
  // meteen-afgeronde manuele boeking (reserveOnly = false) wordt dit meteen
  // verzilverd. Bij een reservering (reserveOnly = true) wordt enkel het
  // bedrag/de code onthouden op de boeking — het saldo wordt pas écht
  // afgeschreven bij confirmManualBooking() hieronder, exact hetzelfde
  // deferred-patroon als bij een online boeking met gedeeltelijke dekking:
  // een reservering wijzigt vaak nog (groepsgrootte, annulatie, ...), dus
  // niets mag onomkeerbaar zijn vóór de definitieve bevestiging.
  let giftCard = null;
  let giftCardAmount = 0;
  if (giftCardCode) {
    giftCard = await validateGiftCard(pool, giftCardCode);
    if (!giftCard) throw new Error("Deze cadeaubon-code is niet gekend.");
    if (giftCard.status !== "active") throw new Error("Deze cadeaubon is niet (meer) actief.");
    if (Number(giftCard.remaining_amount) <= 0) throw new Error("Deze cadeaubon heeft geen resterend saldo meer.");
    giftCardAmount = Math.min(Number(giftCard.remaining_amount), amount);
    giftCardAmount = Math.round(giftCardAmount * 100) / 100;
    amount = Math.round((amount - giftCardAmount) * 100) / 100;
  }

  const customerId = await upsertCustomer(pool, { ...customer, marketingOptIn: false });
  const paymentStatus = reserveOnly ? "pending" : "paid";

  const { rows: bookingRows } = await pool.query(
    `INSERT INTO bookings (
       session_id, customer_id, party_size, customer_note, subtotal_amount,
       discount_amount, amount_due, payment_status, booked_via,
       invoice_requested, invoice_vat_number, invoice_company_name,
       gift_card_id, gift_card_amount
     ) VALUES ($1,$2,$3,$4,$5,0,$6,$7,'backoffice',$8,$9,$10,$11,$12) RETURNING *`,
    [
      session.id, customerId, partySize, note || "", subtotal, amount, paymentStatus,
      !!invoiceRequested, invoiceRequested ? invoiceDetails?.vatNumber || null : null,
      invoiceRequested ? invoiceDetails?.companyName || null : null,
      giftCard ? giftCard.id : null, giftCardAmount || null
    ]
  );
  const booking = bookingRows[0];

  if (service.uses_room_assignment) {
    await pool.query(
      "INSERT INTO room_bookings (session_id, room_id, booking_id, block_type) VALUES ($1,$2,$3,'booking')",
      [session.id, roomDbId, booking.id]
    );
  }

  await pool.query(
    "INSERT INTO payments (booking_id, amount, provider, status, paid_at) VALUES ($1,$2,$3,$4,$5)",
    [booking.id, amount, paymentMethod || "manual", paymentStatus, reserveOnly ? null : new Date()]
  );

  if (!reserveOnly) {
    // Wel dezelfde Billit-factuur (indien aangevraagd) als bij een online
    // betaalde boeking — maar bewust GEEN bevestigingsmail: bij een manuele
    // boeking heeft het team de klant al rechtstreeks gesproken (bv.
    // telefonisch), dus zowel de klantbevestiging als de interne
    // meldingsmail zijn hier overbodig.
    await maybeCreateBillitInvoice(pool, booking.id);
    if (giftCard) await maybeRedeemGiftCard(pool, booking.id);
  }
  // Bij reserveOnly = true gebeurt dit alles pas bij confirmManualBooking().

  return { booking: { id: booking.id, amountDue: Number(booking.amount_due), reserved: !!reserveOnly } };
}

/**
 * Bevestigt een eerder als "enkel reservering" aangemaakte manuele boeking
 * (payment_status 'pending' -> 'paid'). Precies dan pas gebeurt wat bij een
 * meteen-afgeronde manuele boeking al direct gebeurde: de Billit-factuur (bij
 * aanvraag) en het effectief afschrijven van een eventueel gebruikte
 * cadeaubon — bewust nog steeds GEEN bevestigingsmail, om dezelfde reden als
 * bij elke manuele boeking (het team heeft de klant al rechtstreeks
 * gesproken). `paymentMethod` mag hier de eerder opgegeven verwachte
 * betaalwijze overschrijven (kan intussen gewijzigd zijn, bv. van "cash" naar
 * "overschrijving").
 */
async function confirmManualBooking(bookingId, { paymentMethod } = {}) {
  const pool = await getPool();
  const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [bookingId]);
  const booking = rows[0];
  if (!booking) throw new Error("Boeking niet gevonden.");
  if (booking.booked_via !== "backoffice") {
    throw new Error("Enkel manuele (backoffice-)boekingen kunnen zo bevestigd worden.");
  }
  if (booking.payment_status === "paid") {
    return { booking: { id: booking.id, amountDue: Number(booking.amount_due) }, alreadyConfirmed: true };
  }

  await pool.query("UPDATE bookings SET payment_status = 'paid' WHERE id = $1", [bookingId]);
  const updateParams = paymentMethod ? [paymentMethod, bookingId] : [bookingId];
  await pool.query(
    paymentMethod
      ? "UPDATE payments SET status = 'paid', paid_at = now(), provider = $1 WHERE booking_id = $2"
      : "UPDATE payments SET status = 'paid', paid_at = now() WHERE booking_id = $1",
    updateParams
  );

  await maybeCreateBillitInvoice(pool, bookingId);
  if (booking.gift_card_id) await maybeRedeemGiftCard(pool, bookingId);

  return { booking: { id: bookingId, amountDue: Number(booking.amount_due) } };
}

/**
 * Annuleert een boeking vanuit de backoffice-agenda (bv. foute testdata
 * opruimen, of een klant die telefonisch annuleert). Zet enkel
 * bookings.status op 'cancelled' en maakt de room_bookings-rij vrij zodat
 * de room terug beschikbaar is voor dat tijdslot — raakt bewust NIET aan
 * betaling/factuur/cadeaubon-terugstorting, dat blijft manueel werk voor nu
 * (staat als opmerking in de README onder "Bekende beperkingen").
 */
/**
 * Alle gegevens van 1 boeking, voor de PDF-export ("Boeking exporteren" in
 * het detailscherm) — een losstaande query i.p.v. hergebruik van
 * getWeekSessions(), zodat dit werkt ongeacht welke week de agenda net
 * geladen heeft, en zodat ook klant-email/telefoon/notitie/terugbetaling
 * meekomen (die getWeekSessions() bewust niet allemaal teruggeeft, want
 * die voedt de week-grid, niet een volledig exportoverzicht).
 */
async function getBookingDetail(bookingId) {
  const pool = await getPool();
  // Bewust GEEN string_agg(...)+GROUP BY hier (dat gaf een pg-mem-fout bij
  // "SELECT b.*" gecombineerd met GROUP BY) — de room-toewijzing wordt
  // hieronder apart opgehaald en in JS samengevoegd, simpeler en werkt
  // overal hetzelfde.
  const { rows } = await pool.query(
    `SELECT b.*, c.full_name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            s.start_datetime, s.end_datetime, sv.name AS service_name
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN sessions s ON s.id = b.session_id
     JOIN services sv ON sv.id = s.service_id
     WHERE b.id = $1`,
    [bookingId]
  );
  const row = rows[0];
  if (!row) return null;

  const { rows: roomRows } = await pool.query(
    `SELECT r.code FROM room_bookings rb JOIN rooms r ON r.id = rb.room_id WHERE rb.booking_id = $1`,
    [bookingId]
  );
  const roomCodes = roomRows.map(r => r.code).join(", ");

  return {
    id: row.id,
    service: codeFromName(row.service_name),
    serviceName: row.service_name,
    dateISO: toISODate(row.start_datetime),
    start: hhmm(row.start_datetime),
    end: hhmm(row.end_datetime),
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    partySize: row.party_size,
    note: row.customer_note || "",
    subtotal: Number(row.subtotal_amount),
    discount: Number(row.discount_amount),
    amountDue: Number(row.amount_due),
    paymentStatus: row.payment_status,
    status: row.status,
    bookedVia: row.booked_via,
    roomCodes,
    refundedAmount: Number(row.refunded_amount || 0),
    refundReason: row.refund_reason,
    refundedAt: row.refunded_at,
    invoiceRequested: row.invoice_requested,
    billitInvoiceId: row.billit_invoice_id,
    createdAt: row.created_at
  };
}

async function cancelBooking(bookingId, { refundAmount = 0, reason } = {}) {
  const pool = await getPool();
  const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [bookingId]);
  const booking = rows[0];
  if (!booking) throw new Error("Boeking niet gevonden.");
  if (booking.status === "cancelled") return { alreadyCancelled: true };

  const amountDue = Number(booking.amount_due);
  const refund = Math.round(Math.max(0, Math.min(Number(refundAmount) || 0, amountDue)) * 100) / 100;
  if (refund > 0 && booking.payment_status !== "paid") {
    throw new Error("Enkel een betaalde boeking kan terugbetaald worden.");
  }

  // Bij een volledige terugbetaling (refund === amount_due) gaat payment_status
  // naar 'refunded'; bij een gedeeltelijke (bv. annuleringskost ingehouden)
  // blijft payment_status 'paid' — het kept-bedrag (amount_due - refunded_amount)
  // telt dan nog mee als omzet, zie generateWeeklyRevenueInvoice() hieronder.
  const newPaymentStatus = refund >= amountDue && amountDue > 0 ? "refunded" : booking.payment_status;
  await pool.query(
    `UPDATE bookings
     SET status = 'cancelled', payment_status = $2, refunded_amount = $3::numeric,
         refund_reason = $4, refunded_at = CASE WHEN $3::numeric > 0 THEN now() ELSE refunded_at END
     WHERE id = $1`,
    [bookingId, newPaymentStatus, refund, reason || null]
  );
  await pool.query("DELETE FROM room_bookings WHERE booking_id = $1", [bookingId]);

  if (refund > 0) {
    await pool.query(
      "INSERT INTO payments (booking_id, amount, provider, status, paid_at) VALUES ($1,$2,'refund','refunded',now())",
      [bookingId, -refund]
    );
  }

  // Een gebruikte cadeaubon terug aanvullen. Dat moest vroeger manueel, maar
  // sinds het saldo al bij het BOEKEN afgeschreven wordt (en niet pas bij
  // betaling) zou een annulering anders gewoon geld van de klant opeten.
  // gift_card_redeemed_at weer op NULL zetten maakt dit idempotent: een tweede
  // annulering van dezelfde boeking vult niet nog eens aan.
  let giftCardRefunded = 0;
  if (booking.gift_card_id && booking.gift_card_redeemed_at && Number(booking.gift_card_amount) > 0) {
    giftCardRefunded = Number(booking.gift_card_amount);
    try {
      await releaseGiftCardAmount(pool, booking.gift_card_id, giftCardRefunded);
      await pool.query("DELETE FROM discount_redemptions WHERE booking_id = $1 AND type = 'gift_voucher'", [bookingId]);
      await pool.query("UPDATE bookings SET gift_card_redeemed_at = NULL WHERE id = $1", [bookingId]);
    } catch (err) {
      giftCardRefunded = 0;
      console.error(`Cadeaubonsaldo terugzetten mislukt bij annulering van boeking ${bookingId}:`, err.message);
    }
  }

  return { ok: true, refundedAmount: refund, giftCardRefundedAmount: giftCardRefunded };
}

/**
 * Verplaatst een boeking naar een ander tijdslot (bv. na een telefoontje van
 * de klant, of om foute testdata recht te zetten). Volgt het patroon dat het
 * datamodel al voorzag (bookings.rescheduled_from_id, booking_status
 * 'rescheduled'): de oude rij wordt niet verwijderd maar krijgt status
 * 'rescheduled' (telt dus niet meer mee als bezetting/omzet op haar oude
 * tijdslot — zie de status NOT IN ('cancelled','rescheduled') filters
 * hierboven), en er komt een nieuwe boekingsrij op het nieuwe tijdslot die
 * ernaar verwijst. Klant/groepsgrootte/prijs/betaalstatus blijven ongewijzigd
 * over; enkel sessie (en evt. toegewezen room) verandert.
 */
/**
 * Past het aantal personen van een bestaande boeking aan en herbekijkt meteen
 * de room-toewijzing.
 *
 * Waarom dit bestaat: de rooms hebben verschillende capaciteiten (A=10, VL=7,
 * VR=7, M=5). Een boeking die als 2 personen binnenkwam maar in werkelijkheid
 * met 6 komt, staat dan in een te kleine room. Dat kwam bovendrijven bij de
 * import van de Wix-boekingen, waar het echte aantal personen nergens in de
 * export stond (Robin, aug 2026).
 *
 * De room wordt opnieuw gekozen met dezelfde best-fit-logica als bij een nieuwe
 * boeking: de kleinste vrije room die past. De eigen huidige room telt daarbij
 * niet als bezet mee — blijft die de beste keuze, dan verandert er niets.
 *
 * De PRIJS blijft standaard staan. Bij een geïmporteerde of al betaalde boeking
 * is het bedrag wat de klant effectief betaald heeft; dat stilzwijgend
 * herrekenen zou de omzetcijfers vervalsen. Wil je de prijs wél mee aanpassen
 * (bv. de groep is echt groter geworden en betaalt bij), geef dan
 * recalculatePrice: true mee.
 */
async function changePartySize(bookingId, { partySize, recalculatePrice = false } = {}) {
  const pool = await getPool();
  const size = Number(partySize);
  if (!Number.isInteger(size) || size < 1) {
    throw new Error("Geef een geldig aantal personen op (een geheel getal vanaf 1).");
  }

  const { rows } = await pool.query(
    `SELECT b.*, s.service_id, s.capacity AS session_capacity
       FROM bookings b JOIN sessions s ON s.id = b.session_id
      WHERE b.id = $1`,
    [bookingId]
  );
  const booking = rows[0];
  if (!booking) throw new Error("Boeking niet gevonden.");
  if (booking.status === "cancelled" || booking.status === "rescheduled") {
    throw new Error("Deze boeking is geannuleerd of verplaatst.");
  }

  const { rows: svcRows } = await pool.query("SELECT * FROM services WHERE id = $1", [booking.service_id]);
  const service = svcRows[0];

  const min = service.min_online_party_size ?? 1;
  const max = service.max_online_party_size ?? 99;
  if (size > max) {
    throw new Error(`Maximum ${max} personen voor ${service.name}. Voor een grotere groep: maak een tweede boeking of gebruik een extra room.`);
  }

  let newRoom = null;
  if (service.uses_room_assignment) {
    const dbRooms = await getRooms(pool);
    // De eigen room bewust NIET als bezet meetellen: anders zou een boeking die
    // in de juiste room zit zichzelf blokkeren en "volzet" opleveren.
    const { rows: occRows } = await pool.query(
      "SELECT room_id FROM room_bookings WHERE session_id = $1 AND (booking_id IS NULL OR booking_id <> $2)",
      [booking.session_id, bookingId]
    );
    const bezet = occRows
      .map(rb => dbRooms.find(r => r.dbId === rb.room_id))
      .filter(Boolean)
      .map(r => r.id);

    newRoom = bestFitRoom(size, bezet, dbRooms);
    if (!newRoom) {
      throw new Error(`Geen vrije room voor ${size} personen op dit tijdstip. Verplaats de boeking of maak een room vrij.`);
    }
  } else {
    // Dienst zonder rooms (Fluid Art): enkel de sessiecapaciteit bewaken.
    const { rows: booked } = await pool.query(
      `SELECT COALESCE(SUM(party_size),0) AS total FROM bookings
        WHERE session_id = $1 AND status NOT IN ('cancelled','rescheduled') AND id <> $2`,
      [booking.session_id, bookingId]
    );
    if (Number(booked[0].total) + size > Number(booking.session_capacity)) {
      const vrij = Number(booking.session_capacity) - Number(booked[0].total);
      throw new Error(`Nog maar ${vrij} plaats(en) vrij in deze sessie.`);
    }
  }

  // Prijs enkel herrekenen wanneer daar uitdrukkelijk om gevraagd wordt.
  let newAmount = Number(booking.amount_due);
  let newSubtotal = Number(booking.subtotal_amount);
  if (recalculatePrice) {
    if (size < min) {
      throw new Error(`Minimum ${min} personen om de prijs te kunnen herrekenen voor ${service.name}.`);
    }
    newSubtotal = await priceForPartySize(pool, service, size);
    // Een eventueel cadeaubonbedrag blijft staan zoals het is; enkel het te
    // betalen restbedrag schuift mee.
    const bon = Number(booking.gift_card_amount || 0);
    newAmount = Math.max(0, Math.round((newSubtotal - Number(booking.discount_amount || 0) - bon) * 100) / 100);
  }

  await pool.query(
    "UPDATE bookings SET party_size = $2, subtotal_amount = $3::numeric, amount_due = $4::numeric WHERE id = $1",
    [bookingId, size, newSubtotal, newAmount]
  );

  let roomCode = null;
  if (service.uses_room_assignment && newRoom) {
    await pool.query("DELETE FROM room_bookings WHERE booking_id = $1", [bookingId]);
    await pool.query(
      "INSERT INTO room_bookings (session_id, room_id, booking_id, block_type) VALUES ($1,$2,$3,'booking')",
      [booking.session_id, newRoom.dbId, bookingId]
    );
    roomCode = newRoom.id;
  }

  return {
    ok: true,
    partySize: size,
    roomCode,
    roomChanged: roomCode !== null && roomCode !== booking.room_code,
    amountDue: newAmount,
    priceRecalculated: !!recalculatePrice
  };
}

async function rescheduleBooking(bookingId, { dateISO, start }) {
  const pool = await getPool();
  const { rows: oldRows } = await pool.query(
    `SELECT b.*, s.service_id FROM bookings b JOIN sessions s ON s.id = b.session_id WHERE b.id = $1`,
    [bookingId]
  );
  const oldBooking = oldRows[0];
  if (!oldBooking) throw new Error("Boeking niet gevonden.");
  if (oldBooking.status === "cancelled" || oldBooking.status === "rescheduled") {
    throw new Error("Deze boeking is al geannuleerd of al verplaatst.");
  }

  const { rows: svcRows } = await pool.query("SELECT * FROM services WHERE id = $1", [oldBooking.service_id]);
  const service = svcRows[0];

  await ensureSessionsMaterialized(pool, dateISO, addDaysISO(dateISO, 1));
  const startDate = localDateTime(dateISO, start);
  const { rows: sessRows } = await pool.query(
    "SELECT * FROM sessions WHERE service_id = $1 AND start_datetime = $2 AND kind = 'service'",
    [service.id, startDate]
  );
  if (!sessRows[0]) throw new Error("Dit tijdslot bestaat niet (geen sessie gepland op dit moment).");
  const newSession = sessRows[0];
  if (newSession.id === oldBooking.session_id) {
    throw new Error("Dit is hetzelfde tijdslot als de huidige boeking.");
  }

  let roomDbId = null;
  if (service.uses_room_assignment) {
    const dbRooms = await getRooms(pool);
    const occ = await occupiedRoomCodes(pool, newSession.id, dbRooms);
    const room = bestFitRoom(oldBooking.party_size, occ, dbRooms);
    if (!room) throw new Error("Dit tijdslot is helaas volzet voor deze groepsgrootte.");
    roomDbId = room.dbId;
  } else {
    const { rows: booked } = await pool.query(
      "SELECT COALESCE(SUM(party_size),0) AS total FROM bookings WHERE session_id = $1 AND status NOT IN ('cancelled','rescheduled')",
      [newSession.id]
    );
    if (Number(booked[0].total) + oldBooking.party_size > newSession.capacity) {
      throw new Error("Dit tijdslot is helaas volzet.");
    }
  }

  const { rows: newRows } = await pool.query(
    `INSERT INTO bookings (
       session_id, customer_id, party_size, customer_note, subtotal_amount,
       discount_amount, amount_due, payment_status, booked_via,
       invoice_requested, invoice_vat_number, invoice_company_name,
       invoice_company_address, gift_card_id, gift_card_amount,
       gift_card_redeemed_at, rescheduled_from_id
     )
     SELECT $1, customer_id, party_size, customer_note, subtotal_amount,
            discount_amount, amount_due, payment_status, booked_via,
            invoice_requested, invoice_vat_number, invoice_company_name,
            invoice_company_address, gift_card_id, gift_card_amount,
            gift_card_redeemed_at, $2
     FROM bookings WHERE id = $2
     RETURNING *`,
    [newSession.id, bookingId]
  );
  const newBooking = newRows[0];

  if (service.uses_room_assignment) {
    await pool.query(
      "INSERT INTO room_bookings (session_id, room_id, booking_id, block_type) VALUES ($1,$2,$3,'booking')",
      [newSession.id, roomDbId, newBooking.id]
    );
  }

  await pool.query("UPDATE bookings SET status = 'rescheduled' WHERE id = $1", [bookingId]);
  await pool.query("DELETE FROM room_bookings WHERE booking_id = $1", [bookingId]);

  return { newBookingId: newBooking.id };
}

/**
 * Importeert 1 historische/externe boeking (uit een Wix-CSV-export) — bedoeld
 * om te voorkomen dat een tijdslot dat al elders (Wix) geboekt is, via de
 * nieuwe widget dubbel geboekt kan worden, en om de klant meteen in de
 * database te krijgen. Bewust GEEN Billit-factuur, GEEN bevestigingsmail,
 * GEEN cadeaubon-logica — dat hoorde allemaal al bij de originele boeking.
 * booked_via wordt op 'wix_import' gezet (i.p.v. 'backoffice') zodat
 * generateWeeklyRevenueInvoice() deze omzet NOOIT meerekent: die is al via
 * Wix afgehandeld, meetellen zou de wekelijkse Billit-factuur een tweede
 * keer laten aanrekenen. Idempotent per (klant, sessie): een boeking die er
 * al staat wordt overgeslagen, dus hetzelfde CSV-bestand mag gerust twee
 * keer geüpload worden.
 * @returns {{status: 'imported'|'duplicate'|'no_session'|'full'|'error', message?: string, bookingId?: string}}
 */
async function importWixBooking({ serviceCode, dateISO, start, partySize, customer, note, paid }) {
  const pool = await getPool();
  try {
    const service = await getServiceRow(pool, serviceCode);
    await ensureSessionsMaterialized(pool, dateISO, addDaysISO(dateISO, 1));

    const startDate = localDateTime(dateISO, start);
    const { rows: sessRows } = await pool.query(
      "SELECT * FROM sessions WHERE service_id = $1 AND start_datetime = $2 AND kind = 'service'",
      [service.id, startDate]
    );
    if (!sessRows[0]) {
      return { status: "no_session", message: `Geen sessie gepland op ${dateISO} om ${start} voor ${service.name} (buiten het vaste uurrooster).` };
    }
    const session = sessRows[0];

    const customerId = await upsertCustomer(pool, { ...customer, marketingOptIn: false });

    const { rows: existingBooking } = await pool.query(
      `SELECT id FROM bookings WHERE session_id = $1 AND customer_id = $2 AND status NOT IN ('cancelled','rescheduled')`,
      [session.id, customerId]
    );
    if (existingBooking[0]) {
      return { status: "duplicate", message: `Al een actieve boeking voor deze klant op ${dateISO} om ${start}.` };
    }

    let roomDbId = null;
    if (service.uses_room_assignment) {
      const dbRooms = await getRooms(pool);
      const occ = await occupiedRoomCodes(pool, session.id, dbRooms);
      const room = bestFitRoom(partySize, occ, dbRooms);
      if (!room) {
        return { status: "full", message: `Geen vrije room meer op ${dateISO} om ${start} voor groepsgrootte ${partySize}.` };
      }
      roomDbId = room.dbId;
    } else {
      const { rows: booked } = await pool.query(
        "SELECT COALESCE(SUM(party_size),0) AS total FROM bookings WHERE session_id = $1 AND status NOT IN ('cancelled','rescheduled')",
        [session.id]
      );
      if (Number(booked[0].total) + partySize > session.capacity) {
        return { status: "full", message: `Sessie zit al vol op ${dateISO} om ${start}.` };
      }
    }

    const amount = await priceForPartySize(pool, service, partySize);
    const paymentStatus = paid ? "paid" : "pending";

    const { rows: bookingRows } = await pool.query(
      `INSERT INTO bookings (
         session_id, customer_id, party_size, customer_note, subtotal_amount,
         discount_amount, amount_due, payment_status, booked_via
       ) VALUES ($1,$2,$3,$4,$5,0,$5,$6,'wix_import') RETURNING id`,
      [session.id, customerId, partySize, note || "", amount, paymentStatus]
    );
    const bookingId = bookingRows[0].id;

    if (service.uses_room_assignment) {
      await pool.query(
        "INSERT INTO room_bookings (session_id, room_id, booking_id, block_type) VALUES ($1,$2,$3,'booking')",
        [session.id, roomDbId, bookingId]
      );
    }

    await pool.query(
      "INSERT INTO payments (booking_id, amount, provider, status, paid_at) VALUES ($1,$2,'wix',$3,$4)",
      [bookingId, amount, paymentStatus, paid ? new Date() : null]
    );

    return { status: "imported", bookingId };
  } catch (err) {
    return { status: "error", message: err.message };
  }
}

async function markBookingPaid(bookingId) {
  const pool = await getPool();
  // bookings.status blijft 'confirmed' (dat is de reservatie zelf, niet de
  // betaling) — enkel payment_status wijzigt naar 'paid'.
  await pool.query("UPDATE bookings SET payment_status='paid' WHERE id=$1", [bookingId]);
  await pool.query("UPDATE payments SET status='paid', paid_at=now() WHERE booking_id=$1", [bookingId]);

  await maybeCreateBillitInvoice(pool, bookingId);
  await maybeSendConfirmationEmail(pool, bookingId);
  await maybeRedeemGiftCard(pool, bookingId);
}

/**
 * Stuurt de bevestigingsmail (klant + team, incl. notitie) voor een
 * betaalde boeking. Faalt de e-mailaanroep (bv. verkeerd app-wachtwoord),
 * dan wordt dit enkel gelogd — net als bij Billit mag dit de betaling zelf
 * nooit blokkeren.
 */
async function maybeSendConfirmationEmail(pool, bookingId) {
  const { rows } = await pool.query(
    `SELECT b.party_size, b.amount_due, b.customer_note, c.full_name, c.email,
            s.start_datetime, sv.name AS service_name
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN sessions s ON s.id = b.session_id
     LEFT JOIN services sv ON sv.id = s.service_id
     WHERE b.id = $1`,
    [bookingId]
  );
  const booking = rows[0];
  if (!booking) return;

  try {
    await email.sendBookingConfirmation({
      customerName: booking.full_name,
      customerEmail: booking.email,
      serviceName: booking.service_name || "workshop",
      dateISO: toISODate(booking.start_datetime),
      start: hhmm(booking.start_datetime),
      partySize: booking.party_size,
      amount: Number(booking.amount_due),
      note: booking.customer_note
    });
  } catch (err) {
    console.error(`Bevestigingsmail mislukt voor boeking ${bookingId}:`, err.message);
  }
}

/**
 * Maakt, indien de klant een factuur heeft aangevraagd, een verkoopfactuur
 * aan via Billit en slaat het resultaat op in bookings.billit_invoice_id.
 * Faalt de Billit-aanroep (bv. nog niet geconfigureerd, of een netwerkfout),
 * dan wordt de fout enkel gelogd — een mislukte facturatie mag de betaling
 * zelf nooit blokkeren; dit kan later manueel of via een retry opnieuw.
 */
async function maybeCreateBillitInvoice(pool, bookingId) {
  const { rows } = await pool.query(
    `SELECT b.id, b.amount_due, b.invoice_requested, b.invoice_vat_number, b.invoice_company_name,
            b.billit_invoice_id, c.full_name, c.email, c.phone,
            s.start_datetime, sv.name AS service_name, b.party_size
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN sessions s ON s.id = b.session_id
     LEFT JOIN services sv ON sv.id = s.service_id
     WHERE b.id = $1`,
    [bookingId]
  );
  const booking = rows[0];
  if (!booking || !booking.invoice_requested || booking.billit_invoice_id) return;

  if (!billit.isConfigured()) {
    console.warn(`Billit niet geconfigureerd — factuur voor boeking ${bookingId} niet aangemaakt.`);
    return;
  }

  try {
    const { orderId } = await billit.createSalesInvoice({
      bookingId: booking.id,
      orderDate: toISODate(new Date()),
      description: `${booking.service_name} — ${hhmm(booking.start_datetime)} (${booking.party_size}p)`,
      amountIncl: Number(booking.amount_due),
      customerName: booking.full_name,
      customerEmail: booking.email,
      customerPhone: booking.phone,
      invoiceCompanyName: booking.invoice_company_name,
      invoiceVatNumber: booking.invoice_vat_number
    });
    await pool.query("UPDATE bookings SET billit_invoice_id = $1 WHERE id = $2", [String(orderId), bookingId]);
  } catch (err) {
    console.error(`Billit-factuur mislukt voor boeking ${bookingId}:`, err.message);
  }
}

/**
 * Genereert (idempotent, per week) de wekelijkse verzamelfactuur: 1 factuur
 * met 1 lijn per dienst, voor de omzet van betaalde boekingen die NIET al
 * individueel gefactureerd werden (invoice_requested = false) — zo raakt
 * niets dubbel geboekt. Wordt in productie best elke week (bv. zondagavond/
 * maandagochtend) getriggerd via een externe scheduler die dit endpoint
 * aanroept (zie README: "Wekelijkse verzamelfactuur inplannen").
 *
 * @param {string} weekStartISO - een willekeurige datum in de gewenste week;
 *   de maandag wordt automatisch berekend (zoals bij getWeekSessions).
 */
async function generateWeeklyRevenueInvoice(weekStartISO) {
  const pool = await getPool();
  const { mondayOfISO } = require("./dateUtils");
  const periodStart = mondayOfISO(weekStartISO);
  const periodEnd = addDaysISO(periodStart, 6); // zondag van diezelfde week (inclusief)
  const rangeStart = localDateTime(periodStart, "00:00");
  const rangeEnd = localDateTime(addDaysISO(periodStart, 7), "00:00"); // exclusief

  const { rows: existing } = await pool.query(
    "SELECT * FROM weekly_revenue_invoices WHERE period_start = $1",
    [periodStart]
  );
  if (existing[0]) {
    // period_start/period_end komen als DATE (JS Date, UTC-middernacht)
    // terug — omzetten naar een kale "YYYY-MM-DD"-string, zie pgDateToISO.
    return {
      ...existing[0],
      period_start: pgDateToISO(existing[0].period_start),
      period_end: pgDateToISO(existing[0].period_end),
      alreadyExisted: true
    };
  }

  // Een geannuleerde boeking met een gedeeltelijke terugbetaling (bv.
  // annuleringskost ingehouden) telt hier nog mee voor het bedrag dat
  // effectief behouden is (amount_due - refunded_amount) — enkel bij een
  // volledige terugbetaling wordt dat netto 0. Daarom NIET meer filteren op
  // status != 'cancelled': het netto-bedrag regelt dat vanzelf.
  const { rows: perService } = await pool.query(
    `SELECT sv.name AS service_name, COUNT(*)::int AS cnt,
            SUM(b.amount_due - COALESCE(b.refunded_amount,0)) AS total
     FROM bookings b
     JOIN sessions s ON s.id = b.session_id
     JOIN services sv ON sv.id = s.service_id
     WHERE s.start_datetime >= $1 AND s.start_datetime < $2
       AND b.payment_status IN ('paid','refunded') AND b.invoice_requested = FALSE AND b.status != 'rescheduled'
       AND b.booked_via != 'wix_import'
     GROUP BY sv.name`,
    [rangeStart, rangeEnd]
  );
  const { rows: excludedRows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM bookings b JOIN sessions s ON s.id = b.session_id
     WHERE s.start_datetime >= $1 AND s.start_datetime < $2
       AND b.payment_status IN ('paid','refunded') AND b.invoice_requested = TRUE AND b.status != 'rescheduled'`,
    [rangeStart, rangeEnd]
  );
  const excludedCount = excludedRows[0]?.cnt || 0;

  const totalAmount = perService.reduce((sum, r) => sum + Number(r.total), 0);

  let billitInvoiceId = null;
  if (totalAmount > 0) {
    if (!billit.isConfigured()) {
      console.warn(`Billit niet geconfigureerd — wekelijkse factuur voor ${periodStart} niet aangemaakt bij Billit (wel lokaal geregistreerd).`);
    } else {
      try {
        const { orderId } = await billit.createSummaryInvoice({
          orderNumber: `AAR-WK-${periodStart}`,
          periodStartISO: periodStart,
          periodEndISO: periodEnd,
          lines: perService.map(r => ({ label: r.service_name, amountIncl: Number(r.total), count: r.cnt }))
        });
        billitInvoiceId = String(orderId);
      } catch (err) {
        console.error(`Wekelijkse Billit-factuur mislukt voor ${periodStart}:`, err.message);
      }
    }
  }

  const { rows: inserted } = await pool.query(
    `INSERT INTO weekly_revenue_invoices (period_start, period_end, total_amount, excluded_booking_count, billit_invoice_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [periodStart, periodEnd, totalAmount, excludedCount, billitInvoiceId]
  );
  return {
    ...inserted[0],
    period_start: pgDateToISO(inserted[0].period_start),
    period_end: pgDateToISO(inserted[0].period_end),
    alreadyExisted: false,
    perService
  };
}

async function addPersonalAppointment({ title, dateISO, start, end }) {
  if (!title || !dateISO || !start || !end) {
    throw new Error("Titel, datum, start- en eindtijd zijn verplicht voor een persoonlijke afspraak.");
  }
  const pool = await getPool();
  const startDate = localDateTime(dateISO, start);
  const endDate = localDateTime(dateISO, end);
  const { rows } = await pool.query(
    `INSERT INTO sessions (kind, title, start_datetime, end_datetime, visibility)
     VALUES ('personal', $1, $2, $3, 'private') RETURNING id`,
    [title, startDate, endDate]
  );
  return { id: rows[0].id, kind: "personal", title, dateISO, start, end, status: "scheduled", visibility: "private" };
}

/**
 * Voegt een eenmalige, extra sessie toe voor een dienst — buiten het vaste
 * uurrooster (recurrence_rules) om. Bv. Fluid Art zit een bepaalde week
 * volzet, en er wordt een extra sessie de week erna ingepland. Verschijnt
 * meteen als boekbaar tijdstip in de klant-widget, exact zoals een
 * "normale" sessie (recurrence_rule_id blijft NULL — het schema voorzag dit
 * al expliciet als "handmatig/eenmalig toegevoegd").
 */
async function addExtraSession({ serviceCode, dateISO, start, capacity }) {
  if (!serviceCode || !dateISO || !start) {
    throw new Error("Dienst, datum en tijdstip zijn verplicht.");
  }
  const pool = await getPool();
  const service = await getServiceRow(pool, serviceCode);
  const startDate = localDateTime(dateISO, start);
  const endDate = new Date(startDate.getTime() + service.duration_minutes * 60000);

  const { rows: existing } = await pool.query(
    "SELECT id FROM sessions WHERE service_id = $1 AND start_datetime = $2",
    [service.id, startDate]
  );
  if (existing.length > 0) {
    throw new Error("Er bestaat al een sessie op dit tijdstip voor deze dienst.");
  }

  // Capaciteit is enkel relevant bij diensten zonder roomtoewijzing (bv.
  // Fluid Art) — bij Action Painting bepaalt de roomtoewijzing zelf de
  // capaciteit per sessie, dus daar blijft dit veld NULL (zelfde patroon
  // als ensureSessionsMaterialized()).
  const finalCapacity = service.uses_room_assignment ? null : (capacity ? Number(capacity) : service.default_capacity);

  const { rows } = await pool.query(
    `INSERT INTO sessions (kind, service_id, start_datetime, end_datetime, capacity)
     VALUES ('service', $1, $2, $3, $4) RETURNING id`,
    [service.id, startDate, endDate, finalCapacity]
  );
  return { id: rows[0].id, serviceCode, dateISO, start, capacity: finalCapacity };
}

async function closeRoom({ dateISO, start, roomId, allRooms, allDay, reason }) {
  const pool = await getPool();
  await ensureSessionsMaterialized(pool, dateISO, addDaysISO(dateISO, 1));

  const dayStart = localDateTime(dateISO, "00:00");
  const dayEnd = localDateTime(dateISO, "23:59");
  const params = [dayStart, dayEnd];
  let timeClause = "";
  if (!allDay && start) {
    params.push(localDateTime(dateISO, start));
    timeClause = " AND start_datetime = $3";
  }
  const { rows: sessions } = await pool.query(
    `SELECT s.id FROM sessions s JOIN services sv ON sv.id = s.service_id
     WHERE s.kind = 'service' AND sv.uses_room_assignment = TRUE
       AND s.start_datetime >= $1 AND s.start_datetime <= $2${timeClause}`,
    params
  );

  const dbRooms = await getRooms(pool);
  const targetRoomIds = allRooms ? dbRooms.map(r => r.dbId) : [dbRooms.find(r => r.id === roomId)?.dbId].filter(Boolean);

  for (const session of sessions) {
    for (const roomDbId of targetRoomIds) {
      await pool.query(
        `INSERT INTO room_bookings (session_id, room_id, block_type, reason)
         VALUES ($1,$2,'closed',$3) ON CONFLICT (session_id, room_id) DO NOTHING`,
        [session.id, roomDbId, reason || "Gesloten door medewerker"]
      );
    }
  }
}

// ---------------------------------------------------------
// Personeelsplanning (staff_shifts) — bewust simpele CRUD, geen
// terugkerend patroon (zie db/schema.sql). work_date/start_time/end_time
// zijn kale DATE/TIME-kolommen (geen tijdzone-conversie nodig, in
// tegenstelling tot sessions.start_datetime dat TIMESTAMPTZ is) — vandaar
// hier bewust GEEN localDateTime()/pgDateToISO() voor de tijden, enkel
// voor work_date zelf (een DATE-kolom, zelfde patroon als elders).
async function getStaffShifts(mondayISO) {
  const pool = await getPool();
  const sundayExclusiveISO = addDaysISO(mondayISO, 7);
  const { rows } = await pool.query(
    `SELECT id, work_date, staff_name, start_time, end_time, note FROM staff_shifts
     WHERE work_date >= $1 AND work_date < $2 ORDER BY work_date, start_time`,
    [mondayISO, sundayExclusiveISO]
  );
  return rows.map(r => ({
    id: r.id,
    dateISO: pgDateToISO(r.work_date),
    staffName: r.staff_name,
    start: String(r.start_time).slice(0, 5),
    end: String(r.end_time).slice(0, 5),
    note: r.note || ""
  }));
}

async function addStaffShift({ dateISO, staffName, start, end, note }) {
  if (!dateISO || !staffName || !start || !end) {
    throw new Error("Datum, naam, startuur en einduur zijn verplicht.");
  }
  if (end <= start) {
    throw new Error("Einduur moet na startuur liggen.");
  }
  const pool = await getPool();
  const { rows } = await pool.query(
    `INSERT INTO staff_shifts (work_date, staff_name, start_time, end_time, note)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [dateISO, staffName, start, end, note || null]
  );
  return { id: rows[0].id, dateISO, staffName, start, end, note: note || "" };
}

async function updateStaffShift(id, { dateISO, staffName, start, end, note }) {
  if (!dateISO || !staffName || !start || !end) {
    throw new Error("Datum, naam, startuur en einduur zijn verplicht.");
  }
  if (end <= start) {
    throw new Error("Einduur moet na startuur liggen.");
  }
  const pool = await getPool();
  const { rows } = await pool.query(
    `UPDATE staff_shifts SET work_date=$2, staff_name=$3, start_time=$4, end_time=$5, note=$6
     WHERE id=$1 RETURNING id`,
    [id, dateISO, staffName, start, end, note || null]
  );
  if (rows.length === 0) throw new Error("Werkuren niet gevonden.");
  return { id, dateISO, staffName, start, end, note: note || "" };
}

async function deleteStaffShift(id) {
  const pool = await getPool();
  const { rowCount } = await pool.query("DELETE FROM staff_shifts WHERE id = $1", [id]);
  if (rowCount === 0) throw new Error("Werkuren niet gevonden.");
  return { ok: true };
}

async function getWeekSessions(mondayISO) {
  const pool = await getPool();
  const sundayExclusiveISO = addDaysISO(mondayISO, 7);
  await ensureSessionsMaterialized(pool, mondayISO, sundayExclusiveISO);

  const rangeStart = localDateTime(mondayISO, "00:00");
  const rangeEnd = localDateTime(sundayExclusiveISO, "00:00");

  const { rows } = await pool.query(
    `SELECT s.id AS session_id, s.kind, s.title, s.start_datetime, s.end_datetime,
            s.capacity, s.status, s.visibility, sv.name AS service_name,
            sv.uses_room_assignment,
            b.id AS booking_id, b.party_size, b.customer_note, b.amount_due, b.status AS booking_status,
            b.payment_status, b.refunded_amount, b.booked_via, c.full_name AS customer_name,
            rb.room_id AS room_uuid, r.code AS room_code
     FROM sessions s
     LEFT JOIN services sv ON sv.id = s.service_id
     LEFT JOIN bookings b ON b.session_id = s.id AND b.status NOT IN ('cancelled','rescheduled')
     LEFT JOIN customers c ON c.id = b.customer_id
     LEFT JOIN room_bookings rb ON rb.session_id = s.id AND rb.booking_id = b.id
     LEFT JOIN rooms r ON r.id = rb.room_id
     WHERE s.start_datetime >= $1 AND s.start_datetime < $2
     ORDER BY s.start_datetime`,
    [rangeStart, rangeEnd]
  );

  // Room-toewijzingen die door de medewerker gesloten zijn (room_bookings met
  // block_type='closed', booking_id NULL) horen niet bij een specifieke
  // boeking, dus die komen niet mee in de query hierboven — apart ophalen en
  // als eigen "room_closed"-pseudo-events teruggeven, 1 per (sessie, room).
  const { rows: closedRows } = await pool.query(
    `SELECT s.id AS session_id, s.start_datetime, s.end_datetime, sv.name AS service_name,
            r.code AS room_code, rb.reason
     FROM room_bookings rb
     JOIN sessions s ON s.id = rb.session_id
     JOIN services sv ON sv.id = s.service_id
     JOIN rooms r ON r.id = rb.room_id
     WHERE rb.block_type = 'closed' AND s.start_datetime >= $1 AND s.start_datetime < $2
     ORDER BY s.start_datetime`,
    [rangeStart, rangeEnd]
  );

  const events = rows.map(r => {
    const dateISO = toISODate(r.start_datetime);
    if (r.kind === "personal") {
      return {
        kind: "personal",
        title: r.title,
        dateISO,
        start: hhmm(r.start_datetime),
        end: hhmm(r.end_datetime),
        status: r.status,
        visibility: r.visibility
      };
    }
    const base = {
      kind: "service",
      service: codeFromName(r.service_name),
      usesRoomAssignment: r.uses_room_assignment,
      dateISO,
      start: hhmm(r.start_datetime),
      durationMin: Math.round((r.end_datetime - r.start_datetime) / 60000),
      status: r.booking_id ? r.booking_status : r.status,
      visibility: r.visibility
    };
    if (r.booking_id) {
      return {
        ...base,
        customer: r.customer_name,
        partySize: r.party_size,
        amount: r.amount_due !== null ? Number(r.amount_due) : null,
        note: r.customer_note || "",
        bookingId: r.booking_id,
        paymentStatus: r.payment_status,
        refundedAmount: Number(r.refunded_amount || 0),
        bookedVia: r.booked_via,
        roomCode: r.room_code || null,
        // Enkel een manuele (backoffice-)boeking die nog niet bevestigd is
        // ("reserveOnly") kan zo later nog bevestigd worden vanuit de agenda.
        pendingConfirmation: r.booked_via === "backoffice" && r.payment_status === "pending"
      };
    }
    return { ...base, booked: 0, capacity: r.capacity };
  });

  const closedEvents = closedRows.map(r => ({
    kind: "room_closed",
    service: codeFromName(r.service_name),
    dateISO: toISODate(r.start_datetime),
    start: hhmm(r.start_datetime),
    end: hhmm(r.end_datetime),
    roomCode: r.room_code,
    reason: r.reason || "Gesloten"
  }));

  return [...events, ...closedEvents];
}

// Alle klant-e-mailadressen die via een boeking (widget of backoffice)
// verzameld zijn EN toestemming gaven voor nieuws/promoties
// (marketing_opt_in — het vinkje "Ik ontvang graag nieuws en promoties per
// e-mail" in de widget, standaard aangevinkt). customers.email is uniek, dus
// elke klant staat hier maar één keer in, met hun meest recente voorkeur.
// Bedoeld om te combineren met de Wix-abonneelijst voor een nieuwsbrief —
// zie pages/api/admin/customers-export.js.
async function listMarketingEmails() {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT full_name, email, phone, created_at
     FROM customers
     WHERE marketing_opt_in = true
     ORDER BY full_name`
  );
  return rows.map(r => ({
    name: r.full_name,
    email: r.email,
    phone: r.phone,
    createdAt: r.created_at
  }));
}

module.exports = {
  getServices,
  getAvailability,
  getMonthAvailability,
  getRoomsList,
  createBooking,
  createManualBooking,
  confirmManualBooking,
  getBookingDetail,
  cancelBooking,
  rescheduleBooking,
  importWixBooking,
  markBookingPaid,
  addPersonalAppointment,
  addExtraSession,
  closeRoom,
  getWeekSessions,
  getStaffShifts,
  addStaffShift,
  updateStaffShift,
  deleteStaffShift,
  generateWeeklyRevenueInvoice,
  createGiftCardPurchase,
  fulfillGiftCardPurchase,
  refundBooking,
  changePartySize,
  createManualGiftCard,
  searchGiftCards,
  setGiftCardStatus,
  listMarketingEmails
};
