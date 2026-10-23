// ==========================================
// 1. INICJALIZACJA SUPABASE (Baza: opsa)
// ==========================================
const SUPABASE_URL = "https://vrfyniyvawyungkslwod.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_64Xg3rGa9kuBZo5KjGgCrg_X8felZMu";

// Magazyn sesji Supabase Auth. "Zapamiętaj mnie" = localStorage (przetrwa zamknięcie
// przeglądarki), bez zaznaczenia = sessionStorage (do zamknięcia karty).
const AUTH_STORAGE_KEY = "opsaAuth";
const AUTH_REMEMBER_KEY = "opsaRemember";

function setAuthRemember(remember) {
  try { window.localStorage.setItem(AUTH_REMEMBER_KEY, remember ? "1" : "0"); } catch (e) { /* ignoruj */ }
}

const authStorage = {
  getItem(key) {
    try {
      return window.sessionStorage.getItem(key) ?? window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  },
  setItem(key, value) {
    try {
      const remember = window.localStorage.getItem(AUTH_REMEMBER_KEY) === "1";
      (remember ? window.localStorage : window.sessionStorage).setItem(key, value);
      (remember ? window.sessionStorage : window.localStorage).removeItem(key);
    } catch (e) { /* brak dostępu do magazynu - sesja nie przetrwa odświeżenia */ }
  },
  removeItem(key) {
    try {
      window.sessionStorage.removeItem(key);
      window.localStorage.removeItem(key);
    } catch (e) { /* ignoruj */ }
  }
};

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: authStorage,
    storageKey: AUTH_STORAGE_KEY,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});

// Numer wydania doklejany do adresów plików, żeby przeglądarka nie używała starych kopii.
// Zmieniaj przy każdej publikacji - tutaj i w index.html (?v=...).
const APP_BUILD = "20261226";

let currentUser = null;
let cachedUsers = [];
let userToDeleteLogin = null;
let deleteCountdownTimer = null;

const viewTitles = {
  dashboard: "Dashboard",
  employee_list: "Baza pracowników",
  report_time: "Rozliczanie czasu pracy",
  schedule: "Harmonogram pracy",
  reports: "Lista raportów",
  users: "Zarządzanie użytkownikami",
  updates: "Aktualizacje systemu",
  user: "Moje konto",
  options: "Opcje systemu",
  logs: "Logi systemu",
  absences: "Zgłoszenia nieobecności",
  messages: "Komunikaty"
};

// Kliknięcie w awatar lub dane użytkownika w stopce menu otwiera "Moje konto"
document.querySelector(".user-footer")?.addEventListener("click", (e) => {
  if (currentUser && e.target.closest(".user-avatar, .user-info-wrapper")) navigateTo("user");
});

const permissionMap = {
  dashboard: { elementId: "nav-dashboard", column: "allow_dashboard" },
  employee_list: { elementId: "nav-employee_list", column: "allow_employees" },
  report_time: { elementId: "nav-report_time", column: "allow_time_reporting" },
  schedule: { elementId: "nav-schedule", column: "allow_schedule" },
  reports: { elementId: "nav-reports", column: "allow_reports" },
  users: { elementId: "nav-users", column: "allow_users" },
  updates: { elementId: "nav-updates", column: "allow_updates" },
  options: { elementId: "nav-options", column: "allow_options" },
  logs: { elementId: "nav-logs", column: "allow_logs" },
  messages: { elementId: "nav-messages", column: "allow_messages" }
};

function hasPermission(columnName) {
  if (!currentUser) return false;
  return currentUser[columnName] === true || currentUser[columnName] === 1;
}

// ---------- Włączanie i wyłączanie modułów (Opcje -> Moduły) ----------
// Trzy rodzaje logowania można wyłączyć dla wszystkich: użytkowników systemu, pracowników
// (portal z godzinami) i Zalew. Moduły wewnątrz systemu (raporty, harmonogram itd.)
// zależą tylko od uprawnień użytkownika. Stan trzyma tabela app_modules; brak wpisu = włączony.
// Logowania użytkowników nie da się zablokować administratorowi - inaczej nikt nie włączyłby go z powrotem.
const APP_MODULES = [
  {
    key: "user_login", label: "Użytkownicy", icon: "fa-user-gear",
    hint: "Logowanie do systemu (zakładka „Użytkownik”). Administrator może się zalogować zawsze."
  },
  {
    key: "employee_portal", label: "Pracownicy", icon: "fa-helmet-safety",
    hint: "Zakładka „Pracownik” na ekranie logowania i strona z godzinami"
  },
  {
    key: "zalew", label: "Zalew", icon: "fa-fire-flame-curved",
    hint: "Zakładka „Zalew” na ekranie logowania"
  }
];
const LOGIN_TAB_MODULES = { employee: "employee_portal", zalew: "zalew" };

let appModules = {};         // { klucz: true/false }; brak klucza = włączony

function moduleEnabled(key) {

  return appModules[key] !== false;
}

async function loadModules() {
  try {
    const { data, error } = await supabaseClient.from("app_modules").select("key, enabled");
    if (error) throw error;
    appModules = {};
    (data || []).forEach(m => { appModules[m.key] = m.enabled !== false; });
  } catch (err) {
    // bez tabeli albo bez sieci: wszystko włączone, jak przed wprowadzeniem tej funkcji
    console.warn("Nie udało się pobrać ustawień modułów (wszystkie włączone):", err.message || err);
    appModules = {};
  }
  applyLoginTabs();
}

// Zakładki "Pracownik" i "Zalew" na ekranie logowania
function applyLoginTabs() {
  let visible = 0;
  Object.entries(LOGIN_TAB_MODULES).forEach(([mode, key]) => {
    const tab = document.getElementById(`login-tab-${mode}`);
    const on = moduleEnabled(key);
    if (tab) tab.style.display = on ? "" : "none";
    if (on) visible++;
  });
  // sama zakładka "Użytkownik" nie potrzebuje paska zakładek
  const bar = document.querySelector(".login-tabs");
  if (bar) bar.style.display = visible ? "" : "none";
  if (typeof loginMode !== "undefined" && loginMode !== "user" && !moduleEnabled(LOGIN_TAB_MODULES[loginMode])) {
    setLoginMode("user");
  }
}

// Czy zalogowany użytkownik może otworzyć widok (decyduje uprawnienie)
function canOpenView(viewKey) {
  // zgłoszenia nieobecności: mistrzowie (rola "Mistrz") i administrator (absences.js)
  if (viewKey === "absences") return typeof abCanReview === "function" && abCanReview();
  // lista raportów: archiwum ("Lista raportów"), zatwierdzanie albo własne raporty do poprawy (report_approval.js)
  if (viewKey === "reports" && typeof rpaTabs === "function") return rpaTabs().length > 0;
  const info = permissionMap[viewKey];
  if (info && !hasPermission(info.column)) return false;
  return true;
}

// Pokazuje w menu tylko dostępne moduły; zwraca pierwszy dostępny widok
function applyNavVisibility() {
  let firstAvailable = null;
  Object.keys(permissionMap).forEach((viewKey) => {
    const allowed = canOpenView(viewKey);
    const navElement = document.getElementById(permissionMap[viewKey].elementId);
    if (navElement) navElement.style.display = allowed ? "block" : "none";
    if (allowed && !firstAvailable) firstAvailable = viewKey;
  });
  return firstAvailable;
}

// Aktualna wersja systemu w prawym górnym rogu (tabela Check_version, wiersz "aktualna_wersja")
function setTopbarVersion(version) {
  const el = document.getElementById("topbar-version");
  if (el) el.innerText = `Wersja: ${version || "—"}`;
  const loginEl = document.getElementById("auth-version");
  if (loginEl) loginEl.innerText = version ? ` • v${version}` : "";
}

async function loadTopbarVersion() {
  try {
    const { data, error } = await supabaseClient
      .from("Check_version")
      .select("version")
      .ilike("name", "aktualna_wersja")
      .limit(1);
    if (error) throw error;
    setTopbarVersion(data && data.length ? String(data[0].version || "").trim() : "");
  } catch (err) {
    console.error("Błąd pobierania aktualnej wersji:", err);
    setTopbarVersion("");
  }
}

// Dziennik zdarzeń (strona "Logi"). Zapis idzie przez funkcję bazy app_log, która sama
// ustala, kto jest zalogowany - strona podaje tylko, co się stało.
// Błąd zapisu logu nigdy nie przerywa właściwej operacji.
function logAction(action, details) {
  return supabaseClient
    .rpc("app_log", { p_action: action, p_details: details ? String(details) : null })
    .then(({ error }) => {
      if (error) console.warn("Nie udało się zapisać logu:", error.message);
    }, (err) => console.warn("Nie udało się zapisać logu:", err));
}

// Po tej nazwie roli system rozpoznaje administratora
function isAdminRoleName(roleName) {
  return String(roleName || "").trim().toLowerCase() === "administrator";
}

// Raport może zmieniać tylko jego autor albo administrator
function canModifyReport(creatorId) {
  if (!currentUser) return false;
  if (String(currentUser.role?.role || "").toLowerCase() === "administrator") return true;
  return currentUser.id != null && creatorId != null && Number(currentUser.id) === Number(creatorId);
}

// ==========================================
// OBSŁUGA BŁĘDÓW LOGOWANIA (BEZ ROZPYCHANIA KARTY)
// ==========================================
// markFields = false: komunikat bez czerwonych ramek pól (np. brak sieci, wygasła sesja)
function showLoginError(message = "zły login lub hasło", markFields = true) {
  const loginInput = document.getElementById("login-input");
  const passwordInput = document.getElementById("password-input");
  const errorMsg = document.getElementById("login-error-msg");

  if (loginInput && markFields) loginInput.classList.add("input-error");
  if (passwordInput && markFields) passwordInput.classList.add("input-error");

  if (errorMsg) {
    errorMsg.innerText = message;
    errorMsg.classList.add("visible");
  }
}

function clearLoginError() {
  const loginInput = document.getElementById("login-input");
  const passwordInput = document.getElementById("password-input");
  const errorMsg = document.getElementById("login-error-msg");

  if (loginInput) loginInput.classList.remove("input-error");
  if (passwordInput) passwordInput.classList.remove("input-error");

  if (errorMsg) {
    errorMsg.classList.remove("visible");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const loginInput = document.getElementById("login-input");
  const passwordInput = document.getElementById("password-input");

  if (loginInput) loginInput.addEventListener("input", clearLoginError);
  if (passwordInput) passwordInput.addEventListener("input", clearLoginError);
});

// Kolumny użytkownika pobierane przy logowaniu i przy przywracaniu sesji
// (hasła nie ma w tabeli - trzyma je Supabase Auth)
// Gwiazdka zamiast listy kolumn: nowa kolumna uprawnienia (allow_...) nie zepsuje logowania,
// nawet jeśli strona zostanie opublikowana przed dodaniem jej w bazie.
const USER_SELECT = `
  *,
  role:role_id ( role ),
  department:department_id ( department )
`;

// ---------- Konto w Supabase Auth ----------
// Supabase loguje adresem e-mail, a w systemie są loginy. Adres jest sztuczny i powstaje
// z loginu: jego bajty UTF-8 zapisane szesnastkowo + stała końcówka (osobna dla użytkowników
// i pracowników). Ta sama reguła jest w bazie: funkcja public.app_email().
const AUTH_DOMAINS = { user: "@u.opsa.local", employee: "@p.opsa.local", zalew: "@z.opsa.local" };

function authEmail(kind, login) {
  const bytes = new TextEncoder().encode(String(login || "").trim());
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return hex + (AUTH_DOMAINS[kind] || AUTH_DOMAINS.user);
}

// Czy błąd logowania to brak sieci / awaria serwera, a nie zły login lub hasło
function isAuthNetworkError(error) {
  if (!error) return false;
  return !navigator.onLine || error.status === 0 || error.status >= 500 ||
    /fetch|network|timeout/i.test(error.message || "") || error.name === "AuthRetryableFetchError";
}

// ---------- Sesja ----------
// Sesję (token) trzyma Supabase Auth w magazynie przeglądarki (patrz authStorage na górze pliku).
// Obok zapisywany jest tylko ostatni widok i czas ostatniej aktywności.
const SESSION_KEY = "opsaActivity";
const SESSION_IDLE_LIMIT = 8 * 60 * 60 * 1000; // wylogowanie po 8 h bez aktywności
let sessionTouchedAt = 0;

function readActivity() {
  try {
    return JSON.parse(window.localStorage.getItem(SESSION_KEY) || "null") || {};
  } catch (e) {
    return {};
  }
}

function writeSession(view) {
  sessionTouchedAt = Date.now();
  try {
    const prev = readActivity();
    window.localStorage.setItem(SESSION_KEY, JSON.stringify({
      view: view || prev.view || null,
      ts: sessionTouchedAt
    }));
  } catch (e) { /* brak dostępu do magazynu - ignoruj */ }
}

function clearSession() {
  sessionTouchedAt = 0;
  try { window.localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignoruj */ }
}

// Wylogowanie z Supabase Auth (tylko w tej przeglądarce)
async function authSignOut() {
  try {
    await supabaseClient.auth.signOut({ scope: "local" });
  } catch (err) {
    console.error("Błąd wylogowania:", err);
  }
}

// Po odświeżeniu strony: jeśli jest ważna sesja, pomiń ekran logowania
async function restoreSession() {
  const overlay = document.getElementById("auth-overlay");
  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    const session = data && data.session;
    if (!session) return;

    const activity = readActivity();
    if (activity.ts && Date.now() - activity.ts > SESSION_IDLE_LIMIT) {
      clearSession();
      await authSignOut();
      return;
    }

    // Konto użytkownika systemu?
    const { data: user, error: userErr } = await supabaseClient
      .from("users")
      .select(USER_SELECT)
      .eq("auth_id", session.user.id)
      .maybeSingle();
    if (userErr) throw userErr;

    if (user) {
      if (!moduleEnabled("user_login") && !isAdminRoleName(user.role?.role)) {
        // logowanie użytkowników wyłączone - wpuszczany jest tylko administrator
        clearSession();
        await authSignOut();
        return;
      }
      if (user.must_change_password) {
        // hasło tymczasowe: trzeba zalogować się nim i ustawić własne
        clearSession();
        await authSignOut();
        return;
      }
      currentUser = user;
      writeSession(activity.view);
      loadTopbarVersion();
      if (overlay) overlay.style.display = "none";
      initDashboardApp(activity.view);
      return;
    }

    // Konto pracownika (portal z godzinami)?
    if (await epRestore(session.user.id)) return;

    // Konto modułu Zalew?
    if (await zwRestore(session.user.id)) return;

    // Konto Auth bez profilu (usunięty albo nieaktywny) - wyloguj
    clearSession();
    await authSignOut();
  } catch (err) {
    // np. brak internetu: zostaje ekran logowania, sesja nie jest kasowana
    console.error("Nie udało się przywrócić sesji:", err);
  } finally {
    overlay?.classList.remove("session-check");
  }
}

// Zanim przyjdzie odpowiedź z bazy, nie pokazuj formularza logowania
if (authStorage.getItem(AUTH_STORAGE_KEY)) {
  document.getElementById("auth-overlay")?.classList.add("session-check");
}

document.addEventListener("DOMContentLoaded", () => {
  loadTopbarVersion();
  // stan modułów decyduje m.in. o zakładkach logowania i o tym, czy portal może się otworzyć
  loadModules().then(restoreSession);
});

// Aktywność odświeża czas sesji (najwyżej raz na minutę); bez aktywności - wylogowanie
document.addEventListener("click", () => {
  if ((currentUser || epEmployee || zwUser) && Date.now() - sessionTouchedAt > 60 * 1000) writeSession();
});
setInterval(() => {
  if (!sessionTouchedAt || Date.now() - sessionTouchedAt <= SESSION_IDLE_LIMIT) return;
  if (currentUser) handleLogout();
  else if (epEmployee) epLogout();
  else if (zwUser) zwLogout();
  else return;
  showLoginError("Sesja wygasła z powodu braku aktywności. Zaloguj się ponownie.", false);
}, 60 * 1000);

// ---------- Blokada po kilku błędnych próbach ----------
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_SECONDS = 30;
let loginFailedAttempts = 0;
let loginLockTimer = null;

function registerFailedLogin() {
  loginFailedAttempts++;
  if (loginFailedAttempts < LOGIN_MAX_ATTEMPTS) {
    showLoginError("zły login lub hasło");
    return;
  }

  loginFailedAttempts = 0;
  const btn = document.getElementById("btn-login");
  let left = LOGIN_LOCK_SECONDS;
  showLoginError("Zbyt wiele nieudanych prób. Odczekaj chwilę.");

  const tick = () => {
    if (left <= 0) {
      clearInterval(loginLockTimer);
      loginLockTimer = null;
      if (btn) {
        btn.disabled = false;
        btn.innerText = "Zaloguj się";
      }
      clearLoginError();
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.innerText = `Spróbuj za ${left} s`;
    }
    left--;
  };
  tick();
  loginLockTimer = setInterval(tick, 1000);
}

// ==========================================
// 2. LOGOWANIE I PŁYNNA TRANSFORMACJA IKON
// ==========================================
let loginMode = "user";       // zakładka na ekranie logowania: "user" | "employee" (portal pracownika)

async function handleLogin() {
  if (loginMode === "employee") return epLogin();
  if (loginMode === "zalew") return zwLogin();
  if (loginLockTimer) return; // trwa blokada po błędnych próbach
  clearLoginError();

  const loginInput = document.getElementById("login-input").value.trim();
  const passwordInput = document.getElementById("password-input").value;
  const loginBtn = document.getElementById("btn-login");

  if (!loginInput || !passwordInput) {
    showLoginError("Wpisz login i hasło.");
    return;
  }

  try {
    if (loginBtn) {
      loginBtn.disabled = true;
      loginBtn.innerText = "Logowanie...";
    }

    // "Zapamiętaj mnie" decyduje, gdzie Supabase zapisze sesję - trzeba ustawić przed logowaniem
    setAuthRemember(!!document.getElementById("login-remember")?.checked);

    const { data: auth, error: authError } = await supabaseClient.auth.signInWithPassword({
      email: authEmail("user", loginInput),
      password: passwordInput
    });

    if (authError) {
      if (isAuthNetworkError(authError)) {
        console.error("Błąd logowania:", authError);
        showLoginError("Brak połączenia z serwerem. Sprawdź internet.", false);
      } else {
        registerFailedLogin();
      }
      return;
    }

    const { data: user, error } = await supabaseClient
      .from("users")
      .select(USER_SELECT)
      .eq("auth_id", auth.user.id)
      .maybeSingle();

    if (error) {
      console.error("Błąd pobierania profilu użytkownika:", error);
      await authSignOut();
      showLoginError("Błąd bazy danych. Spróbuj ponownie.", false);
      return;
    }
    if (!user) {
      // konto Auth istnieje, ale nie ma już profilu w tabeli users
      await authSignOut();
      registerFailedLogin();
      return;
    }

    // Logowanie użytkowników wyłączone (Opcje -> Moduły): wpuszczany jest tylko administrator
    if (!moduleEnabled("user_login") && !isAdminRoleName(user.role?.role)) {
      await authSignOut();
      showLoginError("Logowanie użytkowników jest wyłączone.", false);
      return;
    }

    loginFailedAttempts = 0;

    // Pierwsze logowanie albo hasło ustawione przez administratora: najpierw własne hasło
    if (user.must_change_password) {
      openForcePassword({
        current: passwordInput,
        onDone: () => {
          user.must_change_password = false;
          completeUserLogin(user);
        },
        onCancel: authSignOut
      });
      return;
    }

    completeUserLogin(user);

  } catch (err) {
    console.error("Niespodziewany błąd:", err);
    showLoginError("Brak połączenia z serwerem. Sprawdź internet.", false);
  } finally {
    // podczas blokady przycisk zostaje nieaktywny z odliczaniem
    if (loginBtn && !loginLockTimer) {
      loginBtn.disabled = false;
      loginBtn.innerText = "Zaloguj się";
    }
  }
}

// Wejście do systemu po poprawnym logowaniu: sesja i animacja powitania
function completeUserLogin(user) {
  currentUser = user;
  logAction("Logowanie");
  clearSession();           // nowe logowanie zaczyna od pulpitu, nie od ostatniego widoku
  writeSession(null);
  loadTopbarVersion();

  const iconBox = document.getElementById("auth-icon-box");
  const stepLogin = document.getElementById("step-login");
  const stepSuccess = document.getElementById("step-success");
  const stepWelcome = document.getElementById("step-welcome");

  const welcomeTextEl = document.getElementById("welcome-text");
  const welcomeMetaEl = document.getElementById("welcome-user-meta");
  const welcomeRoleEl = document.getElementById("welcome-role");
  const welcomeDeptEl = document.getElementById("welcome-dept");
  const progressBar = document.getElementById("welcome-progress-bar");
  const statusText = document.getElementById("welcome-status-text");
  const loaderBox = document.querySelector(".loader-box");
  const authOverlay = document.getElementById("auth-overlay");

  // FAZA 1: Cross-fade z formularza do zielonego ptaszka
  stepLogin.classList.remove("active");
  stepSuccess.classList.add("active");
  
  iconBox.className = "morph-icon-box state-success";

  // FAZA 2: Po wyświetleniu ptaszka (1.2s), morph w żółty kwadrat
  setTimeout(() => {
    welcomeTextEl.textContent = "";
    const roleName = currentUser.role?.role || "Użytkownik";
    if (welcomeRoleEl) welcomeRoleEl.innerText = roleName;
    if (welcomeDeptEl) {
      welcomeDeptEl.innerText = currentUser.department?.department || "Brak działu";
    }
    if (welcomeMetaEl) welcomeMetaEl.classList.remove("visible");

    if (progressBar) progressBar.style.width = "0%";
    if (loaderBox) loaderBox.classList.remove("visible");

    stepSuccess.classList.remove("active");
    stepWelcome.classList.add("active");

    iconBox.className = "morph-icon-box state-welcome";

    const firstName = (currentUser.name || "").trim();
    const lastName = (currentUser.last_name || "").trim();
    const userFullName = (firstName && lastName) ? `${firstName} ${lastName}` : (firstName || lastName || currentUser.login);

    const fullText = `Witaj, ${userFullName}!`;
    let charIdx = 0;

    const typingInterval = setInterval(() => {
      welcomeTextEl.textContent = fullText.slice(0, charIdx + 1);
      charIdx++;

      if (charIdx >= fullText.length) {
        clearInterval(typingInterval);

        if (welcomeMetaEl) welcomeMetaEl.classList.add("visible");
        if (loaderBox) loaderBox.classList.add("visible");

        runLoadingSequence(progressBar, statusText, () => {
          setTimeout(() => {
            authOverlay.style.opacity = "0";
            initDashboardApp();

            setTimeout(() => {
              authOverlay.style.display = "none";
            }, 600);
          }, 600);
        });
      }
    }, 35);

  }, 1200);
}

function runLoadingSequence(progressBar, statusText, onComplete) {
  const steps = [
    { progress: 30, text: "Uwierzytelnianie sesji..." },
    { progress: 65, text: "Pobieranie uprawnień i modułów..." },
    { progress: 90, text: "Inicjalizacja środowiska pracy..." },
    { progress: 100, text: "Zalogowano pomyślnie!" }
  ];

  let stepIndex = 0;

  function executeStep() {
    if (stepIndex < steps.length) {
      const step = steps[stepIndex];
      if (progressBar) progressBar.style.width = `${step.progress}%`;
      if (statusText) statusText.innerText = step.text;
      stepIndex++;
      setTimeout(executeStep, 350);
    } else {
      if (onComplete) onComplete();
    }
  }

  executeStep();
}

// ==========================================
// 3. OBSŁUGA UPRAWNIEŃ I INTERFEJSU
// ==========================================
function initDashboardApp(startView) {
  document.getElementById("app-container").style.display = "flex";

  // widok z adresu (np. kliknięte powiadomienie: ?view=absences) ma pierwszeństwo; adres wraca do czystego
  const urlParams = new URLSearchParams(location.search);
  const urlView = urlParams.get("view");
  if (urlView) {
    startView = urlView;
    // zakładka Listy raportów (np. powiadomienie o raporcie do poprawy: ?view=reports&tab=rejected)
    if (urlParams.get("tab") && typeof rpaTab !== "undefined") rpaTab = urlParams.get("tab");
    history.replaceState(null, "", location.pathname);
  }
  
  const firstName = (currentUser.name || "").trim();
  const lastName = (currentUser.last_name || "").trim();
  const fullName = (firstName && lastName) ? `${firstName} ${lastName}` : (firstName || lastName || currentUser.login);
  
  const nameEl = document.getElementById("current-user-name");
  if (nameEl) nameEl.innerText = fullName;

  const roleEl = document.getElementById("current-user-role");
  const deptEl = document.getElementById("current-user-dept");

  const roleName = currentUser.role?.role || "Brak roli";
  if (roleEl) roleEl.innerText = roleName;
  if (deptEl) {
    deptEl.innerText = currentUser.department?.department || "Brak działu";
  }

  const firstAvailableView = applyNavVisibility();
  if (typeof abStartBadge === "function") abStartBadge(); // dymek z liczbą zgłoszeń nieobecności
  if (typeof pushSync === "function") pushSync();         // to urządzenie dostaje powiadomienia tej osoby
  if (typeof msgStart === "function") msgStart();         // komunikaty: wyskakujące okno i skrzynka
  if (typeof rpaStart === "function") rpaStart();         // liczniki raportów do zatwierdzenia i do poprawy

  // Po odświeżeniu strony wróć do ostatnio otwartego widoku, jeśli nadal jest dozwolony
  if (startView && viewTitles[startView] && canOpenView(startView)) {
    navigateTo(startView);
  } else if (canOpenView("dashboard")) {
    navigateTo("dashboard");
  } else if (firstAvailableView) {
    navigateTo(firstAvailableView);
  } else {
    document.getElementById("main-content").innerHTML = `
      <div class="card" style="border-left: 4px solid var(--danger);">
        <h3>Brak uprawnień</h3>
        <p>Twoje konto nie posiada uprawnień do żadnego z modułów. Skontaktuj się z administratorem.</p>
      </div>
    `;
  }
}

// ==========================================
// 4. NAWIGACJA MIĘDZY WIDOKAMI
// ==========================================
async function navigateTo(viewName) {
  const contentEl = document.getElementById("main-content");
  const topbarTitle = document.getElementById("topbar-title");
  if (typeof prTipHide === "function") prTipHide();     // okienko obecności z Bazy pracowników
  if (typeof rtPickClose === "function") rtPickClose(false); // okienko wyboru godzin

  const permissionInfo = permissionMap[viewName];
  if (!canOpenView(viewName)) {
    alert("Brak uprawnień do tego modułu.");
    return;
  }

  document.querySelectorAll(".menu-item").forEach(item => item.classList.remove("active"));
  const activeNav = document.querySelector(`.menu-item[data-tab="${viewName}"]`);
  if (activeNav) activeNav.classList.add("active");
  if (typeof rpaSyncMenu === "function") rpaSyncMenu(viewName); // zakładki Listy raportów

  topbarTitle.innerText = viewTitles[viewName] || "Moduł";
  writeSession(viewName);

  contentEl.innerHTML = `
    <div class="view-loader">
      <i class="fa-solid fa-spinner fa-spin"></i> Ładowanie widoku...
    </div>
  `;

  try {
    const response = await fetch(`views/${viewName}.html?v=${APP_BUILD}`);
    if (!response.ok) {
      throw new Error(`Nie udało się odnaleźć pliku views/${viewName}.html (Status: ${response.status})`);
    }
    const html = await response.text();
    contentEl.innerHTML = html;

    onViewLoaded(viewName);

  } catch (err) {
    // "Failed to fetch" = przeglądarka w ogóle nie połączyła się z serwerem strony
    const network = err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(String(err.message));
    const fileMode = location.protocol === "file:";
    const hint = fileMode
      ? "Strona jest otwarta bezpośrednio z pliku (adres zaczyna się od <b>file://</b>). Moduły wczytują się tylko przez serwer: otwórz ją przez Live Server albo pod adresem strony w internecie."
      : network
        ? "Nie udało się połączyć z serwerem strony. Sprawdź połączenie z internetem (albo czy działa Live Server) i spróbuj ponownie."
        : rtEsc(err.message);
    contentEl.innerHTML = `
      <div class="card" style="border-left: 4px solid var(--danger);">
        <h3 style="color: var(--danger);">Błąd wczytywania modułu</h3>
        <p>${hint}</p>
        ${network || fileMode ? `<p style="font-size: 0.8rem; color: var(--text-muted);">Szczegóły: ${rtEsc(err.message)}</p>` : ""}
        <button type="button" class="btn-primary" style="width: auto; padding: 10px 18px; margin-top: 6px;" onclick="navigateTo('${viewName}')">
          <i class="fa-solid fa-rotate-right"></i> Spróbuj ponownie
        </button>
      </div>
    `;
  }
}

async function onViewLoaded(viewName) {
  switch(viewName) {
    case 'dashboard':
      await initDashboardView();
      break;
    case 'employee_list':
      await initEmployeeListView();
      break;
    case 'users':
      await loadRoleAndDepartmentDropdowns();
      await loadUsersList();
      break;
    case 'schedule':
      await initScheduleView();
      break;
    case 'report_time':
      await initReportTimeView();
      break;
    case 'reports':
      await initReportsView();
      break;
    case 'updates':
      await initUpdatesView();
      break;
    case 'messages':
      await initMessagesView();
      break;
    case 'absences':
      await initAbsencesView();
      break;
    case 'logs':
      await initLogsView();
      break;
    case 'user':
      initUserView();
      break;
  }
}

function toggleModal(modalId, show) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.toggle("active", show);
}

// ==========================================
// 5. WYLOGOWANIE
// ==========================================
function handleLogout() {
  // log musi wyjść, zanim sesja zostanie zamknięta
  // log i odłączenie urządzenia od powiadomień muszą wyjść, zanim sesja zostanie zamknięta
  Promise.all([
    currentUser ? logAction("Wylogowanie") : null,
    typeof pushForget === "function" ? pushForget() : null
  ]).finally(authSignOut);
  currentUser = null;
  clearSession();
  clearLoginError();
  document.getElementById("app-container").style.display = "none";

  const authOverlay = document.getElementById("auth-overlay");
  authOverlay.style.display = "flex";
  authOverlay.style.opacity = "1";

  document.getElementById("step-login").classList.add("active");
  document.getElementById("step-success").classList.remove("active");
  document.getElementById("step-welcome").classList.remove("active");

  const iconBox = document.getElementById("auth-icon-box");
  iconBox.className = "morph-icon-box";

  document.getElementById("login-input").value = "";
  document.getElementById("password-input").value = "";

  Object.values(permissionMap).forEach((config) => {
    const el = document.getElementById(config.elementId);
    if (el) el.style.display = "none";
  });
}

// ==========================================
// 6. MODUŁ UŻYTKOWNIKÓW (USERS)
// ==========================================
async function loadRoleAndDepartmentDropdowns(selectedRoleId = null, selectedDeptId = null) {
  const roleSelect = document.getElementById("form-user-role-id");
  const deptSelect = document.getElementById("form-user-department-id");

  if (!roleSelect || !deptSelect) return;

  try {
    const [rolesRes, deptsRes] = await Promise.all([
      supabaseClient.from("role").select("id, role").order("role", { ascending: true }),
      supabaseClient.from("department").select("id, department").order("department", { ascending: true })
    ]);

    const roles = rolesRes.data || [];
    const depts = deptsRes.data || [];

    roleSelect.innerHTML = `<option value="">Wybierz rangę...</option>` +
      // roli Administrator nie nadaje się ze strony (tylko w panelu Supabase)
      roles.filter(r => !isAdminRoleName(r.role))
        .map(r => `<option value="${r.id}">${r.role}</option>`).join("");

    deptSelect.innerHTML = `<option value="">Wybierz dział...</option>` +
      depts.map(d => `<option value="${d.id}">${d.department}</option>`).join("");

    if (selectedRoleId) roleSelect.value = selectedRoleId;
    if (selectedDeptId) deptSelect.value = selectedDeptId;

  } catch (err) {
    console.error("Błąd podczas pobierania ról lub działów:", err);
  }
}

async function openCreateUserModal() {
  const form = document.getElementById("user-form");
  if (form) form.reset();

  document.getElementById("user-form-mode").value = "create";
  document.getElementById("original-user-login").value = "";
  document.getElementById("modal-user-title").innerText = "Nowy użytkownik";
  
  const loginField = document.getElementById("form-user-login");
  loginField.disabled = false;

  const passField = document.getElementById("form-user-password");
  passField.required = true;
  passField.placeholder = "••••••••";
  document.getElementById("user-pass-group").style.display = "";
  document.getElementById("user-reset-group").style.display = "none";

  const msgBox = document.getElementById("user-form-msg");
  if (msgBox) msgBox.style.display = "none";

  await loadRoleAndDepartmentDropdowns();
  toggleModal("modal-user-form", true);
}

async function openEditUserModal(login) {
  const user = cachedUsers.find(u => u.login === login);
  if (!user) {
    alert("Nie znaleziono danych użytkownika.");
    return;
  }

  const form = document.getElementById("user-form");
  if (form) form.reset();

  document.getElementById("user-form-mode").value = "edit";
  document.getElementById("original-user-login").value = user.login;
  document.getElementById("modal-user-title").innerText = "Edycja użytkownika";

  document.getElementById("form-user-name").value = user.name || "";
  document.getElementById("form-user-lastname").value = user.last_name || "";
  
  const loginField = document.getElementById("form-user-login");
  loginField.value = user.login;
  loginField.disabled = true;

  // przy edycji hasła nie da się wpisać - tylko reset na hasło startowe (resetAccountPassword)
  const passField = document.getElementById("form-user-password");
  passField.required = false;
  passField.value = "";
  document.getElementById("user-pass-group").style.display = "none";
  document.getElementById("user-reset-group").style.display = "";
  const resetBtn = document.getElementById("btn-reset-user-password");
  const resetHint = document.getElementById("user-reset-hint");
  accountResetSetup(resetBtn, "user", user.id, `${user.name || ""} ${user.last_name || ""}`.trim() || user.login, user.login, "Resetuj hasło");
  // własne hasło zmienia się w "Moje konto" (reset własnego konta nie wymusiłby zmiany przy logowaniu)
  const own = currentUser && Number(currentUser.id) === Number(user.id);
  resetBtn.disabled = own;
  resetHint.textContent = own
    ? "To Twoje konto - swoje hasło zmienisz w „Moje konto” (kliknij swoje imię w menu)."
    : "Hasło zostanie ustawione na „123456”, a przy logowaniu trzeba będzie ustawić nowe.";

  await loadRoleAndDepartmentDropdowns(user.role_id, user.department_id);

  document.getElementById("perm-dashboard").checked = !!(user.allow_dashboard);
  document.getElementById("perm-employees").checked = !!(user.allow_employees);
  document.getElementById("perm-time-reporting").checked = !!(user.allow_time_reporting);
  document.getElementById("perm-schedule").checked = !!(user.allow_schedule);
  document.getElementById("perm-reports").checked = !!(user.allow_reports);
  document.getElementById("perm-users").checked = !!(user.allow_users);
  document.getElementById("perm-updates").checked = !!(user.allow_updates);
  document.getElementById("perm-options").checked = !!(user.allow_options);
  document.getElementById("perm-logs").checked = !!(user.allow_logs);
  const permMsg = document.getElementById("perm-messages");
  if (permMsg) permMsg.checked = !!(user.allow_messages);
  const permApprove = document.getElementById("perm-report-approve");
  if (permApprove) permApprove.checked = !!(user.allow_report_approve);

  const msgBox = document.getElementById("user-form-msg");
  if (msgBox) msgBox.style.display = "none";

  toggleModal("modal-user-form", true);
}

function deleteUser(login) {
  if (currentUser && currentUser.login === login) {
    toggleModal("modal-self-delete-info", true);
    return;
  }

  const user = cachedUsers.find(u => u.login === login);
  let displayName = login;
  if (user) {
    const firstName = (user.name || "").trim();
    const lastName = (user.last_name || "").trim();
    if (firstName || lastName) {
      displayName = `${firstName} ${lastName}`.trim();
    }
  }

  userToDeleteLogin = login;

  const targetNameEl = document.getElementById("delete-user-target-name");
  if (targetNameEl) targetNameEl.innerText = displayName;

  const confirmBtn = document.getElementById("btn-confirm-delete");

  if (deleteCountdownTimer) {
    clearInterval(deleteCountdownTimer);
    deleteCountdownTimer = null;
  }

  let secondsLeft = 3;
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerText = `Tak (${secondsLeft}s)`;

    deleteCountdownTimer = setInterval(() => {
      secondsLeft--;
      if (secondsLeft > 0) {
        confirmBtn.innerText = `Tak (${secondsLeft}s)`;
      } else {
        clearInterval(deleteCountdownTimer);
        deleteCountdownTimer = null;
        confirmBtn.disabled = false;
        confirmBtn.innerText = "Tak";
      }
    }, 1000);
  }

  toggleModal("modal-delete-confirm", true);
}

function closeDeleteConfirmModal() {
  userToDeleteLogin = null;
  if (deleteCountdownTimer) {
    clearInterval(deleteCountdownTimer);
    deleteCountdownTimer = null;
  }
  toggleModal("modal-delete-confirm", false);
}

async function confirmDeleteUser() {
  if (!userToDeleteLogin) return;

  const confirmBtn = document.getElementById("btn-confirm-delete");

  try {
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.innerText = "Usuwanie...";
    }

    const { error } = await supabaseClient
      .from("users")
      .delete()
      .eq("login", userToDeleteLogin);

    if (error) {
      console.error("Błąd podczas usuwania użytkownika:", error);
      alert("Wystąpił błąd podczas usuwania: " + error.message);
      return;
    }

    logAction("Usunięcie użytkownika", `login: ${userToDeleteLogin}`);
    closeDeleteConfirmModal();
    await loadUsersList();

  } catch (err) {
    console.error("Niespodziewany błąd:", err);
    alert("Wystąpił nieoczekiwany błąd podczas usuwania użytkownika.");
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerText = "Tak";
    }
  }
}

async function loadUsersList() {
  const tbody = document.getElementById("users-table-body");
  if (!tbody) return;

  try {
    const { data: allUsers, error } = await supabaseClient
      .from("users")
      .select(USER_SELECT)
      .order("name", { ascending: true });

    if (error) {
      console.error("Błąd pobierania użytkowników:", error);
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; color: var(--danger); padding: 20px;">
            Wystąpił błąd podczas pobierania użytkowników: ${error.message}
          </td>
        </tr>
      `;
      return;
    }

    // Konta administratorów nie są pokazywane w tym panelu: nie da się ich tu edytować ani usunąć
    const users = (allUsers || []).filter(u => !isAdminRoleName(u.role?.role));
    cachedUsers = users;

    if (!users || users.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 25px;">
            Brak zarejestrowanych użytkowników w bazie.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = users.map(u => {
      const permissions = [
        { label: "Dashboard", active: u.allow_dashboard },
        { label: "Pracownicy", active: u.allow_employees },
        { label: "Rozliczanie", active: u.allow_time_reporting },
        { label: "Harmonogram", active: u.allow_schedule },
        { label: "Raporty", active: u.allow_reports },
        { label: "Użytkownicy", active: u.allow_users },
        { label: "Aktualizacje", active: u.allow_updates },
        { label: "Opcje", active: u.allow_options },
        { label: "Logi", active: u.allow_logs },
        { label: "Komunikaty", active: u.allow_messages },
        { label: "Zatwierdzanie raportów", active: u.allow_report_approve }
      ];

      const activeBadges = permissions
        .filter(p => p.active === true || p.active === 1)
        .map(p => `
          <span style="display: inline-block; font-size: 0.72rem; padding: 2px 7px; border-radius: 4px; background: rgba(56, 189, 248, 0.12); color: var(--primary, #38bdf8); border: 1px solid rgba(56, 189, 248, 0.25); margin: 2px;">
            ${p.label}
          </span>
        `).join("");

      const roleName = u.role?.role || '-';
      const deptName = u.department?.department || '-';

      return `
        <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
          <td style="padding: 12px 16px; color: var(--text-muted);">${`${u.name || ''} ${u.last_name || ''}`.trim() || '-'}</td>
          <td style="padding: 12px 16px; color: var(--text-muted);">${u.login}</td>
          <td style="padding: 12px 16px;">
            <span style="background: rgba(255, 255, 255, 0.05); padding: 3px 8px; border-radius: 4px; font-size: 0.8rem; border: 1px solid rgba(255, 255, 255, 0.5); color: var(--text-muted);">
              ${roleName}
            </span>
          </td>
          <td style="padding: 12px 16px; color: var(--text-muted);">${deptName}</td>
          <td style="padding: 12px 16px; max-width: 320px;">
            ${activeBadges || '<span style="color: var(--text-muted); font-size: 0.75rem;">Brak uprawnień</span>'}
          </td>
          <td style="padding: 12px 16px; text-align: center; white-space: nowrap;">
            <button class="link-btn" title="Edytuj użytkownika" style="font-size: 0.95rem; padding: 4px 8px; cursor: pointer;" onclick="openEditUserModal('${u.login}')">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="link-btn" title="Usuń użytkownika" style="font-size: 0.95rem; padding: 4px 8px; cursor: pointer; color: var(--danger, #ef4444); margin-left: 6px;" onclick="deleteUser('${u.login}')">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </td>
        </tr>
      `;
    }).join("");

  } catch (err) {
    console.error("Niespodziewany błąd:", err);
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 20px;">Błąd wczytywania danych.</td></tr>`;
  }
}

async function handleSaveUser(e) {
  e.preventDefault();

  const msgBox = document.getElementById("user-form-msg");
  const saveBtn = document.getElementById("btn-save-user");

  const mode = document.getElementById("user-form-mode").value;
  const originalLogin = document.getElementById("original-user-login").value;

  const name = document.getElementById("form-user-name").value.trim();
  const last_name = document.getElementById("form-user-lastname").value.trim();
  const login = document.getElementById("form-user-login").value.trim();
  const password = document.getElementById("form-user-password").value;
  
  const roleIdRaw = document.getElementById("form-user-role-id").value;
  const role_id = roleIdRaw ? parseInt(roleIdRaw, 10) : null;

  const departmentIdRaw = document.getElementById("form-user-department-id").value;
  const department_id = departmentIdRaw ? parseInt(departmentIdRaw, 10) : null;

  const userPayload = {
    name,
    last_name,
    role_id,
    department_id,
    allow_dashboard: document.getElementById("perm-dashboard") ? document.getElementById("perm-dashboard").checked : false,
    allow_employees: document.getElementById("perm-employees") ? document.getElementById("perm-employees").checked : false,
    allow_time_reporting: document.getElementById("perm-time-reporting") ? document.getElementById("perm-time-reporting").checked : false,
    allow_schedule: document.getElementById("perm-schedule") ? document.getElementById("perm-schedule").checked : false,
    allow_reports: document.getElementById("perm-reports") ? document.getElementById("perm-reports").checked : false,
    allow_users: document.getElementById("perm-users") ? document.getElementById("perm-users").checked : false,
    allow_updates: document.getElementById("perm-updates") ? document.getElementById("perm-updates").checked : false,
    allow_options: document.getElementById("perm-options") ? document.getElementById("perm-options").checked : false,
    allow_logs: document.getElementById("perm-logs") ? document.getElementById("perm-logs").checked : false,
    // kolumna allow_messages istnieje dopiero po sql/33 - bez niej zapis by się nie udał
    ...(currentUser && "allow_messages" in currentUser && document.getElementById("perm-messages")
      ? { allow_messages: document.getElementById("perm-messages").checked } : {}),
    // kolumna allow_report_approve istnieje dopiero po sql/34
    ...(currentUser && "allow_report_approve" in currentUser && document.getElementById("perm-report-approve")
      ? { allow_report_approve: document.getElementById("perm-report-approve").checked } : {})
  };

  try {
    saveBtn.disabled = true;
    saveBtn.innerText = "Zapisywanie...";

    // Hasło trzyma Supabase Auth; ustawia je funkcja bazy app_set_password (wymaga min. 6 znaków).
    // Przy edycji hasła się nie wpisuje - jest tylko przycisk "Resetuj hasło".
    if (mode === "create" && password.length < 6) {
      msgBox.innerText = "Hasło musi mieć co najmniej 6 znaków.";
      msgBox.style.color = "var(--danger, #ef4444)";
      msgBox.style.display = "block";
      return;
    }

    if (mode === "create") {
      userPayload.login = login;

      const { data: existingUser } = await supabaseClient
        .from("users")
        .select("login")
        .eq("login", login)
        .maybeSingle();

      if (existingUser) {
        msgBox.innerText = `Użytkownik o loginie "${login}" już istnieje!`;
        msgBox.style.color = "var(--danger, #ef4444)";
        msgBox.style.display = "block";
        saveBtn.disabled = false;
        saveBtn.innerText = "Zapisz";
        return;
      }

      const { data: inserted, error: insertError } = await supabaseClient
        .from("users")
        .insert([userPayload])
        .select("id");

      if (insertError) throw insertError;
      if (!inserted || !inserted[0]) throw new Error("Użytkownik nie został dodany (brak uprawnień w bazie).");

      // konto logowania; przy pierwszym logowaniu użytkownik ustawia własne hasło
      const { error: accountError } = await supabaseClient.rpc("app_set_password", {
        p_kind: "user",
        p_id: inserted[0].id,
        p_password: password
      });
      if (accountError) {
        throw new Error("Użytkownik został dodany, ale nie udało się utworzyć konta logowania: " +
          accountError.message + " Otwórz jego edycję i ustaw hasło ponownie.");
      }

    } else if (mode === "edit") {
      const { data: updated, error: updateError } = await supabaseClient
        .from("users")
        .update(userPayload)
        .eq("login", originalLogin)
        .select("id");

      if (updateError) throw updateError;
      if (!updated || !updated[0]) throw new Error("Zmiany nie zostały zapisane (brak uprawnień w bazie).");
    }

    logAction(mode === "create" ? "Dodanie użytkownika" : "Edycja użytkownika",
      `${name} ${last_name} (login: ${mode === "create" ? login : originalLogin})`);
    toggleModal("modal-user-form", false);
    await loadUsersList();

  } catch (err) {
    console.error("Błąd zapisu użytkownika:", err);
    msgBox.innerText = "Wystąpił błąd: " + (err.message || err);
    msgBox.style.color = "var(--danger, #ef4444)";
    msgBox.style.display = "block";
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerText = "Zapisz";
  }
}

// ---------- Reset hasła (Użytkownicy i Baza pracowników) ----------
// Hasło wraca do startowego "123456" (EMPLOYEE_DEFAULT_PASSWORD). Funkcja bazy app_set_password
// przy nadaniu hasła komuś innemu ustawia must_change_password - przy logowaniu trzeba ustawić nowe.
// Konto bez logowania (pracownik bez konta) zostaje przy tym utworzone.
// Dwa kliknięcia: pierwsze uzbraja przycisk, drugie (w ciągu 4 s) resetuje.
// Przycisk niesie: data-kind ("user" / "employee"), data-id, data-name, data-login.
let accountResetTimer = null;

function accountResetDisarm(btn, label) {
  clearTimeout(accountResetTimer);
  btn.dataset.armed = "";
  btn.disabled = false;
  btn.classList.remove("armed", "done");
  btn.innerHTML = `<i class="fa-solid fa-key"></i> ${label || btn.dataset.label || "Resetuj hasło"}`;
  if (label) btn.dataset.label = label;
}

async function resetAccountPassword(btn) {
  const user = btn.dataset.kind === "user";
  const msgBox = document.getElementById(user ? "user-form-msg" : "employee-form-msg");
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.classList.add("armed");
    btn.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Na pewno? Kliknij ponownie`;
    clearTimeout(accountResetTimer);
    accountResetTimer = setTimeout(() => accountResetDisarm(btn), 4000);
    return;
  }

  clearTimeout(accountResetTimer);
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Resetowanie...`;
  try {
    const { error } = await supabaseClient.rpc("app_set_password", {
      p_kind: btn.dataset.kind,
      p_id: Number(btn.dataset.id),
      p_password: EMPLOYEE_DEFAULT_PASSWORD
    });
    if (error) throw error;
    logAction(user ? "Reset hasła użytkownika" : "Reset hasła pracownika", `${btn.dataset.name} (login: ${btn.dataset.login})`);
    btn.dataset.armed = "";
    btn.classList.remove("armed");
    btn.classList.add("done");
    btn.innerHTML = `<i class="fa-solid fa-check"></i> Hasło zresetowane`;
    msgBox.innerText = `Zresetowano hasło: ${btn.dataset.name} (login: ${btn.dataset.login}). Hasło to teraz „${EMPLOYEE_DEFAULT_PASSWORD}” - przy logowaniu trzeba będzie ustawić własne.`;
    msgBox.style.color = "#0b7a57";
    msgBox.style.display = "block";
    if (!user) {
      // pracownik mógł dopiero dostać konto - odśwież dane, żeby formularz o tym wiedział
      const emp = cachedEmployees.find(e => String(e.id) === String(btn.dataset.id));
      if (emp && !emp.auth_id) emp.auth_id = "set";
    }
    accountResetTimer = setTimeout(() => accountResetDisarm(btn, "Resetuj hasło"), 4000);
  } catch (err) {
    console.error("Błąd resetu hasła:", err);
    accountResetDisarm(btn);
    msgBox.innerText = "Nie udało się zresetować hasła: " + (err.message || err);
    msgBox.style.color = "var(--danger, #ef4444)";
    msgBox.style.display = "block";
  }
}

// Przygotowanie przycisku resetu w otwieranym formularzu edycji
function accountResetSetup(btn, kind, id, name, login, label) {
  btn.dataset.kind = kind;
  btn.dataset.id = String(id);
  btn.dataset.name = name;
  btn.dataset.login = login || "";
  accountResetDisarm(btn, label);
}

// ==========================================
// 7. MODUŁ PRACOWNIKÓW (EMPLOYEE_LIST)
// ==========================================
let cachedEmployees = [];
let cachedBusinesses = [];
let cachedDepartments = [];
let employeeToDeleteId = null;
let deleteEmployeeCountdownTimer = null;

async function initEmployeeListView() {
  await Promise.all([
    loadEmployeeFilterDictionaries(),
    loadEmployeesList()
  ]);
}

async function loadEmployeeFilterDictionaries() {
  try {
    const [bizRes, deptRes] = await Promise.all([
      supabaseClient.from("business").select("id, business"),
      supabaseClient.from("department").select("id, department")
    ]);

    if (bizRes.error) {
      console.error("Błąd zapytania tabeli business:", bizRes.error);
    }
    if (deptRes.error) {
      console.error("Błąd zapytania tabeli department:", deptRes.error);
    }

    cachedBusinesses = (bizRes.data || []).sort((a, b) => 
      String(a.business || '').localeCompare(String(b.business || ''), 'pl')
    );

    cachedDepartments = (deptRes.data || []).sort((a, b) => 
      String(a.department || '').localeCompare(String(b.department || ''), 'pl')
    );

    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      const filterBiz = document.getElementById("emp-filter-business");
      const filterDept = document.getElementById("emp-filter-dept");

      if (filterBiz && filterDept) {
        clearInterval(interval);

        filterBiz.innerHTML = `<option value="">Wszystkie firmy</option>` +
          cachedBusinesses.map(b => `<option value="${b.id}">${b.business || ('Firma #' + b.id)}</option>`).join("");

        filterDept.innerHTML = `<option value="">Wszystkie działy</option>` +
          cachedDepartments.map(d => `<option value="${d.id}">${d.department || ('Dział #' + d.id)}</option>`).join("");
      }

      if (attempts >= 15) {
        clearInterval(interval);
      }
    }, 50);

  } catch (err) {
    console.error("Krytyczny błąd pobierania słowników firm/działów:", err);
  }
}

async function loadEmployeesList() {
  const tbody = document.getElementById("employees-table-body");
  if (!tbody) return;

  try {
    const { data: employees, error } = await supabaseClient
      .from("employees")
      .select(`
        id,
        first_name,
        last_name,
        phone_number,
        login,
        auth_id,
        business_id,
        department_id,
        active,
        business:business_id ( business ),
        department:department_id ( department )
      `)
      .eq("active", true)
      .order("first_name", { ascending: true })
      .order("last_name", { ascending: true });

    if (error) {
      console.error("Błąd pobierania bazy pracowników:", error);
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; color: var(--danger); padding: 25px;">
            Wystąpił błąd podczas pobierania pracowników: ${error.message}
          </td>
        </tr>
      `;
      return;
    }

    cachedEmployees = employees || [];
    renderEmployeesTable(cachedEmployees);
    // obecność w bieżącym tygodniu: osobno, błąd nie psuje listy (employee_presence.js)
    if (typeof prLoad === "function") prLoad();

  } catch (err) {
    console.error("Niespodziewany błąd pobierania pracowników:", err);
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 20px;">Błąd pobierania danych.</td></tr>`;
  }
}

function renderEmployeesTable(list) {
  const tbody = document.getElementById("employees-table-body");
  if (!tbody) return;

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 30px;">
          Brak aktywnych pracowników spełniających podane kryteria.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = list.map(emp => {
    let businessName = emp.business?.business;
    if (!businessName && emp.business_id) {
      const match = cachedBusinesses.find(b => b.id === emp.business_id);
      businessName = match ? match.business : `Firma #${emp.business_id}`;
    }
    businessName = businessName || '-';

    let deptName = emp.department?.department;
    if (!deptName && emp.department_id) {
      const match = cachedDepartments.find(d => d.id === emp.department_id);
      deptName = match ? match.department : `Dział #${emp.department_id}`;
    }
    deptName = deptName || '-';

    const phone = emp.phone_number ? emp.phone_number : '<span style="color: var(--text-muted); font-size: 0.8rem;">brak</span>';
    const fullNameEscaped = `${emp.first_name || ''} ${emp.last_name || ''}`.trim().replace(/'/g, "\\'");

    return `
      <tr style="border-bottom: 1px solid #F0F0F0;">
        <td style="padding: 14px 18px; font-weight: 600; color: var(--primary);">
          ${emp.first_name || ''} ${emp.last_name || ''}
        </td>
        <td style="padding: 14px 18px; color: var(--text-dark);">
          ${phone}
        </td>
        <td style="padding: 14px 18px;">
          <span style="background: rgba(8, 88, 75, 0.06); color: var(--primary); padding: 4px 9px; border-radius: 4px; font-size: 0.82rem; font-weight: 600; border: 1px solid rgba(8, 88, 75, 0.15);">
            ${businessName}
          </span>
        </td>
        <td style="padding: 14px 18px; color: var(--text-muted); font-size: 0.88rem;">
          ${deptName}
        </td>
        <td class="pr-cell" data-emp="${Number(emp.id)}" style="padding: 10px 12px;">
          ${typeof prCellHtml === "function" ? prCellHtml(emp.id) : ""}
        </td>
        <td style="padding: 14px 18px; text-align: center; white-space: nowrap;">
          <button class="link-btn" title="Podgląd godzin" style="font-size: 1rem; padding: 4px 8px; cursor: pointer; margin-right: 6px;" onclick="ehOpen(${emp.id})">
            <i class="fa-solid fa-clock"></i>
          </button>
          <button class="link-btn" title="Edytuj pracownika" style="font-size: 1rem; padding: 4px 8px; cursor: pointer;" onclick="openEditEmployeeModal(${emp.id})">
            <i class="fa-solid fa-pen-to-square"></i>
          </button>
          <button class="link-btn" title="Usuń pracownika" style="font-size: 1rem; padding: 4px 8px; cursor: pointer; color: var(--danger, #ef4444); margin-left: 6px;" onclick="openDeleteEmployeeModal(${emp.id}, '${fullNameEscaped}')">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </td>
      </tr>
    `;
  }).join("");
}

function openDeleteEmployeeModal(empId, fullName) {
  employeeToDeleteId = empId;

  const targetNameEl = document.getElementById("delete-employee-target-name");
  if (targetNameEl) {
    targetNameEl.innerText = fullName.trim() || `ID: ${empId}`;
  }

  const confirmBtn = document.getElementById("btn-confirm-delete-employee");

  if (deleteEmployeeCountdownTimer) {
    clearInterval(deleteEmployeeCountdownTimer);
    deleteEmployeeCountdownTimer = null;
  }

  let secondsLeft = 3;
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerText = `Tak (${secondsLeft}s)`;

    deleteEmployeeCountdownTimer = setInterval(() => {
      secondsLeft--;
      if (secondsLeft > 0) {
        confirmBtn.innerText = `Tak (${secondsLeft}s)`;
      } else {
        clearInterval(deleteEmployeeCountdownTimer);
        deleteEmployeeCountdownTimer = null;
        confirmBtn.disabled = false;
        confirmBtn.innerText = "Tak";
      }
    }, 1000);
  }

  toggleModal("modal-employee-delete-confirm", true);
}

function closeDeleteEmployeeModal() {
  employeeToDeleteId = null;
  if (deleteEmployeeCountdownTimer) {
    clearInterval(deleteEmployeeCountdownTimer);
    deleteEmployeeCountdownTimer = null;
  }
  toggleModal("modal-employee-delete-confirm", false);
}

async function confirmDeleteEmployee() {
  if (!employeeToDeleteId) return;

  const confirmBtn = document.getElementById("btn-confirm-delete-employee");

  try {
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.innerText = "Usuwanie...";
    }

    const { error } = await supabaseClient
      .from("employees")
      .update({ active: false })
      .eq("id", employeeToDeleteId);

    if (error) {
      console.error("Błąd podczas deaktywacji pracownika:", error);
      alert("Wystąpił błąd: " + error.message);
      return;
    }

    {
      const removed = cachedEmployees.find(emp => String(emp.id) === String(employeeToDeleteId));
      logAction("Usunięcie pracownika", removed ? `${removed.first_name || ""} ${removed.last_name || ""}`.trim() : `id ${employeeToDeleteId}`);
    }
    closeDeleteEmployeeModal();
    await loadEmployeesList();
    applyEmployeeFilters();

  } catch (err) {
    console.error("Niespodziewany błąd:", err);
    alert("Wystąpił nieoczekiwany błąd podczas usuwania pracownika.");
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerText = "Tak";
    }
  }
}

function applyEmployeeFilters() {
  const query = (document.getElementById("emp-filter-search")?.value || "").toLowerCase().trim();
  const selectedBiz = document.getElementById("emp-filter-business")?.value;
  const selectedDept = document.getElementById("emp-filter-dept")?.value;

  const filtered = cachedEmployees.filter(emp => {
    const fullName = `${emp.first_name || ''} ${emp.last_name || ''}`.toLowerCase();
    const reverseFullName = `${emp.last_name || ''} ${emp.first_name || ''}`.toLowerCase();

    const matchesSearch = !query || fullName.includes(query) || reverseFullName.includes(query);
    const matchesBiz = !selectedBiz || String(emp.business_id) === String(selectedBiz);
    const matchesDept = !selectedDept || String(emp.department_id) === String(selectedDept);

    return matchesSearch && matchesBiz && matchesDept;
  });

  renderEmployeesTable(filtered);
}

function resetEmployeeFilters() {
  const searchInput = document.getElementById("emp-filter-search");
  const filterBiz = document.getElementById("emp-filter-business");
  const filterDept = document.getElementById("emp-filter-dept");

  if (searchInput) searchInput.value = "";
  if (filterBiz) filterBiz.value = "";
  if (filterDept) filterDept.value = "";

  renderEmployeesTable(cachedEmployees);
}

async function populateEmployeeModalDropdowns(selectedBizId = null, selectedDeptId = null) {
  const bizSelect = document.getElementById("form-emp-business-id");
  const deptSelect = document.getElementById("form-emp-dept-id");

  if (cachedBusinesses.length === 0 || cachedDepartments.length === 0) {
    const [bRes, dRes] = await Promise.all([
      supabaseClient.from("business").select("id, business"),
      supabaseClient.from("department").select("id, department")
    ]);
    if (bRes.data) {
      cachedBusinesses = bRes.data.sort((a, b) => 
        String(a.business || '').localeCompare(String(b.business || ''), 'pl')
      );
    }
    if (dRes.data) {
      cachedDepartments = dRes.data.sort((a, b) => 
        String(a.department || '').localeCompare(String(b.department || ''), 'pl')
      );
    }
  }

  if (bizSelect) {
    bizSelect.innerHTML = `<option value="">Wybierz firmę...</option>` +
      cachedBusinesses.map(b => `<option value="${b.id}">${b.business || ('Firma #' + b.id)}</option>`).join("");
    if (selectedBizId) bizSelect.value = selectedBizId;
  }

  if (deptSelect) {
    deptSelect.innerHTML = `<option value="">Wybierz dział...</option>` +
      cachedDepartments.map(d => `<option value="${d.id}">${d.department || ('Dział #' + d.id)}</option>`).join("");
    if (selectedDeptId) deptSelect.value = selectedDeptId;
  }
}

async function openCreateEmployeeModal() {
  const form = document.getElementById("employee-form");
  if (form) form.reset();

  document.getElementById("employee-form-mode").value = "create";
  document.getElementById("employee-form-id").value = "";
  document.getElementById("modal-employee-title").innerText = "Nowy pracownik";

  // Login uzupełnia się sam z imienia i nazwiska, hasło startowe jest wpisane z góry
  if (form) form.dataset.loginAuto = "1";
  document.getElementById("form-emp-login").value = "";
  document.getElementById("form-emp-password").value = EMPLOYEE_DEFAULT_PASSWORD;
  document.getElementById("form-emp-password").placeholder = "";
  document.getElementById("emp-pass-group").style.display = "";
  document.getElementById("emp-reset-group").style.display = "none";
  document.getElementById("form-emp-login-hint").textContent =
    "Uzupełnia się z imienia i nazwiska. Zajęty login dostanie kolejny numer.";

  const msgBox = document.getElementById("employee-form-msg");
  if (msgBox) msgBox.style.display = "none";

  await populateEmployeeModalDropdowns();
  toggleModal("modal-employee-form", true);
}

async function openEditEmployeeModal(empId) {
  const emp = cachedEmployees.find(e => e.id === empId);
  if (!emp) {
    alert("Nie znaleziono pracownika.");
    return;
  }

  const form = document.getElementById("employee-form");
  if (form) form.reset();

  document.getElementById("employee-form-mode").value = "edit";
  document.getElementById("employee-form-id").value = emp.id;
  document.getElementById("modal-employee-title").innerText = "Edycja pracownika";

  document.getElementById("form-emp-first-name").value = emp.first_name || "";
  document.getElementById("form-emp-last-name").value = emp.last_name || "";
  document.getElementById("form-emp-phone").value = emp.phone_number || "";

  // Przy edycji login zmienia się tylko ręcznie, a hasła nie da się wpisać - jest tylko reset na "123456"
  if (form) form.dataset.loginAuto = "0";
  document.getElementById("form-emp-login").value = emp.login || "";
  document.getElementById("form-emp-password").value = "";
  document.getElementById("form-emp-login-hint").textContent = "";
  document.getElementById("emp-pass-group").style.display = "none";
  document.getElementById("emp-reset-group").style.display = "";
  const resetBtn = document.getElementById("btn-reset-emp-password");
  const resetHint = document.getElementById("emp-reset-hint");
  accountResetSetup(resetBtn, "employee", emp.id, `${emp.first_name || ""} ${emp.last_name || ""}`.trim(), emp.login,
    emp.auth_id ? "Resetuj hasło" : "Utwórz konto (hasło 123456)");
  // reset działa na zapisanym loginie - bez niego nie ma konta, do którego można by się zalogować
  resetBtn.disabled = !emp.login;
  resetHint.textContent = !emp.login
    ? "Pracownik nie ma loginu. Wpisz login i zapisz - konto powstanie z hasłem „123456”."
    : emp.auth_id
      ? "Hasło zostanie ustawione na „123456”, a przy logowaniu trzeba będzie ustawić nowe."
      : "Pracownik nie ma jeszcze konta. Zostanie utworzone z hasłem „123456”, które trzeba zmienić przy logowaniu.";

  await populateEmployeeModalDropdowns(emp.business_id, emp.department_id);

  const msgBox = document.getElementById("employee-form-msg");
  if (msgBox) msgBox.style.display = "none";

  toggleModal("modal-employee-form", true);
}

const EMPLOYEE_DEFAULT_PASSWORD = "123456";

// Podstawa loginu: pierwsza litera imienia + dwie pierwsze litery nazwiska, małymi literami
// i bez polskich znaków (np. Łukasz Żak -> "lza")
function employeeLoginBase(firstName, lastName) {
  const plain = s => String(s || "")
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[^a-z0-9]/g, "");
  return plain(firstName).slice(0, 1) + plain(lastName).slice(0, 2);
}

// Loginy zaczynające się od podanego tekstu, zajęte przez innych pracowników
async function fetchTakenEmployeeLogins(prefix, excludeId) {
  let query = supabaseClient.from("employees").select("id, login").ilike("login", `${prefix}%`);
  if (excludeId) query = query.neq("id", excludeId);
  const { data, error } = await query;
  if (error) throw error;
  return new Set((data || []).map(r => String(r.login || "").toLowerCase()));
}

// Zajęty login dostaje kolejny numer: "lza2", "lza3"...
async function generateEmployeeLogin(firstName, lastName) {
  const base = employeeLoginBase(firstName, lastName);
  if (!base) throw new Error("Nie można utworzyć loginu z podanego imienia i nazwiska.");

  const taken = await fetchTakenEmployeeLogins(base, null);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

// Nowy pracownik: login podąża za wpisywanym imieniem i nazwiskiem,
// dopóki ktoś nie zmieni go ręcznie
function syncEmployeeLogin() {
  const form = document.getElementById("employee-form");
  const loginEl = document.getElementById("form-emp-login");
  if (!form || !loginEl || form.dataset.loginAuto !== "1") return;
  loginEl.value = employeeLoginBase(
    document.getElementById("form-emp-first-name").value,
    document.getElementById("form-emp-last-name").value
  );
}

function employeeLoginEdited() {
  const form = document.getElementById("employee-form");
  if (form) form.dataset.loginAuto = "0";
  const hint = document.getElementById("form-emp-login-hint");
  if (hint) hint.textContent = "";
}

async function handleSaveEmployee(e) {
  e.preventDefault();

  const form = document.getElementById("employee-form");
  const msgBox = document.getElementById("employee-form-msg");
  const saveBtn = document.getElementById("btn-save-employee");
  const showError = (text) => {
    if (!msgBox) return;
    msgBox.innerText = text;
    msgBox.style.color = "var(--danger, #D9383A)";
    msgBox.style.display = "block";
  };

  const mode = document.getElementById("employee-form-mode").value;
  const empId = document.getElementById("employee-form-id").value;

  const first_name = document.getElementById("form-emp-first-name").value.trim();
  const last_name = document.getElementById("form-emp-last-name").value.trim();
  const phone_number = document.getElementById("form-emp-phone").value.trim() || null;
  const business_id = parseInt(document.getElementById("form-emp-business-id").value, 10);
  const department_id = parseInt(document.getElementById("form-emp-dept-id").value, 10);
  let login = document.getElementById("form-emp-login").value.trim().toLowerCase();
  // hasło wpisuje się tylko przy dodawaniu; przy edycji jest przycisk "Resetuj hasło"
  const password = mode === "create" ? document.getElementById("form-emp-password").value : "";

  const payload = {
    first_name,
    last_name,
    phone_number,
    business_id,
    department_id,
    active: true
  };

  // Hasło trzyma Supabase Auth; ustawia je funkcja bazy app_set_password
  const setAccountPassword = async (id, pass) => {
    const { error } = await supabaseClient.rpc("app_set_password", {
      p_kind: "employee",
      p_id: id,
      p_password: pass
    });
    return error;
  };

  if (msgBox) msgBox.style.display = "none";

  try {
    saveBtn.disabled = true;
    saveBtn.innerText = "Zapisywanie...";

    if (password && password.length < 6) {
      showError("Hasło musi mieć co najmniej 6 znaków.");
      return;
    }

    if (mode === "create") {
      if (!password) {
        showError("Podaj hasło pracownika.");
        return;
      }
      if (!login || form?.dataset.loginAuto === "1") {
        // login wygenerowany automatycznie: przy zajętym dostaje kolejny numer
        login = await generateEmployeeLogin(first_name, last_name);
      } else if ((await fetchTakenEmployeeLogins(login, null)).has(login)) {
        showError(`Login „${login}” jest już zajęty. Wpisz inny.`);
        return;
      }

      const { data: inserted, error } = await supabaseClient
        .from("employees")
        .insert([{ ...payload, login }])
        .select("id");

      if (error) throw error;
      if (!inserted || !inserted[0]) throw new Error("Pracownik nie został dodany (brak uprawnień w bazie).");

      // konto logowania z hasłem startowym; pracownik zmienia je przy pierwszym logowaniu
      const accountError = await setAccountPassword(inserted[0].id, password);
      if (accountError) {
        await loadEmployeesList();
        applyEmployeeFilters();
        throw new Error("Pracownik został dodany, ale nie udało się utworzyć konta logowania: " +
          accountError.message + " Otwórz jego edycję i ustaw hasło ponownie.");
      }
    } else {
      const before = cachedEmployees.find(emp => String(emp.id) === String(empId));

      if (login && (await fetchTakenEmployeeLogins(login, empId)).has(login)) {
        showError(`Login „${login}” jest już zajęty przez innego pracownika.`);
        return;
      }
      const { data: updated, error } = await supabaseClient
        .from("employees")
        .update({ ...payload, login: login || null })
        .eq("id", empId)
        .select("id");

      if (error) throw error;
      if (!updated || !updated[0]) throw new Error("Zmiany nie zostały zapisane (brak uprawnień w bazie).");

      // pracownik dostał login, a nie ma jeszcze konta: konto z hasłem startowym (zmiana przy logowaniu)
      if (login && before && !before.auth_id) {
        const accountError = await setAccountPassword(empId, EMPLOYEE_DEFAULT_PASSWORD);
        if (accountError) throw new Error("Dane zapisane, ale nie udało się utworzyć konta logowania: " + accountError.message);
      }
    }

    logAction(mode === "create" ? "Dodanie pracownika" : "Edycja pracownika",
      `${first_name} ${last_name}${login ? ` (login: ${login})` : ""}`);
    toggleModal("modal-employee-form", false);
    await loadEmployeesList();
    applyEmployeeFilters();

  } catch (err) {
    console.error("Błąd zapisu pracownika:", err);
    showError("Wystąpił błąd podczas zapisu: " + (err.message || err));
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerText = "Zapisz";
  }
}
