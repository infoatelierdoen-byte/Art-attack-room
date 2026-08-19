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

  const dbm = require(path.join(P,"lib/db.js")); (await dbm.getPool()).end();
  await p.end(); await pg.stop();
  console.log(fails===0 ? "\nAlle migratietests geslaagd." : `\n${fails} test(s) gefaald.`);
  process.exit(fails===0?0:1);
})().catch(e=>{ console.error("FATAL:", e.message); process.exit(1); });
