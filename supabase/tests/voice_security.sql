-- Run with `supabase test db` after applying all migrations. Uses synthetic data only.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(11);

insert into auth.users(id, is_anonymous) values ('aaaaaaaa-0000-4000-8000-000000000001', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok($$select public.create_consultation('bbbbbbbb-0000-4000-8000-000000000001', true)$$,
  'Session and user audit inserts work with the shared trigger');
select lives_ok($$select public.append_transcript(
  'cccccccc-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001',
  0, 'Synthetic consultation', 0, 3000, 'manual_demo')$$,
  'Transcript and system audit inserts work with the shared trigger');

do $$begin
  for attempt in 1..5 loop perform public.reserve_scribe_token('bbbbbbbb-0000-4000-8000-000000000001'); end loop;
end$$;
select throws_ok($$select public.reserve_scribe_token('bbbbbbbb-0000-4000-8000-000000000001')$$,
  'PT429', 'Too many transcription token requests', 'Sixth reservation is rejected');
select throws_ok($$select public.delete_discarded_consultation('bbbbbbbb-0000-4000-8000-000000000001')$$,
  '42501', null, 'Mobile clients cannot invoke privileged deletion');
select throws_ok($$select * from public.scribe_token_reservations$$,
  '42501', null, 'Mobile clients cannot read or reset quota reservations');

set local role service_role;
insert into public.session_artifacts(id, session_id, kind, storage_path) values (
  'dddddddd-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'transcript',
  'aaaaaaaa-0000-4000-8000-000000000001/bbbbbbbb-0000-4000-8000-000000000001/transcript.json');
insert into public.agent_events(session_id, event_type, artifact_id) values (
  'bbbbbbbb-0000-4000-8000-000000000001', 'artifact.saved', 'dddddddd-0000-4000-8000-000000000001');
select throws_ok($$select public.delete_discarded_consultation('bbbbbbbb-0000-4000-8000-000000000001')$$,
  'PT409', 'Session must be discarding', 'Deletion requires the discarding state');

set local role authenticated;
do $$begin perform public.transition_consultation('bbbbbbbb-0000-4000-8000-000000000001', 'discarding'); end$$;
set local role service_role;
select lives_ok($$select public.delete_discarded_consultation('bbbbbbbb-0000-4000-8000-000000000001')$$,
  'Discard succeeds with artifact-linked audit records');
select is((select count(*)::integer from public.sessions where id = 'bbbbbbbb-0000-4000-8000-000000000001'), 0,
  'Session is deleted');
select is((select count(*)::integer from public.session_artifacts where session_id = 'bbbbbbbb-0000-4000-8000-000000000001'), 0,
  'Artifact metadata is deleted');

set local role authenticated;
do $$begin perform public.create_consultation('bbbbbbbb-0000-4000-8000-000000000002', true); end$$;
select throws_ok($$select public.reserve_scribe_token('bbbbbbbb-0000-4000-8000-000000000002')$$,
  'PT429', 'Too many transcription token requests', 'Discard and recreate do not reset the per-user quota');
set local role service_role;
update public.scribe_token_reservations set reserved_at = now() - interval '2 minutes'
  where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
set local role authenticated;
select lives_ok($$select public.reserve_scribe_token('bbbbbbbb-0000-4000-8000-000000000002')$$,
  'Reservations expire after the sliding window');

select * from finish();
rollback;
