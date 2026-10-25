// Scholog — student attendance + score record page.
// Reached from scan.html after a successful check-in:
//   student-record.html?t=<session_token>&sid=<student_id>&uid=<teacher_user_id>
//
// No login required. The page uses the session token + device ID to confirm the
// check-in context, then calls the SECURITY DEFINER get_student_record() RPC to
// fetch only this student's attendance history, scores, and computed period grades.
(function () {
    "use strict";

    const SUPABASE_URL = "https://jwjivkdgzxuaecplkkad.supabase.co";
    const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3aml2a2Rnenh1YWVjcGxra2FkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2NTU0NzcsImV4cCI6MjEwODIzMTQ3N30.VTFzl7FlP0apBo5ngnclq3eA9aDE-o3I560-XHSiDKg";
    const RPC_TIMEOUT_MS = 12000;
    const DEVICE_KEY = "scholog_device_id";
    const LOCK_KEY = "scholog_checkin_lock";

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
            token: (params.get("t") || params.get("token") || params.get("session") || "").trim(),
            studentId: (params.get("sid") || params.get("student_id") || params.get("id") || "").trim(),
            userId: (params.get("uid") || params.get("user_id") || "").trim()
        };
    }

    function getDeviceId() {
        try {
            let id = localStorage.getItem(DEVICE_KEY);
            if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
                id = (window.crypto && typeof window.crypto.randomUUID === "function")
                    ? window.crypto.randomUUID()
                    : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
                localStorage.setItem(DEVICE_KEY, id);
            }
            return id;
        } catch (err) {
            return "";
        }
    }

    function readDeviceLock(token) {
        try {
            const raw = JSON.parse(localStorage.getItem(LOCK_KEY) || "null");
            if (!raw || !raw.token) return null;
            if (token && raw.token !== token) return null;
            return raw;
        } catch (err) {
            return null;
        }
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

    // ---------------------------------------------------- grade computation

    function computePeriodSummaries(scores, categories) {
        if (!Array.isArray(scores) || scores.length === 0) return [];

        const cleanCategories = Array.isArray(categories) ? categories : [];
        const periods = [...new Set(scores.map((s) => s.grading_period || s.subject || "General"))];

        return periods.map((period) => {
            const periodScores = scores.filter((s) => (s.grading_period || s.subject || "General") === period);

            // Use configured categories if available; otherwise derive from the score rows themselves.
            const effectiveCategories = cleanCategories.length > 0
                ? cleanCategories.map((c) => ({
                    id: String(c.id || ""),
                    name: String(c.name || "General"),
                    weight: Number(c.weight ?? 0),
                    items: Array.isArray(c.items) && c.items.length > 0 ? c.items : [{ id: "item-1", label: "#1" }]
                }))
                : (() => {
                    const byCat = new Map();
                    periodScores.forEach((s) => {
                        const key = s.category_id || s.category_name || "General";
                        if (!byCat.has(key)) {
                            byCat.set(key, {
                                id: String(s.category_id || ""),
                                name: String(s.category_name || "General"),
                                weight: Number(s.category_weight ?? 100),
                                items: []
                            });
                        }
                        const entry = byCat.get(key);
                        const itemId = String(s.item_id || "item-1");
                        if (!entry.items.some((i) => i.id === itemId)) {
                            entry.items.push({ id: itemId, label: String(s.item_label || "#1") });
                        }
                    });
                    return [...byCat.values()];
                })();

            // Pick the latest-dated score per (category, item) within this period.
            const latestByCatItem = new Map();
            periodScores.forEach((s) => {
                const cat = effectiveCategories.find((c) => c.id && c.id === String(s.category_id || ""))
                    || effectiveCategories.find((c) => c.name === String(s.category_name || "General"));
                if (!cat) return;
                const items = cat.items || [];
                const matchedItem = items.find((i) => i.id === s.item_id)
                    || ((!s.item_id || s.item_id === "item-1") ? items[0] : null)
                    || { id: String(s.item_id || "item-1") };
                const score = Number(s.score);
                const maxScore = Number(s.max_score);
                if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) return;

                const mapKey = `${cat.id || cat.name}::${matchedItem.id}`;
                const prev = latestByCatItem.get(mapKey);
                const rowDate = String(s.date || "");
                if (!prev || rowDate >= prev.date) {
                    latestByCatItem.set(mapKey, {
                        catKey: cat.id || cat.name,
                        itemId: matchedItem.id,
                        score,
                        maxScore,
                        date: rowDate
                    });
                }
            });

            let weightedGrade = 0;
            let coveredWeight = 0;
            let allWeightedItemsScored = true;
            const totalWeight = effectiveCategories.reduce((sum, c) => sum + Number(c.weight || 0), 0);

            const categoryBreakdowns = effectiveCategories.map((cat) => {
                const catKey = cat.id || cat.name;
                const itemCount = Math.max(1, (cat.items || []).length);
                let catScore = 0;
                let catMax = 0;
                let scoredCount = 0;

                latestByCatItem.forEach((entry) => {
                    if (entry.catKey !== catKey) return;
                    catScore += entry.score;
                    catMax += entry.maxScore;
                    scoredCount += 1;
                });

                if (cat.weight > 0 && scoredCount < itemCount) {
                    allWeightedItemsScored = false;
                }
                const pct = catMax > 0 ? (catScore / catMax) * 100 : null;
                if (pct !== null) {
                    weightedGrade += pct * cat.weight;
                    coveredWeight += cat.weight;
                }

                return {
                    name: cat.name,
                    weight: cat.weight,
                    score: catScore,
                    max: catMax,
                    scoredCount,
                    itemCount,
                    pct
                };
            });

            const weightsValid = Math.abs(totalWeight - 100) < 0.001;
            const complete = weightsValid && coveredWeight >= totalWeight - 0.001 && allWeightedItemsScored;
            const grade = coveredWeight > 0 ? weightedGrade / coveredWeight : null;

            return {
                period,
                periodLabel: period === "General" ? "Unassigned" : period,
                grade,
                complete,
                weightsValid,
                coveredWeight: Number(coveredWeight.toFixed(2)),
                totalWeight: Number(totalWeight.toFixed(2)),
                categories: categoryBreakdowns
            };
        });
    }

    // ----------------------------------------------------------- page logic

    async function loadRecord() {
        const p = getParams();
        state.token = p.token;
        state.studentId = p.studentId;
        state.userId = p.userId;

        const backBtn = $("backToScanBtn");
        if (backBtn && p.token) {
            backBtn.href = `scan.html?t=${encodeURIComponent(p.token)}`;
        }

        if (!p.studentId) {
            $("notfound-title").textContent = "Missing student ID";
            $("notfound-text").textContent = "This record page was opened without a student ID. Ask your teacher to check you in first.";
            setView("notfound");
            return;
        }

        // Prevent a locked student phone from changing ?sid= in the URL to spy on a classmate.
        const lock = readDeviceLock(p.token);
        if (lock && lock.studentId && lock.studentId.toLowerCase() !== p.studentId.toLowerCase()) {
            $("notfound-title").textContent = "Access restricted";
            $("notfound-text").textContent = `This device is checked in as ${lock.name || lock.studentId}. Each phone can only view its own attendance and score record.`;
            setView("notfound");
            return;
        }

        setView("loading");

        try {
            // Confirm the session exists and resolve teacher user_id if omitted from URL.
            if (p.token) {
                const info = await rpc("checkin_session_info", { p_token: p.token });
                if (info && info.ok) {
                    state.session = info;
                    if (!state.userId && info.user_id) {
                        state.userId = info.user_id;
                    }
                    const badge = $("record-section-badge");
                    if (badge) badge.textContent = info.section || "Class";
                } else {
                    console.warn("Session lookup failed:", info && info.error);
                }
            }

            if (!state.userId) {
                $("notfound-title").textContent = "Record context missing";
                $("notfound-text").textContent = "Please scan your QR code again from your teacher's session so your record can be loaded.";
                setView("notfound");
                return;
            }

            const rpcPayload = {
                p_student_id: state.studentId,
                p_user_id: state.userId
            };
            if (state.token) {
                rpcPayload.p_token = state.token;
                const devId = getDeviceId();
                if (devId) rpcPayload.p_device_id = devId;
            }

            const data = await rpc("get_student_record", rpcPayload);

            if (!data || !data.ok) {
                const errCode = data && data.error;
                if (errCode === "unauthorized_device") {
                    $("notfound-title").textContent = "Access restricted";
                    $("notfound-text").textContent = "This phone is registered to another student for this session. You can only view the record of the student checked in on this device.";
                } else {
                    $("notfound-title").textContent = "Record not found";
                    $("notfound-text").textContent = errCode || "No attendance or scores found for this student.";
                }
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
        $("record-student-id").textContent = `Student ID: ${data.student_id || ""}`;
        if (data.section) {
            const badge = $("record-section-badge");
            if (badge) badge.textContent = data.section;
        }

        // --- Attendance history & overview stats ---
        const attBody = $("record-attendance-body");
        const attEmpty = $("record-attendance-empty");
        const totalDays = $("record-total-days");

        const attendance = Array.isArray(data.attendance) ? data.attendance : [];
        totalDays.textContent = `${attendance.length} day${attendance.length !== 1 ? "s" : ""}`;

        let presentCount = 0;
        let lateCount = 0;
        let absentCount = 0;
        attendance.forEach((row) => {
            const st = String(row.status || "").toLowerCase();
            if (st === "present") presentCount++;
            else if (st === "late") lateCount++;
            else if (st === "absent") absentCount++;
        });
        const attRate = attendance.length > 0
            ? Math.round(((presentCount + lateCount) / attendance.length) * 100)
            : 0;
        if ($("record-stat-present")) $("record-stat-present").textContent = String(presentCount);
        if ($("record-stat-late")) $("record-stat-late").textContent = String(lateCount);
        if ($("record-stat-absent")) $("record-stat-absent").textContent = String(absentCount);
        if ($("record-stat-rate")) $("record-stat-rate").textContent = `${attRate}%`;

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

        // --- Scores & Computed Period Grades ---
        const scoreBody = $("record-scores-body");
        const scoreEmpty = $("record-scores-empty");
        const scoreCount = $("record-score-count");

        const scores = Array.isArray(data.scores) ? data.scores : [];
        scoreCount.textContent = `${scores.length} score${scores.length !== 1 ? "s" : ""}`;

        const summaryCard = $("record-grade-summary-card");
        const summaryBody = $("record-grade-summary-body");
        const periodCountBadge = $("record-period-count");
        const summaries = computePeriodSummaries(scores, data.categories || data.grading_categories);

        if (summaryCard && summaryBody) {
            if (summaries.length === 0) {
                summaryCard.classList.add("hidden");
                summaryBody.innerHTML = "";
            } else {
                summaryCard.classList.remove("hidden");
                if (periodCountBadge) {
                    periodCountBadge.textContent = `${summaries.length} period${summaries.length !== 1 ? "s" : ""}`;
                }
                summaryBody.innerHTML = summaries.map((item) => {
                    const gradeText = item.grade != null ? `${item.grade.toFixed(2)}%` : "—";
                    const statusLabel = item.grade == null
                        ? "No scores"
                        : (!item.weightsValid
                            ? `Check weights · ${item.totalWeight}%`
                            : (item.complete ? "Final Grade" : `Running · ${item.coveredWeight}%`));
                    const statusClass = item.complete ? "pill-present" : "pill-late";
                    return `<div class="record-period-box">
                        <div class="record-period-top">
                            <div>
                                <strong>${escapeHtml(item.periodLabel)}</strong>
                                <span class="pill ${statusClass}">${escapeHtml(statusLabel)}</span>
                            </div>
                            <span class="record-period-grade">${escapeHtml(gradeText)}</span>
                        </div>
                        <div class="record-category-list">
                            ${item.categories.map((cat) => {
                                const catPct = cat.pct != null ? `${cat.pct.toFixed(1)}%` : "—";
                                return `<div class="record-category-row">
                                    <span>${escapeHtml(cat.name)} <small class="muted">(${escapeHtml(String(cat.weight))}%)</small></span>
                                    <span class="font-mono">${escapeHtml(String(cat.score))}/${escapeHtml(String(cat.max))} · <strong>${escapeHtml(catPct)}</strong></span>
                                </div>`;
                            }).join("")}
                        </div>
                    </div>`;
                }).join("");
            }
        }

        if (scores.length === 0) {
            scoreBody.innerHTML = "";
            scoreEmpty.classList.remove("hidden");
        } else {
            scoreEmpty.classList.add("hidden");
            scoreBody.innerHTML = scores.map((row) => {
                const pct = row.pct != null ? `${row.pct}%` : "—";
                const multiInCategory = scores.filter((s) =>
                    (row.category_id && s.category_id === row.category_id
                        || (!row.category_id && (s.category_name || "General") === (row.category_name || "General")))
                    && (s.grading_period || s.subject || "General") === (row.grading_period || row.subject || "General")
                ).length > 1;
                const itemLabel = String(row.item_label || "").trim();
                const showItem = itemLabel && (itemLabel !== "#1" || multiInCategory);
                const itemSuffix = showItem ? ` · ${escapeHtml(itemLabel)}` : "";
                return `
                    <tr>
                        <td>${escapeHtml(formatDate(row.date))}</td>
                        <td>${escapeHtml(row.grading_period || row.subject || "General")}</td>
                        <td>${escapeHtml(row.category_name || "General")}${itemSuffix}${row.category_weight != null ? ` (${escapeHtml(String(row.category_weight))}%)` : ""}</td>
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
