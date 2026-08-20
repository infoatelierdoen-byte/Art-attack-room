const { toISODate } = require("./dateUtils");

// De agenda als rijen en kolommen, opgebouwd zoals de Wix-boekingslijst waar
// dit systeem op volgt (Robin, aug 2026): dezelfde kolomnamen waar de gegevens
// dezelfde zijn ("Sessiedatum", "Start Tijd", "Servicenaam", "Boeking
// Contactnaam", ...), zodat een bestaande Excel-filter of draaitabel op beide
// bestanden werkt.
//
// Eén rij per ROOM per TIJDSLOT, niet enkel per boeking: zo staat er ook een
// rij voor elke vrije en elke gesloten room. Filter in Excel op de kolom
// "Status" en je hebt ofwel je boekingenlijst ("Geboekt"), ofwel meteen wat er
// nog vrij is ("Vrij").
//
// Deze logica staat bewust hier en niet in de API-route: zo kan de test de
// échte rijen nakijken zonder een HTTP-verzoek na te bootsen. De PDF-variant
// leek in de code correct en gaf tóch elke room als "vrij" terug — dat kwam
// pas aan het licht toen er een echt bestand gemaakt werd.

// De namen die in de Wix-export voorkomen zijn letterlijk overgenomen; de rest
// zijn velden die Wix niet had (het echte aantal personen, de room,
// terugbetalingen) of die wij zelf toevoegen om te kunnen filteren (Dag,
// Status).
const KOLOMMEN = [
  "Sessiedatum",              // 22/08/2026 — zelfde notatie als Wix
  "Dag",                      // zaterdag
  "Start Tijd",
  "Eind Tijd",
  "Duur (min)",
  "Servicenaam",
  "Room",
  "Status",                   // Geboekt / Vrij / Gesloten / Tijdsblok
  "Boeking Contactnaam",
  "Boeking Contact E-mail",
  "Boeking Contact Telefoon",
  "Geboortedatum",
  "Aantal personen",
  "Bedrag",
  "Terugbetaald",
  "Netto",
  "Betaalstatus",
  "Boekingstatus",
  "Geboekt via",
  "Geboekt op",
  "Notitie",
  "Reden sluiting"
];

/**
 * Zet de sessies om in exportrijen: per dag, per starttijd, per room één rij.
 *
 * @param {object}  data
 * @param {Array}   data.sessies   uit store.getAgendaExportRows()
 * @param {Array}   data.gesloten  idem
 * @param {Array}   data.rooms     uit store.getRoomsList() — {id, label, capacity}
 * @param {boolean} data.alleenGeboekt  laat de vrije en gesloten rijen weg
 * @returns {Array<Array<string|number>>}  rijen, in dezelfde volgorde als KOLOMMEN
 */
function bouwRijen({ sessies, gesloten, rooms, alleenGeboekt = false }) {
  const rijen = [];
  const dagen = [...new Set(sessies.map(s => s.dateISO))].sort();

  for (const dISO of dagen) {
    const vanDeDag = sessies.filter(s => s.dateISO === dISO);
    const dichtDeDag = gesloten.filter(g => g.dateISO === dISO);
    const starts = [...new Set(vanDeDag.map(s => s.start))].sort();

    for (const start of starts) {
      const opDitUur = vanDeDag.filter(s => s.start === start);
      const eerste = opDitUur[0];

      if (eerste.kind === "personal") {
        // Een persoonlijke afspraak blokkeert de hele zaak, niet één room.
        if (!alleenGeboekt) {
          rijen.push(rijVoorSlot(eerste, "", "Gesloten", eerste.title || "Privé"));
        }
        continue;
      }

      if (eerste.kind === "block") {
        // Een tijdsblok neemt geen rooms in en blokkeert niets — het staat er
        // puur ter info, met zijn titel in de kolom "Reden sluiting".
        if (!alleenGeboekt) {
          rijen.push(rijVoorSlot(eerste, "", "Tijdsblok", eerste.title || ""));
        }
        continue;
      }

      if (eerste.usesRoomAssignment) {
        // Action Painting: vier rooms naast elkaar, elk hun eigen rij.
        //
        // Een grote groep (meer dan in één room past) staat in twee rooms en
        // krijgt dus twee rijen. Het BEDRAG hoort maar één keer geteld te
        // worden, anders klopt een som in Excel niet. De tweede rij toont dus
        // wel de klant en de room, maar lege bedragkolommen en een notitie die
        // zegt bij welke boeking ze hoort.
        const alGeteld = new Set();
        for (const room of rooms) {
          // getRoomsList() geeft {id, label, capacity} — `id` IS de roomcode
          // ("M", "VL", ...), er is geen aparte `code`. Diezelfde verwarring
          // zorgde er in de PDF-export voor dat élke room als "vrij" op het
          // blad kwam terwijl er wel degelijk boekingen waren.
          const boeking = opDitUur.find(s => s.bookingId && s.roomCode === room.id);
          const dicht = dichtDeDag.find(g => g.start === start && g.roomCode === room.id);
          const label = room.label || room.id;
          if (boeking) {
            const vervolg = alGeteld.has(boeking.bookingId);
            alGeteld.add(boeking.bookingId);
            rijen.push(rijVoorBoeking(boeking, label, vervolg));
          }
          else if (dicht && !alleenGeboekt) rijen.push(rijVoorSlot(eerste, label, "Gesloten", dicht.reason));
          else if (!alleenGeboekt) rijen.push(rijVoorSlot(eerste, label, "Vrij", ""));
        }
      } else {
        // Fluid Art: één zaal met een sessiecapaciteit, dus een roomkolom is
        // hier betekenisloos. Elke boeking krijgt zijn eigen rij; is er geen
        // enkele, dan één rij "Vrij".
        const geboekt = opDitUur.filter(s => s.bookingId);
        for (const b of geboekt) rijen.push(rijVoorBoeking(b, ""));
        if (geboekt.length === 0 && !alleenGeboekt) {
          rijen.push(rijVoorSlot(eerste, "", "Vrij", ""));
        }
      }
    }
  }

  return rijen;
}

/** Kop + rijen samen als één CSV-tekst (zonder BOM). */
function bouwCsv(rijen) {
  return [KOLOMMEN.join(","), ...rijen.map(r => r.map(csvVeld).join(","))].join("\r\n");
}

/**
 * @param {boolean} [vervolgRij] — true voor de TWEEDE room van dezelfde
 *   boeking (een grote groep neemt er twee in). Bedrag en aantal personen
 *   blijven dan leeg zodat een som in Excel niet dubbel telt.
 */
function rijVoorBoeking(b, room, vervolgRij = false) {
  const bedrag = Number(b.amount || 0);
  const terug = Number(b.refundedAmount || 0);
  const notitie = (b.note || "").replace(/\s+/g, " ").trim();
  if (vervolgRij) {
    return [
      dagNotatie(b.dateISO), dagNaam(b.dateISO), b.start, b.end || "", b.durationMin ?? "",
      serviceLabel(b), room, "Geboekt",
      b.customer || "", b.customerEmail || "", b.customerPhone || "",
      b.customerBirthDate ? dagNotatie(b.customerBirthDate) : "",
      "", "", "", "",
      betaalLabel(b), boekingLabel(b), bronLabel(b), tijdstip(b.bookedAt),
      [notitie, "extra room van dezelfde boeking"].filter(Boolean).join(" | "),
      ""
    ];
  }
  return [
    dagNotatie(b.dateISO), dagNaam(b.dateISO), b.start, b.end || "", b.durationMin ?? "",
    serviceLabel(b), room, "Geboekt",
    b.customer || "", b.customerEmail || "", b.customerPhone || "",
    b.customerBirthDate ? dagNotatie(b.customerBirthDate) : "",
    b.partySize ?? "",
    euro(bedrag), euro(terug), euro(bedrag - terug),
    betaalLabel(b), boekingLabel(b), bronLabel(b), tijdstip(b.bookedAt),
    notitie,
    ""
  ];
}

function rijVoorSlot(sessie, room, status, reden) {
  return [
    dagNotatie(sessie.dateISO), dagNaam(sessie.dateISO), sessie.start, sessie.end || "",
    sessie.durationMin ?? "",
    serviceLabel(sessie), room, status,
    "", "", "", "", "", "", "", "", "", "", "", "", "",
    reden || ""
  ];
}

function serviceLabel(e) {
  if (e.kind === "personal") return "Persoonlijke afspraak";
  if (e.kind === "block") return "Tijdsblok";
  if (e.service === "fluid_art") return "Fluid Art";
  if (e.service === "action_painting") return "Action Painting";
  return e.serviceName || e.service || "";
}

function betaalLabel(b) {
  if (b.paymentStatus === "paid") return "Betaald";
  if (b.paymentStatus === "refunded") return "Terugbetaald";
  return "Niet betaald";
}

function boekingLabel(b) {
  return b.pendingConfirmation ? "Reservering" : "Bevestigd";
}

function bronLabel(b) {
  if (b.bookedVia === "backoffice") return "Backoffice";
  if (b.bookedVia === "wix_import") return "Wix (geïmporteerd)";
  return "Website";
}

function euro(n) {
  // Komma als decimaalteken: zo leest Excel in een Belgische/Nederlandse
  // taalinstelling dit als een getal en niet als tekst.
  return Number(n || 0).toFixed(2).replace(".", ",");
}

function tijdstip(waarde) {
  if (!waarde) return "";
  const d = waarde instanceof Date ? waarde : new Date(waarde);
  if (Number.isNaN(d.getTime())) return "";
  const uu = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${dagNotatie(toISODate(d))} ${uu}:${mm}`;
}

const DAGEN_NL = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];

// "2026-08-22" -> "22/08/2026", dezelfde notatie als de Wix-export.
function dagNotatie(iso) {
  const [y, m, d] = String(iso).split("-");
  return `${d}/${m}/${y}`;
}

function dagNaam(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return DAGEN_NL[new Date(y, m - 1, d).getDay()];
}

// Escapen én formules onschadelijk maken. Een klantnaam komt uit het publieke
// boekingsformulier; begint een cel met = + - @ dan voert Excel die uit. Zelfde
// bescherming als in de e-maillijst-export, zie het veiligheidsrapport.
//
// Het scheidingsteken hieronder is een komma, dus een puntkomma hoeft strikt
// genomen niet gequote te worden — maar Excel-NL splitst standaard óók op
// puntkomma en zou een cel met een puntkomma dan verkeerd opdelen. Vandaar
// staat ";" wél in de lijst met tekens die quoting uitlokken.
function csvVeld(waarde) {
  let str = waarde === null || waarde === undefined ? "" : String(waarde);
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  if (/[",\n\r;]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

module.exports = { KOLOMMEN, bouwRijen, bouwCsv, csvVeld, dagNotatie };
