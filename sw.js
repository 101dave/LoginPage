const CACHE_NAME = "scholog-shell-v3";
const OFFLINE_FALLBACK = "./index.html";
const APP_SHELL = [
    "./",
    "./index.html",
    "./main.html",
    "./privacy.html",
    "./style.css",
    "./main.css",
    "./script.js",
    "./main.js",
    "./manifest.json",
    "./icon-192.png",
    "./icon-512.png",
    "./icon-maskable-512.png",
    "./SchologLogo.png",
    "./vendor/supabase.min.js",
    "./vendor/lucide.min.js",
    "./vendor/jspdf.umd.min.js",
    "./vendor/jspdf.plugin.autotable.min.js",
    "./vendor/qrcode.min.js",
    "./vendor/jsqr.min.js",
    "./vendor/xlsx.mini.min.js",
    "./vendor/fonts/plus-jakarta-sans-latin.woff2",
    "./vendor/fonts/plus-jakarta-sans-latin-ext.woff2"
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
    );
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Network-first with complete local cache fallback so offline mode works 100%
self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;

    const url = new URL(req.url);
    // Let Supabase REST / Auth calls go straight to the network (app handles offline queue)
    if (url.hostname.includes("supabase.co")) return;

    event.respondWith(
        fetch(req)
            .then((res) => {
                if (res && res.status === 200 && url.origin === self.location.origin) {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                }
                return res;
            })
            .catch(async () => {
                const cached = await caches.match(req, { ignoreSearch: true });
                if (cached) return cached;
                if (req.mode === "navigate") {
                    const dest = url.pathname.endsWith("main.html") ? "./main.html" : OFFLINE_FALLBACK;
                    return (await caches.match(dest)) || caches.match(OFFLINE_FALLBACK);
                }
                return new Response("Offline", { status: 503, statusText: "Offline" });
            })
    );
});

// Background Sync — notifies open client windows to flush queued offline attendance ops
self.addEventListener("sync", (event) => {
    if (event.tag === "scholog-sync") {
        event.waitUntil(
            self.clients.matchAll({ type: "window" }).then((clients) => {
                clients.forEach((client) => client.postMessage({ type: "SYNC_NOW" }));
            })
        );
    }
});

// Periodic Background Sync — refreshes cached shell assets in the background
self.addEventListener("periodicsync", (event) => {
    if (event.tag === "scholog-refresh") {
        event.waitUntil(
            caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
        );
    }
});

// Push Notifications support
self.addEventListener("push", (event) => {
    let data = { title: "Scholog", body: "Remember to record today's class attendance." };
    if (event.data) {
        try {
            data = Object.assign(data, event.data.json());
        } catch (e) {
            data.body = event.data.text() || data.body;
        }
    }
    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: "icon-192.png",
            badge: "icon-192.png",
            data: { url: data.url || "/main.html" }
        })
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url) || "/main.html";
    event.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
            for (const client of clients) {
                if ("focus" in client) return client.focus();
            }
            if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
        })
    );
});
