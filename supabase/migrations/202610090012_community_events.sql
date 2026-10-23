-- LIVE CITY: authenticated community events and transparent area forecasts.
-- A published event is a declared planning signal, never an observed footfall
-- signal. It may inform a forecast, but cannot satisfy telemetry privacy rules.

begin;

create table if not exists public.community_events (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 3 and 90),
  description text check (description is null or char_length(trim(description)) <= 500),
  category text not null check (category in ('aperitivo', 'food', 'nightlife', 'outdoor', 'culture')),
  place_id bigint references public.places(id) on delete set null,
  latitude double precision not null check (latitude between 45.35 and 45.58),
  longitude double precision not null check (longitude between 8.98 and 9.35),
  start_at timestamptz not null,
  end_at timestamptz not null,
  expected_attendance integer not null check (expected_attendance between 2 and 5000),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at),
  check (end_at <= start_at + interval '24 hours')
);

create index if not exists community_events_active_window_idx
  on public.community_events (start_at, end_at)
  where is_active = true;

create index if not exists community_events_creator_idx
  on public.community_events (created_by, created_at desc);

alter table public.community_events enable row level security;

drop policy if exists "public reads active community events" on public.community_events;
create policy "public reads active community events"
  on public.community_events for select
  to anon, authenticated
  using (is_active = true and end_at >= now());

drop policy if exists "users publish their community events" on public.community_events;
create policy "users publish their community events"
  on public.community_events for insert
  to authenticated
  with check (created_by = auth.uid());

drop policy if exists "users manage their community events" on public.community_events;
create policy "users manage their community events"
  on public.community_events for update
  to authenticated
  using (created_by = auth.uid())
  with check (created_by = auth.uid());

create or replace function public.set_community_event_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists community_events_touch_updated_at on public.community_events;
create trigger community_events_touch_updated_at
before update on public.community_events
for each row execute function public.set_community_event_updated_at();

comment on table public.community_events is
  'User-published public events. Attendance is a declared forecast input, never verified foot traffic.';

commit;
