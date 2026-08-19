-- Migratie: cadeaubonnen dichttimmeren (Robin, aug 2026)
--
-- Volgt uit de veiligheidscheck van 19-08-2026. Twee problemen, allebei
-- alleen op te lossen in de database zelf — applicatiecode kan dit niet
-- garanderen bij gelijktijdige aanvragen.
--
-- BELANGRIJK: enkel nodig op je LIVE database. Een nieuwe database via
-- db/schema.sql heeft dit al staan. Veilig om opnieuw te draaien.
--
-- Uitvoeren via de Neon SQL-editor, of met:
--   psql "$DATABASE_URL" -f db/migrations/004_gift_card_hardening.sql

-- ---------------------------------------------------------------------------
-- 1. Eén Mollie-betaling mag hoogstens één cadeaubon opleveren.
--
-- De code controleerde dit met een SELECT gevolgd door een INSERT. Dat werkt
-- zolang de webhooks netjes na elkaar binnenkomen, maar Mollie stuurt bij een
-- retry soms twee aanroepen vlak na elkaar: beide zien "nog geen bon" en beide
-- maken er een aan. Getest: zes parallelle aanroepen op één betaling van €500
-- leverden zes bonnen van €500 op, alle zes gemaild.
--
-- Deze index maakt dat onmogelijk, ongeacht de timing. Partieel (WHERE ... IS
-- NOT NULL) omdat handmatig aangemaakte en geïmporteerde bonnen geen
-- mollie_payment_id hebben en er dus meerdere NULL-waarden bestaan.
-- ---------------------------------------------------------------------------

-- Vangnet: bestaat de tabel gift_cards nog niet, dan is deze database ouder dan
-- de cadeaubon-functionaliteit. Draai eerst
-- 005_add_gift_cards_to_existing_db.sql — die maakt de tabellen aan, inclusief
-- alles wat hieronder staat, waardoor deze migratie daarna niets meer hoeft te
-- doen. Zonder deze check zou je hier een onduidelijke "relation does not
-- exist"-fout krijgen.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'gift_cards') THEN
    RAISE EXCEPTION 'Tabel gift_cards bestaat nog niet — draai eerst db/migrations/005_add_gift_cards_to_existing_db.sql.';
  END IF;
END $$;

-- Eerst opruimen: bestaande duplicaten (indien aanwezig) op één na verwijderen,
-- anders kan de unieke index niet aangemaakt worden. Bonnen die al gebruikt
-- zijn in een boeking blijven altijd staan — er wordt enkel een ongebruikt
-- duplicaat opgeruimd.
DELETE FROM gift_cards g
WHERE g.mollie_payment_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.gift_card_id = g.id)
  AND g.id <> (
    SELECT g2.id FROM gift_cards g2
    WHERE g2.mollie_payment_id = g.mollie_payment_id
    ORDER BY g2.created_at ASC, g2.id ASC
    LIMIT 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_gift_cards_mollie_payment_id
  ON gift_cards (mollie_payment_id)
  WHERE mollie_payment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Een cadeaubon kan nooit onder nul.
--
-- De oude code deed Math.max(0, saldo - bedrag): bij een tekort werd het saldo
-- stilzwijgend op nul gezet, waardoor dubbel gebruik achteraf onzichtbaar was.
-- Die maskering is uit de code, en deze CHECK is het vangnet eronder: gaat er
-- ooit nog iets mis in de afschrijflogica, dan faalt de transactie luid in
-- plaats van stil geld weg te geven.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_gift_cards_remaining_not_negative'
  ) THEN
    -- Eventuele bestaande negatieve saldo's eerst rechtzetten, anders wordt de
    -- constraint geweigerd. Zou niet mogen voorkomen door de oude Math.max().
    UPDATE gift_cards SET remaining_amount = 0 WHERE remaining_amount < 0;

    ALTER TABLE gift_cards
      ADD CONSTRAINT chk_gift_cards_remaining_not_negative
      CHECK (remaining_amount >= 0);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Sneller zoeken op vervaldatum (de vervalcontrole is nieuw in de code).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_gift_cards_expires_at ON gift_cards (expires_at);
