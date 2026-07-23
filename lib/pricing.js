// Prijslogica — komt overeen met de tabel `service_party_pricing` in
// schema-boekingssysteem.sql. Art Attack Room heeft een totaalprijs per
// groepsgrootte (geen lineaire prijs per persoon); Fluid Art heeft wel een
// vaste prijs per persoon.

const ART_ATTACK_ROOM_PRICING = {
  2: 120,
  3: 174,
  4: 220,
  5: 265,
  6: 312,
  7: 364
};

const FLUID_ART_PRICE_PER_PERSON = 45;

const MIN_PARTY_SIZE = 2;
const MAX_ONLINE_PARTY_SIZE = 7;

function computePrice(serviceCode, partySize) {
  if (!Number.isInteger(partySize) || partySize < 1) {
    throw new Error("Ongeldige groepsgrootte");
  }

  if (serviceCode === "art_attack_room") {
    if (partySize < MIN_PARTY_SIZE) {
      throw new Error("Minimum groepsgrootte voor Art Attack Room is 2 (\"als duo\").");
    }
    if (partySize > MAX_ONLINE_PARTY_SIZE) {
      throw new Error(
        "Groepen groter dan 7 personen kunnen niet online geboekt worden. " +
        "Verwijs door naar het contactformulier of artattackroom@gmail.com."
      );
    }
    return ART_ATTACK_ROOM_PRICING[partySize];
  }

  if (serviceCode === "fluid_art") {
    return FLUID_ART_PRICE_PER_PERSON * partySize;
  }

  throw new Error(`Onbekende dienst: ${serviceCode}`);
}

module.exports = {
  ART_ATTACK_ROOM_PRICING,
  FLUID_ART_PRICE_PER_PERSON,
  MIN_PARTY_SIZE,
  MAX_ONLINE_PARTY_SIZE,
  computePrice
};
