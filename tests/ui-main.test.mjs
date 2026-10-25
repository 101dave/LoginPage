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

function setGradingRow(row, name, weight, itemsCount) {
    row.querySelector(".grading-category-name").value = name;
    row.querySelector(".grading-category-weight").value = String(weight);
    if (typeof itemsCount === "number") {
        row.querySelector(".grading-category-items").value = String(itemsCount);
    }
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

test("student scores: custom maximum and grading period save separately from attendance", async (t) => {
    const { window, client, db, dom } = await bootMainApp();
    t.after(() => dom.window.close());
    const document = window.document;
    const date = todayStr();

    assert.ok(document.getElementById("nav-scores"), "desktop Student Scores navigation exists");
    assert.ok(document.getElementById("mob-nav-scores"), "mobile Student Scores navigation exists");

    window.switchTab("scores");
    await waitFor(() => document.getElementById("view-scores").classList.contains("hidden") === false, { label: "score view" });
    await sleep(30);

    window.openGradingSetup();
    setGradingRow(document.querySelector("#grading-weight-rows .grading-weight-row"), "Written Work", 100, true);
    document.getElementById("form-grading-setup").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelectorAll("#score-table-body .score-input").length === 3, { label: "score rows" });
    await waitFor(() => db.grading_categories.length === 1, { label: "category cloud sync" });

    assert.equal(document.getElementById("view-scores").classList.contains("hidden"), false);
    assert.equal(document.getElementById("view-attendance").classList.contains("hidden"), true);
    assert.ok(document.getElementById("nav-scores").classList.contains("active"));
    assert.equal(document.getElementById("score-date").value, date);
    assert.equal(document.getElementById("score-section").value, "Grade 11 - STEM");

    const periodSelect = document.getElementById("score-period");
    assert.equal(periodSelect.options.length, 7, "Unassigned, four quarters and two semesters are available");
    periodSelect.value = "Quarter 2";
    periodSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal(document.getElementById("score-period-badge").textContent, "Quarter 2");

    assert.equal(document.getElementById("score-category"), null, "no single-category dropdown remains");
    assert.equal(document.getElementById("score-max"), null, "no single global maximum remains");
    assert.equal(document.querySelectorAll("#score-table-head .score-grid-category").length, 1);
    assert.equal(document.querySelectorAll("#score-table-head .score-column-letter").length, 0, "no A/B/C/D column letters in header");
    assert.equal(document.querySelector("#score-table-head .score-grid-index").textContent.trim(), "#");
    assert.equal(document.querySelector("#score-table-head .score-grid-student").textContent.trim(), "Student");
    assert.equal(document.querySelector("#score-table-head .score-grid-final").textContent.trim(), "Final Grade");

    const maxInput = document.querySelector("#score-table-head .score-column-max");
    maxInput.value = "50";
    maxInput.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal(maxInput.value, "50");

    const firstScore = document.querySelector("#score-table-body .score-input");
    assert.ok(firstScore, "score input is in the Student Scores sheet");
    assert.equal(firstScore.max, "50");
    firstScore.value = "40";
    firstScore.dispatchEvent(new window.Event("change", { bubbles: true }));

    await waitFor(() => client.calls.some((c) => c.table === "scores" && c.op === "upsert" && c.payload.score === 40), {
        label: "score cloud upsert"
    });
    const savedScore = db.scores.find((row) => row.student_id === "2026-0001" && row.date === date && row.subject === "Quarter 2");
    assert.equal(savedScore.score, 40);
    assert.equal(savedScore.max_score, 50);
    assert.equal(savedScore.grading_period, "Quarter 2");
    assert.equal(savedScore.category_name, "Written Work");
    assert.equal(savedScore.category_weight, 100);
    assert.equal(savedScore.category_id, db.grading_categories[0].id);
    assert.equal(savedScore.item_id, db.grading_categories[0].items[0].id);
    assert.equal(savedScore.item_label, "#1");
    const scoreCall = client.calls.find((c) => c.table === "scores" && c.op === "upsert" && c.payload.score === 40);
    assert.equal(scoreCall.options.onConflict, "user_id,date,student_id,grading_period,category_id,item_id");

    periodSelect.value = "Semester 1";
    window.loadScoreSheet();
    assert.equal(document.querySelector("#score-table-body .score-input").value, "", "another grading period has its own blank sheet");
    assert.equal(document.querySelector("#score-table-head .score-column-max").value, "100");
    periodSelect.value = "Quarter 2";
    window.loadScoreSheet();
    assert.equal(document.querySelector("#score-table-body .score-input").value, "40", "the quarter score is restored");
    assert.equal(document.querySelector("#score-table-head .score-column-max").value, "50", "the custom maximum is restored");

    const updatedMaxInput = document.querySelector("#score-table-head .score-column-max");
    updatedMaxInput.value = "45";
    updatedMaxInput.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => client.calls.some((c) => c.table === "scores" && c.op === "upsert" && Array.isArray(c.payload) && c.payload[0].max_score === 45), {
        label: "existing scores receive the new maximum"
    });
    assert.equal(savedScore.max_score, 45);
    assert.equal(document.querySelector("#score-table-head .score-column-max").value, "45");
    assert.equal(document.querySelector("#score-table-body .score-input").max, "45");

    const secondScore = document.querySelectorAll("#score-table-body .score-input")[1];
    secondScore.value = "60";
    secondScore.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.match(document.querySelector(".toast-error").textContent, /between 0 and 45/);
    assert.equal(db.scores.some((row) => row.student_id === "2026-0002" && row.subject === "Quarter 2"), false, "scores above the maximum are rejected");

    window.switchTab("attendance");
    await waitFor(() => document.querySelectorAll("#att-table-body tr").length === 3, { label: "attendance rows" });
    assert.equal(document.querySelector("#att-table-body .score-input"), null, "attendance rows have no score inputs");
    assert.equal(document.querySelectorAll("#view-attendance thead th").length, 5, "attendance keeps only its five columns");
    assert.doesNotMatch(document.querySelector("#view-attendance thead").textContent, /Score/i);

    client.calls.length = 0;
    await window.saveAttendance();
    assert.ok(client.calls.some((c) => c.table === "attendance" && c.op === "upsert"), "attendance still saves");
    assert.equal(client.calls.some((c) => c.table === "scores" && c.op !== "select"), false, "saving attendance never writes scores");
});

test("student scores: independent per-section categories, weights and weighted final grade", async (t) => {
    const { window, db, dom } = await bootMainApp({ clientOptions: { enforceGradingConstraints: true } });
    t.after(() => dom.window.close());
    const document = window.document;
    const date = todayStr();

    window.switchTab("scores");
    await waitFor(() => document.getElementById("view-scores").classList.contains("hidden") === false);
    await sleep(30);
    document.getElementById("score-period").value = "Quarter 1";

    // Configure Grade 11 - STEM with 3 categories initially (validation rejects 101%)
    window.openGradingSetup();
    setGradingRow(document.querySelector("#grading-weight-rows .grading-weight-row"), "Written Work", 60);
    click(window, document.getElementById("add-grade-category-btn"));
    let rows = [...document.querySelectorAll("#grading-weight-rows .grading-weight-row")];
    setGradingRow(rows[1], "Project", 40);
    click(window, document.getElementById("add-grade-category-btn"));
    rows = [...document.querySelectorAll("#grading-weight-rows .grading-weight-row")];
    setGradingRow(rows[2], "Extra", 1);

    const form = document.getElementById("form-grading-setup");
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => !document.getElementById("grading-setup-error").classList.contains("hidden"));
    assert.match(document.getElementById("grading-setup-error").textContent, /Category weights for Grade 11 - STEM must total 100%/);

    // Remove the Extra row via its remove button so STEM has Written Work (60%) + Project (40%) = 100%
    click(window, rows[2].querySelector(".grading-category-remove"));
    assert.equal(document.querySelectorAll("#grading-weight-rows .grading-weight-row").length, 2);
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => db.grading_categories.filter(row => row.section === "Grade 11 - STEM" && !row.archived).length === 2, {
        label: "two STEM categories saved"
    });

    // Switch to Grade 11 - ABM: ABM starts with NO categories of its own (does NOT inherit STEM's setup!)
    const sectionSelect = document.getElementById("score-section");
    sectionSelect.value = "Grade 11 - ABM";
    window.loadScoreSheet();
    assert.equal(document.querySelectorAll("#score-table-head .score-grid-category").length, 0, "ABM starts clean without STEM categories");
    assert.match(document.getElementById("score-weight-summary").textContent, /No grading categories set up for Grade 11 - ABM/);

    // Configure Grade 11 - ABM with its OWN grading system, including a same-named "Written Work" at a DIFFERENT weight (25%)
    window.openGradingSetup();
    rows = [...document.querySelectorAll("#grading-weight-rows .grading-weight-row")];
    assert.equal(rows.length, 1, "unconfigured section starts with one blank 100% row");
    setGradingRow(rows[0], "Written Work", 25);
    click(window, document.getElementById("add-grade-category-btn"));
    rows = [...document.querySelectorAll("#grading-weight-rows .grading-weight-row")];
    setGradingRow(rows[1], "Lab Practical", 45);
    click(window, document.getElementById("add-grade-category-btn"));
    rows = [...document.querySelectorAll("#grading-weight-rows .grading-weight-row")];
    setGradingRow(rows[2], "Final Exam", 20);
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => /must total 100%/.test(document.getElementById("grading-setup-error").textContent));
    assert.match(document.getElementById("grading-setup-error").textContent, /Current total: 90%/);

    setGradingRow(rows[2], "Final Exam", 30);
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => db.grading_categories.filter(row => row.section === "Grade 11 - ABM" && !row.archived).length === 3);
    assert.equal(document.querySelectorAll("#score-table-head .score-grid-category").length, 3, "ABM shows its 3 categories");
    assert.match(document.getElementById("score-weight-summary").textContent, /Written Work 25% · Lab Practical 45% · Final Exam 30%/);

    // Switch back to Grade 11 - STEM: STEM's 2 categories and weights (60% / 40%) are completely untouched!
    sectionSelect.value = "Grade 11 - STEM";
    window.loadScoreSheet();
    assert.equal(document.querySelectorAll("#score-table-head .score-grid-category").length, 2, "STEM still shows its 2 categories");
    assert.match(document.getElementById("score-weight-summary").textContent, /Written Work 60% · Project 40%/);
    assert.equal(document.querySelectorAll("#score-table-body tr").length, 3);
    assert.equal(document.querySelectorAll("#score-table-body tr:first-child .score-input").length, 2, "all STEM category cells visible");

    const writtenId = db.grading_categories.find(row => row.section === "Grade 11 - STEM" && row.name === "Written Work").id;
    const projectId = db.grading_categories.find(row => row.section === "Grade 11 - STEM" && row.name === "Project").id;
    let maxInput = document.querySelector(`#score-table-head .score-column-max[data-category-id="${writtenId}"]`);
    maxInput.value = "50";
    maxInput.dispatchEvent(new window.Event("change", { bubbles: true }));
    let firstScore = document.querySelector(`#score-table-body .score-input[data-category-id="${writtenId}"]`);
    firstScore.value = "40";
    firstScore.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => db.scores.some(row => row.category_id === writtenId && row.score === 40));
    let finalCell = document.querySelector("#score-table-body .final-grade-cell");
    assert.match(finalCell.textContent, /80\.00%/);
    assert.match(finalCell.textContent, /Running · 60% weighted/);

    maxInput = document.querySelector(`#score-table-head .score-column-max[data-category-id="${projectId}"]`);
    maxInput.value = "100";
    maxInput.dispatchEvent(new window.Event("change", { bubbles: true }));
    firstScore = document.querySelector(`#score-table-body .score-input[data-category-id="${projectId}"]`);
    firstScore.value = "60";
    firstScore.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => db.scores.some(row => row.category_id === projectId && row.score === 60));
    assert.equal(document.querySelector(`#score-table-head .score-column-max[data-category-id="${writtenId}"]`).value, "50", "one column's Max does not change another column");
    finalCell = document.querySelector("#score-table-body .final-grade-cell");
    assert.match(finalCell.textContent, /72\.00%/);
    assert.match(finalCell.textContent, /Final/);

    // Re-weight STEM to 50/50 -> ABM's Written Work (25%) stays untouched!
    window.openGradingSetup();
    rows = [...document.querySelectorAll("#grading-weight-rows .grading-weight-row")];
    rows.forEach(row => {
        const name = row.querySelector(".grading-category-name").value;
        if (name === "Written Work" || name === "Project") row.querySelector(".grading-category-weight").value = "50";
    });
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => db.scores.filter(row => row.student_id === "2026-0001" && row.date === date)
        .every(row => row.category_weight === 50), { label: "existing STEM score weights updated" });

    assert.equal(
        db.grading_categories.find(row => row.section === "Grade 11 - ABM" && row.name === "Written Work").weight,
        25,
        "editing STEM weights never changes ABM weights"
    );

    finalCell = document.querySelector("#score-table-body .final-grade-cell");
    assert.match(finalCell.textContent, /70\.00%/, "final grade recalculates after section weights change");
    assert.match(finalCell.textContent, /Final/);
    assert.ok(db.scores.every(row => row.category_id && row.category_name && row.grading_period), "every score keeps its category metadata");

    const renamedCategoryId = db.grading_categories.find(row => row.section === "Grade 11 - STEM" && row.name === "Project").id;
    window.openGradingSetup();
    rows = [...document.querySelectorAll("#grading-weight-rows .grading-weight-row")];
    rows.find(row => row.querySelector(".grading-category-name").value === "Project")
        .querySelector(".grading-category-name").value = "Performance Task";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => db.scores.some(row => row.category_name === "Performance Task"), { label: "category rename updates scores" });
    assert.equal(db.scores.length, 2, "renaming a category does not duplicate scores");
    assert.equal(db.scores.find(row => row.category_name === "Performance Task").category_id, renamedCategoryId);
    assert.equal(db.scores.some(row => row.category_name === "Project"), false);
    assert.match(document.querySelector("#score-table-body .final-grade-cell").textContent, /70\.00%/);

    await window.pushFullStateToCloud();
    assert.equal(db.grading_categories.filter(r => !r.archived).length, 5, "full restore retains STEM (2) + ABM (3) independent categories");
    assert.equal(db.section_grading_categories.length, 5, "full restore retains both sections' category mappings");
    assert.equal(db.scores.length, 2, "full restore retains scores");
    assert.ok(db.scores.every(row => row.category_id && ["Written Work", "Performance Task"].includes(row.category_name)));
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

test("offline score replay reconciles backfilled categories and self-heals missing category rows", async (t) => {
    const db = dbWithToday();
    const backfilledId = "1e4eaa85-e640-44e1-ade6-bb7f3d8ef605";
    db.grading_categories = [
        { id: backfilledId, user_id: "user-1", section: "Grade 11 - STEM", name: "General", weight: 100, archived: false }
    ];
    db.section_grading_categories = [
        { id: 1, user_id: "user-1", section: "Grade 11 - STEM", category_id: backfilledId }
    ];
    db.scores = [
        {
            id: 1,
            user_id: "user-1",
            date: "2026-10-24",
            student_id: "2026-0001",
            subject: "General",
            grading_period: "General",
            category_id: backfilledId,
            category_name: "General",
            category_weight: 100,
            score: 89,
            max_score: 100
        }
    ];

    const queuedCategories = [
        { id: "5286d18a-f6c5-4258-b9f0-81ab8b369261", name: "Written Work", weight: 25 },
        { id: "f70fb10a-5d8e-4eda-988d-fbfb9be6ca80", name: "Performance Task", weight: 35 },
        { id: "0431b045-c56e-415b-9c95-4fa0269cc3c8", name: "Quarterly Exam", weight: 25 },
        { id: "f09c44ea-94f1-4130-870c-0cf0b11b352a", name: "Project", weight: 15 }
    ];
    const pendingOps = queuedCategories.map((cat, idx) => ({
        t: "scr",
        date: "2026-10-24",
        section: "Grade 11 - STEM",
        student_id: "2026-0001",
        grading_period: "General",
        category_id: cat.id,
        category_name: cat.name,
        category_weight: cat.weight,
        score: 80 + idx * 5,
        max_score: 100
    }));

    const client = createFakeSupabase({ db, enforceGradingConstraints: true });
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
            window.localStorage.setItem("scholog_app_data_user-1_pending", JSON.stringify(pendingOps));
        }
    });
    t.after(() => page.dom.window.close());

    await waitFor(() => {
        const remaining = JSON.parse(page.window.localStorage.getItem("scholog_app_data_user-1_pending") || "[]");
        return remaining.length === 0;
    }, { label: "offline score queue flushed" });

    assert.equal(db.scores.length, 5, "historical score + four replayed category scores are all stored");
    for (const cat of queuedCategories) {
        assert.ok(
            db.grading_categories.some((c) => c.id === cat.id && c.section === "Grade 11 - STEM" && c.name === cat.name && !c.archived),
            `created section category ${cat.name}`
        );
        assert.ok(db.scores.some((s) => s.category_id === cat.id && s.student_id === "2026-0001"), `synced score for ${cat.name}`);
    }
    const sectionWeight = db.grading_categories
        .filter((c) => c.section === "Grade 11 - STEM" && !c.archived)
        .reduce((sum, c) => sum + Number(c.weight), 0);
    assert.equal(sectionWeight, 100, "backfilled placeholder was archived so section weights remain 100%");
});

test("offline gradingConfig replay merges same-name backfilled category and preserves unsynced edits on failure", async (t) => {
    const db = dbWithToday();
    const backfilledId = "1e4eaa85-e640-44e1-ade6-bb7f3d8ef605";
    db.grading_categories = [
        { id: backfilledId, user_id: "user-1", section: "Grade 11 - STEM", name: "General", weight: 100, archived: false }
    ];
    db.scores = [
        {
            id: 1,
            user_id: "user-1",
            date: "2026-10-24",
            student_id: "2026-0001",
            subject: "General",
            grading_period: "General",
            category_id: backfilledId,
            category_name: "General",
            category_weight: 100,
            score: 89,
            max_score: 100
        }
    ];

    const clientGeneralId = "5286d18a-f6c5-4258-b9f0-81ab8b369261";
    const clientQuizId = "f70fb10a-5d8e-4eda-988d-fbfb9be6ca80";
    const pendingOps = [
        {
            t: "gradingConfig",
            section: "Grade 11 - STEM",
            categories: [
                { id: clientGeneralId, name: "General", weight: 40 },
                { id: clientQuizId, name: "Quizzes", weight: 60 }
            ],
            selectedIds: [clientGeneralId, clientQuizId]
        },
        {
            t: "scr",
            date: "2026-10-24",
            student_id: "2026-0001",
            grading_period: "General",
            category_id: clientQuizId,
            category_name: "Quizzes",
            category_weight: 60,
            score: 95,
            max_score: 100
        }
    ];

    // First boot while scores writes are failing: unsynced scores must stay cached locally.
    const failingClient = createFakeSupabase({ db, failTable: "scores", enforceGradingConstraints: true });
    const firstLoad = loadPage({
        html: "main.html",
        scripts: ["pdf.js", "main.js"],
        url: "https://scholog.test/main.html#scores",
        beforeParse(window) {
            installSupabaseStub(window, failingClient);
            installLucideStub(window);
            window.qrcode = makeFakeQr();
            window.jspdf = { jsPDF: makeFakeJsPdf().FakeJsPDF };
            window.localStorage.setItem("scholog_app_data_user-1_pending", JSON.stringify(pendingOps));
        }
    });
    t.after(() => firstLoad.dom.window.close());

    await waitFor(() => firstLoad.window.document.getElementById("stat-total").textContent !== "0"
        || !firstLoad.window.document.getElementById("view-scores").classList.contains("hidden"));
    await sleep(60);

    const remainingAfterFailure = JSON.parse(firstLoad.window.localStorage.getItem("scholog_app_data_user-1_pending") || "[]");
    assert.equal(remainingAfterFailure.length, 2, "failed ops remain queued for retry");
    const cachedAfterFailure = JSON.parse(firstLoad.window.localStorage.getItem("scholog_app_data_user-1") || "{}");
    assert.ok(
        Object.values(cachedAfterFailure.scores || {}).some((s) => s.category_id === clientQuizId && s.score === 95),
        "unsynced offline score is preserved in local cache across reload"
    );

    // Second boot once backend is healthy: everything flushes cleanly without duplicate name collision.
    const healthyClient = createFakeSupabase({ db, enforceGradingConstraints: true });
    const secondLoad = loadPage({
        html: "main.html",
        scripts: ["pdf.js", "main.js"],
        url: "https://scholog.test/main.html#scores",
        beforeParse(window) {
            installSupabaseStub(window, healthyClient);
            installLucideStub(window);
            window.qrcode = makeFakeQr();
            window.jspdf = { jsPDF: makeFakeJsPdf().FakeJsPDF };
            window.localStorage.setItem("scholog_app_data_user-1", JSON.stringify(cachedAfterFailure));
            window.localStorage.setItem("scholog_app_data_user-1_pending", JSON.stringify(remainingAfterFailure));
        }
    });
    t.after(() => secondLoad.dom.window.close());

    await waitFor(() => {
        const remaining = JSON.parse(secondLoad.window.localStorage.getItem("scholog_app_data_user-1_pending") || "[]");
        return remaining.length === 0;
    }, { label: "pending queue emptied after backend recovery" });

    assert.equal(db.grading_categories.length, 2);
    assert.equal(db.grading_categories.some((c) => c.id === backfilledId), false, "merged away old backfilled ID");
    assert.equal(db.scores.find((s) => s.score === 89).category_id, clientGeneralId, "historical General score re-linked to client General ID");
    assert.ok(db.scores.some((s) => s.category_id === clientQuizId && s.score === 95), "queued Quizzes score synced");
});

test("removing a scored category archives it safely and section rename preserves section grading setup", async (t) => {
    const { window, db, dom } = await bootMainApp({ clientOptions: { enforceGradingConstraints: true } });
    t.after(() => dom.window.close());
    const document = window.document;

    window.switchTab("scores");
    await waitFor(() => document.getElementById("view-scores").classList.contains("hidden") === false);
    await sleep(30);

    // Configure Grade 11 - STEM with Quiz (40%) + Midterm (60%)
    window.openGradingSetup();
    setGradingRow(document.querySelector("#grading-weight-rows .grading-weight-row"), "Quiz", 40);
    click(window, document.getElementById("add-grade-category-btn"));
    let rows = [...document.querySelectorAll("#grading-weight-rows .grading-weight-row")];
    setGradingRow(rows[1], "Midterm", 60);
    const form = document.getElementById("form-grading-setup");
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => db.grading_categories.filter(c => c.section === "Grade 11 - STEM" && !c.archived).length === 2);

    const quizId = db.grading_categories.find(c => c.section === "Grade 11 - STEM" && c.name === "Quiz").id;
    const quizInput = document.querySelector(`#score-table-body .score-input[data-category-id="${quizId}"]`);
    quizInput.value = "85";
    quizInput.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => db.scores.some(s => s.category_id === quizId && s.score === 85));

    // Remove Quiz (which has a saved score) and set Midterm to 100%
    window.openGradingSetup();
    rows = [...document.querySelectorAll("#grading-weight-rows .grading-weight-row")];
    click(window, rows.find(r => r.querySelector(".grading-category-name").value === "Quiz").querySelector(".grading-category-remove"));
    rows = [...document.querySelectorAll("#grading-weight-rows .grading-weight-row")];
    assert.equal(rows.length, 1);
    setGradingRow(rows[0], "Midterm", 100);
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => db.grading_categories.find(c => c.id === quizId)?.archived === true);

    assert.equal(document.querySelectorAll("#score-table-head .score-grid-category").length, 1, "archived Quiz column is hidden");
    assert.ok(db.scores.some(s => s.category_id === quizId), "historical Quiz score row remains preserved in DB");

    // Re-adding a new "Quiz" category later does not collide with the archived row
    window.openGradingSetup();
    rows = [...document.querySelectorAll("#grading-weight-rows .grading-weight-row")];
    setGradingRow(rows[0], "Midterm", 70);
    click(window, document.getElementById("add-grade-category-btn"));
    rows = [...document.querySelectorAll("#grading-weight-rows .grading-weight-row")];
    setGradingRow(rows[1], "Quiz", 30);
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => db.grading_categories.filter(c => c.section === "Grade 11 - STEM" && !c.archived).length === 2);

    // Rename "Grade 11 - STEM" -> "Grade 11 - STEM A" and verify its categories follow the renamed section
    window.switchTab("directory");
    window.openEditSectionModal("Grade 11 - STEM");
    document.getElementById("new-section-name").value = "Grade 11 - STEM A";
    document.querySelector("#modal-section form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => db.grading_categories.filter(c => c.section === "Grade 11 - STEM A" && !c.archived).length === 2);

    window.switchTab("scores");
    document.getElementById("score-section").value = "Grade 11 - STEM A";
    window.loadScoreSheet();
    assert.equal(document.querySelectorAll("#score-table-head .score-grid-category").length, 2, "renamed section keeps its categories");
});

test("student scores: categories support multiple subsections (e.g. 6 Written Works, Quizzes, Performance Tasks) with independent Max scores", async (t) => {
    const { window, db, dom } = await bootMainApp({ clientOptions: { enforceGradingConstraints: true } });
    t.after(() => dom.window.close());
    const document = window.document;
    const date = todayStr();

    window.switchTab("scores");
    await waitFor(() => document.getElementById("view-scores").classList.contains("hidden") === false);
    await sleep(30);
    document.getElementById("score-period").value = "Quarter 1";

    // Configure Grade 11 - STEM with:
    // - Written Work (6 subsections, 30% weight)
    // - Quiz (2 subsections, 20% weight)
    // - Performance Task (2 subsections, 50% weight)
    window.openGradingSetup();
    let rows = [...document.querySelectorAll("#grading-weight-rows .grading-weight-row")];
    setGradingRow(rows[0], "Written Work", 30, 6);
    click(window, document.getElementById("add-grade-category-btn"));
    rows = [...document.querySelectorAll("#grading-weight-rows .grading-weight-row")];
    setGradingRow(rows[1], "Quiz", 20, 2);
    click(window, document.getElementById("add-grade-category-btn"));
    rows = [...document.querySelectorAll("#grading-weight-rows .grading-weight-row")];
    setGradingRow(rows[2], "Performance Task", 50, 2);

    const form = document.getElementById("form-grading-setup");
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => db.grading_categories.filter(c => c.section === "Grade 11 - STEM" && !c.archived).length === 3);

    const wwCat = db.grading_categories.find(c => c.section === "Grade 11 - STEM" && c.name === "Written Work");
    const quizCat = db.grading_categories.find(c => c.section === "Grade 11 - STEM" && c.name === "Quiz");
    const ptCat = db.grading_categories.find(c => c.section === "Grade 11 - STEM" && c.name === "Performance Task");
    assert.equal(wwCat.items.length, 6, "Written Work created with 6 subsections");
    assert.equal(quizCat.items.length, 2, "Quiz created with 2 subsections");
    assert.equal(ptCat.items.length, 2, "Performance Task created with 2 subsections");

    // Grouped header spans match subsection counts (6 + 2 + 2 = 10 total item columns)
    const groupHeaders = [...document.querySelectorAll("#score-table-head .score-grid-category-group")];
    assert.equal(groupHeaders.length, 3);
    assert.equal(groupHeaders[0].getAttribute("colspan"), "6");
    assert.equal(groupHeaders[1].getAttribute("colspan"), "2");
    assert.equal(groupHeaders[2].getAttribute("colspan"), "2");
    assert.equal(document.querySelectorAll("#score-table-head .score-grid-category").length, 10);
    assert.match(
        document.getElementById("score-weight-summary").textContent,
        /Written Work 30% \(6 items\) · Quiz 20% \(2 items\) · Performance Task 50% \(2 items\)/
    );

    // Add a 3rd Quiz subsection directly from the spreadsheet header (+ Add), then remove it (×)
    const addQuizBtn = groupHeaders[1].querySelector(".score-add-item-btn");
    click(window, addQuizBtn);
    await waitFor(() => db.grading_categories.find(c => c.id === quizCat.id).items.length === 3);
    assert.equal(document.querySelectorAll(`#score-table-head .score-grid-category[data-category-id="${quizCat.id}"]`).length, 3);

    const quizItemHeaders = [...document.querySelectorAll(`#score-table-head .score-grid-category[data-category-id="${quizCat.id}"]`)];
    click(window, quizItemHeaders[2].querySelector(".score-remove-item-btn"));
    await waitFor(() => db.grading_categories.find(c => c.id === quizCat.id).items.length === 2);
    assert.equal(document.querySelectorAll(`#score-table-head .score-grid-category[data-category-id="${quizCat.id}"]`).length, 2);

    // Rename Written Work #1 -> "WW 1" inline in the spreadsheet header
    const ww1Header = document.querySelector(`#score-table-head .score-grid-category[data-category-id="${wwCat.id}"]`);
    const ww1LabelInput = ww1Header.querySelector(".score-item-label-input");
    ww1LabelInput.value = "WW 1";
    ww1LabelInput.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => db.grading_categories.find(c => c.id === wwCat.id).items[0].label === "WW 1");

    // Set distinct non-100 Max scores on each of the 6 Written Works: 15, 20, 25, 30, 50, 100 (sum = 240)
    const wwMaxes = [15, 20, 25, 30, 50, 100];
    const wwScores = [12, 18, 20, 27, 45, 94]; // sum = 216 -> 216 / 240 = 90.00%
    const wwMaxInputs = [...document.querySelectorAll(`#score-table-head .score-column-max[data-category-id="${wwCat.id}"]`)];
    assert.equal(wwMaxInputs.length, 6);
    for (let i = 0; i < 6; i++) {
        wwMaxInputs[i].value = String(wwMaxes[i]);
        wwMaxInputs[i].dispatchEvent(new window.Event("change", { bubbles: true }));
    }

    // Enter Juan Dela Cruz's scores for the first 5 Written Works -> still Running (not all 6 items scored yet)
    const firstRowWwInputs = [...document.querySelectorAll(`#score-table-body tr:first-child .score-input[data-category-id="${wwCat.id}"]`)];
    assert.equal(firstRowWwInputs.length, 6);
    for (let i = 0; i < 5; i++) {
        assert.equal(firstRowWwInputs[i].max, String(wwMaxes[i]));
        firstRowWwInputs[i].value = String(wwScores[i]);
        firstRowWwInputs[i].dispatchEvent(new window.Event("change", { bubbles: true }));
    }
    await waitFor(() => db.scores.filter(s => s.category_id === wwCat.id && s.student_id === "2026-0001").length === 5);

    // Enter the 6th Written Work score -> Written Work is now 216/240 = 90.00%, Running · 30% weighted
    firstRowWwInputs[5].value = String(wwScores[5]);
    firstRowWwInputs[5].dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => db.scores.filter(s => s.category_id === wwCat.id && s.student_id === "2026-0001").length === 6);
    assert.equal(db.scores.find(s => s.category_id === wwCat.id && s.score === 12).item_label, "WW 1");

    let finalCell = document.querySelector("#score-table-body tr:first-child .final-grade-cell");
    assert.match(finalCell.textContent, /90\.00%/);
    assert.match(finalCell.textContent, /Running · 30% weighted/);

    // Switch calendar date forward (e.g. next class meeting) within Quarter 1:
    // previously graded Written Works stay visible on the Quarter 1 sheet!
    document.getElementById("score-date").value = "2026-10-26";
    window.loadScoreSheet();
    const restoredWwInputs = [...document.querySelectorAll(`#score-table-body tr:first-child .score-input[data-category-id="${wwCat.id}"]`)];
    assert.deepEqual(restoredWwInputs.map(el => el.value), wwScores.map(String), "scores from earlier dates in the quarter stay visible");

    // Grade Quiz subsections (15/20 + 25/30 = 40/50 = 80.00% * 20% weight) and Performance Task subsections (36/40 + 54/60 = 90/100 = 90.00% * 50% weight)
    const quizMaxInputs = [...document.querySelectorAll(`#score-table-head .score-column-max[data-category-id="${quizCat.id}"]`)];
    quizMaxInputs[0].value = "20";
    quizMaxInputs[0].dispatchEvent(new window.Event("change", { bubbles: true }));
    quizMaxInputs[1].value = "30";
    quizMaxInputs[1].dispatchEvent(new window.Event("change", { bubbles: true }));

    const firstRowQuizInputs = [...document.querySelectorAll(`#score-table-body tr:first-child .score-input[data-category-id="${quizCat.id}"]`)];
    firstRowQuizInputs[0].value = "15";
    firstRowQuizInputs[0].dispatchEvent(new window.Event("change", { bubbles: true }));
    firstRowQuizInputs[1].value = "25";
    firstRowQuizInputs[1].dispatchEvent(new window.Event("change", { bubbles: true }));

    const ptMaxInputs = [...document.querySelectorAll(`#score-table-head .score-column-max[data-category-id="${ptCat.id}"]`)];
    ptMaxInputs[0].value = "40";
    ptMaxInputs[0].dispatchEvent(new window.Event("change", { bubbles: true }));
    ptMaxInputs[1].value = "60";
    ptMaxInputs[1].dispatchEvent(new window.Event("change", { bubbles: true }));

    const firstRowPtInputs = [...document.querySelectorAll(`#score-table-body tr:first-child .score-input[data-category-id="${ptCat.id}"]`)];
    firstRowPtInputs[0].value = "36";
    firstRowPtInputs[0].dispatchEvent(new window.Event("change", { bubbles: true }));
    // Before last PT subsection is entered, status is still Running even though all 3 categories have >=1 score!
    await waitFor(() => db.scores.filter(s => s.student_id === "2026-0001").length === 9);
    finalCell = document.querySelector("#score-table-body tr:first-child .final-grade-cell");
    assert.match(finalCell.textContent, /Running/, "final grade remains Running until every subsection in weighted categories is scored");

    firstRowPtInputs[1].value = "54";
    firstRowPtInputs[1].dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => db.scores.filter(s => s.student_id === "2026-0001").length === 10);

    // Weighted Final Grade: 90% * 0.30 + 80% * 0.20 + 90% * 0.50 = 27 + 16 + 45 = 88.00% Final
    finalCell = document.querySelector("#score-table-body tr:first-child .final-grade-cell");
    assert.match(finalCell.textContent, /88\.00%/);
    assert.match(finalCell.textContent, /Final/);
    assert.equal(db.scores.filter(s => s.student_id === "2026-0001" && s.date === date).length, 6, "earlier-date scores kept their original date");
    assert.equal(db.scores.filter(s => s.student_id === "2026-0001" && s.date === "2026-10-26").length, 4, "newly entered subsections stamped with current date");
});


