-- Scholog — "one phone, one check-in" enforcement.
--
-- Every check-in sent from a student device carries a random device id that the
-- page keeps in localStorage. checkin_mark() records it in checkin_events, and
-- the unique (token, device_id) constraint means a single phone can only ever
-- check ONE student in per session — no passing a phone around the classroom.
--
-- The teacher's own scanner passes p_device_id = null, so it stays unlimited
-- (the teacher may scan the whole class from their device).
--
-- Clearing browser data does not bypass this: the browser only *sends* the id,
-- the server is what enforces the rule.

create table if not exists public.checkin_events (
    id bigserial primary key,
    token uuid not null references public.checkin_sessions(token) on delete cascade,
    device_id text not null,
    student_id text not null,
    created_at timestamptz not null default now(),
    unique (token, device_id)
);

create index if not exists idx_checkin_events_token on public.checkin_events(token);

alter table public.checkin_events enable row level security;
-- Intentionally no policies: only the SECURITY DEFINER functions below touch it.
revoke all on public.checkin_events from anon, authenticated;

-- Replace the 2-argument version: the new one has a defaulted 3rd argument, so
-- older callers (token + student id only) keep working, just without device
-- locking.
drop function if exists public.checkin_mark(uuid, text);

create or replace function public.checkin_mark(
    p_token uuid,
    p_student_id text,
    p_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    s public.checkin_sessions%rowtype;
    st public.students%rowtype;
    v_code text := btrim(coalesce(p_student_id, ''));
    v_device text := nullif(btrim(coalesce(p_device_id, '')), '');
    v_prev text;
    v_device_student text;
    v_device_name text;
    v_total integer := 0;
    v_present integer := 0;
begin
    if v_code = '' then
        return jsonb_build_object('ok', false, 'error', 'missing_id');
    end if;
    if length(v_code) > 64 then
        return jsonb_build_object('ok', false, 'error', 'not_in_class');
    end if;
    if v_device is not null and length(v_device) > 128 then
        return jsonb_build_object('ok', false, 'error', 'invalid_device');
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

    select * into st
      from public.students
     where user_id = s.user_id and section = s.section
       and lower(student_id) = lower(v_code)
     limit 1;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'not_in_class');
    end if;

    -- One phone, one student: block a second (different) student on this device.
    if v_device is not null then
        select e.student_id, stu.name
          into v_device_student, v_device_name
          from public.checkin_events e
          left join public.students stu
            on stu.user_id = s.user_id and stu.student_id = e.student_id
         where e.token = p_token and e.device_id = v_device
         limit 1;

        if v_device_student is not null and v_device_student <> st.student_id then
            return jsonb_build_object(
                'ok', false,
                'error', 'device_already_used',
                'device_student_name', v_device_name,
                'device_student_id', v_device_student);
        end if;
    end if;

    select status into v_prev
      from public.attendance
     where user_id = s.user_id and date = s.attendance_date
       and student_id = st.student_id and subject = 'General';

    insert into public.attendance (user_id, date, student_id, status, subject)
    values (s.user_id, s.attendance_date, st.student_id, 'Present', 'General')
    on conflict (user_id, date, student_id, subject)
    do update set status = 'Present';

    if v_device is not null then
        insert into public.checkin_events (token, device_id, student_id)
        values (p_token, v_device, st.student_id)
        on conflict (token, device_id) do nothing;
    end if;

    select count(*) into v_total
      from public.students st2
     where st2.user_id = s.user_id and st2.section = s.section;

    select count(*) into v_present
      from public.attendance a
      join public.students st2 on st2.user_id = a.user_id and st2.student_id = a.student_id
     where a.user_id = s.user_id
       and a.date = s.attendance_date
       and st2.section = s.section
       and a.status in ('Present', 'Late');

    return jsonb_build_object(
        'ok', true, 'student_name', st.name, 'student_id', st.student_id,
        'status', 'Present', 'previous_status', v_prev,
        'already_marked', v_prev is not null,
        'student_count', v_total, 'checked_in', v_present);
end;
$$;

revoke all on function public.checkin_mark(uuid, text, text) from public;
grant execute on function public.checkin_mark(uuid, text, text) to anon, authenticated, service_role;
