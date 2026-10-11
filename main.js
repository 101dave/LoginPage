// Add at the top of DOMContentLoaded or initial execution in main.js
async function checkAuthGuard() {
    const { data: { user }, error } = await supabaseClient.auth.getUser();
    if (error || !user) {
        window.location.href = 'index.html';
    }
}
checkAuthGuard();

// Supabase Configuration[cite: 1, 5]
const SUPABASE_URL = 'https://uarburvejxtjvtqawtlt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhcmJ1cnZlanh0anZ0cWF3dGx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE2OTg5NzMsImV4cCI6MjEwNzI3NDk3M30.BRFhOet9M0uKf3mvb5zDaQVJ4ihdDyIUxqSgb19ESX8';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let sections = [];
let students = []; 
let attendanceRecords = {};
let activeDirectorySection = "";
let studentToDeleteId = null;

document.addEventListener('DOMContentLoaded', async () => {
    const todayStr = new Date().toISOString().split('T')[0];
    const attDateEl = document.getElementById('att-date');
    const histDateEl = document.getElementById('history-date');
    if(attDateEl) attDateEl.value = todayStr;
    if(histDateEl) histDateEl.value = todayStr;

    populateDropdowns();
    await fetchStudentsFromSupabase();
    lucide.createIcons();
});

// Toggle Mobile Hamburger Menu
function toggleMobileMenu() {
    const menu = document.getElementById('mobileMenu');
    if (menu) {
        menu.classList.toggle('hidden');
    }
}

async function fetchStudentsFromSupabase() {
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) return;

    sections = JSON.parse(localStorage.getItem(`schola_sections_${user.id}`)) || [];
    attendanceRecords = JSON.parse(localStorage.getItem(`schola_attendance_${user.id}`)) || {};
    activeDirectorySection = sections[0] || "";

    const { data, error } = await supabaseClient
        .from('students')
        .select('*')
        .eq('user_id', user.id);

    if (error) {
        showToast("Error sa pag-load ng mga estudyante", "error");
        console.error(error);
    } else {
        students = data || [];
        populateDropdowns();
        renderDashboard();
        renderDirectory();
        loadAttendanceSheet();
        populateHistoryStudentSelect();
    }
}

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

function populateDropdowns() {
    const attSelect = document.getElementById('att-section');
    const studSelect = document.getElementById('stud-section');
    
    if(attSelect) attSelect.innerHTML = '';
    if(studSelect) studSelect.innerHTML = '';

    if (sections.length === 0) {
        if(attSelect) attSelect.innerHTML = `<option value="">No sections available</option>`;
        if(studSelect) studSelect.innerHTML = `<option value="">No sections available</option>`;
        return;
    }

    sections.forEach(sec => {
        if(attSelect) attSelect.innerHTML += `<option value="${sec}">${sec}</option>`;
        if(studSelect) studSelect.innerHTML += `<option value="${sec}">${sec}</option>`;
    });
}

function renderDashboard() {
    const todayStr = new Date().toISOString().split('T')[0];
    const dateLabel = document.getElementById('dash-date-label');
    if(dateLabel) dateLabel.innerText = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const totalStudents = students.length;
    const todayAtt = attendanceRecords[todayStr] || {};

    let presentCount = 0;
    let absentCount = 0;

    students.forEach(s => {
        const status = todayAtt[s.id];
        if(status === 'Present' || status === 'Late' || status === 'Excused') {
            presentCount++;
        } else if(status === 'Absent') {
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

    if (sections.length === 0) {
        breakdownContainer.innerHTML = `<div style="padding: 32px; text-align: center; color: var(--text-muted); font-size: 12px;">No sections created yet. Click "Add Section" to get started.</div>`;
        return;
    }

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

function renderDirectory() {
    const tabsContainer = document.getElementById('directory-section-tabs');
    const bannerContainer = document.getElementById('directory-section-banner');
    const tbody = document.getElementById('directory-table-body');
    const searchInput = document.getElementById('directory-search');
    const searchQuery = searchInput ? searchInput.value.toLowerCase() : '';

    if(!tabsContainer || !bannerContainer || !tbody) return;

    tabsContainer.innerHTML = '';
    
    if (sections.length === 0) {
        activeDirectorySection = "";
        tabsContainer.innerHTML = `<span style="font-size: 12px; color: var(--text-muted); padding: 4px 0;">No sections available.</span>`;
        bannerContainer.innerHTML = `<div><h3>No Section Selected</h3><p>Please add a section first</p></div>`;
        tbody.innerHTML = `<tr><td colspan="5" style="padding: 32px; text-align: center; color: var(--text-muted); font-size: 12px;">No sections or students found.</td></tr>`;
        return;
    }

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
        <div style="display: flex; gap: 8px;">
            <button onclick="openAddStudentModalForSection('${activeDirectorySection}')" class="btn btn-secondary">Add to Section</button>
            <button onclick="deleteSection('${activeDirectorySection}')" class="btn" style="background-color: var(--rose-bg); color: var(--rose-text); border-color: var(--rose-border);">Delete Section</button>
        </div>
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

function loadAttendanceSheet() {
    const dateEl = document.getElementById('att-date');
    const sectionEl = document.getElementById('att-section');
    const tbody = document.getElementById('att-table-body');
    const subtitle = document.getElementById('att-sheet-subtitle');

    if(!dateEl || !sectionEl || !tbody) return;
    const date = dateEl.value;
    const section = sectionEl.value;

    if (!section || sections.length === 0) {
        if(subtitle) subtitle.innerText = `No sections available`;
        tbody.innerHTML = `<tr><td colspan="3" style="padding: 32px; text-align: center; color: var(--text-muted); font-size: 12px;">Please create a section first.</td></tr>`;
        return;
    }

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
                <td><div class="student-cell"><span style="font-weight:500;">${s.name}</span></div></td>
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

async function setAttendanceStatus(date, studentId, status) {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return;

    if(!attendanceRecords[date]) attendanceRecords[date] = {};
    attendanceRecords[date][studentId] = status;
    
    localStorage.setItem(`schola_attendance_${user.id}`, JSON.stringify(attendanceRecords));
    loadAttendanceSheet();
}

function markAllAttendance(status) {
    const dateEl = document.getElementById('att-date');
    const sectionEl = document.getElementById('att-section');
    if(!dateEl || !sectionEl) return;
    
    const date = dateEl.value;
    const section = sectionEl.value;
    const secStudents = students.filter(s => s.section === section);

    if(!attendanceRecords[date]) attendanceRecords[date] = {};
    secStudents.forEach(s => {
        attendanceRecords[date][s.id] = status;
    });

    loadAttendanceSheet();
    showToast(`Marked all as ${status}!`);
}

async function saveAttendance() {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return;
    localStorage.setItem(`schola_attendance_${user.id}`, JSON.stringify(attendanceRecords));
    showToast("Attendance saved successfully!");
}

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
    if(students.length === 0) {
        select.innerHTML = `<option value="">No students available</option>`;
        return;
    }
    students.forEach(s => {
        select.innerHTML += `<option value="${s.id}">${s.name} (${s.section})</option>`;
    });
}

function renderHistory() {
    const results = document.getElementById('history-results');
    if(!results) return;
    results.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 12px;">History report view active.</div>`;
}

function openAddSectionModal() {
    const modal = document.getElementById('modal-section');
    if (modal) {
        modal.classList.remove('hidden');
        const input = document.getElementById('new-section-name');
        if(input) { input.value = ''; input.focus(); }
    }
}

async function handleSectionSubmit(event) {
    event.preventDefault();
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return;

    const sectionInput = document.getElementById('new-section-name');
    const newSection = sectionInput.value.trim();
    if (!newSection) return;

    if (sections.includes(newSection)) {
        showToast("Section already exists!", "error");
        return;
    }

    sections.push(newSection);
    localStorage.setItem(`schola_sections_${user.id}`, JSON.stringify(sections));

    if (!activeDirectorySection) activeDirectorySection = newSection;

    populateDropdowns();
    renderDashboard();
    renderDirectory();
    closeModal('modal-section');
    showToast("Section successfully added!");
}

async function deleteSection(sectionName) {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return;

    if (confirm(`Are you sure you want to delete the section "${sectionName}"?`)) {
        sections = sections.filter(s => s !== sectionName);
        localStorage.setItem(`schola_sections_${user.id}`, JSON.stringify(sections));

        if (activeDirectorySection === sectionName) {
            activeDirectorySection = sections[0] || "";
        }

        populateDropdowns();
        renderDashboard();
        renderDirectory();
        loadAttendanceSheet();
        showToast("Section deleted successfully!");
    }
}

function openAddStudentModal() {
    if (sections.length === 0) {
        showToast("Please add a section first before adding students.", "error");
        openAddSectionModal();
        return;
    }
    document.getElementById('student-modal-title').innerText = "Add New Student";
    document.getElementById('form-student').reset();
    document.getElementById('student-edit-id').value = "";
    document.getElementById('stud-section').value = activeDirectorySection || sections[0];
    document.getElementById('modal-student').classList.remove('hidden');
}

function openAddStudentModalForSection(section) {
    openAddStudentModal();
    document.getElementById('stud-section').value = section;
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.add('hidden');
}

async function handleStudentSubmit(event) {
    event.preventDefault();
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
        showToast("Kailangan mong mag-login muli.", "error");
        return;
    }

    const name = document.getElementById('stud-name').value.trim();
    const id = document.getElementById('stud-id').value.trim();
    const section = document.getElementById('stud-section').value;
    const email = document.getElementById('stud-email').value.trim();

    const { error } = await supabaseClient
        .from('students')
        .insert([{ id, name, section, email, user_id: user.id }]);

    if (error) {
        showToast(error.message, "error");
    } else {
        showToast("Student successfully added to Supabase!");
        closeModal('modal-student');
        await fetchStudentsFromSupabase();
    }
}

function deleteStudent(id) {
    const student = students.find(s => s.id === id);
    if (!student) return;

    studentToDeleteId = id;
    const nameEl = document.getElementById('delete-student-name');
    if (nameEl) nameEl.innerText = student.name;

    const confirmBtn = document.getElementById('confirm-delete-btn');
    if (confirmBtn) {
        confirmBtn.onclick = async () => { await confirmDeleteStudent(); };
    }

    document.getElementById('modal-delete-student').classList.remove('hidden');
    lucide.createIcons();
}

async function confirmDeleteStudent() {
    if (!studentToDeleteId) return;

    const confirmBtn = document.getElementById('confirm-delete-btn');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.innerText = "Deleting...";
    }

    const { error } = await supabaseClient
        .from('students')
        .delete()
        .eq('id', studentToDeleteId);

    if (error) {
        showToast(error.message, "error");
    } else {
        showToast("Student deleted successfully!");
        closeModal('modal-delete-student');
        await fetchStudentsFromSupabase();
    }

    if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.innerText = "Delete";
    }
    studentToDeleteId = null;
}

async function handleLogout() {
    const { error } = await supabaseClient.auth.signOut();
    if (error) {
        showToast("Error sa pag-logout", "error");
    } else {
        showToast("Logged out successfully! Redirecting...", "success");
        setTimeout(() => { window.location.href = 'index.html'; }, 1000);
    }
}