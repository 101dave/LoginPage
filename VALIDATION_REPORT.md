# Scholog — Feature Verification & Adjustment Report

**Date:** 2026-10-23
**Scope:** `101dave/LoginPage` (the Scholog attendance app), branch `arena/f84174e8-loginpage`
**Live preview:** `npm run serve` → port 8080
**Test result:** `npm test` → **49 passing, 0 failing** (1 live-network test skipped; 50 tests total), plus role-based checks run against the production database.

---

## 1. Summary of results

| Requirement | Status | Evidence |
| --- | --- | --- |
| Login / logout | ✅ Pass | `tests/ui-auth.test.mjs` (5 tests), `ui-main.test.mjs` logout test |
| Class list + section selection | ✅ Pass | `ui-main.test.mjs` (class list, search, section tabs), attendance section dropdown |
| Attendance marking (Present / Absent / Late / Excused) | ✅ Pass | `ui-main.test.mjs` loops through all four statuses and checks the saved payload |
| Saving attendance | ✅ **Fixed + Pass** | Wrong database conflict target repaired (see §3); verified against the live DB |
| Correct Daily PDF | ✅ Pass | `tests/pdf.test.mjs` builds a real PDF and inspects content; UI test checks filename/table |
| "Monthly SF2 (.xlsx)" export removed | ✅ Confirmed absent (removed dead code) | Static scan of every file; only export control is **Daily PDF** |
| "Dark Mode" removed | ✅ Confirmed absent + CSS removed | Static scan; dark-theme CSS block deleted; no theme control in any page |
| QR scanner on a separate page | ✅ Implemented | `scan.html` / `scan.js` / `scan.css`; dashboard only links to it |
| Scanner usable externally (students / other devices) | ✅ Implemented | Public session link `scan.html?t=<token>`, no teacher login, anonymous RPCs |
| Typed Student ID fallback | ✅ Implemented | Manual form on the check-in page |
| Typed IDs validated against the class list | ✅ Implemented | `checkin_mark()` validates against `students` for the session's section (server-side) |
| Attendance via QR **or** Student ID | ✅ Pass | 10 check-in tests + live database checks |
| No Monthly SF2 / no dark mode / scanner separate | ✅ Pass | `tests/static.test.mjs` (8 tests) |

---

## 2. What was verified (before changes)

**Login / auth** — sign-in with email + password, friendly error mapping, signup with
password validation, forgot-password email + cooldown, password recovery screen,
session redirect, and logout (Supabase sign-out + local session cleared). All flows
work; no changes were required.

**Class list** — section tabs (All / per section with counts), search by name or ID,
student table (name, ID, email, actions), add/edit/move/delete student and section,
and attendance history calendar. Section dropdowns on the attendance page stay in
sync with the class list.

**Attendance** — the sheet renders every student in the selected section for the
chosen date, highlighting the current status. All four statuses save, "All Present"
batch-writes the section, and the dashboard counts Present + Late as attended.

**Daily PDF** — previously exported a bare table titled "Scholog Attendance Report".
It now produces a complete daily report (title, section, date, teacher, generated
timestamp, status table, summary counts, attendance rate, page numbers) and a clear
`Daily_Attendance_<section>_<date>.pdf` filename. Verified by generating a real
PDF (≈9 KB) and asserting its contents.

---

## 3. Issues found and fixed

### 3.1 Critical — cloud attendance saves always failed
The `attendance` table's unique key is
`attendance_user_date_student_subject_key (user_id, date, student_id, subject)`, but
the app upserted with:

```js
{ onConflict: "user_id,date,student_id" }   // no such constraint
```

Postgres rejects this with `42P10` ("no unique or exclusion constraint matching the
ON CONFLICT specification"). Each save was therefore queued as an offline change and
retried forever; the UI only looked correct because of the local cache.

**Fix:** every attendance write now includes `subject: "General"` and uses
`onConflict: "user_id,date,student_id,subject"` (`setStudentStatus`,
`markAllAttendance`, `saveAttendance`). Confirmed against the production database:
the old form fails with `42P10`, the new form succeeds and updates instead of
duplicating rows.

### 3.2 Save re-uploaded the entire history
`saveAttendance()` used to push **every** attendance row the account had ever
recorded. It now writes only the selected date + section (the rows on screen), which
is faster and cannot clobber other sections.

### 3.3 Background refresh could silently revert a fresh mark
The new auto-refresh (needed so QR check-ins appear) could land after a teacher
clicked a status and overwrite it with the older cloud copy. Fixed with a local
mutation counter: a refresh result is discarded if anything changed locally while
the request was in flight, and refreshes are skipped while offline changes are
queued.

### 3.4 Third-party CDN dependencies (offline/PDF reliability)
jsPDF, AutoTable, Supabase, Lucide, QR generation and the camera scanner are now
vendored in `vendor/` (pinned versions, licenses included), so the app and the PDF
export also work offline. The service worker cache was bumped (`scholog-shell-v4`)
so existing installs receive the new code, and the new files were added to the
offline shell.

---

## 4. Feature removals

**Monthly SF2 (.xlsx) export** — this option does not exist anywhere in the
repository (no XLSX/SheetJS/Excel code, no "Monthly"/"SF2" strings, no spreadsheet
buttons). Nothing had to be deleted; automated tests now guard against it coming
back and assert that **Daily PDF is the only export control** in the app.

**Dark mode** — there was no toggle or theme switch in the UI; only an unused
`[data-theme="dark"]` CSS variable block and a dark `<meta name="theme-color">`.
The dead dark-theme CSS was deleted, the theme-color was set to the light app
background, and tests assert there is no `data-theme`, `darkMode`, dark
`prefers-color-scheme` rule, or theme control in any page.

---

## 5. New: QR / Student-ID check-in

### Architecture
- **`scan.html` is a standalone page** (own CSS/JS). The teacher dashboard contains
  no camera or scanner UI — only a link/button that opens the page in a new tab.
- **Session model:** the teacher opens `scan.html`, chooses section + date + duration,
  and the app inserts a row in `checkin_sessions` (token, section, date, expiry,
  closed). The page shows a QR code and a shareable link
  `scan.html?t=<token>`, plus a live roster.
- **External access:** students open the link/QR on any device. No login is needed.
- **Server validation:** two `SECURITY DEFINER` functions
  (`supabase/migrations/20261023_qr_checkin_functions.sql`) are the only things the
  anonymous role may execute:
  - `checkin_session_info(token)` → section, date, open/closed/expired, counts.
  - `checkin_mark(token, student_id)` → verifies the session is open and unexpired,
    verifies the ID (case-insensitive) belongs to that section's class list, then
    upserts `Present` for the session date, returning the student's name and whether
    they were already marked.
  The anonymous role has **no** table privileges — the class list, attendance and
  sessions cannot be read or written directly without a teacher login.
- **Inputs:** camera scan (QR) *or* typed Student ID. Camera permission/no-camera
  errors fall back to the manual form. Duplicate scans are throttled.
- **Student QR cards:** *Class List → QR* opens a printable ID card encoding
  `SCHOLOG:<student-id>`. The scanner also accepts raw IDs, `?id=` links and JSON.

### Live database verification (production project)
Executed with role switching on the real Supabase database, then cleaned up
(test rows were removed and the live data was left unchanged: 2 sections, 2
students, 4 attendance rows):

| Check | Result |
| --- | --- |
| `anon` reading `students` | ❌ blocked (`42501 permission denied`) — no data leak |
| session info for a valid token | `ok: true`, correct section, `student_count: 2` |
| mark `QA-1` | `ok: true`, name returned, row written as `Present` / `General` |
| repeat mark | `ok: true`, `already_marked: true`, single row (upsert works) |
| lowercase `qa-2` (was `Late`) | matched, `previous_status: "Late"`, now `Present` |
| student from another section (`QA-9`) | `not_in_class` |
| unknown ID / blank ID | `not_in_class` / `missing_id` |
| closed session | `session_closed` |
| expired session | `session_expired` |
| unknown token | `invalid_session` |
| session info flags | `closed: true`, `expired: true` returned correctly |

Implemented in `scan.html`, `scan.js`, `scan.css`, `supabase/migrations/…`,
`main.html` (launcher + student QR modal), `main.js` (`openQrCheckInPage`,
`openStudentQr`, `refreshAttendanceFromCloud`).

---

## 6. Files changed

```
index.html          vendored Supabase, light theme-color
main.html           vendored libs, Daily PDF label, QR check-in launcher card,
                    Refresh button, student QR modal
main.js             attendance upsert fix, scoped save, cloud refresh + mutation
                    guard, daily PDF via pdf.js, QR helpers
main.css            removed dark-theme block, QR card + printable QR card styles
style.css           unchanged
script.js           unchanged
scan.html/.js/.css  NEW standalone QR / Student ID check-in page
pdf.js              NEW daily PDF builder (dependency-injected, unit tested)
supabase/migrations/20261023_qr_checkin_functions.sql   NEW public check-in RPCs
vendor/             pinned browser libraries + licenses + README
sw.js               cache v3 + new shell files
manifest.json       QR check-in shortcut, updated description
privacy.html        check-in data note
README.md, VALIDATION_REPORT.md, package.json, .gitignore, tests/  NEW
```

---

## 7. How to re-run the verification

```bash
npm install
npm test                 # 39 UI / PDF / static tests (no network required)
npm run test:integration # live Supabase end-to-end (needs network access)
npm run serve            # http://localhost:8080
```

Manual smoke test:
1. Sign in → dashboard shows totals and section breakdown.
2. Class List → add a section/student → **QR** shows a printable code.
3. Take Attendance → choose section/date → set the four statuses → Save →
   **Daily PDF** downloads the report.
4. **Open QR Check-In** → pick section/date → *Create check-in QR*.
5. Copy the link into a private window / phone → no login → type the Student ID →
   "You're marked Present".
6. Type an ID from another section → rejected with an explanation.
7. Back in the dashboard → attendance sheet (after Refresh) shows Present; the PDF
   includes it.
8. End check-in on `scan.html` → further check-ins are refused.

---

## 8. Notes / limitations

- Camera scanning requires HTTPS or `localhost` (browser requirement). The typed-ID
  fallback always works.
- Check-in is token-based and time-limited; anyone with an active session link can
  submit IDs from that section. For high-stakes registers, close the session once
  the class is seated — this is the intended classroom flow. Device-level rate
  limiting would require an edge function and a persistent per-device identifier.
- The app is a static site, so the Supabase anon (publishable) key is embedded as
  before; all protection is enforced by RLS and the two `SECURITY DEFINER`
  functions.
- The live integration test in `tests/integration.test.mjs` is skipped by default
  because it needs outbound network access to Supabase.

---

## 9. Follow-up: QR check-in usability pass

After the first release, the check-in page was reworked for clarity and easier
navigation (no behaviour change to the underlying RPCs).

**Student page**
- Class header now shows section, date (with "Today ·"), open/closed badge and a
  progress bar with "`n` / `total` checked in" — students immediately see where
  they are.
- Replaced the two stacked forms with a **Scan QR / Type ID** segmented control
  (proper `role="tablist"`, arrow-key navigation) so only one option is on screen.
- The camera **starts automatically** when the scan tab opens; a blocked camera
  shows a plain-language message and switches to the typed-ID tab.
- A successful check-in takes over the screen: big green confirmation with the
  student's first name, an "Already checked in" variant, and the running count.
- The confirmation **ends the flow**: there is no "Scan next student" and the camera
  does not re-arm, because one phone may only check in one student (see §10).
- A "One phone = one check-in" chip under the class header, plus a help-panel note
  explaining what to do if a phone is shared.
- "Checked in here" chip remembers the student checked in from that device, and a
  collapsible "How do I check in?" explains the 3 steps.

**Teacher page**
- Clear 1-2-3 flow: **choose a class → share the QR/link → live roster**. The
  setup form hides itself once a session exists and returns via *New session*.
- Opening from the dashboard **pre-fills the section and date** already selected in
  the attendance view (`scan.html?section=…&date=…`).
- New **Present on screen** projection mode: full-screen QR, class name, live
  checked-in count, copy-link and Exit (Esc also closes).
- **Copy** and native **Share** buttons, a friendlier empty/closed state, and
  "Updated 10:42" on the roster.

**Tests added** (7): tab switching/one-thing-at-a-time, automatic camera start,
result + recent list + camera re-arm, dashboard prefill, projection mode
open/close/Esc, setup-vs-session panel switching, and the launcher passing the
selected section/date. Suite is now **49 passing, 0 failing**.

## 10. One phone = one check-in

*Requirement: a single phone may not be passed around the class.*

**Server (authoritative).** Migration `supabase/migrations/20261023_single_device_checkin.sql`
(applied to the production project) adds:

- `checkin_events (id, token, device_id, student_id, created_at)` with
  `unique (token, device_id)`, RLS enabled, no policies, and
  `revoke all ... from anon, authenticated` — only the `security definer` RPC touches it.
- `checkin_mark(p_token uuid, p_student_id text, p_device_id text default null)`,
  replacing the 2-argument version. Blank/`null` device ids (the teacher's own
  scanner) keep the old unlimited behaviour.

| Situation | `checkin_mark` result |
| --- | --- |
| First check-in from a phone | `{ok:true, …, already_marked:false}` |
| Same phone, same student again | `{ok:true, …, already_marked:true}` |
| Same phone, a **different** student | `{ok:false, error:"device_already_used", device_student_name, device_student_id}` |
| Teacher device (no `p_device_id`) | always `ok`, any number of students |

**Live verification (production project, `SET LOCAL ROLE anon`, temp `__QA__` user, rolled back + user deleted afterwards):**

| Step | Result |
| --- | --- |
| `phoneA` → `DEV-1` | `ok:true, checked_in:1` |
| `phoneA` → `DEV-2` | `ok:false, device_already_used, device_student_name:"QA One"` |
| `phoneA` → `DEV-1` again | `ok:true, already_marked:true` |
| `phoneB` → `DEV-2` | `ok:true, checked_in:2` |
| teacher (`null` device) × 2 | `ok:true` both times |
| old 2-arg call still works | `ok:true` (default `null`) |

**Client (`scan.js`).**
- `getDeviceId()` stores a random UUID in `localStorage["scholog_device_id"]`
  (falls back to a per-load id when storage is blocked).
- Only the **student** path sends `p_device_id`; `hostCheckIn()` sends nothing.
- A successful check-in writes `localStorage["scholog_checkin_lock"]`
  (`{token, studentId, name}`); on reload the page restores the "already checked in"
  screen instead of the scanner.
- `device_already_used` shows **"One check-in per phone"** naming the student already
  checked in, with no retry option; the Scan/Type tabs stay hidden.
- `friendlyError()` gained `device_already_used` and `invalid_device` copy.
- Fixed a scanner race found while testing: `state.scanning` is now set *before*
  awaiting `Html5Qrcode.start()`, so a code decoded during warm-up stops cleanly and
  the start button stays usable.

**Tests added/updated (`tests/ui-scan.test.mjs`).** Successful check-in locks the
phone; the device id is sent and the lock survives a reload; the server rejection is
explained with the other student's name; two teacher scans send no `p_device_id`.
