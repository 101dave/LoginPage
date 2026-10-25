// Scholog — Guardian SMS helpers.
//
// Dependency-free and side-effect-free so the same code runs in the browser
// (before showing the teacher a cost/segment preview) and in the Supabase Edge
// Function that actually sends. Unit tested in Node, like pdf.js.
//
// Nothing here talks to a provider or a database: it only decides *what* to
// send, *whether* it should be sent, and *how much* it costs.
(function (root) {
    "use strict";

    // ---------------------------------------------------------------- GSM 03.38
    // The default alphabet. A message made only of these characters is billed
    // per 160 characters (153 per part once it splits); anything else drops the
    // whole message to UCS-2 billing at 70/67 characters — roughly 2x the cost.
    var GSM7_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡" +
        "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
    // Characters that are legal but bill as two positions.
    var GSM7_EXT = "\f^{}\\[~]|€";

    var GSM7_COST = Object.create(null);
    for (var i = 0; i < GSM7_BASIC.length; i++) GSM7_COST[GSM7_BASIC.charAt(i)] = 1;
    for (var j = 0; j < GSM7_EXT.length; j++) GSM7_COST[GSM7_EXT.charAt(j)] = 2;

    // Rewrites for characters that are common in Philippine school data but are
    // not in the GSM alphabet. The peso sign alone would double every message.
    var REPLACEMENTS = [
        ["\u20b1", "PHP"],   // ₱
        ["\u2018", "'"], ["\u2019", "'"],
        ["\u201c", "\""], ["\u201d", "\""],
        ["\u2013", "-"], ["\u2014", "-"], ["\u2212", "-"],
        ["\u2026", "..."], ["\u2022", "-"],
        ["\u2265", ">="], ["\u2264", "<="],
        ["\u00d7", "x"], ["\u00f7", "/"],
        ["\u00a0", " "], ["\u200b", ""]
    ];

    var TEMPLATES = {
        absent: {
            tl: "SCHOLOG: Si {name} ay ABSENT ngayong {date} sa {section}. Abiso mula kay {teacher}. Huwag sagutin.",
            en: "SCHOLOG: {name} was ABSENT today, {date} ({section}). Notice from {teacher}. Please do not reply."
        },
        late: {
            tl: "SCHOLOG: Si {name} ay LATE ngayong {date} sa {section}. Abiso mula kay {teacher}. Huwag sagutin.",
            en: "SCHOLOG: {name} arrived LATE today, {date} ({section}). Notice from {teacher}. Please do not reply."
        },
        repeated_absent: {
            tl: "SCHOLOG: Si {name} ay may {count} absences na sa {section}. Makipag-ugnayan po sa adviser na si {teacher}. Huwag sagutin.",
            en: "SCHOLOG: {name} now has {count} absences in {section}. Please contact the adviser, {teacher}. Do not reply."
        },
        term_ready: {
            tl: "SCHOLOG: Kunin na po ang report card ni {name} sa {section} kay {teacher}. Huwag sagutin.",
            en: "SCHOLOG: {name}'s report card ({section}) is ready. Please get it from {teacher}. Do not reply."
        }
    };

    // Published prefixes as a *hint only* — mobile number portability (and new
    // prefixes) mean a prefix can no longer prove the network. Never block on it.
    var NETWORKS = [
        { name: "DITO", prefixes: ["0895", "0896", "0897", "0898"] },
        { name: "Sun", prefixes: ["0922", "0923", "0924", "0925", "0932", "0933", "0943", "0944"] },
        {
            name: "Globe/TM",
            prefixes: [
                "0817", "0904", "0905", "0906", "0915", "0916", "0917", "0926", "0927",
                "0935", "0936", "0937", "0945", "0953", "0954", "0955", "0956", "0965",
                "0966", "0967", "0975", "0976", "0977", "0995", "0996", "0997"
            ]
        },
        {
            name: "Smart/TNT",
            prefixes: [
                "0907", "0908", "0909", "0910", "0911", "0912", "0918", "0919", "0920",
                "0921", "0928", "0929", "0930", "0938", "0939", "0946", "0947", "0948",
                "0949", "0950", "0951", "0961", "0963", "0964", "0968", "0969", "0970",
                "0981", "0989", "0990", "0998", "0999"
            ]
        }
    ];

    var DEFAULT_SETTINGS = {
        notifyOnAbsent: true,
        notifyOnLate: false,
        repeatThreshold: 3,      // 3rd (and later) absence switches to the escalation text
        quietHours: { start: 20, end: 6 }, // 8pm -> 6am: hold until morning
        maxSegments: 2,
        ratePerSms: 0.35,        // PHP, PhilSMS-class local rate; override per school
        currency: "PHP"
    };

    // ---------------------------------------------------------------- helpers

    function settingsWith(overrides) {
        var out = {};
        Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
            out[key] = DEFAULT_SETTINGS[key];
        });
        Object.keys(overrides || {}).forEach(function (key) {
            if (overrides[key] !== undefined) out[key] = overrides[key];
        });
        if (!out.quietHours) out.quietHours = DEFAULT_SETTINGS.quietHours;
        return out;
    }

    function stripDiacritics(ch) {
        if (typeof ch.normalize !== "function") return ch;
        return ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }

    /**
     * Rewrite text so it stays inside the GSM 7-bit alphabet.
     * @returns {{text:string, replaced:Array<string>, unicode:boolean}}
     */
    function toGsm7(value) {
        var text = String(value == null ? "" : value);
        var replaced = [];
        REPLACEMENTS.forEach(function (pair) {
            if (text.indexOf(pair[0]) !== -1) {
                text = text.split(pair[0]).join(pair[1]);
                replaced.push(pair[0]);
            }
        });

        var out = "";
        for (var index = 0; index < text.length; index++) {
            var ch = text.charAt(index);
            if (GSM7_COST[ch] !== undefined) {
                out += ch;
                continue;
            }
            // Keep accented Latin letters by dropping the accent (Peña -> Pena).
            var base = stripDiacritics(ch);
            if (base && base !== ch && GSM7_COST[base] !== undefined) {
                out += base;
                replaced.push(ch);
                continue;
            }
            // Emoji, CJK, symbols and anything else are dropped.
            if (ch.trim() !== "") replaced.push(ch);
        }
        out = out.replace(/[ \t]{2,}/g, " ").trim();
        return { text: out, replaced: replaced, unicode: !isGsm7(out) };
    }

    function isGsm7(text) {
        for (var index = 0; index < text.length; index++) {
            if (GSM7_COST[text.charAt(index)] === undefined) return false;
        }
        return true;
    }

    /**
     * Billing estimate for one message.
     * @returns {{encoding:string, chars:number, segments:number, remaining:number}}
     */
    function segmentCount(value) {
        var text = String(value == null ? "" : value);
        if (text.length === 0) return { encoding: "GSM-7", chars: 0, segments: 1, remaining: 160 };

        if (isGsm7(text)) {
            var units = 0;
            for (var index = 0; index < text.length; index++) {
                units += GSM7_COST[text.charAt(index)];
            }
            // One part holds 160 units; each part of a concatenated message holds 153.
            var parts = units <= 160 ? 1 : Math.ceil(units / 153);
            return {
                encoding: "GSM-7",
                chars: units,
                segments: parts,
                remaining: (parts === 1 ? 160 : parts * 153) - units
            };
        }

        // UCS-2: 70 characters for one part, 67 per part when concatenated.
        var length = text.length;
        var ucsParts = length <= 70 ? 1 : Math.ceil(length / 67);
        return {
            encoding: "UCS-2",
            chars: length,
            segments: ucsParts,
            remaining: (ucsParts === 1 ? 70 : ucsParts * 67) - length
        };
    }

    /**
     * Truncate to at most `maxSegments`, adding an ellipsis when it cuts.
     */
    function fitToSegments(value, maxSegments) {
        var text = String(value == null ? "" : value);
        var limit = Math.max(1, maxSegments || 1);
        if (segmentCount(text).segments <= limit) return text;

        var budget = limit === 1 ? 160 : limit * 153;
        if (!isGsm7(text)) budget = limit === 1 ? 70 : limit * 67;

        var used = 0;
        var cut = "";
        for (var index = 0; index < text.length; index++) {
            var ch = text.charAt(index);
            var cost = GSM7_COST[ch] === undefined ? 1 : GSM7_COST[ch];
            var reserve = 3; // room for "..."
            if (used + cost + reserve > budget) break;
            cut += ch;
            used += cost;
        }
        return (cut ? cut.replace(/[\s,.;:]+$/, "") : "") + "...";
    }

    /** @returns {{ok:boolean, e164:string|null, local:string|null, network:string, reason:string}} */
    function parsePhMobile(value) {
        var raw = String(value == null ? "" : value).trim();
        if (!raw) return { ok: false, e164: null, local: null, network: "unknown", reason: "empty" };

        var digits = raw.replace(/[^\d+]/g, "");
        if (digits.indexOf("+") > 0) digits = digits.split("+").join("");
        if (digits.charAt(0) === "+") digits = digits.slice(1);
        if (/^00/.test(digits)) digits = digits.slice(2);

        // National format is 11 digits starting 0. Mobile blocks start 08 (DITO)
        // or 09 (Globe/TM, Smart/TNT); landlines (02, 03, 04...) are rejected.
        var national;
        if (/^63[89]\d{9}$/.test(digits)) national = "0" + digits.slice(2);
        else if (/^0[89]\d{9}$/.test(digits)) national = digits;
        else if (/^[89]\d{9}$/.test(digits)) national = "0" + digits;
        else return { ok: false, e164: null, local: null, network: "unknown", reason: "not_a_ph_mobile" };

        var prefix = national.slice(0, 4);
        var network = "unknown";
        for (var index = 0; index < NETWORKS.length; index++) {
            if (NETWORKS[index].prefixes.indexOf(prefix) !== -1) {
                network = NETWORKS[index].name;
                break;
            }
        }
        return {
            ok: true,
            e164: "+63" + national.slice(1),
            local: national,
            network: network,
            reason: "ok"
        };
    }

    function normalizePhMobile(value) {
        return parsePhMobile(value).e164;
    }

    /** @returns {{rate:number, currency:string, segments:number, total:number, formatted:string}} */
    function estimateCost(segments, options) {
        var opts = options || {};
        var settings = settingsWith({ ratePerSms: opts.ratePerSms, currency: opts.currency });
        var count = Math.max(1, Number(segments) || 1);
        var total = Math.round(count * settings.ratePerSms * 10000) / 10000;
        return {
            rate: settings.ratePerSms,
            currency: settings.currency,
            segments: count,
            total: total,
            formatted: settings.currency + " " + total.toFixed(2)
        };
    }

    function renderTemplate(template, vars) {
        var values = vars || {};
        return String(template == null ? "" : template).replace(/\{\s*([a-zA-Z0-9_]+)\s*\}/g, function (match, key) {
            var value = values[key];
            return value == null ? "" : String(value);
        });
    }

    /** "23 Oct 2026" — short, ASCII and unambiguous for both languages. */
    function formatDate(value) {
        var date = value instanceof Date ? value : new Date(value);
        if (isNaN(date.getTime())) return "";
        var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        return date.getDate() + " " + months[date.getMonth()] + " " + date.getFullYear();
    }

    function ymd(value) {
        var date = value instanceof Date ? value : new Date(value);
        if (isNaN(date.getTime())) return String(value == null ? "" : value).slice(0, 10);
        return date.getFullYear() + "-" +
            String(date.getMonth() + 1).padStart(2, "0") + "-" +
            String(date.getDate()).padStart(2, "0");
    }

    function dedupeKey(opts) {
        var options = opts || {};
        return [
            String(options.studentId == null ? "" : options.studentId),
            ymd(options.date),
            String(options.kind || "absent")
        ].join(":");
    }

    // Quiet hours are Philippine wall-clock hours. Using the device's own
    // timezone would hold or release messages wrongly for anyone travelling,
    // and makes the behaviour impossible to test deterministically.
    function manilaHour(date) {
        try {
            var formatted = new Intl.DateTimeFormat("en-US", {
                timeZone: "Asia/Manila", hour: "2-digit", hour12: false
            }).format(date);
            var hour = parseInt(formatted, 10);
            if (isFinite(hour)) return hour % 24;
        } catch (e) { /* fall back to the device clock */ }
        return date.getHours();
    }

    function isQuietHours(now, quietHours) {
        var window = quietHours || DEFAULT_SETTINGS.quietHours;
        if (!window) return false;
        var hour = manilaHour(now instanceof Date ? now : new Date(now));
        if (window.start === window.end) return false;
        if (window.start < window.end) return hour >= window.start && hour < window.end;
        return hour >= window.start || hour < window.end; // wraps midnight
    }

    /**
     * Build one guardian message: body, billing and cost, ready to preview.
     * @param {{kind:string, lang?:string, student?:object, guardian?:object, section?:string,
     *          date?:Date|string, count?:number, teacher?:string, ratePerSms?:number,
     *          maxSegments?:number, fit?:boolean}} opts
     */
    function buildGuardianMessage(opts) {
        var options = opts || {};
        var kind = TEMPLATES[options.kind] ? options.kind : "absent";
        var lang = options.lang === "en" ? "en" : "tl";
        var settings = settingsWith({
            ratePerSms: options.ratePerSms,
            maxSegments: options.maxSegments
        });
        var student = options.student || {};
        var guardian = options.guardian || {};

        var body = renderTemplate(TEMPLATES[kind][lang], {
            name: student.name || "your child",
            section: options.section || student.section || "your section",
            date: formatDate(options.date || new Date()),
            time: options.time || "",
            count: options.count == null ? "" : options.count,
            teacher: options.teacher || "the adviser"
        });

        body = toGsm7(body).text;
        if (options.fit !== false) body = fitToSegments(body, settings.maxSegments);

        var billing = segmentCount(body);
        var cost = estimateCost(billing.segments, {
            ratePerSms: settings.ratePerSms,
            currency: settings.currency
        });
        var phone = parsePhMobile(guardian.phone);

        return {
            kind: kind,
            lang: lang,
            body: body,
            to: phone.e164,
            network: phone.network,
            encoding: billing.encoding,
            segments: billing.segments,
            remaining: billing.remaining,
            cost: cost,
            dedupeKey: dedupeKey({ studentId: student.student_id || student.id, date: options.date || new Date(), kind: kind }),
            warnings: phone.ok ? [] : ["no_valid_guardian_number"]
        };
    }

    /**
     * Decide whether a guardian should be texted, and with which template.
     * Pure: pass in the guardian's consent, today's absence count and the log.
     * @returns {{send:boolean, kind:string|null, reason:string, dedupeKey:string}}
     */
    function decideGuardianAlert(opts) {
        var options = opts || {};
        var settings = settingsWith(options.settings);
        var guardian = options.guardian || {};
        var context = options.context || {};
        var status = String(options.status || "");
        var now = context.now instanceof Date ? context.now : new Date(context.now || Date.now());
        var absences = Number(context.absencesIncludingToday) || 0;
        var kind = status === "Late" ? "late" : (absences >= settings.repeatThreshold ? "repeated_absent" : "absent");
        var key = dedupeKey({ studentId: options.studentId, date: context.date || now, kind: kind });
        var already = Array.isArray(context.alreadySent) ? context.alreadySent : [];

        function result(send, reason) {
            return { send: send, kind: send ? kind : null, reason: reason, dedupeKey: key };
        }

        if (status === "Present") return result(false, "present");
        if (status === "Excused") return result(false, "excused");
        if (!parsePhMobile(guardian.phone).ok) return result(false, "no_guardian_phone");
        if (guardian.consent === false) return result(false, "no_consent");
        if (guardian.optedOut === true) return result(false, "opted_out");
        if (status === "Late" && !settings.notifyOnLate) return result(false, "late_disabled");
        if (status === "Absent" && !settings.notifyOnAbsent) return result(false, "absent_disabled");
        if (already.indexOf(key) !== -1) return result(false, "duplicate");
        if (isQuietHours(now, settings.quietHours)) return result(false, "quiet_hours");
        return result(true, "ok");
    }

    var api = {
        VERSION: "1.0.0",
        TEMPLATES: TEMPLATES,
        DEFAULT_SETTINGS: DEFAULT_SETTINGS,
        NETWORKS: NETWORKS,
        toGsm7: toGsm7,
        isGsm7: isGsm7,
        segmentCount: segmentCount,
        fitToSegments: fitToSegments,
        parsePhMobile: parsePhMobile,
        normalizePhMobile: normalizePhMobile,
        estimateCost: estimateCost,
        renderTemplate: renderTemplate,
        formatDate: formatDate,
        ymd: ymd,
        dedupeKey: dedupeKey,
        isQuietHours: isQuietHours,
        manilaHour: manilaHour,
        buildGuardianMessage: buildGuardianMessage,
        decideGuardianAlert: decideGuardianAlert
    };

    root.SchologSms = api;
    if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
