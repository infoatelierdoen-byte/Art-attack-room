// PDF-export voor boekingen ("Boeking exporteren" in het detailscherm, en
// "Week exporteren" in het "Meer acties"-menu). Gebruikt pdfkit: pure
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
  doc.text(b.customerEmail);
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

// Overzicht van alle boekingen in een week, 1 lijn per boeking — bedoeld om
// extern te bewaren of door te sturen (bv. naar een boekhouder), niet als
// vervanging van de wekelijkse Billit-verzamelfactuur.
async function generateWeekBookingsPdf(weekLabel, bookings) {
  const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
  const bufferPromise = streamToBuffer(doc);

  doc.fontSize(16).font("Helvetica-Bold").text(`Boekingen — week van ${weekLabel}`);
  doc.moveDown(0.5);

  const netTotal = bookings.reduce((sum, b) => sum + (Number(b.amount || 0) - Number(b.refundedAmount || 0)), 0);
  doc.fontSize(10).font("Helvetica").fillColor("#333")
    .text(`${bookings.length} boeking${bookings.length === 1 ? "" : "en"} — netto omzet ${money(netTotal)}`);
  doc.fillColor("#000");
  doc.moveDown(1);

  const cols = [
    { label: "Datum", w: 12 },
    { label: "Tijd", w: 7 },
    { label: "Dienst", w: 16 },
    { label: "Klant", w: 24 },
    { label: "P", w: 3 },
    { label: "Room", w: 6 },
    { label: "Bedrag", w: 12 },
    { label: "Status", w: 12 }
  ];

  function drawRow(values, opts = {}) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage({ size: "A4", layout: "landscape", margin: 40 });
    }
    doc.font(opts.bold ? "Courier-Bold" : "Courier").fontSize(9);
    const line = cols.map((c, i) => padCol(values[i], c.w)).join(" ");
    doc.text(line);
  }

  drawRow(cols.map(c => c.label), { bold: true });
  doc.moveDown(0.2);

  for (const b of bookings) {
    const net = Number(b.amount || 0) - Number(b.refundedAmount || 0);
    drawRow([
      b.dateISO,
      b.start,
      serviceLabel(b.service),
      b.customer || "",
      b.partySize,
      b.roomCode || "-",
      money(net),
      b.status
    ]);
  }

  doc.end();
  return bufferPromise;
}

module.exports = { generateBookingPdf, generateWeekBookingsPdf };
