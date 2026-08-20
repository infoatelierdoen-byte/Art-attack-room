// Maakt een echt voorbeeldbestand van de agenda-export op een verse database,
// zodat je ziet wat er in Excel belandt zonder dat je moet deployen.
//
//   node scripts/voorbeeld-export.js /pad/naar/uitvoer.csv
//
// Niet nodig in productie — dit is een hulpscript voor het bouwen/nakijken.
process.env.TZ = "Europe/Brussels";

const path = require("path");
const fs = require("fs");
const EmbeddedPostgres = require("embedded-postgres").default || require("embedded-postgres");

const PROJECT = path.join(__dirname, "..");
const DATA_DIR = "/tmp/embedded-pg-voorbeeld";
const UIT = process.argv[2] || "/tmp/agenda-voorbeeld.csv";

async function main() {
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR, user: "postgres", password: "postgres", port: 54339, persistent: false
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("booking_voorbeeld");
  process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:54339/booking_voorbeeld";

  try {
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(fs.readFileSync(path.join(PROJECT, "db/schema.sql"), "utf8"));
    await pool.query(fs.readFileSync(path.join(PROJECT, "db/seed.sql"), "utf8"));

    const store = require(path.join(PROJECT, "lib/store-sql.js"));
    const { mondayOfISO, addDaysISO } = require(path.join(PROJECT, "lib/dateUtils.js"));
    const { bouwRijen, bouwCsv } = require(path.join(PROJECT, "lib/agendaExport.js"));

    // Een volledige week uitkiezen die volgende maandag begint.
    const vandaag = new Date();
    const maandag = addDaysISO(mondayOfISO(vandaag.toISOString().slice(0, 10)), 7);
    const zondag = addDaysISO(maandag, 13); // twee weken, zodat de tweewekelijkse Fluid Art er zeker in valt

    // Materialiseren zodat we weten welke sessies er die week staan.
    await store.getWeekSessions(maandag);
    await store.getWeekSessions(addDaysISO(maandag, 7));
    const week = await store.getAgendaExportRows(maandag, zondag);
    const ap = week.sessies.filter(s => s.service === "action_painting" && !s.bookingId);
    const fa = week.sessies.filter(s => s.service === "fluid_art" && !s.bookingId);

    const klanten = [
      { naam: "Sofie Van den Berghe", mail: "sofie.vdb@telenet.be", tel: "0475 12 34 56", personen: 6, notitie: "verjaardag, taart meegebracht" },
      { naam: "Kevin De Smet", mail: "kevin.desmet@gmail.com", tel: "0498 77 88 99", personen: 2, notitie: "" },
      { naam: "Familie Peeters", mail: "peeters.familie@skynet.be", tel: "0472 55 66 77", personen: 4, notitie: "twee kinderen van 8 en 10" },
      { naam: "Amina El Karoui", mail: "amina.elk@outlook.com", tel: "0486 11 22 33", personen: 3, notitie: "" },
      { naam: "Jonas Verlinden", mail: "jonas.verlinden@proximus.be", tel: "0479 44 55 66", personen: 7, notitie: "teambuilding, factuur nodig" }
    ];

    const gemaakt = [];
    for (let i = 0; i < klanten.length && i < ap.length; i++) {
      const s = ap[i];
      const k = klanten[i];
      try {
        const { booking } = await store.createManualBooking({
          serviceCode: "action_painting", dateISO: s.dateISO, start: s.start, partySize: k.personen,
          customer: { name: k.naam, email: k.mail, phone: k.tel },
          note: k.notitie, paymentMethod: i % 3 === 2 ? "transfer" : "cash",
          reserveOnly: i % 3 === 2
        });
        gemaakt.push(booking);
      } catch (err) {
        console.log(`(overgeslagen: ${k.naam} — ${err.message})`);
      }
    }

    // Een Fluid Art-boeking (die dienst werkt zonder rooms).
    if (fa[0]) {
      try {
        await store.createManualBooking({
          serviceCode: "fluid_art", dateISO: fa[0].dateISO, start: fa[0].start, partySize: 2,
          customer: { name: "Lien Maes", email: "lien.maes@gmail.com", phone: "0491 22 33 44" },
          note: "", paymentMethod: "cash"
        });
      } catch (err) {
        console.log(`(Fluid Art overgeslagen — ${err.message})`);
      }
    }

    // Eén gedeeltelijke terugbetaling, zodat de kolommen Terugbetaald/Netto
    // niet allemaal op 0,00 staan.
    if (gemaakt[0]) {
      await store.refundBooking(gemaakt[0].id, { refundAmount: 30, reason: "kleinere groep" });
    }

    // Eén gesloten room en één persoonlijke afspraak.
    if (ap[6]) {
      await store.closeRoom({ dateISO: ap[6].dateISO, start: ap[6].start, roomId: "M", reason: "schilderij aan het drogen" });
    }
    await store.addPersonalAppointment({
      dateISO: addDaysISO(maandag, 1), start: "10:00", end: "11:30",
      title: "Leveranciersafspraak verf", visibility: "private"
    });

    const rooms = await store.getRoomsList();
    const data = await store.getAgendaExportRows(maandag, zondag);
    const rijen = bouwRijen({ ...data, rooms, alleenGeboekt: false });
    fs.writeFileSync(UIT, "﻿" + bouwCsv(rijen), "utf8");
    console.log(`${rijen.length} rijen weggeschreven naar ${UIT} (week van ${maandag})`);

    pool.on("error", () => {});
    await pool.end();
    const dbModule = require(path.join(PROJECT, "lib/db.js"));
    const internalPool = await dbModule.getPool();
    internalPool.on("error", () => {});
    await internalPool.end();
    await new Promise(r => setTimeout(r, 250));
  } finally {
    await pg.stop();
  }
}

main().catch(err => { console.error("FOUT:", err); process.exitCode = 1; });
