# Vendored browser libraries

These files are pinned copies of npm packages so the PWA works offline and has no
runtime CDN dependency. They are loaded directly by the HTML pages.

| File | Package | Version | License |
| --- | --- | --- | --- |
| `supabase.js` | `@supabase/supabase-js` (UMD) | 2.118.0 | MIT — `LICENSE-supabase-js.txt` |
| `lucide-subset.js` | `lucide` (UMD), subset build | 0.469.0 | ISC — `LICENSE-lucide.txt` |
| `lucide.min.js` | `lucide` (UMD), full build | 0.469.0 | ISC — `LICENSE-lucide.txt` |
| `jspdf.umd.min.js` | `jspdf` | 2.5.2 | MIT — `LICENSE-jspdf.txt` |
| `jspdf.autotable.min.js` | `jspdf-autotable` | 3.8.4 | MIT |
| `qrcode.js` | `qrcode-generator` | 2.0.4 | MIT |
| `html5-qrcode.min.js` | `html5-qrcode` | 2.3.8 | Apache-2.0 — `LICENSE-html5-qrcode.txt` |

`jspdf` and `jspdf-autotable` are also dev dependencies so the PDF test suite runs
against byte-identical builds (`tests/pdf.test.mjs` asserts this).

`lucide-subset.js` is **generated**, not vendored: `scripts/build-icon-subset.mjs`
reads the full `lucide.min.js` and emits only the icons the app references. The
full build stays in this folder as the input for that script (and is no longer
served or precached); `tests/icons.test.mjs` keeps the subset complete.
