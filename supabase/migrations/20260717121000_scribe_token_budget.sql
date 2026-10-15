begin;
create index agent_events_token_budget_idx on public.agent_events(created_at, session_id)
  where event_type = 'scribe.token_requested';

-- Serialize token reservations across all of this user's sessions, including reconnects.
create function public.reserve_scribe_token(p_session_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare parent public.sessions;
begin
  if auth.uid() is null then raise exception using errcode = 'PT401', message = 'Authentication required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  select * into parent from public.sessions where id = p_session_id and user_id = auth.uid() for update;
  if not found then raise exception using errcode = 'PT404', message = 'Session not found'; end if;
  if parent.status <> 'active' then raise exception using errcode = 'PT409', message = 'Session is not active'; end if;
  if (select count(*) from public.agent_events e join public.sessions s on s.id = e.session_id
      where s.user_id = auth.uid() and e.event_type = 'scribe.token_requested'
        and e.created_at > now() - interval '1 minute') >= 5 then
    raise exception using errcode = 'PT429', message = 'Too many transcription token requests';
  end if;
  insert into public.agent_events(session_id, event_type) values (p_session_id, 'scribe.token_requested');
end;
$$;
revoke all on function public.reserve_scribe_token(uuid) from public, anon;
grant execute on function public.reserve_scribe_token(uuid) to authenticated;
commit;
