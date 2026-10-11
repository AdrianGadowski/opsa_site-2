// ==========================================
// MODUŁ: HARMONOGRAM PRACY (schedule)
// Godziny pracy pracowników na wybrany tydzień. Dane: kolumny tekstowe week_1 ... week_53
// w tabeli employees, w postaci "06:30 - 14:30" (pusta = nie ustalono).
// Numer tygodnia jest liczony tak jak na wykresie w pulpicie: tydzień 1 zaczyna się
// 1 stycznia, kolejne w poniedziałki. Kolumny nie mają roku, więc harmonogram
// dotyczy bieżącego roku i w kolejnym roku jest nadpisywany.
// Wymaga: supabaseClient (app.js), rt* / RT_ALL_TIMES (report_time.js), dbWeekOfYear (dashboard.js)
// Funkcje shWeek* i shParse są używane także w portalu pracownika.
// ==========================================

const SH_PRESETS = [
  { label: "I", from: "06:30", to: "14:30" },
  { label: "II", from: "14:30", to: "22:30" },
  { label: "III", from: "22:30", to: "06:30" }
];
const SH_HISTORY = 3;        // ile poprzednich tygodni pokazać informacyjnie

let shEmployees = [];
let shYear = new Date().getFullYear();
let shWeek = 1;              // wybrany tydzień
let shLoadToken = 0;
let shBannerTimer = null;
let shCopying = false;

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

// ---------- Inicjalizacja ----------
async function initScheduleView() {
  const current = shCurrentWeek();
  shYear = current.year;
  shWeek = current.week;
  shEmployees = [];

  const sel = document.getElementById("sh-week");
  if (sel) {
    const total = shWeeksInYear(shYear);
    sel.innerHTML = Array.from({ length: total }, (_, i) => {
      const w = i + 1;
      const mark = w === current.week ? " • bieżący" : "";
      return `<option value="${w}"${w === shWeek ? " selected" : ""}>Tydzień ${w} (${shWeekLabel(shYear, w)})${mark}</option>`;
    }).join("");
  }

  await shLoad();
}

function shOnWeekChange() {
  shWeek = Number(document.getElementById("sh-week").value) || 1;
  shLoad();
}

function shStepWeek(delta) {
  const next = shWeek + delta;
  if (next < 1 || next > shWeeksInYear(shYear)) return;
  shWeek = next;
  const sel = document.getElementById("sh-week");
  if (sel) sel.value = String(shWeek);
  shLoad();
}

// Poprzednie tygodnie pokazywane informacyjnie (od najnowszego)
function shHistoryWeeks() {
  return Array.from({ length: SH_HISTORY }, (_, i) => shShiftWeek(shYear, shWeek, -(i + 1)));
}

// ---------- Dane ----------
async function shLoad() {
  const tbody = document.getElementById("sh-table-body");
  if (!tbody) return;
  const token = ++shLoadToken;

  const prevBtn = document.getElementById("sh-prev");
  const nextBtn = document.getElementById("sh-next");
  if (prevBtn) prevBtn.disabled = shWeek <= 1;
  if (nextBtn) nextBtn.disabled = shWeek >= shWeeksInYear(shYear);

  document.getElementById("sh-col-current").textContent = `Godziny pracy — tydzień ${shWeek}`;

  const columns = [shWeek, ...shHistoryWeeks().map(w => w.week)]
    .filter((w, i, arr) => arr.indexOf(w) === i)
    .map(shWeekColumn);

  const { data, error } = await supabaseClient
    .from("employees")
    .select(`
      id, first_name, last_name, business_id, department_id,
      business:business_id ( business ),
      department:department_id ( department ),
      ${columns.join(", ")}
    `)
    .eq("active", true);
  if (token !== shLoadToken) return; // w międzyczasie zmieniono tydzień

  if (error) {
    console.error("Błąd pobierania harmonogramu:", error);
    shEmployees = [];
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--danger);padding:25px;">
      Nie udało się pobrać harmonogramu: ${rtEsc(error.message)}</td></tr>`;
    return;
  }

  shEmployees = (data || []).sort((a, b) =>
    `${a.last_name || ""} ${a.first_name || ""}`.localeCompare(`${b.last_name || ""} ${b.first_name || ""}`, "pl"));

  shFillFilters();
  shRenderTable();
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

  return shEmployees.filter(e => {
    const n1 = `${e.first_name || ""} ${e.last_name || ""}`.toLowerCase();
    const n2 = `${e.last_name || ""} ${e.first_name || ""}`.toLowerCase();
    return (!q || n1.includes(q) || n2.includes(q)) &&
      (!biz || String(e.business_id) === biz) &&
      (!dept || String(e.department_id) === dept);
  });
}

function shResetFilters() {
  ["sh-filter-search", "sh-filter-business", "sh-filter-dept"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  shRenderTable();
}

// ---------- Tabela ----------
function shTimeOptions(selected) {
  const opt = t => `<option value="${t}"${t === selected ? " selected" : ""}>${t}</option>`;
  // godzina spoza listy (np. 07:15 wpisana ręcznie w bazie) zostaje widoczna
  const extra = selected && !RT_ALL_TIMES.includes(selected) ? opt(selected) : "";
  return `<option value="">--:--</option>${extra}${RT_ALL_TIMES.map(opt).join("")}`;
}

function shRowHtml(emp) {
  const id = Number(emp.id);
  const raw = emp[shWeekColumn(shWeek)];
  const parsed = shParse(raw);
  const unreadable = !!(raw && String(raw).trim() && !parsed);

  const history = shHistoryWeeks().map(w => {
    const text = shDisplay(emp[shWeekColumn(w.week)]);
    return `<span class="sh-chip ${text ? "" : "none"}" title="Tydzień ${w.week} (${shWeekLabel(w.year, w.week)})">
      <b>T${w.week}</b> ${text ? rtEsc(text) : "—"}</span>`;
  }).join("");

  const presets = SH_PRESETS.map((p, i) => {
    const on = parsed && parsed.from === p.from && parsed.to === p.to;
    return `<button type="button" class="sh-preset ${on ? "on" : ""}" title="Zmiana ${p.label}: ${p.from}–${p.to}"
      onclick="shPreset(${id}, ${i})">${p.label}</button>`;
  }).join("");

  return `
    <tr id="sh-row-${id}" class="${parsed ? "is-set" : ""}">
      <td class="sh-name">${rtEsc(`${emp.last_name || ""} ${emp.first_name || ""}`.trim())}</td>
      <td><span class="sh-biz">${rtEsc(emp.business?.business || "-")}</span></td>
      <td style="color: var(--text-muted); font-size: 0.88rem;">${rtEsc(emp.department?.department || "-")}</td>
      <td><div class="sh-history">${history}</div></td>
      <td>
        <div class="sh-edit">
          <select class="sh-time" id="sh-from-${id}" aria-label="Od" onchange="shOnTime(${id})">${shTimeOptions(parsed ? parsed.from : "")}</select>
          <span aria-hidden="true">–</span>
          <select class="sh-time" id="sh-to-${id}" aria-label="Do" onchange="shOnTime(${id})">${shTimeOptions(parsed ? parsed.to : "")}</select>
          <span class="sh-presets">${presets}</span>
          <button type="button" class="link-btn sh-clear" title="Wyczyść godziny" aria-label="Wyczyść godziny" onclick="shClear(${id})"><i class="fa-solid fa-xmark"></i></button>
        </div>
        ${unreadable ? `<div class="sh-raw">Wpis w bazie: „${rtEsc(String(raw).trim())}”</div>` : ""}
      </td>
      <td class="sh-status" id="sh-status-${id}"></td>
    </tr>`;
}

function shRenderTable() {
  const tbody = document.getElementById("sh-table-body");
  if (!tbody) return;
  const list = shVisibleEmployees();

  const set = shEmployees.filter(e => shParse(e[shWeekColumn(shWeek)])).length;
  const info = document.getElementById("sh-info");
  if (info) info.textContent = `Ustalono godziny: ${set} z ${shEmployees.length}`;

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:30px;">
      Brak pracowników spełniających podane kryteria.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(shRowHtml).join("");
}

function shSetStatus(id, state, text) {
  const el = document.getElementById(`sh-status-${id}`);
  if (!el) return;
  const icons = { saving: "fa-spinner fa-spin", saved: "fa-circle-check", error: "fa-triangle-exclamation", hint: "fa-circle-info" };
  el.className = `sh-status ${state}`;
  el.innerHTML = state ? `<i class="fa-solid ${icons[state]}"></i> ${rtEsc(text || "")}` : "";
}

// ---------- Zapis (od razu po zmianie) ----------
// Zapis idzie przez funkcję bazy app_set_schedule: wymaga uprawnienia "Harmonogram"
// i pozwala zmienić wyłącznie kolumny week_N (nie resztę danych pracownika).
// Zwraca błąd albo null.
async function shWrite(employeeId, week, value) {
  const { error } = await supabaseClient.rpc("app_set_schedule", {
    p_employee_id: employeeId,
    p_week: week,
    p_value: value
  });
  return error || null;
}

async function shSave(id, value) {
  const emp = shEmployees.find(e => Number(e.id) === Number(id));
  if (!emp) return;
  const week = shWeek;               // tydzień z chwili kliknięcia
  const column = shWeekColumn(week);
  const token = shLoadToken;

  shSetStatus(id, "saving", "Zapisywanie...");
  const error = await shWrite(id, week, value);

  const failed = !!error;
  if (failed) {
    console.error("Błąd zapisu harmonogramu:", error);
  } else {
    emp[column] = value;
    logAction("Zmiana harmonogramu",
      `${emp.first_name || ""} ${emp.last_name || ""}`.trim() + `, tydzień ${week}: ${value || "wyczyszczono"}`);
  }
  if (token !== shLoadToken) return; // w międzyczasie zmieniono tydzień - tabela pokazuje już co innego

  if (failed) {
    shSetStatus(id, "error", error ? error.message : "Brak uprawnień w bazie");
    return;
  }

  // odśwież wiersz (podświetlenie, zaznaczony przycisk zmiany) i licznik
  const tr = document.getElementById(`sh-row-${id}`);
  if (tr) tr.outerHTML = shRowHtml(emp);
  shSetStatus(id, "saved", value ? "Zapisano" : "Wyczyszczono");
  const set = shEmployees.filter(e => shParse(e[column])).length;
  const info = document.getElementById("sh-info");
  if (info) info.textContent = `Ustalono godziny: ${set} z ${shEmployees.length}`;
}

function shOnTime(id) {
  const from = document.getElementById(`sh-from-${id}`)?.value || "";
  const to = document.getElementById(`sh-to-${id}`)?.value || "";

  if (!from && !to) {
    shSave(id, null);
  } else if (!from || !to) {
    shSetStatus(id, "hint", "Wybierz drugą godzinę");
  } else if (from === to) {
    shSetStatus(id, "error", "Godziny od i do muszą się różnić");
  } else {
    shSave(id, shFormat(from, to));
  }
}

function shPreset(id, index) {
  const p = SH_PRESETS[index];
  if (p) shSave(id, shFormat(p.from, p.to));
}

function shClear(id) {
  shSave(id, null);
}

// Pracownikom bez godzin w wybranym tygodniu wpisuje godziny z tygodnia poprzedniego.
// Dotyczy tylko osób widocznych przy bieżących filtrach; niczego nie nadpisuje.
async function shCopyPrevious() {
  if (shCopying) return;
  const week = shWeek;               // tydzień z chwili kliknięcia
  const column = shWeekColumn(week);
  const prev = shShiftWeek(shYear, shWeek, -1);
  const prevColumn = shWeekColumn(prev.week);

  const todo = shVisibleEmployees()
    .filter(e => !String(e[column] || "").trim())
    .map(e => ({ emp: e, parsed: shParse(e[prevColumn]) }))
    .filter(x => x.parsed);

  if (todo.length === 0) {
    shShowBanner("warning", `Nie ma czego uzupełnić: nikt z widocznych osób bez godzin nie ma godzin w tygodniu ${prev.week}.`);
    return;
  }

  const btn = document.getElementById("sh-copy-btn");
  shCopying = true;
  if (btn) btn.disabled = true;

  let failed = 0;
  // po kilka zapisów naraz, żeby nie zalać bazy setką żądań
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(todo.slice(i, i + 8).map(async ({ emp, parsed }) => {
      const error = await shWrite(emp.id, week, shFormat(parsed.from, parsed.to));
      if (error) {
        console.error("Błąd kopiowania harmonogramu:", error);
        failed++;
      }
    }));
  }

  logAction("Harmonogram: uzupełnienie z poprzedniego tygodnia", `Tydzień ${week}, osób: ${todo.length - failed}`);
  shCopying = false;
  if (btn) btn.disabled = false;
  await shLoad();

  if (failed) {
    shShowBanner("warning", `Uzupełniono ${todo.length - failed} z ${todo.length} osób. Dla ${failed} zapis się nie powiódł.`);
  } else {
    shShowBanner("success", `Uzupełniono godziny ${todo.length} osobom na podstawie tygodnia ${prev.week}.`);
  }
}
