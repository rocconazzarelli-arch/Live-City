-- LIVE CITY: weather-aware crowd forecasts.
-- Weather never becomes a presence observation. It learns a bounded
-- correction to the observed place/weekday/hour baseline and is used only
-- for future forecasts.

begin;

alter table public.crowd_history
  add column if not exists mastercard_score double precision,
  add column if not exists mastercard_transactions integer;

alter table public.crowd_history
  drop constraint if exists crowd_history_mastercard_privacy_check;
alter table public.crowd_history
  add constraint crowd_history_mastercard_privacy_check
  check (mastercard_transactions is null or mastercard_transactions >= 5);

create table if not exists public.weather_crowd_profiles (
  scope_type text not null check (scope_type in ('place', 'category')),
  scope_key text not null,
  place_id bigint references public.places(id) on delete cascade,
  category text check (category in ('aperitivo', 'food', 'nightlife', 'outdoor', 'culture')),
  daypart text not null check (daypart in ('night', 'morning', 'afternoon', 'evening')),
  rain_delta double precision,
  rain_samples integer not null default 0,
  heavy_rain_delta double precision,
  heavy_rain_samples integer not null default 0,
  hot_delta double precision,
  hot_samples integer not null default 0,
  cold_delta double precision,
  cold_samples integer not null default 0,
  strong_wind_delta double precision,
  strong_wind_samples integer not null default 0,
  pleasant_delta double precision,
  pleasant_samples integer not null default 0,
  sample_count integer not null,
  distinct_days integer not null,
  confidence double precision not null check (confidence between 0 and 1),
  trained_through timestamptz not null,
  refreshed_at timestamptz not null default now(),
  primary key (scope_type, scope_key, daypart),
  constraint weather_crowd_profile_scope_check check (
    (scope_type = 'place' and place_id is not null and category is not null) or
    (scope_type = 'category' and place_id is null and category is not null)
  )
);

create index if not exists weather_crowd_profiles_place_idx
  on public.weather_crowd_profiles (place_id, daypart)
  where scope_type = 'place';
create index if not exists weather_crowd_profiles_category_idx
  on public.weather_crowd_profiles (category, daypart)
  where scope_type = 'category';

alter table public.weather_crowd_profiles enable row level security;
revoke all on table public.weather_crowd_profiles from public, anon, authenticated;

create or replace function public.refresh_weather_crowd_profiles()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  delete from public.weather_crowd_profiles;

  with qualified as (
    select
      h.place_id,
      p.category,
      h.bucket_start,
      h.score::double precision - h.event_boost as observed_score,
      case
        when extract(hour from timezone('Europe/Rome', h.bucket_start)) < 6 then 'night'
        when extract(hour from timezone('Europe/Rome', h.bucket_start)) < 12 then 'morning'
        when extract(hour from timezone('Europe/Rome', h.bucket_start)) < 18 then 'afternoon'
        else 'evening'
      end as daypart,
      w.apparent_temperature_c,
      greatest(coalesce(w.precipitation_mm, 0), coalesce(w.rain_mm, 0)) as precipitation,
      coalesce(w.wind_speed_kmh, 0) as wind_speed_kmh,
      coalesce(w.sunshine_duration_s, 0) as sunshine_duration_s
    from public.crowd_history h
    join public.places p on p.id = h.place_id
    join public.weather_observations w
      on w.location_key = 'milano'
     and w.observed_at = date_trunc('hour', h.bucket_start)
     and w.data_kind in ('analysis', 'reanalysis')
    where h.is_fallback = false
      and (h.besttime_score is not null or h.telemetry_score is not null)
      and h.bucket_start >= now() - interval '365 days'
  ), baselined as (
    select
      q.*,
      avg(observed_score) over (
        partition by place_id,
          extract(isodow from timezone('Europe/Rome', bucket_start)),
          extract(hour from timezone('Europe/Rome', bucket_start))
      ) as baseline_score
    from qualified q
  ), residuals as (
    select
      *,
      observed_score - baseline_score as residual,
      precipitation >= 0.1 and precipitation < 2 as is_rain,
      precipitation >= 2 as is_heavy_rain,
      apparent_temperature_c >= 29 as is_hot,
      apparent_temperature_c <= 7 as is_cold,
      wind_speed_kmh >= 25 as is_strong_wind,
      precipitation < 0.1
        and apparent_temperature_c between 15 and 25
        and wind_speed_kmh < 20
        and sunshine_duration_s >= 900 as is_pleasant
    from baselined
  ), scoped as (
    select
      'place'::text as scope_type,
      'place:' || place_id::text as scope_key,
      place_id,
      category,
      daypart,
      bucket_start,
      residual,
      is_rain, is_heavy_rain, is_hot, is_cold, is_strong_wind, is_pleasant
    from residuals
    union all
    select
      'category'::text,
      'category:' || category,
      null::bigint,
      category,
      daypart,
      bucket_start,
      residual,
      is_rain, is_heavy_rain, is_hot, is_cold, is_strong_wind, is_pleasant
    from residuals
  ), aggregated as (
    select
      scope_type, scope_key, place_id, category, daypart,
      count(*)::integer as sample_count,
      count(distinct timezone('Europe/Rome', bucket_start)::date)::integer as distinct_days,
      max(bucket_start) as trained_through,
      count(*) filter (where is_rain)::integer as rain_samples,
      count(distinct timezone('Europe/Rome', bucket_start)::date) filter (where is_rain) as rain_days,
      avg(residual) filter (where is_rain) as rain_delta,
      count(*) filter (where is_heavy_rain)::integer as heavy_rain_samples,
      count(distinct timezone('Europe/Rome', bucket_start)::date) filter (where is_heavy_rain) as heavy_rain_days,
      avg(residual) filter (where is_heavy_rain) as heavy_rain_delta,
      count(*) filter (where is_hot)::integer as hot_samples,
      count(distinct timezone('Europe/Rome', bucket_start)::date) filter (where is_hot) as hot_days,
      avg(residual) filter (where is_hot) as hot_delta,
      count(*) filter (where is_cold)::integer as cold_samples,
      count(distinct timezone('Europe/Rome', bucket_start)::date) filter (where is_cold) as cold_days,
      avg(residual) filter (where is_cold) as cold_delta,
      count(*) filter (where is_strong_wind)::integer as strong_wind_samples,
      count(distinct timezone('Europe/Rome', bucket_start)::date) filter (where is_strong_wind) as strong_wind_days,
      avg(residual) filter (where is_strong_wind) as strong_wind_delta,
      count(*) filter (where is_pleasant)::integer as pleasant_samples,
      count(distinct timezone('Europe/Rome', bucket_start)::date) filter (where is_pleasant) as pleasant_days,
      avg(residual) filter (where is_pleasant) as pleasant_delta
    from scoped
    group by scope_type, scope_key, place_id, category, daypart
  )
  insert into public.weather_crowd_profiles (
    scope_type, scope_key, place_id, category, daypart,
    rain_delta, rain_samples, heavy_rain_delta, heavy_rain_samples,
    hot_delta, hot_samples, cold_delta, cold_samples,
    strong_wind_delta, strong_wind_samples, pleasant_delta, pleasant_samples,
    sample_count, distinct_days, confidence, trained_through, refreshed_at
  )
  select
    scope_type, scope_key, place_id, category, daypart,
    case when rain_samples >= 8 and rain_days >= 3 then round(rain_delta::numeric, 2)::double precision end,
    rain_samples,
    case when heavy_rain_samples >= 8 and heavy_rain_days >= 3 then round(heavy_rain_delta::numeric, 2)::double precision end,
    heavy_rain_samples,
    case when hot_samples >= 8 and hot_days >= 3 then round(hot_delta::numeric, 2)::double precision end,
    hot_samples,
    case when cold_samples >= 8 and cold_days >= 3 then round(cold_delta::numeric, 2)::double precision end,
    cold_samples,
    case when strong_wind_samples >= 8 and strong_wind_days >= 3 then round(strong_wind_delta::numeric, 2)::double precision end,
    strong_wind_samples,
    case when pleasant_samples >= 8 and pleasant_days >= 3 then round(pleasant_delta::numeric, 2)::double precision end,
    pleasant_samples,
    sample_count,
    distinct_days,
    least(
      case when scope_type = 'place' then 0.85 else 0.75 end,
      sqrt(sample_count::double precision) / 20.0 * least(1.0, distinct_days / 14.0)
    ),
    trained_through,
    now()
  from aggregated
  where (scope_type = 'place' and sample_count >= 30 and distinct_days >= 7)
     or (scope_type = 'category' and sample_count >= 60 and distinct_days >= 10);

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.refresh_weather_crowd_profiles() from public, anon, authenticated;

-- Rebuild historical slots from durable history instead of crowd_signals,
-- whose short retention prevented the 12-observation threshold from being
-- reached. Event boosts and unavailable/fallback estimates are excluded.
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
  with qualified as (
    select
      h.*,
      extract(isodow from timezone('Europe/Rome', h.bucket_start))::integer as local_weekday,
      extract(hour from timezone('Europe/Rome', h.bucket_start))::integer as local_hour,
      greatest(0, least(100, h.score - h.event_boost))::double precision as observed_score,
      case
        when h.telemetry_score is null
         and h.mastercard_score is null
         and h.besttime_observed_at is not null
          then 'besttime:' || h.besttime_observed_at::text
        else 'bucket:' || h.bucket_start::text
      end as observation_key
    from public.crowd_history h
    where h.is_fallback = false
      and (
        h.besttime_score is not null or
        h.telemetry_score is not null or
        h.mastercard_score is not null
      )
      and h.bucket_start >= observation_window_start
  ), deduplicated as (
    select * from (
      select q.*, row_number() over (
        partition by place_id, observation_key order by bucket_start desc
      ) as duplicate_rank
      from qualified q
    ) ranked
    where duplicate_rank = 1
  ), aggregated as (
    select
      place_id,
      local_weekday,
      local_hour,
      avg(observed_score) as average_score,
      count(*)::integer as sample_count,
      count(distinct timezone('Europe/Rome', bucket_start)::date)::integer as distinct_days,
      count(*) filter (where besttime_score is not null)::integer as besttime_samples,
      count(*) filter (where mastercard_score is not null)::integer as mastercard_samples,
      count(*) filter (where telemetry_score is not null)::integer as telemetry_samples,
      min(bucket_start) as first_observed_at
    from deduplicated
    group by place_id, local_weekday, local_hour
  )
  insert into public.crowd_historical_slots (
    place_id, local_weekday, local_hour, average_score, sample_count,
    distinct_days, besttime_samples, mastercard_samples, telemetry_samples,
    window_start, refreshed_at
  )
  select
    place_id, local_weekday, local_hour, average_score, sample_count,
    distinct_days, besttime_samples, mastercard_samples, telemetry_samples,
    observation_window_start, now()
  from aggregated
  on conflict (place_id, local_weekday, local_hour) do update set
    average_score = excluded.average_score,
    sample_count = excluded.sample_count,
    distinct_days = excluded.distinct_days,
    besttime_samples = excluded.besttime_samples,
    mastercard_samples = excluded.mastercard_samples,
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
    'minimumDistinctDays', 3,
    'source', 'durable_crowd_history'
  );
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'weather-crowd-profile-nightly') then
      perform cron.unschedule('weather-crowd-profile-nightly');
    end if;
    perform cron.schedule(
      'weather-crowd-profile-nightly',
      '35 2 * * *',
      $job$select public.refresh_weather_crowd_profiles();$job$
    );
  end if;
end;
$$;

comment on table public.weather_crowd_profiles is
  'Hierarchical weather effects learned from verified crowd residuals. Weather is a forecast correction, never a presence observation.';

commit;
