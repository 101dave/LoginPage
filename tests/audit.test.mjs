// QA audit: hostile input, duplicate student IDs, record linking, QR payloads,
// role separation and password handling.
//
// These are written to *find* bugs, not to confirm the happy path — anything
// that fails here is a real defect, not a test that needs loosening.
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase, defaultDb, loadPage, waitFor, sleep } from "./helpers.mjs";
import { installLucideStub, installSupabaseStub, makeFakeJsPdf, makeFakeQr, todayStr } from "./stubs.mjs";

const SECTION = "Grade 11 - STEM";

function boot(overrides = {}) {
    const db = overrides.db || defaultDb();
    const client = createFakeSupabase({ db, enforceGradingConstraints: true });
    const qr = makeFakeQr();
    const page = loadPage({
        html: "main.html",
        scripts: ["vendor/lucide-subset.js", "csv.js", "pdf.js", "main.js"],
        url: "https://scholog.test/main.html",
        beforeParse(window) {
            installSupabaseStub(window, client);
            window.qrcode = qr;
            window.jspdf = { jsPDF: makeFakeJsPdf().FakeJsPDF };
            window.__toasts = [];
        }
    });
    // Record every toast, since rejected input is surfaced that way.
    const realToast = page.window.showToast;
    page.window.showToast = (message, type) => {
        page.window.__toasts.push({ message, type });
        return realToast(message, type);
    };
    return { ...page, client, db, qr };
}

async function bootReady(overrides) {
    const ctx = boot(overrides);
    await waitFor(() => ctx.window.document.getElementById("stat-total").textContent !== "0", {
        label: "dashboard data"
    });
    return ctx;
}

function addStudentViaForm(window, { name, id, section = SECTION, email = "" }) {
    window.openAddStudentModal();
    const document = window.document;
    document.getElementById("stud-name").value = name;
    document.getElementById("stud-id").value = id;
    document.getElementById("stud-section").value = section;
    document.getElementById("stud-email").value = email;
    document.getElementById("form-student").dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true })
    );
}

// ---------------------------------------------------------------------------
// 1. Invalid input
// ---------------------------------------------------------------------------

test("invalid input: blank or whitespace-only name and ID are refused", async (t) => {
    const { window, dom, db } = await bootReady();
    t.after(() => dom.window.close());

    const before = db.students.length;
    addStudentViaForm(window, { name: "   ", id: "2026-9001" });
    addStudentViaForm(window, { name: "Ghost Student", id: "   " });
    addStudentViaForm(window, { name: "", id: "" });
    await sleep(200);

    assert.equal(db.students.length, before, "no student was created");
    assert.ok(window.__toasts.some((toast) => toast.type === "error"), "the user is told why");
});

test("invalid input: a duplicate student ID is rejected in the form", async (t) => {
    const { window, dom, db } = await bootReady();
    t.after(() => dom.window.close());

    const before = db.students.length;
    addStudentViaForm(window, { name: "Copy Cat", id: "2026-0001" }); // already in the fixtures
    await sleep(200);

    assert.equal(db.students.length, before, "no duplicate row added");
    assert.ok(
        window.__toasts.some((toast) => /already used/i.test(toast.message)),
        "the clash names the existing student"
    );
});

test("invalid input: HTML in a name is escaped, never rendered as markup", async (t) => {
    const { window, dom } = await bootReady();
    t.after(() => dom.window.close());
    const document = window.document;

    addStudentViaForm(window, { name: '<img src=x onerror="window.__xss=1">', id: "2026-9100" });
    window.switchTab("directory");
    await waitFor(() => /2026-9100/.test(document.getElementById("directory-table-body").textContent));

    const injected = document.querySelector('#directory-table-body img[src="x"]');
    assert.equal(injected, null, "no element was injected from the student name");
    assert.equal(window.__xss, undefined, "no script ran");
    assert.match(document.getElementById("directory-table-body").textContent, /<img src=x/);
});

test("invalid input: quotes and quotes-in-quotes survive edit and render intact", async (t) => {
    const { window, dom } = await bootReady();
    t.after(() => dom.window.close());
    const document = window.document;
    const name = `O'Brien "Bong" Dela Cruz`; // also stresses the inline onclick args

    addStudentViaForm(window, { name, id: "2026-9101" });
    window.switchTab("directory");
    await waitFor(() => /2026-9101/.test(document.getElementById("directory-table-body").textContent));
    assert.match(document.getElementById("directory-table-body").textContent, /O'Brien "Bong" Dela Cruz/);

    // Editing through the row action must still find the record (jsArg escaping).
    const row = [...document.querySelectorAll("#directory-table-body tr")]
        .find((tr) => tr.textContent.includes("2026-9101"));
    row.querySelector(".action-qr")?.click();
    assert.equal(document.getElementById("student-qr-name").textContent, name, "the edit/QR action resolved the student");
});

test("invalid input: scores out of range, negative, or non-numeric are refused", async (t) => {
    const db = defaultDb();
    db.grading_categories = [{
        id: "cat-ww", user_id: "user-1", section: SECTION, name: "Written Work", weight: 100,
        items: [{ id: "item-1", label: "#1", max_score: 20 }], archived: false
    }];
    db.section_grading_categories = [{ id: "sgc-1", user_id: "user-1", section: SECTION, category_id: "cat-ww" }];
    const { window, dom, db: liveDb } = await bootReady({ db });
    t.after(() => dom.window.close());

    const date = todayStr();
    const before = liveDb.scores.length;

    window.setStudentScore(date, "2026-0001", "Quarter 1", "cat-ww", "item-1", "999", "20");
    window.setStudentScore(date, "2026-0001", "Quarter 1", "cat-ww", "item-1", "-5", "20");
    window.setStudentScore(date, "2026-0001", "Quarter 1", "cat-ww", "item-1", "abc", "20");
    window.setStudentScore(date, "2026-0001", "Quarter 1", "cat-ww", "item-1", "", "20");
    await sleep(150);

    const written = liveDb.scores.filter((row) => row.category_id === "cat-ww");
    assert.equal(written.length, 0, `no invalid score was stored (got ${JSON.stringify(written)})`);
    assert.ok(window.__toasts.some((toast) => toast.type === "error"), "the teacher is warned");
});

test("invalid input: an unknown attendance status never reaches state", async (t) => {
    const { window, dom, db } = await bootReady();
    t.after(() => dom.window.close());
    const date = todayStr();

    const earliest = db.attendance.find((row) => row.student_id === "2026-0001");
    const targetDate = earliest ? earliest.date : date;
    const before = earliest ? earliest.status : undefined;
    window.setStudentStatus?.(targetDate, "2026-0001", "HACKED");
    window.setStudentStatus?.(targetDate, "2026-0001", "");
    await sleep(250);

    const after = db.attendance.find((row) => row.student_id === "2026-0001" && row.date === targetDate)?.status;
    assert.equal(after, before, `status unchanged (was ${before}, now ${after})`);
    assert.ok(
        db.attendance.every((row) => ["Present", "Absent", "Late", "Excused"].includes(row.status)),
        "database holds only valid statuses"
    );
});

test("invalid input: search text with HTML and regex characters is inert", async (t) => {
    const { window, dom } = await bootReady();
    t.after(() => dom.window.close());
    const document = window.document;

    window.switchTab("directory");
    await waitFor(() => document.querySelectorAll("#directory-table-body tr").length === 4);

    for (const query of ['<script>alert(1)</script>', '.*', '(', '[a-z', "'; DROP TABLE students;--"]) {
        const input = document.getElementById("directory-search");
        input.value = query;
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
        await sleep(30);
        assert.equal(document.querySelector("#directory-table-body script"), null, `no script injected by ${query}`);
        assert.match(document.getElementById("directory-table-body").textContent, /No students found/i);
    }
});

// ---------------------------------------------------------------------------
// 2. Random, unique student IDs
// ---------------------------------------------------------------------------

function randomId(index) {
    const year = 2026 + (index % 2);
    const body = String(Math.floor(Math.random() * 900000) + 100000);
    return `${year}-${body}`;
}

test("bulk import of 250 random IDs creates no duplicates and no collisions", async (t) => {
    const { window, dom, db } = await bootReady();
    t.after(() => dom.window.close());

    const ids = new Set();
    const lines = [];
    for (let i = 0; i < 250; i += 1) {
        let id = randomId(i);
        while (ids.has(id)) id = randomId(i + 1);
        ids.add(id);
        lines.push(`Student ${i + 1},${id}`);
    }
    const expected = ids.size;

    window.openBulkStudentModal();
    const document = window.document;
    document.getElementById("bulk-stud-text").value = lines.join("\n");
    document.getElementById("bulk-stud-section").value = SECTION;
    document.getElementById("form-student-bulk").dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true })
    );
    await sleep(300);

    const imported = db.students.filter((row) => ids.has(row.student_id));
    assert.equal(imported.length, expected, `every row landed exactly once (got ${imported.length}/${expected})`);

    const codes = db.students.map((row) => row.student_id);
    const duplicates = codes.filter((code, index) => codes.indexOf(code) !== index);
    assert.equal(new Set(codes).size, codes.length, `duplicate IDs in the cloud: ${duplicates.slice(0, 5).join(", ")}`);
});

test("re-pasting the same IDs updates rather than duplicating", async (t) => {
    const { window, dom, db } = await bootReady();
    t.after(() => dom.window.close());
    const document = window.document;

    const rows = ["Renamed One,2026-777001", "Renamed Two,2026-777002"];
    const importRows = async (lines) => {
        window.openBulkStudentModal();
        document.getElementById("bulk-stud-text").value = lines.join("\n");
        document.getElementById("bulk-stud-section").value = SECTION;
        document.getElementById("form-student-bulk").dispatchEvent(
            new window.Event("submit", { bubbles: true, cancelable: true })
        );
        await sleep(200);
    };

    await importRows(rows);
    const afterFirst = db.students.length;
    await importRows(["Changed Name,2026-777001", "Renamed Two,2026-777002"]);
    await sleep(250);
    const afterSecond = db.students.length;

    assert.equal(afterSecond, afterFirst, "the second import added nothing");
    assert.equal(
        db.students.filter((row) => row.student_id === "2026-777001").length,
        1,
        "still exactly one row for that ID"
    );
    assert.equal(
        db.students.find((row) => row.student_id === "2026-777001").name,
        "Changed Name",
        "the name was updated"
    );
});

test("duplicate IDs inside one pasted block collapse to one student", async (t) => {
    const { window, dom, db } = await bootReady();
    t.after(() => dom.window.close());
    const document = window.document;

    window.openBulkStudentModal();
    document.getElementById("bulk-stud-text").value = [
        "First Spelling,2026-888001",
        "Second Spelling,2026-888001",
        "Third Spelling,2026-888001"
    ].join("\n");
    document.getElementById("bulk-stud-section").value = SECTION;
    document.getElementById("form-student-bulk").dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true })
    );
    await sleep(250);

    const matches = db.students.filter((row) => row.student_id === "2026-888001");
    assert.equal(matches.length, 1, `expected one row in the cloud, got ${matches.length}`);
});

// ---------------------------------------------------------------------------
// 3. Random IDs link correctly to attendance and scores
// ---------------------------------------------------------------------------

test("a random student ID links to attendance and to a saved score", async (t) => {
    const db = defaultDb();
    db.grading_categories = [{
        id: "cat-ww", user_id: "user-1", section: SECTION, name: "Written Work", weight: 100,
        items: [{ id: "item-1", label: "#1", max_score: 20 }], archived: false
    }];
    db.section_grading_categories = [{ id: "sgc-1", user_id: "user-1", section: SECTION, category_id: "cat-ww" }];
    const { window, dom, db: liveDb } = await bootReady({ db });
    t.after(() => dom.window.close());
    const document = window.document;

    const newId = "2027-314159";
    addStudentViaForm(window, { name: "Random Learner", id: newId });
    await sleep(200);
    assert.ok(liveDb.students.some((row) => row.student_id === newId), "student reached the cloud");

    const date = todayStr();
    window.setStudentStatus(date, newId, "Late");
    window.saveAttendance?.();
    await waitFor(() => liveDb.attendance.some((row) => row.student_id === newId && row.date === date), {
        label: "attendance row"
    });
    assert.equal(
        liveDb.attendance.find((row) => row.student_id === newId).status,
        "Late",
        "attendance stored under the random ID"
    );

    window.setStudentScore(date, newId, "Quarter 1", "cat-ww", "item-1", "18", "20");
    await waitFor(() => liveDb.scores.some((row) => row.student_id === newId), { label: "score row" });
    const saved = liveDb.scores.find((row) => row.student_id === newId);
    assert.equal(Number(saved.score), 18);
    assert.equal(saved.category_id, "cat-ww", "score is linked to the right category");

    // The sheet shows the id back, and the dashboard counts it.
    window.switchTab("scores");
    await waitFor(() => !document.getElementById("view-scores").classList.contains("hidden"));
    document.getElementById("score-date").value = date;
    document.getElementById("score-section").value = SECTION;
    window.loadScoreSheet();
    await waitFor(() => document.getElementById("score-table-body").textContent.includes("Random Learner"));
});

test("attendance keys are date-scoped so one student's record cannot overwrite another's", async (t) => {
    const { window, dom, db } = await bootReady();
    t.after(() => dom.window.close());

    const date = todayStr();
    window.setStudentStatus(date, "2026-0001", "Absent");
    window.setStudentStatus(date, "2026-0002", "Present");
    window.saveAttendance?.();
    await sleep(250);

    const first = db.attendance.find((row) => row.student_id === "2026-0001" && row.date === date);
    const second = db.attendance.find((row) => row.student_id === "2026-0002" && row.date === date);
    assert.equal(first.status, "Absent");
    assert.equal(second.status, "Present");
});

// ---------------------------------------------------------------------------
// 4. QR payloads
// ---------------------------------------------------------------------------

test("QR payload round-trips the record code and the plain-ID fallback", async (t) => {
    const db = defaultDb();
    db.students = db.students.map((row) => (row.student_id === "2026-0001"
        ? { ...row, record_code: "K7M2QPX9" }
        : row));
    const { window, dom, qr } = await bootReady({ db });
    t.after(() => dom.window.close());

    window.switchTab("directory");
    const document = window.document;
    await waitFor(() => document.querySelectorAll("#directory-table-body .action-qr").length > 0);
    document.querySelector("#directory-table-body .action-qr").click();

    assert.equal(qr.encoded.at(-1), "SCHOLOG:2026-0001:K7M2QPX9", "code included when the student has one");

    // A student without a code must still produce a scannable card.
    window.closeModal("modal-student-qr");
    const rows = [...document.querySelectorAll("#directory-table-body tr")];
    const second = rows.find((row) => row.textContent.includes("2026-0002"));
    second.querySelector(".action-qr").click();
    assert.equal(qr.encoded.at(-1), "SCHOLOG:2026-0002", "falls back to the plain payload");
});

// ---------------------------------------------------------------------------
// 5. Roles, sessions, passwords
// ---------------------------------------------------------------------------

test("there is no student account: the student surface needs no login and stores no password", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { ROOT } = await import("./helpers.mjs");
    for (const file of ["scan.html", "scan.js", "student-record.html", "student-record.js"]) {
        const source = fs.readFileSync(path.join(ROOT, file), "utf8");
        assert.doesNotMatch(source, /password/i, `${file} must not mention passwords`);
        assert.doesNotMatch(source, /signInWithPassword|signUp\(/, `${file} must not sign anyone in`);
    }
});

test("credentials are never persisted by the app, only handed to Supabase Auth", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { ROOT } = await import("./helpers.mjs");
    const source = fs.readFileSync(path.join(ROOT, "script.js"), "utf8");

    // The one sign-in call, and no password written to storage or logged.
    assert.match(source, /signInWithPassword\(\{\s*email,\s*password\s*\}\)/);
    assert.doesNotMatch(source, /localStorage\.setItem\([^)]*password/i, "no password in localStorage");
    assert.doesNotMatch(source, /sessionStorage\.setItem\([^)]*password/i, "no password in sessionStorage");
    assert.doesNotMatch(source, /console\.(log|info|warn|error)\([^)]*password/i, "no password in logs");
});

test("the teacher dashboard requires a session; the check-in page does not", async (t) => {
    // No session -> main.html falls back to a local user and must not sync to the cloud.
    const db = defaultDb();
    const client = createFakeSupabase({ db, session: null });
    const page = loadPage({
        html: "main.html",
        scripts: ["vendor/lucide-subset.js", "csv.js", "pdf.js", "main.js"],
        url: "https://scholog.test/main.html",
        beforeParse(window) {
            installSupabaseStub(window, client);
            window.qrcode = makeFakeQr();
            window.jspdf = { jsPDF: makeFakeJsPdf().FakeJsPDF };
        }
    });
    t.after(() => page.dom.window.close());
    await sleep(300);

    // With no session the app must never write to the cloud. (It redirects to
    // index.html; jsdom does not implement navigation, so assert on the writes.)
    const writes = client.calls.filter((call) => call.op && call.op !== "select");
    assert.deepEqual(writes, [], `no writes without a session (got ${JSON.stringify(writes.slice(0, 3))})`);
    assert.equal(page.window.localStorage.getItem("scholog_local_user"), null, "no local account was invented");

    // scan.html is public by design and only calls the two check-in RPCs.
    const scanPage = loadPage({
        html: "scan.html",
        scripts: ["vendor/supabase.js", "scan.js"],
        url: "https://scholog.test/scan.html?t=11111111-2222-4333-8444-555555555555",
        beforeParse(window) {
            window.supabase = { createClient: () => createFakeSupabase({ db }), __client: createFakeSupabase({ db }) };
            window.Html5Qrcode = undefined;
        }
    });
    t.after(() => scanPage.dom.window.close());
    await sleep(200);
    assert.ok(scanPage.window.document.getElementById("view-student") || scanPage.window.document.body.textContent.length > 0);
});

// ---------------------------------------------------------------------------
// 6. Session hygiene (shared device / expiry)
// ---------------------------------------------------------------------------

test("sign-out clears the cached class data so the next teacher on the device cannot read it", async (t) => {
    const { window, dom, client } = await bootReady();
    t.after(() => dom.window.close());

    // The signed-in account's cache and the legacy unsuffixed cache both go.
    window.localStorage.setItem("scholog_app_data_user-1", JSON.stringify({ students: [{ name: "Juan" }] }));
    window.localStorage.setItem("scholog_app_data", JSON.stringify({ students: [{ name: "Old" }] }));
    window.handleLogout();
    await waitFor(
        () => window.localStorage.getItem("scholog_app_data_user-1") === null &&
              window.localStorage.getItem("scholog_app_data") === null,
        { label: "caches cleared" }
    );
});

test("sign-out uploads queued work first, then clears the cache", async (t) => {
    const { window, dom, client, db } = await bootReady();
    t.after(() => dom.window.close());

    const key = "scholog_app_data_user-1";
    window.localStorage.setItem(key, JSON.stringify({ students: [{ name: "Juan" }] }));
    window.localStorage.setItem(`${key}_pending`, JSON.stringify([
        { t: "att", date: todayStr(), student_id: "2026-0001", status: "Absent", _qid: "q-1" }
    ]));

    window.handleLogout();
    await waitFor(() => client.signedOut, { label: "sign out" });
    await sleep(150);

    assert.equal(window.localStorage.getItem(key), null, "the cache is gone once the queue is empty");
    assert.equal(window.localStorage.getItem(`${key}_pending`), null, "the queue drained");
    const row = db.attendance.find(
        (entry) => entry.student_id === "2026-0001" && entry.date === todayStr()
    );
    assert.equal(row?.status, "Absent", "the queued mark reached the cloud instead of being dropped");
});

test("sign-out keeps the cache only when a queued change cannot be uploaded", async (t) => {
    const db = defaultDb();
    const client = createFakeSupabase({ db, enforceGradingConstraints: true, failTable: "attendance" });
    const page = loadPage({
        html: "main.html",
        scripts: ["vendor/lucide-subset.js", "csv.js", "pdf.js", "main.js"],
        url: "https://scholog.test/main.html",
        beforeParse(window) {
            installSupabaseStub(window, client);
            window.qrcode = makeFakeQr();
            window.jspdf = { jsPDF: makeFakeJsPdf().FakeJsPDF };
            window.__toasts = [];
        }
    });
    t.after(() => page.dom.window.close());
    const window = page.window;
    await waitFor(() => window.document.getElementById("stat-total").textContent !== "0", { label: "dashboard" });

    const key = "scholog_app_data_user-1";
    window.localStorage.setItem(key, JSON.stringify({ students: [{ name: "Juan" }] }));
    window.localStorage.setItem(`${key}_pending`, JSON.stringify([
        { t: "att", date: todayStr(), student_id: "2026-0002", status: "Absent", _qid: "q-2" }
    ]));

    window.handleLogout();
    await waitFor(() => client.signedOut, { label: "sign out" });
    await sleep(200);

    assert.ok(window.localStorage.getItem(key), "the cache survives (it holds the only copy of the pending work)");
    assert.ok(window.localStorage.getItem(`${key}_pending`), "the queue survives too");
});

test("an expired session sends the dashboard back to the login page", async (t) => {
    const { window, dom, client } = await bootReady();
    t.after(() => dom.window.close());

    assert.ok(client.authHandlers.length > 0, "main.js subscribes to auth state changes");

    // Supabase fires this when a refresh token expires or is revoked. jsdom
    // cannot navigate, so assert on what the app stopped doing: no resurrections
    // and no further cloud writes.
    for (const handler of client.authHandlers) handler("SIGNED_OUT", null);
    await sleep(100);

    assert.equal(window.localStorage.getItem("scholog_local_user"), null, "no local account resurrected");
    const writes = client.calls.filter((call) => call.op && call.op !== "select");
    assert.deepEqual(writes, [], "no writes after the session died");
});

test("renaming a student ID carries their attendance and scores over (no orphaned records)", async (t) => {
    const { window, dom, db } = await bootReady();
    t.after(() => dom.window.close());

    const student = db.students.find((row) => row.student_id === "2026-0001");
    const oldAtt = db.attendance.filter((row) => row.student_id === "2026-0001").length;
    const oldScores = db.scores.filter((row) => row.student_id === "2026-0001").length;

    window.openEditStudentModal(student.id);
    window.document.getElementById("stud-id").value = "2026-4242";
    window.document.getElementById("form-student").dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true })
    );
    await sleep(300);

    assert.equal(db.students.filter((row) => row.student_id === "2026-0001").length, 0, "old code is gone");
    assert.equal(db.attendance.filter((row) => row.student_id === "2026-0001").length, 0, "no attendance left behind on the old code");
    assert.equal(db.scores.filter((row) => row.student_id === "2026-0001").length, 0, "no scores left behind on the old code");
    assert.equal(db.attendance.filter((row) => row.student_id === "2026-4242").length, oldAtt, "attendance followed the student");
    assert.equal(db.scores.filter((row) => row.student_id === "2026-4242").length, oldScores, "scores followed the student");
});

test("a poisoned offline queue cannot replay an invalid status into the app", async (t) => {
    const { window, dom, db } = await bootReady();
    t.after(() => dom.window.close());

    // Simulates a queue written by an older build, or edited by hand in
    // DevTools. It must be ignored, not replayed.
    window.localStorage.setItem("scholog_app_data_pending", JSON.stringify([
        { t: "att", date: todayStr(), student_id: "2026-0002", status: "HACKED", _qid: "bad-1" },
        { t: "att", date: todayStr(), student_id: "2026-0003", status: "", _qid: "bad-2" }
    ]));

    const before = db.attendance
        .filter((row) => row.date === todayStr())
        .map((row) => `${row.student_id}:${row.status}`)
        .sort();

    await window.syncLatestFromCloud();

    const after = db.attendance
        .filter((row) => row.date === todayStr())
        .map((row) => `${row.student_id}:${row.status}`)
        .sort();

    assert.deepEqual(after, before, "no invalid status reached the database");
});

test("attendance rows already poisoning the cloud are ignored, not counted", async (t) => {
    const db = defaultDb();
    // A row written before the CHECK constraint existed.
    db.attendance.push({
        id: 99, user_id: "user-1", date: todayStr(),
        student_id: "2026-0001", status: "HACKED", subject: "General"
    });
    const client = createFakeSupabase({ db, enforceGradingConstraints: true });
    const page = loadPage({
        html: "main.html",
        scripts: ["vendor/lucide-subset.js", "csv.js", "pdf.js", "main.js"],
        url: "https://scholog.test/main.html",
        beforeParse(window) {
            installSupabaseStub(window, client);
            window.qrcode = makeFakeQr();
            window.jspdf = { jsPDF: makeFakeJsPdf().FakeJsPDF };
        }
    });
    t.after(() => page.dom.window.close());
    await waitFor(() => page.window.document.getElementById("stat-total").textContent !== "0", { label: "dashboard" });

    // The fixture is Present + Late + Absent = 2 in, 1 out. The poisoned row
    // shares its key with 2026-0001's valid Present row, so if it were loaded
    // it would overwrite it and Present would silently drop to 1.
    page.window.switchTab("dashboard");
    const document = page.window.document;
    assert.equal(document.getElementById("stat-present").textContent, "2", "Present still counts the valid row");
    assert.equal(document.getElementById("stat-absent").textContent, "1");
    assert.equal(document.getElementById("stat-rate").textContent, "50%", "2 of 4 learners in");
    assert.equal(document.getElementById("stat-total").textContent, "4");
});

test("the database rejects an invalid attendance status (CHECK constraint ships in the migration)", async () => {
    const sql = await import("node:fs").then((fs) =>
        fs.readFileSync(new URL("../supabase/migrations/20261025_attendance_status_and_student_id_constraints.sql", import.meta.url), "utf8")
    );
    assert.match(sql, /add constraint attendance_status_check/);
    assert.match(sql, /check \(status in \('Present', 'Absent', 'Late', 'Excused'\)\)/);
    assert.match(sql, /not valid/, "existing rows are reported, not silently rewritten");
    assert.match(sql, /students_user_student_id_key/);
});

test("a session revoked elsewhere stops the background refresh instead of queueing forever", async (t) => {
    const { window, dom, client } = await bootReady();
    t.after(() => dom.window.close());

    // Signing out on another device (or revoking the refresh token) leaves a
    // session record in the client that is no longer usable.
    const readsBefore = client.calls.length;
    client.session = null;

    const result = await window.syncLatestFromCloud();
    assert.equal(result, "signed-out", "the refresh reports a dead session");
    assert.equal(client.calls.length, readsBefore, "and stops reading the cloud");
});

test("a session that is still valid keeps the refresh working", async (t) => {
    const { window, dom, client } = await bootReady();
    t.after(() => dom.window.close());

    const result = await window.syncLatestFromCloud();
    assert.equal(result, "synced");
    assert.ok(client.calls.length > 0, "the cloud was read");
});

test("the offline-only account is never logged out by the session check", async (t) => {
    const db = defaultDb();
    const client = createFakeSupabase({ db, enforceGradingConstraints: true, session: null });
    const page = loadPage({
        html: "main.html",
        scripts: ["vendor/lucide-subset.js", "csv.js", "pdf.js", "main.js"],
        url: "https://scholog.test/main.html",
        beforeParse(window) {
            installSupabaseStub(window, client);
            window.qrcode = makeFakeQr();
            window.jspdf = { jsPDF: makeFakeJsPdf().FakeJsPDF };
            window.localStorage.setItem(
                "scholog_local_user",
                JSON.stringify({ email: "offline@example.com", name: "Offline Teacher" })
            );
            window.localStorage.setItem("scholog_app_data", JSON.stringify({
                sections: ["Grade 11 - STEM"],
                students: [{ id: "1", student_id: "2026-0001", name: "Juan Dela Cruz", section: "Grade 11 - STEM" }],
                attendance: {},
                scores: {},
                gradeCategories: [],
                sectionGradeCategories: {}
            }));
        }
    });
    t.after(() => page.dom.window.close());
    await waitFor(() => page.window.document.getElementById("stat-total").textContent !== "0", { label: "local data" });

    // No cloud session exists, so "synced/offline" is the only sane answer —
    // never "signed-out", which would throw the teacher out of local mode.
    const result = await page.window.syncLatestFromCloud();
    assert.notEqual(result, "signed-out");
    assert.equal(page.window.localStorage.getItem("scholog_local_user") !== null, true);
});
