// Responsive + legibility contract for the grading modal.
//
// There is no browser in this environment, so these checks are computed from the
// shipped CSS and markup instead of screenshots: real grid maths at real phone
// widths, real WCAG ratios from the real colour variables, and real DOM labels.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, createFakeSupabase, defaultDb, loadPage, waitFor } from "./helpers.mjs";
import { installSupabaseStub, makeFakeJsPdf, makeFakeQr } from "./stubs.mjs";

const CSS = fs.readFileSync(path.join(ROOT, "main.css"), "utf8");

// ---------------------------------------------------------------- css helpers

const CSS_SOURCE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** Flatten the stylesheet into { media, selector, body } rules. */
function parseRules(css) {
    const rules = [];
    const stack = [];
    let buffer = "";
    for (let i = 0; i < css.length; i += 1) {
        const char = css[i];
        if (char === "{") {
            const prelude = buffer.trim().replace(/\s+/g, " ");
            buffer = "";
            if (prelude.startsWith("@")) {
                stack.push(prelude);
                continue;
            }
            // A plain rule: skip to its own closing brace so nested @media blocks
            // cannot confuse the cursor.
            let depth = 1;
            let j = i + 1;
            for (; j < css.length; j += 1) {
                if (css[j] === "{") depth += 1;
                else if (css[j] === "}") {
                    depth -= 1;
                    if (depth === 0) break;
                }
            }
            const media = [...stack].reverse().find((entry) => entry.startsWith("@media")) || null;
            rules.push({
                media: media ? media.replace(/^@media\s*/, "").trim() : null,
                selector: prelude,
                body: css.slice(i + 1, j)
            });
            i = j;
            continue;
        }
        if (char === "}") {
            stack.pop();
            buffer = "";
            continue;
        }
        buffer += char;
    }
    return rules;
}

const RULES = parseRules(CSS_SOURCE);

/** Every declaration for a selector, optionally scoped to a media query. */
function declarationsFor(selector, media = undefined) {
    const out = {};
    RULES.filter((rule) => {
        // Undefined media means "the base rule", not "every rule anywhere": a
        // narrow-screen override must not be mistaken for the default.
        if (media === undefined ? rule.media !== null : rule.media !== media) return false;
        return rule.selector.split(",").map((part) => part.trim()).includes(selector);
    }).forEach((rule) => {
        rule.body.split(";").forEach((line) => {
            const index = line.indexOf(":");
            if (index === -1) return;
            out[line.slice(0, index).trim()] = line.slice(index + 1).trim();
        });
    });
    return out;
}

function cssVar(name) {
    const match = CSS_SOURCE.match(new RegExp(`--${name.replace(/^--/, "")}:\\s*([^;]+);`));
    assert.ok(match, `--${name.replace(/^--/, "")} must exist`);
    return match[1].trim();
}

// --------------------------------------------------------------- contrast

function luminance(hex) {
    const clean = hex.replace("#", "");
    const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
    const channels = [0, 2, 4].map((offset) => {
        const value = parseInt(full.slice(offset, offset + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
    const a = luminance(foreground);
    const b = luminance(background);
    const lighter = Math.max(a, b);
    const darker = Math.min(a, b);
    return (lighter + 0.05) / (darker + 0.05);
}

// ------------------------------------------------------- width calculator

/**
 * Width available to the modal's content area at a given viewport, following the
 * shipped padding rules (backdrop <=420px uses 10px, modal-content uses 18px).
 */
function modalContentWidth(viewport) {
    const backdropPadding = viewport <= 420 ? 10 : 16;
    const modalPadding = viewport <= 420 ? 18 : 24;
    return viewport - backdropPadding * 2 - modalPadding * 2;
}

/** First grid column width from a `grid-template-columns` string. */
function resolvedColumns(template, available, gap) {
    const parts = template.trim().split(/\s+(?![^(]*\))/);
    const gaps = gap * (parts.length - 1);
    const space = available - gaps;
    const fixed = parts.reduce((sum, part) => {
        const px = /^(\d+(?:\.\d+)?)px$/.exec(part);
        return sum + (px ? Number(px[1]) : 0);
    }, 0);
    const flex = parts.reduce((sum, part) => {
        const fr = /^minmax\(\s*0\s*,\s*(\d+(?:\.\d+)?)fr\s*\)$/.exec(part)
            || /^(\d+(?:\.\d+)?)fr$/.exec(part);
        return sum + (fr ? Number(fr[1]) : 0);
    }, 0);
    const first = parts[0];
    const firstFr = /^minmax\(\s*0\s*,\s*(\d+(?:\.\d+)?)fr\s*\)$/.exec(first) || /^(\d+(?:\.\d+)?)fr$/.exec(first);
    const firstPx = /^(\d+(?:\.\d+)?)px$/.exec(first);
    if (firstPx) return Number(firstPx[1]);
    if (firstFr && flex > 0) return (Math.max(space, 0) * Number(firstFr[1])) / flex;
    return 0;
}

function declarations(body) {
    const out = {};
    (body || "").split(";").forEach((line) => {
        const index = line.indexOf(":");
        if (index === -1) return;
        out[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    });
    return out;
}

// ---------------------------------------------------------------- the checks

test("on a phone, a category name field is wide enough to read", () => {
    const rowDecl = declarationsFor(".grading-weight-row", "(max-width: 560px)");
    const template = rowDecl["grid-template-columns"];
    assert.ok(template, "the mobile category row declares its own grid");
    const gap = Number((rowDecl.gap || "10px").split(" ")[0].replace("px", "")) || 10;

    // The narrowest phone we support.
    for (const viewport of [320, 360, 390, 414, 560]) {
        const available = modalContentWidth(viewport);
        const nameWidth = resolvedColumns(template, available, gap);
        assert.ok(
            nameWidth >= 140,
            `at ${viewport}px the category name column is only ${nameWidth.toFixed(0)}px ` +
            `(available ${available}px, template "${template}")`
        );
    }
});

test("the four-column squeeze was replaced by labelled rows, not a smaller font", () => {
    const areas = declarationsFor(".grading-weight-row", "(max-width: 560px)")["grid-template-areas"] || "";
    assert.match(areas, /name\s+remove/, "name and the remove button share the first line");
    assert.match(areas, /items\s+weight/, "subsections and weight share the second line");

    const periodAreas = declarationsFor(".grading-period-row", "(max-width: 560px)")["grid-template-areas"] || "";
    assert.match(periodAreas, /name\s+remove/, "period rows stack as well");

    assert.equal(
        declarationsFor(".grading-weight-head", "(max-width: 560px)").display,
        "none",
        "the header row is replaced by inline labels"
    );
});

test("phone inputs are 44px tall and 16px text, so iOS does not zoom on focus", () => {
    const decl = declarationsFor(".grading-weight-row .form-control", "(max-width: 560px)");
    assert.equal(decl["min-height"], "44px", "44px minimum touch target");
    assert.equal(decl["font-size"], "16px", "16px stops iOS Safari zooming the page on focus");
});

test("remove buttons are 44x44 touch targets", () => {
    const decl = declarationsFor(".grading-category-remove");
    assert.equal(decl.width, "44px");
    assert.equal(decl.height, "44px");
});

test("the modal scrolls instead of hiding the Save button behind mobile browser chrome", () => {
    const decl = declarationsFor(".modal-content");
    assert.match(decl["overflow-y"], /auto/, "long forms scroll");
    assert.equal(decl["max-height"], "90dvh", "dvh keeps the toolbar from covering the footer");
    assert.match(CSS, /max-height:\s*90vh;[\s\S]{0,200}max-height:\s*90dvh/, "vh fallback still ships");
});

test("modal text is never smaller than 12px", () => {
    const selectors = [
        ".modal-body-copy",
        ".modal-subtext",
        ".field-hint",
        ".checkbox-row",
        ".grading-weight-total",
        ".grading-setup-error",
        ".grading-weight-head",
        ".grading-cell-label"
    ];
    selectors.forEach((selector) => {
        const decl = declarationsFor(selector);
        const size = Number((decl["font-size"] || "").replace("px", ""));
        assert.ok(
            Number.isFinite(size) && size >= 12,
            `${selector} renders at ${decl["font-size"]}, below the 12px floor`
        );
    });
});

test("every text colour in the modal clears WCAG AA against its background", () => {
    const pairs = [
        ["--text-muted", "--bg-card", "hints, labels, subtext"],
        ["--text-main", "--bg-card", "headings and input text"],
        ["--emerald-text", "--emerald-bg", "the weight total"],
        ["--rose-text", "--rose-bg", "the validation error"],
        ["--amber-text", "--bg-card", "the transmuted label"]
    ];
    pairs.forEach(([fg, bg, what]) => {
        const ratio = contrast(cssVar(fg), cssVar(bg));
        assert.ok(ratio >= 4.5, `${what}: ${ratio.toFixed(2)}:1 (needs 4.5:1)`);
    });
});

// ------------------------------------------------------------------ markup

test("each row carries its own visible labels for the stacked layout", async (t) => {
    const db = defaultDb();
    const client = createFakeSupabase({ db, enforceGradingConstraints: true });
    const page = loadPage({
        html: "main.html",
        scripts: ["vendor/lucide-subset.js", "csv.js", "pdf.js", "main.js"],
        url: "https://scholog.test/main.html",
        beforeParse(window) {
            installSupabaseStub(window, client);
            window.qrcode = makeFakeQr();
            window.jspdf = { jsPDF: makeFakeJsPdf().FakeJsPDF };
        }
    });
    t.after(() => page.dom.window.close());
    const window = page.window;
    await waitFor(() => window.document.getElementById("stat-total").textContent !== "0", { label: "dashboard" });

    window.switchTab("scores");
    window.openGradingSetup();
    const document = window.document;

    window.document.getElementById("grading-preset").value = "k12-terms";
    window.applyGradingPreset();

    const rows = Array.from(document.querySelectorAll("#grading-weight-rows .grading-weight-row"));
    assert.ok(rows.length > 0);
    rows.forEach((row) => {
        const labels = Array.from(row.querySelectorAll(".grading-cell-label")).map((el) => el.textContent.trim());
        assert.deepEqual(labels, ["Category", "Subsections", "Weight"], "each field is labelled inline");
    });

    const periodRows = Array.from(document.querySelectorAll("#grading-period-rows .grading-period-row"));
    assert.ok(periodRows.length > 0);
    const periodLabels = Array.from(periodRows[0].querySelectorAll(".grading-cell-label"))
        .map((el) => el.textContent.trim());
    assert.deepEqual(periodLabels, ["Period", "Share of final grade"]);
});

test("the modal has one h3 heading and stays a labelled dialog", async (t) => {
    const db = defaultDb();
    const client = createFakeSupabase({ db, enforceGradingConstraints: true });
    const page = loadPage({
        html: "main.html",
        scripts: ["vendor/lucide-subset.js", "csv.js", "pdf.js", "main.js"],
        url: "https://scholog.test/main.html",
        beforeParse(window) {
            installSupabaseStub(window, client);
            window.qrcode = makeFakeQr();
            window.jspdf = { jsPDF: makeFakeJsPdf().FakeJsPDF };
        }
    });
    t.after(() => page.dom.window.close());
    const window = page.window;
    await waitFor(() => window.document.getElementById("stat-total").textContent !== "0", { label: "dashboard" });

    const modal = window.document.getElementById("modal-grading-setup");
    assert.equal(modal.getAttribute("role"), "dialog");
    assert.equal(modal.getAttribute("aria-modal"), "true");
    assert.ok(modal.getAttribute("aria-label"), "the dialog is named for screen readers");
    const headings = modal.querySelectorAll("h1, h2, h3");
    assert.equal(headings.length, 1, "one heading, so the modal reads as a single panel");
    assert.match(headings[0].textContent, /Categories & Weights/);
});
