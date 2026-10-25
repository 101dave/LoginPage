import test from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase, defaultDb, loadPage, waitFor, sleep } from "./helpers.mjs";
import { installCameraStub, installLucideStub, installSupabaseStub, makeFakeQr, todayStr, userSession } from "./stubs.mjs";

const TOKEN = "11111111-2222-4333-8444-555555555555";

// Camera stub state for the current test (filled by bootScan).
let camera = { callbacks: [], stopped: 0, started: 0, failWith: null };
test.beforeEach(() => {
    camera = { callbacks: [], stopped: 0, started: 0, failWith: null };
});

// Every jsdom window starts with empty storage, so each test gets its own device.

function sessionInfo(overrides = {}) {
    return {
        ok: true,
        user_id: "user-1",
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

    assert.match(document.getElementById("result-title").textContent, /you're Present/i);
    assert.match(document.getElementById("result-text").textContent, /Ana Santos \(2026-0002\)/);
    assert.equal(document.getElementById("session-count").textContent, "2 / 3 checked in");
});

test("students get one clear choice at a time: Scan QR vs Type ID", async (t) => {
    const { window, dom } = bootScan();
    t.after(() => dom.window.close());
    const document = window.document;
    await waitFor(() => !document.getElementById("view-student").classList.contains("hidden"));

    const scanTab = document.getElementById("tab-scan");
    const idTab = document.getElementById("tab-id");
    assert.ok(scanTab.classList.contains("active"));
    assert.equal(scanTab.getAttribute("aria-selected"), "true");
    assert.equal(document.getElementById("panel-scan").classList.contains("hidden"), false);
    assert.equal(document.getElementById("panel-id").classList.contains("hidden"), true);

    // Type ID tab reveals only the manual form and focuses the input.
    idTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.ok(idTab.classList.contains("active"));
    assert.equal(scanTab.getAttribute("aria-selected"), "false");
    assert.equal(document.getElementById("panel-id").classList.contains("hidden"), false);
    assert.equal(document.getElementById("panel-scan").classList.contains("hidden"), true);

    // "I have a QR code instead" jumps back to the scanner.
    document.getElementById("id-use-scan-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.ok(scanTab.classList.contains("active"));
    assert.equal(document.getElementById("panel-scan").classList.contains("hidden"), false);

    // "I don't have a QR code" jumps to typing.
    document.getElementById("scan-use-id-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.ok(idTab.classList.contains("active"));
});

test("camera starts automatically on the scan tab so students just point and scan", async (t) => {
    const { window, dom } = bootScan();
    t.after(() => dom.window.close());
    const document = window.document;

    await waitFor(() => !document.getElementById("view-student").classList.contains("hidden"));
    await waitFor(() => camera.started === 1, { label: "camera auto-start" });
    assert.ok(document.getElementById("scan-stage").classList.contains("is-live"), "live stage marker");
    assert.equal(document.getElementById("startScanBtn").classList.contains("hidden"), true, "manual button hidden while live");
    assert.equal(document.getElementById("stopScanBtn").classList.contains("hidden"), false);
    assert.match(document.getElementById("camera-hint").textContent, /Camera on/i);
});

test("a successful check-in shows a big result and locks the phone", async (t) => {
    const { window, dom, fetchCalls } = bootScan();
    t.after(() => dom.window.close());
    const document = window.document;
    await waitFor(() => !document.getElementById("view-student").classList.contains("hidden"));
    await waitFor(() => camera.started >= 1, { label: "camera ready" });

    document.getElementById("student-id-input").value = "2026-0002";
    document.getElementById("id-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

    await waitFor(() => !document.getElementById("result").classList.contains("hidden"), { label: "result" });
    // One clear message: the tabs and forms step out of the way.
    assert.equal(document.querySelector(".segmented").classList.contains("hidden"), true);
    assert.equal(document.getElementById("panel-id").classList.contains("hidden"), true);
    assert.match(document.getElementById("result-note").textContent, /One check-in per phone/i);

    // The check-in is remembered for this device.
    assert.equal(document.getElementById("recent").classList.contains("hidden"), false);
    assert.match(document.getElementById("recent-list").textContent, /Ana Santos/);

    // The phone is locked: the form cannot come back.
    document.getElementById("result-done").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(document.getElementById("result").classList.contains("hidden"), false, "lock notice stays");
    assert.match(document.getElementById("result-title").textContent, /already checked in/i);
    assert.equal(document.getElementById("panel-scan").classList.contains("hidden"), true);
    assert.ok(fetchCalls.some((call) => call.fn === "checkin_mark"));
});

test("a student device sends its id and the lock survives a reload", async (t) => {
    const first = bootScan();
    t.after(() => first.dom.window.close());
    const firstDoc = first.window.document;
    await waitFor(() => !firstDoc.getElementById("view-student").classList.contains("hidden"));

    firstDoc.getElementById("student-id-input").value = "2026-0002";
    firstDoc.getElementById("id-form").dispatchEvent(new first.window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => first.fetchCalls.some((call) => call.fn === "checkin_mark"), { label: "mark call" });
    await waitFor(() => first.window.localStorage.getItem("scholog_checkin_lock"), { label: "device lock stored" });

    const mark = first.fetchCalls.find((call) => call.fn === "checkin_mark");
    assert.ok(mark.body.p_device_id, "device id is sent with the check-in");
    assert.match(mark.body.p_device_id, /^[A-Za-z0-9-]{8,64}$/);

    const deviceId = mark.body.p_device_id;
    const lock = JSON.parse(first.window.localStorage.getItem("scholog_checkin_lock"));
    assert.equal(lock.studentId, "2026-0002");
    assert.equal(lock.token, TOKEN);

    // Same phone, new page load: the lock is restored before any new check-in.
    const second = bootScan();
    t.after(() => second.dom.window.close());
    second.window.localStorage.setItem("scholog_device_id", deviceId);
    second.window.localStorage.setItem("scholog_checkin_lock", JSON.stringify(lock));

    const secondDoc = second.window.document;
    await waitFor(() => secondDoc.getElementById("result-title") &&
        /already checked in/i.test(secondDoc.getElementById("result-title").textContent), { label: "lock restored" });
    assert.equal(secondDoc.querySelector(".segmented").classList.contains("hidden"), true);
    assert.match(secondDoc.getElementById("result-text").textContent, /Ana Santos/);
});

test("the server block (device already used) is explained clearly", async (t) => {
    const { window, dom } = bootScan({
        handler: (fn) => {
            if (fn === "checkin_session_info") return { data: sessionInfo() };
            if (fn === "checkin_mark") {
                return {
                    data: {
                        ok: false,
                        error: "device_already_used",
                        device_student_name: "Juan Dela Cruz",
                        device_student_id: "2026-0001"
                    }
                };
            }
            return { data: {} };
        }
    });
    t.after(() => dom.window.close());
    const document = window.document;
    await waitFor(() => !document.getElementById("view-student").classList.contains("hidden"));

    document.getElementById("student-id-input").value = "2026-0002";
    document.getElementById("id-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

    await waitFor(() => document.getElementById("result").classList.contains("result-error"), { label: "error card" });
    assert.match(document.getElementById("result-title").textContent, /One check-in per phone/i);
    assert.match(document.getElementById("result-text").textContent, /Juan Dela Cruz \(2026-0001\)/);
    assert.match(document.getElementById("result-text").textContent, /ask your teacher/i);
    assert.equal(document.getElementById("result-retry-id").classList.contains("hidden"), true, "no retry offered");
});

test("no QR session for the date means no class: no camera, no ID form", async (t) => {
    const { window, dom, fetchCalls } = bootScan({
        handler: (fn) => {
            if (fn === "checkin_session_info") return { data: { ok: false, error: "invalid_session" } };
            return { data: {} };
        }
    });
    t.after(() => dom.window.close());
    const document = window.document;

    await waitFor(() => !document.getElementById("view-noclass").classList.contains("hidden"), { label: "no-class view" });

    // The check-in UI is gone: no scanner, no typed ID, no tabs.
    assert.equal(document.getElementById("view-student").classList.contains("hidden"), true);
    assert.equal(camera.started, 0, "camera never starts when there is no class");
    assert.match(document.getElementById("noclass-text").textContent, /no class|not opened/i);
    assert.match(document.getElementById("view-noclass").textContent, /Walang pasok/i);
    assert.match(document.getElementById("view-noclass").textContent, /manually/i);
    assert.equal(fetchCalls.some((call) => call.fn === "checkin_mark"), false);
});

test("an expired session still shows the student page but refuses check-in", async (t) => {
    const { window, dom } = bootScan({
        handler: (fn) => {
            if (fn === "checkin_session_info") {
                return { data: sessionInfo({ expired: true, expires_at: new Date(Date.now() - 60_000).toISOString() }) };
            }
            return { data: {} };
        }
    });
    t.after(() => dom.window.close());
    const document = window.document;

    await waitFor(() => !document.getElementById("view-student").classList.contains("hidden"));

    document.getElementById("student-id-input").value = "2026-0002";
    document.getElementById("id-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => document.getElementById("result").classList.contains("result-error"), { label: "expired card" });
    assert.match(document.getElementById("result-text").textContent, /expired|closed/i);
});

test("host page opens pre-filled from the dashboard link", async (t) => {
    const db = defaultDb();
    const { window, dom } = bootScan({
        url: `https://scholog.test/scan.html?section=${encodeURIComponent("Grade 11 - ABM")}&date=${todayStr()}`,
        session: userSession(),
        db
    });
    t.after(() => dom.window.close());
    const document = window.document;

    await waitFor(() => !document.getElementById("view-host").classList.contains("hidden"), { label: "host view" });
    await waitFor(() => document.getElementById("host-section").options.length === 2, { label: "sections" });
    assert.equal(document.getElementById("host-section").value, "Grade 11 - ABM");
    assert.equal(document.getElementById("host-date").value, todayStr());
    // The create form is the only thing on screen until a session exists.
    assert.equal(document.getElementById("host-start-panel").classList.contains("hidden"), false);
    assert.equal(document.getElementById("host-session").classList.contains("hidden"), true);
});

test("host can project a full-screen check-in code for the class", async (t) => {
    const { window, dom } = bootScan({ url: "https://scholog.test/scan.html", session: userSession(), db: defaultDb() });
    t.after(() => dom.window.close());
    const document = window.document;

    await waitFor(() => !document.getElementById("view-host").classList.contains("hidden"));
    await waitFor(() => document.getElementById("host-section").options.length === 2);
    document.getElementById("host-section").value = "Grade 11 - STEM";
    document.getElementById("session-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => !document.getElementById("host-session").classList.contains("hidden"));

    assert.equal(document.getElementById("presentation").classList.contains("hidden"), true);
    document.getElementById("present-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    const overlay = document.getElementById("presentation");
    assert.equal(overlay.classList.contains("hidden"), false, "projection overlay visible");
    assert.equal(document.body.style.overflow, "hidden", "page scroll locked");
    assert.ok(document.querySelector("#presentation-qr svg"), "big QR rendered");
    assert.equal(document.getElementById("presentation-title").textContent, "Grade 11 - STEM");
    assert.equal(document.getElementById("presentation-checked").textContent, "2");

    document.getElementById("presentation-exit").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(overlay.classList.contains("hidden"), true);
    assert.equal(document.body.style.overflow, "");

    // Escape also closes it.
    document.getElementById("present-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(overlay.classList.contains("hidden"), true);
});

test("host flow hides the setup form once a session exists", async (t) => {
    const { window, dom } = bootScan({ url: "https://scholog.test/scan.html", session: userSession(), db: defaultDb() });
    t.after(() => dom.window.close());
    const document = window.document;

    await waitFor(() => !document.getElementById("view-host").classList.contains("hidden"));
    await waitFor(() => document.getElementById("host-section").options.length === 2);
    document.getElementById("session-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => !document.getElementById("host-session").classList.contains("hidden"));

    assert.equal(document.getElementById("host-start-panel").classList.contains("hidden"), true, "setup form hidden");
    assert.equal(document.getElementById("host-session").classList.contains("hidden"), false);

    // "New session" brings the setup form back and clears the shared link.
    document.getElementById("new-session-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(document.getElementById("host-start-panel").classList.contains("hidden"), false);
    assert.equal(document.getElementById("host-session").classList.contains("hidden"), true);
    assert.equal(document.getElementById("session-link").value, "");
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
    assert.match(document.getElementById("result-title").textContent, /you're Present/i);
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

    // QR scanning is for students only: the teacher page has no camera scanner.
    assert.equal(document.getElementById("host-scan-btn"), null);
    assert.equal(document.getElementById("host-qr-reader"), null);
    assert.equal(camera.started, 0, "the teacher page never opens a camera");
    assert.equal(fetchCalls.some((call) => call.fn === "checkin_mark"), false);
    const manualLink = document.getElementById("host-manual-btn");
    assert.ok(manualLink, "teacher is pointed at manual recording");
    assert.match(manualLink.getAttribute("href"), /main\.html/);

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

test("checking in reveals View my record button with session token and student-record page computes period grades and enforces device lock", async (t) => {
    const { window, dom } = bootScan();
    t.after(() => dom.window.close());
    const document = window.document;
    await waitFor(() => !document.getElementById("view-student").classList.contains("hidden"));

    document.getElementById("student-id-input").value = "2026-0001";
    document.getElementById("id-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

    const viewRecordLink = document.getElementById("result-view-record");
    await waitFor(() => !viewRecordLink.classList.contains("hidden"), { label: "View my record link visible" });
    assert.match(viewRecordLink.href, /student-record\.html\?/);
    assert.match(viewRecordLink.href, /student_id=2026-0001/);
    assert.match(viewRecordLink.href, /user_id=user-1/);
    assert.match(viewRecordLink.href, new RegExp(`t=${TOKEN}`));

    const savedLock = JSON.parse(window.localStorage.getItem("scholog_checkin_lock"));
    const savedDeviceId = window.localStorage.getItem("scholog_device_id");
    assert.equal(savedLock.studentId, "2026-0001");
    assert.equal(savedLock.userId, "user-1");

    // Load student-record.html for 2026-0001 -> renders attendance stats + computed Quarter 1 grade
    const recordPage = loadPage({
        html: "student-record.html",
        scripts: ["student-record.js"],
        url: viewRecordLink.href,
        beforeParse(win) {
            installLucideStub(win);
            win.localStorage.setItem("scholog_device_id", savedDeviceId);
            win.localStorage.setItem("scholog_checkin_lock", JSON.stringify(savedLock));
            win.fetch = async () => ({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    ok: true,
                    student: { name: "Juan Dela Cruz", student_id: "2026-0001", section: "Grade 11 - STEM" },
                    attendance: [
                        { date: "2026-10-25", status: "Present", subject: "General" },
                        { date: "2026-10-24", status: "Late", subject: "General" }
                    ],
                    grading_categories: [
                        {
                            id: "cat-ww",
                            name: "Written Work",
                            weight: 40,
                            items: [{ id: "i1", label: "WW 1", max_score: 20 }]
                        },
                        {
                            id: "cat-pt",
                            name: "Performance Task",
                            weight: 60,
                            items: [{ id: "p1", label: "PT 1", max_score: 50 }]
                        }
                    ],
                    scores: [
                        {
                            date: "2026-10-25",
                            grading_period: "Quarter 1",
                            category_id: "cat-ww",
                            category_name: "Written Work",
                            category_weight: 40,
                            item_id: "i1",
                            item_label: "WW 1",
                            score: 18,
                            max_score: 20
                        },
                        {
                            date: "2026-10-25",
                            grading_period: "Quarter 1",
                            category_id: "cat-pt",
                            category_name: "Performance Task",
                            category_weight: 60,
                            item_id: "p1",
                            item_label: "PT 1",
                            score: 45,
                            max_score: 50
                        }
                    ]
                })
            });
        }
    });
    t.after(() => recordPage.dom.window.close());

    await waitFor(() => !recordPage.window.document.getElementById("view-record").classList.contains("hidden"));
    const recDoc = recordPage.window.document;
    assert.equal(recDoc.getElementById("record-student-name").textContent, "Juan Dela Cruz");
    assert.match(recDoc.getElementById("record-student-id").textContent, /2026-0001/);
    assert.equal(recDoc.getElementById("record-attendance-summary").classList.contains("hidden"), false);
    assert.match(recDoc.getElementById("record-attendance-summary").textContent, /100%/, "Present + Late counts toward attendance rate");
    assert.equal(recDoc.querySelectorAll("#record-attendance-body tr").length, 2);
    assert.equal(recDoc.getElementById("record-grade-summary-card").classList.contains("hidden"), false);
    assert.match(recDoc.getElementById("record-grade-summary-body").textContent, /Quarter 1/);
    assert.match(recDoc.getElementById("record-grade-summary-body").textContent, /90\.00%/);
    assert.match(recDoc.getElementById("record-grade-summary-body").textContent, /Final/);
    assert.equal(recDoc.querySelectorAll("#record-scores-body tr").length, 2);
    assert.match(recDoc.getElementById("record-scores-body").textContent, /90%/);

    // Attempt to view a different student's ID (2026-0002) on the same locked phone -> blocked immediately
    const tamperedUrl = viewRecordLink.href.replace("student_id=2026-0001", "student_id=2026-0002");
    const blockedPage = loadPage({
        html: "student-record.html",
        scripts: ["student-record.js"],
        url: tamperedUrl,
        beforeParse(win) {
            installLucideStub(win);
            win.localStorage.setItem("scholog_device_id", savedDeviceId);
            win.localStorage.setItem("scholog_checkin_lock", JSON.stringify(savedLock));
        }
    });
    t.after(() => blockedPage.dom.window.close());

    await waitFor(() => !blockedPage.window.document.getElementById("view-notfound").classList.contains("hidden"));
    assert.match(blockedPage.window.document.getElementById("notfound-title").textContent, /Access restricted/i);
});

test("smart live projector QR: auto-late grace timer, live check-in feed & pop-up alert, sound toggle, and student Late check-in", async (t) => {
    const db = defaultDb();
    db.attendance = db.attendance.filter((row) => row.student_id !== "2026-0003");
    const { window, dom } = bootScan({ url: "https://scholog.test/scan.html", session: userSession(), db });
    t.after(() => dom.window.close());
    const document = window.document;

    await waitFor(() => !document.getElementById("view-host").classList.contains("hidden"));
    await waitFor(() => document.getElementById("host-section").options.length === 2);

    document.getElementById("host-section").value = "Grade 11 - STEM";
    document.getElementById("host-late-after").value = "15";
    document.getElementById("session-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

    await waitFor(() => !document.getElementById("host-session").classList.contains("hidden"));
    assert.ok(db.checkin_sessions[0].late_after_at, "late_after_at timestamp saved on session");
    assert.match(document.getElementById("host-timer-pill").textContent, /On-Time Window/i);

    // Open fullscreen projector
    document.getElementById("present-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(document.getElementById("presentation-present-count").textContent, "1");
    assert.equal(document.getElementById("presentation-late-count").textContent, "1");
    assert.equal(document.getElementById("presentation-pending-count").textContent, "1");

    // Simulate Lea Reyes (2026-0003) scanning in and refreshing the roster -> triggers Live Pop-Up & Feed update
    db.attendance.push({
        id: 99,
        user_id: "user-1",
        date: todayStr(),
        student_id: "2026-0003",
        status: "Present",
        subject: "General"
    });
    document.getElementById("refresh-roster-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    await waitFor(() => !document.getElementById("presentation-live-pop").classList.contains("hidden"), {
        label: "live projector pop-up alert shown"
    });
    assert.match(document.getElementById("presentation-live-pop").textContent, /Lea Reyes/);
    assert.match(document.getElementById("presentation-feed-list").textContent, /Lea Reyes/);
    assert.equal(document.getElementById("presentation-checked").textContent, "3");

    // Toggle Mark Late Now -> switches session into Late Mode Active
    document.getElementById("host-late-toggle-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => /Late Mode Active/i.test(document.getElementById("host-timer-pill").textContent));
    assert.match(document.getElementById("presentation-timer-pill").textContent, /Late Mode Active/i);

    // Toggle Sound button
    document.getElementById("presentation-sound-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(document.getElementById("presentation-sound-btn").getAttribute("aria-pressed"), "false");
    assert.match(document.getElementById("presentation-sound-btn").textContent, /Muted/i);

    // Student view during Late window shows Late banner and marks student Late
    const lateStudentScan = bootScan({
        handler: (fn) => {
            if (fn === "checkin_session_info") {
                return {
                    data: sessionInfo({
                        late_after_at: new Date(Date.now() - 60_000).toISOString(),
                        late_mode: true
                    })
                };
            }
            if (fn === "checkin_mark") {
                return {
                    data: {
                        ok: true,
                        student_name: "Lea Reyes",
                        student_id: "2026-0003",
                        status: "Late",
                        already_marked: false,
                        student_count: 3,
                        checked_in: 3
                    }
                };
            }
            return { data: {} };
        }
    });
    t.after(() => lateStudentScan.dom.window.close());
    const sDoc = lateStudentScan.window.document;
    await waitFor(() => !sDoc.getElementById("view-student").classList.contains("hidden"));
    assert.equal(sDoc.getElementById("student-late-banner").classList.contains("hidden"), false);
    assert.match(sDoc.getElementById("student-late-banner").textContent, /marks you Late/i);

    sDoc.getElementById("student-id-input").value = "2026-0003";
    sDoc.getElementById("id-form").dispatchEvent(new lateStudentScan.window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => !sDoc.getElementById("result").classList.contains("hidden"));
    assert.match(sDoc.getElementById("result-title").textContent, /marked Late/i);
});


