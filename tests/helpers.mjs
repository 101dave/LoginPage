// Shared test harness for the Scholog static pages.
// Loads the real HTML/CSS/JS in jsdom with in-memory Supabase, jsPDF, QR and
// camera stubs so every UI flow can be exercised without a browser.
import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

export const ROOT = path.resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------- fixtures

export function defaultDb() {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return {
        sections: [
            { id: 1, user_id: "user-1", name: "Grade 11 - STEM" },
            { id: 2, user_id: "user-1", name: "Grade 11 - ABM" }
        ],
        students: [
            { id: "11", user_id: "user-1", student_id: "2026-0001", name: "Juan Dela Cruz", email: "juan@example.com", section: "Grade 11 - STEM" },
            { id: "12", user_id: "user-1", student_id: "2026-0002", name: "Ana Santos", email: "", section: "Grade 11 - STEM" },
            { id: "13", user_id: "user-1", student_id: "2026-0003", name: "Lea Reyes", email: "", section: "Grade 11 - STEM" },
            { id: "21", user_id: "user-1", student_id: "2026-0101", name: "Mark Lim", email: "", section: "Grade 11 - ABM" }
        ],
        attendance: [
            { id: 1, user_id: "user-1", date: today, student_id: "2026-0001", status: "Present", subject: "General" },
            { id: 2, user_id: "user-1", date: today, student_id: "2026-0002", status: "Late", subject: "General" },
            { id: 3, user_id: "user-1", date: today, student_id: "2026-0003", status: "Absent", subject: "General" }
        ],
        scores: [],
        grading_categories: [],
        section_grading_categories: [],
        checkin_sessions: []
    };
}

export function testUser(overrides = {}) {
    return {
        id: "user-1",
        email: "teacher@example.com",
        user_metadata: { full_name: "Teacher Maria" },
        ...overrides
    };
}

// ------------------------------------------------------------ fake supabase

function matches(row, filters) {
    return filters.every((f) => {
        if (f.type === "eq") return row[f.column] === f.value;
        if (f.type === "in") return f.values.includes(row[f.column]);
        return true;
    });
}

class QueryBuilder {
    constructor(client, table) {
        this.client = client;
        this.table = table;
        this.filters = [];
        this.op = "select";
        this.payload = null;
        this.options = null;
        this.singleMode = null;
        this.orderBy = null;
        this.rangeSpec = null;
        this.columns = "*";
    }

    select(columns = "*") { this.columns = columns; return this; }
    eq(column, value) { this.filters.push({ type: "eq", column, value }); return this; }
    in(column, values) { this.filters.push({ type: "in", column, values: values || [] }); return this; }
    order(column, opts = {}) { this.orderBy = { column, ascending: opts.ascending !== false }; return this; }
    range(from, to) { this.rangeSpec = [from, to]; return this; }
    insert(payload) { this.op = "insert"; this.payload = payload; return this; }
    upsert(payload, options) { this.op = "upsert"; this.payload = payload; this.options = options; return this; }
    update(payload) { this.op = "update"; this.payload = payload; return this; }
    delete() { this.op = "delete"; return this; }
    single() { this.singleMode = "single"; return this; }
    maybeSingle() { this.singleMode = "maybe"; return this; }

    then(onFulfilled, onRejected) {
        return this.exec().then(onFulfilled, onRejected);
    }

    async exec() {
        const client = this.client;
        const table = client.db[this.table];
        if (!table) {
            return { data: null, error: { message: `relation "${this.table}" does not exist` } };
        }
        client.calls.push({
            table: this.table,
            op: this.op,
            payload: this.payload,
            options: this.options,
            filters: this.filters
        });

        if (client.failTable === this.table && this.op !== "select") {
            return { data: null, error: { message: "simulated network failure" } };
        }

        if (this.op === "select") {
            let rows = table.filter((row) => matches(row, this.filters));
            if (this.orderBy) {
                const { column, ascending } = this.orderBy;
                rows = [...rows].sort((a, b) => {
                    if (a[column] === b[column]) return 0;
                    return (a[column] > b[column] ? 1 : -1) * (ascending ? 1 : -1);
                });
            }
            if (this.rangeSpec) rows = rows.slice(this.rangeSpec[0], this.rangeSpec[1] + 1);
            rows = rows.map((row) => ({ ...row }));
            if (this.singleMode === "single") {
                if (rows.length !== 1) return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
                return { data: rows[0], error: null };
            }
            if (this.singleMode === "maybe") return { data: rows[0] || null, error: null };
            return { data: rows, error: null };
        }

        if (this.op === "insert") {
            const input = Array.isArray(this.payload) ? this.payload : [this.payload];
            const created = input.map((row) => {
                const fresh = { id: table.length + Math.floor(Math.random() * 100000) + 1, ...row };
                if (this.table === "checkin_sessions") {
                    fresh.token = fresh.token || client.nextToken;
                    fresh.closed = fresh.closed === undefined ? false : fresh.closed;
                    fresh.expires_at = fresh.expires_at || new Date(Date.now() + 2 * 3600 * 1000).toISOString();
                }
                table.push(fresh);
                return { ...fresh };
            });
            if (this.singleMode === "single") return { data: created[0], error: null };
            return { data: created, error: null };
        }

        if (this.op === "upsert") {
            const input = Array.isArray(this.payload) ? this.payload : [this.payload];
            if (client.enforceGradingConstraints) {
                if (this.table === "grading_categories") {
                    for (const row of input) {
                        if (!row.section) {
                            return {
                                data: null,
                                error: {
                                    code: "23502",
                                    message: 'null value in column "section" of relation "grading_categories" violates not-null constraint'
                                }
                            };
                        }
                        if (!row.archived) {
                            const clash = table.find(
                                (candidate) => !candidate.archived
                                    && candidate.user_id === row.user_id
                                    && candidate.section === row.section
                                    && candidate.name === row.name
                                    && candidate.id !== row.id
                            );
                            if (clash) {
                                return {
                                    data: null,
                                    error: {
                                        code: "23505",
                                        message: 'duplicate key value violates unique constraint "grading_categories_user_section_name_active_key"'
                                    }
                                };
                            }
                        }
                    }
                }
                if (this.table === "scores") {
                    const cats = client.db.grading_categories || [];
                    for (const row of input) {
                        if (!row.category_id || !cats.some((c) => c.id === row.category_id)) {
                            return {
                                data: null,
                                error: {
                                    code: "23503",
                                    message: 'insert or update on table "scores" violates foreign key constraint "scores_category_id_fkey"'
                                }
                            };
                        }
                        if (!row.item_id) {
                            return {
                                data: null,
                                error: {
                                    code: "23502",
                                    message: 'null value in column "item_id" of relation "scores" violates not-null constraint'
                                }
                            };
                        }
                    }
                }
            }
            const conflict = (this.options && this.options.onConflict ? this.options.onConflict.split(",") : [])
                .map((c) => c.trim()).filter(Boolean);
            const out = [];
            input.forEach((row) => {
                let existing = null;
                if (conflict.length > 0) {
                    existing = table.find((candidate) => conflict.every((col) => {
                        if (this.table === "scores" && col === "item_id") {
                            return (candidate.item_id || "") === (row.item_id || "");
                        }
                        return candidate[col] === row[col];
                    }));
                }
                if (existing) {
                    Object.assign(existing, row);
                    out.push({ ...existing });
                } else {
                    const fresh = { id: table.length + 1, ...row };
                    table.push(fresh);
                    out.push({ ...fresh });
                }
            });
            return { data: out, error: null };
        }

        if (this.op === "update") {
            const rows = table.filter((row) => matches(row, this.filters));
            rows.forEach((row) => Object.assign(row, this.payload));
            return { data: rows.map((r) => ({ ...r })), error: null };
        }

        if (this.op === "delete") {
            for (let i = table.length - 1; i >= 0; i--) {
                if (matches(table[i], this.filters)) table.splice(i, 1);
            }
            return { data: null, error: null };
        }

        return { data: null, error: { message: "unsupported operation" } };
    }
}

export function createFakeSupabase(options = {}) {
    const client = {
        db: options.db || defaultDb(),
        calls: [],
        session: options.session === undefined ? { user: testUser() } : options.session,
        failTable: options.failTable || null,
        enforceGradingConstraints: Boolean(options.enforceGradingConstraints),
        nextToken: options.nextToken || "11111111-2222-4333-8444-555555555555",
        authHandlers: [],
        authErrors: options.authErrors || {},
        signedOut: false,
        lastSignIn: null,
        lastResetEmail: null,
        lastUpdatedUser: null
    };

    client.from = (table) => new QueryBuilder(client, table);

    client.auth = {
        getSession: async () => ({ data: { session: client.session }, error: null }),
        onAuthStateChange: (handler) => {
            client.authHandlers.push(handler);
            return { data: { subscription: { unsubscribe() {} } } };
        },
        signInWithPassword: async (creds) => {
            client.lastSignIn = creds;
            if (client.authErrors.signIn) return { data: null, error: { message: client.authErrors.signIn } };
            return { data: { session: { user: testUser() } }, error: null };
        },
        signUp: async (creds) => {
            client.lastSignUp = creds;
            if (client.authErrors.signUp) return { data: null, error: { message: client.authErrors.signUp } };
            const identities = client.existingSignup ? [] : [{ id: "identity-1" }];
            return {
                data: {
                    session: options.signupSession === false ? null : { user: testUser() },
                    user: { identities }
                },
                error: null
            };
        },
        resetPasswordForEmail: async (email, opts) => {
            client.lastResetEmail = email;
            client.lastResetOptions = opts;
            return { data: {}, error: client.authErrors.reset ? { message: client.authErrors.reset } : null };
        },
        updateUser: async (payload) => {
            client.lastUpdatedUser = payload;
            return { data: { user: testUser() }, error: null };
        },
        signOut: async () => {
            client.signedOut = true;
            client.session = null;
            return { error: null };
        },
        refreshSession: async () => ({ data: { session: client.session }, error: null }),
        setSession: async () => ({ data: { session: client.session }, error: null })
    };

    return client;
}

// --------------------------------------------------------------- page loader

export function loadPage({ html, scripts = [], url = "https://scholog.test/main.html", beforeParse } = {}) {
    let markup = fs.readFileSync(path.join(ROOT, html), "utf8");
    // Drop every external <script> (stubs replace them) and inject the real app code.
    markup = markup.replace(/<script[\s\S]*?<\/script>/gi, "");
    const inline = scripts
        .map((file) => `<script>\n${fs.readFileSync(path.join(ROOT, file), "utf8")}\n</script>`)
        .join("\n");
    markup = markup.replace("</body>", `${inline}\n</body>`);

    const virtualConsole = new VirtualConsole();
    const errors = [];
    virtualConsole.on("jsdomError", (err) => errors.push(err));
    virtualConsole.on("error", (...args) => errors.push(new Error(args.join(" "))));

    const dom = new JSDOM(markup, {
        url,
        runScripts: "dangerously",
        pretendToBeVisual: true,
        virtualConsole,
        beforeParse(window) {
            window.scrollTo = () => {};
            window.HTMLElement.prototype.scrollIntoView = () => {};
            window.navigator.clipboard = { writeText: async () => {} };
            if (!window.URL.createObjectURL) window.URL.createObjectURL = () => "blob:mock";
            window.URL.revokeObjectURL = () => {};
            if (beforeParse) beforeParse(window);
        }
    });

    return { dom, window: dom.window, errors };
}

export function waitFor(predicate, { timeout = 2000, label = "condition" } = {}) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            let value;
            try {
                value = predicate();
            } catch (err) {
                value = false;
            }
            if (value) return resolve(value);
            if (Date.now() - started > timeout) return reject(new Error(`Timed out waiting for ${label}`));
            setTimeout(tick, 15);
        };
        tick();
    });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
