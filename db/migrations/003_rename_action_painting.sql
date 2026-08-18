-- Migratie: workshop "Art Attack Room" hernoemd naar "Action Painting"
-- (Robin, aug 2026) — zelfde dienst, zelfde rooms/prijzen/rooster, enkel de
-- naam verandert (voor klanten in de widget én in de backoffice-agenda).
--
-- BELANGRIJK: dit is enkel nodig op je LIVE database — een nieuwe/lege
-- database aangemaakt via db/schema.sql + db/seed.sql heeft de nieuwe naam
-- al staan. Voer dit dus enkel uit tegen de bestaande productie-Postgres
-- (bv. via de Neon SQL-editor, of met
-- psql "$DATABASE_URL" -f db/migrations/003_rename_action_painting.sql).
-- Veilig om opnieuw te draaien: de WHERE-clausule vindt na de eerste keer
-- gewoon geen rij meer en doet dan niets.
--
-- Wijzigt enkel de kolom services.name zelf — alle bestaande sessies,
-- boekingen, facturen en room-toewijzingen blijven intact (die verwijzen
-- naar de dienst via een vaste id, niet via de naam).

UPDATE services SET name = 'Action Painting' WHERE name = 'Art Attack Room';
