-- Referentiedata: rooms, diensten, prijstrap en het vaste uurrooster.
-- Idempotent (ON CONFLICT DO NOTHING) zodat dit veilig herhaald kan worden.

INSERT INTO rooms (code, name, capacity) VALUES
  ('A', 'Room A', 10),
  ('M', 'Room M', 5),
  ('VL', 'Room VL', 7),
  ('VR', 'Room VR', 7)
ON CONFLICT (code) DO NOTHING;

-- "Art Attack Room" (de zaak/het merk) is de workshop hier hernoemd naar
-- "Action Painting" (Robin, aug 2026) — zelfde dienst, rooms, prijzen en
-- rooster, enkel de klant- en backoffice-naam veranderde. Bestaande live
-- databases: zie db/migrations/003_rename_action_painting.sql.
INSERT INTO services (name, type, duration_minutes, buffer_minutes, price, default_capacity, uses_room_assignment, min_online_party_size, max_online_party_size)
VALUES
  ('Fluid Art', 'group_session', 90, 60, 60.00, 10, FALSE, 1, 5),
  ('Action Painting', 'group_session', 90, 60, NULL, 7, TRUE, 2, 7)
ON CONFLICT DO NOTHING;

-- Prijstrap Action Painting (2p=120 t.e.m. 7p=364)
INSERT INTO service_party_pricing (service_id, party_size, total_price)
SELECT id, party_size, total_price
FROM services, (VALUES (2,120), (3,174), (4,220), (5,265), (6,312), (7,364)) AS t(party_size, total_price)
WHERE services.name = 'Action Painting'
ON CONFLICT (service_id, party_size) DO NOTHING;

-- Vast uurrooster Action Painting: wo/do/vr/za/zo.
-- weekday: 0=maandag .. 6=zondag (zie schema.sql).
-- Donderdag heeft een end_date (vakantiestop tot en met 31/08/2026).
INSERT INTO recurrence_rules (service_id, weekday, start_time, interval_weeks, anchor_date, end_date)
SELECT id, weekday, start_time::time, 1, '2026-07-01'::date, end_date::date
FROM services, (VALUES
  (2, '14:00', NULL), (2, '16:30', NULL), (2, '19:00', NULL),          -- woensdag
  (3, '13:30', '2026-08-31'), (3, '16:00', '2026-08-31'), -- donderdag zomerrooster, t.e.m. 31/08
  (4, '14:00', NULL), (4, '16:30', NULL),                               -- vrijdag
  (5, '11:00', NULL), (5, '13:30', NULL), (5, '16:00', NULL),           -- zaterdag
  (6, '11:00', NULL), (6, '13:30', NULL), (6, '16:00', NULL)            -- zondag
) AS t(weekday, start_time, end_date)
WHERE services.name = 'Action Painting';

-- Donderdag 18:30: loopt gewoon door, zonder einddatum (Robin, aug 2026).
-- In augustus staat die naast het zomerrooster hierboven (13:30 en 16:00); vanaf
-- 1 september vallen die twee weg en blijft 18:30 als enige donderdagsessie over.
-- De uren van dat zomerrooster komen uit de Wix-export van de bestaande
-- boekingen — daar staan de donderdagen in augustus op 13:30, 16:00 en 18:30.
INSERT INTO recurrence_rules (service_id, weekday, start_time, interval_weeks, anchor_date, end_date)
SELECT id, 3, '18:30'::time, 1, '2026-07-01'::date, NULL
FROM services WHERE services.name = 'Action Painting';

-- Fluid Art: tweewekelijks op dinsdag (weekday=1) 19:00.
-- Ankerdatum 2026-08-18: dat is de dinsdag waarop de workshop effectief
-- doorging (Robin, aug 2026). De reeks loopt dus 18/08, 01/09, 15/09, ...
-- Stond eerder op 2026-07-28, wat de reeks een week verkeerd zette
-- (25/08 i.p.v. 18/08). anchor_date bepaalt bij interval_weeks = 2 welke van
-- de twee weken meetelt, dus deze datum moet op een echte workshopdag vallen.
INSERT INTO recurrence_rules (service_id, weekday, start_time, interval_weeks, anchor_date, end_date)
SELECT id, 1, '19:00'::time, 2, '2026-08-18'::date, NULL
FROM services WHERE services.name = 'Fluid Art';
