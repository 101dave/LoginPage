// Scholog — standalone QR / Student-ID check-in page.
//
// Two modes:
//   * Student mode  — scan.html?t=<session token>  (no login required; opened on
//     the student's own phone or any external device)
//   * Host mode     — scan.html (teacher signed in): creates a check-in session,
//     shows the QR/link to share, and follows the live roster.
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

    const $ = (id) => document.getElementById(id);

    let sb = null;
    try {
        sb = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
    } catch (err) {
        console.error("Supabase init failed:", err);
    }

    const state = {
        mode: "loading",
        token: "",
        session: null,
        currentUser: null,
        hostSession: null,
        rosterTimer: null,
        infoTimer: null,
        submitting: false,
        lastCode: "",
        lastCodeAt: 0,
        scanner: null,
        scanning: false,
        scanTarget: null
    };

    // ---------------------------------------------------------------- helpers

    function todayStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    function isUuid(value) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
    }

    function formatDate(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return value || "—";
        const d = new Date(`${value}T00:00:00`);
        return d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    }

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
        ["loading", "student", "host", "problem"].forEach((view) => {
            const el = $(`view-${view}`);
            if (el) el.classList.toggle("hidden", view !== name);
        });
        state.mode = name;
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
        state.rosterTimer = null;
        state.infoTimer = null;
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
            default:
                return "Something went wrong while saving your attendance. Please try again.";
        }
    }

    // ----------------------------------------------------------- student mode

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

        await refreshStudentSession(true);

        state.infoTimer = setInterval(() => {
            if (document.visibilityState === "visible") refreshStudentSession(false);
        }, 20000);
    }

    async function refreshStudentSession(initial) {
        try {
            const info = await rpc("checkin_session_info", { p_token: state.token });
            if (!info || !info.ok) {
                if (initial) {
                    showProblem(
                        "Check-in unavailable",
                        friendlyError(info && info.error),
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

        const form = $("id-form");
        const input = $("student-id-input");
        const submit = $("submitIdBtn");
        const startScan = $("startScanBtn");
        if (form) {
            input.disabled = !open;
            submit.disabled = !open;
            startScan.disabled = !open;
            if (!open) stopScanner();
        }
    }

    async function submitStudentId(rawCode) {
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
                "That QR code is the class check-in code, not a student ID. Type your Student ID instead."
            );
            return;
        }

        if (state.session.closed || state.session.expired) {
            showResult("error", "Check-in closed", friendlyError(state.session.closed ? "session_closed" : "session_expired"));
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
            const data = await rpc("checkin_mark", { p_token: state.token, p_student_id: code });
            if (data && data.ok) {
                const name = data.student_name || "Student";
                const detail = data.already_marked
                    ? `${name} (${data.student_id}) was already on the list — attendance confirmed as Present.`
                    : `${name} (${data.student_id}) is marked Present for ${formatDate(state.session.date)}.`;
                showResult(data.already_marked ? "info" : "success",
                    data.already_marked ? "Already checked in" : "You're marked Present",
                    detail);
                if (typeof data.checked_in === "number" && typeof data.student_count === "number") {
                    state.session.checked_in = data.checked_in;
                    state.session.student_count = data.student_count;
                    renderStudentSession(state.session);
                }
                $("student-id-input").value = "";
            } else {
                showResult("error", "Could not mark attendance", friendlyError(data && data.error, state.session.section));
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

    function showResult(kind, title, text) {
        const box = $("result");
        const icon = $("result-icon");
        const again = $("result-again");
        box.classList.remove("hidden", "result-error", "result-info");
        if (kind === "error") box.classList.add("result-error");
        if (kind === "info") box.classList.add("result-info");

        icon.classList.remove("result-icon-error", "result-icon-info");
        if (kind === "error") icon.classList.add("result-icon-error");
        if (kind === "info") icon.classList.add("result-icon-info");
        icon.textContent = kind === "error" ? "!" : (kind === "info" ? "i" : "✓");

        $("result-title").textContent = title;
        $("result-text").textContent = text;
        again.classList.toggle("hidden", kind === "error");
        box.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    // --------------------------------------------------------------- scanning

    function cameraSupported() {
        return Boolean(window.Html5Qrcode && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    async function startScanner(target) {
        const isHost = target === "host";
        const hintEl = $(isHost ? "host-scan-hint" : "camera-hint");
        const containerId = isHost ? "host-qr-reader" : "qr-reader";

        if (!cameraSupported()) {
            if (hintEl) hintEl.textContent = "Camera scanning isn't available in this browser. Please type your Student ID instead.";
            return;
        }
        if (state.scanning) return;

        $(containerId).classList.remove("hidden");
        state.scanTarget = target;
        const scanner = new window.Html5Qrcode(containerId, { verbose: false });
        state.scanner = scanner;

        try {
            await scanner.start(
                { facingMode: "environment" },
                { fps: 10, qrbox: { width: 230, height: 230 }, aspectRatio: 1.0 },
                (decoded) => handleDecoded(target, decoded),
                () => { /* per-frame decode misses are normal */ }
            );
            state.scanning = true;
            $(isHost ? "host-scan-btn" : "startScanBtn").classList.add("hidden");
            $(isHost ? "host-stop-scan-btn" : "stopScanBtn").classList.remove("hidden");
            if (hintEl) hintEl.textContent = "Camera on — point it at a QR code.";
        } catch (err) {
            console.error("Camera failed to start:", err);
            state.scanner = null;
            state.scanning = false;
            const name = err && err.name;
            let message = "Could not start the camera. Type your Student ID instead.";
            if (name === "NotAllowedError") message = "Camera permission was blocked. Allow camera access in your browser, or type your Student ID instead.";
            if (name === "NotFoundError") message = "No camera found on this device. Type your Student ID instead.";
            if (name === "NotReadableError") message = "The camera is busy in another app. Close it and try again, or type your Student ID.";
            if (hintEl) hintEl.textContent = message;
            try { scanner.clear(); } catch (e) { /* ignore */ }
            $(containerId).classList.add("hidden");
            $(isHost ? "host-scan-btn" : "startScanBtn").classList.remove("hidden");
            $(isHost ? "host-stop-scan-btn" : "stopScanBtn").classList.add("hidden");
        }
    }

    async function stopScanner() {
        const target = state.scanTarget;
        const containerId = target === "host" ? "host-qr-reader" : "qr-reader";
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
        const startBtn = $(target === "host" ? "host-scan-btn" : "startScanBtn");
        const stopBtn = $(target === "host" ? "host-stop-scan-btn" : "stopScanBtn");
        if (startBtn) startBtn.classList.remove("hidden");
        if (stopBtn) stopBtn.classList.add("hidden");
    }

    async function handleDecoded(target, decoded) {
        await stopScanner();
        if (target === "host") {
            await hostCheckIn(decoded);
        } else {
            await submitStudentId(decoded);
        }
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
                "Open this page from your Scholog dashboard after signing in, or ask your teacher for the class check-in link."
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

        await loadSections();

        const saved = readSavedHostSession();
        if (saved && isUuid(saved)) {
            const resumed = await resumeHostSession(saved);
            if (resumed) return;
        }
        $("host-empty").classList.remove("hidden");
        $("host-session").classList.add("hidden");
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

    function escapeHtml(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function escapeAttr(value) { return escapeHtml(value); }

    async function createSession(event) {
        event.preventDefault();
        if (!state.currentUser) return;

        const section = $("host-section").value;
        const date = $("host-date").value;
        const minutes = Number($("host-duration").value) || 60;

        if (!section) {
            $("host-form-hint").textContent = "Choose a section first.";
            return;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            $("host-form-hint").textContent = "Choose a valid date.";
            return;
        }

        const btn = $("start-session-btn");
        btn.disabled = true;
        btn.textContent = "Creating…";

        try {
            const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
            const { data, error } = await sb
                .from("checkin_sessions")
                .insert({
                    user_id: state.currentUser.id,
                    section,
                    attendance_date: date,
                    expires_at: expiresAt,
                    closed: false
                })
                .select("token, section, attendance_date, expires_at, closed")
                .single();
            if (error) throw error;

            state.hostSession = data;
            saveHostSession(data.token);
            $("host-form-hint").textContent = "";
            await renderHostSession();
            showToast("Check-in session created");
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
            const { data, error } = await sb
                .from("checkin_sessions")
                .select("token, section, attendance_date, expires_at, closed")
                .eq("token", token)
                .maybeSingle();
            if (error) throw error;
            if (!data) {
                clearSavedHostSession();
                return false;
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

        $("host-empty").classList.add("hidden");
        $("host-session").classList.remove("hidden");
        $("host-session").dataset.token = session.token;

        const url = buildCheckinUrl(session.token);
        renderQr(url);
        $("session-link").value = url;
        $("open-link-btn").href = url;

        const closed = Boolean(session.closed);
        const expired = new Date(session.expires_at).getTime() < Date.now();
        const badge = $("host-session-badge");
        badge.textContent = closed ? "Closed" : (expired ? "Expired" : "Open");
        badge.classList.toggle("badge-closed", closed || expired);

        $("close-session-btn").disabled = closed;
        $("host-scan-btn").disabled = closed || expired;

        await loadRoster();

        if (state.rosterTimer) clearInterval(state.rosterTimer);
        state.rosterTimer = setInterval(() => {
            if (document.visibilityState === "visible") loadRoster(true);
        }, 5000);
    }

    function renderQr(url) {
        const container = $("session-qr");
        container.innerHTML = "";
        if (typeof window.qrcode !== "function") {
            container.textContent = "QR generator unavailable — copy the link below.";
            return;
        }
        try {
            const qr = window.qrcode(0, "M");
            qr.addData(url);
            qr.make();
            container.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
        } catch (err) {
            console.error("QR generation failed:", err);
            container.textContent = "Could not draw the QR code — copy the link below.";
        }
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
            const items = list.map((student) => {
                const status = statuses[student.student_id];
                if (status === "Present" || status === "Late") checked += 1;
                return { ...student, status };
            });

            $("host-checked").textContent = String(checked);
            $("host-total").textContent = String(list.length);
            $("host-pending").textContent = String(Math.max(list.length - checked, 0));

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
        } catch (err) {
            console.error("Could not load roster:", err);
            if (!silent) showToast("Could not refresh the roster", "error");
        }
    }

    async function hostCheckIn(rawCode) {
        if (!state.hostSession) return;
        const hintEl = $("host-scan-hint");
        const code = extractStudentId(rawCode);
        if (!code) {
            if (hintEl) hintEl.textContent = "That QR code isn't a student ID. Try scanning a student's ID QR code.";
            return;
        }
        try {
            const data = await rpc("checkin_mark", { p_token: state.hostSession.token, p_student_id: code });
            if (data && data.ok) {
                showToast(`${data.student_name} marked Present`);
                if (hintEl) hintEl.textContent = `${data.student_name} (${data.student_id}) — present.`;
            } else {
                const message = friendlyError(data && data.error, state.hostSession.section);
                showToast(message, "error");
                if (hintEl) hintEl.textContent = message;
            }
        } catch (err) {
            console.error("Host check-in failed:", err);
            showToast("Could not save that check-in", "error");
            if (hintEl) hintEl.textContent = "Could not reach Scholog. Check your connection.";
        }
        loadRoster(true);
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
            $("host-scan-btn").disabled = true;
            showToast("Check-in closed");
        } catch (err) {
            console.error("Could not close session:", err);
            showToast("Could not close the session", "error");
            btn.disabled = false;
        }
    }

    function newSession() {
        state.hostSession = null;
        clearSavedHostSession();
        if (state.rosterTimer) clearInterval(state.rosterTimer);
        state.rosterTimer = null;
        $("host-session").classList.add("hidden");
        $("host-empty").classList.remove("hidden");
        $("session-qr").innerHTML = "";
        $("session-link").value = "";
        stopScanner();
    }

    function saveHostSession(token) {
        try { localStorage.setItem(HOST_STORAGE_KEY, JSON.stringify({ token, savedAt: Date.now() })); } catch (err) { /* ignore */ }
    }
    function readSavedHostSession() {
        try {
            const raw = JSON.parse(localStorage.getItem(HOST_STORAGE_KEY) || "null");
            return raw && raw.token ? raw.token : "";
        } catch (err) {
            return "";
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

        $("startScanBtn").addEventListener("click", () => startScanner("student"));
        $("stopScanBtn").addEventListener("click", () => stopScanner());
        $("result-again").addEventListener("click", () => {
            $("result").classList.add("hidden");
            $("student-id-input").focus();
        });

        $("session-form").addEventListener("submit", createSession);
        $("host-scan-btn").addEventListener("click", () => startScanner("host"));
        const stopHostBtn = $("host-stop-scan-btn");
        if (stopHostBtn) stopHostBtn.addEventListener("click", () => stopScanner());
        $("refresh-roster-btn").addEventListener("click", () => {
            loadRoster();
            showToast("Roster refreshed");
        });
        $("close-session-btn").addEventListener("click", closeSession);
        $("new-session-btn").addEventListener("click", newSession);
        $("copy-link-btn").addEventListener("click", async () => {
            const value = $("session-link").value;
            if (!value) return;
            try {
                await navigator.clipboard.writeText(value);
                showToast("Link copied");
            } catch (err) {
                $("session-link").select();
                showToast("Press Ctrl/Cmd + C to copy the selected link");
            }
        });
        $("signOutBtn").addEventListener("click", signOut);

        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState !== "visible") return;
            if (state.mode === "student") refreshStudentSession(false);
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
