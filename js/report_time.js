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
let rtTargets = [];          // raporty na wybrany dzień i zmianę, do których można dopisać osoby
let rtTarget = "new";        // "new" | numer raportu | null (administrator musi wskazać raport)
let rtTargetManual = false;  // administrator sam wybrał pozycję z listy
let rtTargetKey = "";        // "data|zmiana", dla których ustalono rtTarget
let rtUsersById = null;      // nazwiska autorów raportów (ładowane tylko dla administratora)

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
// Zwraca { top, rest }: najczęstsze godziny (wyróżnione) i pozostałe.
function rtTimeChoices(which, d) {
  if (!rtShift) {
    return { top: RT_TOP_TIMES.slice(), rest: RT_OTHER_TIMES.slice() };
  }

  const start = rtShiftStart();
  const slots = RT_SHIFT_LEN / 30;
  const min = which === "to" ? (d.from ? rtSlot(d.from) + 1 : 1) : 0;
  const max = which === "from" ? (d.to ? rtSlot(d.to) - 1 : slots - 1) : slots;

  // Najczęstsze: pełne połówki zmiany (co 4 h od jej początku, np. 06:30, 10:30, 14:30)
  const top = [], rest = [];
  for (let k = min; k <= max; k++) {
    const t = RT_ALL_TIMES[((start + k * 30) % 1440) / 30];
    (k % 8 === 0 ? top : rest).push(t);
  }
  return { top, rest };
}

// ---------- Przyciski zmian I, II, III (jak w Harmonogramie) ----------
// Jedno kliknięcie wpisuje pełną zmianę: I 06:30–14:30, II 14:30–22:30, III 22:30–06:30.
const RT_PRESETS = RT_SHIFT_NAMES.map((name, i) => ({
  label: ["I", "II", "III"][i],
  name,
  from: RT_ALL_TIMES[((RT_SHIFT_BASE + i * RT_SHIFT_LEN) % 1440) / 30],
  to: RT_ALL_TIMES[((RT_SHIFT_BASE + (i + 1) * RT_SHIFT_LEN) % 1440) / 30]
}));

// Zmiana wynikająca z pozostałych wierszy (raport dotyczy jednej zmiany)
function rtShiftOfOthers(id) {
  for (const [key, d] of Object.entries(rtDraft)) {
    if (String(key) === String(id)) continue;
    if (d.from) return rtShiftOf(d.from, "from");
    if (d.to) return rtShiftOf(d.to, "to");
  }
  return null;
}

function rtPresetsHtml(id, d) {
  const rowShift = d.from ? rtShiftOf(d.from, "from") : (d.to ? rtShiftOf(d.to, "to") : null);
  const others = rtShiftOfOthers(id);
  return RT_PRESETS.map((p, i) => {
    const full = d.from === p.from && d.to === p.to;
    const part = !full && rowShift === p.name;
    const blocked = others && others !== p.name;
    const title = blocked
      ? `Raport dotyczy zmiany ${others.replace("Zmiana ", "")} — wyczyść pozostałe wiersze, aby wybrać inną zmianę`
      : full ? `${p.name}: ${p.from}–${p.to} (kliknij, aby wyczyścić)` : `${p.name}: ${p.from}–${p.to}`;
    return `<button type="button" class="rt-preset${full ? " on" : ""}${part ? " part" : ""}"
      title="${title}" aria-pressed="${full}" ${blocked ? "disabled" : ""}
      onclick="rtOnPreset(${id}, ${i})">${p.label}</button>`;
  }).join("");
}

// Odświeża przyciski zmian we wszystkich wierszach. Wybór godzin w jednym wierszu
// blokuje pozostałe zmiany także w wierszach wypełnionych wcześniej.
function rtRefreshPresets() {
  document.querySelectorAll(".rt-presets[id^='rt-shift-']").forEach(el => {
    const id = el.id.slice("rt-shift-".length);
    el.innerHTML = rtPresetsHtml(Number(id), rtDraft[id] || { from: "", to: "" });
  });
}

function rtOnPreset(id, index) {
  const p = RT_PRESETS[index];
  const d = rtGetDraft(id);
  if (d.from === p.from && d.to === p.to) {
    d.from = d.to = "";          // ponowne kliknięcie wybranej zmiany czyści godziny
  } else {
    d.from = p.from;
    d.to = p.to;
  }
  rtPickClose(false);
  rtCleanupDraft(id);
  if (rtShiftChanged()) rtRenderTable();
  else rtSyncRow(id);
  rtUpdateStats();
  document.querySelectorAll(`#rt-shift-${id} .rt-preset`)[index]?.focus();
}

// Pole godziny: przycisk otwierający okienko wyboru (zamiast zwykłej listy rozwijanej)
function rtTimeBtnHtml(id, which, d) {
  const v = d[which] || "";
  return `<button type="button" class="rt-time${v ? "" : " empty"}" id="rt-${which}-${id}"
    aria-label="${which === "from" ? "Od" : "Do"}" aria-haspopup="dialog" aria-expanded="false"
    onclick="rtPickOpen(${id}, '${which}')">${v || "--:--"}</button>`;
}

function rtSetTimeBtn(id, which, value) {
  const btn = document.getElementById(`rt-${which}-${id}`);
  if (!btn) return;
  btn.textContent = value || "--:--";
  btn.classList.toggle("empty", !value);
}

// ---------- Okienko wyboru godziny (wspólne: Rozliczenie czasu i edycja raportu) ----------
// Kafelki z godzinami: na górze najczęstsze, niżej pozostałe. Klawiatura: strzałki, Enter, Esc.
// Pole godziny to przycisk z klasą "rt-time"; style okienka: css/timepicker.css.
let rtPick = null;           // { key, btnId, onPick } otwartego okienka

function rtPickEl() {
  let el = document.getElementById("rt-picker");
  if (!el) {
    el = document.createElement("div");
    el.id = "rt-picker";
    el.className = "rt-picker";
    el.setAttribute("role", "dialog");
    el.addEventListener("keydown", rtPickKey);
    // Tab poza okienko zamyka je. Tylko gdy fokus trafia do konkretnego elementu
    // (Safari przy kliknięciu nie ustawia fokusu - kliknięcia poza obsługuje "mousedown").
    el.addEventListener("focusout", e => {
      const to = e.relatedTarget;
      if (rtPick && to && !el.contains(to) && !(to.closest && to.closest(".rt-time"))) {
        rtPickClose(false);
      }
    });
    document.body.appendChild(el);
  }
  return el;
}

// Otwiera okienko przy przycisku btn.
// cfg: { key, label ("Od"/"Do"), name, top: [], rest: [], value, emptyText, onPick(value) }
function rtPickerOpen(btn, cfg) {
  if (!btn) return;
  // ponowne kliknięcie tego samego pola zamyka okienko
  if (rtPick && rtPick.key === cfg.key) {
    rtPickClose(true);
    return;
  }
  rtPickClose(false);

  const { top, rest, value } = cfg;
  const chip = (t, cls) =>
    `<button type="button" class="rt-chip${cls}${t === value ? " on" : ""}" onclick="rtPickSet('${t}')">${t}</button>`;

  const el = rtPickEl();
  el.setAttribute("aria-label", `Godzina ${cfg.label.toLowerCase()}${cfg.name ? ": " + cfg.name : ""}`);
  el.innerHTML = `
    <div class="rt-pick-head">
      <span><b>${rtEsc(cfg.label)}</b>${cfg.name ? ` — ${rtEsc(cfg.name)}` : ""}</span>
      <button type="button" class="rt-pick-x" onclick="rtPickClose(true)" aria-label="Zamknij"><i class="fa-solid fa-xmark"></i></button>
    </div>
    ${top.length ? `<div class="rt-pick-lbl">Najczęstsze</div>
      <div class="rt-pick-grid top">${top.map(t => chip(t, " top")).join("")}</div>` : ""}
    ${rest.length ? `<div class="rt-pick-lbl">Pozostałe godziny</div>
      <div class="rt-pick-grid">${rest.map(t => chip(t, "")).join("")}</div>` : ""}
    ${!top.length && !rest.length ? `<div class="rt-pick-empty">${rtEsc(cfg.emptyText || "Brak godzin do wyboru.")}</div>` : ""}
    ${value && cfg.clearable !== false ? `<button type="button" class="rt-pick-clear" onclick="rtPickSet('')"><i class="fa-solid fa-eraser"></i> Wyczyść</button>` : ""}`;

  rtPick = { key: cfg.key, btnId: btn.id, onPick: cfg.onPick };
  btn.classList.add("open");
  btn.setAttribute("aria-expanded", "true");
  el.classList.add("open");
  rtPickPlace(btn, el);
  (el.querySelector(".rt-chip.on") || el.querySelector(".rt-chip") || el.querySelector(".rt-pick-x")).focus();
}

// Rozliczenie czasu: okienko dla pola "Od"/"Do" pracownika
function rtPickOpen(id, which) {
  const d = rtDraft[id] || { from: "", to: "", absent: false };
  const { top, rest } = rtTimeChoices(which, d);
  const emp = rtEmpById[id];
  rtPickerOpen(document.getElementById(`rt-${which}-${id}`), {
    key: `rt|${id}|${which}`,
    label: which === "from" ? "Od" : "Do",
    name: emp ? `${emp.first_name || ""} ${emp.last_name || ""}`.trim() : "",
    top, rest,
    value: d[which],
    emptyText: `Brak godzin do wyboru — zmień godzinę „${which === "from" ? "Do" : "Od"}”.`,
    onPick: value => {
      rtOnTime(id, which, value);
      // po wybraniu "Od" od razu wybór "Do" (jeśli jeszcze puste)
      if (which === "from" && value && !(rtDraft[id] && rtDraft[id].to)) {
        rtPickOpen(id, "to");
      } else {
        document.getElementById(`rt-${which}-${id}`)?.focus();
      }
    }
  });
}

// Okienko pod polem (albo nad nim, gdy brak miejsca); na telefonie - panel u dołu ekranu (CSS)
function rtPickPlace(btn, el) {
  el.style.left = el.style.top = "";
  if (window.matchMedia("(max-width: 768px)").matches) return;
  const r = btn.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) {
    top = r.top - h - 6 >= 8 ? r.top - h - 6 : Math.max(8, window.innerHeight - h - 8);
  }
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function rtPickClose(focusBack) {
  if (!rtPick) return;
  const { btnId } = rtPick;
  rtPick = null;
  document.getElementById("rt-picker")?.classList.remove("open");
  const btn = document.getElementById(btnId);
  if (btn) {
    btn.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
    if (focusBack) btn.focus();
  }
}

function rtPickSet(value) {
  if (!rtPick) return;
  const { onPick } = rtPick;
  rtPickClose(false);
  onPick(value);
}

function rtPickKey(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    rtPickClose(true);
    return;
  }
  const chips = [...document.querySelectorAll("#rt-picker .rt-chip")];
  const i = chips.indexOf(document.activeElement);
  if (i < 0 || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
  e.preventDefault();

  let next = null;
  if (e.key === "ArrowLeft") next = chips[i - 1];
  else if (e.key === "ArrowRight") next = chips[i + 1];
  else {
    // góra / dół: najbliższy kafelek w sąsiednim rzędzie
    const cur = chips[i].getBoundingClientRect();
    const down = e.key === "ArrowDown";
    const rows = chips
      .map(c => ({ c, r: c.getBoundingClientRect() }))
      .filter(x => down ? x.r.top > cur.top + 2 : x.r.top < cur.top - 2);
    if (rows.length) {
      const rowTop = down ? Math.min(...rows.map(x => x.r.top)) : Math.max(...rows.map(x => x.r.top));
      const cx = cur.left + cur.width / 2;
      next = rows
        .filter(x => Math.abs(x.r.top - rowTop) < 2)
        .sort((a, b) => Math.abs(a.r.left + a.r.width / 2 - cx) - Math.abs(b.r.left + b.r.width / 2 - cx))[0].c;
    }
  }
  if (next) next.focus();
}

// Klik poza okienkiem, przewinięcie strony albo zmiana rozmiaru okna zamyka okienko
document.addEventListener("mousedown", e => {
  if (!rtPick) return;
  if (e.target.closest("#rt-picker") || e.target.closest(".rt-time")) return;
  rtPickClose(false);
});
document.addEventListener("scroll", e => {
  if (rtPick && !(e.target.closest && e.target.closest("#rt-picker"))) rtPickClose(false);
}, true);
window.addEventListener("resize", () => rtPickClose(false));

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
  rtPickClose(false);
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
      `${a.first_name || ""} ${a.last_name || ""}`.localeCompare(`${b.first_name || ""} ${b.last_name || ""}`, "pl")
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
    // prywatne listy pracowników: osobno, błąd (np. brak tabel) nie psuje widoku
    rtlLoad();
  } catch (err) {
    console.error("Błąd ładowania widoku rozliczania czasu:", err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--danger);padding:25px;">
        Nie udało się pobrać pracowników: ${rtEsc(err.message || err)}</td></tr>`;
    }
  }
}

// ---------- Tabela pracowników ----------
function rtVisibleEmployees() {
  const q = (document.getElementById("rt-filter-search")?.value || "").toLowerCase().trim();
  const biz = document.getElementById("rt-filter-business")?.value;
  const dept = document.getElementById("rt-filter-dept")?.value;
  const listSet = typeof rtlFilterSet === "function" ? rtlFilterSet() : null; // prywatna lista (emp_lists.js)

  return rtEmployees.filter(e => {
    const n1 = `${e.first_name || ""} ${e.last_name || ""}`.toLowerCase();
    const n2 = `${e.last_name || ""} ${e.first_name || ""}`.toLowerCase();
    return (!q || n1.includes(q) || n2.includes(q)) &&
      (!biz || String(e.business_id) === String(biz)) &&
      (!dept || String(e.department_id) === String(dept)) &&
      (!listSet || listSet.has(Number(e.id)));
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
      <td class="rt-c-time">
        ${rtTimeBtnHtml(id, "from", d)}
      </td>
      <td class="rt-c-time">
        ${rtTimeBtnHtml(id, "to", d)}
      </td>
      <td class="rt-c-shift">
        <div class="rt-presets" id="rt-shift-${id}" role="group" aria-label="Zmiana">${rtPresetsHtml(id, d)}</div>
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
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:30px;">
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
  const l = document.getElementById("rt-filter-list");
  if (l) l.value = "";
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

  rtSetTimeBtn(id, "from", d ? d.from : "");
  rtSetTimeBtn(id, "to", d ? d.to : "");
  const presets = document.getElementById(`rt-shift-${id}`);
  if (presets) presets.innerHTML = rtPresetsHtml(id, d || { from: "", to: "" });

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
  rtRefreshPresets();
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
  btn.disabled = rtSaving || noEntries || !rtMeta.date || rtLocked || rtTarget === null || rtHasConflicts() || rtTargetApproved();
}

// Raport, do którego trafiłyby osoby, jest już zatwierdzony (dopisać się nie da)
function rtTargetApproved() {
  return rtTargets.some(t => t.number === rtTarget && t.status === "approved");
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

// ---------- Jeden raport na użytkownika, dzień i zmianę ----------
// Jeśli autor ma już raport na wybrany dzień i zmianę, nowe osoby są do niego dopisywane
// (ten sam numer). Administrator wpisujący godziny za kogoś dopisuje do raportu mistrza:
// wybiera go z listy raportów istniejących na ten dzień i zmianę.
function rtIsAdmin() {
  return String(currentUser?.role?.role || "").toLowerCase() === "administrator";
}

function rtUserName(id) {
  const u = rtUsersById && rtUsersById[id];
  return u ? `${u.name || ""} ${u.last_name || ""}`.trim() : `Użytkownik #${id}`;
}

// Raporty na wybrany dzień i zmianę, do których zalogowana osoba może dopisać:
// zwykły użytkownik - tylko własne, administrator - wszystkie.
// Zatwierdzonego raportu nie da się uzupełnić (sql/34): administrator go nie widzi na liście,
// zwykły użytkownik dostaje informację, że trzeba cofnąć zatwierdzenie.
async function rtFetchTargets() {
  const withStatus = typeof rpaInstalled === "function" && rpaInstalled();
  const { data, error } = await supabaseClient
    .from("work_reports")
    .select("number_report, add_first_name_id, add_data, first_name_id" + (withStatus ? ", approval_status" : ""))
    .eq("report_date", rtIsoToPl(rtMeta.date))
    .eq("shift", rtMeta.shift);
  if (error) return { error, list: [] };

  const map = new Map();
  (data || []).forEach(r => {
    let t = map.get(r.number_report);
    if (!t) {
      t = { number: Number(r.number_report), creatorId: r.add_first_name_id, created: r.add_data, status: r.approval_status || null, people: new Set() };
      map.set(r.number_report, t);
    }
    t.people.add(r.first_name_id);
  });

  const admin = rtIsAdmin();
  const list = [...map.values()]
    .filter(t => admin ? t.status !== "approved" : Number(t.creatorId) === Number(currentUser.id))
    .sort((a, b) => a.number - b.number);

  // nazwiska autorów są potrzebne tylko administratorowi (lista wyboru)
  if (admin && list.length && !rtUsersById) {
    const { data: users, error: usersErr } = await supabaseClient.from("users").select("id, name, last_name");
    if (!usersErr) {
      rtUsersById = {};
      (users || []).forEach(u => { rtUsersById[u.id] = u; });
    }
  }
  return { error: null, list };
}

// Ustala, dokąd trafią nowe osoby, i rysuje informację / listę wyboru
function rtApplyTargets(list) {
  rtTargets = list;
  const key = `${rtMeta.date}|${rtMeta.shift}`;
  const own = list.filter(t => Number(t.creatorId) === Number(currentUser.id));
  const stillValid = rtTarget === "new" || list.some(t => t.number === rtTarget);

  if (!rtIsAdmin()) {
    // zwykły użytkownik nie wybiera: dopisuje do swojego raportu, jeśli go ma
    rtTarget = own.length ? own[0].number : "new";
  } else if (!(rtTargetManual && key === rtTargetKey && stillValid)) {
    rtTargetManual = false;
    if (own.length) rtTarget = own[0].number;
    else if (list.length === 1) rtTarget = list[0].number;
    else if (list.length > 1) rtTarget = null;   // kilka raportów różnych osób - trzeba wskazać
    else rtTarget = "new";
  }
  rtTargetKey = key;
  rtRenderTarget();
}

function rtClearTargets() {
  rtTargets = [];
  rtTarget = "new";
  rtTargetManual = false;
  rtRenderTarget();
}

function rtRenderTarget() {
  const el = document.getElementById("rt-target");
  if (!el) return;

  if (rtTargets.length === 0) {
    el.style.display = "none";
    el.innerHTML = "";
    return;
  }
  el.style.display = "";

  const describe = t => `nr ${t.number} — ${rtUserName(t.creatorId)} (osób: ${t.people.size})`;

  if (!rtIsAdmin()) {
    const t = rtTargets.find(x => x.number === rtTarget) || rtTargets[0];
    if (t.status === "approved") {
      el.className = "rt-target choose";
      el.innerHTML = `<i class="fa-solid fa-lock"></i>
        <span>Twój raport <strong>nr ${t.number}</strong> na ten dzień i tę zmianę jest już <strong>zatwierdzony</strong>.
        Nie można do niego dopisać osób — poproś osobę z uprawnieniem „Zatwierdzanie raportów” o cofnięcie zatwierdzenia.</span>`;
      return;
    }
    el.className = "rt-target info";
    el.innerHTML = `<i class="fa-solid fa-circle-info"></i>
      <span>Masz już raport <strong>nr ${t.number}</strong> na ten dzień i tę zmianę (osób: ${t.people.size}).
      Nowe osoby zostaną do niego dopisane${t.status === "rejected" ? " (raport jest odesłany do poprawy — po uzupełnieniu wyślij go ponownie z Listy raportów)" : ""}.</span>`;
    return;
  }

  el.className = `rt-target ${rtTarget === null ? "choose" : "info"}`;
  el.innerHTML = `
    <i class="fa-solid ${rtTarget === null ? "fa-triangle-exclamation" : "fa-circle-info"}"></i>
    <div class="rt-target-body">
      <label for="rt-target-select">Na ten dzień i tę zmianę są już raporty. Dopisz osoby do raportu:</label>
      <select id="rt-target-select" class="form-control" onchange="rtOnTargetChange(this.value)">
        ${rtTarget === null ? `<option value="" selected>Wybierz raport...</option>` : ""}
        ${rtTargets.map(t => `<option value="${t.number}"${t.number === rtTarget ? " selected" : ""}>${rtEsc(describe(t))}</option>`).join("")}
        <option value="new"${rtTarget === "new" ? " selected" : ""}>Nowy, osobny raport na moje nazwisko</option>
      </select>
    </div>`;
}

function rtOnTargetChange(value) {
  rtTarget = value === "new" ? "new" : value === "" ? null : Number(value);
  rtTargetManual = true;
  rtRenderTarget();
  rtUpdateSaveButton();
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
    rtClearTargets();
    body.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:30px;">Brak pozycji w raporcie.</td></tr>`;
    rtUpdateSaveButton();
    return;
  }

  if (!rtMeta.date) {
    rtConflicts = {};
    rtClearTargets();
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
    rtClearTargets();
    rtRenderSummaryRows(entries);
    rtShowSummaryMsg(lockError
      ? "Nie udało się sprawdzić blokady miesiąca: " + (lockError.message || lockError)
      : `Miesiąc ${opMonthLabel(rtMeta.date.slice(0, 7))} jest zablokowany. Nie można w nim tworzyć raportów.`, "#9b1c1f");
    rtUpdateSaveButton();
    return;
  }

  // Duplikaty godzin oraz istniejące raporty na ten dzień i zmianę (do dopisania)
  const [res, targets] = await Promise.all([rtFetchConflicts(entries), rtFetchTargets()]);
  if (token !== rtRefreshToken) return; // ktoś zmienił datę/zmianę w trakcie

  const fetchError = res.error || targets.error;
  if (fetchError) {
    console.error("Błąd sprawdzania raportów:", fetchError);
    rtConflicts = {};
    rtClearTargets();
    rtShowSummaryMsg("Nie udało się sprawdzić istniejących raportów: " + (fetchError.message || fetchError));
    rtRenderSummaryRows(entries);
    if (btn) btn.disabled = true;
    return;
  }

  rtApplyTargets(targets.list);
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
  } else {
    // szczegóły wpisu z listy kolizji, z której go usunięto
    const removed = Object.entries(rtConflicts)
      .flatMap(([empId, list]) => list.map(c => ({ empId, c })))
      .find(x => Number(x.c.id) === Number(recordId));
    const emp = removed && rtEmpById[removed.empId];
    logAction("Usunięcie pracownika z raportu", removed
      ? `Raport nr ${removed.c.number_report}, ${rtIsoToPl(rtMeta.date)}: ${emp ? `${emp.first_name || ""} ${emp.last_name || ""}`.trim() : `pracownik #${removed.empId}`}`
      : `wpis id ${recordId}`);
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

    // 2. Dopisanie do istniejącego raportu albo nowy numer.
    //    Lista raportów jest pobierana jeszcze raz - mogła się zmienić od otwarcia okna.
    const fresh = await rtFetchTargets();
    if (fresh.error) throw fresh.error;

    let target = null;
    if (!rtIsAdmin()) {
      // jeden raport na użytkownika, dzień i zmianę
      target = fresh.list[0] || null;
    } else if (rtTarget !== "new") {
      target = fresh.list.find(t => t.number === rtTarget) || null;
      if (!target) {
        rtApplyTargets(fresh.list);
        rtUpdateSaveButton();
        rtShowSummaryMsg("Wybrany raport już nie istnieje. Sprawdź, dokąd mają trafić osoby, i zapisz ponownie.", "#9b1c1f");
        return;
      }
    }

    if (target && target.status === "approved") {
      rtApplyTargets(fresh.list);
      rtUpdateSaveButton();
      rtShowSummaryMsg(`Raport nr ${target.number} na ten dzień i zmianę jest już zatwierdzony. Nie można do niego dopisać osób — najpierw trzeba cofnąć zatwierdzenie.`, "#9b1c1f");
      return;
    }

    let reportNumber;
    if (target) {
      reportNumber = target.number;
    } else {
      const { data: maxRows, error: maxErr } = await supabaseClient
        .from("work_reports")
        .select("number_report")
        .order("number_report", { ascending: false })
        .limit(1);
      if (maxErr) throw maxErr;
      reportNumber = maxRows && maxRows.length ? (Number(maxRows[0].number_report) || 0) + 1 : 1;
    }

    // 3. Zapis. Dopisane osoby dostają autora i datę utworzenia istniejącego raportu,
    //    żeby raport nadal miał jednego autora.
    const reportDate = rtIsoToPl(rtMeta.date);
    const addedOn = target ? target.created : rtIsoToPl(rtTodayIso());
    const authorId = target ? target.creatorId : currentUser.id;

    const records = entries.map(e => ({
      report_date: reportDate,
      shift: rtMeta.shift,
      department_id: e.emp.department_id,
      first_name_id: e.emp.id,
      last_name_id: e.emp.id,
      add_first_name_id: authorId,
      add_last_name_id: authorId,
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
    logAction(target ? "Dopisanie do raportu" : "Utworzenie raportu",
      `Raport nr ${reportNumber}, ${reportDate}, ${rtMeta.shift}, osób: ${records.length}`);
    rtClearTargets();
    const toApproval = typeof rpaInstalled === "function" && rpaInstalled() && !(target && target.status === "rejected");
    rtShowBanner("success", (target
      ? `Dopisano ${records.length} os. do raportu nr ${reportNumber} (${reportDate}, ${rtMeta.shift}).`
      : `Raport nr ${reportNumber} (${reportDate}, ${rtMeta.shift}) został zapisany. Liczba osób: ${records.length}.`) +
      (toApproval ? " Raport czeka na zatwierdzenie." : ""));
    if (typeof rpaRefreshBadges === "function") rpaRefreshBadges();
  } catch (err) {
    console.error("Błąd zapisu raportu:", err);
    rtShowSummaryMsg("Wystąpił błąd podczas zapisu: " + (err.message || err));
  } finally {
    rtSaving = false;
    if (saveBtn) saveBtn.innerText = "Zatwierdź i zapisz";
    rtUpdateSaveButton();
  }
}