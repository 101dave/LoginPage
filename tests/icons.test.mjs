// The icon subset must cover every icon the app references, and must actually
// render the same SVG Lucide would (attributes preserved, inline sizing kept).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { ROOT, loadPage, waitFor } from "./helpers.mjs";
import { installSupabaseStub, makeFakeJsPdf, makeFakeQr } from "./stubs.mjs";
import { createFakeSupabase } from "./helpers.mjs";
import { dbWithToday } from "./stubs.mjs";

const SUBSET = path.join(ROOT, "vendor/lucide-subset.js");
const SOURCE_FILES = ["main.html", "main.js", "scan.html", "scan.js", "student-record.html", "student-record.js", "index.html", "script.js"];

const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

function referencedIcons() {
    const names = new Set();
    for (const file of SOURCE_FILES) {
        for (const match of read(file).matchAll(/data-lucide="([a-z0-9-]+)"/g)) names.add(match[1]);
    }
    return [...names].sort();
}

test("every data-lucide icon used by the app is in the subset bundle", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only" });
    dom.window.eval(fs.readFileSync(SUBSET, "utf8"));
    const icons = dom.window.lucide.icons;

    const missing = referencedIcons().filter((name) => !icons[name]);
    assert.deepEqual(missing, [], `run: node scripts/build-icon-subset.mjs (missing ${missing.join(", ")})`);
});

test("the subset is a rounding error next to the full library", () => {
    const subset = fs.statSync(SUBSET).size;
    const full = fs.statSync(path.join(ROOT, "vendor/lucide.min.js")).size;
    assert.ok(subset < full / 10, `subset ${subset} bytes should be far smaller than ${full}`);
    // main.html must load the subset, not the full build.
    assert.match(read("main.html"), /vendor\/lucide-subset\.js/);
    assert.doesNotMatch(read("main.html"), /vendor\/lucide\.min\.js/);
});

test("createIcons renders real SVG and keeps the placeholder attributes", () => {
    const dom = new JSDOM(
        `<!doctype html><html><body>
            <i data-lucide="users" style="width: 16px; height: 16px;" class="mobile-hide"></i>
            <span data-lucide="chevron-left" aria-hidden="false"></span>
        </body></html>`,
        { runScripts: "outside-only" }
    );
    dom.window.eval(fs.readFileSync(SUBSET, "utf8"));
    dom.window.lucide.createIcons();

    const document = dom.window.document;
    const svg = document.querySelector("svg.lucide-users");
    assert.ok(svg, "rendered an svg");
    assert.equal(svg.tagName.toLowerCase(), "svg");
    assert.equal(svg.getAttribute("style"), "width: 16px; height: 16px;", "inline sizing survives");
    assert.match(svg.getAttribute("class"), /mobile-hide/);
    assert.equal(svg.getAttribute("stroke"), "currentColor");
    assert.ok(svg.querySelectorAll("path").length > 0, "icon paths are present");
    assert.equal(document.querySelectorAll("[data-lucide]").length, 0, "no placeholders left behind");

    // An explicit aria-hidden="false" is preserved for meaningful icons.
    assert.equal(document.querySelector("svg.lucide-chevron-left").getAttribute("aria-hidden"), "false");
});

test("the dashboard icons render inside the real app", async (t) => {
    const client = createFakeSupabase({ db: dbWithToday() });
    const page = loadPage({
        html: "main.html",
        scripts: ["vendor/lucide-subset.js", "pdf.js", "csv.js", "main.js"],
        url: "https://scholog.test/main.html",
        beforeParse(window) {
            installSupabaseStub(window, client);
            window.qrcode = makeFakeQr();
            window.jspdf = { jsPDF: makeFakeJsPdf().FakeJsPDF };
        }
    });
    t.after(() => page.dom.window.close());
    const document = page.window.document;

    await waitFor(() => document.getElementById("stat-total").textContent !== "0", { label: "dashboard data" });
    // Icons in the nav are rendered as SVG, and no <i data-lucide> remains.
    assert.ok(document.querySelector("#nav-dashboard svg, .navbar svg"), "navbar icons rendered");
    assert.equal(document.querySelectorAll("i[data-lucide]").length, 0, "no unrendered icon placeholders");

    // Re-rendering after a tab switch must keep producing SVG.
    page.window.switchTab("directory");
    await waitFor(() => document.querySelectorAll("#directory-table-body tr").length === 4);
    assert.ok(document.querySelector("#directory-section-banner svg"), "banner QR icon rendered");
    assert.equal(document.querySelectorAll("i[data-lucide]").length, 0);
});
