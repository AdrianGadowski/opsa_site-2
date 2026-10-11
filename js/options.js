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
  } catch (err) {
    console.error("Błąd zapisu blokady miesiąca:", err);
    opShowLockMsg(`Nie udało się ${lock ? "zablokować" : "odblokować"} miesiąca ${opMonthLabel(key)}: ${err.message || err}`);
  } finally {
    opLockBusy = false;
  }
  await opLoadLocks();
}
