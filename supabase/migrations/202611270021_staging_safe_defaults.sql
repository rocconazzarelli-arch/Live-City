-- Safe defaults for a newly-created staging project.
--
-- Historical migrations create HTTP cron jobs for the original Supabase
-- project. A clean staging deployment must never call that project or consume
-- BestTime/provider credits until the controlled test runbook is executed.

begin;

do $$
declare
  existing_job record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return;
  end if;

  for existing_job in
    select jobid
    from cron.job
    where jobname in (
      'live-city-crowd-pipeline-every-20-minutes',
      'live-city-hybrid-crowd-every-20-minutes',
      'live-city-mobility-source-daily',
      'live-city-test-friday',
      'live-city-test-saturday'
    )
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end;
$$;

comment on schema public is
  'LIVE CITY staging-safe schema: external provider cron jobs require explicit activation through the test runbook.';

commit;
