import test from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase, loadPage, waitFor } from "./helpers.mjs";
import { installSupabaseStub } from "./stubs.mjs";

async function bootAuthPage(clientOptions = {}) {
    const client = createFakeSupabase({ session: null, ...clientOptions });
    const page = loadPage({
        html: "index.html",
        scripts: ["script.js"],
        url: "https://scholog.test/index.html",
        beforeParse(window) {
            installSupabaseStub(window, client);
        }
    });
    await waitFor(() => page.window.document.getElementById("loginForm").classList.contains("active"), {
        label: "login form ready"
    });
    return { ...page, client };
}

function submit(window, form) {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

test("sign-in form calls Supabase and reports success", async (t) => {
    const { window, client, dom } = await bootAuthPage();
    t.after(() => dom.window.close());
    const document = window.document;

    document.getElementById("loginEmail").value = "teacher@example.com";
    document.getElementById("loginPassword").value = "secret123";
    submit(window, document.getElementById("loginForm"));

    await waitFor(() => client.lastSignIn, { label: "sign-in call" });
    assert.equal(client.lastSignIn.email, "teacher@example.com");
    assert.equal(client.lastSignIn.password, "secret123");
    await waitFor(() => /Signed in successfully/.test(document.getElementById("alertBox").textContent));
    assert.ok(document.getElementById("alertBox").classList.contains("success"));
});

test("wrong password shows a friendly error and re-enables the button", async (t) => {
    const { window, client, dom } = await bootAuthPage({ authErrors: { signIn: "Invalid login credentials" } });
    t.after(() => dom.window.close());
    const document = window.document;

    document.getElementById("loginEmail").value = "teacher@example.com";
    document.getElementById("loginPassword").value = "wrong";
    submit(window, document.getElementById("loginForm"));

    await waitFor(() => /Wrong email or password/.test(document.getElementById("alertBox").textContent));
    assert.equal(document.getElementById("loginSubmitBtn").disabled, false);
    assert.equal(client.signedOut, false);
});

test("signup validates password length and creates an account", async (t) => {
    const { window, client, dom } = await bootAuthPage();
    t.after(() => dom.window.close());
    const document = window.document;

    window.switchTab("signup");
    assert.ok(document.getElementById("signupForm").classList.contains("active"));
    assert.equal(document.getElementById("loginForm").classList.contains("active"), false);

    document.getElementById("signupEmail").value = "new@example.com";
    document.getElementById("signupPassword").value = "123";
    submit(window, document.getElementById("signupForm"));
    await waitFor(() => /at least 6 characters/.test(document.getElementById("alertBox").textContent));
    assert.equal(client.lastSignUp, undefined);

    document.getElementById("signupPassword").value = "goodpass";
    submit(window, document.getElementById("signupForm"));
    await waitFor(() => client.lastSignUp, { label: "sign-up call" });
    assert.equal(client.lastSignUp.email, "new@example.com");
    await waitFor(() => /Account created/.test(document.getElementById("alertBox").textContent));
});

test("forgot-password flow sends a reset link and starts cooldown", async (t) => {
    const { window, client, dom } = await bootAuthPage();
    t.after(() => dom.window.close());
    const document = window.document;

    document.getElementById("loginEmail").value = "teacher@example.com";
    window.openForgotPassword();
    assert.equal(document.getElementById("authTabs").classList.contains("hidden"), true);
    assert.equal(document.getElementById("forgotForm").classList.contains("active"), true);
    assert.equal(document.getElementById("forgotEmail").value, "teacher@example.com");

    submit(window, document.getElementById("forgotForm"));
    await waitFor(() => client.lastResetEmail, { label: "reset email call" });
    assert.equal(client.lastResetEmail, "teacher@example.com");
    await waitFor(() => /Password reset link sent/.test(document.getElementById("alertBox").textContent));
    assert.equal(document.getElementById("forgotSubmitBtn").disabled, true);
    assert.match(document.getElementById("forgotSubmitBtn").textContent, /Resend available in \d+s/);
    window.cancelResetPassword();
});

test("reset-password form validates matching passwords", async (t) => {
    const { window, client, dom } = await bootAuthPage();
    t.after(() => dom.window.close());
    const document = window.document;

    window.openResetPasswordView();
    document.getElementById("newPassword").value = "abcdef";
    document.getElementById("confirmNewPassword").value = "abcdeg";
    submit(window, document.getElementById("resetForm"));
    await waitFor(() => /Passwords do not match/.test(document.getElementById("alertBox").textContent));
    assert.equal(client.lastUpdatedUser, null);

    document.getElementById("confirmNewPassword").value = "abcdef";
    submit(window, document.getElementById("resetForm"));
    await waitFor(() => client.lastUpdatedUser, { label: "password update" });
    assert.equal(client.lastUpdatedUser.password, "abcdef");
});
