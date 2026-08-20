import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

const HOUR_START = 9;
const HOUR_END = 22;
const HOUR_PX = 44;
const DAY_LABELS = ["Ma", "Di", "Wo", "Do", "Vr", "Za", "Zo"];
const MONTHS_NL = [
  "januari", "februari", "maart", "april", "mei", "juni",
  "juli", "augustus", "september", "oktober", "november", "december"
];

// Bewust GEEN toISOString() — dat rekent om naar UTC en verschuift de datum
// met een dag t.o.v. de lokale (Europe/Brussels) kalenderdatum.
function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseISO(iso) { return new Date(iso + "T00:00:00"); }
function addDays(d, n) { const c = new Date(d); c.setDate(c.getDate() + n); return c; }

function mondayOf(dateISO) {
  const d = parseISO(dateISO);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return toISO(addDays(d, diff));
}

// Volledige 6-weken kalendergrid (42 dagen, maandag-gebaseerd) voor de
// mini-maandkalender in de zijbalk — incl. de grijze dagen van de vorige/
// volgende maand die de rand opvullen, zoals in Google Agenda.
function buildFullMonthGrid(year, month) {
  const first = new Date(year, month, 1);
  const firstWeekday = (first.getDay() + 6) % 7; // 0 = maandag
  const start = new Date(year, month, 1 - firstWeekday);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push({ date: d, inMonth: d.getMonth() === month });
  }
  return cells;
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Wijst elk event van een dag een kolom toe zodat events die elkaar in tijd
// overlappen (bv. 3 boekingen van Action Painting, elk in een andere room,
// exact op hetzelfde tijdstip) netjes naast elkaar komen te staan i.p.v.
// volledig over elkaar heen (wat voorheen gebeurde — enkel het laatste event
// in de lijst was dan nog zichtbaar/klikbaar). Standaard greedy
// interval-graph-coloring, zoals de meeste kalender-UI's dat doen.
function layoutDayEvents(dayEvents) {
  const items = dayEvents.map(ev => {
    const startMin = timeToMinutes(ev.start);
    // Een persoonlijke afspraak en een tijdsblok hebben een echt einduur;
    // een workshopsessie heeft een vaste duur.
    const endMin = ev.kind === "personal" || ev.kind === "block"
      ? timeToMinutes(ev.end)
      : startMin + (ev.durationMin || 90);
    return { ev, startMin, endMin, col: 0, cols: 1 };
  }).sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  let active = [];
  let clusterItems = [];

  function closeCluster() {
    if (clusterItems.length === 0) return;
    const maxCols = clusterItems.reduce((m, it) => Math.max(m, it.col + 1), 1);
    clusterItems.forEach(it => { it.cols = maxCols; });
    clusterItems = [];
  }

  for (const item of items) {
    active = active.filter(a => a.endMin > item.startMin);
    if (active.length === 0) closeCluster();

    const usedCols = new Set(active.map(a => a.col));
    let col = 0;
    while (usedCols.has(col)) col++;
    item.col = col;

    active.push(item);
    clusterItems.push(item);
  }
  closeCluster();

  return items;
}

// Bouwt de vaste room-kolommen (A/M/VL/VR) voor Action Painting-tijdsloten op
// een dag, zoals in het referentiescherm dat Robin doorstuurde: elke room
// heeft altijd zijn eigen kolom, ongeacht hoeveel er op dat moment effectief
// geboekt zijn. Diensten zonder roomtoewijzing (Fluid Art) en persoonlijke
// afspraken gebruiken deze grid niet — die blijven op de bestaande dynamische
// overlap-layout (layoutDayEvents) draaien.
function buildRoomGrid(dayEvents, roomOrder) {
  if (!roomOrder.length) return [];
  const roomEvents = dayEvents.filter(e => e.kind === "service" && e.usesRoomAssignment);
  const closedEvents = dayEvents.filter(e => e.kind === "room_closed");
  if (roomEvents.length === 0 && closedEvents.length === 0) return [];

  const slotMap = new Map();
  roomEvents.forEach(e => {
    if (!slotMap.has(e.start)) slotMap.set(e.start, { start: e.start, durationMin: e.durationMin || 90 });
  });
  closedEvents.forEach(e => {
    if (!slotMap.has(e.start)) {
      slotMap.set(e.start, { start: e.start, durationMin: timeToMinutes(e.end) - timeToMinutes(e.start) });
    }
  });

  // Overlappende tijdsloten naast elkaar zetten in plaats van over elkaar.
  //
  // In het vaste uurrooster overlapt er niets (14:00, 16:30, 19:00 met 90
  // minuten elk). Maar sinds het team bij een manuele boeking zelf een uur mag
  // kiezen (Robin, aug 2026) kan er wél een sessie van 10:15 naast die van
  // 11:00 komen te staan. Zonder deze verdeling tekenden die twee rijen rooms
  // exact over elkaar en was geen van beide nog leesbaar.
  //
  // Dezelfde greedy aanpak als layoutDayEvents() hierboven: overlappende
  // sloten vormen een cluster en delen de breedte van de dagkolom.
  const slots = [...slotMap.values()]
    .map(slot => {
      const startMin = timeToMinutes(slot.start);
      return { ...slot, startMin, endMin: startMin + (slot.durationMin || 90), kolom: 0, kolommen: 1 };
    })
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  let actief = [];
  let cluster = [];
  const sluitCluster = () => {
    if (cluster.length === 0) return;
    const max = cluster.reduce((m, it) => Math.max(m, it.kolom + 1), 1);
    cluster.forEach(it => { it.kolommen = max; });
    cluster = [];
  };
  for (const slot of slots) {
    actief = actief.filter(a => a.endMin > slot.startMin);
    if (actief.length === 0) sluitCluster();
    const bezet = new Set(actief.map(a => a.kolom));
    let k = 0;
    while (bezet.has(k)) k++;
    slot.kolom = k;
    actief.push(slot);
    cluster.push(slot);
  }
  sluitCluster();

  const cells = [];
  for (const slot of slots) {
    const startMin = slot.startMin;
    const top = ((startMin / 60) - HOUR_START) * HOUR_PX;
    const height = (slot.durationMin / 60) * HOUR_PX;
    // De strook van de dagkolom die dit tijdslot mag gebruiken. Zonder overlap
    // is dat gewoon de volle breedte (kolommen = 1).
    const bandLinks = slot.kolom / slot.kolommen;
    const bandBreedte = 1 / slot.kolommen;

    // Breedte naar belang verdelen in plaats van vier gelijke kolommen. Een
    // dagkolom is maar ~170px breed; vier gelijke cellen geven een veertigtal
    // pixels elk, te weinig voor een naam. Een geboekte cel weegt daarom dubbel
    // zo zwaar als een vrije. De VOLGORDE van de rooms blijft ongewijzigd, dus
    // M staat nog altijd links en A rechts.
    const alleRooms = roomOrder.map(room => {
      const booking = roomEvents.find(e => e.start === slot.start && e.roomCode === room.id);
      const closed = closedEvents.find(e => e.start === slot.start && e.roomCode === room.id);
      return { room, booking, closed, gewicht: booking ? 2 : 1 };
    });
    // Deelt dit tijdslot zijn strook met een ander (een zelfgekozen uur dat
    // over het vaste rooster heen valt), dan is er geen plaats voor vier
    // cellen naast elkaar. Van een slot met boekingen tonen we dan enkel wat
    // er écht staat — een vrije room op 10:15 zegt toch niets, dat uur bestaat
    // enkel omdát er iemand geboekt is. Een slot zónder boekingen houdt wél
    // zijn vier rooms: dat is meestal het gewone uurrooster, en dat mag niet
    // uit de agenda verdwijnen omdat er toevallig iets overheen valt.
    const bezetteCellen = alleRooms.filter(c => c.booking || c.closed);
    const inhoud = slot.kolommen > 1 && bezetteCellen.length > 0 ? bezetteCellen : alleRooms;
    const totaal = inhoud.reduce((som, c) => som + c.gewicht, 0) || 1;

    // Het tijdslot zelf als klein label boven de rij rooms. Dat geeft je meteen
    // het uur per dag (dat stond enkel in de balk links), én een plek om op te
    // rechtsklikken voor acties die over het hele tijdslot gaan.
    // Voor het rechtermuismenu telt wél de volledige lijst rooms — anders zou
    // "dit tijdslot sluiten" op een gedeeld uur denken dat er niets vrij is.
    const vrijInSlot = alleRooms.filter(c => !c.booking && !c.closed).length;
    const geslotenInSlot = alleRooms.filter(c => c.closed).length;
    cells.push({
      key: `${slot.start}-tag`, kind: "slotTag", top: top - 15,
      left: `calc(${bandLinks * 100}% + 2px)`, height: 14,
      slotStart: slot.start, vrijInSlot, geslotenInSlot
    });

    let gepasseerd = 0;
    inhoud.forEach(({ room, booking, closed, gewicht }) => {
      const left = `calc(${(bandLinks + (gepasseerd / totaal) * bandBreedte) * 100}% + 2px)`;
      const width = `calc(${(gewicht / totaal) * bandBreedte * 100}% - 4px)`;
      gepasseerd += gewicht;
      const gemeen = { slotStart: slot.start, vrijInSlot, geslotenInSlot };
      if (booking) {
        cells.push({ key: `${slot.start}-${room.id}`, kind: "booking", top, height, left, width, ev: booking, roomLabel: room.label, ...gemeen });
      } else if (closed) {
        cells.push({ key: `${slot.start}-${room.id}`, kind: "closed", top, height, left, width, ev: closed, roomLabel: room.label, ...gemeen });
      } else {
        cells.push({ key: `${slot.start}-${room.id}`, kind: "free", top, height, left, width, roomLabel: room.label, ...gemeen });
      }
    });
  }
  return cells;
}

function serviceLabel(code) {
  if (code === "fluid_art") return "Fluid Art";
  if (code === "action_painting") return "Action Painting";
  return code;
}

// Een leeg tijdsblok-formulier. `id` gevuld = een bestaand blok aanpassen.
const EMPTY_BLOCK_FORM = { id: null, title: "", dateISO: "", start: "", end: "" };

const EMPTY_MANUAL_FORM = {
  serviceCode: "", dateISO: "", start: "", partySize: 2,
  name: "", email: "", phone: "", birthDate: "", note: "",
  invoiceRequested: false, vatNumber: "", companyName: "",
  giftCardCode: "", reserveOnly: false, amountOverride: ""
};

const EMPTY_CLOSE_FORM = {
  dateISO: "", allDay: false, start: "", allRooms: false, roomId: "", reason: ""
};

const EMPTY_EXTRA_FORM = { serviceCode: "", dateISO: "", start: "", capacity: "" };

const EMPTY_GIFT_CARD_FORM = { amount: "", purchaserName: "", purchaserEmail: "", note: "" };

const EMPTY_STAFF_FORM = { id: null, dateISO: "", staffName: "", start: "", end: "", note: "" };

export default function Backend() {
  // authRole: null = nog aan het checken, "none" = niet ingelogd,
  // "admin"/"guest" = ingelogd. Komt nu van de server (sessie-cookie na
  // inloggen), niet meer van een klikbare knop — voorheen kon eender wie
  // zichzelf met die knop tot "Admin" maken zonder wachtwoord.
  const [authRole, setAuthRole] = useState(null);
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginSubmitting, setLoginSubmitting] = useState(false);

  // Donkere modus — onafhankelijk van inloggen, voorkeur onthouden in
  // localStorage zodat die overeind blijft na een herlaad. Standaard uit
  // (huidige lichte thema), enkel client-side te lezen (geen window tijdens
  // SSR/build), vandaar in een useEffect i.p.v. rechtstreeks in useState().
  const [darkMode, setDarkMode] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem("backendDarkMode") === "1") setDarkMode(true);
    } catch { /* privénavigatie o.i.d. — dan gewoon standaard licht */ }
  }, []);
  function toggleDarkMode() {
    setDarkMode(v => {
      const next = !v;
      try { localStorage.setItem("backendDarkMode", next ? "1" : "0"); } catch { /* zie hierboven */ }
      return next;
    });
  }

  const [monday, setMonday] = useState(() => mondayOf(toISO(new Date())));
  const [events, setEvents] = useState([]);
  const [pickerYear, setPickerYear] = useState(() => new Date().getFullYear());
  const [pickerMonth, setPickerMonth] = useState(() => new Date().getMonth());
  const [loading, setLoading] = useState(true);

  // De uurbalk links en de dagkolommen zijn twee aparte kolommen die allebei
  // bovenaan beginnen. De dagkolommen hebben er echter nog een kop én een rij
  // met werkuren boven staan, de uurbalk niet. Die stond op een vaste
  // padding-top van 34px — genoeg voor de kop alleen, waardoor élke sessie
  // ongeveer een half uur te laag leek te staan tegenover de uren ernaast.
  // Vast getal werkt hier niet: de rij met werkuren wordt hoger zodra de chips
  // over twee regels lopen. Daarom meten we de echte afstand na het renderen.
  const weekBodyRef = useRef(null);
  const [tijdbalkOffset, setTijdbalkOffset] = useState(34);
  const [staffRijHoogte, setStaffRijHoogte] = useState(null);
  const [showAddPersonal, setShowAddPersonal] = useState(false);
  const [personalForm, setPersonalForm] = useState({ title: "", dateISO: "", start: "", end: "" });

  const [showTimeBlock, setShowTimeBlock] = useState(false);
  const [blockForm, setBlockForm] = useState(EMPTY_BLOCK_FORM);
  const [blockError, setBlockError] = useState("");
  const [blockSubmitting, setBlockSubmitting] = useState(false);

  const [services, setServices] = useState([]);
  const [rooms, setRooms] = useState([]);

  const [showAddBooking, setShowAddBooking] = useState(false);
  const [manualForm, setManualForm] = useState(EMPTY_MANUAL_FORM);
  const [manualSlots, setManualSlots] = useState([]);
  const [manualLoadingSlots, setManualLoadingSlots] = useState(false);
  const [manualError, setManualError] = useState("");
  const [manualSubmitting, setManualSubmitting] = useState(false);

  const [showCloseRoom, setShowCloseRoom] = useState(false);
  const [closeForm, setCloseForm] = useState(EMPTY_CLOSE_FORM);
  const [closeSlots, setCloseSlots] = useState([]);
  const [closeLoadingSlots, setCloseLoadingSlots] = useState(false);
  const [closeError, setCloseError] = useState("");
  const [closeSubmitting, setCloseSubmitting] = useState(false);

  const [showAddExtra, setShowAddExtra] = useState(false);
  const [extraForm, setExtraForm] = useState(EMPTY_EXTRA_FORM);
  const [extraError, setExtraError] = useState("");
  const [extraSubmitting, setExtraSubmitting] = useState(false);

  const [showGiftCards, setShowGiftCards] = useState(false);
  const [giftCardQuery, setGiftCardQuery] = useState("");
  const [giftCardResults, setGiftCardResults] = useState([]);
  const [giftCardLoading, setGiftCardLoading] = useState(false);
  const [giftCardListError, setGiftCardListError] = useState("");
  const [showAddGiftCard, setShowAddGiftCard] = useState(false);
  const [giftCardForm, setGiftCardForm] = useState(EMPTY_GIFT_CARD_FORM);
  const [giftCardError, setGiftCardError] = useState("");
  const [giftCardSubmitting, setGiftCardSubmitting] = useState(false);

  const [confirmTarget, setConfirmTarget] = useState(null); // ev met bookingId, of null
  const [confirmError, setConfirmError] = useState("");
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);

  const [detailTarget, setDetailTarget] = useState(null); // ev met bookingId, voor annuleren
  const [detailError, setDetailError] = useState("");
  const [detailSubmitting, setDetailSubmitting] = useState(false);
  const [cancelRefundAmount, setCancelRefundAmount] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  // Aantal personen aanpassen vanuit het boekingsdetail — herbekijkt meteen de
  // room-toewijzing (rooms hebben verschillende capaciteiten).
  const [partySizeInput, setPartySizeInput] = useState("");
  const [recalcPrice, setRecalcPrice] = useState(false);
  const [partySizeNotice, setPartySizeNotice] = useState("");
  // Notitie bij een boeking, bewerkbaar vanuit het detailvenster.
  const [noteInput, setNoteInput] = useState("");
  const [noteNotice, setNoteNotice] = useState("");

  const [showActionsMenu, setShowActionsMenu] = useState(false);

  const [rescheduleTarget, setRescheduleTarget] = useState(null);
  // Rechtermuismenu in de weekagenda: één menu, andere inhoud naargelang je op
  // een boeking, een vrije room, een gesloten room of het tijdslot zelf klikt.
  const [ctxMenu, setCtxMenu] = useState(null);
  // Beschikbare tijdsloten bij het verplaatsen. Vroeger typte je datum en uur
  // blind in en kreeg je pas na het opslaan te horen dat er geen sessie stond.
  const [rescheduleSlots, setRescheduleSlots] = useState([]);
  const [rescheduleLoadingSlots, setRescheduleLoadingSlots] = useState(false);
  const [rescheduleDateISO, setRescheduleDateISO] = useState("");
  const [rescheduleStart, setRescheduleStart] = useState("");
  const [rescheduleError, setRescheduleError] = useState("");
  const [rescheduleSubmitting, setRescheduleSubmitting] = useState(false);

  const [showImport, setShowImport] = useState(false);
  const [importFileName, setImportFileName] = useState("");
  const [importText, setImportText] = useState("");
  const [importSubmitting, setImportSubmitting] = useState(false);
  const [importError, setImportError] = useState("");
  const [importResult, setImportResult] = useState(null);

  const [staffShifts, setStaffShifts] = useState([]);
  const [staffForm, setStaffForm] = useState(EMPTY_STAFF_FORM);
  const [showStaffShift, setShowStaffShift] = useState(false);
  const [staffError, setStaffError] = useState("");
  const [staffSubmitting, setStaffSubmitting] = useState(false);

  function load(week) {
    setLoading(true);
    Promise.all([
      fetch(`/api/admin/sessions?week=${week}`).then(r => r.json()),
      fetch(`/api/admin/staff-shifts?week=${week}`).then(r => r.json())
    ])
      .then(([sessionsData, shiftsData]) => {
        setMonday(sessionsData.monday);
        setEvents(sessionsData.events);
        setStaffShifts(shiftsData.shifts || []);
      })
      .finally(() => setLoading(false));
  }

  // Bij het laden van de pagina: checken of er al een geldige sessie is
  // (bv. na een herlaad) — geen wachtwoord opnieuw nodig zolang de
  // sessie-cookie (30 dagen) nog geldig is.
  useEffect(() => {
    fetch("/api/auth/me")
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(d => setAuthRole(d.role))
      .catch(() => setAuthRole("none"));
  }, []);

  useEffect(() => {
    if (authRole !== "admin" && authRole !== "guest") return;
    load(monday);
    fetch("/api/services").then(r => r.json()).then(d => {
      setServices(d.services || []);
      setManualForm(f => ({ ...f, serviceCode: f.serviceCode || (d.services && d.services[0]?.code) || "" }));
    });
    fetch("/api/admin/rooms").then(r => r.json()).then(d => setRooms(d.rooms || []));
  }, [authRole]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submitLogin(e) {
    e.preventDefault();
    setLoginError("");
    setLoginSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: loginPassword })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Inloggen mislukt.");
      setAuthRole(data.role);
      setLoginPassword("");
    } catch (err) {
      setLoginError(err.message);
    } finally {
      setLoginSubmitting(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setAuthRole("none");
  }

  const weekDays = useMemo(() => {
    const start = parseISO(monday);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [monday]);

  function shiftWeek(n) {
    load(toISO(addDays(parseISO(monday), n * 7)));
  }

  // --- Mini-maandkalender in de zijbalk ---

  // Volgt de huidig getoonde week: navigeer je via de week-knoppen of
  // "vandaag", dan springt de mini-kalender automatisch mee naar die maand.
  useEffect(() => {
    const d = parseISO(monday);
    setPickerYear(d.getFullYear());
    setPickerMonth(d.getMonth());
  }, [monday]);

  // Los van de week-navigatie kan je in de mini-kalender ook zelf verder
  // bladeren (bv. vooruitkijken) zonder dat de hoofdweergave meteen meespringt
  // — pas een klik op een dag springt naar die week.
  function shiftPickerMonth(n) {
    let m = pickerMonth + n;
    let y = pickerYear;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setPickerMonth(m);
    setPickerYear(y);
  }

  function pickDate(date) {
    load(mondayOf(toISO(date)));
  }

  const pickerGrid = useMemo(() => buildFullMonthGrid(pickerYear, pickerMonth), [pickerYear, pickerMonth]);

  async function submitPersonal(e) {
    e.preventDefault();
    await fetch("/api/admin/personal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(personalForm)
    });
    setShowAddPersonal(false);
    setPersonalForm({ title: "", dateISO: "", start: "", end: "" });
    load(monday);
  }

  // --- Tijdsblok ---
  // Een eigen blok in de agenda om zelf iets in te plannen. Het neemt geen
  // rooms in en blokkeert geen online boekingen (bewuste keuze, Robin aug
  // 2026) — daarvoor is er "Room(s) sluiten".

  function openTimeBlock(dateISO) {
    setBlockForm({ id: null, title: "", dateISO: dateISO || "", start: "", end: "" });
    setBlockError("");
    setShowTimeBlock(true);
  }

  function openEditTimeBlock(ev) {
    setBlockForm({
      id: ev.sessionId, title: ev.title || "",
      dateISO: ev.dateISO, start: ev.start, end: ev.end
    });
    setBlockError("");
    setShowTimeBlock(true);
  }

  async function submitTimeBlock(e) {
    e.preventDefault();
    if (blockForm.end <= blockForm.start) {
      setBlockError("Het einduur moet na het startuur liggen.");
      return;
    }
    setBlockSubmitting(true);
    setBlockError("");
    try {
      const res = await fetch("/api/admin/time-block", {
        method: blockForm.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(blockForm)
      });
      const data = await res.json();
      if (!res.ok) {
        setBlockError(data.error || "Er ging iets mis.");
        return;
      }
      setShowTimeBlock(false);
      setBlockForm(EMPTY_BLOCK_FORM);
      load(monday);
    } finally {
      setBlockSubmitting(false);
    }
  }

  async function verwijderTijdsblok(id) {
    setCtxMenu(null);
    const res = await fetch("/api/admin/time-block", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Het tijdsblok kon niet verwijderd worden.");
      return;
    }
    load(monday);
  }

  // --- Manuele boeking ---

  function openAddBooking() {
    setManualForm({ ...EMPTY_MANUAL_FORM, serviceCode: services[0]?.code || "" });
    setManualSlots([]);
    setManualError("");
    setShowAddBooking(true);
  }

  // Zelfde scherm, maar met de dag en het uur al ingevuld — vanuit het
  // rechtermuismenu op een vrije room.
  function openAddBookingVoor(dateISO, start) {
    const code = services[0]?.code || "";
    setManualForm({ ...EMPTY_MANUAL_FORM, serviceCode: code, dateISO, start });
    setManualError("");
    setShowAddBooking(true);
    fetchManualSlots(code, dateISO, EMPTY_MANUAL_FORM.partySize);
  }

  function fetchManualSlots(serviceCode, dateISO, partySize) {
    if (!serviceCode || !dateISO) { setManualSlots([]); return; }
    setManualLoadingSlots(true);
    // Bewust de ADMIN-route: een groep die niet in één room past mag hier wél
    // geboekt worden (die neemt automatisch een tweede room in). Het publieke
    // /api/availability blijft de online limiet van 7 aanhouden.
    fetch(`/api/admin/availability?service=${serviceCode}&date=${dateISO}&partySize=${partySize || 1}`)
      .then(r => r.json())
      .then(d => setManualSlots(d.slots || []))
      .finally(() => setManualLoadingSlots(false));
  }

  function updateManualField(patch) {
    const next = { ...manualForm, ...patch };
    setManualForm(next);
    if ("serviceCode" in patch || "dateISO" in patch || "partySize" in patch) {
      setManualForm(f => ({ ...f, start: "" }));
      fetchManualSlots(next.serviceCode, next.dateISO, next.partySize);
    }
  }

  // Het ingegeven aantal als getal — de invoer is een tekstveld, dus tijdens
  // het typen kan dit even NaN zijn.
  const grotereGroep = Number(manualForm.partySize) || 0;

  async function submitManual(e) {
    e.preventDefault();
    setManualError("");
    setManualSubmitting(true);
    try {
      const res = await fetch("/api/admin/manual-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceCode: manualForm.serviceCode,
          dateISO: manualForm.dateISO,
          start: manualForm.start,
          partySize: Number(manualForm.partySize),
          customer: {
            name: manualForm.name, email: manualForm.email.trim() || null,
            phone: manualForm.phone, birthDate: manualForm.birthDate || null
          },
          note: manualForm.note,
          // Betaalwijze wordt niet meer gevraagd (Robin, aug 2026): de
          // betaalregel krijgt gewoon 'manual' mee. Zie lib/store-sql.js.
          invoiceRequested: manualForm.invoiceRequested,
          invoiceDetails: manualForm.invoiceRequested
            ? { vatNumber: manualForm.vatNumber, companyName: manualForm.companyName }
            : null,
          giftCardCode: manualForm.giftCardCode.trim() || null,
          reserveOnly: manualForm.reserveOnly,
          amountOverride: manualForm.amountOverride.trim() || null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Er ging iets mis.");
      setShowAddBooking(false);
      load(monday);
    } catch (err) {
      setManualError(err.message);
    } finally {
      setManualSubmitting(false);
    }
  }

  // --- Room(s) sluiten ---

  function openCloseRoom() {
    setCloseForm(EMPTY_CLOSE_FORM);
    setCloseSlots([]);
    setCloseError("");
    setShowCloseRoom(true);
  }

  function fetchCloseSlots(dateISO) {
    if (!dateISO) { setCloseSlots([]); return; }
    setCloseLoadingSlots(true);
    fetch(`/api/availability?service=action_painting&date=${dateISO}`)
      .then(r => r.json())
      .then(d => setCloseSlots(d.slots || []))
      .finally(() => setCloseLoadingSlots(false));
  }

  function updateCloseField(patch) {
    const next = { ...closeForm, ...patch };
    setCloseForm(next);
    if ("dateISO" in patch) {
      setCloseForm(f => ({ ...f, start: "" }));
      fetchCloseSlots(next.dateISO);
    }
  }

  async function submitClose(e) {
    e.preventDefault();
    setCloseError("");
    setCloseSubmitting(true);
    try {
      const res = await fetch("/api/admin/close-room", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dateISO: closeForm.dateISO,
          allDay: closeForm.allDay,
          start: closeForm.allDay ? null : closeForm.start,
          allRooms: closeForm.allRooms,
          roomId: closeForm.allRooms ? null : closeForm.roomId,
          reason: closeForm.reason
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Er ging iets mis.");
      setShowCloseRoom(false);
      load(monday);
    } catch (err) {
      setCloseError(err.message);
    } finally {
      setCloseSubmitting(false);
    }
  }

  // --- Extra sessie (eenmalig, buiten het vaste uurrooster) ---

  function openAddExtra() {
    setExtraForm({ ...EMPTY_EXTRA_FORM, serviceCode: services[0]?.code || "" });
    setExtraError("");
    setShowAddExtra(true);
  }

  async function submitExtra(e) {
    e.preventDefault();
    setExtraError("");
    setExtraSubmitting(true);
    try {
      const res = await fetch("/api/admin/extra-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceCode: extraForm.serviceCode,
          dateISO: extraForm.dateISO,
          start: extraForm.start,
          capacity: extraForm.capacity || null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Er ging iets mis.");
      setShowAddExtra(false);
      load(monday);
    } catch (err) {
      setExtraError(err.message);
    } finally {
      setExtraSubmitting(false);
    }
  }

  // --- Cadeaubonnen ---

  function fetchGiftCards(query) {
    setGiftCardLoading(true);
    setGiftCardListError("");
    fetch(`/api/admin/gift-cards?q=${encodeURIComponent(query || "")}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error);
        setGiftCardResults(d.cards || []);
      })
      .catch(err => setGiftCardListError(err.message))
      .finally(() => setGiftCardLoading(false));
  }

  function openGiftCards() {
    setGiftCardQuery("");
    setShowAddGiftCard(false);
    setShowGiftCards(true);
    fetchGiftCards("");
  }

  async function toggleGiftCardStatus(card) {
    const newStatus = card.status === "active" ? "disabled" : "active";
    try {
      const res = await fetch(`/api/admin/gift-cards/${card.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Er ging iets mis.");
      fetchGiftCards(giftCardQuery);
    } catch (err) {
      setGiftCardListError(err.message);
    }
  }

  async function submitGiftCard(e) {
    e.preventDefault();
    setGiftCardError("");
    setGiftCardSubmitting(true);
    try {
      const res = await fetch("/api/admin/gift-cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: Number(giftCardForm.amount),
          purchaserName: giftCardForm.purchaserName || null,
          purchaserEmail: giftCardForm.purchaserEmail || null,
          note: giftCardForm.note || null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Er ging iets mis.");
      setShowAddGiftCard(false);
      setGiftCardForm(EMPTY_GIFT_CARD_FORM);
      fetchGiftCards(giftCardQuery);
    } catch (err) {
      setGiftCardError(err.message);
    } finally {
      setGiftCardSubmitting(false);
    }
  }

  // --- Reservering bevestigen (manuele boeking die nog niet betaald was) ---

  function openConfirmBooking(ev) {
    setConfirmTarget(ev);
    setConfirmError("");
  }

  async function submitConfirmBooking(e) {
    e.preventDefault();
    setConfirmError("");
    setConfirmSubmitting(true);
    try {
      const res = await fetch("/api/admin/confirm-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Geen betaalwijze meer (Robin, aug 2026) — de betaalregel blijft
        // op 'manual' staan.
        body: JSON.stringify({ bookingId: confirmTarget.bookingId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Er ging iets mis.");
      setConfirmTarget(null);
      load(monday);
    } catch (err) {
      setConfirmError(err.message);
    } finally {
      setConfirmSubmitting(false);
    }
  }

  // --- Boeking annuleren (bv. foute testboeking opruimen) ---

  useLayoutEffect(() => {
    const root = weekBodyRef.current;
    if (!root) return;

    function meet() {
      const staffRijen = [...root.querySelectorAll(".staff-row")];
      const bodies = [...root.querySelectorAll(".week-day-body")];
      if (!bodies.length) return;

      // 1. Alle rijen met werkuren even hoog maken. Zonder dit begint een dag
      //    met veel werkuren-chips lager dan de rest en lopen de dagen onderling
      //    uit de pas.
      const hoogste = staffRijen.reduce((max, el) => {
        const h = el.getBoundingClientRect().height;
        return h > max ? h : max;
      }, 0);
      if (hoogste > 0) {
        setStaffRijHoogte(prev => (prev !== null && Math.abs(prev - hoogste) < 0.5 ? prev : hoogste));
      }

      // 2. De uurbalk evenveel laten zakken als waar de dagkolommen beginnen.
      const offset = bodies[0].getBoundingClientRect().top - root.getBoundingClientRect().top;
      if (offset > 0) {
        setTijdbalkOffset(prev => (Math.abs(prev - offset) < 0.5 ? prev : offset));
      }
    }

    meet();
    const ro = new ResizeObserver(meet);
    ro.observe(root);
    return () => ro.disconnect();
  }, [events, staffShifts, loading, monday]);

  // "Els Peeters" -> "Els P."  ·  "Familie Vandenberghe" -> "Familie V."
  // Eén woord blijft ongewijzigd. Tussenvoegsels ("de", "van", "van den") tellen
  // niet als achternaam, anders zou "Ann de Velde" eindigen op "Ann d.".
  function shortenName(full) {
    const delen = String(full).trim().split(/\s+/).filter(Boolean);
    if (delen.length < 2) return full;
    const tussen = new Set(["de","den","der","van","vande","vanden","vander","le","la","du","het","ter","ten"]);
    let i = delen.length - 1;
    while (i > 0 && tussen.has(delen[i].toLowerCase())) i--;
    return `${delen[0]} ${delen[i][0].toUpperCase()}.`;
  }

  function openDetail(ev) {
    setDetailTarget(ev);
    setDetailError("");
    // Standaard vooraf ingevuld met het volledige bedrag (volledige
    // terugbetaling) — de medewerker kan dit verlagen voor een
    // gedeeltelijke terugbetaling (bv. annuleringskost ingehouden).
    setCancelRefundAmount(ev.amount != null ? String(ev.amount) : "0");
    setCancelReason("");
    setPartySizeInput(ev.partySize != null ? String(ev.partySize) : "");
    setRecalcPrice(false);
    setPartySizeNotice("");
    setNoteInput(ev.note || "");
    setNoteNotice("");
  }

  async function submitNote() {
    setDetailError("");
    setNoteNotice("");
    setDetailSubmitting(true);
    try {
      const res = await fetch("/api/admin/booking-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId: detailTarget.bookingId, note: noteInput })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Er ging iets mis.");
      setNoteNotice("Notitie bewaard.");
      setDetailTarget(t => t && ({ ...t, note: data.note }));
      load(monday);
    } catch (err) {
      setDetailError(err.message);
    } finally {
      setDetailSubmitting(false);
    }
  }

  async function submitPartySize() {
    setDetailError("");
    setPartySizeNotice("");
    setDetailSubmitting(true);
    try {
      const res = await fetch("/api/admin/change-party-size", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookingId: detailTarget.bookingId,
          partySize: Number(partySizeInput),
          recalculatePrice: recalcPrice
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Er ging iets mis.");
      setPartySizeNotice(
        `Aangepast naar ${data.partySize} personen` +
        (data.roomCode ? ` — room ${data.roomCode}` : "") +
        (data.priceRecalculated ? ` — nieuw bedrag €${Number(data.amountDue).toFixed(2)}` : "")
      );
      // Modal bewust open laten: zo ziet de medewerker meteen in welke room de
      // boeking terechtgekomen is. De kop bovenaan meteen mee bijwerken, anders
      // blijft daar het oude aantal en de oude room staan terwijl de melding
      // eronder al iets anders zegt.
      setDetailTarget(t => t && ({
        ...t,
        partySize: data.partySize,
        roomCode: data.roomCode ?? t.roomCode,
        amount: data.priceRecalculated ? Number(data.amountDue) : t.amount
      }));
      load(monday);
    } catch (err) {
      setDetailError(err.message);
    } finally {
      setDetailSubmitting(false);
    }
  }

  // Terugbetalen zonder te annuleren: de boeking en de room blijven staan.
  async function submitRefundBooking() {
    setDetailError("");
    setDetailSubmitting(true);
    try {
      const res = await fetch("/api/admin/refund-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookingId: detailTarget.bookingId,
          refundAmount: Number(cancelRefundAmount) || 0,
          reason: cancelReason
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Er ging iets mis.");
      setDetailTarget(null);
      load(monday);
    } catch (err) {
      setDetailError(err.message);
    } finally {
      setDetailSubmitting(false);
    }
  }

  async function submitCancelBooking() {
    setDetailError("");
    setDetailSubmitting(true);
    try {
      const res = await fetch("/api/admin/cancel-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookingId: detailTarget.bookingId,
          refundAmount: Number(cancelRefundAmount) || 0,
          reason: cancelReason
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Er ging iets mis.");
      setDetailTarget(null);
      load(monday);
    } catch (err) {
      setDetailError(err.message);
    } finally {
      setDetailSubmitting(false);
    }
  }

  // Vanuit het boekingsdetailscherm (na een klik op een boeking in de
  // agenda) — zo gaan zowel "Boeking verplaatsen" als "Boeking annuleren"
  // altijd meteen over de juiste boeking, zonder apart zoekscherm.
  // Vanuit het rechtermuismenu, rechtstreeks op de boeking in de agenda.
  function openReschedule(ev) {
    setRescheduleTarget(ev);
    setRescheduleDateISO(ev.dateISO);
    setRescheduleStart(ev.start);
    setRescheduleError("");
    setRescheduleSlots([]);
  }

  // Welke uren bestaan er op de gekozen dag, en passen ze voor deze groep?
  useEffect(() => {
    if (!rescheduleTarget || !rescheduleDateISO) { setRescheduleSlots([]); return; }
    setRescheduleLoadingSlots(true);
    fetch(`/api/availability?service=${rescheduleTarget.service}&date=${rescheduleDateISO}&partySize=${rescheduleTarget.partySize || 1}`)
      .then(r => r.json())
      .then(d => setRescheduleSlots(d.slots || []))
      .catch(() => setRescheduleSlots([]))
      .finally(() => setRescheduleLoadingSlots(false));
  }, [rescheduleTarget, rescheduleDateISO]);

  function openRescheduleFromDetail() {
    const t = detailTarget;
    setDetailTarget(null);
    openReschedule(t);
  }

  async function submitReschedule(e) {
    e.preventDefault();
    setRescheduleError("");
    setRescheduleSubmitting(true);
    try {
      const res = await fetch("/api/admin/reschedule-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId: rescheduleTarget.bookingId, dateISO: rescheduleDateISO, start: rescheduleStart })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Er ging iets mis.");
      setRescheduleTarget(null);
      load(monday);
    } catch (err) {
      setRescheduleError(err.message);
    } finally {
      setRescheduleSubmitting(false);
    }
  }

  // --- Boekingen importeren (Wix-CSV) ---

  function openImport() {
    setImportFileName("");
    setImportText("");
    setImportError("");
    setImportResult(null);
    setShowImport(true);
    setShowActionsMenu(false);
  }

  function handleImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setImportFileName(file.name);
    setImportError("");
    setImportResult(null);
    const reader = new FileReader();
    reader.onload = () => setImportText(String(reader.result || ""));
    reader.onerror = () => setImportError("Kon het bestand niet lezen.");
    reader.readAsText(file);
  }

  async function submitImport() {
    if (!importText) {
      setImportError("Kies eerst een CSV-bestand.");
      return;
    }
    setImportError("");
    setImportSubmitting(true);
    try {
      const res = await fetch("/api/admin/import-bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: importText })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Er ging iets mis.");
      setImportResult(data);
      load(monday);
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportSubmitting(false);
    }
  }

  // --- Personeelsplanning ---

  function openAddStaffShift(dateISO) {
    setStaffForm({ ...EMPTY_STAFF_FORM, dateISO });
    setStaffError("");
    setShowStaffShift(true);
  }

  function openEditStaffShift(shift) {
    setStaffForm({ id: shift.id, dateISO: shift.dateISO, staffName: shift.staffName, start: shift.start, end: shift.end, note: shift.note || "" });
    setStaffError("");
    setShowStaffShift(true);
  }

  function closeStaffShift() {
    setShowStaffShift(false);
  }

  async function submitStaffShift(e) {
    e.preventDefault();
    setStaffError("");
    setStaffSubmitting(true);
    try {
      const url = staffForm.id ? `/api/admin/staff-shifts/${staffForm.id}` : "/api/admin/staff-shifts";
      const method = staffForm.id ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dateISO: staffForm.dateISO, staffName: staffForm.staffName,
          start: staffForm.start, end: staffForm.end, note: staffForm.note
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Er ging iets mis.");
      setShowStaffShift(false);
      load(monday);
    } catch (err) {
      setStaffError(err.message);
    } finally {
      setStaffSubmitting(false);
    }
  }

  async function deleteStaffShiftHandler() {
    if (!staffForm.id) return;
    setStaffError("");
    setStaffSubmitting(true);
    try {
      const res = await fetch(`/api/admin/staff-shifts/${staffForm.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Er ging iets mis.");
      setShowStaffShift(false);
      load(monday);
    } catch (err) {
      setStaffError(err.message);
    } finally {
      setStaffSubmitting(false);
    }
  }

  // Bepaalt wat een klik op een boeking-blok in de agenda doet: een
  // manuele reservering die nog bevestigd moet worden opent de
  // bevestig-modal, elke andere echte klantboeking opent het detail/
  // annuleer-scherm. Vrije/gesloten cellen en persoonlijke afspraken zijn niet
  // klikbaar.
  // --- Rechtermuismenu ---

  function openCtxMenu(e, inhoud) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ ...inhoud, x: e.clientX, y: e.clientY });
  }

  // Lang indrukken op een tablet geeft hetzelfde menu; daar bestaat geen
  // rechtermuisknop.
  function langIndrukken(inhoud) {
    let timer = null;
    return {
      onTouchStart: e => {
        const t = e.touches[0];
        timer = setTimeout(() => setCtxMenu({ ...inhoud, x: t.clientX, y: t.clientY }), 500);
      },
      onTouchEnd: () => clearTimeout(timer),
      onTouchMove: () => clearTimeout(timer),
      onTouchCancel: () => clearTimeout(timer)
    };
  }

  // Escape sluit het menu, en bij het scrollen van de agenda verdwijnt het ook —
  // anders blijft het zweven op een plek die niets meer met de cel te maken heeft.
  useEffect(() => {
    if (!ctxMenu) return;
    const sluit = e => { if (!e || e.key === "Escape" || e.type === "scroll") setCtxMenu(null); };
    document.addEventListener("keydown", sluit);
    window.addEventListener("scroll", sluit, true);
    return () => {
      document.removeEventListener("keydown", sluit);
      window.removeEventListener("scroll", sluit, true);
    };
  }, [ctxMenu]);

  async function ctxSluitRoom({ dateISO, start, roomId, allRooms }) {
    setCtxMenu(null);
    try {
      const res = await fetch("/api/admin/close-room", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateISO, start, roomId, allRooms, reason: "Gesloten via de agenda" })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Er ging iets mis.");
      load(monday);
    } catch (err) { alert(err.message); }
  }

  async function ctxHeropenRoom({ dateISO, start, roomId, allRooms }) {
    setCtxMenu(null);
    try {
      const res = await fetch("/api/admin/reopen-room", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateISO, start, roomId, allRooms })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Er ging iets mis.");
      load(monday);
    } catch (err) { alert(err.message); }
  }

  function handleEventClick(ev) {
    if (ev.pendingConfirmation) return openConfirmBooking(ev);
    if (ev.kind === "service" && ev.bookingId) return openDetail(ev);
  }

  function eventVisual(ev) {
    // ev.redacted komt van de server (/api/admin/sessions) — die stuurt voor
    // de gast-rol de echte titel/klant/notitie/bedrag van privé-items al
    // niet mee, dus hier is enkel nog een weergavekeuze nodig, geen echte
    // toegangscontrole meer.
    if (ev.kind === "block") {
      // Eigen tijdsblok — paars, met de titel. Neemt geen room in en
      // blokkeert niets; het staat er om het team te tonen dat de zaal op dat
      // moment ergens anders voor gebruikt wordt.
      return {
        cls: "tijdsblok",
        label: ev.title || "Tijdsblok",
        sub: `${ev.start}–${ev.end}`
      };
    }
    if (ev.kind === "personal") {
      return {
        cls: "personal",
        label: ev.redacted ? "Privé" : ev.title,
        sub: ev.redacted ? "" : `${ev.start}–${ev.end}`
      };
    }
    if (ev.redacted) {
      return { cls: "private", label: "Bezet", sub: ev.start };
    }
    const base = ev.service === "fluid_art" ? "fluid" : "attack";
    let cls = ev.visibility === "private" ? `${base} private-visible` : base;
    if (ev.pendingConfirmation) cls += " pending-reservation";
    const label = ev.customer || serviceLabel(ev.service);
    // Roomcellen in de weekweergave zijn maar een veertigtal pixels breed. Een
    // volledige naam wordt daar toch afgekapt, en dan liever op een plek die we
    // zelf kiezen: voornaam + beginletter van de achternaam. De volledige naam
    // blijft beschikbaar als tooltip (title) en staat voluit in het detailvenster.
    const shortName = ev.customer ? shortenName(ev.customer) : label;
    // Het aantal personen staat apart als `count` en wordt als vast badge
    // rechtsboven in het blok getoond, NIET als deel van de tekstregel. In een
    // weekweergave zijn de kolommen smal: stond het achteraan de regel
    // ("Action Painting · 2p"), dan viel precies dat stuk als eerste weg door de
    // afkapping. Nu is het altijd leesbaar, hoe smal de kolom ook is.
    // Enkel een aantal tonen als er ECHT iemand geboekt heeft. Een lege sessie
    // toonde vroeger "0p", wat gewoon ruis is in een kolom vol vrije cellen.
    const count = ev.customer
      ? `${ev.partySize}p`
      : (ev.booked > 0 ? `${ev.booked}p` : null);
    let sub = ev.customer
      ? serviceLabel(ev.service)
      : `${ev.booked ?? 0}/${ev.capacity ?? "-"}`;
    if (ev.pendingConfirmation) sub += " · reservering";
    return { cls, label, shortName, sub, count };
  }

  if (authRole === null) {
    return (
      <div data-theme={darkMode ? "dark" : "light"} style={{ minHeight: "100vh", background: "var(--admin-bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <style>{css}</style>
        <p style={{ color: "var(--admin-text-muted)" }}>Laden…</p>
      </div>
    );
  }

  if (authRole === "none") {
    return (
      <div data-theme={darkMode ? "dark" : "light"} style={{ minHeight: "100vh", background: "var(--admin-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>
        <style>{css}</style>
        <form className="modal" style={{ width: 320 }} onSubmit={submitLogin}>
          <h3>Inloggen</h3>
          <p style={{ fontSize: 13, color: "var(--admin-text-muted)" }}>Toegang tot de backoffice-agenda.</p>
          <input
            required autoFocus type="password" placeholder="Wachtwoord"
            value={loginPassword} onChange={e => setLoginPassword(e.target.value)}
          />
          {loginError && <p className="error-text">{loginError}</p>}
          <button type="submit" className="add-btn" style={{ marginTop: 8 }} disabled={loginSubmitting}>
            {loginSubmitting ? "Bezig…" : "Inloggen"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div data-theme={darkMode ? "dark" : "light"} style={{ minHeight: "100vh", background: "var(--admin-bg)", color: "var(--admin-text)", fontFamily: "inherit" }}>
      <style>{css}</style>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--admin-line)" }}>
        <h1 style={{ fontSize: 20, margin: 0, color: "var(--admin-accent)" }}>Agenda</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <label className="theme-switch" title="Donkere modus">
            <input type="checkbox" checked={darkMode} onChange={toggleDarkMode} />
            <span className="theme-switch-track"></span>
          </label>
          <span style={{ fontSize: 13, color: "var(--admin-text-muted)" }}>
            Ingelogd als {authRole === "admin" ? "Admin" : "Gast"}
          </span>
          <button className="nav-btn" onClick={logout}>Uitloggen</button>
        </div>
      </header>

      <div className="agenda-layout">
        <aside className="sidebar">
          <div className="mini-cal-header">
            <button type="button" className="mini-nav-btn" onClick={() => shiftPickerMonth(-1)}>‹</button>
            <span className="mini-cal-title">{MONTHS_NL[pickerMonth]} {pickerYear}</span>
            <button type="button" className="mini-nav-btn" onClick={() => shiftPickerMonth(1)}>›</button>
          </div>
          <div className="mini-cal-grid">
            {DAY_LABELS.map(w => <div key={w} className="mini-cal-dow">{w}</div>)}
            {pickerGrid.map((cell, i) => {
              const dISO = toISO(cell.date);
              const isToday = dISO === toISO(new Date());
              const inSelectedWeek = weekDays.some(d => toISO(d) === dISO);
              let cls = "mini-cal-day";
              if (!cell.inMonth) cls += " outside";
              if (isToday) cls += " today";
              else if (inSelectedWeek) cls += " in-week";
              return (
                <button type="button" key={i} className={cls} onClick={() => pickDate(cell.date)}>
                  {cell.date.getDate()}
                </button>
              );
            })}
          </div>
        </aside>

        <main style={{ flex: 1, minWidth: 0 }}>
          <div style={{ padding: "12px 20px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button className="nav-btn" onClick={() => shiftWeek(-1)}>‹ vorige week</button>
            <span style={{ fontWeight: 700 }}>
              week van {weekDays[0].toLocaleDateString("nl-BE", { day: "2-digit", month: "long" })}
            </span>
            <button className="nav-btn" onClick={() => shiftWeek(1)}>volgende week ›</button>
            <button className="nav-btn" onClick={() => load(mondayOf(toISO(new Date())))}>vandaag</button>

            <div style={{ marginLeft: "auto", display: "flex", gap: 8, position: "relative" }}>
              <button className="add-btn secondary" onClick={() => setShowActionsMenu(v => !v)}>
                Meer acties {showActionsMenu ? "▴" : "▾"}
              </button>
              {showActionsMenu && (
                <>
                  <div className="menu-backdrop" onClick={() => setShowActionsMenu(false)} />
                  <div className="actions-menu">
                    <button type="button" onClick={() => { openGiftCards(); setShowActionsMenu(false); }}>Cadeaubonnen</button>
                    <button type="button" onClick={() => { openCloseRoom(); setShowActionsMenu(false); }}>Room(s) sluiten</button>
                    <button type="button" onClick={() => { openTimeBlock(""); setShowActionsMenu(false); }}>Tijdsblok toevoegen</button>
                    <button type="button" onClick={() => { setShowAddPersonal(true); setShowActionsMenu(false); }}>Persoonlijke afspraak</button>
                    <button type="button" onClick={() => { openAddExtra(); setShowActionsMenu(false); }}>Extra sessie</button>
                    {authRole === "admin" && (
                      <>
                        <div className="actions-menu-divider" />
                        <button type="button" onClick={openImport}>Boekingen importeren (CSV)</button>
                        <a
                          href={`/api/admin/agenda-export?week=${monday}`}
                          title="Excel-bestand met rijen en kolommen, opgebouwd zoals de Wix-boekingslijst: één rij per room per tijdslot, met een kolom Status (Geboekt / Vrij / Gesloten) om op te filteren"
                          onClick={() => setShowActionsMenu(false)}
                        >
                          Agenda exporteren (Excel)
                        </a>
                        <a
                          href={`/api/admin/agenda-export-pdf?week=${monday}`}
                          title="Afdrukbare agenda van deze week: per dag de werkuren en per tijdslot alle rooms — geboekt, vrij of gesloten"
                          onClick={() => setShowActionsMenu(false)}
                        >
                          Agenda afdrukken (PDF)
                        </a>
                        <a
                          href="/api/admin/customers-export"
                          title="CSV met e-mailadressen van klanten die toestemming gaven voor nieuws/promoties"
                          onClick={() => setShowActionsMenu(false)}
                        >
                          E-maillijst exporteren
                        </a>
                      </>
                    )}
                  </div>
                </>
              )}
              <button className="add-btn" onClick={openAddBooking}>+ Boeking toevoegen</button>
            </div>
          </div>

          {loading ? (
            <p style={{ padding: 20 }}>Laden…</p>
          ) : (
            <div className="week-body" ref={weekBodyRef}>
              <div className="week-time-col" style={{ paddingTop: tijdbalkOffset }}>
                {Array.from({ length: HOUR_END - HOUR_START + 1 }, (_, i) => (
                  <div key={i} className="hour-label">{HOUR_START + i}:00</div>
                ))}
              </div>
              <div className="week-days">
                {weekDays.map((d, i) => {
                  const dISO = toISO(d);
                  const dayEvents = events.filter(e => e.dateISO === dISO);
                  const otherEvents = dayEvents.filter(e => !(e.kind === "service" && e.usesRoomAssignment) && e.kind !== "room_closed");
                  const roomCells = buildRoomGrid(dayEvents, rooms);
                  return (
                    <div key={i} className="week-day-col">
                      <div className="week-day-head">{DAY_LABELS[i]} {d.getDate()}</div>
                      <div className="staff-row" style={staffRijHoogte ? { minHeight: staffRijHoogte } : undefined}>
                        {staffShifts.filter(s => s.dateISO === dISO).map(s => (
                          <button type="button" key={s.id} className="staff-chip" title={s.note || ""} onClick={() => openEditStaffShift(s)}>
                            {s.staffName} <span className="staff-chip-time">{s.start}–{s.end}</span>
                          </button>
                        ))}
                        <button type="button" className="staff-chip add" title="Werkuren toevoegen" onClick={() => openAddStaffShift(dISO)}>+</button>
                      </div>
                      <div className="week-day-body" style={{ height: (HOUR_END - HOUR_START) * HOUR_PX }}>
                        {roomCells.map(cell => {
                          const ctxBasis = { dateISO: dISO, start: cell.slotStart, roomId: cell.roomLabel };
                          if (cell.kind === "slotTag") {
                            const menu = {
                              soort: "tijdslot", dateISO: dISO, start: cell.slotStart,
                              vrijeRooms: cell.vrijInSlot, geslotenRooms: cell.geslotenInSlot
                            };
                            return (
                              <div
                                key={cell.key} className="cal-slot-tag"
                                style={{ top: cell.top, left: cell.left, height: cell.height }}
                                title={`${cell.slotStart} — rechterklik voor opties voor dit hele tijdslot`}
                                onContextMenu={authRole === "admin" ? e => openCtxMenu(e, menu) : undefined}
                                {...(authRole === "admin" ? langIndrukken(menu) : {})}
                              >
                                {cell.slotStart}
                              </div>
                            );
                          }
                          if (cell.kind === "free") {
                            const menu = { soort: "vrij", ...ctxBasis, vrijeRooms: cell.vrijInSlot };
                            return (
                              <div
                                key={cell.key} className="cal-room-cell free"
                                style={{ top: cell.top, height: cell.height, left: cell.left, width: cell.width }}
                                onContextMenu={authRole === "admin" ? e => openCtxMenu(e, menu) : undefined}
                                {...(authRole === "admin" ? langIndrukken(menu) : {})}
                                title="Rechterklik voor opties"
                              >
                                <div className="cal-room-label">{cell.roomLabel}</div>
                                <div className="cal-room-sub">Vrij</div>
                              </div>
                            );
                          }
                          if (cell.kind === "closed") {
                            const menu = { soort: "gesloten", ...ctxBasis, reden: cell.ev.reason };
                            return (
                              <div
                                key={cell.key} className="cal-room-cell closed"
                                style={{ top: cell.top, height: cell.height, left: cell.left, width: cell.width }}
                                title={`${cell.ev.reason || "Gesloten"} — rechterklik om te heropenen`}
                                onContextMenu={authRole === "admin" ? e => openCtxMenu(e, menu) : undefined}
                                {...(authRole === "admin" ? langIndrukken(menu) : {})}
                              >
                                <div className="cal-room-label">{cell.roomLabel}</div>
                                <div className="cal-room-sub">Niet beschikbaar</div>
                              </div>
                            );
                          }
                          const v = eventVisual(cell.ev);
                          // Roomcel: roomcode bovenaan (vaste plaats per room),
                          // daaronder de naam en het aantal personen. De
                          // workshopnaam staat hier bewust NIET meer — die paste
                          // toch niet en is af te lezen aan de kleur.
                          return (
                            <div
                              key={cell.key}
                              className={`cal-event cal-room-booked ${v.cls}${cell.ev.pendingConfirmation || cell.ev.bookingId ? " clickable" : ""}`}
                              style={{ top: cell.top, height: cell.height, left: cell.left, width: cell.width }}
                              onClick={() => handleEventClick(cell.ev)}
                              onContextMenu={authRole === "admin" && cell.ev.bookingId
                                ? e => openCtxMenu(e, { soort: "boeking", ev: cell.ev, roomId: cell.roomLabel })
                                : undefined}
                              {...(authRole === "admin" && cell.ev.bookingId
                                ? langIndrukken({ soort: "boeking", ev: cell.ev, roomId: cell.roomLabel })
                                : {})}
                              title={[
                                cell.ev.customer,
                                cell.ev.partySize != null ? `${cell.ev.partySize} personen` : null,
                                cell.roomLabel ? `room ${cell.roomLabel}` : null,
                                serviceLabel(cell.ev.service),
                                cell.ev.pendingConfirmation ? "— klik om te bevestigen" : "— klik voor details"
                              ].filter(Boolean).join(" · ")}
                            >
                              {cell.roomLabel && <div className="cal-room-code">{cell.roomLabel}</div>}
                              <div className="cal-event-label">{v.shortName}</div>
                              {v.count && <span className="cal-event-count">{v.count}</span>}
                              {cell.ev.pendingConfirmation && <div className="cal-event-sub">reservering</div>}
                            </div>
                          );
                        })}
                        {layoutDayEvents(otherEvents).map((item, idx) => {
                          const { ev, startMin, endMin, col, cols } = item;
                          const top = ((startMin / 60) - HOUR_START) * HOUR_PX;
                          const height = ((endMin - startMin) / 60) * HOUR_PX;
                          const v = eventVisual(ev);
                          return (
                            <div
                              key={idx}
                              className={`cal-event ${v.cls}${ev.pendingConfirmation || ev.bookingId || ev.kind === "block" ? " clickable" : ""}`}
                              style={{
                                top,
                                height,
                                left: `calc(${(col / cols) * 100}% + 3px)`,
                                width: `calc(${100 / cols}% - 6px)`
                              }}
                              onClick={() => (ev.kind === "block" ? openEditTimeBlock(ev) : handleEventClick(ev))}
                              onContextMenu={ev.kind === "block" ? e => openCtxMenu(e, { soort: "tijdsblok", ev }) : undefined}
                              {...(ev.kind === "block" ? langIndrukken({ soort: "tijdsblok", ev }) : {})}
                              title={
                                ev.kind === "block"
                                  ? `${ev.title || "Tijdsblok"} — klik om aan te passen, rechterklik om te verwijderen`
                                  : ev.pendingConfirmation ? "Klik om deze reservering te bevestigen" : (ev.bookingId ? "Klik voor details / annuleren" : undefined)
                              }
                            >
                              <div className="cal-event-label">{v.label}</div>
                              {v.count && <span className="cal-event-count">{v.count}</span>}
                              {v.sub && <div className="cal-event-sub">{v.sub}</div>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </main>
      </div>

      {showTimeBlock && (
        <div className="modal-backdrop" onClick={() => setShowTimeBlock(false)}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submitTimeBlock}>
            <h3>{blockForm.id ? "Tijdsblok aanpassen" : "Tijdsblok toevoegen"}</h3>
            <p style={{ fontSize: 13, color: "var(--admin-text-muted)" }}>
              Een eigen blok in de agenda om zelf iets in te plannen (bv. "Kamp voorbereiden").
              Het staat in het paars en neemt geen room in: klanten kunnen die uren nog gewoon
              boeken. Wil je dat niet, gebruik dan "Room(s) sluiten".
            </p>
            <input required placeholder='Titel (bv. "Zaal klaarzetten")' value={blockForm.title}
              onChange={e => setBlockForm({ ...blockForm, title: e.target.value })} />
            <label className="field-label">Datum</label>
            <input required type="date" value={blockForm.dateISO}
              onChange={e => setBlockForm({ ...blockForm, dateISO: e.target.value })} />
            <label className="field-label">Van / tot</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input required type="time" value={blockForm.start}
                onChange={e => setBlockForm({ ...blockForm, start: e.target.value })} />
              <input required type="time" value={blockForm.end}
                onChange={e => setBlockForm({ ...blockForm, end: e.target.value })} />
            </div>

            {blockError && <p className="error-text">{blockError}</p>}

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button type="button" onClick={() => setShowTimeBlock(false)}>Annuleren</button>
              <button type="submit" className="add-btn" disabled={blockSubmitting}>
                {blockSubmitting ? "Bezig…" : blockForm.id ? "Opslaan" : "Toevoegen"}
              </button>
            </div>
          </form>
        </div>
      )}

      {showAddPersonal && (
        <div className="modal-backdrop" onClick={() => setShowAddPersonal(false)}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submitPersonal}>
            <h3>Persoonlijke afspraak</h3>
            <p style={{ fontSize: 13, color: "var(--admin-text-muted)" }}>
              Altijd privé en zonder klant of prijs — enkel een geblokkeerd tijdslot (bv. "Dokter").
            </p>
            <input required placeholder='Titel (bv. "Dokter")' value={personalForm.title}
              onChange={e => setPersonalForm({ ...personalForm, title: e.target.value })} />
            <input required type="date" value={personalForm.dateISO}
              onChange={e => setPersonalForm({ ...personalForm, dateISO: e.target.value })} />
            <div style={{ display: "flex", gap: 8 }}>
              <input required type="time" value={personalForm.start}
                onChange={e => setPersonalForm({ ...personalForm, start: e.target.value })} />
              <input required type="time" value={personalForm.end}
                onChange={e => setPersonalForm({ ...personalForm, end: e.target.value })} />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button type="button" onClick={() => setShowAddPersonal(false)}>Annuleren</button>
              <button type="submit" className="add-btn">Toevoegen</button>
            </div>
          </form>
        </div>
      )}

      {showAddBooking && (
        <div className="modal-backdrop" onClick={() => setShowAddBooking(false)}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submitManual}>
            <h3>Boeking toevoegen</h3>
            <p style={{ fontSize: 13, color: "var(--admin-text-muted)" }}>
              Voor een boeking die je zelf ingeeft (bv. na een telefoontje). Nooit via Mollie —
              kies hieronder hoe er (al dan niet) betaald werd. Verwacht je dat de details nog
              wijzigen? Vink "enkel reserveren" aan: dan wordt niets definitief (geen factuur,
              geen cadeaubon-afschrijving) tot je de boeking later zelf bevestigt.
            </p>

            <label className="field-label">Workshop</label>
            <select value={manualForm.serviceCode} onChange={e => updateManualField({ serviceCode: e.target.value })}>
              {services.map(s => <option key={s.code} value={s.code}>{s.label}</option>)}
            </select>

            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label className="field-label">Datum</label>
                <input required type="date" value={manualForm.dateISO}
                  onChange={e => updateManualField({ dateISO: e.target.value })} />
              </div>
              <div style={{ width: 90 }}>
                <label className="field-label">Personen</label>
                <input required type="number" min={1} value={manualForm.partySize}
                  onChange={e => updateManualField({ partySize: e.target.value })} />
              </div>
            </div>

            {/* De online limiet van 7 geldt hier niet (Robin, aug 2026). Past
                de groep niet in room A (10 plaatsen), dan komt room VR er
                automatisch bij. Bewust enkel de vaststelling, geen advies:
                welke rooms er eventueel nog bijgesloten worden beslist het
                team zelf. */}
            {grotereGroep > 10 && (
              <p style={{ fontSize: 12, color: "var(--admin-accent)", margin: "-4px 0 0", fontWeight: 700 }}>
                {grotereGroep} personen: room A en room VR worden ingenomen.
              </p>
            )}

            {manualForm.dateISO && (
              <div>
                <label className="field-label">Tijdstip</label>
                {manualLoadingSlots && <p className="muted-text">Beschikbaarheid laden…</p>}
                {!manualLoadingSlots && manualSlots.length === 0 && <p className="muted-text">Geen sessies op deze dag.</p>}
                <div className="slot-row">
                  {manualSlots.map(s => (
                    <button type="button" key={s.start} disabled={!s.bookable}
                      className={`slot-chip ${manualForm.start === s.start ? "selected" : ""} ${!s.bookable ? "disabled" : ""}`}
                      onClick={() => setManualForm(f => ({ ...f, start: s.start }))}>
                      {s.start}{!s.bookable ? " (volzet)" : ""}
                    </button>
                  ))}
                </div>

                {/* Zelf een uur kiezen (Robin, aug 2026). Aan de telefoon wordt
                    er soms een uur afgesproken dat niet in het vaste rooster
                    staat; dan wordt die sessie eenmalig aangemaakt, net als bij
                    het verplaatsen van een boeking. */}
                <label className="field-label" style={{ marginTop: 10 }}>Of een ander uur</label>
                <input type="time" value={manualForm.start}
                  onChange={e => setManualForm(f => ({ ...f, start: e.target.value }))} />
                <p style={{ fontSize: 12, color: "var(--admin-text-muted)", margin: "4px 0 0" }}>
                  Staat er nog geen sessie op dat uur, dan wordt die eenmalig aangemaakt.
                  Het vaste uurrooster verandert daar niet door.
                </p>
              </div>
            )}

            <input required placeholder="Naam klant" value={manualForm.name}
              onChange={e => setManualForm({ ...manualForm, name: e.target.value })} />
            {/* E-mail is niet verplicht (Robin, aug 2026): aan de balie of aan
                de telefoon heeft niet elke klant er een bij de hand. Zonder
                e-mail vertrekt er geen bevestigingsmail — bij een manuele
                boeking gebeurt dat sowieso al niet. */}
            <input type="email" placeholder="E-mail (optioneel)" value={manualForm.email}
              onChange={e => setManualForm({ ...manualForm, email: e.target.value })} />
            <input placeholder="Telefoon (optioneel)" value={manualForm.phone}
              onChange={e => setManualForm({ ...manualForm, phone: e.target.value })} />
            <div>
              <label className="field-label">Geboortedatum (optioneel)</label>
              <input type="date" value={manualForm.birthDate}
                onChange={e => setManualForm({ ...manualForm, birthDate: e.target.value })} />
            </div>
            <textarea placeholder="Notitie (optioneel)" value={manualForm.note}
              onChange={e => setManualForm({ ...manualForm, note: e.target.value })} style={{ minHeight: 50 }} />

            {/* Boven 7 personen stopt de prijstrap. Het systeem rekent dan
                door aan de prijs per persoon van de hoogste trede (€52), maar
                voor een grote groep wordt vaak apart onderhandeld — vandaar
                dit vakje om het afgesproken bedrag zelf te zetten. */}
            {grotereGroep > 7 && (
              <div>
                <label className="field-label">Totaalbedrag (optioneel)</label>
                <input type="number" min={0} step="0.01"
                  placeholder={`Leeg laten = €${(grotereGroep * 52).toFixed(2)} (€52 p.p.)`}
                  value={manualForm.amountOverride}
                  onChange={e => setManualForm({ ...manualForm, amountOverride: e.target.value })} />
              </div>
            )}

            <input placeholder="Cadeaubon-code (optioneel)" value={manualForm.giftCardCode}
              onChange={e => setManualForm({ ...manualForm, giftCardCode: e.target.value })} />

            <label className="checkbox-row">
              <input type="checkbox" checked={manualForm.reserveOnly}
                onChange={e => setManualForm({ ...manualForm, reserveOnly: e.target.checked })} />
              Enkel reserveren (nog niet bevestigd/betaald)
            </label>

            <label className="checkbox-row">
              <input type="checkbox" checked={manualForm.invoiceRequested}
                onChange={e => setManualForm({ ...manualForm, invoiceRequested: e.target.checked })} />
              Klant wenst een factuur
            </label>
            {manualForm.invoiceRequested && (
              <>
                <input placeholder="BTW-nummer" value={manualForm.vatNumber}
                  onChange={e => setManualForm({ ...manualForm, vatNumber: e.target.value })} />
                <input placeholder="Bedrijfsnaam" value={manualForm.companyName}
                  onChange={e => setManualForm({ ...manualForm, companyName: e.target.value })} />
              </>
            )}

            {manualError && <p className="error-text">{manualError}</p>}

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button type="button" onClick={() => setShowAddBooking(false)}>Annuleren</button>
              <button type="submit" className="add-btn" disabled={!manualForm.start || manualSubmitting}>
                {manualSubmitting ? "Bezig…" : manualForm.reserveOnly ? "Reserveren" : "Toevoegen"}
              </button>
            </div>
          </form>
        </div>
      )}

      {showCloseRoom && (
        <div className="modal-backdrop" onClick={() => setShowCloseRoom(false)}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submitClose}>
            <h3>Room(s) sluiten</h3>
            <p style={{ fontSize: 13, color: "var(--admin-text-muted)" }}>
              Enkel van toepassing op Action Painting. Een room met een bestaande klantboeking
              wordt nooit overschreven.
            </p>

            <label className="field-label">Datum</label>
            <input required type="date" value={closeForm.dateISO}
              onChange={e => updateCloseField({ dateISO: e.target.value })} />

            <label className="checkbox-row">
              <input type="checkbox" checked={closeForm.allDay}
                onChange={e => setCloseForm({ ...closeForm, allDay: e.target.checked, start: "" })} />
              Hele dag sluiten (alle tijdstippen)
            </label>

            {!closeForm.allDay && closeForm.dateISO && (
              <div>
                <label className="field-label">Tijdstip</label>
                {closeLoadingSlots && <p className="muted-text">Beschikbaarheid laden…</p>}
                {!closeLoadingSlots && closeSlots.length === 0 && <p className="muted-text">Geen sessies op deze dag.</p>}
                <div className="slot-row">
                  {closeSlots.map(s => (
                    <button type="button" key={s.start}
                      className={`slot-chip ${closeForm.start === s.start ? "selected" : ""}`}
                      onClick={() => setCloseForm(f => ({ ...f, start: s.start }))}>
                      {s.start}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <label className="checkbox-row">
              <input type="checkbox" checked={closeForm.allRooms}
                onChange={e => setCloseForm({ ...closeForm, allRooms: e.target.checked, roomId: "" })} />
              Alle rooms
            </label>
            {!closeForm.allRooms && (
              <select value={closeForm.roomId} onChange={e => setCloseForm({ ...closeForm, roomId: e.target.value })}>
                <option value="">Kies een room…</option>
                {rooms.map(r => <option key={r.id} value={r.id}>{r.label} ({r.capacity}p)</option>)}
              </select>
            )}

            <input placeholder='Reden (bv. "Sluitingsdag", "Onderhoud")' value={closeForm.reason}
              onChange={e => setCloseForm({ ...closeForm, reason: e.target.value })} />

            {closeError && <p className="error-text">{closeError}</p>}

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button type="button" onClick={() => setShowCloseRoom(false)}>Annuleren</button>
              <button
                type="submit"
                className="add-btn"
                disabled={(!closeForm.allDay && !closeForm.start) || (!closeForm.allRooms && !closeForm.roomId) || closeSubmitting}
              >
                {closeSubmitting ? "Bezig…" : "Sluiten"}
              </button>
            </div>
          </form>
        </div>
      )}

      {showAddExtra && (
        <div className="modal-backdrop" onClick={() => setShowAddExtra(false)}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submitExtra}>
            <h3>Extra sessie toevoegen</h3>
            <p style={{ fontSize: 13, color: "var(--admin-text-muted)" }}>
              Voor een eenmalig extra tijdstip buiten het vaste uurrooster — bv. Fluid Art zit een
              week volzet, en je plant een extra sessie de week erna. Verschijnt meteen als
              boekbaar tijdstip in de klant-widget.
            </p>

            <label className="field-label">Workshop</label>
            <select value={extraForm.serviceCode} onChange={e => setExtraForm({ ...extraForm, serviceCode: e.target.value })}>
              {services.map(s => <option key={s.code} value={s.code}>{s.label}</option>)}
            </select>

            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label className="field-label">Datum</label>
                <input required type="date" value={extraForm.dateISO}
                  onChange={e => setExtraForm({ ...extraForm, dateISO: e.target.value })} />
              </div>
              <div style={{ flex: 1 }}>
                <label className="field-label">Tijdstip</label>
                <input required type="time" value={extraForm.start}
                  onChange={e => setExtraForm({ ...extraForm, start: e.target.value })} />
              </div>
            </div>

            {!services.find(s => s.code === extraForm.serviceCode)?.usesRoomAssignment && (
              <div>
                <label className="field-label">Capaciteit (optioneel — standaard zoals normale sessies)</label>
                <input type="number" min={1} placeholder="bv. 10" value={extraForm.capacity}
                  onChange={e => setExtraForm({ ...extraForm, capacity: e.target.value })} />
              </div>
            )}

            {extraError && <p className="error-text">{extraError}</p>}

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button type="button" onClick={() => setShowAddExtra(false)}>Annuleren</button>
              <button type="submit" className="add-btn" disabled={extraSubmitting}>
                {extraSubmitting ? "Bezig…" : "Toevoegen"}
              </button>
            </div>
          </form>
        </div>
      )}

      {showGiftCards && (
        <div className="modal-backdrop" onClick={() => setShowGiftCards(false)}>
          <div className="modal" style={{ width: 420 }} onClick={e => e.stopPropagation()}>
            <h3>Cadeaubonnen</h3>

            <input
              placeholder="Zoek op code, naam of e-mail…"
              value={giftCardQuery}
              onChange={e => { setGiftCardQuery(e.target.value); fetchGiftCards(e.target.value); }}
            />

            {giftCardLoading && <p className="muted-text">Laden…</p>}
            {giftCardListError && <p className="error-text">{giftCardListError}</p>}
            {!giftCardLoading && giftCardResults.length === 0 && (
              <p className="muted-text">Geen cadeaubonnen gevonden.</p>
            )}

            <div className="gift-card-list">
              {giftCardResults.map(card => (
                <div key={card.id} className="gift-card-row">
                  <div>
                    <div style={{ fontWeight: 700 }}>{card.code}</div>
                    <div className="muted-text" style={{ margin: 0 }}>
                      €{card.remainingAmount.toFixed(2)} / €{card.initialAmount.toFixed(2)}
                      {card.purchaserName ? ` · ${card.purchaserName}` : ""}
                      {card.expiresAt ? ` · geldig tot ${card.expiresAt}` : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className={`gift-card-status ${card.status}`}>
                      {card.status === "active" ? "actief" : card.status === "disabled" ? "uitgeschakeld" : "opgebruikt"}
                    </span>
                    {card.status !== "depleted" && (
                      <button type="button" className="add-btn secondary" style={{ padding: "4px 10px", fontSize: 12 }}
                        onClick={() => toggleGiftCardStatus(card)}>
                        {card.status === "active" ? "Uitschakelen" : "Activeren"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {!showAddGiftCard ? (
              <button type="button" className="add-btn" style={{ marginTop: 8 }} onClick={() => setShowAddGiftCard(true)}>
                + Nieuwe cadeaubon
              </button>
            ) : (
              <form onSubmit={submitGiftCard} style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                <input required type="number" min="1" placeholder="Bedrag (€)" value={giftCardForm.amount}
                  onChange={e => setGiftCardForm({ ...giftCardForm, amount: e.target.value })} />
                <input placeholder="Naam koper (optioneel)" value={giftCardForm.purchaserName}
                  onChange={e => setGiftCardForm({ ...giftCardForm, purchaserName: e.target.value })} />
                <input type="email" placeholder="E-mail koper (optioneel)" value={giftCardForm.purchaserEmail}
                  onChange={e => setGiftCardForm({ ...giftCardForm, purchaserEmail: e.target.value })} />
                <input placeholder="Notitie (optioneel)" value={giftCardForm.note}
                  onChange={e => setGiftCardForm({ ...giftCardForm, note: e.target.value })} />
                {giftCardError && <p className="error-text">{giftCardError}</p>}
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" onClick={() => setShowAddGiftCard(false)}>Annuleren</button>
                  <button type="submit" className="add-btn" disabled={giftCardSubmitting}>
                    {giftCardSubmitting ? "Bezig…" : "Aanmaken"}
                  </button>
                </div>
              </form>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button type="button" onClick={() => setShowGiftCards(false)}>Sluiten</button>
            </div>
          </div>
        </div>
      )}

      {confirmTarget && (
        <div className="modal-backdrop" onClick={() => setConfirmTarget(null)}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submitConfirmBooking}>
            <h3>Reservering bevestigen</h3>
            <p style={{ fontSize: 13, color: "var(--admin-text-muted)" }}>
              {confirmTarget.customer} — {serviceLabel(confirmTarget.service)}, {confirmTarget.partySize}p,{" "}
              {confirmTarget.dateISO} om {confirmTarget.start}
              {confirmTarget.amount != null && <> — €{confirmTarget.amount.toFixed(2)} te betalen</>}.
              Dit registreert de boeking als definitief betaald (en maakt de factuur/cadeaubon-
              afschrijving alsnog in orde, indien van toepassing) — nog steeds zonder bevestigingsmail.
            </p>

            {confirmError && <p className="error-text">{confirmError}</p>}

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button type="button" onClick={() => setConfirmTarget(null)}>Annuleren</button>
              <button type="submit" className="add-btn" disabled={confirmSubmitting}>
                {confirmSubmitting ? "Bezig…" : "Bevestigen"}
              </button>
            </div>
          </form>
        </div>
      )}

      {detailTarget && (
        <div className="modal-backdrop" onClick={() => setDetailTarget(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Boekingsdetails</h3>
            <p style={{ fontSize: 13, color: "var(--admin-text-muted)" }}>
              {detailTarget.customer} — {serviceLabel(detailTarget.service)}, {detailTarget.partySize}p
              {detailTarget.roomCode && <> — Room {detailTarget.roomCode}</>}
              <br />
              {detailTarget.dateISO} om {detailTarget.start}
              {detailTarget.amount != null && <> — €{detailTarget.amount.toFixed(2)}</>}
              {detailTarget.paymentStatus && <> ({detailTarget.paymentStatus === "paid" ? "betaald" : "nog niet betaald"})</>}
            </p>

            {authRole === "admin" ? (
              <>
                {/* Aantal personen — bewust bovenaan: de rooms verschillen in
                    capaciteit (A=10, VL=7, VR=7, M=5), dus dit is meestal het
                    eerste wat rechtgezet moet worden bij een boeking die uit
                    Wix geïmporteerd is. */}
                <div className="detail-block">
                  <label className="field-label">Aantal personen</label>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      type="number" min="1" step="1"
                      value={partySizeInput}
                      onChange={e => setPartySizeInput(e.target.value)}
                      style={{ width: 70 }}
                    />
                    <button
                      type="button" className="add-btn secondary"
                      disabled={detailSubmitting || !partySizeInput || Number(partySizeInput) === detailTarget.partySize}
                      onClick={submitPartySize}
                    >
                      {detailSubmitting ? "Bezig…" : "Aanpassen en room herbekijken"}
                    </button>
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 6, color: "var(--admin-text-muted)" }}>
                    <input type="checkbox" checked={recalcPrice} onChange={e => setRecalcPrice(e.target.checked)} />
                    Prijs mee herrekenen naar het tarief voor deze groepsgrootte
                  </label>
                  <p style={{ fontSize: 12, color: "var(--admin-text-muted)", margin: "6px 0 0" }}>
                    Het systeem kiest de kleinste vrije room die past. Vink hierboven aan als de
                    klant ook een ander bedrag moet betalen — anders blijft het betaalde bedrag staan.
                  </p>
                  {partySizeNotice && <p style={{ fontSize: 12, color: "var(--admin-accent)", margin: "6px 0 0", fontWeight: 700 }}>{partySizeNotice}</p>}
                </div>

                {/* Notitie — staat vlak onder het aantal personen, want dat zijn
                    de twee dingen die je bij een boeking het vaakst bijwerkt. */}
                <div className="detail-block">
                  <label className="field-label">Notitie bij deze boeking</label>
                  <textarea
                    rows={3}
                    value={noteInput}
                    onChange={e => setNoteInput(e.target.value)}
                    placeholder='bv. "belt nog terug over het formaat" of "brengt eigen canvas mee"'
                    style={{ width: "100%", resize: "vertical", font: "inherit", fontSize: 13,
                             padding: 8, borderRadius: 8, border: "1px solid var(--admin-line)",
                             background: "var(--admin-surface)", color: "var(--admin-text)" }}
                  />
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                    <button
                      type="button" className="add-btn secondary"
                      disabled={detailSubmitting || noteInput === (detailTarget.note || "")}
                      onClick={submitNote}
                    >
                      {detailSubmitting ? "Bezig…" : "Notitie bewaren"}
                    </button>
                    <span style={{ fontSize: 12, color: "var(--admin-text-muted)" }}>
                      {noteInput.length}/2000
                    </span>
                    {noteNotice && <span style={{ fontSize: 12, color: "var(--admin-accent)", fontWeight: 700 }}>{noteNotice}</span>}
                  </div>
                  <p style={{ fontSize: 12, color: "var(--admin-text-muted)", margin: "6px 0 0" }}>
                    Zichtbaar in de weekagenda, de PDF-export en de interne bevestigingsmail — dus geen
                    plek voor gevoelige gegevens.
                  </p>
                </div>

                <p style={{ fontSize: 12, color: "var(--admin-text-muted)" }}>
                  Vul hieronder het bedrag in en kies dan onderaan wat er moet gebeuren.
                  <br />
                  <strong>Enkel terugbetalen</strong> laat de boeking gewoon staan — de room blijft
                  bezet en de klant komt langs. Voor een prijscorrectie of een commercieel gebaar.
                  <br />
                  <strong>Annuleren</strong> maakt de room weer vrij voor dit tijdslot.
                  <br />
                  In beide gevallen telt enkel het behouden bedrag (bedrag min terugbetaling) mee in
                  de wekelijkse omzetfactuur.
                </p>
                {detailTarget.amount != null && (
                  <>
                    {detailTarget.refundedAmount > 0 && (
                      <p style={{ fontSize: 12, color: "var(--admin-accent)", margin: "6px 0 0" }}>
                        Al terugbetaald: €{detailTarget.refundedAmount.toFixed(2)} — nog €
                        {(detailTarget.amount - detailTarget.refundedAmount).toFixed(2)} terugbetaalbaar.
                      </p>
                    )}
                    <label className="field-label">
                      Bedrag (max €{(detailTarget.amount - (detailTarget.refundedAmount || 0)).toFixed(2)})
                    </label>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input
                        type="number" min="0" max={detailTarget.amount} step="0.01"
                        value={cancelRefundAmount}
                        onChange={e => setCancelRefundAmount(e.target.value)}
                        style={{ width: 100 }}
                      />
                      <button type="button" className="add-btn secondary" onClick={() => setCancelRefundAmount(String(Math.round((detailTarget.amount - (detailTarget.refundedAmount || 0)) * 100) / 100))}>Volledig</button>
                      <button type="button" className="add-btn secondary" onClick={() => setCancelRefundAmount("0")}>Geen</button>
                    </div>
                    <label className="field-label">Reden / notitie (optioneel)</label>
                    <input type="text" placeholder='bv. "annulering 2 dagen op voorhand, 20 EUR kost"' value={cancelReason} onChange={e => setCancelReason(e.target.value)} />
                  </>
                )}
                {detailError && <p className="error-text">{detailError}</p>}
                <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => setDetailTarget(null)}>Sluiten</button>
                  <a
                    className="add-btn secondary"
                    style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}
                    href={`/api/admin/booking-export-pdf?bookingId=${detailTarget.bookingId}`}
                    title="Download deze boeking als PDF, om extern te bewaren"
                  >
                    Boeking exporteren (PDF)
                  </a>
                  <button type="button" className="add-btn secondary" onClick={openRescheduleFromDetail}>
                    Boeking verplaatsen
                  </button>
                  <button
                    type="button"
                    className="add-btn secondary"
                    disabled={detailSubmitting || detailTarget.paymentStatus !== "paid"}
                    title={detailTarget.paymentStatus !== "paid"
                      ? "Enkel mogelijk bij een betaalde boeking"
                      : "De boeking blijft staan, de room blijft bezet"}
                    onClick={submitRefundBooking}
                  >
                    {detailSubmitting ? "Bezig…" : "Enkel terugbetalen"}
                  </button>
                  <button
                    type="button"
                    className="add-btn"
                    style={{ background: "#B33A2E" }}
                    disabled={detailSubmitting}
                    onClick={submitCancelBooking}
                  >
                    {detailSubmitting ? "Bezig…" : "Boeking annuleren"}
                  </button>
                </div>
              </>
            ) : (
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button type="button" onClick={() => setDetailTarget(null)}>Sluiten</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Rechtermuismenu. Eén component, vier vormen — welke items je krijgt hangt
          af van waar je geklikt hebt. Alle acties bestonden al, behalve het
          heropenen van een gesloten room. */}
      {ctxMenu && (
        <>
          <div className="menu-backdrop" onClick={() => setCtxMenu(null)} onContextMenu={e => { e.preventDefault(); setCtxMenu(null); }} />
          <div className="ctx-menu" style={{ left: Math.min(ctxMenu.x, 1200), top: ctxMenu.y }} onClick={e => e.stopPropagation()}>
            {ctxMenu.soort === "boeking" && (
              <>
                <div className="ctx-kop">{ctxMenu.ev.customer} — room {ctxMenu.roomId}</div>
                <button type="button" onClick={() => { setCtxMenu(null); openDetail(ctxMenu.ev); }}>Boeking wijzigen</button>
                <button type="button" onClick={() => { setCtxMenu(null); openDetail(ctxMenu.ev); }}>Aantal personen aanpassen</button>
                <button type="button" onClick={() => { const ev = ctxMenu.ev; setCtxMenu(null); openReschedule(ev); }}>Boeking verplaatsen</button>
                <div className="ctx-scheiding" />
                <button type="button" className="gevaar" onClick={() => { setCtxMenu(null); openDetail(ctxMenu.ev); }}>Boeking annuleren</button>
              </>
            )}

            {ctxMenu.soort === "vrij" && (
              <>
                <div className="ctx-kop">Room {ctxMenu.roomId} — vrij om {ctxMenu.start}</div>
                <button type="button" onClick={() => { const m = ctxMenu; setCtxMenu(null); openAddBookingVoor(m.dateISO, m.start); }}>Boeking toevoegen</button>
                <div className="ctx-scheiding" />
                <button type="button" onClick={() => ctxSluitRoom({ dateISO: ctxMenu.dateISO, start: ctxMenu.start, roomId: ctxMenu.roomId })}>
                  Room {ctxMenu.roomId} sluiten
                </button>
              </>
            )}

            {ctxMenu.soort === "gesloten" && (
              <>
                <div className="ctx-kop">Room {ctxMenu.roomId} — gesloten{ctxMenu.reden ? `: ${ctxMenu.reden}` : ""}</div>
                <button type="button" onClick={() => ctxHeropenRoom({ dateISO: ctxMenu.dateISO, start: ctxMenu.start, roomId: ctxMenu.roomId })}>
                  Room {ctxMenu.roomId} heropenen
                </button>
              </>
            )}

            {ctxMenu.soort === "tijdsblok" && (
              <>
                <div className="ctx-kop">{ctxMenu.ev.title || "Tijdsblok"} — {ctxMenu.ev.start}–{ctxMenu.ev.end}</div>
                <button type="button" onClick={() => { const ev = ctxMenu.ev; setCtxMenu(null); openEditTimeBlock(ev); }}>Tijdsblok aanpassen</button>
                <div className="ctx-scheiding" />
                <button type="button" className="gevaar" onClick={() => verwijderTijdsblok(ctxMenu.ev.sessionId)}>Tijdsblok verwijderen</button>
              </>
            )}

                        {ctxMenu.soort === "tijdslot" && (
              <>
                <div className="ctx-kop">
                  Tijdslot {ctxMenu.start} — {ctxMenu.vrijeRooms} vrij, {ctxMenu.geslotenRooms} gesloten
                </div>
                {/* Zijn alle rooms al bezet of gesloten, dan valt er niets meer te
                    sluiten en tonen we die knop niet. */}
                {ctxMenu.vrijeRooms > 0 && (
                  <button type="button" onClick={() => ctxSluitRoom({ dateISO: ctxMenu.dateISO, start: ctxMenu.start, allRooms: true })}>
                    Dit tijdslot sluiten ({ctxMenu.vrijeRooms} vrije room{ctxMenu.vrijeRooms === 1 ? "" : "s"})
                  </button>
                )}
                {ctxMenu.geslotenRooms > 0 && (
                  <button type="button" onClick={() => ctxHeropenRoom({ dateISO: ctxMenu.dateISO, start: ctxMenu.start, allRooms: true })}>
                    Dit tijdslot heropenen ({ctxMenu.geslotenRooms} gesloten)
                  </button>
                )}
                {ctxMenu.vrijeRooms === 0 && ctxMenu.geslotenRooms === 0 && (
                  <div className="ctx-leeg">Alle rooms zijn geboekt — er valt niets te sluiten.</div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {rescheduleTarget && (
        <div className="modal-backdrop" onClick={() => setRescheduleTarget(null)}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submitReschedule}>
            <h3>Boeking verplaatsen</h3>
            <p style={{ fontSize: 13, color: "var(--admin-text-muted)" }}>
              {rescheduleTarget.customer} — {serviceLabel(rescheduleTarget.service)}, {rescheduleTarget.partySize}p.
              Huidig tijdstip: {rescheduleTarget.dateISO} om {rescheduleTarget.start}.
            </p>
            <label className="field-label">Nieuwe datum</label>
            <input required type="date" value={rescheduleDateISO} onChange={e => setRescheduleDateISO(e.target.value)} />

            <label className="field-label">
              Bestaande tijdsloten op deze dag
              {rescheduleLoadingSlots && <span style={{ fontWeight: 400 }}> — laden…</span>}
            </label>
            {!rescheduleLoadingSlots && rescheduleSlots.length === 0 && (
              <p style={{ fontSize: 12, color: "var(--admin-text-muted)", margin: "2px 0 0" }}>
                Geen sessies gepland op deze dag. Vul hieronder zelf een uur in.
              </p>
            )}
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 4 }}>
              {rescheduleSlots.map(sl => (
                <button
                  key={sl.start} type="button"
                  className={`slot-knop${rescheduleStart === sl.start ? " actief" : ""}`}
                  disabled={!sl.bookable}
                  title={sl.bookable ? "" : `Geen room vrij voor ${rescheduleTarget.partySize} personen`}
                  onClick={() => setRescheduleStart(sl.start)}
                >
                  {sl.start}
                </button>
              ))}
            </div>

            <label className="field-label">Of een ander uur</label>
            <input required type="time" value={rescheduleStart} onChange={e => setRescheduleStart(e.target.value)} />
            <p style={{ fontSize: 12, color: "var(--admin-text-muted)" }}>
              Klant, groepsgrootte, prijs en betaalstatus blijven ongewijzigd — enkel het tijdslot verandert.
              De room wordt opnieuw gekozen: de kleinste vrije die past.
              <br />
              Staat er nog geen sessie op het uur dat je invult, dan wordt die eenmalig aangemaakt. Het vaste
              uurrooster verandert daar niet door.
            </p>
            {rescheduleError && <p className="error-text">{rescheduleError}</p>}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button type="button" onClick={() => setRescheduleTarget(null)}>Annuleren</button>
              <button type="submit" className="add-btn" disabled={rescheduleSubmitting}>
                {rescheduleSubmitting ? "Bezig…" : "Verplaatsen"}
              </button>
            </div>
          </form>
        </div>
      )}

      {showImport && (
        <div className="modal-backdrop" onClick={() => setShowImport(false)}>
          <div className="modal" style={{ width: 460 }} onClick={e => e.stopPropagation()}>
            <h3>Boekingen importeren (CSV)</h3>
            <p style={{ fontSize: 13, color: "var(--admin-text-muted)" }}>
              Voor een boekingslijst uit Wix Bookings (CSV-export). Blokkeert de betrokken tijdsloten
              hier zodat er niet dubbel geboekt kan worden via de widget, en zet de klanten in de
              database. Geannuleerde Wix-boekingen worden overgeslagen. Groepsgrootte bij Art Attack
              Room staat vast op 2 (het echte aantal staat niet betrouwbaar in de export) — pas dit
              nadien manueel aan per boeking indien nodig. Tijdsloten buiten het vaste uurrooster
              worden overgeslagen en hieronder gemeld. Je mag hetzelfde bestand gerust meermaals
              uploaden — bestaande boekingen worden niet dubbel aangemaakt.
            </p>
            <input type="file" accept=".csv" onChange={handleImportFile} />
            {importFileName && <p style={{ fontSize: 12, color: "var(--admin-text-muted)" }}>Gekozen: {importFileName}</p>}
            {importError && <p className="error-text">{importError}</p>}

            {importResult && (
              <div style={{ marginTop: 12, fontSize: 13 }}>
                <p style={{ fontWeight: 700 }}>
                  {(importResult.results.imported || 0) + (importResult.results.imported_new_session || 0)} geïmporteerd van {importResult.totalRows} rijen.
                  {importResult.results.imported_new_session > 0 && (
                    <> Daarvan stonden er {importResult.results.imported_new_session} op een uur dat niet in het
                      vaste uurrooster staat; voor die boekingen is een eenmalige sessie aangemaakt (zie hieronder).</>
                  )}
                </p>
                <p style={{ color: "var(--admin-text-muted)" }}>
                  {importResult.results.duplicate || 0} al bestaand (overgeslagen) ·{" "}
                  {importResult.results.imported_new_session || 0} met een nieuw aangemaakt tijdslot ·{" "}
                  {importResult.results.no_session || 0} zonder sessie ·{" "}
                  {importResult.results.full || 0} tijdslot volzet ·{" "}
                  {importResult.results.error || 0} fout
                  {importResult.parseErrors.length > 0 && <> · {importResult.parseErrors.length} onleesbare rij(en)</>}
                </p>
                {(importResult.details.length > 0 || importResult.parseErrors.length > 0) && (
                  <div className="finder-results" style={{ maxHeight: 220 }}>
                    {importResult.details.map((d, i) => (
                      <div key={i} className="finder-row" style={{ cursor: "default" }}>
                        <span className="finder-row-main">{d.customer} — {d.dateISO} {d.start}</span>
                        <span className="finder-row-sub">{d.status}: {d.message}</span>
                      </div>
                    ))}
                    {importResult.parseErrors.map((e, i) => (
                      <div key={`p${i}`} className="finder-row" style={{ cursor: "default" }}>
                        <span className="finder-row-main">Regel {e.line}</span>
                        <span className="finder-row-sub">{e.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button type="button" onClick={() => setShowImport(false)}>Sluiten</button>
              <button type="button" className="add-btn" disabled={importSubmitting || !importText} onClick={submitImport}>
                {importSubmitting ? "Bezig…" : "Importeren"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showStaffShift && (
        <div className="modal-backdrop" onClick={closeStaffShift}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submitStaffShift}>
            <h3>{staffForm.id ? "Werkuren bewerken" : "Werkuren toevoegen"}</h3>
            <label className="field-label">Datum</label>
            <input required type="date" value={staffForm.dateISO}
              onChange={e => setStaffForm({ ...staffForm, dateISO: e.target.value })} />
            <label className="field-label">Naam medewerker</label>
            <input required placeholder="Naam" value={staffForm.staffName}
              onChange={e => setStaffForm({ ...staffForm, staffName: e.target.value })} />
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label className="field-label">Van</label>
                <input required type="time" value={staffForm.start}
                  onChange={e => setStaffForm({ ...staffForm, start: e.target.value })} />
              </div>
              <div style={{ flex: 1 }}>
                <label className="field-label">Tot</label>
                <input required type="time" value={staffForm.end}
                  onChange={e => setStaffForm({ ...staffForm, end: e.target.value })} />
              </div>
            </div>
            <input placeholder="Notitie (optioneel)" value={staffForm.note}
              onChange={e => setStaffForm({ ...staffForm, note: e.target.value })} />

            {staffError && <p className="error-text">{staffError}</p>}

            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <button type="button" onClick={closeStaffShift}>Annuleren</button>
              {staffForm.id && (
                <button type="button" className="add-btn" style={{ background: "#B33A2E" }} disabled={staffSubmitting} onClick={deleteStaffShiftHandler}>
                  Verwijderen
                </button>
              )}
              <button type="submit" className="add-btn" disabled={staffSubmitting}>
                {staffSubmitting ? "Bezig…" : staffForm.id ? "Opslaan" : "Toevoegen"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

const css = `
  .theme-switch { position: relative; display: inline-block; width: 38px; height: 21px; vertical-align: middle; }
  .theme-switch input { opacity: 0; width: 0; height: 0; position: absolute; }
  .theme-switch-track { position: absolute; inset: 0; background: var(--admin-line); border-radius: 999px; transition: background 0.15s; cursor: pointer; }
  .theme-switch-track::before { content: ""; position: absolute; width: 15px; height: 15px; left: 3px; top: 3px; background: var(--admin-surface); border-radius: 50%; transition: transform 0.15s; box-shadow: 0 1px 2px rgba(0,0,0,0.3); }
  .theme-switch input:checked ~ .theme-switch-track { background: var(--admin-accent); }
  .theme-switch input:checked ~ .theme-switch-track::before { transform: translateX(17px); }
  .role-btn { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--admin-line); background: var(--admin-surface); }
  .role-btn.active { background: var(--admin-accent); color: #fff; border-color: var(--admin-accent); }
  .nav-btn { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--admin-line); background: var(--admin-surface); color: var(--admin-text); }
  .add-btn { padding: 8px 14px; border-radius: 8px; border: none; background: var(--admin-accent); color: #fff; font-weight: 700; }
  .add-btn.secondary { background: var(--admin-surface); color: var(--admin-accent); border: 1px solid var(--admin-accent); }
  .add-btn:disabled { opacity: 0.5; }
  .agenda-layout { display: flex; }
  .sidebar { width: 216px; flex-shrink: 0; padding: 18px 16px; border-right: 1px solid var(--admin-line); }
  .mini-cal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .mini-cal-title { font-weight: 700; font-size: 14px; }
  .mini-nav-btn { width: 26px; height: 26px; border-radius: 6px; border: 1px solid var(--admin-line); background: var(--admin-surface); color: var(--admin-text); font-size: 14px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; }
  .mini-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
  .mini-cal-dow { text-align: center; font-size: 10px; color: var(--admin-text-muted); padding: 4px 0; }
  .mini-cal-day { aspect-ratio: 1; display: flex; align-items: center; justify-content: center; border-radius: 50%; border: none; background: transparent; font-size: 12px; color: var(--admin-text); padding: 0; }
  .mini-cal-day:hover { background: var(--admin-hover); }
  .mini-cal-day.outside { color: #C7C2B6; }
  /* De markering van de getoonde week is een lichte vulling. In het donkere
     thema bleef de tekstkleur wit staan, waardoor die getallen onleesbaar
     werden. De tekstkleur wordt hier daarom expliciet donker gezet — die
     vulling is licht in beide thema's. */
  .mini-cal-day.in-week { background: #FBE9E1; color: #2A1B14; }
  .mini-cal-day.outside.in-week { color: #8A8375; }
  .mini-cal-day.today { background: var(--admin-accent); color: #fff; font-weight: 700; }
  .week-body { display: flex; padding: 0 20px 40px; gap: 0; }
  /* padding-top wordt na het renderen gemeten en als inline-stijl gezet, zie
     de useLayoutEffect hierboven. De 34px hier is enkel de waarde vóór de
     eerste meting, zodat er geen zichtbare sprong is. */
  .week-time-col { width: 56px; padding-top: 34px; }
  .hour-label { height: ${HOUR_PX}px; font-size: 11px; color: var(--admin-text-muted); }
  .week-days { display: grid; grid-template-columns: repeat(7, 1fr); flex: 1; gap: 6px; }
  .week-day-col { border: 1px solid var(--admin-line); border-radius: 10px; overflow: hidden; background: var(--admin-surface); }
  .week-day-head { text-align: center; font-size: 12px; font-weight: 700; padding: 8px 0; border-bottom: 1px solid var(--admin-line); }
  .staff-row { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 6px; border-bottom: 1px solid var(--admin-line); background: var(--admin-subtle); }
  .staff-chip { padding: 2px 7px; border-radius: 999px; border: 1px solid var(--admin-accent); background: var(--admin-surface); color: var(--admin-accent); font-size: 10px; line-height: 1.6; white-space: nowrap; }
  .staff-chip-time { opacity: 0.75; }
  .staff-chip.add { border-style: dashed; color: var(--admin-text-muted); border-color: var(--admin-line); font-weight: 700; padding: 2px 8px; }
  .staff-chip.add:hover { background: var(--admin-hover); }
  .week-day-body { position: relative; background-image: repeating-linear-gradient(to bottom, var(--admin-line) 0, var(--admin-line) 1px, transparent 1px, transparent ${HOUR_PX}px); }
  .cal-event { position: absolute; border-radius: 6px; padding: 4px 6px; font-size: 11px; overflow: hidden; box-sizing: border-box; }
  .cal-event-label { font-weight: 700; }
  .cal-event-sub { opacity: 0.8; }
  /* Aantal personen: een eigen regel met een pill, bewust NIET absoluut
     gepositioneerd rechtsboven. In de weekweergave staan de vier rooms naast
     elkaar in één dagkolom, dus een cel is maar ~35px breed — een badge in de
     hoek zou daar bovenop de klantnaam vallen. Op een eigen regel blijft het
     leesbaar, hoe smal de cel ook is. */
  .detail-block { border: 1px solid var(--admin-line); border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; background: var(--admin-subtle); }
  .cal-event-count { display: inline-block; font-size: 11px; font-weight: 700; line-height: 1.45;
    padding: 0 5px; border-radius: 999px; background: rgba(0,0,0,0.10); color: #000; margin: 1px 0; }
  [data-theme="dark"] .cal-event-count { background: rgba(0,0,0,0.18); color: #000; }
  /* Deze vier achtergronden zijn LICHT in beide thema's, dus de tekstkleur moet
     hier expliciet donker staan. Stond die er niet, dan erfde de cel de
     tekstkleur van het thema — bijna wit in het donkere thema — en werd de
     klantnaam en de roomcode onleesbaar op de crème achtergrond. Enkel het
     personen-badge bleef zichtbaar omdat dat zijn eigen zwarte kleur heeft. */
  .cal-event.attack { background: #FBE9E1; color: #2A1B14; border-left: 3px solid var(--admin-accent); }
  .cal-event.fluid { background: var(--fluid-bg); color: #14213A; border-left: 3px solid var(--fluid); }
  .cal-event.private-visible { background: repeating-linear-gradient(45deg, #FBE9E1, #FBE9E1 6px, #F3DCCF 6px, #F3DCCF 12px); color: #2A1B14; }
  .cal-event.personal { background: var(--private-bg); color: #2B2A26; border-left: 3px solid #6E6A5F; font-style: italic; }
  .cal-event.private { background: var(--private-bg); color: #2B2A26; border-left: 3px solid #6E6A5F; }
  /* Eigen tijdsblok — paars (Robin, aug 2026). Net als bij de blokken
     hierboven staat de tekstkleur er expliciet bij: zonder die regel erft het
     blok de bijna-witte tekstkleur van het donkere thema en valt de titel weg
     op de lichte paarse achtergrond. Contrast van #FFFFFF-achtige lila
     (#EDE6F7) met #2E1B4D is ongeveer 12:1, ruim boven de 4,5:1 die leesbaar
     heet. */
  .cal-event.tijdsblok { background: #EDE6F7; color: #2E1B4D; border-left: 3px solid #6B3FA0; }
  .cal-event.pending-reservation { border: 1px dashed var(--admin-text-muted); border-left-width: 3px; opacity: 0.85; }
  .cal-event.clickable { cursor: pointer; }
  .cal-event.clickable:hover { outline: 2px solid var(--admin-accent); outline-offset: 1px; }
  .menu-backdrop { position: fixed; inset: 0; z-index: 20; background: transparent; }
  .actions-menu { position: absolute; top: 40px; right: 0; z-index: 21; background: var(--admin-surface); border: 1px solid var(--admin-line); border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,0.12); padding: 6px; display: flex; flex-direction: column; min-width: 200px; }
  .actions-menu button, .actions-menu a { display: block; text-align: left; padding: 8px 10px; border: none; background: none; border-radius: 6px; font-size: 13px; color: var(--admin-text); text-decoration: none; cursor: pointer; }
  .actions-menu button:hover, .actions-menu a:hover { background: var(--admin-hover); }
  .actions-menu-divider { height: 1px; background: var(--admin-line); margin: 4px 2px; }
  .finder-results { max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
  .finder-row { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; text-align: left; padding: 8px 10px; border: 1px solid var(--admin-line); border-radius: 8px; background: var(--admin-surface); }
  .finder-row-main { font-size: 13px; font-weight: 700; }
  .finder-row-sub { font-size: 11px; color: var(--admin-text-muted); }
  .cal-room-cell { position: absolute; border-radius: 6px; padding: 4px 6px; font-size: 10px; overflow: hidden; box-sizing: border-box; border: 1px solid var(--admin-line); }
  /* Vrije cellen bewust discreet: ze zijn in de meerderheid en trokken evenveel
     aandacht als een echte boeking. Alleen de roomcode blijft goed leesbaar,
     zodat elke room zijn herkenbare vaste plaats houdt. */
  .cal-room-cell.free { background: transparent; border-style: dashed; opacity: 0.5; }
  .cal-room-cell.free .cal-room-sub { font-size: 9px; }
  .cal-room-cell.closed { background: repeating-linear-gradient(45deg, #EDEAE2, #EDEAE2 5px, #E1DCD0 5px, #E1DCD0 10px); color: #8A8375; }
  .cal-room-label { font-weight: 700; }
  .cal-room-sub { opacity: 0.75; }
  /* Geboekte roomcel: code bovenaan op een vaste plaats, dan de (afgekorte)
     naam, dan het aantal personen. */
  .slot-knop { padding: 7px 12px; border-radius: 8px; border: 1px solid var(--admin-line);
    background: var(--admin-surface); color: var(--admin-text); font: inherit; font-size: 13px; cursor: pointer; }
  .slot-knop:hover:not(:disabled) { border-color: var(--admin-accent); }
  .slot-knop.actief { background: var(--admin-accent); border-color: var(--admin-accent); color: #fff; font-weight: 700; }
  .slot-knop:disabled { border-style: dashed; color: var(--admin-text-muted); opacity: 0.5; cursor: not-allowed; }
  .ctx-menu { position: fixed; z-index: 30; min-width: 226px; background: var(--admin-surface);
    border: 1px solid var(--admin-line); border-radius: 10px; padding: 5px;
    box-shadow: 0 12px 34px rgba(0,0,0,0.28); }
  .ctx-kop { font-size: 10.5px; color: var(--admin-text-muted); padding: 5px 9px 6px;
    border-bottom: 1px solid var(--admin-line); margin-bottom: 4px; }
  .ctx-menu button { display: block; width: 100%; text-align: left; background: none; border: none;
    color: var(--admin-text); font: inherit; font-size: 12.5px; padding: 7px 9px; border-radius: 6px; cursor: pointer; }
  .ctx-menu button:hover { background: var(--admin-hover); }
  .ctx-menu button.gevaar { color: #B33A2E; }
  .ctx-scheiding { height: 1px; background: var(--admin-line); margin: 4px 2px; }
  .ctx-leeg { font-size: 12px; color: var(--admin-text-muted); padding: 6px 9px; }
  .cal-slot-tag { position: absolute; font-size: 9.5px; font-weight: 700; color: var(--admin-text-muted);
    letter-spacing: 0.03em; line-height: 14px; padding: 0 4px; border-radius: 4px; cursor: context-menu;
    user-select: none; }
  .cal-slot-tag:hover { background: var(--admin-hover); color: var(--admin-text); }
  .cal-room-booked { display: flex; flex-direction: column; gap: 1px; padding: 3px 4px; }
  .cal-room-code { font-size: 9.5px; font-weight: 700; opacity: 0.8; line-height: 1.2; letter-spacing: 0.04em; }
  /* De naam mag over meerdere regels: een roomcel is maar ~35px breed maar wel
     ~90px hoog. "Els P." over twee regels leest nog altijd beter dan "E…" op
     één regel. overflow-wrap breekt desnoods binnen een lang woord af. */
  .cal-room-booked .cal-event-label { font-size: 10.5px; line-height: 1.2; white-space: normal;
    overflow-wrap: break-word; }
  .cal-room-booked .cal-event-count { align-self: flex-start; font-size: 10px; padding: 0 4px; margin-top: 1px; }
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; overflow-y: auto; padding: 24px 0; }
  .modal { background: var(--admin-surface); color: var(--admin-text); padding: 20px; border-radius: 12px; width: 340px; max-height: 90vh; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
  .modal input, .modal select, .modal textarea { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--admin-line); background: var(--admin-surface); color: var(--admin-text); font-family: inherit; width: 100%; box-sizing: border-box; }
  .field-label { font-size: 12px; color: var(--admin-text-muted); margin-top: 4px; }
  .muted-text { font-size: 12px; color: var(--admin-text-muted); margin: 4px 0; }
  .error-text { color: #C0392B; font-size: 13px; }
  .checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 14px; }
  .checkbox-row input { width: auto; }
  .slot-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  .slot-chip { padding: 6px 10px; border-radius: 8px; border: 1px solid var(--admin-line); background: var(--admin-surface); color: var(--admin-text); font-size: 13px; width: auto; }
  .slot-chip.selected { background: var(--admin-accent); color: #fff; border-color: var(--admin-accent); }
  .slot-chip.disabled { opacity: 0.4; }
  .gift-card-list { display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow-y: auto; margin-top: 6px; }
  .gift-card-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border: 1px solid var(--admin-line); border-radius: 8px; }
  .gift-card-status { font-size: 11px; padding: 3px 8px; border-radius: 999px; white-space: nowrap; }
  .gift-card-status.active { background: #E4F2E1; color: #2F7A3D; }
  .gift-card-status.disabled { background: #F1EEE7; color: #7C7668; }
  .gift-card-status.depleted { background: #FBE9E1; color: var(--admin-accent); }
`;
