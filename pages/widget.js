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

// Sfeerfoto per dienst, getoond in de hero zodra een workshop gekozen is.
// De bestanden staan in public/images/. Een dienst die hier niet in staat
// toont gewoon de donkere achtergrond (.abr-hero-media in layoutCss).
const HERO_IMAGES = {
  action_painting: {
    src: "/images/action-painting.jpg",
    alt: "Gezin in witte overalls voor hun schilderij in de Action Painting-ruimte",
  },
  fluid_art: {
    src: "/images/fluid-art.jpg",
    alt: "Deelneemster houdt een net gegoten roze fluid art-canvas omhoog",
  },
};

// Handgetekende cadeaubon-illustratie (geen echte foto — er is momenteel geen
// AI-beeldgeneratie beschikbaar). Vervang gerust door een echte foto/AI-beeld:
// gewoon de <GiftTileArt /> hieronder verwijderen en een <img> in de
// .abr-tile-bg-gift div zetten, zoals bij de andere twee tegels.
function GiftTileArt() {
  return (
    <svg viewBox="0 0 400 600" preserveAspectRatio="xMidYMid slice" style={{ width: "100%", height: "100%", display: "block" }}>
      <defs>
        <radialGradient id="giftBg" cx="50%" cy="38%" r="75%">
          <stop offset="0%" stopColor="#3A2A22" />
          <stop offset="100%" stopColor="#1C1C1F" />
        </radialGradient>
      </defs>
      <rect width="400" height="600" fill="url(#giftBg)" />
      <circle cx="90" cy="120" r="3" fill="#F4E7D8" opacity="0.6" />
      <circle cx="320" cy="90" r="2.5" fill="#F4E7D8" opacity="0.5" />
      <circle cx="300" cy="200" r="2" fill="#F4E7D8" opacity="0.4" />
      <circle cx="70" cy="240" r="2" fill="#F4E7D8" opacity="0.4" />
      <rect x="110" y="270" width="180" height="150" rx="6" fill="#C1653A" />
      <rect x="95" y="240" width="210" height="45" rx="6" fill="#D97A4E" />
      <rect x="185" y="240" width="30" height="180" fill="#F4E7D8" opacity="0.9" />
      <rect x="95" y="255" width="210" height="16" fill="#F4E7D8" opacity="0.9" />
      <path d="M200 240 C170 210 140 215 150 245 C160 265 190 250 200 240 Z" fill="#F4E7D8" opacity="0.9" />
      <path d="M200 240 C230 210 260 215 250 245 C240 265 210 250 200 240 Z" fill="#F4E7D8" opacity="0.9" />
      <circle cx="200" cy="240" r="9" fill="#C1653A" />
    </svg>
  );
}

export default function Widget() {
  const today = useMemo(() => new Date(), []);
  const maxDate = useMemo(() => {
    const d = new Date(today);
    d.setMonth(d.getMonth() + 3);
    return d;
  }, [today]);

  // Enkel relevant op desktop (zie CSS media query hieronder): op mobiel
  // wordt deze landingspagina met foto-tegels genegeerd en zie je meteen
  // het boekingsscherm, zoals voorheen — dat pakken we later apart aan.
  const [desktopLanding, setDesktopLanding] = useState(true);

  const [services, setServices] = useState([]);
  const [serviceCode, setServiceCode] = useState("action_painting");
  const [partySize, setPartySize] = useState(2);
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState(null);
  const [slots, setSlots] = useState([]);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  // ISO-datums (YYYY-MM-DD) binnen de getoonde maand die minstens 1 boekbaar
  // tijdstip hebben — voor het groen markeren van dagen in de kalender.
  const [availableDates, setAvailableDates] = useState(new Set());

  const [form, setForm] = useState({
    name: "", email: "", phone: "", birthDate: "", note: "",
    termsAccepted: false, marketingOptIn: true,
    invoiceRequested: false, vatNumber: "", companyName: "",
    giftCardCode: ""
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

  // Prijs PER PERSOON voor naast de stepper (bv. "€60pp" bij 2, "€58pp" bij
  // 3) — het effectief te betalen totaalbedrag (bv. bij "Bevestig en
  // betaal") blijft uiteraard gewoon het totaal, niet dit bedrag.
  const pricePerPerson = useMemo(() => {
    if (price === null || !partySize) return null;
    return Math.round(price / partySize);
  }, [price, partySize]);

  // Welke dagen in de getoonde maand nog boekbaar zijn (groen te markeren) —
  // hangt af van dienst, groepsgrootte én de getoonde maand, dus opnieuw
  // opvragen zodra één daarvan verandert.
  useEffect(() => {
    if (!serviceCode) return;
    fetch(`/api/availability-month?service=${serviceCode}&year=${viewYear}&month=${viewMonth}&partySize=${partySize || 1}`)
      .then(r => r.json())
      .then(d => setAvailableDates(new Set(d.dates || [])))
      .catch(() => setAvailableDates(new Set()));
  }, [serviceCode, viewYear, viewMonth, partySize]);

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
          invoiceDetails: form.invoiceRequested ? { vatNumber: form.vatNumber, companyName: form.companyName } : null,
          giftCardCode: form.giftCardCode.trim() || null
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
          {result.coveredByGiftCard ? (
            <>
              <h2 style={{ color: "var(--accent)" }}>Boeking bevestigd!</h2>
              <p>Je cadeaubon dekte het volledige bedrag — je reservatie is meteen bevestigd. Je ontvangt zo een bevestigingsmail.</p>
            </>
          ) : (
            <>
              <h2 style={{ color: "var(--accent)" }}>Bijna klaar!</h2>
              <p>Je reservatie is aangemaakt. Rond de betaling af om ze te bevestigen.</p>
              <p style={{ fontWeight: 700 }}>Te betalen: €{result.amountDue.toFixed(2)}</p>
              {result.mocked && (
                <p style={{ color: "var(--muted)", fontSize: 13 }}>
                  (Dev-modus: er is geen echte Mollie-key ingesteld, dit is een mock-checkout-link.)
                </p>
              )}
              <a href={result.checkoutUrl} style={styles.primaryBtn}>Naar betaling</a>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`abr-page ${desktopLanding ? "abr-mode-landing" : "abr-mode-booking"}`}>
      <style>{layoutCss}</style>

      {/* Landingspagina met 3 foto-tegels — zichtbaar op elke schermbreedte
          (dus ook in de pop-up-embed, zie public/embed.js): elke klant die
          boekt ziet zo altijd eerst alle workshops, ongeacht welke hij
          uiteindelijk kiest ("follow-through", Robin, aug 2026). Enkel de
          LAYOUT verschilt per breedte (rij op desktop vanaf 900px, kolom
          daaronder — zie media query in layoutCss), niet of dit scherm
          getoond wordt. Spin Art is nog niet live: de derde tegel is
          voorlopig de cadeaubon, en wordt vervangen zodra Spin Art gelanceerd
          wordt. */}
      <div className="abr-landing">
        <div
          className="abr-tile"
          role="button" tabIndex={0}
          onClick={() => { setServiceCode("action_painting"); setSelectedDate(null); setSelectedSlot(null); setDesktopLanding(false); }}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { setServiceCode("action_painting"); setSelectedDate(null); setSelectedSlot(null); setDesktopLanding(false); } }}
        >
          <div className="abr-tile-bg abr-tile-bg-attack">
            <img
              src="/images/action-painting.jpg"
              alt="Gezin in witte overalls voor hun schilderij in de Action Painting-ruimte"
              className="abr-tile-img"
              loading="eager"
            />
          </div>
          <div className="abr-tile-overlay">
            <p className="abr-tile-title">Action Painting</p>
            <p className="abr-tile-sub">Graffiti-ervaring</p>
          </div>
        </div>

        <div
          className="abr-tile"
          role="button" tabIndex={0}
          onClick={() => { setServiceCode("fluid_art"); setSelectedDate(null); setSelectedSlot(null); setDesktopLanding(false); }}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { setServiceCode("fluid_art"); setSelectedDate(null); setSelectedSlot(null); setDesktopLanding(false); } }}
        >
          <div className="abr-tile-bg abr-tile-bg-fluid">
            <img
              src="/images/fluid-art.jpg"
              alt="Deelneemster houdt een net gegoten roze fluid art-canvas omhoog"
              className="abr-tile-img"
              loading="eager"
            />
          </div>
          <div className="abr-tile-overlay">
            <p className="abr-tile-title">Fluid Art</p>
            <p className="abr-tile-sub">Acrylgieten</p>
          </div>
        </div>

        {/* Tijdelijke derde tegel zolang Spin Art nog niet live is (Robin,
            aug 2026) — te vervangen door een echte Spin Art-tegel (zelfde
            opbouw als de twee hierboven, serviceCode "spin_art") zodra die
            dienst effectief in de database staat. */}
        <a className="abr-tile" href="/widget/cadeaubon">
          <div className="abr-tile-bg abr-tile-bg-gift">
            <GiftTileArt />
          </div>
          <div className="abr-tile-overlay">
            <p className="abr-tile-title">Cadeaubon</p>
            <p className="abr-tile-sub">Verras iemand</p>
          </div>
        </a>
      </div>

      <div className="abr-layout">
        <div className="abr-hero">
          <button type="button" className="abr-back-link" onClick={() => setDesktopLanding(true)} aria-label="Kies een andere workshop">
            <span className="abr-back-arrow">‹</span>
            <span className="abr-back-text">Kies een andere workshop</span>
          </button>
          {/* Sfeerfoto van de gekozen workshop. Diensten zonder eigen foto
              (bv. Spin Art zodra die live gaat) vallen terug op de donkere
              achtergrond uit layoutCss — voeg hier dan gewoon een regel toe
              aan HERO_IMAGES bovenaan dit bestand. */}
          <div className="abr-hero-media">
            {HERO_IMAGES[serviceCode] && (
              <img
                src={HERO_IMAGES[serviceCode].src}
                alt={HERO_IMAGES[serviceCode].alt}
                className="abr-hero-img"
              />
            )}
          </div>
          {/* Op mobiel: enkel deze titel over de foto, de volledige tekst
              hieronder (.abr-hero-text) is daar verborgen om de vaste
              fotostrook compact te houden — zie layoutCss. */}
          <p className="abr-hero-mobile-title">{currentService?.label || "Boek je workshop"}</p>
          <div className="abr-hero-text">
            <h1>Boek je workshop</h1>
            {/* "Art Attack Room" hier = de zaak/het merk (waar alle workshops
                doorgaan), niet de workshop zelf — die heet nu Action
                Painting. Zie README "Workshop hernoemd". */}
            <p style={{ ...styles.note, marginBottom: 8 }}>
              Beleef een unieke, creatieve namiddag bij Art Attack Room.
            </p>
            <p style={styles.note}>
              Iemand verrassen? <a href="/widget/cadeaubon" style={{ color: "var(--accent)" }}>Koop een cadeaubon</a>.
            </p>
          </div>
        </div>

        <div className="abr-panel-wrap">
          <div className="abr-panel">
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
              {pricePerPerson !== null && <span style={styles.price}>€{pricePerPerson}pp</span>}
            </div>
            {serviceCode === "action_painting" && (
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
                const isAvailable = !disabled && availableDates.has(toISO(date));
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
                    {isAvailable && !isSelected && <span style={styles.calDayDot} />}
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
                    <div key={s.start}>
                      <button
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
                      {s.bookable && s.roomsLeft === 1 && (
                        <p style={styles.lastRoomWarning}>Nog 1 room beschikbaar</p>
                      )}
                    </div>
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

                <input placeholder="Cadeaubon-code (optioneel)" value={form.giftCardCode}
                  onChange={e => setForm({ ...form, giftCardCode: e.target.value })} style={styles.input} />

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
      </div>
    </div>
  );
}

const layoutCss = `
  /* --- Basis = mobiel (tegels onder elkaar, foto vast bovenaan) --- */
  .abr-page { min-height: 100vh; width: 100%; }

  .abr-landing { display: flex; flex-direction: column; min-height: 100vh; }
  .abr-mode-booking .abr-landing { display: none; }
  .abr-tile { position: relative; flex: 1; display: flex; align-items: flex-end; overflow: hidden; text-decoration: none; cursor: pointer; border: none; }
  .abr-tile-bg { position: absolute; inset: 0; transition: transform 0.4s ease; }
  .abr-tile:hover .abr-tile-bg { transform: scale(1.04); }
  .abr-tile-bg-attack { background: linear-gradient(160deg, #3A2A22, #C1653A); display: flex; align-items: center; justify-content: center; }
  .abr-tile-bg-fluid { background: linear-gradient(160deg, #1E2A3A, #3D8BFF); display: flex; align-items: center; justify-content: center; }
  .abr-tile-bg-gift { background: #1C1C1F; }
  /* De gradients hierboven blijven als achtergrond staan: die zie je zolang de
     foto nog laadt (en als ze ooit zou ontbreken), zodat de tekst in
     .abr-tile-overlay altijd leesbaar blijft. */
  .abr-tile-img { width: 100%; height: 100%; object-fit: cover; object-position: center; display: block; }
  .abr-tile-placeholder-label { color: rgba(255,255,255,0.55); font-size: 13px; border: 1.5px dashed rgba(255,255,255,0.3); padding: 10px 16px; border-radius: 8px; }
  .abr-tile-overlay { position: relative; z-index: 1; width: 100%; box-sizing: border-box; padding: 20px; background: linear-gradient(to top, rgba(0,0,0,0.7), rgba(0,0,0,0) 65%); }
  .abr-tile-title { color: #fff; font-size: 18px; font-weight: 500; margin: 0 0 4px; }
  .abr-tile-sub { color: rgba(255,255,255,0.78); font-size: 12px; margin: 0; }

  .abr-mode-landing .abr-layout { display: none; }
  .abr-layout { display: flex; flex-direction: column; }

  /* Vaste fotostrook bovenaan (~38% van het scherm) met titel erover; de
     volledige tekstblok (.abr-hero-text) is op mobiel verborgen om deze
     strook compact te houden. Daaronder scrollt het boekingspaneel gewoon. */
  .abr-hero { position: sticky; top: 0; z-index: 5; height: 38vh; min-height: 210px; padding: 0; overflow: hidden; }
  .abr-hero-media { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; border-radius: 0; background: linear-gradient(135deg, #2A2A2E, #1C1C1F); display: flex; align-items: center; justify-content: center; }
  .abr-hero-media-label { color: var(--muted); font-size: 13px; }
  .abr-hero-img { width: 100%; height: 100%; object-fit: cover; object-position: center; display: block; }
  .abr-hero-mobile-title { position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; margin: 0; padding: 16px; font-size: 19px; font-weight: 500; color: #fff; background: linear-gradient(to top, rgba(0,0,0,0.7), rgba(0,0,0,0) 70%); }
  .abr-hero-text { display: none; }

  .abr-back-link { display: none; border: none; }
  .abr-mode-booking .abr-back-link { position: absolute; top: 14px; left: 14px; z-index: 6; display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 50%; background: rgba(0,0,0,0.4); color: #fff; font-size: 18px; padding: 0; }
  .abr-back-text { display: none; }

  .abr-panel-wrap { display: flex; justify-content: center; padding: 16px 12px 40px; }
  .abr-panel { width: 100%; max-width: 480px; background: var(--panel); border-radius: 16px; padding: 24px; }

  /* --- Vanaf hier: desktop, zoals eerder afgesproken --- */
  @media (min-width: 900px) {
    .abr-landing { flex-direction: row; }

    .abr-layout { flex-direction: row; align-items: stretch; min-height: 100vh; }
    .abr-hero { position: sticky; top: 0; height: 100vh; min-height: 0; overflow: visible; flex: 1 1 50%; padding: 56px; display: flex; flex-direction: column; justify-content: center; box-sizing: border-box; }
    .abr-hero-media { position: relative; height: 340px; border-radius: 16px; margin-bottom: 16px; }
    .abr-hero-mobile-title { display: none; }
    .abr-hero-text { display: block; }
    .abr-hero-text h1 { margin: 0 0 8px; font-size: 36px; }

    .abr-mode-booking .abr-back-link { position: static; width: auto; height: auto; border-radius: 0; background: none; color: var(--muted); font-size: 13px; padding: 0; margin-bottom: 14px; }
    .abr-back-text { display: inline; margin-left: 4px; }

    .abr-panel-wrap { flex: 1 1 50%; padding: 56px; align-items: center; }
  }
`;

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
  calDay: { position: "relative", padding: "8px 0", borderRadius: 8, border: "1px solid var(--line)", background: "transparent", color: "var(--text)" },
  calDayDisabled: { opacity: 0.25, pointerEvents: "none" },
  calDaySelected: { background: "var(--accent)", borderColor: "var(--accent)", fontWeight: 700 },
  // Klein groen puntje onderaan een dag met nog beschikbare tijdstippen.
  calDayDot: { position: "absolute", bottom: 3, left: "50%", transform: "translateX(-50%)", width: 5, height: 5, borderRadius: "50%", background: "#4CAF6D" },
  slotList: { display: "flex", flexDirection: "column", gap: 8, marginTop: 8 },
  slotBtn: { width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid var(--line)", background: "transparent", color: "var(--text)", textAlign: "left" },
  slotBtnDisabled: { opacity: 0.35 },
  slotBtnSelected: { background: "var(--accent)", borderColor: "var(--accent)", fontWeight: 700 },
  lastRoomWarning: { color: "#E05B5B", fontSize: 11, margin: "4px 0 0 2px" },
  input: { display: "block", width: "100%", marginBottom: 10, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--line)", background: "#1C1C1F", color: "var(--text)" },
  checkboxRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 14, marginBottom: 10 },
  primaryBtn: { display: "inline-block", width: "100%", textAlign: "center", padding: "12px 16px", borderRadius: 10, border: "none", background: "var(--accent)", color: "#fff", fontWeight: 700, textDecoration: "none" }
};
