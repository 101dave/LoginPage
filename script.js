// Initialize Supabase Client
const SUPABASE_URL = "https://jwjivkdgzxuaecplkkad.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3aml2a2Rnenh1YWVjcGxra2FkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2NTU0NzcsImV4cCI6MjEwODIzMTQ3N30.VTFzl7FlP0apBo5ngnclq3eA9aDE-o3I560-XHSiDKg";

let supabaseClient = null;

if (window.supabase) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// Check session on load (Huwag mag-auto redirect kung nasa index page para hindi mag-loop)
document.addEventListener("DOMContentLoaded", async () => {
    if (supabaseClient) {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session) {
            window.location.href = "main.html";
        }
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

async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;

    if (!email || !password) {
        showAlert("Please enter both email and password.");
        return;
    }

    try {
        if (supabaseClient) {
            const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
            if (error) throw error;
            showAlert("Signed in successfully! Redirecting...", "success");
            setTimeout(() => { window.location.href = "main.html"; }, 800);
        } else {
            localStorage.setItem("scholog_local_user", JSON.stringify({ email, name: email.split("@")[0] }));
            showAlert("Signed in locally! Redirecting...", "success");
            setTimeout(() => { window.location.href = "main.html"; }, 800);
        }
    } catch (err) {
        showAlert(err.message || "Failed to sign in.");
    }
}

async function handleSignup(e) {
    e.preventDefault();
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

    try {
        if (supabaseClient) {
            const { data, error } = await supabaseClient.auth.signUp({ email, password });
            if (error) throw error;
            showAlert("Account created! You may now sign in.", "success");
            setTimeout(() => switchTab("login"), 1500);
        } else {
            localStorage.setItem("scholog_local_user", JSON.stringify({ email, name: email.split("@")[0] }));
            showAlert("Account created locally! Redirecting...", "success");
            setTimeout(() => { window.location.href = "main.html"; }, 1000);
        }
    } catch (err) {
        showAlert(err.message || "Failed to create account.");
    }
}