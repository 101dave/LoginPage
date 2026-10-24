-- Scholog — shared grading categories, per-section selection and weighted grades.
-- Existing score rows are preserved and backfilled with category metadata.

create table if not exists public.grading_categories (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    name text not null,
    weight numeric not null default 0 check (weight >= 0 and weight <= 100),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, name)
);

create table if not exists public.section_grading_categories (
    id bigserial primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    section text not null,
    category_id uuid not null references public.grading_categories(id) on delete cascade,
    created_at timestamptz not null default now(),
    unique (user_id, section, category_id)
);

alter table public.grading_categories enable row level security;
alter table public.section_grading_categories enable row level security;

revoke all on public.grading_categories from anon;
revoke all on public.section_grading_categories from anon;
grant select, insert, update, delete on public.grading_categories to authenticated;
grant select, insert, update, delete on public.section_grading_categories to authenticated;
grant usage, select on sequence public.section_grading_categories_id_seq to authenticated;

drop policy if exists grading_categories_teacher_all on public.grading_categories;
create policy grading_categories_teacher_all on public.grading_categories
    for all to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

drop policy if exists section_grading_categories_teacher_all on public.section_grading_categories;
create policy section_grading_categories_teacher_all on public.section_grading_categories
    for all to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- The teacher app writes scores directly. Keep every score private to its owner.
grant select, insert, update, delete on public.scores to authenticated;
grant usage, select on sequence public.scores_id_seq to authenticated;
drop policy if exists scores_teacher_all on public.scores;
create policy scores_teacher_all on public.scores
    for all to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

alter table public.scores add column if not exists category_id uuid;
alter table public.scores add column if not exists category_name text;
alter table public.scores add column if not exists category_weight numeric;
alter table public.scores add column if not exists grading_period text;

-- Create categories only from names already present in score data. If an account
-- has several existing categories, distribute 100% across those categories only.
with source_categories as (
    select distinct
        s.user_id,
        case
            when position('|' in coalesce(s.subject, '')) > 0
                then split_part(s.subject, '|', 2)
            else 'General'
        end as name
    from public.scores s
), ranked_categories as (
    select
        user_id,
        name,
        row_number() over (partition by user_id order by name) as row_num,
        count(*) over (partition by user_id) as category_count
    from source_categories
)
insert into public.grading_categories (user_id, name, weight)
select
    user_id,
    name,
    case
        when row_num = category_count
            then 100 - trunc(100.0 / category_count, 2) * (category_count - 1)
        else trunc(100.0 / category_count, 2)
    end as weight
from ranked_categories
on conflict (user_id, name) do nothing;

-- Backfill period, category ID/name/weight without replacing the legacy subject.
update public.scores s
set
    grading_period = coalesce(
        s.grading_period,
        case
            when position('|' in coalesce(s.subject, '')) > 0
                then split_part(s.subject, '|', 1)
            else coalesce(s.subject, 'General')
        end
    ),
    category_name = coalesce(
        s.category_name,
        case
            when position('|' in coalesce(s.subject, '')) > 0
                then split_part(s.subject, '|', 2)
            else 'General'
        end
    ),
    category_id = coalesce(s.category_id, c.id),
    category_weight = coalesce(s.category_weight, c.weight)
from public.grading_categories c
where c.user_id = s.user_id
  and c.name = case
        when position('|' in coalesce(s.subject, '')) > 0
            then split_part(s.subject, '|', 2)
        else 'General'
    end;

alter table public.scores alter column grading_period set default 'General';
alter table public.scores alter column category_name set default 'General';
alter table public.scores alter column category_weight set default 100;
alter table public.scores alter column grading_period set not null;
alter table public.scores alter column category_id set not null;
alter table public.scores alter column category_name set not null;
alter table public.scores alter column category_weight set not null;
alter table public.scores drop constraint if exists scores_category_id_fkey;
alter table public.scores add constraint scores_category_id_fkey
    foreign key (category_id) references public.grading_categories(id);

-- Existing sections start with all existing categories selected. Teachers can
-- change the selection later; the app validates each saved selection to 100%.
insert into public.section_grading_categories (user_id, section, category_id)
select sec.user_id, sec.name, c.id
from public.sections sec
join public.grading_categories c on c.user_id = sec.user_id
on conflict (user_id, section, category_id) do nothing;

alter table public.scores drop constraint if exists scores_user_id_date_student_id_subject_key;
create unique index if not exists scores_user_date_student_period_category_key
    on public.scores (user_id, date, student_id, grading_period, category_id);

-- The teacher app now writes complete category metadata directly. Retire the old
-- RPC rather than leaving it attached to the removed legacy uniqueness rule.
drop function if exists public.upsert_score(uuid, text, text, text, numeric, numeric);

-- Return the new metadata to the student record page while retaining legacy fields.
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
begin
    select * into st
      from public.students
     where user_id = p_user_id
       and lower(student_id) = lower(p_student_id)
     limit 1;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'student_not_found');
    end if;

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
                    'grading_period', s.grading_period,
                    'category_id', s.category_id,
                    'category_name', s.category_name,
                    'category_weight', s.category_weight,
                    'score', s.score,
                    'max_score', s.max_score,
                    'pct', round((s.score / nullif(s.max_score, 0)) * 100, 1)
                )
                order by s.date desc, s.grading_period, s.category_name
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
