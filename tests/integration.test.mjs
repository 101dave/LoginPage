// Live end-to-end test against the Scholog Supabase project.
// Runs only when SCHOLOG_INTEGRATION=1 so the default `npm test` stays offline.
//
//   SCHOLOG_INTEGRATION=1 node --test tests/integration.test.mjs
//
// It creates a throwaway teacher account + section/students, exercises the real
// RLS-protected tables and the public check-in RPCs, then deletes the data it
// created. The auth user it creates is listed at the end for cleanup.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const enabled = process.env.SCHOLOG_INTEGRATION === "1";

function readEnv() {
    const raw = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    const env = {};
    raw.split(/\r?\n/).forEach((line) => {
        const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (match) env[match[1]] = match[2].trim();
    });
    return env;
}

const env = readEnv();
const URL_BASE = env.VITE_SUPABASE_URL;
const ANON = env.VITE_SUPABASE_ANON_KEY;

const stamp = Date.now();
const EMAIL = `qa.scholog.${stamp}@example.com`;
const PASSWORD = `qa-${stamp}-pass`;
const SECTION = `QA Section ${stamp}`;
const OTHER_SECTION = `QA Other ${stamp}`;
const STUDENTS = [
    { student_id: `QA-${stamp}-1`, name: "QA Juan", section: SECTION },
    { student_id: `QA-${stamp}-2`, name: "QA Ana", section: SECTION }
];
const OUTSIDER = { student_id: `QA-${stamp}-9`, name: "QA Outsider", section: OTHER_SECTION };
const DATE = new Date().toISOString().slice(0, 10);

let authToken = "";
let userId = "";
const createdStudentCodes = [...STUDENTS, OUTSIDER].map((s) => s.student_id);
const sessionTokens = [];

async function api(pathName, { method = "GET", body, token = authToken, key = ANON, prefer } = {}) {
    const headers = { apikey: ANON, "Content-Type": "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    else if (token) headers.Authorization = `Bearer ${token}`;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${URL_BASE}${pathName}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (err) { data = text; }
    return { status: res.status, ok: res.ok, data };
}

const anon = (pathName, options = {}) => api(pathName, { ...options, key: ANON, token: "" });
const asUser = (pathName, options = {}) => api(pathName, options);

test("live Scholog backend: auth, sync, RLS and QR/Student-ID check-in", { skip: !enabled }, async (t) => {
    t.after(async () => {
        // Best-effort cleanup of everything this test created.
        if (authToken) {
            await asUser(`/rest/v1/attendance?student_id=in.(${createdStudentCodes.map((c) => `"${c}"`).join(",")})`, { method: "DELETE" });
            await asUser(`/rest/v1/students?student_id=in.(${createdStudentCodes.map((c) => `"${c}"`).join(",")})`, { method: "DELETE" });
            await asUser(`/rest/v1/sections?name=eq.${encodeURIComponent(SECTION)}`, { method: "DELETE" });
            await asUser(`/rest/v1/sections?name=eq.${encodeURIComponent(OTHER_SECTION)}`, { method: "DELETE" });
            for (const token of sessionTokens) {
                await asUser(`/rest/v1/checkin_sessions?token=eq.${token}`, { method: "DELETE" });
            }
        }
        console.log(`[integration] cleanup marker — test auth user: ${userId || "(none)"}`);
    });

    // ---------------------------------------------------------------- auth
    const signup = await anon("/auth/v1/signup", {
        method: "POST",
        body: { email: EMAIL, password: PASSWORD }
    });
    assert.equal(signup.status, 200, `signup: ${JSON.stringify(signup.data)}`);
    authToken = (signup.data.access_token) || "";
    userId = signup.data.user && signup.data.user.id;

    if (!authToken) {
        const login = await anon("/auth/v1/token?grant_type=password", {
            method: "POST",
            body: { email: EMAIL, password: PASSWORD }
        });
        assert.equal(login.status, 200, `login: ${JSON.stringify(login.data)}`);
        authToken = login.data.access_token;
        userId = login.data.user.id;
    }
    assert.ok(authToken && userId, "signed in with a real access token");

    const me = await asUser("/auth/v1/user");
    assert.equal(me.status, 200);
    assert.equal(me.data.id, userId);

    // ------------------------------------------------- section + students
    let res = await asUser("/rest/v1/sections", { method: "POST", body: [{ name: SECTION }, { name: OTHER_SECTION }], prefer: "return=representation" });
    assert.ok(res.ok, `sections insert: ${JSON.stringify(res.data)}`);

    res = await asUser("/rest/v1/students", {
        method: "POST",
        body: [...STUDENTS, OUTSIDER].map((s) => ({ ...s })),
        prefer: "return=representation"
    });
    assert.ok(res.ok, `students insert: ${JSON.stringify(res.data)}`);
    assert.equal(res.data.length, 3);

    // ------------------------------------------------ attendance save path
    // The old app upserted with onConflict=user_id,date,student_id. The real
    // unique key includes `subject`, so that call fails — the exact bug fixed
    // in main.js.
    const legacy = await asUser("/rest/v1/attendance?on_conflict=user_id,date,student_id", {
        method: "POST",
        body: { date: DATE, student_id: STUDENTS[0].student_id, status: "Present", subject: "General" },
        prefer: "resolution=merge-duplicates,return=representation"
    });
    assert.equal(legacy.ok, false, "legacy conflict target is rejected by the database");
    assert.match(JSON.stringify(legacy.data), /42P10|no unique or exclusion constraint/i);

    const saveRows = STUDENTS.map((s) => ({
        date: DATE, student_id: s.student_id, status: "Present", subject: "General"
    }));
    const save = await asUser("/rest/v1/attendance?on_conflict=user_id,date,student_id,subject", {
        method: "POST",
        body: saveRows,
        prefer: "resolution=merge-duplicates,return=representation"
    });
    assert.ok(save.ok, `attendance upsert: ${JSON.stringify(save.data)}`);
    assert.equal(save.data.length, 2);

    // Status updates overwrite the same row (no duplicates) — like the UI does.
    const late = await asUser("/rest/v1/attendance?on_conflict=user_id,date,student_id,subject", {
        method: "POST",
        body: { date: DATE, student_id: STUDENTS[1].student_id, status: "Late", subject: "General" },
        prefer: "resolution=merge-duplicates,return=representation"
    });
    assert.ok(late.ok);
    const afterLate = await asUser(`/rest/v1/attendance?select=status&date=eq.${DATE}&student_id=eq.${STUDENTS[1].student_id}`);
    assert.equal(afterLate.data.length, 1, "update, not duplicate row");
    assert.equal(afterLate.data[0].status, "Late");

    // ------------------------------------------------------- check-in RPC
    const created = await asUser("/rest/v1/checkin_sessions", {
        method: "POST",
        body: { section: SECTION, attendance_date: DATE, expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), closed: false },
        prefer: "return=representation"
    });
    assert.ok(created.ok, `session insert: ${JSON.stringify(created.data)}`);
    const session = created.data[0];
    sessionTokens.push(session.token);

    // Anon students must NOT be able to read the roster directly…
    const anonStudents = await anon(`/rest/v1/students?select=*&section=eq.${encodeURIComponent(SECTION)}`);
    assert.ok(anonStudents.ok);
    assert.deepEqual(anonStudents.data, [], "RLS hides the class list from anon");

    // …but they can read the public session summary.
    let info = await anon("/rest/v1/rpc/checkin_session_info", { method: "POST", body: { p_token: session.token } });
    assert.equal(info.status, 200, JSON.stringify(info.data));
    assert.equal(info.data.ok, true);
    assert.equal(info.data.section, SECTION);
    assert.equal(info.data.student_count, 2);
    assert.equal(info.data.checked_in, 2);

    // Typed / scanned student ID from an external device (no auth token).
    let mark = await anon("/rest/v1/rpc/checkin_mark", { method: "POST", body: { p_token: session.token, p_student_id: STUDENTS[0].student_id } });
    assert.equal(mark.status, 200, JSON.stringify(mark.data));
    assert.equal(mark.data.ok, true);
    assert.equal(mark.data.student_name, "QA Juan");
    assert.equal(mark.data.status, "Present");

    // Lower-case input is matched case-insensitively.
    let lower = await anon("/rest/v1/rpc/checkin_mark", { method: "POST", body: { p_token: session.token, p_student_id: STUDENTS[1].student_id.toLowerCase() } });
    assert.equal(lower.data.ok, true, JSON.stringify(lower.data));
    assert.equal(lower.data.already_marked, true);
    assert.equal(lower.data.previous_status, "Late");
    assert.equal(lower.data.status, "Present", "check-in sets Present");

    // IDs from another section / unknown IDs are rejected.
    let outsider = await anon("/rest/v1/rpc/checkin_mark", { method: "POST", body: { p_token: session.token, p_student_id: OUTSIDER.student_id } });
    assert.equal(outsider.data.ok, false);
    assert.equal(outsider.data.error, "not_in_class");

    let unknown = await anon("/rest/v1/rpc/checkin_mark", { method: "POST", body: { p_token: session.token, p_student_id: "NOT-A-STUDENT" } });
    assert.equal(unknown.data.error, "not_in_class");

    let missing = await anon("/rest/v1/rpc/checkin_mark", { method: "POST", body: { p_token: session.token, p_student_id: "   " } });
    assert.equal(missing.data.error, "missing_id");

    let badToken = await anon("/rest/v1/rpc/checkin_mark", { method: "POST", body: { p_token: "00000000-0000-4000-8000-000000000000", p_student_id: STUDENTS[0].student_id } });
    assert.equal(badToken.data.error, "invalid_session");

    // Attendance actually landed in the database for the session date.
    const rows = await asUser(`/rest/v1/attendance?select=student_id,status,subject&date=eq.${DATE}&student_id=eq.${STUDENTS[1].student_id}`);
    assert.equal(rows.data.length, 1);
    assert.equal(rows.data[0].status, "Present");
    assert.equal(rows.data[0].subject, "General");

    // Closing the session stops new check-ins…
    const closed = await asUser(`/rest/v1/checkin_sessions?token=eq.${session.token}`, {
        method: "PATCH",
        body: { closed: true },
        prefer: "return=representation"
    });
    assert.ok(closed.ok, JSON.stringify(closed.data));
    mark = await anon("/rest/v1/rpc/checkin_mark", { method: "POST", body: { p_token: session.token, p_student_id: STUDENTS[0].student_id } });
    assert.equal(mark.data.ok, false);
    assert.equal(mark.data.error, "session_closed");

    info = await anon("/rest/v1/rpc/checkin_session_info", { method: "POST", body: { p_token: session.token } });
    assert.equal(info.data.closed, true);

    // …and expired sessions are refused too.
    const expired = await asUser("/rest/v1/checkin_sessions", {
        method: "POST",
        body: { section: SECTION, attendance_date: DATE, expires_at: new Date(Date.now() - 60 * 1000).toISOString(), closed: false },
        prefer: "return=representation"
    });
    assert.ok(expired.ok, JSON.stringify(expired.data));
    sessionTokens.push(expired.data[0].token);
    mark = await anon("/rest/v1/rpc/checkin_mark", { method: "POST", body: { p_token: expired.data[0].token, p_student_id: STUDENTS[0].student_id } });
    assert.equal(mark.data.ok, false);
    assert.equal(mark.data.error, "session_expired");
});
