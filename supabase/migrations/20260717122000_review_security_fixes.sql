begin;

-- Quota reservations must survive session discard. They contain no session or transcript data.
create table public.scribe_token_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  reserved_at timestamptz not null default now()
);
create index scribe_token_reservations_user_time_idx
  on public.scribe_token_reservations(user_id, reserved_at);
alter table public.scribe_token_reservations enable row level security;
revoke all on public.scribe_token_reservations from public, anon, authenticated;
grant all on public.scribe_token_reservations to service_role;

-- Preserve the current window when upgrading an already-running project.
insert into public.scribe_token_reservations(user_id, reserved_at)
  select s.user_id, e.created_at from public.agent_events e
  join public.sessions s on s.id = e.session_id
  where e.event_type = 'scribe.token_requested' and e.created_at > now() - interval '1 minute';

create or replace function public.reserve_scribe_token(p_session_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare parent public.sessions;
begin
  if auth.uid() is null then raise exception using errcode = 'PT401', message = 'Authentication required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  select * into parent from public.sessions where id = p_session_id and user_id = auth.uid() for update;
  if not found then raise exception using errcode = 'PT404', message = 'Session not found'; end if;
  if parent.status <> 'active' then raise exception using errcode = 'PT409', message = 'Session is not active'; end if;
  delete from public.scribe_token_reservations where user_id = auth.uid()
    and reserved_at <= now() - interval '1 minute';
  if (select count(*) from public.scribe_token_reservations where user_id = auth.uid()) >= 5 then
    raise exception using errcode = 'PT429', message = 'Too many transcription token requests';
  end if;
  insert into public.scribe_token_reservations(user_id) values (auth.uid());
  insert into public.agent_events(session_id, event_type) values (p_session_id, 'scribe.token_requested');
end;
$$;

-- Include the previously corrected guard in an upgrade migration as well. A table-specific
-- field must be accessed inside its own IF, not in an AND expression shared by all tables.
create or replace function public.guard_session_child_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare parent public.sessions;
begin
  select * into parent from public.sessions where id = new.session_id for update;
  if not found or parent.status = 'discarding' then
    raise exception using errcode = 'PT409', message = 'Session is unavailable for writes';
  end if;
  if tg_table_name = 'transcript_segments' and tg_op = 'INSERT' and parent.status <> 'active' then
    raise exception using errcode = 'PT409', message = 'Session is not active';
  end if;
  if tg_table_name = 'suggestions' then
    if parent.status = 'completed' then
      raise exception using errcode = 'PT409', message = 'Session is completed';
    end if;
    if exists (
      select 1 from unnest(new.source_segment_ids) as source(id)
      where not exists (select 1 from public.transcript_segments t where t.id = source.id and t.session_id = new.session_id)
    ) then
      raise exception using errcode = 'PT422', message = 'Suggestion sources must belong to this session';
    end if;
    new.updated_at := now();
  end if;
  if tg_table_name = 'session_artifacts' then
    if not starts_with(new.storage_path, parent.user_id::text || '/' || parent.id::text || '/') then
      raise exception using errcode = 'PT422', message = 'Invalid artifact path';
    end if;
  end if;
  if tg_table_name = 'agent_events' then
    if new.actor = 'user' and new.actor_user_id <> parent.user_id then
      raise exception using errcode = 'PT422', message = 'Invalid audit actor';
    end if;
    if new.artifact_id is not null and not exists (
      select 1 from public.session_artifacts a where a.id = new.artifact_id and a.session_id = new.session_id
    ) then
      raise exception using errcode = 'PT422', message = 'Invalid audit artifact';
    end if;
  end if;
  return new;
end;
$$;

-- Storage cleanup happens first in the Edge Function. Delete audit references before
-- artifact cascades can SET NULL and accidentally invoke the discarding write guard.
create function public.delete_discarded_consultation(p_session_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare parent public.sessions;
begin
  select * into parent from public.sessions where id = p_session_id for update;
  if not found then return; end if;
  if parent.status <> 'discarding' then
    raise exception using errcode = 'PT409', message = 'Session must be discarding';
  end if;
  delete from public.agent_events where session_id = p_session_id;
  delete from public.sessions where id = p_session_id;
end;
$$;
revoke all on function public.delete_discarded_consultation(uuid) from public, anon, authenticated;
grant execute on function public.delete_discarded_consultation(uuid) to service_role;
commit;
