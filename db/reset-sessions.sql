-- RESET: alle sessies en boekingen wissen (testdata opruimen)
--
-- ===========================================================================
-- LET OP — DIT VERWIJDERT DEFINITIEF DATA. Er is geen ongedaan maken.
-- ===========================================================================
-- Aangevraagd door Robin (aug 2026) om de dubbele sessies op te ruimen die
-- ontstaan waren door een tijdzonefout in migratie 006. De databank bevatte op
-- dat moment enkel testdata en een import die opnieuw te draaien is.
--
-- WAT VERDWIJNT:
--   • alle boekingen (ook de geïmporteerde Wix-boekingen)
--   • alle betalingen en terugbetalingen
--   • alle room-toewijzingen en room-sluitingen
--   • alle sessies, inclusief persoonlijke afspraken ("Dokter") en handmatig
--     toegevoegde extra sessies
--   • alle verzilveringen van cadeaubonnen die aan een boeking hingen
--
-- WAT BLIJFT STAAN:
--   • de cadeaubonnen zelf (gift_cards) — óók de 355 geïmporteerde
--   • klanten (customers)
--   • diensten, prijzen, rooms en het vaste uurrooster (recurrence_rules)
--   • personeelsplanning (staff_shifts)
--   • wekelijkse omzetfacturen
--
-- BELANGRIJK OVER CADEAUBONNEN: het SALDO van een bon die in een geschrapte
-- boeking gebruikt was, wordt NIET automatisch teruggezet. Stap 0 hieronder
-- toont of dat speelt. Is dat zo, zet dan die saldo's eerst manueel recht, of
-- laat het me weten.
--
-- Daarna: de sessies komen vanzelf terug uit het vaste uurrooster zodra iemand
-- een datum opvraagt in de widget of de agenda. Je moet niets opnieuw aanmaken.
-- De Wix-boekingen importeer je opnieuw via de backoffice.
--
--   psql "$DATABASE_URL" -f db/reset-sessions.sql

SET TIME ZONE 'Europe/Brussels';

-- ---------------------------------------------------------------------------
-- STAP 0 (LEZEN) — wat ga je precies weggooien? Draai dit eerst apart.
-- ---------------------------------------------------------------------------
SELECT 'sessies'                AS wat, COUNT(*)::text AS aantal FROM sessions
UNION ALL SELECT 'boekingen (actief)', COUNT(*)::text FROM bookings WHERE status NOT IN ('cancelled','rescheduled')
UNION ALL SELECT 'boekingen (totaal)', COUNT(*)::text FROM bookings
UNION ALL SELECT 'betalingen',         COUNT(*)::text FROM payments
UNION ALL SELECT 'room-toewijzingen',  COUNT(*)::text FROM room_bookings
UNION ALL SELECT 'cadeaubonnen (blijven staan)', COUNT(*)::text FROM gift_cards
UNION ALL SELECT 'klanten (blijven staan)',      COUNT(*)::text FROM customers
UNION ALL SELECT '>> cadeaubon-saldo dat NIET terugkomt (euro)',
       COALESCE(SUM(b.gift_card_amount), 0)::text
  FROM bookings b
 WHERE b.gift_card_id IS NOT NULL AND b.gift_card_redeemed_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- STAP 1 — wissen, in de volgorde die de verwijzingen respecteert.
--
-- Alles staat in één transactie: gaat er iets mis, dan wordt niets gewist in
-- plaats van de helft.
-- ---------------------------------------------------------------------------
BEGIN;

DELETE FROM discount_redemptions;
DELETE FROM payments;
DELETE FROM room_bookings;

-- bookings verwijst naar zichzelf via rescheduled_from_id; die verwijzing eerst
-- losmaken, anders blokkeert de foreign key de DELETE.
UPDATE bookings SET rescheduled_from_id = NULL WHERE rescheduled_from_id IS NOT NULL;
DELETE FROM bookings;

DELETE FROM sessions;

COMMIT;

-- ---------------------------------------------------------------------------
-- STAP 2 (LEZEN) — controle: alles leeg, de rest ongemoeid.
-- ---------------------------------------------------------------------------
SELECT 'sessies'      AS wat, COUNT(*) AS aantal FROM sessions
UNION ALL SELECT 'boekingen',    COUNT(*) FROM bookings
UNION ALL SELECT 'betalingen',   COUNT(*) FROM payments
UNION ALL SELECT 'cadeaubonnen', COUNT(*) FROM gift_cards
UNION ALL SELECT 'klanten',      COUNT(*) FROM customers
UNION ALL SELECT 'roosterregels', COUNT(*) FROM recurrence_rules;
