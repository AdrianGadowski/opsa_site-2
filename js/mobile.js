// ==========================================
// WERSJA NA TELEFON
// Wysuwane menu boczne i etykiety komórek tabel (css/mobile.css).
// Ładuj PO menu-fx.js. Na komputerze nie zmienia wyglądu.
// ==========================================
(() => {
  const MOBILE_QUERY = "(max-width: 768px)";

  // ---------- 1. Wysuwane menu ----------
  const sidebar = document.querySelector(".sidebar");
  const burger = document.getElementById("topbar-menu-btn");
  const list = document.getElementById("navigation-list");

  if (sidebar && burger) {
    const backdrop = document.createElement("div");
    backdrop.className = "sidebar-backdrop";
    sidebar.after(backdrop);

    const setOpen = (open) => {
      sidebar.classList.toggle("mobile-open", open);
      backdrop.classList.toggle("visible", open);
      burger.setAttribute("aria-expanded", String(open));
    };

    burger.addEventListener("click", () => setOpen(!sidebar.classList.contains("mobile-open")));
    backdrop.addEventListener("click", () => setOpen(false));

    // Wybór pozycji lub wylogowanie zamyka panel
    sidebar.addEventListener("click", (e) => {
      if (e.target.closest(".menu-btn, .user-footer .link-btn, .user-avatar, .user-info-wrapper")) setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setOpen(false);
    });
    // Obrót telefonu / poszerzenie okna ponad próg
    window.matchMedia(MOBILE_QUERY).addEventListener("change", (e) => {
      if (!e.matches) setOpen(false);
    });
  }

  // ---------- 2. Etykiety komórek tabel ----------
  // Na telefonie wiersz tabeli jest kartą; nazwa kolumny trafia do data-label,
  // skąd CSS wyświetla ją obok wartości.
  const content = document.getElementById("main-content");
  if (!content) return;

  function labelTables() {
    content.querySelectorAll("table").forEach((table) => {
      const heads = Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent.trim());
      table.querySelectorAll("tbody > tr").forEach((tr) => {
        Array.from(tr.children).forEach((td, i) => {
          if (td.colSpan > 1) return;
          const label = heads[i] || "";
          if (td.dataset.label !== label) td.dataset.label = label;
        });
      });
    });
  }

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      labelTables();
    });
  }).observe(content, { childList: true, subtree: true });
})();
