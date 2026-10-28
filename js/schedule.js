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

  // numer tygodnia i daty osobno - na telefonie stoją jedno pod drugim
  const label = document.getElementById("sh-week-label");
  if (label) {
    const [week, dates] = shWeekTitle().split(" • ");
    label.innerHTML = `<b>${rtEsc(week)}</b><span class="dot">•</span><span class="dates">${rtEsc(dates)}</span>`;
  }
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
    from: joined ? a.time_from : "", to: joined ? b.time_to : "",
    title: views.map(v => v.title).join(" • ")
  };
}

// Wygląd jednego wpisu: { cls, main, sub, title } oraz from / to, gdy pod spodem są godziny
// (na telefonie godzina rozpoczęcia i zakończenia stoją jedna pod drugą)
function shSingleView(e) {
  if (e.kind === "off") return { cls: "off", main: "Wolne", sub: "", title: "Wolne" };
  if (e.kind === "absence") {
    const hours = e.time_from && e.time_to ? `${e.time_from}–${e.time_to}` : "";
    return {
      cls: "absence", main: "Nieob.", sub: hours || e.note || "", from: hours ? e.time_from : "", to: hours ? e.time_to : "",
      title: `Zgłoszona nieobecność${e.note ? ": " + e.note : ""}${hours ? ", godz. " + hours : ""}`
    };
  }
  const preset = SH_PRESETS.find(p => p.from === e.time_from && p.to === e.time_to);
  if (preset) {
    return { cls: "work", main: preset.label, sub: `${e.time_from}–${e.time_to}`, from: e.time_from, to: e.time_to, title: `Zmiana ${preset.label}: ${e.time_from}–${e.time_to}` };
  }
  // inne godziny niż pełna zmiana: zmiana na górze, godziny pod spodem (pogrubione)
  const shift = shShiftLabel(e.time_from);
  return {
    cls: "work custom",
    main: shift || e.time_from,
    sub: shift ? `${e.time_from}–${e.time_to}` : e.time_to,
    from: shift ? e.time_from : "", to: shift ? e.time_to : "",
    title: `${shift ? `Zmiana ${shift}, inne godziny: ` : "Praca "}${e.time_from}–${e.time_to}`
  };
}

// Podpis pod nazwą zmiany: godziny jako dwie części (od, do) albo zwykły tekst
function shSubHtml(v) {
  if (v.from && v.to) {
    return `<span class="s hrs"><span>${rtEsc(v.from)}</span><span class="dash">–</span><span>${rtEsc(v.to)}</span></span>`;
  }
  return v.sub ? `<span class="s">${rtEsc(v.sub)}</span>` : "";
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
      <span class="m">${rtEsc(v.main)}</span>${shSubHtml(v)}
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
    btn.innerHTML = `<span class="m">${rtEsc(v.main)}</span>${shSubHtml(v)}`;
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

// ---------- Wydruk / PDF ----------
// Okno wyboru: zakres dat (do 62 dni) i pracownicy (domyślnie widoczni po filtrach).
// Tabela do druku powstaje w ukrytej ramce i od razu otwiera się okno drukowania przeglądarki
// ("Zapisz jako PDF" daje plik). U góry dzień tygodnia i data, z lewej imię i nazwisko, w kratkach godziny od–do.
const SH_PRINT_MAX_DAYS = 62;
let shPrintChecked = new Set();   // id zaznaczonych pracowników

function shOpenPrint() {
  if (!shEmployees.length || !shDays.length) return;
  // filtry okna: te same opcje i wybór co na ekranie Harmonogramu (firma, dział, moja lista)
  [["sh-filter-business", "sh-print-business"], ["sh-filter-dept", "sh-print-dept"], ["sh-filter-list", "sh-print-elist"]]
    .forEach(([src, dst]) => {
      const from = document.getElementById(src), to = document.getElementById(dst);
      if (!from || !to) return;
      to.innerHTML = from.innerHTML;
      to.value = from.value;
    });
  shPrintChecked = new Set(shPrintFiltered().map(e => Number(e.id)));
  document.getElementById("sh-print-search").value = "";
  document.getElementById("sh-print-msg").style.display = "none";
  shPrintPreset("week");
  shPrintRenderList();
  toggleModal("modal-sh-print", true);
}

// Szybki wybór okresu: tydzień z ekranu, dwa tygodnie od niego albo miesiąc, w którym ten tydzień się zaczyna
function shPrintPreset(kind) {
  const monday = shDays[0].date;
  let from = monday, to = shDays[6].date;
  if (kind === "2weeks") to = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 13);
  if (kind === "month") {
    from = new Date(monday.getFullYear(), monday.getMonth(), 1);
    to = new Date(monday.getFullYear(), monday.getMonth() + 1, 0);
  }
  document.getElementById("sh-print-from").value = shDayIso(from);
  document.getElementById("sh-print-to").value = shDayIso(to);
  shPrintRangeInfo();
}

// Dni zakresu jako daty (południe każdego dnia - bez kłopotów ze zmianą czasu)
function shPrintDays() {
  const from = document.getElementById("sh-print-from").value;
  const to = document.getElementById("sh-print-to").value;
  if (!from || !to || to < from) return [];
  const days = [];
  for (let d = new Date(`${from}T12:00:00`); shDayIso(d) <= to && days.length <= SH_PRINT_MAX_DAYS; d.setDate(d.getDate() + 1)) {
    days.push(new Date(d));
  }
  return days;
}

function shPrintRangeInfo() {
  const n = shPrintDays().length;
  document.getElementById("sh-print-days").textContent =
    !n ? "zły zakres" : n > SH_PRINT_MAX_DAYS ? `za długo (maks. ${SH_PRINT_MAX_DAYS} dni)` : `${n} ${n === 1 ? "dzień" : "dni"}`;
}

// Pracownik pasuje do wyszukiwania w oknie (imię nazwisko albo nazwisko imię)
function shPrintMatch(e, q) {
  const a = `${e.first_name || ""} ${e.last_name || ""}`.toLowerCase();
  const b = `${e.last_name || ""} ${e.first_name || ""}`.toLowerCase();
  return !q || a.includes(q) || b.includes(q);
}

// Pracownicy pasujący do filtrów okna (firma, dział, moja lista) i - z search - do wyszukiwania
function shPrintFiltered(search) {
  const biz = document.getElementById("sh-print-business")?.value;
  const dept = document.getElementById("sh-print-dept")?.value;
  const listId = document.getElementById("sh-print-elist")?.value;
  const own = listId && typeof rtlLists !== "undefined" ? rtlLists.find(l => String(l.id) === String(listId)) : null;
  const q = search ? document.getElementById("sh-print-search").value.toLowerCase().trim() : "";
  return shEmployees.filter(e =>
    (!biz || String(e.business_id) === biz) &&
    (!dept || String(e.department_id) === dept) &&
    (!own || own.members.has(Number(e.id))) &&
    shPrintMatch(e, q));
}

// Zmiana filtra w oknie: zaznaczeni są dokładnie pasujący pracownicy
function shPrintFilter() {
  shPrintChecked = new Set(shPrintFiltered().map(e => Number(e.id)));
  shPrintRenderList();
}

function shPrintRenderList() {
  const list = shPrintFiltered(true);
  document.getElementById("sh-print-list").innerHTML = list.length ? list.map(e => `
    <label><input type="checkbox" ${shPrintChecked.has(Number(e.id)) ? "checked" : ""} onchange="shPrintToggle(${Number(e.id)}, this.checked)" />
      ${rtEsc(`${e.first_name || ""} ${e.last_name || ""}`.trim())}<small>${rtEsc(e.department?.department || "")}</small></label>`).join("")
    : `<div class="empty">Brak pracowników</div>`;
  document.getElementById("sh-print-count").textContent = `(zaznaczonych: ${shPrintChecked.size})`;
}

function shPrintToggle(id, on) {
  if (on) shPrintChecked.add(id); else shPrintChecked.delete(id);
  document.getElementById("sh-print-count").textContent = `(zaznaczonych: ${shPrintChecked.size})`;
}

// "Zaznacz widocznych" - pracownicy widoczni na liście okna (filtry i wyszukiwanie)
function shPrintCheckAll(on) {
  if (!on) shPrintChecked.clear();
  else shPrintFiltered(true).forEach(e => shPrintChecked.add(Number(e.id)));
  shPrintRenderList();
}

// Kratka wydruku: godziny pracy od–do (np. 06:30–14:30); wolne i nieobecność słownie
// (przy wąskich kolumnach skrót W / N); dwa wpisy jeden pod drugim
function shPrintCell(list, weekday) {
  const w = weekday === 5 ? ` data-w="sat"` : weekday === 6 ? ` data-w="sun"` : "";
  if (!list || !list.length) return `<td${w}></td>`;
  const word = (full, short) => `<span class="full">${full}</span><span class="short">${short}</span>`;
  // od–do; w wąskiej kolumnie "do" schodzi pod "od"
  const hours = e => e.time_from && e.time_to ? `${rtEsc(e.time_from)}–<wbr>${rtEsc(e.time_to)}` : "";
  const one = e => {
    if (e.kind === "off") return `<div class="e"><b>${word("Wolne", "W")}</b></div>`;
    if (e.kind === "absence") {
      return `<div class="e"><b>${word("Nieobecność", "N")}</b>${hours(e) ? `<span>${hours(e)}</span>` : e.note ? `<span>${rtEsc(e.note)}</span>` : ""}</div>`;
    }
    return `<div class="e"><b class="h">${hours(e) || rtEsc(shEntryLabel(e))}</b></div>`;
  };
  const kind = list.every(e => e.kind === "off") ? "off" : list.some(e => e.kind === "absence") ? "ab" : "work";
  return `<td class="${kind}"${w}>${list.map(one).join("")}</td>`;
}

// Biblioteka do zapisu PDF (html2canvas + jsPDF w jednym pliku) - ładowana dopiero przy zapisie, wewnątrz ramki wydruku
const SH_PDF_LIB = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";

// Ustawienia PDF: A4 w poziomie, marginesy jak przy druku, wiersz tabeli nie dzieli się między strony
function shPdfOptions(filename) {
  return {
    margin: 9,
    filename,
    image: { type: "jpeg", quality: 0.96 },
    html2canvas: { scale: 2, backgroundColor: "#ffffff" },
    jsPDF: { unit: "mm", format: "a4", orientation: "landscape" },
    pagebreak: { mode: ["css", "legacy"], avoid: "tr" }
  };
}

// mode: "print" - okno drukowania przeglądarki, "pdf" - od razu plik PDF do pobrania
async function shPrint(mode = "print") {
  const msg = document.getElementById("sh-print-msg");
  const show = text => { msg.textContent = text; msg.style.display = "block"; };
  const days = shPrintDays();
  if (!days.length) return show("Wybierz poprawny zakres dat (Od nie później niż Do).");
  if (days.length > SH_PRINT_MAX_DAYS) return show(`Zakres może mieć najwyżej ${SH_PRINT_MAX_DAYS} dni.`);
  const emps = shEmployees.filter(e => shPrintChecked.has(Number(e.id)));
  if (!emps.length) return show("Zaznacz co najmniej jednego pracownika.");
  msg.style.display = "none";

  const buttons = { print: document.getElementById("sh-print-go"), pdf: document.getElementById("sh-pdf-go") };
  const labels = { print: `<i class="fa-solid fa-print"></i> Drukuj`, pdf: `<i class="fa-solid fa-file-pdf"></i> Zapisz PDF` };
  const busy = on => Object.entries(buttons).forEach(([k, b]) => {
    if (!b) return;
    b.disabled = on;
    b.innerHTML = on && k === mode ? `<i class="fa-solid fa-spinner fa-spin"></i> Przygotowywanie...` : labels[k];
  });
  busy(true);
  const isoDays = days.map(shDayIso);
  let rows;
  try {
    rows = await rpFetchAll(() => supabaseClient
      .from("schedule_days")
      .select("*")
      .gte("day", isoDays[0])
      .lte("day", isoDays[isoDays.length - 1]));
  } catch (err) {
    console.error("Błąd pobierania harmonogramu do wydruku:", err);
    show("Nie udało się pobrać harmonogramu: " + (err.message || err));
    busy(false);
    return;
  }
  if (mode === "print") busy(false);

  // { idPracownika: { dzień: [wpisy wg slotu] } }
  const plan = {};
  rows.forEach(r => {
    const byDay = plan[r.employee_id] || (plan[r.employee_id] = {});
    (byDay[r.day] || (byDay[r.day] = [])).push(r);
  });
  Object.values(plan).forEach(byDay => Object.values(byDay).forEach(l => l.sort((a, b) => (a.slot || 1) - (b.slot || 1))));

  const p = n => String(n).padStart(2, "0");
  const dm = d => `${p(d.getDate())}.${p(d.getMonth() + 1)}`;
  const last = days[days.length - 1];
  const range = `${dm(days[0])}.${days[0].getFullYear()} – ${dm(last)}.${last.getFullYear()}`;
  const weekdays = days.map(d => (d.getDay() + 6) % 7);
  const head = days.map((d, i) =>
    `<th class="d${weekdays[i] === 5 ? " sat" : weekdays[i] === 6 ? " sun" : ""}"><b>${SH_DAY_SHORT[weekdays[i]]}</b><span>${dm(d)}</span></th>`).join("");
  const body = emps.map(e => `<tr>
      <th class="n">${rtEsc(`${e.first_name || ""} ${e.last_name || ""}`.trim())}</th>
      ${isoDays.map((iso, i) => shPrintCell((plan[e.id] || {})[iso], weekdays[i])).join("")}
    </tr>`).join("");
  const shifts = SH_PRESETS.map(s => `<b>${s.label}</b> ${s.from}–${s.to}`).join(" · ");

  const html = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>Harmonogram ${range}</title><style>
    @page { size: A4 landscape; margin: 9mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; color: #1F2328; }
    h1 { margin: 0 0 2px; font-size: 15pt; color: #08584B; }
    .meta { font-size: 8.5pt; color: #5B616B; margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 8pt; }
    th, td { border: 0.6pt solid #9AA1A9; text-align: center; vertical-align: middle; padding: 2px 1px; }
    thead th { background: #08584B; color: #fff; font-weight: 700; }
    thead th.corner { text-align: left; padding: 4px 6px; width: 42mm; vertical-align: bottom; }
    th.d { padding: 4px 1px; line-height: 1.15; }   /* dzień tygodnia u góry, data pod nim - poziomo */
    th.d b { display: block; font-size: 8.5pt; } th.d span { display: block; font-size: 7pt; font-weight: 600; opacity: 0.9; white-space: nowrap; }
    .compact th.d b { font-size: 7pt; } .compact th.d span { font-size: 5.6pt; letter-spacing: -0.1pt; }
    th.d.sat { background: #FCD444; color: #03241E; } th.d.sun { background: #2563EB; }
    th.n { text-align: left; padding: 3px 6px; font-weight: 600; background: #F3F5F4; overflow-wrap: anywhere; }   /* długie nazwisko - w dwóch linijkach */
    td[data-w="sat"] { background: #FFF3C2; } td[data-w="sun"] { background: #E8EFFD; }
    td.work { background: #E3F2EC; } td.off { background: #EEF0F2; color: #6B7280; } td.ab { background: #FDE8E8; color: #9B1C1C; }
    .e { display: flex; flex-direction: column; align-items: center; line-height: 1.1; }
    .e + .e { border-top: 0.6pt dashed #9AA1A9; margin-top: 2px; padding-top: 2px; }
    .e b { font-size: 9pt; }
    .e b.h { font-variant-numeric: tabular-nums; }
    .short { display: none; } .compact .full { display: none; } .compact .short { display: inline; }
    .e span { font-size: 7pt; font-variant-numeric: tabular-nums; }
    .compact table { font-size: 6.5pt; } .compact .e b { font-size: 7.5pt; } .compact .e b.h { font-size: 6.6pt; } .compact .e span { font-size: 5.8pt; }
    .compact thead th.corner { width: 34mm; }
    tr { page-break-inside: avoid; }
    .legend { margin-top: 6px; font-size: 7.5pt; color: #5B616B; }
  </style></head><body><div class="sheet${days.length > 16 ? " compact" : ""}">
    <h1>Harmonogram pracy</h1>
    <div class="meta">${range} · pracowników: ${emps.length} · wydrukowano ${rtEsc(rtIsoToPl(shDayIso(new Date())))}</div>
    <table><thead><tr><th class="corner">Imię i nazwisko</th>${head}</tr></thead><tbody>${body}</tbody></table>
    <div class="legend">W kratkach godziny pracy od–do · ${shifts} · <b>W</b> wolne · <b>N</b> zgłoszona nieobecność · pusta kratka = nie zaplanowano</div>
  </div></body></html>`;

  // ukryta ramka: drukowanie bez nowego okna (nie zatrzyma go blokada wyskakujących okien)
  document.getElementById("sh-print-frame")?.remove();
  const frame = document.createElement("iframe");
  frame.id = "sh-print-frame";
  frame.setAttribute("aria-hidden", "true");
  // szerokość jak strona A4 w poziomie bez marginesów (297 - 2 × 9 mm) - pomiar wierszy zgadza się z wydrukiem
  frame.style.cssText = "position: fixed; left: -10000px; top: 0; width: 279mm; height: 190mm; border: 0; visibility: hidden;";
  document.body.appendChild(frame);
  const doc = frame.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();

  if (mode === "print") {
    toggleModal("modal-sh-print", false);
    logAction("Wydruk harmonogramu", `${range}, pracowników: ${emps.length}`);
    setTimeout(() => {
      shPrintEvenRows(doc);
      frame.contentWindow.focus();
      frame.contentWindow.print();
    }, 250);
    return;
  }

  // PDF: biblioteka w ramce (style tabeli zostają takie jak przy druku), plik pobiera się od razu
  const filename = `Harmonogram ${isoDays[0]} - ${isoDays[isoDays.length - 1]}.pdf`;
  const fail = err => {
    console.error("Błąd zapisu harmonogramu do PDF:", err);
    show("Nie udało się zapisać PDF" + (err?.message ? ": " + err.message : " (brak połączenia z internetem?)") + ". Możesz użyć „Drukuj” i wybrać „Zapisz jako PDF”.");
    busy(false);
  };
  const script = doc.createElement("script");
  script.src = SH_PDF_LIB;
  script.onerror = () => fail(null);
  script.onload = () => {
    shPrintEvenRows(doc);
    frame.contentWindow.html2pdf().set(shPdfOptions(filename)).from(doc.querySelector(".sheet")).save()
      .then(() => {
        busy(false);
        toggleModal("modal-sh-print", false);
        logAction("Zapis harmonogramu do PDF", `${range}, pracowników: ${emps.length}`);
      }, fail);
  };
  doc.head.appendChild(script);
}

// Wszystkie wiersze tej samej wysokości - jak wiersz z dwoma wpisami godzin w jednym dniu
// (albo wyższy, gdy np. długie nazwisko zajmuje dwie linijki)
function shPrintEvenRows(doc) {
  const tbody = doc.querySelector("tbody");
  const first = tbody?.querySelector("tr");
  if (!first) return;
  // wiersz próbny: w każdym dniu dwa wpisy od–do
  const probe = first.cloneNode(true);
  probe.querySelectorAll("td").forEach(td => {
    td.className = "work";
    td.innerHTML = `<div class="e"><b class="h">06:30–<wbr>14:30</b></div><div class="e"><b class="h">14:30–<wbr>18:00</b></div>`;
  });
  tbody.appendChild(probe);
  const height = Math.max(...[...tbody.querySelectorAll("tr")].map(tr => tr.getBoundingClientRect().height));
  probe.remove();
  tbody.querySelectorAll("tr").forEach(tr => { tr.style.height = `${Math.ceil(height)}px`; });
}
