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
- **Room-sluitingen** (`lib/store-sql.js: closeRoom()`): een individuele
  room of alle rooms sluiten voor een tijdslot of een volledige dag,
  weggeschreven als `room_bookings` met `block_type = 'closed'`. Nog geen
  scherm in `/backend` om dit te bedienen (zie hieronder).
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

## Wat hier bewust NOG NIET in zit

Dit is een **bouwbasis**, geen productieklare applicatie. Voor de livegang
(zie ook `Stappenplan-Livegang-Boekingssysteem.docx`) moet nog het volgende
gebeuren:

1. **Echte PostgreSQL-database + hosting.** Lokaal draait alles nog op
   pg-mem (in-memory, verdwijnt bij herstart — prima om te testen, niet voor
   productie). Zie "Hosting en een echte database" hieronder voor de
   concrete stappen (Neon/Supabase + Vercel) — dit is de eerstvolgende stap.
2. **Mollie — webhook nog niet in het echt gezien.** Je test-sleutel staat
   klaar en de koppeling is grondig getest (zie hierboven), maar Mollie kan
   niet naar `localhost` webhooken — dat kan pas écht getest worden zodra de
   app publiek bereikbaar is (via hosting, zie hieronder, of ngrok).
3. **Billit — scheduling.** Zowel de factuur per boeking als de wekelijkse
   verzamelfactuur zijn gebouwd en getest. Wat nog ontbreekt: een
   automatische, terugkerende trigger voor `/api/admin/weekly-invoice` —
   nu moet dit endpoint nog manueel (of via een externe scheduler)
   aangeroepen worden. Zie "Wekelijkse verzamelfactuur inplannen" hieronder.
4. **Wix-koppelingen.** Cadeaubonnen (Wix Gift Cards), loyaltypunten (Wix
   Members/Loyalty Program) en de migratie van bestaande boekingen (Wix
   Bookings API) staan nog als TODO in de code.
5. **E-mail.** De bevestigingsmail (incl. notitie) naar
   info.atelierdoen@gmail.com is nog niet aangesloten — zie de TODO's in
   `pages/api/mollie-webhook.js`.
6. **Authenticatie.** De rolwissel admin/gast in `/backend` is nu een
   simpele knop zonder login — er is nog geen echte gebruikersauthenticatie
   per medewerker (tabel `staff_users` bestaat al in het schema).
7. **Room-sluiting-scherm.** De logica (`closeRoom()`) bestaat, maar nog
   geen knop/scherm in `/backend` om dit te bedienen.
8. **Transacties/race conditions.** De roomtoewijzing bij het boeken
   gebeurt nu als een reeks losse queries, niet in een DB-transactie — bij
   gelijktijdige boekingen op exact hetzelfde tijdslot kan dat in zeldzame
   gevallen tot een dubbele toewijzing leiden. Voor productie: wrap
   `createBooking()` in een transactie met een row-lock op de sessie.
9. **Hosting.** Voor de Wix-embed is HTTPS-hosting nodig (bv. Vercel) —
   `next.config.js` staat al klaar om in een iframe geladen te worden
   (`X-Frame-Options: ALLOWALL` op de `/widget`-route).

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

## Projectstructuur

```
db/
  schema.sql        kopie van schema-boekingssysteem.sql (bron van waarheid)
  seed.sql          referentiedata: rooms, diensten, prijstrap, uurrooster
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
pages/
  widget.js               klant-boekingswidget
  widget/bevestiging.js   pagina na (mock-)betaling
  backend/index.js        admin weekagenda + persoonlijke afspraken
  api/                     alle API-routes, gebruiken lib/store-sql.js
vercel.json          cronjob-config voor de wekelijkse verzamelfactuur (Vercel-hosting)
```
