-- Scholog — harden student record access against classmate ID enumeration
-- and return per-section grading categories so student-record.html can show
-- computed period grades and category breakdowns.

drop function if exists public.get_student_record(text, uuid);
drop function if exists public.get_student_record(text, uuid, uuid, text);

create or replace function public.get_student_record(
    p_student_id text,
    p_user_id uuid,
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
    st public.students%rowtype;
    s public.checkin_sessions%rowtype;
    v_device text := nullif(btrim(coalesce(p_device_id, '')), '');
    v_device_student text;
begin
    select * into st
      from public.students
     where user_id = p_user_id
       and lower(student_id) = lower(btrim(coalesce(p_student_id, '')))
     limit 1;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'student_not_found');
    end if;

    -- When a check-in session token is supplied, ensure the token belongs to
    -- this teacher + section, and that a device locked to one student cannot
    -- enumerate another classmate's ID.
    if p_token is not null then
        select * into s
          from public.checkin_sessions
         where token = p_token
           and user_id = p_user_id;

        if not found or s.section <> st.section then
            return jsonb_build_object('ok', false, 'error', 'invalid_session');
        end if;

        if v_device is not null then
            select e.student_id into v_device_student
              from public.checkin_events e
             where e.token = p_token
               and e.device_id = v_device
             limit 1;

            if v_device_student is not null and lower(v_device_student) <> lower(st.student_id) then
                return jsonb_build_object('ok', false, 'error', 'unauthorized_device');
            end if;
        end if;
    end if;

    return jsonb_build_object(
        'ok', true,
        'student_name', st.name,
        'student_id', st.student_id,
        'section', st.section,
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
            where gc.user_id = p_user_id
              and gc.section = st.section
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
            where a.user_id = p_user_id
              and a.student_id = st.student_id
        ), '[]'::jsonb),
        'scores', coalesce((
            select jsonb_agg(
                jsonb_build_object(
                    'date', s.date,
                    'subject', s.subject,
                    'grading_period', s.grading_period,
                    'category_id', s.category_id,
                    'category_name', s.category_name,
                    'category_weight', s.category_weight,
                    'item_id', s.item_id,
                    'item_label', s.item_label,
                    'score', s.score,
                    'max_score', s.max_score,
                    'pct', round((s.score / nullif(s.max_score, 0)) * 100, 1)
                )
                order by s.date desc, s.grading_period, s.category_name, s.item_label
            )
            from public.scores s
            left join public.grading_categories gc
              on gc.id = s.category_id
            where s.user_id = p_user_id
              and s.student_id = st.student_id
              and coalesce(gc.archived, false) = false
        ), '[]'::jsonb)
    );
end;
$$;

revoke all on function public.get_student_record(text, uuid, uuid, text) from public;
grant execute on function public.get_student_record(text, uuid, uuid, text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
