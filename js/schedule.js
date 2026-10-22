// ==========================================
// MODUŁ: HARMONOGRAM PRACY (schedule) - dzień po dniu
// Dane: tabela schedule_days (sql/26_harmonogram_dni.sql), jeden wpis na pracownika i dzień:
//   work    - praca w godzinach od–do
//   off     - wolne
//   absence - zgłoszona nieobecność (z powodem, np. urlop, L4)
// Widok: siatka pracownicy × dni tygodnia. Kratki zaznacza się kliknięciem, przeciąganiem,
// Ctrl+klik (dodaj/usuń) i Shift+klik (prostokąt); pasek na dole ustawia zaznaczone dni.
// Zmiany zapisują się od razu.
// Numer tygodnia jak na wykresie w pulpicie: tydzień 1 zaczyna się 1 stycznia, kolejne w poniedziałki.
// Wymaga: supabaseClient (app.js), rt* / RT_ALL_TIMES / rtPickerOpen (report_time.js),
//         dbWeekOfYear (dashboard.js), rpFetchAll (reports.js)
// Funkcje shWeek*, shParse i shDayIso są używane także w portalu pracownika i w Obecności.
// ==========================================

const SH_PRESETS = [
  { label: "I", from: "06:30", to: "14:30" },
  { label: "II", from: "14:30", to: "22:30" },
  { label: "III", from: "22:30", to: "06:30" }
];
const SH_DAY_SHORT = ["Pn", "Wt", "Śr", "Czw", "Pt", "Sob", "Niedz"];

let shEmployees = [];
let shYear = new Date().getFullYear();
let shWeek = 1;              // (zgodność) numer wybranego tygodnia
let shMonday = null;         // poniedziałek wybranego tygodnia
let shDays = [];             // [{ date, iso, pl, today, weekend }]
let shPlan = {};             // { [employeeId]: { [iso]: [wpisy wg slotu 1, 2] } } (wpis: { slot, kind, time_from, time_to, note })
let shSel = new Set();       // zaznaczone kratki "idPracownika|rrrr-mm-dd"
let shAnchor = null;         // początek zaznaczenia (Shift+klik, przeciąganie)
let shDragging = false;
let shLoadToken = 0;
let shBannerTimer = null;
let shBusy = false;
let shReadOnly = false;      // tabela schedule_days niedostępna (np. nie uruchomiono sql/26)


// ---------- Tygodnie ----------
function shWeekColumn(week) {
  return `week_${week}`;
}

function shWeeksInYear(year) {
  return dbWeekOfYear(year, 12, 31);
}

// Bieżący tydzień i rok
function shCurrentWeek() {
  const now = new Date();
  return { year: now.getFullYear(), week: dbWeekOfYear(now.getFullYear(), now.getMonth() + 1, now.getDate()) };
}

// Tydzień o delta wcześniej/później, z przejściem przez granicę roku
function shShiftWeek(year, week, delta) {
  let y = year, w = week + delta;
  while (w < 1) { y--; w += shWeeksInYear(y); }
  while (w > shWeeksInYear(y)) { w -= shWeeksInYear(y); y++; }
  return { year: y, week: w };
}

// Zakres dat tygodnia (pierwszy i ostatni tydzień roku są krótsze)
function shWeekRange(year, week) {
  const jan1 = new Date(year, 0, 1);
  const offset = (jan1.getDay() + 6) % 7; // poniedziałek = 0
  const start = new Date(year, 0, 1 + (week - 1) * 7 - offset);
  const end = new Date(year, 0, 1 + (week - 1) * 7 - offset + 6);
  const dec31 = new Date(year, 11, 31);
  return { from: start < jan1 ? jan1 : start, to: end > dec31 ? dec31 : end };
}

function shWeekLabel(year, week) {
  const { from, to } = shWeekRange(year, week);
  const p = n => String(n).padStart(2, "0");
  const d = dt => `${p(dt.getDate())}.${p(dt.getMonth() + 1)}`;
  return `${d(from)}–${d(to)}.${year}`;
}

// "6:30 - 14:30", "06:30-14:30", "6:30 14:30" -> { from: "06:30", to: "14:30" }; null = nie do odczytania
function shParse(text) {
  const m = String(text || "").match(/(\d{1,2})[:.](\d{2})\D+(\d{1,2})[:.](\d{2})/);
  if (!m) return null;
  const t = (h, min) => `${String(Number(h)).padStart(2, "0")}:${min}`;
  return { from: t(m[1], m[2]), to: t(m[3], m[4]) };
}

function shFormat(from, to) {
  return `${from} - ${to}`;
}

// Tekst do wyświetlenia: znormalizowane godziny albo oryginalny wpis, jeśli nie da się go odczytać
function shDisplay(text) {
  const parsed = shParse(text);
  if (parsed) return `${parsed.from} – ${parsed.to}`;
  return String(text || "").trim();
}

function shShowBanner(type, text) {
  const el = document.getElementById("sh-banner");
  if (!el) return;
  const icon = type === "success" ? "fa-circle-check" : "fa-triangle-exclamation";
  el.className = `sh-banner visible ${type}`;
  el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${rtEsc(text)}</span>`;
  clearTimeout(shBannerTimer);
  shBannerTimer = setTimeout(() => el.classList.remove("visible"), 8000);
}

// ---------- Dni ----------
function shDayIso(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shMondayOf(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay() + 6) % 7);
}

function shBuildDays(monday) {
  const todayIso = shDayIso(new Date());
  const p = n => String(n).padStart(2, "0");
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    const iso = shDayIso(date);
    return {
      date, iso,
      pl: `${p(date.getDate())}.${p(date.getMonth() + 1)}`,
      today: iso === todayIso,
      weekend: i >= 5
    };
  });
}

function shWeekTitle() {
  const m = shMonday;
  const s = shDays[6].date;
  const week = dbWeekOfYear(m.getFullYear(), m.getMonth() + 1, m.getDate());
  return `Tydzień ${week} • ${shDays[0].pl}–${shDays[6].pl}.${s.getFullYear()}`;
}

// ---------- Inicjalizacja ----------
async function initScheduleView() {
  shMonday = shMondayOf(new Date());
  shEmployees = [];
  shPlan = {};
  shSel = new Set();
  shAnchor = null;
  shResetCustomTimes();
  // prywatne listy pracowników (filtr "Moja lista"): osobno, błąd nie psuje widoku
  if (typeof rtlLoad === "function") rtlLoad().then(() => { if (shEmployees.length) shRenderTable(); });
  await shLoad();
}

function shStepWeek(delta) {
  shMonday = new Date(shMonday.getFullYear(), shMonday.getMonth(), shMonday.getDate() + 7 * delta);
  shSel.clear();
  shLoad();
}

function shGoToday() {
  shMonday = shMondayOf(new Date());
  shSel.clear();
  shLoad();
}

// ---------- Dane ----------
async function shLoad() {
  const tbody = document.getElementById("sh-table-body");
  if (!tbody) return;
  const token = ++shLoadToken;
  shDays = shBuildDays(shMonday);
  shWeek = dbWeekOfYear(shMonday.getFullYear(), shMonday.getMonth() + 1, shMonday.getDate());
  shYear = shMonday.getFullYear();

  const label = document.getElementById("sh-week-label");
  if (label) label.textContent = shWeekTitle();
  const todayBtn = document.getElementById("sh-today");
  if (todayBtn) todayBtn.disabled = shDays.some(d => d.today);

  try {
    const [employees, plan] = await Promise.all([
      shEmployees.length ? shEmployees : rpFetchAll(() => supabaseClient
        .from("employees")
        .select(`
          id, first_name, last_name, business_id, department_id,
          business:business_id ( business ),
          department:department_id ( department )
        `)
        .eq("active", true)),
      rpFetchAll(() => supabaseClient
        .from("schedule_days")
        .select("*")
        .gte("day", shDays[0].iso)
        .lte("day", shDays[6].iso))
        .then(rows => ({ rows }), error => ({ error }))
    ]);
    if (token !== shLoadToken) return; // w międzyczasie zmieniono tydzień

    shEmployees = employees.sort((a, b) =>
      `${a.first_name || ""} ${a.last_name || ""}`.localeCompare(`${b.first_name || ""} ${b.last_name || ""}`, "pl"));

    shPlan = {};
    shReadOnly = !!plan.error;
    if (plan.error) {
      console.error("Błąd pobierania harmonogramu dziennego:", plan.error);
      shShowBanner("warning", "Nie udało się pobrać harmonogramu: " + (plan.error.message || plan.error) +
        ". Jeśli to pierwsze użycie, administrator musi uruchomić w Supabase skrypt sql/26_harmonogram_dni.sql.");
    } else {
      plan.rows.forEach(r => {
        shPlanAdd(r);
      });
      // bez kolumny "slot" (nie uruchomiono sql/30) zapis mógłby skasować wpisy - tylko podgląd
      const { error: slotErr } = await supabaseClient.from("schedule_days").select("slot").limit(1);
      if (token !== shLoadToken) return;
      if (slotErr) {
        shReadOnly = true;
        shShowBanner("warning", "Harmonogram jest tylko do podglądu: administrator musi uruchomić w Supabase skrypt sql/30_harmonogram_dwie_zmiany.sql.");
      }
    }

    shFillFilters();
    shRenderTable();
  } catch (err) {
    if (token !== shLoadToken) return;
    console.error("Błąd pobierania harmonogramu:", err);
    shEmployees = [];
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--danger);padding:25px;">
      Nie udało się pobrać pracowników: ${rtEsc(err.message || err)}</td></tr>`;
  }
}

// Listy firm i działów z pobranych pracowników (zachowują wybór przy zmianie tygodnia)
function shFillFilters() {
  const fill = (id, label, pairs) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    const sorted = [...pairs.entries()].sort((a, b) => a[1].localeCompare(b[1], "pl"));
    sel.innerHTML = `<option value="">${label}</option>` +
      sorted.map(([value, name]) => `<option value="${rtEsc(value)}">${rtEsc(name)}</option>`).join("");
    if (sorted.some(([value]) => String(value) === prev)) sel.value = prev;
  };

  const biz = new Map(), dept = new Map();
  shEmployees.forEach(e => {
    if (e.business_id != null) biz.set(String(e.business_id), e.business?.business || `Firma #${e.business_id}`);
    if (e.department_id != null) dept.set(String(e.department_id), e.department?.department || `Dział #${e.department_id}`);
  });
  fill("sh-filter-business", "Wszystkie firmy", biz);
  fill("sh-filter-dept", "Wszystkie działy", dept);
}

function shVisibleEmployees() {
  const q = (document.getElementById("sh-filter-search")?.value || "").toLowerCase().trim();
  const biz = document.getElementById("sh-filter-business")?.value;
  const dept = document.getElementById("sh-filter-dept")?.value;
  const listSet = typeof rtlFilterSet === "function" ? rtlFilterSet() : null; // prywatna lista (emp_lists.js)

  return shEmployees.filter(e => {
    const n1 = `${e.first_name || ""} ${e.last_name || ""}`.toLowerCase();
    const n2 = `${e.last_name || ""} ${e.first_name || ""}`.toLowerCase();
    return (!q || n1.includes(q) || n2.includes(q)) &&
      (!biz || String(e.business_id) === biz) &&
      (!dept || String(e.department_id) === dept) &&
      (!listSet || listSet.has(Number(e.id)));
  });
}

function shResetFilters() {
  ["sh-filter-search", "sh-filter-business", "sh-filter-dept", "sh-filter-list"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  shRenderTable();
}

// ---------- Wpisy ----------
// Wpisy dnia (1 albo 2, według slotu); null = nic nie zaplanowano
function shEntry(empId, iso) {
  const list = (shPlan[empId] || {})[iso];
  return list && list.length ? list : null;
}

function shPlanAdd(r) {
  const byDay = shPlan[r.employee_id] || (shPlan[r.employee_id] = {});
  const list = (byDay[r.day] || []).filter(x => (x.slot || 1) !== (r.slot || 1));
  list.push(r);
  byDay[r.day] = list.sort((a, b) => (a.slot || 1) - (b.slot || 1));
}

// Czy dwa wpisy nakładają się w czasie (brak godzin = cały dzień)
function shOverlaps(a, b) {
  if (!a.time_from || !a.time_to || !b.time_from || !b.time_to) return true;
  return rtOverlap(rtRange(a.time_from, a.time_to), rtRange(b.time_from, b.time_to));
}

// Krótka nazwa wpisu: I / II / III / Nieob. / Wolne
function shEntryLabel(e) {
  if (e.kind === "off") return "Wolne";
  if (e.kind === "absence") return "Nieob.";
  const preset = SH_PRESETS.find(p => p.from === e.time_from && p.to === e.time_to);
  return preset ? preset.label : (shShiftLabel(e.time_from) || e.time_from);
}

// Zmiana (I, II, III), do której należą godziny - liczona od godziny "od" (np. 02:30–06:30 -> III)
function shShiftLabel(from) {
  const name = typeof rtShiftOf === "function" && from ? rtShiftOf(from, "from") : "";
  return name ? name.replace("Zmiana ", "") : "";
}

// Wygląd kratki dnia (lista wpisów): { cls, main, sub, title }
function shEntryView(list) {
  if (!list || !list.length) return { cls: "empty", main: "+", sub: "", title: "Nic nie zaplanowano" };
  if (list.length === 1) return shSingleView(list[0]);

  // dwa wpisy: np. "I+II", pod spodem łączne godziny (gdy się stykają) albo "2 zmiany"
  const views = list.map(shSingleView);
  const [a, b] = list;
  const joined = a.time_to && b.time_from && a.time_to === b.time_from;
  const anyAbsence = list.some(e => e.kind === "absence");
  return {
    cls: anyAbsence ? (list.every(e => e.kind === "absence") ? "absence" : "work mixed") : "work two",
    main: list.map(shEntryLabel).join("+"),
    sub: joined ? `${a.time_from}–${b.time_to}` : "2 wpisy",
    title: views.map(v => v.title).join(" • ")
  };
}

// Wygląd jednego wpisu
function shSingleView(e) {
  if (e.kind === "off") return { cls: "off", main: "Wolne", sub: "", title: "Wolne" };
  if (e.kind === "absence") {
    const hours = e.time_from && e.time_to ? `${e.time_from}–${e.time_to}` : "";
    return { cls: "absence", main: "Nieob.", sub: hours || e.note || "", title: `Zgłoszona nieobecność${e.note ? ": " + e.note : ""}${hours ? ", godz. " + hours : ""}` };
  }
  const preset = SH_PRESETS.find(p => p.from === e.time_from && p.to === e.time_to);
  if (preset) {
    return { cls: "work", main: preset.label, sub: `${e.time_from}–${e.time_to}`, title: `Zmiana ${preset.label}: ${e.time_from}–${e.time_to}` };
  }
  // inne godziny niż pełna zmiana: zmiana na górze, godziny pod spodem (pogrubione)
  const shift = shShiftLabel(e.time_from);
  return {
    cls: "work custom",
    main: shift || e.time_from,
    sub: shift ? `${e.time_from}–${e.time_to}` : e.time_to,
    title: `${shift ? `Zmiana ${shift}, inne godziny: ` : "Praca "}${e.time_from}–${e.time_to}`
  };
}

// Kratka = pracownik + dzień + zmiana (slot 1 albo 2)
function shKey(empId, iso, slot) {
  return `${empId}|${iso}|${slot || 1}`;
}

function shParseKey(k) {
  const [emp, iso, slot] = k.split("|");
  return { emp: Number(emp), iso, slot: Number(slot) || 1 };
}

// Wpis w danym slocie dnia (albo null)
function shSlotEntry(empId, iso, slot) {
  return (shEntry(empId, iso) || []).find(e => (e.slot || 1) === slot) || null;
}

// Wygląd kratki jednej zmiany
function shSlotView(empId, iso, slot) {
  const e = shSlotEntry(empId, iso, slot);
  if (e) return shSingleView(e);
  // "wolne" w pierwszej zmianie obejmuje cały dzień
  const first = shSlotEntry(empId, iso, 1);
  if (slot === 2 && first && first.kind === "off") return { cls: "empty off2", main: "", sub: "", title: "Wolne (cały dzień)" };
  return slot === 1
    ? { cls: "empty", main: "+", sub: "", title: "1. zmiana: nic nie zaplanowano" }
    : { cls: "empty s2", main: "+", sub: "", title: "2. zmiana: nic nie zaplanowano" };
}

// ---------- Tabela ----------
// Każdy dzień ma dwie kratki: u góry 1. zmiana, pod nią 2. zmiana
function shCellBtn(emp, day, r, c, slot) {
  const id = Number(emp.id);
  const v = shSlotView(id, day.iso, slot);
  const sel = shSel.has(shKey(id, day.iso, slot));
  return `<button type="button" class="sh-cell slot${slot} ${v.cls}${sel ? " sel" : ""}" data-emp="${id}" data-iso="${day.iso}" data-slot="${slot}"
      data-r="${r * 2 + slot - 1}" data-c="${c}"
      title="${rtEsc(v.title)}" aria-pressed="${sel}" aria-label="${rtEsc(`${emp.first_name || ""} ${emp.last_name || ""}, ${SH_DAY_SHORT[c]} ${day.pl}, ${slot}. zmiana: ${v.title}`)}"
      onmousedown="shCellDown(event, this)" onmouseenter="shCellEnter(this)" onclick="shCellClick(event, this)">
      <span class="m">${rtEsc(v.main)}</span>${v.sub ? `<span class="s">${rtEsc(v.sub)}</span>` : ""}
    </button>`;
}

function shCellHtml(emp, day, r, c) {
  return `<td class="sh-day-td${day.weekend ? " we" : ""}${day.today ? " today" : ""}">
    <div class="sh-pair">${shCellBtn(emp, day, r, c, 1)}${shCellBtn(emp, day, r, c, 2)}</div></td>`;
}

function shRowHtml(emp, r) {
  const id = Number(emp.id);
  const hasMonday = !!shEntry(id, shDays[0].iso);
  return `
    <tr id="sh-row-${id}">
      <td class="sh-name"><button type="button" class="sh-name-btn" title="Zaznacz 1. zmianę na cały tydzień (Ctrl - dodaj do zaznaczenia)"
        onclick="shSelectRow(event, ${id})">${rtEsc(`${emp.first_name || ""} ${emp.last_name || ""}`.trim())}</button></td>
      <td><span class="sh-biz">${rtEsc(emp.business?.business || "-")}</span></td>
      <td class="sh-dept">${rtEsc(emp.department?.department || "-")}</td>
      ${shDays.map((d, c) => shCellHtml(emp, d, r, c)).join("")}
      <td class="sh-tools">
        <button type="button" class="sh-tool" ${hasMonday && !shReadOnly ? "" : "disabled"} onclick="shCopyMonday(${id})"
          title="${hasMonday ? "Wtorek–piątek tak jak poniedziałek, obie zmiany (nadpisuje)" : "Najpierw ustaw poniedziałek"}">Pn → Pt</button>
      </td>
    </tr>`;
}

function shRenderTable() {
  const tbody = document.getElementById("sh-table-body");
  const head = document.getElementById("sh-head-row");
  if (!tbody) return;
  const list = shVisibleEmployees();

  if (head) {
    head.innerHTML = `
      <th>Pracownik</th><th>Firma</th><th>Dział</th>
      ${shDays.map((d, c) => `<th class="sh-day-th${d.weekend ? " we" : ""}${d.today ? " today" : ""}">
        <button type="button" class="sh-col-btn" title="Zaznacz 1. zmianę tego dnia u wszystkich widocznych (Ctrl - dodaj)" onclick="shSelectColumn(event, ${c})">
          <b>${SH_DAY_SHORT[c]}</b><span>${d.pl}</span></button></th>`).join("")}
      <th></th>`;
  }

  // licznik: ile osób ma zaplanowany choć jeden dzień
  const planned = shEmployees.filter(e => shDays.some(d => shEntry(e.id, d.iso))).length;
  const info = document.getElementById("sh-info");
  if (info) info.textContent = `Zaplanowano: ${planned} z ${shEmployees.length} pracowników`;

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--text-muted);padding:30px;">
      Brak pracowników spełniających podane kryteria.</td></tr>`;
  } else {
    tbody.innerHTML = list.map(shRowHtml).join("");
  }
  // zaznaczenie tylko wśród widocznych
  const visible = new Set(list.map(e => String(e.id)));
  [...shSel].forEach(k => { if (!visible.has(k.split("|")[0])) shSel.delete(k); });
  shSyncBar();
}

// Odświeża kratki bez przebudowy całej tabeli
function shRefreshCells() {
  document.querySelectorAll("#sh-table-body .sh-cell").forEach(btn => {
    const id = Number(btn.dataset.emp);
    const slot = Number(btn.dataset.slot) || 1;
    const v = shSlotView(id, btn.dataset.iso, slot);
    const sel = shSel.has(shKey(id, btn.dataset.iso, slot));
    btn.className = `sh-cell slot${slot} ${v.cls}${sel ? " sel" : ""}`;
    btn.title = v.title;
    btn.setAttribute("aria-pressed", String(sel));
    btn.innerHTML = `<span class="m">${rtEsc(v.main)}</span>${v.sub ? `<span class="s">${rtEsc(v.sub)}</span>` : ""}`;
  });
  shSyncBar();
}

// ---------- Zaznaczanie ----------
// Mysz: klik = jedna kratka, przeciąganie = prostokąt, Ctrl/Cmd+klik = dodaj/usuń, Shift+klik = prostokąt od ostatniej.
// Dotyk: stuknięcie dodaje/usuwa kratkę. Klawiatura: Enter/Spacja dodaje/usuwa.
const shTouch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;

function shBtnKey(btn) {
  return shKey(btn.dataset.emp, btn.dataset.iso, Number(btn.dataset.slot) || 1);
}

function shCellsInRect(a, b) {
  const r1 = Math.min(a.r, b.r), r2 = Math.max(a.r, b.r);
  const c1 = Math.min(a.c, b.c), c2 = Math.max(a.c, b.c);
  return [...document.querySelectorAll("#sh-table-body .sh-cell")].filter(btn => {
    const r = Number(btn.dataset.r), c = Number(btn.dataset.c);
    return r >= r1 && r <= r2 && c >= c1 && c <= c2;
  });
}

function shPos(btn) {
  return { r: Number(btn.dataset.r), c: Number(btn.dataset.c) };
}

function shToggle(btn) {
  const k = shBtnKey(btn);
  if (shSel.has(k)) shSel.delete(k); else shSel.add(k);
}

function shCellDown(e, btn) {
  if (e.button !== 0 || shTouch) return;
  e.preventDefault();               // bez zaznaczania tekstu przy przeciąganiu
  btn.focus();
  const pos = shPos(btn);
  if (e.ctrlKey || e.metaKey) {
    shToggle(btn);
    shAnchor = pos;
  } else if (e.shiftKey && shAnchor) {
    shSel.clear();
    shCellsInRect(shAnchor, pos).forEach(b => shSel.add(shBtnKey(b)));
  } else {
    shSel.clear();
    shSel.add(shBtnKey(btn));
    shAnchor = pos;
    shDragging = true;
  }
  shRefreshCells();
}

function shCellEnter(btn) {
  if (!shDragging || !shAnchor) return;
  shSel.clear();
  shCellsInRect(shAnchor, shPos(btn)).forEach(b => shSel.add(shBtnKey(b)));
  shRefreshCells();
}

// Klik z klawiatury (Enter/Spacja, detail = 0) albo stuknięcie na dotyku: dodaj/usuń kratkę
function shCellClick(e, btn) {
  if (e.detail !== 0 && !shTouch) return;   // mysz obsłużył już mousedown
  shToggle(btn);
  shAnchor = shPos(btn);
  shRefreshCells();
}

document.addEventListener("mouseup", () => { shDragging = false; });

// Klik w nazwisko: 1. zmiana na cały tydzień
function shSelectRow(e, id) {
  if (!(e.ctrlKey || e.metaKey)) shSel.clear();
  const keys = shDays.map(d => shKey(id, d.iso, 1));
  const all = keys.every(k => shSel.has(k));
  keys.forEach(k => { if (all) shSel.delete(k); else shSel.add(k); });
  shRefreshCells();
}

// Klik w nagłówek dnia: 1. zmiana tego dnia u wszystkich widocznych
function shSelectColumn(e, c) {
  if (!(e.ctrlKey || e.metaKey)) shSel.clear();
  const keys = shVisibleEmployees().map(emp => shKey(emp.id, shDays[c].iso, 1));
  const all = keys.length && keys.every(k => shSel.has(k));
  keys.forEach(k => { if (all) shSel.delete(k); else shSel.add(k); });
  shRefreshCells();
}

function shClearSelection() {
  shSel.clear();
  shAnchor = null;
  shRefreshCells();
}

// ---------- Pasek akcji ----------
function shSyncBar() {
  const n = shSel.size;
  const count = document.getElementById("sh-sel-count");
  if (count) {
    count.innerHTML = n
      ? `Zaznaczono: <strong>${n}</strong> ${n === 1 ? "kratkę" : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "kratki" : "kratek")}`
      : `Zaznacz dni w tabeli: klik, przeciągnij albo Ctrl+klik`;
  }
  document.querySelectorAll("#sh-actions [data-needs-sel]").forEach(b => { b.disabled = !n || shBusy || shReadOnly; });
  const custom = document.getElementById("sh-act-custom");
  if (custom) custom.disabled = !n || shBusy || shReadOnly || !shCustomValid();
}

// Własne godziny w pasku: dwa pola z okienkiem kafelków (jak w Rozliczeniu czasu)
function shCustomVal(which) {
  return document.getElementById(`sh-act-${which}`)?.dataset.value || "";
}

function shCustomValid() {
  const f = shCustomVal("from"), t = shCustomVal("to");
  return !!(f && t && f !== t);
}

function shResetCustomTimes() {
  ["from", "to"].forEach(w => {
    const b = document.getElementById(`sh-act-${w}`);
    if (b) { b.dataset.value = ""; b.textContent = "--:--"; b.classList.add("empty"); }
  });
}

function shOpenCustomTime(which) {
  const btn = document.getElementById(`sh-act-${which}`);
  const other = shCustomVal(which === "from" ? "to" : "from");
  const filter = t => t !== other;
  rtPickerOpen(btn, {
    key: `sh|${which}`,
    label: which === "from" ? "Od" : "Do",
    name: "własne godziny",
    top: RT_TOP_TIMES.filter(filter),
    rest: RT_OTHER_TIMES.filter(filter),
    value: shCustomVal(which),
    onPick: value => {
      btn.dataset.value = value || "";
      btn.textContent = value || "--:--";
      btn.classList.toggle("empty", !value);
      shSyncBar();
      if (which === "from" && value && !shCustomVal("to")) shOpenCustomTime("to");
      else btn.focus();
    }
  });
}

// Akcje paska: "I" / "II" / "III" / "custom" / "off" / "absence" / "clear"
function shAction(kind) {
  if (kind === "clear") return shApply(null, "wyczyszczono");
  if (kind === "off") return shApply({ kind: "off" }, "wolne");
  if (kind === "absence") {
    const note = (document.getElementById("sh-act-note")?.value || "").trim().slice(0, 80);
    return shApply({ kind: "absence", note: note || null }, `zgłoszona nieobecność${note ? " (" + note + ")" : ""}`);
  }
  if (kind === "custom") {
    if (!shCustomValid()) return;
    const f = shCustomVal("from"), t = shCustomVal("to");
    return shApply({ kind: "work", time_from: f, time_to: t }, `${f}–${t}`);
  }
  const p = SH_PRESETS.find(x => x.label === kind);
  if (p) return shApply({ kind: "work", time_from: p.from, time_to: p.to }, `zmiana ${p.label} ${p.from}–${p.to}`);
}

// ---------- Zapis ----------
// entry = { kind, time_from?, time_to?, note? } albo null (wyczyść); keys = kratki (domyślnie zaznaczone).
// Każda kratka to jedna zmiana dnia (slot 1 albo 2). "Wolne" obejmuje cały dzień (obie zmiany).
// Zmiana, która nakładałaby się na drugą zmianę tego dnia, jest pomijana.
async function shApply(entry, label, keys) {
  const targets = (keys || [...shSel]).map(shParseKey);
  if (!targets.length || shBusy || shReadOnly) return false;

  // stan dni po zmianie: { "emp|iso": { emp, iso, slots: { 1: wpis, 2: wpis } } }
  const days = new Map();
  const dayOf = t => {
    const k = `${t.emp}|${t.iso}`;
    if (!days.has(k)) {
      const slots = {};
      (shEntry(t.emp, t.iso) || []).forEach(e => { slots[e.slot || 1] = shCopyEntry(e); });
      days.set(k, { emp: t.emp, iso: t.iso, slots });
    }
    return days.get(k);
  };

  let skipped = 0;
  targets.sort((a, b) => a.slot - b.slot).forEach(t => {
    const d = dayOf(t);
    if (!entry) {
      delete d.slots[t.slot];
      return;
    }
    if (entry.kind === "off") {
      d.slots = { 1: { ...entry } };            // wolne = cały dzień
      return;
    }
    const other = d.slots[t.slot === 1 ? 2 : 1];
    if (other && other.kind === "off") {
      delete d.slots[t.slot === 1 ? 2 : 1];     // praca / nieobecność zastępuje "wolne"
    } else if (other && shOverlaps(other, entry)) {
      skipped++;                                // nakładałaby się na drugą zmianę
      return;
    }
    d.slots[t.slot] = { ...entry };
  });

  const changes = [...days.values()].map(d => ({
    emp: d.emp,
    iso: d.iso,
    entries: [1, 2].filter(s => d.slots[s]).map(s => ({ ...d.slots[s], slot: s }))
  }));
  const ok = await shSetDays(changes, label);
  if (skipped) {
    shShowBanner("warning", `Pominięto ${skipped} ${skipped === 1 ? "kratkę" : "kratek"}: zmiana nakładałaby się na drugą zmianę tego dnia.`);
  }
  return ok;
}

// Zastępuje wpisy podanych dni: changes = [{ emp, iso, entries: [wpis, wpis?] }] (puste = wyczyść)
async function shSetDays(changes, label) {
  shBusy = true;
  shSyncBar();
  let error = null;
  try {
    // 1. usunięcie dotychczasowych wpisów (osobno dla każdego pracownika)
    const byEmp = new Map();
    changes.forEach(c => (byEmp.get(c.emp) || byEmp.set(c.emp, []).get(c.emp)).push(c.iso));
    for (const [emp, days] of byEmp) {
      const { error: e } = await supabaseClient.from("schedule_days").delete().eq("employee_id", emp).in("day", days);
      if (e) throw e;
      days.forEach(iso => { if (shPlan[emp]) delete shPlan[emp][iso]; });
    }

    // 2. nowe wpisy (slot 1 i ewentualnie 2)
    const rows = [];
    changes.forEach(c => c.entries.forEach((e, i) => rows.push({
      employee_id: c.emp,
      day: c.iso,
      slot: e.slot || i + 1,
      kind: e.kind,
      time_from: e.kind === "off" ? null : (e.time_from || null),
      time_to: e.kind === "off" ? null : (e.time_to || null),
      note: e.kind === "absence" ? (e.note || null) : null
    })));
    for (let i = 0; i < rows.length; i += 500) {
      const { data, error: e } = await supabaseClient
        .from("schedule_days")
        .insert(rows.slice(i, i + 500))
        .select("*");
      if (e) throw e;
      if (!data || !data.length) throw new Error("brak uprawnień w bazie");
      data.forEach(shPlanAdd);
    }
  } catch (err) {
    error = err;
  }
  shBusy = false;

  if (error) {
    console.error("Błąd zapisu harmonogramu:", error);
    shShowBanner("warning", "Nie udało się zapisać harmonogramu: " + (error.message || error) +
      (String(error.message || "").includes("slot") ? " Uruchom w Supabase skrypt sql/30_harmonogram_dwie_zmiany.sql." : ""));
    await shLoad();                 // stan z bazy, żeby tabela nie pokazywała czegoś, czego nie zapisano
  } else {
    const people = new Set(changes.map(c => c.emp)).size;
    logAction("Zmiana harmonogramu", `${shWeekTitle()}: ${label}; dni: ${changes.length}, osób: ${people}`);
  }
  shRefreshCells();
  // licznik zaplanowanych i przyciski "Pn → Pt" zależą od wpisów
  const planned = shEmployees.filter(e => shDays.some(d => shEntry(e.id, d.iso))).length;
  const info = document.getElementById("sh-info");
  if (info) info.textContent = `Zaplanowano: ${planned} z ${shEmployees.length} pracowników`;
  document.querySelectorAll("#sh-table-body tr[id^='sh-row-']").forEach(tr => {
    const id = Number(tr.id.slice(7));
    const tool = tr.querySelector(".sh-tool");
    if (tool) tool.disabled = !shEntry(id, shDays[0].iso) || shReadOnly;
  });
  return !error;
}

// Kopia wpisu bez pól z bazy
function shCopyEntry(e) {
  return { slot: e.slot || 1, kind: e.kind, time_from: e.time_from, time_to: e.time_to, note: e.note };
}

// Wtorek–piątek tak jak poniedziałek (obie zmiany)
async function shCopyMonday(id) {
  const mon = shEntry(id, shDays[0].iso);
  if (!mon || shBusy || shReadOnly) return;
  const entries = mon.map(shCopyEntry);
  await shSetDays(shDays.slice(1, 5).map(d => ({ emp: id, iso: d.iso, entries })),
    `pn → wt–pt (${shEntryView(mon).title})`);
}

// Esc odznacza (gdy nie jest otwarte okienko godzin ani okno modalne)
document.addEventListener("keydown", e => {
  if (e.key !== "Escape" || !document.getElementById("sh-table-body") || !shSel.size) return;
  if (document.querySelector(".modal.active") || document.getElementById("rt-picker")?.classList.contains("open")) return;
  shClearSelection();
});
