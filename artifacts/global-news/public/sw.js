// Global News Intelligence — Service Worker

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// ─── Push notification handler ────────────────────────────────────────────────

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Market Signal", body: event.data.text(), tag: "intel" };
  }

  const options = {
    body: payload.body ?? "",
    icon: "favicon.svg",
    badge: "favicon.svg",
    tag: payload.tag ?? "intel-signal",
    renotify: true,
    silent: false,
    vibrate: [200, 100, 200],
    data: { url: payload.url ?? "intelligence", assetId: payload.assetId },
    actions: [
      { action: "view", title: "Open Analysis" },
      { action: "dismiss", title: "Dismiss" },
    ],
    requireInteraction: false,
    timestamp: Date.now(),
  };

  event.waitUntil(
    self.registration.showNotification(payload.title ?? "Market Signal", options)
  );
});

// ─── Notification click handler ───────────────────────────────────────────────

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "dismiss") return;

  const targetUrl = event.notification.data?.url ?? "intelligence";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            client.postMessage({ type: "NAVIGATE", url: targetUrl });
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      })
  );
});
