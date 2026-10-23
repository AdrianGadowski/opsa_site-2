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
let rpDeptById = {};         // słownik działów: id -> nazwa
let rpEmployees = [];
let rpEmpById = {};
let rpCurrent = null;        // { number, edit } — raport otwarty w oknie
let rpLoadToken = 0;
let rpBannerTimer = null;
let rpBusy = false;
let rpAddEmpId = null;       // pracownik wybrany do dodania w oknie edycji
let rpRowEdits = {};         // { [id wiersza]: { from, to, absent } } — niezapisane zmiany w oknie edycji
let rpDateEdit = null;       // nowa data raportu (rrrr-mm-dd) czekająca na "Zapisz zmiany"; null = bez zmiany
let rpPendingDelete = null;  // { type: "report", number, label, date } | { type: "row", id, date }
let rpLockedKeys = new Set(); // zablokowane miesiące "RRRR-MM" (Opcje -> Blokada miesiąca)
let rpDeleteTimer = null;
let rpSelected = new Set();  // raporty zaznaczone do zatwierdzenia (zakładka "W oczekiwaniu")
let rpAction = null;         // { type: "reject" | "unapprove" | "resubmit", number } - okno potwierdzenia

// Zakładki widoku (report_approval.js): archive - zatwierdzone, pending - w oczekiwaniu, rejected - do poprawy
const RP_TAB_HERO = {
  archive: ["Archiwum", "Lista raportów", "Archiwum zatwierdzonych raportów czasu pracy. Zatwierdzonego raportu nie można zmienić ani usunąć, dopóki osoba z uprawnieniem nie cofnie zatwierdzenia."],
  pending: ["Zatwierdzanie", "W oczekiwaniu na zatwierdzenie", "Raporty czekające na zatwierdzenie, z wszystkich miesięcy. Do czasu zatwierdzenia autor może je edytować; nie liczą się jeszcze w statystykach."],
  rejected: ["Poprawki", "Raporty do poprawy", "Raporty odesłane do poprawy, z powodem odrzucenia. Po poprawieniu autor wysyła raport ponownie do zatwierdzenia."]
};

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
  rpSelected = new Set();

  const now = new Date();
  rpSetPeriod(now.getFullYear(), now.getMonth() + 1);

  // zakładka z menu (albo z powiadomienia); niedostępna - pierwsza dostępna
  const tabs = rpaTabs();
  if (!tabs.includes(rpaTab)) rpaTab = tabs[0] || "archive";
  rpaSyncMenu("reports");
  rpApplyTab();

  try {
    const [users, employees, depts] = await Promise.all([
      rpFetchAll(() => supabaseClient.from("users").select("id, name, last_name")),
      rpFetchAll(() => supabaseClient
        .from("employees")
        .select(`
          id, first_name, last_name, active, department_id,
          business:business_id ( business ),
          department:department_id ( department )
        `)),
      rpFetchAll(() => supabaseClient.from("department").select("id, department"))
    ]);

    rpUsersById = {};
    users.forEach(u => { rpUsersById[u.id] = u; });
    rpDeptById = {};
    depts.forEach(d => { rpDeptById[d.id] = d.department || "Dział #" + d.id; });

    rpEmployees = employees.sort((a, b) =>
      `${a.first_name || ""} ${a.last_name || ""}`.localeCompare(`${b.first_name || ""} ${b.last_name || ""}`, "pl")
    );
    rpEmpById = {};
    rpEmployees.forEach(e => { rpEmpById[e.id] = e; });
  } catch (err) {
    console.error("Błąd pobierania słowników listy raportów:", err);
    rpShowBanner("warning", "Nie udało się pobrać użytkowników lub pracowników: " + (err.message || err));
  }

  await rpLoad();
}

// ---------- Zakładki ----------
// Przełączenie zakładki na otwartym widoku (zakładki w menu - rpaOpenTab)
function rpSetTab(tab) {
  rpaTab = tab;
  rpSelected = new Set();
  rpApplyTab();
  rpLoad();
}

// Nagłówek, wybór miesiąca (tylko w archiwum - kolejki pokazują wszystkie miesiące) i zaznaczona zakładka
function rpApplyTab() {
  const [eyebrow, title, desc] = RP_TAB_HERO[rpaTab] || RP_TAB_HERO.archive;
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set("rp-hero-eyebrow", eyebrow);
  set("rp-hero-title", title);
  // przed sql/34 lista pokazuje wszystkie raporty, jak dawniej
  set("rp-hero-desc", rpaInstalled() ? desc
    : "Raporty czasu pracy. Raport można podejrzeć, edytować (dodać lub usunąć pracownika) albo usunąć w całości.");
  const pick = document.getElementById("rp-periodpick");
  if (pick) pick.style.display = rpaTab === "archive" ? "" : "none";
  const tbody = document.getElementById("rp-table-body");
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="12" style="text-align: center; padding: 30px; color: var(--text-muted);">
      <i class="fa-solid fa-spinner fa-spin"></i> Ładowanie raportów...</td></tr>`;
  }
  rpRenderHead();
  rpSyncBulk();
}

// Stan raportu (przed sql/34 każdy raport traktowany jak dawniej: bez zatwierdzania)
function rpStatus(rep) {
  return rpaInstalled() ? rep.status || "pending" : null;
}

// Edycja i usuwanie: autor albo administrator, miesiąc niezablokowany, raport niezatwierdzony
function rpCanEdit(rep) {
  return canModifyReport(rep.creatorId) &&
    !rpLockedKeys.has(opPeriodKeyFromPl(rep.date)) &&
    rpStatus(rep) !== "approved";
}

// "05.10.2026, 14:32" z daty i godziny w bazie
function rpDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
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
        departmentId: r.id_department ?? null,
        created: r.add_data,
        // zatwierdzanie (sql/34) - na każdym wierszu raportu jest to samo
        status: r.approval_status ?? null,
        approvedBy: r.approved_by ?? null,
        approvedAt: r.approved_at ?? null,
        rejectedBy: r.rejected_by ?? null,
        rejectedAt: r.rejected_at ?? null,
        reason: r.reject_reason ?? null,
        submittedAt: r.submitted_at ?? null,
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

  // Kolejki (w oczekiwaniu, do poprawy): od najstarszego raportu, bez numeru w miesiącu
  // (są w nich raporty z różnych miesięcy, więc numer w miesiącu byłby mylący)
  if (rpaTab !== "archive") {
    return reports.sort((a, b) => rpDateKey(a.date).localeCompare(rpDateKey(b.date)) || num(a) - num(b));
  }

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

// "numer w miesiącu (numer z bazy)"; w kolejkach sam numer z bazy
function rpLabel(rep) {
  return rep.seq ? `${rep.seq} (${rep.number})` : String(rep.number);
}

// ---------- Wybór miesiąca: strzałki ‹ › jak na pulpicie ----------
// Okres trzymają ukryte pola rp-filter-year ("2026") i rp-filter-month ("01".."12").
// Styczeń ‹ = grudzień poprzedniego roku, grudzień › = styczeń następnego. Nie da się wyjść poza bieżący miesiąc.

function rpPeriod() {
  const now = new Date();
  return {
    year: Number(document.getElementById("rp-filter-year")?.value) || now.getFullYear(),
    month: Number(document.getElementById("rp-filter-month")?.value) || now.getMonth() + 1
  };
}

function rpSetPeriod(year, month) {
  const y = document.getElementById("rp-filter-year");
  const m = document.getElementById("rp-filter-month");
  if (y) y.value = String(year);
  if (m) m.value = String(month).padStart(2, "0");
  rpSyncPeriodArrows();
}

function rpPeriodInFuture(year, month) {
  const now = new Date();
  return year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1);
}

function rpStepPeriod(delta) {
  let { year, month } = rpPeriod();
  month += delta;
  if (month < 1) { month = 12; year--; }
  if (month > 12) { month = 1; year++; }
  if (rpPeriodInFuture(year, month)) return;
  rpSetPeriod(year, month);
  rpLoad();
}

function rpSyncPeriodArrows() {
  const { year, month } = rpPeriod();
  const text = document.getElementById("rp-period-text");
  if (text) text.textContent = `${RP_MONTHS[month - 1]} ${year}`;
  const next = document.getElementById("rp-next");
  if (next) next.disabled = rpPeriodInFuture(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1);
}

async function rpLoad() {
  const tbody = document.getElementById("rp-table-body");
  if (!tbody) return;

  const year = document.getElementById("rp-filter-year")?.value;
  const month = document.getElementById("rp-filter-month")?.value;
  const pattern = month ? `%.${month}.${year}` : `%.${year}`;
  const token = ++rpLoadToken;
  const tab = rpaTab;

  // Archiwum: wybrany miesiąc, tylko zatwierdzone (przed sql/34 - wszystkie raporty).
  // Kolejki: wszystkie miesiące; zatwierdzający widzi raporty z całego zakładu, autor - swoje.
  const build = () => {
    // "*": działa też przed dodaniem kolumn id_department (sql/24) i statusu (sql/34)
    let q = supabaseClient.from("work_reports").select("*");
    if (tab === "archive") return rpaFilterApproved(q.like("report_date", pattern), rpaInstalled());
    q = q.eq("approval_status", tab);
    return rpaCanApprove() ? q : q.eq("add_first_name_id", currentUser.id);
  };

  try {
    const rows = await rpFetchAll(build);
    // Zablokowane miesiące: przy nich nie ma edycji ani usuwania
    let lockedKeys = new Set();
    try {
      lockedKeys = await opFetchLockedKeys();
    } catch (lockErr) {
      // przyciski zostają, ale każda akcja i tak sprawdza blokadę w bazie
      console.error("Błąd pobierania blokad miesięcy:", lockErr);
    }
    if (token !== rpLoadToken) return; // w międzyczasie zmieniono filtr albo zakładkę
    rpLockedKeys = lockedKeys;

    rpReports = rpGroup(rows);
    // zaznaczone zostają tylko raporty, które nadal czekają na zatwierdzenie
    rpSelected = new Set([...rpSelected].filter(n => rpReports.some(r => Number(r.number) === n)));
    rpRenderTable();
    rpaRefreshBadges();          // liczniki w menu zgodne z tym, co właśnie widać na liście
    return true;
  } catch (err) {
    if (token !== rpLoadToken) return;
    console.error("Błąd pobierania raportów:", err);
    rpReports = [];
    tbody.innerHTML = `<tr><td colspan="12" style="text-align:center;color:var(--danger);padding:25px;">
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
    const dept = (r.departmentId != null ? rpDeptName(r.departmentId) : "").toLowerCase();
    return n1.includes(q) || n2.includes(q) || dept.includes(q);
  });
}

// Dział raportu (dział mistrza, który go utworzył)
function rpDeptName(id) {
  if (id === null || id === undefined) return "-";
  return rpDeptById[id] || "Dział #" + id;
}

// Pełna data spoza wybranego roku/miesiąca przełącza filtry na ten okres
function rpOnSearch() {
  const q = (document.getElementById("rp-filter-search")?.value || "").trim();
  const m = (rpParseDateQuery(q) || "").match(/^\d{2}\.(\d{2})\.(\d{4})$/);
  const { year, month } = rpPeriod();

  if (rpaTab === "archive" && m && Number(m[1]) >= 1 && Number(m[1]) <= 12 && (year !== Number(m[2]) || month !== Number(m[1]))) {
    rpSetPeriod(Number(m[2]), Number(m[1]));
    rpLoad();
    return;
  }
  rpRenderTable();
}

// Kolumny tabeli w zakładce. Archiwum: kto zatwierdził; w oczekiwaniu: kiedy wysłano (i pole
// zaznaczenia dla zatwierdzającego); do poprawy: kto odesłał i powód.
function rpColumns() {
  const cols = [];
  if (rpaTab === "pending" && rpaCanApprove()) cols.push("check");
  cols.push("num", "date", "shift", "author", "dept", "people", "present", "absent");
  if (rpaTab === "archive") cols.push("created", ...(rpaInstalled() ? ["approved"] : []));
  if (rpaTab === "pending") cols.push("submitted");
  if (rpaTab === "rejected") cols.push("rejected", "reason");
  cols.push("actions");
  return cols;
}

function rpRenderHead() {
  const head = document.getElementById("rp-table-head");
  if (!head) return;
  const titles = {
    num: "Nr", date: "Data raportu", shift: "Zmiana", author: "Utworzył", dept: "Dział", people: "Pracowników",
    created: "Data utworzenia", approved: "Zatwierdził", submitted: "Wysłano", rejected: "Odesłał", reason: "Powód odrzucenia"
  };
  head.innerHTML = `<tr>${rpColumns().map(c => {
    if (c === "check") {
      return `<th class="rp-col-check"><input type="checkbox" id="rp-check-all" class="rp-check" aria-label="Zaznacz wszystkie" onchange="rpToggleAll(this.checked)" /></th>`;
    }
    if (c === "present") return `<th class="rp-c rp-col-ok">Godz. obecne</th>`;
    if (c === "absent") return `<th class="rp-c rp-col-absent">Godz. nieobecne</th>`;
    if (c === "actions") return `<th style="width: 150px;"></th>`;
    return `<th class="rp-c">${titles[c]}</th>`;
  }).join("")}</tr>`;
}

// "Imię Nazwisko" i pod spodem data - kto zatwierdził / odesłał
function rpWhoHtml(userId, iso, emptyText) {
  if (!userId && !iso) return `<span style="color: var(--text-muted);">${emptyText}</span>`;
  return `<span class="rp-who">${rtEsc(userId ? rpUserName(userId) : "-")}</span><span class="rp-when">${rtEsc(rpDateTime(iso))}</span>`;
}

// Przyciski w wierszu: podgląd, edycja i usuwanie (autor), zatwierdzanie (uprawnienie), ponowne wysłanie (autor)
function rpActionsHtml(r) {
  const n = Number(r.number);
  const status = rpStatus(r);
  const locked = rpLockedKeys.has(opPeriodKeyFromPl(r.date));
  const approver = rpaCanApprove();
  const btn = (cls, title, icon, onclick) =>
    `<button class="link-btn rp-act ${cls}" title="${title}" aria-label="${title}" onclick="${onclick}"><i class="fa-solid ${icon}"></i></button>`;

  let html = btn("", "Podgląd raportu", "fa-eye", `rpOpenDetail(${n}, false)`);
  if (rpCanEdit(r)) {
    html += btn("", "Edytuj raport", "fa-pen", `rpOpenDetail(${n}, true)`);
    html += btn("delete", "Usuń raport", "fa-trash", `rpDeleteReport(${n})`);
  }
  if (status === "pending" && approver) {
    html += btn("approve", "Zatwierdź raport", "fa-check", `rpApprove([${n}])`);
    html += btn("reject", "Odeślij do poprawy", "fa-reply", `rpOpenAction('reject', ${n})`);
  }
  if (status === "rejected" && canModifyReport(r.creatorId) && !locked) {
    html += btn("resubmit", "Wyślij ponownie do zatwierdzenia", "fa-paper-plane", `rpOpenAction('resubmit', ${n})`);
  }
  if (status === "approved" && approver && !locked) {
    html += btn("unapprove", "Cofnij zatwierdzenie", "fa-lock-open", `rpOpenAction('unapprove', ${n})`);
  }
  if (locked) {
    const why = status === "approved" && approver
      ? "Miesiąc zablokowany — aby cofnąć zatwierdzenie, najpierw odblokuj miesiąc w Opcjach"
      : "Miesiąc zablokowany — raportu nie można edytować ani usuwać";
    html += `<span class="rp-lock" title="${why}"><i class="fa-solid fa-lock"></i></span>`;
  }
  return html;
}

function rpRenderTable() {
  const tbody = document.getElementById("rp-table-body");
  const info = document.getElementById("rp-filter-info");
  if (!tbody) return;

  const cols = rpColumns();
  const list = rpVisibleReports();
  if (info) {
    info.textContent = list.length === rpReports.length
      ? `Raportów: ${rpReports.length}`
      : `Raportów: ${list.length} z ${rpReports.length}`;
  }

  if (list.length === 0) {
    const empty = rpReports.length
      ? "Brak raportów spełniających podane kryteria."
      : { archive: rpaInstalled() ? "Brak zatwierdzonych raportów w wybranym okresie." : "Brak raportów w wybranym okresie.",
          pending: "Żaden raport nie czeka na zatwierdzenie.",
          rejected: "Brak raportów do poprawy." }[rpaTab];
    tbody.innerHTML = `<tr><td colspan="${cols.length}" style="text-align:center;color:var(--text-muted);padding:30px;">${empty}</td></tr>`;
    rpSyncBulk();
    return;
  }

  tbody.innerHTML = list.map(r => {
    const n = Number(r.number);
    const cells = {
      check: `<td class="rp-col-check"><input type="checkbox" class="rp-check" aria-label="Zaznacz raport nr ${rtEsc(r.number)}"
                ${rpSelected.has(n) ? "checked" : ""} onchange="rpToggleSelect(${n}, this.checked)" /></td>`,
      num: `<td class="rp-c rp-num">${r.seq ? `${r.seq} <span class="rp-num-db">(${rtEsc(r.number)})</span>` : rtEsc(r.number)}${
        rpaTab === "pending" && r.rejectedAt ? `<span class="rp-tag fixed" title="Raport był odesłany do poprawy i został wysłany ponownie">Poprawiony</span>` : ""}</td>`,
      date: `<td class="rp-c" style="font-weight: 600;">${rtEsc(r.date)}</td>`,
      shift: `<td class="rp-c">${rtEsc(r.shift || "-")}</td>`,
      author: `<td class="rp-c">${rtEsc(rpUserName(r.creatorId))}</td>`,
      dept: `<td class="rp-c">${rtEsc(rpDeptName(r.departmentId))}</td>`,
      people: `<td class="rp-c">${r.empIds.size}</td>`,
      present: `<td class="rp-c rp-hours-ok">${rtFmtHours(r.present)}</td>`,
      absent: `<td class="rp-c rp-hours-absent">${rtFmtHours(r.absent)}</td>`,
      created: `<td class="rp-c" style="color: var(--text-muted);">${rtEsc(r.created || "-")}</td>`,
      approved: `<td class="rp-c">${rpWhoHtml(r.approvedBy, r.approvedAt, "przed wprowadzeniem zatwierdzania")}</td>`,
      submitted: `<td class="rp-c" style="color: var(--text-muted);">${rtEsc(rpDateTime(r.submittedAt) || r.created || "-")}</td>`,
      rejected: `<td class="rp-c">${rpWhoHtml(r.rejectedBy, r.rejectedAt, "-")}</td>`,
      reason: `<td class="rp-reason ${r.reason ? "" : "empty"}">${rtEsc(r.reason || "bez podanego powodu")}</td>`,
      actions: `<td style="text-align: right; white-space: nowrap;">${rpActionsHtml(r)}</td>`
    };
    return `<tr class="${rpSelected.has(n) ? "rp-selected" : ""}">${cols.map(c => cells[c]).join("")}</tr>`;
  }).join("");
  rpSyncBulk();
}

// ---------- Zaznaczanie i zatwierdzanie kilku raportów naraz ----------
function rpToggleSelect(number, on) {
  if (on) rpSelected.add(number);
  else rpSelected.delete(number);
  rpRenderTable();
}

// "Zaznacz wszystkie" dotyczy raportów widocznych po filtrze wyszukiwania
function rpToggleAll(on) {
  rpVisibleReports().forEach(r => {
    if (on) rpSelected.add(Number(r.number));
    else rpSelected.delete(Number(r.number));
  });
  rpRenderTable();
}

function rpSyncBulk() {
  const btn = document.getElementById("rp-bulk-approve");
  const show = rpaTab === "pending" && rpaCanApprove();
  if (btn) {
    btn.style.display = show ? "" : "none";
    btn.disabled = !rpSelected.size || rpBusy;
    btn.innerHTML = `<i class="fa-solid fa-check-double"></i> Zatwierdź zaznaczone${rpSelected.size ? ` (${rpSelected.size})` : ""}`;
  }
  const all = document.getElementById("rp-check-all");
  if (all) {
    const visible = rpVisibleReports();
    const picked = visible.filter(r => rpSelected.has(Number(r.number))).length;
    all.checked = visible.length > 0 && picked === visible.length;
    all.indeterminate = picked > 0 && picked < visible.length;
  }
}

function rpApproveSelected() {
  if (rpSelected.size) rpApprove([...rpSelected]);
}

// Zatwierdzenie jednego albo kilku raportów (funkcja bazy sprawdza uprawnienie i stan)
async function rpApprove(numbers) {
  if (rpBusy || !numbers.length) return;
  rpBusy = true;
  rpSyncBulk();
  try {
    const { data, error } = await supabaseClient.rpc("app_report_approve", { p_numbers: numbers.map(Number) });
    if (error) throw error;
    const done = Number(data) || 0;
    rpaAdjust(-done, 0);
    numbers.forEach(n => rpSelected.delete(Number(n)));
    if (rpCurrent && numbers.map(Number).includes(Number(rpCurrent.number))) rpCloseDetail();
    rpShowBanner(done ? "success" : "warning", done
      ? (numbers.length === 1 ? `Raport nr ${numbers[0]} został zatwierdzony.` : `Zatwierdzono raportów: ${done}.`)
      : "Nic nie zostało zatwierdzone - raporty mogły zostać już zatwierdzone albo odesłane do poprawy.");
  } catch (err) {
    console.error("Błąd zatwierdzania raportów:", err);
    rpShowBanner("warning", "Nie udało się zatwierdzić: " + (err.message || err));
  } finally {
    rpBusy = false;
  }
  await rpReloadAfterEdit();
}

// ---------- Okno: odesłanie do poprawy, cofnięcie zatwierdzenia, ponowne wysłanie ----------
const RP_ACTIONS = {
  reject: {
    icon: "fa-reply", iconCls: "", title: "Odesłanie raportu do poprawy", confirm: "Odeślij do poprawy", btnCls: "btn-danger",
    text: rep => `Raport nr ${rpLabel(rep)} z dnia ${rep.date} (${rep.shift || "-"}) autora ${rpUserName(rep.creatorId)} trafi do zakładki „Do poprawy”. Autor dostanie powiadomienie z powodem.`
  },
  unapprove: {
    icon: "fa-lock-open", iconCls: "warn", title: "Cofnięcie zatwierdzenia", confirm: "Cofnij zatwierdzenie", btnCls: "btn-primary",
    text: rep => `Raport nr ${rpLabel(rep)} z dnia ${rep.date} (${rep.shift || "-"}) wróci do zakładki „W oczekiwaniu”. Do ponownego zatwierdzenia nie będzie liczony w statystykach, a autor będzie mógł go edytować.`
  },
  resubmit: {
    icon: "fa-paper-plane", iconCls: "ok", title: "Ponowne wysłanie do zatwierdzenia", confirm: "Wyślij ponownie", btnCls: "btn-primary",
    text: rep => `Raport nr ${rpLabel(rep)} z dnia ${rep.date} (${rep.shift || "-"}) wróci do zakładki „W oczekiwaniu na zatwierdzenie”. Upewnij się, że wszystko zostało poprawione${rep.reason ? ` (powód odrzucenia: „${rep.reason}”)` : ""}.`
  }
};

function rpOpenAction(type, number) {
  const rep = rpFindReport(number);
  const cfg = RP_ACTIONS[type];
  if (!rep || !cfg) return;
  rpAction = { type, number: Number(number) };

  document.getElementById("rp-action-icon").className = `rp-action-icon ${cfg.iconCls}`;
  document.getElementById("rp-action-icon").innerHTML = `<i class="fa-solid ${cfg.icon}"></i>`;
  document.getElementById("rp-action-title").textContent = cfg.title;
  document.getElementById("rp-action-text").textContent = cfg.text(rep);
  document.getElementById("rp-action-reason-wrap").style.display = type === "reject" ? "" : "none";
  document.getElementById("rp-action-reason").value = "";
  document.getElementById("rp-action-msg").style.display = "none";
  const confirmBtn = document.getElementById("rp-action-confirm");
  confirmBtn.className = cfg.btnCls;
  confirmBtn.disabled = false;
  confirmBtn.textContent = cfg.confirm;

  toggleModal("modal-rp-action", true);
  if (type === "reject") document.getElementById("rp-action-reason").focus();
}

function rpCloseAction() {
  rpAction = null;
  toggleModal("modal-rp-action", false);
}

async function rpConfirmAction() {
  const a = rpAction;
  if (!a || rpBusy) return;
  const confirmBtn = document.getElementById("rp-action-confirm");
  const msg = document.getElementById("rp-action-msg");
  confirmBtn.disabled = true;
  rpBusy = true;

  const calls = {
    reject: () => supabaseClient.rpc("app_report_reject", { p_number: a.number, p_reason: document.getElementById("rp-action-reason").value }),
    unapprove: () => supabaseClient.rpc("app_report_unapprove", { p_number: a.number }),
    resubmit: () => supabaseClient.rpc("app_report_resubmit", { p_number: a.number })
  };
  const done = {
    reject: `Raport nr ${a.number} został odesłany do poprawy.`,
    unapprove: `Cofnięto zatwierdzenie raportu nr ${a.number}. Raport jest w zakładce „W oczekiwaniu”.`,
    resubmit: `Raport nr ${a.number} został wysłany ponownie do zatwierdzenia.`
  };

  try {
    const { error } = await calls[a.type]();
    if (error) throw error;
    rpBusy = false;
    // liczniki w menu od razu: [w oczekiwaniu, do poprawy]
    rpaAdjust(...{ reject: [-1, 1], unapprove: [1, 0], resubmit: [1, -1] }[a.type]);
    rpCloseAction();
    if (rpCurrent && Number(rpCurrent.number) === a.number) rpCloseDetail();
    rpShowBanner("success", done[a.type]);
    await rpReloadAfterEdit();
  } catch (err) {
    console.error("Błąd zmiany stanu raportu:", err);
    msg.textContent = err.message || String(err);
    msg.style.display = "block";
    confirmBtn.disabled = false;
  } finally {
    rpBusy = false;
  }
}

// Sprawdza w bazie blokadę miesiąca raportu tuż przed zmianą. Zwraca true (i pokazuje
// komunikat przez show), gdy miesiąc jest zablokowany albo nie dało się tego sprawdzić.
async function rpBlockedByLock(plDate, show) {
  const key = opPeriodKeyFromPl(plDate);
  try {
    if (!(await opIsLocked(key))) return false;
    show(`Miesiąc ${opMonthLabel(key)} jest zablokowany. Raportu nie można edytować ani usuwać.`);
  } catch (err) {
    console.error("Błąd sprawdzania blokady miesiąca:", err);
    show("Nie udało się sprawdzić blokady miesiąca: " + (err.message || err));
  }
  return true;
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
  if (!rep || !rpCanEdit(rep)) return;
  rpOpenDelete(
    { type: "report", number: rep.number, label: rpLabel(rep), date: rep.date, info: `Raport nr ${rep.number}, ${rep.date}, ${rep.shift || "-"}, osób: ${rep.empIds.size}` },
    "Usuwanie raportu",
    "Czy na pewno chcesz usunąć raport",
    `nr ${rpLabel(rep)} z dnia ${rep.date} (${rep.shift || "-"}, pracowników: ${rep.empIds.size})`
  );
}

// Usunięcie pojedynczego pracownika z raportu otwartego w oknie edycji
function rpDeleteRow(recordId) {
  const rep = rpCurrent && rpFindReport(rpCurrent.number);
  const row = rep && rep.rows.find(r => Number(r.id) === Number(recordId));
  if (!row || !rpCanEdit(rep)) return;
  rpOpenDelete(
    { type: "row", id: row.id, date: rep.date, info: `Raport nr ${rep.number}, ${rep.date}: ${rpEmpName(row.first_name_id)}` },
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
  const blocked = await rpBlockedByLock(p.date, msg => {
    if (p.type === "row") rpShowDetailMsg(msg);
    else rpShowBanner("warning", msg);
  });
  if (blocked) {
    rpBusy = false;
    rpCloseDelete();
    await rpReloadAfterEdit();
    return;
  }

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

  if (!failure) {
    logAction(p.type === "report" ? "Usunięcie raportu" : "Usunięcie pracownika z raportu", p.info);
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
  rpCurrent = { number, edit: edit && rpCanEdit(rep) };
  rpRowEdits = {};
  rpDateEdit = null;
  rpHideDetailMsg();
  rpRenderDetail(true);
  toggleModal("modal-rp-detail", true);
}

function rpCloseDetail() {
  rpCurrent = null;
  rpRowEdits = {};
  rpDateEdit = null;
  rpClosePicker();
  rtPickClose(false);
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

  // w edycji datę raportu można zmienić; zapisuje ją dopiero "Zapisz zmiany"
  const dateField = edit
    ? `<span class="rp-date-edit">
         <label for="rp-edit-date">Data raportu:</label>
         <input type="date" id="rp-edit-date" class="form-control ${rpDateEdit ? "rp-dirty-field" : ""}"
                value="${rtEsc(rpDateEdit || rpIsoDate(rep.date))}" onchange="rpOnDateChange()" />
       </span>`
    : `<span>Data raportu:<strong>${rtEsc(rep.date)}</strong></span>`;

  document.getElementById("rp-detail-meta").innerHTML = `
    ${dateField}
    <span>Zmiana:<strong>${rtEsc(rep.shift || "-")}</strong></span>
    <span>Utworzył:<strong>${rtEsc(rpUserName(rep.creatorId))}</strong></span>
    <span>Data utworzenia:<strong>${rtEsc(rep.created || "-")}</strong></span>`;

  rpRenderDetailStatus(rep);
  rpRenderDetailActions(rep);

  document.getElementById("rp-detail-summary").innerHTML = `
    <span>Pracowników:<strong>${rep.empIds.size}</strong></span>
    <span>Godziny obecne:<strong class="rp-hours-ok">${rtFmtHours(rep.present)}</strong></span>
    <span>Godziny nieobecne:<strong class="rp-hours-absent">${rtFmtHours(rep.absent)}</strong></span>`;

  const rows = [...rep.rows].sort((a, b) => {
    const ea = rpEmpById[a.first_name_id] || {};
    const eb = rpEmpById[b.first_name_id] || {};
    return `${ea.first_name || ""} ${ea.last_name || ""}`.localeCompare(`${eb.first_name || ""} ${eb.last_name || ""}`, "pl") ||
      String(a.start_time || "").localeCompare(String(b.start_time || ""));
  });

  document.getElementById("rp-detail-body").innerHTML = rows.map(r => {
    const emp = rpEmpById[r.first_name_id];
    const id = Number(r.id);
    // w edycji pokazuj niezapisane zmiany, jeśli są
    const v = edit ? rpRowValues(r) : null;
    const dirty = edit && !!rpRowEdits[r.id];
    const hours = dirty ? rtDuration(v.from, v.to) : rpHours(r);

    return `
      <tr class="${dirty ? "rp-dirty" : ""}">
        <td style="font-weight: 600;">${rtEsc(rpEmpName(r.first_name_id))}</td>
        <td>${rtEsc(emp?.business?.business || "-")}</td>
        <td>${rtEsc(emp?.department?.department || "-")}</td>
        <td>${edit
          ? rpTimeBtnHtml(`rp-row-from-${id}`, "from", v.from, "rp-row-time", `rpOpenRowTime(${id}, 'from')`)
          : rtEsc(r.start_time || "-")}</td>
        <td>${edit
          ? rpTimeBtnHtml(`rp-row-to-${id}`, "to", v.to, "rp-row-time", `rpOpenRowTime(${id}, 'to')`)
          : rtEsc(r.end_time || "-")}</td>
        <td id="rp-row-sum-${id}" style="font-weight: 700; color: var(--primary); white-space: nowrap;">${hours === null ? "—" : rtFmtHours(hours)}</td>
        <td>${edit
          ? `<label class="rp-switch row">
               <input type="checkbox" id="rp-row-absent-${id}" aria-label="Nieobecność" ${v.absent ? "checked" : ""} onchange="rpOnRowTime(${id})" />
               <span class="track"></span>
               <span class="lbl lbl-off">Obecny</span>
               <span class="lbl lbl-on">Nieobecny</span>
             </label>`
          : (r.at_work === false
            ? `<span class="rp-pill absent">Nieobecność</span>`
            : `<span class="rp-pill ok">Obecność</span>`)}</td>
        <td style="text-align: right; white-space: nowrap;">${edit
          ? `<button type="button" class="rp-mini-btn" onclick="rpDeleteRow(${id})">Usuń</button>`
          : ""}</td>
      </tr>`;
  }).join("");

  rpSyncSaveAll();

  const add = document.getElementById("rp-add");
  add.style.display = edit ? "" : "none";
  if (!edit) return;

  if (resetForm || rep.empIds.has(rpAddEmpId)) rpAddEmpId = null;
  rpSyncAddEmp();

  if (resetForm) {
    rpResetAddTimes();
    document.getElementById("rp-add-absent").checked = false;
  }
}

// Stan zatwierdzenia nad tabelą okna raportu
function rpRenderDetailStatus(rep) {
  const box = document.getElementById("rp-detail-status");
  if (!box) return;
  const status = rpStatus(rep);
  if (!status) {
    box.style.display = "none";
    return;
  }
  const who = (id, iso) => `<b>${rtEsc(id ? rpUserName(id) : "-")}</b>${iso ? `, ${rtEsc(rpDateTime(iso))}` : ""}`;
  let icon, html;
  if (status === "approved") {
    icon = "fa-circle-check";
    html = rep.approvedBy || rep.approvedAt
      ? `Zatwierdzony: ${who(rep.approvedBy, rep.approvedAt)}. Raportu nie można zmienić ani usunąć, dopóki zatwierdzenie nie zostanie cofnięte.`
      : "Zatwierdzony (raport sprzed wprowadzenia zatwierdzania). Raportu nie można zmienić ani usunąć, dopóki zatwierdzenie nie zostanie cofnięte.";
  } else if (status === "rejected") {
    icon = "fa-rotate-left";
    html = `Odesłany do poprawy: ${who(rep.rejectedBy, rep.rejectedAt)}.<br>Powód: <b>${rtEsc(rep.reason || "nie podano")}</b>`;
  } else {
    icon = "fa-hourglass-half";
    html = `W oczekiwaniu na zatwierdzenie${rep.submittedAt ? ` (wysłano ${rtEsc(rpDateTime(rep.submittedAt))})` : ""}.` +
      (rep.rejectedAt ? `<br>Wcześniej odesłany do poprawy przez ${who(rep.rejectedBy, rep.rejectedAt)}. Powód: <b>${rtEsc(rep.reason || "nie podano")}</b>` : "");
  }
  box.className = `rp-status-box ${status}`;
  box.innerHTML = `<i class="fa-solid ${icon}"></i><div>${html}</div>`;
  box.style.display = "";
}

// Przyciski zatwierdzania na dole okna raportu (zależne od stanu i uprawnień)
function rpRenderDetailActions(rep) {
  const el = document.getElementById("rp-detail-actions");
  if (!el) return;
  const n = Number(rep.number);
  const status = rpStatus(rep);
  const locked = rpLockedKeys.has(opPeriodKeyFromPl(rep.date));
  const approver = rpaCanApprove();
  const b = (cls, icon, text, onclick) =>
    `<button type="button" class="${cls}" style="width: auto; padding: 11px 20px;" onclick="${onclick}"><i class="fa-solid ${icon}"></i> ${text}</button>`;
  // W trybie edycji: przy raporcie do poprawy - zapis zmian i od razu ponowne wysłanie do zatwierdzenia;
  // pozostałe przyciski dopiero po zapisie (inaczej pominęłyby niezapisane zmiany)
  if (rpCurrent && rpCurrent.edit) {
    el.innerHTML = status === "rejected" && canModifyReport(rep.creatorId) && !locked
      ? b("btn-primary", "fa-paper-plane", "Zapisz i wyślij do zatwierdzenia", "rpSaveAndResubmit()")
      : "";
    return;
  }
  let html = "";
  if (status === "pending" && approver) {
    html += b("btn-danger", "fa-reply", "Odeślij do poprawy", `rpOpenAction('reject', ${n})`);
    html += b("btn-primary rp-btn-approve", "fa-check", "Zatwierdź", `rpApprove([${n}])`);
  }
  if (status === "rejected" && canModifyReport(rep.creatorId) && !locked) {
    html += b("btn-primary", "fa-paper-plane", "Wyślij ponownie do zatwierdzenia", `rpOpenAction('resubmit', ${n})`);
  }
  if (status === "approved" && approver && !locked) {
    html += b("btn-secondary", "fa-lock-open", "Cofnij zatwierdzenie", `rpOpenAction('unapprove', ${n})`);
  }
  el.innerHTML = html;
}

// ---------- Zmiana daty raportu ----------
// Nowa data jest tylko zapamiętywana; do bazy trafia razem z resztą zmian
// po kliknięciu "Zapisz zmiany" (rpSaveAll).
function rpIsoDate(plDate) {
  const [dd, mm, yyyy] = String(plDate || "").split(".");
  return `${yyyy}-${mm}-${dd}`;
}

function rpOnDateChange() {
  const rep = rpCurrent && rpFindReport(rpCurrent.number);
  const input = document.getElementById("rp-edit-date");
  if (!rep || !input) return;

  rpDateEdit = input.value && input.value !== rpIsoDate(rep.date) ? input.value : null;
  input.classList.toggle("rp-dirty-field", !!rpDateEdit);
  rpHideDetailMsg();
  rpSyncSaveAll();
}

// Sprawdza, czy raport można przenieść na nowy dzień. Zwraca nową datę (dd.mm.rrrr)
// albo null, gdy przeniesienie jest niedozwolone (komunikat jest już pokazany):
//  - nowy miesiąc jest zablokowany,
//  - autor ma już inny raport na nowy dzień i tę samą zmianę (jeden raport na autora, dzień i zmianę),
//  - któryś pracownik ma w nowym dniu i tej zmianie nakładające się godziny w innym raporcie.
async function rpValidateDateChange(rep, iso) {
  const newDate = rtIsoToPl(iso);

  const newKey = iso.slice(0, 7);
  if (await opIsLocked(newKey)) {
    rpShowDetailMsg(`Miesiąc ${opMonthLabel(newKey)} jest zablokowany. Nie można przenieść do niego raportu.`);
    return null;
  }

  // Wpisy innych raportów na nowy dzień i tę samą zmianę
  const { data: existing, error } = await supabaseClient
    .from("work_reports")
    .select("number_report, add_first_name_id, first_name_id, start_time, end_time")
    .eq("report_date", newDate)
    .eq("shift", rep.shift)
    .neq("number_report", rep.number);
  if (error) throw error;

  const sameAuthor = (existing || []).find(o => Number(o.add_first_name_id) === Number(rep.creatorId));
  if (sameAuthor) {
    rpShowDetailMsg(`${rpUserName(rep.creatorId)} ma już raport nr ${sameAuthor.number_report} na ${newDate} (${rep.shift}). Na jeden dzień i zmianę może być tylko jeden raport tej osoby. Nic nie zostało zapisane.`);
    return null;
  }

  for (const row of rep.rows) {
    // godziny po uwzględnieniu niezapisanych zmian w tym wierszu
    const v = rpRowValues(row);
    if (!v.from || !v.to) continue;
    const mine = rtRange(v.from, v.to);
    const clash = (existing || []).find(o =>
      Number(o.first_name_id) === Number(row.first_name_id) &&
      o.start_time && o.end_time && rtOverlap(mine, rtRange(o.start_time, o.end_time)));
    if (clash) {
      rpShowDetailMsg(`${rpEmpName(row.first_name_id)} ma już w dniu ${newDate} wpis w raporcie nr ${clash.number_report} w godzinach ${clash.start_time}–${clash.end_time}. Nic nie zostało zapisane.`);
      return null;
    }
  }

  return newDate;
}

// Godziny do wyboru ograniczone do zmiany raportu; "do" musi być późniejsze niż "od".
// Zwraca { top, rest }: najczęstsze (początek, połowa i koniec zmiany) i pozostałe.
function rpShiftTimeChoices(shift, which, from, to) {
  const selected = which === "from" ? from : to;
  const idx = RT_SHIFT_NAMES.indexOf(shift);
  if (idx < 0) {
    // raport z nieznaną zmianą — bez ograniczeń
    return { top: RT_TOP_TIMES.slice(), rest: RT_OTHER_TIMES.slice() };
  }

  const start = RT_SHIFT_BASE + idx * RT_SHIFT_LEN;
  const slots = RT_SHIFT_LEN / 30;
  const slot = t => ((rtToMin(t) - start + 1440) % 1440) / 30;
  const inShift = (t, isTo) => {
    if (!RT_ALL_TIMES.includes(t)) return false;
    const k = slot(t);
    return isTo ? k >= 1 && k <= slots : k <= slots - 1;
  };

  // Godzina drugiego pola zawęża wybór tylko wtedy, gdy sama mieści się w zmianie
  const min = which === "to" ? (inShift(from, false) ? slot(from) + 1 : 1) : 0;
  const max = which === "from" ? (inShift(to, true) ? slot(to) - 1 : slots - 1) : slots;

  const top = [], rest = [];
  for (let k = min; k <= max; k++) {
    const t = RT_ALL_TIMES[((start + k * 30) % 1440) / 30];
    (k % 8 === 0 ? top : rest).push(t);
  }
  // Zapisana wcześniej godzina spoza zmiany zostaje do wyboru, dopóki nie zostanie zmieniona
  if (selected && !top.includes(selected) && !rest.includes(selected)) rest.unshift(selected);
  return { top, rest };
}

// Pole godziny (przycisk z okienkiem wyboru); wartość w data-value
function rpTimeBtnHtml(id, which, value, cls, onclick) {
  return `<button type="button" class="rt-time ${cls}${value ? "" : " empty"}" id="${id}" data-value="${rtEsc(value || "")}"
    aria-label="${which === "from" ? "Od" : "Do"}" aria-haspopup="dialog" aria-expanded="false"
    onclick="${onclick}">${rtEsc(value || "--:--")}</button>`;
}

function rpTimeVal(id) {
  return document.getElementById(id)?.dataset.value || "";
}

function rpSetTimeVal(id, value) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.dataset.value = value || "";
  btn.textContent = value || "--:--";
  btn.classList.toggle("empty", !value);
}

// Wiersz edytowanego raportu: okienko wyboru "Od"/"Do"
function rpOpenRowTime(recordId, which) {
  const found = rpFindRow(recordId);
  if (!found) return;
  const btnId = `rp-row-${which}-${recordId}`;
  const from = rpTimeVal(`rp-row-from-${recordId}`);
  const to = rpTimeVal(`rp-row-to-${recordId}`);
  const { top, rest } = rpShiftTimeChoices(found.rep.shift, which, from, to);
  rtPickerOpen(document.getElementById(btnId), {
    key: `rp|${recordId}|${which}`,
    label: which === "from" ? "Od" : "Do",
    name: rpEmpName(found.row.first_name_id),
    top, rest,
    value: which === "from" ? from : to,
    clearable: false,          // zapisany wiersz musi mieć obie godziny
    emptyText: `Brak godzin do wyboru — zmień godzinę „${which === "from" ? "Do" : "Od"}”.`,
    onPick: value => {
      rpSetTimeVal(btnId, value);
      rpOnRowTime(recordId);
      document.getElementById(btnId)?.focus();
    }
  });
}

// Formularz "Dodaj pracownika": okienko wyboru "Od"/"Do"
function rpOpenAddTime(which) {
  const rep = rpCurrent && rpFindReport(rpCurrent.number);
  if (!rep) return;
  const btnId = `rp-add-${which}`;
  const from = rpTimeVal("rp-add-from");
  const to = rpTimeVal("rp-add-to");
  const { top, rest } = rpShiftTimeChoices(rep.shift, which, from, to);
  const emp = rpEmpById[rpAddEmpId];
  rtPickerOpen(document.getElementById(btnId), {
    key: `rp-add|${which}`,
    label: which === "from" ? "Od" : "Do",
    name: emp ? rpEmpName(emp.id) : "",
    top, rest,
    value: which === "from" ? from : to,
    emptyText: `Brak godzin do wyboru — zmień godzinę „${which === "from" ? "Do" : "Od"}”.`,
    onPick: value => {
      rpSetTimeVal(btnId, value);
      // po wybraniu "Od" od razu wybór "Do" (jeśli jeszcze puste)
      if (which === "from" && value && !rpTimeVal("rp-add-to")) rpOpenAddTime("to");
      else document.getElementById(btnId)?.focus();
    }
  });
}

function rpResetAddTimes() {
  rpSetTimeVal("rp-add-from", "");
  rpSetTimeVal("rp-add-to", "");
}

// ---------- Zmiana godzin i statusu pracowników w raporcie ----------
function rpFindRow(recordId) {
  const rep = rpCurrent && rpFindReport(rpCurrent.number);
  const row = rep && rep.rows.find(r => Number(r.id) === Number(recordId));
  return row ? { rep, row } : null;
}

// Wartości wiersza w oknie edycji: niezapisana zmiana albo stan z bazy
function rpRowValues(row) {
  return rpRowEdits[row.id] ||
    { from: row.start_time || "", to: row.end_time || "", absent: row.at_work === false };
}

// Niezapisane zmiany, które nadal dotyczą wierszy tego raportu
function rpPendingEdits(rep) {
  return rep.rows
    .filter(r => rpRowEdits[r.id])
    .map(r => ({ row: r, ...rpRowEdits[r.id] }));
}

function rpSyncSaveAll() {
  const btn = document.getElementById("rp-save-all");
  const rep = rpCurrent && rpFindReport(rpCurrent.number);
  if (!btn) return;
  // zmienione wiersze + ewentualna zmiana daty raportu
  const count = rep && rpCurrent.edit ? rpPendingEdits(rep).length + (rpDateEdit ? 1 : 0) : 0;

  // raport do poprawy zapisuje się przyciskiem "Zapisz i wyślij" (rpRenderDetailActions)
  btn.style.display = rpCurrent && rpCurrent.edit && !(rep && rpStatus(rep) === "rejected") ? "" : "none";
  btn.disabled = count === 0 || rpBusy;
  btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> ${count ? `Zapisz zmiany (${count})` : "Zapisz zmiany"}`;
}

// Po zmianie godziny lub suwaka: przelicz listy i sumę, zapamiętaj zmianę do zapisu
function rpOnRowTime(recordId) {
  const found = rpFindRow(recordId);
  const fromSel = document.getElementById(`rp-row-from-${recordId}`);
  const toSel = document.getElementById(`rp-row-to-${recordId}`);
  if (!found || !fromSel || !toSel) return;

  const from = fromSel.dataset.value || "";
  const to = toSel.dataset.value || "";
  const absent = !!document.getElementById(`rp-row-absent-${recordId}`)?.checked;

  const hours = rtDuration(from, to);
  const sum = document.getElementById(`rp-row-sum-${recordId}`);
  if (sum) sum.textContent = hours === null ? "—" : rtFmtHours(hours);

  const changed = from !== (found.row.start_time || "") || to !== (found.row.end_time || "") ||
    absent !== (found.row.at_work === false);
  if (changed) rpRowEdits[found.row.id] = { from, to, absent };
  else delete rpRowEdits[found.row.id];

  fromSel.closest("tr")?.classList.toggle("rp-dirty", changed);
  rpSyncSaveAll();
}

// Zapis wszystkich zmienionych wierszy raportu jednym przyciskiem
async function rpSaveAll() {
  const rep = rpCurrent && rpFindReport(rpCurrent.number);
  if (!rep || rpBusy || !rpCanEdit(rep)) return;

  const edits = rpPendingEdits(rep);
  const dateIso = rpDateEdit;
  if (edits.length === 0 && !dateIso) return;

  if (edits.some(e => rtDuration(e.from, e.to) === null)) {
    rpShowDetailMsg("W każdym zmienionym wierszu wybierz godziny od i do.");
    return;
  }

  rpBusy = true;
  rpSyncSaveAll();
  rpHideDetailMsg();

  try {
    if (await rpBlockedByLock(rep.date, rpShowDetailMsg)) return;

    // Najpierw wszystkie kontrole, dopiero potem zapisy - żeby nie zapisać połowy zmian.
    // 1. Zmiana daty: blokada nowego miesiąca, inny raport autora, kolizje godzin w nowym dniu
    let newDate = null;
    if (dateIso) {
      newDate = await rpValidateDateChange(rep, dateIso);
      if (!newDate) return;
    }
    const effectiveDate = newDate || rep.date;

    // 2. Nowe godziny nie mogą nakładać się na inne wpisy tej samej osoby w tym dniu i zmianie
    let existing = [];
    if (edits.length) {
      const empIds = [...new Set(edits.map(e => e.row.first_name_id))];
      const { data: found, error: checkErr } = await supabaseClient
        .from("work_reports")
        .select("id, number_report, first_name_id, start_time, end_time")
        .eq("report_date", effectiveDate)
        .eq("shift", rep.shift)
        .in("first_name_id", empIds);
      if (checkErr) throw checkErr;
      existing = found || [];
    }

    for (const e of edits) {
      const mine = rtRange(e.from, e.to);
      const clash = (existing || []).find(o => {
        if (Number(o.id) === Number(e.row.id) || Number(o.first_name_id) !== Number(e.row.first_name_id)) return false;
        // inny wpis tej osoby też może być właśnie zmieniany — porównuj z jego nowymi godzinami
        const other = rpRowEdits[o.id] ? { start: rpRowEdits[o.id].from, end: rpRowEdits[o.id].to }
          : { start: o.start_time, end: o.end_time };
        return other.start && other.end && rtOverlap(mine, rtRange(other.start, other.end));
      });
      if (clash) {
        rpShowDetailMsg(`${rpEmpName(e.row.first_name_id)}: godziny ${e.from}–${e.to} nakładają się na wpis w raporcie nr ${clash.number_report}. Nic nie zostało zapisane.`);
        return;
      }
    }

    // 3. Zapis daty (cały raport naraz)
    if (newDate) {
      const { data: moved, error: moveErr } = await supabaseClient
        .from("work_reports")
        .update({ report_date: newDate })
        .eq("number_report", rep.number)
        .select("id");
      if (moveErr) throw moveErr;
      if (!moved || moved.length === 0) {
        rpShowDetailMsg("Data nie została zmieniona (brak uprawnień w bazie). Nic nie zostało zapisane.");
        return;
      }
      rpDateEdit = null;

      // Lista pokazuje wybrany rok i miesiąc - przełącz ją na okres nowej daty, żeby raport nie zniknął
      const [newYear, newMonth] = dateIso.split("-");
      rpSetPeriod(Number(newYear), Number(newMonth));
    }

    // 4. Zapis godzin i statusów
    const failed = [];
    for (const e of edits) {
      const hours = rtDuration(e.from, e.to);
      const { data, error } = await supabaseClient
        .from("work_reports")
        .update({ start_time: e.from, end_time: e.to, total_hours: hours.toFixed(1), at_work: !e.absent })
        .eq("id", e.row.id)
        .select("id");

      if (error || !data || data.length === 0) {
        if (error) console.error("Błąd zapisu wiersza raportu:", error);
        failed.push(rpEmpName(e.row.first_name_id));
      } else {
        delete rpRowEdits[e.row.id];
      }
    }

    rpBusy = false;
    await rpReloadAfterEdit();

    if (failed.length) {
      rpShowDetailMsg(`Nie zapisano zmian dla: ${failed.join(", ")} (brak uprawnień w bazie lub wpis został usunięty).`);
    } else {
      logAction("Edycja raportu", `Raport nr ${rep.number}, ${rep.date}` +
        (newDate ? `, zmiana daty na ${newDate}` : "") +
        (edits.length ? `, zmienionych wierszy: ${edits.length}` : ""));
      rpCloseDetail();
      rpShowBanner("success", (newDate
        ? `Zapisano zmiany w raporcie nr ${rep.number}. Raport został przeniesiony z ${rep.date} na ${newDate}.`
        : `Zapisano zmiany w raporcie nr ${rpLabel(rep)}.`) +
        (rpStatus(rep) === "rejected" ? " Gdy raport jest już poprawiony, wyślij go ponownie do zatwierdzenia." : ""));
      return true;
    }
  } catch (err) {
    console.error("Błąd zapisu zmian w raporcie:", err);
    rpShowDetailMsg("Nie udało się zapisać zmian: " + (err.message || err));
  } finally {
    rpBusy = false;
    rpSyncSaveAll();
  }
}

// Raport do poprawy w trybie edycji: zapis zmian (jeśli są) i ponowne wysłanie do zatwierdzenia
async function rpSaveAndResubmit() {
  const rep = rpCurrent && rpFindReport(rpCurrent.number);
  if (!rep || rpBusy || rpStatus(rep) !== "rejected") return;
  const number = Number(rep.number);

  if (rpPendingEdits(rep).length || rpDateEdit) {
    // przy błędzie zapisu komunikat jest już w oknie, a raport nie zostaje wysłany
    if (!(await rpSaveAll())) return;
  }

  rpBusy = true;
  try {
    const { error } = await supabaseClient.rpc("app_report_resubmit", { p_number: number });
    if (error) throw error;
    rpaAdjust(1, -1);
    rpCloseDetail();
    rpShowBanner("success", `Raport nr ${number} został wysłany ponownie do zatwierdzenia.`);
  } catch (err) {
    console.error("Błąd ponownego wysłania raportu:", err);
    if (rpCurrent) rpShowDetailMsg("Nie udało się wysłać raportu do zatwierdzenia: " + (err.message || err));
    else rpShowBanner("warning", `Zmiany zapisano, ale nie udało się wysłać raportu nr ${number} do zatwierdzenia: ${err.message || err}`);
  } finally {
    rpBusy = false;
  }
  await rpReloadAfterEdit();
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
      <span class="name">${rtEsc(`${e.first_name || ""} ${e.last_name || ""}`.trim())}</span>
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
  if (!rep || rpBusy || !rpCanEdit(rep)) return;

  const from = rpTimeVal("rp-add-from");
  const to = rpTimeVal("rp-add-to");
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
    if (await rpBlockedByLock(rep.date, rpShowDetailMsg)) return;

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

    logAction("Dodanie pracownika do raportu",
      `Raport nr ${rep.number}, ${rep.date}: ${rpEmpName(emp.id)}, ${from}–${to}${absent ? " (nieobecność)" : ""}`);
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
