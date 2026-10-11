// ==========================================
// INSTALACJA JAKO APLIKACJA
// Rejestruje service worker (sw.js) i obsługuje przycisk "Zainstaluj aplikację"
// na ekranie logowania. Przycisk pojawia się tylko tam, gdzie przeglądarka
// pozwala na instalację (Chrome / Edge) i tylko dopóki aplikacja nie jest zainstalowana.
// ==========================================
(() => {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => {
        console.warn("Nie udało się zarejestrować service workera:", err);
      });
    });
  }

  const btn = document.getElementById("btn-install-app");
  const iosHint = document.getElementById("install-ios-hint");
  let installEvent = null;

  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

  // Chrome / Edge: przeglądarka zgłasza, że instalacja jest możliwa
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installEvent = e;
    if (btn) btn.style.display = "";
  });

  if (btn) {
    btn.addEventListener("click", async () => {
      if (!installEvent) return;
      installEvent.prompt();
      try {
        await installEvent.userChoice;
      } catch (err) { /* okno zamknięte - nic do zrobienia */ }
      installEvent = null;
      btn.style.display = "none";
    });
  }

  window.addEventListener("appinstalled", () => {
    installEvent = null;
    if (btn) btn.style.display = "none";
  });

  // iPhone / iPad: Safari nie ma okna instalacji - pokaż krótką instrukcję
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (iosHint && isIos && !standalone) iosHint.style.display = "";
})();
