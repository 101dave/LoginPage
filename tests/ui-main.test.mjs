import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, createFakeSupabase, loadPage, waitFor, sleep } from "./helpers.mjs";
import { dbWithToday, makeFakeJsPdf, makeFakeQr, installLucideStub, installSupabaseStub, todayStr } from "./stubs.mjs";

async function bootMainApp(overrides = {}) {
    const db = overrides.db || dbWithToday();
    const client = createFakeSupabase({ db, ...overrides.clientOptions });
    const pdf = makeFakeJsPdf();
    const qr = makeFakeQr();
    const page = loadPage({
        html: "main.html",
        scripts: ["pdf.js", "main.js"],
        url: "https://scholog.test/main.html",
        beforeParse(window) {
            installSupabaseStub(window, client);
            installLucideStub(window);
            window.qrcode = qr;
            window.jspdf = { jsPDF: pdf.FakeJsPDF };
        }
    });
    await waitFor(() => page.window.document.getElementById("stat-total").textContent !== "0", { label: "dashboard data" });
    return { ...page, client, pdf, db, qr };
}

function click(window, element) {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

test("dashboard renders totals, present/absent counts and section breakdown", async (t) => {
    const { window, dom } = await bootMainApp();
    t.after(() => dom.window.close());
    const document = window.document;

    assert.equal(document.getElementById("stat-total").textContent, "4");
    // Present = 1 Present + 1 Late, Absent = 1
    assert.equal(document.getElementById("stat-present").textContent, "2");
    assert.equal(document.getElementById("stat-absent").textContent, "1");
    assert.equal(document.getElementById("stat-rate").textContent, "50%");
    assert.match(document.getElementById("dash-date-label").textContent, /Today \(\d{4}-\d{2}-\d{2}\)/);

    const breakdown = document.getElementById("section-breakdown-container").textContent;
    assert.match(breakdown, /Grade 11 - STEM/);
    assert.match(breakdown, /3 Students/);
    assert.match(breakdown, /Grade 11 - ABM/);
});

test("class list shows sections, students and search", async (t) => {
    const { window, dom } = await bootMainApp();
    t.after(() => dom.window.close());
    const document = window.document;

    window.switchTab("directory");
    await waitFor(() => document.getElementById("directory-table-body").children.length === 4);

    const tabs = document.getElementById("directory-section-tabs").textContent;
    assert.match(tabs, /All Students/);
    assert.match(tabs, /Grade 11 - STEM/);
    assert.match(tabs, /Grade 11 - ABM/);

    const rows = [...document.querySelectorAll("#directory-table-body tr")];
    assert.equal(rows.length, 4);
    assert.match(rows[0].textContent, /Juan Dela Cruz/);
    assert.match(rows[0].textContent, /2026-0001/);

    // Section filtering
    const sectionBtn = [...document.querySelectorAll(".section-tab-btn")]
        .find((btn) => btn.textContent.includes("Grade 11 - ABM"));
    click(window, sectionBtn);
    await waitFor(() => document.querySelectorAll("#directory-table-body tr").length === 1);
    assert.match(document.getElementById("directory-section-banner").textContent, /Grade 11 - ABM/);

    // Search filtering (back to all)
    click(window, [...document.querySelectorAll(".section-tab-btn")][0]);
    const search = document.getElementById("directory-search");
    search.value = "ana";
    window.renderDirectory();
    await waitFor(() => document.querySelectorAll("#directory-table-body tr").length === 1);
    assert.match(document.getElementById("directory-table-body").textContent, /Ana Santos/);
});

test("class list can show a printable QR code for each student", async (t) => {
    const { window, qr, dom } = await bootMainApp();
    t.after(() => dom.window.close());
    const document = window.document;

    window.switchTab("directory");
    await waitFor(() => document.querySelectorAll("#directory-table-body tr").length === 4);

    const qrButtons = [...document.querySelectorAll("#directory-table-body .action-qr")];
    assert.equal(qrButtons.length, 4, "every student row has a QR action");
    click(window, qrButtons[0]);

    const modal = document.getElementById("modal-student-qr");
    assert.equal(modal.classList.contains("hidden"), false, "QR modal opened");
    assert.equal(document.getElementById("student-qr-name").textContent, "Juan Dela Cruz");
    assert.equal(document.getElementById("student-qr-code").textContent, "2026-0001");
    assert.ok(document.querySelector("#student-qr-canvas svg"), "QR SVG rendered");
    assert.deepEqual([...qr.encoded], ["SCHOLOG:2026-0001"], "QR encodes the student ID");

    window.closeModal("modal-student-qr");
    assert.equal(modal.classList.contains("hidden"), true);
});

test("attendance: section selection, sheet rendering and status marking", async (t) => {
    const { window, client, dom } = await bootMainApp();
    t.after(() => dom.window.close());
    const document = window.document;
    const date = todayStr();

    window.switchTab("attendance");
    await waitFor(() => document.getElementById("att-table-body").children.length === 3);

    await sleep(30);
    const sectionSelect = document.getElementById("att-section");
    assert.equal(sectionSelect.options.length, 2);
    sectionSelect.value = "Grade 11 - STEM";
    document.getElementById("att-date").value = date;
    window.loadAttendanceSheet();

    await waitFor(() => document.querySelectorAll("#att-table-body tr").length === 3);
    const firstRow = document.querySelector("#att-table-body tr");
    assert.match(firstRow.textContent, /Juan Dela Cruz/);
    assert.match(firstRow.textContent, /2026-0001/);

    // Mark every status and confirm the cloud write uses the right subject +
    // conflict target (matches attendance_user_date_student_subject_key).
    const statuses = ["Absent", "Late", "Excused", "Present"];
    for (const status of statuses) {
        client.calls.length = 0;
        const btn = [...firstRow.querySelectorAll(".status-btn")].find((b) => b.textContent.trim() === status);
        assert.ok(btn, `status button ${status} exists`);
        click(window, btn);
        await waitFor(() =>
            client.calls.some((c) => c.table === "attendance" && c.op === "upsert" && c.payload.status === status),
            { label: `upsert for ${status}` }
        );
        const call = client.calls.find((c) => c.table === "attendance" && c.op === "upsert");
        assert.equal(call.payload.subject, "General");
        assert.equal(call.options.onConflict, "user_id,date,student_id,subject");

        await waitFor(() => {
            const row = document.querySelector("#att-table-body tr");
            return Boolean(row && row.querySelector(".status-btn.active-" + status));
        }, { label: `active pill for ${status}` });
    }
});

test("attendance: all-present, save and cloud sync", async (t) => {
    const { window, client, db, dom } = await bootMainApp();
    t.after(() => dom.window.close());
    const document = window.document;
    const date = todayStr();

    window.switchTab("attendance");
    await waitFor(() => document.getElementById("att-table-body").children.length === 3);
    await sleep(30);
    document.getElementById("att-section").value = "Grade 11 - STEM";
    document.getElementById("att-date").value = date;
    window.loadAttendanceSheet();

    client.calls.length = 0;
    window.markAllAttendance("Present");
    await waitFor(() => client.calls.some((c) => c.op === "upsert" && Array.isArray(c.payload) && c.payload.length === 3), {
        label: "batch upsert"
    });
    const batch = client.calls.find((c) => c.op === "upsert" && Array.isArray(c.payload));
    assert.ok(batch.payload.every((row) => row.subject === "General" && row.status === "Present"));
    assert.equal(batch.options.onConflict, "user_id,date,student_id,subject");

    // Rows persisted in the fake cloud
    const abm = db.attendance.find((r) => r.student_id === "2026-0001" && r.date === date);
    assert.equal(abm.status, "Present");

    client.calls.length = 0;
    await window.saveAttendance();
    await waitFor(() => document.querySelector(".toast-success"), { label: "save toast" });
    const saveCall = client.calls.find((c) => c.op === "upsert" && Array.isArray(c.payload));
    assert.ok(saveCall, "save pushes a batch of attendance rows");
    assert.equal(saveCall.payload.length, 3, "only the selected section is saved");
    assert.ok(saveCall.payload.every((row) => row.date === date && row.subject === "General"));
});

test("manual attendance saves even when no QR session was created (no class today)", async (t) => {
    const { window, client, db, dom } = await bootMainApp();
    t.after(() => dom.window.close());
    const document = window.document;
    const date = todayStr();

    // No QR session at all for this date -> "walang pasok" for QR check-in.
    db.checkin_sessions = [];
    window.switchTab("attendance");
    await waitFor(() => document.getElementById("att-table-body").children.length === 3);
    await sleep(30);

    document.getElementById("att-section").value = "Grade 11 - STEM";
    document.getElementById("att-date").value = date;
    window.loadAttendanceSheet();
    await waitFor(() => document.querySelectorAll("#att-table-body tr").length === 3);

    // The teacher can still record by hand.
    const row = document.querySelector("#att-table-body tr");
    const late = [...row.querySelectorAll(".status-btn")].find((b) => b.textContent.trim() === "Late");
    click(window, late);
    client.calls.length = 0;
    await window.saveAttendance();
    await waitFor(() => document.querySelector(".toast-success"), { label: "save toast" });

    const saveCall = client.calls.find((c) => c.op === "upsert" && Array.isArray(c.payload));
    assert.ok(saveCall, "manual save still writes attendance");
    assert.equal(saveCall.payload.length, 3);
    assert.equal(db.checkin_sessions.length, 0, "saving never creates a QR session");
});

test("daily PDF export builds the right report", async (t) => {
    const { window, pdf, dom } = await bootMainApp();
    t.after(() => dom.window.close());
    const document = window.document;
    const date = todayStr();

    window.switchTab("attendance");
    await waitFor(() => document.getElementById("att-table-body").children.length === 3);
    document.getElementById("att-section").value = "Grade 11 - STEM";
    document.getElementById("att-date").value = date;
    window.loadAttendanceSheet();

    window.exportAttendanceToPDF();
    await waitFor(() => pdf.instances.some((doc) => doc.saved), { label: "pdf save" });

    const doc = pdf.instances.find((item) => item.saved);
    assert.equal(doc.saved, `Daily_Attendance_Grade 11 - STEM_${date}.pdf`);

    const text = doc.texts.map((entry) => entry.content).join("\n");
    assert.match(text, /Scholog — Daily Attendance Report/);
    assert.match(text, /Section: Grade 11 - STEM/);
    assert.match(text, new RegExp(`Date: ${date}`));
    assert.match(text, /Teacher: Teacher Maria/);
    assert.match(text, /Present: 1\s+Late: 1\s+Absent: 1\s+Excused: 0\s+Total: 3/);

    assert.equal(doc.tables.length, 1);
    const table = doc.tables[0];
    assert.deepEqual([...table.head[0]], ["#", "Student Name", "Student ID", "Status"]);
    assert.deepEqual([...table.body].map((row) => row[1]), ["Juan Dela Cruz", "Ana Santos", "Lea Reyes"]);
    assert.deepEqual([...table.body].map((row) => row[3]), ["Present", "Late", "Absent"]);

    assert.match(document.querySelector(".toast").textContent, /Daily PDF exported/);
});

test("no Monthly SF2 / xlsx export and no dark mode toggle remain", async (t) => {
    const { window, dom } = await bootMainApp();
    t.after(() => dom.window.close());
    const document = window.document;

    const html = fs.readFileSync(path.join(ROOT, "main.html"), "utf8");
    const css = fs.readFileSync(path.join(ROOT, "main.css"), "utf8");
    const js = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");

    for (const source of [html, css, js, document.body.textContent]) {
        assert.doesNotMatch(source, /monthly/i);
        assert.doesNotMatch(source, /sf2/i);
        assert.doesNotMatch(source, /\.xlsx|sheetjs|xlsx/i);
    }
    // The only export control is the daily PDF.
    const exportButtons = [...document.querySelectorAll("button, a")].filter((el) =>
        /export|pdf|xlsx|sf2/i.test(el.textContent)
    );
    assert.equal(exportButtons.length, 1, "exactly one export control (Daily PDF)");
    assert.match(exportButtons[0].textContent, /Daily PDF/);

    // Dark mode was removed entirely: no theme attribute, toggle, or styles.
    assert.equal(document.querySelectorAll("[data-theme]").length, 0);
    assert.doesNotMatch(css, /\[data-theme=["']?dark/i);
    assert.doesNotMatch(html + js, /darkMode|toggleTheme|theme-toggle|data-theme/i);
    const themeControl = [...document.querySelectorAll("button, a, label, select")].find((el) =>
        /dark mode|light mode|theme/i.test(el.textContent + " " + (el.getAttribute("aria-label") || ""))
    );
    assert.equal(themeControl, undefined, "no dark/light mode control in the UI");
});

test("logout signs the user out and returns to the login page", async (t) => {
    const { window, client, dom } = await bootMainApp();
    t.after(() => dom.window.close());
    window.localStorage.setItem("scholog_local_user", JSON.stringify({ email: "teacher@example.com" }));

    window.handleLogout();
    await waitFor(() => client.signedOut, { label: "sign out" });
    await waitFor(() => window.localStorage.getItem("scholog_local_user") === null, { label: "local user cleared" });
});

test("QR check-in button opens the separate scanner page", async (t) => {
    const { window, dom } = await bootMainApp();
    t.after(() => dom.window.close());
    const opened = [];
    window.open = (url, target, features) => {
        opened.push({ url, target, features });
        return null;
    };

    const btn = [...window.document.querySelectorAll("button")]
        .find((item) => /Start QR Check-In/.test(item.textContent));
    assert.ok(btn, "QR check-in button exists in the attendance view");
    click(window, btn);
    assert.equal(opened.length, 1);
    assert.match(opened[0].url, /scan\.html(\?|$)/);
    assert.equal(opened[0].target, "_blank");

    // The scanner UI itself must not live inside the teacher dashboard.
    assert.equal(window.document.getElementById("qr-reader"), null);
    assert.equal(window.document.querySelector("video"), null);

    // The separate page exists and is a full standalone document.
    const scanHtml = fs.readFileSync(path.join(ROOT, "scan.html"), "utf8");
    assert.match(scanHtml, /<title>Scholog — QR Check-In<\/title>/);
    assert.match(scanHtml, /scan\.js/);
});

test("QR check-in launcher passes the selected section and date", async (t) => {
    const { window, dom } = await bootMainApp();
    t.after(() => dom.window.close());
    const document = window.document;
    const opened = [];
    window.open = (url) => { opened.push(url); return null; };

    window.switchTab("attendance");
    await waitFor(() => document.querySelectorAll("#att-table-body tr").length === 3, { label: "rows" });
    document.getElementById("att-section").value = "Grade 11 - ABM";
    document.getElementById("att-date").value = todayStr();
    window.loadAttendanceSheet();

    window.openQrCheckInPage();
    const url = new URL(opened[0]);
    assert.equal(url.pathname.split("/").pop(), "scan.html");
    assert.equal(url.searchParams.get("section"), "Grade 11 - ABM");
    assert.equal(url.searchParams.get("date"), todayStr());
});

test("teacher refreshes attendance to pick up student check-ins", async (t) => {
    const { window, client, db, dom } = await bootMainApp();
    t.after(() => dom.window.close());
    const document = window.document;
    const date = todayStr();

    window.switchTab("attendance");
    await waitFor(() => document.getElementById("att-table-body").children.length === 3, { label: "attendance rows" });
    await sleep(30);
    await sleep(30);
    window.document.getElementById("att-section").value = "Grade 11 - STEM";
    window.document.getElementById("att-date").value = date;
    window.loadAttendanceSheet();

    // A student checks in from another device (written straight to the cloud).
    const row = db.attendance.find((r) => r.student_id === "2026-0003" && r.date === date);
    row.status = "Present";
    db.students[2].name = "Lea Reyes";

    await window.refreshAttendanceFromCloud();
    await waitFor(() => window.document.querySelector(".toast-success"), { label: "refresh toast" });
    assert.match(window.document.querySelector(".toast-success").textContent, /Latest attendance loaded/);

    const active = [...window.document.querySelectorAll("#att-table-body tr")]
        .find((tr) => /Lea Reyes/.test(tr.textContent))
        .querySelector(".status-btn.active-Present");
    assert.ok(active, "refreshed row shows Present");
    assert.ok(client.calls.some((c) => c.table === "attendance" && c.op === "select"));
});

test("dialogs open with focus inside and close with Escape", async (t) => {
    const { window, dom } = await bootMainApp();
    t.after(() => dom.window.close());
    const document = window.document;

    const backdrop = document.getElementById("modal-section");
    assert.ok(backdrop.classList.contains("hidden"), "modal starts hidden");
    assert.equal(backdrop.getAttribute("role"), "dialog");
    assert.equal(backdrop.getAttribute("aria-modal"), "true");

    window.openAddSectionModal();
    assert.equal(backdrop.classList.contains("hidden"), false, "modal opens");
    await sleep(10);
    assert.equal(document.activeElement.id, "new-section-name", "focus moves into the dialog");

    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(backdrop.classList.contains("hidden"), true, "Escape closes the dialog");
});

test("the mobile menu toggle keeps aria-expanded in sync", async (t) => {
    const { window, dom } = await bootMainApp();
    t.after(() => dom.window.close());
    const document = window.document;
    const trigger = document.querySelector(".hamburger-btn");
    const menu = document.getElementById("mobileMenu");

    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    window.toggleMobileMenu();
    assert.equal(menu.classList.contains("hidden"), false);
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    window.toggleMobileMenu();
    assert.equal(menu.classList.contains("hidden"), true);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
});
