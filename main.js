// Supabase Configuration
const SUPABASE_URL = "https://jwjivkdgzxuaecplkkad.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3aml2a2Rnenh1YWVjcGxra2FkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2NTU0NzcsImV4cCI6MjEwODIzMTQ3N30.VTFzl7FlP0apBo5ngnclq3eA9aDE-o3I560-XHSiDKg";

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
let historyStudentId = null;
let historyCurrentDate = new Date();
let cloudHasData = false;
let flushingOps = false;

let state = {
    sections: [],
    students: [],
    attendance: {}
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

// --- Safety helpers ---

// Escape text that goes into innerHTML (prevents broken rendering and XSS).
function esc(v) {
    return String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// Escape a value used inside an inline onclick='fn(...)' handler.
// JS-escapes quotes/backslashes first, then HTML-escapes for the attribute.
function jsArg(v) {
    return esc(String(v ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/\r?\n/g, "\\n"));
}

// True only for a real Supabase-authenticated user (cloud sync available).
// The local fallback user ("local-user") must never write to the cloud.
function cloudReady() {
    return Boolean(supabaseClient && currentUser && currentUser.id !== "local-user");
}

// Local-timezone date "YYYY-MM-DD".
// NOTE: toISOString() is UTC and shifts the date during PH mornings — never use it for "today".
function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isValidDateStr(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + "T00:00:00Z");
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Attendance keys are `${date}_${student_id}` where the date is always 10 chars.
function parseAttKey(key) {
    return { date: key.slice(0, 10), studentId: key.slice(11) };
}

function reportDbError(action, error) {
    console.error(`Scholog sync error (${action}):`, error);
    showToast(`Sync failed while ${action}. ${error && error.message ? error.message : "Check your connection."}`, "error");
}

// Per-account cache key so two accounts on one browser don't mix data.
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

    const seenCodes = new Set();
    const students = (Array.isArray(raw.students) ? raw.students : [])
        .map((s, idx) => ({
            id: s.id != null ? String(s.id) : `tmp-${idx}-${Date.now()}`,
            student_id: String(s.student_id ?? "").trim(),
            name: String(s.name ?? "").trim(),
            email: String(s.email ?? "").trim(),
            section: String(s.section ?? "").trim()
        }))
        .filter(s => {
            if (!s.student_id || !s.name || seenCodes.has(s.student_id)) return false;
            seenCodes.add(s.student_id);
            return true;
        });

    // Students that reference a section not in the list would be invisible in
    // section tabs — auto-add those sections.
    students.forEach(s => {
        if (s.section && !sections.includes(s.section)) sections.push(s.section);
    });

    const validStatuses = new Set(["Present", "Absent", "Late", "Excused"]);
    const attendance = {};
    const rawAtt = (raw.attendance && typeof raw.attendance === "object" && !Array.isArray(raw.attendance))
        ? raw.attendance
        : {};
    Object.keys(rawAtt).forEach(k => {
        const { date, studentId } = parseAttKey(k);
        if (isValidDateStr(date) && studentId && validStatuses.has(rawAtt[k])) {
            attendance[k] = rawAtt[k];
        }
    });

    return { sections, students, attendance };
}

// --- Initialization ---
document.addEventListener("DOMContentLoaded", async () => {
    try {
        await checkAuth();
        initDateInput();
        refreshIcons();
        switchTab("dashboard");
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
                await flushPendingOps(); // replay changes made while offline
                await migrateLocalDataToCloud();
                saveLocalStore(); // cache cloud data locally so the app still opens offline
                return;
            }
        } catch (err) {
            console.error("Auth check failed:", err);
        }
    }
    fallbackAuth();
}

async function fallbackAuth() {
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
        // Storage full — the app keeps working in memory; cloud sync is unaffected.
        console.error("Could not cache data locally (storage full?):", e);
    }
}

// --- Supabase Data Sync ---

// Unwrap a supabase-js response: throw when the API reported an error.
function must(res) {
    if (res && res.error) throw res.error;
    return res;
}

// Fetch ALL rows for this user in pages, ordered strictly by primary key `id`
// so page boundaries never duplicate or skip rows even past 1,000 records.
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
        state.students = studData.map(s => ({
            id: s.id.toString(),
            student_id: s.student_id,
            name: s.name,
            email: s.email,
            section: s.section
        }));
        state.attendance = {};
        attData.forEach(row => {
            state.attendance[`${row.date}_${row.student_id}`] = row.status;
        });

        // Ensure every student's section appears in state.sections
        state.students.forEach(s => {
            if (s.section && !state.sections.includes(s.section)) {
                state.sections.push(s.section);
            }
        });

        cloudHasData = state.sections.length > 0
            || state.students.length > 0
            || Object.keys(state.attendance).length > 0;
    } catch (err) {
        reportDbError("loading your data", err);
        loadLocalStore(); // offline fallback: show the last cached copy
    }
}

// --- Offline change queue ---
// Every cloud write goes through applyCloudOp. If it fails (e.g. dropped
// connection), the operation is queued and replayed automatically on reconnect
// or next load, so offline work is never silently lost.

function queueOp(op) {
    try {
        const key = pendingKey();
        const q = JSON.parse(localStorage.getItem(key) || "[]");
        let out = q;
        // Keep only the latest attendance status per student+date
        if (op.t === "att") {
            out = q.filter(e => !(e.t === "att" && e.date === op.date && e.student_id === op.student_id));
        }
        out.push(op);
        localStorage.setItem(key, JSON.stringify(out));
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
        case "att": // one attendance status
            must(await supabaseClient.from("attendance").upsert({
                user_id: uid, date: op.date, student_id: op.student_id, status: op.status
            }, { onConflict: "user_id,date,student_id" }));
            break;
        case "attB": { // batch attendance statuses
            for (let i = 0; i < op.rows.length; i += 500) {
                must(await supabaseClient.from("attendance")
                    .upsert(op.rows.slice(i, i + 500).map(r => ({ user_id: uid, ...r })), { onConflict: "user_id,date,student_id" }));
            }
            break;
        }
        case "att-": // remove one student's attendance history
            must(await supabaseClient.from("attendance").delete()
                .eq("user_id", uid).eq("student_id", op.student_id));
            break;
        case "att^": // re-link attendance after a student code rename
            if (op.old_code !== op.student_id) {
                must(await supabaseClient.from("attendance").update({ student_id: op.student_id })
                    .eq("user_id", uid).eq("student_id", op.old_code));
            }
            break;
        case "sec+": // add section (idempotent)
            must(await supabaseClient.from("sections").upsert({
                user_id: uid, name: op.name
            }, { onConflict: "user_id,name" }));
            break;
        case "sec^": // rename section and update associated students
            must(await supabaseClient.from("sections").insert({ user_id: uid, name: op.new_name }));
            must(await supabaseClient.from("students").update({ section: op.new_name }).eq("user_id", uid).eq("section", op.old_name));
            must(await supabaseClient.from("sections").delete().eq("user_id", uid).eq("name", op.old_name));
            break;
        case "sec-": // delete section with its students and attendance
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
        case "stu+": // add/edit student, keyed by student code (idempotent)
            must(await supabaseClient.from("students").upsert({
                user_id: uid, student_id: op.student_id,
                name: op.name, email: op.email || null, section: op.section
            }, { onConflict: "user_id,student_id" }));
            break;
        case "stu^": // rename/edit student keyed by their OLD code
            must(await supabaseClient.from("students").update({
                student_id: op.student_id, name: op.name,
                email: op.email || null, section: op.section
            }).eq("user_id", uid).eq("student_id", op.old_code));
            await applyCloudOp({ t: "att^", old_code: op.old_code, student_id: op.student_id });
            break;
        case "stu-": // delete student + their attendance history
            must(await supabaseClient.from("students").delete()
                .eq("user_id", uid).eq("student_id", op.student_id));
            await applyCloudOp({ t: "att-", student_id: op.student_id });
            break;
        case "prof": { // display name + compressed avatar on the account
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

        try { localStorage.setItem(key, JSON.stringify(failed)); } catch (e) { /* keep going */ }

        if (applied > 0) {
            showToast(`Synced ${applied} change${applied > 1 ? "s" : ""} made while offline.`, "success");
            await loadSupabaseData(); // rebuild state from the cloud (also re-maps ids)
            cloudHasData = true;
        }
        if (failed.length > 0) {
            showToast(`Still waiting to sync ${failed.length} change${failed.length > 1 ? "s" : ""}. Will retry automatically.`, "error");
        }
    } finally {
        flushingOps = false;
    }
}

// One-time upload of pre-login localStorage data so it follows the account everywhere.
async function migrateLocalDataToCloud() {
    if (!cloudReady() || cloudHasData) return;

    const legacy = localStorage.getItem("scholog_app_data");
    if (!legacy) return;

    // If the local data clearly belongs to a different signed-in email, leave it alone.
    const localUserRaw = localStorage.getItem("scholog_local_user");
    if (localUserRaw && currentUser?.email) {
        try {
            const localEmail = JSON.parse(localUserRaw).email;
            if (localEmail && localEmail.toLowerCase() !== currentUser.email.toLowerCase()) return;
        } catch (e) { /* ignore malformed */ }
    }

    try {
        const candidate = normalizeState(JSON.parse(legacy));
        const hasAny = candidate.sections.length > 0
            || candidate.students.length > 0
            || Object.keys(candidate.attendance).length > 0;
        if (!hasAny) return;

        state = candidate;
        await pushFullStateToCloud();
        localStorage.removeItem("scholog_app_data"); // legacy key consumed
        showToast("Your saved data was uploaded — it now follows your account on any device.", "success");
    } catch (err) {
        reportDbError("uploading your existing data", err);
    }
}

// Replace this account's cloud rows with the current state.
// Used for first-login migration and backup restore (intentional replace semantics).
async function pushFullStateToCloud() {
    if (!cloudReady()) throw new Error("Not signed in to the cloud.");
    const uid = currentUser.id;

    // Deletion order respects the data dependencies
    must(await supabaseClient.from("attendance").delete().eq("user_id", uid));
    must(await supabaseClient.from("students").delete().eq("user_id", uid));
    must(await supabaseClient.from("sections").delete().eq("user_id", uid));

    if (state.sections.length > 0) {
        for (let i = 0; i < state.sections.length; i += 500) {
            must(await supabaseClient.from("sections").insert(
                state.sections.slice(i, i + 500).map(name => ({ user_id: uid, name }))
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
                    section: s.section
                }))
            ).select("id, student_id");
            if (error) throw error;
            (data || []).forEach(r => { idByCode[r.student_id] = String(r.id); });
        }

        // Remap local ids to the database-generated ones
        state.students.forEach(s => {
            if (idByCode[s.student_id]) s.id = idByCode[s.student_id];
        });
    }

    const attRows = Object.keys(state.attendance).map(k => {
        const { date, studentId } = parseAttKey(k);
        return { user_id: uid, date, student_id: studentId, status: state.attendance[k] };
    });
    for (let i = 0; i < attRows.length; i += 500) {
        must(await supabaseClient.from("attendance").insert(attRows.slice(i, i + 500)));
    }
}

function setProfileUI(email, name, avatarUrl) {
    const safeName = (name || "User").trim() || "User";
    const initial = safeName.charAt(0).toUpperCase();
    const nameElem = document.getElementById("userNameDisplay");
    const avatarElem = document.getElementById("userAvatar");
    const modalAvatar = document.getElementById("modalPreviewAvatar");
    const nameInput = document.getElementById("profile-display-name");

    if (nameElem) nameElem.textContent = safeName;
    if (nameInput) nameInput.value = safeName;

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

function initDateInput() {
    const dateInput = document.getElementById("att-date");
    if (dateInput) dateInput.value = todayStr();
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
        loadAttendanceSheet();
    }
    refreshIcons();
}

function toggleMobileMenu() {
    const menu = document.getElementById("mobileMenu");
    if (menu) menu.classList.toggle("hidden");
}

async function handleLogout() {
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

// --- Dashboard View ---
function renderDashboard() {
    const today = todayStr();
    document.getElementById("dash-date-label").textContent = `Today (${today})`;

    const totalStudents = state.students.length;
    let presentToday = 0;
    let absentToday = 0;

    state.students.forEach(stud => {
        const key = `${today}_${stud.student_id}`;
        const status = state.attendance[key];
        // Kasama na ang "Late" sa bilang ng mga pumasok (Present)
        if (status === "Present" || status === "Late") presentToday++;
        if (status === "Absent") absentToday++;
    });

    const rate = totalStudents > 0 ? Math.round((presentToday / totalStudents) * 100) : 0;

    document.getElementById("stat-total").textContent = totalStudents;
    document.getElementById("stat-present").textContent = presentToday;
    document.getElementById("stat-absent").textContent = absentToday;
    document.getElementById("stat-rate").textContent = `${rate}%`;

    const container = document.getElementById("section-breakdown-container");
    container.innerHTML = "";

    if (state.sections.length === 0) {
        container.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 13px;">No sections created yet. Open <strong>Class List</strong> to add your first section and students.</div>`;
        return;
    }

    state.sections.forEach(sec => {
        const secStudents = state.students.filter(s => s.section === sec);
        let secPresent = 0;
        secStudents.forEach(s => {
            const status = state.attendance[`${today}_${s.student_id}`];
            // Kasama rin ang "Late" dito sa per-section breakdown
            if (status === "Present" || status === "Late") secPresent++;
        });
        const secRate = secStudents.length > 0 ? Math.round((secPresent / secStudents.length) * 100) : 0;

        const item = document.createElement("div");
        item.className = "breakdown-item";
        item.innerHTML = `
            <div class="breakdown-info">
                <h3>${esc(sec)}</h3>
                <p>${secStudents.length} Students — ${secPresent} Present Today</p>
            </div>
            <div class="breakdown-progress-group">
                <div class="progress-bar-wrapper">
                    <div class="progress-fill" style="width: ${secRate}%"></div>
                </div>
                <span class="stat-value" style="font-size: 16px;">${secRate}%</span>
            </div>
        `;
        container.appendChild(item);
    });
}

// --- Directory View ---
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
    banner.innerHTML = `
        <div>
            <h3>${selectedDirectorySection === "ALL" ? "All Sections" : esc(selectedDirectorySection)}</h3>
            <p>Showing active students in selected view</p>
        </div>
        ${selectedDirectorySection !== "ALL" ? `
            <div style="display: flex; gap: 8px;">
                <button onclick="openEditSectionModal('${jsArg(selectedDirectorySection)}')" class="btn btn-secondary action-edit"><i data-lucide="edit-3"></i> Edit Section</button>
                <button onclick="confirmDeleteSection('${jsArg(selectedDirectorySection)}')" class="btn btn-secondary action-delete"><i data-lucide="trash-2"></i> Delete Section</button>
            </div>` : ""}
    `;

    const filtered = state.students.filter(s => {
        const matchSec = selectedDirectorySection === "ALL" || s.section === selectedDirectorySection;
        const matchSearch = s.name.toLowerCase().includes(searchQuery) || s.student_id.toLowerCase().includes(searchQuery);
        return matchSec && matchSearch;
    });

    if (filtered.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="4" class="text-center" style="padding: 24px; color: var(--text-muted);">No students found.</td></tr>`;
        refreshIcons();
        return;
    }

    filtered.forEach(stud => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>
                <div class="student-cell">
                    <div class="student-avatar">${esc(stud.name.charAt(0))}</div>
                    <div>
                        <strong>${esc(stud.name)}</strong>
                        <div style="font-size: 11px; color: var(--text-muted);">${esc(stud.section)}</div>
                    </div>
                </div>
            </td>
            <td class="font-mono">${esc(stud.student_id)}</td>
            <td>${esc(stud.email || "N/A")}</td>
            <td class="text-right">
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

// --- Attendance View ---
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

function loadAttendanceSheet() {
    const selectedDate = document.getElementById("att-date").value;
    const selectedSec = document.getElementById("att-section").value;
    const tableBody = document.getElementById("att-table-body");

    tableBody.innerHTML = "";

    if (!selectedSec) {
        tableBody.innerHTML = `<tr><td colspan="5" class="text-center" style="padding: 24px; color: var(--text-muted);">No sections yet. Go to <strong>Class List</strong> and click <strong>Add Section</strong> first.</td></tr>`;
        return;
    }

    if (!selectedDate) {
        tableBody.innerHTML = `<tr><td colspan="5" class="text-center" style="padding: 24px; color: var(--text-muted);">Please select a valid date above.</td></tr>`;
        return;
    }

    const secStudents = state.students.filter(s => s.section === selectedSec);

    if (secStudents.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="5" class="text-center" style="padding: 24px; color: var(--text-muted);">No students in this section. Add students from Class List view.</td></tr>`;
        return;
    }

    secStudents.forEach((stud, idx) => {
        const key = `${selectedDate}_${stud.student_id}`;
        const currentStatus = state.attendance[key] || "Present";

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${idx + 1}</td>
            <td><strong>${esc(stud.name)}</strong></td>
            <td class="font-mono">${esc(stud.student_id)}</td>
            <td>${esc(selectedDate)}</td>
            <td class="text-center">
                <div class="status-pill-group">
                    ${["Present", "Absent", "Late", "Excused"].map(st => `
                        <button onclick="setStudentStatus('${jsArg(selectedDate)}', '${jsArg(stud.student_id)}', '${st}')" class="status-btn ${currentStatus === st ? 'active-' + st : ''}">
                            ${st}
                        </button>
                    `).join("")}
                </div>
            </td>
        `;
        tableBody.appendChild(tr);
    });
}

async function setStudentStatus(date, studentId, status) {
    if (!isValidDateStr(date) || !studentId) return;
    const key = `${date}_${studentId}`;
    state.attendance[key] = status;
    loadAttendanceSheet();
    saveLocalStore();
    await trySync({ t: "att", date, student_id: studentId, status });
}

async function markAllAttendance(status) {
    const date = document.getElementById("att-date").value;
    const sec = document.getElementById("att-section").value;
    if (!date || !sec) {
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
        state.attendance[`${date}_${s.student_id}`] = status;
        rows.push({ date, student_id: s.student_id, status });
    });

    saveLocalStore();
    loadAttendanceSheet();

    await trySync({ t: "attB", rows });
    if (cloudReady()) showToast(`Marked all as ${status}`, "success");
    else showToast(`Marked all as ${status} (saved on this device)`, "success");
}

async function saveAttendance() {
    const date = document.getElementById("att-date")?.value;
    const sec = document.getElementById("att-section")?.value;

    if (isValidDateStr(date) && sec) {
        state.students.filter(s => s.section === sec).forEach(s => {
            const k = `${date}_${s.student_id}`;
            if (!state.attendance[k]) {
                state.attendance[k] = "Present";
            }
        });
    }

    saveLocalStore();

    if (!cloudReady()) {
        showToast("Attendance records saved!", "success");
        return;
    }

    try {
        await flushPendingOps();
        const rows = Object.keys(state.attendance).map(k => {
            const { date: d, studentId } = parseAttKey(k);
            return { date: d, student_id: studentId, status: state.attendance[k] };
        });
        if (rows.length > 0) {
            await runWithSessionRetry({ t: "attB", rows });
        }
        showToast("Attendance records saved and synced to the cloud!", "success");
    } catch (err) {
        reportDbError("saving attendance", err);
    }
}

function exportAttendanceToPDF() {
    const jsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDF) {
        showToast("PDF library is unavailable. Please refresh the page.", "error");
        return;
    }

    const date = document.getElementById("att-date").value;
    const sec = document.getElementById("att-section").value;
    if (!sec || !date) {
        showToast("Select a valid date and section before exporting.", "error");
        return;
    }

    const doc = new jsPDF();
    if (typeof doc.autoTable !== "function") {
        showToast("PDF table plugin is unavailable. Please refresh the page.", "error");
        return;
    }

    const secStudents = state.students.filter(s => s.section === sec);

    doc.setFontSize(16);
    doc.text(`Scholog Attendance Report - ${sec}`, 14, 20);
    doc.setFontSize(10);
    doc.text(`Date: ${date}`, 14, 28);

    const rows = secStudents.map((stud, idx) => [
        idx + 1,
        stud.name,
        stud.student_id,
        state.attendance[`${date}_${stud.student_id}`] || "Present"
    ]);

    doc.autoTable({
        startY: 34,
        head: [["#", "Student Name", "Student ID", "Status"]],
        body: rows,
    });

    const safeSec = sec.replace(/[\\/:*?"<>|]+/g, "-").trim() || "Section";
    doc.save(`Attendance_${safeSec}_${date}.pdf`);
    showToast("Exported PDF successfully!", "success");
}

// --- Modals & Actions ---
function openModal(id) { document.getElementById(id)?.classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id)?.classList.add("hidden"); }

function openAddSectionModal() {
    const titleEl = document.querySelector("#modal-section h3");
    if (titleEl) titleEl.textContent = "Add Section";
    const formEl = document.querySelector("#modal-section form");
    if (formEl) formEl.onsubmit = handleSectionSubmit;
    document.getElementById("new-section-name").value = "";
    openModal("modal-section");
}

function openEditSectionModal(oldName) {
    const titleEl = document.querySelector("#modal-section h3");
    if (titleEl) titleEl.textContent = "Edit Section";
    const inputEl = document.getElementById("new-section-name");
    if (inputEl) inputEl.value = oldName;
    
    const formEl = document.querySelector("#modal-section form");
    if (formEl) {
        formEl.onsubmit = async (e) => {
            e.preventDefault();
            const newName = inputEl.value.trim();
            if (!newName) return;

            if (newName === oldName) {
                closeModal("modal-section");
                return;
            }

            if (state.sections.includes(newName)) {
                showToast("That section already exists.", "error");
                return;
            }

            const idx = state.sections.indexOf(oldName);
            if (idx !== -1) state.sections[idx] = newName;

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

            await trySync({ t: "sec^", old_name: oldName, new_name: newName });
        };
    }
    openModal("modal-section");
}

async function handleSectionSubmit(e) {
    e.preventDefault();
    const name = document.getElementById("new-section-name").value.trim();
    if (!name) return;

    if (state.sections.includes(name)) {
        showToast("That section already exists.", "error");
        return;
    }

    state.sections.push(name);
    saveLocalStore();
    closeModal("modal-section");
    document.getElementById("new-section-name").value = "";
    renderDirectory();
    showToast("Section added!", "success");
    await trySync({ t: "sec+", name });
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
        showToast("Student not found — the list may have changed. Please try again.", "error");
        return;
    }
    populateSectionDropdowns();
    document.getElementById("student-modal-title").textContent = "Edit Student";
    document.getElementById("student-edit-id").value = stud.id;
    document.getElementById("stud-name").value = stud.name;
    document.getElementById("stud-id").value = stud.student_id;
    document.getElementById("stud-section").value = stud.section;
    document.getElementById("stud-email").value = stud.email || "";
    openModal("modal-student");
}

async function handleStudentSubmit(e) {
    e.preventDefault();
    const editId = document.getElementById("student-edit-id").value;
    const name = document.getElementById("stud-name").value.trim();
    const studId = document.getElementById("stud-id").value.trim();
    const sec = document.getElementById("stud-section").value;
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
        showToast(`Student code "${studId}" is already used by ${clash.name}.`, "error");
        return;
    }

    if (editId) {
        const idx = state.students.findIndex(s => s.id === editId);
        if (idx === -1) {
            showToast("Student not found — the list may have changed. Please try again.", "error");
            closeModal("modal-student");
            return;
        }
        const oldCode = state.students[idx].student_id;

        state.students[idx] = { id: editId, name, student_id: studId, section: sec, email };

        if (oldCode !== studId) {
            const relinked = {};
            Object.keys(state.attendance).forEach(k => {
                const { date, studentId } = parseAttKey(k);
                relinked[`${date}_${studentId === oldCode ? studId : studentId}`] = state.attendance[k];
            });
            state.attendance = relinked;
            saveLocalStore();
            closeModal("modal-student");
            renderDirectory();
            showToast("Student saved!", "success");
            await trySync({ t: "stu^", old_code: oldCode, student_id: studId, name, email, section: sec });
        } else {
            saveLocalStore();
            closeModal("modal-student");
            renderDirectory();
            showToast("Student saved!", "success");
            await trySync({ t: "stu+", student_id: studId, name, email, section: sec });
        }
    } else {
        const newStud = { id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, student_id: studId, section: sec, email };
        state.students.push(newStud);
        saveLocalStore();
        closeModal("modal-student");
        renderDirectory();
        showToast("Student saved!", "success");
        await trySync({ t: "stu+", student_id: studId, name, email, section: sec });
    }
}

function openTransferModal(id) {
    const stud = state.students.find(s => s.id === id);
    if (!stud) return;
    if (state.sections.length === 0) {
        showToast("Add a section first before moving students.", "error");
        return;
    }
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
    if (!newSec) {
        showToast("Please choose a target section.", "error");
        return;
    }

    const stud = state.students.find(s => s.id === id);
    if (!stud) {
        showToast("Student not found — the list may have changed.", "error");
        closeModal("modal-transfer-student");
        return;
    }

    stud.section = newSec;
    saveLocalStore();
    closeModal("modal-transfer-student");
    renderDirectory();
    showToast("Student moved!", "success");
    await trySync({ t: "stu+", student_id: stud.student_id, name: stud.name, email: stud.email, section: newSec });
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
        state.sections = state.sections.filter(s => s !== sec);
        selectedDirectorySection = "ALL";

        saveLocalStore();
        closeModal("modal-delete-section");
        renderDirectory();
        showToast("Section and its records deleted", "success");
        await trySync({ t: "sec-", name: sec, codes });
    };
    openModal("modal-delete-section");
}

// --- Student Attendance Calendar History ---
function openAttendanceHistory(studentId) {
    const now = new Date();
    historyStudentId = studentId;
    historyCurrentDate = new Date(now.getFullYear(), now.getMonth(), 1);
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

function renderHistoryCalendar() {
    const stud = state.students.find(s => s.id === historyStudentId);
    if (!stud) return;

    document.getElementById("history-student-name").textContent = stud.name;
    document.getElementById("history-student-info").textContent = `${stud.student_id} • ${stud.section}`;

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
        const status = state.attendance[`${dateStr}_${stud.student_id}`];

        if (status && stats[status] !== undefined) {
            stats[status]++;
        }

        const cell = document.createElement("div");
        cell.className = "calendar-day-cell";
        cell.innerHTML = `
            <span class="day-number">${day}</span>
            ${status ? `<span class="day-status-indicator status-cell-${status}">${status.charAt(0)}</span>` : ""}
        `;
        grid.appendChild(cell);
    }

    const summary = document.getElementById("history-stats-summary");
    summary.innerHTML = `
        <div class="history-stat-box"><div class="val text-emerald">${stats.Present}</div><div class="lbl">Present</div></div>
        <div class="history-stat-box"><div class="val text-rose">${stats.Absent}</div><div class="lbl">Absent</div></div>
        <div class="history-stat-box"><div class="val" style="color:var(--amber-text)">${stats.Late}</div><div class="lbl">Late</div></div>
        <div class="history-stat-box"><div class="val" style="color:var(--blue-text)">${stats.Excused}</div><div class="lbl">Excused</div></div>
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
            email: currentUser?.email || "user@scholog.com",
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
    }, 3000);
}