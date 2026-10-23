-- Priority keeps costly BestTime Live refreshes within the LIVE CITY budget.
-- Only the first 100 mapped venues are eligible in a single hourly refresh.

begin;

alter table public.venue_mappings
  add column if not exists live_priority smallint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'venue_mappings_live_priority_check'
      and conrelid = 'public.venue_mappings'::regclass
  ) then
    alter table public.venue_mappings
      add constraint venue_mappings_live_priority_check
      check (live_priority between 0 and 100);
  end if;
end;
$$;

create index if not exists venue_mappings_live_priority_idx
  on public.venue_mappings (live_priority desc, besttime_venue_id)
  where besttime_venue_id is not null;

comment on column public.venue_mappings.live_priority is
  'BestTime Live refresh rank: higher rows are read first, with a hard maximum of 100 per refresh.';

commit;
