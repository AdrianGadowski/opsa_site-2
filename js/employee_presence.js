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
  if (p.kind === "off") return "wolne w harmonogramie";
  return `zgłoszona nieobecność${p.note ? " (" + p.note + ")" : ""}${p.time_from ? ", godz. " + p.time_from + "–" + p.time_to : ""}`;
}

// Stan jednego dnia: { cls, text }. Dzień może mieć 1 albo 2 wpisy (np. zmiana I i II).
function prDayState(empId, day, index) {
  const plans = (prSchedule[empId] || {})[day.iso] || [];
  const works = plans.filter(p => p.kind === "work");
  const rows = (prReports[empId] || {})[day.pl] || [];
  const planText = plans.length ? plans.map(prPlanText).join(" + ") : "brak zaplanowanych godzin";
  const head = `${PR_DAY_NAMES[index]} ${day.pl}`;

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
    return `<span class="pr-day ${s.cls}${day.today ? " today" : ""}" tabindex="0" data-emp="${rtEsc(empId)}" data-i="${i}" aria-label="${rtEsc(s.text)}"
      onmouseenter="prTipShow(this)" onmouseleave="prTipHide()" onfocus="prTipShow(this)" onblur="prTipHide()" onclick="prTipShow(this)">${PR_DAY_LABELS[i]}</span>`;
  }).join("")}</div>`;
}

function prFillCells() {
  document.querySelectorAll("#employees-table-body td.pr-cell[data-emp]").forEach(td => {
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
  const plans = ((prSchedule[empId] || {})[day.iso] || []).slice().sort((a, b) => (a.slot || 1) - (b.slot || 1));
  const rows = (prReports[empId] || {})[day.pl] || [];
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

  const el = prTipEl();
  el.innerHTML = `
    <div class="head"><b>${rtEsc(PR_DAY_NAMES[i])} ${rtEsc(day.pl)}</b>${name ? `<span>${rtEsc(name)}</span>` : ""}</div>
    <div class="state ${s.cls}">${rtEsc(PR_STATE_LABELS[s.cls] || "")}</div>
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

function prTipHide() {
  document.getElementById("pr-tip")?.classList.remove("open");
}

// przewinięcie albo zmiana widoku chowa okienko
document.addEventListener("scroll", prTipHide, true);
