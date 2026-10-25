-- Scholog — per-section grading categories and weights.
-- Each section configures its own categories and weights independently (totaling
-- 100% per section), because different subjects/sections use different grading
-- systems. Historical scores remain intact.

alter table public.grading_categories
    add column if not exists section text;

alter table public.grading_categories
    add column if not exists archived boolean not null default false;

-- Retire the old account-wide unique(user_id, name) rule so two sections under
-- the same teacher can both define e.g. "Quiz" or "Midterm" with different weights.
alter table public.grading_categories
    drop constraint if exists grading_categories_user_id_name_key;
drop index if exists public.grading_categories_user_id_name_key;

-- Assign every pre-existing category row to its section (cloning if a category
-- was shared across multiple sections, and archiving unselected 0%-weight
-- backfill placeholders while preserving their score foreign keys).
do $$
declare
    cat record;
    sec_list text[];
    primary_sec text;
    extra_sec text;
    cloned_id uuid;
    i integer;
begin
    for cat in
        select *
        from public.grading_categories
        where section is null
        order by created_at, id
    loop
        select array_agg(distinct sgc.section order by sgc.section)
          into sec_list
          from public.section_grading_categories sgc
         where sgc.user_id = cat.user_id
           and sgc.category_id = cat.id
           and sgc.section is not null;

        if sec_list is not null and array_length(sec_list, 1) >= 1 then
            primary_sec := sec_list[1];

            update public.grading_categories
               set section = primary_sec,
                   archived = false
             where id = cat.id;

            if array_length(sec_list, 1) >= 2 then
                for i in 2 .. array_length(sec_list, 1) loop
                    extra_sec := sec_list[i];
                    cloned_id := gen_random_uuid();

                    insert into public.grading_categories (
                        id, user_id, section, name, weight, archived, created_at, updated_at
                    ) values (
                        cloned_id, cat.user_id, extra_sec, cat.name, cat.weight, false, cat.created_at, cat.updated_at
                    );

                    update public.scores sc
                       set category_id = cloned_id
                      from public.students st
                     where sc.user_id = cat.user_id
                       and sc.category_id = cat.id
                       and st.user_id = sc.user_id
                       and st.student_id = sc.student_id
                       and st.section = extra_sec;

                    update public.section_grading_categories
                       set category_id = cloned_id
                     where user_id = cat.user_id
                       and section = extra_sec
                       and category_id = cat.id;
                end loop;
            end if;
        else
            select st.section
              into primary_sec
              from public.scores sc
              join public.students st
                on st.user_id = sc.user_id
               and st.student_id = sc.student_id
             where sc.user_id = cat.user_id
               and sc.category_id = cat.id
             limit 1;

            if primary_sec is null then
                select sec.name
                  into primary_sec
                  from public.sections sec
                 where sec.user_id = cat.user_id
                 order by sec.id
                 limit 1;
            end if;

            primary_sec := coalesce(primary_sec, 'General');

            update public.grading_categories
               set section = primary_sec,
                   archived = true,
                   weight = 0
             where id = cat.id;
        end if;
    end loop;
end;
$$;

alter table public.grading_categories
    alter column section set not null;

create unique index if not exists grading_categories_user_section_name_active_key
    on public.grading_categories (user_id, section, name)
    where (not archived);

create index if not exists idx_grading_categories_user_section
    on public.grading_categories (user_id, section);

notify pgrst, 'reload schema';
