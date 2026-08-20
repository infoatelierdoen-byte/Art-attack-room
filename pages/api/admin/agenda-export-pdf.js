const store = require("../../../lib/store-sql");
const { generateAgendaPdf } = require("../../../lib/pdf");
const { requireStaff } = require("../../../lib/auth");
const { mondayOfISO, toISODate, addDaysISO } = require("../../../lib/dateUtils");

// GET /api/admin/agenda-export-pdf?week=2026-08-17
//
// De weekagenda zoals ze op het scherm staat, maar afdrukbaar: per dag de
// werkuren, dan elk tijdslot met alle rooms eronder — geboekt, vrij of
// gesloten. Vervangt de vroegere "Week exporteren", die een platte lijst
// boekingen gaf en dus niet toonde wat er nog vrij was (Robin, aug 2026).
//
// Enkel Admin: het blad bevat klantnamen, bedragen en notities.
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const session = requireStaff(req, res);
  if (!session) return;
  if (session.role !== "admin") {
    return res.status(403).json({ error: "Enkel toegankelijk voor Admin." });
  }

  try {
    const week = req.query.week || toISODate(new Date());
    const monday = mondayOfISO(week);

    const [events, rooms, shifts] = await Promise.all([
      store.getWeekSessions(monday),
      store.getRoomsList(),
      store.getStaffShifts(monday)
    ]);

    const weekTotaal = { boekingen: 0, personen: 0, omzet: 0 };
    const dagen = [];

    for (let i = 0; i < 7; i++) {
      const dISO = addDaysISO(monday, i);
      const dagEvents = events.filter(e => e.dateISO === dISO);

      // Per tijdstip groeperen. Sessies zonder room-toewijzing (Fluid Art) en
      // persoonlijke afspraken krijgen elk hun eigen regel.
      const perStart = new Map();
      for (const e of dagEvents) {
        if (e.kind === "room_closed") continue; // die hangen we onder hun sessie
        const sleutel = e.start;
        if (!perStart.has(sleutel)) {
          perStart.set(sleutel, { start: e.start, dienst: labelVoor(e), rooms: [] });
        }
      }

      const gesloten = dagEvents.filter(e => e.kind === "room_closed");

      const slots = [];
      for (const [start, slot] of [...perStart.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const opDitUur = dagEvents.filter(e => e.start === start && e.kind !== "room_closed");
        const metRooms = opDitUur.filter(e => e.usesRoomAssignment);

        if (metRooms.length > 0 || gesloten.some(g => g.start === start)) {
          // Room-gebaseerde dienst: alle rooms tonen, ook de vrije.
          // getRoomsList() geeft {id, label, capacity} terug — `id` IS de roomcode
          // ("M", "VL", ...), er is geen aparte `code`. Dat was eerst mis, met als
          // gevolg dat geen enkele boeking aan een room gekoppeld raakte en alles
          // als "vrij" op het blad kwam terwijl de dagtotalen wél klopten.
          for (const room of rooms) {
            const boeking = opDitUur.find(e => e.roomCode === room.id);
            const dicht = gesloten.find(g => g.start === start && g.roomCode === room.id);
            if (boeking) {
              slot.rooms.push({
                soort: "boeking", room: room.label || room.id,
                klant: boeking.customer || "(geen naam)",
                personen: boeking.partySize ?? 0,
                bedrag: Number(boeking.amount || 0) - Number(boeking.refundedAmount || 0),
                status: statusLabel(boeking),
                notitie: (boeking.note || "").trim()
              });
            } else if (dicht) {
              slot.rooms.push({ soort: "gesloten", room: room.label || room.id, reden: dicht.reason || "" });
            } else {
              slot.rooms.push({ soort: "vrij", room: room.label || room.id });
            }
          }
        } else {
          // Dienst zonder rooms (Fluid Art werkt met één zaal en een
          // sessiecapaciteit), of een persoonlijke afspraak. Hier is een
          // roomkolom betekenisloos, dus die blijft leeg.
          const geboekt = opDitUur.filter(e => e.bookingId);
          const capaciteit = opDitUur[0]?.capacity;
          for (const e of opDitUur) {
            if (e.kind === "personal") {
              slot.rooms.push({ soort: "gesloten", room: "", reden: e.title || "Privé" });
            } else if (e.bookingId) {
              slot.rooms.push({
                soort: "boeking", room: "",
                klant: e.customer || "(geen naam)",
                personen: e.partySize ?? 0,
                bedrag: Number(e.amount || 0) - Number(e.refundedAmount || 0),
                status: statusLabel(e),
                notitie: (e.note || "").trim()
              });
            }
          }
          if (geboekt.length === 0 && !opDitUur.some(e => e.kind === "personal")) {
            slot.rooms.push({
              soort: "vrij", room: "",
              vrijTekst: capaciteit ? `nog geen boekingen (0/${capaciteit} plaatsen)` : "nog geen boekingen"
            });
          } else if (capaciteit) {
            const bezet = geboekt.reduce((n, e) => n + (e.partySize || 0), 0);
            slot.bezetting = `${bezet}/${capaciteit} plaatsen`;
          }
        }
        slots.push(slot);
      }

      // Let op: een grote groep neemt twee rooms in en komt daardoor als TWEE
      // events terug (één per room). Voor de dagtotalen moet die boeking maar
      // één keer meetellen — anders staat er dubbel zoveel omzet op het blad.
      const gezien = new Set();
      const boekingenVanDeDag = dagEvents.filter(e => {
        if (e.kind !== "service" || !e.bookingId) return false;
        if (gezien.has(e.bookingId)) return false;
        gezien.add(e.bookingId);
        return true;
      });
      const totaal = {
        boekingen: boekingenVanDeDag.length,
        personen: boekingenVanDeDag.reduce((s, b) => s + (b.partySize || 0), 0),
        omzet: boekingenVanDeDag.reduce((s, b) => s + (Number(b.amount || 0) - Number(b.refundedAmount || 0)), 0)
      };
      weekTotaal.boekingen += totaal.boekingen;
      weekTotaal.personen += totaal.personen;
      weekTotaal.omzet += totaal.omzet;

      dagen.push({
        titel: titelVoorDag(dISO),
        werkuren: shifts.filter(s => s.dateISO === dISO).map(s => `${s.staffName} ${s.start}–${s.end}`),
        slots,
        totaal
      });
    }

    const pdf = await generateAgendaPdf({ mondayISO: monday, dagen, weekTotaal });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="agenda-week-${monday}.pdf"`);
    res.status(200).send(pdf);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

function labelVoor(e) {
  if (e.kind === "personal") return "Persoonlijke afspraak";
  if (e.service === "fluid_art") return "Fluid Art";
  if (e.service === "action_painting") return "Action Painting";
  return e.service || "";
}

function statusLabel(b) {
  if (b.pendingConfirmation) return "reservering";
  if (b.paymentStatus === "paid") return "betaald";
  if (b.paymentStatus === "refunded") return "terugbetaald";
  return "niet betaald";
}

const DAGEN_NL = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];
const MAANDEN_NL = ["januari", "februari", "maart", "april", "mei", "juni",
                    "juli", "augustus", "september", "oktober", "november", "december"];

function titelVoorDag(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${DAGEN_NL[dt.getDay()]} ${d} ${MAANDEN_NL[m - 1]} ${y}`;
}
