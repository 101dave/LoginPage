// Supabase Configuration galing sa iyong proyekto[cite: 1, 6]
const SUPABASE_URL = 'https://uarburvejxtjvtqawtlt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhcmJ1cnZlanh0anZ0cWF3dGx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE2OTg5NzMsImV4cCI6MjEwNzI3NDk3M30.BRFhOet9M0uKf3mvb5zDaQVJ4ihdDyIUxqSgb19ESX8';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Initial Sections Setup
const DEFAULT_SECTIONS = [
    "Grade 10 - Newton",
    "Grade 10 - Einstein",
    "Grade 11 - STEM A",
    "Grade 12 - Rizal"
];

let sections = JSON.parse(localStorage.getItem('schola_sections')) || DEFAULT_SECTIONS;
let students = []; // Dito natin ila-load ang mga estudyante mula sa Supabase
let attendanceRecords = JSON.parse(localStorage.getItem('schola_attendance')) || {};

let activeDirectorySection = sections[0] || "";

// Initialize App
document.addEventListener('DOMContentLoaded', async () => {
    const todayStr = new Date().toISOString().split('T')[0];
    const attDateEl = document.getElementById('att-date');
    const histDateEl = document.getElementById('history-date');
    if(attDateEl) attDateEl.value = todayStr;
    if(histDateEl) histDateEl.value = todayStr;

    populateDropdowns();
    await fetchStudentsFromSupabase(); // Kunin ang mga estudyante sa Supabase
    
    lucide.createIcons();
});

// Kumuha ng mga Estudyante mula sa Supabase
async function fetchStudentsFromSupabase() {
    const { data, error } = await supabaseClient
        .from('students')
        .select('*');

    if (error) {
        showToast("Error sa pag-load ng mga estudyante", "error");
        console.error(error);
    } else {
        students = data || [];
        renderDashboard();
        renderDirectory();
        loadAttendanceSheet();
        populateHistoryStudentSelect();
    }
}

// Toast Notification System
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if(!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'success' ? 'toast-success' : 'toast-error'}`;
    toast.innerHTML = `<i data-lucide="${type === 'success' ? 'check-circle' : 'alert-circle'}"></i><span>${message}</span>`;
    container.appendChild(toast);
    lucide.createIcons();

    setTimeout(() => { toast.classList.add('show'); }, 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Navigation Switcher
function switchTab(tabName) {
    ['dashboard', 'directory', 'attendance', 'history'].forEach(t => {
        const viewEl = document.getElementById(`view-${t}`);
        if(viewEl) viewEl.classList.add('hidden');
        const btn = document.getElementById(`nav-${t}`);
        if(btn) btn.classList.remove('active');
        const mobBtn = document.getElementById(`mob-nav-${t}`);
        if(mobBtn) mobBtn.classList.remove('active');
    });

    const activeView = document.getElementById(`view-${tabName}`);
    if(activeView) activeView.classList.remove('hidden');
    const activeBtn = document.getElementById(`nav-${tabName}`);
    if(activeBtn) activeBtn.classList.add('active');
    const activeMob = document.getElementById(`mob-nav-${tabName}`);
    if(activeMob) activeMob.classList.add('active');

    if(tabName === 'dashboard') renderDashboard();
    if(tabName === 'directory') renderDirectory();
    if(tabName === 'attendance') loadAttendanceSheet();
    if(tabName === 'history') renderHistory();
}

// Dropdown Populate Helpers
function populateDropdowns() {
    const attSelect = document.getElementById('att-section');
    const studSelect = document.getElementById('stud-section');
    
    if(attSelect) attSelect.innerHTML = '';
    if(studSelect) studSelect.innerHTML = '';

    sections.forEach(sec => {
        if(attSelect) attSelect.innerHTML += `<option value="${sec}">${sec}</option>`;
        if(studSelect) studSelect.innerHTML += `<option value="${sec}">${sec}</option>`;
    });
}

// ================= DASHBOARD LOGIC =================
function renderDashboard() {
    const todayStr = new Date().toISOString().split('T')[0];
    const dateLabel = document.getElementById('dash-date-label');
    if(dateLabel) dateLabel.innerText = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const totalStudents = students.length;
    const todayAtt = attendanceRecords[todayStr] || {};

    let presentCount = 0;
    let absentCount = 0;

    Object.values(todayAtt).forEach(status => {
        if(status === 'Present' || status === 'Late' || status === 'Excused') {
            if(status === 'Present' || status === 'Late') presentCount++;
        }
        if(status === 'Absent') {
            absentCount++;
        }
    });

    const statTotal = document.getElementById('stat-total');
    const statPresent = document.getElementById('stat-present');
    const statAbsent = document.getElementById('stat-absent');
    const statRate = document.getElementById('stat-rate');

    if(statTotal) statTotal.innerText = totalStudents;
    if(statPresent) statPresent.innerText = presentCount;
    if(statAbsent) statAbsent.innerText = absentCount;
    
    let overallPct = totalStudents > 0 ? Math.round((presentCount / totalStudents) * 100) : 0;
    if(statRate) statRate.innerText = overallPct + '%';

    const breakdownContainer = document.getElementById('section-breakdown-container');
    if(!breakdownContainer) return;
    breakdownContainer.innerHTML = '';

    sections.forEach(sec => {
        const secStudents = students.filter(s => s.section === sec);
        const secTotal = secStudents.length;

        let secPresent = 0;
        secStudents.forEach(s => {
            const status = todayAtt[s.id];
            if(status === 'Present' || status === 'Late' || status === 'Excused') secPresent++;
        });

        let secRate = secTotal > 0 ? Math.round((secPresent / secTotal) * 100) : 0;
        let badgeClass = 'badge-emerald';
        if(secRate < 75) badgeClass = 'badge-rose';
        else if(secRate < 90) badgeClass = 'badge-amber';

        breakdownContainer.innerHTML += `
            <div class="breakdown-item">
                <div class="breakdown-info">
                    <h4>${sec}</h4>
                    <p>${secTotal} enrolled students</p>
                </div>
                <div class="breakdown-progress-group">
                    <div class="progress-bar-wrapper">
                        <div class="progress-fill" style="width: ${secRate}%"></div>
                    </div>
                    <span class="badge ${badgeClass}">${secRate}% Attendance</span>
                </div>
            </div>
        `;
    });
    lucide.createIcons();
}

// ================= DIRECTORY LOGIC =================
function renderDirectory() {
    const tabsContainer = document.getElementById('directory-section-tabs');
    const bannerContainer = document.getElementById('directory-section-banner');
    const tbody = document.getElementById('directory-table-body');
    const searchInput = document.getElementById('directory-search');
    const searchQuery = searchInput ? searchInput.value.toLowerCase() : '';

    if(!tabsContainer || !bannerContainer || !tbody) return;

    tabsContainer.innerHTML = '';
    if(!sections.includes(activeDirectorySection) && sections.length > 0) {
        activeDirectorySection = sections[0];
    }

    sections.forEach(sec => {
        const count = students.filter(s => s.section === sec).length;
        const isActive = sec === activeDirectorySection;
        tabsContainer.innerHTML += `
            <button onclick="activeDirectorySection = '${sec}'; renderDirectory();" class="section-tab-btn ${isActive ? 'active' : 'inactive'}">
                <span>${sec}</span>
                <span class="badge-count">${count}</span>
            </button>
        `;
    });

    const sectionStudents = students.filter(s => s.section === activeDirectorySection && (
        s.name.toLowerCase().includes(searchQuery) || s.id.toLowerCase().includes(searchQuery)
    ));

    bannerContainer.innerHTML = `
        <div>
            <h3>${activeDirectorySection}</h3>
            <p>Showing ${sectionStudents.length} student(s) in this section</p>
        </div>
        <button onclick="openAddStudentModalForSection('${activeDirectorySection}')" class="btn btn-secondary">Add to Section</button>
    `;

    tbody.innerHTML = '';
    if(sectionStudents.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="padding: 32px; text-align: center; color: var(--text-muted); font-size: 12px;">No students found in this section.</td></tr>`;
        return;
    }

    sectionStudents.forEach(s => {
        tbody.innerHTML += `
            <tr>
                <td>
                    <div class="student-cell">
                        <div class="student-avatar">
                            ${s.name.split(' ').map(n => n[0]).join('').substring(0,2).toUpperCase()}
                        </div>
                        <span style="font-weight: 500;">${s.name}</span>
                    </div>
                </td>
                <td class="font-mono">${s.id}</td>
                <td style="color: var(--text-muted);">${s.email}</td>
                <td><span class="badge badge-emerald">Active</span></td>
                <td class="text-right">
                    <button onclick="deleteStudent('${s.id}')" style="background:none; border:none; color:var(--rose-text); cursor:pointer; font-size:12px; font-weight:500;">Delete</button>
                </td>
            </tr>
        `;
    });
    lucide.createIcons();
}

// ================= ATTENDANCE LOGIC =================
function loadAttendanceSheet() {
    const dateEl = document.getElementById('att-date');
    const sectionEl = document.getElementById('att-section');
    const tbody = document.getElementById('att-table-body');
    const subtitle = document.getElementById('att-sheet-subtitle');

    if(!dateEl || !sectionEl || !tbody) return;
    const date = dateEl.value;
    const section = sectionEl.value;

    if(subtitle) subtitle.innerText = `Marking for ${section} on ${date}`;
    tbody.innerHTML = '';

    const secStudents = students.filter(s => s.section === section);
    if(secStudents.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" style="padding: 32px; text-align: center; color: var(--text-muted); font-size: 12px;">No students enrolled in this section.</td></tr>`;
        return;
    }

    if(!attendanceRecords[date]) attendanceRecords[date] = {};

    secStudents.forEach(s => {
        const currentStatus = attendanceRecords[date][s.id] || 'Present';
        tbody.innerHTML += `
            <tr>
                <td>
                    <div class="student-cell">
                        <span style="font-weight:500;">${s.name}</span>
                    </div>
                </td>
                <td class="font-mono">${s.id}</td>
                <td class="text-center">
                    <div class="status-pill-group">
                        ${['Present', 'Absent', 'Late', 'Excused'].map(status => {
                            const active = currentStatus === status;
                            return `<button type="button" onclick="setAttendanceStatus('${date}', '${s.id}', '${status}')" class="status-btn ${active ? 'active-' + status : ''}">${status}</button>`;
                        }).join('')}
                    </div>
                </td>
            </tr>
        `;
    });
}

function setAttendanceStatus(date, studentId, status) {
    if(!attendanceRecords[date]) attendanceRecords[date] = {};
    attendanceRecords[date][studentId] = status;
    loadAttendanceSheet();
}

// ================= HISTORY LOGIC =================
function toggleHistoryMode() {
    const mode = document.getElementById('history-filter-type').value;
    if(mode === 'date') {
        document.getElementById('history-input-date-wrapper').classList.remove('hidden');
        document.getElementById('history-input-student-wrapper').classList.add('hidden');
    } else {
        document.getElementById('history-input-date-wrapper').classList.add('hidden');
        document.getElementById('history-input-student-wrapper').classList.remove('hidden');
        populateHistoryStudentSelect();
    }
    renderHistory();
}

function populateHistoryStudentSelect() {
    const select = document.getElementById('history-student-select');
    if(!select) return;
    select.innerHTML = '';
    students.forEach(s => {
        select.innerHTML += `<option value="${s.id}">${s.name} (${s.section})</option>`;
    });
}

function renderHistory() {
    // Basic history render placeholder
}

// ================= MODALS & SUPABASE CRUD ACTIONS =================
function openAddStudentModal() {
    document.getElementById('student-modal-title').innerText = "Add New Student";
    document.getElementById('form-student').reset();
    document.getElementById('student-edit-id').value = "";
    document.getElementById('stud-section').value = activeDirectorySection;
    document.getElementById('modal-student').classList.remove('hidden');
}

function openAddStudentModalForSection(section) {
    openAddStudentModal();
    document.getElementById('stud-section').value = section;
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.add('hidden');
}

// DITO MAPUPUNTA ANG SUPABASE INSERT KAPAG NAG-ADD NG STUDENT
async function handleStudentSubmit(event) {
    event.preventDefault();
    const name = document.getElementById('stud-name').value.trim();
    const id = document.getElementById('stud-id').value.trim();
    const section = document.getElementById('stud-section').value;
    const email = document.getElementById('stud-email').value.trim();

    // I-save sa Supabase 'students' table
    const { data, error } = await supabaseClient
        .from('students')
        .insert([{ id, name, section, email }]);

    if (error) {
        showToast(error.message, "error");
    } else {
        showToast("Student successfully added to Supabase!");
        closeModal('modal-student');
        await fetchStudentsFromSupabase(); // I-refresh ang listahan galing Supabase
    }
}

// SUPABASE DELETE FUNCTION
async function deleteStudent(id) {
    if(confirm("Sigurado ka bang gusto mong tanggalin ang estudyanteng ito?")) {
        const { error } = await supabaseClient
            .from('students')
            .delete()
            .eq('id', id);

        if (error) {
            showToast(error.message, "error");
        } else {
            showToast("Student deleted successfully!");
            await fetchStudentsFromSupabase(); // I-refresh ang listahan
        }
    }
}