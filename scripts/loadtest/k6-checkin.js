// k6 load test for the Scholog check-in path.
//
//   k6 run scripts/loadtest/k6-checkin.js \
//     -e SUPABASE_URL=https://<staging-ref>.supabase.co \
//     -e SUPABASE_ANON_KEY=<staging anon key> \
//     -e TOKEN=<live session token> \
//     -e STUDENT_IDS=2026-000001,2026-000002,...
//
// STAGING ONLY. This writes real attendance rows (and `checkin_events`), and a
// 10,000-VU ramp against production would corrupt a class's real records.
// Read docs/LOAD_TEST.md before running.
//
// Real-world shape: 10,000 students scanning at the same bell, not 10,000
// teachers pressing Save. Each virtual user sends one check-in per iteration.
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const SUPABASE_URL = __ENV.SUPABASE_URL;
const ANON_KEY = __ENV.SUPABASE_ANON_KEY;
const TOKEN = __ENV.TOKEN;
const STUDENT_IDS = (__ENV.STUDENT_IDS || "").split(",").map((id) => id.trim()).filter(Boolean);
const DEVICE_PREFIX = __ENV.DEVICE_PREFIX || "k6";

if (!SUPABASE_URL || !ANON_KEY || !TOKEN) {
    throw new Error("SUPABASE_URL, SUPABASE_ANON_KEY and TOKEN are required (staging project only).");
}
if (STUDENT_IDS.length === 0) {
    throw new Error("STUDENT_IDS must list at least one student id from the seeded staging class.");
}

const checkinLatency = new Trend("checkin_latency", true);
const checkinAccepted = new Rate("checkin_accepted");

export const options = {
    scenarios: {
        // 10,000 students within a couple of minutes of the bell.
        bell_curve: {
            executor: "ramping-vus",
            startVUs: 0,
            stages: [
                { duration: "1m", target: 50 },
                { duration: "2m", target: 500 },
                { duration: "3m", target: 2000 },
                { duration: "3m", target: 10000 },
                { duration: "2m", target: 10000 },
                { duration: "1m", target: 0 }
            ],
            gracefulRampDown: "30s"
        }
    },
    thresholds: {
        // A student in a corridor will not wait longer than this.
        "http_req_duration{p:95}": ["p(95)<1500"],
        "http_req_failed": ["rate<0.02"],
        checkin_latency: ["p(95)<800"],
        // Some rejections are expected (duplicate device, closed session), so
        // this is informational rather than a hard pass/fail.
        checkin_accepted: ["rate>0.5"]
    },
    summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"]
};

export default function () {
    // One phone = one check-in: a stable pseudo-device per VU, otherwise every
    // iteration would look like the same device and get rejected.
    const deviceId = `${DEVICE_PREFIX}-${__VU}`;
    const studentId = STUDENT_IDS[(__VU + __ITER) % STUDENT_IDS.length];

    const payload = JSON.stringify({
        p_token: TOKEN,
        p_student_id: studentId,
        p_device_id: deviceId
    });

    const res = http.post(`${SUPABASE_URL}/rest/v1/rpc/checkin_mark`, payload, {
        headers: {
            "Content-Type": "application/json",
            apikey: ANON_KEY,
            Authorization: `Bearer ${ANON_KEY}`,
            Prefer: "return=representation"
        },
        tags: { name: "checkin_mark" }
    });

    checkinLatency.add(res.timings.duration);

    const ok = check(res, {
        "http 200": (r) => r.status === 200,
        "rpc answered": (r) => {
            try {
                const body = r.json();
                return body && typeof body === "object" && "ok" in body;
            } catch (err) {
                return false;
            }
        }
    });

    let accepted = false;
    try {
        const body = res.json();
        accepted = Boolean(body && body.ok);
        // Surface the server's verdict once per VU instead of guessing.
        if (!accepted && __ITER === 0) {
            console.warn(`VU ${__VU}: ${JSON.stringify(body)}`);
        }
    } catch (err) {
        /* non-JSON error body, already counted as a failed check */
    }
    checkinAccepted.add(accepted);

    if (!ok) sleep(1);
    // Students stagger themselves; not everyone walks into the room at once.
    sleep(Math.random() * 2);
}
