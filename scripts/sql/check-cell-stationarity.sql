-- Check for migration 202611150014_cell_stationarity.sql.
-- Run it on a development database after applying the migration (SQL editor
-- or psql). It writes synthetic sessions in two cells off the coast of Africa
-- (grid 0:0 and 0:1), runs the refresh and compares the counts. Everything
-- is rolled back: nothing is left behind, whether the check passes or fails.

begin;

-- 6 sessions stay in cell 0:0 for half an hour.
with stayers as materialized (select gen_random_uuid() as id from generate_series(1, 6))
insert into public.location_observations (session_id, latitude, longitude, grid_lat, grid_lng, observed_at, consent_version)
select s.id, 0.002, 0.002, 0, 0, now() - make_interval(mins => m.minutes), '2026-10-private-beta-1'
from stayers s
cross join (values (32), (18), (2)) as m(minutes);

-- 5 sessions walk from cell 0:0 to cell 0:1.
with walkers as materialized (select gen_random_uuid() as id from generate_series(1, 5))
insert into public.location_observations (session_id, latitude, longitude, grid_lat, grid_lng, observed_at, consent_version)
select id, 0.002, 0.002, 0, 0, now() - interval '12 minutes', '2026-10-private-beta-1' from walkers
union all
select id, 0.002, 0.006, 0, 1, now() - interval '3 minutes', '2026-10-private-beta-1' from walkers;

-- 2 sessions have just appeared in cell 0:0: too early to classify.
insert into public.location_observations (session_id, latitude, longitude, grid_lat, grid_lng, observed_at, consent_version)
select gen_random_uuid(), 0.002, 0.002, 0, 0, now() - interval '4 minutes', '2026-10-private-beta-1'
from generate_series(1, 2);

select public.refresh_crowd_area_snapshots();

do $$
declare
  square record;
  street record;
begin
  select distinct_sessions, stationary_sessions, moving_sessions into square
  from public.crowd_area_snapshots where grid_key = '0:0' order by window_end desc limit 1;
  select distinct_sessions, stationary_sessions, moving_sessions into street
  from public.crowd_area_snapshots where grid_key = '0:1' order by window_end desc limit 1;

  assert square.distinct_sessions = 13, format('cell 0:0: expected 13 sessions, got %s', square.distinct_sessions);
  assert square.stationary_sessions = 6, format('cell 0:0: expected 6 stationary, got %s', square.stationary_sessions);
  assert square.moving_sessions = 5, format('cell 0:0: expected 5 moving, got %s', square.moving_sessions);
  assert street.distinct_sessions = 5, format('cell 0:1: expected 5 sessions, got %s', street.distinct_sessions);
  assert street.stationary_sessions = 0, format('cell 0:1: expected 0 stationary, got %s', street.stationary_sessions);
  assert street.moving_sessions = 5, format('cell 0:1: expected 5 moving, got %s', street.moving_sessions);
  raise notice 'cell stationarity check passed';
end;
$$;

rollback;
