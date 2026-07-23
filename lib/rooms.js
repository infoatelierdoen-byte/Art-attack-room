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

module.exports = { ROOMS, bestFitRoom, isSlotBookable };
