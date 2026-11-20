-- Per-venue BestTime Live read windows.
-- Each live call costs a provider credit, including calls to closed venues.
-- `live_read_hours` lists the Europe/Rome clock hours (0-23) in which
-- crowd-refresh may query a venue. NULL keeps the previous behaviour (read on
-- every refresh); an empty array disables live reads for that venue.

begin;

alter table public.venue_mappings
  add column if not exists live_read_hours smallint[];

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'venue_mappings_live_read_hours_check'
      and conrelid = 'public.venue_mappings'::regclass
  ) then
    alter table public.venue_mappings
      add constraint venue_mappings_live_read_hours_check
      check (
        live_read_hours is null or
        live_read_hours <@ array[
          0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
          12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23
        ]::smallint[]
      );
  end if;
end;
$$;

comment on column public.venue_mappings.live_read_hours is
  'Europe/Rome clock hours (0-23) in which BestTime Live may be read for this venue. NULL = every refresh; empty = never.';

commit;
