-- Make BestTime scheduling fail closed. A newly inserted or partially
-- configured venue must never become eligible for paid live reads merely
-- because its schedule is missing.

begin;

update public.venue_mappings
set live_read_hours = '{}'::smallint[]
where live_read_hours is null;

alter table public.venue_mappings
  alter column live_read_hours set default '{}'::smallint[],
  alter column live_read_hours set not null;

comment on column public.venue_mappings.live_read_hours is
  'Europe/Rome clock hours (0-23) in which BestTime Live may be read for this venue. Empty = never; missing schedules fail closed.';

commit;
