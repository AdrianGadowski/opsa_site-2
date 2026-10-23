// ==========================================
// SERVICE WORKER
// 1. Pozwala zainstalować stronę jako aplikację.
// 2. Pokazuje powiadomienia push (zgłoszenia nieobecności - js/push.js, funkcja absence-push).
// Celowo niczego nie zapisuje w pamięci podręcznej: system wymaga połączenia
// z bazą, a aktualność plików zapewnia numer wydania w adresach (?v=...).
// ==========================================

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Wszystkie żądania idą normalnie do sieci
self.addEventListener("fetch", () => {});

// Powiadomienie push: { title, body, url, tag }
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(self.registration.showNotification(data.title || "Odlewnie Polskie", {
    body: data.body || "",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    data: { url: data.url || "./" }
  }));
});

// Kliknięcie: otwiera aplikację (albo przełącza otwartą kartę) na właściwym widoku
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.registration.scope);
  const view = target.searchParams.get("view");
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of list) {
      if (client.url.startsWith(self.registration.scope)) {
        await client.focus();
        if (view) client.postMessage({ type: "open-view", view, tab: target.searchParams.get("tab") });
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
