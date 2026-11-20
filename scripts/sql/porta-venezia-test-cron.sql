-- =============================================================================
-- LIVE CITY · Test Porta Venezia (10 venue) — configurazione cron della finestra
-- =============================================================================
-- Scopo: durante la prova gratuita BestTime (~100 crediti), leggere il live
--   SOLO nella finestra del test invece che ogni 20 minuti in continuo.
--
-- Finestra: venerdì 20:00 -> sabato 02:00 (Europe/Rome), 1 lettura all'ora.
--   = 7 letture. Con 10 venue mappate: 70 crediti live + 20 forecast = 90.
--
-- Fuso: pg_cron su Supabase gira in UTC. A novembre Rome = UTC+1, quindi:
--   Rome 20:00–00:00 -> UTC 19:00–23:00 (venerdì, dow=5)
--   Rome 01:00–02:00 -> UTC 00:00–01:00 (sabato,  dow=6)
--   Se `show timezone;` restituisce 'Europe/Rome', usa invece gli schedule
--   indicati nei commenti "ROME:".
--
-- PREREQUISITI prima di eseguire (entro le 20:00):
--   1) 10 forecast creati su BestTime (20cr) -> 10 besttime_venue_id.
--   2) SOLO le 10 venue nel catalogo venue_mappings (guardia del budget).
--   3) La pipeline continua va messa in pausa (STEP 1 qui sotto).
-- Eseguire nel SQL editor di Supabase.
-- =============================================================================

-- STEP 1 — PAUSA la pipeline continua (ogni 20 min): altrimenti brucia i crediti.
select cron.unschedule('live-city-crowd-pipeline-every-20-minutes');

-- STEP 2 — Venerdì sera: Rome 20:00–00:00 = UTC 19:00–23:00 (5 letture).
--   ROME: '0 20-23 * * 5'
select cron.schedule('live-city-test-friday', '0 19-23 * * 5', $job$
  select net.http_post(
    url := 'https://qmskozzidachccwbtejd.supabase.co/functions/v1/crowd-pipeline-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-refresh-secret', (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'crowd_pipeline_secret' limit 1
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 140000
  );
$job$);

-- STEP 3 — Sabato notte: Rome 01:00–02:00 = UTC 00:00–01:00 (2 letture).
--   ROME: '0 0-2 * * 6'
select cron.schedule('live-city-test-saturday', '0 0-1 * * 6', $job$
  select net.http_post(
    url := 'https://qmskozzidachccwbtejd.supabase.co/functions/v1/crowd-pipeline-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-refresh-secret', (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'crowd_pipeline_secret' limit 1
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 140000
  );
$job$);

-- VERIFICA — fuso e job attivi.
show timezone;                                   -- atteso: UTC
select jobname, schedule, active from cron.job order by jobname;

-- VERIFICA (dopo le 20:00) — il live sta arrivando?
-- select besttime_venue_id, crowd_score, observation_mode, fetched_at
-- from public.venue_crowd_cache order by fetched_at desc limit 20;

-- =============================================================================
-- REVERT (dopo il test) — ferma la finestra. NON riattivare la pipeline 20-min
-- finché sei sul piano a pagamento: i crediti trial saranno finiti.
-- =============================================================================
-- select cron.unschedule('live-city-test-friday');
-- select cron.unschedule('live-city-test-saturday');
