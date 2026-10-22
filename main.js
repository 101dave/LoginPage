// Supabase Configuration
const SUPABASE_URL = "https://jwjivkdgzxuaecplkkad.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3aml2a2Rnenh1YWVjcGxra2FkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2NTU0NzcsImV4cCI6MjEwODIzMTQ3N30.VTFzl7FlP0apBo5ngnclq3eA9aDE-o3I560-XHSiDKg";

let supabaseClient = null;
if (window.supabase) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// App State
let currentUser = null;
let activeTab = "dashboard";
let selectedDirectorySection = "ALL";
let historyStudentId = null;
let historyCurrentDate = new Date();
let cloudHasData = false;

let state = {
    sections: [],
    students: [],
    attendance: {}
};

// --- Helpers ---

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

function normalizeState(raw) {
    const sections = Array.isArray(raw.sections)
        ? [...new Set(raw.sections.map(s => String(s).trim()).filter(Boolean))]
        : [];

    const seenCodes = new Set();
    const students = (Array.isArray(raw.students) ? raw.students : [])
        .map((s, idx) => ({
            id: s.id != null ? String(s.id) : `s${idx}-${Date.now()}`,
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

    const attendance = {};
    const rawAtt = (raw.attendance && typeof raw.attendance === "object") ? raw.attendance : {};
    Object.keys(rawAtt).forEach(k => {
        const { date, studentId } = parseAttKey(k);
        if (/^\d{4}-\d{2}-\d{2}$/.test(date) && rawAtt[k]) {
            attendance[k] = rawAtt[k];
        }
    });

    return { sections, students, attendance };
}

// --- Initialization ---
document.addEventListener("DOMContentLoaded", async () => {
    await checkAuth();
    initDateInput();
    refreshIcons();
    switchTab("dashboard");
});

async function checkAuth() {
    if (supabaseClient) {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session) {
            currentUser = session.user;
            setProfileUI(session.user.email, session.user.user_metadata?.full_name || session.user.email.split("@")[0]);
            await loadSupabaseData();
            await migrateLocalDataToCloud();
            saveLocalStore(); // cache cloud data locally so the app still opens offline
            return;
        }
    }
    fallbackAuth();
}

async function fallbackAuth() {
    const localUser = localStorage.getItem("scholog_local_user");
    if (localUser) {
        const parsed = JSON.parse(localUser);
        currentUser = { id: "local-user", email: parsed.email };
        setProfileUI(parsed.email, parsed.name || "Teacher");
        loadLocalStore();
    } else {
        window.location.href = "index.html";
    }
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
    localStorage.setItem(cacheKey(), JSON.stringify(state));
}

// --- Supabase Data Sync ---
async function loadSupabaseData() {
    if (!cloudReady()) return;

    try {
        const { data: secData, error: secErr } = await supabaseClient
            .from("sections")
            .select("*")
            .eq("user_id", currentUser.id)
            .order("id", { ascending: true });
        if (secErr) throw secErr;

        const { data: studData, error: studErr } = await supabaseClient
            .from("students")
            .select("*")
            .eq("user_id", currentUser.id)
            .order("id", { ascending: true });
        if (studErr) throw studErr;

        const { data: attData, error: attErr } = await supabaseClient
            .from("attendance")
            .select("*")
            .eq("user_id", currentUser.id);
        if (attErr) throw attErr;

        state.sections = (secData || []).map(s => s.name);
        state.students = (studData || []).map(s => ({
            id: s.id.toString(),
            student_id: s.student_id,
            name: s.name,
            email: s.email,
            section: s.section
        }));
        state.attendance = {};
        (attData || []).forEach(row => {
            state.attendance[`${row.date}_${row.student_id}`] = row.status;
        });

        cloudHasData = state.sections.length > 0
            || state.students.length > 0
            || Object.keys(state.attendance).length > 0;
    } catch (err) {
        reportDbError("loading your data", err);
        loadLocalStore(); // offline fallback: show the last cached copy
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
        const parsed = JSON.parse(legacy);
        const candidate = normalizeState(parsed);
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

    // Deletion order respects the data dependencies
    const delAtt = await supabaseClient.from("attendance").delete().eq("user_id", currentUser.id);
    if (delAtt.error) throw delAtt.error;
    const delStud = await supabaseClient.from("students").delete().eq("user_id", currentUser.id);
    if (delStud.error) throw delStud.error;
    const delSec = await supabaseClient.from("sections").delete().eq("user_id", currentUser.id);
    if (delSec.error) throw delSec.error;

    if (state.sections.length > 0) {
        const { error } = await supabaseClient.from("sections").insert(
            state.sections.map(name => ({ user_id: currentUser.id, name }))
        );
        if (error) throw error;
    }

    if (state.students.length > 0) {
        const { data, error } = await supabaseClient.from("students").insert(
            state.students.map(s => ({
                user_id: currentUser.id,
                student_id: s.student_id,
                name: s.name,
                email: s.email || null,
                section: s.section
            }))
        ).select("id, student_id");
        if (error) throw error;

        // Remap local ids to the database-generated ones
        const idByCode = {};
        (data || []).forEach(r => { idByCode[r.student_id] = String(r.id); });
        state.students.forEach(s => {
            if (idByCode[s.student_id]) s.id = idByCode[s.student_id];
        });
    }

    const attRows = Object.keys(state.attendance).map(k => {
        const { date, studentId } = parseAttKey(k);
        return { user_id: currentUser.id, date, student_id: studentId, status: state.attendance[k] };
    });
    for (let i = 0; i < attRows.length; i += 500) {
        const { error } = await supabaseClient.from("attendance").insert(attRows.slice(i, i + 500));
        if (error) throw error;
    }
}

// Upsert every attendance record (used by the Save button as a safety net).
async function syncAllAttendance() {
    const rows = Object.keys(state.attendance).map(k => {
        const { date, studentId } = parseAttKey(k);
        return { user_id: currentUser.id, date, student_id: studentId, status: state.attendance[k] };
    });
    for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabaseClient
            .from("attendance")
            .upsert(rows.slice(i, i + 500), { onConflict: "user_id,date,student_id" });
        if (error) throw error;
    }
}

function setProfileUI(email, name) {
    const nameElem = document.getElementById("userNameDisplay");
    const avatarElem = document.getElementById("userAvatar");
    const modalAvatar = document.getElementById("modalPreviewAvatar");
    const nameInput = document.getElementById("profile-display-name");

    if (nameElem) nameElem.textContent = name;
    if (avatarElem) avatarElem.textContent = name.charAt(0).toUpperCase();
    if (modalAvatar) modalAvatar.textContent = name.charAt(0).toUpperCase();
    if (nameInput) nameInput.value = name;
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
    if (supabaseClient) {
        await supabaseClient.auth.signOut();
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
        if (status === "Present") presentToday++;
        if (status === "Absent") absentToday++;
    });

    const rate = totalStudents > 0 ? Math.round((presentToday / totalStudents) * 100) : 0;

    document.getElementById("stat-total").textContent = totalStudents;
    document.getElementById("stat-present").textContent = presentToday;
    document.getElementById("stat-absent").textContent = absentToday;
    document.getElementById("stat-rate").textContent = `${rate}%`;

    const container = document.getElementById("section-breakdown-container");
    container.innerHTML = "";

    state.sections.forEach(sec => {
        const secStudents = state.students.filter(s => s.section === sec);
        let secPresent = 0;
        secStudents.forEach(s => {
            if (state.attendance[`${today}_${s.student_id}`] === "Present") secPresent++;
        });
        const secRate = secStudents.length > 0 ? Math.round((secPresent / secStudents.length) * 100) : 0;

        const item = document.createElement("div");
        item.className = "breakdown-item";
        item.innerHTML = `
            <div class="breakdown-info">
                <h3>${sec}</h3>
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
        btn.innerHTML = `${sec} <span class="badge-count">${count}</span>`;
        container.appendChild(btn);
    });

    const searchQuery = (document.getElementById("directory-search")?.value || "").toLowerCase();
    const tableBody = document.getElementById("directory-table-body");
    tableBody.innerHTML = "";

    const banner = document.getElementById("directory-section-banner");
    banner.innerHTML = `
        <div>
            <h3>${selectedDirectorySection === "ALL" ? "All Sections" : selectedDirectorySection}</h3>
            <p>Showing active students in selected view</p>
        </div>
        ${selectedDirectorySection !== "ALL" ? `<button onclick="confirmDeleteSection('${selectedDirectorySection}')" class="btn btn-secondary action-delete"><i data-lucide="trash-2"></i> Delete Section</button>` : ""}
    `;

    const filtered = state.students.filter(s => {
        const matchSec = selectedDirectorySection === "ALL" || s.section === selectedDirectorySection;
        const matchSearch = s.name.toLowerCase().includes(searchQuery) || s.student_id.toLowerCase().includes(searchQuery);
        return matchSec && matchSearch;
    });

    if (filtered.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="4" class="text-center" style="padding: 24px; color: var(--text-muted);">No students found.</td></tr>`;
        return;
    }

    filtered.forEach(stud => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>
                <div class="student-cell">
                    <div class="student-avatar">${stud.name.charAt(0)}</div>
                    <div>
                        <strong>${stud.name}</strong>
                        <div style="font-size: 11px; color: var(--text-muted);">${stud.section}</div>
                    </div>
                </div>
            </td>
            <td class="font-mono">${stud.student_id}</td>
            <td>${stud.email || "N/A"}</td>
            <td class="text-right">
                <button onclick="openAttendanceHistory('${stud.id}')" class="action-link action-history">History</button>
                <button onclick="openEditStudentModal('${stud.id}')" class="action-link action-edit">Edit</button>
                <button onclick="openTransferModal('${stud.id}')" class="action-link action-move">Move</button>
                <button onclick="confirmDeleteStudent('${stud.id}')" class="action-link action-delete">Delete</button>
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

    const optionsHTML = state.sections.map(s => `<option value="${s}">${s}</option>`).join("");

    if (attSelect) attSelect.innerHTML = optionsHTML;
    if (studSelect) studSelect.innerHTML = optionsHTML;
    if (transferSelect) transferSelect.innerHTML = optionsHTML;
}

function loadAttendanceSheet() {
    const selectedDate = document.getElementById("att-date").value;
    const selectedSec = document.getElementById("att-section").value;
    const tableBody = document.getElementById("att-table-body");

    if (!selectedDate || !selectedSec) return;

    tableBody.innerHTML = "";
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
            <td><strong>${stud.name}</strong></td>
            <td class="font-mono">${stud.student_id}</td>
            <td>${selectedDate}</td>
            <td class="text-center">
                <div class="status-pill-group">
                    ${["Present", "Absent", "Late", "Excused"].map(st => `
                        <button onclick="setStudentStatus('${selectedDate}', '${stud.student_id}', '${st}')" class="status-btn ${currentStatus === st ? 'active-' + st : ''}">
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
    const key = `${date}_${studentId}`;
    state.attendance[key] = status;
    loadAttendanceSheet();
    saveLocalStore();

    if (cloudReady()) {
        const { error } = await supabaseClient.from("attendance").upsert({
            user_id: currentUser.id,
            date: date,
            student_id: studentId,
            status: status
        }, { onConflict: "user_id,date,student_id" });
        if (error) reportDbError("saving attendance", error);
    }
}

async function markAllAttendance(status) {
    const date = document.getElementById("att-date").value;
    const sec = document.getElementById("att-section").value;
    const secStudents = state.students.filter(s => s.section === sec);

    let upsertPayload = [];
    secStudents.forEach(s => {
        state.attendance[`${date}_${s.student_id}`] = status;
        if (cloudReady()) {
            upsertPayload.push({
                user_id: currentUser.id,
                date: date,
                student_id: s.student_id,
                status: status
            });
        }
    });

    saveLocalStore();

    if (cloudReady() && upsertPayload.length > 0) {
        const { error } = await supabaseClient
            .from("attendance")
            .upsert(upsertPayload, { onConflict: "user_id,date,student_id" });
        if (error) {
            reportDbError("saving attendance", error);
            loadAttendanceSheet();
            return;
        }
    }

    loadAttendanceSheet();
    showToast(`Marked all as ${status}`, "success");
}

async function saveAttendance() {
    saveLocalStore();

    if (!cloudReady()) {
        showToast("Attendance records saved!", "success");
        return;
    }

    try {
        await syncAllAttendance();
        showToast("Attendance records saved and synced to the cloud!", "success");
    } catch (err) {
        reportDbError("saving attendance", err);
    }
}

function exportAttendanceToPDF() {
    const { jsPDF } = window.jspdf;
    if (!jsPDF) {
        showToast("PDF library loading failed.", "error");
        return;
    }

    const doc = new jsPDF();
    const date = document.getElementById("att-date").value;
    const sec = document.getElementById("att-section").value;
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

    doc.save(`Attendance_${sec}_${date}.pdf`);
    showToast("Exported PDF successfully!", "success");
}

// --- Modals & Actions ---
function openModal(id) { document.getElementById(id)?.classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id)?.classList.add("hidden"); }

function openAddSectionModal() { openModal("modal-section"); }

async function handleSectionSubmit(e) {
    e.preventDefault();
    const name = document.getElementById("new-section-name").value.trim();
    if (!name) return;

    if (state.sections.includes(name)) {
        showToast("That section already exists.", "error");
        return;
    }

    if (cloudReady()) {
        const { error } = await supabaseClient.from("sections").insert({
            user_id: currentUser.id,
            name: name
        });
        if (error) {
            reportDbError("adding section", error);
            return;
        }
    }

    state.sections.push(name);
    saveLocalStore();
    closeModal("modal-section");
    document.getElementById("new-section-name").value = "";
    renderDirectory();
    showToast("Section added!", "success");
}

function openAddStudentModal() {
    document.getElementById("student-modal-title").textContent = "Add New Student";
    document.getElementById("form-student").reset();
    document.getElementById("student-edit-id").value = "";
    populateSectionDropdowns();
    openModal("modal-student");
}

function openEditStudentModal(id) {
    const stud = state.students.find(s => s.id === id);
    if (!stud) return;
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

    // Student codes key the attendance records — they must be unique per account
    const clash = state.students.find(s => s.student_id === studId && s.id !== editId);
    if (clash) {
        showToast(`Student code "${studId}" is already used by ${clash.name}.`, "error");
        return;
    }

    if (editId) {
        const idx = state.students.findIndex(s => s.id === editId);
        if (idx === -1) return;
        const oldCode = state.students[idx].student_id;

        if (cloudReady()) {
            const { error } = await supabaseClient.from("students").update({
                student_id: studId,
                name: name,
                email: email || null,
                section: sec
            }).eq("id", editId);
            if (error) {
                reportDbError("updating student", error);
                return;
            }

            // Keep attendance history attached when the student code is renamed
            if (oldCode !== studId) {
                const { error: attErr } = await supabaseClient
                    .from("attendance")
                    .update({ student_id: studId })
                    .eq("user_id", currentUser.id)
                    .eq("student_id", oldCode);
                if (attErr) reportDbError("relinking attendance records", attErr);
            }
        }

        state.students[idx] = { id: editId, name, student_id: studId, section: sec, email };

        if (oldCode !== studId) {
            const relinked = {};
            Object.keys(state.attendance).forEach(k => {
                const { date, studentId } = parseAttKey(k);
                relinked[`${date}_${studentId === oldCode ? studId : studentId}`] = state.attendance[k];
            });
            state.attendance = relinked;
        }
    } else {
        const newStud = { id: Date.now().toString(), name, student_id: studId, section: sec, email };

        if (cloudReady()) {
            const { data, error } = await supabaseClient.from("students").insert({
                user_id: currentUser.id,
                student_id: studId,
                name: name,
                email: email || null,
                section: sec
            }).select("id").single();
            if (error) {
                reportDbError("adding student", error);
                return;
            }
            newStud.id = String(data.id); // use the database-generated id
        }

        state.students.push(newStud);
    }

    saveLocalStore();
    closeModal("modal-student");
    renderDirectory();
    showToast("Student saved!", "success");
}

function openTransferModal(id) {
    const stud = state.students.find(s => s.id === id);
    if (!stud) return;
    populateSectionDropdowns();
    document.getElementById("transfer-student-id").value = stud.id;
    document.getElementById("transfer-student-name").value = stud.name;
    openModal("modal-transfer-student");
}

async function handleTransferSubmit(e) {
    e.preventDefault();
    const id = document.getElementById("transfer-student-id").value;
    const newSec = document.getElementById("transfer-new-section").value;

    const stud = state.students.find(s => s.id === id);
    if (!stud) return;

    if (cloudReady()) {
        const { error } = await supabaseClient.from("students").update({ section: newSec }).eq("id", id);
        if (error) {
            reportDbError("moving student", error);
            return;
        }
    }

    stud.section = newSec;
    saveLocalStore();
    closeModal("modal-transfer-student");
    renderDirectory();
    showToast("Student moved!", "success");
}

function confirmDeleteStudent(id) {
    const stud = state.students.find(s => s.id === id);
    if (!stud) return;
    document.getElementById("delete-student-name").textContent = stud.name;
    document.getElementById("confirm-delete-btn").onclick = async () => {
        const code = stud.student_id;

        if (cloudReady()) {
            const { error } = await supabaseClient.from("students").delete().eq("id", id);
            if (error) {
                reportDbError("deleting student", error);
                return;
            }
            // Remove the student's attendance history too (local + cloud)
            const { error: attErr } = await supabaseClient
                .from("attendance")
                .delete()
                .eq("user_id", currentUser.id)
                .eq("student_id", code);
            if (attErr) reportDbError("deleting attendance records", attErr);
        }

        state.students = state.students.filter(s => s.id !== id);
        Object.keys(state.attendance).forEach(k => {
            if (parseAttKey(k).studentId === code) delete state.attendance[k];
        });

        saveLocalStore();
        closeModal("modal-delete-student");
        renderDirectory();
        showToast("Student deleted", "success");
    };
    openModal("modal-delete-student");
}

function confirmDeleteSection(sec) {
    document.getElementById("delete-section-name").textContent = sec;
    document.getElementById("confirm-delete-section-btn").onclick = async () => {
        const codes = state.students.filter(s => s.section === sec).map(s => s.student_id);

        if (cloudReady()) {
            if (codes.length > 0) {
                const { error: attErr } = await supabaseClient
                    .from("attendance")
                    .delete()
                    .eq("user_id", currentUser.id)
                    .in("student_id", codes);
                if (attErr) {
                    reportDbError("deleting attendance records", attErr);
                    return;
                }
            }
            const { error: studErr } = await supabaseClient
                .from("students")
                .delete()
                .eq("user_id", currentUser.id)
                .eq("section", sec);
            if (studErr) {
                reportDbError("deleting students", studErr);
                return;
            }
            const { error: secErr } = await supabaseClient
                .from("sections")
                .delete()
                .eq("user_id", currentUser.id)
                .eq("name", sec);
            if (secErr) {
                reportDbError("deleting section", secErr);
                return;
            }
        }

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
    };
    openModal("modal-delete-section");
}

// --- Student Attendance Calendar History ---
function openAttendanceHistory(studentId) {
    historyStudentId = studentId;
    historyCurrentDate = new Date();
    renderHistoryCalendar();
    openModal("modal-attendance-history");
}

function changeHistoryMonth(delta) {
    historyCurrentDate.setMonth(historyCurrentDate.getMonth() + delta);
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
function openProfileModal() { openModal("modal-profile"); }

function previewProfileImage(e) {
    const file = e.target.files[0];
    if (file) {
        document.getElementById("profile-file-name").textContent = file.name;
        const reader = new FileReader();
        reader.onload = (evt) => {
            document.getElementById("modalPreviewAvatar").innerHTML = `<img src="${evt.target.result}" style="width:100%;height:100%;object-fit:cover;">`;
        };
        reader.readAsDataURL(file);
    }
}

async function handleProfileSubmit(e) {
    e.preventDefault();
    const newName = document.getElementById("profile-display-name").value.trim();
    if (!newName) return;

    // Store the display name on the account so it follows every device
    if (cloudReady()) {
        const { error } = await supabaseClient.auth.updateUser({
            data: { full_name: newName }
        });
        if (error) {
            reportDbError("updating profile", error);
            return;
        }
    }

    if (currentUser) currentUser.name = newName;
    localStorage.setItem("scholog_local_user", JSON.stringify({
        email: currentUser?.email || "user@scholog.com",
        name: newName
    }));
    setProfileUI(currentUser?.email || "", newName);
    closeModal("modal-profile");
    showToast("Profile updated!", "success");
}

function exportDataBackup() {
    const jsonStr = JSON.stringify(state, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Scholog_Backup_${todayStr()}.json`;
    a.click();
    showToast("Backup downloaded!", "success");
}

function importDataBackup(e) {
    const file = e.target.files[0];
    if (!file) return;

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
