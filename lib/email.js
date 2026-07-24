// Bevestigingsmail na een geslaagde betaling — één mail naar de klant, één
// naar het team (NOTIFY_EMAIL, incl. de notitie van de klant indien
// ingevuld). Bewust twee aparte mails i.p.v. één met CC, zodat de klant het
// interne teamadres nooit in de kopregels te zien krijgt.
//
// Verstuurd via Gmail's eigen SMTP-server met een "app-wachtwoord" (Google
// Account > Beveiliging > App-wachtwoorden, vereist 2-stapsverificatie) —
// geen aparte transactionele e-maildienst nodig. Voldoende voor dit volume
// (Gmail staat tot ~500 e-mails per dag toe via deze weg).
//
// Zonder GMAIL_USER/GMAIL_APP_PASSWORD (lokale ontwikkeling) wordt enkel
// naar de console gelogd — zelfde mock-patroon als lib/mollie.js en
// lib/billit.js, zodat de volledige boekingsflow lokaal te testen is zonder
// dat er iets echt verstuurd wordt.

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "info.atelierdoen@gmail.com";

function isConfigured() {
  return !!(GMAIL_USER && GMAIL_APP_PASSWORD);
}

let transporterPromise = null;
function getTransporter() {
  if (!transporterPromise) {
    const nodemailer = require("nodemailer");
    transporterPromise = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
    });
  }
  return transporterPromise;
}

async function sendMail({ to, subject, text }) {
  if (!isConfigured()) {
    console.log(`[email mock] naar ${to} — "${subject}"\n${text}\n`);
    return { mocked: true };
  }
  const transporter = getTransporter();
  const info = await transporter.sendMail({
    from: `Art Attack Room <${GMAIL_USER}>`,
    to,
    subject,
    text
  });
  return { messageId: info.messageId };
}

function formatDateLabel(dateISO) {
  return new Date(dateISO + "T00:00:00").toLocaleDateString("nl-BE", {
    day: "2-digit",
    month: "long",
    year: "numeric"
  });
}

/**
 * Stuurt de bevestigingsmail voor een betaalde boeking. Faalt deze aanroep
 * (bv. verkeerd app-wachtwoord, of nog niet geconfigureerd), dan mag dat
 * — net als bij Billit — nooit de betaling zelf blokkeren; de aanroeper
 * (store-sql.js) vangt fouten hier bewust op en logt ze enkel.
 */
async function sendBookingConfirmation({
  customerName, customerEmail, serviceName, dateISO, start, partySize, amount, note
}) {
  const dateLabel = formatDateLabel(dateISO);
  const personsLabel = partySize === 1 ? "1 persoon" : `${partySize} personen`;

  const customerText =
    `Hallo ${customerName},\n\n` +
    `Je boeking is bevestigd:\n` +
    `${serviceName} — ${dateLabel} om ${start} (${personsLabel})\n` +
    `Bedrag: €${amount.toFixed(2)}\n\n` +
    `Tot dan!\nArt Attack Room`;

  const internalText =
    `Nieuwe betaalde boeking:\n\n` +
    `Klant: ${customerName} (${customerEmail})\n` +
    `Dienst: ${serviceName}\n` +
    `Datum/tijd: ${dateLabel} om ${start}\n` +
    `Aantal personen: ${partySize}\n` +
    `Bedrag: €${amount.toFixed(2)}\n` +
    (note ? `Notitie van de klant: ${note}\n` : `Geen notitie.\n`);

  await sendMail({
    to: customerEmail,
    subject: `Bevestiging van je boeking — ${serviceName}`,
    text: customerText
  });
  await sendMail({
    to: NOTIFY_EMAIL,
    subject: `Nieuwe boeking: ${customerName} — ${serviceName}`,
    text: internalText
  });
}

/**
 * Mailt de gegenereerde code naar de koper van een online cadeaubon, zodra
 * de betaling bevestigd is (zie fulfillGiftCardPurchase() in store-sql.js).
 * Ook hier: een mislukte verzending mag de aankoop zelf niet blokkeren, de
 * aanroeper vangt fouten op en logt ze enkel — de code blijft wel gewoon
 * bestaan en terugvindbaar in de backoffice (zoekfunctie).
 */
async function sendGiftCardCode({ purchaserName, purchaserEmail, code, amount, expiresAtISO }) {
  const expiresLabel = formatDateLabel(expiresAtISO);
  const text =
    `Hallo ${purchaserName},\n\n` +
    `Bedankt voor je aankoop! Hier is je cadeaubon voor Art Attack Room:\n\n` +
    `Code: ${code}\n` +
    `Waarde: €${amount.toFixed(2)}\n` +
    `Geldig tot: ${expiresLabel}\n\n` +
    `Deze code is te gebruiken voor al onze workshops — geef hem gewoon door ` +
    `bij het boeken (online of telefonisch).\n\n` +
    `Tot binnenkort!\nArt Attack Room`;

  await sendMail({
    to: purchaserEmail,
    subject: "Je cadeaubon voor Art Attack Room",
    text
  });
  await sendMail({
    to: NOTIFY_EMAIL,
    subject: `Nieuwe cadeaubon verkocht: ${code} (€${amount.toFixed(2)})`,
    text: `Cadeaubon ${code} verkocht aan ${purchaserName} (${purchaserEmail}) voor €${amount.toFixed(2)}.`
  });
}

module.exports = { sendBookingConfirmation, sendGiftCardCode, isConfigured };
