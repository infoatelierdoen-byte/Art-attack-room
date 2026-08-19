-- Migratie: cadeaubonnen toevoegen aan een BESTAANDE live database
-- (Robin, aug 2026)
--
-- WAAROM DEZE BESTAAT
-- De cadeaubon-functionaliteit is destijds enkel aan db/schema.sql toegevoegd,
-- zonder bijhorende migratie. Een database die vóór die feature aangemaakt is,
-- mist daardoor de tabellen en kolommen — met als symptoom bij het opslaan van
-- een boeking:
--     column "gift_card_id" of relation "bookings" does not exist
--
-- ==> DRAAI DEZE MIGRATIE VÓÓR 004_gift_card_hardening.sql.
--     004 gaat ervan uit dat de tabel gift_cards al bestaat.
--
-- Volledig idempotent: alles staat achter IF NOT EXISTS, dus meerdere keren
-- draaien is veilig, en op een database die al bij is verandert er niets.
--
-- Uitvoeren via de Neon SQL-editor, of met:
--   psql "$DATABASE_URL" -f db/migrations/005_add_gift_cards_to_existing_db.sql

-- ---------------------------------------------------------------------------
-- 1. Enum-types (CREATE TYPE kent geen IF NOT EXISTS, vandaar de DO-blokken)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gift_card_status') THEN
    CREATE TYPE gift_card_status AS ENUM ('active', 'disabled', 'depleted');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'discount_type') THEN
    CREATE TYPE discount_type AS ENUM ('gift_voucher', 'loyalty_points', 'promo_code');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. De cadeaubon-tabel zelf
--
-- De CHECK op remaining_amount en de unieke index op mollie_payment_id staan
-- hier al mee: op een database die deze tabel nog niet had, is 004 daarna een
-- no-op. Draai 004 gerust toch — hij is idempotent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gift_cards (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                TEXT NOT NULL UNIQUE,
    initial_amount      NUMERIC(8,2) NOT NULL,
    remaining_amount    NUMERIC(8,2) NOT NULL CHECK (remaining_amount >= 0),
    status              gift_card_status NOT NULL DEFAULT 'active',
    purchaser_name      TEXT,
    purchaser_email     TEXT,
    recipient_note      TEXT,
    source              TEXT NOT NULL DEFAULT 'manual',
    mollie_payment_id   TEXT,
    expires_at          DATE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    disabled_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_gift_cards_code ON gift_cards(code);
CREATE INDEX IF NOT EXISTS idx_gift_cards_expires_at ON gift_cards(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gift_cards_mollie_payment_id
  ON gift_cards(mollie_payment_id) WHERE mollie_payment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Verzilveringen (het spoor per boeking: welke bon, welk bedrag)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discount_redemptions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id    UUID NOT NULL REFERENCES bookings(id),
    type          discount_type NOT NULL,
    code          TEXT,
    points_used   INT,
    amount        NUMERIC(8,2) NOT NULL,
    validated_via TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discount_redemptions_booking ON discount_redemptions(booking_id);

-- ---------------------------------------------------------------------------
-- 4. De drie ontbrekende kolommen op bookings — dit is wat de foutmelding gaf
-- ---------------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS gift_card_id          UUID REFERENCES gift_cards(id);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS gift_card_amount      NUMERIC(8,2);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS gift_card_redeemed_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 5. Controle achteraf
--
-- Deze query hoort 3 rijen terug te geven. Krijg je er minder, dan is stap 4
-- niet doorgelopen.
-- ---------------------------------------------------------------------------
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'bookings'
  AND column_name IN ('gift_card_id', 'gift_card_amount', 'gift_card_redeemed_at')
ORDER BY column_name;
