// ==========================================
// PORTAL PRACOWNIKA
// Zakładka "Pracownik" na ekranie logowania i strona z godzinami pracownika
// w wybranym miesiącu (tylko podgląd, bez menu).
// Logowanie: tabela employees (login, password, active).
// Wymaga: supabaseClient, loginMode, showLoginError, clearLoginError, registerFailedLogin,
//         loginLockTimer, readStoredSession, SESSION_IDLE_LIMIT (app.js), rtEsc (report_time.js),
//         rpFetchAll / RP_MONTHS / RP_YEARS_BACK (reports.js), ehBuild (employee_hours.js),
//         opIsLocked / opPeriodKey / opMonthLabel (options.js)
// ==========================================

const EP_SESSION_KEY = "opsaEmpSession";
const EP_SELECT = `
  id, first_name, last_name, login, password, active,
  business:business_id ( business ),
  department:department_id ( department )
`;

let epEmployee = null;
let epStore = null;          // localStorage / sessionStorage bieżącej sesji pracownika
let epLoadToken = 0;

// ---------- Zakładki na ekranie logowania ----------
function setLoginMode(mode) {
  loginMode = mode === "employee" ? "employee" : "user";
  document.getElementById("login-tab-user")?.classList.toggle("on", loginMode === "user");
  document.getElementById("login-tab-employee")?.classList.toggle("on", loginMode === "employee");
  document.getElementById("login-tab-user")?.setAttribute("aria-selected", String(loginMode === "user"));
  document.getElementById("login-tab-employee")?.setAttribute("aria-selected", String(loginMode === "employee"));

  const subtitle = document.querySelector("#step-login .subtitle");
  if (subtitle) {
    subtitle.textContent = loginMode === "employee"
      ? "Podgląd godzin pracownika"
      : "System Ewidencji Czasu Pracy";
  }
  if (!loginLockTimer) clearLoginError();
  document.getElementById("login-input")?.focus();
}

// ---------- Sesja pracownika ----------
function epReadSession() {
  for (const store of [window.sessionStorage, window.localStorage]) {
    try {
      const data = JSON.parse(store.getItem(EP_SESSION_KEY) || "null");
      if (data && data.id != null) return { store, data };
    } catch (e) { /* brak dostępu do magazynu - ignoruj */ }
  }
  return null;
}

function epWriteSession() {
  if (!epStore || !epEmployee) return;
  try {
    epStore.setItem(EP_SESSION_KEY, JSON.stringify({ id: epEmployee.id, ts: Date.now() }));
  } catch (e) { /* sesja po prostu nie zostanie zapamiętana */ }
}

function epClearSession() {
  epStore = null;
  for (const name of ["sessionStorage", "localStorage"]) {
    try { window[name].removeItem(EP_SESSION_KEY); } catch (e) { /* ignoruj */ }
  }
}

// ---------- Logowanie ----------
async function epLogin() {
  if (loginLockTimer) return;
  clearLoginError();

  const login = document.getElementById("login-input").value.trim().toLowerCase();
  const password = document.getElementById("password-input").value;
  const btn = document.getElementById("btn-login");

  if (!login || !password) {
    showLoginError("Wpisz login i hasło.");
    return;
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.innerText = "Logowanie...";
    }

    const { data, error } = await supabaseClient
      .from("employees")
      .select(EP_SELECT)
      .eq("login", login)
      .eq("active", true);

    if (error) {
      console.error("Błąd logowania pracownika:", error);
      const offline = !navigator.onLine || /fetch|network/i.test(error.message || "");
      showLoginError(offline
        ? "Brak połączenia z serwerem. Sprawdź internet."
        : "Błąd bazy danych. Spróbuj ponownie.", false);
      return;
    }

    const emp = (data || []).find(e => e.password && e.password === password);
    if (!emp) {
      registerFailedLogin();
      return;
    }

    loginFailedAttempts = 0;

    // Pierwsze logowanie albo hasło zmienione w kartotece: najpierw własne hasło
    if (await passwordChangeRequired("employees", emp.id)) {
      openForcePassword({
        table: "employees",
        id: emp.id,
        current: password,
        onDone: (newPassword) => {
          emp.password = newPassword;
          epCompleteLogin(emp);
        }
      });
      return;
    }

    epCompleteLogin(emp);
  } catch (err) {
    console.error("Niespodziewany błąd logowania pracownika:", err);
    showLoginError("Brak połączenia z serwerem. Sprawdź internet.", false);
  } finally {
    if (btn && !loginLockTimer) {
      btn.disabled = false;
      btn.innerText = "Zaloguj się";
    }
  }
}

function epCompleteLogin(emp) {
  epEmployee = emp;
  try {
    epStore = document.getElementById("login-remember")?.checked ? window.localStorage : window.sessionStorage;
  } catch (e) {
    epStore = null;
  }
  epWriteSession();
  epOpen();
}

// ---------- Strona pracownika ----------
function epOpen() {
  const emp = epEmployee;
  if (!emp) return;

  const fullName = `${emp.first_name || ""} ${emp.last_name || ""}`.trim() || emp.login;
  document.getElementById("ep-name").textContent = fullName;
  document.getElementById("ep-sub").textContent =
    `${emp.business?.business || "Brak firmy"} • ${emp.department?.department || "Brak działu"}`;

  // Zawsze start od bieżącego miesiąca
  const now = new Date();
  const y = now.getFullYear();
  const current = String(now.getMonth() + 1).padStart(2, "0");
  document.getElementById("ep-year").innerHTML = Array.from({ length: RP_YEARS_BACK + 1 }, (_, i) =>
    `<option value="${y - i}">${y - i}</option>`).join("");
  document.getElementById("ep-month").innerHTML = RP_MONTHS.map((name, i) => {
    const v = String(i + 1).padStart(2, "0");
    return `<option value="${v}"${v === current ? " selected" : ""}>${name}</option>`;
  }).join("");

  document.getElementById("password-input").value = "";
  document.getElementById("employee-portal").style.display = "block";
  const overlay = document.getElementById("auth-overlay");
  if (overlay) overlay.style.display = "none";

  epLoad();
}

function epLogout() {
  epEmployee = null;
  epLoadToken++;
  epClearSession();

  document.getElementById("employee-portal").style.display = "none";
  const overlay = document.getElementById("auth-overlay");
  if (overlay) {
    overlay.style.display = "flex";
    overlay.style.opacity = "1";
  }
  document.getElementById("login-input").value = "";
  document.getElementById("password-input").value = "";
  clearLoginError();
}

function epRenderLock(state, key) {
  const el = document.getElementById("ep-lock");
  if (!el) return;
  const month = opMonthLabel(key);
  const view = {
    locked: ["fa-lock", `Miesiąc zamknięty`, `Godziny za ${month} są zatwierdzone i nie będą już zmieniane.`],
    open: ["fa-lock-open", `Miesiąc otwarty`, `Godziny za ${month} mogą się jeszcze zmienić, dopóki miesiąc nie zostanie zamknięty.`],
    unknown: ["fa-circle-question", `Nie udało się sprawdzić`, `Nie wiadomo, czy ${month} jest zamknięty. Spróbuj ponownie później.`]
  }[state];

  el.className = `ep-lock ${state}`;
  el.innerHTML = `
    <span class="ico"><i class="fa-solid ${view[0]}"></i></span>
    <div><strong>${view[1]}</strong><span class="txt">${rtEsc(view[2])}</span></div>`;
}

async function epLoad() {
  const body = document.getElementById("ep-body");
  if (!body || !epEmployee) return;

  const year = document.getElementById("ep-year").value;
  const month = document.getElementById("ep-month").value;
  const key = opPeriodKey(year, month);
  const token = ++epLoadToken;
  epWriteSession(); // aktywność odświeża czas sesji

  body.innerHTML = `<tr><td colspan="7" class="ep-empty"><i class="fa-solid fa-spinner fa-spin"></i> Ładowanie godzin...</td></tr>`;
  document.getElementById("ep-mobile-empty").style.display = "none";

  // Blokada miesiąca i godziny pobierane równolegle; błąd blokady nie ukrywa godzin
  const lockPromise = opIsLocked(key).then(l => (l ? "locked" : "open")).catch(err => {
    console.error("Błąd sprawdzania blokady miesiąca:", err);
    return "unknown";
  });

  try {
    const [lockState, rows] = await Promise.all([
      lockPromise,
      rpFetchAll(() => supabaseClient
        .from("work_reports")
        .select("id, report_date, shift, start_time, end_time, total_hours, at_work, number_report")
        .eq("first_name_id", epEmployee.id)
        .like("report_date", `%.${month}.${year}`))
    ]);
    if (token !== epLoadToken) return; // zmieniono miesiąc albo wylogowano

    epRenderLock(lockState, key);
    const built = ehBuild(rows, Number(year), Number(month));
    document.getElementById("ep-tiles").innerHTML = built.tilesHtml;
    body.innerHTML = built.bodyHtml;
    // na telefonie dni bez wpisu są ukryte - przy pustym miesiącu pokaż informację
    document.getElementById("ep-mobile-empty").style.display = rows.length === 0 ? "" : "none";
  } catch (err) {
    if (token !== epLoadToken) return;
    console.error("Błąd pobierania godzin pracownika:", err);
    document.getElementById("ep-tiles").innerHTML = "";
    body.innerHTML = `<tr><td colspan="7" class="ep-empty" style="color: var(--danger);">
      Nie udało się pobrać godzin: ${rtEsc(err.message || err)}</td></tr>`;
  }
}

// ---------- Przywrócenie sesji pracownika po odświeżeniu strony ----------
async function epRestoreSession() {
  const stored = epReadSession();
  const overlay = document.getElementById("auth-overlay");
  if (!stored) return;

  // sesja użytkownika systemu ma pierwszeństwo
  if (readStoredSession()) return;

  if (Date.now() - (stored.data.ts || 0) > SESSION_IDLE_LIMIT) {
    epClearSession();
    overlay?.classList.remove("session-check");
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from("employees")
      .select(EP_SELECT)
      .eq("id", stored.data.id)
      .eq("active", true)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      epClearSession(); // konto usunięte albo nieaktywne
      return;
    }
    if (await passwordChangeRequired("employees", data.id)) {
      epClearSession(); // hasło zmienione w kartotece: trzeba zalogować się nim i ustawić własne
      return;
    }

    epEmployee = data;
    epStore = stored.store;
    epWriteSession();
    epOpen();
  } catch (err) {
    console.error("Nie udało się przywrócić sesji pracownika:", err);
  } finally {
    overlay?.classList.remove("session-check");
  }
}

if (epReadSession() && !readStoredSession()) {
  document.getElementById("auth-overlay")?.classList.add("session-check");
}
document.addEventListener("DOMContentLoaded", epRestoreSession);
