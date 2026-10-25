# QA audit — the 10-point checklist

Date: 2026-10-25 · App version: `6acefcf` + this branch · Suite: **120 tests, 119 pass, 1 skipped, 0 fail**

Everything below is either **executed evidence** or **explicitly marked as not
testable here**. No item is claimed as working because the code "looks right".

How it was run:

```bash
npm install --no-audit --no-fund
node --test tests/audit.test.mjs     # the new 20-test hostile suite
npm test                             # the whole suite
```

The hostile suite (`tests/audit.test.mjs`) drives the real `main.js` inside
jsdom against a fake Supabase that enforces the same unique constraints as the
real database, and reads the *database*, not the app's in-memory state — so a
bug that only hides values in the UI still shows up.

---

## Verdict table

| # | Checklist item | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | UI centred and responsive | **PASS** (static) | `.main-container` `max-width:1280px; margin:0 auto`, `.scan-main` `max-width:760px; margin:0 auto`, `style.css` `body{display:flex; justify-content:center}` + `.container{max-width:440px; margin:auto}`. 35 media queries in `main.css`, 6 in `scan.css`, smallest breakpoint 360px. All three `data-table`s are inside `.table-responsive{overflow-x:auto}` so a 620px sheet scrolls instead of pushing the page sideways. Not verified in a real browser (none in this environment). |
| 2 | Login works separately for student and teacher | **PASS, but the premise is wrong** | Only teachers have accounts (`index.html` Sign In / Create Account → Supabase Auth). Students never log in: they scan a QR (`index.html` → Scan QR → `scan.html`) or look up their record (`student-record.html` + 8-char record code). `tests/audit.test.mjs` asserts the student surface contains no `password` field and no `signInWithPassword` call. |
| 3 | Class list, attendance, scores correct | **PASS** | Create/edit/delete, duplicate-ID refusal, per-section roster, attendance save, score save and sheet recalculation all covered and green. The grading engine now supports **both** school levels per section: DepEd DO 015 s. 2026 terms (WW 30 / PT 30 / EX 40, transmutation, descriptors) and college periods (Prelim/Midterm/Semi-Final/Final, average or weighted). See `## Grading schemes` in the README. |
| 4 | Invalid input is caught | **PASS after 3 fixes** | 7 hostile tests: blank/whitespace name and ID refused; duplicate ID refused in the form *and* on edit; HTML in a name escaped; apostrophes/quotes survive inline `onclick` arguments; scores 999 / −5 / `abc` / empty refused; unknown attendance status refused (**was broken — fixed**); HTML/regex/SQL metacharacters in search are inert. |
| 5 | 10,000 concurrent users | **NOT TESTABLE HERE** | No reachable database (this sandbox can only reach github/npm/pypi) and no staging project. Analysis + runnable k6 harness delivered: `docs/LOAD_TEST.md`, `scripts/loadtest/k6-checkin.js`. Headline: reads, not writes, are the ceiling. |
| 6 | QR generation and scanning | **PASS** | Payload round-trips: `SCHOLOG:2026-0001:K7M2QPX9` when the student has a record code, `SCHOLOG:2026-0002` otherwise. Scanner page handles camera start/stop, duplicate-device rejection and the single-session token (`tests/ui-scan.test.mjs`, `tests/record-access.test.mjs`). |
| 7 | Security: hashing, access control, session expiry | **PASS with one honest caveat** | Passwords never touch app code — `signInWithPassword({email,password})` hands them to Supabase Auth (bcrypt server-side); no password in `localStorage`/`sessionStorage`/`console` (asserted). Access control is RLS + the record-code gate. Session expiry: no client-side idle timeout; lifetime is Supabase's JWT policy — now with a real consequence when it lapses (see fix 3). |
| 8 | Random unique student IDs, no duplicates | **PASS after a guard was added** | 250 randomly generated IDs bulk-imported: zero duplicates in the database, zero in-block collisions, re-pasting the same block updates instead of inserting. Form path rejects duplicates on create *and* edit. A DB-level unique index is now attempted by migration. |
| 9 | Random IDs link correctly to attendance and scores | **PASS** | A new `2027-314159` student → marked Late → 18/20 scored → both visible on the sheet; attendance keys are date-scoped so one student cannot overwrite another; renaming an ID moves attendance and scores with it and leaves nothing orphaned (new test). |

---

## Defects found and fixed

### 1. Attendance accepted any status string (data corruption)

`setStudentStatus()` wrote whatever it was handed into `state.attendance` and
queued it to the cloud. There is no `CHECK` constraint on
`attendance.status`, so `""`, `"HACKED"` or a hand-edited restored backup landed
in the table. The dashboard then counted the row as "recorded" but as neither
present nor absent, silently deflating the attendance rate.

- `main.js`: one allow-list (`Present | Absent | Late | Excused`) used by
  `setStudentStatus`, `saveAttendance` (which now repairs an invalid cached value
  to `Present` instead of uploading garbage) and `markAllAttendance`.
- `supabase/migrations/20261025_attendance_status_and_student_id_constraints.sql`:
  adds the `CHECK` constraint `NOT VALID` (enforces new rows without rewriting
  history), validates it automatically when no bad rows exist, otherwise raises
  a notice listing what to clean up. Same migration attempts the unique index on
  `students (user_id, student_id)` — the table predates this repo's migrations,
  so the constraint was previously only *assumed*.

### 2. Sign-out left the previous teacher's class data on the device

A shared staffroom device kept the full roster, attendance and grades in
`localStorage` under `scholog_app_data_<uid>` after logout — and a legacy
`scholog_app_data` key from local-only sessions was never cleaned up at all.
The next teacher could read it from DevTools.

`handleLogout()` now removes both caches — unless the offline queue would lose
unsynced work, in which case the cache is kept (losing a marked attendance sheet
is worse than a dirty cache on a device the teacher is still holding).

### 3. An expired session left the dashboard open

`onAuthStateChange("SIGNED_OUT")` only set `currentUser = null`. The teacher
stayed on `main.html` looking at cached data, and every subsequent write joined
the offline queue and retried forever against a dead session. Now a `SIGNED_OUT`
while on the dashboard redirects to `index.html`.

### 4. Hot-path indexes (added pre-emptively for item 5)

`supabase/migrations/20261025_hot_path_indexes.sql`. The check-in RPCs match
learners with `lower(student_id) = lower($1)`, which cannot use the plain
`(user_id, student_id)` index — the roster was being scanned on every scan. Also
indexes `attendance (user_id, date)`, `attendance (user_id, student_id)`,
`scores (user_id, student_id)`, `section_grading_categories (user_id, section)`
and `students (lower(record_code))`.

---

## Not testable in this environment

| Item | Why | What to do instead |
| --- | --- | --- |
| 10,000 concurrent users | No reachable Supabase project; a load test against production would write synthetic check-ins over real learners' records and breach data-minimisation duties. | Run `scripts/loadtest/k6-checkin.js` against a throwaway staging project. `docs/LOAD_TEST.md` explains what to watch and what will break first (the 30-second full-state poll). |
| Real rendering / touch targets | No browser. `jsdom` has no layout engine, so "is it centred" is answered from CSS rules only. | Open the four pages at 360px, 390px and 768px widths in responsive mode; the classes to watch are `.main-container`, `.table-responsive`, `.score-spreadsheet-wrap`. |
| Password hashing algorithm | bcrypt happens inside Supabase Auth. | Confirm in the Supabase dashboard (Auth → Providers → Email) that bcrypt cost is the default; the app never sees a password. |
| JWT lifetime / idle timeout | Set by the Supabase project, not by code. | Dashboard → Auth → Sessions. Consider lowering the access-token TTL and adding an idle timeout if devices are shared. |
| Migrations actually applied | No database here. | Apply in order; the two new ones are additive and re-runnable. |

---

## Recommended next steps, in order

1. **SF9 (Report Card) from the term grades** — the term engine now exists, but
   the printable card does not. This is the last place where the app can produce
   a *wrong number a parent will sign*.
2. Apply the three new migrations the next time you deploy (client change goes
   with the attendance allow-list; old clients stay compatible).
3. Run the k6 harness on staging, then replace the 30-second full-state poll with
   a delta/today-only fetch.
4. Add an idle timeout (15 min) on the dashboard if teachers share devices —
   Supabase expiry alone will not log out someone who walks away mid-shift.
