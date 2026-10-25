-- Scholog — stop the student-record endpoint from being enumerable.
--
-- Problem: `get_student_record` was executable by `anon` and, with no session
-- token, resolved a learner from the Student ID *alone* and returned their
-- attendance history and full score list. Student IDs are sequential and are
-- printed on QR cards (2026-0001, 2026-0002, …), so anyone could walk the range
-- and harvest every learner's grades.
--
-- Grades are sensitive personal information under RA 10173 (§3(l)) and the NPC
-- treats learner records as such, so an unauthenticated, guessable lookup is not
-- an acceptable access control.
--
-- Fix: every student now gets a random `record_code`. The record endpoint
-- returns data only when
--   1. the caller presents a live check-in session token that belongs to the
--      student's section (the in-class path, unchanged), or
--   2. the caller presents that student's record code (the QR-card path).
-- Anything else gets `code_required` and no data at all.
--
-- 32-character alphabet (no I/O/0/1) × 8 characters = 2^40 codes, so guessing is
-- not viable even without per-IP throttling.
--
-- After applying: teacher QR cards re-render with the code baked in
-- (`SCHOLOG:<student-id>:<record-code>`), and rows created earlier are backfilled
-- here. Old cards that only carry the id stop returning data — reprint them.

-- ---------------------------------------------------------------- record codes

create or replace function public.new_record_code()
returns text
language sql
volatile
as $$
    select string_agg(
               substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', (random() * 31)::int + 1, 1),
               ''
           )
      from generate_series(1, 8);
$$;

alter table public.students
    add column if not exists record_code text;

update public.students
   set record_code = public.new_record_code()
 where record_code is null or btrim(record_code) = '';

alter table public.students
    alter column record_code set default public.new_record_code();

create index if not exists students_user_record_code_idx
    on public.students (user_id, upper(record_code));

-- Keep the codes unreadable to `anon`: the students table already has no grant.
revoke all on function public.new_record_code() from anon, authenticated;

-- ------------------------------------------------------- gate + delegate
-- The previous implementations are renamed rather than rewritten so the record
-- payload logic stays in one place; they are then made teacher-only.

drop function if exists public.get_student_record(text, uuid);

do $$
begin
    if exists (
        select 1 from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname = 'get_student_record'
           and pg_get_function_identity_arguments(p.oid) = 'text, uuid, uuid, text'
    ) then
        execute 'alter function public.get_student_record(text, uuid, uuid, text) rename to get_student_record_unchecked';
    end if;
end $$;

revoke all on function public.get_student_record_unchecked(text, uuid, uuid, text) from anon, authenticated;

create or replace function public.get_student_record(
    p_student_id text,
    p_user_id uuid default null,
    p_token uuid default null,
    p_device_id text default null,
    p_record_code text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v_code text := btrim(coalesce(p_student_id, ''));
    v_record_code text := btrim(coalesce(p_record_code, ''));
    v_student public.students%rowtype;
    v_session public.checkin_sessions%rowtype;
    v_user_id uuid := p_user_id;
    v_session_ok boolean := false;
    v_code_ok boolean := false;
    v_has_digit boolean;
begin
    if v_code = '' then
        return jsonb_build_object('ok', false, 'error', 'student_not_found');
    end if;

    -- A live session token proves the caller is in that class right now.
    if p_token is not null then
        select * into v_session
          from public.checkin_sessions cs
         where cs.token = p_token;

        if not found then
            return jsonb_build_object('ok', false, 'error', 'invalid_session');
        end if;
        if v_user_id is null then
            v_user_id := v_session.user_id;
        elsif v_session.user_id <> v_user_id then
            return jsonb_build_object('ok', false, 'error', 'invalid_session');
        end if;
        v_session_ok := true;
    end if;

    -- Resolve the learner. Only a real id/code is accepted: a code with no digit
    -- at all cannot be a student number, which keeps obvious probes cheap.
    v_has_digit := v_code ~ '[0-9]';
    if not v_has_digit then
        return jsonb_build_object('ok', false, 'error', 'student_not_found');
    end if;

    if v_user_id is not null then
        select * into v_student
          from public.students st
         where st.user_id = v_user_id
           and lower(st.student_id) = lower(v_code)
         limit 1;
    else
        select st.* into v_student
          from public.students st
         where lower(st.student_id) = lower(v_code)
         order by st.id desc
         limit 1;

        if found then
            v_user_id := v_student.user_id;
        end if;
    end if;

    if v_student.id is null or v_user_id is null then
        return jsonb_build_object('ok', false, 'error', 'student_not_found');
    end if;

    -- The QR-card path: the code must match this exact learner.
    if v_record_code <> '' then
        v_code_ok := (
            v_student.record_code is not null
            and upper(v_student.record_code) = upper(v_record_code)
        );
    end if;

    -- The token only helps for the student's own section.
    if v_session_ok and v_session.section = v_student.section then
        v_session_ok := true;
    else
        v_session_ok := false;
    end if;

    if not (v_session_ok or v_code_ok) then
        return jsonb_build_object('ok', false, 'error', 'code_required');
    end if;

    return public.get_student_record_unchecked(p_student_id, v_user_id, p_token, p_device_id);
end;
$$;

revoke all on function public.get_student_record(text, uuid, uuid, text, text) from anon, authenticated, service_role;
grant execute on function public.get_student_record(text, uuid, uuid, text, text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ teacher API
-- Teachers (already authenticated, already RLS-scoped to their own rows) can read
-- a code for printing; students never can.

create or replace function public.my_student_record_codes()
returns table (student_id text, record_code text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
    select st.student_id, st.record_code
      from public.students st
     where st.user_id = auth.uid()
     order by st.student_id;
$$;

revoke all on function public.my_student_record_codes() from anon;
grant execute on function public.my_student_record_codes() to authenticated, service_role;
