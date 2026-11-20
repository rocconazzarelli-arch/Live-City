-- =============================================================================
-- LIVE CITY · Test Porta Venezia — cron della serata (letture alle :30)
-- =============================================================================
-- Il cron lancia la pipeline una volta all'ora, alle :30, da venerdì 19:30 a
-- sabato 01:30 (Europe/Rome) = 7 esecuzioni. In ogni esecuzione crowd-refresh
-- legge SOLO le venue il cui `live_read_hours` contiene l'ora corrente di Roma
-- (vedi scripts/sql/porta-venezia-venue-schedule.sql). Con il piano attuale:
-- 12+12+12+12+10+10+7 = 75 chiamate live.
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
--   1) Migration 202611200019_venue_live_read_hours.sql applicata.
--   2) Edge function crowd-refresh ri-deployata (legge live_read_hours).
--   3) venue_mappings + orari impostati con porta-venezia-venue-schedule.sql,
--      e i suoi controlli di budget superati.
-- Eseguire nel SQL editor di Supabase.
-- =============================================================================

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
    url := 'https://qmskozzidachccwbtejd.supabase.co/functions/v1/crowd-pipeline-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-refresh-secret', (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'crowd_pipeline_secret' limit 1
      )
    ),
    body := '{"forceProvider": true, "forceWeather": true}'::jsonb,
    timeout_milliseconds := 140000
  );
$job$);

-- STEP 3 — Sabato: Rome 01:30 = UTC 00:30 (1 esecuzione).
--   ROME: '30 0-1 * * 6'
select cron.schedule('live-city-test-saturday', '30 0 * * 6', $job$
  select net.http_post(
    url := 'https://qmskozzidachccwbtejd.supabase.co/functions/v1/crowd-pipeline-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-refresh-secret', (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'crowd_pipeline_secret' limit 1
      )
    ),
    body := '{"forceProvider": true, "forceWeather": true}'::jsonb,
    timeout_milliseconds := 140000
  );
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
