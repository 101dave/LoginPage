// ==========================================
// SCHOLOG - MAIN APPLICATION LOGIC
// ==========================================

// Supabase Configuration
const SUPABASE_URL = 'https://uarburvejxtjvtqawtlt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhcmJ1cnZlanh0anZ0cWF3dGx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE2OTg5NzMsImV4cCI6MjEwNzI3NDk3M30.BRFhOet9M0uKf3mvb5zDaQVJ4ihdDyIUxqSgb19ESX8';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Application State
let sections = [];
let students = []; 
let attendanceRecords = {};
let activeDirectorySection = "";
let studentToDeleteId = null;

// Auth Guard on Page Load
async function checkAuthGuard() {
    try {
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        if (error || !session) {
            console.warn("No active session found. Redirecting to login.");
            window.location.href = 'index.html';
        }
    } catch (err) {
        console.error("Critical error in checkAuthGuard:", err);
        window.location.href = 'index.html';
    }
}

// Initializer Lifecycle
document.addEventListener('DOMContentLoaded', async () => {
    await checkAuthGuard();

    const todayStr = new Date().toISOString().split('T')[0];
    const attDateEl = document.getElementById('att-date');
    if (attDateEl) attDateEl.value = todayStr;

    await fetchStudentsFromSupabase();
    if (window.lucide) {
        lucide.createIcons();
    }
});

// Toggle Mobile Hamburger Menu
function toggleMobileMenu() {
    const menu = document.getElementById('mobileMenu');
    if (menu) {
        menu.classList.toggle('hidden');
    }
}

// Fetch All Data from Supabase Cloud Database with Robust Error Handling
async function fetchStudentsFromSupabase() {
    try {
        const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
        if (sessionError || !session || !session.user) {
            console.error("User session not found during data fetch:", sessionError);
            return;
        }
        const user = session.user;

        // 1. Fetch Sections
        const { data: secData, error: secError } = await supabaseClient
            .from('sections')
            .select('name')
            .eq('user_id', user.id);

        if (secError) {
            console.error("Error fetching sections:", secError);
            showToast("Error loading sections", "error");
            sections = [];
        } else {
            sections = secData ? secData.map(s => s.name) : [];
        }

        if (sections.length > 0 && (!activeDirectorySection || !sections.includes(activeDirectorySection))) {
            activeDirectorySection = sections[0];
        }

        // 2. Fetch Students
        const { data: studData, error: studError } = await supabaseClient
            .from('students')
            .select('*')
            .eq('user_id', user.id);

        if (studError) {
            console.error("Error fetching students:", studError);
            showToast("Error loading students", "error");
            students = [];
        } else {
            students = studData || [];
        }

        // 3. Fetch Attendance Records
        const { data: attData, error: attError } = await supabaseClient
            .from('attendance')
            .select('*')
            .eq('user_id', user.id);

        if (attError) {
            console.error("Error fetching attendance records:", attError);
            showToast("Error loading attendance records", "error");
            attendanceRecords = {};
        } else {
            attendanceRecords = {};
            if (attData) {
                attData.forEach(rec => {
                    if (!attendanceRecords[rec.date]) {
                        attendanceRecords[rec.date] = {};
                    }
                    attendanceRecords[rec.date][rec.student_id] = rec.status;
                });
            }
        }

        // Render UI Components with Fresh State
        populateDropdowns();
        renderDashboard();
        renderDirectory();
        loadAttendanceSheet();

    } catch (err) {
        console.error("Unexpected error in fetchStudentsFromSupabase:", err);
        showToast("Failed to synchronize data from cloud.", "error");
    }
}

// Toast Notification System
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'success' ? 'toast-success' : 'toast-error'}`;
    toast.innerHTML = `<i data-lucide="${type === 'success' ? 'check' : 'alert-triangle'}"></i><span>${message}</span>`;
    container.appendChild(toast);
    if (window.lucide) lucide.createIcons();

    setTimeout(() => { toast.classList.add('show'); }, 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Tab Switching Navigation
function switchTab(tabName) {
    ['dashboard', 'directory', 'attendance'].forEach(t => {
        const viewEl = document.getElementById(`view-${t}`);
        if (viewEl) viewEl.classList.add('hidden');
        const btn = document.getElementById(`nav-${t}`);
        if (btn) btn.classList.remove('active');
        const mobBtn = document.getElementById(`mob-nav-${t}`);
        if (mobBtn) mobBtn.classList.remove('active');
    });

    const activeView = document.getElementById(`view-${tabName}`);
    if (activeView) activeView.classList.remove('hidden');
    const activeBtn = document.getElementById(`nav-${tabName}`);
    if (activeBtn) activeBtn.classList.add('active');
    const activeMob = document.getElementById(`mob-nav-${tabName}`);
    if (activeMob) activeMob.classList.add('active');

    if (tabName === 'dashboard') renderDashboard();
    if (tabName === 'directory') renderDirectory();
    if (tabName === 'attendance') loadAttendanceSheet();
}

// Populate Section Select Dropdowns
function populateDropdowns() {
    const attSelect = document.getElementById('att-section');
    const studSelect = document.getElementById('stud-section');
    
    if (attSelect) attSelect.innerHTML = '';
    if (studSelect) studSelect.innerHTML = '';

    if (sections.length === 0) {
        if (attSelect) attSelect.innerHTML = `<option value="">No sections available</option>`;
        if (studSelect) studSelect.innerHTML = `<option value="">No sections available</option>`;
        return;
    }

    sections.forEach(sec => {
        if (attSelect) attSelect.innerHTML += `<option value="${sec}">${sec}</option>`;
        if (studSelect) studSelect.innerHTML += `<option value="${sec}">${sec}</option>`;
    });
}

// Render Dashboard View & Metrics
function renderDashboard() {
    const todayStr = new Date().toISOString().split('T')[0];
    const dateLabel = document.getElementById('dash-date-label');
    if (dateLabel) dateLabel.innerText = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const totalStudents = students.length;
    const todayAtt = attendanceRecords[todayStr] || {};

    let presentCount = 0;
    let absentCount = 0;

    students.forEach(s => {
        const status = todayAtt[s.id];
        if (status === 'Present' || status === 'Late' || status === 'Excused') {
            presentCount++;
        } else if (status === 'Absent') {
            absentCount++;
        }
    });

    const statTotal = document.getElementById('stat-total');
    const statPresent = document.getElementById('stat-present');
    const statAbsent = document.getElementById('stat-absent');
    const statRate = document.getElementById('stat-rate');

    if (statTotal) statTotal.innerText = totalStudents;
    if (statPresent) statPresent.innerText = presentCount;
    if (statAbsent) statAbsent.innerText = absentCount;
    
    let overallPct = totalStudents > 0 ? Math.round((presentCount / totalStudents) * 100) : 0;
    if (statRate) statRate.innerText = overallPct + '%';

    const breakdownContainer = document.getElementById('section-breakdown-container');
    if (!breakdownContainer) return;
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
            if (status === 'Present' || status === 'Late' || status === 'Excused') secPresent++;
        });

        let secRate = secTotal > 0 ? Math.round((secPresent / secTotal) * 100) : 0;
        let badgeClass = 'badge-emerald';
        if (secRate < 75) badgeClass = 'badge-rose';
        else if (secRate < 90) badgeClass = 'badge-amber';

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
    if (window.lucide) lucide.createIcons();
}

// Render Class List View
function renderDirectory() {
    const tabsContainer = document.getElementById('directory-section-tabs');
    const bannerContainer = document.getElementById('directory-section-banner');
    const tbody = document.getElementById('directory-table-body');
    const searchInput = document.getElementById('directory-search');
    const searchQuery = searchInput ? searchInput.value.toLowerCase() : '';

    if (!tabsContainer || !bannerContainer || !tbody) return;

    tabsContainer.innerHTML = '';
    
    if (sections.length === 0) {
        activeDirectorySection = "";
        tabsContainer.innerHTML = `<span style="font-size: 12px; color: var(--text-muted); padding: 4px 0;">No sections available.</span>`;
        bannerContainer.innerHTML = `<div><h3>No Section Selected</h3><p>Please add a section first</p></div>`;
        tbody.innerHTML = `<tr><td colspan="5" style="padding: 32px; text-align: center; color: var(--text-muted); font-size: 12px;">No sections or students found.</td></tr>`;
        return;
    }

    if (!sections.includes(activeDirectorySection) && sections.length > 0) {
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
    if (sectionStudents.length === 0) {
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
    if (window.lucide) lucide.createIcons();
}

// Load Attendance Sheet View (Table Layout with Date Support)
function loadAttendanceSheet() {
    const dateEl = document.getElementById('att-date');
    const sectionEl = document.getElementById('att-section');
    const tbody = document.getElementById('att-table-body');
    const subtitle = document.getElementById('att-sheet-subtitle');

    if (!dateEl || !sectionEl || !tbody) return;
    
    const selectedDate = dateEl.value;
    const selectedSection = sectionEl.value;

    if (!selectedSection || sections.length === 0) {
        if (subtitle) subtitle.innerText = `No sections available. Please create a section first.`;
        tbody.innerHTML = `<tr><td colspan="5" style="padding: 32px; text-align: center; color: var(--text-muted); font-size: 13px;">No sections available. Please create a section first.</td></tr>`;
        return;
    }

    const formattedDate = new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });

    if (subtitle) {
        subtitle.innerHTML = `Showing attendance table for <strong>${selectedSection}</strong> on <strong>${formattedDate}</strong>`;
    }

    tbody.innerHTML = '';

    const secStudents = students.filter(s => s.section === selectedSection);
    if (secStudents.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="padding: 32px; text-align: center; color: var(--text-muted); font-size: 13px;">No students enrolled in section "${selectedSection}".</td></tr>`;
        return;
    }

    if (!attendanceRecords[selectedDate]) {
        attendanceRecords[selectedDate] = {};
    }

    secStudents.forEach((student, index) => {
        const currentStatus = attendanceRecords[selectedDate][student.id] || 'Present';

        const row = document.createElement('tr');
        row.innerHTML = `
            <td style="color: var(--text-muted); font-weight: 600;">${index + 1}</td>
            <td>
                <div class="student-cell">
                    <div class="student-avatar">
                        ${student.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()}
                    </div>
                    <span style="font-weight: 600; color: var(--text-main);">${student.name}</span>
                </div>
            </td>
            <td class="font-mono">${student.id}</td>
            <td><span class="badge badge-gray">${selectedDate}</span></td>
            <td class="text-center">
                <div class="status-pill-group">
                    ${['Present', 'Absent', 'Late', 'Excused'].map(status => {
                        const active = currentStatus === status;
                        return `<button type="button" 
                                    onclick="setAttendanceStatus('${selectedDate}', '${student.id}', '${status}')" 
                                    class="status-btn ${active ? 'active-' + status : ''}">
                                    ${status}
                                </button>`;
                    }).join('')}
                </div>
            </td>
        `;
        tbody.appendChild(row);
    });

    if (window.lucide) lucide.createIcons();
}

function setAttendanceStatus(date, studentId, status) {
    if (!attendanceRecords[date]) attendanceRecords[date] = {};
    attendanceRecords[date][studentId] = status;
    loadAttendanceSheet();
}

function markAllAttendance(status) {
    const dateEl = document.getElementById('att-date');
    const sectionEl = document.getElementById('att-section');
    if (!dateEl || !sectionEl) return;
    
    const date = dateEl.value;
    const section = sectionEl.value;
    const secStudents = students.filter(s => s.section === section);

    if (!attendanceRecords[date]) attendanceRecords[date] = {};
    secStudents.forEach(s => {
        attendanceRecords[date][s.id] = status;
    });

    loadAttendanceSheet();
    showToast(`Marked all as ${status}!`);
}

// Save Attendance Records to Supabase Cloud with Upsert
async function saveAttendance() {
    try {
        const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
        if (sessionError || !session || !session.user) {
            showToast("Authentication required to save attendance.", "error");
            return;
        }
        const user = session.user;

        const dateEl = document.getElementById('att-date');
        if (!dateEl) return;
        const selectedDate = dateEl.value;

        const currentDaySheet = attendanceRecords[selectedDate] || {};
        const upsertData = Object.keys(currentDaySheet).map(studentId => ({
            user_id: user.id,
            student_id: studentId,
            date: selectedDate,
            status: currentDaySheet[studentId]
        }));

        if (upsertData.length === 0) {
            showToast("No attendance data to save.", "error");
            return;
        }

        const { error } = await supabaseClient
            .from('attendance')
            .upsert(upsertData, { onConflict: 'user_id,student_id,date' });

        if (error) {
            console.error("Supabase attendance upsert error:", error);
            showToast("Failed to save attendance: " + error.message, "error");
        } else {
            showToast("Attendance saved successfully to cloud!");
        }
    } catch (err) {
        console.error("Unexpected error in saveAttendance:", err);
        showToast("An unexpected error occurred while saving attendance.", "error");
    }
}

// Modal & Section Handlers
function openAddSectionModal() {
    const modal = document.getElementById('modal-section');
    if (modal) {
        modal.classList.remove('hidden');
        const input = document.getElementById('new-section-name');
        if (input) { input.value = ''; input.focus(); }
    }
}

async function handleSectionSubmit(event) {
    event.preventDefault();
    try {
        const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
        if (sessionError || !session || !session.user) {
            showToast("Authentication required.", "error");
            return;
        }
        const user = session.user;

        const sectionInput = document.getElementById('new-section-name');
        const newSection = sectionInput.value.trim();
        if (!newSection) return;

        if (sections.includes(newSection)) {
            showToast("Section already exists!", "error");
            return;
        }

        const { error } = await supabaseClient
            .from('sections')
            .insert([{ name: newSection, user_id: user.id }]);

        if (error) {
            console.error("Error inserting section:", error);
            showToast(error.message, "error");
        } else {
            closeModal('modal-section');
            showToast("Section successfully added!");
            await fetchStudentsFromSupabase();
        }
    } catch (err) {
        console.error("Unexpected error in handleSectionSubmit:", err);
        showToast("Failed to add section.", "error");
    }
}

async function deleteSection(sectionName) {
    try {
        const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
        if (sessionError || !session || !session.user) return;
        const user = session.user;

        if (confirm(`Are you sure you want to delete the section "${sectionName}"?`)) {
            const { error } = await supabaseClient
                .from('sections')
                .delete()
                .eq('name', sectionName)
                .eq('user_id', user.id);

            if (error) {
                console.error("Error deleting section:", error);
                showToast(error.message, "error");
            } else {
                showToast("Section deleted successfully!");
                await fetchStudentsFromSupabase();
            }
        }
    } catch (err) {
        console.error("Unexpected error in deleteSection:", err);
        showToast("Failed to delete section.", "error");
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
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('hidden');
}

async function handleStudentSubmit(event) {
    event.preventDefault();
    try {
        const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
        if (sessionError || !session || !session.user) {
            showToast("You need to log in again.", "error");
            return;
        }
        const user = session.user;

        const name = document.getElementById('stud-name').value.trim();
        const id = document.getElementById('stud-id').value.trim();
        const section = document.getElementById('stud-section').value;
        const email = document.getElementById('stud-email').value.trim();

        const { error } = await supabaseClient
            .from('students')
            .insert([{ id, name, section, email, user_id: user.id }]);

        if (error) {
            console.error("Error inserting student:", error);
            showToast(error.message, "error");
        } else {
            showToast("Student successfully added to Supabase!");
            closeModal('modal-student');
            await fetchStudentsFromSupabase();
        }
    } catch (err) {
        console.error("Unexpected error in handleStudentSubmit:", err);
        showToast("Failed to add student.", "error");
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
    if (window.lucide) lucide.createIcons();
}

async function confirmDeleteStudent() {
    if (!studentToDeleteId) return;

    const confirmBtn = document.getElementById('confirm-delete-btn');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.innerText = "Deleting...";
    }

    try {
        const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
        if (sessionError || !session || !session.user) return;
        const user = session.user;

        const { error } = await supabaseClient
            .from('students')
            .delete()
            .eq('id', studentToDeleteId)
            .eq('user_id', user.id);

        if (error) {
            console.error("Error deleting student:", error);
            showToast(error.message, "error");
        } else {
            showToast("Student deleted successfully!");
            closeModal('modal-delete-student');
            await fetchStudentsFromSupabase();
        }
    } catch (err) {
        console.error("Unexpected error in confirmDeleteStudent:", err);
        showToast("Failed to delete student.", "error");
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.innerText = "Delete";
        }
        studentToDeleteId = null;
    }
}

async function handleLogout() {
    try {
        const { error } = await supabaseClient.auth.signOut();
        if (error) {
            console.error("Error during logout:", error);
            showToast("Error during logout", "error");
        } else {
            showToast("Logged out successfully! Redirecting...", "success");
            setTimeout(() => { window.location.href = 'index.html'; }, 1000);
        }
    } catch (err) {
        console.error("Unexpected error in handleLogout:", err);
        window.location.href = 'index.html';
    }
}