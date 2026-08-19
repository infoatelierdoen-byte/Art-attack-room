-- Migratie: uurrooster Action Painting bijwerken (Robin, aug 2026)
--
-- Het afgesproken rooster:
--   woensdag        14:00, 16:30, 19:00
--   donderdag       t.e.m. 31/08/2026: 13:30, 16:00 en 18:30
--                   vanaf 01/09/2026: nog één sessie, om 18:30
--   vrijdag         14:00, 16:30
--   zaterdag        11:00, 13:30, 16:00
--   zondag          11:00, 13:30, 16:00
--
-- Fluid Art blijft tweewekelijks op dinsdag 19:00, maar de reeks stond een week
-- verkeerd: de ankerdatum wordt 18/08/2026, de dinsdag waarop de workshop
-- effectief doorging. De reeks loopt dus 18/08, 01/09, 15/09, ...
--
-- BELANGRIJK: enkel nodig op je LIVE database. Een nieuwe database via
-- db/schema.sql + db/seed.sql heeft dit rooster al staan.
-- Veilig om opnieuw te draaien.
--
-- Uitvoeren via de Neon SQL-editor, of met:
--   psql "$DATABASE_URL" -f db/migrations/006_update_schedule.sql

-- ===========================================================================
-- VERPLICHT — tijdzone vastzetten voor deze sessie.
-- ===========================================================================
-- start_datetime is een TIMESTAMPTZ. Een cast als ::time of ::date rekent dat
-- eerst om naar de tijdzone-instelling van de SERVER, niet naar die van de
-- applicatie. Neon staat standaard op UTC; dan geeft een sessie van 13:30
-- Brusselse tijd bij ::time gewoon 11:30 terug, matcht geen enkele vergelijking
-- hieronder, en beschouwt de migratie ELKE sessie als "buiten het rooster".
-- Getest: op UTC zou deze migratie 37 van de 37 toekomstige sessies als fout
-- aanmerken, op Europe/Brussels 0 van de 37.
--
-- SET TIME ZONE geldt enkel voor deze verbinding en verandert niets aan de
-- database zelf.
SET TIME ZONE 'Europe/Brussels';

--
-- ===========================================================================
-- LEES DIT EERST — draai stap 0 apart en bekijk het resultaat.
-- ===========================================================================
-- Sessies worden "gematerialiseerd": zodra een datum ooit opgevraagd is, staat
-- er een echte rij in `sessions`. Het aanpassen van een regel hieronder
-- verandert die bestaande rijen NIET. Daarom ruimt stap 3 toekomstige sessies
-- op die niet meer in het nieuwe rooster passen — maar uitsluitend als er geen
-- boeking en geen room-blokkade aan hangt.
--
-- Sessies met een boeking blijven staan, ook al passen ze niet meer in het
-- rooster. Stap 0 toont ze, zodat je die klanten zelf kan verwittigen of de
-- boeking kan verplaatsen. Er verdwijnt dus nooit stilzwijgend een boeking.

-- ---------------------------------------------------------------------------
-- STAP 0 (LEZEN) — welke geboekte sessies vallen buiten het nieuwe rooster?
-- Verandert niets. Geeft dit rijen terug, verplaats die boekingen dan eerst
-- vanuit de backoffice, of verwittig de klanten.
-- ---------------------------------------------------------------------------
SELECT
  s.start_datetime,
  to_char(s.start_datetime, 'Dy DD/MM/YYYY HH24:MI') AS wanneer,
  c.full_name  AS klant,
  c.email      AS email,
  b.party_size AS personen
FROM sessions s
JOIN bookings  b ON b.session_id = s.id AND b.status NOT IN ('cancelled', 'rescheduled')
JOIN customers c ON c.id = b.customer_id
JOIN services sv ON sv.id = s.service_id
WHERE sv.name = 'Action Painting'
  AND s.start_datetime >= now()
  AND NOT (
    -- woensdag
    (EXTRACT(ISODOW FROM s.start_datetime) = 3 AND s.start_datetime::time IN ('14:00','16:30','19:00'))
    -- donderdag: zomerrooster t.e.m. 31/08, daarna enkel 18:30
    OR (EXTRACT(ISODOW FROM s.start_datetime) = 4 AND s.start_datetime::date <= '2026-08-31'
        AND s.start_datetime::time IN ('13:30','16:00','18:30'))
    OR (EXTRACT(ISODOW FROM s.start_datetime) = 4 AND s.start_datetime::date >= '2026-09-01'
        AND s.start_datetime::time = '18:30')
    -- vrijdag
    OR (EXTRACT(ISODOW FROM s.start_datetime) = 5 AND s.start_datetime::time IN ('14:00','16:30'))
    -- zaterdag en zondag
    OR (EXTRACT(ISODOW FROM s.start_datetime) IN (6, 7) AND s.start_datetime::time IN ('11:00','13:30','16:00'))
  )
ORDER BY s.start_datetime;

-- Idem voor Fluid Art: boekingen op een dinsdag die niet in de nieuwe
-- tweewekelijkse reeks (vanaf 18/08/2026) valt.
SELECT
  to_char(s.start_datetime, 'Dy DD/MM/YYYY HH24:MI') AS wanneer,
  c.full_name  AS klant,
  c.email      AS email,
  b.party_size AS personen
FROM sessions s
JOIN bookings  b ON b.session_id = s.id AND b.status NOT IN ('cancelled', 'rescheduled')
JOIN customers c ON c.id = b.customer_id
JOIN services sv ON sv.id = s.service_id
WHERE sv.name = 'Fluid Art'
  AND s.start_datetime >= now()
  AND (
    EXTRACT(ISODOW FROM s.start_datetime) <> 2
    OR s.start_datetime::time <> '19:00'
    OR (MOD((s.start_datetime::date - DATE '2026-08-18') / 7, 2) <> 0)
  )
ORDER BY s.start_datetime;

-- ---------------------------------------------------------------------------
-- STAP 1 — de vrijdagregels verzetten (13:30 -> 14:00, 16:00 -> 16:30)
--
-- Bewust UPDATE en geen DELETE + INSERT: zo blijft het regel-id bestaan en
-- houden reeds gematerialiseerde sessies hun verwijzing (recurrence_rule_id).
-- ISODOW telt maandag=1, de kolom `weekday` telt maandag=0 — vrijdag is hier
-- dus 4.
-- ---------------------------------------------------------------------------
UPDATE recurrence_rules rr
   SET start_time = '14:00'
  FROM services sv
 WHERE sv.id = rr.service_id AND sv.name = 'Action Painting'
   AND rr.weekday = 4 AND rr.start_time = '13:30';

UPDATE recurrence_rules rr
   SET start_time = '16:30'
  FROM services sv
 WHERE sv.id = rr.service_id AND sv.name = 'Action Painting'
   AND rr.weekday = 4 AND rr.start_time = '16:00';

-- ---------------------------------------------------------------------------
-- STAP 2 — donderdag rechtzetten
--
-- De database had donderdag op 14:00/16:30/19:00 staan. Uit de Wix-export van de
-- bestaande boekingen (aug 2026) blijkt dat het in werkelijkheid 13:30, 16:00 en
-- 18:30 was — er staan 11 betaalde boekingen op die uren. Ze worden dus
-- gecorrigeerd, niet vervangen.
--
-- 13:30 en 16:00 lopen t.e.m. 31/08; 18:30 loopt gewoon door zonder einddatum.
-- Vanaf 1 september blijft 18:30 daardoor als enige donderdagsessie over — geen
-- aparte startdatum nodig.
-- ---------------------------------------------------------------------------
-- De drie oude uren naar de juiste zetten. Elke UPDATE apart, zodat een database
-- die er al deels goed op staat gewoon niets doet.
UPDATE recurrence_rules rr SET start_time = '13:30'
  FROM services sv WHERE sv.id = rr.service_id AND sv.name = 'Action Painting'
   AND rr.weekday = 3 AND rr.start_time = '14:00';
UPDATE recurrence_rules rr SET start_time = '16:00'
  FROM services sv WHERE sv.id = rr.service_id AND sv.name = 'Action Painting'
   AND rr.weekday = 3 AND rr.start_time = '16:30';
UPDATE recurrence_rules rr SET start_time = '18:30', end_date = NULL
  FROM services sv WHERE sv.id = rr.service_id AND sv.name = 'Action Painting'
   AND rr.weekday = 3 AND rr.start_time = '19:00';

-- 13:30 en 16:00 stoppen op 31/08.
UPDATE recurrence_rules rr SET end_date = '2026-08-31'
  FROM services sv WHERE sv.id = rr.service_id AND sv.name = 'Action Painting'
   AND rr.weekday = 3 AND rr.start_time IN ('13:30','16:00')
   AND (rr.end_date IS NULL OR rr.end_date > '2026-08-31');

-- 18:30 loopt door zonder einddatum.
UPDATE recurrence_rules rr SET end_date = NULL
  FROM services sv WHERE sv.id = rr.service_id AND sv.name = 'Action Painting'
   AND rr.weekday = 3 AND rr.start_time = '18:30';

-- Bestaat 18:30 nog niet (bv. omdat er geen 19:00-regel was), dan alsnog aanmaken.
INSERT INTO recurrence_rules (service_id, weekday, start_time, interval_weeks, anchor_date, end_date)
SELECT sv.id, 3, '18:30'::time, 1, '2026-07-01'::date, NULL
FROM services sv
WHERE sv.name = 'Action Painting'
  AND NOT EXISTS (
    SELECT 1 FROM recurrence_rules r2
    WHERE r2.service_id = sv.id AND r2.weekday = 3 AND r2.start_time = '18:30'
  );

-- ---------------------------------------------------------------------------
-- STAP 2b — Fluid Art: de tweewekelijkse reeks een week verschuiven
--
-- anchor_date bepaalt bij interval_weeks = 2 WELKE van de twee weken meetelt.
-- Stond hij op 28/07/2026, dan viel de reeks op 11/08, 25/08, 08/09, ... terwijl
-- de workshop in werkelijkheid op 18/08 doorging. Met 18/08 als anker klopt de
-- reeks: 18/08, 01/09, 15/09, ...
-- ---------------------------------------------------------------------------
UPDATE recurrence_rules rr
   SET anchor_date = '2026-08-18'
  FROM services sv
 WHERE sv.id = rr.service_id AND sv.name = 'Fluid Art'
   AND rr.weekday = 1 AND rr.interval_weeks = 2;

-- Toekomstige LEGE Fluid Art-sessies opruimen die op een "verkeerde" dinsdag
-- staan: alles wat een even aantal weken van 18/08/2026 af ligt, hoort in de
-- reeks; de rest niet. Sessies met een boeking blijven ook hier staan.
DELETE FROM sessions s
USING services sv
WHERE sv.id = s.service_id
  AND sv.name = 'Fluid Art'
  AND s.kind = 'service'
  AND s.start_datetime >= now()
  AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.session_id = s.id AND b.status NOT IN ('cancelled','rescheduled'))
  AND NOT EXISTS (SELECT 1 FROM room_bookings rb WHERE rb.session_id = s.id)
  AND (
    EXTRACT(ISODOW FROM s.start_datetime) <> 2
    OR s.start_datetime::time <> '19:00'
    OR (MOD((s.start_datetime::date - DATE '2026-08-18') / 7, 2) <> 0)
  );

-- ---------------------------------------------------------------------------
-- STAP 3 — toekomstige LEGE sessies opruimen die niet meer in het rooster passen
--
-- Enkel sessies zonder boeking én zonder room-blokkade, en enkel in de toekomst.
-- Wat hier verdwijnt, wordt vanzelf opnieuw aangemaakt met de juiste uren zodra
-- iemand die datum opvraagt (materializeRule() in lib/store-sql.js).
-- ---------------------------------------------------------------------------
DELETE FROM sessions s
USING services sv
WHERE sv.id = s.service_id
  AND sv.name = 'Action Painting'
  AND s.kind = 'service'
  AND s.start_datetime >= now()
  AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.session_id = s.id AND b.status NOT IN ('cancelled','rescheduled'))
  AND NOT EXISTS (SELECT 1 FROM room_bookings rb WHERE rb.session_id = s.id)
  AND NOT (
    (EXTRACT(ISODOW FROM s.start_datetime) = 3 AND s.start_datetime::time IN ('14:00','16:30','19:00'))
    OR (EXTRACT(ISODOW FROM s.start_datetime) = 4 AND s.start_datetime::date <= '2026-08-31'
        AND s.start_datetime::time IN ('13:30','16:00','18:30'))
    OR (EXTRACT(ISODOW FROM s.start_datetime) = 4 AND s.start_datetime::date >= '2026-09-01'
        AND s.start_datetime::time = '18:30')
    OR (EXTRACT(ISODOW FROM s.start_datetime) = 5 AND s.start_datetime::time IN ('14:00','16:30'))
    OR (EXTRACT(ISODOW FROM s.start_datetime) IN (6, 7) AND s.start_datetime::time IN ('11:00','13:30','16:00'))
  );

-- ---------------------------------------------------------------------------
-- STAP 4 (LEZEN) — controle: zo ziet het rooster er nu uit
-- ---------------------------------------------------------------------------
SELECT
  CASE rr.weekday WHEN 0 THEN 'maandag' WHEN 1 THEN 'dinsdag' WHEN 2 THEN 'woensdag'
                  WHEN 3 THEN 'donderdag' WHEN 4 THEN 'vrijdag' WHEN 5 THEN 'zaterdag'
                  WHEN 6 THEN 'zondag' END AS dag,
  rr.start_time AS uur,
  rr.anchor_date AS vanaf,
  rr.end_date    AS tot_en_met,
  sv.name        AS workshop
FROM recurrence_rules rr
JOIN services sv ON sv.id = rr.service_id
ORDER BY sv.name, rr.weekday, rr.start_time;
