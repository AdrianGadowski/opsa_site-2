// ==========================================
// 1. INICJALIZACJA SUPABASE (Baza: opsa)
// ==========================================
const SUPABASE_URL = "https://vrfyniyvawyungkslwod.supabase.co"; 
const SUPABASE_ANON_KEY = "sb_publishable_64Xg3rGa9kuBZo5KjGgCrg_X8felZMu";  

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Numer wydania doklejany do adresów plików, żeby przeglądarka nie używała starych kopii.
// Zmieniaj przy każdej publikacji - tutaj i w index.html (?v=...).
const APP_BUILD = "20261013";

let currentUser = null;
let cachedUsers = [];
let userToDeleteLogin = null;
let deleteCountdownTimer = null;

const viewTitles = {
  dashboard: "Dashboard",
  employee_list: "Baza pracowników",
  report_time: "Rozliczanie czasu pracy",
  reports: "Lista raportów",
  users: "Zarządzanie użytkownikami",
  updates: "Aktualizacje systemu"
};

const permissionMap = {
  dashboard: { elementId: "nav-dashboard", column: "allow_dashboard" },
  employee_list: { elementId: "nav-employee_list", column: "allow_employees" },
  report_time: { elementId: "nav-report_time", column: "allow_time_reporting" },
  reports: { elementId: "nav-reports", column: "allow_reports" },
  users: { elementId: "nav-users", column: "allow_users" },
  updates: { elementId: "nav-updates", column: "allow_updates" }
};

function hasPermission(columnName) {
  if (!currentUser) return false;
  return currentUser[columnName] === true || currentUser[columnName] === 1;
}

// Aktualna wersja systemu w prawym górnym rogu (tabela Check_version, wiersz "aktualna_wersja")
function setTopbarVersion(version) {
  const el = document.getElementById("topbar-version");
  if (el) el.innerText = `Wersja: ${version || "—"}`;
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

// Raport może zmieniać tylko jego autor albo administrator
function canModifyReport(creatorId) {
  if (!currentUser) return false;
  if (String(currentUser.role?.role || "").toLowerCase() === "administrator") return true;
  return currentUser.id != null && creatorId != null && Number(currentUser.id) === Number(creatorId);
}

// ==========================================
// OBSŁUGA BŁĘDÓW LOGOWANIA (BEZ ROZPYCHANIA KARTY)
// ==========================================
function showLoginError(message = "zły login lub hasło") {
  const loginInput = document.getElementById("login-input");
  const passwordInput = document.getElementById("password-input");
  const errorMsg = document.getElementById("login-error-msg");

  if (loginInput) loginInput.classList.add("input-error");
  if (passwordInput) passwordInput.classList.add("input-error");

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

// ==========================================
// 2. LOGOWANIE I PŁYNNA TRANSFORMACJA IKON
// ==========================================
async function handleLogin() {
  clearLoginError();

  const loginInput = document.getElementById("login-input").value.trim();
  const passwordInput = document.getElementById("password-input").value;
  const loginBtn = document.getElementById("btn-login");

  if (!loginInput || !passwordInput) {
    showLoginError("zły login lub hasło");
    return;
  }

  try {
    if (loginBtn) {
      loginBtn.disabled = true;
      loginBtn.innerText = "Logowanie...";
    }

    const { data: user, error } = await supabaseClient
      .from("users")
      .select(`
        id,
        login,
        password,
        name, 
        last_name, 
        role_id,
        role:role_id ( role ),
        department_id,
        department:department_id ( department ),
        allow_dashboard,
        allow_employees,
        allow_time_reporting,
        allow_reports,
        allow_users,
        allow_updates
      `)
      .eq("login", loginInput)
      .maybeSingle();

    if (error) {
      console.error("Błąd zapytania Supabase:", error);
      showLoginError("Błąd połączenia z bazą danych.");
      return;
    }

    if (!user || user.password !== passwordInput) {
      showLoginError("zły login lub hasło");
      return;
    }

    currentUser = user;
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

  } catch (err) {
    console.error("Niespodziewany błąd:", err);
    showLoginError("Wystąpił błąd logowania.");
  } finally {
    if (loginBtn) {
      loginBtn.disabled = false;
      loginBtn.innerText = "Zaloguj się";
    }
  }
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
function initDashboardApp() {
  document.getElementById("app-container").style.display = "flex";
  
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

  let firstAvailableView = null;

  Object.keys(permissionMap).forEach((viewKey) => {
    const config = permissionMap[viewKey];
    const isAllowed = hasPermission(config.column);
    const navElement = document.getElementById(config.elementId);

    if (navElement) navElement.style.display = isAllowed ? "block" : "none";

    if (isAllowed && !firstAvailableView) {
      firstAvailableView = viewKey;
    }
  });

  if (hasPermission("allow_dashboard")) {
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

  const permissionInfo = permissionMap[viewName];
  if (permissionInfo && !hasPermission(permissionInfo.column)) {
    alert("Brak uprawnień do tego modułu.");
    return;
  }

  document.querySelectorAll(".menu-item").forEach(item => item.classList.remove("active"));
  const activeNav = document.querySelector(`.menu-item[data-tab="${viewName}"]`);
  if (activeNav) activeNav.classList.add("active");

  topbarTitle.innerText = viewTitles[viewName] || "Moduł";

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
    contentEl.innerHTML = `
      <div class="card" style="border-left: 4px solid var(--danger);">
        <h3 style="color: var(--danger);">Błąd wczytywania modułu</h3>
        <p>${err.message}</p>
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
    case 'report_time':
      await initReportTimeView();
      break;
    case 'reports':
      await initReportsView();
      break;
    case 'updates':
      await initUpdatesView();
      break;
  }
}

function toggleModal(modalId, show) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.toggle("active", show);
}

function handleForgotPassword() {
  const email = document.getElementById("forgot-email").value.trim();
  const login = document.getElementById("forgot-login").value.trim();

  if (!login || !email) {
    alert("Wprowadź login i adres e-mail.");
    return;
  }
  alert("Jeśli dane są poprawne, hasło zostanie wysłane na podany adres e-mail.");
  toggleModal("modal-forgot-password", false);
}

// ==========================================
// 5. WYLOGOWANIE
// ==========================================
function handleLogout() {
  currentUser = null;
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
      roles.map(r => `<option value="${r.id}">${r.role}</option>`).join("");

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

  const passHint = document.getElementById("password-hint");
  if (passHint) passHint.style.display = "none";

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

  const passField = document.getElementById("form-user-password");
  passField.required = false;
  passField.value = "";
  passField.placeholder = "Wpisz, aby zmienić hasło";

  const passHint = document.getElementById("password-hint");
  if (passHint) passHint.style.display = "block";

  await loadRoleAndDepartmentDropdowns(user.role_id, user.department_id);

  document.getElementById("perm-dashboard").checked = !!(user.allow_dashboard);
  document.getElementById("perm-employees").checked = !!(user.allow_employees);
  document.getElementById("perm-time-reporting").checked = !!(user.allow_time_reporting);
  document.getElementById("perm-reports").checked = !!(user.allow_reports);
  document.getElementById("perm-users").checked = !!(user.allow_users);
  document.getElementById("perm-updates").checked = !!(user.allow_updates);

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
    const { data: users, error } = await supabaseClient
      .from("users")
      .select(`
        login,
        name,
        last_name,
        role_id,
        role:role_id ( role ),
        department_id,
        department:department_id ( department ),
        allow_dashboard,
        allow_employees,
        allow_time_reporting,
        allow_reports,
        allow_users,
        allow_updates
      `)
      .order("name", { ascending: true });

    if (error) {
      console.error("Błąd pobierania użytkowników:", error);
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; color: var(--danger); padding: 20px;">
            Wystąpił błąd podczas pobierania użytkowników: ${error.message}
          </td>
        </tr>
      `;
      return;
    }

    cachedUsers = users || [];

    if (!users || users.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 25px;">
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
        { label: "Raporty", active: u.allow_reports },
        { label: "Użytkownicy", active: u.allow_users },
        { label: "Aktualizacje", active: u.allow_updates }
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
          <td style="padding: 12px 16px; color: var(--text-muted);">${u.name || '-'}</td>
          <td style="padding: 12px 16px; color: var(--text-muted);">${u.last_name || '-'}</td>
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
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--danger); padding: 20px;">Błąd wczytywania danych.</td></tr>`;
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
    allow_reports: document.getElementById("perm-reports") ? document.getElementById("perm-reports").checked : false,
    allow_users: document.getElementById("perm-users") ? document.getElementById("perm-users").checked : false,
    allow_updates: document.getElementById("perm-updates") ? document.getElementById("perm-updates").checked : false
  };

  try {
    saveBtn.disabled = true;
    saveBtn.innerText = "Zapisywanie...";

    if (mode === "create") {
      userPayload.login = login;
      userPayload.password = password;

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

      const { error: insertError } = await supabaseClient
        .from("users")
        .insert([userPayload]);

      if (insertError) throw insertError;

    } else if (mode === "edit") {
      if (password && password.trim() !== "") {
        userPayload.password = password;
      }

      const { error: updateError } = await supabaseClient
        .from("users")
        .update(userPayload)
        .eq("login", originalLogin);

      if (updateError) throw updateError;
    }

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
        business_id,
        department_id,
        active,
        business:business_id ( business ),
        department:department_id ( department )
      `)
      .eq("active", true)
      .order("last_name", { ascending: true });

    if (error) {
      console.error("Błąd pobierania bazy pracowników:", error);
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: var(--danger); padding: 25px;">
            Wystąpił błąd podczas pobierania pracowników: ${error.message}
          </td>
        </tr>
      `;
      return;
    }

    cachedEmployees = employees || [];
    renderEmployeesTable(cachedEmployees);

  } catch (err) {
    console.error("Niespodziewany błąd pobierania pracowników:", err);
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--danger); padding: 20px;">Błąd pobierania danych.</td></tr>`;
  }
}

function renderEmployeesTable(list) {
  const tbody = document.getElementById("employees-table-body");
  if (!tbody) return;

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px;">
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
        <td style="padding: 14px 18px; text-align: center; white-space: nowrap;">
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

  await populateEmployeeModalDropdowns(emp.business_id, emp.department_id);

  const msgBox = document.getElementById("employee-form-msg");
  if (msgBox) msgBox.style.display = "none";

  toggleModal("modal-employee-form", true);
}

async function handleSaveEmployee(e) {
  e.preventDefault();

  const msgBox = document.getElementById("employee-form-msg");
  const saveBtn = document.getElementById("btn-save-employee");

  const mode = document.getElementById("employee-form-mode").value;
  const empId = document.getElementById("employee-form-id").value;

  const first_name = document.getElementById("form-emp-first-name").value.trim();
  const last_name = document.getElementById("form-emp-last-name").value.trim();
  const phone_number = document.getElementById("form-emp-phone").value.trim() || null;
  const business_id = parseInt(document.getElementById("form-emp-business-id").value, 10);
  const department_id = parseInt(document.getElementById("form-emp-dept-id").value, 10);

  const payload = {
    first_name,
    last_name,
    phone_number,
    business_id,
    department_id,
    active: true
  };

  try {
    saveBtn.disabled = true;
    saveBtn.innerText = "Zapisywanie...";

    if (mode === "create") {
      const { error } = await supabaseClient
        .from("employees")
        .insert([payload]);

      if (error) throw error;
    } else {
      const { error } = await supabaseClient
        .from("employees")
        .update(payload)
        .eq("id", empId);

      if (error) throw error;
    }

    toggleModal("modal-employee-form", false);
    await loadEmployeesList();
    applyEmployeeFilters();

  } catch (err) {
    console.error("Błąd zapisu pracownika:", err);
    if (msgBox) {
      msgBox.innerText = "Wystąpił błąd podczas zapisu: " + (err.message || err);
      msgBox.style.color = "var(--danger, #D9383A)";
      msgBox.style.display = "block";
    }
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerText = "Zapisz";
  }
}