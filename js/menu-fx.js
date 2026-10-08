// ==========================================
// ANIMOWANE MENU BOCZNE
// Niezależny od app.js - reaguje na zmiany klas/stylów w DOM.
// Ładuj PO app.js.
// ==========================================
(() => {
  const sidebar = document.querySelector(".sidebar");
  const list = document.getElementById("navigation-list");
  if (!sidebar || !list) return;

  const STORAGE_KEY = "sidebarCollapsed";

  // ---------- 1. Etykiety w <span> (pozwala płynnie je chować) ----------
  function wrapLabels(root) {
    if (!root) return;
    Array.from(root.childNodes).forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        const span = document.createElement("span");
        span.className = "menu-label";
        span.textContent = node.textContent.trim();
        node.replaceWith(span);
      }
    });
  }
  wrapLabels(sidebar.querySelector(".sidebar-header"));
  list.querySelectorAll(".menu-btn").forEach(wrapLabels);

  // ---------- 2. Wskaźnik aktywnej pozycji ----------
  const indicator = document.createElement("span");
  indicator.className = "menu-indicator";
  indicator.setAttribute("aria-hidden", "true");
  list.prepend(indicator);

  let wasVisible = false;
  let movingTimer = null;

  function placeIndicator(instant) {
    const active = list.querySelector(".menu-item.active");

    // brak aktywnej pozycji albo jest ukryta (przed zalogowaniem)
    if (!active || active.offsetParent === null) {
      indicator.classList.remove("visible");
      wasVisible = false;
      return;
    }

    const skipAnimation = instant || !wasVisible;
    if (skipAnimation) indicator.classList.add("no-anim");

    indicator.style.width = active.offsetWidth + "px";
    indicator.style.height = active.offsetHeight + "px";
    indicator.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    indicator.classList.add("visible");

    if (skipAnimation) {
      void indicator.offsetWidth; // wymuś przeliczenie stylów bez przejścia
      indicator.classList.remove("no-anim");
    } else {
      indicator.classList.add("is-moving");
      clearTimeout(movingTimer);
      movingTimer = setTimeout(() => indicator.classList.remove("is-moving"), 500);
    }
    wasVisible = true;
  }

  // Zmiana klasy .active lub widoczności pozycji (app.js ustawia style.display)
  new MutationObserver((mutations) => {
    if (mutations.some((m) => m.target !== indicator)) placeIndicator(false);
  }).observe(list, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"]
  });

  // Zmiana rozmiaru listy (zwijanie panelu, resize okna) - wskaźnik podąża natychmiast
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => placeIndicator(true)).observe(list);
  }
  window.addEventListener("resize", () => placeIndicator(true));

  // ---------- 3. Zwijanie panelu ----------
  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "sidebar-toggle";
  toggleBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
  sidebar.appendChild(toggleBtn);

  function readPref() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }
  function savePref(collapsed) {
    try { localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0"); } catch (e) { /* brak dostępu - ignoruj */ }
  }

  function setCollapsed(collapsed, persist) {
    sidebar.classList.toggle("collapsed", collapsed);
    toggleBtn.setAttribute("aria-expanded", String(!collapsed));
    toggleBtn.setAttribute("aria-label", collapsed ? "Rozwiń menu" : "Zwiń menu");

    // Gdy etykiet nie widać, pokaż nazwę w podpowiedzi przeglądarki
    list.querySelectorAll(".menu-btn").forEach((btn) => {
      const label = btn.querySelector(".menu-label");
      if (collapsed && label) btn.title = label.textContent;
      else btn.removeAttribute("title");
    });

    if (persist) savePref(collapsed);
  }

  const pref = readPref();
  setCollapsed(pref === null ? window.innerWidth < 900 : pref === "1", false);
  toggleBtn.addEventListener("click", () => {
    setCollapsed(!sidebar.classList.contains("collapsed"), true);
  });

  // ---------- 4. Awatar z inicjałami ----------
  const footer = sidebar.querySelector(".user-footer");
  const nameEl = document.getElementById("current-user-name");

  if (footer && nameEl) {
    const avatar = document.createElement("div");
    avatar.className = "user-avatar";
    avatar.setAttribute("aria-hidden", "true");
    footer.prepend(avatar);

    const updateAvatar = () => {
      const parts = (nameEl.textContent || "").trim().split(/\s+/).filter(Boolean);
      avatar.textContent = parts.length
        ? (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase()
        : "?";
    };

    new MutationObserver(updateAvatar).observe(nameEl, {
      childList: true,
      characterData: true,
      subtree: true
    });
    updateAvatar();
  }
})();