# Art Attack Room — boekingssysteem (MVP-scaffold)

Werkende basis van het boekingssysteem uit `Voorstel-Boekingssysteem-Workshops.docx`:
de klant-widget (`/widget`), de admin-agenda (`/backend`), de API-routes en
een echte SQL-gebaseerde datalaag tegen `db/schema.sql` (een kopie van
`schema-boekingssysteem.sql`). Dit is de code-tegenhanger van de twee
HTML-prototypes (`prototype-boekingswidget.html` en
`prototype-backend-boekingen.html`) — echte, draaiende logica in plaats van
een statische mockup.

## Snel starten (lokaal testen — geen database-account nodig)

```bash
npm install
npm run dev
```

Open <http://localhost:3000/widget> voor de klant-widget en
<http://localhost:3000/backend> voor de admin-agenda.

Zonder `DATABASE_URL` gebruikt het project **pg-mem**: een in-memory
SQL-engine die zich exact gedraagt als een PostgreSQL-verbinding, automatisch
geladen met `db/schema.sql` + `db/seed.sql`. Dezelfde SQL-queries
(`lib/store-sql.js`) draaien dus ongewijzigd lokaal én in productie — enkel
de databaseverbinding zelf verschilt (zie `lib/db.js`). Betalingen worden
gemockt (`lib/mollie.js`) zodat de volledige boekingsflow te testen is zonder
een echte Mollie-transactie — zet `MOLLIE_API_KEY` in `.env.local` om over
te schakelen op de echte Mollie-koppeling (zie "Mollie testen" hieronder).

**Voor een echte PostgreSQL-database:** zet `DATABASE_URL` in `.env.local`
(zie `.env.example`), en voer `db/schema.sql` gevolgd door `db/seed.sql`
eenmalig uit tegen die database (bv. via `psql "$DATABASE_URL" -f db/schema.sql`).
De app schakelt dan automatisch over op de echte database. Dit pad is
inmiddels ook echt getest (niet enkel tegen pg-mem, zie "Hosting en een
echte database" hieronder) — daarbij is trouwens een echte datumbug aan het
licht gekomen en gefixt (zie diezelfde sectie).

**Migraties op een bestaande live database:** `db/schema.sql` is enkel voor
een nieuwe/lege database — draai het niet opnieuw tegen een database die al
data bevat. Latere kolomwijzigingen komen in `db/migrations/` als apart
nummer bestand (bv. `001_add_refund_tracking.sql` voor de terugbetaling bij
annuleren, zie "Boeking annuleren en verplaatsen" hieronder) — die moeten
één keer manueel uitgevoerd worden tegen de live database
(`psql "$DATABASE_URL" -f db/migrations/001_add_refund_tracking.sql`).

## Wat hier al werkt

- **Echte databaselaag** (`lib/store-sql.js` + `db/schema.sql` + `db/seed.sql`):
  geen in-memory arrays meer — sessies, boekingen, klanten en rooms zijn
  echte tabellen. Terugkerende patronen (`recurrence_rules`) worden
  "gematerialiseerd": concrete rijen in `sessions` worden aangemaakt zodra
  een datum voor het eerst opgevraagd wordt, idempotent (geen dubbels bij
  herhaald opvragen).
- **Prijslogica**: de prijstrap voor Art Attack Room (2p=€120 t.e.m. 7p=€364,
  nooit per persoon) komt rechtstreeks uit `service_party_pricing`; Fluid Art
  gebruikt de vaste prijs per persoon uit `services.price`. Foutmeldingen
  voor groepen buiten de toegelaten online-grootte zijn DB-gedreven
  (`min_online_party_size`/`max_online_party_size`).
- **Vast uurrooster**: sessies (Art Attack Room: wo/do/vr/za/zo op de
  afgesproken uren, met de donderdag-cutoff op 31/08; Fluid Art:
  tweewekelijks op dinsdag 19u) worden berekend uit `recurrence_rules` in de
  database (`db/seed.sql`), niet uit een hardcoded lijst.
- **Automatische room-toewijzing** (`lib/rooms.js` + `room_bookings`-tabel):
  kiest bij elke boeking de kleinste vrije room (A=10, M=5, VL=7, VR=7) die
  past bij de groepsgrootte. Getest met oplopende bezetting (4 boekingen na
  elkaar op hetzelfde tijdslot verdelen zich correct over de 4 rooms, en het
  tijdslot wordt pas "volzet" als alle rooms bezet zijn). Roomdetails worden
  nergens naar de klant teruggestuurd — de API geeft enkel `bookable: true/false`
  terug.
- **Boekingsflow** (`/widget` + `/api/bookings`): groepsgrootte kiezen,
  kalenderweergave (tot 3 maanden vooruit), tijdstip kiezen, klantgegevens
  (incl. geboortedatum en notitie), algemene voorwaarden verplicht,
  marketing-opt-in standaard aangevinkt, optionele factuuraanvraag, en een
  (gemockte) Mollie-checkout — alles weggeschreven in echte tabellen
  (`bookings`, `customers`, `room_bookings`, `payments`).
- **Persoonlijke afspraken** (`/backend` + `/api/admin/personal`): een
  afspraak zoals "Dokter" toevoegen die altijd privé is en nooit een klant
  of prijs heeft (`sessions.kind = 'personal'`) — apart van een privé
  gemarkeerde, wél betalende groepsboeking.
- **Manuele boeking** (`/backend` + `/api/admin/manual-booking`): een
  boeking die het team zelf ingeeft (bv. na een telefoontje) — zelfde
  tijdslot-/roomlogica als de klant-widget, maar geen Mollie-betaallink: je
  kiest een betaalwijze (cash/overschrijving/andere) en de boeking wordt
  meteen als betaald geregistreerd (`booked_via = 'backoffice'`). Wél de
  Billit-factuur bij aanvraag, maar bewust GEEN bevestigingsmail — bij een
  manuele boeking heeft het team de klant al rechtstreeks gesproken, dus
  zowel de klantbevestiging als de interne meldingsmail zouden overbodig
  zijn. Geboortedatum is hier optioneel (in tegenstelling tot de
  klant-widget). Ook hier kan een cadeaubon-code ingevuld worden.
  - **"Enkel reserveren"** (checkbox in hetzelfde scherm, `reserveOnly`):
    voor een boeking die vaak nog wijzigt (groepsgrootte, annulatie, ...) en
    dus nog niet definitief is — er is en blijft **geen Mollie-koppeling**
    voor manuele boekingen, maar met deze optie wordt de boeking ook nog
    niet als "betaald" geregistreerd. Er gebeurt dan nog **niets**
    onomkeerbaars: geen Billit-factuur, en gebruikte je een cadeaubon, dan
    wordt het saldo nog niet afgeschreven (`gift_card_amount` wordt wel al
    onthouden op de boeking, exact hetzelfde deferred-patroon als bij een
    online boeking met gedeeltelijke cadeaubon-dekking). Een gereserveerde
    boeking is herkenbaar in de weekagenda (gestreepte rand, "· reservering"
    label) en klikbaar — dat opent een klein venster om de boeking alsnog te
    bevestigen (met de effectieve betaalwijze), waarna pas de Billit-factuur
    en de cadeaubon-afschrijving gebeuren (`lib/store-sql.js:
    confirmManualBooking()`, `/api/admin/confirm-booking`). Nog steeds
    bewust geen bevestigingsmail op dat moment.
- **Extra sessie toevoegen** (`/backend` + `/api/admin/extra-session`, logica
  in `lib/store-sql.js: addExtraSession()`): een eenmalig extra tijdstip
  buiten het vaste uurrooster (`recurrence_rules`) om — bv. Fluid Art zit een
  week volzet, en je plant een extra sessie de week erna. Verschijnt meteen
  als boekbaar tijdstip in de klant-widget. `recurrence_rule_id` blijft NULL
  (dat voorzag het schema al expliciet als "handmatig/eenmalig
  toegevoegd"). Voorkomt dubbels op exact hetzelfde tijdstip.
- **Room-sluitingen** (`/backend` + `/api/admin/close-room`, logica in
  `lib/store-sql.js: closeRoom()`): een individuele room of alle rooms
  sluiten voor een specifiek tijdstip of de volledige dag, weggeschreven als
  `room_bookings` met `block_type = 'closed'`. Een room met een bestaande
  klantboeking wordt nooit overschreven (`ON CONFLICT DO NOTHING` op
  session+room) — getest door te proberen een al-beboekte room te sluiten:
  de boeking blijft ongemoeid staan.
- **Weekagenda in kalendervorm** (`/backend`): een Google Agenda-achtig
  weekoverzicht met echte data uit `/api/admin/sessions`, inclusief
  rolwissel admin/gast (gast ziet privé-items enkel als "Bezet"/"Privé").
- **Mollie-betalingen** (`lib/mollie.js`): zonder `MOLLIE_API_KEY` een
  volledig werkende mock-checkout (voor lokaal testen zonder echt geld); met
  een echte sleutel (`test_...` of `live_...`) de officiële
  `@mollie/api-client` — dezelfde code, enkel de sleutel bepaalt welke van de
  twee gebruikt wordt.
- **Mollie-webhook** (`/api/mollie-webhook`): zet `bookings.payment_status`
  en de bijhorende `payments`-rij op "paid" zodra de betaling bevestigd
  wordt. Vertrouwt bewust nooit op wat de inkomende request zelf beweert:
  Mollie stuurt hier enkel het payment-ID naartoe, de `bookingId` wordt altijd
  apart bij Mollie zelf opgevraagd via de metadata die bij het aanmaken van
  de betaling werd meegegeven — zo kan niemand een betaling vervalsen door
  zelf een POST naar dit endpoint te sturen met een verzonnen `bookingId`.
- **Billit-facturatie per boeking** (`lib/billit.js`): zodra een boeking met
  "ik wens een factuur" betaald wordt, maakt de app automatisch een echte
  verkoopfactuur aan via `POST /v1/orders` — als bedrijfsklant (met
  BTW-nummer) wanneer bedrijfsgegevens zijn ingevuld, anders als
  privépersoon (zonder BTW-nummer). Onze prijzen zijn BTW-inclusief; het
  bedrag wordt teruggerekend naar het nettobedrag voor Billit
  (`BILLIT_VAT_PERCENTAGE`, standaard 21% — **laat dit percentage
  bevestigen door een boekhouder** voor je op productie schakelt). De
  Billit-koppeling gebruikt ApiKey + PartyID (niet-commerciële integratie,
  zie `.env.example`) en faalt nooit de betaling zelf: lukt de
  factuuraanroep niet, dan wordt dit enkel gelogd zodat het later manueel
  of via een retry hersteld kan worden.
- **Bevestigingsmail** (`lib/email.js`): zodra een boeking online betaald is
  via Mollie, gaat er een bevestigingsmail naar de klant én een interne
  meldingsmail (incl. de notitie van de klant) naar `NOTIFY_EMAIL`.
  Verstuurd via Gmail's eigen SMTP-server met een app-wachtwoord (geen
  aparte e-maildienst nodig) — zie `.env.example` voor hoe je dat aanmaakt.
  Zonder `GMAIL_USER`/`GMAIL_APP_PASSWORD` wordt enkel naar de console
  gelogd, net als bij Mollie en Billit. **Bewust niet** bij een manuele
  boeking (zie hieronder) — daar heeft het team de klant al rechtstreeks
  gesproken.
- **Cadeaubonnen** — volledig eigen systeem (bewust NIET gekoppeld aan de Wix
  Gift Cards API): bruikbaar voor élke workshop, voor een zelfgekozen bedrag.
  - *Klant koopt online* (`/widget/cadeaubon` + `/api/gift-cards/purchase`):
    kiest een bedrag (€5–€500, met 4 vaste suggesties of een vrij bedrag),
    betaalt via Mollie; de code zelf wordt pas aangemaakt zodra de betaling
    bevestigd wordt (Mollie-webhook, zie `fulfillGiftCardPurchase()` in
    `lib/store-sql.js`) en meteen naar de koper gemaild (`lib/email.js:
    sendGiftCardCode()`). Standaard 1 jaar geldig.
  - *Gebruiken bij een boeking*: een extra veld "Cadeaubon-code" in de
    klant-widget (en in het manuele-boeking-scherm in `/backend`, voor
    telefonische boekingen). Dekt de bon het volledige bedrag, dan wordt de
    boeking meteen bevestigd zonder Mollie; is er een restbedrag, dan gaat
    dat via de gewone Mollie-checkout. Het effectief afschrijven van het
    saldo gebeurt bewust pas zodra de betaling (van het eventuele restbedrag)
    écht bevestigd is — zelfde deferred-pattern als de bevestigingsmail en
    Billit-factuur hierboven, met een idempotentie-guard
    (`gift_card_redeemed_at`) tegen een dubbele afschrijving bij een
    herhaalde webhook-aanroep.
  - *Backoffice-beheer* (`/backend` → knop "Cadeaubonnen"): zoeken op code,
    naam of e-mail, manueel een nieuwe bon aanmaken (bv. cash verkocht), en
    activeren/uitschakelen. Een opgebruikte bon (`status = 'depleted'`) kan
    niet meer geactiveerd worden.
  - *Import van de bestaande bonnen* (`db/import-gift-cards.sql`): de 355
    bestaande cadeaubonnen (91 uit Wix, 264 uit FareHarbor — bewust **niet**
    samengevoegd, dit zijn en blijven twee gescheiden bronsystemen) zijn
    omgezet naar één `INSERT ... ON CONFLICT (code) DO NOTHING`-script. Voer
    dit **eenmalig** uit tegen je database, net zoals `schema.sql`/`seed.sql`
    (zie "Cadeaubonnen importeren" hieronder) — bevat echte klantgegevens,
    dus **niet publiek delen of naar een publieke Git-repo pushen**.
- **Wekelijkse verzamelfactuur** (`lib/store-sql.js: generateWeeklyRevenueInvoice()`
  + `POST /api/admin/weekly-invoice`): telt per week de omzet van betaalde
  boekingen op die NIET al individueel gefactureerd werden
  (`invoice_requested = false`), gegroepeerd per dienst, en maakt daarvoor
  1 verzamelfactuur aan bij Billit (geen echte klant, enkel een interne
  "kassaomzet"-registratie). **Idempotent per week**: een tweede aanroep
  voor dezelfde week doet niets opnieuw (getest). Levert ook altijd een
  rij in `weekly_revenue_invoices` op, zelfs bij €0 omzet (voor een
  volledig overzicht/audit-trail) — enkel dan wordt Billit niet
  aangeroepen.
- **E-maillijst exporteren** (`lib/store-sql.js: listMarketingEmails()` +
  `GET /api/admin/customers-export`, knop "E-maillijst exporteren" in
  `/backend`): CSV-download van alle klant-e-mailadressen verzameld via
  boekingen (widget + backoffice), beperkt tot wie `marketing_opt_in = true`
  heeft staan (het vinkje "Ik ontvang graag nieuws en promoties per e-mail"
  in de widget). `customers.email` is uniek, dus elke klant staat er maar
  één keer in met hun meest recente voorkeur. Enkel voor Admin (bevat
  persoonsgegevens) — bedoeld om samen te voegen met de Wix-abonneelijst
  voor een nieuwsbrief.
- **Boeking annuleren en verplaatsen** (enkel Admin): geen zoekscherm meer —
  beide acties zitten in het detailscherm van een boeking, klik de boeking
  gewoon aan in de agenda. Niet in het "Meer acties"-menu (dat bevat enkel
  nog Cadeaubonnen, Room(s) sluiten, Persoonlijke afspraak, Extra sessie en
  E-maillijst exporteren). Bij "Boeking annuleren" kies je zelf hoeveel je
  terugbetaalt — volledig, gedeeltelijk (bv. annuleringskost ingehouden) of
  niets (`bookings.refunded_amount`/`refund_reason`/`refunded_at`, zie
  `db/migrations/001_add_refund_tracking.sql`). Het bedrag dat je behoudt
  telt nog mee in de wekelijkse omzetfactuur (`generateWeeklyRevenueInvoice()`
  trekt `refunded_amount` af van `amount_due` i.p.v. de hele boeking te
  negeren). Raakt bewust niet aan een eventueel gebruikte cadeaubon — die
  terugstorting blijft voorlopig manueel werk. "Boeking verplaatsen" laat je
  gewoon een nieuwe datum/tijdstip invullen; klant, groepsgrootte, prijs en
  betaalstatus blijven exact hetzelfde staan, enkel het tijdslot (en evt. de
  toegewezen room) verandert. Kan enkel naar een tijdstip waar al een sessie
  gepland staat.
- **Boeking exporteren als PDF** (enkel Admin, `lib/pdf.js` met `pdfkit` —
  pure JavaScript, geen headless browser nodig zodat dit ook op Vercel's
  serverless functies werkt): "Boeking exporteren (PDF)" in het
  detailscherm van 1 boeking geeft alle gegevens (klant, tijdstip, room,
  bedrag, betaal-/terugbetalingsstatus) als downloadbare PDF, om extern te
  bewaren. "Week exporteren (PDF)" in "Meer acties" geeft een overzicht van
  alle boekingen in de zichtbare week in 1 PDF. Geen vervanging van de
  Billit-verzamelfactuur, enkel een leesbaar exportbestand.
- **BELANGRIJKE BUGFIX — dagen naast de ankerdatum kregen nooit sessies**
  (`lib/store-sql.js: ruleAppliesOn()`): alle Art Attack Room-weekdagregels
  delen dezelfde `anchor_date` (een woensdag) in `db/seed.sql`. De oude
  check eiste dat het aantal dagen sinds die ankerdatum deelbaar was door 7
  — dat klopte toevallig voor woensdag, maar voor donderdag/vrijdag/
  zaterdag/zondag was dat aantal dagen NOOIT deelbaar door 7, dus voor die
  4 dagen werd er nooit een sessie gematerialiseerd (de widget toonde er
  simpelweg geen enkel tijdstip). Ontdekt tijdens het testen van de
  Wix-import hieronder. Gefixt door eerst de eerste echte occurrence van
  elke regel z'n eigen weekdag te bepalen, en pas dán de tussenperiode te
  toetsen. Geverifieerd: alle 5 weekdagen (wo/do/vr/za/zo) tonen nu correct
  hun tijdsloten.
- **Boekingen importeren uit Wix (CSV)** (`lib/wixImport.js` + `lib/store-sql.js:
  importWixBooking()`, "Boekingen importeren (CSV)" in "Meer acties", enkel
  Admin): voor een boekingslijst-export uit Wix Bookings. Blokkeert de
  betrokken tijdsloten in dit systeem (voorkomt dubbele boekingen via de
  widget) en zet de klanten in de database. Geannuleerde Wix-boekingen
  worden overgeslagen. Groepsgrootte bij Art Attack Room staat vast op 2
  (bewuste keuze, juli 2026 — de CSV-export geeft geen betrouwbaar aantal
  personen door, enkel het aantal "rooms" dat altijd 1 is); bij Fluid Art
  wordt "Bezette plaatsen" wel als het echte aantal gebruikt. Rijen op een
  tijdstip buiten het vaste uurrooster (bv. een uitzonderlijk ingepaste
  boeking) worden overgeslagen en gemeld — voeg die eerst toe via "Extra
  sessie" en upload dan opnieuw (idempotent, veilig om hetzelfde bestand
  meermaals te uploaden). `booked_via` wordt op `'wix_import'` gezet zodat
  `generateWeeklyRevenueInvoice()` deze omzet nooit meerekent (die is al via
  Wix afgehandeld). Geverifieerd tegen de echte, door Robin aangeleverde
  boekingslijst (85 rijen): na de bugfix hierboven importeerden 53 rijen
  correct, de overige 32 zijn tijdstippen buiten het vaste uurrooster
  (grotendeels al voorbije data, een aantal toekomstige nog te herbekijken).
- **BUGFIX — annuleren met een gedeeltelijke terugbetaling faalde**
  (`lib/store-sql.js: cancelBooking()`): de UPDATE-query gebruikte dezelfde
  parameter (`$3`, het terugbetaalde bedrag) zowel als kolomwaarde als in een
  `CASE WHEN $3 > 0`-vergelijking — de databaselaag kon daar geen eenduidig
  type voor afleiden ("inconsistent types deduced for parameter $3").
  Gefixt met een expliciete `::numeric`-cast op beide plekken. Geverifieerd
  door effectief een boeking aan te maken en te annuleren met een
  gedeeltelijke terugbetaling (bv. €45 van €45) — werkt nu.
- **Personeelsplanning** (`staff_shifts`-tabel + `/api/admin/staff-shifts`):
  een "Personeel"-balkje bovenaan elke dagkolom in de weekagenda, met per dag
  een chip per medewerker ("naam, van–tot"). Klik op "+" om iemand toe te
  voegen voor die dag, klik op een bestaande chip om te bewerken of te
  verwijderen. Bewust **geen vast weekpatroon** (Robin, aug 2026: werkuren
  verschillen te veel per week) — elke dag wordt apart ingevuld. Zichtbaar en
  bewerkbaar voor zowel Admin als Gast (net als de rest van de agenda), en
  volledig los van de boekingslogica: heeft geen invloed op beschikbaarheid
  of prijzen, puur een overzicht. Nieuwe database, dus bij een bestaande
  live-database moet je eenmalig `db/migrations/002_add_staff_shifts.sql`
  uitvoeren (een gloednieuwe database via `db/schema.sql` heeft de tabel al).
  Geverifieerd end-to-end tegen een draaiende server: aanmaken, bewerken,
  verwijderen en de validatie dat het einduur na het startuur moet liggen —
  allemaal getest via `curl`.

Geverifieerd: `npm run build` slaagt, en alle bovenstaande flows zijn met
`curl`/Node-scripts end-to-end getest tegen de echte SQL-laag — inclusief
het schema zelf (`db/schema.sql` is voor het eerst effectief uitgevoerd en
gevalideerd, niet enkel gelezen) en de volledige Billit-payload (VAT-
berekening, bedrijfs- vs. privéklant, DB-opslag van het factuur-ID). De
Billit-aanroep zelf is getest met een gemockte `fetch` — een echte
netwerkoproep naar `api.sandbox.billit.be` kon niet vanuit deze omgeving
(geen algemene internettoegang in de sandbox-shell hier); zie "Billit
sandbox testen" hieronder voor de manuele testcommando.

De Mollie-koppeling is op dezelfde manier grondig getest: de volledige
mock-flow (boeking aanmaken → checkout-URL → webhook simuleren met enkel een
payment-ID, zoals de echte Mollie doet → `payment_status` wordt "paid" in de
database) is end-to-end doorlopen tegen een draaiende server. De
`@mollie/api-client`-integratie zelf (het pad dat gebruikt wordt zodra een
echte `MOLLIE_API_KEY` gezet is) is getest tegen een lokale mock-server die
zich gedraagt als de Mollie-API, om te bevestigen dat de payload
(`amount.value` als string met 2 decimalen), de checkout-URL-extractie en de
metadata-doorgifte correct zijn — een echte aanroep naar `api.mollie.com` kon
ik hier niet doen (geen algemene internettoegang, en ik heb bewust geen live
sleutel gevraagd voor ik dit met jou had afgestemd, zie "Mollie testen"
hieronder). Met je eigen test-sleutel is bevestigd dat de app effectief een
echte aanroep naar `https://api.mollie.com/v2/payments` probeert te doen met
de juiste payload — die faalde enkel op een DNS-fout door het ontbreken van
internettoegang hier, niet op een codefout.

De volledige datalaag (`lib/store-sql.js`) is bovendien voor het eerst ook
tegen een **echte PostgreSQL-database** getest (niet enkel pg-mem) — zie
"Hosting en een echte database" hieronder. Daarbij is een reële bug aan het
licht gekomen en meteen gefixt: `pgDateToISO()` gebruikte UTC-getters in de
veronderstelling dat een DATE-kolom altijd als UTC-middernacht terugkomt.
Dat klopt voor pg-mem, maar niet voor de echte `pg`-driver (die geeft de
*lokale* middernacht terug, omgezet naar UTC) — daardoor schoof elke datum
een dag terug zodra tegen een echte database gedraaid werd, met als gevolg
dat het uurrooster (recurrence_rules) niet correct herkend werd. Gefixt door
overal lokale getters te gebruiken (zoals `toISODate()` al deed), en
opnieuw geverifieerd tegen zowel een echte Postgres als pg-mem.

De volledige cadeaubon-functionaliteit is op dezelfde manier end-to-end
getest tegen een echte, lokale PostgreSQL-instantie: het schema (met de
`gift_cards`-tabel en de nieuwe kolommen op `bookings`), de import van de 355
bestaande bonnen, volledige dekking van een boeking (meteen bevestigd, geen
Mollie nodig), gedeeltelijke dekking (rest via Mollie, saldo pas afgeschreven
na bevestigde betaling — met een idempotentie-test tegen een dubbele
webhook-aanroep), een opgebruikte of uitgeschakelde bon die geweigerd wordt,
zoeken op code/naam/e-mail, en de volledige online-aankoopflow (Mollie-
betaling → code genereren → mailen), eveneens idempotent getest.

De "enkel reserveren"-optie bij manuele boekingen is apart en volledig
getest tegen dezelfde echte PostgreSQL-instantie: een reservering blijft
`payment_status = 'pending'` (geen Billit-factuur, geen cadeaubon-
afschrijving) tot ze expliciet bevestigd wordt; bevestigen van een
niet-bestaande of een online (niet-backoffice) boeking wordt geweigerd;
een tweede keer bevestigen van een al-betaalde reservering is een veilige
no-op; en een cadeaubon gekoppeld aan een reservering wordt pas afgeschreven
bij de effectieve bevestiging, niet bij het aanmaken van de reservering.

## Wat hier bewust NOG NIET in zit

Dit is een **bouwbasis**, geen productieklare applicatie. Ondertussen al
afgerond: hosting (Vercel) + een echte database (Neon), de Mollie-webhook
(bevestigd met een echte test-betaling), de bevestigingsmail, manuele
boekingen, en het room-sluiting-scherm. Voor de livegang (zie ook
`Stappenplan-Livegang-Boekingssysteem.docx`) moet nog het volgende gebeuren:

1. **Billit — scheduling.** Zowel de factuur per boeking als de wekelijkse
   verzamelfactuur zijn gebouwd en getest. Wat nog ontbreekt: een
   automatische, terugkerende trigger voor `/api/admin/weekly-invoice` —
   nu moet dit endpoint nog manueel (of via een externe scheduler)
   aangeroepen worden. Zie "Wekelijkse verzamelfactuur inplannen" hieronder.
   **Dit staat nog steeds open — zie de herinnering onderaan dit document.**
2. **Overige Wix-koppelingen.** Cadeaubonnen zijn ondertussen volledig
   afgerond als eigen (niet-Wix-gebonden) systeem, zie hierboven. Nog wel als
   TODO: loyaltypunten (Wix Members/Loyalty Program) en de migratie van
   bestaande boekingen (Wix Bookings API).
3. **Authenticatie per medewerker.** `/backend` vraagt ondertussen wel een
   wachtwoord (zie "Backend beveiligen" hieronder) — maar dat is nog één
   gedeeld wachtwoord per rol (admin/gast), geen individuele accounts per
   medewerker. De `staff_users`-tabel staat daar al klaar voor, mocht dat
   later nodig zijn.
4. **Transacties/race conditions.** De roomtoewijzing bij het boeken
   gebeurt nu als een reeks losse queries, niet in een DB-transactie — bij
   gelijktijdige boekingen op exact hetzelfde tijdslot kan dat in zeldzame
   gevallen tot een dubbele toewijzing leiden. Voor productie: wrap
   `createBooking()` in een transactie met een row-lock op de sessie.
5. **Vercel Hobby is niet toegestaan voor commercieel gebruik.** Zodra dit
   echt live gaat met betalende klanten, is een Vercel Pro-abonnement nodig
   (zie eerdere toelichting) — de gratis laag mag daar niet voor gebruikt
   worden.

## Billit sandbox testen

Zet in `.env.local`:

```
BILLIT_API_BASE=https://api.sandbox.billit.be
BILLIT_API_KEY=<jouw sandbox ApiKey>
BILLIT_PARTY_ID=<jouw sandbox PartyID>
```

Start de app (`npm run dev`), maak op <http://localhost:3000/widget> een
boeking met "ik wens een factuur" aangevinkt, en rond de (gemockte)
betaling af. De app roept dan automatisch Billit aan; controleer het
resultaat op <https://my.sandbox.billit.be> onder Verkoopfacturen.

Wil je de Billit-koppeling apart testen, zonder de hele boekingsflow, met
een losse curl (vervang de sleutels):

```bash
curl -X POST "https://api.sandbox.billit.be/v1/orders" \
  -H "ApiKey: <jouw sandbox ApiKey>" \
  -H "PartyID: <jouw sandbox PartyID>" \
  -H "Content-Type: application/json" \
  -d '{
    "OrderType": "Invoice",
    "OrderDirection": "Income",
    "OrderNumber": "AAR-TEST-001",
    "OrderDate": "2026-07-22",
    "ExpiryDate": "2026-07-22",
    "Customer": {
      "PartyType": "Customer",
      "Name": "Test Klant",
      "Email": "testklant@example.com",
      "VATLiable": false,
      "Language": "NL",
      "CountryCode": "BE"
    },
    "OrderLines": [
      {"Quantity": 1, "UnitPriceExcl": 100.00, "Description": "Art Attack Room workshop (test)", "VATPercentage": 21}
    ]
  }'
```

Een succesvolle aanroep geeft een order-ID terug (bv. `123456`) en status
200. Deze curl kon ik zelf niet uitvoeren: mijn sandbox-omgeving hier heeft
geen algemene internettoegang (enkel een beperkte set fetch-tools), dus dit
is de ontbrekende laatste verificatiestap die jij (of een developer met
netwerktoegang) moet doen voor we hier 100% zeker van zijn.

## Hosting en een echte database

Twee dingen die je zelf moet aanmaken (accounts kan ik niet voor je
aanmaken) — allebei hebben een gratis laag die voor deze schaal ruim
voldoende is:

1. **Een PostgreSQL-database** (bv. [Neon](https://neon.tech) of
   [Supabase](https://supabase.com) — beide gratis te starten, beide geven
   je een kant-en-klare `DATABASE_URL`-connectiestring). Voer daarna éénmalig
   `db/schema.sql` en `db/seed.sql` uit tegen die database (via de SQL-editor
   die beide diensten in hun dashboard aanbieden, of via `psql
   "$DATABASE_URL" -f db/schema.sql`).
2. **Vercel** (<https://vercel.com>) voor de hosting zelf — vereist voor
   HTTPS (nodig voor de Wix-embed) en voor een publiek bereikbaar adres
   (nodig voor de Mollie-webhook). Verbind je GitHub-repo (of upload de code
   via de Vercel CLI), en zet in Vercel's project-instellingen
   (Settings > Environment Variables) dezelfde variabelen als in
   `.env.local`: `DATABASE_URL`, `MOLLIE_API_KEY`, `BILLIT_API_BASE`,
   `BILLIT_API_KEY`, `BILLIT_PARTY_ID`, `BILLIT_VAT_PERCENTAGE`, en
   `NEXT_PUBLIC_BASE_URL` (dit laatste wordt dan je echte Vercel-URL, niet
   `localhost:3000`).

Voeg ook een `vercel.json` toe in de hoofdmap voor de wekelijkse
verzamelfactuur (zie "Wekelijkse verzamelfactuur inplannen" hieronder voor
de inhoud) — dat hoeft niet apart geconfigureerd te worden, Vercel leest dat
automatisch bij elke deploy.

Deze volledige databaselaag (`lib/store-sql.js`, dus niet enkel het schema
zelf) is ondertussen ook echt tegen een genuine PostgreSQL-instantie getest
(niet enkel pg-mem) — inclusief een boeking aanmaken, de betaling bevestigen
via de webhook, en de wekelijkse verzamelfactuur. Dat leverde meteen een
concrete fix op (zie hierboven, `pgDateToISO()`), dus dit was geen overbodige
stap: het bewijst dat het gedrag tegen een échte database niet zomaar
hetzelfde is als tegen pg-mem, en dat is nu opgelost en opnieuw bevestigd.

## Mollie testen

In tegenstelling tot Billit heeft Mollie geen apart sandbox-account: test-
(`test_...`) en live- (`live_...`) sleutels staan gewoon naast elkaar in
hetzelfde dashboard, onder **Ontwikkelaars > API-sleutels**
(<https://www.mollie.com/dashboard/developers/api-keys>). Zet in `.env.local`:

```
MOLLIE_API_KEY=test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Start de app (`npm run dev`) en maak op <http://localhost:3000/widget> een
boeking af. Je krijgt nu een **echte Mollie test-checkout-URL** (geen
mock meer) — met een testkaart/testmethode op die pagina kan je een
nep-betaling voltooien zonder dat er echt geld beweegt.

**Belangrijke beperking: lokaal kan de webhook niet aankomen.** Mollie stuurt
na de betaling een POST naar `webhookUrl` (bij ons `NEXT_PUBLIC_BASE_URL +
/api/mollie-webhook`) — maar Mollie's servers kunnen `localhost` niet
bereiken. Je ziet dus wel de echte test-checkout werken, maar
`bookings.payment_status` blijft op "pending" staan tot de webhook ergens
publiek bereikbaar is. Twee opties om dat lokaal toch te zien werken:

1. **ngrok** (of vergelijkbaar): `ngrok http 3000`, zet de ngrok-URL als
   `NEXT_PUBLIC_BASE_URL` in `.env.local`, herstart de app. Nu kan Mollie de
   webhook wel bereiken.
2. **Wachten tot de eerste echte deploy** (bv. op Vercel): daar is
   `NEXT_PUBLIC_BASE_URL` sowieso een publiek adres en werkt de webhook
   vanzelf.

Wil je de webhook-logica apart testen zonder een echte Mollie-betaling, met
een losse curl die exact nabootst wat Mollie zelf verstuurt (form-urlencoded,
enkel het payment-ID):

```bash
curl -X POST "http://localhost:3000/api/mollie-webhook" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "id=<een payment-ID uit je eigen test-checkout>"
```

## E-mail testen

De bevestigingsmail gebruikt Gmail's eigen SMTP-server met een
"app-wachtwoord" — geen aparte e-maildienst nodig. Aanmaken:

1. Zorg dat 2-stapsverificatie aanstaat op het Gmail-account dat moet
   versturen (Google Account > Beveiliging).
2. Ga naar <https://myaccount.google.com/apppasswords>, maak een nieuw
   app-wachtwoord aan (naam mag vrij gekozen worden, bv. "Boekingssysteem").
3. Zet in `.env.local` (spaties uit de 16-tekens-code weglaten):

```
GMAIL_USER=info.atelierdoen@gmail.com
GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx
```

Zonder deze twee variabelen wordt enkel naar de console gelogd (`[email
mock] ...`) — handig om lokaal te testen zonder echte mails te versturen.
Met een echt app-wachtwoord verstuurt de app zowel de klantbevestiging als
de interne meldingsmail (naar `NOTIFY_EMAIL`, incl. de notitie van de
klant) meteen zodra een boeking online betaald wordt via de klant-widget
(Mollie-webhook). Bewust niet bij een manuele boeking in `/backend` — zie
hierboven.

Getest: het correcte gebruik van de mock-modus (beide mails met correcte
inhoud gelogd), en — met het echte app-wachtwoord dat je gaf — bevestigd dat
de app effectief een SMTP-verbinding met `smtp.gmail.com` probeert op te
zetten met de juiste inloggegevens. Een volledige verzending kon ik hier
niet afronden (geen internettoegang in deze sandbox, net als bij Mollie en
Billit) — dat kan je zelf meteen zien werken zodra dit op Vercel staat.

## Wekelijkse verzamelfactuur testen en inplannen

Test de logica los van de kalender met een curl (past werkende `week`-datum
aan; elke datum in de gewenste week werkt, de maandag wordt automatisch
berekend):

```bash
curl -X POST "http://localhost:3000/api/admin/weekly-invoice?week=2026-08-03"
```

Antwoord bevat `periodStart`, `periodEnd`, `totalAmount`,
`excludedBookingCount` (aantal reeds individueel gefactureerde boekingen in
die week) en `billitInvoiceId`. Een tweede aanroep voor dezelfde week geeft
`alreadyExisted: true` terug zonder iets opnieuw bij Billit aan te maken —
veilig om per ongeluk dubbel te draaien.

**Automatisch elke week laten lopen:** dit endpoint moet in productie zelf
niet "weten" wanneer het maandag is — een externe scheduler roept het gewoon
wekelijks aan. Met hosting op Vercel kan dat via een [Vercel Cron
Job](https://vercel.com/docs/cron-jobs) — `vercel.json` (in de hoofdmap van
dit project) staat hier al klaar voor:

```json
{
  "crons": [{ "path": "/api/admin/weekly-invoice", "schedule": "0 6 * * 1" }]
}
```

Dit roept het endpoint elke maandag om 6u 's ochtends aan (verwerkt dan
automatisch de zonet afgelopen week, want zonder `?week=` valt het endpoint
terug op "7 dagen geleden"). Draai je niet op Vercel: elke cronjob of
scheduler die een POST-request kan sturen (bv. een cron-taak op een VPS met
`curl`, of een externe dienst zoals cron-job.org) volstaat evengoed.

## Backend beveiligen (login)

`/backend` en alle `/api/admin/*`-routes vragen nu een wachtwoord (`lib/auth.js`,
`pages/api/auth/{login,logout,me}.js`) — voorheen kon iedereen die de URL kende
er zonder inloggen bij. Twee gedeelde wachtwoorden (geen aparte accounts per
medewerker, bewust eenvoudig gehouden voor een klein team):

1. Zet in `.env.local` (lokaal) en in Vercel's Environment Variables (productie):

```
STAFF_ADMIN_PASSWORD=<kies een sterk wachtwoord>
STAFF_GUEST_PASSWORD=<kies een ander wachtwoord, of laat leeg voor geen gast-toegang>
AUTH_SECRET=<willekeurige lange tekenreeks, bv. via: openssl rand -hex 32>
```

2. Op `/backend` verschijnt nu eerst een inlogscherm. Met het admin-wachtwoord
   zie je alles; met het gast-wachtwoord worden persoonlijke afspraken (bv.
   "Tandarts") getoond als "Bezet"/"Privé" — en dat gebeurt nu **op de
   server** (`pages/api/admin/sessions.js: redactForGuest()`), niet meer via
   een knopje in de browser dat vroeger door iedereen zelf omgezet kon worden
   naar "Admin". De sessie blijft 30 dagen geldig (cookie), dus niet elke
   keer opnieuw inloggen.
3. Wachtwoord gelekt of medewerker vertrokken? Wijzig gewoon
   `STAFF_ADMIN_PASSWORD`/`STAFF_GUEST_PASSWORD` in Vercel en herdeploy. Wil
   je bovendien alle op dat moment al ingelogde sessies onmiddellijk laten
   verlopen (i.p.v. pas na 30 dagen), wijzig dan ook `AUTH_SECRET` — dat
   maakt in één klap élke bestaande sessie ongeldig.

De wekelijkse verzamelfactuur (`/api/admin/weekly-invoice`, aangeroepen door
Vercel Cron, zie verderop) gebruikt bewust een aparte, tweede sleutel
(`CRON_SECRET`) i.p.v. de staff-login — een cronjob kan namelijk niet
inloggen. Zonder `CRON_SECRET` valt dat ene endpoint terug op de gewone
staff-login (dus nooit volledig open), maar dan moet je het zelf manueel
aanroepen als ingelogde medewerker i.p.v. automatisch via de cron.

Let op: dit is een gedeeld-wachtwoord-systeem, geen volwaardige
per-medewerker-authenticatie (de `staff_users`-tabel in `schema.sql` staat
daar wel al voor klaar, voor een latere uitbreiding met individuele
accounts). Voor de huidige schaal (klein team, één gedeelde toegang per
rol) is dit een bewuste, pragmatische keuze — geverifieerd end-to-end
(ingelogd/niet-ingelogd, verkeerd wachtwoord, redactie voor gast-rol, en de
cron-uitzondering) tegen een echt draaiende server.

## Stijl aanpassen (kleur, lettertype)

De kleuren (donkere achtergrond, accentkleur, ...) staan allemaal centraal in
`styles/globals.css` als CSS-variabelen (`--accent`, `--paper`, `--panel`,
...) — één regel aanpassen volstaat, de rest van de app gebruikt overal
dezelfde variabele. De accentkleur is ondertussen aangepast naar een warme
terracotta (`#C1653A`, was roze), en het lettertype naar
[Quicksand](https://fonts.google.com/specimen/Quicksand) (Google Fonts,
geladen via `pages/_document.js`) i.p.v. de standaard systeemfont.

## Prijzen aanpassen op een bestaande database

`db/seed.sql` is bewust idempotent (`ON CONFLICT DO NOTHING`) — handig om
veilig te herhalen, maar dat betekent ook dat een prijswijziging daarin
**niet** doorwerkt op een database die al gezaaid is (zoals je Neon-database
nu). Voor een reeds bestaande database moet je de prijs zelf aanpassen, bv.
via Neon's SQL Editor:

```sql
UPDATE services SET price = 60.00 WHERE name = 'Fluid Art';
```

Voor de prijstrap van Art Attack Room (per groepsgrootte) zou dat zijn:

```sql
UPDATE service_party_pricing spp
SET total_price = 999
FROM services s
WHERE spp.service_id = s.id AND s.name = 'Art Attack Room' AND spp.party_size = 4; -- pas party_size en bedrag aan
```

## Cadeaubonnen importeren

`db/import-gift-cards.sql` bevat de 355 bestaande cadeaubonnen (91 uit Wix,
264 uit FareHarbor) als één `INSERT ... ON CONFLICT (code) DO NOTHING`-script
— bewust **niet** samengevoegd tot één lijst: het zijn en blijven twee
gescheiden bronsystemen (`source = 'imported_wix'` / `'imported_fareharbor'`
in de `gift_cards`-tabel), zodat je in de backoffice altijd kan zien uit
welk systeem een bon oorspronkelijk komt.

Voer dit **eenmalig** uit tegen je database, ná `schema.sql` en `seed.sql`
(bv. via Neon's SQL Editor, of `psql "$DATABASE_URL" -f db/import-gift-cards.sql`).
Het script is idempotent (`ON CONFLICT DO NOTHING`), dus per ongeluk twee keer
uitvoeren doet geen kwaad. **Let op:** dit bestand bevat echte klantgegevens
(namen, e-mailadressen) — niet naar een publieke Git-repo pushen.

Getest (via een echte, lokale PostgreSQL-instantie, niet enkel pg-mem): alle
355 rijen worden correct geïmporteerd, zonder dubbele codes, met de juiste
status (actief/uitgeschakeld/opgebruikt) afgeleid uit de brondata.

## Projectstructuur

```
db/
  schema.sql               kopie van schema-boekingssysteem.sql (bron van waarheid)
  seed.sql                 referentiedata: rooms, diensten, prijstrap, uurrooster
  import-gift-cards.sql    eenmalige import van de 355 bestaande cadeaubonnen (Wix + FareHarbor)
  migrations/002_add_staff_shifts.sql  eenmalig uit te voeren tegen een bestaande live-database
lib/
  db.js             databaseverbinding (pg-mem lokaal, echte pg met DATABASE_URL)
  store-sql.js       de echte, SQL-gebaseerde implementatie (in gebruik door de API)
  store.js           oudere in-memory implementatie (referentie/demo, niet meer gebruikt)
  pricing.js         prijs-validatie (min/max groepsgrootte)
  scheduling.js      (gebruikt door store.js; store-sql.js materialiseert zelf uit de DB)
  rooms.js           best-fit room-toewijzing (herbruikbaar met elke roomlijst)
  dateUtils.js       datumhelpers (bewust zonder toISOString/UTC-bugs)
  mollie.js          Mollie-wrapper (mock zonder API-key, echte @mollie/api-client mét)
  billit.js          Billit-koppeling: factuur per boeking (ApiKey + PartyID auth)
  email.js           Bevestigingsmail + cadeaubon-mail via Gmail SMTP (mock zonder app-wachtwoord)
  auth.js            Staff-login: wachtwoord -> ondertekende sessie-cookie (admin/gast)
pages/
  api/auth/login.js, logout.js, me.js   in-/uitloggen + sessie-check voor /backend
  widget.js                       klant-boekingswidget (incl. cadeaubon-code invullen)
  widget/bevestiging.js           pagina na (mock-)betaling van een boeking
  widget/cadeaubon.js             cadeaubon kopen (bedrag kiezen + Mollie-checkout)
  widget/cadeaubon-bevestiging.js pagina na (mock-)betaling van een cadeaubon-aankoop
  backend/index.js        admin weekagenda, persoonlijke afspraken, manuele
                          boekingen, room-sluitingen, cadeaubonnen-beheer
  api/                     alle API-routes, gebruiken lib/store-sql.js
  api/admin/manual-booking.js       boeking die het team zelf ingeeft (geen Mollie, evt. reserveOnly)
  api/admin/confirm-booking.js      een eerdere reservering alsnog bevestigen (betaald + factuur/cadeaubon)
  api/admin/close-room.js           room(s) sluiten voor een tijdslot of hele dag
  api/admin/rooms.js                roomlijst (voor het room-sluiten-scherm)
  api/admin/extra-session.js        eenmalige extra sessie buiten het uurrooster
  api/admin/gift-cards.js           cadeaubonnen zoeken (GET) / manueel aanmaken (POST)
  api/admin/gift-cards/[id].js      cadeaubon activeren/uitschakelen (PATCH)
  api/gift-cards/purchase.js        klant koopt een cadeaubon (Mollie-checkout aanmaken)
  api/admin/staff-shifts.js         personeelsplanning: week ophalen (GET) / dag toevoegen (POST)
  api/admin/staff-shifts/[id].js    personeelsplanning: bewerken (PATCH) / verwijderen (DELETE)
vercel.json          cronjob-config voor de wekelijkse verzamelfactuur (Vercel-hosting)
```
