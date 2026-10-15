-- Person 2 owns infrastructure; Person 3 owns suggestions and agent processing.
-- Initial additive migration. Recovery: roll forward; never drop patient data to retry deployment.
begin;

create type public.session_status as enum ('active', 'paused', 'ending', 'completed', 'discarding');
create type public.suggestion_priority as enum ('low', 'medium', 'high', 'critical');
create type public.suggestion_status as enum ('approved', 'resolved', 'dismissed');
create type public.processing_status as enum ('pending', 'processing', 'completed', 'failed');
create type public.artifact_kind as enum ('transcript', 'understanding', 'questions', 'evaluation', 'resolution', 'summary', 'audit');
create type public.transcript_source as enum ('elevenlabs', 'manual_demo');

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status public.session_status not null default 'active',
  consented_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz
);
create index sessions_user_created_idx on public.sessions(user_id, created_at desc);

create table public.transcript_segments (
  id uuid primary key,
  session_id uuid not null references public.sessions(id) on delete cascade,
  sequence integer not null check (sequence >= 0),
  text text not null check (length(btrim(text)) between 1 and 16000),
  start_ms bigint not null check (start_ms >= 0),
  end_ms bigint not null check (end_ms >= start_ms),
  source public.transcript_source not null default 'elevenlabs',
  processing_status public.processing_status not null default 'pending',
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (session_id, sequence)
);
create index transcript_pending_idx on public.transcript_segments(session_id, sequence)
  where processing_status in ('pending', 'failed');

create table public.suggestions (
  question_id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  question text not null check (length(btrim(question)) between 1 and 2000),
  priority public.suggestion_priority not null,
  status public.suggestion_status not null default 'approved',
  source_segment_ids uuid[] not null check (cardinality(source_segment_ids) > 0),
  evaluation jsonb not null check (
    jsonb_typeof(evaluation) = 'object'
    and evaluation @> '{"relevant": true, "supported": true}'::jsonb
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index suggestions_session_idx on public.suggestions(session_id, created_at);

create table public.session_artifacts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  kind public.artifact_kind not null,
  storage_path text not null unique,
  schema_version integer not null default 1 check (schema_version > 0),
  created_at timestamptz not null default now()
);
create index session_artifacts_session_idx on public.session_artifacts(session_id, kind);

create table public.agent_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  event_type text not null check (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  actor text not null default 'system' check (actor in ('user', 'system')),
  actor_user_id uuid references auth.users(id),
  artifact_id uuid references public.session_artifacts(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  check ((actor = 'user' and actor_user_id is not null) or (actor = 'system' and actor_user_id is null))
);
create index agent_events_session_idx on public.agent_events(session_id, created_at, id);

-- A single parent-row lock serializes transcript writes, ending, and discard.
-- Guards also apply to service-role writers so in-flight agents cannot recreate discarded data.
create function public.guard_session_child_write() returns trigger
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

create trigger transcript_write_guard before insert or update on public.transcript_segments
  for each row execute function public.guard_session_child_write();
create trigger suggestion_write_guard before insert or update on public.suggestions
  for each row execute function public.guard_session_child_write();
create trigger artifact_write_guard before insert or update on public.session_artifacts
  for each row execute function public.guard_session_child_write();
create trigger event_write_guard before insert or update on public.agent_events
  for each row execute function public.guard_session_child_write();

alter table public.sessions enable row level security;
alter table public.transcript_segments enable row level security;
alter table public.suggestions enable row level security;
alter table public.agent_events enable row level security;
alter table public.session_artifacts enable row level security;

create policy sessions_owner_read on public.sessions for select to authenticated
  using (user_id = (select auth.uid()));
create policy transcript_owner_read on public.transcript_segments for select to authenticated
  using (exists (select 1 from public.sessions s where s.id = session_id and s.user_id = (select auth.uid())));
create policy suggestions_owner_read on public.suggestions for select to authenticated
  using (exists (select 1 from public.sessions s where s.id = session_id and s.user_id = (select auth.uid())));
create policy events_owner_read on public.agent_events for select to authenticated
  using (exists (select 1 from public.sessions s where s.id = session_id and s.user_id = (select auth.uid())));
create policy artifacts_owner_read on public.session_artifacts for select to authenticated
  using (exists (select 1 from public.sessions s where s.id = session_id and s.user_id = (select auth.uid())));

-- Mobile clients are read-only except for the explicitly granted, authenticated RPCs below.
revoke all on public.sessions, public.transcript_segments, public.suggestions, public.agent_events, public.session_artifacts from anon, authenticated;
grant select on public.sessions, public.transcript_segments, public.suggestions, public.agent_events, public.session_artifacts to authenticated;
grant all on public.sessions, public.transcript_segments, public.suggestions, public.agent_events, public.session_artifacts to service_role;

create function public.create_consultation(p_id uuid, p_consent boolean) returns public.sessions
language plpgsql security definer set search_path = '' as $$
declare result public.sessions;
begin
  if auth.uid() is null then raise exception using errcode = 'PT401', message = 'Authentication required'; end if;
  if p_consent is distinct from true then raise exception using errcode = 'PT422', message = 'Speaker consent is required'; end if;
  insert into public.sessions(id, user_id) values (p_id, auth.uid()) on conflict (id) do nothing returning * into result;
  if not found then
    select * into result from public.sessions where id = p_id and user_id = auth.uid();
    if not found then raise exception using errcode = 'PT404', message = 'Session not found'; end if;
    return result;
  end if;
  insert into public.agent_events(session_id, event_type, actor, actor_user_id)
    values (p_id, 'session.created', 'user', auth.uid());
  return result;
end;
$$;

create function public.transition_consultation(p_session_id uuid, p_status public.session_status) returns public.sessions
language plpgsql security definer set search_path = '' as $$
declare result public.sessions;
begin
  select * into result from public.sessions where id = p_session_id and user_id = auth.uid() for update;
  if not found then raise exception using errcode = 'PT404', message = 'Session not found'; end if;
  if p_status is null or p_status not in ('active', 'paused', 'ending', 'discarding') then
    raise exception using errcode = 'PT422', message = 'Unsupported session transition';
  end if;
  if result.status = p_status then return result; end if;
  if not (
    (result.status = 'active' and p_status in ('paused', 'ending')) or
    (result.status = 'paused' and p_status in ('active', 'ending')) or
    p_status = 'discarding'
  ) or result.status = 'discarding' then
    raise exception using errcode = 'PT409', message = 'Invalid session transition';
  end if;
  -- Record before setting discarding, which blocks all further child writes.
  insert into public.agent_events(session_id, event_type, actor, actor_user_id, metadata)
    values (p_session_id, 'session.status_changed', 'user', auth.uid(), jsonb_build_object('from', result.status, 'to', p_status));
  update public.sessions set status = p_status, updated_at = now(),
    ended_at = case when p_status = 'ending' then now() else ended_at end
    where id = p_session_id returning * into result;
  return result;
end;
$$;

create function public.append_transcript(
  p_id uuid, p_session_id uuid, p_sequence integer, p_text text,
  p_start_ms bigint, p_end_ms bigint, p_source public.transcript_source
) returns public.transcript_segments
language plpgsql security definer set search_path = '' as $$
declare parent public.sessions; result public.transcript_segments;
begin
  select * into parent from public.sessions where id = p_session_id and user_id = auth.uid() for update;
  if not found then raise exception using errcode = 'PT404', message = 'Session not found'; end if;
  select * into result from public.transcript_segments where id = p_id;
  if found then
    if result.session_id <> p_session_id or result.sequence <> p_sequence or result.text <> p_text
      or result.start_ms <> p_start_ms or result.end_ms <> p_end_ms or result.source <> p_source then
      raise exception using errcode = 'PT409', message = 'Segment id already used for different content';
    end if;
    return result;
  end if;
  if parent.status <> 'active' then raise exception using errcode = 'PT409', message = 'Session is not active'; end if;
  insert into public.transcript_segments(id, session_id, sequence, text, start_ms, end_ms, source)
    values (p_id, p_session_id, p_sequence, p_text, p_start_ms, p_end_ms, p_source) returning * into result;
  insert into public.agent_events(session_id, event_type, metadata)
    values (p_session_id, 'transcript.final', jsonb_build_object('segment_id', p_id));
  return result;
end;
$$;

-- Person 3 calls this with its server-only client after saving summary.json.
create function public.complete_consultation(p_session_id uuid) returns public.sessions
language plpgsql security definer set search_path = '' as $$
declare result public.sessions;
begin
  select * into result from public.sessions where id = p_session_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'Session not found'; end if;
  if result.status = 'completed' then return result; end if;
  if result.status <> 'ending' or not exists (
    select 1 from public.session_artifacts where session_id = p_session_id and kind = 'summary'
  ) then raise exception using errcode = 'PT409', message = 'Session must be ending with a saved summary'; end if;
  insert into public.agent_events(session_id, event_type) values (p_session_id, 'summary.ready');
  update public.sessions set status = 'completed', updated_at = now() where id = p_session_id returning * into result;
  return result;
end;
$$;

-- PUBLIC gets EXECUTE by default on new functions; explicitly remove it.
revoke all on function public.guard_session_child_write() from public, anon, authenticated;
revoke all on function public.create_consultation(uuid, boolean) from public, anon;
revoke all on function public.transition_consultation(uuid, public.session_status) from public, anon;
revoke all on function public.append_transcript(uuid, uuid, integer, text, bigint, bigint, public.transcript_source) from public, anon;
revoke all on function public.complete_consultation(uuid) from public, anon, authenticated;
grant execute on function public.create_consultation(uuid, boolean) to authenticated;
grant execute on function public.transition_consultation(uuid, public.session_status) to authenticated;
grant execute on function public.append_transcript(uuid, uuid, integer, text, bigint, bigint, public.transcript_source) to authenticated;
grant execute on function public.complete_consultation(uuid) to service_role;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
  values ('patient-artifacts', 'patient-artifacts', false, 10485760, array['application/json']);
-- Only server helpers upload/delete. Read requires both folder ownership and a live session.
create policy patient_artifacts_owner_read on storage.objects for select to authenticated using (
  bucket_id = 'patient-artifacts'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1 from public.sessions s where s.id::text = (storage.foldername(name))[2]
      and s.user_id = (select auth.uid()) and s.status <> 'discarding'
  )
);

alter publication supabase_realtime add table public.sessions, public.transcript_segments, public.suggestions, public.session_artifacts;
commit;
