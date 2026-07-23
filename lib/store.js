// In-memory datastore voor lokale ontwikkeling.
//
// BELANGRIJK: dit bestand simuleert de tabellen uit schema-boekingssysteem.sql
// (services, service_party_pricing, rooms, sessions, bookings, customers,
// payments) met JS-arrays in het geheugen van het Node-proces. Dat is
// voldoende om de volledige boekingslogica te bouwen en te testen zonder een
// database op te zetten, maar het is GEEN productie-oplossing: bij een
// herstart van het proces is alle data weg, en er is geen concurrency-controle.
//
// Voor productie: vervang de functies hieronder door echte SQL-queries tegen
// PostgreSQL (bv. via `pg` of Prisma), met exact dezelfde functienamen en
// signatuur, zodat de API-routes en pagina's ongewijzigd kunnen blijven.

const { generateSessionInstances } = require("./scheduling");
const { bestFitRoom, ROOMS } = require("./rooms");
const { computePrice, MIN_PARTY_SIZE, MAX_ONLINE_PARTY_SIZE } = require("./pricing");
const { addDaysISO } = require("./dateUtils");
const mollie = require("./mollie");

const SERVICES = [
  {
    code: "fluid_art",
    label: "Fluid Art",
    usesRoomAssignment: false,
    minOnlinePartySize: 1,
    maxOnlinePartySize: 5,
    pricingType: "per_person",
    pricePerPerson: 45
  },
  {
    code: "art_attack_room",
    label: "Art Attack Room",
    usesRoomAssignment: true,
    minOnlinePartySize: MIN_PARTY_SIZE,
    maxOnlinePartySize: MAX_ONLINE_PARTY_SIZE,
    pricingType: "party_tier",
    pricingTable: require("./pricing").ART_ATTACK_ROOM_PRICING
  }
];

/** @type {Array<Object>} boekingen (kind: 'service') */
let bookings = [];
/** @type {Array<Object>} persoonlijke afspraken (kind: 'personal') — nooit prijs/klant */
let personalAppointments = [];
/** @type {Array<Object>} klanten */
let customers = [];
/** @type {Array<Object>} room-sluitingen (staff sluit een room of een volledige dag) */
let roomClosures = [];

let nextBookingId = 1;
let nextCustomerId = 1;
let nextPersonalId = 1;

function getServices() {
  return SERVICES;
}

function findService(code) {
  const s = SERVICES.find(s => s.code === code);
  if (!s) throw new Error(`Onbekende dienst: ${code}`);
  return s;
}

function activeBookingsFor(serviceCode, dateISO, start) {
  return bookings.filter(
    b => b.serviceCode === serviceCode && b.dateISO === dateISO && b.start === start && b.status !== "cancelled"
  );
}

function occupiedRoomIdsFor(dateISO, start) {
  const fromBookings = bookings
    .filter(b => b.serviceCode === "art_attack_room" && b.dateISO === dateISO && b.start === start && b.status !== "cancelled")
    .map(b => b.roomId);
  const fromClosures = roomClosures
    .filter(c => c.dateISO === dateISO && (c.start === start || c.allDay))
    .map(c => c.roomId)
    .filter(Boolean);
  const allRoomsClosed = roomClosures.some(c => c.dateISO === dateISO && c.allRooms && (c.start === start || c.allDay));
  if (allRoomsClosed) return ROOMS.map(r => r.id);
  return [...new Set([...fromBookings, ...fromClosures])];
}

/**
 * Beschikbare tijdsloten op een dag voor een dienst en groepsgrootte.
 * Geeft NOOIT roomdetails terug — enkel start, duur en of het boekbaar is.
 */
function getAvailability(serviceCode, dateISO, partySize) {
  const service = findService(serviceCode);
  const dayInstances = generateSessionInstances(dateISO, addDaysISO(dateISO, 1)).filter(
    s => s.service === serviceCode
  );

  return dayInstances.map(slot => {
    let bookable;
    if (service.usesRoomAssignment) {
      const occ = occupiedRoomIdsFor(dateISO, slot.start);
      bookable = partySize ? bestFitRoom(partySize, occ) !== null : ROOMS.some(r => !occ.includes(r.id));
    } else {
      const bookedCount = activeBookingsFor(serviceCode, dateISO, slot.start).reduce(
        (sum, b) => sum + b.partySize,
        0
      );
      const remaining = slot.capacity - bookedCount;
      bookable = partySize ? remaining >= partySize : remaining > 0;
    }
    return { start: slot.start, durationMin: slot.durationMin, bookable };
  });
}

function upsertCustomer({ name, email, phone, birthDate, marketingOptIn }) {
  let customer = customers.find(c => c.email.toLowerCase() === email.toLowerCase());
  if (customer) {
    Object.assign(customer, { name, phone, birthDate, marketingOptIn });
    return customer;
  }
  customer = {
    id: nextCustomerId++,
    name,
    email,
    phone,
    birthDate,
    marketingOptIn: marketingOptIn !== false, // default TRUE, expliciete klantkeuze uit het voorstel
    loyaltyPoints: 0,
    createdAt: new Date().toISOString()
  };
  customers.push(customer);
  return customer;
}

/**
 * Maakt een boeking aan: valideert beschikbaarheid, berekent de prijs,
 * wijst automatisch een room toe (enkel voor Art Attack Room), maakt een
 * (mock) Mollie-betaling aan.
 */
async function createBooking(payload) {
  const {
    serviceCode,
    dateISO,
    start,
    partySize,
    customer,
    note,
    termsAccepted,
    marketingOptIn,
    applyLoyaltyDiscount,
    invoiceRequested,
    invoiceDetails
  } = payload;

  if (!termsAccepted) {
    throw new Error("Akkoord met de algemene voorwaarden is verplicht.");
  }
  if (!customer || !customer.name || !customer.email || !customer.birthDate) {
    throw new Error("Naam, e-mail en geboortedatum zijn verplicht.");
  }

  const service = findService(serviceCode);
  const slots = generateSessionInstances(dateISO, addDaysISO(dateISO, 1)).filter(
    s => s.service === serviceCode && s.start === start
  );
  if (slots.length === 0) {
    throw new Error("Dit tijdslot bestaat niet (geen sessie gepland op dit moment).");
  }

  let roomId = null;
  if (service.usesRoomAssignment) {
    const occ = occupiedRoomIdsFor(dateISO, start);
    const room = bestFitRoom(partySize, occ);
    if (!room) throw new Error("Dit tijdslot is helaas volzet voor deze groepsgrootte.");
    roomId = room.id;
  } else {
    const bookedCount = activeBookingsFor(serviceCode, dateISO, start).reduce((s, b) => s + b.partySize, 0);
    if (bookedCount + partySize > slots[0].capacity) {
      throw new Error("Dit tijdslot is helaas volzet.");
    }
  }

  let amount = computePrice(serviceCode, partySize);
  let discountAmount = 0;
  if (applyLoyaltyDiscount) {
    discountAmount = Math.round(amount * 0.1 * 100) / 100;
    amount = Math.round((amount - discountAmount) * 100) / 100;
  }

  const savedCustomer = upsertCustomer({ ...customer, marketingOptIn });

  const booking = {
    id: nextBookingId++,
    kind: "service",
    serviceCode,
    dateISO,
    start,
    durationMin: slots[0].durationMin,
    partySize,
    roomId, // enkel intern gebruikt, nooit naar de klant getoond
    customerId: savedCustomer.id,
    customerName: savedCustomer.name,
    customerEmail: savedCustomer.email,
    note: note || "",
    subtotalAmount: computePrice(serviceCode, partySize),
    discountAmount,
    amountDue: amount,
    status: "pending_payment",
    visibility: "standard",
    invoiceRequested: !!invoiceRequested,
    invoiceDetails: invoiceRequested ? invoiceDetails : null,
    createdAt: new Date().toISOString()
  };
  bookings.push(booking);

  const payment = await mollie.createPayment({
    amount,
    description: `${service.label} — ${dateISO} ${start} (${partySize}p)`,
    redirectUrl: `${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/widget/bevestiging?booking=${booking.id}`,
    webhookUrl: `${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/mollie-webhook`,
    metadata: { bookingId: booking.id }
  });
  booking.paymentId = payment.id;
  booking.paymentCheckoutUrl = payment.checkoutUrl;

  // TODO productie: bevestigingsmail (incl. notitie) naar info.atelierdoen@gmail.com
  // pas versturen nadat de Mollie-webhook "paid" bevestigt, niet hier meteen.

  return { booking, payment };
}

function markBookingPaid(bookingId) {
  const booking = bookings.find(b => b.id === Number(bookingId));
  if (!booking) return null;
  booking.status = "confirmed";
  return booking;
}

function addPersonalAppointment({ title, dateISO, start, end }) {
  if (!title || !dateISO || !start || !end) {
    throw new Error("Titel, datum, start- en eindtijd zijn verplicht voor een persoonlijke afspraak.");
  }
  const appt = {
    id: nextPersonalId++,
    kind: "personal",
    title,
    dateISO,
    start,
    end,
    status: "scheduled",
    visibility: "private" // altijd privé, nooit een prijs of klant
  };
  personalAppointments.push(appt);
  return appt;
}

function closeRoom({ dateISO, start, roomId, allRooms, allDay, reason }) {
  roomClosures.push({ dateISO, start: start || null, roomId: roomId || null, allRooms: !!allRooms, allDay: !!allDay, reason: reason || "" });
}

/**
 * Alle sessies/afspraken van een week (maandag t.e.m. zondag), voor de
 * back-end weekagenda. Geeft voor elk rooster-tijdslot ofwel de echte
 * boeking (indien aanwezig), ofwel een lege/beschikbare sessie terug, plus
 * de persoonlijke afspraken los daarvan.
 */
function getWeekSessions(mondayISO) {
  const sundayExclusiveISO = addDaysISO(mondayISO, 7);
  const slots = generateSessionInstances(mondayISO, sundayExclusiveISO);

  const serviceEvents = slots.map(slot => {
    const slotBookings = activeBookingsFor(slot.service, slot.dateISO, slot.start);
    if (slotBookings.length === 0) {
      return {
        kind: "service",
        service: slot.service,
        dateISO: slot.dateISO,
        start: slot.start,
        durationMin: slot.durationMin,
        status: "scheduled",
        visibility: "standard",
        booked: 0,
        capacity: slot.capacity
      };
    }
    // Voor Art Attack Room kan max. 1 boeking per room per tijdslot; we tonen
    // ze als aparte events zodat elke room/groep zichtbaar is.
    return slotBookings.map(b => ({
      kind: "service",
      service: slot.service,
      dateISO: slot.dateISO,
      start: slot.start,
      durationMin: slot.durationMin,
      status: b.status,
      visibility: b.visibility,
      customer: b.customerName,
      partySize: b.partySize,
      amount: b.amountDue,
      note: b.note,
      bookingId: b.id
    }));
  }).flat();

  const personalEvents = personalAppointments.filter(
    p => p.dateISO >= mondayISO && p.dateISO < sundayExclusiveISO
  );

  return [...serviceEvents, ...personalEvents].sort((a, b) => (a.dateISO + a.start).localeCompare(b.dateISO + b.start));
}

function getAllBookings() {
  return bookings;
}

module.exports = {
  getServices,
  getAvailability,
  createBooking,
  markBookingPaid,
  addPersonalAppointment,
  closeRoom,
  getWeekSessions,
  getAllBookings
};
