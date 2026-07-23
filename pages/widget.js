import { useEffect, useMemo, useState } from "react";

const MONTHS_NL = [
  "januari", "februari", "maart", "april", "mei", "juni",
  "juli", "augustus", "september", "oktober", "november", "december"
];
const WEEKDAYS_NL = ["Ma", "Di", "Wo", "Do", "Vr", "Za", "Zo"];

// Bewust GEEN toISOString() — dat rekent om naar UTC en verschuift de datum
// met een dag t.o.v. de lokale (Europe/Brussels) kalenderdatum.
function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfMonth(year, month) {
  return new Date(year, month, 1);
}

// Maandag-gebaseerde kalendergrid (zoals het HTML-prototype).
function buildMonthGrid(year, month) {
  const first = startOfMonth(year, month);
  const firstWeekday = (first.getDay() + 6) % 7; // 0=ma
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(new Date(year, month, day));
  return cells;
}

export default function Widget() {
  const today = useMemo(() => new Date(), []);
  const maxDate = useMemo(() => {
    const d = new Date(today);
    d.setMonth(d.getMonth() + 3);
    return d;
  }, [today]);

  const [services, setServices] = useState([]);
  const [serviceCode, setServiceCode] = useState("art_attack_room");
  const [partySize, setPartySize] = useState(2);
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState(null);
  const [slots, setSlots] = useState([]);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [loadingSlots, setLoadingSlots] = useState(false);

  const [form, setForm] = useState({
    name: "", email: "", phone: "", birthDate: "", note: "",
    termsAccepted: false, marketingOptIn: true,
    invoiceRequested: false, vatNumber: "", companyName: ""
  });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/services").then(r => r.json()).then(d => setServices(d.services || []));
  }, []);

  const currentService = services.find(s => s.code === serviceCode);

  useEffect(() => {
    if (!currentService) return;
    const min = currentService.minOnlinePartySize ?? 1;
    const max = currentService.maxOnlinePartySize ?? 7;
    if (partySize < min) setPartySize(min);
    if (partySize > max) setPartySize(max);
  }, [currentService]); // eslint-disable-line react-hooks/exhaustive-deps

  const price = useMemo(() => {
    if (!currentService) return null;
    if (currentService.pricingType === "party_tier") return currentService.pricingTable[partySize] ?? null;
    if (currentService.pricingType === "per_person") return currentService.pricePerPerson * partySize;
    return null;
  }, [currentService, partySize]);

  function selectDate(date) {
    setSelectedDate(date);
    setSelectedSlot(null);
    setLoadingSlots(true);
    const iso = toISO(date);
    fetch(`/api/availability?service=${serviceCode}&date=${iso}&partySize=${partySize}`)
      .then(r => r.json())
      .then(d => setSlots(d.slots || []))
      .finally(() => setLoadingSlots(false));
  }

  async function submitBooking(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceCode,
          dateISO: toISO(selectedDate),
          start: selectedSlot,
          partySize,
          customer: { name: form.name, email: form.email, phone: form.phone, birthDate: form.birthDate },
          note: form.note,
          termsAccepted: form.termsAccepted,
          marketingOptIn: form.marketingOptIn,
          invoiceRequested: form.invoiceRequested,
          invoiceDetails: form.invoiceRequested ? { vatNumber: form.vatNumber, companyName: form.companyName } : null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Er ging iets mis.");
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const grid = buildMonthGrid(viewYear, viewMonth);
  const monthLabel = `${MONTHS_NL[viewMonth]} ${viewYear}`;

  function shiftMonth(n) {
    let m = viewMonth + n;
    let y = viewYear;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setViewMonth(m);
    setViewYear(y);
  }

  function isDateDisabled(date) {
    const d0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return date < d0 || date > maxDate;
  }

  if (result) {
    return (
      <div style={styles.wrap}>
        <div style={styles.card}>
          <h2 style={{ color: "var(--accent)" }}>Bijna klaar!</h2>
          <p>Je reservatie is aangemaakt. Rond de betaling af om ze te bevestigen.</p>
          <p style={{ fontWeight: 700 }}>Te betalen: €{result.amountDue.toFixed(2)}</p>
          {result.mocked && (
            <p style={{ color: "var(--muted)", fontSize: 13 }}>
              (Dev-modus: er is geen echte Mollie-key ingesteld, dit is een mock-checkout-link.)
            </p>
          )}
          <a href={result.checkoutUrl} style={styles.primaryBtn}>Naar betaling</a>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <h1 style={styles.h1}>Boek je workshop</h1>

        <div style={styles.tabs}>
          {services.map(s => (
            <button
              key={s.code}
              onClick={() => { setServiceCode(s.code); setSelectedDate(null); setSelectedSlot(null); }}
              style={{ ...styles.tab, ...(serviceCode === s.code ? styles.tabActive : {}) }}
            >
              {s.label}
            </button>
          ))}
        </div>

        {currentService && (
          <>
            <div style={styles.row}>
              <span style={styles.label}>Aantal personen</span>
              <div style={styles.stepper}>
                <button
                  style={styles.stepBtn}
                  onClick={() => setPartySize(Math.max(currentService.minOnlinePartySize, partySize - 1))}
                >−</button>
                <span style={{ minWidth: 24, textAlign: "center" }}>{partySize}</span>
                <button
                  style={styles.stepBtn}
                  onClick={() => setPartySize(Math.min(currentService.maxOnlinePartySize, partySize + 1))}
                >+</button>
              </div>
              {price !== null && <span style={styles.price}>€{price}</span>}
            </div>
            {serviceCode === "art_attack_room" && (
              <p style={styles.note}>
                Groepen groter dan 7? Mail naar{" "}
                <a href="mailto:artattackroom@gmail.com" style={{ color: "var(--accent)" }}>artattackroom@gmail.com</a>.
              </p>
            )}

            <div style={styles.calHeader}>
              <button style={styles.navBtn} onClick={() => shiftMonth(-1)}>‹</button>
              <span>{monthLabel}</span>
              <button style={styles.navBtn} onClick={() => shiftMonth(1)}>›</button>
            </div>
            <div style={styles.calGrid}>
              {WEEKDAYS_NL.map(w => <div key={w} style={styles.calDow}>{w}</div>)}
              {grid.map((date, i) => {
                if (!date) return <div key={i} />;
                const disabled = isDateDisabled(date);
                const isSelected = selectedDate && toISO(selectedDate) === toISO(date);
                return (
                  <button
                    key={i}
                    disabled={disabled}
                    onClick={() => selectDate(date)}
                    style={{
                      ...styles.calDay,
                      ...(disabled ? styles.calDayDisabled : {}),
                      ...(isSelected ? styles.calDaySelected : {})
                    }}
                  >
                    {date.getDate()}
                  </button>
                );
              })}
            </div>

            {selectedDate && (
              <div style={{ marginTop: 16 }}>
                <div style={styles.label}>Tijdstip</div>
                {loadingSlots && <p style={{ color: "var(--muted)" }}>Beschikbaarheid laden…</p>}
                {!loadingSlots && slots.length === 0 && <p style={{ color: "var(--muted)" }}>Geen sessies op deze dag.</p>}
                <div style={styles.slotList}>
                  {slots.map(s => (
                    <button
                      key={s.start}
                      disabled={!s.bookable}
                      onClick={() => setSelectedSlot(s.start)}
                      style={{
                        ...styles.slotBtn,
                        ...(s.bookable ? {} : styles.slotBtnDisabled),
                        ...(selectedSlot === s.start ? styles.slotBtnSelected : {})
                      }}
                    >
                      {s.start} {s.bookable ? "— Boek nu" : "— volzet"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {selectedSlot && (
              <form onSubmit={submitBooking} style={{ marginTop: 20 }}>
                <input required placeholder="Naam" value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })} style={styles.input} />
                <input required type="email" placeholder="E-mail" value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })} style={styles.input} />
                <input required placeholder="Telefoon" value={form.phone}
                  onChange={e => setForm({ ...form, phone: e.target.value })} style={styles.input} />
                <input required type="date" placeholder="Geboortedatum" value={form.birthDate}
                  onChange={e => setForm({ ...form, birthDate: e.target.value })} style={styles.input} />
                <textarea placeholder="Notitie (optioneel)" value={form.note}
                  onChange={e => setForm({ ...form, note: e.target.value })} style={{ ...styles.input, minHeight: 60 }} />

                <label style={styles.checkboxRow}>
                  <input type="checkbox" checked={form.invoiceRequested}
                    onChange={e => setForm({ ...form, invoiceRequested: e.target.checked })} />
                  Ik wens een factuur
                </label>
                {form.invoiceRequested && (
                  <>
                    <input placeholder="BTW-nummer" value={form.vatNumber}
                      onChange={e => setForm({ ...form, vatNumber: e.target.value })} style={styles.input} />
                    <input placeholder="Bedrijfsnaam" value={form.companyName}
                      onChange={e => setForm({ ...form, companyName: e.target.value })} style={styles.input} />
                  </>
                )}

                <label style={styles.checkboxRow}>
                  <input type="checkbox" checked={form.marketingOptIn}
                    onChange={e => setForm({ ...form, marketingOptIn: e.target.checked })} />
                  Ik ontvang graag nieuws en promoties per e-mail
                </label>
                <label style={styles.checkboxRow}>
                  <input required type="checkbox" checked={form.termsAccepted}
                    onChange={e => setForm({ ...form, termsAccepted: e.target.checked })} />
                  Ik ga akkoord met de algemene voorwaarden
                </label>

                {error && <p style={{ color: "#FF8A8A" }}>{error}</p>}

                <button type="submit" disabled={!form.termsAccepted || submitting} style={styles.primaryBtn}>
                  {submitting ? "Bezig…" : `Bevestig en betaal — €${price}`}
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const styles = {
  wrap: { minHeight: "100vh", display: "flex", justifyContent: "center", padding: "24px 12px" },
  card: { width: "100%", maxWidth: 480, background: "var(--panel)", borderRadius: 16, padding: 24 },
  h1: { fontSize: 22, marginTop: 0 },
  tabs: { display: "flex", gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--line)", background: "transparent", color: "var(--text)" },
  tabActive: { background: "var(--accent)", borderColor: "var(--accent)", fontWeight: 700 },
  row: { display: "flex", alignItems: "center", gap: 12, marginBottom: 8 },
  label: { color: "var(--muted)", fontSize: 13, marginBottom: 6 },
  stepper: { display: "flex", alignItems: "center", gap: 10 },
  stepBtn: { width: 30, height: 30, borderRadius: 8, border: "1px solid var(--line)", background: "transparent", color: "var(--text)", fontSize: 18 },
  price: { marginLeft: "auto", fontWeight: 700, color: "var(--accent)", fontSize: 20 },
  note: { color: "var(--muted)", fontSize: 13 },
  calHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", margin: "16px 0 8px" },
  navBtn: { background: "transparent", border: "1px solid var(--line)", color: "var(--text)", borderRadius: 8, width: 30, height: 30 },
  calGrid: { display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4 },
  calDow: { textAlign: "center", color: "var(--muted)", fontSize: 12, padding: 4 },
  calDay: { padding: "8px 0", borderRadius: 8, border: "1px solid var(--line)", background: "transparent", color: "var(--text)" },
  calDayDisabled: { opacity: 0.25, pointerEvents: "none" },
  calDaySelected: { background: "var(--accent)", borderColor: "var(--accent)", fontWeight: 700 },
  slotList: { display: "flex", flexDirection: "column", gap: 8, marginTop: 8 },
  slotBtn: { padding: "10px 12px", borderRadius: 10, border: "1px solid var(--line)", background: "transparent", color: "var(--text)", textAlign: "left" },
  slotBtnDisabled: { opacity: 0.35 },
  slotBtnSelected: { background: "var(--accent)", borderColor: "var(--accent)", fontWeight: 700 },
  input: { display: "block", width: "100%", marginBottom: 10, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--line)", background: "#1C1C1F", color: "var(--text)" },
  checkboxRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 14, marginBottom: 10 },
  primaryBtn: { display: "inline-block", width: "100%", textAlign: "center", padding: "12px 16px", borderRadius: 10, border: "none", background: "var(--accent)", color: "#fff", fontWeight: 700, textDecoration: "none" }
};
