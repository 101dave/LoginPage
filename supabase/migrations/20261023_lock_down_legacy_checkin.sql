-- Harden the public check-in surface before deploying to Vercel.
--
-- 1. Legacy RPCs are superseded by checkin_mark() / checkin_session_info().
--    submit_checkin() was still EXECUTE-able by anon and never wrote to
--    checkin_events, so a student could bypass "one phone, one check-in" by
--    calling the RPC directly instead of using the check-in page.
-- 2. The browser app never truncates tables nor manages triggers, so those
--    privileges are revoked from the client roles.
-- 3. anon (students) keeps no table access at all: check-in goes exclusively
--    through the two SECURITY DEFINER RPCs.

drop function if exists public.submit_checkin(uuid, text);
drop function if exists public.open_checkin(text);

revoke truncate, references, trigger on public.attendance       from anon, authenticated;
revoke truncate, references, trigger on public.sections         from anon, authenticated;
revoke truncate, references, trigger on public.students         from anon, authenticated;
revoke truncate, references, trigger on public.checkin_sessions from anon, authenticated;
revoke truncate, references, trigger on public.checkin_events   from anon, authenticated;

revoke all on public.attendance, public.sections, public.students,
              public.checkin_sessions, public.checkin_events from anon;
