-- DIAGNOSE: welke migraties zijn nog niet gedraaid op deze database?
--
-- Puur leesbaar — verandert niets. Plak dit in de Neon SQL-editor en je ziet
-- per migratie of ze al toegepast is. Handig wanneer je niet meer zeker weet
-- welke je ooit uitgevoerd hebt.
--
--   psql "$DATABASE_URL" -f db/check-schema-state.sql

SELECT
  '001_add_refund_tracking' AS migratie,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bookings' AND column_name = 'refunded_amount'
  ) THEN 'OK — al gedraaid' ELSE 'ONTBREEKT — nog uit te voeren' END AS status

UNION ALL SELECT
  '002_add_staff_shifts',
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'staff_shifts'
  ) THEN 'OK — al gedraaid' ELSE 'ONTBREEKT — nog uit te voeren' END

UNION ALL SELECT
  '003_rename_action_painting',
  CASE WHEN EXISTS (
    SELECT 1 FROM services WHERE name = 'Art Attack Room'
  ) THEN 'ONTBREEKT — workshop heet nog "Art Attack Room"'
       ELSE 'OK — al gedraaid (of nieuwe database)' END

UNION ALL SELECT
  '005_add_gift_cards (EERST draaien, vóór 004)',
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bookings' AND column_name = 'gift_card_id'
  ) THEN 'OK — al gedraaid' ELSE 'ONTBREEKT — dit veroorzaakt de fout bij het boeken' END

UNION ALL SELECT
  '004_gift_card_hardening (NA 005)',
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'uq_gift_cards_mollie_payment_id'
  ) THEN 'OK — al gedraaid' ELSE 'ONTBREEKT — nog uit te voeren' END

ORDER BY migratie;
