// Scholog — standalone QR / Student-ID check-in page.
//
// Two modes:
//   * Student mode  — scan.html?t=<session token>  (no login required; opened on
//     the student's own phone or any other device)
//   * Host mode     — scan.html (teacher signed in): creates a check-in session,
//     shows the QR/link to share and follows the live roster.
//
// Attendance is written through the public checkin_mark() / checkin_session_info()
// Postgres functions, which validate the session and the Student ID against the
// teacher's class list. The anon role has no direct table access.
(function () {
    "use strict";

    const SUPABASE_URL = "https://jwjivkdgzxuaecplkkad.supabase.co";
    const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3aml2a2Rnenh1YWVjcGxra2FkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2NTU0NzcsImV4cCI6MjEwODIzMTQ3N30.VTFzl7FlP0apBo5ngnclq3eA9aDE-o3I560-XHSiDKg";
    const HOST_STORAGE_KEY = "scholog_checkin_host";
    const RPC_TIMEOUT_MS = 12000;
    const DEVICE_KEY = "scholog_device_id";
    const LOCK_KEY = "scholog_checkin_lock";
    const SOUND_KEY = "scholog_projector_sound";
    const RECENT_LIMIT = 5;
    const FEED_LIMIT = 8;

    const $ = (id) => document.getElementById(id);

    let sb = null;
    try {
        sb = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
    } catch (err) {
        console.error("Supabase init failed:", err);
    }

    let initialSoundEnabled = true;
    try {
        initialSoundEnabled = localStorage.getItem(SOUND_KEY) !== "off";
    } catch (err) {
        initialSoundEnabled = true;
    }

    const state = {
        mode: "loading",
        token: "",
        session: null,
        currentUser: null,
        hostSession: null,
        rosterTimer: null,
        infoTimer: null,
        resumeTimer: null,
        countdownTimer: null,
        livePopTimer: null,
        submitting: false,
        lastCode: "",
        lastCodeAt: 0,
        scanner: null,
        scanning: false,
        studentTab: "scan",
        autoScanAttempted: false,
        cameraBlocked: false,
        deviceLocked: false,
        soundEnabled: initialSoundEnabled,
        audioCtx: null,
        rosterSeededForToken: "",
        knownCheckins: new Map(),
        liveFeed: [],
        recent: []
    };

    // ---------------------------------------------------------------- helpers

    function todayStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    function isValidDateStr(s) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return false;
        const d = new Date(`${s}T00:00:00Z`);
        return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
    }

    function isUuid(value) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
    }

    function formatDate(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return value || "—";
        const d = new Date(`${value}T00:00:00`);
        const today = todayStr();
        if (value === today) return `Today · ${d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`;
        return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    }

    function escapeHtml(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function escapeAttr(value) { return escapeHtml(value); }

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
        ["loading", "student", "host", "problem", "noclass"].forEach((view) => {
            const el = $(`view-${view}`);
            if (el) el.classList.toggle("hidden", view !== name);
        });
        state.mode = name;
    }

    // No QR session for this date => there is no class to check in for. The
    // teacher can still record attendance by hand in the dashboard.
    function showNoClass(detail) {
        cancelResume();
        stopScanner();
        if (state.infoTimer) clearInterval(state.infoTimer);
        state.infoTimer = null;
        state.session = null;
        const text = $("noclass-text");
        if (text) {
            text.textContent = detail || "Your teacher has not opened a QR check-in session for this date, so there is no class to check in for.";
        }
        $("dashboardLink").classList.add("hidden");
        $("signOutBtn").classList.add("hidden");
        setView("noclass");
    }

    function showProblem(title, text, options = {}) {
        $("problem-title").textContent = title;
        $("problem-text").textContent = text;
        const signIn = $("problem-signin");
        if (signIn) signIn.classList.toggle("hidden", options.signIn === false);
        setView("problem");
        stopScanner();
        clearTimers();
    }

    function clearTimers() {
        if (state.rosterTimer) clearInterval(state.rosterTimer);
        if (state.infoTimer) clearInterval(state.infoTimer);
        if (state.resumeTimer) clearTimeout(state.resumeTimer);
        if (state.countdownTimer) clearInterval(state.countdownTimer);
        if (state.livePopTimer) clearTimeout(state.livePopTimer);
        state.rosterTimer = null;
        state.infoTimer = null;
        state.resumeTimer = null;
        state.countdownTimer = null;
        state.livePopTimer = null;
    }

    function formatCountdown(ms) {
        const totalSec = Math.max(0, Math.ceil(ms / 1000));
        const hrs = Math.floor(totalSec / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);
        const secs = totalSec % 60;
        if (hrs > 0) {
            return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
        }
        return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }

    function playCheckinChime(status = "Present") {
        if (!state.soundEnabled) return false;
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return false;
            if (!state.audioCtx) state.audioCtx = new AudioCtx();
            const ctx = state.audioCtx;
            if (ctx.state === "suspended" && typeof ctx.resume === "function") {
                ctx.resume().catch(() => {});
            }
            const now = ctx.currentTime || 0;
            const freqs = status === "Late" ? [659.25, 523.25] : [523.25, 783.99];
            freqs.forEach((freq, idx) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = "sine";
                osc.frequency.setValueAtTime(freq, now + idx * 0.11);
                gain.gain.setValueAtTime(0.14, now + idx * 0.11);
                gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.11 + 0.24);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(now + idx * 0.11);
                osc.stop(now + idx * 0.11 + 0.25);
            });
            return true;
        } catch (err) {
            return false;
        }
    }

    function syncSoundButtons() {
        const label = state.soundEnabled ? "Sound: On" : "Sound: Muted";
        ["host-sound-btn", "presentation-sound-btn"].forEach((id) => {
            const btn = $(id);
            if (!btn) return;
            btn.textContent = label;
            btn.setAttribute("aria-pressed", String(state.soundEnabled));
            btn.classList.toggle("sound-muted", !state.soundEnabled);
        });
    }

    function toggleProjectorSound() {
        state.soundEnabled = !state.soundEnabled;
        try {
            localStorage.setItem(SOUND_KEY, state.soundEnabled ? "on" : "off");
        } catch (err) { /* ignore */ }
        syncSoundButtons();
        if (state.soundEnabled) {
            playCheckinChime("Present");
            showToast("Check-in sound enabled");
        } else {
            showToast("Check-in sound muted");
        }
    }

    function startCountdownLoop() {
        if (state.countdownTimer) clearInterval(state.countdownTimer);
        updateSmartTimers();
        state.countdownTimer = setInterval(updateSmartTimers, 1000);
    }

    function updateSmartTimers() {
        const now = Date.now();

        // Student mode banner
        if (state.mode === "student" && state.session) {
            const banner = $("student-late-banner");
            const submit = $("submitIdBtn");
            const closed = Boolean(state.session.closed);
            const expired = Boolean(state.session.expired) || (state.session.expires_at && new Date(state.session.expires_at).getTime() < now);
            const open = !closed && !expired;
            const lateAt = state.session.late_after_at ? new Date(state.session.late_after_at).getTime() : null;

            if (banner) {
                if (!open || (!lateAt && !state.session.late_mode)) {
                    banner.classList.add("hidden");
                } else {
                    banner.classList.remove("hidden");
                    const isLateNow = Boolean(state.session.late_mode) || (lateAt !== null && lateAt <= now);
                    banner.classList.toggle("timer-late", isLateNow);
                    banner.classList.toggle("timer-ontime", !isLateNow);
                    if (isLateNow) {
                        banner.textContent = "Late check-in window — checking in now marks you Late";
                        if (submit && !state.submitting) submit.textContent = "Mark me Late";
                    } else {
                        banner.textContent = `On-time check-in window · ${formatCountdown(lateAt - now)} left before Late`;
                        if (submit && !state.submitting) submit.textContent = "Mark me Present";
                    }
                }
            }
        }

        // Host & Projector mode timers
        if (state.mode === "host" && state.hostSession) {
            const session = state.hostSession;
            const expMs = session.expires_at ? new Date(session.expires_at).getTime() - now : 0;
            const closed = Boolean(session.closed);
            const expired = expMs <= 0;
            const lateAt = session.late_after_at ? new Date(session.late_after_at).getTime() : null;

            const expText = closed
                ? "Session closed"
                : (expired ? "Session expired" : `Closes in ${formatCountdown(expMs)}`);
            if ($("host-expiry-pill")) $("host-expiry-pill").textContent = expText;
            if ($("presentation-expiry-pill")) $("presentation-expiry-pill").textContent = expText;

            let pillText = "Present Mode · No Late Cutoff";
            let pillClass = "smart-timer-pill timer-pill-ontime";
            let toggleLabel = "Mark Late Now";

            if (closed || expired) {
                pillText = closed ? "Session Closed" : "Session Expired";
                pillClass = "smart-timer-pill timer-pill-muted";
            } else if (lateAt !== null) {
                if (lateAt > now) {
                    pillText = `On-Time Window · ${formatCountdown(lateAt - now)} left`;
                    pillClass = "smart-timer-pill timer-pill-ontime";
                    toggleLabel = "Mark Late Now";
                } else {
                    pillText = "Late Mode Active · New scans marked Late";
                    pillClass = "smart-timer-pill timer-pill-late";
                    toggleLabel = "Reopen On-Time (+5m)";
                }
            }

            ["host-timer-pill", "presentation-timer-pill"].forEach((id) => {
                const el = $(id);
                if (!el) return;
                el.textContent = pillText;
                el.className = pillClass;
            });

            ["host-late-toggle-btn", "presentation-late-toggle-btn"].forEach((id) => {
                const btn = $(id);
                if (!btn) return;
                btn.textContent = toggleLabel;
                btn.disabled = closed || expired;
            });

            const extendBtn = $("host-extend-late-btn");
            if (extendBtn) extendBtn.disabled = closed || expired;
        }
    }

    function getTokenFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const direct = params.get("t") || params.get("token") || params.get("session");
        if (direct) return direct.trim();
        const hash = window.location.hash.replace(/^#/, "");
        if (hash) {
            const hashParams = new URLSearchParams(hash);
            const fromHash = hashParams.get("t") || hashParams.get("token");
            if (fromHash) return fromHash.trim();
        }
        return "";
    }

    function buildCheckinUrl(token) {
        const url = new URL("scan.html", window.location.href);
        url.search = "";
        url.hash = "";
        url.searchParams.set("t", token);
        return url.href;
    }

    function buildStudentRecordUrl(studentId, userId) {
        if (!studentId) return "";
        const url = new URL("student-record.html", window.location.href);
        url.search = "";
        url.hash = "";
        if (state.token) url.searchParams.set("t", state.token);
        url.searchParams.set("student_id", studentId);
        if (userId) url.searchParams.set("user_id", userId);
        return url.href;
    }

    // Normalise whatever a QR code contains into a plain Student ID.
    function extractStudentId(raw) {
        let text = String(raw == null ? "" : raw).trim();
        if (!text) return "";

        if (text.charAt(0) === "{") {
            try {
                const obj = JSON.parse(text);
                text = String(obj.student_id || obj.studentId || obj.code || obj.id || "").trim();
            } catch (err) {
                /* not JSON, keep the raw text */
            }
        }

        if (/^scholog:/i.test(text)) text = text.slice(8).trim();

        if (/^https?:\/\//i.test(text) || /scan\.html/i.test(text)) {
            try {
                const url = new URL(text, window.location.href);
                const fromQuery = url.searchParams.get("id") ||
                    url.searchParams.get("student_id") ||
                    url.searchParams.get("student") ||
                    url.searchParams.get("code");
                if (fromQuery) return fromQuery.trim();
                if (url.searchParams.get("t") || /scan\.html$/i.test(url.pathname)) {
                    // This is the class check-in QR itself, not a student ID card.
                    return "";
                }
            } catch (err) {
                /* fall through */
            }
        }

        return text.replace(/\s+/g, " ").slice(0, 64);
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
                const message = (data && (data.message || data.error_description || data.hint)) || `HTTP ${res.status}`;
                throw new Error(message);
            }
            return data;
        } finally {
            clearTimeout(timer);
        }
    }

    function friendlyError(code, sectionName) {
        const where = sectionName ? `“${sectionName}”` : "this class";
        switch (code) {
            case "invalid_session":
                return "This check-in link is no longer valid. Ask your teacher for today's QR code or link.";
            case "session_closed":
                return "Check-in has been closed by the teacher.";
            case "session_expired":
                return "This check-in link has expired. Ask your teacher to start a new one.";
            case "not_in_class":
                return `That Student ID is not on the class list for ${where}. Double-check the ID and try again.`;
            case "missing_id":
                return "Please type your Student ID first.";
            case "device_already_used":
                return "This phone already checked in another student. Each phone can only check in one student — ask your teacher for help.";
            case "invalid_device":
                return "This phone could not be verified. Reload the page and try again, or ask your teacher.";
            default:
                return "Something went wrong while saving your attendance. Please try again.";
        }
    }

    // ----------------------------------------------------------- student mode

    // Two clear tabs (Scan / Type ID) instead of two stacked forms, so students
    // always know where they are and what to do next.
    function setStudentTab(tab, options = {}) {
        const target = tab === "id" ? "id" : "scan";
        state.studentTab = target;

        const scanTab = $("tab-scan");
        const idTab = $("tab-id");
        const scanPanel = $("panel-scan");
        const idPanel = $("panel-id");

        if (!scanTab || !idTab) return;

        const scanActive = target === "scan";
        scanTab.classList.toggle("active", scanActive);
        idTab.classList.toggle("active", !scanActive);
        scanTab.setAttribute("aria-selected", String(scanActive));
        idTab.setAttribute("aria-selected", String(!scanActive));
        scanTab.tabIndex = scanActive ? 0 : -1;
        idTab.tabIndex = scanActive ? -1 : 0;

        if (scanPanel) scanPanel.classList.toggle("hidden", !scanActive);
        if (idPanel) idPanel.classList.toggle("hidden", scanActive);

        if (state.deviceLocked) {
            const lock = readDeviceLock(state.token);
            if (lock) renderDeviceLock(lock);
            return;
        }

        hideResult();

        if (scanActive) {
            if (state.session && !state.session.closed && !state.session.expired) {
                if (!options.noCamera) startScanner();
            }
        } else {
            stopScanner();
            const input = $("student-id-input");
            if (input && !input.disabled) {
                setTimeout(() => input.focus(), 30);
            }
        }
    }

    // Keep the tabs usable with arrow keys (standard tablist behaviour).
    function handleTabKeys(event) {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const next = state.studentTab === "scan" ? "id" : "scan";
        setStudentTab(next);
        $(next === "scan" ? "tab-scan" : "tab-id").focus();
    }

    async function startStudentMode(rawToken) {
        if (!isUuid(rawToken)) {
            showProblem(
                "Invalid check-in link",
                "This QR code or link doesn't match a Scholog check-in session. Ask your teacher for today's code.",
                { signIn: false }
            );
            return;
        }

        state.token = rawToken;
        state.mode = "student";
        setView("student");
        $("dashboardLink").classList.add("hidden");
        $("signOutBtn").classList.add("hidden");

        setStudentTab("scan", { noCamera: true });
        await refreshStudentSession(true);

        // No session = no class: the "walang pasok" screen is final.
        if (!state.session) return;

        // This phone already checked someone in for this session? Show that.
        const lock = readDeviceLock(state.token);
        if (lock && lock.studentId) {
            renderDeviceLock(lock);
        } else {
            maybeAutoStartCamera();
        }

        state.infoTimer = setInterval(() => {
            if (document.visibilityState === "visible") refreshStudentSession(false);
        }, 20000);
    }

    // Start the camera once, automatically, because most students arrive here to
    // scan. Browsers that block autoplay/permissions keep the big manual button.
    function maybeAutoStartCamera() {
        if (state.autoScanAttempted || state.deviceLocked) return;
        state.autoScanAttempted = true;
        if (!cameraSupported() || !state.session) return;
        if (state.session.closed || state.session.expired) return;
        if (state.studentTab !== "scan") return;
        startScanner({ auto: true });
    }

    async function refreshStudentSession(initial) {
        try {
            const info = await rpc("checkin_session_info", { p_token: state.token });
            if (!info || !info.ok) {
                const error = info && info.error;
                if (error === "invalid_session") {
                    // No session = no class. Nothing to scan, nothing to type.
                    showNoClass();
                    return;
                }
                if (initial) {
                    showProblem(
                        "Check-in unavailable",
                        friendlyError(error),
                        { signIn: false }
                    );
                }
                return;
            }
            state.session = info;
            renderStudentSession(info);
        } catch (err) {
            console.error("Could not load check-in session:", err);
            if (initial) {
                showProblem(
                    "Can't reach Scholog",
                    "Check your internet connection and reload this page, or ask your teacher for help.",
                    { signIn: false }
                );
            }
        }
    }

    function renderStudentSession(info) {
        const closed = Boolean(info.closed);
        const expired = Boolean(info.expired);
        const open = !closed && !expired;

        $("session-section").textContent = info.section || "Class";
        $("session-date").textContent = formatDate(info.date);

        const badge = $("session-state-badge");
        badge.textContent = closed ? "Closed" : (expired ? "Expired" : "Open");
        badge.classList.toggle("badge-closed", !open);

        const total = Number(info.student_count) || 0;
        const checked = Number(info.checked_in) || 0;
        const pct = total > 0 ? Math.round((checked / total) * 100) : 0;
        $("session-progress").style.width = `${pct}%`;
        $("session-progress-bar").setAttribute("aria-valuenow", String(pct));
        $("session-count").textContent = `${checked} / ${total} checked in`;

        const hint = $("session-hint");
        if (closed) hint.textContent = "Check-in has been closed by your teacher.";
        else if (expired) hint.textContent = "This check-in link has expired — ask your teacher for a new one.";
        else hint.textContent = "Scan your QR code or type your Student ID below.";

        const input = $("student-id-input");
        const submit = $("submitIdBtn");
        const startScan = $("startScanBtn");
        const tabScan = $("tab-scan");
        const tabId = $("tab-id");
        if (input) {
            input.disabled = !open;
            submit.disabled = !open;
            if (startScan) startScan.disabled = !open;
            tabScan.disabled = !open;
            tabId.disabled = !open;
            if (!open) stopScanner();
        }

        startCountdownLoop();
    }

    async function submitStudentId(rawCode, options = {}) {
        if (state.submitting) return;
        if (!state.session) {
            showResult("error", "Check-in not ready", "Please wait a moment and try again.");
            return;
        }

        const code = extractStudentId(rawCode);
        if (!code) {
            showResult(
                "error",
                "Use your Student ID",
                "That QR code is the class check-in code, not a student ID. Type your Student ID instead.",
                { retryId: true }
            );
            return;
        }

        if (state.session.closed || state.session.expired) {
            showResult("error", "Check-in closed", friendlyError(state.session.closed ? "session_closed" : "session_expired"));
            return;
        }

        if (state.deviceLocked) {
            showResult("info", "This phone is already checked in",
                "Only one check-in per phone is allowed for this session. Ask your teacher if you need help.",
                { locked: true });
            return;
        }

        const now = Date.now();
        if (code === state.lastCode && now - state.lastCodeAt < 2500) return;
        state.lastCode = code;
        state.lastCodeAt = now;

        state.submitting = true;
        const submitBtn = $("submitIdBtn");
        const originalLabel = submitBtn.textContent;
        submitBtn.textContent = "Checking…";
        submitBtn.disabled = true;

        try {
            const body = { p_token: state.token, p_student_id: code };
            if (state.mode === "student") body.p_device_id = getDeviceId();
            const data = await rpc("checkin_mark", body);
            if (data && data.ok) {
                const name = data.student_name || "Student";
                const markedStatus = data.status === "Late" ? "Late" : "Present";
                const detail = data.already_marked
                    ? `${name} (${data.student_id}) was already on the list — attendance confirmed as ${markedStatus}.`
                    : `${name} (${data.student_id}) is marked ${markedStatus} for ${formatDate(state.session.date)}.`;

                addRecent(data.student_name, data.student_id);

                if (typeof data.checked_in === "number" && typeof data.student_count === "number") {
                    state.session.checked_in = data.checked_in;
                    state.session.student_count = data.student_count;
                    renderStudentSession(state.session);
                }

                // Lock this phone to this student for the rest of the session.
                const userId = state.session && state.session.user_id ? state.session.user_id : "";
                writeDeviceLock({
                    token: state.token,
                    studentId: data.student_id,
                    name: data.student_name || "Student",
                    status: markedStatus,
                    userId,
                    at: Date.now()
                });
                state.deviceLocked = true;

                // Point "View my record" to the student's attendance + score record page.
                const recordUrl = buildStudentRecordUrl(data.student_id, userId);
                const resultTitle = data.already_marked
                    ? "Already checked in"
                    : (markedStatus === "Late"
                        ? `${name.split(" ")[0]}, you're marked Late`
                        : `${name.split(" ")[0]}, you're Present!`);

                showResult(data.already_marked ? "info" : "success",
                    resultTitle,
                    detail,
                    { locked: true, recordUrl });

                $("student-id-input").value = "";
            } else if (data && data.error === "device_already_used") {
                const owner = data.device_student_name ? `${data.device_student_name} (${data.device_student_id})` : "another student";
                state.deviceLocked = true;
                writeDeviceLock({
                    token: state.token,
                    studentId: data.device_student_id || "",
                    name: data.device_student_name || "Student",
                    at: Date.now()
                });
                showResult("error", "One check-in per phone",
                    `This phone already checked in ${owner}. Each phone can only mark one student — ask your teacher if this is a mistake.`,
                    { locked: true });
            } else {
                showResult("error", "Could not mark attendance",
                    friendlyError(data && data.error, state.session.section),
                    { retryId: (data && data.error) === "not_in_class" });
            }
        } catch (err) {
            console.error("Check-in failed:", err);
            showResult(
                "error",
                "Connection problem",
                "We couldn't reach Scholog. Check your internet connection and try again."
            );
        } finally {
            state.submitting = false;
            submitBtn.textContent = originalLabel;
            submitBtn.disabled = Boolean(state.session && (state.session.closed || state.session.expired));
        }
    }

    // With one check-in per phone the camera no longer re-arms automatically;
    // the student sees the confirmation and taps Done.
    function cancelResume() {
        if (state.resumeTimer) clearTimeout(state.resumeTimer);
        state.resumeTimer = null;
        const note = $("result-note");
        if (note) {
            note.classList.add("hidden");
            note.textContent = "";
        }
    }

    // --- one phone, one check-in -------------------------------------------
    // The id only identifies the browser (not the person); the server pairs it
    // with the session token so a phone can mark exactly one student.
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
            // Storage blocked (private mode): fall back to a per-load id.
            state.ephemeralDeviceId = state.ephemeralDeviceId ||
                `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
            return state.ephemeralDeviceId;
        }
    }

    function readDeviceLock(token) {
        try {
            const raw = JSON.parse(localStorage.getItem(LOCK_KEY) || "null");
            if (!raw || !raw.token || raw.token !== token) return null;
            return raw;
        } catch (err) {
            return null;
        }
    }

    function writeDeviceLock(info) {
        try { localStorage.setItem(LOCK_KEY, JSON.stringify(info)); } catch (err) { /* ignore */ }
    }

    function renderDeviceLock(lock) {
        state.deviceLocked = true;
        cancelResume();
        stopScanner();
        addRecent(lock.name, lock.studentId);
        const userId = (lock && lock.userId) || (state.session && state.session.user_id) || "";
        const recordUrl = lock && lock.studentId ? buildStudentRecordUrl(lock.studentId, userId) : "";
        showResult("info", "This phone is already checked in",
            `${lock.name} (${lock.studentId}) was checked in from this phone. Only one check-in per phone is allowed — ask your teacher if you need help.`,
            { locked: true, recordUrl });
    }

    function addRecent(name, studentId) {
        if (!name) return;
        state.recent.unshift({ name, studentId });
        state.recent = state.recent.slice(0, RECENT_LIMIT);
        const box = $("recent");
        const list = $("recent-list");
        if (!box || !list) return;
        box.classList.remove("hidden");
        list.innerHTML = state.recent
            .map((item) => `<li title="${escapeAttr(item.studentId)}">${escapeHtml(item.name)}</li>`)
            .join("");
    }

    function showResult(kind, title, text, options = {}) {
        cancelResume();

        const box = $("result");
        const icon = $("result-icon");
        box.classList.remove("hidden", "result-error", "result-info");
        if (kind === "error") box.classList.add("result-error");
        if (kind === "info") box.classList.add("result-info");

        icon.classList.remove("result-icon-error", "result-icon-info");
        if (kind === "error") icon.classList.add("result-icon-error");
        if (kind === "info") icon.classList.add("result-icon-info");
        icon.textContent = kind === "error" ? "!" : (kind === "info" ? "i" : "✓");

        $("result-title").textContent = title;
        $("result-text").textContent = text;

        // Offer the other input method only when the attempt can still succeed.
        const retryBtn = $("result-retry-id");
        retryBtn.classList.toggle("hidden", !options.retryId);
        retryBtn.textContent = state.studentTab === "id" ? "Try again" : "Type my ID instead";

        // A locked phone has nowhere to go back to: the confirmation is the end.
        const doneBtn = $("result-done");
        if (doneBtn) doneBtn.classList.toggle("hidden", Boolean(options.locked));

        const recordLink = $("result-view-record");
        if (recordLink) {
            const hasRecord = Boolean(options.recordUrl);
            recordLink.classList.toggle("hidden", !hasRecord);
            recordLink.href = hasRecord ? options.recordUrl : "#";
        }

        const note = $("result-note");
        if (note) {
            note.classList.toggle("hidden", !options.locked);
            note.textContent = options.locked
                ? "One check-in per phone. Ask your teacher if you need to fix this."
                : "";
        }

        // Hide the form while the result is showing: one clear message on screen.
        $("panel-scan").classList.add("hidden");
        $("panel-id").classList.add("hidden");
        const segmented = document.querySelector(".segmented");
        if (segmented) segmented.classList.add("hidden");

        stopScanner();
        box.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    function hideResult() {
        cancelResume();
        if (state.deviceLocked) {
            // A used phone stays locked: show the notice again instead of the form.
            const lock = readDeviceLock(state.token);
            renderDeviceLock(lock || { token: state.token, studentId: "", name: "This phone" });
            return;
        }
        const box = $("result");
        if (box) box.classList.add("hidden");
        const segmented = document.querySelector(".segmented");
        if (segmented) segmented.classList.remove("hidden");
        if (state.studentTab === "scan") {
            $("panel-scan").classList.remove("hidden");
            $("panel-id").classList.add("hidden");
        } else {
            $("panel-id").classList.remove("hidden");
            $("panel-scan").classList.add("hidden");
        }
    }

    // --------------------------------------------------------------- scanning

    function cameraSupported() {
        return Boolean(window.Html5Qrcode && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    function setScanStageLive(live) {
        const stage = $("scan-stage");
        if (stage) stage.classList.toggle("is-live", live);
        const note = $("scan-live-note");
        if (note) note.classList.toggle("hidden", !live);
    }

    // QR scanning belongs to students only; the teacher records attendance in
    // the dashboard's Attendance sheet.
    async function startScanner() {
        const hintEl = $("camera-hint");
        const containerId = "qr-reader";

        if (state.deviceLocked) return;

        if (!cameraSupported()) {
            state.cameraBlocked = true;
            if (hintEl) hintEl.textContent = "Camera scanning isn't available in this browser. Tap “Type ID” and enter your Student ID.";
            setStudentTab("id");
            return;
        }
        // A camera that is still warming up has no scanner yet; let the tap
        // restart it instead of swallowing the click.
        if (state.scanning && state.scanner) return;

        const container = $(containerId);
        if (!container) return;
        container.classList.remove("hidden");

        const scanner = new window.Html5Qrcode(containerId, { verbose: false });
        state.scanner = scanner;
        // Mark the scanner busy up front: a QR code can decode before start()
        // resolves, and that check-in stops the camera immediately.
        state.scanning = true;

        try {
            await scanner.start(
                { facingMode: "environment" },
                { fps: 10, qrbox: { width: 230, height: 230 }, aspectRatio: 1.0 },
                (decoded) => handleDecoded(decoded),
                () => { /* per-frame decode misses are normal */ }
            );
            state.cameraBlocked = false;
            $("startScanBtn").classList.add("hidden");
            $("stopScanBtn").classList.remove("hidden");
            if (hintEl) hintEl.textContent = "Camera on — hold your QR code steady inside the frame.";
            setScanStageLive(true);
        } catch (err) {
            console.error("Camera failed to start:", err);
            if (state.scanner === scanner) {
                state.scanner = null;
                state.scanning = false;
            }
            state.cameraBlocked = true;
            const name = err && err.name;
            let message = "Could not start the camera. Type your Student ID instead.";
            if (name === "NotAllowedError") message = "Camera access is blocked. Allow it in your browser settings, or tap “Type ID”.";
            if (name === "NotFoundError") message = "No camera found on this device. Tap “Type ID” to enter your Student ID.";
            if (name === "NotReadableError") message = "The camera is busy in another app. Close it and try again, or tap “Type ID”.";
            if (hintEl) hintEl.textContent = `${message} (Camera unavailable — you can still check in.)`;
            try { scanner.clear(); } catch (e) { /* ignore */ }
            container.classList.add("hidden");
            $("startScanBtn").classList.remove("hidden");
            $("stopScanBtn").classList.add("hidden");
            setScanStageLive(false);
        }
    }

    async function stopScanner() {
        const containerId = "qr-reader";
        const scanner = state.scanner;
        state.scanner = null;
        state.scanning = false;
        if (scanner) {
            try { await scanner.stop(); } catch (err) { /* already stopped */ }
            try { scanner.clear(); } catch (err) { /* ignore */ }
        }
        const container = $(containerId);
        if (container) {
            container.classList.add("hidden");
            container.innerHTML = "";
        }
        const startBtn = $("startScanBtn");
        const stopBtn = $("stopScanBtn");
        if (startBtn) startBtn.classList.remove("hidden");
        if (stopBtn) stopBtn.classList.add("hidden");
        setScanStageLive(false);
    }

    async function handleDecoded(decoded) {
        await stopScanner();
        await submitStudentId(decoded, { cameFromScan: true });
    }

    // -------------------------------------------------------------- host mode

    async function startHostMode() {
        if (!sb) {
            showProblem(
                "Can't reach Scholog",
                "The Supabase library did not load. Check your internet connection and reload the page."
            );
            return;
        }

        let session = null;
        try {
            const result = await sb.auth.getSession();
            session = result && result.data ? result.data.session : null;
        } catch (err) {
            console.error("Session lookup failed:", err);
        }

        if (!session || !session.user) {
            showProblem(
                "Teacher sign-in required",
                "Are you a student? Open the QR code or the link your teacher shared (it looks like scan.html?t=…). Teachers: open this page from your Scholog dashboard after signing in — this page only creates and shares the check-in QR; students do the scanning."
            );
            return;
        }

        state.currentUser = session.user;
        $("signOutBtn").classList.remove("hidden");
        $("dashboardLink").classList.remove("hidden");
        setView("host");
        $("host-date").value = todayStr();

        const label = session.user.user_metadata && session.user.user_metadata.full_name
            ? session.user.user_metadata.full_name
            : (session.user.email || "Teacher").split("@")[0];
        $("host-user").textContent = label;

        if (navigator.share) $("share-link-btn").classList.remove("hidden");

        await loadSections();
        applyUrlPrefill();

        const saved = readSavedHostSession();
        if (saved && isUuid(saved)) {
            const resumed = await resumeHostSession(saved);
            if (resumed) return;
        }
    }

    // The dashboard passes the section/date the teacher was already looking at.
    function applyUrlPrefill() {
        const params = new URLSearchParams(window.location.search);
        const section = params.get("section");
        const date = params.get("date");

        if (section) {
            const select = $("host-section");
            const match = [...select.options].find((opt) => opt.value === section);
            if (match) select.value = section;
        }
        if (date && isValidDateStr(date)) {
            $("host-date").value = date;
        }
    }

    async function loadSections() {
        const select = $("host-section");
        select.innerHTML = `<option value="">Loading…</option>`;
        try {
            const { data, error } = await sb.from("sections").select("name").order("name", { ascending: true });
            if (error) throw error;
            const names = (data || []).map((row) => row.name);
            if (names.length === 0) {
                select.innerHTML = `<option value="">No sections yet</option>`;
                $("host-form-hint").textContent = "Add a section and students in the Class List first.";
                $("start-session-btn").disabled = true;
                return;
            }
            select.innerHTML = names.map((name) => `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`).join("");
            $("start-session-btn").disabled = false;
            $("host-form-hint").textContent = "";
        } catch (err) {
            console.error("Could not load sections:", err);
            select.innerHTML = `<option value="">Could not load sections</option>`;
            $("host-form-hint").textContent = "Check your connection and reload this page.";
            $("start-session-btn").disabled = true;
        }
    }

    async function createSession(event) {
        event.preventDefault();
        if (!state.currentUser) return;

        const section = $("host-section").value;
        const date = $("host-date").value;
        const minutes = Number($("host-duration").value) || 60;
        const lateMinutesRaw = $("host-late-after") ? Number($("host-late-after").value) : 0;
        const lateMinutes = Number.isFinite(lateMinutesRaw) && lateMinutesRaw > 0 ? lateMinutesRaw : 0;

        if (!section) {
            $("host-form-hint").textContent = "Choose a section first.";
            return;
        }
        if (!isValidDateStr(date)) {
            $("host-form-hint").textContent = "Choose a valid date.";
            return;
        }

        const btn = $("start-session-btn");
        btn.disabled = true;
        btn.textContent = "Creating…";

        try {
            const nowMs = Date.now();
            const expiresAt = new Date(nowMs + minutes * 60 * 1000).toISOString();
            const lateAfterAt = lateMinutes > 0
                ? new Date(nowMs + Math.min(lateMinutes, minutes) * 60 * 1000).toISOString()
                : null;
            const insertPayload = {
                user_id: state.currentUser.id,
                section,
                attendance_date: date,
                expires_at: expiresAt,
                late_after_at: lateAfterAt,
                closed: false
            };

            let { data, error } = await sb
                .from("checkin_sessions")
                .insert(insertPayload)
                .select("token, section, attendance_date, expires_at, late_after_at, closed")
                .single();
            if (error && /late_after_at/i.test(String(error.message || ""))) {
                delete insertPayload.late_after_at;
                ({ data, error } = await sb
                    .from("checkin_sessions")
                    .insert(insertPayload)
                    .select("token, section, attendance_date, expires_at, closed")
                    .single());
            }
            if (error) throw error;

            if (data && data.late_after_at === undefined) {
                data.late_after_at = lateAfterAt;
            }
            state.hostSession = data;
            state.rosterSeededForToken = "";
            state.knownCheckins.clear();
            state.liveFeed = [];
            saveHostSession(data.token, data.late_after_at);
            $("host-form-hint").textContent = "";
            await renderHostSession();
            showToast("Check-in ready — share the QR or link");
        } catch (err) {
            console.error("Could not create check-in session:", err);
            $("host-form-hint").textContent = `Could not create the session: ${err.message || err}.`;
            showToast("Could not create session", "error");
        } finally {
            btn.disabled = false;
            btn.textContent = "Create check-in QR";
        }
    }

    async function resumeHostSession(token) {
        try {
            let { data, error } = await sb
                .from("checkin_sessions")
                .select("token, section, attendance_date, expires_at, late_after_at, closed")
                .eq("token", token)
                .maybeSingle();
            if (error && /late_after_at/i.test(String(error.message || ""))) {
                ({ data, error } = await sb
                    .from("checkin_sessions")
                    .select("token, section, attendance_date, expires_at, closed")
                    .eq("token", token)
                    .maybeSingle());
            }
            if (error) throw error;
            if (!data) {
                clearSavedHostSession();
                return false;
            }
            if (data.late_after_at === undefined) {
                data.late_after_at = readSavedHostLateAfter() || null;
            }
            state.hostSession = data;
            await renderHostSession();
            return true;
        } catch (err) {
            console.error("Could not resume session:", err);
            return false;
        }
    }

    async function renderHostSession() {
        const session = state.hostSession;
        if (!session) return;

        $("host-start-panel").classList.add("hidden");
        $("host-session").classList.remove("hidden");

        const url = buildCheckinUrl(session.token);
        renderQr($("session-qr"), url);
        renderQr($("presentation-qr"), url);
        $("session-link").value = url;
        $("open-link-btn").href = url;

        $("host-session-title").textContent = session.section;
        $("host-session-sub").textContent = formatDate(session.attendance_date);
        $("presentation-title").textContent = session.section;
        $("presentation-sub").textContent = formatDate(session.attendance_date);

        const closed = Boolean(session.closed);
        const expired = new Date(session.expires_at).getTime() < Date.now();
        const badge = $("host-session-badge");
        badge.textContent = closed ? "Closed" : (expired ? "Expired" : "Open");
        badge.classList.toggle("badge-closed", closed || expired);

        $("close-session-btn").disabled = closed;
        $("present-btn").disabled = closed || expired;

        syncSoundButtons();
        startCountdownLoop();
        await loadRoster();

        if (state.rosterTimer) clearInterval(state.rosterTimer);
        state.rosterTimer = setInterval(() => {
            if (document.visibilityState === "visible") loadRoster(true);
        }, 4000);
    }

    function renderQr(container, url) {
        if (!container) return;
        container.innerHTML = "";
        if (typeof window.qrcode !== "function") {
            container.textContent = "QR generator unavailable — copy the link instead.";
            return;
        }
        try {
            const qr = window.qrcode(0, "M");
            qr.addData(url);
            qr.make();
            container.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
        } catch (err) {
            console.error("QR generation failed:", err);
            container.textContent = "Could not draw the QR code — copy the link instead.";
        }
    }

    function renderProjectorFeed() {
        const feedList = $("presentation-feed-list");
        if (!feedList) return;
        if (state.liveFeed.length === 0) {
            feedList.innerHTML = `<li class="presentation-feed-empty">Waiting for students to scan…</li>`;
            return;
        }
        feedList.innerHTML = state.liveFeed.slice(0, FEED_LIMIT).map((item, idx) => {
            const pillClass = item.status === "Late" ? "pill-late" : "pill-present";
            const freshClass = idx === 0 && item.isNew ? " feed-item-fresh" : "";
            return `<li class="presentation-feed-item${freshClass}">
                <div class="feed-item-student">
                    <span class="feed-avatar">${escapeHtml((item.name || "S").charAt(0).toUpperCase())}</span>
                    <div>
                        <strong class="feed-name">${escapeHtml(item.name)}</strong>
                        <span class="feed-code">${escapeHtml(item.student_id)}${item.time ? ` · ${escapeHtml(item.time)}` : ""}</span>
                    </div>
                </div>
                <span class="pill ${pillClass}">${escapeHtml(item.status)}</span>
            </li>`;
        }).join("");
    }

    function announceNewCheckins(newlyChecked) {
        if (!Array.isArray(newlyChecked) || newlyChecked.length === 0) return;
        const latest = newlyChecked[0];
        playCheckinChime(latest.status);

        const extraCount = newlyChecked.length > 1 ? ` (+${newlyChecked.length - 1} more)` : "";
        const pillClass = latest.status === "Late" ? "pill-late" : "pill-present";
        const bannerHtml = `
            <span class="live-pop-icon">${latest.status === "Late" ? "⏱" : "✓"}</span>
            <div class="live-pop-text">
                <strong>${escapeHtml(latest.name)}</strong> <span class="code">(${escapeHtml(latest.student_id)})</span> checked in${escapeHtml(extraCount)}
            </div>
            <span class="pill ${pillClass}">${escapeHtml(latest.status)}</span>
        `;

        ["host-live-banner", "presentation-live-pop"].forEach((id) => {
            const box = $(id);
            if (!box) return;
            box.innerHTML = bannerHtml;
            box.classList.remove("hidden", "pop-late");
            if (latest.status === "Late") box.classList.add("pop-late");
        });

        if (state.livePopTimer) clearTimeout(state.livePopTimer);
        state.livePopTimer = setTimeout(() => {
            $("host-live-banner")?.classList.add("hidden");
            $("presentation-live-pop")?.classList.add("hidden");
        }, 6500);
    }

    async function updateHostSessionLateCutoff(nextIso, toastMsg) {
        if (!state.hostSession || !sb) return;
        const prevIso = state.hostSession.late_after_at || null;
        state.hostSession.late_after_at = nextIso;
        saveHostSession(state.hostSession.token, nextIso);
        updateSmartTimers();
        try {
            const { error } = await sb
                .from("checkin_sessions")
                .update({ late_after_at: nextIso })
                .eq("token", state.hostSession.token);
            if (error && !/late_after_at/i.test(String(error.message || ""))) throw error;
            if (toastMsg) showToast(toastMsg);
        } catch (err) {
            console.error("Could not update late cutoff:", err);
            state.hostSession.late_after_at = prevIso;
            updateSmartTimers();
            showToast("Could not update Late timer", "error");
        }
    }

    async function handleLateToggle() {
        if (!state.hostSession) return;
        const now = Date.now();
        const lateAt = state.hostSession.late_after_at ? new Date(state.hostSession.late_after_at).getTime() : null;
        const isCurrentlyLate = lateAt !== null && lateAt <= now;
        if (isCurrentlyLate) {
            const reopenedIso = new Date(now + 5 * 60 * 1000).toISOString();
            await updateHostSessionLateCutoff(reopenedIso, "On-Time window reopened for 5 minutes");
        } else {
            const immediateLateIso = new Date(now - 1000).toISOString();
            await updateHostSessionLateCutoff(immediateLateIso, "Late Mode active — new check-ins will be marked Late");
        }
    }

    async function extendLateGrace(minutes = 5) {
        if (!state.hostSession) return;
        const now = Date.now();
        const currentLateMs = state.hostSession.late_after_at ? new Date(state.hostSession.late_after_at).getTime() : now;
        const baseMs = Math.max(now, currentLateMs);
        const nextIso = new Date(baseMs + minutes * 60 * 1000).toISOString();
        await updateHostSessionLateCutoff(nextIso, `Added +${minutes}m to On-Time grace period`);
    }

    async function loadRoster(silent = false) {
        const session = state.hostSession;
        if (!session || !sb) return;

        try {
            const { data: students, error } = await sb
                .from("students")
                .select("student_id, name")
                .eq("section", session.section)
                .order("name", { ascending: true });
            if (error) throw error;

            const list = students || [];
            const codes = list.map((s) => s.student_id);
            let statuses = {};

            if (codes.length > 0) {
                const { data: rows, error: attError } = await sb
                    .from("attendance")
                    .select("student_id, status, subject")
                    .eq("date", session.attendance_date)
                    .in("student_id", codes);
                if (attError) throw attError;
                (rows || []).forEach((row) => {
                    if (!row.subject || row.subject === "General") statuses[row.student_id] = row.status;
                });
            }

            let checked = 0;
            let presentCount = 0;
            let lateCount = 0;
            const items = list.map((student) => {
                const status = statuses[student.student_id];
                if (status === "Present") {
                    checked += 1;
                    presentCount += 1;
                } else if (status === "Late") {
                    checked += 1;
                    lateCount += 1;
                }
                return { ...student, status };
            });

            const pendingCount = Math.max(list.length - checked, 0);
            const pct = list.length > 0 ? Math.round((checked / list.length) * 100) : 0;

            $("host-checked").textContent = String(checked);
            $("host-total").textContent = String(list.length);
            $("host-pending").textContent = String(pendingCount);
            $("presentation-checked").textContent = String(checked);
            if ($("presentation-total-label")) {
                $("presentation-total-label").textContent = `of ${list.length} checked in (${pct}%)`;
            }
            if ($("presentation-present-count")) $("presentation-present-count").textContent = String(presentCount);
            if ($("presentation-late-count")) $("presentation-late-count").textContent = String(lateCount);
            if ($("presentation-pending-count")) $("presentation-pending-count").textContent = String(pendingCount);
            if ($("presentation-progress-fill")) $("presentation-progress-fill").style.width = `${pct}%`;

            // Detect newly checked-in students for live projector feed + sound
            const isFirstSeed = state.rosterSeededForToken !== session.token;
            const newlyChecked = [];
            const timeLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

            if (isFirstSeed) {
                state.knownCheckins.clear();
                state.liveFeed = [];
                items.forEach((item) => {
                    if (item.status === "Present" || item.status === "Late") {
                        state.knownCheckins.set(item.student_id, item.status);
                        state.liveFeed.push({
                            name: item.name,
                            student_id: item.student_id,
                            status: item.status,
                            time: "",
                            isNew: false
                        });
                    }
                });
                state.rosterSeededForToken = session.token;
            } else {
                state.liveFeed.forEach((f) => { f.isNew = false; });
                items.forEach((item) => {
                    if (item.status === "Present" || item.status === "Late") {
                        const prevStatus = state.knownCheckins.get(item.student_id);
                        if (prevStatus !== item.status) {
                            state.knownCheckins.set(item.student_id, item.status);
                            const entry = {
                                name: item.name,
                                student_id: item.student_id,
                                status: item.status,
                                time: timeLabel,
                                isNew: true
                            };
                            newlyChecked.push(entry);
                            state.liveFeed = [
                                entry,
                                ...state.liveFeed.filter((f) => f.student_id !== item.student_id)
                            ].slice(0, FEED_LIMIT);
                        }
                    }
                });
            }

            renderProjectorFeed();
            if (newlyChecked.length > 0) {
                announceNewCheckins(newlyChecked);
            }

            const roster = $("host-roster");
            if (items.length === 0) {
                roster.innerHTML = `<li><span class="muted">No students in this section yet.</span></li>`;
            } else {
                roster.innerHTML = items.map((item) => {
                    const pillClass = item.status ? `pill-${item.status.toLowerCase()}` : "";
                    const pillText = item.status || "Not checked in";
                    return `<li>
                        <span>
                            <span class="name">${escapeHtml(item.name)}</span><br>
                            <span class="code">${escapeHtml(item.student_id)}</span>
                        </span>
                        <span class="pill ${pillClass}">${escapeHtml(pillText)}</span>
                    </li>`;
                }).join("");
            }

            $("host-roster-updated").textContent = `Updated ${timeLabel}`;
        } catch (err) {
            console.error("Could not load roster:", err);
            if (!silent) showToast("Could not refresh the roster", "error");
        }
    }

    async function closeSession() {
        if (!state.hostSession || !sb) return;
        const btn = $("close-session-btn");
        btn.disabled = true;
        try {
            const { error } = await sb
                .from("checkin_sessions")
                .update({ closed: true })
                .eq("token", state.hostSession.token);
            if (error) throw error;
            state.hostSession.closed = true;
            clearSavedHostSession();
            if (state.rosterTimer) clearInterval(state.rosterTimer);
            state.rosterTimer = null;
            const badge = $("host-session-badge");
            badge.textContent = "Closed";
            badge.classList.add("badge-closed");
            $("present-btn").disabled = true;
            closePresentation();
            showToast("Check-in closed");
        } catch (err) {
            console.error("Could not close session:", err);
            showToast("Could not close the session", "error");
            btn.disabled = false;
        }
    }

    function newSession() {
        state.hostSession = null;
        state.rosterSeededForToken = "";
        state.knownCheckins.clear();
        state.liveFeed = [];
        clearSavedHostSession();
        if (state.rosterTimer) clearInterval(state.rosterTimer);
        state.rosterTimer = null;
        if (state.countdownTimer) clearInterval(state.countdownTimer);
        state.countdownTimer = null;
        closePresentation();
        stopScanner();
        $("host-session").classList.add("hidden");
        $("host-start-panel").classList.remove("hidden");
        $("session-qr").innerHTML = "";
        $("presentation-qr").innerHTML = "";
        $("session-link").value = "";
        $("host-live-banner")?.classList.add("hidden");
        $("presentation-live-pop")?.classList.add("hidden");
    }

    // Fullscreen QR for the classroom projector.
    function openPresentation() {
        const overlay = $("presentation");
        if (!overlay) return;
        overlay.classList.remove("hidden");
        document.body.style.overflow = "hidden";
        updateSmartTimers();
        renderProjectorFeed();
        const exit = $("presentation-exit");
        if (exit) exit.focus();
    }

    function closePresentation() {
        const overlay = $("presentation");
        if (!overlay || overlay.classList.contains("hidden")) return;
        overlay.classList.add("hidden");
        document.body.style.overflow = "";
        const btn = $("present-btn");
        if (btn) btn.focus();
    }

    async function copyCheckinLink() {
        const value = $("session-link").value;
        if (!value) return false;
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(value);
            } else {
                $("session-link").select();
                document.execCommand("copy");
            }
            showToast("Link copied — paste it in your class group chat");
            return true;
        } catch (err) {
            $("session-link").select();
            showToast("Press Ctrl/Cmd + C to copy the selected link");
            return false;
        }
    }

    async function shareCheckinLink() {
        const url = $("session-link").value;
        if (!url) return;
        const shareData = {
            title: "Scholog check-in",
            text: `Check in for ${state.hostSession ? state.hostSession.section : "class"}`,
            url
        };
        try {
            await navigator.share(shareData);
        } catch (err) {
            if (err && err.name === "AbortError") return;
            copyCheckinLink();
        }
    }

    function saveHostSession(token, lateAfterAt = null) {
        try {
            localStorage.setItem(HOST_STORAGE_KEY, JSON.stringify({
                token,
                late_after_at: lateAfterAt || null,
                savedAt: Date.now()
            }));
        } catch (err) { /* ignore */ }
    }
    function readSavedHostSession() {
        try {
            const raw = JSON.parse(localStorage.getItem(HOST_STORAGE_KEY) || "null");
            return raw && raw.token ? raw.token : "";
        } catch (err) {
            return "";
        }
    }
    function readSavedHostLateAfter() {
        try {
            const raw = JSON.parse(localStorage.getItem(HOST_STORAGE_KEY) || "null");
            return raw && raw.late_after_at ? raw.late_after_at : null;
        } catch (err) {
            return null;
        }
    }
    function clearSavedHostSession() {
        try { localStorage.removeItem(HOST_STORAGE_KEY); } catch (err) { /* ignore */ }
    }

    async function signOut() {
        try { if (sb) await sb.auth.signOut(); } catch (err) { /* ignore */ }
        window.location.href = "index.html";
    }

    // ------------------------------------------------------------------ wiring

    function wireEvents() {
        $("id-form").addEventListener("submit", (event) => {
            event.preventDefault();
            submitStudentId($("student-id-input").value);
        });

        $("tab-scan").addEventListener("click", () => setStudentTab("scan"));
        $("tab-id").addEventListener("click", () => setStudentTab("id"));
        $("tab-scan").addEventListener("keydown", handleTabKeys);
        $("tab-id").addEventListener("keydown", handleTabKeys);

        $("scan-use-id-btn").addEventListener("click", () => setStudentTab("id"));
        $("id-use-scan-btn").addEventListener("click", () => setStudentTab("scan"));

        $("startScanBtn").addEventListener("click", () => startScanner());
        $("stopScanBtn").addEventListener("click", () => stopScanner());

        $("result-retry-id").addEventListener("click", () => setStudentTab("id"));
        $("result-done").addEventListener("click", () => {
            hideResult();
            $("session-hint").scrollIntoView({ behavior: "smooth", block: "start" });
        });

        $("session-form").addEventListener("submit", createSession);
        $("refresh-roster-btn").addEventListener("click", () => {
            loadRoster();
            showToast("Roster refreshed");
        });
        $("close-session-btn").addEventListener("click", closeSession);
        $("new-session-btn").addEventListener("click", newSession);
        $("copy-link-btn").addEventListener("click", copyCheckinLink);
        $("presentation-copy").addEventListener("click", copyCheckinLink);
        $("share-link-btn").addEventListener("click", shareCheckinLink);
        $("present-btn").addEventListener("click", openPresentation);
        $("presentation-exit").addEventListener("click", closePresentation);
        $("signOutBtn").addEventListener("click", signOut);
        $("host-late-toggle-btn")?.addEventListener("click", handleLateToggle);
        $("presentation-late-toggle-btn")?.addEventListener("click", handleLateToggle);
        $("host-extend-late-btn")?.addEventListener("click", () => extendLateGrace(5));
        $("host-sound-btn")?.addEventListener("click", toggleProjectorSound);
        $("presentation-sound-btn")?.addEventListener("click", toggleProjectorSound);

        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape") closePresentation();
        });

        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState !== "visible") return;
            if (state.mode === "student") {
                refreshStudentSession(false);
                if (state.studentTab === "scan" && !state.scanning && !state.cameraBlocked && !state.deviceLocked) {
                    startScanner({ auto: true });
                }
            }
            if (state.mode === "host" && state.hostSession) loadRoster(true);
        });
    }

    async function init() {
        wireEvents();
        const token = getTokenFromUrl();
        if (token) {
            await startStudentMode(token);
        } else {
            await startHostMode();
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
