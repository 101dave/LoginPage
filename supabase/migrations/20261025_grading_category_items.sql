-- Scholog — subsections (assessment items) inside each grading category.
-- Allows categories such as Written Work, Performance Task, and Quiz to hold
-- multiple graded items (e.g. 6 Written Works, each with its own Max score)
-- instead of a single 1-100 column.

alter table public.grading_categories
    add column if not exists items jsonb not null default '[]'::jsonb;

update public.grading_categories
   set items = jsonb_build_array(
       jsonb_build_object(
           'id', gen_random_uuid()::text,
           'label', '#1',
           'max_score', 100
       )
   )
 where jsonb_typeof(items) <> 'array'
    or jsonb_array_length(items) = 0;

alter table public.scores
    add column if not exists item_id text;

alter table public.scores
    add column if not exists item_label text not null default '#1';

update public.scores s
   set item_id = coalesce(
           nullif(s.item_id, ''),
           gc.items->0->>'id',
           'item-1'
       ),
       item_label = coalesce(
           nullif(s.item_label, ''),
           gc.items->0->>'label',
           '#1'
       )
  from public.grading_categories gc
 where s.category_id = gc.id
   and (s.item_id is null or s.item_id = '');

update public.scores
   set item_id = 'item-1'
 where item_id is null or item_id = '';

alter table public.scores
    alter column item_id set default 'item-1',
    alter column item_id set not null;

drop index if exists public.scores_user_date_student_period_category_idx;

create unique index if not exists scores_user_date_student_period_cat_item_idx
    on public.scores (user_id, date, student_id, grading_period, category_id, item_id);

-- Include subsection label and hide archived categories on the student record page.
create or replace function public.get_student_record(p_student_id text, p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
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
        )
    );
end;
$$;

notify pgrst, 'reload schema';
