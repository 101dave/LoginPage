-- Drop legacy 5-column unique index/constraint on public.scores that blocked
-- recording multiple subsections (different item_id values) under the same
-- grading category on the same date, student, and grading period (HTTP 409).

alter table public.scores
    drop constraint if exists scores_user_date_student_period_category_key;

alter table public.scores
    drop constraint if exists scores_user_date_student_subject_key;

alter table public.scores
    drop constraint if exists scores_user_id_date_student_id_subject_key;

drop index if exists public.scores_user_date_student_period_category_key;
drop index if exists public.scores_user_date_student_period_category_idx;
drop index if exists public.scores_user_date_student_subject_key;
drop index if exists public.scores_user_id_date_student_id_subject_key;

create unique index if not exists scores_user_date_student_period_cat_item_idx
    on public.scores (user_id, date, student_id, grading_period, category_id, item_id);

notify pgrst, 'reload schema';
