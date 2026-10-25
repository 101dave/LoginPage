# Scholog — Feature Proposals to Stand Out

**Date:** 2026-10-25 · **Branch:** `arena/93d9ef82-loginpage`
**Goal:** pick features that make Scholog *the* tool a Filipino teacher reaches for — not just another attendance app.

---

## 1. Where the app is already strong (don't rebuild these)

| Already shipped | Why it matters |
| --- | --- |
| Signed-in teacher app + RLS per account | Safe multi-tenant without a backend of your own |
| Sections, class lists, bulk paste/CSV add, printed QR cards | Fast onboarding at enrollment time |
| Manual attendance (Present / Absent / Late / Excused) + "All Present" | The daily habit |
| QR / Student ID self check-in, no student login, one-phone-one-check-in, late grace window | The flashy feature — and the reason students care |
| Student record page (`student-record.html`, no login, `noindex`) | A public read-only surface already exists |
| Per-section grading categories with subsections + independent Max scores | Better than most paid PH tools already |
| Daily PDF, score CSV, offline queue, PWA install, no build step | Cheap to host, works on a ₱6k Android phone |

The gap is not features-by-count. It's that the app stops at *recorded data*, while a teacher's actual pain starts right after: **converting those numbers into the forms DepEd requires, and telling the parent.**

---

## 2. The single biggest opportunity: DO 015, s. 2026

This is why the timing is unusually good.

DepEd Order No. 015, s. 2026 (signed 4 June 2026, effective **SY 2026–2027**, repealing DO 8, s. 2015 and DO 36, s. 2016) changed the whole grading model — and SY 2026–2027, which is **right now**, is the transition year:

- **Three terms, not four quarters.** Under DO 9, s. 2026 the school year is 8 June 2026 – 8 April 2027, 201 class days: Term 1 (Jun 8 – Sep 15), **Term 2 (Sep 16 – Dec 18 — current)**, Term 3 (Jan 4 – Apr 8 2027).
- **New component names and weights** (Grades 4–10): Written/Oral Works (WWs), Product/Performance Tasks (PTs), Examinations (EXs).
  - English, Filipino, Math, Science, AP, GMRC/Values Ed → **20% WW · 50% PT · 30% EX**
  - EPP/TLE, MAPEH → **20% WW · 60% PT · 20% EX**
  - SHS core → 20/50/30; SHS Field Exposure/Arts Apprenticeship → 15/70/15; SHS Arts/Sports/Health electives → 20/60/20
- **Exams have an internal split:** Summative Test 1 = 30%, Summative Test 2 = 30%, Term Examination = 40%.
- **Adjusted transmutation table for SY 2026–2027 only.** Raw **Initial Grade (IG) of 70.00 → passing Term Grade of 75**. Bands are ~1.18 points wide above 70 (70.00–71.17 → 75, 71.18–72.35 → 76 … 99.50–100 → 100), and ~4.67 points wide below 70 (60 is the lowest reportable grade). From **SY 2027–2028** transmutation is removed entirely for Grades 4–12 (zero-based, 75 passing).
- **New descriptors:** Advancing (90–100), Benchmarking (80–89), Connecting (75–79), Developing (65–74), Emerging (0–64).
- **Final Grade = average of the Term Grades**, rounded to a whole number.

### What this means for Scholog today

Your grading engine is still built for the **repealed** order:

- `score-period` offers *Quarter 1–4 / Semester 1–2 / Unassigned* — there is no Term 1–3.
- Categories are free-form with any weights (`category_weight ?? 100`) — nothing enforces WW/PT/EX, and the 30/30/40 exam split can't be expressed.
- The sheet shows a **running percentage**, which under DO 015 is only the **Initial Grade**. Teachers still have to transmute it by hand, band by band, for every learner — the exact error-prone step that eats a weekend.

> **Proposal #1 — "Term Grade engine + SF9 report card."**
> Add a school-year mode (`SY 2026–27 · transmuted` / `SY 2027–28 · zero-based`), switch periods to Terms, tag categories as WW/PT/EX with auto-seeded, editable weights per learning area, add the ST1/ST2/Term-Exam 30/30/40 split, then show **IG → Term Grade → descriptor** per student, plus a printable per-learner SF9-style report card (grades + attendance summary + conduct line) and a section class-record PDF.
>
> **Why it stands out:** it's the only free, offline-capable tool that produces a *correct* SY 2026–2027 report-card grade. Every PH teacher is doing this conversion right now by hand, in Excel, with the wrong table. This is also a moat: an attendance app can be cloned, a grading engine that is right about Annex D cannot be cloned casually.
>
> **Effort:** ~1–2 focused sessions. Pure, testable `transmute(ig, mode)` + `descriptor(tg)` functions in `main.js` (mirroring how `pdf.js` is already unit-tested), one Supabase migration (`grading_categories.component`, `sections.learning_area`, `sections.school_year`, terms in `scores.grading_period`), UI in the scores view, one PDF builder.
> **Risk:** the exact band boundaries must be verified against the order's **Annex D**, not against blogs. Ship the table as data in one place so it's a one-line fix, and label the output "computed per DO 015, s. 2026 — verify against your school's official ECR."

---

## 3. The close second: close the loop with the guardian

Teachers currently discover an absence on the dashboard and then… text the parent manually, or don't. There is no guardian field in the app at all (`students` has name / ID / email only).

> **Status: on hold (Oct 2026).** Parked by request — the SMS encoding/cost/rule
> helpers were prototyped and tested, then removed from the tree; they stay
> recoverable from git history (commit `391088d`) if this is picked up later.

> **Proposal #2 — Guardian loop.**
> `guardian_name` + `guardian_contact` on students; one-tap **Notify guardian** from the watchlist and attendance sheet that opens a pre-filled message ("Hi Ma'am/Sir, this is to inform you that *Juan* was absent on *Oct 23* (4th absence this term). — Ms. Cruz"), via `sms:` link, Web Share, or copy; a `notifications` log so you know who was already told; a printable absence notice slip; and a **parent portal** built on the existing `student-record.html` — an unguessable, expiring, `noindex` link showing attendance + term grades.
> **Why it stands out:** it's the "so what" of attendance data, and almost nobody in the local market does it because it needs both sides — the record *and* the grade. Also directly reduces dropouts, which is what DepEd actually measures.
> **Effort:** Medium. No SMS gateway needed for v1 (no per-message cost, no DPA headaches).

---

## 4. The one that protects your flagship feature: anti-screenshot QR

Right now a check-in session is a **static** `scan.html?t=<uuid>` link that lives until `expires_at`. One phone = one check-in is enforced per *device*, so a student who receives the link in a group chat can check in from home on a second phone — and a classmate can screenshot the projector QR and forward it.

> **Proposal #3 — Rotating live QR.** Project a QR whose payload carries a short-lived code (HMAC of the session secret + a 30-second time step, e.g. `?t=<token>&c=4821`) refreshed on the projector. `checkin_mark` rejects a stale/absent code. A screenshot is worthless ~30s later; sharing the link no longer works at all.
> **Why it stands out:** it turns "QR attendance" from a convenience into actual evidence — the thing a teacher needs when a parent disputes an absence.
> **Effort:** Medium–high. One migration + RPC change, a timer/client loop, new tests. This is a security change to a core path, so it needs the full `npm test` sweep plus the anon-only RPC audit.

---

## 5. Supporting ideas (ranked, cheaper)

| # | Idea | Why | Effort |
| --- | --- | --- | --- |
| 4 | **School calendar & "no class" days** — Term 1–3 ranges, holidays, suspensions, half-days; one tap to mark a no-class day. Attendance % uses *school days*, matching SF2's `Average Daily Attendance ÷ Number of School Days`. | Right now every recorded row inflates the denominator, so rates and the watchlist are quietly wrong in a country with frequent suspensions. Prerequisite for any SF2/percentage output. | M |
| 5 | **Report-remarks builder** — deterministic, offline, no API key: pick a template ("*{name} maintained a {tg} in {subject}; {trend} in attendance this term*") from each learner's real numbers. | Teachers write 40+ narrative comments per term. Offline + free + no student data leaving the device is a genuinely better pitch than "AI". | S–M |
| 6 | **Bulk XLSX / SF1 import** — paste is fine, but advisers have an SF1 spreadsheet already. | Kills the #1 onboarding friction; feature teachers *show each other*. | S |
| 7 | **Keyboard-first attendance** — `P` `A` `L` `E` per row, arrow to move, undo last change. | 40 students × 5 sections: this is the difference between 4 minutes and 40 seconds a day. | S |
| 8 | **Shared sections (adviser + subject teachers)** — real roles in RLS. | Needed for whole-school adoption, but it's an RLS redesign; do it once you have paying/committed users. | L |

---

## 6. Scorecard

| Feature | Teacher value | Differentiation | Effort | Timing (Oct 2026) |
| --- | --- | --- | --- | --- |
| **1. Term Grade engine + SF9-style card** | ★★★★★ | ★★★★★ | M | ★★★★★ Term 1 grades are being computed *now* |
| **2. Guardian loop + parent portal** | ★★★★☆ | ★★★★☆ | M | ★★★★☆ |
| **3. Rotating anti-screenshot QR** | ★★★☆☆ | ★★★★☆ | M–L | ★★★☆☆ |
| 4. School calendar / no-class days | ★★★★☆ | ★★★☆☆ | M | ★★★★☆ (needed for #1's attendance %) |
| 5. Report-remarks builder | ★★★☆☆ | ★★★☆☆ | S–M | ★★★☆☆ |
| 6. XLSX / SF1 import | ★★★☆☆ | ★★☆☆☆ | S | ★★★☆☆ |
| 7. Keyboard-first attendance | ★★★☆☆ | ★★☆☆☆ | S | ★★★★☆ |
| 8. Shared sections / roles | ★★★★☆ | ★★★☆☆ | L | ★★☆☆☆ |

---

## 7. Recommended sequence

1. **Now** — Fix the grading backbone (`Terms`, `learning_area`, WW/PT/EX, `transmute()`, descriptors, zero-based toggle). Ship the **SF9-style per-learner card** + section class record. That is the headline: *"Free, offline, and actually correct for DO 015, s. 2026."*
2. **Next** — School calendar / no-class days, so both attendance % and the report card's attendance summary are trustworthy. Add the small **compliance strip** in the dashboard header (`SY 2026–2027 · Term 2 · DO 015, s. 2026`) — cheap, loud proof you're current.
3. **Then** — Guardian loop: contacts, one-tap notify, notification log, parent portal off `student-record.html`.
4. **Later** — Rotating QR, XLSX import, remarks builder, shared sections.

## 8. What *not* to build (deliberately)

- **A generic "Monthly SF2 .xlsx" export** — it was already removed once, and a wrong-looking government form is worse than none. If you do SF2, do it from a real school-day calendar (idea 4) and label it a helper, not an official form.
- **Dark mode** — already removed; it's a maintenance tax, not a differentiator.
- **A chatbot / "AI assistant" bolted on** — high cost, no local trust gain, and it means uploading minors' data. Template-driven remarks get 90% of the value offline.
- **Leaderboards / student gamification** — publishing rankings of minors is a privacy and bullying liability.

---

### Sources for the policy details above

Grading rules and the three-term calendar come from DepEd Order No. 015, s. 2026 and DO 9, s. 2026 as reported by PIA and DepEd-aligned teaching resources (Sept–Oct 2026). **Verify every band of the transmutation table against Annex D of the official order before shipping it to teachers** — the numbers are stored in one place for exactly that reason.
