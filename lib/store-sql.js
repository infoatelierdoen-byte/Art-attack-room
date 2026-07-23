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

const { getPool } = require("./db");
const { bestFitRoom } = require("./rooms");
const { toISODate, parseISODate, addDaysISO } = require("./dateUtils");
const mollie = require("./mollie");
const billit = require("./billit");

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

function schemaWeekday(date) {
  // JS Date#getDay(): 0=zo..6=za. schema.sql: 0=ma..6=zo (zie recurrence_rules).
  return (date.getDay() + 6) % 7;
}

function ruleAppliesOn(rule, dateISO) {
  const d = parseISODate(dateISO);
  if (schemaWeekday(d) !== rule.weekday) return false;
  if (rule.end_date && dateISO > rule.end_date) return false;
  if (dateISO < rule.anchor_date) return false;
  const anchor = parseISODate(rule.anchor_date);
  const diffDays = Math.round((d - anchor) / 86400000);
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
    if (service.uses_room_assignment) {
      const occ = await occupiedRoomCodes(pool, s.id, dbRooms);
      bookable = partySize ? bestFitRoom(partySize, occ, dbRooms) !== null : dbRooms.some(r => !occ.includes(r.id));
    } else {
      const { rows: bookings } = await pool.query(
        "SELECT COALESCE(SUM(party_size),0) AS total FROM bookings WHERE session_id = $1 AND status != 'cancelled'",
        [s.id]
      );
      const remaining = s.capacity - Number(bookings[0].total);
      bookable = partySize ? remaining >= partySize : remaining > 0;
    }
    results.push({
      start: hhmm(s.start_datetime),
      durationMin: Math.round((s.end_datetime - s.start_datetime) / 60000),
      bookable
    });
  }
  return results;
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

async function createBooking(payload) {
  const {
    serviceCode, dateISO, start, partySize, customer, note,
    termsAccepted, marketingOptIn, applyLoyaltyDiscount,
    invoiceRequested, invoiceDetails
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
      "SELECT COALESCE(SUM(party_size),0) AS total FROM bookings WHERE session_id = $1 AND status != 'cancelled'",
      [session.id]
    );
    if (Number(booked[0].total) + partySize > session.capacity) {
      throw new Error("Dit tijdslot is helaas volzet.");
    }
  }

  let amount = await priceForPartySize(pool, service, partySize);
  const subtotal = amount;
  let discountAmount = 0;
  if (applyLoyaltyDiscount) {
    discountAmount = Math.round(amount * 0.1 * 100) / 100;
    amount = Math.round((amount - discountAmount) * 100) / 100;
  }

  const customerId = await upsertCustomer(pool, { ...customer, marketingOptIn });

  const { rows: bookingRows } = await pool.query(
    `INSERT INTO bookings (
       session_id, customer_id, party_size, customer_note, subtotal_amount,
       discount_amount, amount_due, invoice_requested, invoice_vat_number, invoice_company_name
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      session.id, customerId, partySize, note || "", subtotal, discountAmount, amount,
      !!invoiceRequested, invoiceRequested ? invoiceDetails?.vatNumber || null : null,
      invoiceRequested ? invoiceDetails?.companyName || null : null
    ]
  );
  const booking = bookingRows[0];

  if (service.uses_room_assignment) {
    await pool.query(
      "INSERT INTO room_bookings (session_id, room_id, booking_id, block_type) VALUES ($1,$2,$3,'booking')",
      [session.id, roomDbId, booking.id]
    );
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

  // TODO productie: bevestigingsmail (incl. notitie) naar
  // info.atelierdoen@gmail.com pas versturen zodra de Mollie-webhook
  // effectief "paid" bevestigt (zie pages/api/mollie-webhook.js).

  return {
    booking: { id: booking.id, amountDue: Number(booking.amount_due) },
    payment
  };
}

async function markBookingPaid(bookingId) {
  const pool = await getPool();
  // bookings.status blijft 'confirmed' (dat is de reservatie zelf, niet de
  // betaling) — enkel payment_status wijzigt naar 'paid'.
  await pool.query("UPDATE bookings SET payment_status='paid' WHERE id=$1", [bookingId]);
  await pool.query("UPDATE payments SET status='paid', paid_at=now() WHERE booking_id=$1", [bookingId]);

  await maybeCreateBillitInvoice(pool, bookingId);
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

  const { rows: perService } = await pool.query(
    `SELECT sv.name AS service_name, COUNT(*)::int AS cnt, SUM(b.amount_due) AS total
     FROM bookings b
     JOIN sessions s ON s.id = b.session_id
     JOIN services sv ON sv.id = s.service_id
     WHERE s.start_datetime >= $1 AND s.start_datetime < $2
       AND b.payment_status = 'paid' AND b.invoice_requested = FALSE AND b.status != 'cancelled'
     GROUP BY sv.name`,
    [rangeStart, rangeEnd]
  );
  const { rows: excludedRows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM bookings b JOIN sessions s ON s.id = b.session_id
     WHERE s.start_datetime >= $1 AND s.start_datetime < $2
       AND b.payment_status = 'paid' AND b.invoice_requested = TRUE AND b.status != 'cancelled'`,
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

async function getWeekSessions(mondayISO) {
  const pool = await getPool();
  const sundayExclusiveISO = addDaysISO(mondayISO, 7);
  await ensureSessionsMaterialized(pool, mondayISO, sundayExclusiveISO);

  const rangeStart = localDateTime(mondayISO, "00:00");
  const rangeEnd = localDateTime(sundayExclusiveISO, "00:00");

  const { rows } = await pool.query(
    `SELECT s.id AS session_id, s.kind, s.title, s.start_datetime, s.end_datetime,
            s.capacity, s.status, s.visibility, sv.name AS service_name,
            b.id AS booking_id, b.party_size, b.customer_note, b.amount_due, b.status AS booking_status,
            c.full_name AS customer_name
     FROM sessions s
     LEFT JOIN services sv ON sv.id = s.service_id
     LEFT JOIN bookings b ON b.session_id = s.id AND b.status != 'cancelled'
     LEFT JOIN customers c ON c.id = b.customer_id
     WHERE s.start_datetime >= $1 AND s.start_datetime < $2
     ORDER BY s.start_datetime`,
    [rangeStart, rangeEnd]
  );

  return rows.map(r => {
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
        bookingId: r.booking_id
      };
    }
    return { ...base, booked: 0, capacity: r.capacity };
  });
}

module.exports = {
  getServices,
  getAvailability,
  createBooking,
  markBookingPaid,
  addPersonalAppointment,
  closeRoom,
  getWeekSessions,
  generateWeeklyRevenueInvoice
};
