import test from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase, defaultDb, loadPage, waitFor, sleep } from "./helpers.mjs";
import { installCameraStub, installSupabaseStub, makeFakeQr, todayStr, userSession } from "./stubs.mjs";

const TOKEN = "11111111-2222-4333-8444-555555555555";

// Camera stub state for the current test (filled by bootScan).
let camera = { callbacks: [], stopped: 0, started: 0, failWith: null };
test.beforeEach(() => {
    camera = { callbacks: [], stopped: 0, started: 0, failWith: null };
});

function sessionInfo(overrides = {}) {
    return {
        ok: true,
        section: "Grade 11 - STEM",
        date: todayStr(),
        closed: false,
        expired: false,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        student_count: 3,
        checked_in: 1,
        ...overrides
    };
}

function installFetchStub(window, handler) {
    const calls = [];
    window.fetch = async (url, init = {}) => {
        const fn = String(url).split("/rpc/")[1];
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ url: String(url), fn, body, headers: init.headers, method: init.method });
        const result = handler(fn, body) || {};
        const status = result.status || 200;
        const payload = result.data === undefined ? {} : result.data;
        return { ok: status < 400, status, text: async () => JSON.stringify(payload) };
    };
    return calls;
}

function bootScan({ url, token = TOKEN, session = null, db = defaultDb(), handler } = {}) {
    const client = createFakeSupabase({ db, session });
    const page = loadPage({
        html: "scan.html",
        scripts: ["scan.js"],
        url: url || `https://scholog.test/scan.html?t=${token}`,
        beforeParse(window) {
            installSupabaseStub(window, client);
            window.qrcode = makeFakeQr();
            camera = installCameraStub(window);
        }
    });
    const fetchCalls = installFetchStub(page.window, handler || ((fn, body) => {
        if (fn === "checkin_session_info") return { data: sessionInfo() };
        if (fn === "checkin_mark") {
            return {
                data: {
                    ok: true,
                    student_name: body.p_student_id === "2026-0002" ? "Ana Santos" : "Lea Reyes",
                    student_id: body.p_student_id,
                    status: "Present",
                    already_marked: false,
                    student_count: 3,
                    checked_in: 2
                }
            };
        }
        return { data: {} };
    }));
    return { ...page, client, fetchCalls };
}

test("student check-in page renders the session from an externally shared link", async (t) => {
    const { window, dom, fetchCalls } = bootScan();
    t.after(() => dom.window.close());
    const document = window.document;

    await waitFor(() => !document.getElementById("view-student").classList.contains("hidden"), { label: "student view" });
    assert.equal(document.getElementById("view-host").classList.contains("hidden"), true);
    assert.equal(document.getElementById("session-section").textContent, "Grade 11 - STEM");
    assert.match(document.getElementById("session-date").textContent, /\d{4}/);
    assert.equal(document.getElementById("session-count").textContent, "1 / 3 checked in");
    assert.equal(document.getElementById("session-state-badge").textContent, "Open");

    // No teacher login is required: the page only calls the public RPCs.
    assert.ok(fetchCalls.length >= 1);
    assert.equal(fetchCalls[0].fn, "checkin_session_info");
    assert.equal(fetchCalls[0].body.p_token, TOKEN);
    assert.ok(fetchCalls[0].headers.apikey, "anon API key is sent");
});

test("typing a valid Student ID marks the student present", async (t) => {
    const { window, dom, fetchCalls } = bootScan();
    t.after(() => dom.window.close());
    const document = window.document;
    await waitFor(() => !document.getElementById("view-student").classList.contains("hidden"));

    document.getElementById("student-id-input").value = "2026-0002";
    document.getElementById("id-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

    await waitFor(() => !document.getElementById("result").classList.contains("hidden"), { label: "result card" });
    const mark = fetchCalls.find((call) => call.fn === "checkin_mark");
    assert.ok(mark, "checkin_mark was called");
    assert.equal(mark.body.p_token, TOKEN);
    assert.equal(mark.body.p_student_id, "2026-0002");

    assert.match(document.getElementById("result-title").textContent, /marked Present/i);
    assert.match(document.getElementById("result-text").textContent, /Ana Santos \(2026-0002\)/);
    assert.equal(document.getElementById("session-count").textContent, "2 / 3 checked in");
});

test("an ID that is not on the class list is rejected", async (t) => {
    const { window, dom, fetchCalls } = bootScan({
        handler: (fn) => {
            if (fn === "checkin_session_info") return { data: sessionInfo() };
            if (fn === "checkin_mark") return { data: { ok: false, error: "not_in_class" } };
            return { data: {} };
        }
    });
    t.after(() => dom.window.close());
    const document = window.document;
    await waitFor(() => !document.getElementById("view-student").classList.contains("hidden"));

    document.getElementById("student-id-input").value = "9999-9999";
    document.getElementById("id-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

    await waitFor(() => document.getElementById("result").classList.contains("result-error"), { label: "error result" });
    assert.match(document.getElementById("result-text").textContent, /not on the class list/i);
    assert.ok(fetchCalls.some((call) => call.fn === "checkin_mark" && call.body.p_student_id === "9999-9999"));
});

test("closed and expired sessions block check-in", async (t) => {
    const closed = bootScan({ handler: () => ({ data: sessionInfo({ closed: true }) }) });
    t.after(() => closed.dom.window.close());
    const closedDoc = closed.window.document;
    await waitFor(() => !closedDoc.getElementById("view-student").classList.contains("hidden"));
    await waitFor(() => closedDoc.getElementById("session-state-badge").textContent === "Closed");
    assert.equal(closedDoc.getElementById("student-id-input").disabled, true);
    assert.equal(closedDoc.getElementById("submitIdBtn").disabled, true);
    assert.match(closedDoc.getElementById("session-hint").textContent, /closed by your teacher/i);

    const expired = bootScan({ handler: () => ({ data: sessionInfo({ expired: true }) }) });
    t.after(() => expired.dom.window.close());
    const expiredDoc = expired.window.document;
    await waitFor(() => !expiredDoc.getElementById("view-student").classList.contains("hidden"));
    await waitFor(() => expiredDoc.getElementById("session-state-badge").textContent === "Expired");
    assert.equal(expiredDoc.getElementById("submitIdBtn").disabled, true);
    assert.match(expiredDoc.getElementById("session-hint").textContent, /expired/i);
});

test("an invalid or missing token is handled safely", async (t) => {
    const invalid = bootScan({ token: "not-a-token" });
    t.after(() => invalid.dom.window.close());
    const doc = invalid.window.document;
    await waitFor(() => !doc.getElementById("view-problem").classList.contains("hidden"));
    assert.match(doc.getElementById("problem-title").textContent, /Invalid check-in link/i);
    assert.equal(doc.getElementById("problem-signin").classList.contains("hidden"), true);
});

test("scanning a student QR code extracts the ID and checks in", async (t) => {
    const { window, dom, fetchCalls } = bootScan();
    t.after(() => dom.window.close());
    const document = window.document;
    await waitFor(() => !document.getElementById("view-student").classList.contains("hidden"));

    document.getElementById("startScanBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => camera.callbacks.length > 0, { label: "camera started" });

    camera.callbacks[0]("https://scholog.test/scan.html?id=2026-0003");
    await waitFor(() => fetchCalls.some((call) => call.fn === "checkin_mark"), { label: "scan check-in" });

    const mark = fetchCalls.find((call) => call.fn === "checkin_mark");
    assert.equal(mark.body.p_student_id, "2026-0003");
    await waitFor(() => !document.getElementById("result").classList.contains("hidden"));
    assert.match(document.getElementById("result-title").textContent, /marked Present/i);
});

test("printed student QR cards (SCHOLOG:ID) check in by scanned ID", async (t) => {
    const { window, dom, fetchCalls } = bootScan();
    t.after(() => dom.window.close());
    const document = window.document;
    await waitFor(() => !document.getElementById("view-student").classList.contains("hidden"));

    document.getElementById("startScanBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => camera.callbacks.length > 0);
    camera.callbacks[0]("SCHOLOG:2026-0002");

    await waitFor(() => fetchCalls.some((call) => call.fn === "checkin_mark"), { label: "card scan" });
    const mark = fetchCalls.find((call) => call.fn === "checkin_mark");
    assert.equal(mark.body.p_student_id, "2026-0002");
});

test("scanning the class check-in QR asks for a Student ID instead", async (t) => {
    const { window, dom, fetchCalls } = bootScan();
    t.after(() => dom.window.close());
    const document = window.document;
    await waitFor(() => !document.getElementById("view-student").classList.contains("hidden"));

    document.getElementById("startScanBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => camera.callbacks.length > 0);
    camera.callbacks[0](`https://scholog.test/scan.html?t=${TOKEN}`);

    await waitFor(() => document.getElementById("result").classList.contains("result-error"));
    assert.match(document.getElementById("result-text").textContent, /Type your Student ID/i);
    assert.equal(fetchCalls.some((call) => call.fn === "checkin_mark"), false);
});

test("camera-less devices fall back to typed Student ID", async (t) => {
    const { window, dom } = bootScan();
    t.after(() => dom.window.close());
    const document = window.document;
    await waitFor(() => !document.getElementById("view-student").classList.contains("hidden"));

    delete window.Html5Qrcode;
    document.getElementById("startScanBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => /isn't available|type your Student ID/i.test(document.getElementById("camera-hint").textContent));
});

test("teacher host mode creates a shareable session with QR, link and live roster", async (t) => {
    const db = defaultDb();
    db.attendance = db.attendance.filter((row) => row.student_id !== "2026-0003");
    const { window, dom, fetchCalls } = bootScan({ url: "https://scholog.test/scan.html", session: userSession(), db });
    t.after(() => dom.window.close());
    const document = window.document;

    await waitFor(() => !document.getElementById("view-host").classList.contains("hidden"), { label: "host view" });
    await waitFor(() => document.getElementById("host-section").options.length === 2, { label: "sections loaded" });
    assert.equal(document.getElementById("host-date").value, todayStr());
    assert.equal(document.getElementById("host-user").textContent, "Teacher Maria");

    document.getElementById("host-section").value = "Grade 11 - STEM";
    document.getElementById("session-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

    await waitFor(() => !document.getElementById("host-session").classList.contains("hidden"), { label: "session created" });
    assert.equal(db.checkin_sessions.length, 1);
    assert.equal(db.checkin_sessions[0].section, "Grade 11 - STEM");

    assert.match(document.getElementById("session-link").value, new RegExp(`scan\\.html\\?t=${TOKEN}`));
    assert.ok(document.querySelector("#session-qr svg"), "QR code rendered");
    assert.equal(document.getElementById("open-link-btn").href, document.getElementById("session-link").value);

    await waitFor(() => document.querySelectorAll("#host-roster li").length === 3, { label: "roster rows" });
    assert.match(document.getElementById("host-roster").textContent, /Juan Dela Cruz/);
    assert.equal(document.getElementById("host-total").textContent, "3");
    assert.equal(document.getElementById("host-checked").textContent, "2");
    assert.equal(document.getElementById("host-pending").textContent, "1");
    assert.match(document.getElementById("host-roster").textContent, /Present/);
    assert.match(document.getElementById("host-roster").textContent, /Not checked in/);

    // Teacher can also scan a student ID card into the same session.
    document.getElementById("host-scan-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => camera.callbacks.length > 0);
    camera.callbacks[0]("2026-0003");
    await waitFor(() => fetchCalls.some((call) => call.fn === "checkin_mark"), { label: "host scan" });
    const mark = fetchCalls.find((call) => call.fn === "checkin_mark");
    assert.equal(mark.body.p_token, TOKEN);
    assert.equal(mark.body.p_student_id, "2026-0003");

    document.getElementById("close-session-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => db.checkin_sessions[0].closed === true, { label: "session closed" });
    await waitFor(() => document.getElementById("host-session-badge").textContent === "Closed");
    await sleep(20);
});

test("host mode without a teacher login points to sign-in", async (t) => {
    const { window, dom } = bootScan({ url: "https://scholog.test/scan.html", session: null });
    t.after(() => dom.window.close());
    const document = window.document;
    await waitFor(() => !document.getElementById("view-problem").classList.contains("hidden"));
    assert.match(document.getElementById("problem-title").textContent, /Teacher sign-in required/i);
    assert.equal(document.getElementById("problem-signin").classList.contains("hidden"), false);
});
