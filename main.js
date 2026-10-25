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
let mainDeferredPrompt = null;
// Bumped whenever attendance is changed locally. Background cloud refreshes
// compare it so a slow refresh can never overwrite a fresh mark/save.
let localMutationSeq = 0;

window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    mainDeferredPrompt = e;
    const isStandalone = Boolean(
        (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
        window.navigator.standalone === true
    );
    if (!isStandalone) {
        document.getElementById("navInstallAppBtn")?.classList.remove("hidden");
        document.getElementById("mobInstallAppBtn")?.classList.remove("hidden");
    }
});

async function triggerMainPwaInstall() {
    if (mainDeferredPrompt) {
        mainDeferredPrompt.prompt();
        const { outcome } = await mainDeferredPrompt.userChoice;
        if (outcome === "accepted") {
            showToast("Scholog app installed!", "success");
            document.getElementById("navInstallAppBtn")?.classList.add("hidden");
            document.getElementById("mobInstallAppBtn")?.classList.add("hidden");
        }
        mainDeferredPrompt = null;
    } else {
        showToast("Tap your browser menu and choose 'Install app' or 'Add to Home screen'.", "success");
    }
}

let state = {
    sections: [],
    students: [],
    attendance: {},
    scores: {},
    gradeCategories: [],
    sectionGradeCategories: {}
};

const SCORE_KEY_SEPARATOR = "|";

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

function parseScoreKey(key) {
    // Key format: YYYY-MM-DD_STUDENTID_PERIOD[\u001fCATEGORY[\u001fITEM]]
    // Date is always 10 chars (YYYY-MM-DD), then "_", then studentId, then "_", then subject.
    // Split on the LAST underscore before SCORE_KEY_SEPARATOR so student IDs,
    // category keys, and item IDs containing "_" all survive cleanly.
    if (key.length < 12) return { date: "", studentId: "", subject: "" };
    const date = key.slice(0, 10);
    if (key.charAt(10) !== "_") return { date: "", studentId: "", subject: "" };
    const rest = key.slice(11);
    const sepIdx = rest.indexOf(SCORE_KEY_SEPARATOR);
    const head = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
    const lastUnderscore = head.lastIndexOf("_");
    if (lastUnderscore === -1) return { date, studentId: head, subject: "" };
    return {
        date,
        studentId: head.slice(0, lastUnderscore),
        subject: rest.slice(lastUnderscore + 1)
    };
}

function parseLegacyScoreSubject(subject) {
    const value = String(subject || "General");
    const separatorIndex = value.indexOf(SCORE_KEY_SEPARATOR);
    if (separatorIndex === -1) return { period: value || "General", category: "General" };
    const afterFirst = value.slice(separatorIndex + 1);
    const secondSep = afterFirst.indexOf(SCORE_KEY_SEPARATOR);
    const categoryPart = secondSep === -1 ? afterFirst : afterFirst.slice(0, secondSep);
    return {
        period: value.slice(0, separatorIndex) || "General",
        category: categoryPart || "General"
    };
}

function makeScoreRecordKey(date, studentId, gradingPeriod, categoryId, categoryName, itemId = "") {
    const categoryKey = categoryId || `legacy-${categoryName || "General"}`;
    const itemPart = itemId ? `${SCORE_KEY_SEPARATOR}${itemId}` : "";
    return `${date}_${studentId}_${gradingPeriod || "General"}${SCORE_KEY_SEPARATOR}${categoryKey}${itemPart}`;
}

function newCategoryId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, char => {
        const random = Math.floor(Math.random() * 16);
        const value = char === "x" ? random : (random & 0x3) | 0x8;
        return value.toString(16);
    });
}

function sanitizeCategoryItems(rawItems, fallbackCount = 1, cloneIds = false) {
    const clean = [];
    const seenIds = new Set();
    if (Array.isArray(rawItems) && rawItems.length > 0) {
        rawItems.slice(0, 30).forEach((rawItem, idx) => {
            let id = cloneIds ? newCategoryId() : String(rawItem?.id || "").trim();
            if (!id || seenIds.has(id)) id = newCategoryId();
            seenIds.add(id);
            const label = String(rawItem?.label || "").trim().slice(0, 40) || `#${idx + 1}`;
            const maxNum = Number(rawItem?.max_score);
            const maxScore = Number.isFinite(maxNum) && maxNum > 0 ? maxNum : 100;
            const periodMax = {};
            if (rawItem?.period_max && typeof rawItem.period_max === "object" && !Array.isArray(rawItem.period_max)) {
                Object.keys(rawItem.period_max).forEach(period => {
                    const val = Number(rawItem.period_max[period]);
                    if (Number.isFinite(val) && val > 0) periodMax[period] = val;
                });
            }
            clean.push({ id, label, max_score: maxScore, period_max: periodMax });
        });
    }
    if (clean.length === 0) {
        const count = Math.max(1, Math.min(30, Math.round(Number(fallbackCount) || 1)));
        for (let i = 0; i < count; i++) {
            clean.push({ id: newCategoryId(), label: `#${i + 1}`, max_score: 100, period_max: {} });
        }
    }
    return clean;
}

function categoryItemsForCloud(items) {
    return sanitizeCategoryItems(items).map(item => {
        const out = { id: item.id, label: item.label, max_score: item.max_score };
        if (item.period_max && Object.keys(item.period_max).length > 0) {
            out.period_max = item.period_max;
        }
        return out;
    });
}

function sanitizeGradeCategories(value, legacySectionMap = null, fallbackSection = "") {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const clean = [];
    value.forEach(category => {
        if (category?.archived === true) return;
        const rawId = String(category?.id || "").trim();
        const name = String(category?.name || "").trim();
        const weight = Number(category?.weight);
        if (!rawId || !name || name.length > 60) return;
        if (!Number.isFinite(weight) || weight < 0 || weight > 100) return;

        const explicitSection = String(category?.section || "").trim();
        let targetSections = [];
        if (explicitSection) {
            targetSections = [explicitSection];
        } else if (legacySectionMap && typeof legacySectionMap === "object" && !Array.isArray(legacySectionMap)) {
            targetSections = Object.keys(legacySectionMap).filter(
                sec => Array.isArray(legacySectionMap[sec]) && legacySectionMap[sec].map(String).includes(rawId)
            );
            if (targetSections.length === 0 && Object.keys(legacySectionMap).length === 0 && fallbackSection) {
                targetSections = [fallbackSection];
            }
        } else if (fallbackSection) {
            targetSections = [fallbackSection];
        }

        targetSections.forEach((sec, index) => {
            const section = String(sec || "").trim();
            if (!section) return;
            const id = index === 0 ? rawId : newCategoryId();
            const key = `${section.toLowerCase()}\n${name.toLowerCase()}`;
            if (seen.has(key)) return;
            seen.add(key);
            const items = sanitizeCategoryItems(category?.items, category?.itemCount || 1, index > 0);
            clean.push({ id, section, name, weight, items, _sourceId: index > 0 ? rawId : null });
        });
    });
    return clean;
}

function sanitizeSectionGradeCategories(_value, categories = []) {
    const output = {};
    categories.forEach(category => {
        if (!category?.section || !category?.id) return;
        if (!output[category.section]) output[category.section] = [];
        if (!output[category.section].includes(category.id)) {
            output[category.section].push(category.id);
        }
    });
    return output;
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

    const rawCategories = sanitizeGradeCategories(raw.gradeCategories, raw.sectionGradeCategories, sections[0] || "");
    const clonedIdBySourceAndSection = new Map();
    const gradeCategories = rawCategories.map(cat => {
        if (cat._sourceId) {
            clonedIdBySourceAndSection.set(`${cat._sourceId}::${cat.section}`, cat.id);
        }
        return { id: cat.id, section: cat.section, name: cat.name, weight: cat.weight, items: cat.items };
    });
    gradeCategories.forEach(cat => {
        if (cat.section && !sections.includes(cat.section)) sections.push(cat.section);
    });
    const studentSectionByCode = new Map(students.map(s => [s.student_id, s.section]));

    const scores = {};
    const rawSc = (raw.scores && typeof raw.scores === "object" && !Array.isArray(raw.scores))
        ? raw.scores
        : {};
    Object.keys(rawSc).forEach(k => {
        const parsed = parseScoreKey(k);
        const value = rawSc[k] || {};
        if (!isValidDateStr(parsed.date) || !parsed.studentId || !parsed.subject) return;
        const legacy = parseLegacyScoreSubject(value.subject || parsed.subject);
        const gradingPeriod = value.grading_period || legacy.period;
        const categoryName = value.category_name || legacy.category;
        const studentId = value.student_id || parsed.studentId;
        const studSection = studentSectionByCode.get(studentId) || "";
        const remappedId = (value.category_id && studSection && clonedIdBySourceAndSection.get(`${value.category_id}::${studSection}`))
            || value.category_id
            || null;
        const matchedCat = gradeCategories.find(c => c.id === remappedId)
            || gradeCategories.find(c => (!studSection || c.section === studSection) && c.name === categoryName);
        const matchedItem = matchedCat
            ? (matchedCat.items.find(i => i.id === value.item_id)
                || ((!value.item_id || value.item_id === "item-1") ? matchedCat.items[0] : null))
            : null;
        const itemId = matchedItem?.id || value.item_id || "";
        const itemLabel = matchedItem?.label || value.item_label || "#1";
        // A score identified only by category name (legacy rows, or a category
        // renamed after the score was saved) must still be linked to the real
        // category, otherwise it cannot be written back to the cloud.
        const categoryId = matchedCat?.id || remappedId || null;
        const normalizedKey = makeScoreRecordKey(parsed.date, studentId, gradingPeriod, categoryId, categoryName, itemId);
        scores[normalizedKey] = {
            ...value,
            date: parsed.date,
            student_id: studentId,
            subject: value.subject || gradingPeriod,
            grading_period: gradingPeriod,
            category_id: categoryId,
            category_name: categoryName,
            category_weight: Number(value.category_weight ?? 100),
            item_id: itemId || null,
            item_label: itemLabel
        };
    });

    const sectionGradeCategories = sanitizeSectionGradeCategories(raw.sectionGradeCategories, gradeCategories);
    return { sections, students, attendance, scores, gradeCategories, sectionGradeCategories };
}

// --- Initialization ---
document.addEventListener("DOMContentLoaded", async () => {
    try {
        await checkAuth();
        initDateInput();
        refreshIcons();
        const hashTab = window.location.hash.replace(/^#/, "");
        const startTab = ["dashboard", "directory", "attendance", "scores"].includes(hashTab) ? hashTab : "dashboard";
        switchTab(startTab);
        startCloudRefreshLoop();
    } catch (err) {
        console.error("Scholog failed to start:", err);
        showToast("Scholog failed to load. Check your connection and refresh the page.", "error");
    }
});

// Keeps the dashboard / attendance sheet in step with QR check-ins that
// students save from the separate scan.html page.
function startCloudRefreshLoop() {
    if (window.__schologRefreshLoop) return;
    window.__schologRefreshLoop = true;

    setInterval(() => {
        if (document.visibilityState !== "visible") return;
        if (activeTab !== "attendance" && activeTab !== "dashboard") return;
        if (Date.now() - lastCloudSyncAt < 20000) return;
        syncLatestFromCloud().catch(() => {});
    }, 30000);

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        if (activeTab !== "attendance" && activeTab !== "dashboard") return;
        syncLatestFromCloud().catch(() => {});
    });
}

async function checkAuth() {
    if (supabaseClient) {
        try {
            const { data: { session } } = await supabaseClient.auth.getSession();
            if (session) {
                currentUser = session.user;
                const displayName = session.user.user_metadata?.full_name || session.user.email.split("@")[0];
                currentAvatar = session.user.user_metadata?.avatar_url || "";
                setProfileUI(session.user.email, displayName, currentAvatar);
                const pendingBefore = readPendingOps();
                if (pendingBefore.length > 0) {
                    const hadLocalCache = Boolean(localStorage.getItem(cacheKey()));
                    loadLocalStore();
                    applyPendingOpsToLocalState(pendingBefore);
                    await flushPendingOps();
                    const pendingAfter = readPendingOps();
                    if (pendingAfter.length === 0) {
                        if (!cloudHasData && state.sections.length === 0 && state.students.length === 0 && Object.keys(state.scores).length === 0) {
                            await loadSupabaseData();
                        }
                    } else {
                        if (!hadLocalCache) await loadSupabaseData();
                        applyPendingOpsToLocalState(pendingAfter);
                    }
                } else {
                    await loadSupabaseData();
                }
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

// Read the account's cloud data into a plain snapshot (no side effects).
async function fetchCloudState() {
    const [secData, studData, attData] = await Promise.all([
        fetchAll("sections", currentUser.id),
        fetchAll("students", currentUser.id),
        fetchAll("attendance", currentUser.id)
    ]);

    // Newer grading tables are optional while an older deployment is being migrated.
    const [scRes, catRes, secCatRes] = await Promise.allSettled([
        fetchAll("scores", currentUser.id),
        fetchAll("grading_categories", currentUser.id),
        fetchAll("section_grading_categories", currentUser.id)
    ]);
    const scData = scRes.status === "fulfilled" ? scRes.value : [];
    const categoryData = catRes.status === "fulfilled" ? catRes.value : [];
    const sectionCategoryData = secCatRes.status === "fulfilled" ? secCatRes.value : [];

    const sections = secData.map(s => s.name);
    const students = studData.map(s => ({
        id: s.id.toString(),
        student_id: s.student_id,
        name: s.name,
        email: s.email,
        section: s.section
    }));

    const attendance = {};
    attData.forEach(row => {
        attendance[`${row.date}_${row.student_id}`] = row.status;
    });

    const legacySectionMap = sectionCategoryData.reduce((map, row) => {
        if (!row?.section || !row?.category_id) return map;
        if (!map[row.section]) map[row.section] = [];
        map[row.section].push(row.category_id);
        return map;
    }, {});
    const rawCategories = sanitizeGradeCategories(categoryData, legacySectionMap, sections[0] || "");
    const clonedIdBySourceAndSection = new Map();
    const gradeCategories = rawCategories.map(cat => {
        if (cat._sourceId) {
            clonedIdBySourceAndSection.set(`${cat._sourceId}::${cat.section}`, cat.id);
        }
        return { id: cat.id, section: cat.section, name: cat.name, weight: cat.weight, items: cat.items };
    });
    const sectionGradeCategories = sanitizeSectionGradeCategories(legacySectionMap, gradeCategories);
    const studentSectionByCode = new Map(students.map(s => [s.student_id, s.section]));

    const scores = {};
    scData.forEach(row => {
        const legacy = parseLegacyScoreSubject(row.subject);
        const gradingPeriod = row.grading_period || legacy.period;
        const categoryName = row.category_name || legacy.category;
        const studSection = studentSectionByCode.get(row.student_id) || "";
        const remappedId = (row.category_id && studSection && clonedIdBySourceAndSection.get(`${row.category_id}::${studSection}`))
            || row.category_id
            || null;
        const category = gradeCategories.find(item => item.id === remappedId)
            || gradeCategories.find(item => (!studSection || item.section === studSection) && item.name === categoryName);
        const categoryId = remappedId || category?.id || null;
        const categoryWeight = Number(row.category_weight ?? category?.weight ?? 100);
        const matchedItem = category
            ? (category.items.find(i => i.id === row.item_id)
                || ((!row.item_id || row.item_id === "item-1") ? category.items[0] : null))
            : null;
        const itemId = matchedItem?.id || row.item_id || "";
        const itemLabel = matchedItem?.label || row.item_label || "#1";
        const key = makeScoreRecordKey(row.date, row.student_id, gradingPeriod, categoryId, categoryName, itemId);
        scores[key] = {
            score: row.score,
            max_score: row.max_score,
            date: row.date,
            student_id: row.student_id,
            subject: row.subject || gradingPeriod,
            grading_period: gradingPeriod,
            category_id: categoryId,
            category_name: categoryName,
            category_weight: categoryWeight,
            item_id: itemId || null,
            item_label: itemLabel
        };
    });

    students.forEach(s => {
        if (s.section && !sections.includes(s.section)) sections.push(s.section);
    });
    gradeCategories.forEach(cat => {
        if (cat.section && !sections.includes(cat.section)) sections.push(cat.section);
    });

    return { sections, students, attendance, scores, gradeCategories, sectionGradeCategories };
}

function applyCloudState(snapshot) {
    state = snapshot;
    cloudHasData = state.sections.length > 0
        || state.students.length > 0
        || Object.keys(state.attendance).length > 0;
}

async function loadSupabaseData() {
    if (!cloudReady()) return;

    try {
        applyCloudState(await fetchCloudState());
    } catch (err) {
        reportDbError("loading your data", err);
        loadLocalStore(); // offline fallback: show the last cached copy
    }
}

// --- Offline change queue ---
// Every cloud write goes through applyCloudOp. If it fails (e.g. dropped
// connection), the operation is queued and replayed automatically on reconnect
// or next load, so offline work is never silently lost.

function readPendingOps() {
    try {
        const parsed = JSON.parse(localStorage.getItem(pendingKey()) || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function applyScoreOpToLocalState(row) {
    if (!row || !isValidDateStr(row.date) || !row.student_id) return;
    const legacy = parseLegacyScoreSubject(row.subject);
    const gradingPeriod = row.grading_period || legacy.period;
    const categoryName = row.category_name || legacy.category;
    const categoryId = row.category_id || null;
    const categoryWeight = Number(row.category_weight ?? 100);
    const studSection = String(
        row.section
        || state.students.find(s => s.student_id === row.student_id)?.section
        || state.sections[0]
        || ""
    ).trim();
    let category = categoryId ? state.gradeCategories.find(item => item.id === categoryId) : null;
    if (!category && categoryId && categoryName && studSection) {
        const sameName = state.gradeCategories.find(
            item => item.section === studSection && item.name.toLowerCase() === String(categoryName).toLowerCase()
        );
        if (!sameName) {
            category = {
                id: String(categoryId),
                section: studSection,
                name: String(categoryName).trim(),
                weight: Number.isFinite(categoryWeight) ? Math.min(Math.max(categoryWeight, 0), 100) : 0,
                items: sanitizeCategoryItems(row.item_id ? [{ id: row.item_id, label: row.item_label || "#1", max_score: row.max_score || 100 }] : null)
            };
            state.gradeCategories.push(category);
            state.sectionGradeCategories = sanitizeSectionGradeCategories(null, state.gradeCategories);
        } else {
            category = sameName;
        }
    }
    if (category && row.item_id && row.item_id !== "item-1" && !category.items.some(i => i.id === row.item_id)) {
        category.items.push({
            id: String(row.item_id),
            label: String(row.item_label || `#${category.items.length + 1}`).trim(),
            max_score: Number(row.max_score) > 0 ? Number(row.max_score) : 100,
            period_max: {}
        });
    }
    const itemId = row.item_id || category?.items?.[0]?.id || "";
    const itemLabel = row.item_label || category?.items?.find(i => i.id === itemId)?.label || "#1";
    const key = makeScoreRecordKey(row.date, row.student_id, gradingPeriod, categoryId, categoryName, itemId);
    state.scores[key] = {
        score: Number(row.score),
        max_score: Number(row.max_score ?? 100),
        date: row.date,
        student_id: row.student_id,
        subject: gradingPeriod,
        grading_period: gradingPeriod,
        category_id: categoryId,
        category_name: categoryName,
        category_weight: Number.isFinite(categoryWeight) ? categoryWeight : 100,
        item_id: itemId || null,
        item_label: itemLabel
    };
}

// Re-apply queued offline operations onto in-memory state so unsynced changes
// remain visible and cached even if a page reload happens before sync finishes.
function applyPendingOpsToLocalState(ops) {
    if (!Array.isArray(ops) || ops.length === 0) return;
    for (const op of ops) {
        if (!op || typeof op !== "object") continue;
        switch (op.t) {
            case "att":
                if (isValidDateStr(op.date) && op.student_id && op.status) {
                    state.attendance[`${op.date}_${op.student_id}`] = op.status;
                }
                break;
            case "attB":
                (op.rows || []).forEach(r => {
                    if (r && isValidDateStr(r.date) && r.student_id && r.status) {
                        state.attendance[`${r.date}_${r.student_id}`] = r.status;
                    }
                });
                break;
            case "gradingConfig":
                if (Array.isArray(op.categories) && op.section) {
                    const sectionCategories = sanitizeGradeCategories(op.categories, null, op.section)
                        .map(cat => ({ id: cat.id, section: op.section, name: cat.name, weight: cat.weight, items: cat.items }));
                    state.gradeCategories = [
                        ...state.gradeCategories.filter(cat => cat.section !== op.section),
                        ...sectionCategories
                    ];
                    state.sectionGradeCategories = sanitizeSectionGradeCategories(null, state.gradeCategories);
                    refreshScoreCategoryMetadata(state.gradeCategories);
                }
                break;
            case "scr":
                applyScoreOpToLocalState(op);
                break;
            case "scrB":
                (op.rows || []).forEach(r => applyScoreOpToLocalState(r));
                break;
            case "scr-": {
                if (op.date && op.student_id) {
                    const key = makeScoreRecordKey(op.date, op.student_id, op.grading_period || "General", op.category_id, op.category_name, op.item_id || "");
                    delete state.scores[key];
                    Object.keys(state.scores).forEach(k => {
                        const v = state.scores[k];
                        if (
                            v &&
                            (v.student_id || parseScoreKey(k).studentId) === op.student_id &&
                            (v.grading_period || "General") === (op.grading_period || "General") &&
                            v.category_id === op.category_id &&
                            (v.item_id || "") === (op.item_id || "")
                        ) {
                            delete state.scores[k];
                        }
                    });
                }
                break;
            }
            case "sec+":
                if (op.name && !state.sections.includes(op.name)) state.sections.push(op.name);
                break;
            case "sec^":
                if (op.old_name && op.new_name) {
                    const idx = state.sections.indexOf(op.old_name);
                    if (idx !== -1) state.sections[idx] = op.new_name;
                    state.students.forEach(s => { if (s.section === op.old_name) s.section = op.new_name; });
                    state.gradeCategories.forEach(c => { if (c.section === op.old_name) c.section = op.new_name; });
                    state.sectionGradeCategories = sanitizeSectionGradeCategories(null, state.gradeCategories);
                }
                break;
            case "sec-":
                if (op.name) {
                    state.sections = state.sections.filter(s => s !== op.name);
                    state.students = state.students.filter(s => s.section !== op.name);
                    state.gradeCategories = state.gradeCategories.filter(c => c.section !== op.name);
                    state.sectionGradeCategories = sanitizeSectionGradeCategories(null, state.gradeCategories);
                }
                break;
            case "stu+":
                if (op.student_id && op.name) {
                    const existing = state.students.find(s => s.student_id === op.student_id);
                    if (existing) {
                        existing.name = op.name;
                        existing.email = op.email || "";
                        existing.section = op.section || existing.section;
                    } else {
                        state.students.push({
                            id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                            student_id: op.student_id,
                            name: op.name,
                            email: op.email || "",
                            section: op.section || ""
                        });
                    }
                    if (op.section && !state.sections.includes(op.section)) state.sections.push(op.section);
                }
                break;
            case "stuB+":
                (op.rows || []).forEach(r => {
                    if (!r || !r.student_id || !r.name) return;
                    const existing = state.students.find(s => s.student_id === r.student_id);
                    if (existing) {
                        existing.name = r.name;
                        existing.email = r.email || "";
                        existing.section = r.section || existing.section;
                    } else {
                        state.students.push({
                            id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                            student_id: r.student_id,
                            name: r.name,
                            email: r.email || "",
                            section: r.section || ""
                        });
                    }
                    if (r.section && !state.sections.includes(r.section)) state.sections.push(r.section);
                });
                break;
            case "stu^":
                if (op.old_code && op.student_id) {
                    const existing = state.students.find(s => s.student_id === op.old_code || s.student_id === op.student_id);
                    if (existing) {
                        existing.student_id = op.student_id;
                        if (op.name) existing.name = op.name;
                        if (op.email !== undefined) existing.email = op.email || "";
                        if (op.section) existing.section = op.section;
                    }
                    relinkStudentRecordsLocally(op.old_code, op.student_id);
                }
                break;
            case "stu-":
                if (op.student_id) {
                    state.students = state.students.filter(s => s.student_id !== op.student_id);
                    removeStudentRecordsLocally(op.student_id);
                }
                break;
            default:
                break;
        }
    }
}

function queueOp(op) {
    try {
        const key = pendingKey();
        const q = readPendingOps();
        let out = q;
        // Keep only the latest attendance status per student+date
        if (op.t === "att") {
            out = q.filter(e => !(e.t === "att" && e.date === op.date && e.student_id === op.student_id));
        } else if (op.t === "scr" || op.t === "scr-") {
            out = q.filter(e => !(
                (e.t === "scr" || e.t === "scr-")
                && e.date === op.date
                && e.student_id === op.student_id
                && e.grading_period === op.grading_period
                && e.category_id === op.category_id
                && (e.item_id || "") === (op.item_id || "")
            ));
        } else if (op.t === "gradingConfig") {
            out = q.filter(e => !(e.t === "gradingConfig" && e.section === op.section));
        }
        if (!op._qid) {
            op._qid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    if (!cloudReady()) return false;
    let allApplied = true;
    for (const op of ops) {
        try {
            await runWithSessionRetry(op);
        } catch (err) {
            allApplied = false;
            console.error("Sync failed, change queued for retry:", op, err);
            queueOp(op);
            showToast("Saved on this device — will sync automatically when you're back online.", "error");
        }
    }
    return allApplied;
}

function resolveSectionForScoreRow(row) {
    if (row?.section) return String(row.section).trim();
    const stud = state.students.find(s => s.student_id === row?.student_id);
    if (stud?.section) return stud.section;
    const cat = state.gradeCategories.find(c => c.id === row?.category_id);
    if (cat?.section) return cat.section;
    return state.sections[0] || "General";
}

// Find the grading category a score belongs to, creating a harmless weight-0
// category if the setup that produced it is gone. Losing the score would be
// worse than showing an extra column the teacher can rename or delete.
function resolveCategoryForScore(row) {
    if (!row) return null;
    const section = resolveSectionForScoreRow(row);
    const legacy = parseLegacyScoreSubject(row.subject);
    const name = String(row.category_name || legacy.category || "General").trim() || "General";

    if (row.category_id) {
        const byId = state.gradeCategories.find(item => item.id === row.category_id);
        if (byId) return byId;
    }

    const byName = state.gradeCategories.find(
        item => item.section === section && item.name.toLowerCase() === name.toLowerCase()
    );
    if (byName) {
        row.category_id = byName.id;
        row.category_name = byName.name;
        row.category_weight = byName.weight;
        return byName;
    }

    const carriedItem = row.item_id
        ? [{ id: row.item_id, label: row.item_label || "#1", max_score: Number(row.max_score) > 0 ? Number(row.max_score) : 100 }]
        : null;
    const created = {
        id: row.category_id || newCategoryId(),
        section,
        name: name.slice(0, 60),
        weight: 0,
        items: sanitizeCategoryItems(carriedItem, 1)
    };
    state.gradeCategories.push(created);
    state.sectionGradeCategories = sanitizeSectionGradeCategories(null, state.gradeCategories);
    row.category_id = created.id;
    row.category_name = created.name;
    row.category_weight = 0;
    if (!row.item_id) {
        row.item_id = created.items[0].id;
        row.item_label = created.items[0].label;
    }
    return created;
}

function scoreRowForCloud(row, uid) {
    const legacy = parseLegacyScoreSubject(row.subject);
    const gradingPeriod = row.grading_period || legacy.period;
    const categoryName = row.category_name || legacy.category;
    const studSection = resolveSectionForScoreRow(row);
    const category = state.gradeCategories.find(item => item.id === row.category_id)
        || state.gradeCategories.find(item => item.section === studSection && item.name === categoryName)
        || resolveCategoryForScore(row);
    const categoryId = category?.id || row.category_id || null;
    if (!categoryId) return null;
    const matchedItem = category?.items
        ? (category.items.find(i => i.id === row.item_id)
            || ((!row.item_id || row.item_id === "item-1") ? category.items[0] : null))
        : null;
    const itemId = matchedItem?.id || row.item_id || "item-1";
    const itemLabel = matchedItem?.label || row.item_label || "#1";
    return {
        user_id: uid,
        date: row.date,
        student_id: row.student_id,
        subject: gradingPeriod,
        grading_period: gradingPeriod,
        category_id: categoryId,
        category_name: category?.name || categoryName,
        category_weight: category?.weight ?? row.category_weight ?? 100,
        item_id: itemId,
        item_label: itemLabel,
        score: Number(row.score),
        max_score: Number(row.max_score ?? 100)
    };
}

function isMissingCategoryFkError(error) {
    const code = String(error?.code || "");
    const msg = `${error?.message || ""} ${error?.details || ""}`;
    return code === "23503" || /scores_category_id_fkey|grading_categories/i.test(msg);
}

// Reconcile a client-created category UUID with an existing active cloud
// category of the same name within the same section so unique(user_id, section, name)
// never blocks offline replay and historical scores re-link cleanly.
async function reconcileCategoryByNameInCloud(uid, section, existingSectionCategories, category, timestamp, activeIds = null) {
    const targetNameKey = String(category.name || "").trim().toLowerCase();
    const migratingPrefix = `__migrating_${category.id}_`;
    const clashIndex = existingSectionCategories.findIndex(
        row => row.id !== category.id && !row.archived && (
            String(row.name || "").trim().toLowerCase() === targetNameKey
            || String(row.name || "").startsWith(migratingPrefix)
        )
    );
    if (clashIndex === -1) return;

    const clash = existingSectionCategories[clashIndex];
    if (activeIds && activeIds.has(clash.id)) {
        const parkedName = `__swap_${clash.id}`;
        must(await supabaseClient.from("grading_categories")
            .update({ name: parkedName, updated_at: timestamp })
            .eq("user_id", uid)
            .eq("id", clash.id));
        clash.name = parkedName;
        return;
    }

    const targetExists = existingSectionCategories.some(row => row.id === category.id);
    const cloudItems = categoryItemsForCloud(category.items);
    const primaryTargetItem = cloudItems[0];

    must(await supabaseClient.from("grading_categories")
        .update({ name: `${migratingPrefix}${clash.id}`, updated_at: timestamp })
        .eq("user_id", uid)
        .eq("id", clash.id));

    must(await supabaseClient.from("grading_categories").upsert({
        id: category.id,
        user_id: uid,
        section,
        name: category.name,
        weight: category.weight,
        items: cloudItems,
        archived: false,
        updated_at: timestamp
    }, { onConflict: "id" }));

    const { data: clashScores, error: clashErr } = await supabaseClient
        .from("scores")
        .select("id, date, student_id, grading_period, item_id")
        .eq("user_id", uid)
        .eq("category_id", clash.id);
    if (clashErr) throw clashErr;

    const seenClashPeriodKeys = new Set();
    let clashHasMultiItemsOnSameDay = false;
    (clashScores || []).forEach(r => {
        const k = `${r.date}|${r.student_id}|${r.grading_period}`;
        if (seenClashPeriodKeys.has(k)) clashHasMultiItemsOnSameDay = true;
        seenClashPeriodKeys.add(k);
    });
    const canRemapToPrimaryItem = (!Array.isArray(clash.items) || clash.items.length <= 1)
        && !clashHasMultiItemsOnSameDay
        && Boolean(primaryTargetItem);

    if (targetExists && clashScores && clashScores.length > 0) {
        const { data: targetScores, error: targetErr } = await supabaseClient
            .from("scores")
            .select("date, student_id, grading_period, item_id")
            .eq("user_id", uid)
            .eq("category_id", category.id);
        if (targetErr) throw targetErr;
        if (targetScores && targetScores.length > 0) {
            const targetKeys = new Set(targetScores.map(r => `${r.date}|${r.student_id}|${r.grading_period}|${r.item_id || ""}`));
            const duplicateIds = clashScores
                .filter(r => {
                    const mappedItem = canRemapToPrimaryItem ? primaryTargetItem.id : (r.item_id || "");
                    return targetKeys.has(`${r.date}|${r.student_id}|${r.grading_period}|${mappedItem}`)
                        || targetKeys.has(`${r.date}|${r.student_id}|${r.grading_period}|${r.item_id || ""}`);
                })
                .map(r => r.id);
            if (duplicateIds.length > 0) {
                must(await supabaseClient.from("scores").delete().eq("user_id", uid).in("id", duplicateIds));
            }
        }
    }

    const scorePatch = {
        category_id: category.id,
        category_name: category.name,
        category_weight: category.weight
    };
    if (canRemapToPrimaryItem) {
        scorePatch.item_id = primaryTargetItem.id;
        scorePatch.item_label = primaryTargetItem.label;
    }
    must(await supabaseClient.from("scores").update(scorePatch).eq("user_id", uid).eq("category_id", clash.id));

    must(await supabaseClient.from("section_grading_categories")
        .delete()
        .eq("user_id", uid)
        .eq("category_id", clash.id));
    must(await supabaseClient.from("section_grading_categories").upsert(
        [{ user_id: uid, section, category_id: category.id }],
        { onConflict: "user_id,section,category_id" }
    ));

    must(await supabaseClient.from("grading_categories")
        .delete()
        .eq("user_id", uid)
        .eq("id", clash.id));

    existingSectionCategories.splice(clashIndex, 1);
    if (!targetExists) {
        existingSectionCategories.push({
            id: category.id,
            user_id: uid,
            section,
            name: category.name,
            weight: category.weight,
            items: cloudItems,
            archived: false
        });
    }
}

function dedupeScorePayload(payload) {
    if (!Array.isArray(payload)) return payload;
    const byKey = new Map();
    payload.forEach(row => {
        const k = `${row.user_id}|${row.date}|${row.student_id}|${row.grading_period}|${row.category_id}|${row.item_id || ""}`;
        byKey.set(k, row);
    });
    return [...byKey.values()];
}

async function upsertScorePayloadWithCategoryRecovery(rawPayload, uid, sectionHint = "") {
    const payload = dedupeScorePayload(rawPayload);
    const conflictOpts = { onConflict: "user_id,date,student_id,grading_period,category_id,item_id" };
    const firstAttempt = await supabaseClient.from("scores").upsert(payload, conflictOpts);
    if (!firstAttempt || !firstAttempt.error) return firstAttempt;
    if (!isMissingCategoryFkError(firstAttempt.error)) throw firstAttempt.error;

    const rows = Array.isArray(payload) ? payload : [payload];
    const neededMap = new Map();
    rows.forEach(row => {
        if (!row.category_id) return;
        if (!neededMap.has(row.category_id)) {
            const weight = Number(row.category_weight ?? 0);
            const section = sectionHint || resolveSectionForScoreRow(row);
            const localCat = state.gradeCategories.find(c => c.id === row.category_id);
            neededMap.set(row.category_id, {
                id: row.category_id,
                section,
                name: String(row.category_name || "General").trim() || "General",
                weight: Number.isFinite(weight) ? Math.min(Math.max(weight, 0), 100) : 0,
                items: localCat?.items
                    ? sanitizeCategoryItems(localCat.items)
                    : [{ id: row.item_id || newCategoryId(), label: row.item_label || "#1", max_score: Number(row.max_score) > 0 ? Number(row.max_score) : 100, period_max: {} }]
            });
        } else if (row.item_id) {
            const entry = neededMap.get(row.category_id);
            if (!entry.items.some(i => i.id === row.item_id)) {
                entry.items.push({
                    id: row.item_id,
                    label: row.item_label || `#${entry.items.length + 1}`,
                    max_score: Number(row.max_score) > 0 ? Number(row.max_score) : 100,
                    period_max: {}
                });
            }
        }
    });

    const timestamp = new Date().toISOString();
    const allExistingCategories = await fetchAll("grading_categories", uid);

    for (const category of neededMap.values()) {
        const sectionExisting = allExistingCategories.filter(row => row.section === category.section);

        // If this section only had an auto-backfilled "General" (100%) category
        // and offline score rows are restoring distinct categories for this section,
        // archive that placeholder so the section's weights stay clean.
        if (
            category.name.toLowerCase() !== "general"
            && category.weight > 0
            && sectionExisting.filter(r => !r.archived).length === 1
            && String(sectionExisting.find(r => !r.archived).name || "").trim().toLowerCase() === "general"
            && Number(sectionExisting.find(r => !r.archived).weight) === 100
            && !neededMap.has(sectionExisting.find(r => !r.archived).id)
        ) {
            const backfilled = sectionExisting.find(r => !r.archived);
            must(await supabaseClient.from("section_grading_categories")
                .delete()
                .eq("user_id", uid)
                .eq("category_id", backfilled.id));
            must(await supabaseClient.from("grading_categories")
                .update({ archived: true, weight: 0, updated_at: timestamp })
                .eq("user_id", uid)
                .eq("id", backfilled.id));
            backfilled.archived = true;
            backfilled.weight = 0;
        }

        await reconcileCategoryByNameInCloud(uid, category.section, sectionExisting, category, timestamp);
        if (!sectionExisting.some(row => row.id === category.id)) {
            const cloudItems = categoryItemsForCloud(category.items);
            must(await supabaseClient.from("grading_categories").upsert({
                id: category.id,
                user_id: uid,
                section: category.section,
                name: category.name,
                weight: category.weight,
                items: cloudItems,
                archived: false,
                updated_at: timestamp
            }, { onConflict: "id" }));
            must(await supabaseClient.from("section_grading_categories").upsert(
                [{ user_id: uid, section: category.section, category_id: category.id }],
                { onConflict: "user_id,section,category_id" }
            ));
            allExistingCategories.push({ ...category, items: cloudItems, user_id: uid, archived: false });
        }
    }

    return must(await supabaseClient.from("scores").upsert(payload, conflictOpts));
}

async function syncGradingConfigToCloud(op, uid) {
    const section = String(op.section || "").trim();
    if (!section) return;
    const timestamp = new Date().toISOString();
    const { data: existingRows, error: fetchErr } = await supabaseClient
        .from("grading_categories")
        .select("*")
        .eq("user_id", uid)
        .eq("section", section);
    if (fetchErr) throw fetchErr;
    const existingCategories = existingRows || [];

    const activeIds = new Set(op.categories.map(category => category.id));
    for (const category of op.categories) {
        await reconcileCategoryByNameInCloud(uid, section, existingCategories, category, timestamp, activeIds);
    }

    for (let i = 0; i < op.categories.length; i += 500) {
        must(await supabaseClient.from("grading_categories").upsert(
            op.categories.slice(i, i + 500).map(category => ({
                id: category.id,
                user_id: uid,
                section,
                name: category.name,
                weight: category.weight,
                items: categoryItemsForCloud(category.items),
                archived: false,
                updated_at: timestamp
            })),
            { onConflict: "id" }
        ));
    }
    for (const category of op.categories) {
        must(await supabaseClient.from("scores").update({
            category_name: category.name,
            category_weight: category.weight
        }).eq("user_id", uid).eq("category_id", category.id));
        for (const item of sanitizeCategoryItems(category.items)) {
            must(await supabaseClient.from("scores").update({
                item_label: item.label
            }).eq("user_id", uid).eq("category_id", category.id).eq("item_id", item.id));
        }
    }
    if (op.categories.length > 0) {
        must(await supabaseClient.from("section_grading_categories").upsert(
            op.categories.map(category => ({ user_id: uid, section, category_id: category.id })),
            { onConflict: "user_id,section,category_id" }
        ));
    } else {
        must(await supabaseClient.from("section_grading_categories").delete()
            .eq("user_id", uid).eq("section", section));
    }

    // Retire categories removed from THIS section only: delete unused ones and
    // archive any still referenced by historical score rows. Other sections are
    // never touched.
    for (const stale of existingCategories) {
        if (activeIds.has(stale.id)) continue;
        must(await supabaseClient.from("section_grading_categories")
            .delete()
            .eq("user_id", uid)
            .eq("category_id", stale.id));
        const { data: linkedScores, error: scoreErr } = await supabaseClient
            .from("scores")
            .select("id")
            .eq("user_id", uid)
            .eq("category_id", stale.id)
            .range(0, 0);
        if (scoreErr) throw scoreErr;
        if (!linkedScores || linkedScores.length === 0) {
            must(await supabaseClient.from("grading_categories")
                .delete()
                .eq("user_id", uid)
                .eq("id", stale.id));
        } else if (!stale.archived || Number(stale.weight) !== 0) {
            must(await supabaseClient.from("grading_categories")
                .update({ archived: true, weight: 0, updated_at: timestamp })
                .eq("user_id", uid)
                .eq("id", stale.id));
        }
    }
}

async function applyCloudOp(op) {
    const uid = currentUser.id;
    switch (op.t) {
        case "att": // one attendance status
            must(await supabaseClient.from("attendance").upsert({
                user_id: uid, date: op.date, student_id: op.student_id,
                status: op.status, subject: op.subject || "General"
            }, { onConflict: "user_id,date,student_id,subject" }));
            break;
        case "attB": { // batch attendance statuses
            for (let i = 0; i < op.rows.length; i += 500) {
                must(await supabaseClient.from("attendance")
                    .upsert(op.rows.slice(i, i + 500).map(r => ({
                        user_id: uid, subject: "General", ...r
                    })), { onConflict: "user_id,date,student_id,subject" }));
            }
            break;
        }
        case "scr": { // one score with its category and grading-period metadata
            const single = scoreRowForCloud(op, uid);
            if (single) await upsertScorePayloadWithCategoryRecovery(single, uid, op.section || "");
            break;
        }
        case "scr-": { // delete one cleared score cell
            let q = supabaseClient.from("scores").delete()
                .eq("user_id", uid)
                .eq("date", op.date)
                .eq("student_id", op.student_id)
                .eq("grading_period", op.grading_period || "General")
                .eq("category_id", op.category_id);
            if (op.item_id) q = q.eq("item_id", op.item_id);
            must(await q);
            break;
        }
        case "scrB": { // batch scores
            for (let i = 0; i < op.rows.length; i += 500) {
                const slice = op.rows.slice(i, i + 500);
                const rowsForCloud = slice.map(r => scoreRowForCloud(r, uid)).filter(Boolean);
                if (rowsForCloud.length === 0) break;
                await upsertScorePayloadWithCategoryRecovery(
                    rowsForCloud,
                    uid,
                    slice[0]?.section || op.section || ""
                );
            }
            break;
        }
        case "gradingConfig": // one section's independent categories and weights
            await syncGradingConfigToCloud(op, uid);
            break;
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
        case "scr-stu": // remove one student's score history
            must(await supabaseClient.from("scores").delete()
                .eq("user_id", uid).eq("student_id", op.student_id));
            break;
        case "scr^": // re-link scores after a student code rename
            if (op.old_code !== op.student_id) {
                must(await supabaseClient.from("scores").update({ student_id: op.student_id })
                    .eq("user_id", uid).eq("student_id", op.old_code));
            }
            break;
        case "sec+": // add section (idempotent)
            must(await supabaseClient.from("sections").upsert({
                user_id: uid, name: op.name
            }, { onConflict: "user_id,name" }));
            break;
        case "sec^": // rename section and update associated students + section categories
            must(await supabaseClient.from("sections").upsert({ user_id: uid, name: op.new_name }, { onConflict: "user_id,name" }));
            must(await supabaseClient.from("students").update({ section: op.new_name }).eq("user_id", uid).eq("section", op.old_name));
            must(await supabaseClient.from("grading_categories").update({ section: op.new_name }).eq("user_id", uid).eq("section", op.old_name));
            must(await supabaseClient.from("section_grading_categories").update({ section: op.new_name }).eq("user_id", uid).eq("section", op.old_name));
            must(await supabaseClient.from("sections").delete().eq("user_id", uid).eq("name", op.old_name));
            break;
        case "sec-": { // delete section with its students, attendance, scores, and categories
            const { data: secCats, error: secCatErr } = await supabaseClient
                .from("grading_categories")
                .select("id")
                .eq("user_id", uid)
                .eq("section", op.name);
            if (secCatErr) throw secCatErr;
            const catIds = (secCats || []).map(r => r.id).filter(Boolean);
            for (let i = 0; i < catIds.length; i += 100) {
                must(await supabaseClient.from("scores").delete()
                    .eq("user_id", uid).in("category_id", catIds.slice(i, i + 100)));
            }
            if (op.codes && op.codes.length > 0) {
                for (let i = 0; i < op.codes.length; i += 100) {
                    const batch = op.codes.slice(i, i + 100);
                    must(await supabaseClient.from("attendance").delete()
                        .eq("user_id", uid).in("student_id", batch));
                    must(await supabaseClient.from("scores").delete()
                        .eq("user_id", uid).in("student_id", batch));
                }
            }
            must(await supabaseClient.from("section_grading_categories").delete()
                .eq("user_id", uid).eq("section", op.name));
            must(await supabaseClient.from("grading_categories").delete()
                .eq("user_id", uid).eq("section", op.name));
            must(await supabaseClient.from("students").delete()
                .eq("user_id", uid).eq("section", op.name));
            must(await supabaseClient.from("sections").delete()
                .eq("user_id", uid).eq("name", op.name));
            break;
        }
        case "stu+": // add/edit student, keyed by student code (idempotent)
            must(await supabaseClient.from("students").upsert({
                user_id: uid, student_id: op.student_id,
                name: op.name, email: op.email || null, section: op.section
            }, { onConflict: "user_id,student_id" }));
            break;
        case "stuB+": { // batch add/edit students
            for (let i = 0; i < op.rows.length; i += 500) {
                must(await supabaseClient.from("students").upsert(
                    op.rows.slice(i, i + 500).map(r => ({
                        user_id: uid,
                        student_id: r.student_id,
                        name: r.name,
                        email: r.email || null,
                        section: r.section
                    })),
                    { onConflict: "user_id,student_id" }
                ));
            }
            break;
        }
        case "stu^": // rename/edit student keyed by their OLD code
            must(await supabaseClient.from("students").update({
                student_id: op.student_id, name: op.name,
                email: op.email || null, section: op.section
            }).eq("user_id", uid).eq("student_id", op.old_code));
            await applyCloudOp({ t: "att^", old_code: op.old_code, student_id: op.student_id });
            await applyCloudOp({ t: "scr^", old_code: op.old_code, student_id: op.student_id });
            break;
        case "stu-": // delete student + their attendance & score history
            must(await supabaseClient.from("students").delete()
                .eq("user_id", uid).eq("student_id", op.student_id));
            await applyCloudOp({ t: "att-", student_id: op.student_id });
            await applyCloudOp({ t: "scr-stu", student_id: op.student_id });
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
    const processedIds = new Set();
    let stampedMissingIds = false;
    q.forEach(op => {
        if (op && !op._qid) {
            op._qid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            stampedMissingIds = true;
        }
    });
    if (stampedMissingIds) {
        try { localStorage.setItem(key, JSON.stringify(q)); } catch (e) { /* keep going */ }
    }
    const failed = [];
    let applied = 0;
    try {
        for (const op of q) {
            processedIds.add(op._qid);
            try {
                await runWithSessionRetry(op);
                applied++;
            } catch (err) {
                const detail = err && typeof err === "object"
                    ? `${err.code || ""} ${err.message || ""} ${err.details || ""}`.trim()
                    : String(err);
                console.error(`Failed to replay offline change (${op.t}): ${detail}`, op, err);
                failed.push(op);
            }
        }

        let latestQueue = [];
        try { latestQueue = JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) { latestQueue = []; }
        const appendedWhileFlushing = Array.isArray(latestQueue)
            ? latestQueue.filter(item => item && (!item._qid || !processedIds.has(item._qid)))
            : [];
        const remaining = [...failed, ...appendedWhileFlushing];
        try { localStorage.setItem(key, JSON.stringify(remaining)); } catch (e) { /* keep going */ }

        if (applied > 0) {
            showToast(`Synced ${applied} change${applied > 1 ? "s" : ""} made while offline.`, "success");
            await loadSupabaseData(); // rebuild state from the cloud (also re-maps ids)
            if (remaining.length > 0) applyPendingOpsToLocalState(remaining);
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
//
// The whole payload is planned and validated in memory BEFORE anything is
// deleted. A score whose grading category no longer exists gets a weight-0
// category created for it rather than aborting the restore, so one legacy row
// can never cost the teacher the rest of their backup.
function buildFullStatePlan(uid) {
    ensureScoreCategories();
    Object.values(state.scores).forEach(row => resolveCategoryForScore(row));

    const sectionRows = state.sections.map(name => ({ user_id: uid, name }));

    const categoryRows = state.gradeCategories.map(category => ({
        id: category.id,
        user_id: uid,
        section: category.section,
        name: category.name,
        weight: category.weight,
        items: categoryItemsForCloud(category.items),
        archived: false
    }));
    const activeIds = new Set(categoryRows.map(row => row.id));
    Object.values(state.scores).forEach(scoreRow => {
        if (!scoreRow?.category_id || activeIds.has(scoreRow.category_id)) return;
        activeIds.add(scoreRow.category_id);
        categoryRows.push({
            id: scoreRow.category_id,
            user_id: uid,
            section: resolveSectionForScoreRow(scoreRow),
            name: String(scoreRow.category_name || "General").trim() || "General",
            weight: 0,
            items: [{ id: scoreRow.item_id || "item-1", label: scoreRow.item_label || "#1", max_score: Number(scoreRow.max_score) > 0 ? Number(scoreRow.max_score) : 100 }],
            archived: true
        });
    });

    const sectionCategoryRows = state.gradeCategories.map(category => ({
        user_id: uid,
        section: category.section,
        category_id: category.id
    }));

    const studentRows = state.students.map(s => ({
        user_id: uid,
        student_id: s.student_id,
        name: s.name,
        email: s.email || null,
        section: s.section
    }));

    const attRows = Object.keys(state.attendance).map(k => {
        const { date, studentId } = parseAttKey(k);
        return { user_id: uid, date, student_id: studentId, status: state.attendance[k] };
    });

    const scoreRows = dedupeScorePayload(
        Object.values(state.scores).map(row => scoreRowForCloud(row, uid)).filter(Boolean)
    );

    return { sectionRows, categoryRows, sectionCategoryRows, studentRows, attRows, scoreRows };
}

async function pushFullStateToCloud() {
    if (!cloudReady()) throw new Error("Not signed in to the cloud.");
    const uid = currentUser.id;
    const plan = buildFullStatePlan(uid);
    const summary = {
        sections: plan.sectionRows.length,
        students: plan.studentRows.length,
        attendance: plan.attRows.length,
        scores: 0,
        categories: plan.categoryRows.length,
        skippedScores: 0
    };

    // Deletion order respects the data dependencies.
    must(await supabaseClient.from("scores").delete().eq("user_id", uid));
    must(await supabaseClient.from("section_grading_categories").delete().eq("user_id", uid));
    must(await supabaseClient.from("grading_categories").delete().eq("user_id", uid));
    must(await supabaseClient.from("attendance").delete().eq("user_id", uid));
    must(await supabaseClient.from("students").delete().eq("user_id", uid));
    must(await supabaseClient.from("sections").delete().eq("user_id", uid));

    for (let i = 0; i < plan.sectionRows.length; i += 500) {
        must(await supabaseClient.from("sections").insert(plan.sectionRows.slice(i, i + 500)));
    }

    for (let i = 0; i < plan.categoryRows.length; i += 500) {
        must(await supabaseClient.from("grading_categories").insert(plan.categoryRows.slice(i, i + 500)));
    }

    for (let i = 0; i < plan.sectionCategoryRows.length; i += 500) {
        must(await supabaseClient.from("section_grading_categories").insert(plan.sectionCategoryRows.slice(i, i + 500)));
    }

    if (plan.studentRows.length > 0) {
        const idByCode = {};
        for (let i = 0; i < plan.studentRows.length; i += 500) {
            const { data, error } = await supabaseClient.from("students").insert(
                plan.studentRows.slice(i, i + 500)
            ).select("id, student_id");
            if (error) throw error;
            (data || []).forEach(r => { idByCode[r.student_id] = String(r.id); });
        }

        // Remap local ids to the database-generated ones
        state.students.forEach(s => {
            if (idByCode[s.student_id]) s.id = idByCode[s.student_id];
        });
    }

    for (let i = 0; i < plan.attRows.length; i += 500) {
        must(await supabaseClient.from("attendance").insert(plan.attRows.slice(i, i + 500)));
    }

    for (let i = 0; i < plan.scoreRows.length; i += 500) {
        const batch = plan.scoreRows.slice(i, i + 500);
        try {
            must(await supabaseClient.from("scores").insert(batch));
            summary.scores += batch.length;
        } catch (batchErr) {
            // Fall back to one row at a time so a single unusable row cannot
            // take the rest of the scores down with it.
            console.error("Score batch insert failed, retrying row by row:", batchErr);
            for (const row of batch) {
                try {
                    must(await supabaseClient.from("scores").insert([row]));
                    summary.scores += 1;
                } catch (rowErr) {
                    summary.skippedScores += 1;
                    console.error("Skipped one score while restoring:", rowErr, row);
                }
            }
        }
    }

    return summary;
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
    const today = todayStr();
    ["att-date", "score-date"].forEach(id => {
        const dateInput = document.getElementById(id);
        if (dateInput) dateInput.value = today;
    });
}

function refreshIcons() {
    if (window.lucide) {
        window.lucide.createIcons();
    }
}

// --- Navigation & Tabs ---
function switchTab(tabName) {
    activeTab = tabName;
    const views = ["dashboard", "directory", "attendance", "scores"];
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
        syncLatestFromCloud().catch(() => {});
    }
    if (tabName === "scores") {
        populateSectionDropdowns();
        loadScoreSheet();
        syncLatestFromCloud().catch(() => {});
    }
    refreshIcons();
}

function toggleMobileMenu() {
    const menu = document.getElementById("mobileMenu");
    if (!menu) return;
    const opening = menu.classList.contains("hidden");
    menu.classList.toggle("hidden", !opening);
    const trigger = document.querySelector(".hamburger-btn");
    if (trigger) trigger.setAttribute("aria-expanded", String(opening));
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
    // Don't leave a resumable QR check-in session behind on a shared device.
    localStorage.removeItem("scholog_checkin_host");
    window.location.href = "index.html";
}

// --- Dashboard View ---
function openSectionAttendance(sectionName) {
    if (!sectionName) return;
    populateSectionDropdowns();
    const attSelect = document.getElementById("att-section");
    if (attSelect && state.sections.includes(sectionName)) {
        attSelect.value = sectionName;
    }
    switchTab("attendance");
}

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
    } else {
        state.sections.forEach(sec => {
            const secStudents = state.students.filter(s => s.section === sec);
            let secPresent = 0;
            let secAbsent = 0;
            let secLate = 0;
            let secExcused = 0;
            let secRecorded = 0;
            secStudents.forEach(s => {
                const status = state.attendance[`${today}_${s.student_id}`];
                if (status) secRecorded++;
                // Kasama rin ang "Late" dito sa per-section breakdown
                if (status === "Present" || status === "Late") secPresent++;
                if (status === "Absent") secAbsent++;
                if (status === "Late") secLate++;
                if (status === "Excused") secExcused++;
            });
            const secRate = secStudents.length > 0 ? Math.round((secPresent / secStudents.length) * 100) : 0;
            const detailPills = secRecorded === 0 && secStudents.length > 0
                ? `<span class="dash-sec-pill dash-sec-unrecorded">Not recorded today</span>`
                : [
                    secLate > 0 ? `<span class="dash-sec-pill dash-sec-late">${secLate} Late</span>` : "",
                    secAbsent > 0 ? `<span class="dash-sec-pill dash-sec-absent">${secAbsent} Absent</span>` : "",
                    secExcused > 0 ? `<span class="dash-sec-pill dash-sec-excused">${secExcused} Excused</span>` : ""
                ].filter(Boolean).join(" ");

            const item = document.createElement("div");
            item.className = "breakdown-item";
            item.innerHTML = `
                <div class="breakdown-info">
                    <h3>${esc(sec)}</h3>
                    <p>${secStudents.length} Students — ${secPresent} Present Today ${detailPills}</p>
                </div>
                <div class="breakdown-progress-group">
                    <div class="progress-bar-wrapper">
                        <div class="progress-fill" style="width: ${secRate}%"></div>
                    </div>
                    <span class="stat-value" style="font-size: 16px;">${secRate}%</span>
                    <button type="button" onclick="openSectionAttendance('${jsArg(sec)}')" class="btn btn-secondary dash-take-att-btn" title="Take attendance for ${esc(sec)}">Mark</button>
                </div>
            `;
            container.appendChild(item);
        });
    }

    renderDashboardWatchlist();
}

function renderDashboardWatchlist() {
    const watchContainer = document.getElementById("dashboard-watchlist-container");
    const watchBadge = document.getElementById("dash-watchlist-badge");
    if (!watchContainer) return;

    const countsByCode = new Map();
    Object.keys(state.attendance).forEach(k => {
        const { studentId } = parseAttKey(k);
        const status = state.attendance[k];
        if (!studentId || !status) return;
        if (!countsByCode.has(studentId)) {
            countsByCode.set(studentId, { Absent: 0, Late: 0, Present: 0, Excused: 0 });
        }
        const entry = countsByCode.get(studentId);
        if (entry[status] !== undefined) entry[status]++;
    });

    const flagged = state.students
        .map(stud => {
            const c = countsByCode.get(stud.student_id) || { Absent: 0, Late: 0, Present: 0, Excused: 0 };
            return { stud, absent: c.Absent, late: c.Late, present: c.Present };
        })
        .filter(item => item.absent > 0 || item.late >= 2)
        .sort((a, b) => (b.absent - a.absent) || (b.late - a.late) || a.stud.name.localeCompare(b.stud.name));

    const atRiskCount = flagged.filter(item => item.absent >= 2).length;
    if (watchBadge) {
        if (atRiskCount > 0) {
            watchBadge.textContent = `${atRiskCount} Flagged (2+ Absences)`;
            watchBadge.className = "badge badge-rose";
        } else if (flagged.length > 0) {
            watchBadge.textContent = `${flagged.length} Monitored`;
            watchBadge.className = "badge badge-amber";
        } else {
            watchBadge.textContent = "All Clear";
            watchBadge.className = "badge badge-emerald";
        }
    }

    if (flagged.length === 0) {
        watchContainer.innerHTML = `<div style="padding: 18px 20px; text-align: center; color: var(--text-muted); font-size: 13px;">No students have recorded absences or repeated tardiness yet.</div>`;
        return;
    }

    watchContainer.innerHTML = flagged.slice(0, 8).map(({ stud, absent, late }) => `
        <div class="breakdown-item watchlist-item">
            <div class="breakdown-info">
                <h3>${esc(stud.name)} <span class="font-mono" style="font-size:12px; color:var(--text-muted); font-weight:500;">(${esc(stud.student_id)})</span></h3>
                <p>${esc(stud.section)}</p>
            </div>
            <div class="watchlist-badges">
                ${absent > 0 ? `<span class="badge ${absent >= 2 ? "badge-rose" : "badge-amber"}">${absent} Absent</span>` : ""}
                ${late > 0 ? `<span class="badge badge-amber">${late} Late</span>` : ""}
                <button type="button" onclick="openAttendanceHistory('${jsArg(stud.id)}')" class="action-link action-history">History</button>
            </div>
        </div>
    `).join("");
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
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            ${state.students.length > 0 ? `<button onclick="openSectionQrModal('${jsArg(selectedDirectorySection)}')" class="btn btn-secondary action-qr"><i data-lucide="qr-code"></i> Print QR Cards</button>` : ""}
            ${selectedDirectorySection !== "ALL" ? `
                <button onclick="openEditSectionModal('${jsArg(selectedDirectorySection)}')" class="btn btn-secondary action-edit"><i data-lucide="edit-3"></i> Edit Section</button>
                <button onclick="confirmDeleteSection('${jsArg(selectedDirectorySection)}')" class="btn btn-secondary action-delete"><i data-lucide="trash-2"></i> Delete Section</button>
            ` : ""}
        </div>
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
                <button onclick="openStudentQr('${jsArg(stud.id)}')" class="action-link action-qr">QR</button>
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
    const scoreSelect = document.getElementById("score-section");
    const studSelect = document.getElementById("stud-section");
    const bulkStudSelect = document.getElementById("bulk-stud-section");
    const transferSelect = document.getElementById("transfer-new-section");

    const prevAtt = attSelect ? attSelect.value : "";
    const prevScore = scoreSelect ? scoreSelect.value : "";
    const prevBulk = bulkStudSelect ? bulkStudSelect.value : "";
    const optionsHTML = state.sections.length > 0
        ? state.sections.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("")
        : `<option value="">-- No sections yet --</option>`;

    if (attSelect) {
        attSelect.innerHTML = optionsHTML;
        if (prevAtt && state.sections.includes(prevAtt)) attSelect.value = prevAtt;
    }
    if (scoreSelect) {
        scoreSelect.innerHTML = optionsHTML;
        if (prevScore && state.sections.includes(prevScore)) scoreSelect.value = prevScore;
    }
    if (studSelect) studSelect.innerHTML = optionsHTML;
    if (bulkStudSelect) {
        bulkStudSelect.innerHTML = optionsHTML;
        if (prevBulk && state.sections.includes(prevBulk)) bulkStudSelect.value = prevBulk;
    }
    if (transferSelect) transferSelect.innerHTML = optionsHTML;
}

function loadAttendanceSheet() {
    const selectedDate = document.getElementById("att-date").value;
    const selectedSec = document.getElementById("att-section").value;
    const tableBody = document.getElementById("att-table-body");
    const subtitle = document.getElementById("att-sheet-subtitle");

    tableBody.innerHTML = "";

    if (!selectedSec) {
        if (subtitle) subtitle.textContent = "Mark student statuses for the selected date and section";
        tableBody.innerHTML = `<tr><td colspan="5" class="text-center" style="padding: 24px; color: var(--text-muted);">No sections yet. Go to <strong>Class List</strong> and click <strong>Add Section</strong> first.</td></tr>`;
        return;
    }

    if (!selectedDate) {
        if (subtitle) subtitle.textContent = "Mark student statuses for the selected date and section";
        tableBody.innerHTML = `<tr><td colspan="5" class="text-center" style="padding: 24px; color: var(--text-muted);">Please select a valid date above.</td></tr>`;
        return;
    }

    const secStudents = state.students.filter(s => s.section === selectedSec);

    if (secStudents.length === 0) {
        if (subtitle) subtitle.textContent = `${selectedDate} · ${selectedSec} · No students in section`;
        tableBody.innerHTML = `<tr><td colspan="5" class="text-center" style="padding: 24px; color: var(--text-muted);">No students in this section. Add students from Class List view.</td></tr>`;
        return;
    }

    let recordedCount = 0;
    secStudents.forEach(stud => {
        if (state.attendance[`${selectedDate}_${stud.student_id}`]) recordedCount++;
    });

    if (subtitle) {
        if (recordedCount === 0) {
            subtitle.innerHTML = `${esc(selectedDate)} · ${esc(selectedSec)} · <span class="att-save-badge att-save-unsaved">Not saved yet — defaults to Present until you click Save</span>`;
        } else if (recordedCount < secStudents.length) {
            subtitle.innerHTML = `${esc(selectedDate)} · ${esc(selectedSec)} · <span class="att-save-badge att-save-partial">${recordedCount}/${secStudents.length} recorded — click Save to mark remaining as Present</span>`;
        } else {
            subtitle.innerHTML = `${esc(selectedDate)} · ${esc(selectedSec)} · <span class="att-save-badge att-save-saved">Saved (${recordedCount}/${secStudents.length} recorded)</span>`;
        }
    }

    secStudents.forEach((stud, idx) => {
        const key = `${selectedDate}_${stud.student_id}`;
        const savedStatus = state.attendance[key];
        const currentStatus = savedStatus || "Present";

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${idx + 1}</td>
            <td><strong>${esc(stud.name)}</strong></td>
            <td class="font-mono">${esc(stud.student_id)}</td>
            <td>${esc(selectedDate)}</td>
            <td class="text-center status-cell">
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

// --- Student Scores View ---
function getSectionGradeCategories(section) {
    if (!section) return [];
    return state.gradeCategories.filter(category => category.section === section);
}

function getSelectedGradeCategoryIds(section) {
    return getSectionGradeCategories(section).map(category => category.id);
}

function getCategoryItems(category) {
    if (!Array.isArray(category.items) || category.items.length === 0) {
        category.items = sanitizeCategoryItems(null, 1);
    }
    return category.items;
}

function itemMaximumKey(categoryId, itemId) {
    return `${categoryId}::${itemId}`;
}

function syncScoreHeaderStickyOffset() {
    const apply = () => {
        const tableEl = document.querySelector("#view-scores .score-spreadsheet");
        const groupRow = document.querySelector("#score-table-head tr.score-head-group-row");
        if (!tableEl || !groupRow) return;
        const height = Math.round(groupRow.getBoundingClientRect?.().height || groupRow.offsetHeight || 0);
        if (height > 0) {
            tableEl.style.setProperty("--score-group-row-height", `${height}px`);
        }
    };
    apply();
    if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(apply);
    }
}

window.addEventListener("resize", () => {
    if (activeTab === "scores") syncScoreHeaderStickyOffset();
});

function renderScoreSheetHeader(categories, itemMaximums) {
    const tableHead = document.getElementById("score-table-head");
    if (!tableHead) return;
    if (categories.length === 0) {
        tableHead.innerHTML = `<tr class="score-head-group-row">
            <th class="text-center score-grid-index">#</th>
            <th class="text-center score-grid-student">Student</th>
            <th class="text-center score-grid-final">Final Grade</th>
        </tr>`;
        return;
    }

    tableHead.innerHTML = `
        <tr class="score-head-group-row">
            <th rowspan="2" class="text-center score-grid-index">#</th>
            <th rowspan="2" class="text-center score-grid-student">Student</th>
            ${categories.map(category => {
                const items = getCategoryItems(category);
                return `<th colspan="${items.length}" class="text-center score-grid-category-group" data-category-id="${esc(category.id)}">
                    <div class="score-category-group-bar">
                        <div class="score-category-heading">
                            <strong>${esc(category.name)}</strong>
                            <small>${esc(category.weight)}%${items.length > 1 ? ` · ${items.length} items` : ""}</small>
                        </div>
                        <button type="button" class="score-add-item-btn"
                            onclick="addCategorySubsection('${jsArg(category.id)}')"
                            title="Add subsection under ${esc(category.name)}"
                            aria-label="Add subsection to ${esc(category.name)}">+ Add</button>
                    </div>
                </th>`;
            }).join("")}
            <th rowspan="2" class="text-center score-grid-final">Final Grade</th>
        </tr>
        <tr class="score-head-item-row">
            ${categories.flatMap(category => {
                const items = getCategoryItems(category);
                const singleClass = items.length === 1 ? " score-col-single" : "";
                return items.map((item, itemIdx) => {
                    const maximum = itemMaximums.get(itemMaximumKey(category.id, item.id)) || 100;
                    return `<th class="text-center score-grid-category${singleClass}" data-category-id="${esc(category.id)}" data-item-id="${esc(item.id)}">
                        <div class="score-item-bar">
                            <input type="text" class="score-item-label-input" value="${esc(item.label)}" maxlength="40"
                                placeholder="#${itemIdx + 1}"
                                aria-label="Subsection name for ${esc(category.name)} ${itemIdx + 1}"
                                onchange="renameCategorySubsection('${jsArg(category.id)}', '${jsArg(item.id)}', this.value, this)">
                            ${items.length > 1 ? `<button type="button" class="score-remove-item-btn"
                                onclick="removeCategorySubsection('${jsArg(category.id)}', '${jsArg(item.id)}')"
                                title="Remove ${esc(item.label)}"
                                aria-label="Remove ${esc(item.label)} from ${esc(category.name)}">&times;</button>` : ""}
                        </div>
                        <label class="score-column-max-label">
                            <span>Max</span>
                            <input type="number" class="score-column-max" min="1" step="any" value="${esc(maximum)}"
                                data-category-id="${esc(category.id)}" data-item-id="${esc(item.id)}" data-previous-value="${esc(maximum)}"
                                aria-label="Maximum score for ${esc(category.name)} ${esc(item.label)}"
                                onchange="updateScoreMaximum('${jsArg(category.id)}', '${jsArg(item.id)}', this.value, this)">
                        </label>
                    </th>`;
                });
            }).join("")}
        </tr>
    `;
    syncScoreHeaderStickyOffset();
}

function renderScoreWeightSummary(section) {
    const summary = document.getElementById("score-weight-summary");
    if (!summary) return;
    if (!section) {
        summary.textContent = "Create and select a section to configure its grading categories and weights.";
        summary.classList.remove("text-rose");
        return;
    }
    const selected = getSectionGradeCategories(section);
    const sectionTotal = Number(selected.reduce((sum, category) => sum + category.weight, 0).toFixed(2));
    summary.textContent = selected.length > 0
        ? `${section}: ${selected.map(category => {
            const count = getCategoryItems(category).length;
            return `${category.name} ${category.weight}%${count > 1 ? ` (${count} items)` : ""}`;
        }).join(" · ")} | Section total: ${sectionTotal}%`
        : `No grading categories set up for ${section} yet. Click Categories & Weights to configure this section.`;
    summary.classList.toggle("text-rose", selected.length > 0 && Math.abs(sectionTotal - 100) > 0.001);
}

function resolveScoreItemForCategory(category, value) {
    const items = getCategoryItems(category);
    if (value?.item_id) {
        const exact = items.find(i => i.id === value.item_id);
        if (exact) return exact;
        if (value.item_id === "item-1" && items[0]) return items[0];
        return null;
    }
    return items[0] || null;
}

function calculateStudentFinalGrade(studentId, section, gradingPeriod) {
    const categories = getSectionGradeCategories(section);
    const totals = new Map(categories.map(category => [
        category.id,
        {
            score: 0,
            max: 0,
            weight: category.weight,
            itemCount: getCategoryItems(category).length,
            scoredItemIds: new Set()
        }
    ]));

    // Pick the latest-dated score per (category, item) within this grading period.
    const latestByCatItem = new Map();
    Object.keys(state.scores).forEach(key => {
        const value = state.scores[key];
        const parsed = parseScoreKey(key);
        if ((value.student_id || parsed.studentId) !== studentId) return;
        const period = value.grading_period || parseLegacyScoreSubject(value.subject || parsed.subject).period;
        if (period !== gradingPeriod) return;
        const category = categories.find(item => item.id === value.category_id)
            || categories.find(item => !value.category_id && item.name === value.category_name);
        if (!category || !totals.has(category.id)) return;
        const matchedItem = resolveScoreItemForCategory(category, value);
        if (!matchedItem) return;
        const score = Number(value.score);
        const maxScore = Number(value.max_score);
        if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) return;
        const mapKey = `${category.id}::${matchedItem.id}`;
        const prev = latestByCatItem.get(mapKey);
        const rowDate = String(value.date || parsed.date || "");
        if (!prev || rowDate >= prev.date) {
            latestByCatItem.set(mapKey, {
                categoryId: category.id,
                itemId: matchedItem.id,
                score,
                maxScore,
                date: rowDate
            });
        }
    });

    latestByCatItem.forEach(entry => {
        const total = totals.get(entry.categoryId);
        total.score += entry.score;
        total.max += entry.maxScore;
        total.scoredItemIds.add(entry.itemId);
    });

    let weightedGrade = 0;
    let coveredWeight = 0;
    let allWeightedItemsScored = true;
    const totalWeight = categories.reduce((sum, category) => sum + category.weight, 0);
    totals.forEach(total => {
        if (total.weight > 0 && total.scoredItemIds.size < total.itemCount) {
            allWeightedItemsScored = false;
        }
        if (total.max <= 0) return;
        weightedGrade += (total.score / total.max) * 100 * total.weight;
        coveredWeight += total.weight;
    });

    return {
        grade: coveredWeight > 0 ? weightedGrade / coveredWeight : null,
        coveredWeight,
        totalWeight,
        weightsValid: Math.abs(totalWeight - 100) < 0.001,
        complete: Math.abs(totalWeight - 100) < 0.001 && coveredWeight >= totalWeight - 0.001 && allWeightedItemsScored
    };
}

function finalGradeMarkup(studentId, section, gradingPeriod) {
    const result = calculateStudentFinalGrade(studentId, section, gradingPeriod);
    if (result.grade == null) return `<span class="final-grade-empty">—</span><small>No scores</small>`;
    const covered = Number(result.coveredWeight.toFixed(2));
    const status = !result.weightsValid
        ? `Check weights · ${Number(result.totalWeight.toFixed(2))}%`
        : result.complete ? "Final" : `Running · ${covered}%`;
    return `<strong class="final-grade-value">${result.grade.toFixed(2)}%</strong>
        <small class="${result.complete ? "final-grade-complete" : "final-grade-running"}">${status}</small>`;
}

function updateFinalGradeCells() {
    const section = document.getElementById("score-section")?.value || "";
    const period = document.getElementById("score-period")?.value || "General";
    document.querySelectorAll("#score-table-body .final-grade-cell").forEach(cell => {
        cell.innerHTML = finalGradeMarkup(cell.dataset.studentId, section, period);
    });
}

function ensureScoreCategories() {
    const namesBySection = new Map();
    Object.values(state.scores).forEach(value => {
        if (value.category_id && state.gradeCategories.some(c => c.id === value.category_id)) return;
        const section = resolveSectionForScoreRow(value);
        if (state.gradeCategories.some(c => c.section === section)) return;
        const name = String(value.category_name || parseLegacyScoreSubject(value.subject).category || "").trim();
        if (!section || !name) return;
        if (!namesBySection.has(section)) namesBySection.set(section, new Set());
        namesBySection.get(section).add(name);
    });

    namesBySection.forEach((nameSet, section) => {
        const names = [...nameSet].sort();
        if (names.length === 0) return;
        const baseWeight = Math.floor((100 / names.length) * 100) / 100;
        names.forEach((name, index) => {
            state.gradeCategories.push({
                id: newCategoryId(),
                section,
                name,
                weight: index === names.length - 1
                    ? Number((100 - baseWeight * (names.length - 1)).toFixed(2))
                    : baseWeight,
                items: sanitizeCategoryItems(null, 1)
            });
        });
    });

    state.sectionGradeCategories = sanitizeSectionGradeCategories(null, state.gradeCategories);
    refreshScoreCategoryMetadata(state.gradeCategories);
}

function refreshScoreCategoryMetadata(categories) {
    const studentSectionByCode = new Map(state.students.map(s => [s.student_id, s.section]));
    const nextScores = {};
    Object.keys(state.scores).forEach(key => {
        const value = state.scores[key];
        const parsed = parseScoreKey(key);
        const studentId = value.student_id || parsed.studentId;
        const studSection = studentSectionByCode.get(studentId) || "";
        const legacy = parseLegacyScoreSubject(value.subject || parsed.subject);
        const period = value.grading_period || legacy.period;
        const oldName = value.category_name || legacy.category;
        const category = categories.find(item => item.id === value.category_id)
            || categories.find(item => !value.category_id && (!studSection || item.section === studSection) && item.name === oldName);
        const categoryId = category?.id || value.category_id || null;
        const categoryName = category?.name || oldName;
        const matchedItem = category ? resolveScoreItemForCategory(category, value) : null;
        const itemId = matchedItem?.id || value.item_id || "";
        const itemLabel = matchedItem?.label || value.item_label || "#1";
        const nextKey = makeScoreRecordKey(value.date || parsed.date, studentId, period, categoryId, categoryName, itemId);
        nextScores[nextKey] = {
            ...value,
            student_id: studentId,
            grading_period: period,
            category_id: categoryId,
            category_name: categoryName,
            category_weight: category?.weight ?? value.category_weight ?? 100,
            item_id: itemId || null,
            item_label: itemLabel
        };
    });
    state.scores = nextScores;
}

// Scores keep their own category ID/name/weight, subsection item ID/label, and
// grading-period metadata. Searches the selected date first, then falls back to
// the latest saved entry for that (student, gradingPeriod, category, item) so
// previously graded subsections stay visible on the period sheet across days.
function findScoreRecord(date, studentId, gradingPeriod, category, item = null) {
    const items = getCategoryItems(category);
    const targetItem = item || items[0];
    const isFirstItem = !targetItem || targetItem.id === items[0]?.id;
    const itemId = targetItem?.id || "";

    const exactKey = makeScoreRecordKey(date, studentId, gradingPeriod, category.id, category.name, itemId);
    if (state.scores[exactKey]) return { key: exactKey, value: state.scores[exactKey] };

    if (isFirstItem) {
        const noItemKey = makeScoreRecordKey(date, studentId, gradingPeriod, category.id, category.name, "");
        if (state.scores[noItemKey] && (!state.scores[noItemKey].item_id || state.scores[noItemKey].item_id === "item-1")) {
            return { key: noItemKey, value: state.scores[noItemKey] };
        }
        const legacyKey = makeScoreRecordKey(date, studentId, gradingPeriod, null, category.name, "");
        if (state.scores[legacyKey]) return { key: legacyKey, value: state.scores[legacyKey] };
    }

    let bestKey = null;
    let bestVal = null;
    let bestDate = "";
    Object.keys(state.scores).forEach(k => {
        const val = state.scores[k];
        const parsed = parseScoreKey(k);
        if ((val.student_id || parsed.studentId) !== studentId) return;
        const period = val.grading_period || parseLegacyScoreSubject(val.subject || parsed.subject).period;
        if (period !== gradingPeriod) return;
        const catMatches = val.category_id === category.id || (!val.category_id && val.category_name === category.name);
        if (!catMatches) return;
        const resolved = resolveScoreItemForCategory(category, val);
        if (!resolved || resolved.id !== itemId) return;
        const rowDate = String(val.date || parsed.date || "");
        if (!bestVal || rowDate >= bestDate) {
            bestKey = k;
            bestVal = val;
            bestDate = rowDate;
        }
    });
    if (bestVal) return { key: bestKey, value: bestVal };

    return { key: exactKey, value: null };
}

function loadScoreSheet() {
    const selectedDate = document.getElementById("score-date")?.value || "";
    const selectedSec = document.getElementById("score-section")?.value || "";
    const selectedPeriod = document.getElementById("score-period")?.value || "General";
    const categories = getSectionGradeCategories(selectedSec);
    const secStudents = selectedSec ? state.students.filter(s => s.section === selectedSec) : [];
    const tableBody = document.getElementById("score-table-body");
    if (!tableBody) return;

    const itemMaximums = new Map();
    let totalItemColumns = 0;
    categories.forEach(category => {
        getCategoryItems(category).forEach(item => {
            totalItemColumns++;
            const firstSavedScore = secStudents
                .map(stud => findScoreRecord(selectedDate, stud.student_id, selectedPeriod, category, item).value)
                .find(Boolean);
            const savedMaximum = Number(firstSavedScore?.max_score);
            const periodConfiguredMax = Number(item.period_max?.[selectedPeriod]);
            const resolvedMax = Number.isFinite(savedMaximum) && savedMaximum > 0
                ? savedMaximum
                : (Number.isFinite(periodConfiguredMax) && periodConfiguredMax > 0 ? periodConfiguredMax : (Number(item.max_score) > 0 ? Number(item.max_score) : 100));
            itemMaximums.set(itemMaximumKey(category.id, item.id), resolvedMax);
        });
    });

    const columnCount = totalItemColumns + 3;
    renderScoreSheetHeader(categories, itemMaximums);
    renderScoreWeightSummary(selectedSec);

    const periodLabel = selectedPeriod === "General" ? "Unassigned" : selectedPeriod;
    const badge = document.getElementById("score-period-badge");
    const subtitle = document.getElementById("score-sheet-subtitle");
    if (badge) badge.textContent = periodLabel;
    if (subtitle) {
        subtitle.textContent = selectedSec
            ? `${selectedDate || "No date"} · ${periodLabel} · ${selectedSec} · ${totalItemColumns} assessment column${totalItemColumns === 1 ? "" : "s"}`
            : "Record student scores for the selected date and section";
    }

    tableBody.innerHTML = "";
    if (!selectedSec) {
        tableBody.innerHTML = `<tr><td colspan="${columnCount}" class="text-center score-grid-empty">No sections yet. Go to <strong>Class List</strong> and click <strong>Add Section</strong> first.</td></tr>`;
        return;
    }
    if (!selectedDate) {
        tableBody.innerHTML = `<tr><td colspan="${columnCount}" class="text-center score-grid-empty">Please select a valid date above.</td></tr>`;
        return;
    }
    if (secStudents.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="${columnCount}" class="text-center score-grid-empty">No students in this section. Add students from Class List view.</td></tr>`;
        return;
    }
    if (categories.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="${columnCount}" class="text-center score-grid-empty">Open <strong>Categories &amp; Weights</strong> to add category columns for this section.</td></tr>`;
        return;
    }

    secStudents.forEach((stud, idx) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td class="text-center score-grid-index">${idx + 1}</td>
            <td class="text-center score-grid-student"><strong>${esc(stud.name)}</strong><small>${esc(stud.student_id)}</small></td>
            ${categories.flatMap(category => {
                const items = getCategoryItems(category);
                const singleClass = items.length === 1 ? " score-col-single" : "";
                return items.map(item => {
                    const record = findScoreRecord(selectedDate, stud.student_id, selectedPeriod, category, item);
                    const currentScore = record.value;
                    const currentMaxValue = Number(currentScore?.max_score);
                    const currentMaximum = Number.isFinite(currentMaxValue) && currentMaxValue > 0
                        ? currentMaxValue
                        : itemMaximums.get(itemMaximumKey(category.id, item.id));
                    const titleLabel = items.length > 1 ? `${category.name} (${item.label})` : category.name;
                    return `<td class="text-center score-grid-cell${singleClass}">
                        <input type="number" class="score-input" min="0" max="${esc(currentMaximum)}" step="any"
                            value="${currentScore ? esc(currentScore.score) : ""}" placeholder="—"
                            title="${esc(titleLabel)}: enter 0 to ${esc(currentMaximum)}"
                            aria-label="${esc(titleLabel)} score for ${esc(stud.name)}"
                            data-key="${esc(record.key)}" data-category-id="${esc(category.id)}"
                            data-item-id="${esc(item.id)}" data-max-score="${esc(currentMaximum)}"
                            onkeydown="handleScoreInputKeydown(event, this)"
                            onchange="setStudentScore('${jsArg(selectedDate)}', '${jsArg(stud.student_id)}', '${jsArg(selectedPeriod)}', '${jsArg(category.id)}', '${jsArg(item.id)}', this.value, this.dataset.maxScore)">
                    </td>`;
                });
            }).join("")}
            <td class="text-center score-grid-final final-grade-cell" data-student-id="${esc(stud.student_id)}">${finalGradeMarkup(stud.student_id, selectedSec, selectedPeriod)}</td>
        `;
        tableBody.appendChild(tr);
    });
}

function handleScoreInputKeydown(event, inputEl) {
    if (!event || !inputEl) return;
    const key = event.key;
    if (key !== "Enter" && key !== "ArrowDown" && key !== "ArrowUp") return;

    event.preventDefault();
    const row = inputEl.closest("tr");
    const catId = inputEl.dataset.categoryId || "";
    const itemId = inputEl.dataset.itemId || "";
    const targetRow = (key === "ArrowUp") ? row?.previousElementSibling : row?.nextElementSibling;
    if (targetRow) {
        const nextInput = Array.from(targetRow.querySelectorAll(".score-input")).find(
            el => (el.dataset.categoryId || "") === catId && (el.dataset.itemId || "") === itemId
        );
        if (nextInput) {
            nextInput.focus();
            if (typeof nextInput.select === "function") nextInput.select();
            return;
        }
    }
    inputEl.blur();
}

async function setStudentStatus(date, studentId, status) {
    if (!isValidDateStr(date) || !studentId) return;
    const key = `${date}_${studentId}`;
    state.attendance[key] = status;
    localMutationSeq++;
    loadAttendanceSheet();
    saveLocalStore();
    await trySync({ t: "att", date, student_id: studentId, status });
}

async function syncSectionCategoriesConfig(section) {
    if (!section || !cloudReady()) return true;
    const sectionCategories = getSectionGradeCategories(section);
    return trySync({
        t: "gradingConfig",
        section,
        categories: sectionCategories,
        selectedIds: sectionCategories.map(c => c.id)
    });
}

async function addCategorySubsection(categoryId) {
    const category = state.gradeCategories.find(item => item.id === categoryId);
    if (!category) return false;
    const items = getCategoryItems(category);
    if (items.length >= 30) {
        showToast("A category can have up to 30 subsections.", "error");
        return false;
    }
    const newItem = {
        id: newCategoryId(),
        label: `#${items.length + 1}`,
        max_score: 100,
        period_max: {}
    };
    items.push(newItem);
    localMutationSeq++;
    saveLocalStore();
    loadScoreSheet();
    await syncSectionCategoriesConfig(category.section);
    showToast(`Added ${category.name} ${newItem.label}.`, "success");
    return true;
}

async function removeCategorySubsection(categoryId, itemId) {
    const category = state.gradeCategories.find(item => item.id === categoryId);
    if (!category) return false;
    const items = getCategoryItems(category);
    if (items.length <= 1) {
        showToast("Each category keeps at least one subsection.", "error");
        return false;
    }
    const idx = items.findIndex(i => i.id === itemId);
    if (idx === -1) return false;
    const removed = items[idx];
    items.splice(idx, 1);
    items.forEach((item, index) => {
        if (/^#\d+$/.test(item.label)) item.label = `#${index + 1}`;
    });
    refreshScoreCategoryMetadata(state.gradeCategories);
    localMutationSeq++;
    saveLocalStore();
    loadScoreSheet();
    await syncSectionCategoriesConfig(category.section);
    showToast(`Removed ${category.name} ${removed.label}.`, "success");
    return true;
}

async function renameCategorySubsection(categoryId, itemId, newLabel, inputEl) {
    const category = state.gradeCategories.find(item => item.id === categoryId);
    if (!category) return false;
    const items = getCategoryItems(category);
    const idx = items.findIndex(i => i.id === itemId);
    if (idx === -1) return false;
    const cleaned = String(newLabel || "").trim().slice(0, 40) || `#${idx + 1}`;
    items[idx].label = cleaned;
    if (inputEl) inputEl.value = cleaned;
    refreshScoreCategoryMetadata(state.gradeCategories);
    localMutationSeq++;
    saveLocalStore();
    await syncSectionCategoriesConfig(category.section);
    return true;
}

async function updateScoreMaximum(categoryId, itemIdOrMax, maxOrInput, maybeInput) {
    let itemId = itemIdOrMax;
    let maxScoreValue = maxOrInput;
    let maxInput = maybeInput;
    if (maybeInput === undefined && maxOrInput && typeof maxOrInput === "object") {
        itemId = "";
        maxScoreValue = itemIdOrMax;
        maxInput = maxOrInput;
    }
    if (!maxInput) return false;

    const previousMaximum = Number(maxInput.dataset.previousValue) || 100;
    const maxScore = Number(maxScoreValue);
    if (!Number.isFinite(maxScore) || maxScore <= 0) {
        maxInput.value = String(previousMaximum);
        showToast("Max score must be greater than 0.", "error");
        return false;
    }

    const date = document.getElementById("score-date")?.value || "";
    const sec = document.getElementById("score-section")?.value || "";
    const gradingPeriod = document.getElementById("score-period")?.value || "General";
    const category = state.gradeCategories.find(item => item.id === categoryId);
    const targetItem = category
        ? (getCategoryItems(category).find(i => i.id === (itemId || maxInput.dataset.itemId)) || getCategoryItems(category)[0])
        : null;
    if (!isValidDateStr(date) || !sec || !category || !targetItem) {
        maxInput.value = String(previousMaximum);
        showToast("Select a valid date, section and category first.", "error");
        return false;
    }

    const secStudents = state.students.filter(s => s.section === sec);
    const savedRecords = secStudents.map(stud => {
        const record = findScoreRecord(date, stud.student_id, gradingPeriod, category, targetItem);
        return { ...record, studentId: stud.student_id };
    }).filter(record => record.value);

    const highestScore = savedRecords.reduce((highest, record) => {
        const value = Number(record.value.score);
        return Number.isFinite(value) ? Math.max(highest, value) : highest;
    }, 0);
    if (highestScore > maxScore) {
        maxInput.value = String(previousMaximum);
        showToast(`Max score cannot be lower than an entered score (${highestScore}).`, "error");
        return false;
    }

    if (!targetItem.period_max || typeof targetItem.period_max !== "object") {
        targetItem.period_max = {};
    }
    targetItem.period_max[gradingPeriod] = maxScore;

    maxInput.value = String(maxScore);
    maxInput.dataset.previousValue = String(maxScore);
    document.querySelectorAll("#score-table-body .score-input").forEach(input => {
        if (input.dataset.categoryId !== categoryId || input.dataset.itemId !== targetItem.id) return;
        input.max = String(maxScore);
        input.dataset.maxScore = String(maxScore);
        input.title = `${category.name} (${targetItem.label}): enter 0 to ${maxScore}`;
    });

    localMutationSeq++;
    if (savedRecords.length > 0) {
        const rows = [];
        savedRecords.forEach(record => {
            const recordDate = record.value.date || date;
            const nextKey = makeScoreRecordKey(recordDate, record.studentId, gradingPeriod, category.id, category.name, targetItem.id);
            if (record.key !== nextKey) {
                delete state.scores[record.key];
            }
            state.scores[nextKey] = {
                ...record.value,
                date: recordDate,
                student_id: record.studentId,
                subject: gradingPeriod,
                grading_period: gradingPeriod,
                category_id: category.id,
                category_name: category.name,
                category_weight: category.weight,
                item_id: targetItem.id,
                item_label: targetItem.label,
                max_score: maxScore
            };
            record.key = nextKey;
            rows.push({
                date: recordDate,
                section: category.section || sec,
                student_id: record.studentId,
                grading_period: gradingPeriod,
                category_id: category.id,
                category_name: category.name,
                category_weight: category.weight,
                item_id: targetItem.id,
                item_label: targetItem.label,
                score: Number(record.value.score),
                max_score: maxScore
            });
        });
        saveLocalStore();
        updateFinalGradeCells();

        if (cloudReady()) {
            await syncSectionCategoriesConfig(category.section || sec);
            const synced = await trySync({ t: "scrB", section: category.section || sec, rows });
            if (!synced) return false;
        }
    } else {
        saveLocalStore();
        if (cloudReady()) {
            await syncSectionCategoriesConfig(category.section || sec);
        }
    }

    showToast(savedRecords.length > 0
        ? `Max score updated to ${maxScore} for ${savedRecords.length} saved score${savedRecords.length === 1 ? "" : "s"}.`
        : `Max score set to ${maxScore}.`, "success");
    return true;
}

async function setStudentScore(date, studentId, gradingPeriod, categoryId, itemIdOrScore, scoreOrMax = 100, maybeMax) {
    let itemId = itemIdOrScore;
    let scoreValue = scoreOrMax;
    let maxScoreValue = maybeMax ?? 100;
    const category = state.gradeCategories.find(item => item.id === categoryId);
    if (!category) return false;
    const items = getCategoryItems(category);
    if (maybeMax === undefined && !items.some(i => i.id === itemIdOrScore)) {
        itemId = items[0]?.id || "";
        scoreValue = itemIdOrScore;
        maxScoreValue = scoreOrMax;
    }
    const targetItem = items.find(i => i.id === itemId) || items[0];
    if (!isValidDateStr(date) || !studentId || !gradingPeriod || !targetItem) return false;
    const labelSuffix = items.length > 1 ? ` (${targetItem.label})` : "";

    if (String(scoreValue ?? "").trim() === "") {
        const existing = findScoreRecord(date, studentId, gradingPeriod, category, targetItem);
        if (!existing.value) return false;
        const recordDate = existing.value.date || date;
        delete state.scores[existing.key];
        localMutationSeq++;
        saveLocalStore();
        updateFinalGradeCells();

        if (cloudReady()) {
            const synced = await trySync({
                t: "scr-",
                date: recordDate,
                section: category.section,
                student_id: studentId,
                grading_period: gradingPeriod,
                category_id: category.id,
                category_name: category.name,
                item_id: targetItem.id
            });
            if (!synced) return false;
        }
        showToast(`${category.name}${labelSuffix} score cleared`, "success");
        return true;
    }

    const score = Number(scoreValue);
    const maxScore = Number(maxScoreValue);
    if (!Number.isFinite(score)) return false;
    if (!Number.isFinite(maxScore) || maxScore <= 0) {
        showToast("Max score must be greater than 0.", "error");
        return false;
    }
    if (score < 0 || score > maxScore) {
        showToast(`Score must be between 0 and ${maxScore}.`, "error");
        return false;
    }

    const existing = findScoreRecord(date, studentId, gradingPeriod, category, targetItem);
    const recordDate = existing.value?.date || date;
    const key = makeScoreRecordKey(recordDate, studentId, gradingPeriod, category.id, category.name, targetItem.id);
    if (existing.value && existing.key !== key) {
        delete state.scores[existing.key];
    }
    state.scores[key] = {
        score,
        max_score: maxScore,
        date: recordDate,
        student_id: studentId,
        subject: gradingPeriod,
        grading_period: gradingPeriod,
        category_id: category.id,
        category_name: category.name,
        category_weight: category.weight,
        item_id: targetItem.id,
        item_label: targetItem.label
    };
    localMutationSeq++;
    saveLocalStore();
    updateFinalGradeCells();

    if (cloudReady()) {
        const synced = await trySync({
            t: "scr",
            date: recordDate,
            section: category.section,
            student_id: studentId,
            grading_period: gradingPeriod,
            category_id: category.id,
            category_name: category.name,
            category_weight: category.weight,
            item_id: targetItem.id,
            item_label: targetItem.label,
            score,
            max_score: maxScore
        });
        if (!synced) return false;
    }

    showToast(`${category.name}${labelSuffix} score saved: ${score}/${maxScore}`, "success");
    return true;
}

function gradingCategoryRowMarkup(category) {
    const itemCount = Array.isArray(category.items) && category.items.length > 0 ? category.items.length : 1;
    return `<div class="grading-weight-row" data-category-id="${esc(category.id)}">
        <input type="text" class="form-control grading-category-name" value="${esc(category.name)}" maxlength="60" placeholder="e.g. Written Work" aria-label="Category name">
        <input type="number" class="form-control grading-category-items" min="1" max="30" step="1" value="${esc(itemCount)}" aria-label="Subsections for ${esc(category.name || "category")}" title="Number of subsections / graded items">
        <div class="grading-weight-input">
            <input type="number" class="form-control grading-category-weight" min="0" max="100" step="0.01" value="${esc(category.weight)}" aria-label="Weight for ${esc(category.name || "category")}" oninput="updateGradingTotals()">
            <span>%</span>
        </div>
        <button type="button" class="grading-category-remove" onclick="removeGradingCategoryRow(this)" title="Remove category" aria-label="Remove ${esc(category.name || "category")}">&times;</button>
    </div>`;
}

function removeGradingCategoryRow(button) {
    const rowsContainer = document.getElementById("grading-weight-rows");
    const row = button?.closest(".grading-weight-row");
    if (!rowsContainer || !row) return;
    const allRows = rowsContainer.querySelectorAll(".grading-weight-row");
    if (allRows.length <= 1) {
        row.dataset.categoryId = newCategoryId();
        row.querySelector(".grading-category-name").value = "";
        const itemsEl = row.querySelector(".grading-category-items");
        if (itemsEl) itemsEl.value = "1";
        row.querySelector(".grading-category-weight").value = "100";
    } else {
        row.remove();
    }
    setGradingSetupError();
    updateGradingTotals();
}

function updateGradingTotals() {
    const section = document.getElementById("score-section")?.value || "Section";
    let sectionTotal = 0;
    document.querySelectorAll("#grading-weight-rows .grading-weight-row").forEach(row => {
        const weight = Number(row.querySelector(".grading-category-weight").value);
        if (!Number.isFinite(weight)) return;
        sectionTotal += weight;
    });
    const sectionElement = document.getElementById("grading-section-total");
    if (sectionElement) {
        sectionElement.textContent = `${section} total: ${Number(sectionTotal.toFixed(2))}%`;
        sectionElement.classList.toggle("invalid", Math.abs(sectionTotal - 100) > 0.001);
    }
    return { sectionTotal };
}

function setGradingSetupError(message = "") {
    const error = document.getElementById("grading-setup-error");
    if (!error) return;
    error.textContent = message;
    error.classList.toggle("hidden", !message);
}

function openGradingSetup() {
    const section = document.getElementById("score-section")?.value || "";
    if (!section) {
        showToast("Create and select a section first.", "error");
        return;
    }
    document.getElementById("grading-setup-section").textContent = `Section: ${section} · applies only to this section`;
    const sectionCategories = getSectionGradeCategories(section);
    const rows = document.getElementById("grading-weight-rows");
    rows.innerHTML = sectionCategories.length > 0
        ? sectionCategories.map(category => gradingCategoryRowMarkup(category)).join("")
        : gradingCategoryRowMarkup({ id: newCategoryId(), section, name: "", weight: 100, items: sanitizeCategoryItems(null, 1) });
    setGradingSetupError();
    updateGradingTotals();
    openModal("modal-grading-setup");
}

function addGradingCategoryRow() {
    const section = document.getElementById("score-section")?.value || "";
    const rows = document.getElementById("grading-weight-rows");
    const wrapper = document.createElement("div");
    wrapper.innerHTML = gradingCategoryRowMarkup({ id: newCategoryId(), section, name: "", weight: 0, items: sanitizeCategoryItems(null, 1) });
    const row = wrapper.firstElementChild;
    rows.appendChild(row);
    updateGradingTotals();
    row.querySelector(".grading-category-name").focus();
}

async function saveGradingSetup(event) {
    event.preventDefault();
    const section = document.getElementById("score-section")?.value || "";
    const rowElements = Array.from(document.querySelectorAll("#grading-weight-rows .grading-weight-row"));
    if (!section || rowElements.length === 0) {
        setGradingSetupError("Add at least one grading category.");
        return;
    }

    const categories = [];
    const names = new Set();
    for (const row of rowElements) {
        const id = row.dataset.categoryId;
        const name = row.querySelector(".grading-category-name").value.trim();
        const itemCountRaw = Number(row.querySelector(".grading-category-items")?.value ?? 1);
        const weight = Number(row.querySelector(".grading-category-weight").value);
        const nameKey = name.toLowerCase();
        if (!name || name.length > 60) {
            setGradingSetupError("Every category needs a name of 60 characters or fewer.");
            return;
        }
        if (names.has(nameKey)) {
            setGradingSetupError(`Category names in ${section} must be unique: ${name}.`);
            return;
        }
        if (!Number.isInteger(itemCountRaw) || itemCountRaw < 1 || itemCountRaw > 30) {
            setGradingSetupError(`Enter 1 to 30 subsections for ${name}.`);
            return;
        }
        if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
            setGradingSetupError(`Enter a weight from 0 to 100 for ${name}.`);
            return;
        }
        const existingCategory = state.gradeCategories.find(c => c.id === id);
        const existingItems = existingCategory ? sanitizeCategoryItems(existingCategory.items) : [];
        const items = existingItems.slice(0, itemCountRaw);
        while (items.length < itemCountRaw) {
            items.push({
                id: newCategoryId(),
                label: `#${items.length + 1}`,
                max_score: 100,
                period_max: {}
            });
        }
        names.add(nameKey);
        categories.push({ id, section, name, weight, items });
    }

    const sectionTotal = categories.reduce((sum, category) => sum + category.weight, 0);
    if (Math.abs(sectionTotal - 100) > 0.001) {
        setGradingSetupError(`Category weights for ${section} must total 100%. Current total: ${Number(sectionTotal.toFixed(2))}%.`);
        return;
    }

    state.gradeCategories = [
        ...state.gradeCategories.filter(category => category.section !== section),
        ...categories
    ];
    state.sectionGradeCategories = sanitizeSectionGradeCategories(null, state.gradeCategories);
    refreshScoreCategoryMetadata(state.gradeCategories);
    localMutationSeq++;
    saveLocalStore();
    closeModal("modal-grading-setup");
    loadScoreSheet();

    if (cloudReady()) {
        const synced = await trySync({
            t: "gradingConfig",
            section,
            categories,
            selectedIds: categories.map(c => c.id)
        });
        if (!synced) return;
    }
    showToast(`Grading setup saved for ${section}.`, "success");
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

    localMutationSeq++;
    saveLocalStore();
    loadAttendanceSheet();

    await trySync({ t: "attB", rows });
    if (cloudReady()) showToast(`Marked all as ${status}`, "success");
    else showToast(`Marked all as ${status} (saved on this device)`, "success");
}

async function saveAttendance() {
    const date = document.getElementById("att-date")?.value;
    const sec = document.getElementById("att-section")?.value;

    if (!sec) {
        showToast("Please create and select a section first.", "error");
        return;
    }
    if (!isValidDateStr(date)) {
        showToast("Please select a valid date before saving.", "error");
        return;
    }

    const secStudents = state.students.filter(s => s.section === sec);
    if (secStudents.length === 0) {
        showToast("No students in this section to save.", "error");
        return;
    }

    // Default anyone untouched in the sheet to Present, then save the whole
    // selected day/section (not every historical row) in one batch.
    const rows = secStudents.map(stud => {
        const key = `${date}_${stud.student_id}`;
        if (!state.attendance[key]) state.attendance[key] = "Present";
        return { date, student_id: stud.student_id, status: state.attendance[key] };
    });

    localMutationSeq++;
    saveLocalStore();
    loadAttendanceSheet();

    if (!cloudReady()) {
        showToast("Attendance saved on this device (offline).", "success");
        return;
    }

    try {
        await flushPendingOps();
        await runWithSessionRetry({ t: "attB", rows });
        showToast(`Attendance saved and synced to the cloud (${rows.length} students).`, "success");
    } catch (err) {
        console.error("Saving attendance failed:", err);
        queueOp({ t: "attB", rows });
        showToast("Saved on this device — it will sync automatically when you're back online.", "error");
    }
}

function currentTeacherLabel() {
    if (!currentUser) return "";
    const meta = currentUser.user_metadata || {};
    if (meta.full_name) return meta.full_name;
    return (currentUser.email || "").split("@")[0];
}

// jsPDF + AutoTable are ~400 KB and are only needed when a teacher exports a
// report, so they are fetched on first use instead of on every page load.
function loadPdfLibraries() {
    const loadScript = (src) => new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-scholog-lib="${src}"]`);
        if (existing) {
            if (existing.dataset.loaded === "true") return resolve();
            existing.addEventListener("load", () => resolve());
            existing.addEventListener("error", () => reject(new Error(src)));
            return;
        }
        const script = document.createElement("script");
        script.src = src;
        script.async = false;
        script.dataset.schologLib = src;
        script.addEventListener("load", () => {
            script.dataset.loaded = "true";
            resolve();
        });
        script.addEventListener("error", () => reject(new Error(src)));
        document.head.appendChild(script);
    });

    return loadScript("vendor/jspdf.umd.min.js").then(() => loadScript("vendor/jspdf.autotable.min.js"));
}

function exportAttendanceToPDF() {
    const jsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDF) {
        if (window.__pdfLibrariesLoading) return;
        window.__pdfLibrariesLoading = true;
        loadPdfLibraries()
            .then(() => {
                window.__pdfLibrariesLoading = false;
                exportAttendanceToPDF();
            })
            .catch(() => {
                window.__pdfLibrariesLoading = false;
                showToast("Could not load the PDF library. Check your connection and try again.", "error");
            });
        return;
    }
    if (!window.SchologPdf) {
        showToast("PDF helper is unavailable. Please refresh the page.", "error");
        return;
    }

    const date = document.getElementById("att-date").value;
    const sec = document.getElementById("att-section").value;
    if (!sec || !date) {
        showToast("Select a valid date and section before exporting.", "error");
        return;
    }

    const secStudents = state.students.filter(s => s.section === sec);
    if (secStudents.length === 0) {
        showToast("There are no students in this section to export.", "error");
        return;
    }

    try {
        const doc = new jsPDF();
        const result = window.SchologPdf.buildDailyAttendancePdf(doc, {
            section: sec,
            date,
            students: secStudents,
            attendance: state.attendance,
            generatedAt: new Date(),
            teacher: currentTeacherLabel()
        });
        doc.save(result.filename);
        showToast(`Daily PDF exported (${secStudents.length} students).`, "success");
    } catch (err) {
        console.error("Daily PDF export failed:", err);
        showToast(err && err.message ? err.message : "Could not build the daily PDF.", "error");
    }
}

function csvEscapeCell(val) {
    const str = String(val ?? "");
    if (/[",\r\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

function triggerCsvSave(filename, rows) {
    const csvBody = "\uFEFF" + rows.map(row => row.map(csvEscapeCell).join(",")).join("\r\n");
    const blob = new Blob([csvBody], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function saveScoreSheetCsv() {
    const date = document.getElementById("score-date")?.value || todayStr();
    const sec = document.getElementById("score-section")?.value || "";
    const period = document.getElementById("score-period")?.value || "General";
    if (!sec) {
        showToast("Please select a section first.", "error");
        return;
    }
    const secStudents = state.students.filter(s => s.section === sec);
    if (secStudents.length === 0) {
        showToast("There are no students in this section to save.", "error");
        return;
    }
    const categories = getSectionGradeCategories(sec);
    if (categories.length === 0) {
        showToast("Configure grading categories for this section first.", "error");
        return;
    }

    const periodLabel = period === "General" ? "Unassigned" : period;
    const colDescriptors = [];
    categories.forEach(cat => {
        const items = getCategoryItems(cat);
        items.forEach(item => {
            const firstSaved = secStudents
                .map(stud => findScoreRecord(date, stud.student_id, period, cat, item).value)
                .find(Boolean);
            const configuredMax = Number(item.period_max?.[period]) || Number(item.max_score) || 100;
            const maxVal = Number(firstSaved?.max_score) > 0 ? Number(firstSaved.max_score) : configuredMax;
            const colTitle = items.length > 1
                ? `${cat.name} - ${item.label} (Max ${maxVal})`
                : `${cat.name} (Max ${maxVal})`;
            colDescriptors.push({ cat, item, maxVal, colTitle });
        });
    });

    const header = [
        "Student ID",
        "Student Name",
        "Section",
        "Grading Period",
        ...colDescriptors.map(d => d.colTitle),
        "Computed Grade (%)",
        "Status"
    ];
    const rows = [header];

    secStudents.forEach(stud => {
        const itemCells = colDescriptors.map(({ cat, item }) => {
            const rec = findScoreRecord(date, stud.student_id, period, cat, item);
            return rec.value ? rec.value.score : "";
        });
        const finalRes = calculateStudentFinalGrade(stud.student_id, sec, period);
        const gradeCell = finalRes.grade != null ? finalRes.grade.toFixed(2) : "";
        const statusCell = finalRes.grade == null
            ? "No scores"
            : (!finalRes.weightsValid ? "Check weights" : (finalRes.complete ? "Final" : `Running (${Number(finalRes.coveredWeight.toFixed(2))}%)`));
        rows.push([
            stud.student_id,
            stud.name,
            stud.section,
            periodLabel,
            ...itemCells,
            gradeCell,
            statusCell
        ]);
    });

    const safeSec = sec.replace(/[^a-z0-9_-]+/gi, "_");
    const safePeriod = periodLabel.replace(/[^a-z0-9_-]+/gi, "_");
    triggerCsvSave(`Grades_${safeSec}_${safePeriod}_${date}.csv`, rows);
    showToast(`Grades CSV saved (${secStudents.length} students).`, "success");
}

// --- Cloud refresh (picks up QR / Student-ID check-ins saved by students) ---
let lastCloudSyncAt = 0;

function openQrCheckInPage() {
    // Carry the section/date the teacher is already looking at so the
    // check-in page opens ready to go (no re-selecting anything).
    const section = document.getElementById("att-section")?.value || "";
    const date = document.getElementById("att-date")?.value || "";
    const url = new URL("scan.html", window.location.href);
    if (section) url.searchParams.set("section", section);
    if (date && isValidDateStr(date)) url.searchParams.set("date", date);
    window.open(url.href, "_blank", "noopener");
}

// Pull the newest data from Supabase without clobbering queued offline changes
// or an attendance edit the teacher made while the request was in flight.
// Returns "synced", "skipped" (local work present) or "offline".
async function syncLatestFromCloud() {
    if (!cloudReady()) return "offline";

    let queued = [];
    try { queued = JSON.parse(localStorage.getItem(pendingKey()) || "[]"); } catch (err) { queued = []; }
    if (Array.isArray(queued) && queued.length > 0) return "skipped";

    const seqBefore = localMutationSeq;
    const snapshot = await fetchCloudState();
    if (seqBefore !== localMutationSeq) return "skipped";

    applyCloudState(snapshot);
    saveLocalStore();
    populateSectionDropdowns();
    loadAttendanceSheet();
    if (activeTab === "scores") loadScoreSheet();
    if (activeTab === "dashboard") renderDashboard();
    if (activeTab === "directory") renderDirectory();

    lastCloudSyncAt = Date.now();
    refreshIcons();
    return "synced";
}

async function refreshAttendanceFromCloud() {
    if (!cloudReady()) {
        showToast("Connect to the internet to refresh check-ins.", "error");
        return;
    }
    try {
        const result = await syncLatestFromCloud();
        if (result === "synced") showToast("Latest attendance loaded.", "success");
        else if (result === "skipped") showToast("You have unsaved changes — refresh skipped so nothing is lost.", "error");
    } catch (err) {
        console.error("Refresh failed:", err);
        showToast("Could not refresh attendance right now.", "error");
    }
}

// --- Modals & Actions ---
// Dialogs are announced with role="dialog"/aria-modal, so focus must move into
// them on open and return to the trigger on close for keyboard users.
let lastFocusedElement = null;

function openModal(id) {
    const dialog = document.getElementById(id);
    if (!dialog) return;
    lastFocusedElement = document.activeElement;
    dialog.classList.remove("hidden");
    // Prefer the first real field; fall back to the close button.
    const focusTarget = dialog.querySelector(
        "input:not([type='hidden']):not([disabled]), select, textarea"
    ) || dialog.querySelector(".close-btn");
    if (focusTarget) setTimeout(() => focusTarget.focus(), 0);
}

function closeModal(id) {
    const dialog = document.getElementById(id);
    if (!dialog) return;
    dialog.classList.add("hidden");
    if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
        try { lastFocusedElement.focus(); } catch (_) { /* element is gone */ }
    }
    lastFocusedElement = null;
}

document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" && event.key !== "Esc") return;
    const openDialogs = Array.from(document.querySelectorAll(".modal-backdrop:not(.hidden)"));
    if (!openDialogs.length) return;
    event.preventDefault();
    openDialogs.forEach((dialog) => {
        const closeBtn = dialog.querySelector(".close-btn");
        if (closeBtn) closeBtn.click();
        else dialog.classList.add("hidden");
    });
});

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
            state.gradeCategories.forEach(category => {
                if (category.section === oldName) category.section = newName;
            });
            state.sectionGradeCategories = sanitizeSectionGradeCategories(null, state.gradeCategories);

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

function relinkStudentRecordsLocally(oldCode, newCode) {
    if (!oldCode || !newCode || oldCode === newCode) return;
    const relinkedAtt = {};
    Object.keys(state.attendance).forEach(k => {
        const { date, studentId } = parseAttKey(k);
        relinkedAtt[`${date}_${studentId === oldCode ? newCode : studentId}`] = state.attendance[k];
    });
    state.attendance = relinkedAtt;

    const relinkedScores = {};
    Object.keys(state.scores).forEach(k => {
        const val = state.scores[k];
        const parsed = parseScoreKey(k);
        const sid = val?.student_id || parsed.studentId;
        if (sid === oldCode) {
            const period = val.grading_period || parseLegacyScoreSubject(val.subject || parsed.subject).period;
            const nextKey = makeScoreRecordKey(
                val.date || parsed.date,
                newCode,
                period,
                val.category_id,
                val.category_name,
                val.item_id || ""
            );
            relinkedScores[nextKey] = {
                ...val,
                student_id: newCode
            };
        } else {
            relinkedScores[k] = val;
        }
    });
    state.scores = relinkedScores;
}

function removeStudentRecordsLocally(code) {
    if (!code) return;
    Object.keys(state.attendance).forEach(k => {
        if (parseAttKey(k).studentId === code) delete state.attendance[k];
    });
    Object.keys(state.scores).forEach(k => {
        const val = state.scores[k];
        const sid = val?.student_id || parseScoreKey(k).studentId;
        if (sid === code) delete state.scores[k];
    });
}

function switchStudentModalMode(mode) {
    const singleForm = document.getElementById("form-student");
    const bulkForm = document.getElementById("form-student-bulk") || document.getElementById("form-bulk-student");
    const singleTab = document.getElementById("tab-student-single");
    const bulkTab = document.getElementById("tab-student-bulk");
    const titleEl = document.getElementById("student-modal-title");

    const isBulk = mode === "bulk";
    if (singleForm) singleForm.classList.toggle("hidden", isBulk);
    if (bulkForm) bulkForm.classList.toggle("hidden", !isBulk);
    if (singleTab) singleTab.classList.toggle("active", !isBulk);
    if (bulkTab) bulkTab.classList.toggle("active", isBulk);
    if (titleEl && !document.getElementById("student-edit-id")?.value) {
        titleEl.textContent = isBulk ? "Bulk Add Students" : "Add New Student";
    }
    if (isBulk) updateBulkStudentPreview();
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
    (document.getElementById("student-modal-tabs") || document.getElementById("student-modal-mode-tabs"))?.classList.remove("hidden");
    switchStudentModalMode("single");
    populateSectionDropdowns();
    if (selectedDirectorySection !== "ALL" && state.sections.includes(selectedDirectorySection)) {
        document.getElementById("stud-section").value = selectedDirectorySection;
        const bulkSec = document.getElementById("bulk-stud-section");
        if (bulkSec) bulkSec.value = selectedDirectorySection;
    }
    openModal("modal-student");
}

function openBulkStudentModal() {
    if (state.sections.length === 0) {
        showToast("Add a section first (e.g. Grade 11 - STEM), then import students into it.", "error");
        openAddSectionModal();
        return;
    }
    document.getElementById("student-edit-id").value = "";
    (document.getElementById("form-student-bulk") || document.getElementById("form-bulk-student"))?.reset();
    (document.getElementById("student-modal-tabs") || document.getElementById("student-modal-mode-tabs"))?.classList.remove("hidden");
    populateSectionDropdowns();
    if (selectedDirectorySection !== "ALL" && state.sections.includes(selectedDirectorySection)) {
        const bulkSec = document.getElementById("bulk-stud-section");
        if (bulkSec) bulkSec.value = selectedDirectorySection;
        document.getElementById("stud-section").value = selectedDirectorySection;
    }
    switchStudentModalMode("bulk");
    updateBulkStudentPreview();
    openModal("modal-student");
}

function parseCsvRowCells(line) {
    if (line.includes("\t")) {
        return line.split("\t").map(c => c.trim().replace(/^"|"$/g, ""));
    }
    const cells = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                cur += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === "," && !inQuotes) {
            cells.push(cur.trim());
            cur = "";
        } else {
            cur += ch;
        }
    }
    cells.push(cur.trim());
    return cells;
}

function parseBulkStudentLines(rawText) {
    const lines = String(rawText || "")
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean);

    const parsed = [];
    const errors = [];
    const seenCodes = new Set();

    lines.forEach((line, idx) => {
        const cells = parseCsvRowCells(line).filter(c => c !== "");
        if (cells.length === 0) return;

        // Skip header row if detected
        if (idx === 0) {
            const joinedLower = cells.join(" ").toLowerCase();
            if (
                (joinedLower.includes("name") && (joinedLower.includes("id") || joinedLower.includes("code") || joinedLower.includes("student"))) ||
                joinedLower === "full name" ||
                joinedLower === "student id"
            ) {
                return;
            }
        }

        if (cells.length < 2) {
            errors.push(`Row ${idx + 1}: Needs both Full Name and Student ID`);
            return;
        }

        let name = "";
        let student_id = "";
        let email = "";

        const emailIdx = cells.findIndex(c => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c));
        if (emailIdx !== -1 && cells.length >= 3) {
            email = cells[emailIdx];
        }

        const remaining = cells.filter((_, i) => i !== emailIdx);
        const firstLooksLikeId = /^[0-9A-Z_-]{3,24}$/i.test(remaining[0]) && /\d/.test(remaining[0]) && !remaining[0].includes(" ");
        const secondLooksLikeId = /^[0-9A-Z_-]{3,24}$/i.test(remaining[1]) && /\d/.test(remaining[1]) && !remaining[1].includes(" ");

        if (firstLooksLikeId && !secondLooksLikeId) {
            student_id = remaining[0].trim();
            name = remaining[1].trim();
        } else {
            name = remaining[0].trim();
            student_id = remaining[1].trim();
        }

        if (!email && remaining[2] && remaining[2].includes("@")) {
            email = remaining[2].trim();
        }

        if (!name || !student_id) {
            errors.push(`Row ${idx + 1}: Missing name or ID`);
            return;
        }

        const codeUpper = student_id.toLowerCase();
        if (seenCodes.has(codeUpper)) {
            errors.push(`Row ${idx + 1}: Duplicate ID "${student_id}" in list`);
            return;
        }
        seenCodes.add(codeUpper);
        parsed.push({ name, student_id, email });
    });

    return { parsed, errors };
}

function updateBulkStudentPreview() {
    const textarea = document.getElementById("bulk-stud-text") || document.getElementById("bulk-stud-textarea");
    const summaryEl = document.getElementById("bulk-preview-count") || document.getElementById("bulk-stud-preview");
    if (!summaryEl) return;

    const { parsed, errors } = parseBulkStudentLines(textarea?.value || "");
    if (parsed.length === 0 && errors.length === 0) {
        summaryEl.textContent = "0 students ready to import.";
        summaryEl.className = "bulk-preview-summary";
        return;
    }

    const existingUpdateCount = parsed.filter(r => state.students.some(s => s.student_id === r.student_id)).length;
    const newCount = parsed.length - existingUpdateCount;
    const parts = [`${parsed.length} student${parsed.length === 1 ? "" : "s"} ready (${newCount} new${existingUpdateCount > 0 ? `, ${existingUpdateCount} update` : ""})`];
    if (errors.length > 0) {
        parts.push(`${errors.length} skipped (${errors[0]})`);
    }
    summaryEl.textContent = parts.join(" · ");
    summaryEl.className = `bulk-preview-summary ${errors.length > 0 ? "has-warning" : "has-ready"}`;
}

function handleBulkCsvFile(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
        const textarea = document.getElementById("bulk-stud-text") || document.getElementById("bulk-stud-textarea");
        if (textarea) {
            textarea.value = String(evt.target?.result || "");
            updateBulkStudentPreview();
        }
    };
    reader.readAsText(file);
}

async function handleBulkStudentSubmit(e) {
    e.preventDefault();
    const sec = document.getElementById("bulk-stud-section")?.value || "";
    const textarea = document.getElementById("bulk-stud-text") || document.getElementById("bulk-stud-textarea");
    const rawText = textarea?.value || "";

    if (!sec) {
        showToast("Please select a target section first.", "error");
        return;
    }

    const { parsed, errors } = parseBulkStudentLines(rawText);
    if (parsed.length === 0) {
        showToast(errors[0] || "Paste at least one student row (Full Name, Student ID).", "error");
        return;
    }

    const syncRows = [];
    parsed.forEach(row => {
        const existing = state.students.find(s => s.student_id === row.student_id);
        if (existing) {
            existing.name = row.name;
            existing.section = sec;
            if (row.email) existing.email = row.email;
        } else {
            state.students.push({
                id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: row.name,
                student_id: row.student_id,
                section: sec,
                email: row.email || ""
            });
        }
        syncRows.push({
            student_id: row.student_id,
            name: row.name,
            email: row.email || "",
            section: sec
        });
    });

    localMutationSeq++;
    saveLocalStore();
    closeModal("modal-student");
    renderDirectory();
    showToast(`Imported ${syncRows.length} student${syncRows.length === 1 ? "" : "s"} into ${sec}!`, "success");
    await trySync({ t: "stuB+", rows: syncRows });
}

function openEditStudentModal(id) {
    const stud = state.students.find(s => s.id === id);
    if (!stud) {
        showToast("Student not found — the list may have changed. Please try again.", "error");
        return;
    }
    populateSectionDropdowns();
    (document.getElementById("student-modal-tabs") || document.getElementById("student-modal-mode-tabs"))?.classList.add("hidden");
    switchStudentModalMode("single");
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
            relinkStudentRecordsLocally(oldCode, studId);
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
        removeStudentRecordsLocally(code);

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
        const secCategoryIds = new Set(
            state.gradeCategories.filter(c => c.section === sec).map(c => c.id)
        );

        state.students = state.students.filter(s => s.section !== sec);
        Object.keys(state.attendance).forEach(k => {
            if (codes.includes(parseAttKey(k).studentId)) delete state.attendance[k];
        });
        Object.keys(state.scores).forEach(k => {
            const val = state.scores[k];
            const sid = val?.student_id || parseScoreKey(k).studentId;
            if (codes.includes(sid) || (val?.category_id && secCategoryIds.has(val.category_id))) {
                delete state.scores[k];
            }
        });
        state.sections = state.sections.filter(s => s !== sec);
        state.gradeCategories = state.gradeCategories.filter(c => c.section !== sec);
        state.sectionGradeCategories = sanitizeSectionGradeCategories(null, state.gradeCategories);
        selectedDirectorySection = "ALL";

        saveLocalStore();
        closeModal("modal-delete-section");
        renderDirectory();
        showToast("Section and its records deleted", "success");
        await trySync({ t: "sec-", name: sec, codes });
    };
    openModal("modal-delete-section");
}

// --- Student QR ID cards ---
// The payload is intentionally just the student code with a SCHOLOG: prefix;
// scan.html accepts it both from the camera and from typed input.
function studentQrPayload(studentId) {
    return `SCHOLOG:${String(studentId || "").trim()}`;
}

function buildQrSvgMarkup(payload, cellSize = 5) {
    if (typeof window.qrcode !== "function") return "";
    try {
        const qr = window.qrcode(0, "M");
        qr.addData(payload);
        qr.make();
        return qr.createSvgTag({ cellSize, margin: 4, scalable: true });
    } catch (err) {
        console.error("Could not build the student QR code:", err);
        return "";
    }
}

function openStudentQr(id) {
    const stud = state.students.find(s => s.id === id);
    if (!stud) {
        showToast("Student not found — the list may have changed.", "error");
        return;
    }

    const modalBox = document.getElementById("modal-student-qr-content") || document.getElementById("modal-student-qr-box");
    const singleWrap = document.getElementById("student-qr-single");
    const bulkWrap = document.getElementById("student-qr-bulk");
    const titleEl = document.getElementById("student-qr-modal-title") || document.getElementById("student-qr-title");
    const container = document.getElementById("student-qr-canvas");
    if (!container) return;

    modalBox?.classList.remove("modal-qr-bulk-mode");
    singleWrap?.classList.remove("hidden");
    if (bulkWrap) {
        bulkWrap.classList.add("hidden");
        bulkWrap.innerHTML = "";
    }
    if (titleEl) titleEl.textContent = "Student Check-In QR";

    container.innerHTML = "";
    const payload = studentQrPayload(stud.student_id);
    const svg = buildQrSvgMarkup(payload, 5);
    if (!svg) {
        container.textContent = typeof window.qrcode !== "function"
            ? "QR generator unavailable — students can type their Student ID instead."
            : "Could not build the QR code — students can type their Student ID instead.";
    } else {
        container.innerHTML = svg;
        container.dataset.payload = payload;
    }

    document.getElementById("student-qr-name").textContent = stud.name;
    document.getElementById("student-qr-code").textContent = stud.student_id;
    openModal("modal-student-qr");
    refreshIcons();
}

function openSectionQrModal(sectionFilter = "ALL") {
    const targetSec = sectionFilter || selectedDirectorySection || "ALL";
    const list = state.students.filter(s => targetSec === "ALL" || s.section === targetSec);
    if (list.length === 0) {
        showToast("No students in this view to generate QR cards for.", "error");
        return;
    }

    const modalBox = document.getElementById("modal-student-qr-content") || document.getElementById("modal-student-qr-box");
    const singleWrap = document.getElementById("student-qr-single");
    const bulkWrap = document.getElementById("student-qr-bulk");
    const titleEl = document.getElementById("student-qr-modal-title") || document.getElementById("student-qr-title");
    if (!bulkWrap) return;

    modalBox?.classList.add("modal-qr-bulk-mode");
    singleWrap?.classList.add("hidden");
    bulkWrap.classList.remove("hidden");
    if (titleEl) {
        titleEl.textContent = targetSec === "ALL"
            ? `All Student QR Cards (${list.length})`
            : `${targetSec} — QR Cards (${list.length})`;
    }

    bulkWrap.innerHTML = list.map(stud => {
        const payload = studentQrPayload(stud.student_id);
        const svg = buildQrSvgMarkup(payload, 4);
        return `
            <div class="bulk-qr-card-item" data-student-id="${esc(stud.student_id)}">
                <div class="bulk-qr-svg">${svg || `<span class="font-mono">${esc(payload)}</span>`}</div>
                <strong class="bulk-qr-name">${esc(stud.name)}</strong>
                <span class="bulk-qr-code font-mono">${esc(stud.student_id)}</span>
                <small class="bulk-qr-sec">${esc(stud.section)}</small>
            </div>
        `;
    }).join("");

    openModal("modal-student-qr");
    refreshIcons();
}

function printStudentQr() {
    window.print();
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
                        const restored = await pushFullStateToCloud();
                        const counts = `${restored.students} students, ${restored.attendance} attendance records, ${restored.scores} scores`;
                        if (restored.skippedScores > 0) {
                            showToast(`Backup restored with ${counts}. ${restored.skippedScores} score(s) could not be saved — they are still in your backup file and local copy.`, "error");
                        } else {
                            showToast(`Backup restored: ${counts}.`, "success");
                        }
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