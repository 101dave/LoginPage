// Scholog — CSV report builder.
//
// Kept dependency-free and side-effect-free (like pdf.js) so the exact file the
// teacher downloads can be unit tested in Node.
//
// Plain comma-separated data opens in Excel as an undifferentiated wall of
// text: no title, no section/period context, and every number quoted so Excel
// flags it as text and refuses to total it. This builder emits a small report
// layout instead — title block, a two-row header that groups subsections under
// their category, real numbers for Excel, and class summary rows at the bottom.
(function (root) {
    "use strict";

    var ROW_JOINER = "\r\n";
    var BOM = "\uFEFF";
    var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    function toDate(value) {
        if (value instanceof Date && !isNaN(value.getTime())) return value;
        var parsed = value == null ? new Date() : new Date(value);
        return isNaN(parsed.getTime()) ? new Date() : parsed;
    }

    /** "23 Oct 2026" — unambiguous for both en-PH and tl readers. */
    function formatDate(value) {
        var date = toDate(value);
        return date.getDate() + " " + MONTHS[date.getMonth()] + " " + date.getFullYear();
    }

    /** "25 Oct 2026 10:30 AM" */
    function formatStamp(value) {
        var date = toDate(value);
        var hours = date.getHours();
        var suffix = hours >= 12 ? "PM" : "AM";
        var hour12 = hours % 12 === 0 ? 12 : hours % 12;
        return formatDate(date) + " " + hour12 + ":" +
            String(date.getMinutes()).padStart(2, "0") + " " + suffix;
    }

    function ymd(value) {
        var date = toDate(value);
        return date.getFullYear() + "-" +
            String(date.getMonth() + 1).padStart(2, "0") + "-" +
            String(date.getDate()).padStart(2, "0");
    }

    function sanitizeFilenamePart(value, fallback) {
        var cleaned = String(value == null ? "" : value)
            .replace(/[^a-z0-9]+/gi, "_")
            .replace(/^_+|_+$/g, "");
        return cleaned || fallback;
    }

    /** Grades_<section>_<period>_<date>.csv */
    function buildScoreSheetFilename(opts) {
        var options = opts || {};
        return [
            "Grades",
            sanitizeFilenamePart(options.section, "Section"),
            sanitizeFilenamePart(options.period, "Period"),
            ymd(options.date) // ISO date, always filename-safe
        ].join("_") + ".csv";
    }

    function isNumber(value) {
        return typeof value === "number" && isFinite(value);
    }

    // Excel runs any cell starting with = + - @ as a formula. A guardian or a
    // teacher can type anything into a name field, so neutralise those first.
    function looksLikeFormula(text) {
        if (!/^[=+@]/.test(text) && !/^-/.test(text)) return false;
        if (/^-\d/.test(text)) return false; // a plain negative number is fine
        return true;
    }

    /**
     * One CSV cell.
     * Numbers stay bare so Excel treats them as numbers and can total them.
     * Strings are quoted only when they need it, numeric-looking strings with a
     * leading zero are emitted as ="0012" so Excel does not eat the zero, and
     * anything starting like a formula is prefixed with an apostrophe.
     */
    function csvEscape(value) {
        if (value == null) return "";
        if (isNumber(value)) return String(value);

        var text = String(value);
        if (text === "") return "";

        if (/^0\d+$/.test(text)) return '="' + text + '"';
        if (looksLikeFormula(text)) text = "'" + text;

        if (/[",\r\n]/.test(text) || /^\s|\s$/.test(text)) {
            return '"' + text.replace(/"/g, '""') + '"';
        }
        return text;
    }

    function toLine(row) {
        return (row || []).map(csvEscape).join(",");
    }

    function gridToCsv(rows) {
        return (rows || []).map(toLine).join(ROW_JOINER);
    }

    function withBom(text) {
        var body = String(text == null ? "" : text);
        return body.charAt(0) === BOM ? body : BOM + body;
    }

    /**
     * Turn the score-sheet model into a report the teacher can read in Excel.
     * @param {{
     *   title?:string, school?:string, teacher?:string, section:string, period:string,
     *   date:Date|string, generatedAt?:Date|string,
     *   categories?:Array<{name:string, items?:Array<{label:string, max:number}>}>,
     *   students?:Array<{student_id:string, name:string, scores?:Array<number|null>,
     *                    grade?:number|null, status?:string}>,
     *   summary?:{classAverage?:number|null, withFinal?:number, withRunning?:number,
     *             withoutScores?:number}
     * }} model
     * @returns {{filename:string, rows:Array<Array>, text:string}}
     */
    function buildScoreSheetCsv(model) {
        var options = model || {};
        var students = Array.isArray(options.students) ? options.students : [];
        var categories = Array.isArray(options.categories) ? options.categories : [];

        // Flatten categories -> columns, remembering which category owns them so
        // the header can group subsections like "Written Work | #1 #2 #3".
        var columns = [];
        categories.forEach(function (category) {
            var items = Array.isArray(category.items) ? category.items : [];
            var name = String(category.name == null ? "" : category.name);
            if (items.length === 0) {
                columns.push({ id: category.id || name, category: name, isFirst: true, span: 1, label: name, max: null });
                return;
            }
            items.forEach(function (item, index) {
                columns.push({
                    id: category.id || name,
                    category: name,
                    isFirst: index === 0,
                    span: items.length,
                    label: String(item.label == null ? "" : item.label),
                    max: isNumber(Number(item.max)) ? Number(item.max) : null
                });
            });
        });

        var cols = columns.length;
        var gradeIndex = 2 + cols;
        var rows = [];

        // ---- title block -------------------------------------------------
        rows.push([options.title || "Scholog — Student Score Sheet"]);
        var meta = [
            ["Section", options.section || ""],
            ["Grading Period", options.period || "Unassigned"],
            ["Score Date", formatDate(options.date)]
        ];
        if (options.school) meta.unshift(["School", options.school]);
        if (options.teacher) meta.push(["Teacher", options.teacher]);
        meta.forEach(function (pair) { rows.push(pair); });

        // ---- headers -----------------------------------------------------
        rows.push([]);

        var groupRow = ["Student ID", "Student Name"];
        var itemRow = ["", ""];
        columns.forEach(function (column) {
            if (!column.isFirst) {
                groupRow.push("");
                itemRow.push(column.label + (column.max != null ? " (Max " + column.max + ")" : ""));
                return;
            }
            // A single-subsection category keeps one header cell:
            // "Performance Task (Max 50)", not a category row plus an item row.
            var single = column.span === 1;
            var groupTitle = single
                ? column.category + (column.max != null ? " (Max " + column.max + ")" : "")
                : column.category;
            groupRow.push(groupTitle);
            itemRow.push(single ? "" : column.label + (column.max != null ? " (Max " + column.max + ")" : ""));
        });
        groupRow.push("Computed Grade (%)", "Status");
        itemRow.push("", "");
        rows.push(groupRow);
        rows.push(itemRow);

        // ---- one row per student ----------------------------------------
        students.forEach(function (student) {
            var row = [String(student.student_id == null ? "" : student.student_id), student.name || ""];
            var scores = Array.isArray(student.scores) ? student.scores : [];
            for (var index = 0; index < cols; index++) {
                var value = scores[index];
                row.push(isNumber(value) ? value : "");
            }
            row.push(isNumber(student.grade) ? Math.round(student.grade * 100) / 100 : "");
            row.push(student.status || "");
            rows.push(row);
        });

        // ---- summary -----------------------------------------------------
        var summary = options.summary || {};
        var hasSummary = isNumber(summary.classAverage)
            || isNumber(summary.withFinal)
            || isNumber(summary.withRunning)
            || isNumber(summary.withoutScores);
        if (hasSummary) {
            rows.push([]);
            function summaryRow(label, value) {
                var row = [label];
                for (var index = 1; index < gradeIndex; index++) row.push("");
                row.push(isNumber(value) ? Math.round(value * 100) / 100 : (value == null ? "" : value));
                row.push("");
                rows.push(row);
            }
            if (isNumber(summary.classAverage)) summaryRow("Class Average", summary.classAverage);
            if (isNumber(summary.withFinal)) summaryRow("Students with final grades", summary.withFinal);
            if (isNumber(summary.withRunning)) summaryRow("Students with running grades", summary.withRunning);
            if (isNumber(summary.withoutScores)) summaryRow("Students without scores", summary.withoutScores);
        }

        rows.push([]);
        rows.push(["Generated", formatStamp(options.generatedAt || new Date())]);
        rows.push(["Note", "Scores are raw points. Computed Grade is the weighted percentage for the selected grading period."]);

        return {
            filename: buildScoreSheetFilename(options),
            rows: rows,
            text: gridToCsv(rows)
        };
    }

    /**
     * Final-grade report: one row per learner, one column per grading period,
     * then the combined grade and its descriptor.
     * @param {{
     *   section:string, structure?:string, rule?:string, transmuted?:boolean,
     *   date?:Date|string, generatedAt?:Date|string,
     *   periods?:Array<string>,
     *   students?:Array<{student_id:string, name:string,
     *                    periods?:Object<string, number|null>,
     *                    final?:number|null, raw?:number|null,
     *                    transmuted?:boolean, descriptor?:string}>
     * }} model
     * @returns {{filename:string, rows:Array<Array>, text:string}}
     */
    function buildGradeSummaryCsv(model) {
        var options = model || {};
        var periods = Array.isArray(options.periods) ? options.periods : [];
        var students = Array.isArray(options.students) ? options.students : [];
        var rows = [];

        rows.push(["Scholog — Final Grades"]);
        rows.push(["Section", options.section || ""]);
        rows.push(["Structure", options.structure || ""]);
        rows.push(["Final grade rule", options.rule || ""]);
        rows.push(["Transmutation", options.transmuted ? "On (raw below 70 is recorded as 75)" : "Off"]);
        rows.push(["As of", formatDate(options.date)]);

        rows.push([]);
        var header = ["Student ID", "Student Name"].concat(periods, ["Final Grade", "Descriptor", "Note"]);
        rows.push(header);

        var graded = [];
        students.forEach(function (student) {
            var perPeriod = student.periods || {};
            var row = [String(student.student_id == null ? "" : student.student_id),
                String(student.name == null ? "" : student.name)];
            periods.forEach(function (period) {
                var value = perPeriod[period];
                row.push(isNumber(Number(value)) && value != null && value !== "" ? Number(value) : "");
            });
            var final = student.final;
            row.push(isNumber(Number(final)) && final != null ? Number(final) : "");
            row.push(student.descriptor || "");
            row.push(student.transmuted ? "Transmuted from " + Number(student.raw).toFixed(2) : "");
            if (isNumber(Number(final)) && final != null) graded.push(Number(final));
            rows.push(row);
        });

        rows.push([]);
        rows.push(["Class average", graded.length > 0 ? Number((graded.reduce(function (sum, value) { return sum + value; }, 0) / graded.length).toFixed(2)) : ""]);
        rows.push(["Students with a final grade", graded.length + " of " + students.length]);
        rows.push(["Generated", formatStamp(options.generatedAt || new Date())]);
        rows.push(["Note", "Each period column is that period's weighted percentage. The final grade combines them by the section's rule."]);

        var section = sanitizeFilenamePart(options.section, "Section");
        return {
            filename: ["FinalGrades", section, ymd(options.date)].join("_") + ".csv",
            rows: rows,
            text: gridToCsv(rows)
        };
    }

    var api = {
        VERSION: "1.0.0",
        ROW_JOINER: ROW_JOINER,
        BOM: BOM,
        csvEscape: csvEscape,
        gridToCsv: gridToCsv,
        withBom: withBom,
        formatDate: formatDate,
        formatStamp: formatStamp,
        ymd: ymd,
        buildScoreSheetFilename: buildScoreSheetFilename,
        buildScoreSheetCsv: buildScoreSheetCsv,
        buildGradeSummaryCsv: buildGradeSummaryCsv
    };

    root.SchologCsv = api;
    if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
