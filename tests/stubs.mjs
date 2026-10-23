// Library stubs used by the jsdom UI tests.
import { defaultDb, testUser } from "./helpers.mjs";

export function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dbWithToday() {
    const db = defaultDb();
    const today = todayStr();
    db.attendance = db.attendance.map((row) => ({ ...row, date: today }));
    return db;
}

export function makeFakeJsPdf() {
    const instances = [];
    class FakeJsPDF {
        constructor() {
            this.texts = [];
            this.tables = [];
            this.saved = null;
            this.pages = 1;
            this.internal = { pageSize: { getWidth: () => 210, getHeight: () => 297 } };
            this.lastAutoTable = { finalY: 120 };
            instances.push(this);
        }
        setFont() {}
        setFontSize() {}
        setTextColor() {}
        text(content, x, y) { this.texts.push({ content, x, y }); }
        autoTable(options) { this.tables.push(options); }
        getNumberOfPages() { return this.pages; }
        setPage() {}
        save(name) { this.saved = name; }
    }
    return { FakeJsPDF, instances };
}

export function makeFakeQr() {
    const encoded = [];
    function qrcode() {
        return {
            addData(data) { encoded.push(data); },
            make() {},
            createSvgTag() {
                return '<svg data-testid="qr-svg" width="100" height="100"><rect/></svg>';
            }
        };
    }
    qrcode.encoded = encoded;
    return qrcode;
}

export function installCameraStub(window) {
    const state = { callbacks: [], stopped: 0, started: 0, failWith: null };
    class FakeHtml5Qrcode {
        constructor(elementId) { this.elementId = elementId; }
        async start(_camera, _config, onSuccess) {
            if (state.failWith) {
                const err = new Error("camera blocked");
                err.name = state.failWith;
                throw err;
            }
            state.started += 1;
            state.callbacks.push(onSuccess);
        }
        async stop() { state.stopped += 1; }
        clear() {}
    }
    window.Html5Qrcode = FakeHtml5Qrcode;
    window.navigator.mediaDevices = { getUserMedia: async () => ({}) };
    return state;
}

export function installSupabaseStub(window, client) {
    window.supabase = { createClient: () => client, __client: client };
}

export function installLucideStub(window) {
    window.lucide = { createIcons() {} };
}

export function userSession(overrides = {}) {
    return { user: testUser(overrides) };
}
