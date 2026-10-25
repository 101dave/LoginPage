// Grading schemes: one account, two school levels.
//
// High school follows DepEd's terms (DO 015 s. 2026), college follows
// Prelim/Midterm/Semi-Final/Final. The period structure is per SECTION, so a
// teacher handling both never has to choose one for the whole account.
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase, defaultDb, loadPage, waitFor, sleep } from "./helpers.mjs";
import { installLucideStub, installSupabaseStub, makeFakeJsPdf, makeFakeQr, todayStr } from "./stubs.mjs";

const SHS = "Grade 11 - STEM";
const COLLEGE = "BSIT 1-A";

function boot(overrides = {}) {
    const db = overrides.db || defaultDb();
    // Give the account a college section too: same teacher, two school levels.
    if (!db.sections.some((section) => section.name === COLLEGE)) {
        db.sections.push({ id: 3, user_id: "user-1", name: COLLEGE });
        db.students.push({
            id: "31", user_id: "user-1", student_id: "2026-0301",
            name: "Bea Cruz", email: "", section: COLLEGE
        });
    }
    const client = createFakeSupabase({ db, enforceGradingConstraints: true });
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
    const realToast = page.window.showToast;
    page.window.showToast = (message, type) => {
        page.window.__toasts.push({ message, type });
        return realToast(message, type);
    };
    return { ...page, client, db };
}

async function bootReady() {
    const ctx = boot();
    await waitFor(() => ctx.window.document.getElementById("stat-total").textContent !== "0", {
        label: "dashboard data"
    });
    return ctx;
}

/** Select a tab and a section, the way a teacher does. */
async function openScores(window, section) {
    window.switchTab("scores");
    const select = window.document.getElementById("score-section");
    select.value = section;
    window.onScoreSectionChange();
    await sleep(60);
}

/** Save a scheme through the modal, not by poking state. */
async function saveScheme(window, { preset, periods = null, finalRule = "average", transmute = false }) {
    window.openGradingSetup();
    const document = window.document;
    document.getElementById("grading-preset").value = preset;
    window.applyGradingPreset();
    if (periods) {
        const rows = document.getElementById("grading-period-rows");
        rows.innerHTML = periods
            .map((period) => window.gradingPeriodRowMarkup(period))
            .join("");
    }
    document.getElementById("grading-final-rule").value = finalRule;
    document.getElementById("grading-transmute").checked = transmute;
    // Presets prefill official component weights; fall back to one 100% category
    // so the fixture is valid for the "custom" presets too.
    const rows = Array.from(document.querySelectorAll("#grading-weight-rows .grading-weight-row"));
    if (!rows.some((row) => row.querySelector(".grading-category-name").value.trim())) {
        if (rows.length === 0) window.addGradingCategoryRow();
        const row = document.querySelector("#grading-weight-rows .grading-weight-row");
        row.querySelector(".grading-category-name").value = "Written Work";
        row.querySelector(".grading-category-weight").value = 100;
        Array.from(document.querySelectorAll("#grading-weight-rows .grading-weight-row"))
            .slice(1)
            .forEach((extra) => extra.querySelector(".grading-category-weight").value = 0);
    }
    document.getElementById("form-grading-setup").dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true })
    );
    await sleep(200);
}

/** Save a score the way the sheet does. */
async function score(window, { studentId, period, value, max = 100, date = todayStr() }) {
    const section = window.document.getElementById("score-section").value;
    const category = window.getSectionGradeCategories(section)[0];
    assert.ok(category, "the section has a grading category");
    await window.setStudentScore(date, studentId, period, category.id, category.items[0].id, value, max, category.name, category.items[0].label);
    await sleep(120);
}

// ---------------------------------------------------------------------------
// 1. Period structure per section
// ---------------------------------------------------------------------------

test("a high-school section can use DepEd terms while another section keeps quarters", async (t) => {
    const { window, dom } = await bootReady();
    t.after(() => dom.window.close());

    await openScores(window, SHS);
    await saveScheme(window, { preset: "k12-terms" });

    await openScores(window, COLLEGE);
    await saveScheme(window, { preset: "college-semestral" });

    const periodOptions = (section) => {
        window.document.getElementById("score-section").value = section;
        window.populatePeriodSelect();
        return Array.from(window.document.getElementById("score-period").options).map((option) => option.value);
    };

    assert.deepEqual(periodOptions(SHS), ["General", "Term 1", "Term 2", "Term 3"]);
    assert.deepEqual(periodOptions(COLLEGE), ["General", "Prelim", "Midterm", "Semi-Final", "Final"]);
});

test("the scheme is stored per section and reaches the cloud", async (t) => {
    const { window, dom, db } = await bootReady();
    t.after(() => dom.window.close());

    await openScores(window, SHS);
    await saveScheme(window, { preset: "k12-terms", finalRule: "average", transmute: true });
    await waitFor(() => db.section_grading_schemes.length === 1, { label: "scheme row" });

    const row = db.section_grading_schemes[0];
    assert.equal(row.section, SHS);
    assert.equal(row.preset, "k12-terms");
    assert.equal(row.final_rule, "average");
    assert.equal(row.transmute, true);
    // Arrays come from the jsdom realm, so compare copies.
    assert.deepEqual(Array.from(row.periods, (period) => period.name), ["Term 1", "Term 2", "Term 3"]);
});

test("a section with no scheme keeps the legacy quarters and semesters", async (t) => {
    const { window, dom } = await bootReady();
    t.after(() => dom.window.close());

    await openScores(window, COLLEGE);
    const values = Array.from(window.document.getElementById("score-period").options).map((option) => option.value);
    assert.deepEqual(values, ["General", "Quarter 1", "Quarter 2", "Quarter 3", "Quarter 4", "Semester 1", "Semester 2"]);
});

// ---------------------------------------------------------------------------
// 2. Final grade across periods
// ---------------------------------------------------------------------------

test("DepEd terms: final grade is the average of the term grades", async (t) => {
    const { window, dom } = await bootReady();
    t.after(() => dom.window.close());

    await openScores(window, SHS);
    await saveScheme(window, { preset: "k12-terms", transmute: false });

    await score(window, { studentId: "2026-0001", period: "Term 1", value: 80 });
    await score(window, { studentId: "2026-0001", period: "Term 2", value: 90 });
    await score(window, { studentId: "2026-0001", period: "Term 3", value: 100 });

    const result = window.calculateSectionFinalGrade("2026-0001", SHS);
    assert.deepEqual(Array.from(result.periods, (period) => period.grade), [80, 90, 100]);
    assert.equal(Number(result.final.toFixed(2)), 90, "(80 + 90 + 100) / 3");
    assert.equal(result.descriptor, "Advancing");
    assert.equal(result.transmuted, false);
});

test("college: weighted periods decide the final grade", async (t) => {
    const { window, dom } = await bootReady();
    t.after(() => dom.window.close());

    await openScores(window, COLLEGE);
    await saveScheme(window, {
        preset: "college-semestral",
        finalRule: "weighted",
        periods: [
            { name: "Prelim", weight: 20 },
            { name: "Midterm", weight: 20 },
            { name: "Semi-Final", weight: 25 },
            { name: "Final", weight: 35 }
        ]
    });

    await score(window, { studentId: "2026-0301", period: "Prelim", value: 90 });
    await score(window, { studentId: "2026-0301", period: "Midterm", value: 80 });
    await score(window, { studentId: "2026-0301", period: "Semi-Final", value: 70 });
    await score(window, { studentId: "2026-0301", period: "Final", value: 100 });

    const result = window.calculateSectionFinalGrade("2026-0301", COLLEGE);
    // 90*.2 + 80*.2 + 70*.25 + 100*.35 = 18 + 16 + 17.5 + 35 = 86.5
    assert.equal(Number(result.final.toFixed(2)), 86.5);
    assert.equal(result.descriptor, "Benchmarking");
});

test("a period with no score leaves the final grade running, it does not become zero", async (t) => {
    const { window, dom } = await bootReady();
    t.after(() => dom.window.close());

    await openScores(window, SHS);
    await saveScheme(window, { preset: "k12-terms", transmute: false });
    await score(window, { studentId: "2026-0002", period: "Term 1", value: 88 });

    const result = window.calculateSectionFinalGrade("2026-0002", SHS);
    assert.equal(Number(result.final.toFixed(2)), 88, "only the graded term counts");
    assert.equal(result.complete, false, "but the final grade is flagged as not final");
});

test("transmutation raises a raw grade below 70 to 75 and says so", async (t) => {
    const { window, dom } = await bootReady();
    t.after(() => dom.window.close());

    await openScores(window, SHS);
    await saveScheme(window, { preset: "k12-terms", transmute: true });

    for (const term of ["Term 1", "Term 2", "Term 3"]) {
        await score(window, { studentId: "2026-0003", period: term, value: 60 });
    }

    const result = window.calculateSectionFinalGrade("2026-0003", SHS);
    assert.equal(Number(result.raw.toFixed(2)), 60);
    assert.equal(result.final, 75);
    assert.equal(result.transmuted, true);
    assert.equal(result.descriptor, "Connecting");
});

test("transmutation off keeps the raw grade", async (t) => {
    const { window, dom } = await bootReady();
    t.after(() => dom.window.close());

    await openScores(window, SHS);
    await saveScheme(window, { preset: "college-semestral", finalRule: "average", transmute: false });
    await score(window, { studentId: "2026-0001", period: "Prelim", value: 60 });

    const result = window.calculateSectionFinalGrade("2026-0001", SHS);
    assert.equal(Number(result.final.toFixed(2)), 60);
    assert.equal(result.transmuted, false);
});

// ---------------------------------------------------------------------------
// 3. The grade a teacher reads on screen
// ---------------------------------------------------------------------------

test("the Final Grades table shows every period, the final grade and the descriptor", async (t) => {
    const { window, dom } = await bootReady();
    t.after(() => dom.window.close());

    await openScores(window, SHS);
    await saveScheme(window, { preset: "k12-terms", transmute: false });
    for (const term of ["Term 1", "Term 2", "Term 3"]) {
        await score(window, { studentId: "2026-0001", period: term, value: 90 });
    }
    await openScores(window, SHS);

    const head = window.document.getElementById("grade-summary-head").textContent;
    assert.match(head, /Term 1/);
    assert.match(head, /Term 3/);
    assert.match(head, /Final Grade/);

    const rows = Array.from(window.document.querySelectorAll("#grade-summary-body tr"));
    const juan = rows.find((row) => row.textContent.includes("2026-0001"));
    assert.ok(juan, "the learner has a row");
    assert.match(juan.textContent, /90\.00/);
    assert.match(juan.textContent, /Advancing/);
});

// ---------------------------------------------------------------------------
// 4. Invalid schemes are refused
// ---------------------------------------------------------------------------

test("a duplicate period name is refused with a clear message", async (t) => {
    const { window, dom, db } = await bootReady();
    t.after(() => dom.window.close());

    await openScores(window, SHS);
    await saveScheme(window, {
        preset: "custom",
        periods: [{ name: "Term 1", weight: null }, { name: "term 1", weight: null }]
    });

    const error = window.document.getElementById("grading-setup-error");
    assert.match(error.textContent, /Duplicate grading period/i);
    assert.equal(db.section_grading_schemes.length, 0, "nothing was saved");
});

test("a weighted scheme with every share at 0% is refused", async (t) => {
    const { window, dom, db } = await bootReady();
    t.after(() => dom.window.close());

    await openScores(window, SHS);
    await saveScheme(window, {
        preset: "custom",
        finalRule: "weighted",
        periods: [{ name: "Grading 1", weight: 0 }, { name: "Grading 2", weight: 0 }]
    });

    const error = window.document.getElementById("grading-setup-error");
    assert.match(error.textContent, /above 0%/i);
    assert.equal(db.section_grading_schemes.length, 0);
});

test("period names cannot hijack the reserved legacy bucket", async (t) => {
    const { window, dom } = await bootReady();
    t.after(() => dom.window.close());

    await openScores(window, SHS);
    await saveScheme(window, { preset: "custom", periods: [{ name: "General", weight: null }] });
    assert.match(window.document.getElementById("grading-setup-error").textContent, /reserved/i);
});

// ---------------------------------------------------------------------------
// 5. CSV export
// ---------------------------------------------------------------------------

test("the final-grades CSV carries each period, the final grade and the descriptor", async (t) => {
    const { window, dom } = await bootReady();
    t.after(() => dom.window.close());

    const csv = window.SchologCsv.buildGradeSummaryCsv({
        section: SHS,
        structure: "High School — DO 015 s. 2026 (3 terms)",
        rule: "Average of periods",
        transmuted: true,
        date: "2026-10-25",
        periods: ["Term 1", "Term 2", "Term 3"],
        students: [
            { student_id: "2026-0001", name: "Juan Dela Cruz", periods: { "Term 1": 60, "Term 2": 60, "Term 3": 60 }, final: 75, raw: 60, transmuted: true, descriptor: "Connecting" }
        ]
    });

    assert.match(csv.text, /Term 1/);
    assert.match(csv.text, /Final Grade/);
    assert.match(csv.text, /75/, "the transmuted grade, not the raw 60");
    assert.match(csv.text, /Transmuted from 60\.00/);
    assert.match(csv.text, /Connecting/);
    assert.match(csv.filename, /^FinalGrades_/);
});

test("choosing the DepEd preset prefills Written Work 30 / Performance Task 30 / Term Exam 40", async (t) => {
    const { window, dom } = await bootReady();
    t.after(() => dom.window.close());

    await openScores(window, SHS);
    window.openGradingSetup();
    const document = window.document;
    document.getElementById("grading-preset").value = "k12-terms";
    window.applyGradingPreset();

    const rows = Array.from(document.querySelectorAll("#grading-weight-rows .grading-weight-row"));
    const model = rows.map((row) => ({
        name: row.querySelector(".grading-category-name").value,
        weight: Number(row.querySelector(".grading-category-weight").value)
    }));
    assert.deepEqual(JSON.parse(JSON.stringify(model)), [
        { name: "Written Work", weight: 30 },
        { name: "Performance Task", weight: 30 },
        { name: "Term Exam", weight: 40 }
    ]);
    assert.match(document.getElementById("grading-section-total").textContent, /100/);
});

test("switching presets never overwrites categories the teacher already typed", async (t) => {
    const { window, dom } = await bootReady();
    t.after(() => dom.window.close());

    await openScores(window, SHS);
    await saveScheme(window, { preset: "custom", periods: [{ name: "Grading 1", weight: null }] });

    window.openGradingSetup();
    const document = window.document;
    document.getElementById("grading-preset").value = "k12-terms";
    window.applyGradingPreset();

    const names = Array.from(document.querySelectorAll("#grading-weight-rows .grading-category-name"))
        .map((input) => input.value);
    assert.deepEqual(names, ["Written Work"], "the saved category is untouched");
});

test("a section without a scheme shows the periods it actually has scores for", async (t) => {
    const { window, dom } = await bootReady();
    t.after(() => dom.window.close());

    await openScores(window, SHS);
    // Keep the legacy period list, but the section still needs a category to
    // hold a score.
    await saveScheme(window, { preset: "legacy" });
    await score(window, { studentId: "2026-0001", period: "Semester 1", value: 91 });
    await openScores(window, SHS);

    const head = window.document.getElementById("grade-summary-head").textContent;
    assert.match(head, /Semester 1/, "the semester that holds data is a column");
    assert.doesNotMatch(head, /Quarter 1/, "no invented quarter column");
});
