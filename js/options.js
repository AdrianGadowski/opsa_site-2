// ==========================================
// MODUŁ: OPCJE SYSTEMU (options)
// Kafelki z ustawieniami systemu. Blokada miesiąca: tabela Closed_Periods
// (year_month "RRRR-MM", is_locked, locked_at).
// Funkcje opIsLocked / opFetchLockedKeys / opMonthLabel są używane także
// w rozliczaniu czasu i na liście raportów.
// Wymaga: supabaseClient, toggleModal (app.js), rtEsc (report_time.js), RP_MONTHS / RP_YEARS_BACK (reports.js)
// ==========================================

const OP_PERIODS_TABLE = "Closed_Periods";

let opBannerTimer = null;
let opLockRows = {};         // { "RRRR-MM": wiersz Closed_Periods } dla wybranego roku
let opLockBusy = false;
let opLockToken = 0;

// ---------- Wspólne: blokada miesiąca ----------
function opPeriodKey(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

// "dd.mm.rrrr" -> "rrrr-mm"
function opPeriodKeyFromPl(plDate) {
  const [, m, y] = String(plDate || "").split(".");
  return `${y}-${m}`;
}

// "2026-10" -> "październik 2026"
function opMonthLabel(key) {
  const [y, m] = String(key).split("-");
  const name = RP_MONTHS[Number(m) - 1];
  return name ? `${name.toLowerCase()} ${y}` : key;
}

// Czy miesiąc ("RRRR-MM") jest zablokowany. Rzuca błąd, gdy nie da się tego sprawdzić.
async function opIsLocked(key) {
  const { data, error } = await supabaseClient
    .from(OP_PERIODS_TABLE)
    .select("year_month")
    .eq("year_month", key)
    .eq("is_locked", true)
    .limit(1);
  if (error) throw error;
  return !!(data && data.length);
}

// Wszystkie zablokowane miesiące jako zbiór kluczy "RRRR-MM"
async function opFetchLockedKeys() {
  const { data, error } = await supabaseClient
    .from(OP_PERIODS_TABLE)
    .select("year_month")
    .eq("is_locked", true);
  if (error) throw error;
  return new Set((data || []).map(r => r.year_month));
}

// ---------- Komunikat na stronie opcji ----------
function opShowBanner(text) {
  const el = document.getElementById("op-banner");
  if (!el) return;
  el.textContent = "";
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-circle-info";
  const span = document.createElement("span");
  span.textContent = text;
  el.append(icon, span);
  el.classList.add("visible");
  clearTimeout(opBannerTimer);
  opBannerTimer = setTimeout(() => el.classList.remove("visible"), 5000);
}

// Tymczasowa obsługa kafelków, które nie mają jeszcze swojej funkcji
function opComingSoon(name) {
  opShowBanner(`Opcja „${name}” nie jest jeszcze dostępna.`);
}

// ---------- Okno: blokada miesiąca ----------
function opOpenLocks() {
  const now = new Date();
  const y = now.getFullYear();
  const current = String(now.getMonth() + 1).padStart(2, "0");

  // rok następny też, żeby dało się zablokować miesiąc z wyprzedzeniem
  document.getElementById("op-lock-year").innerHTML =
    Array.from({ length: RP_YEARS_BACK + 2 }, (_, i) => y + 1 - i)
      .map(v => `<option value="${v}"${v === y ? " selected" : ""}>${v}</option>`).join("");
  document.getElementById("op-lock-month").innerHTML = RP_MONTHS.map((name, i) => {
    const v = String(i + 1).padStart(2, "0");
    return `<option value="${v}"${v === current ? " selected" : ""}>${name}</option>`;
  }).join("");

  opHideLockMsg();
  toggleModal("modal-op-locks", true);
  opLoadLocks();
}

function opCloseLocks() {
  opLockToken++;
  toggleModal("modal-op-locks", false);
}

function opShowLockMsg(text) {
  const el = document.getElementById("op-lock-msg");
  if (!el) return;
  el.textContent = text;
  el.style.display = "block";
}

function opHideLockMsg() {
  const el = document.getElementById("op-lock-msg");
  if (el) el.style.display = "none";
}

async function opLoadLocks() {
  const list = document.getElementById("op-lock-list");
  if (!list) return;
  const year = document.getElementById("op-lock-year").value;
  const token = ++opLockToken;

  const { data, error } = await supabaseClient
    .from(OP_PERIODS_TABLE)
    .select("year_month, is_locked, locked_at")
    .like("year_month", `${year}-%`);
  if (token !== opLockToken) return; // zmieniono rok albo zamknięto okno

  if (error) {
    console.error("Błąd pobierania blokad miesięcy:", error);
    opLockRows = {};
    list.innerHTML = `<div class="op-lock-empty">Nie udało się pobrać blokad: ${rtEsc(error.message)}</div>`;
    opSyncLockButton();
    return;
  }

  opLockRows = {};
  (data || []).forEach(r => { opLockRows[r.year_month] = r; });
  opRenderLocks();
}

function opLockedAtText(row) {
  if (!row || !row.is_locked) return "Odblokowany";
  if (!row.locked_at) return "Zablokowany";
  const d = new Date(row.locked_at);
  if (isNaN(d)) return "Zablokowany";
  const p = n => String(n).padStart(2, "0");
  return `Zablokowany ${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function opRenderLocks() {
  const list = document.getElementById("op-lock-list");
  if (!list) return;
  const year = document.getElementById("op-lock-year").value;
  const selected = document.getElementById("op-lock-month").value;

  list.innerHTML = RP_MONTHS.map((name, i) => {
    const month = String(i + 1).padStart(2, "0");
    const row = opLockRows[opPeriodKey(year, month)];
    const locked = !!(row && row.is_locked);

    return `
      <div class="op-lock-row ${locked ? "locked" : ""} ${month === selected ? "selected" : ""}">
        <span class="ico"><i class="fa-solid ${locked ? "fa-lock" : "fa-lock-open"}"></i></span>
        <div class="info">
          <div class="name">${name} ${rtEsc(year)}</div>
          <div class="st">${rtEsc(opLockedAtText(row))}</div>
        </div>
        <label class="op-switch">
          <input type="checkbox" ${locked ? "checked" : ""} aria-label="Blokada: ${name} ${rtEsc(year)}"
                 onchange="opToggleLock('${month}', this.checked)" />
          <span class="track"></span>
        </label>
      </div>`;
  }).join("");

  opSyncLockButton();
}

// Przycisk u góry: zablokuj / odblokuj miesiąc wybrany z listy rozwijanej
function opSyncLockButton() {
  const btn = document.getElementById("op-lock-btn");
  if (!btn) return;
  const year = document.getElementById("op-lock-year").value;
  const month = document.getElementById("op-lock-month").value;
  const row = opLockRows[opPeriodKey(year, month)];
  const locked = !!(row && row.is_locked);

  btn.className = locked ? "btn-secondary" : "btn-danger";
  btn.innerHTML = locked
    ? `<i class="fa-solid fa-lock-open" style="margin-right: 8px;"></i> Odblokuj miesiąc`
    : `<i class="fa-solid fa-lock" style="margin-right: 8px;"></i> Zablokuj miesiąc`;
  btn.disabled = opLockBusy;
}

function opOnLockMonthChange() {
  opHideLockMsg();
  opRenderLocks();
}

function opOnLockYearChange() {
  opHideLockMsg();
  opLoadLocks();
}

function opToggleSelectedLock() {
  const year = document.getElementById("op-lock-year").value;
  const month = document.getElementById("op-lock-month").value;
  const row = opLockRows[opPeriodKey(year, month)];
  opToggleLock(month, !(row && row.is_locked));
}

// Zapis blokady: aktualizacja wiersza miesiąca albo dodanie go, jeśli jeszcze nie istnieje
async function opToggleLock(month, lock) {
  if (opLockBusy) {
    opRenderLocks(); // cofnij suwak kliknięty w trakcie innego zapisu
    return;
  }
  const year = document.getElementById("op-lock-year").value;
  const key = opPeriodKey(year, month);
  const payload = { is_locked: lock, locked_at: lock ? new Date().toISOString() : null };

  opLockBusy = true;
  opSyncLockButton();
  opHideLockMsg();

  try {
    const { data, error } = await supabaseClient
      .from(OP_PERIODS_TABLE)
      .update(payload)
      .eq("year_month", key)
      .select("year_month");
    if (error) throw error;

    if (!data || data.length === 0) {
      const { data: inserted, error: insertErr } = await supabaseClient
        .from(OP_PERIODS_TABLE)
        .insert({ year_month: key, ...payload })
        .select("year_month");
      if (insertErr) throw insertErr;
      if (!inserted || inserted.length === 0) throw new Error("brak uprawnień w bazie");
    }
    logAction(lock ? "Zablokowanie miesiąca" : "Odblokowanie miesiąca", opMonthLabel(key));
  } catch (err) {
    console.error("Błąd zapisu blokady miesiąca:", err);
    opShowLockMsg(`Nie udało się ${lock ? "zablokować" : "odblokować"} miesiąca ${opMonthLabel(key)}: ${err.message || err}`);
  } finally {
    opLockBusy = false;
  }
  await opLoadLocks();
}

// ---------- Okno: słowniki (działy i firmy) ----------
// Lista istniejących pozycji i dodawanie nowej. Zapis wymaga uprawnienia "Opcje"
// (polityki w sql/06_slowniki.sql).
const OP_DICTS = {
  department: {
    table: "department", column: "department",
    title: "Działy", one: "dział", placeholder: "Nazwa nowego działu", empty: "Nie ma jeszcze żadnego działu.",
    deleteTitle: "Usuwanie działu", deleteQuestion: "Czy na pewno chcesz usunąć dział",
    // gdzie dział jest używany: [tabela, kolumna, opis]
    usedIn: [["employees", "department_id", "pracowników"], ["users", "department_id", "użytkowników"], ["work_reports", "department_id", "wpisów w raportach"]]
  },
  business: {
    table: "business", column: "business",
    title: "Firmy", one: "firmę", placeholder: "Nazwa nowej firmy", empty: "Nie ma jeszcze żadnej firmy.",
    deleteTitle: "Usuwanie firmy", deleteQuestion: "Czy na pewno chcesz usunąć firmę",
    usedIn: [["employees", "business_id", "pracowników"]]
  },
  role: {
    table: "role", column: "role", icon: "fa-user-tag",
    title: "Role", one: "rolę", placeholder: "Nazwa nowej roli", empty: "Nie ma jeszcze żadnej roli.",
    deleteTitle: "Usuwanie roli", deleteQuestion: "Czy na pewno chcesz usunąć rolę",
    usedIn: [["users", "role_id", "użytkowników"]],
    // po nazwie tej roli system rozpoznaje administratora (pełne prawa do raportów) - nie wolno jej usunąć
    protectedNames: ["administrator"]
  }
};

// Pozycja, której nie wolno usunąć (np. rola "Administrator")
function opDictProtected(cfg, item) {
  return (cfg.protectedNames || []).includes(String(item.name || "").toLowerCase());
}

let opDictKind = null;
let opDictItems = [];
let opDictBusy = false;
let opDictToken = 0;

function opOpenDict(kind) {
  const cfg = OP_DICTS[kind];
  if (!cfg) return;
  opDictKind = kind;
  opDictItems = [];

  document.getElementById("op-dict-title").textContent = cfg.title;
  const input = document.getElementById("op-dict-name");
  input.value = "";
  input.placeholder = cfg.placeholder;
  document.getElementById("op-dict-add").innerHTML = `<i class="fa-solid fa-plus" style="margin-right: 8px;"></i> Dodaj ${cfg.one}`;
  opDictMsg("");

  toggleModal("modal-op-dict", true);
  input.focus();
  opLoadDict();
}

function opCloseDict() {
  opDictKind = null;
  opDictToken++;
  toggleModal("modal-op-dict", false);
}

function opDictMsg(text, ok) {
  const el = document.getElementById("op-dict-msg");
  if (!el) return;
  el.textContent = text;
  el.style.color = ok ? "#0b7a57" : "var(--danger)";
  el.style.display = text ? "block" : "none";
}

async function opLoadDict() {
  const cfg = OP_DICTS[opDictKind];
  const list = document.getElementById("op-dict-list");
  if (!cfg || !list) return;
  const token = ++opDictToken;

  const { data, error } = await supabaseClient.from(cfg.table).select(`id, ${cfg.column}`);
  if (token !== opDictToken) return; // w międzyczasie zamknięto okno albo otwarto drugi słownik

  if (error) {
    console.error("Błąd pobierania słownika:", error);
    opDictItems = [];
    list.innerHTML = `<div class="op-lock-empty">Nie udało się pobrać listy: ${rtEsc(error.message)}</div>`;
    return;
  }

  opDictItems = (data || [])
    .map(r => ({ id: r.id, name: String(r[cfg.column] || "").trim() }))
    .sort((a, b) => a.name.localeCompare(b.name, "pl"));

  // Pozycje chronione (rola "Administrator") w ogóle nie są pokazywane w panelu:
  // nie da się ich tu usunąć ani zmienić. Zostają w opDictItems, żeby nie dało się dodać ich drugi raz.
  const visible = opDictItems.filter(it => !opDictProtected(cfg, it));

  list.innerHTML = visible.length
    ? visible.map(it => `
        <div class="op-dict-row">
          <span class="ico"><i class="fa-solid ${cfg.icon || (opDictKind === "business" ? "fa-building" : "fa-sitemap")}"></i></span>
          <span class="name">${rtEsc(it.name || `(bez nazwy, id ${it.id})`)}</span>
          <button type="button" class="op-dict-del" title="Usuń" aria-label="Usuń: ${rtEsc(it.name)}" onclick="opOpenDictDelete(${Number(it.id)})"><i class="fa-solid fa-trash"></i></button>
        </div>`).join("")
    : `<div class="op-lock-empty" style="color: var(--text-muted);">${cfg.empty}</div>`;
}

async function opAddDictItem() {
  const cfg = OP_DICTS[opDictKind];
  if (!cfg || opDictBusy) return;

  const input = document.getElementById("op-dict-name");
  const name = input.value.trim().replace(/\s+/g, " ");
  if (!name) {
    opDictMsg("Wpisz nazwę.");
    return;
  }
  if (opDictItems.some(it => it.name.toLowerCase() === name.toLowerCase())) {
    const taken = opDictItems.find(it => it.name.toLowerCase() === name.toLowerCase());
    opDictMsg(opDictProtected(cfg, taken)
      ? `Nazwa „${name}” jest zastrzeżona przez system.`
      : `„${name}” jest już na liście.`);
    return;
  }

  const btn = document.getElementById("op-dict-add");
  opDictBusy = true;
  if (btn) btn.disabled = true;
  opDictMsg("");

  try {
    const { data, error } = await supabaseClient
      .from(cfg.table)
      .insert({ [cfg.column]: name })
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) throw new Error("brak uprawnień w bazie");

    logAction("Dodanie pozycji słownika", `${cfg.title}: ${name}`);
    input.value = "";
    await opLoadDict();
    opDictMsg(`Dodano: ${name}`, true);
    input.focus();
  } catch (err) {
    console.error("Błąd dodawania do słownika:", err);
    opDictMsg("Nie udało się dodać: " + (err.message || err));
  } finally {
    opDictBusy = false;
    if (btn) btn.disabled = false;
  }
}

// ---------- Usuwanie pozycji słownika (okno potwierdzenia z odliczaniem 3 s) ----------
let opDictDeleteId = null;
let opDictDeleteTimer = null;

function opOpenDictDelete(id) {
  const cfg = OP_DICTS[opDictKind];
  const item = opDictItems.find(it => Number(it.id) === Number(id));
  if (!cfg || !item || opDictProtected(cfg, item)) return;
  opDictDeleteId = item.id;

  document.getElementById("op-delete-title").innerText = cfg.deleteTitle;
  document.getElementById("op-delete-question").innerText = cfg.deleteQuestion;
  document.getElementById("op-delete-target").innerText = item.name || `id ${item.id}`;

  const confirmBtn = document.getElementById("op-btn-confirm-delete");

  if (opDictDeleteTimer) {
    clearInterval(opDictDeleteTimer);
    opDictDeleteTimer = null;
  }

  let secondsLeft = 3;
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerText = `Tak (${secondsLeft}s)`;

    opDictDeleteTimer = setInterval(() => {
      secondsLeft--;
      if (secondsLeft > 0) {
        confirmBtn.innerText = `Tak (${secondsLeft}s)`;
      } else {
        clearInterval(opDictDeleteTimer);
        opDictDeleteTimer = null;
        confirmBtn.disabled = false;
        confirmBtn.innerText = "Tak";
      }
    }, 1000);
  }

  toggleModal("modal-op-delete-confirm", true);
}

function opCloseDictDelete() {
  opDictDeleteId = null;
  if (opDictDeleteTimer) {
    clearInterval(opDictDeleteTimer);
    opDictDeleteTimer = null;
  }
  toggleModal("modal-op-delete-confirm", false);
}

// Ile wierszy w innych tabelach korzysta z tej pozycji: [{ label, count }] (tylko niezerowe)
async function opDictUsage(cfg, id) {
  const results = await Promise.all(cfg.usedIn.map(async ([table, column, label]) => {
    const { count, error } = await supabaseClient
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq(column, id);
    if (error) throw error;
    return { label, count: count || 0 };
  }));
  return results.filter(r => r.count > 0);
}

async function opConfirmDictDelete() {
  const cfg = OP_DICTS[opDictKind];
  const id = opDictDeleteId;
  if (!cfg || id === null || opDictBusy) return;
  const item = opDictItems.find(it => Number(it.id) === Number(id));

  const confirmBtn = document.getElementById("op-btn-confirm-delete");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerText = "Usuwanie...";
  }

  opDictBusy = true;
  let message = "", ok = false;
  try {
    // Pozycji, do której coś jest przypisane, nie wolno usunąć - osierociłoby to pracowników i raporty
    const usage = item && opDictProtected(cfg, item) ? [] : await opDictUsage(cfg, id);
    if (item && opDictProtected(cfg, item)) {
      message = `Pozycji „${item.name}” nie można usunąć - system z niej korzysta.`;
    } else if (usage.length) {
      message = `Nie można usunąć „${item ? item.name : id}”: korzysta z niej ` +
        usage.map(u => `${u.count} ${u.label}`).join(", ") + ". Najpierw przypisz im inną pozycję.";
    } else {
      const { data, error } = await supabaseClient.from(cfg.table).delete().eq("id", id).select("id");
      if (error) throw error;
      if (!data || data.length === 0) throw new Error("brak uprawnień w bazie albo pozycja już nie istnieje");
      message = `Usunięto: ${item ? item.name : id}`;
      logAction("Usunięcie pozycji słownika", `${cfg.title}: ${item ? item.name : id}`);
      ok = true;
    }
  } catch (err) {
    console.error("Błąd usuwania ze słownika:", err);
    message = "Nie udało się usunąć: " + (err.message || err);
  } finally {
    opDictBusy = false;
  }

  opCloseDictDelete();
  await opLoadDict();
  opDictMsg(message, ok);
}
