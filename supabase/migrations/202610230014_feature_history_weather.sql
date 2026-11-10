-- LIVE CITY: feature history for the predictive model.
-- Adds hourly Open-Meteo weather and a 20-minute history of every Crowd Engine
-- estimate with its flattened signals. Additive and rerunnable.

begin;

create table if not exists public.weather_observations (
  location_key text not null,
  observed_at timestamptz not null,
  latitude double precision not null,
  longitude double precision not null,
  temperature_c double precision,
  apparent_temperature_c double precision,
  relative_humidity_pct double precision,
  precipitation_mm double precision,
  rain_mm double precision,
  cloud_cover_pct double precision,
  wind_speed_kmh double precision,
  weather_code integer,
  is_day boolean,
  sunshine_duration_s double precision,
  data_kind text not null,
  provider text not null default 'open-meteo',
  fetched_at timestamptz not null default now(),
  primary key (location_key, observed_at),
  constraint weather_observations_data_kind_check
    check (data_kind in ('forecast', 'analysis', 'reanalysis'))
);

create index if not exists weather_observations_observed_at_idx
  on public.weather_observations (observed_at desc);

create or replace function public.weather_data_kind_rank(kind text)
returns integer
language sql
immutable
as $$
  select case kind
    when 'reanalysis' then 3
    when 'analysis' then 2
    when 'forecast' then 1
    else 0
  end;
$$;

-- Upserts weather rows while never replacing a value with a less
-- authoritative one. Returns the number of rows inserted or updated.
create or replace function public.upsert_weather_observations(p_rows jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  affected integer;
begin
  with upserted as (
    insert into public.weather_observations as existing (
      location_key, observed_at, latitude, longitude,
      temperature_c, apparent_temperature_c, relative_humidity_pct,
      precipitation_mm, rain_mm, cloud_cover_pct, wind_speed_kmh,
      weather_code, is_day, sunshine_duration_s, data_kind, provider, fetched_at
    )
    select
      r.location_key, r.observed_at, r.latitude, r.longitude,
      r.temperature_c, r.apparent_temperature_c, r.relative_humidity_pct,
      r.precipitation_mm, r.rain_mm, r.cloud_cover_pct, r.wind_speed_kmh,
      r.weather_code, r.is_day, r.sunshine_duration_s, r.data_kind,
      coalesce(r.provider, 'open-meteo'), now()
    from jsonb_to_recordset(p_rows) as r (
      location_key text,
      observed_at timestamptz,
      latitude double precision,
      longitude double precision,
      temperature_c double precision,
      apparent_temperature_c double precision,
      relative_humidity_pct double precision,
      precipitation_mm double precision,
      rain_mm double precision,
      cloud_cover_pct double precision,
      wind_speed_kmh double precision,
      weather_code integer,
      is_day boolean,
      sunshine_duration_s double precision,
      data_kind text,
      provider text
    )
    on conflict (location_key, observed_at) do update set
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      temperature_c = excluded.temperature_c,
      apparent_temperature_c = excluded.apparent_temperature_c,
      relative_humidity_pct = excluded.relative_humidity_pct,
      precipitation_mm = excluded.precipitation_mm,
      rain_mm = excluded.rain_mm,
      cloud_cover_pct = excluded.cloud_cover_pct,
      wind_speed_kmh = excluded.wind_speed_kmh,
      weather_code = excluded.weather_code,
      is_day = excluded.is_day,
      sunshine_duration_s = excluded.sunshine_duration_s,
      data_kind = excluded.data_kind,
      provider = excluded.provider,
      fetched_at = excluded.fetched_at
    where public.weather_data_kind_rank(excluded.data_kind)
      >= public.weather_data_kind_rank(existing.data_kind)
    returning 1
  )
  select count(*) into affected from upserted;

  return affected;
end;
$$;

create table if not exists public.crowd_history (
  place_id bigint not null references public.places(id) on delete cascade,
  bucket_start timestamptz not null,
  calculated_at timestamptz not null,
  score integer not null,
  activity_level text not null,
  confidence double precision not null,
  dominant_source text not null,
  is_fallback boolean not null,
  historical_score double precision,
  besttime_score double precision,
  besttime_observed_at timestamptz,
  besttime_stale boolean,
  telemetry_score double precision,
  telemetry_sessions integer,
  event_boost double precision not null default 0,
  event_count integer not null default 0,
  signal_count integer not null default 0,
  formula_version text not null,
  primary key (place_id, bucket_start),
  constraint crowd_history_score_check check (score between 0 and 100),
  -- Mirrors the engine's privacy threshold: small groups are never stored.
  constraint crowd_history_telemetry_privacy_check
    check (telemetry_sessions is null or telemetry_sessions >= 5)
);

create index if not exists crowd_history_bucket_idx
  on public.crowd_history (bucket_start desc);

alter table public.weather_observations enable row level security;
alter table public.crowd_history enable row level security;

-- Backend-only: no client policies. Edge Functions use the service role.
revoke all on table public.weather_observations from anon, authenticated;
revoke all on table public.crowd_history from anon, authenticated;
revoke all on function public.upsert_weather_observations(jsonb) from public, anon, authenticated;

comment on table public.weather_observations is
  'Hourly Open-Meteo weather per location; data_kind ranks forecast < analysis < reanalysis.';
comment on table public.crowd_history is
  'Aggregate 20-minute Crowd Engine history per place, kept as training data for the predictive model.';

commit;
