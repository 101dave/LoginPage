// Supabase Configuration
const SUPABASE_URL = "https://jwjivkdgzxuaecplkkad.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3aml2a2Rnenh1YWVjcGxra2FkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2NTU0NzcsImV4cCI6MjEwODIzMTQ3N30.VTFzl7FlP0apBo5ngnclq3eA9aDE-o3I560-XHSiDKg";

const DEFAULT_SUBJECT = "General";
const VALID_STATUSES = new Set(["Present", "Absent", "Late", "Excused"]);

let supabaseClient = null;
if (window.supabase) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// App State
let currentUser = null;
let currentAvatar = "";
let pendingAvatarDataUrl = null;
let activeTab = "dashboard";
let selectedDirectorySection = "ALL";
let dashboardSelectedDate = "";
let trendDaysRange = 7;

// History Calendar State
let historyStudentId = null;
let historyCurrentDate = new Date();
let historySelectedDateStr = "";

// Bulk Import Staging
let stagedImportStudents = [];

// QR Scanner & Single Card State
let qrStream = null;
let qrScanRaf = null;
let qrFacingMode = "environment";
let qrLastScannedMap = {};
let qrRecentEntries = [];
let activeQrStudent = null;

// Sync State
let cloudHasData = false;
let flushingOps = false;

let state = {
    sections: [],
    sectionMeta: {},
    students: [],
    attendance: {},
    remarks: {}
};

// Keep session user fresh on automatic background token refresh
if (supabaseClient) {
    supabaseClient.auth.onAuthStateChange((event, session) => {
        if (session && session.user) {
            currentUser = session.user;
        } else if (event === "SIGNED_OUT") {
            currentUser = null;
        }
    });
}

// Replay queued offline changes automatically as soon as connectivity returns
window.addEventListener("online", () => {
    flushPendingOps().then(() => {
        saveLocalStore();
        switchTab(activeTab);
    }).catch(err => console.error("Auto-sync on reconnect failed:", err));
});

// Listen for Background Sync trigger from Service Worker (sw.js)
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
        if (e.data && e.data.type === "SYNC_NOW") {
            flushPendingOps().then(() => {
                saveLocalStore();
                switchTab(activeTab);
            }).catch(() => {});
        }
    });
}

// --- Theme Management (Light / Dark) ---
function syncThemeUI() {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const btn = document.getElementById("themeToggleBtn");
    if (btn) {
        btn.innerHTML = `<i data-lucide="${isDark ? "sun" : "moon"}"></i>`;
        btn.title = isDark ? "Switch to Light Mode" : "Switch to Dark Mode";
        refreshIcons();
    }
}

function toggleTheme() {
    const html = document.documentElement;
    const next = html.getAttribute("data-theme") === "dark" ? "light" : "dark";
    if (next === "dark") {
        html.setAttribute("data-theme", "dark");
    } else {
        html.removeAttribute("data-theme");
    }
    try {
        localStorage.setItem("scholog_theme", next);
    } catch (e) {}
    syncThemeUI();
}

// --- Safety & Key Helpers ---
function esc(v) {
    return String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function jsArg(v) {
    return esc(String(v ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/\r?\n/g, "\\n"));
}

function cloudReady() {
    return Boolean(supabaseClient && currentUser && currentUser.id !== "local-user");
}

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shiftDateStr(baseDateStr, deltaDays) {
    const [y, m, d] = baseDateStr.split("-").map(Number);
    const dt = new Date(y, m - 1, d + deltaDays);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function isValidDateStr(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + "T00:00:00Z");
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function sanitizeSubjectName(raw) {
    const cleaned = String(raw ?? "").replace(/\|/g, "-").trim();
    return cleaned || DEFAULT_SUBJECT;
}

function normalizeGender(raw) {
    const v = String(raw ?? "").trim().toLowerCase();
    if (v === "m" || v === "male" || v === "lalaki" || v === "boy") return "Male";
    if (v === "f" || v === "female" || v === "babae" || v === "girl") return "Female";
    return "";
}

// Backwards-compatible key builder:
// "General" -> `${date}_${studentId}` (matches existing local backups)
// Custom subject -> `${date}|${subject}|${studentId}`
function makeAttKey(date, studentId, subject = DEFAULT_SUBJECT) {
    const sub = sanitizeSubjectName(subject);
    return sub === DEFAULT_SUBJECT
        ? `${date}_${studentId}`
        : `${date}|${sub}|${studentId}`;
}

function parseAttKey(key) {
    if (key.includes("|")) {
        const firstPipe = key.indexOf("|");
        const secondPipe = key.indexOf("|", firstPipe + 1);
        if (firstPipe === 10 && secondPipe > firstPipe) {
            return {
                date: key.slice(0, 10),
                subject: sanitizeSubjectName(key.slice(firstPipe + 1, secondPipe)),
                studentId: key.slice(secondPipe + 1)
            };
        }
    }
    return {
        date: key.slice(0, 10),
        subject: DEFAULT_SUBJECT,
        studentId: key.slice(11)
    };
}

function getSectionMeta(secName) {
    const meta = state.sectionMeta && state.sectionMeta[secName];
    const subjects = Array.isArray(meta?.subjects) && meta.subjects.length > 0
        ? [...new Set(meta.subjects.map(sanitizeSubjectName))]
        : [DEFAULT_SUBJECT];
    return {
        start_time: typeof meta?.start_time === "string" ? meta.start_time : "",
        subjects
    };
}

function getAllKnownSubjects() {
    const set = new Set([DEFAULT_SUBJECT]);
    state.sections.forEach(sec => {
        getSectionMeta(sec).subjects.forEach(sub => set.add(sub));
    });
    Object.keys(state.attendance).forEach(k => {
        set.add(parseAttKey(k).subject);
    });
    return [...set];
}

function reportDbError(action, error) {
    console.error(`Scholog sync error (${action}):`, error);
    showToast(`Sync failed while ${action}. ${error && error.message ? error.message : "Check your connection."}`, "error");
}

function cacheKey() {
    return (currentUser && currentUser.id && currentUser.id !== "local-user")
        ? `scholog_app_data_${currentUser.id}`
        : "scholog_app_data";
}

function pendingKey() {
    return `${cacheKey()}_pending`;
}

function normalizeState(raw) {
    const sections = Array.isArray(raw.sections)
        ? [...new Set(raw.sections.map(s => String(s).trim()).filter(Boolean))]
        : [];

    const sectionMeta = {};
    if (raw.sectionMeta && typeof raw.sectionMeta === "object") {
        Object.keys(raw.sectionMeta).forEach(sec => {
            const m = raw.sectionMeta[sec] || {};
            const subs = Array.isArray(m.subjects) && m.subjects.length > 0
                ? [...new Set(m.subjects.map(sanitizeSubjectName))]
                : [DEFAULT_SUBJECT];
            sectionMeta[sec] = {
                start_time: typeof m.start_time === "string" ? m.start_time : "",
                subjects: subs
            };
        });
    }

    const seenCodes = new Set();
    const students = (Array.isArray(raw.students) ? raw.students : [])
        .map((s, idx) => ({
            id: s.id != null ? String(s.id) : `tmp-${idx}-${Date.now()}`,
            student_id: String(s.student_id ?? "").trim(),
            name: String(s.name ?? "").trim(),
            email: String(s.email ?? "").trim(),
            section: String(s.section ?? "").trim(),
            gender: normalizeGender(s.gender)
        }))
        .filter(s => {
            if (!s.student_id || !s.name || seenCodes.has(s.student_id)) return false;
            seenCodes.add(s.student_id);
            return true;
        });

    students.forEach(s => {
        if (s.section && !sections.includes(s.section)) sections.push(s.section);
    });

    sections.forEach(sec => {
        if (!sectionMeta[sec]) {
            sectionMeta[sec] = { start_time: "", subjects: [DEFAULT_SUBJECT] };
        }
    });

    const attendance = {};
    const rawAtt = (raw.attendance && typeof raw.attendance === "object" && !Array.isArray(raw.attendance))
        ? raw.attendance
        : {};
    Object.keys(rawAtt).forEach(k => {
        const { date, subject, studentId } = parseAttKey(k);
        if (isValidDateStr(date) && studentId && VALID_STATUSES.has(rawAtt[k])) {
            attendance[makeAttKey(date, studentId, subject)] = rawAtt[k];
        }
    });

    const remarks = {};
    const rawRem = (raw.remarks && typeof raw.remarks === "object" && !Array.isArray(raw.remarks))
        ? raw.remarks
        : {};
    Object.keys(rawRem).forEach(k => {
        const { date, subject, studentId } = parseAttKey(k);
        const val = String(rawRem[k] ?? "").trim();
        if (isValidDateStr(date) && studentId && val) {
            remarks[makeAttKey(date, studentId, subject)] = val;
        }
    });

    return { sections, sectionMeta, students, attendance, remarks };
}

// --- Initialization ---
document.addEventListener("DOMContentLoaded", async () => {
    try {
        syncThemeUI();
        await checkAuth();
        initDateInputs();
        refreshIcons();
        const hashTab = window.location.hash.replace(/^#/, "");
        const startTab = ["dashboard", "directory", "attendance"].includes(hashTab) ? hashTab : "dashboard";
        switchTab(startTab);
    } catch (err) {
        console.error("Scholog failed to start:", err);
        showToast("Scholog failed to load. Check your connection and refresh the page.", "error");
    }
});

async function checkAuth() {
    if (supabaseClient) {
        try {
            const { data: { session } } = await supabaseClient.auth.getSession();
            if (session) {
                currentUser = session.user;
                const displayName = session.user.user_metadata?.full_name || session.user.email.split("@")[0];
                currentAvatar = session.user.user_metadata?.avatar_url || "";
                setProfileUI(session.user.email, displayName, currentAvatar);
                await loadSupabaseData();
                await flushPendingOps();
                await migrateLocalDataToCloud();
                saveLocalStore();
                return;
            }
        } catch (err) {
            console.error("Auth check failed:", err);
        }
    }
    fallbackAuth();
}

function fallbackAuth() {
    const localUser = localStorage.getItem("scholog_local_user");
    if (localUser) {
        try {
            const parsed = JSON.parse(localUser);
            currentUser = { id: "local-user", email: parsed.email };
            currentAvatar = parsed.avatar || "";
            setProfileUI(parsed.email, parsed.name || "Teacher", currentAvatar);
            loadLocalStore();
            return;
        } catch (e) {
            console.error("Malformed local user:", e);
        }
    }
    window.location.href = "index.html";
}

function loadLocalStore() {
    const saved = localStorage.getItem(cacheKey()) || localStorage.getItem("scholog_app_data");
    if (saved) {
        try {
            state = normalizeState(JSON.parse(saved));
        } catch (e) {
            console.error("Failed to read local cache:", e);
        }
    }
}

function saveLocalStore() {
    try {
        localStorage.setItem(cacheKey(), JSON.stringify(state));
    } catch (e) {
        console.error("Could not cache data locally:", e);
    }
}

// --- Supabase Cloud Sync ---
function must(res) {
    if (res && res.error) throw res.error;
    return res;
}

async function fetchAll(table, userId) {
    const pageSize = 1000;
    let from = 0;
    let out = [];
    while (true) {
        const { data, error } = await supabaseClient
            .from(table)
            .select("*")
            .eq("user_id", userId)
            .order("id", { ascending: true })
            .range(from, from + pageSize - 1);
        if (error) throw error;
        out = out.concat(data || []);
        if (!data || data.length < pageSize) break;
        from += pageSize;
    }
    return out;
}

async function loadSupabaseData() {
    if (!cloudReady()) return;

    try {
        const [secData, studData, attData] = await Promise.all([
            fetchAll("sections", currentUser.id),
            fetchAll("students", currentUser.id),
            fetchAll("attendance", currentUser.id)
        ]);

        state.sections = secData.map(s => s.name);
        state.sectionMeta = {};
        secData.forEach(s => {
            const subs = Array.isArray(s.subjects) && s.subjects.length > 0
                ? [...new Set(s.subjects.map(sanitizeSubjectName))]
                : [DEFAULT_SUBJECT];
            state.sectionMeta[s.name] = {
                start_time: s.start_time || "",
                subjects: subs
            };
        });

        state.students = studData.map(s => ({
            id: s.id.toString(),
            student_id: s.student_id,
            name: s.name,
            email: s.email || "",
            section: s.section,
            gender: normalizeGender(s.gender)
        }));

        state.attendance = {};
        state.remarks = {};
        attData.forEach(row => {
            const key = makeAttKey(row.date, row.student_id, row.subject || DEFAULT_SUBJECT);
            state.attendance[key] = row.status;
            if (row.remarks) state.remarks[key] = row.remarks;
        });

        state.students.forEach(s => {
            if (s.section && !state.sections.includes(s.section)) {
                state.sections.push(s.section);
            }
        });
        state.sections.forEach(sec => {
            if (!state.sectionMeta[sec]) {
                state.sectionMeta[sec] = { start_time: "", subjects: [DEFAULT_SUBJECT] };
            }
        });

        cloudHasData = state.sections.length > 0
            || state.students.length > 0
            || Object.keys(state.attendance).length > 0;
    } catch (err) {
        reportDbError("loading your data", err);
        loadLocalStore();
    }
}

function queueOp(op) {
    try {
        const key = pendingKey();
        const q = JSON.parse(localStorage.getItem(key) || "[]");
        let out = q;
        if (op.t === "att" || op.t === "att-one") {
            const sub = sanitizeSubjectName(op.subject);
            out = q.filter(e => !(
                (e.t === "att" || e.t === "att-one")
                && e.date === op.date
                && e.student_id === op.student_id
                && sanitizeSubjectName(e.subject) === sub
            ));
        }
        out.push(op);
        localStorage.setItem(key, JSON.stringify(out));
        if ("serviceWorker" in navigator) {
            navigator.serviceWorker.ready.then(reg => {
                if (reg.sync) return reg.sync.register("scholog-sync");
            }).catch(() => {});
        }
    } catch (e) {
        console.error("Could not queue offline change:", e);
    }
}

async function runWithSessionRetry(op) {
    try {
        await applyCloudOp(op);
    } catch (err) {
        const msg = String(err && err.message ? err.message : "");
        if (/jwt expired|invalid jwt|pgrst301/i.test(msg) && supabaseClient) {
            const { data } = await supabaseClient.auth.refreshSession();
            if (data && data.session) {
                currentUser = data.session.user;
                await applyCloudOp(op);
                return;
            }
        }
        throw err;
    }
}

async function trySync(...ops) {
    if (!cloudReady()) return;
    for (const op of ops) {
        try {
            await runWithSessionRetry(op);
        } catch (err) {
            console.error("Sync failed, change queued for retry:", op, err);
            queueOp(op);
            showToast("Saved on this device — will sync automatically when you're back online.", "error");
        }
    }
}

async function applyCloudOp(op) {
    const uid = currentUser.id;
    switch (op.t) {
        case "att": {
            const subject = sanitizeSubjectName(op.subject);
            must(await supabaseClient.from("attendance").upsert({
                user_id: uid,
                date: op.date,
                student_id: op.student_id,
                subject,
                status: op.status,
                remarks: op.remarks || null
            }, { onConflict: "user_id,date,student_id,subject" }));
            break;
        }
        case "att-one": {
            const subject = sanitizeSubjectName(op.subject);
            must(await supabaseClient.from("attendance").delete()
                .eq("user_id", uid)
                .eq("date", op.date)
                .eq("student_id", op.student_id)
                .eq("subject", subject));
            break;
        }
        case "attB": {
            for (let i = 0; i < op.rows.length; i += 500) {
                const payload = op.rows.slice(i, i + 500).map(r => ({
                    user_id: uid,
                    date: r.date,
                    student_id: r.student_id,
                    subject: sanitizeSubjectName(r.subject),
                    status: r.status,
                    remarks: r.remarks || null
                }));
                must(await supabaseClient.from("attendance")
                    .upsert(payload, { onConflict: "user_id,date,student_id,subject" }));
            }
            break;
        }
        case "attClearSec": {
            const subject = sanitizeSubjectName(op.subject);
            if (op.codes && op.codes.length > 0) {
                for (let i = 0; i < op.codes.length; i += 100) {
                    must(await supabaseClient.from("attendance").delete()
                        .eq("user_id", uid)
                        .eq("date", op.date)
                        .eq("subject", subject)
                        .in("student_id", op.codes.slice(i, i + 100)));
                }
            }
            break;
        }
        case "att-":
            must(await supabaseClient.from("attendance").delete()
                .eq("user_id", uid).eq("student_id", op.student_id));
            break;
        case "att^":
            if (op.old_code !== op.student_id) {
                must(await supabaseClient.from("attendance").update({ student_id: op.student_id })
                    .eq("user_id", uid).eq("student_id", op.old_code));
            }
            break;
        case "sec+": {
            const subjects = Array.isArray(op.subjects) && op.subjects.length > 0
                ? op.subjects.map(sanitizeSubjectName)
                : [DEFAULT_SUBJECT];
            must(await supabaseClient.from("sections").upsert({
                user_id: uid,
                name: op.name,
                start_time: op.start_time || null,
                subjects
            }, { onConflict: "user_id,name" }));
            break;
        }
        case "sec^": {
            const subjects = Array.isArray(op.subjects) && op.subjects.length > 0
                ? op.subjects.map(sanitizeSubjectName)
                : [DEFAULT_SUBJECT];
            must(await supabaseClient.from("sections").upsert({
                user_id: uid,
                name: op.new_name,
                start_time: op.start_time || null,
                subjects
            }, { onConflict: "user_id,name" }));
            must(await supabaseClient.from("students").update({ section: op.new_name })
                .eq("user_id", uid).eq("section", op.old_name));
            must(await supabaseClient.from("sections").delete()
                .eq("user_id", uid).eq("name", op.old_name));
            break;
        }
        case "sec-":
            if (op.codes && op.codes.length > 0) {
                for (let i = 0; i < op.codes.length; i += 100) {
                    must(await supabaseClient.from("attendance").delete()
                        .eq("user_id", uid).in("student_id", op.codes.slice(i, i + 100)));
                }
            }
            must(await supabaseClient.from("students").delete()
                .eq("user_id", uid).eq("section", op.name));
            must(await supabaseClient.from("sections").delete()
                .eq("user_id", uid).eq("name", op.name));
            break;
        case "stu+":
            must(await supabaseClient.from("students").upsert({
                user_id: uid,
                student_id: op.student_id,
                name: op.name,
                email: op.email || null,
                section: op.section,
                gender: op.gender || null
            }, { onConflict: "user_id,student_id" }));
            break;
        case "stuB":
            for (let i = 0; i < op.rows.length; i += 500) {
                const payload = op.rows.slice(i, i + 500).map(s => ({
                    user_id: uid,
                    student_id: s.student_id,
                    name: s.name,
                    email: s.email || null,
                    section: s.section,
                    gender: s.gender || null
                }));
                must(await supabaseClient.from("students")
                    .upsert(payload, { onConflict: "user_id,student_id" }));
            }
            break;
        case "stu^":
            must(await supabaseClient.from("students").update({
                student_id: op.student_id,
                name: op.name,
                email: op.email || null,
                section: op.section,
                gender: op.gender || null
            }).eq("user_id", uid).eq("student_id", op.old_code));
            await applyCloudOp({ t: "att^", old_code: op.old_code, student_id: op.student_id });
            break;
        case "stu-":
            must(await supabaseClient.from("students").delete()
                .eq("user_id", uid).eq("student_id", op.student_id));
            await applyCloudOp({ t: "att-", student_id: op.student_id });
            break;
        case "prof": {
            const meta = { full_name: op.full_name };
            if (typeof op.avatar_url === "string") meta.avatar_url = op.avatar_url;
            must(await supabaseClient.auth.updateUser({ data: meta }));
            break;
        }
        default:
            console.error("Unknown queued operation:", op);
    }
}

async function flushPendingOps() {
    if (!cloudReady() || flushingOps) return;

    const key = pendingKey();
    let q = [];
    try { q = JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) { q = []; }
    if (!Array.isArray(q) || q.length === 0) return;

    flushingOps = true;
    const failed = [];
    let applied = 0;
    try {
        for (const op of q) {
            try {
                await runWithSessionRetry(op);
                applied++;
            } catch (err) {
                console.error("Failed to replay offline change:", op, err);
                failed.push(op);
            }
        }

        try { localStorage.setItem(key, JSON.stringify(failed)); } catch (e) {}

        if (applied > 0) {
            showToast(`Synced ${applied} offline change${applied > 1 ? "s" : ""} to the cloud.`, "success");
            await loadSupabaseData();
            cloudHasData = true;
        }
        if (failed.length > 0) {
            showToast(`Waiting to sync ${failed.length} change${failed.length > 1 ? "s" : ""}. Will retry automatically.`, "error");
        }
    } finally {
        flushingOps = false;
    }
}

async function migrateLocalDataToCloud() {
    if (!cloudReady() || cloudHasData) return;

    const legacy = localStorage.getItem("scholog_app_data");
    if (!legacy) return;

    const localUserRaw = localStorage.getItem("scholog_local_user");
    if (localUserRaw && currentUser?.email) {
        try {
            const localEmail = JSON.parse(localUserRaw).email;
            if (localEmail && localEmail.toLowerCase() !== currentUser.email.toLowerCase()) return;
        } catch (e) {}
    }

    try {
        const candidate = normalizeState(JSON.parse(legacy));
        const hasAny = candidate.sections.length > 0
            || candidate.students.length > 0
            || Object.keys(candidate.attendance).length > 0;
        if (!hasAny) return;

        state = candidate;
        await pushFullStateToCloud();
        localStorage.removeItem("scholog_app_data");
        showToast("Your saved local data was uploaded to your cloud account!", "success");
    } catch (err) {
        reportDbError("uploading your existing data", err);
    }
}

async function pushFullStateToCloud() {
    if (!cloudReady()) throw new Error("Not signed in to the cloud.");
    const uid = currentUser.id;

    must(await supabaseClient.from("attendance").delete().eq("user_id", uid));
    must(await supabaseClient.from("students").delete().eq("user_id", uid));
    must(await supabaseClient.from("sections").delete().eq("user_id", uid));

    if (state.sections.length > 0) {
        for (let i = 0; i < state.sections.length; i += 500) {
            must(await supabaseClient.from("sections").insert(
                state.sections.slice(i, i + 500).map(name => {
                    const meta = getSectionMeta(name);
                    return {
                        user_id: uid,
                        name,
                        start_time: meta.start_time || null,
                        subjects: meta.subjects
                    };
                })
            ));
        }
    }

    if (state.students.length > 0) {
        const idByCode = {};
        for (let i = 0; i < state.students.length; i += 500) {
            const { data, error } = await supabaseClient.from("students").insert(
                state.students.slice(i, i + 500).map(s => ({
                    user_id: uid,
                    student_id: s.student_id,
                    name: s.name,
                    email: s.email || null,
                    section: s.section,
                    gender: s.gender || null
                }))
            ).select("id, student_id");
            if (error) throw error;
            (data || []).forEach(r => { idByCode[r.student_id] = String(r.id); });
        }

        state.students.forEach(s => {
            if (idByCode[s.student_id]) s.id = idByCode[s.student_id];
        });
    }

    const attRows = Object.keys(state.attendance).map(k => {
        const { date, subject, studentId } = parseAttKey(k);
        return {
            user_id: uid,
            date,
            student_id: studentId,
            subject,
            status: state.attendance[k],
            remarks: state.remarks[k] || null
        };
    });
    for (let i = 0; i < attRows.length; i += 500) {
        must(await supabaseClient.from("attendance").insert(attRows.slice(i, i + 500)));
    }
}

function setProfileUI(email, name, avatarUrl) {
    const safeName = (name || "Teacher").trim() || "Teacher";
    const initial = safeName.charAt(0).toUpperCase();
    const nameElem = document.getElementById("userNameDisplay");
    const avatarElem = document.getElementById("userAvatar");
    const modalAvatar = document.getElementById("modalPreviewAvatar");
    const nameInput = document.getElementById("profile-display-name");
    const emailDisp = document.getElementById("profile-email-display");
    const syncBadge = document.getElementById("syncModeBadge");

    if (nameElem) nameElem.textContent = safeName;
    if (nameInput) nameInput.value = safeName;
    if (emailDisp) emailDisp.textContent = email || "";
    if (syncBadge) syncBadge.textContent = cloudReady() ? "Cloud Synced" : "Offline Mode";

    const validImg = typeof avatarUrl === "string" && /^data:image\/(jpeg|png|webp|gif);base64,/i.test(avatarUrl);
    if (avatarElem) {
        avatarElem.innerHTML = validImg ? `<img src="${esc(avatarUrl)}" alt="Avatar">` : "";
        if (!validImg) avatarElem.textContent = initial;
    }
    if (modalAvatar) {
        modalAvatar.innerHTML = validImg ? `<img src="${esc(avatarUrl)}" alt="Avatar">` : "";
        if (!validImg) modalAvatar.textContent = initial;
    }
}

function initDateInputs() {
    const today = todayStr();
    dashboardSelectedDate = today;
    const attDate = document.getElementById("att-date");
    const dashDate = document.getElementById("dash-date-input");
    if (attDate) attDate.value = today;
    if (dashDate) dashDate.value = today;
}

function refreshIcons() {
    if (window.lucide) {
        window.lucide.createIcons();
    }
}

// --- Navigation & Tabs ---
function switchTab(tabName) {
    activeTab = tabName;
    const views = ["dashboard", "directory", "attendance"];
    views.forEach(view => {
        const section = document.getElementById(`view-${view}`);
        const navBtn = document.getElementById(`nav-${view}`);
        const mobBtn = document.getElementById(`mob-nav-${view}`);

        if (section) section.classList.toggle("hidden", view !== tabName);
        if (navBtn) navBtn.classList.toggle("active", view === tabName);
        if (mobBtn) mobBtn.classList.toggle("active", view === tabName);
    });

    if (tabName === "dashboard") renderDashboard();
    if (tabName === "directory") renderDirectory();
    if (tabName === "attendance") {
        populateSectionDropdowns();
        populateAttSubjectDropdown();
        loadAttendanceSheet();
    }
    refreshIcons();
}

function jumpToTakeAttendance(secName, dateStr) {
    switchTab("attendance");
    const attSec = document.getElementById("att-section");
    const attDate = document.getElementById("att-date");
    if (attSec && state.sections.includes(secName)) {
        attSec.value = secName;
        populateAttSubjectDropdown();
    }
    if (attDate && isValidDateStr(dateStr)) {
        attDate.value = dateStr;
    }
    loadAttendanceSheet();
}

function toggleMobileMenu() {
    const menu = document.getElementById("mobileMenu");
    if (menu) menu.classList.toggle("hidden");
}

async function handleLogout() {
    stopQrCamera();
    try {
        if (supabaseClient) {
            await supabaseClient.auth.signOut();
        }
    } catch (err) {
        console.error("Sign-out error:", err);
    }
    localStorage.removeItem("scholog_local_user");
    window.location.href = "index.html";
}

// --- Dashboard View (Date Picker + Trend Chart + At-Risk Early Warning) ---
function onDashDateChange() {
    const val = document.getElementById("dash-date-input")?.value;
    if (isValidDateStr(val)) {
        dashboardSelectedDate = val;
        renderDashboard();
    }
}

function resetDashToToday() {
    dashboardSelectedDate = todayStr();
    const dashInput = document.getElementById("dash-date-input");
    if (dashInput) dashInput.value = dashboardSelectedDate;
    renderDashboard();
}

function setTrendRange(days) {
    trendDaysRange = days === 14 ? 14 : 7;
    document.getElementById("trend-range-7")?.classList.toggle("btn-primary", trendDaysRange === 7);
    document.getElementById("trend-range-7")?.classList.toggle("btn-secondary", trendDaysRange !== 7);
    document.getElementById("trend-range-14")?.classList.toggle("btn-primary", trendDaysRange === 14);
    document.getElementById("trend-range-14")?.classList.toggle("btn-secondary", trendDaysRange !== 14);
    renderDashboard();
}

function computeStudentRiskList(subjectFilter) {
    // Collect sorted distinct dates that have at least one attendance record for this subject
    const allDatesSet = new Set();
    Object.keys(state.attendance).forEach(k => {
        const parsed = parseAttKey(k);
        if (parsed.subject === subjectFilter) allDatesSet.add(parsed.date);
    });
    const sortedDates = [...allDatesSet].sort();
    if (sortedDates.length === 0) return [];

    const flagged = [];
    state.students.forEach(stud => {
        let totalRecorded = 0;
        let attended = 0;
        let absentTotal = 0;
        let currentStreak = 0;
        let maxConsecutiveAbsences = 0;

        sortedDates.forEach(dt => {
            const st = state.attendance[makeAttKey(dt, stud.student_id, subjectFilter)];
            if (!st) return;
            totalRecorded++;
            if (st === "Present" || st === "Late") {
                attended++;
                currentStreak = 0;
            } else if (st === "Absent") {
                absentTotal++;
                currentStreak++;
                if (currentStreak > maxConsecutiveAbsences) {
                    maxConsecutiveAbsences = currentStreak;
                }
            } else if (st === "Excused") {
                currentStreak = 0;
            }
        });

        if (totalRecorded === 0) return;

        const rate = Math.round((attended / totalRecorded) * 100);
        const hasStreakWarning = maxConsecutiveAbsences >= 3;
        const hasRateWarning = totalRecorded >= 2 && rate < 80;

        if (hasStreakWarning || hasRateWarning) {
            flagged.push({
                student: stud,
                rate,
                absentTotal,
                maxConsecutiveAbsences,
                totalRecorded
            });
        }
    });

    flagged.sort((a, b) => (b.maxConsecutiveAbsences - a.maxConsecutiveAbsences) || (a.rate - b.rate));
    return flagged;
}

function renderDashboard() {
    const today = todayStr();
    const targetDate = isValidDateStr(dashboardSelectedDate) ? dashboardSelectedDate : today;
    dashboardSelectedDate = targetDate;

    const dashInput = document.getElementById("dash-date-input");
    if (dashInput && dashInput.value !== targetDate) dashInput.value = targetDate;

    const todayBtn = document.getElementById("dash-today-btn");
    if (todayBtn) todayBtn.classList.toggle("hidden", targetDate === today);

    // Populate Subject Filter dropdown
    const subSelect = document.getElementById("dash-subject-filter");
    const knownSubjects = getAllKnownSubjects();
    let selectedSubject = subSelect?.value || DEFAULT_SUBJECT;
    if (!knownSubjects.includes(selectedSubject)) selectedSubject = DEFAULT_SUBJECT;
    if (subSelect) {
        subSelect.innerHTML = knownSubjects
            .map(s => `<option value="${esc(s)}">${s === DEFAULT_SUBJECT ? "Subject: General / Homeroom" : `Subject: ${esc(s)}`}</option>`)
            .join("");
        subSelect.value = selectedSubject;
    }

    const labelEl = document.getElementById("dash-date-label");
    if (labelEl) {
        labelEl.textContent = targetDate === today
            ? `Today (${targetDate})`
            : `Viewing ${targetDate}`;
    }

    const totalStudents = state.students.length;
    let presentCount = 0;
    let lateCount = 0;
    let excusedCount = 0;
    let absentCount = 0;
    let markedCount = 0;

    state.students.forEach(stud => {
        const status = state.attendance[makeAttKey(targetDate, stud.student_id, selectedSubject)];
        if (!status) return;
        markedCount++;
        if (status === "Present") presentCount++;
        else if (status === "Late") { presentCount++; lateCount++; }
        else if (status === "Excused") excusedCount++;
        else if (status === "Absent") absentCount++;
    });

    const unmarkedCount = Math.max(0, totalStudents - markedCount);
    const rate = totalStudents > 0 ? Math.round((presentCount / totalStudents) * 100) : 0;

    document.getElementById("stat-total").textContent = totalStudents;
    document.getElementById("stat-sections-sub").textContent = `${state.sections.length} Section${state.sections.length === 1 ? "" : "s"}`;
    document.getElementById("stat-present").textContent = presentCount;
    document.getElementById("stat-present-sub").textContent = `${lateCount} Late • ${excusedCount} Excused`;
    document.getElementById("stat-absent").textContent = absentCount;
    document.getElementById("stat-absent-sub").textContent = `${unmarkedCount} Unmarked`;
    document.getElementById("stat-rate").textContent = `${rate}%`;
    document.getElementById("stat-rate-sub").textContent = markedCount === 0
        ? "Not yet recorded"
        : `${markedCount}/${totalStudents} students recorded`;

    // Render 7 / 14 Day Attendance Trend Chart
    const trendContainer = document.getElementById("trend-chart-container");
    if (trendContainer) {
        trendContainer.innerHTML = "";
        for (let offset = -(trendDaysRange - 1); offset <= 0; offset++) {
            const dt = shiftDateStr(targetDate, offset);
            let dayAttended = 0;
            let dayMarked = 0;
            state.students.forEach(s => {
                const st = state.attendance[makeAttKey(dt, s.student_id, selectedSubject)];
                if (st) {
                    dayMarked++;
                    if (st === "Present" || st === "Late") dayAttended++;
                }
            });
            const pct = totalStudents > 0 && dayMarked > 0
                ? Math.round((dayAttended / totalStudents) * 100)
                : 0;
            const fillCls = dayMarked === 0 ? "" : (pct < 75 ? "low" : (pct < 90 ? "mid" : ""));
            const shortLbl = dt.slice(5); // MM-DD

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = `trend-col ${dt === targetDate ? "selected-day" : ""}`;
            btn.title = `${dt}: ${dayMarked === 0 ? "No records" : `${pct}% (${dayAttended}/${totalStudents} present)`}`;
            btn.onclick = () => {
                dashboardSelectedDate = dt;
                renderDashboard();
            };
            btn.innerHTML = `
                <span class="trend-pct">${dayMarked === 0 ? "—" : `${pct}%`}</span>
                <div class="trend-bar-track">
                    <div class="trend-bar-fill ${fillCls}" style="height: ${dayMarked === 0 ? 0 : Math.max(pct, 6)}%"></div>
                </div>
                <span class="trend-date-lbl">${esc(shortLbl)}</span>
            `;
            trendContainer.appendChild(btn);
        }
    }

    // Render At-Risk Students Warning Card
    const riskList = computeStudentRiskList(selectedSubject);
    const riskBadge = document.getElementById("at-risk-badge");
    const riskBody = document.getElementById("at-risk-list");
    if (riskBadge) {
        riskBadge.textContent = `${riskList.length} Flagged`;
        riskBadge.className = `badge ${riskList.length > 0 ? "badge-rose" : "badge-emerald"}`;
    }
    if (riskBody) {
        if (state.students.length === 0) {
            riskBody.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px;">Add students in <strong>Class List</strong> to monitor attendance warnings.</div>`;
        } else if (riskList.length === 0) {
            riskBody.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--emerald-text); font-size: 13px; font-weight: 600;">All students are on track — no attendance warnings right now.</div>`;
        } else {
            riskBody.innerHTML = riskList.map(item => {
                const s = item.student;
                const reasons = [];
                if (item.maxConsecutiveAbsences >= 3) reasons.push(`${item.maxConsecutiveAbsences} consecutive absences`);
                if (item.rate < 80) reasons.push(`${item.rate}% attendance (${item.absentTotal} absent)`);
                const mailSubject = encodeURIComponent(`Scholog Attendance Follow-Up — ${s.name}`);
                const mailBody = encodeURIComponent(
                    `Hello,\n\nWe are reaching out regarding ${s.name} (${s.section}), whose current recorded attendance rate is ${item.rate}% (${item.absentTotal} absence${item.absentTotal === 1 ? "" : "s"}).\n\nPlease let us know if everything is okay or if an excuse note needs to be submitted.\n\nThank you.`
                );
                return `
                    <div class="at-risk-row">
                        <div class="at-risk-meta">
                            <h4>${esc(s.name)}</h4>
                            <p>${esc(s.section)} &bull; <span class="text-rose" style="font-weight: 700;">${esc(reasons.join(" • "))}</span></p>
                        </div>
                        <div class="at-risk-actions">
                            <button type="button" onclick="openAttendanceHistory('${jsArg(s.id)}')" class="btn btn-secondary btn-sm">History</button>
                            ${s.email ? `<a href="mailto:${esc(s.email)}?subject=${mailSubject}&body=${mailBody}" class="btn btn-accent-blue btn-sm" style="text-decoration:none;">Email</a>` : ""}
                        </div>
                    </div>
                `;
            }).join("");
        }
    }

    // Section Breakdown List
    const container = document.getElementById("section-breakdown-container");
    container.innerHTML = "";

    if (state.sections.length === 0) {
        container.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px;">No sections created yet. Open <strong>Class List</strong> to add or import your first section and students.</div>`;
        return;
    }

    state.sections.forEach(sec => {
        const secStudents = state.students.filter(s => s.section === sec);
        const meta = getSectionMeta(sec);
        let secPresent = 0;
        let secAbsent = 0;
        let secMarked = 0;
        secStudents.forEach(s => {
            const st = state.attendance[makeAttKey(targetDate, s.student_id, selectedSubject)];
            if (st) secMarked++;
            if (st === "Present" || st === "Late") secPresent++;
            if (st === "Absent") secAbsent++;
        });
        const secRate = secStudents.length > 0 ? Math.round((secPresent / secStudents.length) * 100) : 0;

        const item = document.createElement("div");
        item.className = "breakdown-item";
        item.innerHTML = `
            <div class="breakdown-info">
                <h3>
                    ${esc(sec)}
                    ${meta.start_time ? `<span class="badge badge-gray">${esc(meta.start_time)}</span>` : ""}
                </h3>
                <p>${secStudents.length} Students &mdash; ${secMarked === 0 ? "Not yet marked" : `${secPresent} Present, ${secAbsent} Absent (${secMarked}/${secStudents.length} marked)`}</p>
            </div>
            <div class="breakdown-progress-group">
                <div class="progress-bar-wrapper">
                    <div class="progress-fill" style="width: ${secRate}%"></div>
                </div>
                <span class="stat-value" style="font-size: 16px; min-width: 44px; text-align: right;">${secRate}%</span>
                <button type="button" onclick="jumpToTakeAttendance('${jsArg(sec)}', '${jsArg(targetDate)}')" class="btn btn-secondary btn-sm">Take &rarr;</button>
            </div>
        `;
        container.appendChild(item);
    });
}

// --- Class List / Directory View ---
function renderDirectory() {
    if (selectedDirectorySection !== "ALL" && !state.sections.includes(selectedDirectorySection)) {
        selectedDirectorySection = "ALL";
    }

    const container = document.getElementById("directory-section-tabs");
    container.innerHTML = "";

    const allBtn = document.createElement("button");
    allBtn.className = `section-tab-btn ${selectedDirectorySection === "ALL" ? "active" : "inactive"}`;
    allBtn.onclick = () => { selectedDirectorySection = "ALL"; renderDirectory(); };
    allBtn.innerHTML = `All Students <span class="badge-count">${state.students.length}</span>`;
    container.appendChild(allBtn);

    state.sections.forEach(sec => {
        const count = state.students.filter(s => s.section === sec).length;
        const btn = document.createElement("button");
        btn.className = `section-tab-btn ${selectedDirectorySection === sec ? "active" : "inactive"}`;
        btn.onclick = () => { selectedDirectorySection = sec; renderDirectory(); };
        btn.innerHTML = `${esc(sec)} <span class="badge-count">${count}</span>`;
        container.appendChild(btn);
    });

    const searchQuery = (document.getElementById("directory-search")?.value || "").toLowerCase();
    const tableBody = document.getElementById("directory-table-body");
    tableBody.innerHTML = "";

    const banner = document.getElementById("directory-section-banner");
    const secMeta = selectedDirectorySection !== "ALL" ? getSectionMeta(selectedDirectorySection) : null;
    const subDesc = secMeta
        ? `Subjects: ${esc(secMeta.subjects.join(", "))}${secMeta.start_time ? ` • Start time: ${esc(secMeta.start_time)}` : ""}`
        : "Showing all enrolled students across sections";

    banner.innerHTML = `
        <div>
            <h3>${selectedDirectorySection === "ALL" ? "All Sections" : esc(selectedDirectorySection)}</h3>
            <p>${subDesc}</p>
        </div>
        <div class="banner-actions">
            <button onclick="exportSectionQrCardsPDF()" class="btn btn-secondary btn-sm">
                <i data-lucide="qr-code"></i> QR ID Cards PDF
            </button>
            ${selectedDirectorySection !== "ALL" ? `
                <button onclick="openEditSectionModal('${jsArg(selectedDirectorySection)}')" class="btn btn-secondary btn-sm action-edit"><i data-lucide="edit-3"></i> Edit Section</button>
                <button onclick="confirmDeleteSection('${jsArg(selectedDirectorySection)}')" class="btn btn-secondary btn-sm action-delete"><i data-lucide="trash-2"></i> Delete Section</button>
            ` : ""}
        </div>
    `;

    const filtered = state.students.filter(s => {
        const matchSec = selectedDirectorySection === "ALL" || s.section === selectedDirectorySection;
        const matchSearch = s.name.toLowerCase().includes(searchQuery)
            || s.student_id.toLowerCase().includes(searchQuery)
            || (s.email || "").toLowerCase().includes(searchQuery);
        return matchSec && matchSearch;
    });

    if (filtered.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="4" class="text-center" style="padding: 24px; color: var(--text-muted);">No students found. Add a student or use <strong>Import CSV/Excel</strong> above.</td></tr>`;
        refreshIcons();
        return;
    }

    filtered.forEach(stud => {
        const genderChip = stud.gender ? `<span class="gender-tag">${stud.gender.charAt(0)}</span>` : "";
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>
                <div class="student-cell">
                    <div class="student-avatar">${esc(stud.name.charAt(0))}</div>
                    <div>
                        <strong>${esc(stud.name)}</strong>${genderChip}
                        <div style="font-size: 11px; color: var(--text-muted);">${esc(stud.section)}</div>
                    </div>
                </div>
            </td>
            <td class="font-mono">${esc(stud.student_id)}</td>
            <td>${esc(stud.email || "—")}</td>
            <td class="text-right">
                <button onclick="openSingleStudentQrModal('${jsArg(stud.id)}')" class="action-link action-qr">QR</button>
                <button onclick="openAttendanceHistory('${jsArg(stud.id)}')" class="action-link action-history">History</button>
                <button onclick="openEditStudentModal('${jsArg(stud.id)}')" class="action-link action-edit">Edit</button>
                <button onclick="openTransferModal('${jsArg(stud.id)}')" class="action-link action-move">Move</button>
                <button onclick="confirmDeleteStudent('${jsArg(stud.id)}')" class="action-link action-delete">Delete</button>
            </td>
        `;
        tableBody.appendChild(tr);
    });

    refreshIcons();
}

// --- Attendance Sheet & Multi-Subject Logic ---
function populateSectionDropdowns() {
    const attSelect = document.getElementById("att-section");
    const studSelect = document.getElementById("stud-section");
    const transferSelect = document.getElementById("transfer-new-section");

    const prevAtt = attSelect ? attSelect.value : "";
    const optionsHTML = state.sections.length > 0
        ? state.sections.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("")
        : `<option value="">-- No sections yet --</option>`;

    if (attSelect) {
        attSelect.innerHTML = optionsHTML;
        if (prevAtt && state.sections.includes(prevAtt)) attSelect.value = prevAtt;
    }
    if (studSelect) studSelect.innerHTML = optionsHTML;
    if (transferSelect) transferSelect.innerHTML = optionsHTML;
}

function populateAttSubjectDropdown() {
    const sec = document.getElementById("att-section")?.value;
    const subSelect = document.getElementById("att-subject");
    if (!subSelect) return;

    const prev = subSelect.value;
    const subjects = sec ? getSectionMeta(sec).subjects : [DEFAULT_SUBJECT];
    subSelect.innerHTML = subjects
        .map(s => `<option value="${esc(s)}">${esc(s)}</option>`)
        .join("");
    if (prev && subjects.includes(prev)) {
        subSelect.value = prev;
    }
}

function onAttSectionChange() {
    populateAttSubjectDropdown();
    loadAttendanceSheet();
}

async function promptAddSubject() {
    const sec = document.getElementById("att-section")?.value;
    if (!sec) {
        showToast("Create a section first before adding subjects.", "error");
        return;
    }
    const raw = window.prompt(`Add a subject or schedule for ${sec} (e.g. Mathematics, Afternoon Session):`);
    if (!raw) return;
    const cleaned = sanitizeSubjectName(raw);
    const meta = getSectionMeta(sec);
    if (!meta.subjects.includes(cleaned)) {
        meta.subjects.push(cleaned);
        state.sectionMeta[sec] = meta;
        saveLocalStore();
        await trySync({ t: "sec+", name: sec, start_time: meta.start_time, subjects: meta.subjects });
    }
    populateAttSubjectDropdown();
    document.getElementById("att-subject").value = cleaned;
    loadAttendanceSheet();
    showToast(`Subject "${cleaned}" ready for ${sec}!`, "success");
}

function getCurrentAttContext() {
    const date = document.getElementById("att-date")?.value || "";
    const sec = document.getElementById("att-section")?.value || "";
    const subject = sanitizeSubjectName(document.getElementById("att-subject")?.value || DEFAULT_SUBJECT);
    return { date, sec, subject };
}

function loadAttendanceSheet() {
    const { date: selectedDate, sec: selectedSec, subject: selectedSubject } = getCurrentAttContext();
    const tableBody = document.getElementById("att-table-body");
    const statusBadge = document.getElementById("att-sheet-status-badge");
    const clearBtn = document.getElementById("att-clear-btn");
    const subtitle = document.getElementById("att-sheet-subtitle");

    tableBody.innerHTML = "";

    if (!selectedSec) {
        if (statusBadge) { statusBadge.textContent = "No Section"; statusBadge.className = "badge badge-gray"; }
        if (clearBtn) clearBtn.classList.add("hidden");
        tableBody.innerHTML = `<tr><td colspan="5" class="text-center" style="padding: 24px; color: var(--text-muted);">No sections yet. Go to <strong>Class List</strong> and click <strong>Add Section</strong> first.</td></tr>`;
        return;
    }

    if (!isValidDateStr(selectedDate)) {
        tableBody.innerHTML = `<tr><td colspan="5" class="text-center" style="padding: 24px; color: var(--text-muted);">Please select a valid date above.</td></tr>`;
        return;
    }

    const secStudents = state.students.filter(s => s.section === selectedSec);

    if (secStudents.length === 0) {
        if (statusBadge) { statusBadge.textContent = "0 Students"; statusBadge.className = "badge badge-gray"; }
        if (clearBtn) clearBtn.classList.add("hidden");
        tableBody.innerHTML = `<tr><td colspan="5" class="text-center" style="padding: 24px; color: var(--text-muted);">No students in this section yet. Add or import students in <strong>Class List</strong>.</td></tr>`;
        return;
    }

    let markedCount = 0;
    secStudents.forEach(stud => {
        if (state.attendance[makeAttKey(selectedDate, stud.student_id, selectedSubject)]) {
            markedCount++;
        }
    });

    if (statusBadge) {
        if (markedCount === 0) {
            statusBadge.textContent = `Unmarked (0/${secStudents.length})`;
            statusBadge.className = "badge badge-gray";
        } else if (markedCount < secStudents.length) {
            statusBadge.textContent = `Partial (${markedCount}/${secStudents.length} marked)`;
            statusBadge.className = "badge badge-amber";
        } else {
            statusBadge.textContent = `Complete (${markedCount}/${secStudents.length} marked)`;
            statusBadge.className = "badge badge-emerald";
        }
    }
    if (clearBtn) clearBtn.classList.toggle("hidden", markedCount === 0);
    if (subtitle) {
        subtitle.textContent = `${selectedSec} • ${selectedSubject} • ${selectedDate}`;
    }

    secStudents.forEach((stud, idx) => {
        const key = makeAttKey(selectedDate, stud.student_id, selectedSubject);
        const currentStatus = state.attendance[key] || null;
        const currentRemark = state.remarks[key] || "";
        const genderChip = stud.gender ? `<span class="gender-tag">${stud.gender.charAt(0)}</span>` : "";

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${idx + 1}</td>
            <td><strong>${esc(stud.name)}</strong>${genderChip}</td>
            <td class="font-mono">${esc(stud.student_id)}</td>
            <td class="text-center">
                <div class="status-pill-group">
                    ${["Present", "Absent", "Late", "Excused"].map(st => `
                        <button type="button" onclick="setStudentStatus('${jsArg(selectedDate)}', '${jsArg(stud.student_id)}', '${st}', '${jsArg(selectedSubject)}')" class="status-btn ${currentStatus === st ? `active-${st}` : ""}">
                            ${st}
                        </button>
                    `).join("")}
                </div>
            </td>
            <td>
                <input type="text" list="remarks-presets" value="${esc(currentRemark)}" onchange="updateStudentRemark('${jsArg(selectedDate)}', '${jsArg(stud.student_id)}', '${jsArg(selectedSubject)}', this.value)" class="remark-input" placeholder="Optional note...">
            </td>
        `;
        tableBody.appendChild(tr);
    });
}

async function setStudentStatus(date, studentId, status, subject = DEFAULT_SUBJECT) {
    if (!isValidDateStr(date) || !studentId) return;
    const sub = sanitizeSubjectName(subject);
    const key = makeAttKey(date, studentId, sub);

    // Clicking the already active pill toggles back to unmarked
    if (state.attendance[key] === status) {
        delete state.attendance[key];
        delete state.remarks[key];
        loadAttendanceSheet();
        saveLocalStore();
        await trySync({ t: "att-one", date, student_id: studentId, subject: sub });
        return;
    }

    state.attendance[key] = status;
    const remark = state.remarks[key] || "";
    loadAttendanceSheet();
    saveLocalStore();
    await trySync({ t: "att", date, student_id: studentId, subject: sub, status, remarks: remark });
}

async function updateStudentRemark(date, studentId, subject, rawNote) {
    if (!isValidDateStr(date) || !studentId) return;
    const sub = sanitizeSubjectName(subject);
    const key = makeAttKey(date, studentId, sub);
    const note = String(rawNote ?? "").trim();

    if (note) {
        state.remarks[key] = note;
        // If teacher writes an excuse note before picking a status, default to Excused or keep existing
        if (!state.attendance[key]) {
            state.attendance[key] = /medical|excuse|letter|clinic|competition/i.test(note) ? "Excused" : "Present";
            loadAttendanceSheet();
        }
    } else {
        delete state.remarks[key];
    }

    saveLocalStore();
    if (state.attendance[key]) {
        await trySync({
            t: "att",
            date,
            student_id: studentId,
            subject: sub,
            status: state.attendance[key],
            remarks: note
        });
    }
}

async function clearCurrentSheet() {
    const { date, sec, subject } = getCurrentAttContext();
    if (!isValidDateStr(date) || !sec) return;
    const secStudents = state.students.filter(s => s.section === sec);
    const codes = [];
    secStudents.forEach(s => {
        const key = makeAttKey(date, s.student_id, subject);
        if (state.attendance[key] || state.remarks[key]) {
            delete state.attendance[key];
            delete state.remarks[key];
            codes.push(s.student_id);
        }
    });
    saveLocalStore();
    loadAttendanceSheet();
    await trySync({ t: "attClearSec", date, subject, codes });
    showToast(`Cleared marks for ${sec} (${date}).`, "success");
}

async function markAllAttendance(status) {
    const { date, sec, subject } = getCurrentAttContext();
    if (!isValidDateStr(date) || !sec) {
        showToast("Please create and select a section first.", "error");
        return;
    }

    const secStudents = state.students.filter(s => s.section === sec);
    if (secStudents.length === 0) {
        showToast("No students in this section yet.", "error");
        return;
    }

    const rows = [];
    secStudents.forEach(s => {
        const key = makeAttKey(date, s.student_id, subject);
        state.attendance[key] = status;
        rows.push({
            date,
            student_id: s.student_id,
            subject,
            status,
            remarks: state.remarks[key] || ""
        });
    });

    saveLocalStore();
    loadAttendanceSheet();

    await trySync({ t: "attB", rows });
    showToast(`Marked all ${secStudents.length} students as ${status}.`, "success");
}

// Scoped strictly to active (date + section + subject) rather than re-uploading all historical records
async function saveAttendance() {
    const { date, sec, subject } = getCurrentAttContext();
    if (!isValidDateStr(date) || !sec) {
        showToast("Please select a valid date and section first.", "error");
        return;
    }

    const secStudents = state.students.filter(s => s.section === sec);
    const rows = [];
    secStudents.forEach(s => {
        const key = makeAttKey(date, s.student_id, subject);
        if (state.attendance[key]) {
            rows.push({
                date,
                student_id: s.student_id,
                subject,
                status: state.attendance[key],
                remarks: state.remarks[key] || ""
            });
        }
    });

    if (rows.length === 0) {
        showToast("No students marked yet — click 'All Present' or choose statuses before saving.", "error");
        return;
    }

    saveLocalStore();

    if (!cloudReady()) {
        showToast(`Saved ${rows.length}/${secStudents.length} attendance records locally!`, "success");
        return;
    }

    try {
        await flushPendingOps();
        await runWithSessionRetry({ t: "attB", rows });
        showToast(`Saved & synced ${rows.length}/${secStudents.length} records for ${sec}!`, "success");
    } catch (err) {
        queueOp({ t: "attB", rows });
        reportDbError("saving attendance", err);
    }
}

// --- Exports: Daily PDF + DepEd SF2 Monthly Excel Workbook (.xlsx) ---
function exportAttendanceToPDF() {
    const jsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDF) {
        showToast("PDF library is unavailable. Please refresh the page.", "error");
        return;
    }

    const { date, sec, subject } = getCurrentAttContext();
    if (!sec || !isValidDateStr(date)) {
        showToast("Select a valid date and section before exporting.", "error");
        return;
    }

    const doc = new jsPDF();
    if (typeof doc.autoTable !== "function") {
        showToast("PDF table plugin is unavailable. Please refresh the page.", "error");
        return;
    }

    const secStudents = state.students.filter(s => s.section === sec);
    let counts = { Present: 0, Late: 0, Absent: 0, Excused: 0, Unmarked: 0 };

    const rows = secStudents.map((stud, idx) => {
        const key = makeAttKey(date, stud.student_id, subject);
        const st = state.attendance[key] || "Unmarked";
        const note = state.remarks[key] || "";
        counts[st] = (counts[st] || 0) + 1;
        return [idx + 1, stud.name, stud.student_id, stud.gender || "—", st, note];
    });

    doc.setFontSize(15);
    doc.text(`Scholog Attendance Report — ${sec}`, 14, 18);
    doc.setFontSize(10);
    doc.text(`Date: ${date}   |   Subject: ${subject}`, 14, 25);
    doc.text(
        `Summary: Present ${counts.Present}  •  Late ${counts.Late}  •  Absent ${counts.Absent}  •  Excused ${counts.Excused}  •  Unmarked ${counts.Unmarked}`,
        14,
        31
    );

    doc.autoTable({
        startY: 36,
        head: [["#", "Student Name", "Student ID", "Gender", "Status", "Remarks"]],
        body: rows
    });

    const safeSec = sec.replace(/[\\/:*?"<>|]+/g, "-").trim() || "Section";
    doc.save(`Attendance_${safeSec}_${date}.pdf`);
    showToast("Daily PDF report exported!", "success");
}

function exportMonthlySF2Excel() {
    if (!window.XLSX) {
        showToast("Spreadsheet export library is unavailable.", "error");
        return;
    }

    const { date, sec, subject } = getCurrentAttContext();
    if (!sec || !isValidDateStr(date)) {
        showToast("Select a date and section first.", "error");
        return;
    }

    const secStudents = state.students.filter(s => s.section === sec);
    if (secStudents.length === 0) {
        showToast("No students in this section to export.", "error");
        return;
    }

    const [year, month] = date.split("-").map(Number);
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const dowShort = ["Su", "M", "T", "W", "TH", "F", "Sa"];
    const daysInMonth = new Date(year, month, 0).getDate();

    // Include Mon-Fri school days + any weekend date that actually has recorded attendance
    const schoolDays = [];
    for (let d = 1; d <= daysInMonth; d++) {
        const dtStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const dow = new Date(year, month - 1, d).getDay();
        const hasWeekendMark = secStudents.some(s => Boolean(state.attendance[makeAttKey(dtStr, s.student_id, subject)]));
        if ((dow >= 1 && dow <= 5) || hasWeekendMark) {
            schoolDays.push({ day: d, dowLabel: dowShort[dow], dateStr: dtStr });
        }
    }

    const teacherName = document.getElementById("userNameDisplay")?.textContent || "Teacher";
    const sheetRows = [
        ["School Form 2 (SF2) Daily Attendance Report of Learners"],
        [`Section: ${sec}`, "", `Month: ${monthNames[month - 1]} ${year}`, "", `Subject: ${subject}`, "", `Adviser/Teacher: ${teacherName}`],
        ["Legend: P = Present, L = Late (Tardy), A = Absent, E = Excused"],
        []
    ];

    const headerRow1 = ["#", "LEARNER'S NAME (Last Name, First Name)", "Student ID / LRN", ...schoolDays.map(d => d.day), "Total Present", "Total Late", "Total Absent", "Total Excused", "Attendance %", "Remarks / Notes"];
    const headerRow2 = ["", "", "", ...schoolDays.map(d => d.dowLabel), "", "", "", "", "", ""];
    sheetRows.push(headerRow1, headerRow2);

    const males = secStudents.filter(s => s.gender === "Male").sort((a, b) => a.name.localeCompare(b.name));
    const females = secStudents.filter(s => s.gender === "Female").sort((a, b) => a.name.localeCompare(b.name));
    const unspecified = secStudents.filter(s => !s.gender).sort((a, b) => a.name.localeCompare(b.name));

    const detailedLogs = [["Date", "Subject", "Section", "Student ID", "Student Name", "Gender", "Status", "Remarks"]];

    const appendGroup = (groupLabel, list) => {
        if (list.length === 0) return new Array(schoolDays.length).fill(0);
        sheetRows.push(["", `--- ${groupLabel} (${list.length}) ---`]);
        const dailyPresentTotals = new Array(schoolDays.length).fill(0);

        list.forEach((stud, idx) => {
            let pCount = 0, lCount = 0, aCount = 0, eCount = 0, recCount = 0;
            const studNotes = [];
            const marks = schoolDays.map((sd, dIdx) => {
                const key = makeAttKey(sd.dateStr, stud.student_id, subject);
                const st = state.attendance[key];
                const note = state.remarks[key] || "";
                if (st) {
                    recCount++;
                    detailedLogs.push([sd.dateStr, subject, sec, stud.student_id, stud.name, stud.gender || "Unspecified", st, note]);
                }
                if (note) studNotes.push(`${sd.dateStr.slice(5)}: ${note}`);

                if (st === "Present") { pCount++; dailyPresentTotals[dIdx]++; return "P"; }
                if (st === "Late") { lCount++; dailyPresentTotals[dIdx]++; return "L"; }
                if (st === "Absent") { aCount++; return "A"; }
                if (st === "Excused") { eCount++; return "E"; }
                return "";
            });

            const pct = recCount > 0 ? `${Math.round(((pCount + lCount) / recCount) * 100)}%` : "—";
            sheetRows.push([
                idx + 1,
                stud.name,
                stud.student_id,
                ...marks,
                pCount + lCount,
                lCount,
                aCount,
                eCount,
                pct,
                studNotes.join("; ")
            ]);
        });

        sheetRows.push(["", `${groupLabel} | DAILY PRESENT TOTAL`, "", ...dailyPresentTotals, "", "", "", "", "", ""]);
        return dailyPresentTotals;
    };

    const maleDaily = appendGroup("MALE", males);
    const femaleDaily = appendGroup("FEMALE", females);
    const unspecDaily = appendGroup("UNSPECIFIED GENDER", unspecified);

    const combinedDaily = schoolDays.map((_, i) => maleDaily[i] + femaleDaily[i] + unspecDaily[i]);
    sheetRows.push([]);
    sheetRows.push(["", "COMBINED TOTAL PER DAY", "", ...combinedDaily, "", "", "", "", "", ""]);

    const wb = window.XLSX.utils.book_new();
    const wsMatrix = window.XLSX.utils.aoa_to_sheet(sheetRows);
    const wsLogs = window.XLSX.utils.aoa_to_sheet(detailedLogs);
    window.XLSX.utils.book_append_sheet(wb, wsMatrix, "SF2 Monthly Matrix");
    window.XLSX.utils.book_append_sheet(wb, wsLogs, "Remarks & Logs");

    const safeSec = sec.replace(/[\\/:*?"<>|]+/g, "-").trim() || "Section";
    window.XLSX.writeFile(wb, `SF2_${safeSec}_${year}-${String(month).padStart(2, "0")}.xlsx`);
    showToast(`Exported SF2 Monthly Workbook (${monthNames[month - 1]} ${year})!`, "success");
}

// --- QR Code Generation (Single Card + Printable Section PDF) & Live Scanner ---
function generateQrPngDataUrl(payload, modulePx = 6, marginModules = 4) {
    if (!window.qrcode) throw new Error("QR generator library not loaded.");
    const qr = window.qrcode(0, "M");
    qr.addData(payload);
    qr.make();

    const count = qr.getModuleCount();
    const totalModules = count + marginModules * 2;
    const canvas = document.createElement("canvas");
    canvas.width = totalModules * modulePx;
    canvas.height = totalModules * modulePx;

    let ctx = null;
    try { ctx = canvas.getContext("2d"); } catch (e) { ctx = null; }
    if (!ctx) {
        return { dataUrl: qr.createDataURL(modulePx, marginModules * modulePx), format: "GIF", canvas: null, count, totalModules };
    }

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#0f172a";
    for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
            if (qr.isDark(r, c)) {
                ctx.fillRect((c + marginModules) * modulePx, (r + marginModules) * modulePx, modulePx, modulePx);
            }
        }
    }
    return { dataUrl: canvas.toDataURL("image/png"), format: "PNG", canvas };
}

function openSingleStudentQrModal(id) {
    const stud = state.students.find(s => s.id === id);
    if (!stud) return;
    try {
        const { dataUrl } = generateQrPngDataUrl(`SCHOLOG:${stud.student_id}`, 7, 4);
        activeQrStudent = { ...stud, qrDataUrl: dataUrl };
        document.getElementById("single-qr-img").src = dataUrl;
        document.getElementById("single-qr-name").textContent = stud.name;
        document.getElementById("single-qr-meta").textContent = `${stud.student_id} • ${stud.section}`;
        openModal("modal-student-qr");
    } catch (err) {
        showToast(err.message || "Could not generate QR code.", "error");
    }
}

function downloadSingleStudentQr() {
    if (!activeQrStudent) return;
    const a = document.createElement("a");
    a.href = activeQrStudent.qrDataUrl;
    a.download = `QR_${activeQrStudent.student_id}_${activeQrStudent.name.replace(/\s+/g, "_")}.png`;
    a.click();
}

function downloadSingleStudentQrPdf() {
    if (!activeQrStudent) return;
    renderQrCardsPdf([activeQrStudent], `QR_Card_${activeQrStudent.student_id}.pdf`);
}

function exportSectionQrCardsPDF() {
    const list = selectedDirectorySection === "ALL"
        ? state.students
        : state.students.filter(s => s.section === selectedDirectorySection);

    if (list.length === 0) {
        showToast("No students found to generate QR cards.", "error");
        return;
    }

    const label = selectedDirectorySection === "ALL" ? "All_Students" : selectedDirectorySection.replace(/[\\/:*?"<>|]+/g, "-");
    renderQrCardsPdf(list, `Scholog_QR_Cards_${label}.pdf`);
}

function renderQrCardsPdf(studentsList, fileName) {
    const jsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDF) {
        showToast("PDF library is unavailable.", "error");
        return;
    }

    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const cardW = 86;
    const cardH = 58;
    const marginX = 14;
    const marginY = 14;
    const gapX = 10;
    const gapY = 8;

    studentsList.forEach((stud, idx) => {
        const slot = idx % 8; // 2 columns x 4 rows per A4 page
        if (idx > 0 && slot === 0) doc.addPage();

        const col = slot % 2;
        const row = Math.floor(slot / 2);
        const x = marginX + col * (cardW + gapX);
        const y = marginY + row * (cardH + gapY);

        doc.setDrawColor(203, 213, 225);
        doc.roundedRect(x, y, cardW, cardH, 3, 3);

        const qrObj = generateQrPngDataUrl(`SCHOLOG:${stud.student_id}`, 6, 3);
        doc.addImage(qrObj.dataUrl, qrObj.format, x + 5, y + 8, 42, 42);

        doc.setFontSize(8);
        doc.setTextColor(100, 116, 139);
        doc.text("SCHOLOG ID CARD", x + 50, y + 15);

        doc.setFontSize(10.5);
        doc.setTextColor(15, 23, 42);
        const wrappedName = doc.splitTextToSize(stud.name, 32);
        doc.text(wrappedName.slice(0, 2), x + 50, y + 23);

        doc.setFontSize(8.5);
        doc.setTextColor(51, 65, 85);
        doc.text(`ID: ${stud.student_id}`, x + 50, y + 36);
        const wrappedSec = doc.splitTextToSize(stud.section, 32);
        doc.text(wrappedSec.slice(0, 2), x + 50, y + 43);
    });

    doc.save(fileName);
    showToast(`Generated ${studentsList.length} printable QR ID card${studentsList.length === 1 ? "" : "s"}!`, "success");
}

function parseQrStudentCode(raw) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) return "";
    if (/^scholog:/i.test(trimmed)) return trimmed.slice(8).trim();
    return trimmed;
}

function playScanBeep(kind) {
    if (!document.getElementById("qr-sound-toggle")?.checked) return;
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        const now = ctx.currentTime;
        gain.gain.setValueAtTime(0.12, now);
        if (kind === "error") {
            osc.type = "sawtooth";
            osc.frequency.setValueAtTime(220, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
            osc.start(now);
            osc.stop(now + 0.2);
        } else if (kind === "Late") {
            osc.frequency.setValueAtTime(587, now);
            osc.frequency.setValueAtTime(494, now + 0.09);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
            osc.start(now);
            osc.stop(now + 0.2);
        } else {
            osc.frequency.setValueAtTime(880, now);
            osc.frequency.setValueAtTime(1175, now + 0.08);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
            osc.start(now);
            osc.stop(now + 0.18);
        }
    } catch (e) {}
}

function openQrScannerModal() {
    const { date, sec, subject } = getCurrentAttContext();
    if (!sec) {
        showToast("Create and select a section first before scanning.", "error");
        return;
    }

    const meta = getSectionMeta(sec);
    const cutoffEl = document.getElementById("qr-cutoff-time");
    if (cutoffEl) cutoffEl.value = meta.start_time || "07:30";

    const ctxEl = document.getElementById("qr-scanner-context");
    if (ctxEl) ctxEl.textContent = `${sec} • ${subject} • ${date}`;

    openModal("modal-qr-scanner");
    startQrCamera();
}

function closeQrScannerModal() {
    stopQrCamera();
    closeModal("modal-qr-scanner");
}

async function saveQrCutoffForSection() {
    const { sec } = getCurrentAttContext();
    const val = document.getElementById("qr-cutoff-time")?.value || "";
    if (!sec) return;
    const meta = getSectionMeta(sec);
    meta.start_time = val;
    state.sectionMeta[sec] = meta;
    saveLocalStore();
    await trySync({ t: "sec+", name: sec, start_time: meta.start_time, subjects: meta.subjects });
}

async function startQrCamera() {
    stopQrCamera();
    const placeholder = document.getElementById("qr-camera-placeholder");
    const video = document.getElementById("qr-video");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        if (placeholder) placeholder.textContent = "Camera API not available in this browser — use Scan Image File or the USB/ID input below.";
        return;
    }

    try {
        qrStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: qrFacingMode } },
            audio: false
        });
        video.srcObject = qrStream;
        await video.play();
        if (placeholder) placeholder.classList.add("hidden");
        scanVideoFrameLoop();
    } catch (err) {
        if (placeholder) {
            placeholder.classList.remove("hidden");
            placeholder.textContent = "Camera permission denied or unavailable — upload a QR image or type/scan Student ID below.";
        }
    }
}

function flipQrCamera() {
    qrFacingMode = qrFacingMode === "environment" ? "user" : "environment";
    startQrCamera();
}

function stopQrCamera() {
    if (qrScanRaf) {
        cancelAnimationFrame(qrScanRaf);
        qrScanRaf = null;
    }
    if (qrStream) {
        qrStream.getTracks().forEach(t => t.stop());
        qrStream = null;
    }
    const video = document.getElementById("qr-video");
    if (video) video.srcObject = null;
}

function scanVideoFrameLoop() {
    const video = document.getElementById("qr-video");
    const canvas = document.getElementById("qr-canvas");
    if (!video || !canvas || !qrStream) return;

    if (video.readyState === video.HAVE_ENOUGH_DATA && window.jsQR) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const decoded = window.jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: "dontInvert" });
        if (decoded && decoded.data) {
            processScannedQrText(decoded.data);
        }
    }
    qrScanRaf = requestAnimationFrame(scanVideoFrameLoop);
}

function scanQrFromImageFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";

    const reader = new FileReader();
    reader.onload = (evt) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const decoded = window.jsQR ? window.jsQR(imgData.data, imgData.width, imgData.height) : null;
            if (decoded && decoded.data) {
                processScannedQrText(decoded.data, true);
            } else {
                playScanBeep("error");
                showToast("No readable QR code found in that image.", "error");
            }
        };
        img.src = evt.target.result;
    };
    reader.readAsDataURL(file);
}

function handleManualQrSubmit(e) {
    e.preventDefault();
    const input = document.getElementById("qr-manual-code");
    if (!input || !input.value.trim()) return;
    processScannedQrText(input.value.trim(), true);
    input.value = "";
    input.focus();
}

async function processScannedQrText(rawText, bypassCooldown = false) {
    const code = parseQrStudentCode(rawText);
    if (!code) return;

    const nowMs = Date.now();
    if (!bypassCooldown && qrLastScannedMap[code] && (nowMs - qrLastScannedMap[code]) < 3000) {
        return;
    }
    qrLastScannedMap[code] = nowMs;

    const stud = state.students.find(s => s.student_id.toLowerCase() === code.toLowerCase());
    if (!stud) {
        playScanBeep("error");
        showToast(`Unknown Student ID: "${code}"`, "error");
        return;
    }

    const { date, subject } = getCurrentAttContext();
    const targetDate = isValidDateStr(date) ? date : todayStr();
    const mode = document.getElementById("qr-scan-mode")?.value || "auto";
    const cutoff = document.getElementById("qr-cutoff-time")?.value || "";

    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    let status = "Present";
    if (mode === "Present" || mode === "Late") {
        status = mode;
    } else if (cutoff && targetDate === todayStr() && hhmm > cutoff) {
        status = "Late";
    }

    const key = makeAttKey(targetDate, stud.student_id, subject);
    state.attendance[key] = status;
    if (status === "Late" && !state.remarks[key]) {
        state.remarks[key] = `Scanned ${hhmm}`;
    }

    saveLocalStore();
    if (activeTab === "attendance") loadAttendanceSheet();
    playScanBeep(status);

    qrRecentEntries.unshift({
        time: hhmm,
        name: stud.name,
        code: stud.student_id,
        status
    });
    qrRecentEntries = qrRecentEntries.slice(0, 12);

    const feed = document.getElementById("qr-recent-scans");
    if (feed) {
        feed.innerHTML = qrRecentEntries.map(item => `
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <span><strong>${esc(item.name)}</strong> <span class="font-mono">(${esc(item.code)})</span></span>
                <span class="badge ${item.status === "Present" ? "badge-emerald" : "badge-amber"}">${esc(item.status)} • ${esc(item.time)}</span>
            </div>
        `).join("");
    }

    showToast(`${stud.name} marked ${status}!`, "success");
    await trySync({
        t: "att",
        date: targetDate,
        student_id: stud.student_id,
        subject,
        status,
        remarks: state.remarks[key] || ""
    });
}

// --- Bulk CSV / Excel / Copy-Paste Import ---
function openImportModal() {
    stagedImportStudents = [];
    const defSecInput = document.getElementById("import-default-section");
    if (defSecInput) {
        defSecInput.value = selectedDirectorySection !== "ALL"
            ? selectedDirectorySection
            : (state.sections[0] || "Grade 11 - STEM");
    }
    const pasteEl = document.getElementById("import-paste-text");
    if (pasteEl) pasteEl.value = "";
    const fileEl = document.getElementById("import-sheet-file");
    if (fileEl) fileEl.value = "";
    renderImportPreview();
    openModal("modal-import-students");
}

function downloadSampleTemplateCSV() {
    const csv = [
        "Student ID,Full Name,Gender,Section,Email",
        "2026-0001,\"Dela Cruz, Juan\",Male,Grade 11 - STEM,juan@example.com",
        "2026-0002,\"Santos, Maria\",Female,Grade 11 - STEM,maria@example.com"
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "Scholog_Students_Template.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function parseRowsToStudentObjects(aoaRows) {
    const fallbackSec = (document.getElementById("import-default-section")?.value || "").trim() || "Section A";
    const nonEmpty = aoaRows
        .map(r => (Array.isArray(r) ? r.map(c => String(c ?? "").trim()) : []))
        .filter(r => r.some(Boolean));

    if (nonEmpty.length === 0) return [];

    const firstLower = nonEmpty[0].map(c => c.toLowerCase());
    const findCol = (patterns) => firstLower.findIndex(h => patterns.some(p => p.test(h)));

    let idIdx = findCol([/^(student[_\s-]*id|id|lrn|code|id[_\s-]*no|student[_\s-]*no)$/i]);
    let nameIdx = findCol([/^(name|full[_\s-]*name|student[_\s-]*name|learner.*name|student)$/i]);
    let genderIdx = findCol([/^(gender|sex)$/i]);
    let secIdx = findCol([/^(section|class|strand|grade.*section)$/i]);
    let emailIdx = findCol([/^(email|e-mail|guardian.*email|parent.*email)$/i]);

    const hasHeader = idIdx !== -1 || nameIdx !== -1;
    let startRow = hasHeader ? 1 : 0;

    if (!hasHeader) {
        // Default column order: Student ID, Name, Gender, Section, Email
        idIdx = 0;
        nameIdx = 1;
        genderIdx = 2;
        secIdx = 3;
        emailIdx = 4;
    }

    const parsed = [];
    const seen = new Set();
    for (let i = startRow; i < nonEmpty.length; i++) {
        const row = nonEmpty[i];
        const student_id = (idIdx >= 0 ? row[idIdx] : "") || "";
        const name = (nameIdx >= 0 ? row[nameIdx] : "") || "";
        if (!student_id || !name || seen.has(student_id)) continue;
        seen.add(student_id);

        parsed.push({
            student_id,
            name,
            gender: genderIdx >= 0 ? normalizeGender(row[genderIdx]) : "",
            section: (secIdx >= 0 && row[secIdx]) ? row[secIdx] : fallbackSec,
            email: (emailIdx >= 0 && row[emailIdx]) ? row[emailIdx] : ""
        });
    }
    return parsed;
}

function handleSpreadsheetFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
        try {
            if (window.XLSX) {
                const wb = window.XLSX.read(evt.target.result, { type: "array" });
                const firstSheet = wb.Sheets[wb.SheetNames[0]];
                const rows = window.XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: "" });
                stagedImportStudents = parseRowsToStudentObjects(rows);
            } else {
                const text = new TextDecoder().decode(evt.target.result);
                const rows = text.split(/\r?\n/).map(line => line.split(/,|\t/));
                stagedImportStudents = parseRowsToStudentObjects(rows);
            }
            renderImportPreview();
        } catch (err) {
            showToast("Could not parse that spreadsheet file.", "error");
        }
    };
    reader.readAsArrayBuffer(file);
}

function previewPasteImport() {
    const raw = document.getElementById("import-paste-text")?.value || "";
    if (!raw.trim()) {
        stagedImportStudents = [];
        renderImportPreview();
        return;
    }
    const rows = raw.split(/\r?\n/).map(line => {
        if (line.includes("\t")) return line.split("\t");
        if (window.XLSX) {
            const wb = window.XLSX.read(line, { type: "string" });
            const sh = wb.Sheets[wb.SheetNames[0]];
            return (window.XLSX.utils.sheet_to_json(sh, { header: 1 })[0]) || [];
        }
        return line.split(",");
    });
    stagedImportStudents = parseRowsToStudentObjects(rows);
    renderImportPreview();
}

function renderImportPreview() {
    const summaryEl = document.getElementById("import-preview-summary");
    const tbody = document.getElementById("import-preview-body");
    const btn = document.getElementById("confirm-import-btn");

    if (btn) btn.disabled = stagedImportStudents.length === 0;
    if (summaryEl) {
        summaryEl.textContent = `${stagedImportStudents.length} valid student${stagedImportStudents.length === 1 ? "" : "s"} ready to import`;
    }
    if (!tbody) return;

    if (stagedImportStudents.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-center" style="padding: 14px; color: var(--text-muted);">Upload a file or paste rows above to preview</td></tr>`;
        return;
    }

    tbody.innerHTML = stagedImportStudents.slice(0, 25).map(s => `
        <tr>
            <td class="font-mono">${esc(s.student_id)}</td>
            <td><strong>${esc(s.name)}</strong></td>
            <td>${esc(s.gender || "—")}</td>
            <td>${esc(s.section)}</td>
        </tr>
    `).join("");
}

async function commitBulkImport() {
    if (stagedImportStudents.length === 0) return;

    const newSections = [];
    stagedImportStudents.forEach(item => {
        if (item.section && !state.sections.includes(item.section)) {
            state.sections.push(item.section);
            state.sectionMeta[item.section] = { start_time: "", subjects: [DEFAULT_SUBJECT] };
            newSections.push(item.section);
        }

        const existingIdx = state.students.findIndex(s => s.student_id === item.student_id);
        if (existingIdx >= 0) {
            state.students[existingIdx] = {
                ...state.students[existingIdx],
                name: item.name,
                section: item.section,
                gender: item.gender || state.students[existingIdx].gender || "",
                email: item.email || state.students[existingIdx].email || ""
            };
        } else {
            state.students.push({
                id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                student_id: item.student_id,
                name: item.name,
                section: item.section,
                gender: item.gender,
                email: item.email
            });
        }
    });

    const count = stagedImportStudents.length;
    const ops = [
        ...newSections.map(name => ({ t: "sec+", name, start_time: "", subjects: [DEFAULT_SUBJECT] })),
        { t: "stuB", rows: [...stagedImportStudents] }
    ];

    stagedImportStudents = [];
    saveLocalStore();
    closeModal("modal-import-students");
    renderDirectory();
    showToast(`Imported ${count} student${count === 1 ? "" : "s"} successfully!`, "success");
    await trySync(...ops);
}

// --- Modals & CRUD Actions ---
function openModal(id) { document.getElementById(id)?.classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id)?.classList.add("hidden"); }

function parseSubjectsInput(raw) {
    const list = String(raw ?? "")
        .split(",")
        .map(sanitizeSubjectName)
        .filter(Boolean);
    return list.length > 0 ? [...new Set(list)] : [DEFAULT_SUBJECT];
}

function openAddSectionModal() {
    const titleEl = document.querySelector("#modal-section h3");
    if (titleEl) titleEl.textContent = "Add Section";
    const formEl = document.querySelector("#modal-section form");
    if (formEl) formEl.onsubmit = handleSectionSubmit;
    document.getElementById("new-section-name").value = "";
    document.getElementById("section-start-time").value = "";
    document.getElementById("section-subjects").value = "General";
    openModal("modal-section");
}

function openEditSectionModal(oldName) {
    const meta = getSectionMeta(oldName);
    const titleEl = document.querySelector("#modal-section h3");
    if (titleEl) titleEl.textContent = "Edit Section";
    document.getElementById("new-section-name").value = oldName;
    document.getElementById("section-start-time").value = meta.start_time || "";
    document.getElementById("section-subjects").value = meta.subjects.join(", ");

    const formEl = document.querySelector("#modal-section form");
    if (formEl) {
        formEl.onsubmit = async (e) => {
            e.preventDefault();
            const newName = document.getElementById("new-section-name").value.trim();
            const startTime = document.getElementById("section-start-time").value;
            const subjects = parseSubjectsInput(document.getElementById("section-subjects").value);
            if (!newName) return;

            if (newName !== oldName && state.sections.includes(newName)) {
                showToast("That section already exists.", "error");
                return;
            }

            if (newName === oldName) {
                state.sectionMeta[oldName] = { start_time: startTime, subjects };
                saveLocalStore();
                closeModal("modal-section");
                renderDirectory();
                showToast("Section schedule & subjects updated!", "success");
                await trySync({ t: "sec+", name: oldName, start_time: startTime, subjects });
                return;
            }

            const idx = state.sections.indexOf(oldName);
            if (idx !== -1) state.sections[idx] = newName;
            delete state.sectionMeta[oldName];
            state.sectionMeta[newName] = { start_time: startTime, subjects };

            state.students.forEach(s => {
                if (s.section === oldName) s.section = newName;
            });

            if (selectedDirectorySection === oldName) {
                selectedDirectorySection = newName;
            }

            saveLocalStore();
            closeModal("modal-section");
            renderDirectory();
            showToast("Section updated!", "success");
            await trySync({ t: "sec^", old_name: oldName, new_name: newName, start_time: startTime, subjects });
        };
    }
    openModal("modal-section");
}

async function handleSectionSubmit(e) {
    e.preventDefault();
    const name = document.getElementById("new-section-name").value.trim();
    const startTime = document.getElementById("section-start-time").value;
    const subjects = parseSubjectsInput(document.getElementById("section-subjects").value);
    if (!name) return;

    if (state.sections.includes(name)) {
        showToast("That section already exists.", "error");
        return;
    }

    state.sections.push(name);
    state.sectionMeta[name] = { start_time: startTime, subjects };
    saveLocalStore();
    closeModal("modal-section");
    renderDirectory();
    showToast("Section added!", "success");
    await trySync({ t: "sec+", name, start_time: startTime, subjects });
}

function openAddStudentModal() {
    if (state.sections.length === 0) {
        showToast("Add a section first (e.g. Grade 11 - STEM), then add students to it.", "error");
        openAddSectionModal();
        return;
    }
    document.getElementById("student-modal-title").textContent = "Add New Student";
    document.getElementById("form-student").reset();
    document.getElementById("student-edit-id").value = "";
    populateSectionDropdowns();
    if (selectedDirectorySection !== "ALL" && state.sections.includes(selectedDirectorySection)) {
        document.getElementById("stud-section").value = selectedDirectorySection;
    }
    openModal("modal-student");
}

function openEditStudentModal(id) {
    const stud = state.students.find(s => s.id === id);
    if (!stud) {
        showToast("Student not found — please try again.", "error");
        return;
    }
    populateSectionDropdowns();
    document.getElementById("student-modal-title").textContent = "Edit Student";
    document.getElementById("student-edit-id").value = stud.id;
    document.getElementById("stud-name").value = stud.name;
    document.getElementById("stud-id").value = stud.student_id;
    document.getElementById("stud-section").value = stud.section;
    document.getElementById("stud-gender").value = stud.gender || "";
    document.getElementById("stud-email").value = stud.email || "";
    openModal("modal-student");
}

async function handleStudentSubmit(e) {
    e.preventDefault();
    const editId = document.getElementById("student-edit-id").value;
    const name = document.getElementById("stud-name").value.trim();
    const studId = document.getElementById("stud-id").value.trim();
    const sec = document.getElementById("stud-section").value;
    const gender = normalizeGender(document.getElementById("stud-gender").value);
    const email = document.getElementById("stud-email").value.trim();

    if (!name || !studId) {
        showToast("Please fill in the student name and ID.", "error");
        return;
    }

    if (!sec) {
        showToast("Please create and select a section first.", "error");
        return;
    }

    const clash = state.students.find(s => s.student_id === studId && s.id !== editId);
    if (clash) {
        showToast(`Student ID "${studId}" is already used by ${clash.name}.`, "error");
        return;
    }

    if (editId) {
        const idx = state.students.findIndex(s => s.id === editId);
        if (idx === -1) {
            closeModal("modal-student");
            return;
        }
        const oldCode = state.students[idx].student_id;
        state.students[idx] = { id: editId, name, student_id: studId, section: sec, gender, email };

        if (oldCode !== studId) {
            const relinkedAtt = {};
            Object.keys(state.attendance).forEach(k => {
                const { date, subject, studentId } = parseAttKey(k);
                relinkedAtt[makeAttKey(date, studentId === oldCode ? studId : studentId, subject)] = state.attendance[k];
            });
            const relinkedRem = {};
            Object.keys(state.remarks).forEach(k => {
                const { date, subject, studentId } = parseAttKey(k);
                relinkedRem[makeAttKey(date, studentId === oldCode ? studId : studentId, subject)] = state.remarks[k];
            });
            state.attendance = relinkedAtt;
            state.remarks = relinkedRem;

            saveLocalStore();
            closeModal("modal-student");
            renderDirectory();
            showToast("Student updated!", "success");
            await trySync({ t: "stu^", old_code: oldCode, student_id: studId, name, email, section: sec, gender });
        } else {
            saveLocalStore();
            closeModal("modal-student");
            renderDirectory();
            showToast("Student updated!", "success");
            await trySync({ t: "stu+", student_id: studId, name, email, section: sec, gender });
        }
    } else {
        const newStud = {
            id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name,
            student_id: studId,
            section: sec,
            gender,
            email
        };
        state.students.push(newStud);
        saveLocalStore();
        closeModal("modal-student");
        renderDirectory();
        showToast("Student saved!", "success");
        await trySync({ t: "stu+", student_id: studId, name, email, section: sec, gender });
    }
}

function openTransferModal(id) {
    const stud = state.students.find(s => s.id === id);
    if (!stud) return;
    populateSectionDropdowns();
    document.getElementById("transfer-student-id").value = stud.id;
    document.getElementById("transfer-student-name").value = stud.name;
    document.getElementById("transfer-new-section").value = stud.section;
    openModal("modal-transfer-student");
}

async function handleTransferSubmit(e) {
    e.preventDefault();
    const id = document.getElementById("transfer-student-id").value;
    const newSec = document.getElementById("transfer-new-section").value;
    if (!newSec) return;

    const stud = state.students.find(s => s.id === id);
    if (!stud) {
        closeModal("modal-transfer-student");
        return;
    }

    stud.section = newSec;
    saveLocalStore();
    closeModal("modal-transfer-student");
    renderDirectory();
    showToast("Student moved!", "success");
    await trySync({ t: "stu+", student_id: stud.student_id, name: stud.name, email: stud.email, section: newSec, gender: stud.gender });
}

function confirmDeleteStudent(id) {
    const stud = state.students.find(s => s.id === id);
    if (!stud) return;
    document.getElementById("delete-student-name").textContent = stud.name;
    document.getElementById("confirm-delete-btn").onclick = async () => {
        const code = stud.student_id;
        state.students = state.students.filter(s => s.id !== id);
        Object.keys(state.attendance).forEach(k => {
            if (parseAttKey(k).studentId === code) delete state.attendance[k];
        });
        Object.keys(state.remarks).forEach(k => {
            if (parseAttKey(k).studentId === code) delete state.remarks[k];
        });

        saveLocalStore();
        closeModal("modal-delete-student");
        renderDirectory();
        showToast("Student deleted", "success");
        await trySync({ t: "stu-", student_id: code });
    };
    openModal("modal-delete-student");
}

function confirmDeleteSection(sec) {
    document.getElementById("delete-section-name").textContent = sec;
    document.getElementById("confirm-delete-section-btn").onclick = async () => {
        const codes = state.students.filter(s => s.section === sec).map(s => s.student_id);

        state.students = state.students.filter(s => s.section !== sec);
        Object.keys(state.attendance).forEach(k => {
            if (codes.includes(parseAttKey(k).studentId)) delete state.attendance[k];
        });
        Object.keys(state.remarks).forEach(k => {
            if (codes.includes(parseAttKey(k).studentId)) delete state.remarks[k];
        });
        state.sections = state.sections.filter(s => s !== sec);
        delete state.sectionMeta[sec];
        selectedDirectorySection = "ALL";

        saveLocalStore();
        closeModal("modal-delete-section");
        renderDirectory();
        showToast("Section and its records deleted", "success");
        await trySync({ t: "sec-", name: sec, codes });
    };
    openModal("modal-delete-section");
}

// --- Interactive Student Attendance Calendar History ---
function openAttendanceHistory(studentId) {
    const stud = state.students.find(s => s.id === studentId);
    if (!stud) return;

    const now = new Date();
    historyStudentId = studentId;
    historyCurrentDate = new Date(now.getFullYear(), now.getMonth(), 1);
    historySelectedDateStr = todayStr();

    const subSel = document.getElementById("history-subject-select");
    if (subSel) {
        const subs = getSectionMeta(stud.section).subjects;
        subSel.innerHTML = subs.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
        subSel.value = DEFAULT_SUBJECT;
    }

    renderHistoryCalendar();
    openModal("modal-attendance-history");
}

function changeHistoryMonth(delta) {
    historyCurrentDate = new Date(
        historyCurrentDate.getFullYear(),
        historyCurrentDate.getMonth() + delta,
        1
    );
    renderHistoryCalendar();
}

function selectHistoryDay(dateStr) {
    historySelectedDateStr = dateStr;
    renderHistoryCalendar();
}

async function setHistoryDayStatus(status) {
    const stud = state.students.find(s => s.id === historyStudentId);
    if (!stud || !isValidDateStr(historySelectedDateStr)) return;
    const subject = sanitizeSubjectName(document.getElementById("history-subject-select")?.value || DEFAULT_SUBJECT);
    const key = makeAttKey(historySelectedDateStr, stud.student_id, subject);

    if (!status) {
        delete state.attendance[key];
        delete state.remarks[key];
        saveLocalStore();
        renderHistoryCalendar();
        if (activeTab === "dashboard") renderDashboard();
        if (activeTab === "attendance") loadAttendanceSheet();
        await trySync({ t: "att-one", date: historySelectedDateStr, student_id: stud.student_id, subject });
        return;
    }

    state.attendance[key] = status;
    const note = document.getElementById("history-day-remark")?.value.trim() || state.remarks[key] || "";
    if (note) state.remarks[key] = note;

    saveLocalStore();
    renderHistoryCalendar();
    if (activeTab === "dashboard") renderDashboard();
    if (activeTab === "attendance") loadAttendanceSheet();
    await trySync({ t: "att", date: historySelectedDateStr, student_id: stud.student_id, subject, status, remarks: note });
}

async function saveHistoryDayRemark() {
    const stud = state.students.find(s => s.id === historyStudentId);
    if (!stud || !isValidDateStr(historySelectedDateStr)) return;
    const subject = sanitizeSubjectName(document.getElementById("history-subject-select")?.value || DEFAULT_SUBJECT);
    const note = document.getElementById("history-day-remark")?.value.trim() || "";
    await updateStudentRemark(historySelectedDateStr, stud.student_id, subject, note);
    renderHistoryCalendar();
    showToast("Note saved!", "success");
}

function renderHistoryCalendar() {
    const stud = state.students.find(s => s.id === historyStudentId);
    if (!stud) return;

    const subject = sanitizeSubjectName(document.getElementById("history-subject-select")?.value || DEFAULT_SUBJECT);
    document.getElementById("history-student-name").textContent = stud.name;
    document.getElementById("history-student-info").textContent = `${stud.student_id} • ${stud.section} • ${subject}`;

    const year = historyCurrentDate.getFullYear();
    const month = historyCurrentDate.getMonth();
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    document.getElementById("history-month-label").textContent = `${monthNames[month]} ${year}`;

    const grid = document.getElementById("calendar-grid-body");
    grid.innerHTML = "";

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    for (let i = 0; i < firstDay; i++) {
        const emptyCell = document.createElement("div");
        emptyCell.className = "calendar-day-cell empty";
        grid.appendChild(emptyCell);
    }

    let stats = { Present: 0, Absent: 0, Late: 0, Excused: 0 };

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const key = makeAttKey(dateStr, stud.student_id, subject);
        const status = state.attendance[key];
        const note = state.remarks[key] || "";

        if (status && stats[status] !== undefined) {
            stats[status]++;
        }

        const cell = document.createElement("div");
        cell.className = `calendar-day-cell ${historySelectedDateStr === dateStr ? "selected" : ""}`;
        cell.title = `${dateStr}${status ? `: ${status}` : " (Unmarked)"}${note ? ` — ${note}` : ""}`;
        cell.onclick = () => selectHistoryDay(dateStr);
        cell.innerHTML = `
            <span class="day-number">${day}</span>
            ${note ? `<span class="day-note-dot" title="${esc(note)}"></span>` : ""}
            ${status ? `<span class="day-status-indicator status-cell-${status}">${status.charAt(0)}</span>` : ""}
        `;
        grid.appendChild(cell);
    }

    // Populate inline day editor
    const dateLbl = document.getElementById("history-selected-date-label");
    const btnGroup = document.getElementById("history-day-buttons");
    const remarkRow = document.getElementById("history-remark-row");
    const remarkInput = document.getElementById("history-day-remark");

    if (isValidDateStr(historySelectedDateStr)) {
        const selKey = makeAttKey(historySelectedDateStr, stud.student_id, subject);
        const selStatus = state.attendance[selKey] || "";
        if (dateLbl) dateLbl.textContent = `Edit ${historySelectedDateStr}:`;
        if (btnGroup) {
            btnGroup.innerHTML = ["Present", "Late", "Absent", "Excused"].map(st => `
                <button type="button" onclick="setHistoryDayStatus('${st}')" class="status-btn ${selStatus === st ? `active-${st}` : ""}">${st}</button>
            `).join("") + (selStatus ? `<button type="button" onclick="setHistoryDayStatus('')" class="action-link action-delete">Clear</button>` : "");
        }
        if (remarkRow) remarkRow.classList.remove("hidden");
        if (remarkInput) remarkInput.value = state.remarks[selKey] || "";
    }

    const summary = document.getElementById("history-stats-summary");
    summary.innerHTML = `
        <div class="history-stat-box"><div class="val text-emerald">${stats.Present}</div><div class="lbl">Present</div></div>
        <div class="history-stat-box"><div class="val text-rose">${stats.Absent}</div><div class="lbl">Absent</div></div>
        <div class="history-stat-box"><div class="val text-amber">${stats.Late}</div><div class="lbl">Late</div></div>
        <div class="history-stat-box"><div class="val text-blue">${stats.Excused}</div><div class="lbl">Excused</div></div>
    `;
}

// --- Profile & Data Backup/Restore ---
function openProfileModal() {
    pendingAvatarDataUrl = null;
    const fileLabel = document.getElementById("profile-file-name");
    if (fileLabel) fileLabel.textContent = "Select image file...";
    openModal("modal-profile");
}

function compressAvatarImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read image file."));
        reader.onload = (evt) => {
            const img = new Image();
            img.onerror = () => reject(new Error("Unsupported image format."));
            img.onload = () => {
                const size = 72;
                const canvas = document.createElement("canvas");
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext("2d");
                const minSide = Math.min(img.width, img.height);
                const sx = (img.width - minSide) / 2;
                const sy = (img.height - minSide) / 2;
                ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
                resolve(canvas.toDataURL("image/jpeg", 0.72));
            };
            img.src = evt.target.result;
        };
        reader.readAsDataURL(file);
    });
}

async function previewProfileImage(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.type || !file.type.startsWith("image/")) {
        showToast("Please choose a valid image file (PNG, JPG, GIF, or WebP).", "error");
        e.target.value = "";
        return;
    }

    if (file.size > 10 * 1024 * 1024) {
        showToast("Image is too large (max 10 MB).", "error");
        e.target.value = "";
        return;
    }

    try {
        const compactDataUrl = await compressAvatarImage(file);
        pendingAvatarDataUrl = compactDataUrl;
        document.getElementById("profile-file-name").textContent = file.name;
        document.getElementById("modalPreviewAvatar").innerHTML = `<img src="${esc(compactDataUrl)}" alt="Avatar">`;
    } catch (err) {
        showToast(err.message || "Could not process that image.", "error");
        e.target.value = "";
    }
}

async function handleProfileSubmit(e) {
    e.preventDefault();
    const newName = document.getElementById("profile-display-name").value.trim();
    if (!newName) return;

    if (pendingAvatarDataUrl !== null) {
        currentAvatar = pendingAvatarDataUrl;
    }

    if (!cloudReady()) {
        localStorage.setItem("scholog_local_user", JSON.stringify({
            email: currentUser?.email || "teacher@local.scholog",
            name: newName,
            avatar: currentAvatar
        }));
    }

    setProfileUI(currentUser?.email || "", newName, currentAvatar);
    closeModal("modal-profile");
    showToast("Profile updated!", "success");

    await trySync({ t: "prof", full_name: newName, avatar_url: currentAvatar });
}

function exportDataBackup() {
    const jsonStr = JSON.stringify(state, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Scholog_Backup_${todayStr()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast("Backup downloaded!", "success");
}

function importDataBackup(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";

    const reader = new FileReader();
    reader.onload = async (evt) => {
        try {
            const imported = JSON.parse(evt.target.result);
            if (imported.sections && imported.students && imported.attendance) {
                state = normalizeState(imported);

                if (cloudReady()) {
                    showToast("Restoring backup to your account...", "success");
                    try {
                        await pushFullStateToCloud();
                        showToast("Backup restored and synced to the cloud!", "success");
                    } catch (err) {
                        reportDbError("restoring backup", err);
                    }
                } else {
                    showToast("Data restored successfully!", "success");
                }

                saveLocalStore();
                closeModal("modal-profile");
                switchTab(activeTab);
            } else {
                throw new Error("Invalid format");
            }
        } catch (err) {
            showToast("Invalid backup file.", "error");
        }
    };
    reader.readAsText(file);
}

// --- Toast Notifications ---
function showToast(message, type = "success") {
    const container = document.getElementById("toast-container");
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
