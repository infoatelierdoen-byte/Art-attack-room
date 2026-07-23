import { useEffect, useMemo, useState } from "react";

const HOUR_START = 9;
const HOUR_END = 22;
const HOUR_PX = 44;
const DAY_LABELS = ["Ma", "Di", "Wo", "Do", "Vr", "Za", "Zo"];

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

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function serviceLabel(code) {
  if (code === "fluid_art") return "Fluid Art";
  if (code === "art_attack_room") return "Art Attack Room";
  return code;
}

export default function Backend() {
  const [monday, setMonday] = useState(() => mondayOf(toISO(new Date())));
  const [events, setEvents] = useState([]);
  const [role, setRole] = useState("admin"); // admin | guest
  const [loading, setLoading] = useState(true);
  const [showAddPersonal, setShowAddPersonal] = useState(false);
  const [personalForm, setPersonalForm] = useState({ title: "", dateISO: "", start: "", end: "" });

  function load(week) {
    setLoading(true);
    fetch(`/api/admin/sessions?week=${week}`)
      .then(r => r.json())
      .then(d => { setMonday(d.monday); setEvents(d.events); })
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(monday); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const weekDays = useMemo(() => {
    const start = parseISO(monday);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [monday]);

  function shiftWeek(n) {
    load(toISO(addDays(parseISO(monday), n * 7)));
  }

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

  function eventVisual(ev) {
    const hideDetails = ev.visibility === "private" && role === "guest";
    if (ev.kind === "personal") {
      return {
        cls: "personal",
        label: hideDetails ? "Privé" : ev.title,
        sub: hideDetails ? "" : `${ev.start}–${ev.end}`
      };
    }
    if (hideDetails) {
      return { cls: "private", label: "Bezet", sub: ev.start };
    }
    const base = ev.service === "fluid_art" ? "fluid" : "attack";
    const cls = ev.visibility === "private" ? `${base} private-visible` : base;
    const label = ev.customer || serviceLabel(ev.service);
    const sub = ev.customer ? `${serviceLabel(ev.service)} · ${ev.partySize}p` : `${ev.booked ?? 0}/${ev.capacity ?? "-"}`;
    return { cls, label, sub };
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--admin-bg)", color: "#20221F", fontFamily: "inherit" }}>
      <style>{css}</style>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--admin-line)" }}>
        <h1 style={{ fontSize: 20, margin: 0, color: "var(--admin-accent)" }}>Agenda</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setRole("admin")} className={`role-btn ${role === "admin" ? "active" : ""}`}>Admin</button>
          <button onClick={() => setRole("guest")} className={`role-btn ${role === "guest" ? "active" : ""}`}>Gast</button>
        </div>
      </header>

      <div style={{ padding: "12px 20px", display: "flex", alignItems: "center", gap: 10 }}>
        <button className="nav-btn" onClick={() => shiftWeek(-1)}>‹ vorige week</button>
        <span style={{ fontWeight: 700 }}>
          week van {weekDays[0].toLocaleDateString("nl-BE", { day: "2-digit", month: "long" })}
        </span>
        <button className="nav-btn" onClick={() => shiftWeek(1)}>volgende week ›</button>
        <button className="nav-btn" onClick={() => load(mondayOf(toISO(new Date())))}>vandaag</button>
        <button style={{ marginLeft: "auto" }} className="add-btn" onClick={() => setShowAddPersonal(true)}>
          + Persoonlijke afspraak
        </button>
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
              return (
                <div key={i} className="week-day-col">
                  <div className="week-day-head">{DAY_LABELS[i]} {d.getDate()}</div>
                  <div className="week-day-body" style={{ height: (HOUR_END - HOUR_START) * HOUR_PX }}>
                    {dayEvents.map((ev, idx) => {
                      const startMin = timeToMinutes(ev.start);
                      const endMin = ev.kind === "personal" ? timeToMinutes(ev.end) : startMin + (ev.durationMin || 90);
                      const top = ((startMin / 60) - HOUR_START) * HOUR_PX;
                      const height = ((endMin - startMin) / 60) * HOUR_PX;
                      const v = eventVisual(ev);
                      return (
                        <div key={idx} className={`cal-event ${v.cls}`} style={{ top, height }}>
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
    </div>
  );
}

const css = `
  .role-btn { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--admin-line); background: #fff; }
  .role-btn.active { background: var(--admin-accent); color: #fff; border-color: var(--admin-accent); }
  .nav-btn { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--admin-line); background: #fff; }
  .add-btn { padding: 8px 14px; border-radius: 8px; border: none; background: var(--admin-accent); color: #fff; font-weight: 700; }
  .week-body { display: flex; padding: 0 20px 40px; gap: 0; }
  .week-time-col { width: 56px; padding-top: 34px; }
  .hour-label { height: ${HOUR_PX}px; font-size: 11px; color: #7C7668; }
  .week-days { display: grid; grid-template-columns: repeat(7, 1fr); flex: 1; gap: 6px; }
  .week-day-col { border: 1px solid var(--admin-line); border-radius: 10px; overflow: hidden; background: #fff; }
  .week-day-head { text-align: center; font-size: 12px; font-weight: 700; padding: 8px 0; border-bottom: 1px solid var(--admin-line); }
  .week-day-body { position: relative; background-image: repeating-linear-gradient(to bottom, #F1EEE7 0, #F1EEE7 1px, transparent 1px, transparent ${HOUR_PX}px); }
  .cal-event { position: absolute; left: 3px; right: 3px; border-radius: 6px; padding: 4px 6px; font-size: 11px; overflow: hidden; }
  .cal-event-label { font-weight: 700; }
  .cal-event-sub { opacity: 0.8; }
  .cal-event.attack { background: #FBE9E1; border-left: 3px solid var(--admin-accent); }
  .cal-event.fluid { background: var(--fluid-bg); border-left: 3px solid var(--fluid); }
  .cal-event.private-visible { background: repeating-linear-gradient(45deg, #FBE9E1, #FBE9E1 6px, #F3DCCF 6px, #F3DCCF 12px); }
  .cal-event.personal { background: var(--private-bg); border-left: 3px solid #7C7668; font-style: italic; }
  .cal-event.private { background: var(--private-bg); border-left: 3px solid #7C7668; }
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; }
  .modal { background: #fff; padding: 20px; border-radius: 12px; width: 320px; display: flex; flex-direction: column; gap: 8px; }
  .modal input { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--admin-line); }
`;
