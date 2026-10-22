// Initialize Supabase Client
const SUPABASE_URL = "https://jwjivkdgzxuaecplkkad.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3aml2a2Rnenh1YWVjcGxra2FkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2NTU0NzcsImV4cCI6MjEwODIzMTQ3N30.VTFzl7FlP0apBo5ngnclq3eA9aDE-o3I560-XHSiDKg";

let supabaseClient = null;
let authBusy = false;

if (window.supabase) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// Check session on load
document.addEventListener("DOMContentLoaded", async () => {
    try {
        if (supabaseClient) {
            const { data: { session } } = await supabaseClient.auth.getSession();
            if (session) {
                window.location.href = "main.html";
            }
        }
    } catch (err) {
        console.error("Session check failed:", err);
    }
});

function switchTab(tab) {
    const loginTab = document.getElementById("loginTab");
    const signupTab = document.getElementById("signupTab");
    const loginForm = document.getElementById("loginForm");
    const signupForm = document.getElementById("signupForm");
    const alertBox = document.getElementById("alertBox");

    alertBox.classList.add("hidden");

    if (tab === "login") {
        loginTab.classList.add("active");
        signupTab.classList.remove("active");
        loginForm.classList.add("active");
        signupForm.classList.remove("active");
    } else {
        signupTab.classList.add("active");
        loginTab.classList.remove("active");
        signupForm.classList.add("active");
        loginForm.classList.remove("active");
    }
}

function showAlert(message, type = "error") {
    const alertBox = document.getElementById("alertBox");
    alertBox.textContent = message;
    alertBox.className = `alert ${type}`;
    alertBox.classList.remove("hidden");
}

function friendlyAuthError(err) {
    const msg = (err && err.message) ? err.message : "Something went wrong.";
    if (/email not confirmed/i.test(msg)) {
        return "Please confirm your email first — check your inbox for the confirmation link, then sign in.";
    }
    if (/invalid login credentials/i.test(msg)) {
        return "Wrong email or password. Please try again.";
    }
    if (/already registered|already been registered/i.test(msg)) {
        return "An account with this email already exists. Please sign in instead.";
    }
    if (/rate limit/i.test(msg)) {
        return "Too many sign-up/sign-in attempts right now. Please wait a minute and try again.";
    }
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
        return "Cannot reach the server. Please check your internet connection and try again.";
    }
    return msg;
}

function setSubmitting(formEl, busy, busyLabel, idleLabel) {
    authBusy = busy;
    const btn = formEl ? formEl.querySelector('button[type="submit"]') : null;
    if (!btn) return;
    btn.disabled = busy;
    const span = btn.querySelector("span");
    if (span) span.textContent = busy ? busyLabel : idleLabel;
}

async function handleLogin(e) {
    e.preventDefault();
    if (authBusy) return;

    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;

    if (!email || !password) {
        showAlert("Please enter both email and password.");
        return;
    }

    setSubmitting(e.target, true, "Signing in...", "Sign In");
    try {
        if (supabaseClient) {
            const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
            if (error) throw error;
            showAlert("Signed in successfully! Loading your data from the cloud...", "success");
            setTimeout(() => { window.location.href = "main.html"; }, 600);
        } else {
            localStorage.setItem("scholog_local_user", JSON.stringify({ email, name: email.split("@")[0] }));
            showAlert("Signed in locally! Redirecting...", "success");
            setTimeout(() => { window.location.href = "main.html"; }, 600);
        }
    } catch (err) {
        setSubmitting(e.target, false, "Signing in...", "Sign In");
        showAlert(friendlyAuthError(err));
    }
}

async function handleSignup(e) {
    e.preventDefault();
    if (authBusy) return;

    const email = document.getElementById("signupEmail").value.trim();
    const password = document.getElementById("signupPassword").value;

    if (!email || !password) {
        showAlert("Please fill in all required fields.");
        return;
    }

    if (password.length < 6) {
        showAlert("Password must be at least 6 characters long.");
        return;
    }

    setSubmitting(e.target, true, "Creating account...", "Create Account");
    try {
        if (supabaseClient) {
            const redirectUrl = new URL("index.html", window.location.href).href;
            const { data, error } = await supabaseClient.auth.signUp({
                email,
                password,
                options: {
                    emailRedirectTo: redirectUrl,
                    data: { full_name: email.split("@")[0] }
                }
            });
            if (error) throw error;

            // Supabase returns an empty identities array when email already exists and confirmation is active
            if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
                setSubmitting(e.target, false, "Creating account...", "Create Account");
                switchTab("login");
                document.getElementById("loginEmail").value = email;
                showAlert("An account with this email already exists. Please sign in instead.");
                return;
            }

            if (data.session) {
                showAlert("Account created! Loading your workspace...", "success");
                setTimeout(() => { window.location.href = "main.html"; }, 600);
            } else {
                setSubmitting(e.target, false, "Creating account...", "Create Account");
                showAlert("Account created! Check your email to confirm your account, then sign in.", "success");
                setTimeout(() => switchTab("login"), 1800);
            }
        } else {
            localStorage.setItem("scholog_local_user", JSON.stringify({ email, name: email.split("@")[0] }));
            showAlert("Account created locally! Redirecting...", "success");
            setTimeout(() => { window.location.href = "main.html"; }, 800);
        }
    } catch (err) {
        setSubmitting(e.target, false, "Creating account...", "Create Account");
        showAlert(friendlyAuthError(err));
    }
}
