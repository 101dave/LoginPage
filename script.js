// Initialize Supabase Client
const SUPABASE_URL = "https://jwjivkdgzxuaecplkkad.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3aml2a2Rnenh1YWVjcGxra2FkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2NTU0NzcsImV4cCI6MjEwODIzMTQ3N30.VTFzl7FlP0apBo5ngnclq3eA9aDE-o3I560-XHSiDKg";

// Capture initial URL hash/query BEFORE Supabase SDK strips auth fragments
const initialRawFragment = (
    (window.location.hash ? window.location.hash.slice(1) : "") +
    (window.location.search ? "&" + window.location.search.slice(1) : "")
);

let supabaseClient = null;
let authBusy = false;
let isRecoveryMode = false;
let resetCooldownTimer = null;

// PWA Install Prompt State
let deferredPrompt = null;

// Helper to check if the browser supports native PWA installation
function isGoogleChrome() {
    const ua = navigator.userAgent || "";
    return Boolean(window.chrome || /Chrome|CriOS|Edg|OPR|SamsungBrowser/i.test(ua));
}

function isStandaloneMode() {
    return Boolean(
        (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
        window.navigator.standalone === true
    );
}

window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;

    const installBanner = document.getElementById("pwaInstallBanner");
    if (installBanner && !isStandaloneMode()) {
        installBanner.classList.remove("hidden");
    }
});

async function triggerPwaInstall() {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === "accepted") {
            showAlert("App installed successfully!", "success");
            const installBanner = document.getElementById("pwaInstallBanner");
            if (installBanner) installBanner.classList.add("hidden");
        }
        deferredPrompt = null;
    } else {
        showAlert("To install Scholog: tap your browser's menu button and select 'Install app' or 'Add to Home screen'.", "success");
    }
}

window.addEventListener("DOMContentLoaded", () => {
    if (window.matchMedia("(display-mode: standalone)").matches) {
        const installBanner = document.getElementById("pwaInstallBanner");
        if (installBanner) installBanner.classList.add("hidden");
    }
});

if (window.supabase) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Catch PASSWORD_RECOVERY in both implicit (#type=recovery) and PKCE (?code=...) flows
    supabaseClient.auth.onAuthStateChange((event) => {
        if (event === "PASSWORD_RECOVERY") {
            isRecoveryMode = true;
            openResetPasswordView();
        }
    });
}

async function processAuthUrlFragment(rawFragment) {
    const src = typeof rawFragment === "string"
        ? rawFragment
        : (
            (window.location.hash ? window.location.hash.slice(1) : "") +
            (window.location.search ? "&" + window.location.search.slice(1) : "")
        );
    if (!src) return false;

    const params = new URLSearchParams(src);
    const errCode = params.get("error_code") || params.get("error");
    const errDesc = params.get("error_description");

    if (errCode || errDesc) {
        isRecoveryMode = false;
        cleanUrlBar();
        openForgotPassword(false);
        if (/expired/i.test(String(errCode) + " " + String(errDesc))) {
            showAlert("That password reset link has expired or was already used. Enter your email below to get a fresh link.");
        } else {
            showAlert(errDesc || "That link is no longer valid. Request a new password reset link below.");
        }
        return true;
    }

    if (params.get("type") === "recovery") {
        isRecoveryMode = true;
        const accessToken = params.get("access_token");
        const refreshToken = params.get("refresh_token");
        if (supabaseClient && accessToken && refreshToken) {
            try {
                await supabaseClient.auth.setSession({
                    access_token: accessToken,
                    refresh_token: refreshToken
                });
            } catch (err) {
                console.error("Failed to set recovery session:", err);
            }
        }
        cleanUrlBar();
        openResetPasswordView();
        return true;
    }

    return false;
}

// Also handle same-tab hash navigation (e.g. mobile browser reusing an open tab)
window.addEventListener("hashchange", () => {
    processAuthUrlFragment();
});

// Check session on load
document.addEventListener("DOMContentLoaded", async () => {
    const handledSpecialUrl = await processAuthUrlFragment(initialRawFragment);
    if (handledSpecialUrl || isRecoveryMode) {
        return;
    }

    try {
        if (supabaseClient) {
            const { data: { session } } = await supabaseClient.auth.getSession();
            if (session && !isRecoveryMode) {
                window.location.href = "main.html";
            }
        }
    } catch (err) {
        console.error("Session check failed:", err);
    }
});

function cleanUrlBar() {
    if (window.history && window.history.replaceState) {
        window.history.replaceState(null, "", window.location.pathname);
    }
}

function setHeaderText(title, subtitle) {
    const titleEl = document.getElementById("authCardTitle");
    const subEl = document.getElementById("authCardSubtitle");
    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = subtitle;
}

function hideAllForms() {
    ["loginForm", "signupForm", "forgotForm", "resetForm"].forEach(id => {
        document.getElementById(id)?.classList.remove("active");
    });
}

function switchTab(tab) {
    const authTabs = document.getElementById("authTabs");
    const loginTab = document.getElementById("loginTab");
    const signupTab = document.getElementById("signupTab");
    const alertBox = document.getElementById("alertBox");

    alertBox.classList.add("hidden");
    authTabs?.classList.remove("hidden");
    hideAllForms();
    setHeaderText("Welcome to Scholog", "Sign in to manage your class attendance");

    if (tab === "login") {
        loginTab.classList.add("active");
        signupTab.classList.remove("active");
        document.getElementById("loginForm").classList.add("active");
    } else {
        signupTab.classList.add("active");
        loginTab.classList.remove("active");
        document.getElementById("signupForm").classList.add("active");
    }
}

function openForgotPassword(clearMessages = true) {
    const authTabs = document.getElementById("authTabs");
    const alertBox = document.getElementById("alertBox");
    const loginEmail = document.getElementById("loginEmail")?.value.trim();
    const forgotEmail = document.getElementById("forgotEmail");

    if (clearMessages) alertBox.classList.add("hidden");
    authTabs?.classList.add("hidden");
    hideAllForms();
    setHeaderText("Forgot Password", "Reset access to your Scholog account");

    if (forgotEmail && loginEmail && !forgotEmail.value) {
        forgotEmail.value = loginEmail;
    }
    document.getElementById("forgotForm")?.classList.add("active");
}

function openResetPasswordView() {
    const authTabs = document.getElementById("authTabs");
    const alertBox = document.getElementById("alertBox");

    alertBox.classList.add("hidden");
    authTabs?.classList.add("hidden");
    hideAllForms();
    setHeaderText("Set New Password", "Create a new password for your account");
    document.getElementById("resetForm")?.classList.add("active");
}

async function cancelResetPassword() {
    isRecoveryMode = false;
    cleanUrlBar();
    try {
        if (supabaseClient) await supabaseClient.auth.signOut();
    } catch (e) { /* ignore */ }
    switchTab("login");
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
    if (/same password|different from the old password/i.test(msg)) {
        return "Your new password must be different from your previous password.";
    }
    if (/rate limit/i.test(msg)) {
        return "Email limit reached right now — check your inbox/spam folder for an earlier email, or wait a bit and try again.";
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

function startResetCooldown(seconds) {
    const btn = document.getElementById("forgotSubmitBtn");
    if (!btn) return;
    const span = btn.querySelector("span");
    let remaining = seconds;
    btn.disabled = true;
    if (resetCooldownTimer) clearInterval(resetCooldownTimer);

    const tick = () => {
        if (remaining <= 0) {
            clearInterval(resetCooldownTimer);
            resetCooldownTimer = null;
            btn.disabled = false;
            if (span) span.textContent = "Send Reset Link";
            return;
        }
        if (span) span.textContent = `Resend available in ${remaining}s`;
        remaining--;
    };
    tick();
    resetCooldownTimer = setInterval(tick, 1000);
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

async function handleForgotPassword(e) {
    e.preventDefault();
    if (authBusy) return;

    const email = document.getElementById("forgotEmail").value.trim();
    if (!email) {
        showAlert("Please enter your email address.");
        return;
    }

    if (!supabaseClient) {
        showAlert("Password recovery requires an internet connection.", "error");
        return;
    }

    setSubmitting(e.target, true, "Sending reset link...", "Send Reset Link");
    try {
        const redirectTo = new URL("index.html", window.location.href).href;
        const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) throw error;

        authBusy = false;
        showAlert(
            `Password reset link sent to ${email}! Check your inbox (and Spam folder), click the link, and set your new password.`,
            "success"
        );
        startResetCooldown(60);
    } catch (err) {
        setSubmitting(e.target, false, "Sending reset link...", "Send Reset Link");
        showAlert(friendlyAuthError(err));
    }
}

async function handleResetPassword(e) {
    e.preventDefault();
    if (authBusy) return;

    const newPassword = document.getElementById("newPassword").value;
    const confirmPassword = document.getElementById("confirmNewPassword").value;

    if (!newPassword || newPassword.length < 6) {
        showAlert("Password must be at least 6 characters long.");
        return;
    }

    if (newPassword !== confirmPassword) {
        showAlert("Passwords do not match. Please double-check and try again.");
        return;
    }

    if (!supabaseClient) {
        showAlert("Cannot reach the server. Please check your connection.");
        return;
    }

    setSubmitting(e.target, true, "Updating password...", "Update Password");
    try {
        const { error } = await supabaseClient.auth.updateUser({ password: newPassword });
        if (error) throw error;

        isRecoveryMode = false;
        cleanUrlBar();
        showAlert("Password updated! Signing you in...", "success");
        setTimeout(() => { window.location.href = "main.html"; }, 800);
    } catch (err) {
        setSubmitting(e.target, false, "Updating password...", "Update Password");
        showAlert(friendlyAuthError(err));
    }
}