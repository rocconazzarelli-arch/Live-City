-- LIVE CITY: scalable 20-minute refresh and privacy-bounded location telemetry.
-- Additive and rerunnable. Secret values are stored separately in Supabase Vault.

begin;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

alter table public.places
  add column if not exists catalog_source text not null default 'foursquare',
  add column if not exists source_place_id text;

update public.places
set source_place_id = fsq_place_id
where source_place_id is null;

create index if not exists location_observations_observed_at_idx
  on public.location_observations (observed_at desc);
create index if not exists location_observations_place_time_idx
  on public.location_observations (matched_place_id, observed_at desc)
  where matched_place_id is not null;
create index if not exists location_observations_session_time_idx
  on public.location_observations (session_id, observed_at desc);
create index if not exists place_presences_last_seen_idx
  on public.place_presences (last_seen_at desc);
create index if not exists crowd_snapshots_place_window_idx
  on public.crowd_snapshots (place_id, window_end desc);

create or replace function public.purge_expired_location_telemetry()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  observations_deleted integer;
  presences_deleted integer;
  signals_deleted integer;
begin
  delete from public.location_observations
  where observed_at < now() - interval '24 hours';
  get diagnostics observations_deleted = row_count;

  delete from public.place_presences
  where last_seen_at < now() - interval '7 days';
  get diagnostics presences_deleted = row_count;

  delete from public.crowd_signals
  where valid_until < now() - interval '24 hours';
  get diagnostics signals_deleted = row_count;

  return jsonb_build_object(
    'observationsDeleted', observations_deleted,
    'presencesDeleted', presences_deleted,
    'signalsDeleted', signals_deleted,
    'executedAt', now()
  );
end;
$$;

revoke all on function public.purge_expired_location_telemetry() from public, anon, authenticated;

do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid from cron.job
    where jobname in ('live-city-crowd-pipeline-every-20-minutes', 'live-city-location-retention')
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;

  perform cron.schedule(
    'live-city-crowd-pipeline-every-20-minutes',
    '*/20 * * * *',
    $job$
      select net.http_post(
        url := 'https://qmskozzidachccwbtejd.supabase.co/functions/v1/crowd-pipeline-refresh',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-refresh-secret', (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'crowd_pipeline_secret'
            limit 1
          )
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 140000
      );
    $job$
  );

  perform cron.schedule(
    'live-city-location-retention',
    '17 * * * *',
    $job$select public.purge_expired_location_telemetry();$job$
  );
end;
$$;

commit;
