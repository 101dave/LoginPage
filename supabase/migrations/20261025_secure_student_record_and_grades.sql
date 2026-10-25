-- Scholog — harden student record access against classmate ID enumeration
-- and return per-section grading categories so student-record.html can show
-- computed period grades and category breakdowns.
-- Fixes PL/pgSQL variable shadowing between `v_session` and `public.scores sc`.

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
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v_student public.students%rowtype;
    v_session public.checkin_sessions%rowtype;
    v_user_id uuid := p_user_id;
    v_device text := nullif(btrim(coalesce(p_device_id, '')), '');
    v_device_student text;
begin
    -- If token is provided, load session and resolve teacher user_id if omitted
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

    if v_user_id is null then
        return jsonb_build_object('ok', false, 'error', 'student_not_found');
    end if;

    select * into v_student
      from public.students st
     where st.user_id = v_user_id
       and lower(st.student_id) = lower(btrim(coalesce(p_student_id, '')))
     limit 1;

    if not found then
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
    end if;

    return jsonb_build_object(
        'ok', true,
        'student_name', v_student.name,
        'student_id', v_student.student_id,
        'section', v_student.section,
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
