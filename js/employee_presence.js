// ==========================================
// MODUŁ: OBECNOŚĆ W BIEŻĄCYM TYGODNIU (lista pracowników -> kolumna "Obecność")
// Kafelki pn–niedz: plan dnia z Harmonogramu (schedule_days) porównany z raportami (work_reports).
//   zielony kontur    - dzień zaplanowany do pracy (brak raportu)
//   zielony           - obecny, godziny zgodne z harmonogramem
//   żółty             - obecny, ale inaczej niż w harmonogramie (inne godziny albo dzień niezaplanowany)
//   czerwony          - nieobecny (w raporcie)
//   czerwony kontur   - zgłoszona nieobecność w harmonogramie (brak raportu)
//   szary             - brak zaplanowanych godzin (nic albo wolne)
// Wymaga: supabaseClient, rtEsc, rpFetchAll, shDayIso
// ==========================================

const PR_DAY_LABELS = ["Pn", "Wt", "Śr", "Czw", "Pt", "Sob", "Niedz"];
const PR_DAY_NAMES = ["poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota", "niedziela"];

let prDays = [];             // [{ date, iso: "rrrr-mm-dd", pl: "dd.mm.rrrr", today }]
let prSchedule = {};         // { [employeeId]: { [iso]: [wpisy schedule_days] } }
let prReports = {};          // { [employeeId]: { "dd.mm.rrrr": [wiersze] } }
let prLoaded = false;
let prLoadToken = 0;

// Dni bieżącego tygodnia (od poniedziałku do niedzieli)
function prWeekDays() {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + 6) % 7);
  const p = n => String(n).padStart(2, "0");
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    return {
      date: d,
      iso: shDayIso(d),
      pl: `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`,
      today: d.toDateString() === now.toDateString()
    };
  });
}

function prWeekLabel() {
  if (!prDays.length) prDays = prWeekDays();
  return `${prDays[0].pl.slice(0, 5)}–${prDays[6].pl.slice(0, 5)}`;
}

// Pobiera harmonogram i raporty bieżącego tygodnia, potem uzupełnia kafelki w tabeli
async function prLoad() {
  const token = ++prLoadToken;
  prDays = prWeekDays();
  prLoaded = false;
  const head = document.getElementById("emp-presence-head");
  if (head) head.title = `Bieżący tydzień: ${prWeekLabel()}`;
  const range = document.getElementById("emp-presence-range");
  if (range) range.textContent = prWeekLabel();

  const [schedRes, reportsRes] = await Promise.allSettled([
    rpFetchAll(() => supabaseClient
      .from("schedule_days")
      .select("id, employee_id, day, kind, time_from, time_to, note")
      .gte("day", prDays[0].iso)
      .lte("day", prDays[6].iso)),
    rpFetchAll(() => supabaseClient
      .from("work_reports")
      .select("id, first_name_id, report_date, start_time, end_time, at_work")
      .in("report_date", prDays.map(d => d.pl)))
  ]);
  if (token !== prLoadToken) return;

  prSchedule = {};
  if (schedRes.status === "fulfilled") {
    schedRes.value.forEach(r => {
      const byDay = prSchedule[r.employee_id] || (prSchedule[r.employee_id] = {});
      (byDay[r.day] || (byDay[r.day] = [])).push(r);
    });
  } else {
    console.warn("Obecność: nie udało się pobrać harmonogramu:", schedRes.reason?.message || schedRes.reason);
  }

  prReports = {};
  if (reportsRes.status === "fulfilled") {
    reportsRes.value.forEach(r => {
      const byDay = prReports[r.first_name_id] || (prReports[r.first_name_id] = {});
      (byDay[r.report_date] || (byDay[r.report_date] = [])).push(r);
    });
  } else {
    console.warn("Obecność: nie udało się pobrać raportów:", reportsRes.reason?.message || reportsRes.reason);
  }

  prLoaded = true;
  prFillCells();
}

// Opis jednego wpisu harmonogramu
function prPlanText(p) {
  if (p.kind === "work") return `zaplanowano ${p.time_from}–${p.time_to}`;
  if (p.kind === "extra") return `poza harmonogramem ${p.time_from}–${p.time_to}`;
  if (p.kind === "off") return "wolne w harmonogramie";
  return `zgłoszona nieobecność${p.note ? " (" + p.note + ")" : ""}${p.time_from ? ", godz. " + p.time_from + "–" + p.time_to : ""}`;
}

// Zmiany dnia, od wcześniejszej: zaplanowane w harmonogramie (np. I i II albo I i III) oraz
// przepracowane poza harmonogramem - raport, który nie pokrywa się z żadną zaplanowaną zmianą
// (np. zaplanowana I, a w raporcie także II). Takie zmiany mają kind "extra".
function prDayShifts(plans, rows) {
  const planned = plans.filter(p => p.kind !== "off" && p.time_from && p.time_to);
  const ranges = planned.map(p => rtRange(p.time_from, p.time_to));
  const extra = [];
  rows.forEach(r => {
    if (!r.start_time || !r.end_time) return;
    const rr = rtRange(r.start_time, r.end_time);
    if (ranges.some(x => rtOverlap(x, rr))) return;
    // kilka nakładających się raportów spoza planu to jedna zmiana
    const same = extra.find(x => rtOverlap(rtRange(x.time_from, x.time_to), rr));
    if (!same) extra.push({ kind: "extra", time_from: r.start_time, time_to: r.end_time });
  });
  return [...planned, ...extra].sort((a, b) => rtToMin(a.time_from) - rtToMin(b.time_from));
}

// Stan każdej z dwóch zmian osobno. Raport należy do zmiany, z którą pokrywa się godzinowo
// (zmiana III liczy się do dnia, w którym się zaczyna - tak jak w harmonogramie i raportach).
function prHalfStates(shifts, rows) {
  const ranges = shifts.map(p => rtRange(p.time_from, p.time_to));
  const mine = shifts.map(() => []);
  const loose = [];   // raporty w godzinach poza obiema zmianami
  rows.forEach(r => {
    const k = r.start_time && r.end_time ? ranges.findIndex(x => rtOverlap(x, rtRange(r.start_time, r.end_time))) : -1;
    (k < 0 ? loose : mine[k]).push(r);
  });
  return shifts.map((p, k) => {
    const present = mine[k].filter(r => r.at_work !== false);
    // zmiana spoza harmonogramu: przepracowana - "inaczej niż w harmonogramie", inaczej nieobecny
    if (p.kind === "extra") return present.length ? "diff" : "absent";
    if (present.length) {
      const exact = p.kind === "work" && present.some(r => r.start_time === p.time_from && r.end_time === p.time_to);
      return exact ? "ok" : "diff";
    }
    if (mine[k].length) return "absent";
    if (loose.some(r => r.at_work !== false)) return "diff";   // pracował, ale w innych godzinach
    return p.kind === "absence" ? "absplan" : "plan";
  });
}

// Stan jednego dnia: { cls, text } albo przy dwóch zmianach o różnym stanie
// { cls: "split", halves: [stan lewej, stan prawej], shifts, text }.
function prDayState(empId, day, index) {
  const plans = (prSchedule[empId] || {})[day.iso] || [];
  const works = plans.filter(p => p.kind === "work");
  const rows = (prReports[empId] || {})[day.pl] || [];
  const planText = plans.length ? plans.map(prPlanText).join(" + ") : "brak zaplanowanych godzin";
  const head = `${PR_DAY_NAMES[index]} ${day.pl}`;

  // dwie zmiany (zaplanowane albo przepracowane poza planem): kafelek z dwiema połówkami,
  // każda ze stanem swojej zmiany (gdy obie mają ten sam stan, kafelek jest zwykły, jednokolorowy)
  const shifts = prDayShifts(plans, rows);
  if (shifts.length === 2) {
    const halves = prHalfStates(shifts, rows);
    if (halves[0] !== halves[1]) {
      return {
        cls: "split", halves, shifts,
        text: `${head}: ` + shifts.map((p, k) => `${prPlanText(p)} — ${PR_STATE_LABELS[halves[k]].toLowerCase()}`).join("; ")
      };
    }
  }

  const present = rows.filter(r => r.at_work !== false);
  const absent = rows.filter(r => r.at_work === false);
  const hours = list => list.map(r => `${r.start_time || "?"}–${r.end_time || "?"}`).join(", ");

  if (present.length) {
    // zgodnie z harmonogramem: każda zaplanowana zmiana ma raport z tymi samymi godzinami
    const match = works.length > 0 &&
      works.every(w => present.some(r => r.start_time === w.time_from && r.end_time === w.time_to));
    return match
      ? { cls: "ok", text: `${head}: obecny ${hours(present)} — zgodnie z harmonogramem` }
      : { cls: "diff", text: `${head}: obecny ${hours(present)} — inaczej niż w harmonogramie (${planText})` };
  }
  if (absent.length) return { cls: "absent", text: `${head}: nieobecny (${planText})` };
  if (works.length) return { cls: "plan", text: `${head}: ${planText}, brak raportu` };
  if (plans.some(p => p.kind === "absence")) return { cls: "absplan", text: `${head}: ${planText}` };
  return { cls: "none", text: `${head}: ${planText}` };
}

function prCellHtml(empId) {
  if (!prLoaded) {
    return `<span class="pr-loading"><i class="fa-solid fa-spinner fa-spin"></i></span>`;
  }
  return `<div class="pr-week">${prDays.map((day, i) => {
    const s = prDayState(empId, day, i);
    // dwie zmiany o różnym stanie: dwie połówki, a napis w kolorach obu (l-… / r-…)
    const split = s.cls === "split";
    const cls = split ? `split l-${s.halves[0]} r-${s.halves[1]}` : s.cls;
    const inner = split
      ? `<i class="pr-h ${s.halves[0]}"></i><i class="pr-h ${s.halves[1]}"></i><b class="pr-lbl">${PR_DAY_LABELS[i]}</b>`
      : PR_DAY_LABELS[i];
    return `<span class="pr-day ${cls}${day.today ? " today" : ""}" tabindex="0" data-emp="${rtEsc(empId)}" data-i="${i}" aria-label="${rtEsc(s.text)}"
      onmouseenter="prTipShow(this)" onmouseleave="prTipHide()" onfocus="prTipShow(this)" onblur="prTipHide()" onclick="prTipShow(this)">${inner}</span>`;
  }).join("")}</div>`;
}

function prFillCells() {
  document.querySelectorAll("#employees-table-body td.pr-cell[data-emp]").forEach(td => {
    td.dataset.range = prWeekLabel();   // na telefonie: "Obecność 19.10–25.10" nad kafelkami
    td.innerHTML = prCellHtml(td.dataset.emp);
  });
}

// ---------- Okienko po najechaniu na kafelek dnia ----------
// Pokazuje plan z Harmonogramu (zmiany, godziny, nieobecność, wolne), godziny z raportów i ocenę dnia.
const PR_STATE_LABELS = {
  ok: "Obecny zgodnie z harmonogramem",
  diff: "Obecny inaczej niż w harmonogramie",
  absent: "Nieobecny (w raporcie)",
  plan: "Zaplanowany, brak raportu",
  absplan: "Zgłoszona nieobecność",
  none: "Brak zaplanowanych godzin"
};

function prTipEl() {
  let el = document.getElementById("pr-tip");
  if (!el) {
    el = document.createElement("div");
    el.id = "pr-tip";
    el.className = "pr-tip";
    el.setAttribute("role", "tooltip");
    document.body.appendChild(el);
  }
  return el;
}

function prTipShow(tile) {
  if (!prLoaded) return;
  const empId = tile.dataset.emp;
  const i = Number(tile.dataset.i);
  const day = prDays[i];
  if (!day) return;

  const s = prDayState(empId, day, i);
  // od najwcześniejszej zmiany - tak jak połówki kafelka (cały dzień / wolne na początku)
  const startMin = p => (p.time_from ? rtToMin(p.time_from) : -1);
  const plans = ((prSchedule[empId] || {})[day.iso] || []).slice().sort((a, b) => startMin(a) - startMin(b));
  const rows = ((prReports[empId] || {})[day.pl] || []).slice()
    .sort((a, b) => (a.start_time ? rtToMin(a.start_time) : -1) - (b.start_time ? rtToMin(b.start_time) : -1));
  const emp = (typeof cachedEmployees !== "undefined" ? cachedEmployees : []).find(e => String(e.id) === String(empId));
  const name = emp ? `${emp.first_name || ""} ${emp.last_name || ""}`.trim() : "";

  const planLine = p => {
    if (p.kind === "off") return `<div class="row"><span class="tag off">Wolne</span></div>`;
    const hours = p.time_from && p.time_to ? `${p.time_from}–${p.time_to}` : "cały dzień";
    if (p.kind === "absence") {
      return `<div class="row"><span class="tag absence">Nieobecność</span><span>${rtEsc(hours)}</span>${p.note ? `<span class="muted">${rtEsc(p.note)}</span>` : ""}</div>`;
    }
    const preset = SH_PRESETS.find(x => x.from === p.time_from && x.to === p.time_to);
    const shift = preset ? preset.label : (typeof shShiftLabel === "function" ? shShiftLabel(p.time_from) : "");
    return `<div class="row"><span class="tag work">${shift ? "Zmiana " + rtEsc(shift) : "Praca"}</span><span>${rtEsc(hours)}</span>${preset || !shift ? "" : `<span class="muted">inne godziny</span>`}</div>`;
  };
  const reportLine = r => `<div class="row"><span class="tag ${r.at_work === false ? "absence" : "work"}">${r.at_work === false ? "Nieobecny" : "Obecny"}</span>
    <span>${rtEsc(r.start_time || "?")}–${rtEsc(r.end_time || "?")}</span></div>`;

  // dwie zmiany o różnym stanie: osobna ocena każdej (lewa połówka - wcześniejsza zmiana)
  const shiftName = p => {
    const preset = SH_PRESETS.find(x => x.from === p.time_from && x.to === p.time_to);
    const label = preset ? preset.label : (typeof shShiftLabel === "function" ? shShiftLabel(p.time_from) : "");
    return (label ? `Zmiana ${label}` : `${p.time_from}–${p.time_to}`) + (p.kind === "extra" ? " (poza harmonogramem)" : "");
  };
  const stateHtml = s.cls === "split"
    ? s.shifts.map((p, k) => `<div class="state ${s.halves[k]}">${rtEsc(shiftName(p))}: ${rtEsc(PR_STATE_LABELS[s.halves[k]].toLowerCase())}</div>`).join("")
    : `<div class="state ${s.cls}">${rtEsc(PR_STATE_LABELS[s.cls] || "")}</div>`;

  const el = prTipEl();
  el.innerHTML = `
    <div class="head"><b>${rtEsc(PR_DAY_NAMES[i])} ${rtEsc(day.pl)}</b>${name ? `<span>${rtEsc(name)}</span>` : ""}</div>
    ${stateHtml}
    <div class="sec">Harmonogram</div>
    ${plans.length ? plans.map(planLine).join("") : `<div class="row muted">nic nie zaplanowano</div>`}
    <div class="sec">Raporty</div>
    ${rows.length ? rows.map(reportLine).join("") : `<div class="row muted">brak raportu</div>`}`;
  el.classList.add("open");

  // nad kafelkiem (albo pod nim, gdy brak miejsca), w granicach okna
  const r = tile.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
  const top = r.top - h - 8 >= 8 ? r.top - h - 8 : Math.min(r.bottom + 8, window.innerHeight - h - 8);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

// Ukrycie = usunięcie okienka ze strony: nic nie zostaje po przejściu do innego modułu,
// przełączeniu okna albo karty (wtedy przeglądarka nie zgłasza zjechania myszką)
function prTipHide() {
  document.getElementById("pr-tip")?.remove();
}

document.addEventListener("scroll", prTipHide, true);
window.addEventListener("blur", prTipHide);
document.addEventListener("visibilitychange", prTipHide);
