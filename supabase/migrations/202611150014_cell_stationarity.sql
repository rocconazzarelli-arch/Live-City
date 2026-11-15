-- LIVE CITY: stationarity index for the area heatmap.
-- A density snapshot cannot tell a packed square from a packed street. For
-- every published cell this also counts how many sessions stood still and how
-- many were walking through, so the app can tell gatherings from flows.
-- Only per-cell counts are stored: no path is reconstructed or kept.

begin;

alter table public.crowd_area_snapshots
  add column if not exists stationary_sessions integer check (stationary_sessions >= 0),
  add column if not exists moving_sessions integer check (moving_sessions >= 0);

comment on column public.crowd_area_snapshots.stationary_sessions is
  'Sessions of the window whose latest cell is this one and that stayed in it for 15 minutes or more.';
comment on column public.crowd_area_snapshots.moving_sessions is
  'Sessions of the window seen in more than one cell during the window, and not stationary in this cell.';

create or replace function public.refresh_crowd_area_snapshots()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  window_end_at timestamptz := date_trunc('minute', now());
  window_start_at timestamptz := date_trunc('minute', now()) - interval '20 minutes';
  -- Dwell time is measured a little further back than the publishing window,
  -- so a session that has been in a cell for 15 minutes is recognised even
  -- when only its last observation falls in the window.
  lookback_start_at timestamptz := date_trunc('minute', now()) - interval '40 minutes';
  inserted_count integer := 0;
begin
  with recent as materialized (
    select session_id, grid_lat, grid_lng, observed_at
    from public.location_observations
    where observed_at >= lookback_start_at
      and observed_at < window_end_at
      and consent_version = '2026-10-private-beta-1'
      and grid_lat is not null
      and grid_lng is not null
  ),
  latest as (
    select distinct on (session_id)
      session_id, grid_lat, grid_lng, observed_at as latest_at
    from recent
    order by session_id, observed_at desc
  ),
  -- How long each session has been in its latest cell without leaving it.
  dwell as (
    select
      l.session_id, l.grid_lat, l.grid_lng,
      l.latest_at - min(r.observed_at) as dwell_time
    from latest l
    join recent r on r.session_id = l.session_id
    where r.observed_at > coalesce((
      select max(other.observed_at)
      from recent other
      where other.session_id = l.session_id
        and (other.grid_lat <> l.grid_lat or other.grid_lng <> l.grid_lng)
    ), '-infinity'::timestamptz)
    group by l.session_id, l.grid_lat, l.grid_lng, l.latest_at
  ),
  in_window as (
    select grid_lat, grid_lng, session_id, count(*) as observation_count
    from recent
    where observed_at >= window_start_at
    group by grid_lat, grid_lng, session_id
  ),
  window_cells as (
    select session_id, count(*) as cells_in_window
    from in_window
    group by session_id
  ),
  classified as (
    select
      w.grid_lat, w.grid_lng, w.observation_count,
      (d.grid_lat = w.grid_lat and d.grid_lng = w.grid_lng
        and d.dwell_time >= interval '15 minutes') as is_stationary,
      c.cells_in_window > 1 as changed_cell
    from in_window w
    join dwell d on d.session_id = w.session_id
    join window_cells c on c.session_id = w.session_id
  )
  insert into public.crowd_area_snapshots (
    grid_key, center_latitude, center_longitude, window_start, window_end,
    distinct_sessions, observation_count, density_score,
    stationary_sessions, moving_sessions
  )
  select
    grid_lat::text || ':' || grid_lng::text,
    (grid_lat + 0.5) * 0.004,
    (grid_lng + 0.5) * 0.004,
    window_start_at,
    window_end_at,
    count(*)::integer,
    sum(observation_count)::integer,
    least(100, round(count(*) * 5.0))::integer,
    count(*) filter (where is_stationary)::integer,
    count(*) filter (where changed_cell and not is_stationary)::integer
  from classified
  group by grid_lat, grid_lng
  having count(*) >= 5
  on conflict (grid_key, window_end) do update
    set distinct_sessions = excluded.distinct_sessions,
        observation_count = excluded.observation_count,
        density_score = excluded.density_score,
        stationary_sessions = excluded.stationary_sessions,
        moving_sessions = excluded.moving_sessions,
        created_at = now();

  get diagnostics inserted_count = row_count;
  delete from public.crowd_area_snapshots where window_end < now() - interval '24 hours';
  return jsonb_build_object('cellsPublished', inserted_count, 'windowStart', window_start_at, 'windowEnd', window_end_at, 'privacyThreshold', 5);
end;
$$;

revoke all on function public.refresh_crowd_area_snapshots() from public, anon, authenticated;

commit;
