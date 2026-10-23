-- A direct conversation is allowed only after both sides follow each other.
-- Accepting a request therefore creates the reciprocal accepted relation in the
-- same transaction; the client can never forge it through a direct PATCH.

begin;

create or replace function public.accept_social_follow(requester_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  viewer_id uuid := auth.uid();
begin
  if viewer_id is null then raise exception 'Authentication required'; end if;
  if requester_id = viewer_id then raise exception 'Cannot accept own follow'; end if;

  update public.social_follows
  set accepted_at = now()
  where follower_id = requester_id
    and following_id = viewer_id
    and accepted_at is null;

  if not found then
    raise exception 'Follow request not found';
  end if;

  insert into public.social_follows (follower_id, following_id, accepted_at)
  values (viewer_id, requester_id, now())
  on conflict (follower_id, following_id) do update
    set accepted_at = coalesce(public.social_follows.accepted_at, excluded.accepted_at);
end;
$$;

drop policy if exists "recipients accept follow requests" on public.social_follows;

revoke all on function public.accept_social_follow(uuid) from public;
grant execute on function public.accept_social_follow(uuid) to authenticated;

commit;
