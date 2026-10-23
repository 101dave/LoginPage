-- Scholog — public QR / Student-ID check-in API
--
-- Students open scan.html?t=<session token> on their own phone (no teacher
-- login). They either scan their student QR code or type their Student ID.
-- Both paths go through these SECURITY DEFINER functions, which:
--   * validate the check-in session (exists, open, not expired),
--   * validate the student ID against the teacher's class list for the
--     session's section,
--   * and upsert a "Present" row in public.attendance for the session date.
--
-- The anon role only gets EXECUTE on these two functions. It still cannot
-- read students/sections/attendance directly (RLS stays as-is).

create or replace function public.checkin_session_info(p_token uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    s public.checkin_sessions%rowtype;
    v_total integer := 0;
    v_present integer := 0;
begin
    select * into s from public.checkin_sessions where token = p_token;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'invalid_session');
    end if;

    select count(*) into v_total
      from public.students st
     where st.user_id = s.user_id
       and st.section = s.section;

    select count(*) into v_present
      from public.attendance a
      join public.students st
        on st.user_id = a.user_id
       and st.student_id = a.student_id
     where a.user_id = s.user_id
       and a.date = s.attendance_date
       and st.section = s.section
       and a.status in ('Present', 'Late');

    return jsonb_build_object(
        'ok', true,
        'section', s.section,
        'date', s.attendance_date,
        'closed', s.closed,
        'expired', s.expires_at < now(),
        'expires_at', s.expires_at,
        'student_count', v_total,
        'checked_in', v_present
    );
end;
$$;

create or replace function public.checkin_mark(p_token uuid, p_student_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    s public.checkin_sessions%rowtype;
    st public.students%rowtype;
    v_code text := btrim(coalesce(p_student_id, ''));
    v_prev text;
    v_total integer := 0;
    v_present integer := 0;
begin
    if v_code = '' then
        return jsonb_build_object('ok', false, 'error', 'missing_id');
    end if;

    -- Student IDs are short codes; reject absurd input instead of scanning it.
    if length(v_code) > 64 then
        return jsonb_build_object('ok', false, 'error', 'not_in_class');
    end if;

    select * into s from public.checkin_sessions where token = p_token;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'invalid_session');
    end if;
    if s.closed then
        return jsonb_build_object('ok', false, 'error', 'session_closed');
    end if;
    if s.expires_at < now() then
        return jsonb_build_object('ok', false, 'error', 'session_expired');
    end if;

    -- Validate the typed/scanned ID against the class list for this section.
    select * into st
      from public.students
     where user_id = s.user_id
       and section = s.section
       and lower(student_id) = lower(v_code)
     limit 1;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'not_in_class');
    end if;

    select status into v_prev
      from public.attendance
     where user_id = s.user_id
       and date = s.attendance_date
       and student_id = st.student_id
       and subject = 'General';

    insert into public.attendance (user_id, date, student_id, status, subject)
    values (s.user_id, s.attendance_date, st.student_id, 'Present', 'General')
    on conflict (user_id, date, student_id, subject)
    do update set status = 'Present';

    select count(*) into v_total
      from public.students st2
     where st2.user_id = s.user_id
       and st2.section = s.section;

    select count(*) into v_present
      from public.attendance a
      join public.students st2
        on st2.user_id = a.user_id
       and st2.student_id = a.student_id
     where a.user_id = s.user_id
       and a.date = s.attendance_date
       and st2.section = s.section
       and a.status in ('Present', 'Late');

    return jsonb_build_object(
        'ok', true,
        'student_name', st.name,
        'student_id', st.student_id,
        'status', 'Present',
        'previous_status', v_prev,
        'already_marked', v_prev is not null,
        'student_count', v_total,
        'checked_in', v_present
    );
end;
$$;

revoke all on function public.checkin_session_info(uuid) from public;
revoke all on function public.checkin_mark(uuid, text) from public;

grant execute on function public.checkin_session_info(uuid) to anon, authenticated, service_role;
grant execute on function public.checkin_mark(uuid, text) to anon, authenticated, service_role;
