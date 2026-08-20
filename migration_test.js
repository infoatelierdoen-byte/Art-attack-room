// Migratietest: bootst een database na van vóór de cadeaubon-feature (de
// situatie op de live Neon-database, aug 2026) en controleert dat 005 gevolgd
// door 004 die database correct bijwerkt — inclusief de fout die Robin zag:
//   column "gift_card_id" of relation "bookings" does not exist
process.env.TZ = "Europe/Brussels";
// Simuleert Robins situatie: een database van vóór de cadeaubon-feature.
// Draait daarna 005 en 004 en controleert of alles klopt.
const EmbeddedPostgres = require("embedded-postgres").default || require("embedded-postgres");
const fs = require("fs"); const path = require("path");
const P = "/mnt/user-data/working";
let fails = 0;
function log(name, ok, extra="") { if(!ok) fails++; console.log(`${ok?"PASS":"FAIL"} — ${name}${extra?" :: "+extra:""}`); }

(async () => {
  require("fs").rmSync("/tmp/pg-migtest",{recursive:true,force:true});
  const pg = new EmbeddedPostgres({ databaseDir: "/tmp/pg-migtest", user:"postgres", password:"x", port: 54399, persistent:false });
  await pg.initialise(); await pg.start(); await pg.createDatabase("t");
  const pool = pg.getPgClient ? null : null;
  const { Pool } = require("pg");
  const p = new Pool({ connectionString: "postgresql://postgres:x@localhost:54399/t" });

  await p.query(fs.readFileSync(path.join(P,"db/schema.sql"),"utf8"));
  await p.query(fs.readFileSync(path.join(P,"db/seed.sql"),"utf8"));

  // --- oude database nabootsen: cadeaubon-onderdelen weghalen ---
  await p.query("ALTER TABLE bookings DROP COLUMN gift_card_id, DROP COLUMN gift_card_amount, DROP COLUMN gift_card_redeemed_at");
  await p.query("DROP TABLE discount_redemptions");
  await p.query("DROP TABLE gift_cards");
  await p.query("DROP TYPE gift_card_status");
  const { rows: pre } = await p.query("SELECT COUNT(*)::int c FROM information_schema.columns WHERE table_name='bookings' AND column_name='gift_card_id'");
  log("Uitgangspunt: gift_card_id ontbreekt (zoals bij Robin)", pre[0].c === 0);

  // --- 004 zonder 005 moet duidelijk falen ---
  let guarded = false;
  try { await p.query(fs.readFileSync(path.join(P,"db/migrations/004_gift_card_hardening.sql"),"utf8")); }
  catch (e) { guarded = /005_add_gift_cards/.test(e.message); }
  log("004 vóór 005 geeft een duidelijke instructie i.p.v. een cryptische fout", guarded);

  // --- 005 draaien ---
  await p.query(fs.readFileSync(path.join(P,"db/migrations/005_add_gift_cards_to_existing_db.sql"),"utf8"));
  const { rows: cols } = await p.query("SELECT column_name FROM information_schema.columns WHERE table_name='bookings' AND column_name LIKE 'gift_card%' ORDER BY 1");
  log("005 voegt de 3 kolommen toe", cols.length === 3, cols.map(c=>c.column_name).join(","));
  log("005 maakt tabel gift_cards", (await p.query("SELECT COUNT(*)::int c FROM information_schema.tables WHERE table_name='gift_cards'")).rows[0].c === 1);
  log("005 maakt tabel discount_redemptions", (await p.query("SELECT COUNT(*)::int c FROM information_schema.tables WHERE table_name='discount_redemptions'")).rows[0].c === 1);

  // --- 005 twee keer draaien moet veilig zijn ---
  let idem = true;
  try { await p.query(fs.readFileSync(path.join(P,"db/migrations/005_add_gift_cards_to_existing_db.sql"),"utf8")); } catch(e){ idem = false; console.log("   "+e.message); }
  log("005 is idempotent (tweede keer draaien is veilig)", idem);

  // --- 004 daarna ---
  let ok4 = true;
  try { await p.query(fs.readFileSync(path.join(P,"db/migrations/004_gift_card_hardening.sql"),"utf8")); } catch(e){ ok4=false; console.log("   "+e.message); }
  log("004 draait probleemloos na 005", ok4);
  let ok4b = true;
  try { await p.query(fs.readFileSync(path.join(P,"db/migrations/004_gift_card_hardening.sql"),"utf8")); } catch(e){ ok4b=false; console.log("   "+e.message); }
  log("004 is idempotent", ok4b);

  // --- werkt de app-logica nu? echte boeking met cadeaubon ---
  process.env.DATABASE_URL = "postgresql://postgres:x@localhost:54399/t";
  const store = require(path.join(P,"lib/store-sql.js"));
  const card = await store.createManualGiftCard({ amount: 60, purchaserName:"Test", purchaserEmail:"t@t.be" });
  let slot=null; const today=new Date();
  for (let i=1;i<=40 && !slot;i++){ const d=new Date(today); d.setDate(d.getDate()+i); const iso=d.toISOString().slice(0,10);
    const av = await store.getAvailability("fluid_art", iso, 1); const f=av.find(s=>s.bookable); if(f) slot={iso,start:f.start}; }
  const { booking } = await store.createBooking({ serviceCode:"fluid_art", dateISO:slot.iso, start:slot.start, partySize:1,
    customer:{name:"Test",email:"t2@t.be",phone:"047",birthDate:"1990-01-01"}, note:"", termsAccepted:true, marketingOptIn:false, giftCardCode: card.code });
  log("Boeking met cadeaubon slaagt na migratie (de oorspronkelijke fout is weg)", booking.amountDue === 0, `amountDue=${booking.amountDue}`);

  // ================================================================
  // Migratie 006: uurrooster Action Painting
  // ================================================================
  // Oude toestand nabootsen: vrijdag op 13:30/16:00 en geen donderdag 18:30.
  await p.query(`UPDATE recurrence_rules rr SET start_time='13:30' FROM services sv
                 WHERE sv.id=rr.service_id AND sv.name='Action Painting' AND rr.weekday=4 AND rr.start_time='14:00'`);
  await p.query(`UPDATE recurrence_rules rr SET start_time='16:00' FROM services sv
                 WHERE sv.id=rr.service_id AND sv.name='Action Painting' AND rr.weekday=4 AND rr.start_time='16:30'`);
  await p.query(`UPDATE recurrence_rules rr SET start_time='14:00', end_date='2026-08-31' FROM services sv
                 WHERE sv.id=rr.service_id AND sv.name='Action Painting' AND rr.weekday=3 AND rr.start_time='13:30'`);
  await p.query(`UPDATE recurrence_rules rr SET start_time='16:30', end_date='2026-08-31' FROM services sv
                 WHERE sv.id=rr.service_id AND sv.name='Action Painting' AND rr.weekday=3 AND rr.start_time='16:00'`);
  await p.query(`UPDATE recurrence_rules rr SET start_time='19:00', end_date='2026-08-31' FROM services sv
                 WHERE sv.id=rr.service_id AND sv.name='Action Painting' AND rr.weekday=3 AND rr.start_time='18:30'`);

  // Sessies materialiseren voor de komende twee maanden (zoals de widget doet).
  const store6 = require(path.join(P,"lib/store-sql.js"));
  const vrijdagen = [];
  for (let i = 1; i <= 60; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0,10);
    await store6.getAvailability("action_painting", iso, 2);
    if (d.getDay() === 5) vrijdagen.push(iso);
  }
  const { rows: oudVr } = await p.query(
    `SELECT COUNT(*)::int c FROM sessions s JOIN services sv ON sv.id=s.service_id
     WHERE sv.name='Action Painting' AND s.start_datetime::time='13:30' AND s.start_datetime >= now()`);
  log("Uitgangspunt: toekomstige vrijdagsessies staan op 13:30", oudVr[0].c > 0, `${oudVr[0].c} sessies`);

  // Eén boeking op een vrijdag 13:30 — die mag NIET verdwijnen.
  const avVr = await store6.getAvailability("action_painting", vrijdagen[0], 2);
  const slot1330 = avVr.find(sl => sl.start === "13:30" && sl.bookable);
  const { booking: vrB } = await store6.createManualBooking({
    serviceCode:"action_painting", dateISO: vrijdagen[0], start:"13:30", partySize:2,
    customer:{name:"Blijft Staan", email:"blijft@test.be", phone:"047"}, note:"", paymentMethod:"cash"
  });
  log("Testboeking op vrijdag 13:30 aangemaakt", !!slot1330 && !!vrB.id);

  // De migratie draaien op een verbinding die op UTC staat — zoals Neon
  // standaard doet. Zonder de SET TIME ZONE bovenaan de migratie zou ::time hier
  // omgerekende UTC-uren teruggeven, matcht geen enkele vergelijking, en wordt
  // ELKE lege toekomstige sessie verwijderd. Dat is één keer echt misgegaan op
  // de live database (aug 2026), vandaar dat deze test bewust op UTC draait.
  const utc = await p.connect();
  await utc.query("SET TIME ZONE 'UTC'");
  const {rows: tzVoor} = await utc.query("SHOW TimeZone");
  log("Migratietest draait op een UTC-verbinding (zoals Neon)", tzVoor[0].TimeZone === "UTC", tzVoor[0].TimeZone);
  await utc.query(fs.readFileSync(path.join(P,"db/migrations/006_update_schedule.sql"),"utf8"));
  utc.release();

  const { rows: regels } = await p.query(
    `SELECT rr.weekday, rr.start_time::text AS t, rr.anchor_date, rr.end_date FROM recurrence_rules rr
     JOIN services sv ON sv.id=rr.service_id WHERE sv.name='Action Painting' ORDER BY rr.weekday, rr.start_time`);
  const heeft = (wd, t) => regels.some(r => r.weekday===wd && r.t.startsWith(t));
  log("Vrijdag staat nu op 14:00 en 16:30", heeft(4,"14:00") && heeft(4,"16:30"));
  log("Vrijdag 13:30/16:00 zijn weg als regel", !heeft(4,"13:30") && !heeft(4,"16:00"));
  log("Woensdag onveranderd (14:00, 16:30, 19:00)", heeft(2,"14:00") && heeft(2,"16:30") && heeft(2,"19:00"));
  log("Zaterdag onveranderd (11:00, 13:30, 16:00)", heeft(5,"11:00") && heeft(5,"13:30") && heeft(5,"16:00"));
  log("Zondag onveranderd (11:00, 13:30, 16:00)", heeft(6,"11:00") && heeft(6,"13:30") && heeft(6,"16:00"));
  const do1830 = regels.find(r => r.weekday===3 && r.t.startsWith("18:30"));
  log("Donderdag 18:30 toegevoegd", !!do1830);
  // Bewust toISODate() uit lib/dateUtils en NIET toISOString(): dat laatste
  // rekent om naar UTC en zou een DATE-kolom van 01/09 in Europe/Brussels als
  // "2026-08-31" teruggeven — precies de datumbug waar de README voor waarschuwt.
  const { toISODate: dISO } = require(path.join(P,"lib/dateUtils.js"));
  log("Donderdag 18:30 loopt door (geen einddatum)", do1830 && !do1830.end_date, String(do1830 && do1830.end_date));
  const doZomer = regels.filter(r => r.weekday===3 && !r.t.startsWith("18:30"));
  log("Donderdag-zomerrooster is 13:30 en 16:00",
      doZomer.length===2 && doZomer.every(r => r.t.startsWith("13:30") || r.t.startsWith("16:00")),
      doZomer.map(r => r.t.slice(0,5)).join(","));
  log("Donderdag-zomerrooster loopt t.e.m. 31/08/2026",
      doZomer.length > 0 && doZomer.every(r => r.end_date && dISO(r.end_date) === "2026-08-31"),
      doZomer.map(r => dISO(r.end_date)).join(","));

  // Fluid Art ongemoeid.
  const { rows: fa } = await p.query(
    `SELECT rr.weekday, rr.start_time::text AS t, rr.interval_weeks FROM recurrence_rules rr
     JOIN services sv ON sv.id=rr.service_id WHERE sv.name='Fluid Art'`);
  log("Fluid Art ongewijzigd (tweewekelijks dinsdag 19:00)",
      fa.length===1 && fa[0].weekday===1 && fa[0].t.startsWith("19:00") && fa[0].interval_weeks===2);

  // De geboekte sessie blijft staan, de lege oude sessies zijn opgeruimd.
  const { rows: bewaard } = await p.query(
    `SELECT COUNT(*)::int c FROM sessions s JOIN bookings b ON b.session_id=s.id WHERE b.id=$1`, [vrB.id]);
  log("Sessie mét boeking blijft bestaan (boeking niet verweesd)", bewaard[0].c === 1);
  const { rows: restVr } = await p.query(
    `SELECT COUNT(*)::int c FROM sessions s JOIN services sv ON sv.id=s.service_id
     WHERE sv.name='Action Painting' AND s.start_datetime::time='13:30' AND s.start_datetime >= now()
       AND EXTRACT(ISODOW FROM s.start_datetime)=5`);
  log("Lege vrijdagsessies van 13:30 zijn opgeruimd (enkel de geboekte blijft)", restVr[0].c === 1, `${restVr[0].c} over`);

  // Nieuwe uren verschijnen bij het opnieuw opvragen.
  const avNa = await store6.getAvailability("action_painting", vrijdagen[1], 2);
  const uren = avNa.map(x => x.start);
  log("Vrijdag toont nu 14:00 en 16:30", uren.includes("14:00") && uren.includes("16:30"), uren.join(","));
  log("Vrijdag toont geen 13:30 meer", !uren.includes("13:30"), uren.join(","));

  // Donderdag: vóór 01/09 geen 18:30, erna wel.
  const doVoor = "2026-08-27", doNa = "2026-09-03"; // beide donderdagen
  const avDoVoor = (await store6.getAvailability("action_painting", doVoor, 2)).map(x=>x.start);
  const avDoNa   = (await store6.getAvailability("action_painting", doNa,   2)).map(x=>x.start);
  log("Donderdag 27/08 (zomer): 13:30, 16:00 en 18:30 — zoals in de Wix-boekingen",
      ["13:30","16:00","18:30"].every(t=>avDoVoor.includes(t)) && avDoVoor.length===3, avDoVoor.join(","));
  log("Donderdag 03/09: enkel 18:30", avDoNa.length===1 && avDoNa[0]==="18:30", avDoNa.join(","));

  // Fluid Art: reeks moet vanaf 18/08/2026 lopen, dus 01/09 wel en 25/08 niet.
  const { rows: faNa } = await p.query(
    `SELECT rr.anchor_date FROM recurrence_rules rr JOIN services sv ON sv.id=rr.service_id
     WHERE sv.name='Fluid Art'`);
  log("Fluid Art ankerdatum staat op 18/08/2026", dISO(faNa[0].anchor_date) === "2026-08-18", dISO(faNa[0].anchor_date));
  const fa0109 = (await store6.getAvailability("fluid_art", "2026-09-01", 2)).map(x=>x.start);
  const fa2508 = (await store6.getAvailability("fluid_art", "2026-08-25", 2)).map(x=>x.start);
  const fa1509 = (await store6.getAvailability("fluid_art", "2026-09-15", 2)).map(x=>x.start);
  log("Fluid Art op di 01/09 (in de reeks)", fa0109.includes("19:00"), fa0109.join(",") || "leeg");
  log("Fluid Art NIET op di 25/08 (tussenweek)", fa2508.length === 0, fa2508.join(",") || "leeg");
  log("Fluid Art op di 15/09 (twee weken later)", fa1509.includes("19:00"), fa1509.join(",") || "leeg");

  // Idempotent.
  let ok6 = true;
  try {
    const u2 = await p.connect();
    await u2.query("SET TIME ZONE 'UTC'");
    await u2.query(fs.readFileSync(path.join(P,"db/migrations/006_update_schedule.sql"),"utf8"));
    u2.release();
  } catch(e){ ok6=false; console.log("   "+e.message); }
  log("006 is idempotent", ok6);

  // ================================================================
  // Import: een boeking op een uur buiten het rooster
  // ================================================================
  // Deze boekingen bestaan echt en zijn betaald. Overslaan zou betekenen dat het
  // tijdslot vrij lijkt en een tweede klant erop kan boeken.
  const buitenRooster = { // maandag: er staat nooit iets gepland op maandag
    serviceCode: "action_painting", dateISO: "2026-09-07", start: "10:15", partySize: 2,
    customer: { name: "Buiten Rooster", email: "buiten@test.be", phone: "047", birthDate: "1990-01-01" },
    note: "", paid: true
  };
  const {rows: voorImport} = await p.query(
    "SELECT COUNT(*)::int c FROM sessions WHERE start_datetime = TIMESTAMPTZ '2026-09-07 10:15:00+02'");
  log("Uitgangspunt: er bestaat geen sessie op ma 07/09 om 10:15", voorImport[0].c === 0);

  const impUit = await store6.importWixBooking(buitenRooster);
  log("Boeking buiten het rooster wordt tóch geïmporteerd", impUit.status === "imported_new_session", impUit.status);

  const {rows: naImport} = await p.query(
    `SELECT s.recurrence_rule_id, COUNT(b.id)::int AS boekingen
       FROM sessions s LEFT JOIN bookings b ON b.session_id = s.id
      WHERE s.start_datetime = TIMESTAMPTZ '2026-09-07 10:15:00+02'
      GROUP BY s.id, s.recurrence_rule_id`);
  log("Er is één sessie aangemaakt met de boeking erop",
      naImport.length === 1 && naImport[0].boekingen === 1, JSON.stringify(naImport[0] || null));
  log("De nieuwe sessie hangt niet aan een roosterregel (eenmalig)",
      naImport[0] && naImport[0].recurrence_rule_id === null);

  const {rows: roomNa} = await p.query(
    `SELECT r.code FROM room_bookings rb JOIN rooms r ON r.id = rb.room_id
      JOIN sessions s ON s.id = rb.session_id
     WHERE s.start_datetime = TIMESTAMPTZ '2026-09-07 10:15:00+02'`);
  log("De boeking kreeg een room toegewezen", roomNa.length === 1, roomNa[0] && roomNa[0].code);

  // Een tweede klant op datzelfde uur hoort gewoon in de bestaande sessie te
  // landen, niet in een nieuwe.
  const imp2 = await store6.importWixBooking({ ...buitenRooster,
    customer: { ...buitenRooster.customer, name: "Tweede Klant", email: "tweede@test.be" } });
  const {rows: naTweede} = await p.query(
    "SELECT COUNT(*)::int c FROM sessions WHERE start_datetime = TIMESTAMPTZ '2026-09-07 10:15:00+02'");
  log("Tweede boeking op hetzelfde uur maakt geen extra sessie aan",
      imp2.status === "imported" && naTweede[0].c === 1, `${imp2.status}, ${naTweede[0].c} sessie(s)`);

  // ================================================================
  // Migratie 008 + snelheid: hoeveel databaseverzoeken per scherm?
  // ================================================================
  await p.query(fs.readFileSync(path.join(P,"db/migrations/008_unique_session_slot.sql"),"utf8"));
  const {rows: idx} = await p.query(
    "SELECT COUNT(*)::int c FROM pg_indexes WHERE indexname = 'uq_sessions_service_start'");
  log("008 maakt de unieke index op (service_id, start_datetime)", idx[0].c === 1);

  // Een tweede sessie voor dezelfde dienst op hetzelfde moment moet nu falen.
  const {rows: eenSessie} = await p.query(
    "SELECT service_id, start_datetime, end_datetime FROM sessions WHERE service_id IS NOT NULL LIMIT 1");
  let dubbelGeweigerd = false;
  try {
    await p.query(
      `INSERT INTO sessions (kind, service_id, start_datetime, end_datetime) VALUES ('service',$1,$2,$3)`,
      [eenSessie[0].service_id, eenSessie[0].start_datetime, eenSessie[0].end_datetime]);
  } catch (e) { dubbelGeweigerd = /duplicate key|unique/i.test(e.message); }
  log("Dubbele sessie op hetzelfde tijdstip wordt geweigerd", dubbelGeweigerd);

  let ok8 = true;
  try { await p.query(fs.readFileSync(path.join(P,"db/migrations/008_unique_session_slot.sql"),"utf8")); }
  catch(e){ ok8=false; console.log("   "+e.message); }
  log("008 is idempotent", ok8);

  // Elk databaseverzoek is op Neon een aparte netwerkronde. Deze grenzen zijn
  // bewust ruim maar VAST: gaat er ooit weer een lus met een query per sessie in
  // sluipen, dan loopt dit meteen op en faalt deze test.
  const echtePool = await require(path.join(P,"lib/db.js")).getPool();
  const origQuery = echtePool.query.bind(echtePool);
  let queryTeller = 0;
  echtePool.query = (...a) => { queryTeller++; return origQuery(...a); };
  const tel = async fn => { queryTeller = 0; await fn(); return queryTeller; };

  const {mondayOfISO: maandagVan, addDaysISO: plusDagen} = require(path.join(P,"lib/dateUtils.js"));
  const maandag = maandagVan(new Date().toISOString().slice(0,10));
  await store6.getWeekSessions(maandag);                    // eerste keer: sessies aanmaken
  const qWeek  = await tel(() => store6.getWeekSessions(plusDagen(maandag, 7)));
  const qMaand = await tel(() => store6.getMonthAvailability("action_painting", 2026, 9, 2));
  const qDag   = await tel(() => store6.getAvailability("action_painting", "2026-09-05", 2));
  log("Weekagenda blijft onder 10 databaseverzoeken", qWeek < 10, `${qWeek} queries`);
  log("Maandkalender blijft onder 12 databaseverzoeken", qMaand < 12, `${qMaand} queries`);
  log("Eén dag in de widget blijft onder 10 databaseverzoeken", qDag < 10, `${qDag} queries`);
  echtePool.query = origQuery;

  // ================================================================
  // Migratie 009: tijdsblok + optionele e-mail
  // ================================================================
  // De testdatabase is uit de NIEUWE schema.sql gebouwd, waar beide zaken al
  // in staan. Deze migratie moet daar dus zonder klagen overheen kunnen —
  // precies wat er op Neon gebeurt als hij per ongeluk twee keer draait.
  //
  // Het echte risico zit in ALTER TYPE ... ADD VALUE: die mag in PostgreSQL
  // niet in dezelfde transactie gebruikt worden als waarin hij is toegevoegd.
  // pool.query() met een heel bestand stuurt alles als één impliciete
  // transactie, en dat is strenger dan wat psql doet. Draait het hier, dan
  // draait het bij Robin zeker.
  let ok9 = true;
  try { await p.query(fs.readFileSync(path.join(P,"db/migrations/009_tijdsblok_en_optionele_email.sql"),"utf8")); }
  catch(e){ ok9=false; console.log("   "+e.message); }
  log("009 draait zonder fout", ok9);

  let ok9b = true;
  try { await p.query(fs.readFileSync(path.join(P,"db/migrations/009_tijdsblok_en_optionele_email.sql"),"utf8")); }
  catch(e){ ok9b=false; console.log("   "+e.message); }
  log("009 is idempotent", ok9b);

  const {rows: enumRij} = await p.query(
    `SELECT COUNT(*)::int c FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'session_kind' AND e.enumlabel = 'block'`);
  log("009 voegt het sessietype 'block' toe", enumRij[0].c === 1);

  const {rows: emailKol} = await p.query(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'customers' AND column_name = 'email'`);
  log("009 maakt customers.email optioneel", emailKol[0].is_nullable === "YES", emailKol[0].is_nullable);

  // Twee klanten zonder e-mail moeten naast elkaar kunnen bestaan — dat is de
  // reden dat de UNIQUE-index mag blijven staan.
  await p.query("INSERT INTO customers (full_name) VALUES ('Zonder Mail 1'), ('Zonder Mail 2')");
  const {rows: zonderMail} = await p.query("SELECT COUNT(*)::int c FROM customers WHERE email IS NULL");
  log("Meerdere klanten zonder e-mail kunnen naast elkaar bestaan", zonderMail[0].c >= 2, `${zonderMail[0].c} klanten`);

  // Maar twee klanten mét hetzelfde adres nog steeds niet.
  let dubbelMailGeweigerd = false;
  try {
    await p.query("INSERT INTO customers (full_name, email) VALUES ('A','dubbel@test.be'), ('B','dubbel@test.be')");
  } catch(e){ dubbelMailGeweigerd = /duplicate key|unique/i.test(e.message); }
  log("Twee klanten met hetzelfde e-mailadres blijven geweigerd", dubbelMailGeweigerd);

  // Een tijdsblok moet nu in de sessies-tabel passen, een 'block' MÉT dienst niet.
  const {rows: blokRij} = await p.query(
    `INSERT INTO sessions (kind, title, start_datetime, end_datetime)
     VALUES ('block','Testblok', now(), now() + interval '1 hour') RETURNING id`);
  log("Een tijdsblok kan opgeslagen worden", !!blokRij[0].id);
  let blokMetDienstGeweigerd = false;
  try {
    const {rows: eenDienst} = await p.query("SELECT id FROM services LIMIT 1");
    await p.query(
      `INSERT INTO sessions (kind, service_id, title, start_datetime, end_datetime)
       VALUES ('block',$1,'Fout', now(), now() + interval '1 hour')`, [eenDienst[0].id]);
  } catch(e){ blokMetDienstGeweigerd = /chk_session_kind_service|check constraint/i.test(e.message); }
  log("Een tijdsblok gekoppeld aan een dienst wordt geweigerd", blokMetDienstGeweigerd);
  await p.query("DELETE FROM sessions WHERE id = $1", [blokRij[0].id]);

  // --- 009 op een ECHT oude database ---------------------------------
  // Hierboven draaide 009 op een database die 'block' al kende, dus het
  // spannende stuk (ALTER TYPE ... ADD VALUE) werd overgeslagen. Daarom een
  // aparte database die eruitziet zoals die van Robin vóór deze migratie:
  // een session_kind zonder 'block', een verplichte e-mail, en de oude CHECK.
  //
  // Het hele bestand gaat in één pool.query() — dus als één impliciete
  // transactie. PostgreSQL weigert een nieuw toegevoegde enum-waarde in
  // dezelfde transactie te gebruiken; daarom staat de CHECK in de migratie op
  // kind::text en niet op kind. Deze test is precies wat dat bewaakt.
  await pg.createDatabase("oud");
  const oud = new Pool({ connectionString: "postgresql://postgres:x@localhost:54399/oud" });
  await oud.query(`
    CREATE TYPE session_kind AS ENUM ('service', 'personal');
    CREATE TYPE session_status AS ENUM ('scheduled','cancelled');
    CREATE TYPE session_visibility AS ENUM ('standard','private');
    CREATE TABLE services (id SERIAL PRIMARY KEY, name TEXT);
    CREATE TABLE customers (
      id SERIAL PRIMARY KEY, full_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE);
    CREATE TABLE sessions (
      id SERIAL PRIMARY KEY,
      kind session_kind NOT NULL DEFAULT 'service',
      service_id INT REFERENCES services(id),
      title TEXT,
      start_datetime TIMESTAMPTZ NOT NULL,
      end_datetime TIMESTAMPTZ NOT NULL,
      status session_status NOT NULL DEFAULT 'scheduled',
      visibility session_visibility NOT NULL DEFAULT 'standard',
      CONSTRAINT chk_session_kind_service CHECK (
        (kind = 'service' AND service_id IS NOT NULL) OR
        (kind = 'personal' AND service_id IS NULL)));
  `);
  let oudOk = true;
  try { await oud.query(fs.readFileSync(path.join(P,"db/migrations/009_tijdsblok_en_optionele_email.sql"),"utf8")); }
  catch(e){ oudOk=false; console.log("   "+e.message); }
  log("009 draait op een database die 'block' nog niet kent", oudOk);

  if (oudOk) {
    // En daarna moet de nieuwe waarde ook echt bruikbaar zijn.
    const {rows: nieuwBlok} = await oud.query(
      `INSERT INTO sessions (kind, title, start_datetime, end_datetime)
       VALUES ('block','Na de migratie', now(), now() + interval '1 hour') RETURNING id`);
    log("Na 009 kan er een tijdsblok bijgemaakt worden", !!nieuwBlok[0].id);
    const {rows: naMigratie} = await oud.query(
      "INSERT INTO customers (full_name) VALUES ('Zonder Mail') RETURNING id");
    log("Na 009 kan er een klant zonder e-mail bijkomen", !!naMigratie[0].id);
  }
  oud.on("error", () => {});
  await oud.end();

  // ================================================================
  // reset-sessions.sql — draait hij, en blijft het juiste staan?
  // ================================================================
  const {rows: voorReset} = await p.query(`
    SELECT (SELECT COUNT(*)::int FROM sessions) AS sessies,
           (SELECT COUNT(*)::int FROM bookings) AS boekingen,
           (SELECT COUNT(*)::int FROM gift_cards) AS bonnen,
           (SELECT COUNT(*)::int FROM customers) AS klanten,
           (SELECT COUNT(*)::int FROM recurrence_rules) AS regels`);
  log("Voor de reset staan er sessies en boekingen in", voorReset[0].sessies > 0 && voorReset[0].boekingen > 0,
      `${voorReset[0].sessies} sessies, ${voorReset[0].boekingen} boekingen`);

  await p.query(fs.readFileSync(path.join(P,"db/reset-sessions.sql"),"utf8"));

  const {rows: naReset} = await p.query(`
    SELECT (SELECT COUNT(*)::int FROM sessions) AS sessies,
           (SELECT COUNT(*)::int FROM bookings) AS boekingen,
           (SELECT COUNT(*)::int FROM payments) AS betalingen,
           (SELECT COUNT(*)::int FROM room_bookings) AS rooms,
           (SELECT COUNT(*)::int FROM gift_cards) AS bonnen,
           (SELECT COUNT(*)::int FROM customers) AS klanten,
           (SELECT COUNT(*)::int FROM recurrence_rules) AS regels`);
  log("Reset wist alle sessies", naReset[0].sessies === 0, naReset[0].sessies);
  log("Reset wist alle boekingen", naReset[0].boekingen === 0, naReset[0].boekingen);
  log("Reset wist alle betalingen en room-toewijzingen",
      naReset[0].betalingen === 0 && naReset[0].rooms === 0);
  log("Cadeaubonnen blijven staan", naReset[0].bonnen === voorReset[0].bonnen, `${naReset[0].bonnen} van ${voorReset[0].bonnen}`);
  log("Klanten blijven staan", naReset[0].klanten === voorReset[0].klanten, `${naReset[0].klanten} van ${voorReset[0].klanten}`);
  log("Het uurrooster blijft staan", naReset[0].regels === voorReset[0].regels, `${naReset[0].regels} regels`);

  // En het belangrijkste: de sessies komen vanzelf terug uit het rooster.
  const dagNa = new Date(); dagNa.setDate(dagNa.getDate() + 7);
  const isoNa = dagNa.toISOString().slice(0,10);
  const avNa2 = await store6.getAvailability("action_painting", isoNa, 2);
  log("Sessies worden vanzelf opnieuw aangemaakt bij het opvragen van een datum",
      avNa2.length > 0, `${avNa2.length} tijdsloten op ${isoNa}`);

  // Zie de toelichting in giftcard_test.js: verbindingen netjes sluiten vóór de
  // embedded server stopt, anders eindigt een geslaagde run toch met exit-code 1.
  const dbm = require(path.join(P,"lib/db.js"));
  const internal = await dbm.getPool();
  internal.on("error", () => {});
  await internal.end();
  p.on("error", () => {});
  await p.end();
  await new Promise(r => setTimeout(r, 250));
  await pg.stop();
  console.log(fails===0 ? "\nAlle migratietests geslaagd." : `\n${fails} test(s) gefaald.`);
  process.exit(fails===0?0:1);
})().catch(e=>{ console.error("FATAL:", e.message); process.exit(1); });
