// ==========================================
// PORTAL PRACOWNIKA
// Zakładka "Pracownik" na ekranie logowania i strona z godzinami pracownika
// w wybranym miesiącu (tylko podgląd, bez menu).
// Logowanie: Supabase Auth (konto powiązane z wierszem employees przez auth_id).
// Baza sama pilnuje, że pracownik widzi tylko swoje godziny.
// Wymaga: supabaseClient, loginMode, showLoginError, clearLoginError, registerFailedLogin,
//         loginLockTimer, authEmail, isAuthNetworkError, setAuthRemember, authSignOut,
//         writeSession, clearSession (app.js), openForcePassword (password.js), rtEsc (report_time.js),
//         rpFetchAll / RP_MONTHS / RP_YEARS_BACK (reports.js), ehBuild (employee_hours.js),
//         opIsLocked / opPeriodKey / opMonthLabel (options.js)
// ==========================================

const EP_SELECT = `
  id, auth_id, first_name, last_name, login, active, must_change_password,
  business:business_id ( business ),
  department:department_id ( department )
`;

let epEmployee = null;
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

// Profil aktywnego pracownika powiązany z kontem Auth (null = brak albo nieaktywny)
async function epFetchProfile(authId) {
  const { data, error } = await supabaseClient
    .from("employees")
    .select(EP_SELECT)
    .eq("auth_id", authId)
    .eq("active", true)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ---------- Logowanie ----------
async function epLogin() {
  if (loginLockTimer) return;
  clearLoginError();

  // loginy pracowników są zapisywane małymi literami
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

    // "Zapamiętaj mnie" decyduje, gdzie Supabase zapisze sesję - trzeba ustawić przed logowaniem
    setAuthRemember(!!document.getElementById("login-remember")?.checked);

    const { data: auth, error: authError } = await supabaseClient.auth.signInWithPassword({
      email: authEmail("employee", login),
      password
    });

    if (authError) {
      if (isAuthNetworkError(authError)) {
        console.error("Błąd logowania pracownika:", authError);
        showLoginError("Brak połączenia z serwerem. Sprawdź internet.", false);
      } else {
        registerFailedLogin();
      }
      return;
    }

    let emp;
    try {
      emp = await epFetchProfile(auth.user.id);
    } catch (err) {
      console.error("Błąd pobierania profilu pracownika:", err);
      await authSignOut();
      showLoginError("Błąd bazy danych. Spróbuj ponownie.", false);
      return;
    }
    if (!emp) {
      // konto istnieje, ale pracownik jest nieaktywny albo usunięty
      await authSignOut();
      registerFailedLogin();
      return;
    }

    loginFailedAttempts = 0;

    // Pierwsze logowanie albo hasło zmienione w kartotece: najpierw własne hasło
    if (emp.must_change_password) {
      openForcePassword({
        current: password,
        onDone: () => {
          emp.must_change_password = false;
          epCompleteLogin(emp);
        },
        onCancel: authSignOut
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
  logAction("Logowanie");
  clearSession();
  writeSession(null);
  epOpen();
}

// Przywrócenie portalu po odświeżeniu strony (wołane z restoreSession w app.js).
// Zwraca true, gdy konto należy do aktywnego pracownika i portal został otwarty.
async function epRestore(authId) {
  const emp = await epFetchProfile(authId);
  if (!emp || emp.must_change_password) return false; // hasło tymczasowe: trzeba zalogować się ponownie
  epEmployee = emp;
  writeSession(null);
  epOpen();
  return true;
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

  epLoadSchedule();
  epLoad();
}

// Kafelki z godzinami pracy z harmonogramu: bieżący i przyszły tydzień
async function epLoadSchedule() {
  const el = document.getElementById("ep-schedule");
  if (!el || !epEmployee) return;
  const empId = epEmployee.id;

  const current = shCurrentWeek();
  const next = shShiftWeek(current.year, current.week, 1);
  const weeks = [
    { ...current, title: "Ten tydzień", cls: "now" },
    { ...next, title: "Przyszły tydzień", cls: "next" }
  ];

  const render = (values, failed) => {
    el.innerHTML = weeks.map(w => {
      const text = shDisplay(values[shWeekColumn(w.week)]);
      const value = failed ? "Nie udało się pobrać" : (text || "Nie ustalono");
      return `
        <div class="ep-shift ${w.cls} ${text && !failed ? "" : "empty"}">
          <span class="ico"><i class="fa-solid ${w.cls === "now" ? "fa-business-time" : "fa-calendar-plus"}"></i></span>
          <div>
            <div class="lbl">${w.title} • tydzień ${w.week} (${shWeekLabel(w.year, w.week)})</div>
            <div class="val">${rtEsc(value)}</div>
          </div>
        </div>`;
    }).join("");
  };

  const { data, error } = await supabaseClient
    .from("employees")
    .select(weeks.map(w => shWeekColumn(w.week)).join(", "))
    .eq("id", empId)
    .maybeSingle();
  if (!epEmployee || epEmployee.id !== empId) return; // w międzyczasie wylogowano

  if (error) console.error("Błąd pobierania harmonogramu pracownika:", error);
  render(data || {}, !!error);
}

function epLogout() {
  // log musi wyjść, zanim sesja zostanie zamknięta
  (epEmployee ? logAction("Wylogowanie") : Promise.resolve()).finally(authSignOut);
  epEmployee = null;
  epLoadToken++;
  clearSession();

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

async function epLoad(userAction) {
  const body = document.getElementById("ep-body");
  if (!body || !epEmployee) return;

  const year = document.getElementById("ep-year").value;
  const month = document.getElementById("ep-month").value;
  const key = opPeriodKey(year, month);
  const token = ++epLoadToken;
  writeSession(null); // aktywność odświeża czas sesji
  // zmiana miesiąca przez pracownika to jego jedyny "ruch" na stronie poza logowaniem
  if (userAction === true) logAction("Podgląd godzin", opMonthLabel(key));

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
