# Scholog — Student & Attendance Tracker

Scholog is a static, installable web app for teachers: manage class sections and
student lists, take daily attendance (Present / Absent / Late / Excused), export a
daily PDF report, and let students check themselves in from their own phones with a
QR code or their Student ID. Data is stored in Supabase with per-account Row Level
Security, cached locally for offline use, and synced automatically when back online.

## Pages

| Page | Purpose |
| --- | --- |
| `index.html` | Sign in, create account, forgot password, set new password |
| `main.html` | Teacher dashboard: dashboard, class list, take attendance, student scores, daily PDF |
| `scan.html` | **Separate** check-in page: students scan QR / type ID; teachers create and share the session |
| `privacy.html` | Privacy policy |

## Taking attendance

> **No QR session = walang pasok.** A QR check-in session is what tells students
> there is a class to check in for. If the teacher never creates one for a date,
> students cannot check in at all (the page shows a "Walang pasok · No class today"
> screen). The teacher can **still record attendance by hand** — manual Present /
> Absent / Late / Excused + **Save** never needs a QR session.

1. **In class (teacher):** *Take Attendance* → pick a date and section → tap a status
   per student, *All Present*, then **Save**. **Daily PDF** downloads
   `Daily_Attendance_<section>_<date>.pdf` with the roster, statuses and summary.
   This works with or without a QR session.
2. **Student self check-in (QR / Student ID):**
   1. Teacher opens **Start QR Check-In** (attendance view) — `scan.html` opens in a new
      tab, already pre-filled with the section and date on screen. The scanner is never
      inside the dashboard itself.
   2. Teacher taps *Create check-in QR*. A QR code, share link
      (`scan.html?t=<session token>`) and live roster appear. **Present on screen**
      projects a big full-screen QR for the classroom; **Copy** / **Share** sends the
      link to a group chat. The setup form hides itself once the session exists.
   3. Students open that link/QR on their own devices — **no login needed**. The page
      has two clear tabs: **Scan QR** (camera starts automatically) and **Type ID**
      for anyone without a QR card. Scanning is **student-only** — the teacher page
      has no camera.
   4. The ID is validated against that section's class list on the server, then a
      Present record is written for the session date. The result takes over the screen
      with a big confirmation, the student's name and the running count.
   5. The dashboard refreshes automatically (and via **Refresh**) so check-ins show up
      in the attendance sheet and the daily PDF.

Student QR cards are generated in **Class List → QR** and can be printed. The payload
is `SCHOLOG:<student-id>`; the check-in page also accepts raw IDs, `?id=<student-id>`
links and JSON payloads.

### Check-in page UX at a glance

| Who | What they see |
| --- | --- |
| Student | Class + date + progress, a **"One phone = one check-in"** rule chip, then a **Scan QR / Type ID** switch, auto-starting camera, a big green confirmation that ends the flow, a "Checked in here" chip and a collapsible 3-step help panel |
| Teacher | A **1-2-3** flow: choose class → share the QR/link → watch the live roster; projection mode, copy/share, refresh, new session, end check-in and a **Record manually** shortcut are always one tap away (no teacher-side camera scanning) |

## Recording scores and final grades

Open **Student Scores → Categories & Weights** after selecting a section to create
that section's categories such as Written Work, Performance Task, Quiz, Midterm,
Final Exam, Lab Practical, Project, or Recitation, along with how many **subsections**
each category starts with (for example, 6 Written Works, 4 Quizzes, or 3 Performance
Tasks). Each section manages its own independent categories and weights totaling
100%, so different subjects and sections can use completely different grading
systems without affecting one another.

Choose a date and grading period (Quarter 1–4, Semester 1–2, or Unassigned). The
spreadsheet groups subsections under each parent category header: teachers can add
(`+ Add`), rename, or remove (`×`) subsections directly in the table header, set an
independent **Max** score per subsection (e.g. `15`, `20`, `25`, `30`, `50`, `100` —
never locked to `100`), and enter raw scores directly in the cells. Each category's
percentage is the sum of its subsections' raw points divided by the sum of their
maximum points; the final grade combines those category percentages using that
section's weights. Until every weighted subsection in the section has a score, the
table shows a **running grade** rather than a complete final grade.

Apply `supabase/migrations/20261025_grading_categories.sql`,
`supabase/migrations/20261025_per_section_grading_categories.sql`,
`supabase/migrations/20261025_grading_category_items.sql`, and
`supabase/migrations/20261025_drop_legacy_score_category_unique_index.sql` so
scores carry grading-period, category, and subsection metadata and
`grading_categories` store per-section categories and their subsections.

## Backend

- Supabase project settings live in `.env` and are mirrored in `script.js`, `main.js`
  and `scan.js` (the app is static, so the publishable anon key is embedded — RLS
  protects the data).
- Tables: `sections`, `students`, `attendance`, `scores`, `grading_categories`,
  `section_grading_categories`, `checkin_sessions`.
- Attendance is unique per `(user_id, date, student_id, subject)`; the app writes
  `subject = 'General'` and upserts on that exact conflict target.
- Public check-in RPCs: `checkin_session_info(token)` and
  `checkin_mark(token, student_id, device_id = null)`.
- **One phone = one check-in.** The student page sends a random `device_id`
  (`localStorage`, per browser). The RPC stores `(token, device_id)` in
  `checkin_events` and refuses a *second, different* student from the same phone
  with `device_already_used` (naming the student already checked in). Re-submitting
  the same student is fine.
- A check-in needs a live session: no session, a closed session or an expired
  session is rejected (`invalid_session` / `session_closed` / `session_expired`).
  The page turns `invalid_session` into the "Walang pasok · No class today" screen.
- `checkin_mark` also accepts `device_id = null` (kept for old clients and scripts);
  the app's own teacher flow never calls it — teachers record in the dashboard.
  (see `supabase/migrations/20261023_qr_checkin_functions.sql`). They are
  `SECURITY DEFINER`, validate the session (open, not expired) and the student ID,
  and are the only thing `anon` can execute — the class list, attendance and sessions
  stay unreadable without a teacher login.

## Backup & restore

**Profile → Backup Data** downloads the whole account as one JSON file
(`Scholog_Backup_<date>.json`): sections, students, attendance, scores **and**
the per-section grading categories. **Restore Data** replaces the account with
that file (cloud + local cache) and reports exactly what came back, e.g.
*"Backup restored: 4 students, 3 attendance records, 12 scores."*

Two guarantees worth knowing after a restore:

- A score is never dropped because its grading category was renamed or deleted.
  Restore re-links it to the matching category by name, and when no category
  exists at all it creates a **weight-0** one (visible in *Categories & Weights*,
  so the teacher can name it or give it a weight) instead of failing.
- The whole payload is planned and validated **before** the cloud rows are
  deleted, and a failing score batch is retried one row at a time. Previously a
  single legacy score aborted the restore after students and attendance had
  been written — leaving the account with no scores at all.

If a restore is interrupted by a dropped connection, the same backup file can be
restored again: restoring is a full replace, never a merge.

## Local development

```bash
npm install        # dev tooling for the test suite only
npm run serve      # static server on http://localhost:8080 (use any static server)
```

Open `/index.html`. Camera scanning requires HTTPS or `localhost`.

## Tests

```bash
npm test                  # UI/PDF/backup/SMS/static checks (jsdom, no network)
npm run test:integration  # live Supabase test (needs network + SCHOLOG_INTEGRATION=1)
```

The suite loads the real HTML/CSS/JS in jsdom with stubbed libraries and covers:
authentication flows, dashboard/class list rendering, all four attendance statuses,
attendance saving and cloud conflict targets, daily PDF content, removal of the
Monthly SF2 export and dark mode, student QR cards, the standalone check-in page
(QR scan, typed ID, invalid/closed/expired sessions, host mode, live roster),
backup/restore round trips (including legacy scores with no grading category),
and asset/offline-cache consistency.

## Deploying to Vercel

The app is plain static files — no build step, no environment variables needed
(the Supabase URL + anon key are embedded in the JS, which is safe: they are the
public client credentials, protected by Row Level Security).

1. Import the repo in Vercel and keep **Framework Preset: Other**, build command
   empty, output directory `.` (the repository root).
2. Deploy. `vercel.json` adds the security headers (CSP, `X-Frame-Options`,
   `Referrer-Policy`, `Permissions-Policy`), `immutable` caching for `/vendor/*`
   and `must-revalidate` for HTML + `sw.js`.
3. Add your production URL to Supabase → Authentication → URL Configuration
   (`Site URL` + `Redirect URLs`). It is already set to
   `https://scholog.vercel.app` plus `https://*-*.vercel.app/**` for previews.
4. Camera check-in needs HTTPS — Vercel gives that automatically.

## Files

```
index.html, script.js, style.css      auth UI
main.html, main.js, main.css, pdf.js  teacher app + daily PDF builder
sms.js                                guardian-SMS helpers (encoding, cost, rules)
scan.html, scan.js, scan.css          standalone QR / Student ID check-in
vendor/                               pinned browser libraries (see vendor/README.md)
supabase/migrations/                  SQL applied to the Supabase project
tests/                                node:test suites
sw.js, manifest.json                  PWA offline cache + install metadata
vercel.json                           security + caching headers for Vercel
robots.txt, sitemap.xml               crawl rules / search metadata
```
