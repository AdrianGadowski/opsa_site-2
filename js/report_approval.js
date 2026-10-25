// ==========================================
// ZATWIERDZANIE RAPORTÓW: zakładki "Listy raportów" w menu i liczniki
// Zakładki: archive - Zatwierdzone, mine - Moje raporty (wszystkie stany, raporty zalogowanej osoby),
//           pending - W oczekiwaniu na zatwierdzenie, rejected - Do poprawy.
// Zatwierdza, odsyła do poprawy i cofa zatwierdzenie osoba z uprawnieniem "Zatwierdzanie raportów"
// (users.allow_report_approve) - raporty z całego zakładu. Autor widzi swoje raporty w oczekiwaniu
// i do poprawy. Liczniki w menu: zatwierdzający - wszystkie raporty, pozostali - swoje do poprawy.
// Baza: sql/34_zatwierdzanie_raportow.sql. Bez niego jest tylko jedna lista ze wszystkimi raportami, jak dawniej.
// Wymaga: supabaseClient, currentUser, hasPermission, navigateTo (app.js).
// ==========================================

const RPA_POLL_MS = 60000;   // jak często odświeżać liczniki

let rpaTab = "mine";            // wybrana zakładka; domyślnie Moje raporty (niedostępna - pierwsza dostępna)
let rpaPollTimer = null;
let rpaCounts = { pending: 0, rejected: 0 };   // liczby widoczne teraz w menu
let rpaCountsToken = 0;
let rpaColumnState = null;   // portal pracownika: czy baza ma już status raportów (sql/34); null = nie sprawdzono

// Czy baza ma zatwierdzanie raportów (sql/34): po nim konto użytkownika ma kolumnę allow_report_approve
function rpaInstalled() {
  return !!(typeof currentUser !== "undefined" && currentUser && "allow_report_approve" in currentUser);
}

function rpaCanApprove() {
  return rpaInstalled() && hasPermission("allow_report_approve");
}

// Zakładki dostępne dla zalogowanej osoby (w kolejności z menu)
function rpaTabs() {
  if (typeof currentUser === "undefined" || !currentUser) return [];
  const approve = rpaCanApprove();
  const tabs = [];
  // Moje raporty: każdy, kto tworzy raporty; pierwsza w menu i otwierana po kliknięciu "Lista raportów"
  if (hasPermission("allow_time_reporting") || hasPermission("allow_reports")) tabs.push("mine");
  if (hasPermission("allow_reports") || approve) tabs.push("archive");
  if (rpaInstalled() && (approve || hasPermission("allow_reports") || hasPermission("allow_time_reporting"))) {
    tabs.push("pending", "rejected");
  }
  return tabs;
}

// Statystyki (pulpit, godziny pracownika, portal) liczą tylko zatwierdzone raporty.
// Zwraca true, gdy trzeba filtrować; przed sql/34 - false (wszystkie raporty, jak dawniej).
async function rpaApprovedOnly() {
  if (typeof currentUser !== "undefined" && currentUser) return rpaInstalled();
  if (rpaColumnState !== null) return rpaColumnState;
  const { error } = await supabaseClient.from("work_reports").select("approval_status").limit(1);
  if (!error) rpaColumnState = true;
  else if (error.code === "42703" || /approval_status/.test(error.message || "")) rpaColumnState = false;
  else return false;           // np. brak sieci - spróbuj przy następnym pobraniu
  return rpaColumnState;
}

// Zapytanie z filtrem "tylko zatwierdzone" (gdy approved = true)
function rpaFilterApproved(query, approved) {
  return approved ? query.eq("approval_status", "approved") : query;
}

// ---------- Menu ----------
// Kliknięcie "Lista raportów" otwiera pierwszą dostępną zakładkę (zwykle Listę raportów),
// kliknięcie zakładki - tę zakładkę. Na otwartym widoku tylko przełącza zakładkę.
function rpaOpenTab(tab) {
  const tabs = rpaTabs();
  if (!tabs.length) return;
  rpaTab = tabs.includes(tab) ? tab : tabs[0];
  if (document.getElementById("rp-table-body") && typeof rpSetTab === "function") {
    rpaSyncMenu("reports");
    rpSetTab(rpaTab);
  } else {
    navigateTo("reports");
  }
}

// Rozwinięcie pozycji i zaznaczenie zakładki (navigateTo woła to przy każdej zmianie widoku)
function rpaSyncMenu(viewName) {
  const item = document.getElementById("nav-reports");
  if (!item) return;
  const tabs = rpaTabs();
  const open = viewName === "reports";
  item.classList.toggle("open", open);
  item.querySelector(":scope > .menu-btn")?.setAttribute("aria-expanded", String(open));
  item.querySelectorAll(".menu-sub-btn").forEach(btn => {
    const tab = btn.dataset.rtab;
    btn.parentElement.hidden = !tabs.includes(tab);
    btn.classList.toggle("active", open && tab === rpaTab);
  });
}

// ---------- Liczniki ----------
// Dymki przy "Liście raportów" i jej zakładkach w menu (klasy .rpa-badge)
function rpaSetBadges(pending, rejected) {
  rpaCounts = { pending, rejected };
  const fmt = n => (n > 99 ? "99+" : String(n));
  document.querySelectorAll(".rpa-badge.pending").forEach(b => {
    b.textContent = fmt(pending);
    b.style.display = pending > 0 ? "" : "none";
  });
  document.querySelectorAll(".rpa-badge.rejected").forEach(b => {
    b.textContent = fmt(rejected);
    b.style.display = rejected > 0 ? "" : "none";
  });
  document.getElementById("topbar-menu-btn")?.classList.toggle("rpa-dot", pending + rejected > 0);
}

// Od razu po akcji (zatwierdzenie, odesłanie, ponowne wysłanie), zanim odpowie baza:
// np. rpaAdjust(-3, 0) po zatwierdzeniu trzech raportów. Liczy tylko to, co widzi ta osoba.
function rpaAdjust(pendingDelta, rejectedDelta) {
  rpaSetBadges(
    rpaCanApprove() ? Math.max(0, rpaCounts.pending + pendingDelta) : 0,
    Math.max(0, rpaCounts.rejected + rejectedDelta)
  );
}

async function rpaRefreshBadges() {
  if (!rpaInstalled() || !rpaTabs().length) {
    rpaSetBadges(0, 0);
    return;
  }
  // odpowiedź starszego zapytania (np. z odświeżania co minutę) nie nadpisuje nowszej
  const token = ++rpaCountsToken;
  const { data, error } = await supabaseClient.rpc("app_report_counts");
  if (token !== rpaCountsToken) return;
  if (error) {
    console.warn("Zatwierdzanie raportów: liczniki niedostępne:", error.message);
    return;
  }
  const c = (Array.isArray(data) ? data[0] : data) || {};
  // zatwierdzający: wszystkie raporty; autor: tylko swoje do poprawy
  if (rpaCanApprove()) rpaSetBadges(Number(c.pending) || 0, Number(c.rejected) || 0);
  else rpaSetBadges(0, Number(c.my_rejected) || 0);
}

// Start po zalogowaniu użytkownika; zatrzymuje się sam po wylogowaniu
function rpaStart() {
  clearInterval(rpaPollTimer);
  rpaSyncMenu(null);
  if (!rpaInstalled() || !rpaTabs().length) {
    rpaSetBadges(0, 0);
    return;
  }
  rpaRefreshBadges();
  rpaPollTimer = setInterval(() => {
    if (typeof currentUser === "undefined" || !currentUser) {
      clearInterval(rpaPollTimer);
      rpaSetBadges(0, 0);
      return;
    }
    if (!document.hidden) rpaRefreshBadges();
  }, RPA_POLL_MS);
}
