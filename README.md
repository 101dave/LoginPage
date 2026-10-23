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
| `main.html` | Teacher dashboard: dashboard, class list, take attendance, daily PDF |
| `scan.html` | **Separate** QR / Student ID check-in page (students + teacher host mode) |
| `privacy.html` | Privacy policy |

## Taking attendance

1. **In class (teacher):** *Take Attendance* → pick a date and section → tap a status
   per student, *All Present*, then **Save**. **Daily PDF** downloads
   `Daily_Attendance_<section>_<date>.pdf` with the roster, statuses and summary.
2. **Student self check-in (QR / Student ID):**
   1. Teacher opens **Open QR Check-In** (attendance view) — it opens `scan.html` in a
      new tab, never inside the dashboard.
   2. Teacher picks the section + date and taps *Create check-in QR*. A QR code and
      share link (`scan.html?t=<session token>`) appear, plus a live roster.
   3. Students open that link/QR on their own devices — **no login needed**. They scan
      the QR code printed from *Class List → QR*, or type their Student ID.
   4. The ID is validated against that section's class list on the server, then a
      Present record is written for the session date.
   5. The dashboard refreshes automatically (and via **Refresh**) so check-ins show up
      in the attendance sheet and the daily PDF.

Student QR cards are generated in **Class List → QR** and can be printed. The payload
is `SCHOLOG:<student-id>`; the check-in page also accepts raw IDs, `?id=<student-id>`
links and JSON payloads.

## Backend

- Supabase project settings live in `.env` and are mirrored in `script.js`, `main.js`
  and `scan.js` (the app is static, so the publishable anon key is embedded — RLS
  protects the data).
- Tables: `sections`, `students`, `attendance`, `checkin_sessions`.
- Attendance is unique per `(user_id, date, student_id, subject)`; the app writes
  `subject = 'General'` and upserts on that exact conflict target.
- Public check-in RPCs: `checkin_session_info(token)` and `checkin_mark(token, student_id)`
  (see `supabase/migrations/20261023_qr_checkin_functions.sql`). They are
  `SECURITY DEFINER`, validate the session (open, not expired) and the student ID,
  and are the only thing `anon` can execute — the class list, attendance and sessions
  stay unreadable without a teacher login.

## Local development

```bash
npm install        # dev tooling for the test suite only
npm run serve      # static server on http://localhost:8080 (use any static server)
```

Open `/index.html`. Camera scanning requires HTTPS or `localhost`.

## Tests

```bash
npm test                  # 39 UI/PDF/static checks (jsdom, no network)
npm run test:integration  # live Supabase test (needs network + SCHOLOG_INTEGRATION=1)
```

The suite loads the real HTML/CSS/JS in jsdom with stubbed libraries and covers:
authentication flows, dashboard/class list rendering, all four attendance statuses,
attendance saving and cloud conflict targets, daily PDF content, removal of the
Monthly SF2 export and dark mode, student QR cards, the standalone check-in page
(QR scan, typed ID, invalid/closed/expired sessions, host mode, live roster) and
asset/offline-cache consistency.

## Files

```
index.html, script.js, style.css      auth UI
main.html, main.js, main.css, pdf.js  teacher app + daily PDF builder
scan.html, scan.js, scan.css          standalone QR / Student ID check-in
vendor/                               pinned browser libraries (see vendor/README.md)
supabase/migrations/                  SQL applied to the Supabase project
tests/                                node:test suites
sw.js, manifest.json                  PWA offline cache + install metadata
```
