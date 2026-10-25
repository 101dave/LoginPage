-- Scholog — harden student record access against classmate ID enumeration,
-- support standalone student QR scanning without requiring a shared session link,
-- and return per-section grading categories so student-record.html can show
-- computed period grades and category breakdowns.

drop function if exists public.get_student_record(text, uuid);
drop function if exists public.get_student_record(text, uuid, uuid, text);

create or replace function public.get_student_record(
    p_student_id text,
    p_user_id uuid default null,
    p_token uuid default null,
    p_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v_code text := btrim(coalesce(p_student_id, ''));
    v_student public.students%rowtype;
    v_session public.checkin_sessions%rowtype;
    v_active_session public.checkin_sessions%rowtype;
    v_user_id uuid := p_user_id;
    v_device text := nullif(btrim(coalesce(p_device_id, '')), '');
    v_device_student text;
    v_prev_status text;
    v_target_status text;
    v_checked_in_now boolean := false;
    v_checkin_date date := null;
begin
    if v_code = '' then
        return jsonb_build_object('ok', false, 'error', 'student_not_found');
    end if;

    -- If a session token is provided, load the session and resolve teacher user_id if omitted
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
    end if;

    -- Resolve the student record:
    -- 1) If teacher user_id is known, match within that teacher's roster.
    -- 2) If neither token nor user_id was supplied (standalone QR scan without a teacher link),
    --    look up the student by student_id directly.
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
         order by
             (select count(*) from public.scores sc where sc.user_id = st.user_id and lower(sc.student_id) = lower(st.student_id)) desc,
             (select count(*) from public.attendance a where a.user_id = st.user_id and lower(a.student_id) = lower(st.student_id)) desc,
             st.id desc
         limit 1;

        if found then
            v_user_id := v_student.user_id;
        end if;
    end if;

    if v_student.id is null or v_user_id is null then
        return jsonb_build_object('ok', false, 'error', 'student_not_found');
    end if;

    -- When a check-in session token is supplied, ensure the token belongs to
    -- this student's section, and that a device locked to one student cannot
    -- enumerate another classmate's ID.
    if p_token is not null then
        if v_session.section <> v_student.section then
            return jsonb_build_object('ok', false, 'error', 'invalid_session');
        end if;

        if v_device is not null then
            select e.student_id into v_device_student
              from public.checkin_events e
             where e.token = p_token
               and e.device_id = v_device
             limit 1;

            if v_device_student is not null and lower(v_device_student) <> lower(v_student.student_id) then
                return jsonb_build_object('ok', false, 'error', 'unauthorized_device');
            end if;
        end if;
    else
        -- Standalone scan (no session link sent by teacher):
        -- If there is an active open check-in session right now for this student's section,
        -- automatically mark their attendance (respecting the single-device rule and Late cutoff).
        select * into v_active_session
          from public.checkin_sessions cs
         where cs.user_id = v_user_id
           and cs.section = v_student.section
           and cs.closed = false
           and cs.expires_at > now()
         order by cs.expires_at desc
         limit 1;

        if found then
            if v_device is not null then
                select e.student_id into v_device_student
                  from public.checkin_events e
                 where e.token = v_active_session.token
                   and e.device_id = v_device
                 limit 1;
            end if;

            if v_device_student is null or lower(v_device_student) = lower(v_student.student_id) then
                select a.status into v_prev_status
                  from public.attendance a
                 where a.user_id = v_user_id
                   and a.date = v_active_session.attendance_date
                   and a.student_id = v_student.student_id
                   and a.subject = 'General';

                if v_active_session.late_after_at is not null and v_active_session.late_after_at < now() then
                    v_target_status := 'Late';
                else
                    v_target_status := 'Present';
                end if;

                if v_prev_status = 'Present' and v_target_status = 'Late' then
                    v_target_status := 'Present';
                end if;

                insert into public.attendance (user_id, date, student_id, status, subject)
                values (v_user_id, v_active_session.attendance_date, v_student.student_id, v_target_status, 'General')
                on conflict (user_id, date, student_id, subject)
                do update set status = excluded.status;

                if v_device is not null then
                    insert into public.checkin_events (token, device_id, student_id)
                    values (v_active_session.token, v_device, v_student.student_id)
                    on conflict (token, device_id) do nothing;
                end if;

                v_checked_in_now := true;
                v_checkin_date := v_active_session.attendance_date;
            end if;
        end if;
    end if;

    return jsonb_build_object(
        'ok', true,
        'user_id', v_user_id,
        'student_name', v_student.name,
        'student_id', v_student.student_id,
        'section', v_student.section,
        'checked_in_now', v_checked_in_now,
        'checkin_status', v_target_status,
        'checkin_date', v_checkin_date,
        'categories', coalesce((
            select jsonb_agg(
                jsonb_build_object(
                    'id', gc.id,
                    'name', gc.name,
                    'weight', gc.weight,
                    'items', coalesce(gc.items, '[]'::jsonb)
                )
                order by gc.created_at, gc.name
            )
            from public.grading_categories gc
            where gc.user_id = v_user_id
              and gc.section = v_student.section
              and coalesce(gc.archived, false) = false
        ), '[]'::jsonb),
        'attendance', coalesce((
            select jsonb_agg(
                jsonb_build_object(
                    'date', a.date,
                    'status', a.status,
                    'subject', coalesce(a.subject, 'General')
                )
                order by a.date desc
            )
            from public.attendance a
            where a.user_id = v_user_id
              and lower(a.student_id) = lower(v_student.student_id)
        ), '[]'::jsonb),
        'scores', coalesce((
            select jsonb_agg(
                jsonb_build_object(
                    'date', sc.date,
                    'subject', sc.subject,
                    'grading_period', sc.grading_period,
                    'category_id', sc.category_id,
                    'category_name', sc.category_name,
                    'category_weight', sc.category_weight,
                    'item_id', sc.item_id,
                    'item_label', sc.item_label,
                    'score', sc.score,
                    'max_score', sc.max_score,
                    'pct', round((sc.score / nullif(sc.max_score, 0)) * 100, 1)
                )
                order by sc.date desc, sc.grading_period, sc.category_name, sc.item_label
            )
            from public.scores sc
            left join public.grading_categories gc
              on gc.id = sc.category_id
            where sc.user_id = v_user_id
              and lower(sc.student_id) = lower(v_student.student_id)
              and coalesce(gc.archived, false) = false
        ), '[]'::jsonb)
    );
end;
$$;

revoke all on function public.get_student_record(text, uuid, uuid, text) from public;
grant execute on function public.get_student_record(text, uuid, uuid, text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
