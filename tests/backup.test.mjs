// Backup / restore round trip: every row in the app has to survive the JSON file.
//
// Regression cover for the bug where a score whose grading category had been
// renamed or deleted made the restore abort halfway: students and attendance
// came back, scores did not (and the scores already in the cloud were gone).
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase, defaultDb, loadPage, waitFor, sleep } from "./helpers.mjs";
import { installLucideStub, installSupabaseStub, makeFakeJsPdf, makeFakeQr } from "./stubs.mjs";

const DATE = "2026-10-23";
const SECTION = "Grade 11 - STEM";

const cat = (id, name, weight, items) => ({
    id, user_id: "user-1", section: SECTION, name, weight, items, archived: false
});
const score = (overrides) => ({
    date: DATE, student_id: "2026-0001", subject: "Quarter 1", grading_period: "Quarter 1",
    category_id: null, category_name: "General", category_weight: 100,
    item_id: null, item_label: null, score: 10, max_score: 20, ...overrides
});

function dbWith({ categories = [], scores = [] }) {
    const db = defaultDb();
    db.grading_categories = JSON.parse(JSON.stringify(categories));
    db.section_grading_categories = categories.map((c, i) => ({
        id: `sgc-${i}`, user_id: "user-1", section: c.section, category_id: c.id
    }));
    db.scores = scores.map((s, i) => ({ id: `s-${i}`, user_id: "user-1", ...s }));
    return db;
}

// Load the dashboard, click Backup, wipe the account, click Restore.
async function roundTrip(fixture) {
    const db = dbWith(fixture);
    const client = createFakeSupabase({ db, enforceGradingConstraints: true });
    const page = loadPage({
        html: "main.html",
        scripts: ["pdf.js", "main.js"],
        url: "https://scholog.test/main.html",
        beforeParse(window) {
            installSupabaseStub(window, client);
            installLucideStub(window);
            window.qrcode = makeFakeQr();
            window.jspdf = { jsPDF: makeFakeJsPdf().FakeJsPDF };
            window.__blob = null;
            window.URL.createObjectURL = (blob) => { window.__blob = blob; return "blob:mock"; };
            window.HTMLAnchorElement.prototype.click = function () {};
        }
    });
    const { window, dom } = page;
    await waitFor(() => window.document.getElementById("stat-total").textContent !== "0", { label: "dashboard data" });

    const toasts = [];
    const realToast = window.showToast;
    window.showToast = (message, type) => { toasts.push({ message, type }); return realToast(message, type); };

    // 1. What the Backup button writes to disk.
    window.exportDataBackup();
    await waitFor(() => window.__blob, { label: "backup blob" });
    const backup = JSON.parse(await window.__blob.text());
    const fileScores = Object.keys(backup.scores || {}).length;

    // 2. An account with nothing left in any table.
    db.scores = [];
    db.attendance = [];
    db.grading_categories = [];
    db.section_grading_categories = [];
    db.students = [];
    db.sections = [];

    // 3. Restore that file through the real handler.
    const file = new window.File([JSON.stringify(backup)], "backup.json", { type: "application/json" });
    window.importDataBackup({ target: { files: [file], value: "backup.json" } });
    await sleep(600);

    const result = {
        backup,
        fileScores,
        dbStudents: db.students.length,
        dbAttendance: db.attendance.length,
        dbScores: db.scores,
        dbCategories: db.grading_categories,
        toasts
    };
    dom.window.close();
    return result;
}

test("a clean backup round-trips students, attendance, categories and scores", async () => {
    const result = await roundTrip({
        categories: [
            cat("cat-ww", "Written Work", 30, [
                { id: "item-ww-1", label: "#1", max_score: 20 },
                { id: "item-ww-2", label: "#2", max_score: 30 }
            ]),
            cat("cat-pt", "Performance Task", 50, [{ id: "item-pt-1", label: "#1", max_score: 50 }])
        ],
        scores: [
            score({ student_id: "2026-0001", category_id: "cat-ww", category_name: "Written Work", category_weight: 30, item_id: "item-ww-1", item_label: "#1", score: 18, max_score: 20 }),
            score({ student_id: "2026-0001", category_id: "cat-ww", category_name: "Written Work", category_weight: 30, item_id: "item-ww-2", item_label: "#2", score: 27, max_score: 30 }),
            score({ student_id: "2026-0002", category_id: "cat-pt", category_name: "Performance Task", category_weight: 50, item_id: "item-pt-1", item_label: "#1", score: 44, max_score: 50 })
        ]
    });

    assert.equal(result.fileScores, 3, "the file itself contains the scores");
    assert.equal(result.dbStudents, 4, "students restored");
    assert.equal(result.dbScores.length, 3, "scores restored");
    assert.equal(result.dbCategories.length, 2, "grading categories restored");
    assert.ok(result.toasts.some((t) => /3 scores/.test(t.message)), "the toast reports what was restored");
});

test("a score whose category no longer exists is restored, not dropped", async () => {
    // "Quiz" was never set up (or was deleted) for this section: the old code
    // threw here and left the whole restore without scores.
    const result = await roundTrip({
        categories: [cat("cat-ww", "Written Work", 100, [{ id: "item-ww-1", label: "#1", max_score: 20 }])],
        scores: [
            score({ student_id: "2026-0001", category_id: null, category_name: "Quiz", category_weight: 0, score: 9, max_score: 10 })
        ]
    });

    assert.equal(result.fileScores, 1);
    assert.equal(result.dbScores.length, 1, "the orphaned score survives");
    assert.equal(Number(result.dbScores[0].score), 9);
    assert.ok(
        result.dbCategories.some((c) => c.name === "Quiz" && Number(c.weight) === 0),
        "a weight-0 category is created so the score has a home"
    );
    assert.equal(
        result.dbScores[0].category_id,
        result.dbCategories.find((c) => c.name === "Quiz").id,
        "the score points at that category"
    );
});

test("one unusable score cannot take the other scores down with it", async () => {
    const result = await roundTrip({
        categories: [cat("cat-ww", "Written Work", 100, [{ id: "item-ww-1", label: "#1", max_score: 20 }])],
        scores: [
            score({ student_id: "2026-0001", category_id: "cat-ww", category_name: "Written Work", item_id: "item-ww-1", item_label: "#1", score: 18, max_score: 20 }),
            score({ student_id: "2026-0002", category_id: null, category_name: "Recitation", category_weight: 0, score: 7, max_score: 10 })
        ]
    });

    assert.equal(result.fileScores, 2);
    assert.equal(result.dbScores.length, 2, "both scores restored");
    assert.deepEqual(result.dbScores.map((r) => Number(r.score)).sort((a, b) => a - b), [7, 18]);
    assert.equal(result.dbStudents, 4);
});

test("scores saved under a stale category id keep their numbers", async () => {
    const result = await roundTrip({
        categories: [cat("cat-ww", "Written Work", 100, [{ id: "item-ww-1", label: "#1", max_score: 20 }])],
        scores: [
            score({
                student_id: "2026-0003", category_id: "cat-deleted", category_name: "Old Project",
                category_weight: 20, item_id: "item-gone", item_label: "#1", score: 15, max_score: 20
            })
        ]
    });

    assert.equal(result.dbScores.length, 1);
    assert.equal(Number(result.dbScores[0].score), 15);
    assert.ok(result.dbCategories.some((c) => c.id === "cat-deleted" || c.name === "Old Project"));
});

test("a legacy score with no grading setup at all still comes back", async () => {
    const result = await roundTrip({
        categories: [],
        scores: [score({ student_id: "2026-0001", subject: "General", grading_period: "General", category_id: null, category_name: "General", category_weight: 100, score: 40, max_score: 50 })]
    });

    assert.equal(result.dbScores.length, 1, "legacy score restored");
    assert.equal(Number(result.dbScores[0].score), 40);
    assert.equal(result.dbStudents, 4);
    assert.equal(result.dbAttendance, 3, "attendance is untouched by score recovery");
});
