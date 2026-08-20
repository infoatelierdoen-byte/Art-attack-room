// PDF-export voor boekingen ("Boeking exporteren" in het detailscherm) en voor
// de weekagenda ("Agenda exporteren" in het "Meer acties"-menu). Gebruikt pdfkit: pure
// JavaScript, geen headless browser nodig (bv. Puppeteer) — belangrijk
// omdat dit in een serverless functie op Vercel moet kunnen draaien zonder
// een zware/native dependency.
const PDFDocument = require("pdfkit");

function serviceLabel(code) {
  if (code === "fluid_art") return "Fluid Art";
  if (code === "action_painting") return "Action Painting";
  return code;
}

function streamToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function money(n) {
  return `EUR ${Number(n).toFixed(2)}`;
}

const DAGEN_NL = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];
const MAANDEN_NL = ["januari", "februari", "maart", "april", "mei", "juni",
                    "juli", "augustus", "september", "oktober", "november", "december"];

// "2026-08-22" -> "zaterdag 22 augustus 2026".
// Bewust met new Date(y, m-1, d) en niet met Date.parse van de ISO-string:
// die laatste leest hem als UTC-middernacht en kan er in onze tijdzone een dag
// naast zitten — dezelfde valkuil als elders in dit project.
function formatDateNl(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${DAGEN_NL[dt.getDay()]} ${d} ${MAANDEN_NL[m - 1]} ${y}`;
}

// Enkele-boeking export: alle details op 1 pagina, bedoeld om extern te
// bewaren (bv. voor de klant, of in een eigen archief/boekhoudsysteem).
async function generateBookingPdf(b) {
  const doc = new PDFDocument({ margin: 50 });
  const bufferPromise = streamToBuffer(doc);

  doc.fontSize(18).font("Helvetica-Bold").text("Boekingsdetails");
  doc.moveDown(0.3);
  doc.fontSize(9).font("Helvetica").fillColor("#666").text(`Boeking-ID: ${b.id}`);
  doc.fillColor("#000");
  doc.moveDown();

  doc.fontSize(13).font("Helvetica-Bold").text(serviceLabel(b.service));
  doc.fontSize(11).font("Helvetica").text(`${b.dateISO} om ${b.start}${b.end ? " - " + b.end : ""}`);
  doc.moveDown();

  doc.fontSize(11).font("Helvetica-Bold").text("Klant");
  doc.font("Helvetica").text(b.customerName);
  // E-mail is optioneel bij een manuele boeking; pdfkit struikelt over
  // undefined, dus enkel schrijven wat er is.
  if (b.customerEmail) doc.text(b.customerEmail);
  if (b.customerPhone) doc.text(b.customerPhone);
  doc.moveDown();

  doc.font("Helvetica-Bold").text("Boeking");
  doc.font("Helvetica").text(`Aantal personen: ${b.partySize}`);
  if (b.roomCodes) doc.text(`Room: ${b.roomCodes}`);
  doc.text(`Status: ${b.status}`);
  doc.text(`Aangemaakt via: ${b.bookedVia === "backoffice" ? "backoffice (medewerker)" : "website"}`);
  if (b.note) doc.text(`Notitie: ${b.note}`);
  doc.moveDown();

  doc.font("Helvetica-Bold").text("Betaling");
  doc.font("Helvetica").text(`Subtotaal: ${money(b.subtotal)}`);
  if (b.discount) doc.text(`Korting: -${money(b.discount)}`);
  doc.text(`Te betalen: ${money(b.amountDue)}`);
  doc.text(`Betaalstatus: ${b.paymentStatus}`);
  if (b.refundedAmount > 0) {
    doc.moveDown(0.3);
    doc.fillColor("#B33A2E");
    doc.text(`Terugbetaald: ${money(b.refundedAmount)}`);
    if (b.refundReason) doc.text(`Reden: ${b.refundReason}`);
    if (b.refundedAt) doc.text(`Op: ${new Date(b.refundedAt).toLocaleString("nl-BE")}`);
    doc.fillColor("#000");
  }
  if (b.invoiceRequested) {
    doc.moveDown(0.3);
    doc.text(`Factuur aangevraagd${b.billitInvoiceId ? ` (Billit-ID: ${b.billitInvoiceId})` : ""}`);
  }

  doc.moveDown(1.5);
  doc.fontSize(8).fillColor("#888")
    .text(`Aangemaakt op ${new Date(b.createdAt).toLocaleString("nl-BE")} — geëxporteerd op ${new Date().toLocaleString("nl-BE")}`);

  doc.end();
  return bufferPromise;
}

function padCol(str, len) {
  str = String(str ?? "");
  if (str.length > len) return str.slice(0, Math.max(0, len - 1)) + "…";
  return str.padEnd(len);
}
/**
 * Agenda-export: de weekagenda zoals je ze op het scherm ziet, maar dan per dag
 * onder elkaar en afdrukbaar (Robin, aug 2026). Vervangt de vorige
 * "Week exporteren", die een platte lijst boekingen gaf zonder te tonen welke
 * rooms vrij waren of gesloten.
 *
 * Per dag: de werkuren van het team bovenaan, dan elk tijdslot met alle vier de
 * rooms eronder — geboekt, vrij of gesloten. Zo is één blad genoeg om te weten
 * wie er komt, met hoeveel, in welke room, en wat er nog vrij is.
 */
async function generateAgendaPdf({ mondayISO, dagen, weekTotaal }) {
  const doc = new PDFDocument({ margin: 42, size: "A4" });
  const bufferPromise = streamToBuffer(doc);

  const ACCENT = "#C1653A";
  const GRIJS = "#6B6B72";

  doc.fontSize(17).font("Helvetica-Bold").fillColor("#000")
     .text(`Agenda — week van ${formatDateNl(mondayISO)}`);
  doc.fontSize(9.5).font("Helvetica").fillColor(GRIJS)
     .text(`${weekTotaal.boekingen} boeking${weekTotaal.boekingen === 1 ? "" : "en"} · `
         + `${weekTotaal.personen} personen · netto ${money(weekTotaal.omzet)}`
         + `    (afgedrukt op ${formatDateNl(new Date().toISOString().slice(0, 10))})`);
  doc.moveDown(1);

  const nieuwePaginaIndienNodig = (nodig = 60) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - nodig) {
      doc.addPage({ size: "A4", margin: 42 });
    }
  };

  for (const dag of dagen) {
    nieuwePaginaIndienNodig(90);

    // Dagkop
    doc.moveDown(0.3);
    doc.fontSize(12).font("Helvetica-Bold").fillColor(ACCENT).text(dag.titel);
    doc.fontSize(8.5).font("Helvetica").fillColor(GRIJS)
       .text(dag.werkuren.length ? `Werkuren: ${dag.werkuren.join(" · ")}` : "Werkuren: niets ingepland");
    doc.moveTo(doc.page.margins.left, doc.y + 2)
       .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
       .strokeColor("#DDD8D0").lineWidth(0.7).stroke();
    doc.moveDown(0.6);

    if (dag.slots.length === 0) {
      doc.fontSize(9).font("Helvetica-Oblique").fillColor(GRIJS).text("   Geen sessies gepland.");
      doc.moveDown(0.4);
      continue;
    }

    for (const slot of dag.slots) {
      nieuwePaginaIndienNodig(70);
      doc.fontSize(10).font("Helvetica-Bold").fillColor("#000")
         .text(`  ${slot.start}   ${slot.dienst}${slot.bezetting ? `   (${slot.bezetting})` : ""}`);

      for (const r of slot.rooms) {
        nieuwePaginaIndienNodig(26);
        const x = doc.page.margins.left + 22;
        doc.fontSize(9).font("Helvetica-Bold").fillColor("#000").text(padCol(r.room, 5), x, doc.y, { continued: true });
        if (r.soort === "boeking") {
          doc.font("Helvetica").text(
            `${padCol(r.klant, 30)} ${padCol(r.personen + "p", 4)} ${padCol(money(r.bedrag), 10)} ${r.status}`
          );
          if (r.notitie) {
            doc.fontSize(8).font("Helvetica-Oblique").fillColor(GRIJS)
               .text(`        ${r.notitie}`, doc.page.margins.left + 22, doc.y, { width: 460 });
            doc.fillColor("#000");
          }
        } else if (r.soort === "gesloten") {
          doc.font("Helvetica-Oblique").fillColor(GRIJS).text(`gesloten${r.reden ? ` — ${r.reden}` : ""}`);
          doc.fillColor("#000");
        } else {
          doc.font("Helvetica").fillColor("#9A9A9F").text(r.vrijTekst || "vrij");
          doc.fillColor("#000");
        }
      }
      doc.moveDown(0.45);
    }

    doc.fontSize(8.5).font("Helvetica-Bold").fillColor(GRIJS)
       .text(`   Dagtotaal: ${dag.totaal.boekingen} boeking${dag.totaal.boekingen === 1 ? "" : "en"}`
           + ` · ${dag.totaal.personen} persoon${dag.totaal.personen === 1 ? "" : "en"}`
           + ` · ${money(dag.totaal.omzet)}`);
    doc.fillColor("#000");
    doc.moveDown(0.8);
  }

  doc.end();
  return bufferPromise;
}

module.exports = { generateBookingPdf, generateAgendaPdf };
