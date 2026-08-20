// Rooms en de "best-fit" auto-toewijzing — komt overeen met de tabel `rooms`
// en de toewijzingslogica beschreven in het voorstel (hoofdstuk 5).
// Belangrijk: deze roomdetails worden NOOIT naar de klant teruggestuurd door
// de API — enkel gebruikt om te bepalen of een tijdslot nog boekbaar is.

const ROOMS = [
  { id: "A", label: "Room A", capacity: 10 },
  { id: "M", label: "Room M", capacity: 5 },
  { id: "VL", label: "Room VL", capacity: 7 },
  { id: "VR", label: "Room VR", capacity: 7 }
];

/**
 * Kiest de kleinste vrije room die groot genoeg is voor de groep.
 * @param {number} partySize
 * @param {string[]} occupiedRoomIds - rooms die op dit tijdslot al bezet of gesloten zijn
 * @param {{id:string,label:string,capacity:number}[]} [roomsList] - standaard de
 *   hardcoded ROOMS (in-memory store); de SQL-store geeft hier de rooms uit
 *   de database door, zodat rooms.js niet moet weten welke store actief is.
 * @returns {{id:string,label:string,capacity:number}|null}
 */
function bestFitRoom(partySize, occupiedRoomIds = [], roomsList = ROOMS) {
  const free = roomsList.filter(r => !occupiedRoomIds.includes(r.id) && r.capacity >= partySize);
  if (free.length === 0) return null;
  free.sort((a, b) => a.capacity - b.capacity);
  return free[0];
}

function isSlotBookable(partySize, occupiedRoomIds = [], roomsList = ROOMS) {
  return bestFitRoom(partySize, occupiedRoomIds, roomsList) !== null;
}

// Welke room krijgt de overloop van een groep die niet in één room past?
// Robin (aug 2026): "bij een boeking van meer dan 10 personen moet room VR
// automatisch ingenomen worden." VL heeft dezelfde capaciteit als VR en dient
// als terugval wanneer VR net bezet is — anders zou een boeking geweigerd
// worden terwijl er een identieke room vrij staat.
const OVERLOOP_VOORKEUR = ["VR", "VL", "M"];

/**
 * Kiest ALLE rooms die een groep nodig heeft.
 *
 * Tot en met de grootste room (A, 10 plaatsen) is dat gewoon de best passende
 * room, precies zoals online. Daarboven — enkel mogelijk via een manuele
 * boeking — komt room A erbij plus de eerste vrije overlooproom (VR, anders
 * VL, anders M).
 *
 * Past de groep zelfs daarmee niet (meer dan 17 personen), dan geeft dit
 * tóch die twee rooms terug. Bewuste keuze: het team beslist zelf welke
 * rooms het daarvoor nog sluit (Robin, aug 2026), dus het systeem waarschuwt
 * daar niet over en houdt niets tegen.
 *
 * @returns {{rooms: Array, capaciteit: number}|null}
 *   null = er is geen enkele room vrij die deze groep aankan.
 */
function roomsForPartySize(partySize, occupiedRoomIds = [], roomsList = ROOMS) {
  const enkel = bestFitRoom(partySize, occupiedRoomIds, roomsList);
  if (enkel) return { rooms: [enkel], capaciteit: enkel.capacity };

  // Geen enkele room is groot genoeg: combineren. Start bij de grootste vrije
  // room, want die doet het meeste werk.
  const vrij = roomsList.filter(r => !occupiedRoomIds.includes(r.id));
  if (vrij.length < 2) return null;
  const grootste = [...vrij].sort((a, b) => b.capacity - a.capacity)[0];

  const overloop = OVERLOOP_VOORKEUR
    .map(code => vrij.find(r => r.id === code && r.id !== grootste.id))
    .filter(Boolean)[0];
  if (!overloop) return null;

  const gekozen = [grootste, overloop];
  const capaciteit = gekozen.reduce((som, r) => som + r.capacity, 0);
  return { rooms: gekozen, capaciteit };
}

module.exports = { ROOMS, bestFitRoom, isSlotBookable, roomsForPartySize };
