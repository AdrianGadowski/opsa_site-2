// ==========================================
// MODUŁ: POWIADOMIENIA PUSH (zgłoszenia nieobecności)
// Urządzenie włącza powiadomienia przyciskiem; adres urządzenia (subskrypcja) trafia do bazy
// przez app_push_subscribe (sql/31_powiadomienia_push.sql). Wysyła je funkcja Edge Function
// "absence-push" (supabase/functions/absence-push). Pokazuje je sw.js.
//  * Mistrz / administrator: przycisk na stronie "Nieobecności".
//  * Pracownik: przycisk w portalu, w sekcji "Moje zgłoszenia nieobecności".
// Po zalogowaniu urządzenie z już włączonymi powiadomieniami jest przypisywane do zalogowanej osoby,
// a przy wylogowaniu - odłączane (wspólny telefon nie dostaje cudzych powiadomień).
// ==========================================

// Klucz publiczny VAPID (jawny). Wygeneruj w tools/vapid.html i wklej tutaj.
const PUSH_VAPID_PUBLIC_KEY = "";

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function pushStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function pushIsIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function pushKeyBytes(b64url) {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function pushCurrentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function pushSave(sub) {
  const json = sub.toJSON();
  const { error } = await supabaseClient.rpc("app_push_subscribe", {
    p_endpoint: json.endpoint,
    p_p256dh: json.keys?.p256dh || "",
    p_auth: json.keys?.auth || "",
    p_user_agent: navigator.userAgent
  });
  if (error) throw error;
}

// Stan do wyświetlenia: "on" | "off" | "denied" | "unsupported" | "ios-install" | "not-configured"
async function pushState() {
  if (!PUSH_VAPID_PUBLIC_KEY) return "not-configured";
  if (!pushSupported()) return pushIsIos() && !pushStandalone() ? "ios-install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  const sub = await pushCurrentSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

async function pushEnable() {
  if (!PUSH_VAPID_PUBLIC_KEY || !pushSupported()) return pushRefreshButtons();
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return pushRefreshButtons();
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: pushKeyBytes(PUSH_VAPID_PUBLIC_KEY)
      });
    }
    await pushSave(sub);
    logAction("Włączenie powiadomień", navigator.userAgent.slice(0, 120));
  } catch (err) {
    console.error("Nie udało się włączyć powiadomień:", err);
    alert("Nie udało się włączyć powiadomień: " + (err.message || err));
  }
  pushRefreshButtons();
}

async function pushDisable() {
  try {
    const sub = await pushCurrentSubscription();
    if (sub) {
      await supabaseClient.rpc("app_push_unsubscribe", { p_endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    logAction("Wyłączenie powiadomień", navigator.userAgent.slice(0, 120));
  } catch (err) {
    console.error("Nie udało się wyłączyć powiadomień:", err);
  }
  pushRefreshButtons();
}

// Po zalogowaniu: urządzenie z włączonymi powiadomieniami należy teraz do zalogowanej osoby
async function pushSync() {
  try {
    if (!PUSH_VAPID_PUBLIC_KEY || !pushSupported() || Notification.permission !== "granted") return;
    const sub = await pushCurrentSubscription();
    if (sub) await pushSave(sub);
  } catch (err) {
    console.warn("Powiadomienia: nie udało się przypisać urządzenia:", err.message || err);
  }
  pushRefreshButtons();
}

// Przed wylogowaniem: odłącz urządzenie od konta (powiadomienia w przeglądarce zostają włączone)
async function pushForget() {
  try {
    const sub = await pushCurrentSubscription();
    if (sub) await supabaseClient.rpc("app_push_unsubscribe", { p_endpoint: sub.endpoint });
  } catch (err) { /* wylogowanie i tak trwa */ }
}

// Przyciski "Powiadomienia" (data-push-btn) i podpowiedzi (data-push-hint) na stronie
async function pushRefreshButtons() {
  const btns = document.querySelectorAll("[data-push-btn]");
  if (!btns.length) return;
  const state = await pushState();
  const view = {
    on: { text: "Powiadomienia włączone", icon: "fa-bell", cls: "on", hint: "To urządzenie dostaje powiadomienia. Kliknij, aby wyłączyć." },
    off: { text: "Włącz powiadomienia", icon: "fa-bell-slash", cls: "off", hint: "" },
    denied: { text: "Powiadomienia zablokowane", icon: "fa-ban", cls: "blocked", hint: "Powiadomienia są zablokowane w ustawieniach przeglądarki lub telefonu. Odblokuj je dla tej strony i spróbuj ponownie." },
    unsupported: { text: "Brak powiadomień", icon: "fa-ban", cls: "blocked", hint: "Ta przeglądarka nie obsługuje powiadomień." },
    "ios-install": { text: "Włącz powiadomienia", icon: "fa-mobile-screen", cls: "off", hint: "Na iPhonie dodaj najpierw stronę do ekranu głównego (Udostępnij → „Do ekranu początkowego”), otwórz ją z ikony i dopiero wtedy włącz powiadomienia." },
    "not-configured": { text: "Powiadomienia niedostępne", icon: "fa-ban", cls: "blocked", hint: "Powiadomienia nie są jeszcze skonfigurowane przez administratora." }
  }[state];
  btns.forEach(btn => {
    btn.className = `push-btn ${view.cls}`;
    btn.innerHTML = `<i class="fa-solid ${view.icon}"></i> ${view.text}`;
    btn.title = view.hint || view.text;
    btn.disabled = ["denied", "unsupported", "not-configured", "ios-install"].includes(state);
    btn.onclick = state === "on" ? pushDisable : pushEnable;
  });
  document.querySelectorAll("[data-push-hint]").forEach(el => {
    el.textContent = view.hint;
    el.style.display = view.hint && state !== "on" ? "" : "none";
  });
}

// Kliknięcie powiadomienia przy otwartej aplikacji: sw.js prosi o przejście do widoku
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", e => {
    const msg = e.data || {};
    if (msg.type !== "open-view") return;
    if (typeof currentUser !== "undefined" && currentUser && typeof canOpenView === "function" && canOpenView(msg.view)) {
      navigateTo(msg.view);
    } else if (typeof epEmployee !== "undefined" && epEmployee && typeof abPortalLoad === "function") {
      abPortalLoad();
      if (typeof epLoadSchedule === "function") epLoadSchedule();
    }
  });
}
