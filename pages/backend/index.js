import { useEffect, useMemo, useState } from "react";

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
// overlappen (bv. 3 boekingen van Art Attack Room, elk in een andere room,
// exact op hetzelfde tijdstip) netjes naast elkaar komen te staan i.p.v.
// volledig over elkaar heen (wat voorheen gebeurde — enkel het laatste event
// in de lijst was dan nog zichtbaar/klikbaar). Standaard greedy
// interval-graph-coloring, zoals de meeste kalender-UI's dat doen.
function layoutDayEvents(dayEvents) {
  const items = dayEvents.map(ev => {
    const startMin = timeToMinutes(ev.start);
    const endMin = ev.kind === "personal" ? timeToMinutes(ev.end) : startMin + (ev.durationMin || 90);
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

// Bouwt de vaste room-kolommen (A/M/VL/VR) voor Art Attack Room-tijdsloten op
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

  const cells = [];
  for (const slot of slotMap.values()) {
    const startMin = timeToMinutes(slot.start);
    const top = ((startMin / 60) - HOUR_START) * HOUR_PX;
    const height = (slot.durationMin / 60) * HOUR_PX;

    roomOrder.forEach((room, idx) => {
      const left = `calc(${(idx / roomOrder.length) * 100}% + 2px)`;
      const width = `calc(${100 / roomOrder.length}% - 4px)`;
      const booking = roomEvents.find(e => e.start === slot.start && e.roomCode === room.id);
      const closed = closedEvents.find(e => e.start === slot.start && e.roomCode === room.id);
      if (booking) {
        cells.push({ key: `${slot.start}-${room.id}`, kind: "booking", top, height, left, width, ev: booking, roomLabel: room.label });
      } else if (closed) {
        cells.push({ key: `${slot.start}-${room.id}`, kind: "closed", top, height, left, width, ev: closed, roomLabel: room.label });
      } else {
        cells.push({ key: `${slot.start}-${room.id}`, kind: "free", top, height, left, width, roomLabel: room.label });
      }
    });
  }
  return cells;
}

function serviceLabel(code) {
  if (code === "fluid_art") return "Fluid Art";
  if (code === "art_attack_room") return "Art Attack Room";
  return code;
}

const EMPTY_MANUAL_FORM = {
  serviceCode: "", dateISO: "", start: "", partySize: 2,
  name: "", email: "", phone: "", birthDate: "", note: "",
  paymentMethod: "cash", invoiceRequested: false, vatNumber: "", companyName: "",
  giftCardCode: "", reserveOnly: false
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

  const [monday, setMonday] = useState(() => mondayOf(toISO(new Date())));
  const [events, setEvents] = useState([]);
  const [pickerYear, setPickerYear] = useState(() => new Date().getFullYear());
  const [pickerMonth, setPickerMonth] = useState(() => new Date().getMonth());
  const [loading, setLoading] = useState(true);
  const [showAddPersonal, setShowAddPersonal] = useState(false);
  const [personalForm, setPersonalForm] = useState({ title: "", dateISO: "", start: "", end: "" });

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
  const [confirmPaymentMethod, setConfirmPaymentMethod] = useState("cash");
  const [confirmError, setConfirmError] = useState("");
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);

  const [detailTarget, setDetailTarget] = useState(null); // ev met bookingId, voor annuleren
  const [detailError, setDetailError] = useState("");
  const [detailSubmitting, setDetailSubmitting] = useState(false);
  const [cancelRefundAmount, setCancelRefundAmount] = useState("");
  const [cancelReason, setCancelReason] = useState("");

  const [showActionsMenu, setShowActionsMenu] = useState(false);

  const [rescheduleTarget, setRescheduleTarget] = useState(null);
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

  // --- Manuele boeking ---

  function openAddBooking() {
    setManualForm({ ...EMPTY_MANUAL_FORM, serviceCode: services[0]?.code || "" });
    setManualSlots([]);
    setManualError("");
    setShowAddBooking(true);
  }

  function fetchManualSlots(serviceCode, dateISO, partySize) {
    if (!serviceCode || !dateISO) { setManualSlots([]); return; }
    setManualLoadingSlots(true);
    fetch(`/api/availability?service=${serviceCode}&date=${dateISO}&partySize=${partySize || 1}`)
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
            name: manualForm.name, email: manualForm.email,
            phone: manualForm.phone, birthDate: manualForm.birthDate || null
          },
          note: manualForm.note,
          paymentMethod: manualForm.paymentMethod,
          invoiceRequested: manualForm.invoiceRequested,
          invoiceDetails: manualForm.invoiceRequested
            ? { vatNumber: manualForm.vatNumber, companyName: manualForm.companyName }
            : null,
          giftCardCode: manualForm.giftCardCode.trim() || null,
          reserveOnly: manualForm.reserveOnly
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
    fetch(`/api/availability?service=art_attack_room&date=${dateISO}`)
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
    setConfirmPaymentMethod("cash");
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
        body: JSON.stringify({ bookingId: confirmTarget.bookingId, paymentMethod: confirmPaymentMethod })
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

  function openDetail(ev) {
    setDetailTarget(ev);
    setDetailError("");
    // Standaard vooraf ingevuld met het volledige bedrag (volledige
    // terugbetaling) — de medewerker kan dit verlagen voor een
    // gedeeltelijke terugbetaling (bv. annuleringskost ingehouden).
    setCancelRefundAmount(ev.amount != null ? String(ev.amount) : "0");
    setCancelReason("");
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
  function openRescheduleFromDetail() {
    setRescheduleTarget(detailTarget);
    setRescheduleDateISO(detailTarget.dateISO);
    setRescheduleStart(detailTarget.start);
    setRescheduleError("");
    setDetailTarget(null);
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
  function handleEventClick(ev) {
    if (ev.pendingConfirmation) return openConfirmBooking(ev);
    if (ev.kind === "service" && ev.bookingId) return openDetail(ev);
  }

  function eventVisual(ev) {
    // ev.redacted komt van de server (/api/admin/sessions) — die stuurt voor
    // de gast-rol de echte titel/klant/notitie/bedrag van privé-items al
    // niet mee, dus hier is enkel nog een weergavekeuze nodig, geen echte
    // toegangscontrole meer.
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
    let sub = ev.customer ? `${serviceLabel(ev.service)} · ${ev.partySize}p` : `${ev.booked ?? 0}/${ev.capacity ?? "-"}`;
    if (ev.pendingConfirmation) sub += " · reservering";
    return { cls, label, sub };
  }

  if (authRole === null) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--admin-bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <style>{css}</style>
        <p style={{ color: "#7C7668" }}>Laden…</p>
      </div>
    );
  }

  if (authRole === "none") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--admin-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>
        <style>{css}</style>
        <form className="modal" style={{ width: 320 }} onSubmit={submitLogin}>
          <h3>Inloggen</h3>
          <p style={{ fontSize: 13, color: "#7C7668" }}>Toegang tot de backoffice-agenda.</p>
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
    <div style={{ minHeight: "100vh", background: "var(--admin-bg)", color: "#20221F", fontFamily: "inherit" }}>
      <style>{css}</style>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--admin-line)" }}>
        <h1 style={{ fontSize: 20, margin: 0, color: "var(--admin-accent)" }}>Agenda</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, color: "#7C7668" }}>
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
                    <button type="button" onClick={() => { setShowAddPersonal(true); setShowActionsMenu(false); }}>Persoonlijke afspraak</button>
                    <button type="button" onClick={() => { openAddExtra(); setShowActionsMenu(false); }}>Extra sessie</button>
                    {authRole === "admin" && (
                      <>
                        <div className="actions-menu-divider" />
                        <button type="button" onClick={openImport}>Boekingen importeren (CSV)</button>
                        <a
                          href={`/api/admin/week-export-pdf?week=${monday}`}
                          title="PDF met alle boekingen van deze week, om extern te bewaren"
                          onClick={() => setShowActionsMenu(false)}
                        >
                          Week exporteren (PDF)
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
            <div className="week-body">
              <div className="week-time-col">
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
                      <div className="staff-row">
                        {staffShifts.filter(s => s.dateISO === dISO).map(s => (
                          <button type="button" key={s.id} className="staff-chip" title={s.note || ""} onClick={() => openEditStaffShift(s)}>
                            {s.staffName} <span className="staff-chip-time">{s.start}–{s.end}</span>
                          </button>
                        ))}
                        <button type="button" className="staff-chip add" title="Werkuren toevoegen" onClick={() => openAddStaffShift(dISO)}>+</button>
                      </div>
                      <div className="week-day-body" style={{ height: (HOUR_END - HOUR_START) * HOUR_PX }}>
                        {roomCells.map(cell => {
                          if (cell.kind === "free") {
                            return (
                              <div key={cell.key} className="cal-room-cell free" style={{ top: cell.top, height: cell.height, left: cell.left, width: cell.width }}>
                                <div className="cal-room-label">{cell.roomLabel}</div>
                                <div className="cal-room-sub">Vrij</div>
                              </div>
                            );
                          }
                          if (cell.kind === "closed") {
                            return (
                              <div key={cell.key} className="cal-room-cell closed" style={{ top: cell.top, height: cell.height, left: cell.left, width: cell.width }} title={cell.ev.reason}>
                                <div className="cal-room-label">{cell.roomLabel}</div>
                                <div className="cal-room-sub">Niet beschikbaar</div>
                              </div>
                            );
                          }
                          const v = eventVisual(cell.ev);
                          return (
                            <div
                              key={cell.key}
                              className={`cal-event ${v.cls}${cell.ev.pendingConfirmation || cell.ev.bookingId ? " clickable" : ""}`}
                              style={{ top: cell.top, height: cell.height, left: cell.left, width: cell.width }}
                              onClick={() => handleEventClick(cell.ev)}
                              title={cell.ev.pendingConfirmation ? "Klik om deze reservering te bevestigen" : (cell.ev.bookingId ? "Klik voor details / annuleren" : undefined)}
                            >
                              <div className="cal-event-label">{v.label}</div>
                              {v.sub && <div className="cal-event-sub">{v.sub}</div>}
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
                              className={`cal-event ${v.cls}${ev.pendingConfirmation || ev.bookingId ? " clickable" : ""}`}
                              style={{
                                top,
                                height,
                                left: `calc(${(col / cols) * 100}% + 3px)`,
                                width: `calc(${100 / cols}% - 6px)`
                              }}
                              onClick={() => handleEventClick(ev)}
                              title={ev.pendingConfirmation ? "Klik om deze reservering te bevestigen" : (ev.bookingId ? "Klik voor details / annuleren" : undefined)}
                            >
                              <div className="cal-event-label">{v.label}</div>
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

      {showAddPersonal && (
        <div className="modal-backdrop" onClick={() => setShowAddPersonal(false)}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submitPersonal}>
            <h3>Persoonlijke afspraak</h3>
            <p style={{ fontSize: 13, color: "#7C7668" }}>
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
            <p style={{ fontSize: 13, color: "#7C7668" }}>
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
              </div>
            )}

            <input required placeholder="Naam klant" value={manualForm.name}
              onChange={e => setManualForm({ ...manualForm, name: e.target.value })} />
            <input required type="email" placeholder="E-mail" value={manualForm.email}
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

            <input placeholder="Cadeaubon-code (optioneel)" value={manualForm.giftCardCode}
              onChange={e => setManualForm({ ...manualForm, giftCardCode: e.target.value })} />

            <label className="checkbox-row">
              <input type="checkbox" checked={manualForm.reserveOnly}
                onChange={e => setManualForm({ ...manualForm, reserveOnly: e.target.checked })} />
              Enkel reserveren (nog niet bevestigd/betaald)
            </label>

            <label className="field-label">
              {manualForm.reserveOnly ? "Verwachte betaalwijze (later te bevestigen)" : "Betaalwijze"}
            </label>
            <select value={manualForm.paymentMethod} onChange={e => setManualForm({ ...manualForm, paymentMethod: e.target.value })}>
              <option value="cash">Cash</option>
              <option value="bank_transfer">Overschrijving</option>
              <option value="other">Andere</option>
            </select>

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
            <p style={{ fontSize: 13, color: "#7C7668" }}>
              Enkel van toepassing op Art Attack Room. Een room met een bestaande klantboeking
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
            <p style={{ fontSize: 13, color: "#7C7668" }}>
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
            <p style={{ fontSize: 13, color: "#7C7668" }}>
              {confirmTarget.customer} — {serviceLabel(confirmTarget.service)}, {confirmTarget.partySize}p,{" "}
              {confirmTarget.dateISO} om {confirmTarget.start}
              {confirmTarget.amount != null && <> — €{confirmTarget.amount.toFixed(2)} te betalen</>}.
              Dit registreert de boeking als definitief betaald (en maakt de factuur/cadeaubon-
              afschrijving alsnog in orde, indien van toepassing) — nog steeds zonder bevestigingsmail.
            </p>

            <label className="field-label">Betaalwijze</label>
            <select value={confirmPaymentMethod} onChange={e => setConfirmPaymentMethod(e.target.value)}>
              <option value="cash">Cash</option>
              <option value="bank_transfer">Overschrijving</option>
              <option value="other">Andere</option>
            </select>

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
            <p style={{ fontSize: 13, color: "#7C7668" }}>
              {detailTarget.customer} — {serviceLabel(detailTarget.service)}, {detailTarget.partySize}p
              {detailTarget.roomCode && <> — Room {detailTarget.roomCode}</>}
              <br />
              {detailTarget.dateISO} om {detailTarget.start}
              {detailTarget.amount != null && <> — €{detailTarget.amount.toFixed(2)}</>}
              {detailTarget.paymentStatus && <> ({detailTarget.paymentStatus === "paid" ? "betaald" : "nog niet betaald"})</>}
            </p>

            {authRole === "admin" ? (
              <>
                <p style={{ fontSize: 12, color: "#7C7668" }}>
                  Annuleren maakt de room terug vrij voor dit tijdslot. Vul hieronder in hoeveel je
                  terugbetaalt aan de klant — volledig, gedeeltelijk (bv. annuleringskost ingehouden)
                  of niets. Het behouden bedrag telt nog mee in de wekelijkse omzetfactuur.
                </p>
                {detailTarget.amount != null && (
                  <>
                    <label className="field-label">Terug te betalen bedrag (max €{detailTarget.amount.toFixed(2)})</label>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input
                        type="number" min="0" max={detailTarget.amount} step="0.01"
                        value={cancelRefundAmount}
                        onChange={e => setCancelRefundAmount(e.target.value)}
                        style={{ width: 100 }}
                      />
                      <button type="button" className="add-btn secondary" onClick={() => setCancelRefundAmount(String(detailTarget.amount))}>Volledig</button>
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

      {rescheduleTarget && (
        <div className="modal-backdrop" onClick={() => setRescheduleTarget(null)}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submitReschedule}>
            <h3>Boeking verplaatsen</h3>
            <p style={{ fontSize: 13, color: "#7C7668" }}>
              {rescheduleTarget.customer} — {serviceLabel(rescheduleTarget.service)}, {rescheduleTarget.partySize}p.
              Huidig tijdstip: {rescheduleTarget.dateISO} om {rescheduleTarget.start}.
            </p>
            <label className="field-label">Nieuwe datum</label>
            <input required type="date" value={rescheduleDateISO} onChange={e => setRescheduleDateISO(e.target.value)} />
            <label className="field-label">Nieuw tijdstip</label>
            <input required type="time" value={rescheduleStart} onChange={e => setRescheduleStart(e.target.value)} />
            <p style={{ fontSize: 12, color: "#7C7668" }}>
              Klant, groepsgrootte, prijs en betaalstatus blijven ongewijzigd — enkel het tijdslot verandert.
              Kan enkel naar een tijdstip waar effectief een sessie gepland staat.
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
            <p style={{ fontSize: 13, color: "#7C7668" }}>
              Voor een boekingslijst uit Wix Bookings (CSV-export). Blokkeert de betrokken tijdsloten
              hier zodat er niet dubbel geboekt kan worden via de widget, en zet de klanten in de
              database. Geannuleerde Wix-boekingen worden overgeslagen. Groepsgrootte bij Art Attack
              Room staat vast op 2 (het echte aantal staat niet betrouwbaar in de export) — pas dit
              nadien manueel aan per boeking indien nodig. Tijdsloten buiten het vaste uurrooster
              worden overgeslagen en hieronder gemeld. Je mag hetzelfde bestand gerust meermaals
              uploaden — bestaande boekingen worden niet dubbel aangemaakt.
            </p>
            <input type="file" accept=".csv" onChange={handleImportFile} />
            {importFileName && <p style={{ fontSize: 12, color: "#7C7668" }}>Gekozen: {importFileName}</p>}
            {importError && <p className="error-text">{importError}</p>}

            {importResult && (
              <div style={{ marginTop: 12, fontSize: 13 }}>
                <p style={{ fontWeight: 700 }}>
                  {importResult.results.imported || 0} geïmporteerd van {importResult.totalRows} rijen.
                </p>
                <p style={{ color: "#7C7668" }}>
                  {importResult.results.duplicate || 0} al bestaand (overgeslagen) ·{" "}
                  {importResult.results.no_session || 0} buiten uurrooster ·{" "}
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
  .role-btn { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--admin-line); background: #fff; }
  .role-btn.active { background: var(--admin-accent); color: #fff; border-color: var(--admin-accent); }
  .nav-btn { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--admin-line); background: #fff; }
  .add-btn { padding: 8px 14px; border-radius: 8px; border: none; background: var(--admin-accent); color: #fff; font-weight: 700; }
  .add-btn.secondary { background: #fff; color: var(--admin-accent); border: 1px solid var(--admin-accent); }
  .add-btn:disabled { opacity: 0.5; }
  .agenda-layout { display: flex; }
  .sidebar { width: 216px; flex-shrink: 0; padding: 18px 16px; border-right: 1px solid var(--admin-line); }
  .mini-cal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .mini-cal-title { font-weight: 700; font-size: 14px; }
  .mini-nav-btn { width: 26px; height: 26px; border-radius: 6px; border: 1px solid var(--admin-line); background: #fff; font-size: 14px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; }
  .mini-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
  .mini-cal-dow { text-align: center; font-size: 10px; color: #7C7668; padding: 4px 0; }
  .mini-cal-day { aspect-ratio: 1; display: flex; align-items: center; justify-content: center; border-radius: 50%; border: none; background: transparent; font-size: 12px; color: #20221F; padding: 0; }
  .mini-cal-day:hover { background: #F1EEE7; }
  .mini-cal-day.outside { color: #C7C2B6; }
  .mini-cal-day.in-week { background: #FBE9E1; }
  .mini-cal-day.today { background: var(--admin-accent); color: #fff; font-weight: 700; }
  .week-body { display: flex; padding: 0 20px 40px; gap: 0; }
  .week-time-col { width: 56px; padding-top: 34px; }
  .hour-label { height: ${HOUR_PX}px; font-size: 11px; color: #7C7668; }
  .week-days { display: grid; grid-template-columns: repeat(7, 1fr); flex: 1; gap: 6px; }
  .week-day-col { border: 1px solid var(--admin-line); border-radius: 10px; overflow: hidden; background: #fff; }
  .week-day-head { text-align: center; font-size: 12px; font-weight: 700; padding: 8px 0; border-bottom: 1px solid var(--admin-line); }
  .staff-row { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 6px; border-bottom: 1px solid var(--admin-line); background: #FAF8F4; }
  .staff-chip { padding: 2px 7px; border-radius: 999px; border: 1px solid var(--admin-accent); background: #fff; color: var(--admin-accent); font-size: 10px; line-height: 1.6; white-space: nowrap; }
  .staff-chip-time { opacity: 0.75; }
  .staff-chip.add { border-style: dashed; color: #7C7668; border-color: #C7C2B6; font-weight: 700; padding: 2px 8px; }
  .staff-chip.add:hover { background: #F1EEE7; }
  .week-day-body { position: relative; background-image: repeating-linear-gradient(to bottom, #F1EEE7 0, #F1EEE7 1px, transparent 1px, transparent ${HOUR_PX}px); }
  .cal-event { position: absolute; border-radius: 6px; padding: 4px 6px; font-size: 11px; overflow: hidden; box-sizing: border-box; }
  .cal-event-label { font-weight: 700; }
  .cal-event-sub { opacity: 0.8; }
  .cal-event.attack { background: #FBE9E1; border-left: 3px solid var(--admin-accent); }
  .cal-event.fluid { background: var(--fluid-bg); border-left: 3px solid var(--fluid); }
  .cal-event.private-visible { background: repeating-linear-gradient(45deg, #FBE9E1, #FBE9E1 6px, #F3DCCF 6px, #F3DCCF 12px); }
  .cal-event.personal { background: var(--private-bg); border-left: 3px solid #7C7668; font-style: italic; }
  .cal-event.private { background: var(--private-bg); border-left: 3px solid #7C7668; }
  .cal-event.pending-reservation { border: 1px dashed #7C7668; border-left-width: 3px; opacity: 0.85; }
  .cal-event.clickable { cursor: pointer; }
  .cal-event.clickable:hover { outline: 2px solid var(--admin-accent); outline-offset: 1px; }
  .menu-backdrop { position: fixed; inset: 0; z-index: 20; background: transparent; }
  .actions-menu { position: absolute; top: 40px; right: 0; z-index: 21; background: #fff; border: 1px solid var(--admin-line); border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,0.12); padding: 6px; display: flex; flex-direction: column; min-width: 200px; }
  .actions-menu button, .actions-menu a { display: block; text-align: left; padding: 8px 10px; border: none; background: none; border-radius: 6px; font-size: 13px; color: #20221F; text-decoration: none; cursor: pointer; }
  .actions-menu button:hover, .actions-menu a:hover { background: #F1EEE7; }
  .actions-menu-divider { height: 1px; background: var(--admin-line); margin: 4px 2px; }
  .finder-results { max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
  .finder-row { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; text-align: left; padding: 8px 10px; border: 1px solid var(--admin-line); border-radius: 8px; background: #fff; }
  .finder-row-main { font-size: 13px; font-weight: 700; }
  .finder-row-sub { font-size: 11px; color: #7C7668; }
  .cal-room-cell { position: absolute; border-radius: 6px; padding: 4px 6px; font-size: 10px; overflow: hidden; box-sizing: border-box; border: 1px solid var(--admin-line); }
  .cal-room-cell.free { background: #fff; }
  .cal-room-cell.closed { background: repeating-linear-gradient(45deg, #EDEAE2, #EDEAE2 5px, #E1DCD0 5px, #E1DCD0 10px); color: #8A8375; }
  .cal-room-label { font-weight: 700; }
  .cal-room-sub { opacity: 0.75; }
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; overflow-y: auto; padding: 24px 0; }
  .modal { background: #fff; padding: 20px; border-radius: 12px; width: 340px; max-height: 90vh; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
  .modal input, .modal select, .modal textarea { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--admin-line); font-family: inherit; width: 100%; box-sizing: border-box; }
  .field-label { font-size: 12px; color: #7C7668; margin-top: 4px; }
  .muted-text { font-size: 12px; color: #7C7668; margin: 4px 0; }
  .error-text { color: #C0392B; font-size: 13px; }
  .checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 14px; }
  .checkbox-row input { width: auto; }
  .slot-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  .slot-chip { padding: 6px 10px; border-radius: 8px; border: 1px solid var(--admin-line); background: #fff; font-size: 13px; width: auto; }
  .slot-chip.selected { background: var(--admin-accent); color: #fff; border-color: var(--admin-accent); }
  .slot-chip.disabled { opacity: 0.4; }
  .gift-card-list { display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow-y: auto; margin-top: 6px; }
  .gift-card-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border: 1px solid var(--admin-line); border-radius: 8px; }
  .gift-card-status { font-size: 11px; padding: 3px 8px; border-radius: 999px; white-space: nowrap; }
  .gift-card-status.active { background: #E4F2E1; color: #2F7A3D; }
  .gift-card-status.disabled { background: #F1EEE7; color: #7C7668; }
  .gift-card-status.depleted { background: #FBE9E1; color: var(--admin-accent); }
`;
