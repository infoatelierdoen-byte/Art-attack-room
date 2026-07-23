// Genereert concrete sessie-instanties uit de vaste terugkerende regels —
// komt overeen met de tabel `recurrence_rules` + `sessions` in
// schema-boekingssysteem.sql. Dit vervangt de "hardcoded" SCHEDULE-tabel uit
// het HTML-prototype door herbruikbare, geteste logica.

const SESSION_DURATION_MIN = 90;
const BUFFER_MIN = 60; // tijd tussen sessies — hier al verwerkt in de vaste uren

// JS Date#getDay(): 0=zo, 1=ma, 2=di, 3=wo, 4=do, 5=vr, 6=za
const ART_ATTACK_ROOM_RULES = [
  { weekday: 3, times: ["14:00", "16:30", "19:00"], endDate: null }, // woensdag
  { weekday: 4, times: ["14:00", "16:30", "19:00"], endDate: "2026-08-31" }, // donderdag, tot en met 31/08
  { weekday: 5, times: ["13:30", "16:00"], endDate: null }, // vrijdag
  { weekday: 6, times: ["11:00", "13:30", "16:00"], endDate: null }, // zaterdag
  { weekday: 0, times: ["11:00", "13:30", "16:00"], endDate: null } // zondag
];

// Fluid Art: elke twee weken op dinsdag om 19:00. 2026-07-28 is een bevestigde
// datum (ankerdatum) — elke datum die daar een veelvoud van 14 dagen van
// verwijderd is, hoort bij hetzelfde ritme.
const FLUID_ART_ANCHOR = "2026-07-28";
const FLUID_ART_TIME = "19:00";
const FLUID_ART_CAPACITY = 10;
const ART_ATTACK_ROOM_MAX_ONLINE = 7;

// Let op: toISODate/addDays komen uit dateUtils.js en gebruiken bewust lokale
// datumcomponenten (niet toISOString/UTC) — anders verschuiven datums met een
// dag zodra de server niet in UTC draait.
const { toISODate, addDays } = require("./dateUtils");

function isFluidArtDate(dateISO) {
  const anchor = new Date(FLUID_ART_ANCHOR + "T00:00:00");
  const d = new Date(dateISO + "T00:00:00");
  const diffDays = Math.round((d - anchor) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return diffDays % 14 === 0; // ook eerdere data op hetzelfde ritme (indien ooit nodig)
  return diffDays % 14 === 0;
}

/**
 * Genereert alle sessie-instanties (Fluid Art + Art Attack Room) tussen
 * fromDate (inclusief) en toDate (exclusief), als vlakke lijst.
 * @param {string} fromISO  bv. "2026-07-22"
 * @param {string} toISO    bv. "2026-10-22"
 */
function generateSessionInstances(fromISO, toISO) {
  const from = new Date(fromISO + "T00:00:00");
  const to = new Date(toISO + "T00:00:00");
  const instances = [];

  for (let d = new Date(from); d < to; d = addDays(d, 1)) {
    const dateISO = toISODate(d);
    const weekday = d.getDay();

    if (isFluidArtDate(dateISO)) {
      instances.push({
        service: "fluid_art",
        dateISO,
        start: FLUID_ART_TIME,
        durationMin: SESSION_DURATION_MIN,
        capacity: FLUID_ART_CAPACITY,
        usesRoomAssignment: false
      });
    }

    for (const rule of ART_ATTACK_ROOM_RULES) {
      if (rule.weekday !== weekday) continue;
      if (rule.endDate && dateISO > rule.endDate) continue;
      for (const time of rule.times) {
        instances.push({
          service: "art_attack_room",
          dateISO,
          start: time,
          durationMin: SESSION_DURATION_MIN,
          capacity: ART_ATTACK_ROOM_MAX_ONLINE, // online boekbaar max — fysiek kan room A tot 10
          usesRoomAssignment: true
        });
      }
    }
  }

  return instances.sort((a, b) => (a.dateISO + a.start).localeCompare(b.dateISO + b.start));
}

module.exports = {
  SESSION_DURATION_MIN,
  BUFFER_MIN,
  ART_ATTACK_ROOM_RULES,
  FLUID_ART_ANCHOR,
  FLUID_ART_TIME,
  FLUID_ART_CAPACITY,
  ART_ATTACK_ROOM_MAX_ONLINE,
  generateSessionInstances,
  isFluidArtDate
};
