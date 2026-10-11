// ==========================================
// MODUŁ: MOJE KONTO (user)
// Podgląd własnych danych i uprawnień, zmiana hasła (tabela users).
// Wymaga: supabaseClient, currentUser, hasPermission (app.js), rtEsc (report_time.js)
// ==========================================

const US_MIN_PASSWORD = 6;
const US_MODULES = [
  { column: "allow_dashboard", label: "Dashboard", icon: "fa-chart-pie" },
  { column: "allow_employees", label: "Baza pracowników", icon: "fa-users" },
  { column: "allow_time_reporting", label: "Rozliczanie czasu", icon: "fa-clock" },
  { column: "allow_reports", label: "Lista raportów", icon: "fa-file-lines" },
  { column: "allow_users", label: "Użytkownicy", icon: "fa-user-gear" },
  { column: "allow_updates", label: "Aktualizacje", icon: "fa-rotate" },
  { column: "allow_options", label: "Opcje", icon: "fa-sliders" }
];

let usSaving = false;

function initUserView() {
  if (!currentUser) return;

  const first = (currentUser.name || "").trim();
  const last = (currentUser.last_name || "").trim();
  const fullName = `${first} ${last}`.trim() || currentUser.login || "—";
  const role = currentUser.role?.role || "Brak roli";
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value || "—";
  };

  set("us-avatar", ((first[0] || "") + (last[0] || "")).toUpperCase() || "?");
  set("us-fullname", fullName);
  set("us-role-chip", role);
  set("us-name", first);
  set("us-lastname", last);
  set("us-login", currentUser.login);
  set("us-role", role);
  set("us-dept", currentUser.department?.department || "Brak działu");

  const perms = document.getElementById("us-perms");
  if (perms) {
    perms.innerHTML = US_MODULES.map(m => {
      const on = hasPermission(m.column);
      return `
        <div class="us-perm ${on ? "on" : ""}">
          <span class="ico"><i class="fa-solid ${m.icon}"></i></span>
          <div>
            <div class="lbl">${rtEsc(m.label)}</div>
            <div class="st"><i class="fa-solid ${on ? "fa-circle-check" : "fa-lock"}"></i> ${on ? "Masz dostęp" : "Brak dostępu"}</div>
          </div>
        </div>`;
    }).join("");
  }
}

function usTogglePass(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  btn.setAttribute("aria-label", show ? "Ukryj hasło" : "Pokaż hasło");
  btn.innerHTML = `<i class="fa-solid ${show ? "fa-eye-slash" : "fa-eye"}"></i>`;
}

function usShowMsg(type, text) {
  const el = document.getElementById("us-msg");
  if (!el) return;
  const icon = type === "success" ? "fa-circle-check" : "fa-triangle-exclamation";
  el.className = `us-msg visible ${type}`;
  el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${rtEsc(text)}</span>`;
}

async function usChangePassword() {
  if (usSaving || !currentUser) return;

  const currentEl = document.getElementById("us-pass-current");
  const newEl = document.getElementById("us-pass-new");
  const repeatEl = document.getElementById("us-pass-repeat");
  const current = currentEl.value;
  const next = newEl.value;
  const repeat = repeatEl.value;

  if (!current || !next || !repeat) {
    usShowMsg("error", "Uzupełnij wszystkie trzy pola.");
    return;
  }
  if (next.length < US_MIN_PASSWORD) {
    usShowMsg("error", `Nowe hasło musi mieć co najmniej ${US_MIN_PASSWORD} znaków.`);
    return;
  }
  if (next !== repeat) {
    usShowMsg("error", "Nowe hasło i jego powtórzenie różnią się.");
    return;
  }
  if (next === current) {
    usShowMsg("error", "Nowe hasło musi być inne niż obecne.");
    return;
  }
  if (currentUser.id === undefined || currentUser.id === null) {
    usShowMsg("error", "Brak identyfikatora konta. Wyloguj się i zaloguj ponownie.");
    return;
  }

  const btn = document.getElementById("us-pass-save");
  usSaving = true;
  if (btn) btn.disabled = true;

  try {
    // Baza sprawdza obecne hasło, zapisuje nowe w Supabase Auth i zdejmuje wymóg zmiany
    await changeOwnPassword(current, next);

    currentEl.value = "";
    newEl.value = "";
    repeatEl.value = "";
    usShowMsg("success", "Hasło zostało zmienione.");
  } catch (err) {
    console.error("Błąd zmiany hasła:", err);
    usShowMsg("error", "Nie udało się zmienić hasła: " + (err.message || err));
  } finally {
    usSaving = false;
    if (btn) btn.disabled = false;
  }
}
