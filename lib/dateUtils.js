// Let op: bewust GEEN toISOString() gebruiken — dat rekent om naar UTC en
// verschuift de datum met een dag zodra de server niet in UTC draait (bv.
// Europe/Brussels). We lezen dus altijd de lokale datumcomponenten uit.
function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseISODate(iso) {
  return new Date(iso + "T00:00:00");
}

function addDays(d, n) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

function addDaysISO(iso, n) {
  return toISODate(addDays(parseISODate(iso), n));
}

// Maandag van de week waarin dateISO valt (ma=start van de week, zoals in de
// back-end weekagenda).
function mondayOfISO(dateISO) {
  const d = parseISODate(dateISO);
  const day = d.getDay(); // 0=zo..6=za
  const diff = day === 0 ? -6 : 1 - day;
  return toISODate(addDays(d, diff));
}

module.exports = { toISODate, parseISODate, addDays, addDaysISO, mondayOfISO };
