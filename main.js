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

let state = {
    sections: [],
    students: [],
    attendance: {}
};

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
        } else {
            fallbackAuth();
        }
    } else {
        fallbackAuth();
    }
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
    const saved = localStorage.getItem("scholog_app_data");
    if (saved) {
        try { state = JSON.parse(saved); } catch (e) { console.error(e); }
    }
}

function saveLocalStore() {
    localStorage.setItem("scholog_app_data", JSON.stringify(state));
}

// --- Supabase Data Sync ---
async function loadSupabaseData() {
    if (!supabaseClient || !currentUser) return;

    try {
        const { data: secData } = await supabaseClient
            .from("sections")
            .select("*")
            .eq("user_id", currentUser.id);
        
        if (secData) {
            state.sections = secData.map(s => s.name);
        }

        const { data: studData } = await supabaseClient
            .from("students")
            .select("*")
            .eq("user_id", currentUser.id);
        
        if (studData) {
            state.students = studData.map(s => ({
                id: s.id.toString(),
                student_id: s.student_id,
                name: s.name,
                email: s.email,
                section: s.section
            }));
        }

        const { data: attData } = await supabaseClient
            .from("attendance")
            .select("*")
            .eq("user_id", currentUser.id);
        
        if (attData) {
            state.attendance = {};
            attData.forEach(row => {
                const key = `${row.date}_${row.student_id}`;
                state.attendance[key] = row.status;
            });
        }
    } catch (err) {
        console.error("Error loading data from Supabase:", err);
        loadLocalStore();
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
    const today = new Date().toISOString().split("T")[0];
    const dateInput = document.getElementById("att-date");
    if (dateInput) dateInput.value = today;
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
    const today = new Date().toISOString().split("T")[0];
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

    if (supabaseClient && currentUser) {
        await supabaseClient.from("attendance").upsert({
            user_id: currentUser.id,
            date: date,
            student_id: studentId,
            status: status
        }, { onConflict: 'user_id,date,student_id' });
    }
    saveLocalStore();
}

async function markAllAttendance(status) {
    const date = document.getElementById("att-date").value;
    const sec = document.getElementById("att-section").value;
    const secStudents = state.students.filter(s => s.section === sec);

    let upsertPayload = [];
    secStudents.forEach(s => {
        state.attendance[`${date}_${s.student_id}`] = status;
        if (supabaseClient && currentUser) {
            upsertPayload.push({
                user_id: currentUser.id,
                date: date,
                student_id: s.student_id,
                status: status
            });
        }
    });

    if (supabaseClient && currentUser && upsertPayload.length > 0) {
        await supabaseClient.from("attendance").upsert(upsertPayload, { onConflict: 'user_id,date,student_id' });
    }

    saveLocalStore();
    loadAttendanceSheet();
    showToast(`Marked all as ${status}`, "success");
}

function saveAttendance() {
    saveLocalStore();
    showToast("Attendance records saved!", "success");
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
    if (name && !state.sections.includes(name)) {
        state.sections.push(name);
        
        if (supabaseClient && currentUser) {
            await supabaseClient.from("sections").insert({
                user_id: currentUser.id,
                name: name
            });
        }

        saveLocalStore();
        closeModal("modal-section");
        document.getElementById("new-section-name").value = "";
        renderDirectory();
        showToast("Section added!", "success");
    }
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

    if (editId) {
        const idx = state.students.findIndex(s => s.id === editId);
        if (idx !== -1) {
            state.students[idx] = { id: editId, name, student_id: studId, section: sec, email };
            if (supabaseClient && currentUser) {
                await supabaseClient.from("students").update({
                    student_id: studId,
                    name: name,
                    email: email,
                    section: sec
                }).eq("id", editId);
            }
        }
    } else {
        const newDbId = Date.now();
        const newStud = { id: newDbId.toString(), name, student_id: studId, section: sec, email };
        state.students.push(newStud);
        if (supabaseClient && currentUser) {
            await supabaseClient.from("students").insert({
                id: newDbId,
                user_id: currentUser.id,
                student_id: studId,
                name: name,
                email: email,
                section: sec
            });
        }
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
    if (stud) {
        stud.section = newSec;
        if (supabaseClient && currentUser) {
            await supabaseClient.from("students").update({ section: newSec }).eq("id", id);
        }
        saveLocalStore();
        closeModal("modal-transfer-student");
        renderDirectory();
        showToast("Student moved!", "success");
    }
}

function confirmDeleteStudent(id) {
    const stud = state.students.find(s => s.id === id);
    if (!stud) return;
    document.getElementById("delete-student-name").textContent = stud.name;
    document.getElementById("confirm-delete-btn").onclick = async () => {
        state.students = state.students.filter(s => s.id !== id);
        if (supabaseClient && currentUser) {
            await supabaseClient.from("students").delete().eq("id", id);
        }
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
        state.sections = state.sections.filter(s => s !== sec);
        state.students = state.students.filter(s => s.section !== sec);
        selectedDirectorySection = "ALL";

        if (supabaseClient && currentUser) {
            await supabaseClient.from("sections").delete().eq("name", sec).eq("user_id", currentUser.id);
            await supabaseClient.from("students").delete().eq("section", sec).eq("user_id", currentUser.id);
        }

        saveLocalStore();
        closeModal("modal-delete-section");
        renderDirectory();
        showToast("Section and students deleted", "success");
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

function handleProfileSubmit(e) {
    e.preventDefault();
    const newName = document.getElementById("profile-display-name").value.trim();
    if (newName) {
        if (currentUser) currentUser.name = newName;
        localStorage.setItem("scholog_local_user", JSON.stringify({ email: currentUser?.email || "user@scholog.com", name: newName }));
        setProfileUI(currentUser?.email || "", newName);
        closeModal("modal-profile");
        showToast("Profile updated!", "success");
    }
}

function exportDataBackup() {
    const jsonStr = JSON.stringify(state, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Scholog_Backup_${new Date().toISOString().split("T")[0]}.json`;
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
                state = imported;
                saveLocalStore();
                closeModal("modal-profile");
                switchTab(activeTab);
                showToast("Data restored successfully!", "success");
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