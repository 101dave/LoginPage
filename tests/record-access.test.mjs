// Student record access control: a typed Student ID alone must not return a
// learner's grades (see supabase/migrations/20261025_student_record_codes.sql).
import test from "node:test";
import assert from "node:assert/strict";
import { loadPage, waitFor } from "./helpers.mjs";
import { installCameraStub, installLucideStub } from "./stubs.mjs";

const STUDENT = { student_id: "2026-0001", name: "Juan Dela Cruz", section: "Grade 11 - STEM" };
const CODE = "K7M2QPX9";

// Stand up student-record.html with a fetch that records every RPC call.
function bootRecord({ url, respond, camera = false }) {
    const calls = [];
    let cameraState = null;
    const page = loadPage({
        html: "student-record.html",
        scripts: ["student-record.js"],
        url,
        beforeParse(window) {
            installLucideStub(window);
            if (camera) cameraState = installCameraStub(window);
            window.fetch = async (target, init) => {
                const body = init && init.body ? JSON.parse(init.body) : null;
                calls.push({ url: String(target), body });
                const payload = respond(body);
                return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
            };
        }
    });
    return { ...page, calls, cameraState };
}

test("a bare Student ID is refused and the page asks for the record code", async (t) => {
    const { window, dom, calls } = bootRecord({
        url: "https://scholog.test/student-record.html?student_id=2026-0001",
        respond: () => ({ ok: false, error: "code_required" })
    });
    t.after(() => dom.window.close());
    const document = window.document;

    await waitFor(() => calls.some((call) => call.url.includes("get_student_record")), { label: "record rpc" });

    // No code was sent, so nothing about the learner came back.
    const recordCall = calls.find((call) => call.url.includes("get_student_record"));
    assert.equal(recordCall.body.p_student_id, "2026-0001");
    assert.equal(recordCall.body.p_record_code, undefined, "no code is sent when none is known");

    // The typed-ID panel opens with the code field and the explanation.
    await waitFor(() => !document.getElementById("lookup-code-note").classList.contains("hidden"), {
        label: "code prompt"
    });
    const codeField = document.getElementById("lookup-code-input");
    assert.ok(codeField, "record code field exists");
    assert.notEqual(codeField.required, false, "the field becomes required");
    assert.equal(document.getElementById("lookup-id-input").value, "2026-0001", "the typed ID is kept");
    assert.match(document.getElementById("lookup-code-note").textContent, /record code/i);
});

test("the record code from the QR link unlocks the record", async (t) => {
    const { window, dom, calls } = bootRecord({
        url: `https://scholog.test/student-record.html?student_id=2026-0001&code=${CODE}`,
        respond: () => ({ ok: true, student: STUDENT, attendance: [], scores: [], categories: [] })
    });
    t.after(() => dom.window.close());

    await waitFor(() => calls.some((call) => call.url.includes("get_student_record")), { label: "record rpc" });
    const recordCall = calls.find((call) => call.url.includes("get_student_record"));
    assert.equal(recordCall.body.p_record_code, CODE, "the code is sent with the lookup");

    await waitFor(() => !window.document.getElementById("view-record").classList.contains("hidden"), {
        label: "record view"
    });
});

test("typing the ID and the code together works, and the URL keeps the code", async (t) => {
    const { window, dom, calls } = bootRecord({
        url: "https://scholog.test/student-record.html",
        respond: (body) => (body && body.p_record_code === CODE
            ? { ok: true, student: STUDENT, attendance: [], scores: [], categories: [] }
            : { ok: false, error: "code_required" })
    });
    t.after(() => dom.window.close());
    const document = window.document;

    // The lookup UI is wired on DOMContentLoaded; wait for it before typing.
    await waitFor(() => !document.getElementById("view-lookup").classList.contains("hidden"), {
        label: "lookup view"
    });
    document.getElementById("lookup-id-input").value = "2026-0001";
    document.getElementById("lookup-code-input").value = CODE;
    document.getElementById("lookup-id-form").dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true })
    );

    await waitFor(() => calls.some((call) => call.body && call.body.p_record_code === CODE), {
        label: "lookup with code"
    });
    await waitFor(() => !document.getElementById("view-record").classList.contains("hidden"), {
        label: "record view"
    });
    assert.match(window.location.search, new RegExp(`code=${CODE}`), "the code is kept in the URL");
});

test("a scanned card payload with the code is parsed into id + code", async (t) => {
    const { window, dom, calls, cameraState } = bootRecord({
        url: "https://scholog.test/student-record.html",
        respond: () => ({ ok: true, student: STUDENT, attendance: [], scores: [], categories: [] }),
        camera: true
    });
    t.after(() => dom.window.close());

    // The page auto-starts its scanner; feed it a card payload.
    await waitFor(() => cameraState && cameraState.callbacks.length > 0, { label: "scanner started" });
    cameraState.callbacks[0](`SCHOLOG:2026-0001:${CODE}`);
    await waitFor(() => calls.some((call) => call.url.includes("get_student_record")), { label: "record rpc" });

    const recordCall = calls.find((call) => call.url.includes("get_student_record"));
    assert.equal(recordCall.body.p_student_id, "2026-0001");
    assert.equal(recordCall.body.p_record_code, CODE);
});

test("a live check-in session token still opens the record without a code", async (t) => {
    const token = "11111111-2222-4333-8444-555555555555";
    const { window, dom, calls } = bootRecord({
        url: `https://scholog.test/student-record.html?t=${token}&student_id=2026-0001&user_id=user-1`,
        respond: (body) => (body && body.p_token === token
            ? { ok: true, user_id: "user-1", section: "Grade 11 - STEM" }
            : { ok: false, error: "invalid_session" })
    });
    t.after(() => dom.window.close());

    await waitFor(() => calls.some((call) => call.url.includes("get_student_record")), { label: "record rpc" });
    const recordCall = calls.find((call) => call.url.includes("get_student_record"));
    assert.equal(recordCall.body.p_token, token);
    assert.equal(recordCall.body.p_record_code, undefined, "in-class students need no code");
});
