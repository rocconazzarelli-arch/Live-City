-- Optional absolute window for one-off BestTime tests. The hourly schedule is
-- still required; these bounds add a second fail-closed guard so a manual or
-- recurring refresh cannot consume credits on another day.

begin;

alter table public.venue_mappings
  add column if not exists live_read_from timestamptz,
  add column if not exists live_read_until timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'venue_mappings_live_read_window_check'
      and conrelid = 'public.venue_mappings'::regclass
  ) then
    alter table public.venue_mappings
      add constraint venue_mappings_live_read_window_check
      check (
        (live_read_from is null and live_read_until is null)
        or (
          live_read_from is not null
          and live_read_until is not null
          and live_read_until > live_read_from
        )
      );
  end if;
end;
$$;

comment on column public.venue_mappings.live_read_from is
  'Inclusive absolute start for paid live reads. NULL with live_read_until NULL means no date restriction.';
comment on column public.venue_mappings.live_read_until is
  'Exclusive absolute end for paid live reads. Partial or malformed windows fail closed in the Edge Function.';

do $$
declare
  existing_job record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return;
  end if;
  for existing_job in
    select jobid from cron.job
    where jobname = 'live-city-test-sunday-citylife'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end;
$$;

commit;
