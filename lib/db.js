// Databaseverbinding.
//
// Met DATABASE_URL ingesteld (.env.local): een echte PostgreSQL-verbinding
// via `pg`, tegen db/schema.sql (voer dat schema + db/seed.sql eenmalig
// manueel uit tegen die database, bv. via psql of een migratietool).
//
// Zonder DATABASE_URL (lokale ontwikkeling, geen setup nodig): een
// in-memory SQL-engine (`pg-mem`) die zich exact gedraagt als een
// PostgreSQL-verbinding (dezelfde `pool.query(text, params)`-interface),
// automatisch geladen met db/schema.sql en db/seed.sql. Dezelfde
// SQL-queries in lib/store-sql.js draaien dus ongewijzigd in beide gevallen
// — enkel de pool zelf verschilt.
//
// Belangrijk: pg-mem is een test-/ontwikkel-engine, geen vervanging voor
// een echte database in productie (geen persistentie tussen herstarts,
// niet elke Postgres-functie wordt ondersteund).

const fs = require("fs");
const path = require("path");

// Alle openingsuren/rooster-logica gaat uit van lokale (Belgische)
// klokttijd. Zet dit expliciet vast, want een productie-host (bv. Vercel)
// draait standaard in UTC — zonder deze regel zouden sessies enkele uren
// verschuiven t.o.v. de bedoelde openingsuren.
process.env.TZ = "Europe/Brussels";

let poolPromise = null;

function getPool() {
  if (!poolPromise) {
    // In productie NOOIT stil terugvallen op de in-memory database. Viel
    // DATABASE_URL ooit weg bij een redeploy, dan startte de site gewoon op met
    // een lege database uit db/seed.sql: geen fout, geen alarm, alle boekingen
    // "weg" en bij elke herstart opnieuw leeg. Beter meteen luid falen.
    if (!process.env.DATABASE_URL && process.env.NODE_ENV === "production") {
      throw new Error(
        "DATABASE_URL ontbreekt in productie. De app weigert te starten met de " +
        "in-memory testdatabase — zet DATABASE_URL in de Vercel-omgevingsvariabelen."
      );
    }
    poolPromise = process.env.DATABASE_URL ? createRealPool() : createDevPool();
  }
  return poolPromise;
}

async function createRealPool() {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

async function createDevPool() {
  const { newDb } = require("pg-mem");
  const db = newDb({ autoCreateForeignKeyIndices: true });

  // gen_random_uuid() komt normaal uit de pgcrypto-extensie; pg-mem heeft
  // die niet, dus we registreren hem manueel met Node's eigen crypto-module.
  db.public.registerFunction({
    name: "gen_random_uuid",
    returns: "uuid",
    // impure: anders memoized pg-mem het resultaat en krijgt elke rij in
    // een multi-row INSERT (of opeenvolgende inserts) dezelfde uuid.
    impure: true,
    implementation: () => require("crypto").randomUUID()
  });

  const schemaPath = path.join(process.cwd(), "db", "schema.sql");
  let schemaSql = fs.readFileSync(schemaPath, "utf8");
  // pg-mem ondersteunt (nog) geen string_agg, dus de 4 rapportage-VIEWs
  // (niet nodig voor de kernlogica hieronder) worden enkel voor deze
  // dev-engine overgeslagen. In db/schema.sql zelf blijven ze gewoon staan
  // — dat is 100% geldige PostgreSQL-syntax voor de echte database.
  schemaSql = schemaSql.replace(/CREATE VIEW[\s\S]*?;\n/g, "");
  db.public.none(schemaSql);

  const seedPath = path.join(process.cwd(), "db", "seed.sql");
  const seedSql = fs.readFileSync(seedPath, "utf8");
  db.public.none(seedSql);

  const { Pool } = db.adapters.createPg();
  return new Pool();
}

module.exports = { getPool };
