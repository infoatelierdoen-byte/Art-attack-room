-- DIAGNOSE: welke sessies staan er echt in de database, en waar zitten dubbels?
--
-- Puur leesbaar — verandert niets. Plak dit in de Neon SQL-editor wanneer de
-- weekagenda tijdsloten dubbel toont.
--
--   psql "$DATABASE_URL" -f db/check-sessions.sql

-- Zonder deze regel rekent ::time om naar de tijdzone van de server (op Neon
-- standaard UTC) en lijken alle uren twee uur te vroeg.
SET TIME ZONE 'Europe/Brussels';

-- 1. Alle toekomstige sessies met hun status en aantal boekingen.
--    Twee rijen op dezelfde dag met bijna hetzelfde uur (bv. 13:30 én 14:00)
--    zijn de dubbels die je in de agenda ziet.
SELECT
  to_char(s.start_datetime, 'Dy DD/MM/YYYY HH24:MI')      AS wanneer,
  sv.name                                                  AS workshop,
  s.status,
  CASE WHEN s.recurrence_rule_id IS NULL
       THEN 'eenmalig toegevoegd' ELSE 'uit het vaste rooster' END AS herkomst,
  COUNT(b.id)                                              AS boekingen,
  COALESCE(SUM(b.party_size), 0)                           AS personen
FROM sessions s
JOIN services sv ON sv.id = s.service_id
LEFT JOIN bookings b
       ON b.session_id = s.id AND b.status NOT IN ('cancelled','rescheduled')
WHERE s.kind = 'service'
  AND s.start_datetime >= now()
  AND s.start_datetime < now() + INTERVAL '3 months'
GROUP BY s.id, sv.name, s.status, s.recurrence_rule_id, s.start_datetime
ORDER BY s.start_datetime;

-- 2. Alleen de dagen waar meerdere sessies binnen hetzelfde uur beginnen.
--    Dit is de korte lijst: precies de dubbels.
SELECT
  s.start_datetime::date                                   AS dag,
  sv.name                                                  AS workshop,
  string_agg(to_char(s.start_datetime,'HH24:MI') ||
             ' (' || s.status || ', ' ||
             (SELECT COUNT(*) FROM bookings b
               WHERE b.session_id = s.id AND b.status NOT IN ('cancelled','rescheduled'))
             || ' boekingen)', '  +  ' ORDER BY s.start_datetime) AS sessies
FROM sessions s
JOIN services sv ON sv.id = s.service_id
WHERE s.kind = 'service' AND s.start_datetime >= now()
GROUP BY s.start_datetime::date, sv.name
HAVING COUNT(*) > (
  CASE
    WHEN sv.name = 'Fluid Art' THEN 1
    WHEN EXTRACT(ISODOW FROM s.start_datetime::date) = 4
         AND s.start_datetime::date <= DATE '2026-08-31' THEN 3
    WHEN EXTRACT(ISODOW FROM s.start_datetime::date) = 4 THEN 1
    WHEN EXTRACT(ISODOW FROM s.start_datetime::date) = 5 THEN 2
    ELSE 3
  END
)
ORDER BY dag;
