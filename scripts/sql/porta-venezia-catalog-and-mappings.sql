-- =============================================================================
-- LIVE CITY · Test Porta Venezia — catalogo + mappings + orari (in un colpo)
-- =============================================================================
-- I 10 locali del test non sono nel catalogo `places` (verificato il
-- 2026-11-20: a Porta Venezia c'erano solo 16 place, nessuno di questi).
-- Questo script li aggiunge al catalogo con i dati della registrazione BestTime
-- (stessa venue di cui misuriamo il live) e crea i relativi venue_mappings con
-- la finestra di lettura `live_read_hours` (ore Europe/Rome).
--
--   places.fsq_place_id    = 'besttime:<venue_id>'   (id opaco, univoco)
--   places.catalog_source  = 'besttime'
--   venue_mappings         = matched, live_priority 100, live_read_hours
--
-- Riempi id, indirizzo matchato e coordinate dalla risposta BestTime. Se anche
-- un solo placeholder o coordinata non valida resta presente, ready_venues è
-- vuota e lo script non inserisce nessuna delle 10 righe.
-- devono essere una tra: aperitivo, food, nightlife, outdoor, culture.
-- Rieseguibile: aggiorna le righe esistenti invece di duplicarle.
-- =============================================================================

with test_venues (besttime_venue_id, name, address, latitude, longitude, category, live_read_hours) as (
  values
    ('<ID_LOVE>',         'Love',                                  'Via Melzo 5, Milano',              0.0, 0.0, 'nightlife', '{19,20,21,22,23,0,1}'::smallint[]),
    ('<ID_RAINBOW_CAFE>', 'Rainbow Café Milano',                    'Via Alessandro Tadino 6, Milano',  0.0, 0.0, 'nightlife', '{19,20,21,22,23,0,1}'::smallint[]),
    ('<ID_RED_CAFE>',     'Red Café',                               'Via Lecco 5, Milano',              0.0, 0.0, 'aperitivo', '{19,20,21,22,23,0,1}'::smallint[]),
    ('<ID_NURA>',         'Nura',                                   'Via Melzo 21, Milano',             0.0, 0.0, 'aperitivo', '{19,20,21,22,23,0,1}'::smallint[]),
    ('<ID_MAGUTT>',       'Magutt',                                 'Via Lambro 11, Milano',            0.0, 0.0, 'aperitivo', '{19,20,21,22,23,0,1}'::smallint[]),
    ('<ID_BROLO>',        'Brolo Milano - Orto con cucina',         'Via Melzo 19, Milano',             0.0, 0.0, 'food',      '{19,20,21,22,23,0,1}'::smallint[]),
    ('<ID_MALPIGHI_8>',   'Malpighi 8',                             'Via Marcello Malpighi 8, Milano',  0.0, 0.0, 'aperitivo', '{19,20,21,22,23,0}'::smallint[]),
    ('<ID_EPPOL>',        'Eppol',                                  'Via Marcello Malpighi 7, Milano',  0.0, 0.0, 'food',      '{19,20,21,22,23,0}'::smallint[]),
    ('<ID_BAR_PICCHIO>',  'Bar Picchio',                            'Via Melzo 11, Milano',             0.0, 0.0, 'aperitivo', '{19,20,21,22,23}'::smallint[]),
    ('<ID_DA_OSCAR>',     'Ristorante Da Oscar (Porta Venezia)',    'Via Lazzaro Palazzi 4, Milano',    0.0, 0.0, 'food',      '{19,20,21,22}'::smallint[])
),
ready_venues as (
  select v.*
  from test_venues v
  cross join (
    select count(*) = 10
      and bool_and(besttime_venue_id not like '<%')
      and bool_and(latitude between 45.0 and 46.0)
      and bool_and(longitude between 9.0 and 10.0) as ready
    from test_venues
  ) validation
  where validation.ready
),
upserted_places as (
  insert into public.places (
    fsq_place_id, source_place_id, name, address, category,
    latitude, longitude, catalog_source, is_active
  )
  select 'besttime:' || besttime_venue_id, besttime_venue_id, name, address, category,
         latitude, longitude, 'besttime', true
  from ready_venues
  on conflict (fsq_place_id) do update
    set name = excluded.name,
        address = excluded.address,
        category = excluded.category,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        is_active = true,
        updated_at = now()
  returning fsq_place_id
)
insert into public.venue_mappings (
  fsq_place_id, fsq_name, besttime_venue_id, besttime_name,
  match_status, live_priority, live_read_hours
)
select 'besttime:' || v.besttime_venue_id, v.name, v.besttime_venue_id, v.name,
       'matched', 100, v.live_read_hours
from ready_venues v
join upserted_places p on p.fsq_place_id = 'besttime:' || v.besttime_venue_id
on conflict (fsq_place_id) do update
  set besttime_venue_id = excluded.besttime_venue_id,
      besttime_name = excluded.besttime_name,
      match_status = 'matched',
      live_priority = excluded.live_priority,
      live_read_hours = excluded.live_read_hours,
      updated_at = now();

-- CONTROLLI (prima di attivare il cron)
-- Atteso: senza_orario = 0, venue_in_programma = 10, letture_pianificate = 63.
select
  count(*) filter (where live_read_hours is null) as senza_orario,
  count(*) filter (where cardinality(live_read_hours) > 0) as venue_in_programma,
  coalesce(sum(cardinality(live_read_hours)), 0) as letture_pianificate
from public.venue_mappings
where besttime_venue_id is not null;
