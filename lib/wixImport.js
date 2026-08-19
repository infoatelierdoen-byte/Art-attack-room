// Parser voor de boekingslijst-CSV die je uit Wix Bookings kan exporteren
// ("Boekingen importeren (CSV)" in /backend, zie pages/api/admin/import-bookings.js).
// Doel: toekomstige tijdsloten die al via Wix geboekt zijn blokkeren in dit
// nieuwe systeem (zodat niemand via de widget dubbel kan boeken), en de
// klantengegevens in de database krijgen.
const { parse } = require("csv-parse/sync");

// Typfouten in e-mailadressen uit de Wix-export, door Robin bevestigd (aug
// 2026). Zonder deze correctie krijgen die twee klanten nooit een
// bevestigingsmail — de mail vertrekt naar een domein dat niet bestaat.
// Bewust een expliciete lijst en geen slimme "raad het domein"-logica: een
// verkeerd geraden adres stuurt post naar een vreemde.
const EMAIL_CORRECTIES = {
  "verhelst.steph@gmail.gom": "verhelst.steph@gmail.com",
  "piet@vetopartners.br": "piet@vetopartners.be"
};

function codeFromName(name) {
  return name.toLowerCase().replace(/\s+/g, "_");
}

const MONTHS_NL = {
  januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6,
  juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12
};

// "10/10/2026" (D/M/YYYY, Belgische notatie — nooit M/D) -> "2026-10-10"
function parseWixDate(str) {
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// "1978-09-28" blijft zo (al ISO); een enkele extra check dat het echt een
// datum is, anders (bv. "Onbekend") krijgen we geen geboortedatum mee.
function parseBirthDate(str) {
  const s = String(str || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Sommige Wix-exports geven data-datums in tekstvorm ("10 oktober 2026") in
// plaats van D/M/YYYY — niet gebruikt voor Sessiedatum (die is al D/M/YYYY),
// maar wel handig als losse helper voor eventuele toekomstige e-mail-parsing.
function parseDutchLongDate(str) {
  const m = String(str).trim().match(/^(\d{1,2})\s+(\w+)\s+(\d{4})$/i);
  if (!m) return null;
  const [, d, monthName, y] = m;
  const mo = MONTHS_NL[monthName.toLowerCase()];
  if (!mo) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// Bouwt een leesbare notitie uit de "Formuliervraag N / Formulierantwoord N"
// kolomparen — behalve "Geboortedatum" (die gaat apart naar de klant, niet
// naar de boekingsnotitie) en alles wat "Onbekend" is (= niet ingevuld).
function extractNote(row) {
  const lines = [];
  for (let i = 1; i <= 10; i++) {
    const q = (row[`Formuliervraag ${i}`] || "").trim();
    const a = (row[`Formulierantwoord ${i}`] || "").trim();
    if (!q || !a || q === "Onbekend" || a === "Onbekend" || q === "Geboortedatum") continue;
    lines.push(`${q}: ${a}`);
  }
  return lines.join(" | ");
}

function extractBirthDate(row) {
  for (let i = 1; i <= 10; i++) {
    const q = (row[`Formuliervraag ${i}`] || "").trim();
    if (q === "Geboortedatum") {
      return parseBirthDate(row[`Formulierantwoord ${i}`]);
    }
  }
  return null;
}

/**
 * @param {string} csvText — ruwe inhoud van het geüploade CSV-bestand
 * @returns {{ rows: Array, parseErrors: Array<{line:number, message:string}> }}
 *   rows = genormaliseerde boekingen, klaar voor store.importWixBooking().
 *   Rijen met status "Geannuleerd"/"Cancelled" of die niet te parsen zijn
 *   komen niet in `rows` terecht maar wel als item in parseErrors.
 */
function parseWixBookingsCsv(csvText) {
  const records = parse(csvText, { columns: true, skip_empty_lines: true, bom: true });

  const rows = [];
  const parseErrors = [];

  records.forEach((row, idx) => {
    const lineNo = idx + 2; // +1 voor de header-rij, +1 voor 1-based
    const status = (row["Boekingstatus"] || "").trim().toLowerCase();
    if (status.includes("geannuleerd") || status.includes("cancel")) {
      return; // geannuleerde Wix-boekingen bewust niet meenemen
    }

    const dateISO = parseWixDate(row["Sessiedatum"]);
    const start = (row["Start Tijd"] || "").trim();
    const serviceName = (row["Servicenaam"] || "").trim();
    // Wix noemt deze dienst in de export nog altijd "Art Attack Room" (dat
    // is Wix's eigen naam, los van hoe wij de dienst intern noemen) — sinds
    // de hernoeming naar "Action Painting" (Robin, aug 2026) moet dat hier
    // vertaald worden naar onze eigen servicecode. Zonder deze vertaling zou
    // getServiceRow() in store-sql.js geen matchende dienst meer vinden voor
    // elke toekomstige (her-)import van een Wix-export met de oude naam.
    const rawServiceCode = codeFromName(serviceName);
    const serviceCode = rawServiceCode === "art_attack_room" ? "action_painting" : rawServiceCode;
    const rawEmail = (row["Boeking Contact E-mail"] || "").trim().toLowerCase();
    const email = EMAIL_CORRECTIES[rawEmail] || rawEmail;
    const name = (row["Boeking Contactnaam"] || "").trim();
    const phoneRaw = (row["Boeking Contact Telefoon"] || "").trim();
    const phone = phoneRaw && phoneRaw !== "Onbekend" ? phoneRaw : null;

    if (!dateISO || !start || !serviceCode || !email || !name) {
      parseErrors.push({ line: lineNo, message: `Onvolledige rij (datum/tijd/dienst/naam/e-mail ontbreekt): ${name || email || "?"}` });
      return;
    }

    let partySize;
    if (serviceCode === "action_painting") {
      // "Bezette plaatsen" is bij Action Painting het aantal ROOMS (altijd
      // 1), niet het aantal personen — dat staat nergens betrouwbaar in
      // deze CSV. Bewuste keuze (Robin, juli 2026): groepsgrootte 2 (het
      // minimum) voor elke geïmporteerde boeking. Blokkeert de room correct
      // en overschat nooit de benodigde capaciteit; nadien manueel aan te
      // passen per boeking indien de echte groepsgrootte gekend is.
      partySize = 2;
    } else {
      // Fluid Art is een gedeelde les tot capaciteit 10 — daar is "Bezette
      // plaatsen" wel het echte aantal personen.
      const n = parseInt(row["Bezette plaatsen"], 10);
      partySize = Number.isFinite(n) && n > 0 ? n : 1;
    }

    const paid = (row["Betaalstatus"] || "").trim().toLowerCase() === "betaald";

    rows.push({
      dateISO,
      start,
      serviceCode,
      serviceName,
      partySize,
      paid,
      emailCorrected: email !== rawEmail ? rawEmail : null,
      customer: {
        name,
        email,
        phone,
        birthDate: extractBirthDate(row)
      },
      note: extractNote(row),
      sourceLine: lineNo
    });
  });

  return { rows, parseErrors };
}

module.exports = { parseWixBookingsCsv, parseWixDate, parseDutchLongDate, EMAIL_CORRECTIES };
