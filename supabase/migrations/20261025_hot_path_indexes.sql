-- Scholog — indexes for the query shapes the app actually issues.
--
-- Written for the "will this hold up with many teachers" question, not for
-- micro-optimisation. Every statement is IF NOT EXISTS and safe to re-run.
--
-- The three hot paths, and why each index is here:
--
-- 1. Check-in (`checkin_mark`) and the record page (`get_student_record`) look a
--    learner up with `lower(student_id) = lower($1)`. A function call on the
--    column means the plain unique index on (user_id, student_id) cannot be
--    used, so Postgres scans the teacher's whole roster. The expression index
--    below matches the query exactly.
--
-- 2. The dashboard, the daily PDF and "save the sheet" all read one teacher's
--    attendance for one date; the sheet also re-reads every student in a
--    section. (user_id, date) and (user_id, student_id) make those index lookups
--    instead of sequential scans once a teacher has years of rows.
--
-- 3. The 30-second background refresh fetches the whole account (see
--    docs/LOAD_TEST.md). These indexes make that refresh cheaper; they do not
--    make it free — reducing the polling itself is the real fix.

create index if not exists students_user_lower_student_id_idx
    on public.students (user_id, lower(student_id));

create index if not exists attendance_user_date_idx
    on public.attendance (user_id, date);

create index if not exists attendance_user_student_idx
    on public.attendance (user_id, student_id);

create index if not exists scores_user_student_idx
    on public.scores (user_id, student_id);

create index if not exists section_grading_categories_user_section_idx
    on public.section_grading_categories (user_id, section);

-- The record page also matches students by record code without a teacher id.
create index if not exists students_lower_record_code_idx
    on public.students (lower(record_code));
