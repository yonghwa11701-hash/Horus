-- Person 3: consultation memory between transcript chunks, and a lease so that exactly one
-- worker runs a session's agents at a time, in transcript order.
begin;

create table public.consultation_memory (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  understanding jsonb,
  questions jsonb not null default '[]'::jsonb check (jsonb_typeof(questions) = 'array'),
  lock_id uuid,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.consultation_memory enable row level security;
revoke all on public.consultation_memory from public, anon, authenticated;
grant all on public.consultation_memory to service_role;
-- Same discard guard as every other child table.
create trigger memory_write_guard before insert or update on public.consultation_memory
  for each row execute function public.guard_session_child_write();

-- Returns the row only if this caller now holds the lease. An expired lease can be taken over.
create function public.claim_agent_memory(p_session_id uuid, p_lock_id uuid, p_lease_seconds integer)
returns setof public.consultation_memory
language sql security definer set search_path = '' as $$
  insert into public.consultation_memory as m (session_id, lock_id, locked_until)
    values (p_session_id, p_lock_id, now() + make_interval(secs => p_lease_seconds))
  on conflict (session_id) do update
    set lock_id = excluded.lock_id, locked_until = excluded.locked_until, updated_at = now()
    where m.locked_until is null or m.locked_until < now()
  returning m.*;
$$;
revoke all on function public.claim_agent_memory(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_agent_memory(uuid, uuid, integer) to service_role;

commit;
