-- Supabase's safe-update guard requires an explicit WHERE on DELETE even
-- inside a security-definer refresh function. Keep migration 016 immutable
-- and replace only the affected function.

create or replace function public.refresh_weather_crowd_profiles()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  delete from public.weather_crowd_profiles
  where scope_type in ('place', 'category');

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
