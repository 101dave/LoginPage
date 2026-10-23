# Vendored browser libraries

These files are pinned copies of npm packages so the PWA works offline and has no
runtime CDN dependency. They are loaded directly by the HTML pages.

| File | Package | Version | License |
| --- | --- | --- | --- |
| `supabase.js` | `@supabase/supabase-js` (UMD) | 2.118.0 | MIT — `LICENSE-supabase-js.txt` |
| `lucide.min.js` | `lucide` (UMD) | 0.469.0 | ISC — `LICENSE-lucide.txt` |
| `jspdf.umd.min.js` | `jspdf` | 2.5.2 | MIT — `LICENSE-jspdf.txt` |
| `jspdf.autotable.min.js` | `jspdf-autotable` | 3.8.4 | MIT |
| `qrcode.js` | `qrcode-generator` | 2.0.4 | MIT |
| `html5-qrcode.min.js` | `html5-qrcode` | 2.3.8 | Apache-2.0 — `LICENSE-html5-qrcode.txt` |

`jspdf` and `jspdf-autotable` are also dev dependencies so the PDF test suite runs
against byte-identical builds (`tests/pdf.test.mjs` asserts this).
