// Daily PDF generation with the real jsPDF + AutoTable builds.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { jsPDF } = require("jspdf");
require("jspdf-autotable");

await import("../pdf.js");
const SchologPdf = globalThis.SchologPdf;

const STUDENTS = [
    { student_id: "2026-0001", name: "Juan Dela Cruz" },
    { student_id: "2026-0002", name: "Ana Santos" },
    { student_id: "2026-0003", name: "Lea Reyes" },
    { student_id: "2026-0004", name: "Mark Lim" }
];
const DATE = "2026-10-23";
const ATTENDANCE = {
    "2026-10-23_2026-0001": "Present",
    "2026-10-23_2026-0002": "Late",
    "2026-10-23_2026-0003": "Absent",
    "2026-10-23_2026-0004": "Excused"
};

test("vendored PDF libraries match the tested versions", () => {
    const vendorJspdf = fs.readFileSync(path.join(ROOT, "vendor/jspdf.umd.min.js"));
    const npmJspdf = fs.readFileSync(path.join(ROOT, "node_modules/jspdf/dist/jspdf.umd.min.js"));
    assert.ok(vendorJspdf.equals(npmJspdf), "vendor/jspdf.umd.min.js is the real jsPDF build");

    const vendorAuto = fs.readFileSync(path.join(ROOT, "vendor/jspdf.autotable.min.js"));
    const npmAuto = fs.readFileSync(path.join(ROOT, "node_modules/jspdf-autotable/dist/jspdf.plugin.autotable.min.js"));
    assert.ok(vendorAuto.equals(npmAuto), "vendor/jspdf.autotable.min.js is the real AutoTable build");
});

test("builds a real, valid daily attendance PDF", () => {
    const doc = new jsPDF();
    const result = SchologPdf.buildDailyAttendancePdf(doc, {
        section: "Grade 11 - STEM",
        date: DATE,
        teacher: "Teacher Maria",
        students: STUDENTS,
        attendance: ATTENDANCE,
        generatedAt: new Date("2026-10-23T08:30:00Z")
    });

    assert.equal(result.filename, "Daily_Attendance_Grade 11 - STEM_2026-10-23.pdf");
    assert.deepEqual(result.counts, { Present: 1, Late: 1, Absent: 1, Excused: 1 });
    assert.deepEqual(result.rows.map((row) => row[3]), ["Present", "Late", "Absent", "Excused"]);

    const buffer = Buffer.from(doc.output("arraybuffer"));
    assert.equal(buffer.subarray(0, 4).toString(), "%PDF", "output starts with a PDF header");
    assert.ok(buffer.length > 3000, `PDF has real content (${buffer.length} bytes)`);

    const raw = buffer.toString("latin1");
    assert.match(raw, /Scholog/, "report title is embedded");
    assert.match(raw, /Daily Attendance Report/);
    assert.match(raw, /2026-10-23/);
});

test("empty section still produces a usable PDF", () => {
    const doc = new jsPDF();
    const result = SchologPdf.buildDailyAttendancePdf(doc, {
        section: "Empty",
        date: DATE,
        students: [],
        attendance: {}
    });
    assert.deepEqual(result.counts, { Present: 0, Late: 0, Absent: 0, Excused: 0 });
    assert.equal(result.rows.length, 0);
    const buffer = Buffer.from(doc.output("arraybuffer"));
    assert.ok(buffer.length > 1000);
    assert.match(buffer.toString("latin1"), /No students in this section/);
});

test("statuses default to Present when nothing is saved yet", () => {
    const doc = new jsPDF();
    const result = SchologPdf.buildDailyAttendancePdf(doc, {
        section: "Grade 11 - ABM",
        date: DATE,
        students: [{ student_id: "X-1", name: "Unmarked Student" }],
        attendance: {}
    });
    assert.equal(result.rows[0][3], "Present");
});

test("file names are sanitised and the missing-plugin error is clear", () => {
    assert.equal(SchologPdf.safeFilenamePart("Grade 11 / STEM: A*", "Section"), "Grade 11 - STEM- A-");
    const doc = new jsPDF();
    const result = SchologPdf.buildDailyAttendancePdf(doc, {
        section: 'Section/With:Bad*Chars?',
        date: DATE,
        students: STUDENTS,
        attendance: ATTENDANCE
    });
    assert.equal(result.filename, "Daily_Attendance_Section-With-Bad-Chars-_2026-10-23.pdf");

    assert.throws(
        () => SchologPdf.buildDailyAttendancePdf({}, { section: "X", date: DATE, students: [] }),
        /PDF table plugin is unavailable/
    );
});
