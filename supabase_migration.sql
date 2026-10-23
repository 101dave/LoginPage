-- Scholog v2 Additive Supabase Migration
-- Safe to run multiple times (idempotent, preserves all existing rows & RLS policies)

-- 1. Sections: optional class start time (HH:MM) for QR auto-Late cutoff + subjects/schedules array
ALTER TABLE public.sections
  ADD COLUMN IF NOT EXISTS start_time text,
  ADD COLUMN IF NOT EXISTS subjects jsonb NOT NULL DEFAULT '["General"]'::jsonb;

-- 2. Students: optional gender column for DepEd SF2 Male/Female grouping
ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS gender text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'students_gender_check'
  ) THEN
    ALTER TABLE public.students
      ADD CONSTRAINT students_gender_check
      CHECK (gender IS NULL OR gender IN ('Male', 'Female', 'Other'));
  END IF;
END $$;

-- 3. Attendance: support per-subject/schedule attendance + optional remarks/excuse notes
ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS subject text NOT NULL DEFAULT 'General',
  ADD COLUMN IF NOT EXISTS remarks text;

ALTER TABLE public.attendance
  DROP CONSTRAINT IF EXISTS attendance_user_date_student_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attendance_user_date_student_subject_key'
  ) THEN
    ALTER TABLE public.attendance
      ADD CONSTRAINT attendance_user_date_student_subject_key
      UNIQUE (user_id, date, student_id, subject);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_attendance_user_date_subject
  ON public.attendance USING btree (user_id, date, subject);

NOTIFY pgrst, 'reload schema';
