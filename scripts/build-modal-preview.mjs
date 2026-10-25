// Build preview/grading-modal.html from the real app.
//
// There is no browser in CI, but the layout still has to be looked at. This
// script renders the actual grading modal (same main.js, same main.css, same
// markup) and writes a page that shows it at three widths — a phone, a large
// phone, and a tablet. Nothing is hand-copied, so the preview cannot drift.
//
//   node scripts/build-modal-preview.mjs
import fs from "node:fs";
import path from "node:path";
import { ROOT, createFakeSupabase, defaultDb, loadPage, waitFor } from "../tests/helpers.mjs";
import { installSupabaseStub, makeFakeJsPdf, makeFakeQr } from "../tests/stubs.mjs";

const OUT = path.join(ROOT, "preview");

function stripHidden(html) {
    return html
        .replace(/ class="modal-backdrop hidden"/, ' class="modal-backdrop"')
        .replace(/ class="([^"]*)\bhidden\b([^"]*)"/g, ' class="$1$2"');
}

async function renderModal() {
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

    await waitFor(() => page.window.document.getElementById("stat-total").textContent !== "0", {
        label: "dashboard data"
    });

    const window = page.window;
    window.switchTab("scores");
    window.openGradingSetup();

    // Show a realistic DepEd setup: three terms, WW/PT/EX prefilled.
    const document = window.document;
    document.getElementById("grading-preset").value = "k12-terms";
    window.applyGradingPreset();

    const modal = document.getElementById("modal-grading-setup");
    const html = stripHidden(modal.outerHTML);
    page.dom.window.close();
    return html;
}

const modalHtml = await renderModal();

const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grading modal — responsive check</title>
<link rel="stylesheet" href="../main.css">
<style>
    /* Preview chrome only. The modal itself uses the shipping stylesheet. */
    body {
        margin: 0;
        padding: 24px;
        background: var(--bg-main);
        font-family: "Plus Jakarta Sans", system-ui, sans-serif;
        color: var(--text-main);
    }
    .preview-head { max-width: 1100px; margin: 0 auto 20px; }
    .preview-head h1 { font-size: 20px; margin: 0 0 6px; }
    .preview-head p { margin: 0; color: var(--text-muted); font-size: 13px; line-height: 1.6; }
    .frames { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
    .frame { border: 1px solid var(--border-color); border-radius: 14px; overflow: hidden; background: var(--bg-card); }
    .frame-label {
        padding: 8px 12px;
        font-size: 12px;
        font-weight: 700;
        color: var(--text-muted);
        border-bottom: 1px solid var(--border-color);
        background: var(--bg-row-hover);
    }
    .frame-body { background: rgba(2, 6, 23, 0.04); }
    /* Neutralise the dialog positioning so it sits inside its frame. */
    .frame-body .modal-backdrop {
        position: static;
        inset: auto;
        padding: 10px;
        background: transparent;
        backdrop-filter: none;
        align-items: flex-start;
    }
    .frame-body .modal-content { max-height: none; }
    .frame-320 .frame-body { width: 320px; }
    .frame-390 .frame-body { width: 390px; }
    .frame-768 .frame-body { width: 768px; }
</style>
</head>
<body>
    <div class="preview-head">
        <h1>Categories &amp; Weights — responsive check</h1>
        <p>
            Rendered from the real <code>main.js</code> and <code>main.css</code>, not a mock-up.
            Below 560px every row becomes a labelled card: the category name keeps a readable width,
            the subsection count and weight sit underneath, and each field carries its own label.
            Inputs are 44px tall with 16px text so iOS does not zoom when a field is focused.
        </p>
    </div>
    <div class="frames">
        <div class="frame frame-320">
            <div class="frame-label">320px — smallest phone</div>
            <div class="frame-body">${modalHtml}</div>
        </div>
        <div class="frame frame-390">
            <div class="frame-label">390px — iPhone 14/15</div>
            <div class="frame-body">${modalHtml}</div>
        </div>
        <div class="frame frame-768">
            <div class="frame-label">768px — tablet / desktop dialog</div>
            <div class="frame-body">${modalHtml}</div>
        </div>
    </div>
</body>
</html>
`;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "grading-modal.html"), page, "utf8");
console.log(`preview/grading-modal.html written (${(page.length / 1024).toFixed(1)} KB)`);
