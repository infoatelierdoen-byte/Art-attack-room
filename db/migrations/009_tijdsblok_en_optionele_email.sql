-- Migratie: tijdsblokken in de agenda + e-mail optioneel bij een boeking
-- (Robin, aug 2026)
--
-- Twee losse zaken die allebei één kolom/type raken:
--
-- 1. TIJDSBLOK. Een nieuw soort item in de agenda ('block'): een eigen
--    tijdsblok met een titel, om zelf iets in te plannen. Het neemt bewust
--    GEEN rooms in en blokkeert GEEN online boekingen — het is een gekleurde
--    (paarse) melding voor het team. Wil je wél dat er niet meer op geboekt
--    kan worden, gebruik dan "Room(s) sluiten".
--
--    Verschil met 'personal': een persoonlijke afspraak is privé (de
--    gast-rol ziet enkel "Privé"), een tijdsblok is gewoon zichtbaar met
--    zijn titel.
--
-- 2. E-MAIL OPTIONEEL. Aan de balie of aan de telefoon heeft niet elke klant
--    een e-mailadres bij de hand. customers.email mag daarom leeg blijven.
--    De UNIQUE-index blijft staan: PostgreSQL beschouwt elke NULL als
--    verschillend, dus meerdere klanten zonder e-mail kunnen naast elkaar
--    bestaan, terwijl twee klanten met hetzelfde adres nog steeds geweigerd
--    worden.
--
-- Veilig om opnieuw te draaien.
--
--   psql "$DATABASE_URL" -f db/migrations/009_tijdsblok_en_optionele_email.sql

SET TIME ZONE 'Europe/Brussels';

-- ---------------------------------------------------------
-- 1. Nieuw sessietype 'block'
-- ---------------------------------------------------------
-- ALTER TYPE ... ADD VALUE is niet terug te draaien en klaagt als de waarde
-- er al staat; vandaar de IF NOT EXISTS.
ALTER TYPE session_kind ADD VALUE IF NOT EXISTS 'block';

-- De bestaande CHECK laat enkel 'service' (mét dienst) en 'personal' (zonder)
-- toe. Een tijdsblok hangt, net als een persoonlijke afspraak, aan geen
-- enkele dienst.
--
-- Let op: de nieuwe enum-waarde mag in dezelfde transactie waarin ze is
-- toegevoegd nog niet gebruikt worden. Daarom staat de constraint hieronder
-- niet met een letterlijke 'block'-vergelijking maar via de tekstvorm van de
-- kolom (kind::text), wat wél meteen werkt.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS chk_session_kind_service;
ALTER TABLE sessions ADD CONSTRAINT chk_session_kind_service CHECK (
    (kind::text = 'service'  AND service_id IS NOT NULL) OR
    (kind::text = 'personal' AND service_id IS NULL) OR
    (kind::text = 'block'    AND service_id IS NULL)
);

-- ---------------------------------------------------------
-- 2. E-mail mag leeg blijven
-- ---------------------------------------------------------
ALTER TABLE customers ALTER COLUMN email DROP NOT NULL;

-- Controle achteraf — beide regels moeten 'OK' teruggeven.
SELECT CASE WHEN EXISTS (
         SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'session_kind' AND e.enumlabel = 'block')
       THEN 'OK — sessietype block bestaat'
       ELSE 'FOUT — sessietype block ontbreekt' END AS controle_tijdsblok;

SELECT CASE WHEN (SELECT is_nullable FROM information_schema.columns
                   WHERE table_name = 'customers' AND column_name = 'email') = 'YES'
       THEN 'OK — e-mail mag leeg blijven'
       ELSE 'FOUT — e-mail is nog altijd verplicht' END AS controle_email;
