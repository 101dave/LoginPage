// ==========================================
// SCHOLOG - MAIN APPLICATION LOGIC
// ==========================================

const SUPABASE_URL = 'https://uarburvejxtjvtqawtlt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhcmJ1cnZlanh0anZ0cWF3dGx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE2OTg5NzMsImV4cCI6MjEwNzI3NDk3M30.BRFhOet9M0uKf3mvb5zDaQVJ4ihdDyIUxqSgb19ESX8';

// ✅ FIX for GitHub Pages: explicit auth storage + PKCE flow
// Without this, Edge/Brave Tracking Prevention blocks session on github.io but not on localhost
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: window.localStorage,
        storageKey: 'scholog-auth-token',
        flowType: 'pkce'
    }
});

// ✅ Helper to detect network/ad-block failures
function isNetworkBlockError(err) {
    if (!err) return false;
    const msg = (err.message || JSON.stringify(err)).toLowerCase();
    return msg.includes('failed to fetch') || msg.includes('err_connection') || msg.includes('networkerror');
}

// Application State
let sections = [];
let students = []; 
let attendanceRecords = {};
let activeDirectorySection = "";
let studentToDeleteId = null;
let sectionToDelete = null;

// State variables for Calendar History View
let currentHistoryStudentId = null;
let historyCurrentDate = new Date();

// Auth Guard on Page Load
async function checkAuthGuard() {
    try {
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        if (error || !session) {
            console.warn("No active session found. Redirecting to login.");
            window.location.href = 'index.html';
            return false;
        }
        return true;
    } catch (err) {
        console.error("Critical error in checkAuthGuard:", err);
        window.location.href = 'index.html';
        return false;
    }
}

// Function para i-load at i-customize ang User Profile sa Header
async function loadUserProfile() {
    try {
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        if (error || !session || !session.user) return;

        const user = session.user;
        const email = user.email || 'User';
        
        const userKey = `scholog_profile_${user.id}`;
        const savedProfile = JSON.parse(localStorage.getItem(userKey) || '{}');

        const customName = savedProfile.name || user.user_metadata?.display_name || '';
        const customAvatar = savedProfile.avatar || user.user_metadata?.avatar_url || '';

        const displayName = customName ? customName : email;
        const initial = email.charAt(0).toUpperCase();

        const userNameDisplay = document.getElementById('userNameDisplay');
        const userAvatarEl = document.getElementById('userAvatar');
        
        if (userNameDisplay) userNameDisplay.innerText = displayName;
        if (userAvatarEl) {
            if (customAvatar) {
                userAvatarEl.innerHTML = `<img src="${customAvatar}" alt="Profile" onerror="this.parentElement.innerHTML='${initial}'">`;
            } else {
                userAvatarEl.innerText = initial;
            }
        }

    } catch (err) {
        console.error("Error loading user profile:", err);
    }
}

function openProfileModal() {
    const modal = document.getElementById('modal-profile');
    if (!modal) return;

    supabaseClient.auth.getSession().then(({ data: { session } }) => {
        if (!session || !session.user) return;
        const userKey = `scholog_profile_${session.user.id}`;
        const savedProfile = JSON.parse(localStorage.getItem(userKey) || '{}');

        const savedName = savedProfile.name || session.user.user_metadata?.display_name || '';
        const savedAvatar = savedProfile.avatar || session.user.user_metadata?.avatar_url || '';
        
        document.getElementById('profile-display-name').value = savedName;
        
        const previewAvatar = document.getElementById('modalPreviewAvatar');
        const fileNameDisplay = document.getElementById('profile-file-name');

        if (previewAvatar) {
            if (savedAvatar) {
                previewAvatar.innerHTML = `<img src="${savedAvatar}" alt="Preview" style="width:100%; height:100%; object-fit:cover;">`;
                if (fileNameDisplay) fileNameDisplay.innerText = 'Change profile picture';
            } else {
                const emailInitial = savedName ? savedName.charAt(0).toUpperCase() : session.user.email.charAt(0).toUpperCase();
                previewAvatar.innerText = emailInitial;
                if (fileNameDisplay) fileNameDisplay.innerText = 'Select a profile picture...';
            }
        }
        
        const fileInput = document.getElementById('profile-image-file');
        if (fileInput) fileInput.value = '';

        modal.classList.remove('hidden');
        if (window.lucide) lucide.createIcons();
    });
}

function previewProfileImage(event) {
    const file = event.target.files[0];
    const fileNameDisplay = document.getElementById('profile-file-name');
    
    if (file) {
        if (fileNameDisplay) fileNameDisplay.innerText = file.name;
        const reader = new FileReader();
        reader.onload = function(e) {
            const previewAvatar = document.getElementById('modalPreviewAvatar');
            if (previewAvatar) {
                previewAvatar.innerHTML = `<img src="${e.target.result}" alt="Preview" style="width:100%; height:100%; object-fit:cover;">`;
            }
        };
        reader.readAsDataURL(file);
    }
}

async function handleProfileSubmit(event) {
    event.preventDefault();
    
    const displayName = document.getElementById('profile-display-name').value.trim();
    const fileInput = document.getElementById('profile-image-file');

    try {
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        if (error || !session || !session.user) {
            showToast("Session expired. Please sign in again.", "error");
            return;
        }

        const userKey = `scholog_profile_${session.user.id}`;
        let existingProfile = JSON.parse(localStorage.getItem(userKey) || '{}');
        existingProfile.name = displayName;

        if (fileInput && fileInput.files && fileInput.files[0]) {
            const file = fileInput.files[0];
            const reader = new FileReader();

            reader.onload = async function(e) {
                existingProfile.avatar = e.target.result;
                localStorage.setItem(userKey, JSON.stringify(existingProfile));

                await supabaseClient.auth.updateUser({
                    data: { display_name: displayName, avatar_url: e.target.result }
                });

                showToast("Profile updated successfully!");
                closeModal('modal-profile');
                loadUserProfile();
            };
            reader.readAsDataURL(file);
        } else {
            localStorage.setItem(userKey, JSON.stringify(existingProfile));

            await supabaseClient.auth.updateUser({
                data: { display_name: displayName }
            });

            showToast("Profile updated successfully!");
            closeModal('modal-profile');
            loadUserProfile();
        }

    } catch (err) {
        console.error("Error saving profile:", err);
        showToast("Failed to update profile.", "error");
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const isAuthenticated = await checkAuthGuard();
    if (!isAuthenticated) return;

    await loadUserProfile();

    const todayStr = new Date().toISOString().split('T')[0];
    const attDateEl = document.getElementById('att-date');
    if (attDateEl) attDateEl.value = todayStr;

    await fetchStudentsFromSupabase();
    if (window.lucide) {
        lucide.createIcons();
    }
});

function toggleMobileMenu() {
    const menu = document.getElementById('mobileMenu');
    if (menu) {
        menu.classList.toggle('hidden');
    }
}

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
            .select('*')
            .eq('user_id', user.id);

        if (secError) {
            console.error("Error fetching sections:", JSON.stringify(secError, null, 2));
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
            console.error("Error fetching students:", JSON.stringify(studError, null, 2));
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
            console.error("Error fetching attendance records:", JSON.stringify(attError, null, 2));
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

        populateDropdowns();
        renderDashboard();
        renderDirectory();
        loadAttendanceSheet();

    } catch (err) {
        console.error("Unexpected error in fetchStudentsFromSupabase:", err);
        if (isNetworkBlockError(err)) {
            showToast("Network blocked: Tracking Prevention / AdBlock is blocking Supabase. Whitelist this site and reload. (Works on localhost because localhost is exempt)", "error");
            console.warn("[Scholog] Fix: In Edge go to edge://settings/privacy -> Tracking prevention -> Exceptions Add 101dave.github.io. In Brave disable Shields for this site. In uBlock disable for github.io + supabase.co");
        } else {
            showToast("Failed to synchronize data from cloud.", "error");
        }
    }
}

async function exportDataBackup() {
    try {
        const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
        if (sessionError || !session || !session.user) {
            showToast("Authentication required for backup.", "error");
            return;
        }
        const userId = session.user.id;

        const { data: secData } = await supabaseClient.from('sections').select('*').eq('user_id', userId);
        const { data: studData } = await supabaseClient.from('students').select('*').eq('user_id', userId);
        const { data: attData } = await supabaseClient.from('attendance').select('*').eq('user_id', userId);

        const backupPayload = {
            version: "1.0",
            exportDate: new Date().toISOString(),
            sections: secData || [],
            students: studData || [],
            attendance: attData || []
        };

        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backupPayload, null, 2));
        const downloadAnchor = document.createElement('a');
        downloadAnchor.setAttribute("href", dataStr);
        downloadAnchor.setAttribute("download", `Scholog_Backup_${new Date().toISOString().split('T')[0]}.json`);
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();

        showToast("Backup downloaded successfully!");
    } catch (err) {
        console.error("Export backup error:", err);
        showToast("Failed to export backup data.", "error");
    }
}

async function importDataBackup(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const content = e.target.result;
            const parsedData = JSON.parse(content);

            if (!parsedData.sections || !parsedData.students || !parsedData.attendance) {
                showToast("Invalid backup file format.", "error");
                return;
            }

            const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
            if (sessionError || !session || !session.user) {
                showToast("Authentication required to restore data.", "error");
                return;
            }
            const userId = session.user.id;

            const sectionsToInsert = parsedData.sections.map(s => ({ name: s.name, user_id: userId }));
            const studentsToInsert = parsedData.students.map(st => ({
                id: st.id,
                name: st.name,
                section: st.section,
                email: st.email,
                user_id: userId
            }));
            const attendanceToInsert = parsedData.attendance.map(at => ({
                student_id: at.student_id,
                date: at.date,
                status: at.status,
                user_id: userId
            }));

            if (sectionsToInsert.length > 0) {
                await supabaseClient.from('sections').upsert(sectionsToInsert, { onConflict: 'user_id,name' });
            }

            if (studentsToInsert.length > 0) {
                await supabaseClient.from('students').upsert(studentsToInsert, { onConflict: 'user_id,id' });
            }

            if (attendanceToInsert.length > 0) {
                await supabaseClient.from('attendance').upsert(attendanceToInsert, { onConflict: 'user_id,student_id,date' });
            }

            showToast("Data restored successfully!");
            await fetchStudentsFromSupabase();

        } catch (err) {
            console.error("Import backup error:", err);
            showToast("Failed to parse or restore backup file.", "error");
        } finally {
            event.target.value = '';
        }
    };
    reader.readAsText(file);
}

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
        tbody.innerHTML = `<tr><td colspan="4" style="padding: 32px; text-align: center; color: var(--text-muted); font-size: 12px;">No sections or students found.</td></tr>`;
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
        tbody.innerHTML = `<tr><td colspan="4" style="padding: 32px; text-align: center; color: var(--text-muted); font-size: 12px;">No students found in this section.</td></tr>`;
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
                <td class="text-right">
                    <button onclick="openStudentHistory('${s.id}')" style="background:none; border:none; color:var(--emerald-text); cursor:pointer; font-size:12px; font-weight:600; margin-right:8px;">History</button>
                    <button onclick="openAddStudentModal('${s.id}')" style="background:none; border:none; color:var(--primary); cursor:pointer; font-size:12px; font-weight:600; margin-right:8px;">Edit</button>
                    <button onclick="openTransferModal('${s.id}')" style="background:none; border:none; color:var(--blue-text); cursor:pointer; font-size:12px; font-weight:600; margin-right:8px;">Move</button>
                    <button onclick="deleteStudent('${s.id}')" style="background:none; border:none; color:var(--rose-text); cursor:pointer; font-size:12px; font-weight:500;">Delete</button>
                </td>
            </tr>
        `;
    });
    if (window.lucide) lucide.createIcons();
}

function openStudentHistory(studentId) {
    const student = students.find(s => s.id === studentId);
    if (!student) return;

    currentHistoryStudentId = studentId;
    historyCurrentDate = new Date();

    document.getElementById('history-student-name').innerText = student.name;
    document.getElementById('history-student-info').innerText = `ID: ${student.id} | Section: ${student.section}`;

    renderCalendarGrid();
    document.getElementById('modal-attendance-history').classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
}

function changeHistoryMonth(offset) {
    historyCurrentDate.setDate(1);
    historyCurrentDate.setMonth(historyCurrentDate.getMonth() + offset);
    renderCalendarGrid();
}

function renderCalendarGrid() {
    if (!currentHistoryStudentId) return;

    const year = historyCurrentDate.getFullYear();
    const month = historyCurrentDate.getMonth();

    const monthName = historyCurrentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    document.getElementById('history-month-label').innerText = monthName;

    const gridBody = document.getElementById('calendar-grid-body');
    gridBody.innerHTML = '';

    const firstDayIndex = new Date(year, month, 1).getDay();
    const totalDaysInMonth = new Date(year, month + 1, 0).getDate();

    let counts = { Present: 0, Late: 0, Absent: 0, Excused: 0 };

    for (let i = 0; i < firstDayIndex; i++) {
        gridBody.innerHTML += `<div class="calendar-day-cell empty"></div>`;
    }

    for (let day = 1; day <= totalDaysInMonth; day++) {
        const formattedDay = day < 10 ? `0${day}` : `${day}`;
        const formattedMonth = (month + 1) < 10 ? `0${month + 1}` : `${month + 1}`;
        const dateKey = `${year}-${formattedMonth}-${formattedDay}`;

        let status = null;
        if (attendanceRecords[dateKey] && attendanceRecords[dateKey][currentHistoryStudentId]) {
            status = attendanceRecords[dateKey][currentHistoryStudentId];
            if (counts[status] !== undefined) counts[status]++;
        }

        let statusHtml = '';
        let cellClass = '';
        if (status) {
            cellClass = `status-cell-${status}`;
            statusHtml = `<div class="day-status-indicator">${status}</div>`;
        }

        gridBody.innerHTML += `
            <div class="calendar-day-cell ${cellClass}">
                <span class="day-number">${day}</span>
                ${statusHtml}
            </div>
        `;
    }

    const statsContainer = document.getElementById('history-stats-summary');
    statsContainer.innerHTML = `
        <div class="history-stat-box"><div class="val text-emerald">${counts.Present}</div><div class="lbl">Present</div></div>
        <div class="history-stat-box"><div class="val" style="color:var(--amber-text);">${counts.Late}</div><div class="lbl">Late</div></div>
        <div class="history-stat-box"><div class="val text-rose">${counts.Absent}</div><div class="lbl">Absent</div></div>
        <div class="history-stat-box"><div class="val" style="color:var(--blue-text);">${counts.Excused}</div><div class="lbl">Excused</div></div>
    `;
}

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

    secStudents.forEach((student, index) => {
        const currentStatus = (attendanceRecords[selectedDate] && attendanceRecords[selectedDate][student.id]) 
            ? attendanceRecords[selectedDate][student.id] 
            : '';

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
            showToast("Failed to save attendance: " + error.message, "error");
        } else {
            showToast("Attendance saved successfully to cloud!");
        }
    } catch (err) {
        showToast("An unexpected error occurred while saving attendance.", "error");
    }
}

function exportAttendanceToPDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    const dateEl = document.getElementById('att-date');
    const sectionEl = document.getElementById('att-section');

    const selectedDate = dateEl ? dateEl.value : '';
    const selectedSection = sectionEl ? sectionEl.value : '';

    if (!selectedSection) {
        showToast("Please select a section before exporting.", "error");
        return;
    }

    const secStudents = students.filter(s => s.section === selectedSection);
    if (secStudents.length === 0) {
        showToast("No students in the selected section.", "error");
        return;
    }

    doc.setFontSize(18);
    doc.text("Scholog — Attendance Report", 14, 20);

    doc.setFontSize(11);
    doc.setTextColor(100);
    doc.text(`Section: ${selectedSection}`, 14, 28);
    doc.text(`Date: ${selectedDate}`, 14, 34);

    const currentDaySheet = attendanceRecords[selectedDate] || {};
    const tableRows = [];

    secStudents.forEach((student, index) => {
        const status = currentDaySheet[student.id] || 'Present';
        tableRows.push([
            index + 1,
            student.name,
            student.id,
            student.email || 'N/A',
            status
        ]);
    });

    doc.autoTable({
        startY: 42,
        head: [['#', 'Student Name', 'Student ID', 'Email', 'Status']],
        body: tableRows,
        theme: 'striped',
        headStyles: { fillColor: [15, 23, 42] },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        styles: { font: 'helvetica', fontSize: 10 }
    });

    doc.save(`Attendance_${selectedSection.replace(/\s+/g, '_')}_${selectedDate}.pdf`);
    showToast("Nai-download na ang Attendance PDF!");
}

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
        if (sessionError || !session || !session.user) return;
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
            showToast(error.message, "error");
        } else {
            closeModal('modal-section');
            showToast("Section successfully added!");
            await fetchStudentsFromSupabase();
        }
    } catch (err) {
        showToast("Failed to add section.", "error");
    }
}

function deleteSection(sectionName) {
    sectionToDelete = sectionName;
    const nameEl = document.getElementById('delete-section-name');
    if (nameEl) nameEl.innerText = sectionName;

    const confirmBtn = document.getElementById('confirm-delete-section-btn');
    if (confirmBtn) {
        confirmBtn.onclick = async () => { await confirmDeleteSection(); };
    }

    document.getElementById('modal-delete-section').classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
}

async function confirmDeleteSection() {
    if (!sectionToDelete) return;
    try {
        const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
        if (sessionError || !session || !session.user) return;
        const user = session.user;

        const { error } = await supabaseClient
            .from('sections')
            .delete()
            .eq('name', sectionToDelete)
            .eq('user_id', user.id);

        if (error) {
            showToast(error.message, "error");
        } else {
            showToast("Section deleted successfully!");
            closeModal('modal-delete-section');
            await fetchStudentsFromSupabase();
        }
    } catch (err) {
        showToast("Failed to delete section.", "error");
    } finally {
        sectionToDelete = null;
    }
}

function openAddStudentModal(studentId = null) {
    if (sections.length === 0) {
        showToast("Please add a section first before adding students.", "error");
        openAddSectionModal();
        return;
    }
    
    const modalTitle = document.getElementById('student-modal-title');
    const form = document.getElementById('form-student');
    form.reset();
    
    if (studentId) {
        modalTitle.innerText = "Edit Student";
        const student = students.find(s => s.id === studentId);
        if (student) {
            document.getElementById('student-edit-id').value = student.id;
            document.getElementById('stud-name').value = student.name;
            document.getElementById('stud-id').value = student.id;
            document.getElementById('stud-id').disabled = true;
            document.getElementById('stud-section').value = student.section;
            document.getElementById('stud-email').value = student.email || '';
        }
    } else {
        modalTitle.innerText = "Add New Student";
        document.getElementById('student-edit-id').value = "";
        document.getElementById('stud-id').disabled = false;
        document.getElementById('stud-section').value = activeDirectorySection || sections[0];
    }
    
    document.getElementById('modal-student').classList.remove('hidden');
}

function openAddStudentModalForSection(section) {
    openAddStudentModal();
    document.getElementById('stud-section').value = section;
}

function openTransferModal(studentId) {
    const student = students.find(s => s.id === studentId);
    if (!student) return;

    document.getElementById('transfer-student-id').value = student.id;
    document.getElementById('transfer-student-name').value = student.name;

    const selectEl = document.getElementById('transfer-new-section');
    selectEl.innerHTML = '';

    sections.forEach(sec => {
        if (sec !== student.section) {
            selectEl.innerHTML += `<option value="${sec}">${sec}</option>`;
        }
    });

    if (selectEl.options.length === 0) {
        showToast("No other section available to move into.", "error");
        return;
    }

    document.getElementById('modal-transfer-student').classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
}

async function handleTransferSubmit(event) {
    event.preventDefault();
    try {
        const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
        if (sessionError || !session || !session.user) return;
        const user = session.user;

        const studentId = document.getElementById('transfer-student-id').value;
        const newSection = document.getElementById('transfer-new-section').value;

        const { error } = await supabaseClient
            .from('students')
            .update({ section: newSection })
            .eq('id', studentId)
            .eq('user_id', user.id);

        if (error) {
            showToast(error.message, "error");
        } else {
            showToast("Student successfully moved to " + newSection + "!");
            closeModal('modal-transfer-student');
            await fetchStudentsFromSupabase();
        }
    } catch (err) {
        showToast("Failed to transfer student.", "error");
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('hidden');
}

async function handleStudentSubmit(event) {
    event.preventDefault();
    try {
        const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
        if (sessionError || !session || !session.user) return;
        const user = session.user;

        const editId = document.getElementById('student-edit-id').value;
        const name = document.getElementById('stud-name').value.trim();
        const id = document.getElementById('stud-id').value.trim();
        const section = document.getElementById('stud-section').value;
        const email = document.getElementById('stud-email').value.trim();

        let error;
        if (editId) {
            const res = await supabaseClient
                .from('students')
                .update({ name, section, email })
                .eq('id', editId)
                .eq('user_id', user.id);
            error = res.error;
        } else {
            const existing = students.find(s => s.id === id);
            if (existing) {
                showToast("Student ID already exists!", "error");
                return;
            }

            const res = await supabaseClient
                .from('students')
                .insert([{ id, name, section, email, user_id: user.id }]);
            error = res.error;
        }

        if (error) {
            showToast(error.message, "error");
        } else {
            showToast(editId ? "Student successfully updated!" : "Student successfully added!");
            closeModal('modal-student');
            await fetchStudentsFromSupabase();
        }
    } catch (err) {
        showToast("Failed to save student data.", "error");
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
            showToast(error.message, "error");
        } else {
            showToast("Student deleted successfully!");
            closeModal('modal-delete-student');
            await fetchStudentsFromSupabase();
        }
    } catch (err) {
        showToast("Failed to delete student.", "error");
    } finally {
        studentToDeleteId = null;
    }
}

async function handleLogout() {
    try {
        await supabaseClient.auth.signOut();
        showToast("Logged out successfully! Redirecting...", "success");
        setTimeout(() => { window.location.href = 'index.html'; }, 1000);
    } catch (err) {
        window.location.href = 'index.html';
    }
}