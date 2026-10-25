// Scholog — student attendance + score record page & standalone QR record scanner.
//
// Two ways to use this page (no teacher login required):
//   1) Reached from scan.html after a check-in:
//        student-record.html?t=<session_token>&student_id=<student_id>&user_id=<teacher_user_id>
//   2) Opened directly by a student even when no QR session link was sent:
//        student-record.html
//      The student scans their printed Student QR card (SCHOLOG:<id>), uploads a
//      saved QR photo from their phone, or types their Student ID. The SECURITY DEFINER
//      get_student_record() RPC resolves their record, auto-checks them in if their
//      section currently has an open QR session, and returns their attendance,
//      scores, and computed period grades.
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
        student: null,
        lookupTab: "scan",
        scanner: null,
        scanning: false,
        cameraBlocked: false
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
        ["loading", "lookup", "record", "notfound"].forEach((view) => {
            const el = $(`view-${view}`);
            if (el) el.classList.toggle("hidden", view !== name);
        });
        if (name !== "lookup") {
            stopLookupScanner();
        }
        const scanAnotherBtn = $("scanAnotherBtn");
        if (scanAnotherBtn) {
            const lock = readDeviceLock(state.token);
            const canScanAnother = name !== "lookup" && (!state.token || !lock);
            scanAnotherBtn.classList.toggle("hidden", !canScanAnother);
        }
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

    function extractStudentId(raw) {
        let text = String(raw == null ? "" : raw).trim();
        if (!text) return "";

        if (text.charAt(0) === "{") {
            try {
                const obj = JSON.parse(text);
                text = String(obj.student_id || obj.studentId || obj.code || obj.id || "").trim();
            } catch (err) {
                /* keep raw */
            }
        }

        if (/^scholog:/i.test(text)) text = text.slice(8).trim();

        if (/^https?:\/\//i.test(text) || /(?:scan|student-record)\.html/i.test(text)) {
            try {
                const url = new URL(text, window.location.href);
                const fromQuery = url.searchParams.get("student_id") ||
                    url.searchParams.get("sid") ||
                    url.searchParams.get("id") ||
                    url.searchParams.get("student") ||
                    url.searchParams.get("code");
                if (fromQuery) return fromQuery.trim();
                if (url.searchParams.get("t") || /scan\.html$/i.test(url.pathname)) {
                    return "";
                }
            } catch (err) {
                /* fall through */
            }
        }

        return text.replace(/[\r\n\t]+/g, " ").trim().slice(0, 64);
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

    // ---------------------------------------------------- standalone QR scanner

    function cameraSupported() {
        return Boolean(window.Html5Qrcode && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    function setLookupStageLive(live) {
        const stage = $("lookup-scan-stage");
        if (stage) stage.classList.toggle("is-live", live);
        const note = $("lookup-scan-live-note");
        if (note) note.classList.toggle("hidden", !live);
    }

    function setLookupTab(tab) {
        state.lookupTab = tab === "id" ? "id" : "scan";
        const isScan = state.lookupTab === "scan";
        const tabScan = $("lookup-tab-scan");
        const tabId = $("lookup-tab-id");
        const panelScan = $("lookup-panel-scan");
        const panelId = $("lookup-panel-id");

        if (tabScan) {
            tabScan.classList.toggle("active", isScan);
            tabScan.setAttribute("aria-selected", String(isScan));
            tabScan.tabIndex = isScan ? 0 : -1;
        }
        if (tabId) {
            tabId.classList.toggle("active", !isScan);
            tabId.setAttribute("aria-selected", String(!isScan));
            tabId.tabIndex = !isScan ? 0 : -1;
        }
        if (panelScan) panelScan.classList.toggle("hidden", !isScan);
        if (panelId) panelId.classList.toggle("hidden", isScan);

        if (isScan) {
            if (!state.scanning && !state.cameraBlocked && cameraSupported()) {
                startLookupScanner();
            }
        } else {
            stopLookupScanner();
            const input = $("lookup-id-input");
            if (input) input.focus();
        }
    }

    async function startLookupScanner() {
        const hintEl = $("lookup-camera-hint");
        const containerId = "lookup-qr-reader";

        if (!cameraSupported()) {
            state.cameraBlocked = true;
            if (hintEl) {
                hintEl.textContent = "Camera scanning isn't available in this browser. Upload a QR photo or tap “Type ID”.";
            }
            return;
        }
        if (state.scanning && state.scanner) return;

        const container = $(containerId);
        if (!container) return;
        container.classList.remove("hidden");

        const scanner = new window.Html5Qrcode(containerId, { verbose: false });
        state.scanner = scanner;
        state.scanning = true;

        try {
            await scanner.start(
                { facingMode: "environment" },
                { fps: 10, qrbox: { width: 230, height: 230 }, aspectRatio: 1.0 },
                (decoded) => {
                    stopLookupScanner().finally(() => {
                        lookupStudentByCode(decoded);
                    });
                },
                () => { /* frame miss */ }
            );
            state.cameraBlocked = false;
            $("lookupStartScanBtn")?.classList.add("hidden");
            $("lookupStopScanBtn")?.classList.remove("hidden");
            if (hintEl) hintEl.textContent = "Camera on — hold your Student QR code steady inside the frame.";
            setLookupStageLive(true);
        } catch (err) {
            if (state.scanner === scanner) {
                state.scanner = null;
                state.scanning = false;
            }
            state.cameraBlocked = true;
            if (hintEl) {
                hintEl.textContent = "Could not start the camera. You can upload a QR photo or tap “Type ID”.";
            }
            try { scanner.clear(); } catch (e) { /* ignore */ }
            container.classList.add("hidden");
            $("lookupStartScanBtn")?.classList.remove("hidden");
            $("lookupStopScanBtn")?.classList.add("hidden");
            setLookupStageLive(false);
        }
    }

    async function stopLookupScanner() {
        const containerId = "lookup-qr-reader";
        const scanner = state.scanner;
        state.scanner = null;
        state.scanning = false;
        if (scanner) {
            try { await scanner.stop(); } catch (err) { /* ignore */ }
            try { scanner.clear(); } catch (err) { /* ignore */ }
        }
        const container = $(containerId);
        if (container) {
            container.classList.add("hidden");
            container.innerHTML = "";
        }
        $("lookupStartScanBtn")?.classList.remove("hidden");
        $("lookupStopScanBtn")?.classList.add("hidden");
        setLookupStageLive(false);
    }

    async function handleQrFileUpload(event) {
        const file = event.target && event.target.files && event.target.files[0];
        if (!file) return;
        await stopLookupScanner();

        if (!window.Html5Qrcode) {
            showToast("QR scanner library unavailable. Please type your Student ID.", "error");
            setLookupTab("id");
            return;
        }

        const hintEl = $("lookup-camera-hint");
        if (hintEl) hintEl.textContent = "Reading QR code from image…";

        try {
            const fileScanner = new window.Html5Qrcode("lookup-qr-file-scratch", { verbose: false });
            const decoded = await fileScanner.scanFile(file, false);
            try { fileScanner.clear(); } catch (e) { /* ignore */ }
            event.target.value = "";
            await lookupStudentByCode(decoded);
        } catch (err) {
            event.target.value = "";
            if (hintEl) {
                hintEl.textContent = "Could not find a valid Student QR in that image. Try another photo or tap “Type ID”.";
            }
            showToast("No QR code detected in that image", "error");
        }
    }

    function openLookupView() {
        setView("lookup");
        setLookupTab(cameraSupported() ? "scan" : "id");
    }

    async function lookupStudentByCode(rawInput) {
        const code = extractStudentId(rawInput);
        if (!code) {
            showToast("Please scan your Student QR card or enter a valid Student ID.", "error");
            return;
        }
        state.studentId = code;
        try {
            const url = new URL(window.location.href);
            url.searchParams.set("student_id", code);
            window.history.replaceState({}, "", url.href);
        } catch (err) { /* ignore */ }
        await fetchAndRenderStudentRecord();
    }

    // ---------------------------------------------------- grade computation

    function computePeriodSummaries(scores, categories) {
        if (!Array.isArray(scores) || scores.length === 0) return [];

        const cleanCategories = Array.isArray(categories) ? categories : [];
        const periods = [...new Set(scores.map((s) => s.grading_period || s.subject || "General"))];

        return periods.map((period) => {
            const periodScores = scores.filter((s) => (s.grading_period || s.subject || "General") === period);

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
        state.studentId = extractStudentId(p.studentId);
        state.userId = p.userId;

        const backBtn = $("backToScanBtn");
        if (backBtn && p.token) {
            backBtn.href = `scan.html?t=${encodeURIComponent(p.token)}`;
        }

        // If no student ID was provided in the URL, open the built-in QR Scanner / ID Lookup
        // so students can scan their QR card or enter their ID even without a teacher QR link.
        if (!state.studentId) {
            openLookupView();
            return;
        }

        await fetchAndRenderStudentRecord();
    }

    async function fetchAndRenderStudentRecord() {
        // Prevent a locked student phone from changing ?sid= in the URL to spy on a classmate.
        const lock = readDeviceLock(state.token);
        if (lock && lock.studentId && lock.studentId.toLowerCase() !== state.studentId.toLowerCase()) {
            $("notfound-title").textContent = "Access restricted";
            $("notfound-text").textContent = `This device is checked in as ${lock.name || lock.studentId}. Each phone can only view its own attendance and score record.`;
            setView("notfound");
            return;
        }

        setView("loading");

        try {
            // Confirm the session exists and resolve teacher user_id if a token is in the URL.
            if (state.token) {
                const info = await rpc("checkin_session_info", { p_token: state.token });
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

            const rpcPayload = {
                p_student_id: state.studentId,
                p_user_id: state.userId || null
            };
            const devId = getDeviceId();
            if (devId) rpcPayload.p_device_id = devId;
            if (state.token) {
                rpcPayload.p_token = state.token;
            }

            const data = await rpc("get_student_record", rpcPayload);

            if (!data || !data.ok) {
                const errCode = data && data.error;
                if (errCode === "unauthorized_device") {
                    $("notfound-title").textContent = "Access restricted";
                    $("notfound-text").textContent = "This phone is registered to another student for this session. You can only view the record of the student checked in on this device.";
                } else if (errCode === "student_not_found") {
                    $("notfound-title").textContent = "Student ID not found";
                    $("notfound-text").textContent = `We couldn't find "${state.studentId}" on your teacher's class list. Check your QR card or Student ID and try again.`;
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

        const studentObj = data.student && typeof data.student === "object" ? data.student : {};
        const resolvedName = data.student_name || studentObj.name || "Student";
        const resolvedId = data.student_id || studentObj.student_id || state.studentId || "";
        const resolvedSection = data.section || studentObj.section || (state.session && state.session.section) || "";

        $("record-student-name").textContent = resolvedName;
        $("record-student-id").textContent = `Student ID: ${resolvedId}`;
        if (resolvedSection) {
            const badge = $("record-section-badge");
            if (badge) badge.textContent = resolvedSection;
        }

        const checkinBanner = $("record-checkin-banner");
        if (checkinBanner) {
            if (data.checked_in_now) {
                const st = data.checkin_status || "Present";
                checkinBanner.classList.remove("hidden");
                checkinBanner.classList.toggle("timer-late", st === "Late");
                checkinBanner.classList.toggle("timer-ontime", st !== "Late");
                checkinBanner.textContent = `Attendance marked ${st} for ${formatDate(data.checkin_date)}`;
            } else {
                checkinBanner.classList.add("hidden");
                checkinBanner.textContent = "";
            }
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
                const rawPct = row.pct != null
                    ? Number(row.pct)
                    : (Number(row.max_score) > 0 ? Math.round((Number(row.score) / Number(row.max_score)) * 1000) / 10 : null);
                const pct = Number.isFinite(rawPct) ? `${rawPct}%` : "—";
                const multiInCategory = scores.filter((s) =>
                    (row.category_id && s.category_id === row.category_id
                        || (!row.category_id && (s.category_name || "General") === (row.category_name || "General")))
                    && (s.grading_period || s.subject || "General") === (row.grading_period || row.subject || "General")
                ).length > 1;
                const itemLabel = String(row.item_label || "").trim();
                const showItem = itemLabel && (itemLabel !== "#1" || multiInCategory);
                const itemSuffix = showItem ? ` · ${escapeHtml(itemLabel)}` : "";
                const rawPeriod = row.grading_period || row.subject || "General";
                const periodDisplay = rawPeriod === "General" ? "Unassigned" : rawPeriod;
                return `
                    <tr>
                        <td>${escapeHtml(formatDate(row.date))}</td>
                        <td>${escapeHtml(periodDisplay)}</td>
                        <td>${escapeHtml(row.category_name || "General")}${itemSuffix}${row.category_weight != null ? ` (${escapeHtml(String(row.category_weight))}%)` : ""}</td>
                        <td class="text-right font-mono">${escapeHtml(String(row.score))} / ${escapeHtml(String(row.max_score))}</td>
                        <td class="text-center"><span class="badge badge-score">${escapeHtml(pct)}</span></td>
                    </tr>
                `;
            }).join("");
        }

        setView("record");
        showToast(data.checked_in_now ? `Checked in (${data.checkin_status || "Present"}) & record loaded` : "Record loaded", "success");
    }

    // ------------------------------------------------------------------ wiring

    function wireLookupEvents() {
        $("lookup-tab-scan")?.addEventListener("click", () => setLookupTab("scan"));
        $("lookup-tab-id")?.addEventListener("click", () => setLookupTab("id"));
        $("lookupUseIdBtn")?.addEventListener("click", () => setLookupTab("id"));
        $("lookupUseScanBtn")?.addEventListener("click", () => setLookupTab("scan"));
        $("lookupStartScanBtn")?.addEventListener("click", () => startLookupScanner());
        $("lookupStopScanBtn")?.addEventListener("click", () => stopLookupScanner());
        $("lookupQrFileBtn")?.addEventListener("click", () => $("lookup-qr-file")?.click());
        $("lookup-qr-file")?.addEventListener("change", handleQrFileUpload);
        $("lookup-id-form")?.addEventListener("submit", (event) => {
            event.preventDefault();
            lookupStudentByCode($("lookup-id-input")?.value || "");
        });
        $("scanAnotherBtn")?.addEventListener("click", () => openLookupView());
        $("notfound-scan-btn")?.addEventListener("click", () => openLookupView());
    }

    document.addEventListener("DOMContentLoaded", () => {
        wireLookupEvents();
        loadRecord();
    });

})();
