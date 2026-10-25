// CSV report builder + the real "Save CSV" button.
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase, defaultDb, loadPage, waitFor } from "./helpers.mjs";
import { installLucideStub, installSupabaseStub, makeFakeJsPdf, makeFakeQr } from "./stubs.mjs";

await import("../csv.js");
const Csv = globalThis.SchologCsv;

const parseCsv = (text) => text.split("\r\n").map((line) => line.split(","));

const MODEL = {
    section: "Grade 8 - Rizal",
    period: "Quarter 2",
    date: "2026-10-23",
    teacher: "Ms. Cruz",
    categories: [
        { id: "ww", name: "Written Work", items: [{ label: "#1", max: 20 }, { label: "#2", max: 30 }] },
        { id: "pt", name: "Performance Task", items: [{ label: "#1", max: 50 }] }
    ],
    students: [
        { student_id: "2026-0001", name: "Juan Dela Cruz", scores: [18, 27, 44], grade: 86.5, status: "Final" },
        { student_id: "2026-0002", name: "Ana Santos", scores: [12, null, null], grade: 60, status: "Running (60%)" }
    ],
    summary: { classAverage: 73.25, withFinal: 1, withRunning: 1, withoutScores: 0 }
};

test("the file has a title block instead of starting with raw data", () => {
    const csv = Csv.buildScoreSheetCsv(MODEL);
    const rows = parseCsv(csv.text);

    assert.match(rows[0][0], /Student Score Sheet/);
    assert.deepEqual(rows[1], ["Section", "Grade 8 - Rizal"]);
    assert.deepEqual(rows[2], ["Grading Period", "Quarter 2"]);
    assert.deepEqual(rows[3], ["Score Date", "23 Oct 2026"]);
    assert.deepEqual(rows[4], ["Teacher", "Ms. Cruz"]);
});

test("headers group subsections under their category", () => {
    const rows = parseCsv(Csv.buildScoreSheetCsv(MODEL).text);
    const groupRow = rows.find((row) => row[0] === "Student ID");
    const index = rows.indexOf(groupRow);
    const itemRow = rows[index + 1];

    assert.deepEqual(groupRow, [
        "Student ID", "Student Name",
        "Written Work", "", "Performance Task (Max 50)",
        "Computed Grade (%)", "Status"
    ]);
    assert.deepEqual(itemRow, [
        "", "",
        "#1 (Max 20)", "#2 (Max 30)", "",
        "", ""
    ]);
});

test("numbers stay bare so Excel can total them", () => {
    const rows = parseCsv(Csv.buildScoreSheetCsv(MODEL).text);
    const juan = rows.find((row) => row[0] === "2026-0001");
    assert.deepEqual(juan, ["2026-0001", "Juan Dela Cruz", "18", "27", "44", "86.5", "Final"]);

    // No quotes around the values at all.
    assert.doesNotMatch(Csv.buildScoreSheetCsv(MODEL).text, /"18"|"86\.5"/);
});

test("missing scores leave an empty cell, not a dash or a zero", () => {
    const rows = parseCsv(Csv.buildScoreSheetCsv(MODEL).text);
    const ana = rows.find((row) => row[0] === "2026-0002");
    assert.deepEqual(ana, ["2026-0002", "Ana Santos", "12", "", "", "60", "Running (60%)"]);
});

test("class summary sits under the grade column", () => {
    const rows = parseCsv(Csv.buildScoreSheetCsv(MODEL).text);
    const average = rows.find((row) => row[0] === "Class Average");
    assert.equal(average[5], "73.25");
    assert.equal(average.length, 7);
    assert.ok(rows.some((row) => row[0] === "Students with final grades" && row[5] === "1"));
    assert.ok(rows.some((row) => row[0] === "Generated"));
});

test("names with commas, quotes and accents survive Excel", () => {
    const csv = Csv.buildScoreSheetCsv({
        ...MODEL,
        students: [
            { student_id: "2026-0003", name: 'Reyes, Maria "Mia"', scores: [20, 30, 50], grade: 100, status: "Final" },
            { student_id: "2026-0004", name: "José Peña", scores: [0, 0, 0], grade: 0, status: "Final" }
        ]
    });
    const rows = parseCsv(csv.text);

    // Quoted so the comma inside the name cannot shift the columns.
    assert.equal(rows.find((row) => row[0] === "2026-0003")[1], '"Reyes');
    assert.match(csv.text, /"Reyes, Maria ""Mia"""/);

    // Non-ASCII text is kept: the file is UTF-8 with a BOM, so Excel shows it.
    assert.match(csv.text, /José Peña/);
    assert.equal(Csv.withBom(csv.text).charCodeAt(0), 0xFEFF);
    assert.equal(Csv.withBom(csv.text).split("\uFEFF").length, 2, "the BOM is added exactly once");
});

test("student IDs keep their leading zeros and cells cannot become formulas", () => {
    assert.equal(Csv.csvEscape("0012"), '="0012"');
    assert.equal(Csv.csvEscape("2026-0001"), "2026-0001");
    assert.equal(Csv.csvEscape("=SUM(A1:A9)"), "'=SUM(A1:A9)");
    assert.equal(Csv.csvEscape("+63 917 123 4567"), "'+63 917 123 4567");
    assert.equal(Csv.csvEscape("  padded  "), '"  padded  "');
    assert.equal(Csv.csvEscape(86.5), "86.5");
    assert.equal(Csv.csvEscape(null), "");
});

test("filename matches the download the teacher sees", () => {
    assert.equal(
        Csv.buildScoreSheetFilename({ section: "Grade 8 - Rizal", period: "Quarter 2", date: "2026-10-23" }),
        "Grades_Grade_8_Rizal_Quarter_2_2026-10-23.csv"
    );
});

// ------------------------------------------------------------- through the UI

test("Save CSV downloads the report, BOM included", async (t) => {
    const db = defaultDb();
    const section = "Grade 11 - STEM";
    db.grading_categories = [{
        id: "cat-ww", user_id: "user-1", section, name: "Written Work", weight: 100,
        items: [{ id: "item-1", label: "#1", max_score: 20 }], archived: false
    }];
    db.section_grading_categories = [{ id: "sgc-1", user_id: "user-1", section, category_id: "cat-ww" }];
    db.scores = [{
        id: "score-1", user_id: "user-1", date: "2026-10-23", student_id: "2026-0001",
        subject: "Quarter 1", grading_period: "Quarter 1", category_id: "cat-ww",
        category_name: "Written Work", category_weight: 100,
        item_id: "item-1", item_label: "#1", score: 18, max_score: 20
    }];

    const client = createFakeSupabase({ db, enforceGradingConstraints: true });
    const page = loadPage({
        html: "main.html",
        scripts: ["csv.js", "pdf.js", "main.js"],
        url: "https://scholog.test/main.html",
        beforeParse(window) {
            installSupabaseStub(window, client);
            installLucideStub(window);
            window.qrcode = makeFakeQr();
            window.jspdf = { jsPDF: makeFakeJsPdf().FakeJsPDF };
            window.__download = null;
            window.URL.createObjectURL = (blob) => { window.__download = blob; return "blob:mock"; };
            window.HTMLAnchorElement.prototype.click = function () {
                window.__filename = this.download;
            };
        }
    });
    const { window, dom } = page;
    t.after(() => dom.window.close());

    await waitFor(() => window.document.getElementById("stat-total").textContent !== "0", { label: "dashboard data" });
    window.switchTab("scores");
    await waitFor(() => window.document.getElementById("view-scores").classList.contains("hidden") === false);

    window.document.getElementById("score-date").value = "2026-10-23";
    window.saveScoreSheetCsv();
    await waitFor(() => window.__download, { label: "csv download" });

    // Blob.text() strips the BOM while decoding, so check the raw bytes
    // the browser writes to disk: EF BB BF is what makes Excel read UTF-8.
    const bytes = new Uint8Array(await window.__download.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF], "UTF-8 BOM for Excel");

    const text = await window.__download.text();
    assert.equal(window.__filename, "Grades_Grade_11_STEM_Unassigned_2026-10-23.csv");
    assert.match(text, /Student Score Sheet/);
    assert.match(text, /Grade 11 - STEM/);
    assert.match(text, /Written Work/);
    assert.match(text, /2026-0001/);
    assert.match(text, /Juan Dela Cruz/);
});
