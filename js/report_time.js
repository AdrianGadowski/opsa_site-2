// ==========================================
// MODUŁ: ROZLICZANIE CZASU PRACY (report_time)
// Tabela docelowa: work_reports
// Wymaga: supabaseClient, currentUser, toggleModal (z app.js)
// ==========================================

const RT_TOP_TIMES = ["06:30", "10:30", "14:30", "18:30", "22:30", "02:30"];
const RT_ALL_TIMES = Array.from({ length: 48 }, (_, i) =>
  `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`
);
const RT_OTHER_TIMES = RT_ALL_TIMES.filter(t => !RT_TOP_TIMES.includes(t));

// Zmiany po 8 h, liczone od 06:30
const RT_SHIFT_NAMES = ["Zmiana I", "Zmiana II", "Zmiana III"];
const RT_SHIFT_BASE = 390;   // 06:30 w minutach
const RT_SHIFT_LEN = 480;

let rtShift = null;          // zmiana wykryta z wybranych godzin (null = nic nie wybrano)
let rtEmployees = [];
let rtEmpById = {};
let rtDraft = {};            // { [employeeId]: { from, to, absent } }
let rtShowErrors = false;
let rtMeta = { date: null, shift: null };
let rtConflicts = {};        // { [employeeId]: [rekordy work_reports] }
let rtBannerTimer = null;
let rtRefreshToken = 0;
let rtSaving = false;
let rtLocked = false;        // miesiąc wybranej daty raportu jest zablokowany (Opcje -> Blokada miesiąca)

// ---------- Pomocnicze ----------
function rtEsc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function rtToMin(t) {
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + m;
}

// Godziny między od–do (obsługa przejścia przez północ). null = brak / nieprawidłowe.
function rtDuration(from, to) {
  if (!from || !to) return null;
  let diff = rtToMin(to) - rtToMin(from);
  if (diff < 0) diff += 1440;
  if (diff === 0) return null;
  return diff / 60;
}

function rtRange(from, to) {
  const s = rtToMin(from);
  let e = rtToMin(to);
  if (e <= s) e += 1440;
  return [s, e];
}

function rtOverlap(a, b) {
  return [-1440, 0, 1440].some(shift => a[0] < b[1] + shift && b[0] + shift < a[1]);
}

function rtFmtHours(h) {
  return `${h.toFixed(1)} h`;
}

function rtTodayIso() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function rtIsoToPl(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

// Zmiana, do której należy godzina. Granica (np. 14:30) jako "od" otwiera kolejną zmianę,
// a jako "do" zamyka poprzednią.
function rtShiftOf(time, which) {
  const m = (rtToMin(time) - RT_SHIFT_BASE - (which === "to" ? 1 : 0) + 1440) % 1440;
  return RT_SHIFT_NAMES[Math.floor(m / RT_SHIFT_LEN)];
}

function rtDetectShift() {
  for (const d of Object.values(rtDraft)) {
    if (d.from) return rtShiftOf(d.from, "from");
    if (d.to) return rtShiftOf(d.to, "to");
  }
  return null;
}

function rtShiftChanged() {
  const s = rtDetectShift();
  if (s === rtShift) return false;
  rtShift = s;
  return true;
}

function rtShiftStart() {
  return RT_SHIFT_BASE + RT_SHIFT_NAMES.indexOf(rtShift) * RT_SHIFT_LEN;
}

// Numer półgodzinnego slotu w bieżącej zmianie (0 = początek zmiany, 16 = koniec)
function rtSlot(time) {
  return ((rtToMin(time) - rtShiftStart() + 1440) % 1440) / 30;
}

// Bez wykrytej zmiany: wszystkie godziny. Po wykryciu: tylko godziny tej zmiany,
// przy czym "do" musi być późniejsze niż "od" w tym samym wierszu.
function rtTimeOptions(which, d) {
  const selected = d[which];
  const opt = t => `<option value="${t}"${t === selected ? " selected" : ""}>${t}</option>`;
  const empty = `<option value="">--:--</option>`;

  if (!rtShift) {
    return empty +
      `<optgroup label="Początki zmian">${RT_TOP_TIMES.map(opt).join("")}</optgroup>` +
      `<optgroup label="Pozostałe godziny">${RT_OTHER_TIMES.map(opt).join("")}</optgroup>`;
  }

  const start = rtShiftStart();
  const slots = RT_SHIFT_LEN / 30;
  const min = which === "to" ? (d.from ? rtSlot(d.from) + 1 : 1) : 0;
  const max = which === "from" ? (d.to ? rtSlot(d.to) - 1 : slots - 1) : slots;

  // Na górze listy pełne połówki zmiany (co 4 h od jej początku, np. 10:30 i 14:30), niżej reszta
  let top = "", rest = "";
  for (let k = min; k <= max; k++) {
    const html = opt(RT_ALL_TIMES[((start + k * 30) % 1440) / 30]);
    if (k % 8 === 0) top += html;
    else rest += html;
  }
  return empty +
    (top ? `<optgroup label="Najczęstsze">${top}</optgroup>` : "") +
    (rest ? `<optgroup label="Pozostałe godziny">${rest}</optgroup>` : "");
}

function rtRowState(d) {
  if (!d) return { hours: null, filled: false, incomplete: false };
  const hours = rtDuration(d.from, d.to);
  const filled = hours !== null;
  const incomplete = !filled && !!(d.from || d.to || d.absent);
  return { hours, filled, incomplete };
}

function rtShowBanner(type, text) {
  const el = document.getElementById("rt-banner");
  if (!el) return;
  const icon = type === "success" ? "fa-circle-check" : "fa-triangle-exclamation";
  el.className = `rt-banner visible ${type}`;
  el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${rtEsc(text)}</span>`;
  clearTimeout(rtBannerTimer);
  rtBannerTimer = setTimeout(() => el.classList.remove("visible"), type === "success" ? 10000 : 8000);
}

// ---------- Inicjalizacja ----------
async function initReportTimeView() {
  rtDraft = {};
  rtShowErrors = false;
  rtConflicts = {};
  rtMeta = { date: rtTodayIso(), shift: null };

  const tbody = document.getElementById("rt-table-body");

  try {
    const [empRes, bizRes, deptRes] = await Promise.all([
      supabaseClient
        .from("employees")
        .select(`
          id, first_name, last_name, business_id, department_id,
          business:business_id ( business ),
          department:department_id ( department )
        `)
        .eq("active", true),
      supabaseClient.from("business").select("id, business"),
      supabaseClient.from("department").select("id, department")
    ]);

    if (empRes.error) throw empRes.error;

    rtEmployees = (empRes.data || []).sort((a, b) =>
      `${a.last_name || ""} ${a.first_name || ""}`.localeCompare(`${b.last_name || ""} ${b.first_name || ""}`, "pl")
    );
    rtEmpById = {};
    rtEmployees.forEach(e => { rtEmpById[e.id] = e; });

    const bizSel = document.getElementById("rt-filter-business");
    const deptSel = document.getElementById("rt-filter-dept");

    const businesses = (bizRes.data || []).sort((a, b) => String(a.business || "").localeCompare(String(b.business || ""), "pl"));
    const depts = (deptRes.data || []).sort((a, b) => String(a.department || "").localeCompare(String(b.department || ""), "pl"));

    if (bizSel) {
      bizSel.innerHTML = `<option value="">Wszystkie firmy</option>` +
        businesses.map(b => `<option value="${b.id}">${rtEsc(b.business || "Firma #" + b.id)}</option>`).join("");
    }
    if (deptSel) {
      deptSel.innerHTML = `<option value="">Wszystkie działy</option>` +
        depts.map(d => `<option value="${d.id}">${rtEsc(d.department || "Dział #" + d.id)}</option>`).join("");
    }

    rtRenderTable();
    rtUpdateStats();
  } catch (err) {
    console.error("Błąd ładowania widoku rozliczania czasu:", err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--danger);padding:25px;">
        Nie udało się pobrać pracowników: ${rtEsc(err.message || err)}</td></tr>`;
    }
  }
}

// ---------- Tabela pracowników ----------
function rtVisibleEmployees() {
  const q = (document.getElementById("rt-filter-search")?.value || "").toLowerCase().trim();
  const biz = document.getElementById("rt-filter-business")?.value;
  const dept = document.getElementById("rt-filter-dept")?.value;

  return rtEmployees.filter(e => {
    const n1 = `${e.first_name || ""} ${e.last_name || ""}`.toLowerCase();
    const n2 = `${e.last_name || ""} ${e.first_name || ""}`.toLowerCase();
    return (!q || n1.includes(q) || n2.includes(q)) &&
      (!biz || String(e.business_id) === String(biz)) &&
      (!dept || String(e.department_id) === String(dept));
  });
}

function rtRowClass(id) {
  const d = rtDraft[id];
  const st = rtRowState(d);
  let cls = "rt-row";
  if (d && d.absent) cls += " is-absent";
  else if (st.filled) cls += " is-filled";
  if (rtShowErrors && st.incomplete) cls += " is-error";
  return cls;
}

function rtRowHtml(emp) {
  const id = emp.id;
  const d = rtDraft[id] || { from: "", to: "", absent: false };
  const st = rtRowState(d);
  const hasAny = !!(d.from || d.to || d.absent);

  return `
    <tr id="rt-row-${id}" class="${rtRowClass(id)}" style="border-bottom: 1px solid #F0F0F0;">
      <td class="rt-name" style="font-weight: 600; color: var(--primary);">${rtEsc(emp.first_name)} ${rtEsc(emp.last_name)}</td>
      <td>
        <span style="background: rgba(8, 88, 75, 0.06); color: var(--primary); padding: 4px 9px; border-radius: 4px; font-size: 0.82rem; font-weight: 600; border: 1px solid rgba(8, 88, 75, 0.15);">
          ${rtEsc(emp.business?.business || "-")}
        </span>
      </td>
      <td style="color: var(--text-muted); font-size: 0.88rem;">${rtEsc(emp.department?.department || "-")}</td>
      <td>
        <select class="rt-time" id="rt-from-${id}" aria-label="Od" onchange="rtOnTime(${id}, 'from', this.value)">
          ${rtTimeOptions("from", d)}
        </select>
      </td>
      <td>
        <select class="rt-time" id="rt-to-${id}" aria-label="Do" onchange="rtOnTime(${id}, 'to', this.value)">
          ${rtTimeOptions("to", d)}
        </select>
      </td>
      <td class="rt-sum ${st.filled ? "" : "empty"}" id="rt-sum-${id}">${st.filled ? rtFmtHours(st.hours) : "—"}</td>
      <td>
        <label class="rt-switch">
          <input type="checkbox" ${d.absent ? "checked" : ""} onchange="rtOnAbsent(${id}, this.checked)" aria-label="Nieobecność" />
          <span class="track"></span>
          <span class="lbl" id="rt-lbl-${id}">${d.absent ? "Nieobecny" : "Obecny"}</span>
        </label>
      </td>
      <td>
        <button type="button" class="link-btn rt-clear ${hasAny ? "visible" : ""}" id="rt-clear-${id}" title="Wyczyść wiersz" onclick="rtClearRow(${id})">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </td>
    </tr>`;
}

function rtRenderTable() {
  const tbody = document.getElementById("rt-table-body");
  if (!tbody) return;
  rtShift = rtDetectShift();
  const list = rtVisibleEmployees();

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:30px;">
      Brak pracowników spełniających podane kryteria.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(rtRowHtml).join("");
}

function rtApplyFilters() { rtRenderTable(); }

function rtResetFilters() {
  const s = document.getElementById("rt-filter-search");
  const b = document.getElementById("rt-filter-business");
  const d = document.getElementById("rt-filter-dept");
  if (s) s.value = "";
  if (b) b.value = "";
  if (d) d.value = "";
  rtRenderTable();
}

// ---------- Edycja wierszy ----------
function rtGetDraft(id) {
  if (!rtDraft[id]) rtDraft[id] = { from: "", to: "", absent: false };
  return rtDraft[id];
}

function rtCleanupDraft(id) {
  const d = rtDraft[id];
  if (d && !d.from && !d.to && !d.absent) delete rtDraft[id];
}

// Aktualizacja wiersza "w miejscu" (bez przerysowania, żeby nie gubić fokusu)
function rtSyncRow(id) {
  const tr = document.getElementById(`rt-row-${id}`);
  if (!tr) return;
  const d = rtDraft[id];
  const st = rtRowState(d);

  tr.className = rtRowClass(id);

  const opts = d || { from: "", to: "" };
  const fromSel = document.getElementById(`rt-from-${id}`);
  const toSel = document.getElementById(`rt-to-${id}`);
  if (fromSel) fromSel.innerHTML = rtTimeOptions("from", opts);
  if (toSel) toSel.innerHTML = rtTimeOptions("to", opts);

  const sum = document.getElementById(`rt-sum-${id}`);
  if (sum) {
    sum.textContent = st.filled ? rtFmtHours(st.hours) : "—";
    sum.classList.toggle("empty", !st.filled);
  }

  const lbl = document.getElementById(`rt-lbl-${id}`);
  if (lbl) lbl.textContent = d && d.absent ? "Nieobecny" : "Obecny";

  const clr = document.getElementById(`rt-clear-${id}`);
  if (clr) clr.classList.toggle("visible", !!d);
}

function rtOnTime(id, which, value) {
  rtGetDraft(id)[which] = value;
  rtCleanupDraft(id);
  if (rtShiftChanged()) {
    // zmiana wykryta lub zwolniona — listy godzin zmieniają się we wszystkich wierszach
    rtRenderTable();
    document.getElementById(`rt-${which}-${id}`)?.focus();
  } else {
    rtSyncRow(id);
  }
  rtUpdateStats();
}

function rtOnAbsent(id, checked) {
  rtGetDraft(id).absent = checked;
  rtCleanupDraft(id);
  rtSyncRow(id);
  rtUpdateStats();
}

function rtReplaceRow(id) {
  const tr = document.getElementById(`rt-row-${id}`);
  const emp = rtEmpById[id];
  if (tr && emp) tr.outerHTML = rtRowHtml(emp);
}

function rtClearRow(id) {
  delete rtDraft[id];
  if (rtShiftChanged()) rtRenderTable();
  else rtReplaceRow(id);
  rtUpdateStats();
}

function rtClearAll() {
  if (Object.keys(rtDraft).length === 0) return;
  toggleModal("modal-rt-clear-confirm", true);
}

function rtConfirmClearAll() {
  toggleModal("modal-rt-clear-confirm", false);
  rtDraft = {};
  rtShowErrors = false;
  rtRenderTable();
  rtUpdateStats();
}

function rtFilledEntries() {
  return rtEmployees
    .filter(e => rtRowState(rtDraft[e.id]).filled)
    .map(e => {
      const d = rtDraft[e.id];
      return { emp: e, from: d.from, to: d.to, absent: !!d.absent, hours: rtDuration(d.from, d.to) };
    });
}

function rtUpdateStats() {
  const entries = rtFilledEntries();
  const total = entries.reduce((s, e) => s + e.hours, 0);
  const absent = entries.filter(e => e.absent).length;

  const c = document.getElementById("rt-stat-count");
  const a = document.getElementById("rt-stat-absent");
  const h = document.getElementById("rt-stat-hours");
  if (c) c.textContent = entries.length;
  if (a) a.textContent = absent;
  if (h) h.textContent = rtFmtHours(total);

  const s = document.getElementById("rt-stat-shift");
  if (s) s.textContent = rtShift || "—";
}

// ---------- Okno potwierdzenia ----------
async function rtOpenConfirm() {
  const incompleteIds = Object.keys(rtDraft).filter(id => rtRowState(rtDraft[id]).incomplete);

  if (incompleteIds.length > 0) {
    rtShowErrors = true;
    const visibleIds = new Set(rtVisibleEmployees().map(e => String(e.id)));
    if (incompleteIds.some(id => !visibleIds.has(id))) rtResetFilters();
    else rtRenderTable();

    rtShowBanner(
      "warning",
      `Niekompletne wiersze: ${incompleteIds.length}. Uzupełnij godziny od i do (różne od siebie) albo wyczyść wiersz.`
    );
    document.getElementById(`rt-row-${incompleteIds[0]}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const entries = rtFilledEntries();
  if (entries.length === 0) {
    rtShowBanner("warning", "Uzupełnij godziny od i do przynajmniej jednemu pracownikowi.");
    return;
  }

  rtShowErrors = false;
  rtMeta.shift = rtShift;

  document.getElementById("rt-meta-date").value = rtMeta.date || "";
  document.getElementById("rt-meta-shift").textContent = rtMeta.shift || "—";
  rtHideSummaryMsg();
  toggleModal("modal-rt-confirm", true);
  await rtRefreshSummary();
}

function rtCloseConfirm() {
  rtRefreshToken++;
  toggleModal("modal-rt-confirm", false);
}

function rtOnMetaChange() {
  rtMeta.date = document.getElementById("rt-meta-date").value;
  rtHideSummaryMsg();
  rtRefreshSummary();
}

function rtShowSummaryMsg(text, color = "var(--danger, #D9383A)") {
  const el = document.getElementById("rt-summary-msg");
  if (!el) return;
  el.textContent = text;
  el.style.color = color;
  el.style.display = "block";
}

function rtHideSummaryMsg() {
  const el = document.getElementById("rt-summary-msg");
  if (el) el.style.display = "none";
}

function rtHasConflicts() {
  return Object.values(rtConflicts).some(list => list.length > 0);
}

function rtUpdateSaveButton() {
  const btn = document.getElementById("rt-btn-save");
  if (!btn) return;
  const noEntries = rtFilledEntries().length === 0;
  btn.disabled = rtSaving || noEntries || !rtMeta.date || rtLocked || rtHasConflicts();
}

// Szuka wpisów tych pracowników w wybranym dniu i zmianie, które nakładają się godzinowo
async function rtFetchConflicts(entries) {
  const ids = entries.map(e => e.emp.id);
  const { data, error } = await supabaseClient
    .from("work_reports")
    .select("id, number_report, first_name_id, add_first_name_id, start_time, end_time, at_work")
    .eq("report_date", rtIsoToPl(rtMeta.date))
    .eq("shift", rtMeta.shift)
    .in("first_name_id", ids);

  if (error) return { error, map: {} };

  const map = {};
  entries.forEach(e => {
    const mine = rtRange(e.from, e.to);
    map[e.emp.id] = (data || []).filter(r => {
      if (Number(r.first_name_id) !== Number(e.emp.id)) return false;
      if (!r.start_time || !r.end_time) return true; // brak godzin = traktuj jako kolizję
      return rtOverlap(mine, rtRange(r.start_time, r.end_time));
    });
  });
  return { error: null, map };
}

async function rtRefreshSummary() {
  const body = document.getElementById("rt-summary-body");
  const info = document.getElementById("rt-summary-totals");
  if (!body) return;

  const entries = rtFilledEntries();
  const token = ++rtRefreshToken;

  if (info) {
    const present = entries.filter(e => !e.absent).reduce((s, e) => s + e.hours, 0);
    const absent = entries.filter(e => e.absent).reduce((s, e) => s + e.hours, 0);
    info.innerHTML = `
      <span>Pracowników:<strong>${entries.length}</strong></span>
      <span>Godziny obecne:<strong class="ok">${rtFmtHours(present)}</strong></span>
      <span>Godziny nieobecne:<strong class="absent">${rtFmtHours(absent)}</strong></span>`;
  }

  if (entries.length === 0) {
    rtConflicts = {};
    body.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:30px;">Brak pozycji w raporcie.</td></tr>`;
    rtUpdateSaveButton();
    return;
  }

  if (!rtMeta.date) {
    rtConflicts = {};
    rtShowSummaryMsg("Wybierz datę raportu.");
    rtRenderSummaryRows(entries);
    rtUpdateSaveButton();
    return;
  }

  body.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:30px;">
    <i class="fa-solid fa-spinner fa-spin"></i> Sprawdzanie duplikatów...</td></tr>`;
  const btn = document.getElementById("rt-btn-save");
  if (btn) btn.disabled = true;

  // Zablokowany miesiąc: raportu nie można zapisać
  let lockError = null;
  try {
    rtLocked = await opIsLocked(rtMeta.date.slice(0, 7));
  } catch (err) {
    console.error("Błąd sprawdzania blokady miesiąca:", err);
    rtLocked = true;
    lockError = err;
  }
  if (token !== rtRefreshToken) return;

  if (rtLocked) {
    rtConflicts = {};
    rtRenderSummaryRows(entries);
    rtShowSummaryMsg(lockError
      ? "Nie udało się sprawdzić blokady miesiąca: " + (lockError.message || lockError)
      : `Miesiąc ${opMonthLabel(rtMeta.date.slice(0, 7))} jest zablokowany. Nie można w nim tworzyć raportów.`, "#9b1c1f");
    rtUpdateSaveButton();
    return;
  }

  const res = await rtFetchConflicts(entries);
  if (token !== rtRefreshToken) return; // ktoś zmienił datę/zmianę w trakcie

  if (res.error) {
    console.error("Błąd sprawdzania duplikatów:", res.error);
    rtConflicts = {};
    rtShowSummaryMsg("Nie udało się sprawdzić duplikatów: " + (res.error.message || res.error));
    rtRenderSummaryRows(entries);
    if (btn) btn.disabled = true;
    return;
  }

  rtConflicts = res.map;
  rtRenderSummaryRows(entries);
  rtUpdateSaveButton();

  if (rtHasConflicts()) {
    rtShowSummaryMsg(
      "Część osób jest już w raporcie w tych godzinach. Usuń je z istniejącego raportu albo pomiń w nowym.",
      "#9b1c1f"
    );
  } else {
    rtHideSummaryMsg();
  }
}

function rtRenderSummaryRows(entries) {
  const body = document.getElementById("rt-summary-body");
  if (!body) return;

  body.innerHTML = entries.map(e => {
    const conflicts = rtConflicts[e.emp.id] || [];
    const isConflict = conflicts.length > 0;

    const status = isConflict
      ? conflicts.map(c => `
          <div class="rt-conflict-line">
            <span>Już w raporcie nr ${rtEsc(c.number_report)} (${c.at_work === false ? "nieobecność" : "obecność"}, ${rtEsc(c.start_time || "?")}–${rtEsc(c.end_time || "?")})</span>
            ${canModifyReport(c.add_first_name_id)
              ? `<button type="button" class="rt-mini-btn danger" onclick="rtDeleteExisting(this, ${Number(c.id)})">Usuń z raportu nr ${rtEsc(c.number_report)}</button>`
              : ""}
          </div>`).join("")
      : (e.absent
          ? `<span class="rt-pill absent">Nieobecność</span>`
          : `<span class="rt-pill ok">Obecność</span>`);

    return `
      <tr class="${isConflict ? "conflict" : ""}">
        <td style="font-weight: 600;">${rtEsc(e.emp.first_name)} ${rtEsc(e.emp.last_name)}</td>
        <td>${rtEsc(e.emp.business?.business || "-")}</td>
        <td>${rtEsc(e.emp.department?.department || "-")}</td>
        <td>${e.from}</td>
        <td>${e.to}</td>
        <td style="font-weight: 700; color: var(--primary); white-space: nowrap;">${rtFmtHours(e.hours)}</td>
        <td>${status}</td>
        <td><button type="button" class="rt-mini-btn neutral" onclick="rtSkipEntry(${e.emp.id})">Pomiń</button></td>
      </tr>`;
  }).join("");
}

// Usunięcie istniejącego wpisu z bazy (dwa kliknięcia, drugie w ciągu 3,5 s)
async function rtDeleteExisting(btn, recordId) {
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.dataset.orig = btn.textContent;
    btn.classList.add("armed");
    btn.textContent = "Na pewno? Kliknij ponownie";
    setTimeout(() => {
      if (btn.isConnected && btn.dataset.armed === "1") {
        btn.dataset.armed = "";
        btn.classList.remove("armed");
        btn.textContent = btn.dataset.orig;
      }
    }, 3500);
    return;
  }

  btn.disabled = true;
  btn.textContent = "Usuwanie...";

  const { data, error } = await supabaseClient
    .from("work_reports")
    .delete()
    .eq("id", recordId)
    .select("id");

  if (error) {
    console.error("Błąd usuwania wpisu z raportu:", error);
    rtShowSummaryMsg("Nie udało się usunąć wpisu: " + error.message);
  } else if (!data || data.length === 0) {
    rtShowSummaryMsg("Wpis nie został usunięty (brak uprawnień w bazie lub został już usunięty).");
  }

  await rtRefreshSummary();
}

// Pominięcie osoby w nowym raporcie (czyści jej wiersz na stronie)
function rtSkipEntry(id) {
  delete rtDraft[id];
  if (rtShiftChanged()) rtRenderTable();
  else rtReplaceRow(id);
  rtUpdateStats();
  rtRefreshSummary();
}

async function rtSaveReport() {
  if (rtSaving) return;

  const entries = rtFilledEntries();
  const saveBtn = document.getElementById("rt-btn-save");
  if (entries.length === 0) return;

  if (!rtMeta.date) {
    rtShowSummaryMsg("Wybierz datę raportu.");
    return;
  }
  if (!currentUser || currentUser.id === undefined || currentUser.id === null) {
    rtShowSummaryMsg("Brak ID zalogowanego użytkownika (dodaj kolumnę id do zapytania logowania w app.js).");
    return;
  }

  rtSaving = true;
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerText = "Zapisywanie...";
  }

  try {
    // 0. Miesiąc mógł zostać zablokowany już po otwarciu okna
    rtLocked = await opIsLocked(rtMeta.date.slice(0, 7));
    if (rtLocked) {
      rtShowSummaryMsg(`Miesiąc ${opMonthLabel(rtMeta.date.slice(0, 7))} jest zablokowany. Nie można w nim tworzyć raportów.`, "#9b1c1f");
      return;
    }

    // 1. Ostatnie sprawdzenie duplikatów tuż przed zapisem
    const check = await rtFetchConflicts(entries);
    if (check.error) throw check.error;
    rtConflicts = check.map;
    if (rtHasConflicts()) {
      rtRenderSummaryRows(entries);
      rtShowSummaryMsg("W międzyczasie pojawiły się duplikaty. Rozwiąż je i zapisz ponownie.", "#9b1c1f");
      return;
    }

    // 2. Kolejny numer raportu
    const { data: maxRows, error: maxErr } = await supabaseClient
      .from("work_reports")
      .select("number_report")
      .order("number_report", { ascending: false })
      .limit(1);
    if (maxErr) throw maxErr;

    const reportNumber = maxRows && maxRows.length ? (Number(maxRows[0].number_report) || 0) + 1 : 1;

    // 3. Zapis
    const reportDate = rtIsoToPl(rtMeta.date);
    const addedOn = rtIsoToPl(rtTodayIso());

    const records = entries.map(e => ({
      report_date: reportDate,
      shift: rtMeta.shift,
      department_id: e.emp.department_id,
      first_name_id: e.emp.id,
      last_name_id: e.emp.id,
      add_first_name_id: currentUser.id,
      add_last_name_id: currentUser.id,
      number_report: reportNumber,
      add_data: addedOn,
      start_time: e.from,
      end_time: e.to,
      total_hours: e.hours.toFixed(1),
      at_work: !e.absent
    }));

    const { error: insertErr } = await supabaseClient.from("work_reports").insert(records);
    if (insertErr) throw insertErr;

    // 4. Sukces
    rtDraft = {};
    rtConflicts = {};
    rtShowErrors = false;
    rtCloseConfirm();
    rtRenderTable();
    rtUpdateStats();
    rtShowBanner("success", `Raport nr ${reportNumber} (${reportDate}, ${rtMeta.shift}) został zapisany. Liczba osób: ${records.length}.`);
  } catch (err) {
    console.error("Błąd zapisu raportu:", err);
    rtShowSummaryMsg("Wystąpił błąd podczas zapisu: " + (err.message || err));
  } finally {
    rtSaving = false;
    if (saveBtn) saveBtn.innerText = "Zatwierdź i zapisz";
    rtUpdateSaveButton();
  }
}