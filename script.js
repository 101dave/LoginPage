const SUPABASE_URL = 'https://uarburvejxtjvtqawtlt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhcmJ1cnZlanh0anZ0cWF3dGx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE2OTg5NzMsImV4cCI6MjEwNzI3NDk3M30.BRFhOet9M0uKf3mvb5zDaQVJ4ihdDyIUxqSgb19ESX8';

// ✅ FIX: Explicit auth config so GitHub Pages (not just localhost) works
// - persistSession + storageKey ensures session survives on github.io
// - detectSessionInUrl + flowType: 'pkce' is required for modern Supabase
// - This config is exempt from Edge/Brave's strict tracking prevention on localhost but needs it on production
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

function switchTab(tab) {
    const loginTab = document.getElementById('loginTab');
    const signupTab = document.getElementById('signupTab');
    const loginForm = document.getElementById('loginForm');
    const signupForm = document.getElementById('signupForm');
    hideAlert();

    if (tab === 'login') {
        loginTab.classList.add('active');
        signupTab.classList.remove('active');
        loginForm.classList.add('active');
        signupForm.classList.remove('active');
    } else {
        signupTab.classList.add('active');
        loginTab.classList.remove('active');
        signupForm.classList.add('active');
        loginForm.classList.remove('active');
    }
}

function showAlert(message, type) {
    const alertBox = document.getElementById('alertBox');
    if (!alertBox) return;
    alertBox.textContent = message;
    alertBox.className = `alert ${type}`;
}

function hideAlert() {
    const alertBox = document.getElementById('alertBox');
    if (!alertBox) return;
    alertBox.className = 'alert hidden';
}

async function handleLogin(event) {
    event.preventDefault();
    hideAlert();

    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;

    // Small network check before calling Supabase
    if (!navigator.onLine) {
        showAlert('You appear to be offline. Check your internet connection.', 'error');
        return;
    }

    const { data, error } = await supabaseClient.auth.signInWithPassword({
        email,
        password,
    });

    if (error) {
        console.error('Login error:', error);
        // Detect network/ad-block caused failure
        if (error.message && error.message.toLowerCase().includes('failed to fetch')) {
            showAlert('Network blocked: Your browser (Tracking Prevention / AdBlock / Brave Shield) is blocking Supabase. Disable it for this site and try again. See console for details.', 'error');
        } else {
            showAlert(error.message || 'Incorrect email or password. Please try again.', 'error');
        }
    } else {
        showAlert('Login successful! Redirecting...', 'success');
        setTimeout(() => {
            window.location.href = 'main.html';
        }, 1000);
    }
}

async function handleSignup(event) {
    event.preventDefault();
    hideAlert();

    const submitBtn = event.target.querySelector('[type="submit"]') || event.submitter;
    const email = document.getElementById('signupEmail').value;
    const password = document.getElementById('signupPassword').value;

    if (submitBtn) submitBtn.disabled = true;
    const originalHTML = submitBtn ? submitBtn.innerHTML : '';
    if (submitBtn) submitBtn.textContent = 'Creating Account...';

    try {
        const { data, error } = await supabaseClient.auth.signUp({
            email,
            password,
            options: {
                // ✅ FIX: Tell Supabase where to redirect after email confirmation
                emailRedirectTo: window.location.origin + window.location.pathname.replace('index.html','') + 'main.html'
            }
        });

        if (error) {
            if (error.message && error.message.toLowerCase().includes('failed to fetch')) {
                showAlert('Network blocked: Tracking Prevention / AdBlock is blocking Supabase. Please whitelist ' + window.location.hostname, 'error');
            } else {
                showAlert(error.message, 'error');
            }
        } else {
            showAlert('Signup successful! Please check your email for verification.', 'success');
        }
    } catch (err) {
        console.error('Signup unexpected error:', err);
        showAlert('Network error: Failed to reach Supabase. Check AdBlock / Tracking Prevention.', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalHTML;
            if (window.lucide) lucide.createIcons();
        }
    }
}

// Optional: log auth state for debugging on GitHub Pages
supabaseClient.auth.onAuthStateChange((event, session) => {
    console.log('[Scholog Auth]', event, session ? 'session OK for ' + session.user.email : 'no session');
});
