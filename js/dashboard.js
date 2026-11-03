// ==========================================
// MODUŁ: DASHBOARD
// Źródło: work_reports (+ słowniki employees, department)
// Wymaga: supabaseClient (app.js), rt* (report_time.js), rpFetchAll / RP_MONTHS / RP_YEARS_BACK (reports.js)
// ==========================================

const DB_TOP = 6;            // ile pozycji w listach działów, firm i pracowników
const DB_COUNT_MS = 600;     // jak długo liczby w kafelkach nabijają się do wartości

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

function dbHoursLines(present, absent, pendP = 0, pendA = 0) {
  const lines = [
    ["var(--db-present)", `Obecne: ${dbHours(present)}`],
    ["var(--db-absent)", `Nieobecne: ${dbHours(absent)}`]
  ];
  if (pendP > 0) lines.push(["var(--db-present-soft)", `Obecne do zatwierdzenia: ${dbHours(pendP)}`]);
  if (pendA > 0) lines.push(["var(--db-absent-soft)", `Nieobecne do zatwierdzenia: ${dbHours(pendA)}`]);
  return lines;
}

// Stan raportu (sql/34). Przed nim nie ma tej kolumny - wszystko liczy się jak zatwierdzone
function dbStatus(row) {
  return row.approval_status || "approved";
}

// Dolicza godziny wiersza: zatwierdzone (present, absent) albo do zatwierdzenia (pendP, pendA)
function dbAddHours(entry, row) {
  const hours = parseFloat(row.total_hours) || 0;
  const away = row.at_work === false;
  if (dbStatus(row) === "pending") {
    if (away) entry.pendA += hours; else entry.pendP += hours;
  } else if (away) {
    entry.absent += hours;
  } else {
    entry.present += hours;
  }
}

// Liczba w kafelku nabija się od zera do wartości (dbRunCounts); bez JS / animacji od razu właściwa
function dbCountHtml(value, digits = 1) {
  return `<span data-count="${value}" data-digits="${digits}">${dbNum(value, digits)}</span>`;
}

function dbRunCounts(root) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const start = performance.now();
  const items = [...root.querySelectorAll("[data-count]")].map(el => ({
    el, target: Number(el.dataset.count), digits: Number(el.dataset.digits)
  }));
  const step = now => {
    const t = Math.min(1, (now - start) / DB_COUNT_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    items.forEach(({ el, target, digits }) => {
      el.textContent = dbNum(t < 1 ? target * eased : target, digits);
    });
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  // karta w tle nie rysuje klatek - właściwa wartość i tak musi się pojawić
  setTimeout(() => items.forEach(({ el, target, digits }) => { el.textContent = dbNum(target, digits); }), DB_COUNT_MS + 100);
}

function dbEmptyEntry() {
  return { present: 0, absent: 0, pendP: 0, pendA: 0 };
}

function dbEntrySum(e) {
  return e.present + e.absent + e.pendP + e.pendA;
}

// Słupek wykresu: u góry kreskowane godziny do zatwierdzenia, pod nimi zatwierdzone.
// index - numer kolumny: słupki wyrastają kolejno (--i, views/dashboard.html)
function dbStackHtml(v, max, index = 0) {
  const sum = dbEntrySum(v);
  if (sum <= 0) return "";
  const seg = (cls, hours) => (hours > 0 ? `<span class="seg ${cls}" style="flex: ${hours} 0 0;"></span>` : "");
  return `
    <div class="stack" style="height: ${(sum / max) * 100}%; --i: ${index};">
      ${seg("pa", v.pendA)}${seg("pp", v.pendP)}${seg("a", v.absent)}${seg("p", v.present)}
    </div>`;
}

// Opis słupka dla czytników ekranu
function dbAriaHours(v) {
  const pend = v.pendP + v.pendA;
  return `obecne ${dbHours(v.present)}, nieobecne ${dbHours(v.absent)}${pend > 0 ? `, do zatwierdzenia ${dbHours(pend)}` : ""}`;
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
  const wasZalew = !!document.querySelector('.db-tab.on[data-dtab="zalew"]');
  document.querySelectorAll(".db-tab").forEach(b => {
    const on = b.dataset.dtab === tab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll(".db-pane").forEach(p => { p.hidden = p.dataset.pane !== tab; });
  // nagłówek: miesiąc dla ewidencji, tydzień dla Zalewu
  document.querySelectorAll("[data-only]").forEach(el => { el.hidden = el.dataset.only !== tab; });
  // przejście z ewidencji na Zalew: kadź spada z góry na swoje miejsce
  if (tab === "zalew" && !wasZalew && typeof zwDropLadle === "function") zwDropLadle();
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
  // tydzień zalewu ma własny wybór tygodnia - nie zależy od miesiąca pulpitu
  if (typeof zwDashOpenInApp === "function" && (typeof moduleEnabled !== "function" || moduleEnabled("zalew"))) {
    zwDashOpenInApp();
  }

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
    // Główne liczby to zatwierdzone raporty; oczekujące są osobno (dopiski, kreskowane słupki),
    // a odrzucone tylko w pasku nad kafelkami (sql/34; przed nim każdy raport liczy się jak zatwierdzony)
    const hasStatus = await rpaApprovedOnly();
    const [rows, yearOnly] = await Promise.all([
      rpFetchAll(() => supabaseClient
        .from("work_reports")
        .select("*") // "*": działa też przed dodaniem kolumny id_department (sql/24)
        .like("report_date", pattern)),
      month
        ? rpFetchAll(() => supabaseClient
            .from("work_reports")
            .select(`report_date, total_hours, at_work${hasStatus ? ", approval_status" : ""}`)
            .like("report_date", `%.${year}`))
        : null
    ]);
    if (token !== dbLoadToken) return; // w międzyczasie zmieniono okres

    dbRender(rows, year, month);
    dbSyncZalewModule(token);
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

// Sumuje godziny w mapie pod wskazanym kluczem
function dbAdd(map, key, row) {
  let entry = map.get(key);
  if (!entry) {
    entry = dbEmptyEntry();
    map.set(key, entry);
  }
  dbAddHours(entry, row);
}

function dbRender(rows, year, month) {
  const total = dbEmptyEntry();
  const byTime = new Map();    // dzień miesiąca albo numer miesiąca
  const byDept = new Map();
  const byBiz = new Map();
  const byEmp = new Map();
  // Raporty, dni i pracownicy w kafelkach: tylko zatwierdzone
  const reports = new Set();
  const days = new Set();
  const people = new Set();
  // Pasek nad kafelkami: co czeka w wybranym okresie
  const waiting = { pendReports: new Set(), rejHours: 0, rejReports: new Set() };

  rows.forEach(r => {
    const status = dbStatus(r);
    if (status === "rejected") {     // odrzucony raport się zmieni - bez wykresów, tylko w pasku
      waiting.rejHours += parseFloat(r.total_hours) || 0;
      waiting.rejReports.add(r.number_report);
      return;
    }
    if (status === "pending") {
      waiting.pendReports.add(r.number_report);
    } else {
      reports.add(r.number_report);
      days.add(r.report_date);
      people.add(r.first_name_id);
    }

    const [d, m] = String(r.report_date || "").split(".");
    const emp = dbEmpById[r.first_name_id];

    dbAddHours(total, r);
    dbAdd(byTime, Number(month ? d : m), r);
    // dział raportu, jak w kolumnie „Dział” na liście raportów (dział mistrza);
    // bez kolumny id_department w bazie (przed sql/24) - dział pracownika
    const deptId = "id_department" in r ? r.id_department : r.department_id;
    dbAdd(byDept, (deptId != null && (dbDeptById[deptId] || "Dział #" + deptId)) || "Brak działu", r);
    dbAdd(byBiz, emp?.business?.business || "Brak firmy", r);
    dbAdd(byEmp, r.first_name_id, r);
  });

  const periodName = month ? `${RP_MONTHS[Number(month) - 1].toLowerCase()} ${year}` : `rok ${year}`;
  document.getElementById("db-period-label").textContent =
    `Podsumowanie czasu pracy z raportów — ${periodName}.`;

  dbRenderPending(total.pendP + total.pendA, waiting);
  dbRenderKpis(total, reports.size, days.size, people.size);
  dbRenderTime(byTime, year, month);
  const legendPend = document.getElementById("db-legend-pend");
  if (legendPend) legendPend.style.display = total.pendP + total.pendA > 0 ? "" : "none";

  // Kolejność według zatwierdzonych; przy remisie decydują oczekujące
  const sortByTotal = map => [...map.entries()]
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => (b.present + b.absent) - (a.present + a.absent) || (b.pendP + b.pendA) - (a.pendP + a.pendA));

  dbRenderBars("db-depts", dbFold(sortByTotal(byDept)), "both");
  dbRenderBars("db-biz", dbFold(sortByTotal(byBiz)), "both");

  const emps = [...byEmp.entries()].map(([id, v]) => {
    const e = dbEmpById[id];
    return { label: e ? `${e.first_name || ""} ${e.last_name || ""}`.trim() : `Pracownik #${id}`, ...v };
  });
  dbRenderBars("db-top-present",
    emps.filter(e => e.present + e.pendP > 0).sort((a, b) => b.present - a.present || b.pendP - a.pendP).slice(0, DB_TOP), "present");
  dbRenderBars("db-top-absent",
    emps.filter(e => e.absent + e.pendA > 0).sort((a, b) => b.absent - a.absent || b.pendA - a.pendA).slice(0, DB_TOP), "absent");
}

// ---------- Pasek: co czeka na zatwierdzenie i poprawę w wybranym okresie ----------
// Klikalny dla zatwierdzających - tylko oni widzą w zakładkach wszystkie te raporty
function dbRenderPending(pendHours, waiting) {
  const el = document.getElementById("db-pending");
  if (!el) return;
  const canOpen = typeof rpaCanApprove === "function" && rpaCanApprove();
  const inReports = n => `${dbNum(n, 0)} ${n === 1 ? "raporcie" : "raportach"}`;
  const item = (cls, icon, label, hours, count, tab) => {
    const text = `<i class="fa-solid ${icon}"></i><span>${label}: <b>${dbHours(hours)}</b> w ${inReports(count)}</span>`;
    return canOpen
      ? `<button type="button" class="db-wait ${cls}" onclick="rpaOpenTab('${tab}')">${text}<i class="fa-solid fa-chevron-right go"></i></button>`
      : `<div class="db-wait ${cls}">${text}</div>`;
  };
  const parts = [];
  if (waiting.pendReports.size) parts.push(item("pend", "fa-hourglass-half", "Do zatwierdzenia", pendHours, waiting.pendReports.size, "pending"));
  if (waiting.rejReports.size) parts.push(item("rej", "fa-pen", "Do poprawy", waiting.rejHours, waiting.rejReports.size, "rejected"));
  el.innerHTML = parts.join("");
  el.hidden = !parts.length;
}

// Zostawia DB_TOP największych pozycji, resztę łączy w "Pozostałe"
function dbFold(items) {
  if (items.length <= DB_TOP) return items;
  const rest = items.slice(DB_TOP - 1).reduce(
    (acc, it) => ({
      label: acc.label,
      present: acc.present + it.present,
      absent: acc.absent + it.absent,
      pendP: acc.pendP + it.pendP,
      pendA: acc.pendA + it.pendA
    }),
    { label: `Pozostałe (${items.length - DB_TOP + 1})`, ...dbEmptyEntry() }
  );
  return [...items.slice(0, DB_TOP - 1), rest];
}

// ---------- Kafelki ----------
function dbRenderKpis(total, reportCount, dayCount, empCount) {
  const all = total.present + total.absent;
  const rate = all > 0 ? (total.absent / all) * 100 : 0;
  const perEmp = empCount > 0 ? total.present / empCount : 0;

  const tile = (cls, icon, label, value, unit, note, extra = "", pending = 0) => `
    <div class="db-kpi ${cls}">
      <div class="lbl"><span class="ico"><i class="fa-solid ${icon}"></i></span>${label}</div>
      <div class="val">${value}${unit ? `<small>${unit}</small>` : ""}</div>
      ${pending > 0 ? `<div class="pend">+ ${dbHours(pending)} do zatwierdzenia</div>` : ""}
      ${extra}
      <div class="note">${note}</div>
    </div>`;

  const kpis = document.getElementById("db-kpis");
  kpis.innerHTML =
    tile("lead", "fa-clock", "Godziny obecne", dbCountHtml(total.present), "h",
      `Średnio ${dbNum(perEmp)} h na pracownika`, "", total.pendP) +
    tile("absent", "fa-user-xmark", "Godziny nieobecne", dbCountHtml(total.absent), "h",
      `z ${dbNum(all)} h zgłoszonych łącznie`, "", total.pendA) +
    tile("rate", "fa-percent", "Wskaźnik absencji", dbCountHtml(rate), "%",
      "Udział godzin nieobecnych w zgłoszonych",
      `<div class="db-meter" aria-hidden="true"><span style="width: ${Math.min(rate, 100)}%;"></span></div>`) +
    tile("", "fa-file-lines", "Raporty", dbCountHtml(reportCount, 0), "",
      `Dni z raportami: ${dbNum(dayCount, 0)}`) +
    tile("", "fa-users", "Pracownicy", dbCountHtml(empCount, 0), "",
      "Osoby ujęte w raportach");
  dbRunCounts(kpis);
}

// ---------- Wykres: godziny w czasie ----------
function dbRenderTime(byTime, year, month) {
  const el = document.getElementById("db-time");
  const title = document.getElementById("db-time-title");
  const sub = document.getElementById("db-time-sub");

  const count = month ? new Date(Number(year), Number(month), 0).getDate() : 12;
  const points = Array.from({ length: count }, (_, i) => {
    const key = i + 1;
    const v = byTime.get(key) || dbEmptyEntry();
    const axis = month ? String(key) : RP_MONTHS[i].slice(0, 3);
    const full = month ? `${String(key).padStart(2, "0")}.${month}.${year}` : `${RP_MONTHS[i]} ${year}`;
    return { key, axis, full, ...v };
  });

  title.textContent = month ? "Godziny dzień po dniu" : "Godziny w kolejnych miesiącach";
  document.getElementById("db-legend-weekend").style.display = month ? "" : "none";
  const maxTotal = Math.max(...points.map(dbEntrySum));

  if (maxTotal <= 0) {
    sub.textContent = "";
    el.innerHTML = dbEmptyHtml("Brak raportów w wybranym okresie.");
    return;
  }

  const peak = points.reduce((a, b) => (dbEntrySum(b) > dbEntrySum(a) ? b : a));
  sub.textContent = `Najwięcej zgłoszonych godzin: ${peak.full} (${dbHours(dbEntrySum(peak))})`;

  const max = dbNiceMax(maxTotal);
  const ticks = [0, 1, 2, 3, 4].map(i => (max / 4) * i);

  const yAxis = ticks.map(t => `<span style="bottom: ${(t / max) * 100}%;">${dbNum(t)}</span>`).join("");
  const grid = ticks.map(t =>
    `<i class="${t === 0 ? "base" : ""}" style="bottom: ${(t / max) * 100}%;"></i>`).join("");

  const cols = points.map(p => {
    // na telefonie podpisy co 5 dni (plus pierwszy), żeby się nie zlewały
    const minor = month && !(p.key === 1 || p.key % 5 === 0) ? " minor" : "";
    const stack = dbStackHtml(p, max, p.key - 1);
    // Weekend (tylko w widoku dni): sobota i niedziela mają własne tło kolumny
    const weekday = month ? new Date(Number(year), Number(month) - 1, p.key).getDay() : -1;
    const dayClass = weekday === 6 ? " sat" : weekday === 0 ? " sun" : "";
    const dayName = weekday === 6 ? " (sobota)" : weekday === 0 ? " (niedziela)" : "";
    const label = `${p.full}${dayName}: ${dbAriaHours(p)}`;

    return `
      <div class="db-col${dayClass}" tabindex="0" role="img" aria-label="${rtEsc(label)}"
           data-tip="${dbTipAttr(p.full + dayName, dbHoursLines(p.present, p.absent, p.pendP, p.pendA))}">
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

  // months[m] = lista tygodni tego miesiąca: { week, from, to, present, absent, pendP, pendA }
  const months = Array.from({ length: 12 }, (_, mi) => {
    const weeks = [];
    const daysInMonth = new Date(y, mi + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const week = dbWeekOfYear(y, mi + 1, d);
      const last = weeks[weeks.length - 1];
      if (last && last.week === week) last.to = d;
      else weeks.push({ week, from: d, to: d, ...dbEmptyEntry() });
    }
    return weeks;
  });

  rows.forEach(r => {
    if (dbStatus(r) === "rejected") return;   // odrzucone poza wykresem
    const [d, m] = String(r.report_date || "").split(".").map(Number);
    if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return;
    const cell = months[m - 1].find(w => d >= w.from && d <= w.to);
    if (!cell) return;
    dbAddHours(cell, r);
  });

  const legendPend = document.getElementById("db-legend-pend-year");
  if (legendPend) legendPend.style.display = months.flat().some(c => c.pendP + c.pendA > 0) ? "" : "none";

  const maxWeek = Math.max(...months.flat().map(dbEntrySum));
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
    const total = weeks.reduce((acc, c) => ({
      present: acc.present + c.present,
      absent: acc.absent + c.absent,
      pendP: acc.pendP + c.pendP,
      pendA: acc.pendA + c.pendA
    }), dbEmptyEntry());

    const cols = weeks.map(c => {
      const range = c.from === c.to ? `${p2(c.from)}.${mm}.${year}` : `${p2(c.from)}.${mm}–${p2(c.to)}.${mm}.${year}`;
      const name = `Tydzień ${c.week} (${range})`;

      return `
        <div class="db-col" tabindex="0" role="img"
             aria-label="${rtEsc(`${name}: ${dbAriaHours(c)}`)}"
             data-tip="${dbTipAttr(name, dbHoursLines(c.present, c.absent, c.pendP, c.pendA))}">
          <div class="area">${dbStackHtml(c, max, c.week - 1)}</div>
          <div class="wk">${c.week}</div>
        </div>`;
    }).join("");

    const isSelected = selectedMonth && Number(selectedMonth) === mi + 1;
    const monthTip = dbTipAttr(`${monthName} ${year} — razem`, dbHoursLines(total.present, total.absent, total.pendP, total.pendA));

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

  // Długość paska z oczekującymi; liczba główna tylko z zatwierdzonych
  const value = it => (mode === "present" ? it.present + it.pendP : mode === "absent" ? it.absent + it.pendA : dbEntrySum(it));
  const max = Math.max(0, ...items.map(value));

  if (items.length === 0 || max <= 0) {
    el.innerHTML = dbEmptyHtml("Brak danych w wybranym okresie.");
    return;
  }

  el.innerHTML = `<div class="db-bars">` + items.map(it => {
    const p = mode === "absent" ? 0 : it.present;
    const a = mode === "present" ? 0 : it.absent;
    const pp = mode === "absent" ? 0 : it.pendP;
    const pa = mode === "present" ? 0 : it.pendA;
    const num = (mode === "both"
      ? `<b>${dbHours(it.present)}</b> · ${dbHours(it.absent)} nieob.`
      : `<b>${dbHours(p + a)}</b>`) +
      (pp + pa > 0 ? ` <span class="pend">+ ${dbHours(pp + pa)}</span>` : "");

    return `
      <div class="db-bar" tabindex="0" data-tip="${dbTipAttr(it.label, dbHoursLines(it.present, it.absent, it.pendP, it.pendA))}">
        <div class="top">
          <span class="name">${rtEsc(it.label)}</span>
          <span class="num">${num}</span>
        </div>
        <div class="track" aria-hidden="true">
          ${p > 0 ? `<span class="p" style="width: ${(p / max) * 100}%;"></span>` : ""}
          ${a > 0 ? `<span class="a" style="width: ${(a / max) * 100}%;"></span>` : ""}
          ${pp > 0 ? `<span class="pp" style="width: ${(pp / max) * 100}%;"></span>` : ""}
          ${pa > 0 ? `<span class="pa" style="width: ${(pa / max) * 100}%;"></span>` : ""}
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

// ---------- Zalew ----------
// Zakładka Zalew pokazuje tylko tydzień zalewu (js/zalew.js, zwDashOpenInApp).
// Moduł Zalew wyłączony w Opcjach: zakładka znika. Ustawienia modułów pobierane od nowa,
// żeby zmiana w Opcjach działała bez przelogowania.
async function dbSyncZalewModule(token) {
  dbSyncZalewTab(moduleEnabled("zalew")); // od razu, bez mignięcia
  await loadModules();
  if (token !== dbLoadToken) return;
  dbSyncZalewTab(moduleEnabled("zalew"));
}
