-- Migratie: personeelsplanning (wie werkt wanneer, van/tot hoe laat).
--
-- BELANGRIJK: dit is enkel nodig op je LIVE database — een nieuwe/lege
-- database aangemaakt via db/schema.sql heeft deze tabel al staan
-- (schema.sql is bijgewerkt). Voer dit dus enkel uit tegen de bestaande
-- productie-Postgres (bv. via de Neon/Vercel Postgres SQL-editor, of met
-- psql "$DATABASE_URL" -f db/migrations/002_add_staff_shifts.sql).
-- Veilig om opnieuw te draaien (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS staff_shifts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_date   DATE NOT NULL,
    staff_name  TEXT NOT NULL,
    start_time  TIME NOT NULL,
    end_time    TIME NOT NULL,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_shifts_date ON staff_shifts(work_date);
