-- Stop paid BestTime Live reads for one venue as soon as the provider
-- explicitly reports that no live observation is available for that venue.
-- Transient/global provider failures remain retryable and never change the
-- per-venue status.

begin;

alter table public.venue_mappings
  add column if not exists live_availability_status text not null default 'pending',
  add column if not exists live_suspended_at timestamptz,
  add column if not exists live_suspension_reason text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'venue_mappings_live_availability_status_check'
      and conrelid = 'public.venue_mappings'::regclass
  ) then
    alter table public.venue_mappings
      add constraint venue_mappings_live_availability_status_check
      check (live_availability_status in ('pending', 'confirmed', 'suspended'));
  end if;
end
$$;

create index if not exists venue_mappings_live_credit_guard_idx
  on public.venue_mappings (live_priority desc, besttime_venue_id)
  where besttime_venue_id is not null
    and live_availability_status in ('pending', 'confirmed');

comment on column public.venue_mappings.live_availability_status is
  'BestTime paid-read guard: pending/confirmed are eligible; suspended is excluded until an explicit manual reset.';
comment on column public.venue_mappings.live_suspended_at is
  'When this venue was excluded after BestTime explicitly returned no usable live observation.';
comment on column public.venue_mappings.live_suspension_reason is
  'Bounded internal reason for the paid-read suspension; never stores provider payloads or credentials.';

commit;
