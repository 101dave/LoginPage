-- Scholog — per-section grading schemes.
--
-- A teacher can handle a Grade 11 section and a college block at the same time.
-- The two record grades differently:
--
--   * High school, DO 015 s. 2026  → Term 1, Term 2, Term 3
--   * High school, DO 8 (legacy)   → Quarter 1..4
--   * College, semestral           → Prelim, Midterm, Semi-Final, Final
--
-- So the period structure belongs to the SECTION, not to the account and not to
-- the app. `periods` is an ordered jsonb array of { name, weight } where weight
-- is that period's share of the final grade (null = equal share).
--
-- Sections with no row keep the legacy Quarter/Semester list, so every existing
-- score stays exactly where it is.

create table if not exists public.section_grading_schemes (
    user_id uuid not null references auth.users(id) on delete cascade,
    section text not null,
    preset text not null default 'custom',
    periods jsonb not null default '[]'::jsonb,
    final_rule text not null default 'average' check (final_rule in ('average', 'weighted')),
    transmute boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (user_id, section),
    -- A scheme without periods is meaningless: "no scheme" means "delete the row".
    constraint section_grading_schemes_periods_nonempty
        check (jsonb_typeof(periods) = 'array' and jsonb_array_length(periods) between 1 and 12)
);

alter table public.section_grading_schemes enable row level security;

drop policy if exists "section_grading_schemes owner read" on public.section_grading_schemes;
drop policy if exists "section_grading_schemes owner write" on public.section_grading_schemes;
drop policy if exists "section_grading_schemes owner update" on public.section_grading_schemes;
drop policy if exists "section_grading_schemes owner delete" on public.section_grading_schemes;

create policy "section_grading_schemes owner read"
    on public.section_grading_schemes for select
    using (auth.uid() = user_id);

create policy "section_grading_schemes owner write"
    on public.section_grading_schemes for insert
    with check (auth.uid() = user_id);

create policy "section_grading_schemes owner update"
    on public.section_grading_schemes for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

create policy "section_grading_schemes owner delete"
    on public.section_grading_schemes for delete
    using (auth.uid() = user_id);

notify pgrst, 'reload schema';
