// Static / consistency checks across the whole app.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const PAGES = ["index.html", "main.html", "scan.html", "privacy.html"];
const SOURCE_JS = ["script.js", "main.js", "scan.js", "pdf.js", "sw.js"];
const FIRST_PARTY = [...PAGES, ...SOURCE_JS, "main.css", "scan.css", "style.css", "manifest.json"];

const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("removed features stay gone: no Monthly SF2 export and no dark mode", () => {
    for (const file of FIRST_PARTY) {
        const source = read(file);
        assert.doesNotMatch(source, /monthly/i, `${file}: no monthly export`);
        assert.doesNotMatch(source, /\bsf2\b/i, `${file}: no SF2 export`);
        assert.doesNotMatch(source, /xlsx|sheetjs|exceljs/i, `${file}: no spreadsheet export`);
        assert.doesNotMatch(source, /data-theme|darkMode|toggleTheme|theme-toggle/i, `${file}: no dark-mode plumbing`);
        assert.doesNotMatch(source, /prefers-color-scheme:\s*dark/i, `${file}: no dark color scheme`);
    }
    // The only export control in the dashboard is the daily PDF.
    const mainHtml = read("main.html");
    const exportLabels = [...mainHtml.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi)]
        .map((match) => match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
        .filter((label) => /pdf|export|download|xlsx|sf2/i.test(label));
    assert.deepEqual(exportLabels, ["Daily PDF"]);
    assert.match(mainHtml, /exportAttendanceToPDF\(\)/);
});

test("QR scanner lives on its own page, not in the teacher dashboard", () => {
    const mainHtml = read("main.html");
    assert.doesNotMatch(mainHtml, /id="qr-reader"/);
    assert.doesNotMatch(mainHtml, /html5-qrcode/);
    assert.doesNotMatch(read("main.js"), /Html5Qrcode|getUserMedia/);
    assert.match(mainHtml, /openQrCheckInPage\(\)/);

    const scanHtml = read("scan.html");
    assert.match(scanHtml, /id="qr-reader"/);
    assert.match(scanHtml, /vendor\/html5-qrcode\.min\.js/);
    assert.match(scanHtml, /vendor\/qrcode\.js/);
    assert.match(scanHtml, /src="scan\.js"/);
    assert.match(scanHtml, /href="scan\.css"/);
    // Student mode must not require teacher auth: only the public RPCs are used.
    assert.doesNotMatch(scanHtml, /password/i);
});

test("QR scanning is student-only and a missing session means no class", () => {
    const scanHtml = read("scan.html");
    const scanJs = read("scan.js");

    // No teacher-side camera: scanning belongs to the student page only.
    assert.doesNotMatch(scanHtml, /host-scan-btn|host-qr-reader|host-stop-scan-btn|host-scan-hint/);
    assert.doesNotMatch(scanJs, /hostCheckIn|scanTarget/);
    assert.equal((scanJs.match(/new window\.Html5Qrcode/g) || []).length, 1, "one scanner, student page");
    assert.match(scanHtml, /Record manually/);
    assert.match(scanHtml, /for students only/i);

    // No session -> "walang pasok" screen, and the teacher still records by hand.
    assert.match(scanHtml, /id="view-noclass"/);
    assert.match(scanJs, /function showNoClass/);
    assert.match(scanJs, /invalid_session/);
    assert.match(read("main.html"), /Walang QR session = walang pasok/);
    assert.match(read("main.html"), /manual records never need a QR session/i);
});

test("every locally referenced asset exists", () => {
    const dir = (p) => path.resolve(ROOT, p);
    for (const page of PAGES) {
        const html = read(page);
        const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
            .map((match) => match[1])
            .filter((href) => !/^(https?:|data:|mailto:|#|\/)/.test(href));
        for (const href of refs) {
            assert.ok(fs.existsSync(dir(href)), `${page} references missing asset ${href}`);
        }
    }
});

test("service worker caches the new shell and the QR page offline", () => {
    const sw = read("sw.js");
    assert.match(sw, /scholog-shell-v6/);
    for (const asset of [
        "./scan.html", "./scan.css", "./scan.js", "./pdf.js",
        "./vendor/supabase.js", "./vendor/qrcode.js", "./vendor/html5-qrcode.min.js",
        "./vendor/jspdf.umd.min.js", "./vendor/jspdf.autotable.min.js", "./vendor/lucide.min.js"
    ]) {
        assert.ok(sw.includes(`"${asset}"`), `sw caches ${asset}`);
    }
});

test("manifest exposes the check-in page", () => {
    const manifest = JSON.parse(read("manifest.json"));
    assert.equal(manifest.start_url, "/index.html");
    assert.ok(manifest.shortcuts.some((shortcut) => shortcut.url === "/scan.html"));
    assert.match(manifest.description, /check-in/i);
});

test("all pages are mobile-friendly and self-host their libraries", () => {
    for (const page of PAGES) {
        const html = read(page);
        assert.match(html, /name="viewport"/, `${page} has a viewport meta tag`);
        assert.doesNotMatch(html, /<script[^>]+src="https?:/, `${page} uses vendored scripts`);
    }
});

test("Supabase credentials match the shared .env", () => {
    const env = Object.fromEntries(
        read(".env").split(/\r?\n/).filter(Boolean).map((line) => {
            const [key, ...rest] = line.split("=");
            return [key, rest.join("=").trim()];
        })
    );
    for (const file of ["script.js", "main.js", "scan.js"]) {
        const source = read(file);
        assert.ok(source.includes(env.VITE_SUPABASE_URL), `${file} uses the configured Supabase URL`);
        assert.ok(source.includes(env.VITE_SUPABASE_ANON_KEY), `${file} uses the configured anon key`);
    }
});

test("attendance writes target the real composite unique key", () => {
    const source = read("main.js");
    assert.match(source, /onConflict: "user_id,date,student_id,subject"/);
    assert.doesNotMatch(source, /onConflict: "user_id,date,student_id"/);
    // Every attendance write carries the subject column used by the unique key.
    assert.match(source, /subject: "General"/);
});

test("deployment hardening: Vercel headers, robots and sitemap are in place", () => {
    const vercel = JSON.parse(read("vercel.json"));
    const globalHeaders = vercel.headers.find((entry) => entry.source === "/(.*)");
    assert.ok(globalHeaders, "vercel.json defines global headers");
    const keys = Object.fromEntries(globalHeaders.headers.map((h) => [h.key, h.value]));
    for (const header of ["Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"]) {
        assert.ok(keys[header], `sends ${header}`);
    }
    assert.match(keys["Content-Security-Policy"], /default-src 'self'/);
    assert.match(keys["Content-Security-Policy"], /object-src 'none'/);
    // Long-lived caching only for immutable vendored libraries.
    const vendor = vercel.headers.find((entry) => entry.source === "/vendor/(.*)");
    assert.match(vendor.headers[0].value, /immutable/);

    assert.match(read("robots.txt"), /Sitemap: https:\/\/scholog\.vercel\.app\/sitemap\.xml/);
    assert.match(read("robots.txt"), /Disallow: \/main\.html/);
    const sitemap = read("sitemap.xml");
    assert.match(sitemap, /<loc>https:\/\/scholog\.vercel\.app\/<\/loc>/);
});

test("SEO and accessibility basics on every page", () => {
    for (const page of PAGES) {
        const html = read(page);
        assert.match(html, /<meta name="description" content="[^"]{40,}"/, `${page} has a meta description`);
        assert.match(html, /<html lang="[a-z]{2}"/, `${page} declares a language`);
        assert.equal((html.match(/<h1[\s>]/g) || []).length >= 1, true, `${page} has an h1`);
        assert.doesNotMatch(html, /<img(?![^>]*\balt=)[^>]*>/, `${page}: every image has alt text`);
    }
    const index = read("index.html");
    assert.match(index, /<main class="container">/, "login page has a main landmark");
    assert.match(index, /<meta property="og:title"/, "login page has Open Graph tags");
    assert.match(index, /<meta name="twitter:card"/, "login page has Twitter card tags");

    const mainHtml = read("main.html");
    assert.equal((mainHtml.match(/class="modal-backdrop hidden" role="dialog"/g) || []).length, 8,
        "every modal is a labelled dialog");
    assert.doesNotMatch(mainHtml, /role="dialog"(?![^>]*aria-label)/, "dialogs are labelled");
});

test("images are optimised for the web", () => {
    for (const asset of ["SchologLogo.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
        const size = fs.statSync(path.join(ROOT, asset)).size;
        assert.ok(size < 120 * 1024, `${asset} stays under 120 KB (currently ${Math.round(size / 1024)} KB)`);
    }
});

test("the heavy PDF libraries load on demand, not on every page view", () => {
    const mainHtml = read("main.html");
    assert.doesNotMatch(mainHtml, /<script src="vendor\/jspdf/, "jsPDF is not loaded eagerly");
    assert.match(read("main.js"), /function loadPdfLibraries/);
    // Still cached by the service worker so offline exports keep working.
    assert.match(read("sw.js"), /vendor\/jspdf\.umd\.min\.js/);
    // Vendor scripts must not sit in <head> and block the first paint.
    for (const page of ["index.html", "main.html", "scan.html"]) {
        const head = read(page).split("</head>")[0];
        assert.doesNotMatch(head, /<script src=/, `${page} has no render-blocking external scripts`);
    }
});
