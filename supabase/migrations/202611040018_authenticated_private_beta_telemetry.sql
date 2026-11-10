-- LIVE CITY: authenticated, revocable private-beta location contribution.
-- Auth identities are retained only in the consent register. Location rows use
-- a rotating HMAC pseudonym and remain unreadable to clients.

begin;

create table if not exists public.private_beta_participants (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null check (status in ('active', 'withdrawn')),
  consent_version text not null,
  consented_at timestamptz not null,
  revoked_at timestamptz,
  last_contribution_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists private_beta_participants_status_idx
  on public.private_beta_participants (status, updated_at desc);

alter table public.private_beta_participants enable row level security;
revoke all on table public.private_beta_participants from public, anon, authenticated;

comment on table public.private_beta_participants is
  'Backend-only consent register for authenticated private-beta location contributors; location observations store only rotating pseudonyms.';

create or replace function public.refresh_crowd_area_snapshots()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  window_end_at timestamptz := date_trunc('minute', now());
  window_start_at timestamptz := date_trunc('minute', now()) - interval '20 minutes';
  inserted_count integer := 0;
begin
  insert into public.crowd_area_snapshots (
    grid_key, center_latitude, center_longitude, window_start, window_end,
    distinct_sessions, observation_count, density_score
  )
  select
    grid_lat::text || ':' || grid_lng::text,
    (grid_lat + 0.5) * 0.004,
    (grid_lng + 0.5) * 0.004,
    window_start_at,
    window_end_at,
    count(distinct session_id)::integer,
    count(*)::integer,
    least(100, round(count(distinct session_id) * 5.0))::integer
  from public.location_observations
  where observed_at >= window_start_at
    and observed_at < window_end_at
    and consent_version = '2026-11-private-beta-2'
    and grid_lat is not null
    and grid_lng is not null
  group by grid_lat, grid_lng
  having count(distinct session_id) >= 5
  on conflict (grid_key, window_end) do update
    set distinct_sessions = excluded.distinct_sessions,
        observation_count = excluded.observation_count,
        density_score = excluded.density_score,
        created_at = now();

  get diagnostics inserted_count = row_count;
  delete from public.crowd_area_snapshots where window_end < now() - interval '24 hours';
  return jsonb_build_object(
    'cellsPublished', inserted_count,
    'windowStart', window_start_at,
    'windowEnd', window_end_at,
    'privacyThreshold', 5,
    'consentVersion', '2026-11-private-beta-2'
  );
end;
$$;

commit;
