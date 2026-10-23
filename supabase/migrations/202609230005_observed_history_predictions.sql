-- LIVE CITY: forecasts trained only on historical real observations.
-- BestTime values and opt-in telemetry are deduplicated by their source timestamp
-- before contributing to a Europe/Rome weekday/hour prediction slot.

begin;

-- Existing cache rows cannot prove whether they came from BestTime Live or a
-- forecast endpoint.  They start as unknown and are deliberately ignored by
-- the engine until the refresh adapter stamps a verified live observation.
alter table public.venue_crowd_cache
  add column if not exists observation_mode text not null default 'unknown';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'venue_crowd_cache_observation_mode_check'
      and conrelid = 'public.venue_crowd_cache'::regclass
  ) then
    alter table public.venue_crowd_cache
      add constraint venue_crowd_cache_observation_mode_check
      check (observation_mode in ('live', 'forecast', 'unknown'));
  end if;
end;
$$;

create table if not exists public.crowd_historical_slots (
  place_id bigint not null references public.places(id) on delete cascade,
  local_weekday smallint not null check (local_weekday between 1 and 7),
  local_hour smallint not null check (local_hour between 0 and 23),
  average_score double precision not null check (average_score between 0 and 100),
  sample_count integer not null check (sample_count >= 0),
  distinct_days integer not null check (distinct_days >= 0),
  besttime_samples integer not null default 0 check (besttime_samples >= 0),
  telemetry_samples integer not null default 0 check (telemetry_samples >= 0),
  window_start timestamptz not null,
  refreshed_at timestamptz not null default now(),
  primary key (place_id, local_weekday, local_hour)
);

create index if not exists crowd_historical_slots_lookup_idx
  on public.crowd_historical_slots (local_weekday, local_hour, sample_count desc);

create or replace function public.refresh_crowd_historical_slots()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  upserted_count integer := 0;
  observation_window_start timestamptz := now() - interval '90 days';
begin
  with deduplicated_observations as (
    select distinct on (place_id, source, observed_at)
      place_id,
      source,
      score,
      observed_at
    from public.crowd_signals
    where observed_at >= observation_window_start
      and signal_type = 'observed'
      and metadata ->> 'kind' in ('besttime', 'telemetry')
      and score between 0 and 100
    order by place_id, source, observed_at, created_at desc
  ),
  slots as (
    select
      place_id,
      extract(isodow from observed_at at time zone 'Europe/Rome')::smallint as local_weekday,
      extract(hour from observed_at at time zone 'Europe/Rome')::smallint as local_hour,
      avg(score)::double precision as average_score,
      count(*)::integer as sample_count,
      count(distinct (observed_at at time zone 'Europe/Rome')::date)::integer as distinct_days,
      count(*) filter (where source = 'besttime')::integer as besttime_samples,
      count(*) filter (where source = 'live_city')::integer as telemetry_samples
    from deduplicated_observations
    group by place_id, local_weekday, local_hour
  )
  insert into public.crowd_historical_slots (
    place_id, local_weekday, local_hour, average_score, sample_count,
    distinct_days, besttime_samples, telemetry_samples, window_start, refreshed_at
  )
  select
    place_id, local_weekday, local_hour, average_score, sample_count,
    distinct_days, besttime_samples, telemetry_samples, observation_window_start, now()
  from slots
  on conflict (place_id, local_weekday, local_hour) do update
    set average_score = excluded.average_score,
        sample_count = excluded.sample_count,
        distinct_days = excluded.distinct_days,
        besttime_samples = excluded.besttime_samples,
        telemetry_samples = excluded.telemetry_samples,
        window_start = excluded.window_start,
        refreshed_at = excluded.refreshed_at;

  get diagnostics upserted_count = row_count;

  delete from public.crowd_historical_slots
  where refreshed_at < now() - interval '2 days';

  return jsonb_build_object(
    'slotsUpserted', upserted_count,
    'windowStart', observation_window_start,
    'minimumSamples', 12,
    'minimumDistinctDays', 3
  );
end;
$$;

alter table public.crowd_historical_slots enable row level security;
revoke all on table public.crowd_historical_slots from anon, authenticated;
revoke all on function public.refresh_crowd_historical_slots() from public, anon, authenticated;

do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid from cron.job where jobname = 'live-city-observed-history-nightly'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;

  perform cron.schedule(
    'live-city-observed-history-nightly',
    '13 2 * * *',
    $job$select public.refresh_crowd_historical_slots();$job$
  );
end;
$$;

commit;
