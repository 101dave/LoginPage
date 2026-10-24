// Scholog — student attendance + score record page.
// Reached from scan.html after a successful check-in:
//   student-record.html?t=<session_token>&sid=<student_id>&uid=<teacher_user_id>
//
// No login required. The page uses the session token to confirm the check-in
// context, then calls the SECURITY DEFINER get_student_record() RPC to fetch
// only this student's attendance history and scores.
(function () {
    "use strict";

    const SUPABASE_URL = "https://jwjivkdgzxuaecplkkad.supabase.co";
    const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3aml2a2Rnenh1YWVjcGxra2FkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2NTU0NzcsImV4cCI6MjEwODIzMTQ3N30.VTFzl7FlP0apBo5ngnclq3eA9aDE-o3I560-XHSiDKg";
    const RPC_TIMEOUT_MS = 12000;

    const $ = (id) => document.getElementById(id);

    let sb = null;
    try {
        sb = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
    } catch (err) {
        console.error("Supabase init failed:", err);
    }

    const state = {
        token: "",
        studentId: "",
        userId: "",
        session: null,
        student: null
    };

    // ---------------------------------------------------------------- helpers

    function showToast(message, type = "success") {
        const container = $("toast-container");
        if (!container) return;
        const toast = document.createElement("div");
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => toast.classList.add("show"), 10);
        setTimeout(() => {
            toast.classList.remove("show");
            setTimeout(() => toast.remove(), 300);
        }, 3200);
    }

    function setView(name) {
        ["loading", "record", "notfound"].forEach((view) => {
            const el = $(`view-${view}`);
            if (el) el.classList.toggle("hidden", view !== name);
        });
    }

    function getParams() {
        const params = new URLSearchParams(window.location.search);
        return {
            token: params.get("t") || params.get("token") || params.get("session") || "",
            studentId: params.get("sid") || params.get("student_id") || params.get("id") || "",
            userId: params.get("uid") || params.get("user_id") || ""
        };
    }

    function formatDate(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return value || "—";
        const d = new Date(`${value}T00:00:00`);
        return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    }

    function escapeHtml(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function statusPillClass(status) {
        switch ((status || "").toLowerCase()) {
            case "present": return "pill-present";
            case "absent": return "pill-absent";
            case "late": return "pill-late";
            case "excused": return "pill-excused";
            default: return "";
        }
    }

    // --------------------------------------------------------------- RPC layer

    async function rpc(fn, body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
        try {
            const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    apikey: SUPABASE_ANON_KEY,
                    Authorization: `Bearer ${SUPABASE_ANON_KEY}`
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            const text = await res.text();
            let data = null;
            try { data = text ? JSON.parse(text) : null; } catch (err) { data = text; }
            if (!res.ok) {
                const message = (data && (data.message || data.error_description || data.hint || data.error)) || `HTTP ${res.status}`;
                throw new Error(message);
            }
            return data;
        } finally {
            clearTimeout(timer);
        }
    }

    // ----------------------------------------------------------- page logic

    async function loadRecord() {
        const p = getParams();
        state.token = p.token;
        state.studentId = p.studentId;
        state.userId = p.userId;

        if (!p.studentId) {
            $("notfound-title").textContent = "Missing student ID";
            $("notfound-text").textContent = "This record page was opened without a student ID. Ask your teacher to check you in first.";
            setView("notfound");
            return;
        }

        if (!p.userId) {
            $("notfound-title").textContent = "Record context missing";
            $("notfound-text").textContent = "Please scan your QR code again from your teacher's session so your record can be loaded.";
            setView("notfound");
            return;
        }

        setView("loading");

        try {
            // Optional: confirm the session exists and get section context.
            if (p.token) {
                const info = await rpc("checkin_session_info", { p_token: p.token });
                if (info && info.ok) {
                    state.session = info;
                    const badge = $("record-section-badge");
                    if (badge) badge.textContent = info.section || "Class";
                } else {
                    console.warn("Session lookup failed:", info && info.error);
                    // Non-fatal — we can still load the record by student ID + user ID.
                }
            }

            const data = await rpc("get_student_record", {
                p_student_id: p.studentId,
                p_user_id: p.userId
            });

            if (!data || !data.ok) {
                $("notfound-title").textContent = "Record not found";
                $("notfound-text").textContent = (data && data.error) || "No attendance or scores found for this student.";
                setView("notfound");
                return;
            }

            state.student = data;
            renderRecord(data);
        } catch (err) {
            console.error("Could not load student record:", err);
            $("notfound-title").textContent = "Could not load record";
            $("notfound-text").textContent = err.message || "Check your connection and try again.";
            setView("notfound");
        }
    }

    function renderRecord(data) {
        $("view-loading").classList.add("hidden");

        $("record-student-name").textContent = data.student_name || "Student";
        $("record-student-id").textContent = `Student ID: ${escapeHtml(data.student_id || "")}`;
        if (data.section) {
            const badge = $("record-section-badge");
            if (badge) badge.textContent = data.section;
        }

        // --- Attendance history ---
        const attBody = $("record-attendance-body");
        const attEmpty = $("record-attendance-empty");
        const totalDays = $("record-total-days");

        const attendance = data.attendance || [];
        totalDays.textContent = `${attendance.length} day${attendance.length !== 1 ? "s" : ""}`;

        if (attendance.length === 0) {
            attBody.innerHTML = "";
            attEmpty.classList.remove("hidden");
        } else {
            attEmpty.classList.add("hidden");
            attBody.innerHTML = attendance.map((row) => `
                <tr>
                    <td>${escapeHtml(formatDate(row.date))}</td>
                    <td class="text-center"><span class="pill ${statusPillClass(row.status)}">${escapeHtml(row.status || "—")}</span></td>
                    <td>${escapeHtml(row.subject || "General")}</td>
                </tr>
            `).join("");
        }

        // --- Scores ---
        const scoreBody = $("record-scores-body");
        const scoreEmpty = $("record-scores-empty");
        const scoreCount = $("record-score-count");

        const scores = data.scores || [];
        scoreCount.textContent = `${scores.length} score${scores.length !== 1 ? "s" : ""}`;

        if (scores.length === 0) {
            scoreBody.innerHTML = "";
            scoreEmpty.classList.remove("hidden");
        } else {
            scoreEmpty.classList.add("hidden");
            scoreBody.innerHTML = scores.map((row) => {
                const pct = row.pct != null ? `${row.pct}%` : "—";
                return `
                    <tr>
                        <td>${escapeHtml(formatDate(row.date))}</td>
                        <td>${escapeHtml(row.subject || "General")}</td>
                        <td class="text-right font-mono">${escapeHtml(String(row.score))} / ${escapeHtml(String(row.max_score))}</td>
                        <td class="text-center"><span class="badge badge-score">${escapeHtml(pct)}</span></td>
                    </tr>
                `;
            }).join("");
        }

        setView("record");
        showToast("Record loaded", "success");
    }

    // ------------------------------------------------------------------ wiring

    document.addEventListener("DOMContentLoaded", () => {
        loadRecord();
    });

})();
