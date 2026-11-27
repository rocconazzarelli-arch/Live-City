-- =============================================================================
-- LIVE CITY · California Bakery CityLife · domenica 2026-11-29
-- =============================================================================
-- Finestra locale: 08:00–11:00 Europe/Rome.
-- Letture: 08:30, 09:30, 10:30 = 3 crediti live massimi.
-- Registrazione BestTime: fino a 2 crediti. Budget aggiuntivo massimo = 5.
-- Budget combinato con Porta Venezia: 22 forecast + 66 live = 88 crediti.
--
-- Prima dell'esecuzione sostituire <BESTTIME_VENUE_ID_CALIFORNIA_BAKERY>
-- con l'id verificato restituito da BestTime. Lo script fallisce se il
-- placeholder è ancora presente.
-- =============================================================================

do $$
begin
  if '<BESTTIME_VENUE_ID_CALIFORNIA_BAKERY>' like '<%' then
    raise exception 'Inserire il BestTime venue id verificato prima di continuare';
  end if;
end;
$$;

insert into public.venue_mappings (
  fsq_place_id,
  fsq_name,
  besttime_venue_id,
  besttime_name,
  match_status,
  live_priority,
  live_read_hours,
  live_read_from,
  live_read_until,
  live_availability_status,
  live_suspended_at,
  live_suspension_reason
)
values (
  'test:citylife:california-bakery',
  'California Bakery CityLife',
  '<BESTTIME_VENUE_ID_CALIFORNIA_BAKERY>',
  'California Bakery CityLife',
  'matched',
  100,
  '{8,9,10}'::smallint[],
  timestamptz '2026-11-29 08:00:00+01',
  timestamptz '2026-11-29 11:00:00+01',
  'pending',
  null,
  null
)
on conflict (fsq_place_id) do update
set besttime_venue_id = excluded.besttime_venue_id,
    besttime_name = excluded.besttime_name,
    match_status = excluded.match_status,
    live_priority = excluded.live_priority,
    live_read_hours = excluded.live_read_hours,
    live_read_from = excluded.live_read_from,
    live_read_until = excluded.live_read_until,
    live_availability_status = 'pending',
    live_suspended_at = null,
    live_suspension_reason = null,
    updated_at = now();

do $$
declare
  due_count int;
  due_reads int;
  project_url text;
begin
  select decrypted_secret into project_url
  from vault.decrypted_secrets
  where name = 'supabase_project_url'
  limit 1;
  if project_url is null or project_url !~ '^https://[a-z0-9]+\.supabase\.co$' then
    raise exception 'Missing/invalid vault secret supabase_project_url';
  end if;

  select count(*)::int, coalesce(sum(cardinality(live_read_hours)), 0)::int
  into due_count, due_reads
  from public.venue_mappings
  where besttime_venue_id is not null
    and live_availability_status in ('pending', 'confirmed')
    and live_read_hours && '{8,9,10}'::smallint[]
    and (
      live_read_from is null
      or tstzrange(live_read_from, live_read_until, '[)') &&
        tstzrange(
          timestamptz '2026-11-29 08:00:00+01',
          timestamptz '2026-11-29 11:00:00+01',
          '[)'
        )
    );

  if due_count <> 1 or due_reads <> 3 then
    raise exception 'CityLife budget guard failed: expected 1 venue / 3 live, got % / %',
      due_count, due_reads;
  end if;
end;
$$;

do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid from cron.job
    where jobname = 'live-city-test-sunday-citylife'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end;
$$;

-- pg_cron usa UTC: 07:30–09:30 UTC = 08:30–10:30 Europe/Rome.
select cron.schedule('live-city-test-sunday-citylife', '30 7-9 * * 0', $job$
  select net.http_post(
    url := (
      select decrypted_secret || '/functions/v1/crowd-pipeline-refresh'
      from vault.decrypted_secrets
      where name = 'supabase_project_url' limit 1
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-refresh-secret', (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'crowd_pipeline_secret' limit 1
      )
    ),
    body := '{"forceProvider": true, "forceWeather": true}'::jsonb,
    timeout_milliseconds := 140000
  )
  where (now() at time zone 'Europe/Rome')::date = date '2026-11-29';
$job$);

select jobname, schedule, active
from cron.job
where jobname = 'live-city-test-sunday-citylife';

-- Dopo il test:
-- select cron.unschedule('live-city-test-sunday-citylife');
