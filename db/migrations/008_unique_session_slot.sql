-- Migratie: één sessie per dienst per tijdstip afdwingen (Robin, aug 2026)
--
-- Twee redenen:
--
-- 1. SNELHEID. Sessies worden nu in één INSERT aangemaakt in plaats van rij per
--    rij met telkens een SELECT ervoor. Die ene INSERT gebruikt
--    ON CONFLICT DO NOTHING om de race op te vangen waarbij twee gelijktijdige
--    verzoeken dezelfde sessie willen aanmaken. Daarvoor is deze unieke index
--    nodig — zonder index doet ON CONFLICT niets en kan er alsnog een dubbel
--    ontstaan.
--
-- 2. DUBBELE TIJDSLOTEN. Twee sessies voor dezelfde workshop op exact hetzelfde
--    moment horen niet te bestaan, maar niets in de database verhinderde dat.
--
-- Persoonlijke afspraken (service_id IS NULL) vallen buiten deze index: daarvan
-- mogen er wel meerdere op hetzelfde moment staan.
--
-- Veilig om opnieuw te draaien.
--
--   psql "$DATABASE_URL" -f db/migrations/008_unique_session_slot.sql

SET TIME ZONE 'Europe/Brussels';

-- Eerst eventuele bestaande dubbels opruimen, anders kan de index niet
-- aangemaakt worden. Alleen dubbels ZONDER boeking en ZONDER room-blokkade
-- worden verwijderd; van elke groep blijft de oudste altijd staan.
DELETE FROM sessions s
WHERE s.service_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.session_id = s.id AND b.status NOT IN ('cancelled','rescheduled'))
  AND NOT EXISTS (SELECT 1 FROM room_bookings rb WHERE rb.session_id = s.id)
  AND s.id <> (
    SELECT s2.id FROM sessions s2
     WHERE s2.service_id = s.service_id AND s2.start_datetime = s.start_datetime
     ORDER BY s2.created_at NULLS LAST, s2.id
     LIMIT 1
  );

-- Blijven er nu nog dubbels over, dan hangt er aan allebei een boeking. Die
-- mag ik niet zomaar weggooien — de index wordt dan niet aangemaakt en deze
-- melding vertelt je welke het zijn.
DO $$
DECLARE
  rest TEXT;
BEGIN
  SELECT string_agg(to_char(start_datetime, 'DD/MM/YYYY HH24:MI'), ', ')
    INTO rest
    FROM (
      SELECT start_datetime FROM sessions
       WHERE service_id IS NOT NULL
       GROUP BY service_id, start_datetime HAVING COUNT(*) > 1
    ) t;
  IF rest IS NOT NULL THEN
    RAISE EXCEPTION
      'Er staan nog dubbele sessies met boekingen op: %. Verplaats of annuleer eerst één van beide boekingen.', rest;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_service_start
  ON sessions (service_id, start_datetime)
  WHERE service_id IS NOT NULL;

-- Controle: dit hoort 0 rijen te geven.
SELECT to_char(start_datetime, 'DD/MM/YYYY HH24:MI') AS dubbel, COUNT(*) AS aantal
FROM sessions
WHERE service_id IS NOT NULL
GROUP BY service_id, start_datetime
HAVING COUNT(*) > 1;
