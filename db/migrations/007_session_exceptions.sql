-- Migratie: eenmalige uitzonderingen op het vaste rooster (Robin, aug 2026)
--
-- Losse afwijkingen die uit de Wix-boekingslijst naar boven kwamen. Dit zijn
-- GEEN roosterwijzigingen — het vaste patroon blijft ongemoeid, enkel deze
-- specifieke datum wijkt af.
--
-- Veilig om opnieuw te draaien.
--
--   psql "$DATABASE_URL" -f db/migrations/007_session_exceptions.sql

-- ---------------------------------------------------------------------------
-- Vrijdag 02/10/2026: 16:30 wordt 17:30
--
-- Er stond één betaalde boeking op 17:30 die nergens in het rooster paste
-- (vrijdag is 14:00 en 16:30). Afgesproken: die vrijdag vervangt 17:30 de
-- sessie van 16:30. De sessie van 14:00 blijft gewoon staan.
--
-- De 16:30-sessie wordt op 'cancelled' gezet in plaats van verwijderd. Dat is
-- bewust: materializeRule() in lib/store-sql.js kijkt enkel of er al een rij
-- bestaat voor die dienst op dat tijdstip, ongeacht de status. Een verwijderde
-- rij zou dus meteen opnieuw aangemaakt worden zodra iemand die datum opvraagt;
-- een geannuleerde blijft weg (getAvailability filtert op status = 'scheduled').
-- ---------------------------------------------------------------------------

-- Eerst zorgen dat de sessies van die dag bestaan, zodat de UPDATE hieronder
-- iets te doen heeft ook als de datum nog nooit opgevraagd is.
INSERT INTO sessions (kind, service_id, recurrence_rule_id, start_datetime, end_datetime, capacity)
SELECT 'service', sv.id, NULL,
       TIMESTAMPTZ '2026-10-02 16:30:00+02', TIMESTAMPTZ '2026-10-02 18:00:00+02', NULL
FROM services sv
WHERE sv.name = 'Action Painting'
  AND NOT EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.service_id = sv.id AND s.start_datetime = TIMESTAMPTZ '2026-10-02 16:30:00+02'
  );

-- 16:30 uitschakelen — enkel als er niemand op geboekt heeft.
UPDATE sessions s
   SET status = 'cancelled'
  FROM services sv
 WHERE sv.id = s.service_id
   AND sv.name = 'Action Painting'
   AND s.start_datetime = TIMESTAMPTZ '2026-10-02 16:30:00+02'
   AND s.status = 'scheduled'
   AND NOT EXISTS (
     SELECT 1 FROM bookings b
      WHERE b.session_id = s.id AND b.status NOT IN ('cancelled','rescheduled')
   );

-- 17:30 als eenmalige sessie toevoegen (recurrence_rule_id NULL = handmatig
-- toegevoegd, zoals addExtraSession() dat ook doet).
INSERT INTO sessions (kind, service_id, recurrence_rule_id, start_datetime, end_datetime, capacity)
SELECT 'service', sv.id, NULL,
       TIMESTAMPTZ '2026-10-02 17:30:00+02', TIMESTAMPTZ '2026-10-02 19:00:00+02', NULL
FROM services sv
WHERE sv.name = 'Action Painting'
  AND NOT EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.service_id = sv.id AND s.start_datetime = TIMESTAMPTZ '2026-10-02 17:30:00+02'
  );

-- ---------------------------------------------------------------------------
-- Controle: zo ziet vrijdag 02/10/2026 er nu uit.
-- Verwacht: 14:00 scheduled, 16:30 cancelled, 17:30 scheduled.
-- ---------------------------------------------------------------------------
SELECT to_char(s.start_datetime, 'DD/MM/YYYY HH24:MI') AS tijdstip, s.status, sv.name AS workshop
FROM sessions s
JOIN services sv ON sv.id = s.service_id
WHERE s.start_datetime::date = DATE '2026-10-02'
ORDER BY s.start_datetime;
