# Load testing Scholog

**Status: not executed against production.** This document gives the analysis
and a runnable harness. See "Why I did not run it" at the bottom.

---

## 1. The short answer: 10,000 concurrent teachers will not hold up — and the database is not the first thing to break

The limit is not Postgres. It is the **background refresh loop** in `main.js`:

```js
setInterval(() => {                    // every 30s, while on dashboard/attendance
    if (Date.now() - lastCloudSyncAt < 20000) return;
    syncLatestFromCloud();             // -> fetchCloudState() -> 6 tables
}, 30000);
```

`fetchCloudState()` reads **six tables in full** for that teacher: `sections`,
`students`, `attendance`, `scores`, `grading_categories`,
`section_grading_categories`. Each is paginated at 1,000 rows.

| Scenario | Requests / 30s | Peak ~qps |
| --- | --- | --- |
| 1 teacher, 40 students, 60 class days | 6 | negligible |
| 100 teachers, same | 600 | ~20 |
| **10,000 teachers, same** | **60,000** | **~2,000** |
| 10,000 teachers, 200 class days (8,000 attendance rows → 8 pages) | 10,000 × 13 = 130,000 | **~4,300** |

A Supabase project on a small compute add-on handles roughly **a few hundred
queries per second** comfortably. So the ceiling is somewhere in the low
thousands of *actively-open dashboards*, and it is reached by **reads**, not
writes. Each of those reads also transfers the teacher's entire history.

### The fixes, cheapest first

1. **Poll a delta, not the world** (`S`). Ask for rows changed since a
   timestamp (`updated_at > $lastSync`) or just today's attendance:
   `attendance?date=eq.<today>` → one small query instead of six full ones.
   This alone cuts the load by roughly an order of magnitude.
2. **Back off when idle** (`S`). 30s → 60s/120s while the tab is visible but
   untouched, and pause entirely when hidden (partly done already via
   `document.visibilityState`).
3. **Use Supabase Realtime for check-ins** (`M`). Subscribe to the session's
   attendance rows instead of polling; the roster updates push-only. Needs RLS
   policies for realtime, which the current table grants intentionally avoid.
4. **Cap the sync window** (`S`). The dashboard only needs today; the PDF needs
   one date. Fetching a full academic year to render "3 present" is waste.

### What is *not* a problem

- **Writes.** Attendance saves are per-student upserts batched at 500 rows, the
  conflict target `(user_id, date, student_id, subject)` is a real unique index,
  and 40 concurrent check-ins touch 40 different rows (no lock contention).
- **Check-in RPCs.** `SECURITY DEFINER` functions doing an indexed lookup and one
  upsert; short, no table locks.
- **Storage volume.** 10k teachers × 8k attendance rows = 80M rows — large for a
  free tier, fine for a paid one *with* the indexes in
  `20261025_hot_path_indexes.sql`.

---

## 2. Indexes added for the hot paths

`supabase/migrations/20261025_hot_path_indexes.sql`

| Index | Serves |
| --- | --- |
| `students (user_id, lower(student_id))` | `checkin_mark()` and `get_student_record()` lookups — a plain column index cannot be used when the query wraps the column in `lower()` |
| `attendance (user_id, date)` | dashboard totals, daily PDF, sheet load |
| `attendance (user_id, student_id)` | per-student history modal |
| `scores (user_id, student_id)` | student record page, score history |
| `section_grading_categories (user_id, section)` | score-sheet column setup |
| `students (lower(record_code))` | record-code lookup without a teacher id |

Without these, a teacher with a few years of data turns every dashboard refresh
into sequential scans.

---

## 3. Running it

```bash
# install k6: https://k6.io/docs/get-started/installation/
k6 run scripts/loadtest/k6-checkin.js \
  -e SUPABASE_URL=https://<staging-ref>.supabase.co \
  -e SUPABASE_ANON_KEY=<staging anon key> \
  -e TOKEN=<a live check-in session token from the staging teacher> \
  -e STUDENT_IDS=$(seq -f '2026-%06g' 1 500 | paste -sd,)
```

The script ramps `50 → 500 → 2,000 → 10,000` virtual users over ~10 minutes and
watches three things:

| Metric | Threshold | Why |
| --- | --- | --- |
| `http_req_duration{p:95}` | < 1500 ms | a student standing in the corridor |
| `http_req_failed` | < 2% | RPC errors (not 4xx from a bad payload) |
| `checkin_latency` trend | < 800 ms p95 | the single write path that matters |

It only exercises the **check-in path** (`checkin_mark`), because that is the
only thing that hits 10,000 simultaneous users in the real world — 10,000
teachers do not press Save at the same instant, but 10,000 students do scan a QR
at 7:59 AM.

> **Point it at staging, never production.** Load tests write real rows; the
> check-in path also inserts into `checkin_events`. Use a throwaway Supabase
> project with a seeded class, and delete the project afterwards.

---

## 4. Why I did not run it

1. **No access.** This environment's outbound network is limited to
   `github.com`, `npmjs.org` and `pypi.org`; the Supabase project is not
   reachable, and no staging credentials exist here.
2. **It would be the wrong target.** The only database I could reach is the
   production one holding real learners' records. A 10,000-VU ramp against it
   would write synthetic check-ins over real attendance, could trip Supabase's
   abuse protection, and would be exactly the kind of processing that RA 10173
   obliges you to minimise — on minors' data.

So the deliverable is the analysis, the indexes and the harness. Run it against
staging and the numbers in §1 become measurable rather than arithmetic.
