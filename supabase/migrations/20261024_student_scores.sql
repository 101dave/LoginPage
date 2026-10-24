-- Scholog — student scores + student record page.
--
-- Scores are entered by the teacher (authenticated role) via upsert_score().
-- Students view their own attendance + scores on student-record.html (no login)
-- via get_student_record(), a SECURITY DEFINER RPC that returns only the
-- requested student's data.
--
-- The student-record page is reached from scan.html after a successful check-in:
--   student-record.html?t=<session_token>&sid=<student_id>

create table if not exists public.scores (
    id bigserial primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    date text not null,
    student_id text not null,
    subject text not null default 'General',
    score numeric not null,
    max_score numeric not null default 100,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, date, student_id, subject)
);

alter table public.scores enable row level security;
-- No direct table access: everything goes through SECURITY DEFINER RPCs.
revoke all on public.scores from anon, authenticated;

-- ------------------------------------------------------------------
-- Student record: attendance history + scores for one student.
-- Accessible by anon (the student-record page has no login).
-- ------------------------------------------------------------------
create or replace function public.get_student_record(
    p_student_id text,
    p_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    st public.students%rowtype;
    v_found boolean := false;
begin
    -- Validate the student exists under this teacher.
    select * into st
      from public.students
     where user_id = p_user_id
       and lower(student_id) = lower(p_student_id)
     limit 1;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'student_not_found');
    end if;

    -- Attendance history for this student (all dates).
    return jsonb_build_object(
        'ok', true,
        'student_name', st.name,
        'student_id', st.student_id,
        'section', st.section,
        'attendance', (
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
        ),
        'scores', (
            select jsonb_agg(
                jsonb_build_object(
                    'date', s.date,
                    'subject', s.subject,
                    'score', s.score,
                    'max_score', s.max_score,
                    'pct', round((s.score / nullif(s.max_score, 0)) * 100, 1)
                )
                order by s.date desc, s.subject
            )
            from public.scores s
            where s.user_id = p_user_id
              and s.student_id = st.student_id
        )
    );
end;
$$;

revoke all on function public.get_student_record(text, uuid) from public;
grant execute on function public.get_student_record(text, uuid) to anon, authenticated, service_role;

-- ------------------------------------------------------------------
-- Teacher upserts a score for a student.
-- Accessible by authenticated (teacher) only.
-- ------------------------------------------------------------------
create or replace function public.upsert_score(
    p_user_id uuid,
    p_date text,
    p_student_id text,
    p_subject text,
    p_score numeric,
    p_max_score numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    st public.students%rowtype;
    v_score numeric := coalesce(p_score, 0);
    v_max numeric := coalesce(p_max_score, 100);
begin
    if p_max_score is not null and p_max_score <= 0 then
        return jsonb_build_object('ok', false, 'error', 'invalid_max_score');
    end if;
    if p_score is null or p_score < 0 then
        return jsonb_build_object('ok', false, 'error', 'invalid_score');
    end if;

    -- Validate the student exists under this teacher.
    select * into st
      from public.students
     where user_id = p_user_id
       and lower(student_id) = lower(p_student_id)
     limit 1;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'student_not_found');
    end if;

    insert into public.scores (user_id, date, student_id, subject, score, max_score)
    values (p_user_id, p_date, st.student_id, coalesce(p_subject, 'General'), v_score, v_max)
    on conflict (user_id, date, student_id, subject)
    do update set
        score = excluded.score,
        max_score = excluded.max_score,
        updated_at = now();

    return jsonb_build_object(
        'ok', true,
        'student_name', st.name,
        'student_id', st.student_id,
        'subject', coalesce(p_subject, 'General'),
        'score', v_score,
        'max_score', v_max
    );
end;
$$;

revoke all on function public.upsert_score(uuid, text, text, text, numeric, numeric) from public;
grant execute on function public.upsert_score(uuid, text, text, text, numeric, numeric) to authenticated, service_role;
