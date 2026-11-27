-- =============================================================================
-- LIVE CITY · Test Porta Venezia — cron della serata (letture alle :30)
-- =============================================================================
-- Il cron lancia la pipeline una volta all'ora, alle :30, da venerdì 19:30 a
-- sabato 01:30 (Europe/Rome) = 7 esecuzioni. In ogni esecuzione crowd-refresh
-- legge SOLO le venue il cui `live_read_hours` contiene l'ora corrente di Roma
-- (vedi scripts/sql/porta-venezia-venue-schedule.sql). Con il piano attuale:
-- 10+10+10+10+9+8+6 = 63 chiamate live.
--
-- IMPORTANTE: la pipeline chiama BestTime solo nei primi 5 minuti dell'ora,
-- a meno che non riceva {"forceProvider": true}. Alle :30 il flag è
-- obbligatorio, altrimenti nessuna venue viene letta. `forceWeather` fa
-- archiviare anche il meteo Open-Meteo ad ogni esecuzione.
--
-- Fuso: pg_cron su Supabase gira in UTC. A novembre Rome = UTC+1:
--   Rome 19:30–00:30 (ven) -> UTC '30 18-23 * * 5'   (6 esecuzioni)
--   Rome 01:30       (sab) -> UTC '30 0 * * 6'       (1 esecuzione)
--   Se `show timezone;` restituisce 'Europe/Rome', usa gli schedule "ROME:".
--
-- PREREQUISITI (prima delle 19:30):
--   1) Migration 202611260020_venue_live_read_hours_fail_closed.sql applicata.
--   2) Edge function crowd-refresh ri-deployata (legge live_read_hours).
--   3) venue_mappings + orari impostati con porta-venezia-venue-schedule.sql,
--      e i suoi controlli di budget superati: 10 venue / 63 live.
--   4) Vault secret `supabase_project_url` impostato all'URL DEL PROGETTO
--      STAGING (es. https://<project-ref>.supabase.co, senza slash finale).
-- Eseguire nel SQL editor di Supabase.
-- Prima dell'esecuzione sostituire <TEST_FRIDAY_YYYY-MM-DD> con la data locale
-- del venerdì scelto (es. 2026-11-27). La data guard impedisce chiamate nelle
-- settimane successive anche se i job non vengono rimossi subito.
-- =============================================================================

-- STEP 0 — Guardia bloccante. Mostra il budget e interrompe lo script se la
-- configurazione non è esattamente quella approvata.
with hourly as (
  select hour, count(*)::int as venues
  from public.venue_mappings, unnest(live_read_hours) as hour
  where besttime_venue_id is not null
  group by hour
), budget as (
  select
    count(*) filter (where cardinality(live_read_hours) > 0)::int as scheduled_venues,
    coalesce(sum(cardinality(live_read_hours)), 0)::int as planned_live_reads
  from public.venue_mappings
  where besttime_venue_id is not null
)
select scheduled_venues, planned_live_reads, 20 as forecast_credits,
       planned_live_reads + 20 as maximum_total_credits,
       (select jsonb_object_agg(hour, venues) from hourly) as reads_by_rome_hour
from budget;

do $$
declare
  scheduled_count int;
  live_count int;
  hourly_plan jsonb;
  project_url text;
begin
  select decrypted_secret into project_url
  from vault.decrypted_secrets
  where name = 'supabase_project_url'
  limit 1;

  if project_url is null or project_url !~ '^https://[a-z0-9]+\.supabase\.co$' then
    raise exception 'Missing/invalid vault secret supabase_project_url';
  end if;

  select count(*) filter (where cardinality(live_read_hours) > 0)::int,
         coalesce(sum(cardinality(live_read_hours)), 0)::int
  into scheduled_count, live_count
  from public.venue_mappings
  where besttime_venue_id is not null;

  select jsonb_object_agg(hour, venues)
  into hourly_plan
  from (
    select hour, count(*)::int as venues
    from public.venue_mappings, unnest(live_read_hours) as hour
    where besttime_venue_id is not null
    group by hour
  ) h;

  if scheduled_count <> 10 or live_count <> 63 then
    raise exception 'Budget guard failed: expected 10 venues / 63 live, got % / %',
      scheduled_count, live_count;
  end if;
  if hourly_plan <> '{"0":8,"1":6,"19":10,"20":10,"21":10,"22":10,"23":9}'::jsonb then
    raise exception 'Hourly budget guard failed: %', hourly_plan;
  end if;
end;
$$;

-- STEP 1 — Pausa della pipeline continua e pulizia di eventuali job di test.
do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid from cron.job
    where jobname in (
      'live-city-crowd-pipeline-every-20-minutes',
      'live-city-test-friday',
      'live-city-test-saturday'
    )
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end;
$$;

-- STEP 2 — Venerdì: Rome 19:30–00:30 = UTC 18:30–23:30 (6 esecuzioni).
--   ROME: '30 19-23 * * 5'
select cron.schedule('live-city-test-friday', '30 18-23 * * 5', $job$
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
  where (now() at time zone 'Europe/Rome')::date in (
    date '<TEST_FRIDAY_YYYY-MM-DD>',
    date '<TEST_FRIDAY_YYYY-MM-DD>' + 1
  );
$job$);

-- STEP 3 — Sabato: Rome 01:30 = UTC 00:30 (1 esecuzione).
--   ROME: '30 0-1 * * 6'
select cron.schedule('live-city-test-saturday', '30 0 * * 6', $job$
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
  where (now() at time zone 'Europe/Rome')::date =
    date '<TEST_FRIDAY_YYYY-MM-DD>' + 1;
$job$);

-- VERIFICA — fuso e job attivi.
show timezone;                                   -- atteso: UTC
select jobname, schedule, active from cron.job order by jobname;

-- VERIFICA (dopo ogni esecuzione) — quante venue lette e quante saltate.
-- select started_at, requested_count, live_written_count, unavailable_count,
--        failure_count, metadata ->> 'romeHour' as rome_hour,
--        metadata ->> 'scheduledSkipped' as skipped
-- from public.crowd_provider_runs order by started_at desc limit 10;

-- =============================================================================
-- REVERT (dopo il test). NON riattivare la pipeline 20-min finché sei sulla
-- trial: ogni lettura consuma crediti.
-- =============================================================================
-- select cron.unschedule('live-city-test-friday');
-- select cron.unschedule('live-city-test-saturday');
