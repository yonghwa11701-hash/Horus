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

-- Commits one agent batch in a single transaction, only while the caller's lease is unexpired:
-- memory, new and changed suggestions, completed segments and their events land together or not at all.
create function public.save_agent_batch(
  p_session_id uuid, p_lock_id uuid, p_understanding jsonb, p_questions jsonb,
  p_created jsonb, p_changed jsonb, p_segment_ids uuid[], p_events jsonb
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.consultation_memory
    set understanding = p_understanding, questions = p_questions, updated_at = now()
    where session_id = p_session_id and lock_id = p_lock_id and locked_until > now();
  if not found then return false; end if;
  insert into public.suggestions (question_id, session_id, question, priority, status, source_segment_ids, evaluation, resolved_at)
    select c.question_id, p_session_id, c.question, c.priority, c.status, c.source_segment_ids, c.evaluation, c.resolved_at
    from jsonb_populate_recordset(null::public.suggestions, p_created) c
    on conflict (question_id) do nothing;
  update public.suggestions s set priority = c.priority, status = c.status, resolved_at = c.resolved_at
    from jsonb_populate_recordset(null::public.suggestions, p_changed) c
    where s.question_id = c.question_id and s.session_id = p_session_id;
  update public.transcript_segments set processing_status = 'completed', processed_at = now()
    where session_id = p_session_id and id = any(p_segment_ids);
  insert into public.agent_events (session_id, event_type, metadata)
    select p_session_id, e->>'event_type', e->'metadata' from jsonb_array_elements(p_events) e;
  return true;
end;
$$;
revoke all on function public.save_agent_batch(uuid, uuid, jsonb, jsonb, jsonb, jsonb, uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.save_agent_batch(uuid, uuid, jsonb, jsonb, jsonb, jsonb, uuid[], jsonb) to service_role;

commit;
