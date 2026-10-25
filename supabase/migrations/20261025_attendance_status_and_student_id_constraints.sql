-- Scholog — enforce the attendance status domain in the database.
--
-- The client is the only writer, and until now it accepted any string:
-- `setStudentStatus()` copied whatever it was given into state and queued it to
-- the cloud. With no CHECK constraint, garbage like 'HACKED' or '' landed in
-- `attendance`, which then skewed the dashboard rate (an unknown status counts
-- as recorded but as neither present nor absent).
--
-- `NOT VALID` is deliberate: it enforces the domain for every INSERT and UPDATE
-- from now on, without a full table scan and without silently rewriting history.
-- Existing bad rows (if any) are reported below so they can be reviewed and
-- fixed by a human, then the constraint can be validated.

do $$
begin
    if not exists (
        select 1
          from pg_constraint
         where conrelid = 'public.attendance'::regclass
           and conname = 'attendance_status_check'
    ) then
        alter table public.attendance
            add constraint attendance_status_check
            check (status in ('Present', 'Absent', 'Late', 'Excused'))
            not valid;
    end if;
end $$;

-- How many legacy rows sit outside the domain? (Expect zero.)
do $$
declare
    bad integer;
begin
    select count(*) into bad
      from public.attendance
     where status not in ('Present', 'Absent', 'Late', 'Excused');

    if bad > 0 then
        raise notice 'Scholog: % attendance row(s) hold an invalid status. Review them, then run: alter table public.attendance validate constraint attendance_status_check;', bad;
    else
        -- Nothing to clean up: make the constraint fully trusted.
        alter table public.attendance validate constraint attendance_status_check;
    end if;
end $$;

-- Student IDs are unique per account. The table predates this repo's
-- migrations, so the constraint is added defensively; duplicate rows (which
-- would make attendance and scores ambiguous) are reported rather than deleted.
do $$
declare
    dupes integer;
begin
    select count(*) into dupes
      from (
        select user_id, student_id
          from public.students
         group by user_id, student_id
        having count(*) > 1
      ) d;

    if dupes > 0 then
        raise notice 'Scholog: % duplicate (user_id, student_id) pair(s) exist. Merge or delete them, then run: create unique index students_user_student_id_key on public.students (user_id, student_id);', dupes;
    else
        create unique index if not exists students_user_student_id_key
            on public.students (user_id, student_id);
    end if;
end $$;
