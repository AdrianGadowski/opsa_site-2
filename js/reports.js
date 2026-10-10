// ==========================================
// MODUŁ: LISTA RAPORTÓW (reports)
// Tabela źródłowa: work_reports (raport = wiersze o tym samym number_report)
// Wymaga: supabaseClient, toggleModal (z app.js) oraz pomocniczych rt* (z report_time.js)
// ==========================================

const RP_MONTHS = ["Styczeń", "Luty", "Marzec", "Kwiecień", "Maj", "Czerwiec",
  "Lipiec", "Sierpień", "Wrzesień", "Październik", "Listopad", "Grudzień"];
const RP_YEARS_BACK = 5;
const RP_PAGE = 1000;        // limit wierszy na jedno zapytanie w Supabase

let rpReports = [];          // raporty z wybranego okresu
let rpUsersById = {};
let rpEmployees = [];
let rpEmpById = {};
let rpCurrent = null;        // { number, edit } — raport otwarty w oknie
let rpLoadToken = 0;
let rpBannerTimer = null;
let rpBusy = false;
let rpAddEmpId = null;       // pracownik wybrany do dodania w oknie edycji
let rpPendingDelete = null;  // { type: "report", number } | { type: "row", id }
let rpDeleteTimer = null;

// ---------- Pomocnicze ----------
function rpHours(row) {
  return parseFloat(row.total_hours) || 0;
}

// "dd.mm.rrrr" -> "rrrrmmdd" (do sortowania)
function rpDateKey(pl) {
  const [d, m, y] = String(pl || "").split(".");
  return `${y || ""}${m || ""}${d || ""}`;
}

function rpUserName(id) {
  const u = rpUsersById[id];
  return u ? `${u.name || ""} ${u.last_name || ""}`.trim() : `Użytkownik #${id}`;
}

function rpEmpName(id) {
  const e = rpEmpById[id];
  return e ? `${e.first_name || ""} ${e.last_name || ""}`.trim() : `Pracownik #${id}`;
}

function rpShowBanner(type, text) {
  const el = document.getElementById("rp-banner");
  if (!el) return;
  const icon = type === "success" ? "fa-circle-check" : "fa-triangle-exclamation";
  el.className = `rp-banner visible ${type}`;
  el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${rtEsc(text)}</span>`;
  clearTimeout(rpBannerTimer);
  rpBannerTimer = setTimeout(() => el.classList.remove("visible"), 8000);
}

function rpShowDetailMsg(text) {
  const el = document.getElementById("rp-detail-msg");
  if (!el) return;
  el.textContent = text;
  el.style.color = "var(--danger, #D9383A)";
  el.style.display = "block";
}

function rpHideDetailMsg() {
  const el = document.getElementById("rp-detail-msg");
  if (el) el.style.display = "none";
}

// Pobiera wszystkie wiersze zapytania, stronami po RP_PAGE
async function rpFetchAll(build) {
  let all = [];
  for (let from = 0; ; from += RP_PAGE) {
    const { data, error } = await build().order("id", { ascending: true }).range(from, from + RP_PAGE - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < RP_PAGE) return all;
  }
}

// ---------- Inicjalizacja ----------
async function initReportsView() {
  rpCurrent = null;
  rpReports = [];

  const now = new Date();
  const yearSel = document.getElementById("rp-filter-year");
  const monthSel = document.getElementById("rp-filter-month");

  if (yearSel) {
    const y = now.getFullYear();
    yearSel.innerHTML = Array.from({ length: RP_YEARS_BACK + 1 }, (_, i) =>
      `<option value="${y - i}">${y - i}</option>`).join("");
  }
  if (monthSel) {
    const current = String(now.getMonth() + 1).padStart(2, "0");
    monthSel.innerHTML = `<option value="">Wszystkie miesiące</option>` +
      RP_MONTHS.map((name, i) => {
        const v = String(i + 1).padStart(2, "0");
        return `<option value="${v}"${v === current ? " selected" : ""}>${name}</option>`;
      }).join("");
  }

  try {
    const [users, employees] = await Promise.all([
      rpFetchAll(() => supabaseClient.from("users").select("id, name, last_name")),
      rpFetchAll(() => supabaseClient
        .from("employees")
        .select(`
          id, first_name, last_name, active, department_id,
          business:business_id ( business ),
          department:department_id ( department )
        `))
    ]);

    rpUsersById = {};
    users.forEach(u => { rpUsersById[u.id] = u; });

    rpEmployees = employees.sort((a, b) =>
      `${a.last_name || ""} ${a.first_name || ""}`.localeCompare(`${b.last_name || ""} ${b.first_name || ""}`, "pl")
    );
    rpEmpById = {};
    rpEmployees.forEach(e => { rpEmpById[e.id] = e; });
  } catch (err) {
    console.error("Błąd pobierania słowników listy raportów:", err);
    rpShowBanner("warning", "Nie udało się pobrać użytkowników lub pracowników: " + (err.message || err));
  }

  await rpLoad();
}

// ---------- Lista raportów ----------
function rpGroup(rows) {
  const map = new Map();
  rows.forEach(r => {
    let rep = map.get(r.number_report);
    if (!rep) {
      rep = {
        number: r.number_report,
        date: r.report_date,
        shift: r.shift,
        creatorId: r.add_first_name_id,
        created: r.add_data,
        rows: [],
        empIds: new Set(),
        present: 0,
        absent: 0
      };
      map.set(r.number_report, rep);
    }
    rep.rows.push(r);
    rep.empIds.add(r.first_name_id);
    if (r.at_work === false) rep.absent += rpHours(r);
    else rep.present += rpHours(r);
  });

  const num = r => Number(r.number) || 0;
  const reports = [...map.values()];

  // Numer kolejny w miesiącu: od najstarszego raportu (data raportu, potem numer z bazy)
  const counters = {};
  reports
    .sort((a, b) => rpDateKey(a.date).localeCompare(rpDateKey(b.date)) || num(a) - num(b))
    .forEach(r => {
      const month = rpDateKey(r.date).slice(0, 6);
      counters[month] = (counters[month] || 0) + 1;
      r.seq = counters[month];
    });

  // Na liście: od ostatnio utworzonych (data utworzenia, potem numer z bazy)
  return reports.sort((a, b) =>
    rpDateKey(b.created).localeCompare(rpDateKey(a.created)) || num(b) - num(a)
  );
}

// "numer w miesiącu (numer z bazy)"
function rpLabel(rep) {
  return `${rep.seq} (${rep.number})`;
}

async function rpLoad() {
  const tbody = document.getElementById("rp-table-body");
  if (!tbody) return;

  const year = document.getElementById("rp-filter-year")?.value;
  const month = document.getElementById("rp-filter-month")?.value;
  const pattern = month ? `%.${month}.${year}` : `%.${year}`;
  const token = ++rpLoadToken;

  try {
    const rows = await rpFetchAll(() => supabaseClient
      .from("work_reports")
      .select("id, report_date, shift, department_id, first_name_id, add_first_name_id, number_report, add_data, start_time, end_time, total_hours, at_work")
      .like("report_date", pattern));
    if (token !== rpLoadToken) return; // w międzyczasie zmieniono filtr

    rpReports = rpGroup(rows);
    rpRenderTable();
    return true;
  } catch (err) {
    if (token !== rpLoadToken) return;
    console.error("Błąd pobierania raportów:", err);
    rpReports = [];
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--danger);padding:25px;">
      Nie udało się pobrać raportów: ${rtEsc(err.message || err)}</td></tr>`;
  }
}

// Zapis daty z wyszukiwarki ("5.3.2026", "2026-03-05", "05/03") -> "05.03.2026" / "05.03".
// null = wpisany tekst nie jest datą.
function rpParseDateQuery(q) {
  if (!/^\d{1,4}([.\-\/]\d{1,4}){0,2}[.\-\/]?$/.test(q)) return null;
  let parts = q.split(/[.\-\/]/).filter(Boolean);
  if (parts[0].length === 4) parts = parts.reverse(); // rrrr-mm-dd
  return parts.map((p, i) => (i < 2 ? p.padStart(2, "0") : p)).join(".");
}

function rpVisibleReports() {
  const q = (document.getElementById("rp-filter-search")?.value || "").toLowerCase().trim();
  if (!q) return rpReports;

  const date = rpParseDateQuery(q);
  if (date) {
    // początek ("10.10") albo końcówka daty ("10.2026", "2026")
    return rpReports.filter(r => {
      const d = String(r.date || "");
      return d.startsWith(date) || d.endsWith("." + date);
    });
  }

  return rpReports.filter(r => {
    const u = rpUsersById[r.creatorId] || {};
    const n1 = `${u.name || ""} ${u.last_name || ""}`.toLowerCase();
    const n2 = `${u.last_name || ""} ${u.name || ""}`.toLowerCase();
    return n1.includes(q) || n2.includes(q);
  });
}

// Pełna data spoza wybranego roku/miesiąca przełącza filtry na ten okres
function rpOnSearch() {
  const q = (document.getElementById("rp-filter-search")?.value || "").trim();
  const m = (rpParseDateQuery(q) || "").match(/^\d{2}\.(\d{2})\.(\d{4})$/);
  const yearSel = document.getElementById("rp-filter-year");
  const monthSel = document.getElementById("rp-filter-month");

  if (m && yearSel && monthSel && Number(m[1]) >= 1 && Number(m[1]) <= 12 &&
      (yearSel.value !== m[2] || (monthSel.value && monthSel.value !== m[1]))) {
    if (![...yearSel.options].some(o => o.value === m[2])) {
      yearSel.insertAdjacentHTML("beforeend", `<option value="${m[2]}">${m[2]}</option>`);
    }
    yearSel.value = m[2];
    monthSel.value = m[1];
    rpLoad();
    return;
  }
  rpRenderTable();
}

function rpRenderTable() {
  const tbody = document.getElementById("rp-table-body");
  const info = document.getElementById("rp-filter-info");
  if (!tbody) return;

  const list = rpVisibleReports();
  if (info) {
    info.textContent = list.length === rpReports.length
      ? `Raportów: ${rpReports.length}`
      : `Raportów: ${list.length} z ${rpReports.length}`;
  }

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:30px;">
      ${rpReports.length === 0 ? "Brak raportów w wybranym okresie." : "Brak raportów spełniających podane kryteria."}</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(r => {
    const n = Number(r.number);
    const canModify = canModifyReport(r.creatorId);
    return `
      <tr>
        <td class="rp-c rp-num">${r.seq} <span class="rp-num-db">(${rtEsc(r.number)})</span></td>
        <td class="rp-c" style="font-weight: 600;">${rtEsc(r.date)}</td>
        <td class="rp-c">${rtEsc(r.shift || "-")}</td>
        <td>${rtEsc(rpUserName(r.creatorId))}</td>
        <td class="rp-c">${r.empIds.size}</td>
        <td class="rp-c rp-hours-ok">${rtFmtHours(r.present)}</td>
        <td class="rp-c rp-hours-absent">${rtFmtHours(r.absent)}</td>
        <td class="rp-c" style="color: var(--text-muted);">${rtEsc(r.created || "-")}</td>
        <td style="text-align: right;">
          <button class="link-btn" title="Podgląd raportu" style="font-size: 1rem; padding: 4px 8px; cursor: pointer;" onclick="rpOpenDetail(${n}, false)">
            <i class="fa-solid fa-eye"></i>
          </button>${canModify ? `
          <button class="link-btn" title="Edytuj raport" style="font-size: 1rem; padding: 4px 8px; cursor: pointer; margin-left: 6px;" onclick="rpOpenDetail(${n}, true)">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button class="link-btn" title="Usuń raport" style="font-size: 1rem; padding: 4px 8px; cursor: pointer; color: var(--danger, #ef4444); margin-left: 6px;" onclick="rpDeleteReport(${n})">
            <i class="fa-solid fa-trash"></i>
          </button>` : ""}
        </td>
      </tr>`;
  }).join("");
}

function rpFindReport(number) {
  return rpReports.find(r => Number(r.number) === Number(number)) || null;
}

// ---------- Usuwanie (okno potwierdzenia z odliczaniem 3 s) ----------
function rpOpenDelete(pending, title, question, target) {
  rpPendingDelete = pending;
  document.getElementById("rp-delete-title").innerText = title;
  document.getElementById("rp-delete-question").innerText = question;
  document.getElementById("rp-delete-target").innerText = target;

  const confirmBtn = document.getElementById("rp-btn-confirm-delete");

  if (rpDeleteTimer) {
    clearInterval(rpDeleteTimer);
    rpDeleteTimer = null;
  }

  let secondsLeft = 3;
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerText = `Tak (${secondsLeft}s)`;

    rpDeleteTimer = setInterval(() => {
      secondsLeft--;
      if (secondsLeft > 0) {
        confirmBtn.innerText = `Tak (${secondsLeft}s)`;
      } else {
        clearInterval(rpDeleteTimer);
        rpDeleteTimer = null;
        confirmBtn.disabled = false;
        confirmBtn.innerText = "Tak";
      }
    }, 1000);
  }

  toggleModal("modal-rp-delete-confirm", true);
}

function rpCloseDelete() {
  rpPendingDelete = null;
  if (rpDeleteTimer) {
    clearInterval(rpDeleteTimer);
    rpDeleteTimer = null;
  }
  toggleModal("modal-rp-delete-confirm", false);
}

function rpDeleteReport(number) {
  const rep = rpFindReport(number);
  if (!rep || !canModifyReport(rep.creatorId)) return;
  rpOpenDelete(
    { type: "report", number: rep.number, label: rpLabel(rep) },
    "Usuwanie raportu",
    "Czy na pewno chcesz usunąć raport",
    `nr ${rpLabel(rep)} z dnia ${rep.date} (${rep.shift || "-"}, pracowników: ${rep.empIds.size})`
  );
}

// Usunięcie pojedynczego pracownika z raportu otwartego w oknie edycji
function rpDeleteRow(recordId) {
  const rep = rpCurrent && rpFindReport(rpCurrent.number);
  const row = rep && rep.rows.find(r => Number(r.id) === Number(recordId));
  if (!row || !canModifyReport(rep.creatorId)) return;
  rpOpenDelete(
    { type: "row", id: row.id },
    "Usuwanie pracownika z raportu",
    `Czy na pewno chcesz usunąć z raportu nr ${rpLabel(rep)} pracownika`,
    `${rpEmpName(row.first_name_id)} (${row.start_time || "?"}–${row.end_time || "?"})`
  );
}

async function rpConfirmDelete() {
  const p = rpPendingDelete;
  if (!p || rpBusy) return;

  const confirmBtn = document.getElementById("rp-btn-confirm-delete");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerText = "Usuwanie...";
  }

  rpBusy = true;
  let failure = null;
  try {
    let query = supabaseClient.from("work_reports").delete();
    query = p.type === "report" ? query.eq("number_report", p.number) : query.eq("id", p.id);
    const { data, error } = await query.select("id");

    if (error) throw error;
    if (!data || data.length === 0) {
      failure = "Nic nie zostało usunięte (brak uprawnień w bazie lub wpis został już usunięty).";
    }
  } catch (err) {
    console.error("Błąd usuwania z raportu:", err);
    failure = "Nie udało się usunąć: " + (err.message || err);
  } finally {
    rpBusy = false;
  }

  rpCloseDelete();

  if (p.type === "row") {
    if (failure) rpShowDetailMsg(failure);
    else rpHideDetailMsg();
  } else {
    rpShowBanner(failure ? "warning" : "success", failure || `Raport nr ${p.label} został usunięty.`);
  }
  await rpReloadAfterEdit();
}

// ---------- Okno raportu (podgląd / edycja) ----------
function rpOpenDetail(number, edit) {
  const rep = rpFindReport(number);
  if (!rep) return;
  rpCurrent = { number, edit: edit && canModifyReport(rep.creatorId) };
  rpHideDetailMsg();
  rpRenderDetail(true);
  toggleModal("modal-rp-detail", true);
}

function rpCloseDetail() {
  rpCurrent = null;
  rpClosePicker();
  toggleModal("modal-rp-detail", false);
}

function rpRenderDetail(resetForm) {
  const rep = rpCurrent && rpFindReport(rpCurrent.number);
  if (!rep) {
    rpCloseDetail();
    return;
  }
  const edit = rpCurrent.edit;

  document.getElementById("rp-detail-title").textContent =
    `${edit ? "Edycja raportu" : "Raport"} nr ${rpLabel(rep)}`;

  document.getElementById("rp-detail-meta").innerHTML = `
    <span>Data raportu:<strong>${rtEsc(rep.date)}</strong></span>
    <span>Zmiana:<strong>${rtEsc(rep.shift || "-")}</strong></span>
    <span>Utworzył:<strong>${rtEsc(rpUserName(rep.creatorId))}</strong></span>
    <span>Data utworzenia:<strong>${rtEsc(rep.created || "-")}</strong></span>`;

  document.getElementById("rp-detail-summary").innerHTML = `
    <span>Pracowników:<strong>${rep.empIds.size}</strong></span>
    <span>Godziny obecne:<strong class="rp-hours-ok">${rtFmtHours(rep.present)}</strong></span>
    <span>Godziny nieobecne:<strong class="rp-hours-absent">${rtFmtHours(rep.absent)}</strong></span>`;

  const rows = [...rep.rows].sort((a, b) => {
    const ea = rpEmpById[a.first_name_id] || {};
    const eb = rpEmpById[b.first_name_id] || {};
    return `${ea.last_name || ""} ${ea.first_name || ""}`.localeCompare(`${eb.last_name || ""} ${eb.first_name || ""}`, "pl") ||
      String(a.start_time || "").localeCompare(String(b.start_time || ""));
  });

  document.getElementById("rp-detail-body").innerHTML = rows.map(r => {
    const emp = rpEmpById[r.first_name_id];
    return `
      <tr>
        <td style="font-weight: 600;">${rtEsc(rpEmpName(r.first_name_id))}</td>
        <td>${rtEsc(emp?.business?.business || "-")}</td>
        <td>${rtEsc(emp?.department?.department || "-")}</td>
        <td>${rtEsc(r.start_time || "-")}</td>
        <td>${rtEsc(r.end_time || "-")}</td>
        <td style="font-weight: 700; color: var(--primary); white-space: nowrap;">${rtFmtHours(rpHours(r))}</td>
        <td>${r.at_work === false
          ? `<span class="rp-pill absent">Nieobecność</span>`
          : `<span class="rp-pill ok">Obecność</span>`}</td>
        <td style="text-align: right;">${edit
          ? `<button type="button" class="rp-mini-btn" onclick="rpDeleteRow(${Number(r.id)})">Usuń</button>`
          : ""}</td>
      </tr>`;
  }).join("");

  const add = document.getElementById("rp-add");
  add.style.display = edit ? "" : "none";
  if (!edit) return;

  if (resetForm || rep.empIds.has(rpAddEmpId)) rpAddEmpId = null;
  rpSyncAddEmp();

  if (resetForm) {
    document.getElementById("rp-add-from").innerHTML = "";
    document.getElementById("rp-add-to").innerHTML = "";
    document.getElementById("rp-add-absent").checked = false;
  }
  rpSyncAddTimes();
}

// Listy godzin ograniczone do zmiany raportu; "do" musi być późniejsze niż "od"
function rpSyncAddTimes() {
  const rep = rpCurrent && rpFindReport(rpCurrent.number);
  const fromSel = document.getElementById("rp-add-from");
  const toSel = document.getElementById("rp-add-to");
  if (!rep || !fromSel || !toSel) return;

  const from = fromSel.value;
  const to = toSel.value;
  const opt = (t, sel) => `<option value="${t}"${t === sel ? " selected" : ""}>${t}</option>`;
  const empty = `<option value="">--:--</option>`;

  const idx = RT_SHIFT_NAMES.indexOf(rep.shift);
  if (idx < 0) {
    // raport z nieznaną zmianą — bez ograniczeń
    fromSel.innerHTML = empty + RT_ALL_TIMES.map(t => opt(t, from)).join("");
    toSel.innerHTML = empty + RT_ALL_TIMES.map(t => opt(t, to)).join("");
    return;
  }

  const start = RT_SHIFT_BASE + idx * RT_SHIFT_LEN;
  const slots = RT_SHIFT_LEN / 30;
  const slot = t => ((rtToMin(t) - start + 1440) % 1440) / 30;
  const time = k => RT_ALL_TIMES[((start + k * 30) % 1440) / 30];

  let fromHtml = empty;
  for (let k = 0; k <= (to ? slot(to) - 1 : slots - 1); k++) fromHtml += opt(time(k), from);
  let toHtml = empty;
  for (let k = (from ? slot(from) + 1 : 1); k <= slots; k++) toHtml += opt(time(k), to);

  fromSel.innerHTML = fromHtml;
  toSel.innerHTML = toHtml;
}

// Po zmianie w bazie: odśwież listę i otwarte okno (zamknij je, jeśli raport zniknął)
async function rpReloadAfterEdit() {
  await rpLoad();
  if (!rpCurrent) return;
  if (rpFindReport(rpCurrent.number)) rpRenderDetail(false);
  else rpCloseDetail();
}

// ---------- Wybór pracownika do dodania (okno z wyszukiwarką) ----------
function rpSyncAddEmp() {
  const btn = document.getElementById("rp-add-emp");
  if (!btn) return;
  const emp = rpEmpById[rpAddEmpId];
  btn.textContent = emp ? rpEmpName(emp.id) : "Wybierz pracownika...";
  btn.classList.toggle("empty", !emp);
}

function rpOpenPicker() {
  if (!rpCurrent) return;
  const search = document.getElementById("rp-picker-search");
  if (search) search.value = "";
  rpRenderPicker();
  toggleModal("modal-rp-picker", true);
  if (search) search.focus();
}

function rpClosePicker() {
  toggleModal("modal-rp-picker", false);
}

// Aktywni pracownicy, których jeszcze nie ma w raporcie
function rpRenderPicker() {
  const rep = rpCurrent && rpFindReport(rpCurrent.number);
  const list = document.getElementById("rp-picker-list");
  if (!rep || !list) return;

  const q = (document.getElementById("rp-picker-search")?.value || "").toLowerCase().trim();
  const found = rpEmployees.filter(e => {
    if (e.active === false || rep.empIds.has(e.id)) return false;
    if (!q) return true;
    const first = (e.first_name || "").toLowerCase();
    const last = (e.last_name || "").toLowerCase();
    return `${first} ${last}`.includes(q) || `${last} ${first}`.includes(q) ||
      (e.business?.business || "").toLowerCase().includes(q) ||
      (e.department?.department || "").toLowerCase().includes(q);
  });

  if (found.length === 0) {
    list.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:30px;font-size:0.9rem;">
      ${q ? "Brak pracowników spełniających podane kryteria." : "Wszyscy aktywni pracownicy są już w tym raporcie."}</div>`;
    return;
  }

  list.innerHTML = found.map(e => `
    <button type="button" class="rp-picker-item" onclick="rpPickEmployee(${Number(e.id)})">
      <span class="name">${rtEsc(`${e.last_name || ""} ${e.first_name || ""}`.trim())}</span>
      <span class="sub">${rtEsc(e.business?.business || "-")} • ${rtEsc(e.department?.department || "-")}</span>
    </button>`).join("");
}

function rpPickEmployee(id) {
  rpAddEmpId = id;
  rpSyncAddEmp();
  rpHideDetailMsg();
  rpClosePicker();
  document.getElementById("rp-add-from")?.focus();
}

// Dodanie pracownika do raportu
async function rpAddEmployee() {
  const rep = rpCurrent && rpFindReport(rpCurrent.number);
  if (!rep || rpBusy || !canModifyReport(rep.creatorId)) return;

  const from = document.getElementById("rp-add-from").value;
  const to = document.getElementById("rp-add-to").value;
  const absent = document.getElementById("rp-add-absent").checked;
  const emp = rpEmpById[rpAddEmpId];
  const hours = rtDuration(from, to);

  if (!emp) {
    rpShowDetailMsg("Wybierz pracownika.");
    return;
  }
  if (hours === null) {
    rpShowDetailMsg("Wybierz godziny od i do.");
    return;
  }

  const btn = document.getElementById("rp-add-btn");
  rpBusy = true;
  if (btn) btn.disabled = true;
  rpHideDetailMsg();

  try {
    // Ten sam pracownik nie może mieć nakładających się godzin w tym dniu i zmianie
    const { data: existing, error: checkErr } = await supabaseClient
      .from("work_reports")
      .select("number_report, start_time, end_time")
      .eq("report_date", rep.date)
      .eq("shift", rep.shift)
      .eq("first_name_id", emp.id);
    if (checkErr) throw checkErr;

    const mine = rtRange(from, to);
    const clash = (existing || []).find(r =>
      !r.start_time || !r.end_time || rtOverlap(mine, rtRange(r.start_time, r.end_time)));
    if (clash) {
      rpShowDetailMsg(`Ten pracownik jest już w raporcie nr ${clash.number_report} w godzinach ${clash.start_time || "?"}–${clash.end_time || "?"}.`);
      return;
    }

    const { error: insertErr } = await supabaseClient.from("work_reports").insert({
      report_date: rep.date,
      shift: rep.shift,
      department_id: emp.department_id,
      first_name_id: emp.id,
      last_name_id: emp.id,
      add_first_name_id: rep.creatorId,
      add_last_name_id: rep.creatorId,
      number_report: rep.number,
      add_data: rep.created,
      start_time: from,
      end_time: to,
      total_hours: hours.toFixed(1),
      at_work: !absent
    });
    if (insertErr) throw insertErr;

    rpAddEmpId = null;
    document.getElementById("rp-add-absent").checked = false;
    await rpReloadAfterEdit();
  } catch (err) {
    console.error("Błąd dodawania pracownika do raportu:", err);
    rpShowDetailMsg("Nie udało się dodać pracownika: " + (err.message || err));
  } finally {
    rpBusy = false;
    if (btn) btn.disabled = false;
  }
}
