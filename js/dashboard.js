// ==========================================
// MODUŁ: DASHBOARD
// Źródło: work_reports (+ słowniki employees, department)
// Wymaga: supabaseClient (app.js), rt* (report_time.js), rpFetchAll / RP_MONTHS / RP_YEARS_BACK (reports.js)
// ==========================================

const DB_TOP = 6;            // ile pozycji w listach działów, firm i pracowników
const DB_SHIFTS = ["Zmiana I", "Zmiana II", "Zmiana III"];

let dbEmpById = {};
let dbDeptById = {};
let dbLoadToken = 0;

// ---------- Pomocnicze ----------
function dbNum(value, digits = 1) {
  return Number(value || 0).toLocaleString("pl-PL", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function dbHours(value) {
  return `${dbNum(value)} h`;
}

// Najbliższa "okrągła" wartość >= v, wygodna do podziału osi na 4 części
function dbNiceMax(v) {
  if (v <= 0) return 4;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const step = [1, 2, 4, 5, 8, 10].find(s => s * pow >= v) || 10;
  return step * pow;
}

function dbEmptyHtml(text) {
  return `<div class="db-empty"><i class="fa-solid fa-chart-simple"></i>${rtEsc(text)}</div>`;
}

// Treść dymka: "Tytuł|kolor|tekst|kolor|tekst..."
function dbTipAttr(title, lines) {
  return rtEsc([title, ...lines.flat()].join("|"));
}

function dbHoursLines(present, absent) {
  return [
    ["var(--db-present)", `Obecne: ${dbHours(present)}`],
    ["var(--db-absent)", `Nieobecne: ${dbHours(absent)}`]
  ];
}

// ---------- Wybór okresu: strzałki ‹ › (bez list rozwijanych) ----------
// Okres trzymają ukryte pola db-filter-year ("2026") i db-filter-month ("01".."12", "" = cały rok).
// Z wybranym miesiącem strzałki zmieniają miesiąc (styczeń ‹ = grudzień poprzedniego roku,
// grudzień › = styczeń następnego). Nie da się wyjść poza bieżący miesiąc.

function dbPeriod() {
  return {
    year: Number(document.getElementById("db-filter-year")?.value) || new Date().getFullYear(),
    month: Number(document.getElementById("db-filter-month")?.value) || 0
  };
}

function dbSetPeriod(year, month) {
  document.getElementById("db-filter-year").value = String(year);
  document.getElementById("db-filter-month").value = month ? String(month).padStart(2, "0") : "";
  dbSyncPeriodArrows();
}

function dbStepPeriod(delta) {
  let { year, month } = dbPeriod();
  if (month) {
    month += delta;
    if (month < 1) { month = 12; year--; }
    if (month > 12) { month = 1; year++; }
  } else {
    year += delta;
  }
  if (dbPeriodInFuture(year, month)) return;
  dbSetPeriod(year, month);
  dbLoad();
}

function dbPeriodInFuture(year, month) {
  const now = new Date();
  return year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1);
}

function dbSyncPeriodArrows() {
  const { year, month } = dbPeriod();
  const label = month ? "miesiąc" : "rok";
  const text = document.getElementById("db-period-text");
  if (text) text.textContent = month ? `${RP_MONTHS[month - 1]} ${year}` : `Rok ${year}`;
  const prev = document.getElementById("db-prev");
  const next = document.getElementById("db-next");
  if (prev) prev.title = `Poprzedni ${label}`;
  if (next) {
    next.title = `Następny ${label}`;
    const ny = month ? (month === 12 ? year + 1 : year) : year + 1;
    const nm = month ? (month === 12 ? 1 : month + 1) : 0;
    next.disabled = dbPeriodInFuture(ny, nm);
  }
}

// ---------- Zakładki: Ewidencja czasu pracy / Zalew ----------
// Wybrana zakładka jest pamiętana w tej przeglądarce. Zakładka Zalew znika, gdy moduł Zalew jest wyłączony.
const DB_TAB_KEY = "opsaDashboardTab";

function dbTabSaved() {
  try { return localStorage.getItem(DB_TAB_KEY) === "zalew" ? "zalew" : "time"; } catch (e) { return "time"; }
}

function dbSetTab(tab) {
  const zalewBtn = document.getElementById("db-tab-zalew");
  if (tab === "zalew" && zalewBtn && zalewBtn.hidden) tab = "time";
  document.querySelectorAll(".db-tab").forEach(b => {
    const on = b.dataset.dtab === tab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll(".db-pane").forEach(p => { p.hidden = p.dataset.pane !== tab; });
  try { localStorage.setItem(DB_TAB_KEY, tab); } catch (e) { /* bez zapamiętania */ }
}

function dbSyncZalewTab(enabled) {
  const btn = document.getElementById("db-tab-zalew");
  if (!btn) return;
  btn.hidden = !enabled;
  // bez Zalewu zostaje jedna zakładka - cały pasek wyboru jest wtedy zbędny
  const bar = document.querySelector(".db-tabs");
  if (bar) bar.hidden = !enabled;
  const active = document.querySelector(".db-tab.on");
  if (!enabled && active && active.dataset.dtab === "zalew") dbSetTab("time");
}

// ---------- Inicjalizacja ----------
async function initDashboardView() {
  const now = new Date();
  dbSetPeriod(now.getFullYear(), now.getMonth() + 1);

  dbSyncPeriodArrows();
  dbSetTab(dbTabSaved());
  dbInitTooltip();

  try {
    const [employees, depts] = await Promise.all([
      rpFetchAll(() => supabaseClient
        .from("employees")
        .select("id, first_name, last_name, business:business_id ( business )")),
      rpFetchAll(() => supabaseClient.from("department").select("id, department"))
    ]);
    dbEmpById = {};
    employees.forEach(e => { dbEmpById[e.id] = e; });
    dbDeptById = {};
    depts.forEach(d => { dbDeptById[d.id] = d.department; });
  } catch (err) {
    console.error("Błąd pobierania słowników dashboardu:", err);
  }

  await dbLoad();
}

// ---------- Dane ----------
async function dbLoad() {
  const root = document.getElementById("db-root");
  if (!root) return;

  const year = document.getElementById("db-filter-year").value;
  const month = document.getElementById("db-filter-month").value;
  const pattern = month ? `%.${month}.${year}` : `%.${year}`;
  const token = ++dbLoadToken;

  try {
    // Wykres roczny na dole zawsze pokazuje cały rok, niezależnie od wybranego miesiąca.
    // Przy "Cały rok" wystarcza jedno pobranie.
    const [rows, yearOnly] = await Promise.all([
      rpFetchAll(() => supabaseClient
        .from("work_reports")
        .select("*") // "*": działa też przed dodaniem kolumny id_department (sql/24)
        .like("report_date", pattern)),
      month
        ? rpFetchAll(() => supabaseClient
            .from("work_reports")
            .select("report_date, total_hours, at_work")
            .like("report_date", `%.${year}`))
        : null
    ]);
    if (token !== dbLoadToken) return; // w międzyczasie zmieniono okres

    dbRender(rows, year, month);
    dbLoadZalew(year, month, token); // osobno: błąd Zalewu (np. brak uprawnień) nie psuje reszty pulpitu
    dbRenderYear(yearOnly || rows, year, month);
  } catch (err) {
    if (token !== dbLoadToken) return;
    console.error("Błąd pobierania danych dashboardu:", err);
    document.getElementById("db-kpis").innerHTML = "";
    document.getElementById("db-time").innerHTML =
      dbEmptyHtml("Nie udało się pobrać danych: " + (err.message || err));
    document.getElementById("db-year").innerHTML = "";
  }
}

// Sumuje godziny obecne/nieobecne w mapie pod wskazanym kluczem
function dbAdd(map, key, row) {
  let entry = map.get(key);
  if (!entry) {
    entry = { present: 0, absent: 0 };
    map.set(key, entry);
  }
  const hours = parseFloat(row.total_hours) || 0;
  if (row.at_work === false) entry.absent += hours;
  else entry.present += hours;
}

function dbRender(rows, year, month) {
  const total = { present: 0, absent: 0 };
  const byTime = new Map();    // dzień miesiąca albo numer miesiąca
  const byShift = new Map();
  const byDept = new Map();
  const byBiz = new Map();
  const byEmp = new Map();
  const reports = new Set();
  const days = new Set();

  rows.forEach(r => {
    const [d, m] = String(r.report_date || "").split(".");
    const emp = dbEmpById[r.first_name_id];
    const all = new Map([["all", total]]);

    dbAdd(all, "all", r);
    dbAdd(byTime, Number(month ? d : m), r);
    dbAdd(byShift, r.shift || "Brak zmiany", r);
    // dział raportu, jak w kolumnie „Dział” na liście raportów (dział mistrza);
    // bez kolumny id_department w bazie (przed sql/24) - dział pracownika
    const deptId = "id_department" in r ? r.id_department : r.department_id;
    dbAdd(byDept, (deptId != null && (dbDeptById[deptId] || "Dział #" + deptId)) || "Brak działu", r);
    dbAdd(byBiz, emp?.business?.business || "Brak firmy", r);
    dbAdd(byEmp, r.first_name_id, r);
    reports.add(r.number_report);
    days.add(r.report_date);
  });

  const periodName = month ? `${RP_MONTHS[Number(month) - 1].toLowerCase()} ${year}` : `rok ${year}`;
  document.getElementById("db-period-label").textContent =
    `Podsumowanie czasu pracy z raportów — ${periodName}.`;

  dbRenderKpis(total, reports.size, days.size, byEmp.size);
  dbRenderTime(byTime, year, month);

  const sortByTotal = map => [...map.entries()]
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => (b.present + b.absent) - (a.present + a.absent));

  // Zmiany w stałej kolejności I, II, III; nietypowe nazwy na końcu
  const shifts = sortByTotal(byShift).sort((a, b) => {
    const ia = DB_SHIFTS.indexOf(a.label), ib = DB_SHIFTS.indexOf(b.label);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  dbRenderBars("db-shifts", shifts, "both");
  dbRenderBars("db-depts", dbFold(sortByTotal(byDept)), "both");
  dbRenderBars("db-biz", dbFold(sortByTotal(byBiz)), "both");

  const emps = [...byEmp.entries()].map(([id, v]) => {
    const e = dbEmpById[id];
    return { label: e ? `${e.first_name || ""} ${e.last_name || ""}`.trim() : `Pracownik #${id}`, ...v };
  });
  dbRenderBars("db-top-present",
    emps.filter(e => e.present > 0).sort((a, b) => b.present - a.present).slice(0, DB_TOP), "present");
  dbRenderBars("db-top-absent",
    emps.filter(e => e.absent > 0).sort((a, b) => b.absent - a.absent).slice(0, DB_TOP), "absent");
}

// Zostawia DB_TOP największych pozycji, resztę łączy w "Pozostałe"
function dbFold(items) {
  if (items.length <= DB_TOP) return items;
  const rest = items.slice(DB_TOP - 1).reduce(
    (acc, it) => ({ label: acc.label, present: acc.present + it.present, absent: acc.absent + it.absent }),
    { label: `Pozostałe (${items.length - DB_TOP + 1})`, present: 0, absent: 0 }
  );
  return [...items.slice(0, DB_TOP - 1), rest];
}

// ---------- Kafelki ----------
function dbRenderKpis(total, reportCount, dayCount, empCount) {
  const all = total.present + total.absent;
  const rate = all > 0 ? (total.absent / all) * 100 : 0;
  const perEmp = empCount > 0 ? total.present / empCount : 0;

  const tile = (cls, icon, label, value, unit, note, extra = "") => `
    <div class="db-kpi ${cls}">
      <div class="lbl"><span class="ico"><i class="fa-solid ${icon}"></i></span>${label}</div>
      <div class="val">${value}${unit ? `<small>${unit}</small>` : ""}</div>
      ${extra}
      <div class="note">${note}</div>
    </div>`;

  document.getElementById("db-kpis").innerHTML =
    tile("lead", "fa-clock", "Godziny obecne", dbNum(total.present), "h",
      `Średnio ${dbNum(perEmp)} h na pracownika`) +
    tile("absent", "fa-user-xmark", "Godziny nieobecne", dbNum(total.absent), "h",
      `z ${dbNum(all)} h zgłoszonych łącznie`) +
    tile("rate", "fa-percent", "Wskaźnik absencji", dbNum(rate), "%",
      "Udział godzin nieobecnych w zgłoszonych",
      `<div class="db-meter" aria-hidden="true"><span style="width: ${Math.min(rate, 100)}%;"></span></div>`) +
    tile("", "fa-file-lines", "Raporty", dbNum(reportCount, 0), "",
      `Dni z raportami: ${dbNum(dayCount, 0)}`) +
    tile("", "fa-users", "Pracownicy", dbNum(empCount, 0), "",
      "Osoby ujęte w raportach");
}

// ---------- Wykres: godziny w czasie ----------
function dbRenderTime(byTime, year, month) {
  const el = document.getElementById("db-time");
  const title = document.getElementById("db-time-title");
  const sub = document.getElementById("db-time-sub");

  const count = month ? new Date(Number(year), Number(month), 0).getDate() : 12;
  const points = Array.from({ length: count }, (_, i) => {
    const key = i + 1;
    const v = byTime.get(key) || { present: 0, absent: 0 };
    const axis = month ? String(key) : RP_MONTHS[i].slice(0, 3);
    const full = month ? `${String(key).padStart(2, "0")}.${month}.${year}` : `${RP_MONTHS[i]} ${year}`;
    return { key, axis, full, ...v };
  });

  title.textContent = month ? "Godziny dzień po dniu" : "Godziny w kolejnych miesiącach";
  document.getElementById("db-legend-weekend").style.display = month ? "" : "none";
  const maxTotal = Math.max(...points.map(p => p.present + p.absent));

  if (maxTotal <= 0) {
    sub.textContent = "";
    el.innerHTML = dbEmptyHtml("Brak raportów w wybranym okresie.");
    return;
  }

  const peak = points.reduce((a, b) => ((b.present + b.absent) > (a.present + a.absent) ? b : a));
  sub.textContent = `Najwięcej zgłoszonych godzin: ${peak.full} (${dbHours(peak.present + peak.absent)})`;

  const max = dbNiceMax(maxTotal);
  const ticks = [0, 1, 2, 3, 4].map(i => (max / 4) * i);

  const yAxis = ticks.map(t => `<span style="bottom: ${(t / max) * 100}%;">${dbNum(t)}</span>`).join("");
  const grid = ticks.map(t =>
    `<i class="${t === 0 ? "base" : ""}" style="bottom: ${(t / max) * 100}%;"></i>`).join("");

  const cols = points.map(p => {
    const sum = p.present + p.absent;
    // na telefonie podpisy co 5 dni (plus pierwszy), żeby się nie zlewały
    const minor = month && !(p.key === 1 || p.key % 5 === 0) ? " minor" : "";
    const stack = sum > 0 ? `
      <div class="stack" style="height: ${(sum / max) * 100}%;">
        ${p.absent > 0 ? `<span class="seg a" style="flex: ${p.absent} 0 0;"></span>` : ""}
        ${p.present > 0 ? `<span class="seg p" style="flex: ${p.present} 0 0;"></span>` : ""}
      </div>` : "";
    // Weekend (tylko w widoku dni): sobota i niedziela mają własne tło kolumny
    const weekday = month ? new Date(Number(year), Number(month) - 1, p.key).getDay() : -1;
    const dayClass = weekday === 6 ? " sat" : weekday === 0 ? " sun" : "";
    const dayName = weekday === 6 ? " (sobota)" : weekday === 0 ? " (niedziela)" : "";
    const label = `${p.full}${dayName}: obecne ${dbHours(p.present)}, nieobecne ${dbHours(p.absent)}`;

    return `
      <div class="db-col${dayClass}" tabindex="0" role="img" aria-label="${rtEsc(label)}"
           data-tip="${dbTipAttr(p.full + dayName, dbHoursLines(p.present, p.absent))}">
        <div class="area">${stack}</div>
        <div class="xl${minor}">${rtEsc(p.axis)}</div>
      </div>`;
  }).join("");

  el.innerHTML = `
    <div class="db-chart">
      <div class="db-yaxis" aria-hidden="true">${yAxis}</div>
      <div class="db-plot">
        <div class="db-gridlines">${grid}</div>
        <div class="db-cols">${cols}</div>
      </div>
    </div>`;
}


// ---------- Wykres: cały rok, miesiące podzielone na tygodnie ----------
// Tygodnie są numerowane kolejno przez cały rok (od poniedziałku do niedzieli; tydzień 1
// zaczyna się 1 stycznia). Tydzień na przełomie miesięcy ma po jednej kolumnie w każdym
// z nich, z tym samym numerem - dzięki temu sumy miesięcy się zgadzają.
function dbWeekOfYear(year, month, day) {
  const jan1 = new Date(year, 0, 1);
  const offset = (jan1.getDay() + 6) % 7; // poniedziałek = 0
  const dayOfYear = Math.round((new Date(year, month - 1, day) - jan1) / 86400000);
  return Math.floor((dayOfYear + offset) / 7) + 1;
}

function dbRenderYear(rows, year, selectedMonth) {
  const el = document.getElementById("db-year");
  const title = document.getElementById("db-year-title");
  if (!el) return;
  if (title) title.textContent = `Godziny w miesiącach — ${year}`;

  const y = Number(year);

  // months[m] = lista tygodni tego miesiąca: { week, from, to, present, absent }
  const months = Array.from({ length: 12 }, (_, mi) => {
    const weeks = [];
    const daysInMonth = new Date(y, mi + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const week = dbWeekOfYear(y, mi + 1, d);
      const last = weeks[weeks.length - 1];
      if (last && last.week === week) last.to = d;
      else weeks.push({ week, from: d, to: d, present: 0, absent: 0 });
    }
    return weeks;
  });

  rows.forEach(r => {
    const [d, m] = String(r.report_date || "").split(".").map(Number);
    if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return;
    const cell = months[m - 1].find(w => d >= w.from && d <= w.to);
    if (!cell) return;
    const hours = parseFloat(r.total_hours) || 0;
    if (r.at_work === false) cell.absent += hours;
    else cell.present += hours;
  });

  const maxWeek = Math.max(...months.flat().map(c => c.present + c.absent));
  if (maxWeek <= 0) {
    el.innerHTML = dbEmptyHtml(`Brak raportów w roku ${year}.`);
    return;
  }

  const max = dbNiceMax(maxWeek);
  const ticks = [0, 1, 2, 3, 4].map(i => (max / 4) * i);
  const yAxis = ticks.map(t => `<span style="bottom: ${(t / max) * 100}%;">${dbNum(t)}</span>`).join("");
  const grid = ticks.map(t =>
    `<i class="${t === 0 ? "base" : ""}" style="bottom: ${(t / max) * 100}%;"></i>`).join("");
  const p2 = n => String(n).padStart(2, "0");

  const groups = months.map((weeks, mi) => {
    const monthName = RP_MONTHS[mi];
    const mm = p2(mi + 1);
    const total = weeks.reduce((acc, c) => ({ present: acc.present + c.present, absent: acc.absent + c.absent }),
      { present: 0, absent: 0 });

    const cols = weeks.map(c => {
      const sum = c.present + c.absent;
      const range = c.from === c.to ? `${p2(c.from)}.${mm}.${year}` : `${p2(c.from)}.${mm}–${p2(c.to)}.${mm}.${year}`;
      const name = `Tydzień ${c.week} (${range})`;
      const stack = sum > 0 ? `
        <div class="stack" style="height: ${(sum / max) * 100}%;">
          ${c.absent > 0 ? `<span class="seg a" style="flex: ${c.absent} 0 0;"></span>` : ""}
          ${c.present > 0 ? `<span class="seg p" style="flex: ${c.present} 0 0;"></span>` : ""}
        </div>` : "";

      return `
        <div class="db-col" tabindex="0" role="img"
             aria-label="${rtEsc(`${name}: obecne ${dbHours(c.present)}, nieobecne ${dbHours(c.absent)}`)}"
             data-tip="${dbTipAttr(name, dbHoursLines(c.present, c.absent))}">
          <div class="area">${stack}</div>
          <div class="wk">${c.week}</div>
        </div>`;
    }).join("");

    const isSelected = selectedMonth && Number(selectedMonth) === mi + 1;
    const monthTip = dbTipAttr(`${monthName} ${year} — razem`, dbHoursLines(total.present, total.absent));

    return `
      <div class="db-mgroup ${isSelected ? "selected" : ""}">
        <div class="weeks">${cols}</div>
        <div class="mxl" tabindex="0" data-tip="${monthTip}">
          <span class="mn">${rtEsc(monthName.slice(0, 3))}</span>
          <span class="tot ok" title="Godziny obecne">${dbHours(total.present)}</span>
          <span class="tot absent" title="Godziny nieobecne">${dbHours(total.absent)}</span>
        </div>
      </div>`;
  }).join("");

  el.innerHTML = `
    <div class="db-chart months">
      <div class="db-yaxis" aria-hidden="true">${yAxis}</div>
      <div class="db-plot">
        <div class="db-gridlines">${grid}</div>
        <div class="db-cols">${groups}</div>
      </div>
    </div>`;
}

// ---------- Listy słupków poziomych ----------
// mode: "both" (obecne + nieobecne), "present" albo "absent" (jedna miara)
function dbRenderBars(containerId, items, mode) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const value = it => (mode === "present" ? it.present : mode === "absent" ? it.absent : it.present + it.absent);
  const max = Math.max(0, ...items.map(value));

  if (items.length === 0 || max <= 0) {
    el.innerHTML = dbEmptyHtml("Brak danych w wybranym okresie.");
    return;
  }

  el.innerHTML = `<div class="db-bars">` + items.map(it => {
    const p = mode === "absent" ? 0 : it.present;
    const a = mode === "present" ? 0 : it.absent;
    const num = mode === "both"
      ? `<b>${dbHours(it.present)}</b> · ${dbHours(it.absent)} nieob.`
      : `<b>${dbHours(value(it))}</b>`;

    return `
      <div class="db-bar" tabindex="0" data-tip="${dbTipAttr(it.label, dbHoursLines(it.present, it.absent))}">
        <div class="top">
          <span class="name">${rtEsc(it.label)}</span>
          <span class="num">${num}</span>
        </div>
        <div class="track" aria-hidden="true">
          ${p > 0 ? `<span class="p" style="width: ${(p / max) * 100}%;"></span>` : ""}
          ${a > 0 ? `<span class="a" style="width: ${(a / max) * 100}%;"></span>` : ""}
        </div>
      </div>`;
  }).join("") + `</div>`;
}

// ---------- Dymek ----------
function dbInitTooltip() {
  const root = document.getElementById("db-root");
  const tip = document.getElementById("db-tip");
  if (!root || !tip) return;

  const show = (target) => {
    const parts = (target.dataset.tip || "").split("|");
    if (!parts[0]) return;

    tip.textContent = "";
    const title = document.createElement("strong");
    title.textContent = parts[0];
    tip.appendChild(title);
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const row = document.createElement("div");
      row.className = "row";
      const dot = document.createElement("i");
      dot.style.background = parts[i];
      row.appendChild(dot);
      row.appendChild(document.createTextNode(parts[i + 1]));
      tip.appendChild(row);
    }

    tip.style.display = "block";
    const rect = target.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), window.innerWidth - w - 8);
    const top = rect.top - h - 8 >= 8 ? rect.top - h - 8 : rect.bottom + 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  const hide = () => { tip.style.display = "none"; };

  root.addEventListener("mouseover", e => {
    const target = e.target.closest("[data-tip]");
    if (target) show(target); else hide();
  });
  root.addEventListener("mouseleave", hide);
  root.addEventListener("focusin", e => {
    const target = e.target.closest("[data-tip]");
    if (target) show(target);
  });
  root.addEventListener("focusout", hide);
}

// ---------- Zalew: podsumowanie zalewów w wybranym okresie ----------
// Tabela zalewy (moduł Zalew). Podział na zmiany I, II, III i ogółem,
// a pod spodem waga w rozbiciu na linie i zmiany.
const DB_ZW_SHIFTS = ["Zmiana I", "Zmiana II", "Zmiana III"];
const DB_ZW_LINES = ["Lora", "HWS", "HWS-D", "SMS"];
const DB_ZW_TOP_MODELS = 10;  // ile modeli pokazać w tabeli "Zalane modele"

function dbKg(value) {
  return `${dbNum(value, 0)} kg`;
}

async function dbLoadZalew(year, month, token) {
  const el = document.getElementById("db-zalew");
  const sub = document.getElementById("db-zalew-sub");
  if (!el) return;

  // Moduł Zalew wyłączony w Opcjach: panel w ogóle się nie pokazuje.
  // Ustawienia modułów pobierane od nowa, żeby zmiana w Opcjach działała bez przelogowania.
  const panel = document.getElementById("db-zalew-panel");
  if (panel) panel.style.display = moduleEnabled("zalew") ? "" : "none"; // od razu, bez mignięcia
  dbSyncZalewTab(moduleEnabled("zalew"));
  await loadModules();
  if (token !== dbLoadToken) return;
  const zalewOn = moduleEnabled("zalew");
  if (panel) panel.style.display = zalewOn ? "" : "none";
  dbSyncZalewTab(zalewOn);
  if (!zalewOn) {
    el.innerHTML = "";
    return;
  }

  const pad = n => String(n).padStart(2, "0");
  const from = month ? `${year}-${month}-01` : `${year}-01-01`;
  const to = month
    ? `${year}-${month}-${pad(new Date(Number(year), Number(month), 0).getDate())}`
    : `${year}-12-31`;
  if (sub) {
    sub.textContent = month
      ? `${RP_MONTHS[Number(month) - 1]} ${year} — kadzie, formy i waga zalana na wszystkich liniach`
      : `Rok ${year} — kadzie, formy i waga zalana na wszystkich liniach`;
  }
  el.innerHTML = `<div class="db-empty"><i class="fa-solid fa-spinner fa-spin"></i>Ładowanie zalewów...</div>`;

  let rows;
  try {
    rows = await rpFetchAll(() => supabaseClient
      .from("zalewy")
      .select("id, data_zalewu, zmiana, linia, numer_kadzi, nr_modelu, ilosc_form, waga_razem")
      .gte("data_zalewu", from)
      .lte("data_zalewu", to));
  } catch (err) {
    if (token !== dbLoadToken) return;
    console.error("Błąd pobierania zalewów do pulpitu:", err);
    el.innerHTML = dbEmptyHtml("Nie udało się pobrać zalewów: " + (err.message || err));
    return;
  }
  if (token !== dbLoadToken) return;

  const sums = rowsOf => ({
    ladles: new Set(rowsOf.map(r => `${r.zmiana}|${r.linia}|${String(r.numer_kadzi || "").trim()}`)).size,
    forms: rowsOf.reduce((s, r) => s + (Number(r.ilosc_form) || 0), 0),
    weight: rowsOf.reduce((s, r) => s + (Number(r.waga_razem) || 0), 0)
  });

  if (rows.length === 0) {
    el.innerHTML = dbEmptyHtml("Brak zalewów w wybranym okresie.");
    return;
  }

  const total = sums(rows);
  const tile = (title, s, cls) => `
    <div class="db-zw-tile ${cls}">
      <div class="lbl">${rtEsc(title)}</div>
      <div class="val">${dbKg(s.weight)}</div>
      <div class="note">Kadzi: <b>${dbNum(s.ladles, 0)}</b> • Form: <b>${dbNum(s.forms, 0)}</b></div>
    </div>`;

  const shiftTiles = DB_ZW_SHIFTS.map((shift, i) => tile(shift, sums(rows.filter(r => r.zmiana === shift)), `z${i + 1}`)).join("");
  const other = rows.filter(r => !DB_ZW_SHIFTS.includes(r.zmiana));

  // Linie x zmiany: w każdej komórce waga, kadzie i formy
  const cellSums = (line, shift) =>
    sums(rows.filter(r => (!line || r.linia === line) && (!shift || r.zmiana === shift)));
  const cellHtml = s => s.weight || s.forms
    ? `<div class="w">${dbKg(s.weight)}</div><div class="kf">Kadzi: <b>${dbNum(s.ladles, 0)}</b> • Form: <b>${dbNum(s.forms, 0)}</b></div>`
    : `<div class="none">—</div>`;

  const lineRows = DB_ZW_LINES.map(line => `
    <tr>
      <td class="ln">${rtEsc(line)}</td>
      ${DB_ZW_SHIFTS.map(shift => `<td>${cellHtml(cellSums(line, shift))}</td>`).join("")}
      <td class="tot">${cellHtml(cellSums(line, null))}</td>
    </tr>`).join("");

  // Modele zalane w okresie: od największej wagi
  const byModel = new Map();
  rows.forEach(r => {
    const key = `${r.linia}|${String(r.nr_modelu || "").trim() || "-"}`;
    if (!byModel.has(key)) byModel.set(key, { line: r.linia, model: String(r.nr_modelu || "").trim() || "-", rows: [] });
    byModel.get(key).rows.push(r);
  });
  const models = [...byModel.values()]
    .map(m => ({ ...m, s: sums(m.rows) }))
    .sort((a, b) => b.s.weight - a.s.weight || b.s.forms - a.s.forms);
  const topModels = models.slice(0, DB_ZW_TOP_MODELS);

  el.innerHTML = `
    <div class="db-zw-tiles">
      ${tile("Ogółem", total, "main")}
      ${shiftTiles}
    </div>
    ${dbZalewChart(rows, year, month)}
    ${dbZalewLineCharts(rows, year, month)}
    ${other.length ? `<p class="db-zw-other">Wpisy bez przypisanej zmiany: ${dbNum(other.length, 0)} (${dbKg(sums(other).weight)}) — są wliczone tylko do „Ogółem”.</p>` : ""}

    <h5 class="db-zw-h">Linie i zmiany</h5>
    <div style="overflow-x: auto;">
      <table class="db-zw-table">
        <thead>
          <tr>
            <th>Linia</th>
            ${DB_ZW_SHIFTS.map((s, i) => `<th><i class="db-zw-dot z${i + 1}"></i>${rtEsc(s)}</th>`).join("")}
            <th>Razem</th>
          </tr>
        </thead>
        <tbody>
          ${lineRows}
          <tr class="sum">
            <td class="ln">Wszystkie linie</td>
            ${DB_ZW_SHIFTS.map(shift => `<td>${cellHtml(cellSums(null, shift))}</td>`).join("")}
            <td class="tot">${cellHtml(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <h5 class="db-zw-h">Zalane modele${models.length > DB_ZW_TOP_MODELS ? ` — ${DB_ZW_TOP_MODELS} największych z ${models.length}` : ""}</h5>
    <div style="overflow-x: auto;">
      <table class="db-zw-table models">
        <thead>
          <tr>
            <th>Model</th>
            <th>Linia</th>
            <th>Kadzi</th>
            <th>Form</th>
            <th>Waga</th>
            <th>Udział</th>
          </tr>
        </thead>
        <tbody>
          ${topModels.map(m => {
            const share = total.weight > 0 ? (m.s.weight / total.weight) * 100 : 0;
            return `
              <tr>
                <td class="ln">${rtEsc(m.model)}</td>
                <td>${rtEsc(m.line || "-")}</td>
                <td>${dbNum(m.s.ladles, 0)}</td>
                <td>${dbNum(m.s.forms, 0)}</td>
                <td class="tot">${dbKg(m.s.weight)}</td>
                <td class="share"><span class="bar"><span style="width: ${Math.min(share, 100)}%;"></span></span>${dbNum(share)}%</td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
}

// Wykres zalewów: dzień po dniu (albo miesiąc po miesiącu przy "Cały rok"),
// kolumna podzielona na zmiany: I zielona, II żółta, III czerwona
// opts.max - wspólna skala (wykresy linii porównywalne między sobą), opts.small - niższy wykres
function dbZalewChart(rows, year, month, opts = {}) {
  const count = month ? new Date(Number(year), Number(month), 0).getDate() : 12;
  const points = Array.from({ length: count }, (_, i) => {
    const key = i + 1;
    const mm = month || String(key).padStart(2, "0");
    const prefix = month ? `${year}-${month}-${String(key).padStart(2, "0")}` : `${year}-${mm}`;
    const inPoint = rows.filter(r => String(r.data_zalewu || "").startsWith(prefix));
    const perShift = DB_ZW_SHIFTS.map(s =>
      inPoint.filter(r => r.zmiana === s).reduce((sum, r) => sum + (Number(r.waga_razem) || 0), 0));
    return {
      key,
      axis: month ? String(key) : RP_MONTHS[i].slice(0, 3),
      full: month ? `${String(key).padStart(2, "0")}.${month}.${year}` : `${RP_MONTHS[i]} ${year}`,
      perShift,
      total: perShift.reduce((a, b) => a + b, 0)
    };
  });

  const maxTotal = Math.max(...points.map(p => p.total));
  if (maxTotal <= 0 && !opts.small) return "";

  const max = opts.max || dbNiceMax(maxTotal);
  const ticks = [0, 1, 2, 3, 4].map(i => (max / 4) * i);
  // duże wartości na osi w tonach, żeby się mieściły
  const tickLabel = t => (max >= 10000 ? `${dbNum(t / 1000)} t` : dbNum(t, 0));
  const yAxis = ticks.map(t => `<span style="bottom: ${(t / max) * 100}%;">${tickLabel(t)}</span>`).join("");
  const grid = ticks.map(t => `<i class="${t === 0 ? "base" : ""}" style="bottom: ${(t / max) * 100}%;"></i>`).join("");
  const colors = ["var(--db-z1)", "var(--db-z2)", "var(--db-z3)"];

  const cols = points.map(p => {
    const weekday = month ? new Date(Number(year), Number(month) - 1, p.key).getDay() : -1;
    const dayClass = weekday === 6 ? " sat" : weekday === 0 ? " sun" : "";
    const minor = month && !(p.key === 1 || p.key % 5 === 0) ? " minor" : "";
    // od góry: zmiana III, II, I (zmiana I przy osi)
    const segs = [2, 1, 0]
      .filter(i => p.perShift[i] > 0)
      .map(i => `<span class="seg z${i + 1}" style="flex: ${p.perShift[i]} 0 0;"></span>`).join("");
    const lines = DB_ZW_SHIFTS.map((s, i) => [colors[i], `${s}: ${dbKg(p.perShift[i])}`]);
    lines.push(["transparent", `Razem: ${dbKg(p.total)}`]);
    const label = `${p.full}: ` + DB_ZW_SHIFTS.map((s, i) => `${s} ${dbKg(p.perShift[i])}`).join(", ");

    return `
      <div class="db-col${dayClass}" tabindex="0" role="img" aria-label="${rtEsc(label)}"
           data-tip="${dbTipAttr(p.full, lines)}">
        <div class="area">${p.total > 0 ? `<div class="stack" style="height: ${(p.total / max) * 100}%;">${segs}</div>` : ""}</div>
        <div class="xl${minor}">${rtEsc(p.axis)}</div>
      </div>`;
  }).join("");

  return `
    <div class="db-chart db-zw-chart${opts.small ? " small" : ""}">
      <div class="db-yaxis" aria-hidden="true">${yAxis}</div>
      <div class="db-plot">
        <div class="db-gridlines">${grid}</div>
        <div class="db-cols">${cols}</div>
      </div>
    </div>`;
}

// Najwyższa suma dnia (albo miesiąca) w podanych wierszach - do wspólnej skali wykresów linii
function dbZalewMaxPoint(rows, year, month) {
  const totals = new Map();
  rows.forEach(r => {
    const d = String(r.data_zalewu || "");
    const key = month ? d.slice(0, 10) : d.slice(0, 7);
    totals.set(key, (totals.get(key) || 0) + (Number(r.waga_razem) || 0));
  });
  return Math.max(0, ...totals.values());
}

// Osobny wykres dla każdej linii (Lora, HWS, HWS-D, SMS), z tą samą skalą,
// żeby linie dało się porównać na oko; kolory zmian jak na wykresie ogólnym
function dbZalewLineCharts(rows, year, month) {
  const perLine = DB_ZW_LINES.map(line => ({ line, rows: rows.filter(r => r.linia === line) }));
  const max = dbNiceMax(Math.max(...perLine.map(l => dbZalewMaxPoint(l.rows, year, month))));
  if (max <= 0) return "";

  return `
    <h5 class="db-zw-h">Linie</h5>
    <div class="db-zw-lines">
      ${perLine.map(l => {
        const weight = l.rows.reduce((s, r) => s + (Number(r.waga_razem) || 0), 0);
        const forms = l.rows.reduce((s, r) => s + (Number(r.ilosc_form) || 0), 0);
        return `
          <div class="db-zw-line">
            <div class="db-zw-line-head">
              <span class="name">${rtEsc(l.line)}</span>
              <span class="sum">${dbKg(weight)} • form: ${dbNum(forms, 0)}</span>
            </div>
            ${l.rows.length
              ? dbZalewChart(l.rows, year, month, { max, small: true })
              : `<div class="db-empty" style="padding: 30px 10px;">Brak zalewów na tej linii.</div>`}
          </div>`;
      }).join("")}
    </div>`;
}
