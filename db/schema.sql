-- =========================================================
-- Boekingssysteem workshops - datamodel (PostgreSQL)
-- v3: rooms + automatische toewijzing, cadeaubonnen/loyalty,
--     facturatie (Billit), klant-zelfservice, Wix-koppelingen
-- =========================================================

CREATE TYPE service_type AS ENUM ('group_session', 'private');
CREATE TYPE session_status AS ENUM ('scheduled', 'cancelled', 'completed');
CREATE TYPE booking_status AS ENUM ('confirmed', 'cancelled', 'rescheduled', 'waitlist', 'no_show');
CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'failed', 'refunded');
CREATE TYPE room_block_type AS ENUM ('booking', 'closed');
CREATE TYPE discount_type AS ENUM ('gift_voucher', 'loyalty_points', 'promo_code');
CREATE TYPE staff_role AS ENUM ('admin', 'guest');
CREATE TYPE session_visibility AS ENUM ('standard', 'private');
CREATE TYPE session_kind AS ENUM ('service', 'personal');

-- ---------------------------------------------------------
-- Back-end gebruikers (medewerkers), niet te verwarren met customers.
-- admin  = volledige toegang, incl. privé-afspraken.
-- guest  = volledige toegang tot de agenda en boekingen, BEHALVE
--          de details van sessions/bookings met visibility = 'private':
--          die tonen voor een guest enkel het tijdslot als "bezet".
-- ---------------------------------------------------------
CREATE TABLE staff_users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name   TEXT NOT NULL,
    email       TEXT NOT NULL UNIQUE,
    role        staff_role NOT NULL DEFAULT 'guest',
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------
-- Rooms (fysieke ruimtes in het pand)
-- Enkel relevant voor diensten met uses_room_assignment = true.
-- ---------------------------------------------------------
CREATE TABLE rooms (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        TEXT NOT NULL UNIQUE,     -- 'A', 'M', 'VL', 'VR'
    name        TEXT,
    capacity    INT NOT NULL,             -- A=10, M=5, VL=7, VR=7
    is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---------------------------------------------------------
-- Diensten / workshops (het "aanbod")
-- ---------------------------------------------------------
CREATE TABLE services (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                    TEXT NOT NULL,                 -- "Fluid Art", "Art Attack Room"
    type                    service_type NOT NULL,
    description             TEXT,                          -- later aan te vullen
    photo_urls              TEXT[],                        -- later aan te vullen
    duration_minutes        INT NOT NULL,                  -- 90 voor Art Attack Room
    buffer_minutes          INT NOT NULL DEFAULT 0,         -- 60 voor Art Attack Room (opkuis/wissel)
    price                   NUMERIC(8,2),                    -- prijs per persoon; enkel gebruikt wanneer er GEEN service_party_pricing is (bv. Fluid Art = 45/pers)
    default_capacity        INT NOT NULL,                   -- enkel gebruikt als uses_room_assignment = false (10 voor Fluid Art)
    uses_room_assignment    BOOLEAN NOT NULL DEFAULT FALSE,  -- true voor Art Attack Room
    min_online_party_size   INT NOT NULL DEFAULT 1,          -- 2 voor Art Attack Room (geen boeking als "1")
    max_online_party_size   INT,                             -- 7 voor Art Attack Room; groter = enkel via contact
    is_active               BOOLEAN NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------
-- Totaalprijs per groepsgrootte (bv. Art Attack Room).
-- Vervangt een vlakke "prijs per persoon" door een prijstrap:
-- 2p=120, 3p=174, 4p=220, 5p=265, 6p=312, 7p=364.
-- Ontbreekt een groepsgrootte hier voor een service, dan valt
-- de applicatie terug op services.price * aantal personen.
-- ---------------------------------------------------------
CREATE TABLE service_party_pricing (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id  UUID NOT NULL REFERENCES services(id),
    party_size  INT NOT NULL,
    total_price NUMERIC(8,2) NOT NULL,
    UNIQUE (service_id, party_size)
);

-- ---------------------------------------------------------
-- Terugkerende patronen
-- Bv. Art Attack Room woensdag 14u/16u30/19u (interval_weeks=1),
-- donderdag zelfde uren maar met end_date = 2026-08-31 (vakantiestop),
-- Fluid Art dinsdag 19u met interval_weeks=2.
-- ---------------------------------------------------------
CREATE TABLE recurrence_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id      UUID NOT NULL REFERENCES services(id),
    weekday         INT NOT NULL,          -- 0=maandag .. 6=zondag
    start_time      TIME NOT NULL,
    interval_weeks  INT NOT NULL DEFAULT 1,
    anchor_date     DATE NOT NULL,
    end_date        DATE,                  -- NULL = voorlopig onbeperkt; bv. 2026-08-31 voor donderdag
    active          BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---------------------------------------------------------
-- Concrete sessies / tijdsloten op de kalender (Google Agenda-achtig
-- weekoverzicht in de back-end, zie prototype-backend-boekingen.html).
--
-- kind = 'service'  -> een workshop-tijdslot, gekoppeld aan services.
-- kind = 'personal' -> een eigen, persoonlijke afspraak (bv. "Dokter"),
--                      NIET gekoppeld aan een service, NOOIT een prijs
--                      of klant, en altijd visibility = 'private'.
-- ---------------------------------------------------------
CREATE TABLE sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind                session_kind NOT NULL DEFAULT 'service',
    service_id          UUID REFERENCES services(id),           -- NULL wanneer kind = 'personal'
    title               TEXT,                                    -- titel voor personal-afspraken (bv. "Dokter"), of override-naam bij een privé-boeking
    recurrence_rule_id  UUID REFERENCES recurrence_rules(id),  -- NULL = handmatig/eenmalig toegevoegd
    start_datetime      TIMESTAMPTZ NOT NULL,
    end_datetime        TIMESTAMPTZ NOT NULL,                  -- inclusief buffer_minutes
    capacity            INT,                    -- enkel gebruikt wanneer service.uses_room_assignment = false
    status              session_status NOT NULL DEFAULT 'scheduled',
    visibility          session_visibility NOT NULL DEFAULT 'standard', -- 'private' = voor guest-rol enkel zichtbaar als "bezet"; kind='personal' is altijd 'private'
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_session_kind_service CHECK (
        (kind = 'service' AND service_id IS NOT NULL) OR
        (kind = 'personal' AND service_id IS NULL)
    )
);

CREATE INDEX idx_sessions_service ON sessions(service_id);
CREATE INDEX idx_sessions_start ON sessions(start_datetime);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_kind ON sessions(kind);

-- Belangrijk: een 'personal' sessie heeft NOOIT een rij in bookings/payments.
-- Het is enkel een geblokkeerd tijdslot in de agenda (geen klant, geen prijs).

-- ---------------------------------------------------------
-- Klanten
-- Gekoppeld aan het Wix-ledenaccount voor loyaltypunten.
-- ---------------------------------------------------------
CREATE TABLE customers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name           TEXT NOT NULL,
    email               TEXT NOT NULL UNIQUE,
    phone               TEXT,
    birth_date          DATE,                              -- voor verjaardagsmail
    marketing_opt_in    BOOLEAN NOT NULL DEFAULT TRUE,      -- default aangevinkt bij boeking (bewust gekozen, zie voorstel §8)
    terms_accepted_at   TIMESTAMPTZ,                        -- moment van akkoord algemene voorwaarden
    wix_member_id       TEXT,                               -- koppeling met Wix Members / Loyalty Program
    loyalty_points       INT NOT NULL DEFAULT 0,             -- lokale cache; bron van waarheid is Wix Loyalty
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------
-- Boekingen: 1 rij per reservatie (= 1 groep) op een sessie
-- ---------------------------------------------------------
CREATE TABLE bookings (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id              UUID NOT NULL REFERENCES sessions(id),
    customer_id             UUID NOT NULL REFERENCES customers(id),
    party_size              INT NOT NULL DEFAULT 1,
    customer_note            TEXT,                            -- vrij invulveld door de klant (wensen, verjaardag, allergieën, ...)
    status                  booking_status NOT NULL DEFAULT 'confirmed',
    subtotal_amount         NUMERIC(8,2) NOT NULL,           -- vóór korting
    discount_amount         NUMERIC(8,2) NOT NULL DEFAULT 0,
    amount_due              NUMERIC(8,2) NOT NULL,           -- subtotal_amount - discount_amount
    payment_status          payment_status NOT NULL DEFAULT 'pending',
    booked_via              TEXT NOT NULL DEFAULT 'website', -- 'website' of 'backoffice'
    external_wix_booking_id TEXT,                            -- referentie bij migratie vanuit Wix Bookings
    rescheduled_from_id     UUID REFERENCES bookings(id),    -- vorige boeking bij zelf verzetten (tot 72u vooraf)
    invoice_requested       BOOLEAN NOT NULL DEFAULT FALSE,
    invoice_vat_number      TEXT,
    invoice_company_name    TEXT,
    invoice_company_address TEXT,
    billit_invoice_id       TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bookings_session ON bookings(session_id);
CREATE INDEX idx_bookings_customer ON bookings(customer_id);

-- ---------------------------------------------------------
-- Kortingen: cadeaubon (Wix), loyaltypunten of promocode
-- Eén boeking kan meerdere toepassingen hebben (zelden), vandaar
-- een aparte tabel i.p.v. enkel een code-veld op bookings.
-- ---------------------------------------------------------
CREATE TABLE discount_redemptions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id  UUID NOT NULL REFERENCES bookings(id),
    type        discount_type NOT NULL,
    code        TEXT,                       -- cadeaubon- of promocode; NULL bij loyalty_points
    points_used INT,                        -- enkel bij type = 'loyalty_points' (bv. 10)
    amount      NUMERIC(8,2) NOT NULL,       -- effectief kortingsbedrag
    validated_via TEXT,                     -- 'wix_gift_card_api', 'wix_loyalty_api', 'manual'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------
-- Roomtoewijzing per sessie (enkel voor Art Attack Room)
-- ---------------------------------------------------------
CREATE TABLE room_bookings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID NOT NULL REFERENCES sessions(id),
    room_id     UUID NOT NULL REFERENCES rooms(id),
    booking_id  UUID REFERENCES bookings(id),   -- NULL wanneer block_type = 'closed'
    block_type  room_block_type NOT NULL DEFAULT 'booking',
    reason      TEXT,                            -- bv. "Sluitingsdag", "Prive - volledige verhuur"
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, room_id)
);

CREATE INDEX idx_room_bookings_session ON room_bookings(session_id);

-- ---------------------------------------------------------
-- Betalingen (Mollie)
-- ---------------------------------------------------------
CREATE TABLE payments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id          UUID NOT NULL REFERENCES bookings(id),
    amount              NUMERIC(8,2) NOT NULL,
    provider             TEXT NOT NULL DEFAULT 'mollie',
    provider_payment_id TEXT,
    status              payment_status NOT NULL DEFAULT 'pending',
    paid_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------
-- Wekelijkse verzamelfactuur (Billit)
-- Boekt de omzet van een week in als één factuur, exclusief
-- de bedragen die al individueel gefactureerd werden
-- (bookings.invoice_requested = true en al gekoppeld aan billit_invoice_id).
-- ---------------------------------------------------------
CREATE TABLE weekly_revenue_invoices (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_start        DATE NOT NULL,
    period_end          DATE NOT NULL,
    total_amount         NUMERIC(10,2) NOT NULL,   -- som van amount_due, exclusief individueel gefactureerde boekingen
    excluded_booking_count INT NOT NULL DEFAULT 0,
    billit_invoice_id   TEXT,
    generated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------
-- Beschikbare rooms per sessie (enkel diensten met roomtoewijzing)
-- ---------------------------------------------------------
CREATE VIEW room_availability_per_session AS
SELECT
    s.id AS session_id,
    s.service_id,
    s.start_datetime,
    r.id AS room_id,
    r.code AS room_code,
    r.capacity AS room_capacity,
    (rb.id IS NULL) AS is_available
FROM sessions s
JOIN services sv ON sv.id = s.service_id AND sv.uses_room_assignment = TRUE
JOIN rooms r ON TRUE
LEFT JOIN room_bookings rb ON rb.session_id = s.id AND rb.room_id = r.id
WHERE r.is_active = TRUE AND s.status = 'scheduled';

-- Toewijzingslogica (applicatiecode, niet SQL):
--   1. Klant geeft groepsgrootte op; > max_online_party_size -> verwijs naar contact/mail.
--   2. Filter room_availability_per_session op is_available = true AND room_capacity >= groepsgrootte.
--   3. Toon een tijdslot enkel als er minstens 1 zo'n room overblijft.
--   4. Bij bevestiging: wijs de kleinst passende vrije room toe (best fit).

-- ---------------------------------------------------------
-- Back-office overzicht: 1 rij per boeking
-- ---------------------------------------------------------
CREATE VIEW backoffice_bookings_overview AS
SELECT
    b.id AS booking_id,
    sv.name AS service_name,
    s.start_datetime,
    c.full_name AS customer,
    c.email,
    b.party_size,
    b.customer_note,
    string_agg(DISTINCT r.code, ', ') AS assigned_rooms,
    b.subtotal_amount,
    b.discount_amount,
    b.amount_due,
    b.payment_status,
    b.status AS booking_status,
    b.booked_via,
    b.invoice_requested
FROM bookings b
JOIN sessions s ON s.id = b.session_id
JOIN services sv ON sv.id = s.service_id
JOIN customers c ON c.id = b.customer_id
LEFT JOIN room_bookings rb ON rb.booking_id = b.id
LEFT JOIN rooms r ON r.id = rb.room_id
GROUP BY b.id, sv.name, s.start_datetime, c.full_name, c.email, b.party_size, b.customer_note,
         b.subtotal_amount, b.discount_amount, b.amount_due, b.payment_status,
         b.status, b.booked_via, b.invoice_requested
ORDER BY s.start_datetime;

-- Toegang voor de guest-rol: de applicatie (niet deze view) filtert de
-- kolommen hierboven weg wanneer s.visibility = 'private' en de ingelogde
-- staff_user.role = 'guest' -- die ziet dan enkel start_datetime en dat
-- het tijdslot bezet is, de rest wordt vervangen door "Privé". Dit kan
-- ook afgedwongen worden met Postgres Row-Level Security op deze tabellen,
-- gekoppeld aan de rol van de ingelogde staff_user.

-- ---------------------------------------------------------
-- Analytics: omzet, gemiddelde waarde en piekmomenten
-- ---------------------------------------------------------
CREATE VIEW analytics_revenue_by_week AS
SELECT
    date_trunc('week', s.start_datetime)::date AS week_start,
    sv.name AS service_name,
    COUNT(b.id) AS bookings_count,
    SUM(b.amount_due) FILTER (WHERE b.payment_status = 'paid') AS revenue,
    ROUND(AVG(b.amount_due) FILTER (WHERE b.payment_status = 'paid'), 2) AS avg_booking_value
FROM bookings b
JOIN sessions s ON s.id = b.session_id
JOIN services sv ON sv.id = s.service_id
WHERE b.status = 'confirmed'
GROUP BY 1, 2
ORDER BY 1 DESC;

CREATE VIEW analytics_peak_times AS
SELECT
    EXTRACT(DOW FROM s.start_datetime) AS weekday,       -- 0=zondag .. 6=zaterdag (Postgres-conventie)
    to_char(s.start_datetime, 'HH24:MI') AS start_time,
    sv.name AS service_name,
    COUNT(b.id) AS bookings_count,
    SUM(b.party_size) AS total_guests
FROM bookings b
JOIN sessions s ON s.id = b.session_id
JOIN services sv ON sv.id = s.service_id
WHERE b.status = 'confirmed'
GROUP BY 1, 2, 3
ORDER BY bookings_count DESC;

-- ---------------------------------------------------------
-- Seed data (voorbeeld)
-- ---------------------------------------------------------
-- INSERT INTO rooms (code, capacity) VALUES
--   ('A', 10), ('M', 5), ('VL', 7), ('VR', 7);
--
-- INSERT INTO service_party_pricing (service_id, party_size, total_price) VALUES
--   (<attack_room_id>, 2, 120), (<attack_room_id>, 3, 174), (<attack_room_id>, 4, 220),
--   (<attack_room_id>, 5, 265), (<attack_room_id>, 6, 312), (<attack_room_id>, 7, 364);
--
-- Art Attack Room recurrence_rules (voorbeeld, service_id in te vullen):
--   woensdag  14:00, 16:30, 19:00   (interval_weeks=1, end_date=NULL)
--   donderdag 14:00, 16:30, 19:00   (interval_weeks=1, end_date='2026-08-31')
--   vrijdag   13:30, 16:00          (interval_weeks=1, end_date=NULL)
--   zaterdag  11:00, 13:30, 16:00   (interval_weeks=1, end_date=NULL)
--   zondag    11:00, 13:30, 16:00   (interval_weeks=1, end_date=NULL)
-- Fluid Art: dinsdag 19:00, interval_weeks=2
