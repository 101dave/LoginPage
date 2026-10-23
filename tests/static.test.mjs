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
    assert.match(sw, /scholog-shell-v3/);
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
