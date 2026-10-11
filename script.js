const SUPABASE_URL = 'https://uarburvejxtjvtqawtlt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhcmJ1cnZlanh0anZ0cWF3dGx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE2OTg5NzMsImV4cCI6MjEwNzI3NDk3M30.BRFhOet9M0uKf3mvb5zDaQVJ4ihdDyIUxqSgb19ESX8';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
    alertBox.textContent = message;
    alertBox.className = `alert ${type}`;
}

function hideAlert() {
    const alertBox = document.getElementById('alertBox');
    alertBox.className = 'alert hidden';
}

async function handleLogin(event) {
    event.preventDefault();
    hideAlert();

    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;

    // Sa halip na mag-declare ng bagong const, direktang gamitin ang window.supabase
const { data, error } = await window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY).auth.signInWithPassword({
    email,
    password,
});

    if (error) {
        // Kapag mali ang password o email, ipapakita ang error message rito
        showAlert('Incorrect email or password. Please try again.', 'error');
    } else {
        // Kapag tama ang password, magre-redirect sa iyong external website
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

    // Disable button and show loading state
    submitBtn.disabled = true;
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Creating Account...';

    try{
    const { data, error } = await window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY).auth.signUp({
        email,
        password,
    });

    if (error) {
        showAlert(error.message, 'error');
    } else {
        showAlert('Signup successful! Please check your email for verification.', 'success');
    }
    }
   finally {
        // Re-enable button
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
    }
}