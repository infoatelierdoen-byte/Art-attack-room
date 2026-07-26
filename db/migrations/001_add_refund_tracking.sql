-- Migratie: terugbetaling bijhouden bij het annuleren van een boeking.
--
-- BELANGRIJK: dit is enkel nodig op je LIVE database — een nieuwe/lege
-- database aangemaakt via db/schema.sql heeft deze kolommen al staan
-- (schema.sql is bijgewerkt). Voer dit dus enkel uit tegen de bestaande
-- productie-Postgres (bv. via de Neon/Vercel Postgres SQL-editor, of met
-- psql "$DATABASE_URL" -f db/migrations/001_add_refund_tracking.sql).
-- Veilig om opnieuw te draaien (IF NOT EXISTS).

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(8,2) NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_reason TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
