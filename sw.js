// ==========================================
// SERVICE WORKER
// Potrzebny tylko po to, żeby stronę dało się zainstalować jako aplikację.
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
