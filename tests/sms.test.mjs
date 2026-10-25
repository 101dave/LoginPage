// Guardian SMS helpers: encoding, billing, phone numbers, templates, decisions.
import test from "node:test";
import assert from "node:assert/strict";

await import("../sms.js");
const Sms = globalThis.SchologSms;

const STUDENT = { student_id: "2026-0001", name: "Juan Dela Cruz", section: "Grade 8 - Rizal" };
const GUARDIAN = { phone: "0917 123 4567", consent: true };
const NOON = new Date("2026-10-23T12:00:00+08:00");
const LATE_NIGHT = new Date("2026-10-23T22:30:00+08:00");

test("keeps messages inside the cheap GSM-7 alphabet", () => {
    const peso = Sms.toGsm7("Bayad: \u20b135 para sa load \u2014 salamat\u2026");
    assert.equal(peso.text, "Bayad: PHP35 para sa load - salamat...");
    assert.equal(peso.unicode, false);
    assert.ok(peso.replaced.includes("\u20b1"), "the peso sign is rewritten, not dropped");

    // A peso sign alone would have flipped the whole message to UCS-2 billing.
    const unicode = Sms.segmentCount("Bayad: \u20b135");
    assert.equal(unicode.encoding, "UCS-2");
    assert.equal(Sms.segmentCount(peso.text).encoding, "GSM-7");

    // ñ is part of the GSM alphabet and must survive untouched.
    const enye = Sms.toGsm7("Si Pe\u00f1a ay absent");
    assert.equal(enye.text, "Si Pe\u00f1a ay absent");
    assert.deepEqual(enye.replaced, []);

    // e-acute/egrave and enye ARE in the GSM alphabet and must not be mangled.
    assert.equal(Sms.toGsm7("Jos\u00e9").text, "Jos\u00e9");

    // Accents that are not in it are dropped rather than the whole letter.
    assert.equal(Sms.toGsm7("Mar\u00eda").text, "Maria");

    // Emoji and other symbols are removed so they cannot double the cost.
    assert.equal(Sms.toGsm7("Absent \u{1F44D} si Ana").text, "Absent si Ana");
});

test("bills by GSM-7 segment, with 153 characters per concatenated part", () => {
    assert.deepEqual(Sms.segmentCount(""), { encoding: "GSM-7", chars: 0, segments: 1, remaining: 160 });
    assert.equal(Sms.segmentCount("a".repeat(160)).segments, 1);
    assert.equal(Sms.segmentCount("a".repeat(161)).segments, 2);
    assert.equal(Sms.segmentCount("a".repeat(306)).segments, 2);
    assert.equal(Sms.segmentCount("a".repeat(307)).segments, 3);

    // Extension characters { } [ ] ~ ^ \ | and the euro sign cost two positions.
    assert.equal(Sms.segmentCount("{".repeat(80)).chars, 160);
    assert.equal(Sms.segmentCount("{".repeat(80)).segments, 1);
    assert.equal(Sms.segmentCount("{".repeat(81)).segments, 2);

    // UCS-2 messages bill 70/67 characters per part.
    assert.equal(Sms.segmentCount("\u4f60".repeat(70)).segments, 1);
    assert.equal(Sms.segmentCount("\u4f60".repeat(71)).segments, 2);
});

test("fits a message into a segment budget", () => {
    const long = "a".repeat(400);
    const fitted = Sms.fitToSegments(long, 1);
    assert.equal(Sms.segmentCount(fitted).segments, 1);
    assert.match(fitted, /\.\.\.$/);
    assert.equal(Sms.fitToSegments("short", 1), "short");
    assert.equal(Sms.segmentCount(Sms.fitToSegments(long, 2)).segments, 2);
});

test("normalizes Philippine mobile numbers to E.164 and rejects landlines", () => {
    const cases = [
        ["0917 123 4567", "+639171234567"],
        ["09171234567", "+639171234567"],
        ["9171234567", "+639171234567"],
        ["+63 917 123 4567", "+639171234567"],
        ["639171234567", "+639171234567"],
        ["00639171234567", "+639171234567"],
        ["(+63) 917-123-4567", "+639171234567"]
    ];
    for (const [input, expected] of cases) {
        assert.equal(Sms.normalizePhMobile(input), expected, input);
    }

    assert.equal(Sms.parsePhMobile("0917 123 4567").network, "Globe/TM");
    assert.equal(Sms.parsePhMobile("0955 123 4567").network, "Globe/TM");
    assert.equal(Sms.parsePhMobile("0895 123 4567").network, "DITO");
    assert.equal(Sms.parsePhMobile("0999 123 4567").network, "Smart/TNT");

    for (const bad of ["", "   ", "02 8123 4567", "12345", "juan@example.com", "0999"]) {
        assert.equal(Sms.normalizePhMobile(bad), null, `rejects ${JSON.stringify(bad)}`);
    }
    assert.equal(Sms.parsePhMobile("").reason, "empty");
    assert.equal(Sms.parsePhMobile("02 8123 4567").reason, "not_a_ph_mobile");
});

test("estimates the peso cost of a send", () => {
    assert.deepEqual(Sms.estimateCost(1), {
        rate: 0.35, currency: "PHP", segments: 1, total: 0.35, formatted: "PHP 0.35"
    });
    assert.equal(Sms.estimateCost(2).total, 0.7);
    assert.equal(Sms.estimateCost(1, { ratePerSms: 0.56 }).total, 0.56);
    assert.equal(Sms.estimateCost(0).segments, 1, "a zero count still bills one message");
});

test("builds a Tagalog absence message that fits one segment", () => {
    const message = Sms.buildGuardianMessage({
        kind: "absent",
        lang: "tl",
        student: STUDENT,
        guardian: GUARDIAN,
        section: STUDENT.section,
        date: NOON,
        teacher: "Ms. Cruz"
    });

    assert.equal(message.to, "+639171234567");
    assert.equal(message.kind, "absent");
    assert.match(message.body, /Juan Dela Cruz/);
    assert.match(message.body, /23 Oct 2026/);
    assert.match(message.body, /Grade 8 - Rizal/);
    assert.match(message.body, /Ms\. Cruz/);
    assert.equal(message.encoding, "GSM-7");
    assert.equal(message.segments, 1, "the default absence text must stay one segment");
    assert.equal(message.cost.total, 0.35);
    assert.deepEqual(message.warnings, []);
    assert.equal(message.dedupeKey, "2026-0001:2026-10-23:absent");
});

test("builds the English variants and flags a missing number", () => {
    const english = Sms.buildGuardianMessage({
        kind: "repeated_absent",
        lang: "en",
        student: STUDENT,
        guardian: GUARDIAN,
        date: NOON,
        teacher: "Ms. Cruz",
        count: 3
    });
    assert.match(english.body, /3 absences/);
    assert.doesNotMatch(english.body, /TODAY/);
    assert.ok(english.body.length > 0);

    const noPhone = Sms.buildGuardianMessage({
        kind: "absent", student: STUDENT, guardian: {}, date: NOON, teacher: "Ms. Cruz"
    });
    assert.equal(noPhone.to, null);
    assert.deepEqual(noPhone.warnings, ["no_valid_guardian_number"]);
});

test("a long name is trimmed to the segment budget, never sent at 4x the price", () => {
    const message = Sms.buildGuardianMessage({
        kind: "repeated_absent",
        student: { student_id: "2026-0009", name: "Maria Concepcion Dela Cruz-Villanueva Santos" },
        guardian: GUARDIAN,
        section: "Grade 11 - STEM A",
        date: NOON,
        teacher: "Ms. Maria Concepcion Santos-Cruz",
        count: 7,
        maxSegments: 1
    });
    assert.equal(message.segments, 1);
    assert.match(message.body, /\.\.\.$/);
});

test("decides when a guardian is texted", () => {
    const base = {
        studentId: "2026-0001",
        status: "Absent",
        guardian: GUARDIAN,
        context: { absencesIncludingToday: 1, now: NOON, date: NOON, alreadySent: [] }
    };

    const ok = Sms.decideGuardianAlert(base);
    assert.equal(ok.send, true);
    assert.equal(ok.reason, "ok");
    assert.equal(ok.kind, "absent");

    assert.equal(Sms.decideGuardianAlert({ ...base, status: "Present" }).reason, "present");
    assert.equal(Sms.decideGuardianAlert({ ...base, status: "Excused" }).reason, "excused");
    assert.equal(Sms.decideGuardianAlert({ ...base, guardian: { ...GUARDIAN, consent: false } }).reason, "no_consent");
    assert.equal(Sms.decideGuardianAlert({ ...base, guardian: { ...GUARDIAN, optedOut: true } }).reason, "opted_out");
    assert.equal(Sms.decideGuardianAlert({ ...base, guardian: { phone: "" } }).reason, "no_guardian_phone");
    assert.equal(Sms.decideGuardianAlert({ ...base, status: "Late" }).reason, "late_disabled");

    const sent = Sms.decideGuardianAlert({
        ...base,
        context: { ...base.context, alreadySent: ["2026-0001:2026-10-23:absent"] }
    });
    assert.equal(sent.send, false);
    assert.equal(sent.reason, "duplicate");

    const late = Sms.decideGuardianAlert({ ...base, status: "Late", settings: { notifyOnLate: true } });
    assert.equal(late.kind, "late");
    assert.equal(late.send, true);
});

test("escalates after the configured number of absences", () => {
    const base = {
        studentId: "2026-0001",
        status: "Absent",
        guardian: GUARDIAN,
        context: { now: NOON, date: NOON, alreadySent: [] }
    };
    assert.equal(Sms.decideGuardianAlert({ ...base, context: { ...base.context, absencesIncludingToday: 2 } }).kind, "absent");
    assert.equal(Sms.decideGuardianAlert({ ...base, context: { ...base.context, absencesIncludingToday: 3 } }).kind, "repeated_absent");
    assert.equal(Sms.decideGuardianAlert({
        ...base,
        settings: { repeatThreshold: 2 },
        context: { ...base.context, absencesIncludingToday: 2 }
    }).kind, "repeated_absent");
});

test("holds messages during quiet hours", () => {
    assert.equal(Sms.isQuietHours(NOON, { start: 20, end: 6 }), false);
    assert.equal(Sms.isQuietHours(LATE_NIGHT, { start: 20, end: 6 }), true);
    assert.equal(Sms.isQuietHours(new Date("2026-10-23T05:30:00+08:00"), { start: 20, end: 6 }), true);
    assert.equal(Sms.isQuietHours(new Date("2026-10-23T06:00:00+08:00"), { start: 20, end: 6 }), false);
    assert.equal(Sms.isQuietHours(new Date("2026-10-23T13:00:00+08:00"), { start: 9, end: 17 }), true);
    assert.equal(Sms.isQuietHours(NOON, null), false);

    const held = Sms.decideGuardianAlert({
        studentId: "2026-0001",
        status: "Absent",
        guardian: GUARDIAN,
        context: { absencesIncludingToday: 1, now: LATE_NIGHT, date: LATE_NIGHT, alreadySent: [] }
    });
    assert.equal(held.send, false);
    assert.equal(held.reason, "quiet_hours");
});

test("dedupe keys are stable per student, date and kind", () => {
    const key = Sms.dedupeKey({ studentId: "2026-0001", date: "2026-10-23T08:00:00+08:00", kind: "absent" });
    assert.equal(key, "2026-0001:2026-10-23:absent");
    assert.equal(key, Sms.dedupeKey({ studentId: "2026-0001", date: NOON, kind: "absent" }));
    assert.notEqual(key, Sms.dedupeKey({ studentId: "2026-0001", date: NOON, kind: "late" }));
});

test("renderTemplate tolerates missing values", () => {
    assert.equal(Sms.renderTemplate("Hi {name}, {missing}!", { name: "Ana" }), "Hi Ana, !");
    assert.equal(Sms.renderTemplate("Hi { name }", { name: "Ana" }), "Hi Ana");
    assert.equal(Sms.renderTemplate(null, {}), "");
});
