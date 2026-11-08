// ==========================================
// MODUŁ: ODBICIA Z BRAMY
// Tabele: gate_entries, gate_people (sql/46_odbicia_bramy.sql).
// Uprawnienia: allow_gate_view (podgląd), allow_gate_edit (wgrywanie, poprawianie, kasowanie).
//
// Plik z bramy (Excel, raport "Rejestr zdarzeń"): jedno przejście to trzy wiersze ("Odczyt Nośnika",
// "Przyznanie dostępu", "Przyznanie dostępu na Przejściu") - liczy się tylko przejście.
// Kierunek z kolumny "Źródło" (…_WE = wejście, …_WY = wyjście), osoba z kolumny "Osoba" ("[422]: Imię Nazwisko"),
// firma z kolumny "Grupa" ("[8] DEPO").
// Wejście łączy się z najbliższym kolejnym wyjściem tej osoby (najwyżej GT_MAX_HOURS później), więc nocna
// III zmiana daje jedno odbicie. Zmiana i dzień: według najbliższego początku zmiany (06:30, 14:30, 22:30) -
// wejście 05:40 to I zmiana, wejście 00:30 to III zmiana z poprzedniego dnia.
// Odbicia z brakiem wejścia / wyjścia, bardzo długim pobytem albo nierozpoznaną osobą są oznaczone
// do weryfikacji; można je poprawić albo skasować.
// Wymaga: supabaseClient, currentUser, hasPermission, toggleModal, logAction, savedToast (app.js),
//         rtEsc (report_time.js), RP_MONTHS (reports.js).
// ==========================================

const GT_XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
const GT_MAX_HOURS = 18;          // najdłuższy czas między wejściem a wyjściem jednego odbicia (podwójne zmiany trwają 16–17 h)
const GT_LONG_HOURS = 18;         // dłuższy pobyt jest oznaczony do weryfikacji
const GT_MIN_TABLE = 100;        // najniższa wysokość tabel dopasowanych do okna (px); niżej przewija się strona
const GT_DOUBLE_MIN = 2;          // dwa przejścia w tym samym kierunku w ciągu 2 min = jedno
const GT_SHIFTS = [               // początek zmiany w minutach od północy
  { name: "Zmiana I", start: 390 },
  { name: "Zmiana II", start: 870 },
  { name: "Zmiana III", start: 1350 }
];
const GT_ISSUES = {
  brak_wejscia: { label: "Brak wejścia", cls: "warn" },
  brak_wyjscia: { label: "Brak wyjścia", cls: "warn" },
  dlugi_pobyt: { label: "Długi pobyt", cls: "warn" },
  nierozpoznany: { label: "Nierozpoznana osoba", cls: "bad" },
  dopasowanie: { label: "Dopasowanie częściowe", cls: "info" }
};
const GT_WEEKDAYS = ["nd", "pn", "wt", "śr", "cz", "pt", "sb"];

let gtYear = 0;
let gtMonth = 0;                  // 1-12
let gtRows = [];                  // odbicia wybranego miesiąca
let gtEmployees = [];
let gtEmpById = {};
let gtPeople = {};                // { [numer osoby z bramy]: employee_id | null }
let gtPeopleNames = {};           // { [numer osoby z bramy]: imię i nazwisko z bramy }
let gtImport = null;              // wczytany plik przed zapisem
let gtEditId = null;
let gtLoadToken = 0;
let gtBusy = false;
let gtBannerTimer = null;

// "1 odbicie", "3 odbicia", "8 odbić"
function gtCountText(n) {
  const few = n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14);
  return `${n} ${n === 1 ? "odbicie" : few ? "odbicia" : "odbić"}`;
}

function gtCanEdit() {
  return hasPermission("allow_gate_edit");
}

// ---------- Czas (lokalny, bez strefy - tak jak w pliku z bramy) ----------
// Czas trzymany jako milisekundy "naiwne" (Date.UTC z lokalnych składowych), żeby nie mieszać stref.
const gtPad = n => String(n).padStart(2, "0");

function gtIso(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${gtPad(d.getUTCMonth() + 1)}-${gtPad(d.getUTCDate())}T${gtPad(d.getUTCHours())}:${gtPad(d.getUTCMinutes())}:${gtPad(d.getUTCSeconds())}`;
}

function gtDateIso(ms) {
  return gtIso(ms).slice(0, 10);
}

function gtParseIso(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
}

// Komórka "Czas" z Excela: liczba (dni od 1899-12-30), Date albo tekst "dd.mm.yyyy hh:mm:ss"
function gtCellTime(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Math.round((v - 25569) * 86400000);
  if (v instanceof Date) return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), v.getHours(), v.getMinutes(), v.getSeconds());
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
  return gtParseIso(s);
}

function gtHm(s) {
  return s ? String(s).slice(11, 16) : "";
}

function gtPlDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

// Zmiana i dzień zmiany według najbliższego początku (wejście) albo końca zmiany (samo wyjście)
function gtShiftOf(inMs, outMs) {
  const base = inMs ?? outMs;
  const minutes = Math.round(((base % 86400000) + 86400000) % 86400000 / 60000);
  let best = null;
  GT_SHIFTS.forEach(s => {
    const ref = inMs !== null ? s.start : (s.start + 480) % 1440;
    const diff = ((minutes - ref + 720 + 1440) % 1440) - 720;   // ze znakiem, -720..719
    if (!best || Math.abs(diff) < Math.abs(best.diff)) best = { shift: s.name, diff };
  });
  // początek zmiany = czas odbicia przesunięty do najbliższej granicy (a przy samym wyjściu - jeszcze o 8 h wstecz)
  const startMs = base - best.diff * 60000 - (inMs !== null ? 0 : 480 * 60000);
  return { shift: best.shift, workDate: gtDateIso(startMs) };
}

// Zmiana do wyświetlenia: przy pobycie dłuższym niż jedna zmiana także zmiana, na której było wyjście
// (najbliższy koniec zmiany: 14:30 - I, 22:30 - II, 06:30 - III), np. "II – III" przy wejściu 14:12 i wyjściu 06:45
function gtShiftLabel(r) {
  const short = name => String(name || "-").replace("Zmiana ", "");
  const first = short(r.shift);
  const inMs = gtParseIso(r.entry_at), outMs = gtParseIso(r.exit_at);
  if (inMs === null || outMs === null || outMs - inMs <= 10 * 3600000) return first;
  const minutes = Math.round(((outMs % 86400000) + 86400000) % 86400000 / 60000);
  let last = null, best = Infinity;
  GT_SHIFTS.forEach(s => {
    const end = (s.start + 480) % 1440;
    const dist = Math.abs(((minutes - end + 720 + 1440) % 1440) - 720);
    if (dist < best) { best = dist; last = short(s.name); }
  });
  return last && last !== first ? `${first} – ${last}` : first;
}

// Czas na terenie w pełnych minutach (z godzin wejścia i wyjścia) i zapis HH:MM, np. "08:35"
function gtStayMinutes(r) {
  const inMs = gtParseIso(r.entry_at), outMs = gtParseIso(r.exit_at);
  return inMs !== null && outMs !== null ? Math.round((outMs - inMs) / 60000) : null;
}

function gtFmtStay(minutes) {
  return `${gtPad(Math.floor(minutes / 60))}:${gtPad(minutes % 60)}`;
}

function gtHours(inMs, outMs) {
  return inMs !== null && outMs !== null ? Math.round((outMs - inMs) / 36000) / 100 : null;
}

// ---------- Pracownicy i dopasowanie nazwisk ----------
function gtNorm(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim().split(" ").filter(Boolean).sort().join(" ");
}

function gtEmpName(id) {
  const e = gtEmpById[id];
  return e ? `${e.first_name || ""} ${e.last_name || ""}`.trim() : "";
}

// Pracownik dla osoby z bramy: zapamiętane przypisanie, a bez niego - takie samo imię i nazwisko
// (bez względu na wielkość liter, polskie znaki i kolejność imienia i nazwiska)
function gtMatchEmployee(personId, gateName) {
  if (personId !== null && gtPeople[personId]) return { id: gtPeople[personId], how: "zapamiętane" };
  const key = gtNorm(gateName);
  const found = gtEmployees.filter(e => gtNorm(`${e.first_name} ${e.last_name}`) === key);
  const pick = (list, how) => {
    if (list.length === 1) return { id: list[0].id, how };
    // kilku pracowników: tylko gdy jeden z nich jest aktywny
    const active = list.filter(e => e.active !== false);
    return active.length === 1 ? { id: active[0].id, how } : null;
  };
  const exact = pick(found, "nazwisko");
  if (exact || found.length) return exact;
  // Częściowo: wszystkie człony z bramy są w imieniu i nazwisku pracownika albo odwrotnie, co najmniej dwa wspólne
  // (np. "Luis Alonso" i "Luis Rosemberg Alonso Guerra"); człon może różnić się jedną-dwiema literami
  // (gtSameToken, np. "Galashvili" i "Galashwili"). Takie przypisanie trzeba sprawdzić.
  const mine = key.split(" ").filter(Boolean);
  const partial = gtEmployees.filter(e => {
    const theirs = gtNorm(`${e.first_name} ${e.last_name}`).split(" ").filter(Boolean);
    const common = mine.filter(t => theirs.some(x => gtSameToken(t, x))).length;
    return common >= 2 && (common === mine.length || common === theirs.length);
  });
  return pick(partial, "częściowe");
}

// Ten sam człon imienia lub nazwiska: identyczny albo różniący się o jedną literę (od 4 liter) lub o dwie
// (od 8 liter) - dopisaną, brakującą albo zamienioną (np. "galashvili" / "galashwili", "krychkovskyi" / "krychovski")
function gtSameToken(a, b) {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  const limit = shorter >= 8 ? 2 : shorter >= 4 ? 1 : 0;
  if (!limit || Math.abs(a.length - b.length) > limit) return false;
  // odległość edycyjna (Levenshtein), przerwana, gdy przekroczy limit
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    if (Math.min(...cur) > limit) return false;
    prev = cur;
  }
  return prev[b.length] <= limit;
}

function gtSplitName(gateName) {
  const parts = String(gateName || "").trim().split(/\s+/);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") };
}

// ---------- Start i wybór miesiąca ----------
async function initGateView() {
  gtWatchLayout();
  const now = new Date();
  gtYear = now.getFullYear();
  gtMonth = now.getMonth() + 1;
  gtImport = null;
  document.querySelectorAll("[data-gt-edit]").forEach(el => { el.style.display = gtCanEdit() ? "" : "none"; });

  try {
    const [empRes, peopleRes] = await Promise.all([
      supabaseClient.from("employees").select("id, first_name, last_name, active, business:business_id ( business )"),
      supabaseClient.from("gate_people").select("gate_person_id, gate_name, employee_id")
    ]);
    if (empRes.error) throw empRes.error;
    if (peopleRes.error) throw peopleRes.error;
    gtEmployees = (empRes.data || []).sort((a, b) =>
      `${a.last_name || ""} ${a.first_name || ""}`.localeCompare(`${b.last_name || ""} ${b.first_name || ""}`, "pl"));
    gtEmpById = {};
    gtEmployees.forEach(e => { gtEmpById[e.id] = e; });
    gtPeople = {};
    gtPeopleNames = {};
    (peopleRes.data || []).forEach(p => {
      gtPeople[p.gate_person_id] = p.employee_id;
      gtPeopleNames[p.gate_person_id] = p.gate_name;
    });
  } catch (err) {
    console.error("Błąd ładowania modułu odbić:", err);
    gtShowBanner("error", /gate_|relation|schema cache/i.test(err.message || "")
      ? "Moduł nie jest jeszcze gotowy w bazie danych - uruchom plik sql/46_odbicia_bramy.sql."
      : "Nie udało się pobrać danych: " + (err.message || err));
    return;
  }
  await gtLoad();
}

function gtStep(delta) {
  const d = new Date(gtYear, gtMonth - 1 + delta, 1);
  const now = new Date();
  if (d > new Date(now.getFullYear(), now.getMonth(), 1)) return;
  gtYear = d.getFullYear();
  gtMonth = d.getMonth() + 1;
  gtLoad();
}

// ---------- Tygodnie (ISO: od poniedziałku, tydzień 1 zawiera 4 stycznia) ----------
const GT_DAY = 86400000;
let gtWeekCounts = {};            // { "rok-tydzień": liczba odbić } dla kafelków tygodni
let gtWeekReview = {};            // { "rok-tydzień": liczba odbić do weryfikacji }
let gtWeeksYear = null;           // rok, którego tygodnie pokazują kafelki
let gtStatsWeek = null;           // tydzień zaznaczony w ramce: { year, week, from, to, rows } - liczby w ramce tylko z niego

function gtIsoWeek(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));      // czwartek tego tygodnia
  const year = t.getUTCFullYear();
  return { year, week: Math.ceil(((t - Date.UTC(year, 0, 1)) / GT_DAY + 1) / 7) };
}

function gtWeekMonday(year, week) {
  const jan4 = Date.UTC(year, 0, 4);
  return jan4 - ((new Date(jan4).getUTCDay() || 7) - 1) * GT_DAY + (week - 1) * 7 * GT_DAY;
}

// Kafelki tygodni roku wybranego miesiąca (tylko podgląd, bez filtrowania tabel):
// zielony - wgrane odbicia, żółty - są odbicia do weryfikacji, szary - brak odbić
async function gtLoadWeeks() {
  const year = gtYear;
  try {
    // daty z kilku dni na przełomie lat też należą do tygodni tego roku
    const rows = await rpFetchAll(() => supabaseClient
      .from("gate_entries")
      .select("work_date, issues, verified")
      .gte("work_date", `${year - 1}-12-25`)
      .lte("work_date", `${year + 1}-01-07`));
    gtWeekCounts = {};
    gtWeekReview = {};
    rows.forEach(r => {
      const w = gtIsoWeek(r.work_date);
      const key = `${w.year}-${w.week}`;
      gtWeekCounts[key] = (gtWeekCounts[key] || 0) + 1;
      if (gtNeedsReview(r)) gtWeekReview[key] = (gtWeekReview[key] || 0) + 1;
    });
    gtWeeksYear = year;
  } catch (err) {
    console.error("Błąd pobierania tygodni odbić:", err);
  }
  gtRenderWeeks();
}

function gtRenderWeeks() {
  const box = document.getElementById("gt-weeks");
  if (!box || gtWeeksYear === null) return;
  const year = gtWeeksYear;
  const today = gtIsoWeek(gtDateIso(Date.now()));
  const total = gtIsoWeek(`${year}-12-28`).week;                     // 52 albo 53
  const last = year === today.year ? today.week : year > today.year ? 0 : total;
  const fmt = ms => `${gtPad(new Date(ms).getUTCDate())}.${gtPad(new Date(ms).getUTCMonth() + 1)}`;
  const loaded = Object.keys(gtWeekCounts).filter(k => k.startsWith(`${year}-`)).length;

  document.getElementById("gt-weeks-title").textContent = `Wczytane tygodnie ${year}`;
  document.getElementById("gt-weeks-sub").textContent = `${loaded} z ${last}`;

  // górna linia: miesiące nad swoimi tygodniami (tydzień należy do miesiąca, w którym wypada jego czwartek)
  let months = "", tiles = "", spanStart = 1, spanMonth = null;
  const flush = end => {
    if (spanMonth === null) return;
    const name = RP_MONTHS[spanMonth];
    months += `<div class="mh" style="grid-column: ${spanStart} / ${end};" title="${name}">${end - spanStart >= 3 ? name : name.slice(0, 3)}</div>`;
  };
  for (let w = 1; w <= total; w++) {
    const mon = gtWeekMonday(year, w);
    const m = new Date(mon + 3 * GT_DAY).getUTCMonth();
    if (m !== spanMonth) { flush(w); spanStart = w; spanMonth = m; }
    const n = gtWeekCounts[`${year}-${w}`] || 0;
    const review = gtWeekReview[`${year}-${w}`] || 0;
    const current = year === today.year && w === today.week;
    const cls = review ? " review" : n ? " loaded" : w > last ? " future" : "";
    const active = gtStatsWeek && gtStatsWeek.year === year && gtStatsWeek.week === w;
    tiles += `<button type="button" class="gt-wk${cls}${current ? " current" : ""}${active ? " active" : ""}" style="grid-column: ${w};"
      ${w > last ? "disabled" : ""} aria-pressed="${!!active}" onclick="gtPickStatsWeek(${year}, ${w})"
      title="Tydzień ${w}: ${fmt(mon)}–${fmt(mon + 6 * GT_DAY)}.${year}${n ? ` · ${gtCountText(n)}${review ? `, do weryfikacji: ${review}` : ""}` : w > last ? "" : " · brak odbić"}${active ? " · kliknij ponownie, aby wrócić do miesiąca" : ""}">T${w}</button>`;
  }
  flush(total + 1);
  box.innerHTML = `<div class="gt-wgrid" style="--weeks: ${total};">${months}${tiles}</div>`;

  // na wąskim ekranie (przewijanie w bok) - bieżący tydzień na środku
  const scroll = box.parentElement;
  const target = box.querySelector(".gt-wk.active") || box.querySelector(".gt-wk.current");
  if (scroll && target) scroll.scrollLeft = Math.max(0, target.offsetLeft - scroll.clientWidth / 2 + target.offsetWidth / 2);
}

function gtSyncMonth() {
  const label = document.getElementById("gt-month");
  if (label) label.textContent = `${RP_MONTHS[gtMonth - 1]} ${gtYear}`;
  const now = new Date();
  const next = document.getElementById("gt-next");
  if (next) next.disabled = gtYear > now.getFullYear() || (gtYear === now.getFullYear() && gtMonth >= now.getMonth() + 1);
}

async function gtLoad() {
  gtSyncMonth();
  const body = document.getElementById("gt-body");
  if (!body) return;
  const token = ++gtLoadToken;
  body.innerHTML = `<tr><td colspan="7" class="gt-empty"><i class="fa-solid fa-spinner fa-spin"></i> Ładowanie odbić...</td></tr>`;

  const from = `${gtYear}-${gtPad(gtMonth)}-01`;
  const to = `${gtYear}-${gtPad(gtMonth)}-${gtPad(new Date(gtYear, gtMonth, 0).getDate())}`;
  gtLoadWeeks();
  if (gtStatsWeek) gtLoadStatsWeek().then(gtRenderStats);
  try {
    const rows = await rpFetchAll(() => supabaseClient
      .from("gate_entries")
      .select("*")
      .gte("work_date", from)
      .lte("work_date", to)
      .order("work_date", { ascending: true })
      .order("id", { ascending: true }));
    if (token !== gtLoadToken) return;
    gtRows = rows;
    gtRenderFirms();
    gtRender();
  } catch (err) {
    if (token !== gtLoadToken) return;
    console.error("Błąd pobierania odbić:", err);
    body.innerHTML = `<tr><td colspan="7" class="gt-empty" style="color: var(--danger);">Nie udało się pobrać odbić: ${rtEsc(err.message || err)}</td></tr>`;
  }
}

// ---------- Tabele: osoby z bramy (dopasowanie do Bazy pracowników) i odbicia wybranej osoby ----------
let gtSelKey = null;              // wybrana osoba w pierwszej tabeli
let gtPeopleView = [];            // osoby widoczne w pierwszej tabeli (po filtrach)
let gtPersonEdit = null;          // osoba w oknie dopasowania

// Osoba z bramy: numer z systemu bramy, a bez niego - imię i nazwisko z pliku
function gtPersonKey(r) {
  return r.gate_person_id !== null && r.gate_person_id !== undefined ? `p:${r.gate_person_id}` : `n:${gtNorm(r.gate_name)}`;
}

function gtDisplayName(r) {
  return (r.employee_id && gtEmpName(r.employee_id)) || `${r.first_name || ""} ${r.last_name || ""}`.trim() || r.gate_name;
}

// Tło wiersza: samo dopasowanie częściowe - jasnoniebieskie, inne uwagi - żółte
function gtRowClass(issues) {
  const list = issues || [];
  if (!list.length) return "";
  return list.every(i => i === "dopasowanie") ? "partial" : "review";
}

// Uwagi, które wymagają weryfikacji; dopasowanie częściowe jest tylko informacją (niebieskie) i się do nich nie liczy
function gtReviewIssues(issues) {
  return (issues || []).filter(i => i !== "dopasowanie");
}

function gtNeedsReview(r) {
  return gtReviewIssues(r.issues).length > 0 && !r.verified;
}

function gtRenderFirms() {
  const sel = document.getElementById("gt-filter-firm");
  if (!sel) return;
  const current = sel.value;
  const firms = [...new Set(gtRows.map(r => r.firm).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pl"));
  sel.innerHTML = `<option value="">Wszystkie firmy</option>` + firms.map(f => `<option${f === current ? " selected" : ""}>${rtEsc(f)}</option>`).join("");
}

// Osoby z odbić wybranego miesiąca
function gtPersons() {
  const map = new Map();
  gtRows.forEach(r => {
    const key = gtPersonKey(r);
    let p = map.get(key);
    if (!p) {
      p = { key, personId: r.gate_person_id ?? null, gateName: r.gate_name, employeeId: null, firms: new Set(), rows: [] };
      map.set(key, p);
    }
    p.rows.push(r);
    if (r.firm) p.firms.add(r.firm);
    if (r.employee_id) p.employeeId = r.employee_id;
  });
  return [...map.values()].map(p => ({
    ...p,
    firm: [...p.firms].join(", "),
    name: (p.employeeId && gtEmpName(p.employeeId)) || p.gateName,
    unknown: p.rows.some(r => !r.employee_id),
    partial: p.rows.some(r => r.employee_id && !r.verified && (r.issues || []).includes("dopasowanie")),
    review: p.rows.filter(gtNeedsReview).length
  })).sort((a, b) => a.name.localeCompare(b.name, "pl"));
}

function gtFilteredPersons() {
  const q = gtNorm(document.getElementById("gt-filter-search")?.value || "");
  const firm = document.getElementById("gt-filter-firm")?.value || "";
  const onlyUnknown = !!document.getElementById("gt-filter-review")?.checked;
  return gtPersons().filter(p =>
    (!firm || p.firms.has(firm)) &&
    (!onlyUnknown || p.unknown) &&
    (!q || q.split(" ").every(t => gtNorm(`${p.name} ${p.gateName}`).includes(t))));
}

function gtIssuesHtml(r) {
  const list = r.issues || [];
  if (!list.length) return `<span class="gt-tag ok"><i class="fa-solid fa-check"></i> OK</span>`;
  return list.map(i => `<span class="gt-tag ${r.verified ? "done" : GT_ISSUES[i]?.cls || "warn"}">${rtEsc(GT_ISSUES[i]?.label || i)}</span>`).join(" ") +
    (r.verified ? ` <span class="gt-tag done" title="Sprawdzone"><i class="fa-solid fa-check"></i> sprawdzone</span>` : "");
}

function gtTimeHtml(s, workDate) {
  if (!s) return `<span class="gt-missing">—</span>`;
  const day = String(s).slice(0, 10);
  const shift = day !== workDate ? ` <span class="gt-nextday" title="${gtPlDate(day)}">${day > workDate ? "+1" : "−1"}</span>` : "";
  return `${gtHm(s)}${shift}`;
}

// Liczby w ramce tygodni: dla zaznaczonego tygodnia albo (bez zaznaczenia) dla miesiąca w tabelach
function gtRenderStats() {
  const el = document.getElementById("gt-stats");
  if (!el) return;
  const rows = gtStatsWeek ? (gtStatsWeek.rows || []) : gtRows;
  const review = rows.filter(gtNeedsReview).length;
  const minutes = rows.reduce((s, r) => s + (gtStayMinutes(r) || 0), 0);
  const people = new Set(rows.map(gtPersonKey)).size;
  const unknown = new Set(rows.filter(r => !r.employee_id).map(gtPersonKey)).size;   // osoby nierozpoznane w Bazie pracowników
  const fmt = iso => gtPlDate(iso).slice(0, 5);
  el.innerHTML = `
    <span class="gt-chip scope${gtStatsWeek ? " week" : ""}">${gtStatsWeek
      ? `Tydzień ${gtStatsWeek.week} · ${fmt(gtStatsWeek.from)}–${fmt(gtStatsWeek.to)}`
      : `${RP_MONTHS[gtMonth - 1]} ${gtYear}`}</span>
    <span class="gt-chip">Odbicia <b>${gtStatsWeek && !gtStatsWeek.rows ? "…" : rows.length}</b></span>
    <span class="gt-chip">Osoby <b>${gtStatsWeek && !gtStatsWeek.rows ? "…" : people}</b></span>
    <span class="gt-chip">Na terenie <b>${gtStatsWeek && !gtStatsWeek.rows ? "…" : gtFmtStay(minutes)}</b></span>
    <span class="gt-chip${review ? " warn" : ""}">Do weryfikacji <b>${gtStatsWeek && !gtStatsWeek.rows ? "…" : review}</b></span>
    <span class="gt-chip${unknown ? " bad" : ""}">Nierozpoznane <b>${gtStatsWeek && !gtStatsWeek.rows ? "…" : unknown}</b></span>`;
}

// Zaznaczenie tygodnia zmienia tylko liczby w ramce tygodni (tabele zostają bez zmian);
// ponowne kliknięcie tego samego tygodnia wraca do liczb miesiąca
async function gtPickStatsWeek(year, week) {
  if (gtStatsWeek && gtStatsWeek.year === year && gtStatsWeek.week === week) {
    gtStatsWeek = null;
  } else {
    const mon = gtWeekMonday(year, week);
    gtStatsWeek = { year, week, from: gtDateIso(mon), to: gtDateIso(mon + 6 * GT_DAY), rows: null };
    await gtLoadStatsWeek();
  }
  gtRenderWeeks();
  gtRenderStats();
}

async function gtLoadStatsWeek() {
  const w = gtStatsWeek;
  if (!w) return;
  gtRenderStats();
  try {
    const rows = await rpFetchAll(() => supabaseClient
      .from("gate_entries")
      .select("gate_person_id, gate_name, employee_id, entry_at, exit_at, issues, verified")
      .gte("work_date", w.from)
      .lte("work_date", w.to));
    if (gtStatsWeek === w) w.rows = rows;
  } catch (err) {
    console.error("Błąd pobierania odbić tygodnia:", err);
    if (gtStatsWeek === w) w.rows = [];
  }
}

function gtRender() {
  const body = document.getElementById("gt-people-body");
  if (!body) return;

  gtRenderStats();

  gtPeopleView = gtFilteredPersons();
  if (!gtPeopleView.some(p => p.key === gtSelKey)) gtSelKey = gtPeopleView[0]?.key ?? null;
  const edit = gtCanEdit();

  body.innerHTML = gtPeopleView.map((p, i) => {
    // zapis z bramy zawsze pod nazwiskiem - widać, kogo dopasowano do kogo
    // żółta kropka: zapis z bramy inny niż imię i nazwisko w Bazie pracowników (wielkość liter, polskie znaki
    // i kolejność imienia i nazwiska się nie liczą)
    const differs = p.employeeId && gtNorm(p.name) !== gtNorm(p.gateName);
    // czerwona kropka: osoba nierozpoznana w Bazie pracowników
    const dot = differs ? `<i class="gt-dot" title="Zapis z bramy różni się od Bazy pracowników"></i>`
      : p.unknown ? `<i class="gt-dot red" title="Osoba nierozpoznana w Bazie pracowników"></i>` : "";
    const gateNote = `<span class="gt-sub">z bramy: ${rtEsc(p.gateName)}</span>${dot}`;
    const tags = [
      p.unknown ? `<span class="gt-tag bad">Nierozpoznana</span>` : "",
      p.partial ? `<span class="gt-tag info">Dopasowanie częściowe</span>` : "",
      p.review && !p.unknown ? `<span class="gt-tag warn">Do weryfikacji: ${p.review}</span>` : ""
    ].join(" ").trim() || `<span class="gt-tag ok"><i class="fa-solid fa-check"></i> OK</span>`;
    return `
      <tr class="gt-person${p.key === gtSelKey ? " sel" : ""}${p.unknown ? " unknown" : p.partial ? " partial" : ""}" onclick="gtSelectPerson(${i})">
        <td data-label="Pracownik" class="gt-name"><span class="gt-namebox${dot ? " has-dot" : ""}">${rtEsc(p.name)}${gateNote}</span></td>
        <td data-label="Firma">${rtEsc(p.firm || "-")}</td>
        <td data-label="Wejścia | wyjścia" class="gt-time gt-inout" title="Odbicia wejść | odbicia wyjść">
          <span class="in">${p.rows.filter(r => r.entry_at).length}</span> | <span class="out">${p.rows.filter(r => r.exit_at).length}</span></td>
        <td data-label="Status">${tags}</td>
        <td data-label="" class="gt-actions">${edit ? `
          <button type="button" class="gt-icon" title="Dopasuj do Bazy pracowników" aria-label="Dopasuj do Bazy pracowników"
            onclick="event.stopPropagation(); gtOpenPerson(${i})"><i class="fa-solid fa-pen"></i></button>` : ""}</td>
      </tr>`;
  }).join("") || `<tr><td colspan="5" class="gt-empty">${gtRows.length ? "Brak osób spełniających kryteria." : "Brak odbić w tym miesiącu. Wgraj plik z bramy."}</td></tr>`;

  gtRenderEntries();
  gtFitTables();
}

// Jedna przewijka: tabele obok siebie wypełniają resztę okna pod filtrami i przewijają się same (strona stoi).
// Gdy na tabele zostaje za mało miejsca (niskie okno) albo są jedna pod drugą (wąski obszar treści),
// tabele mają pełną wysokość i przewija się tylko strona.
function gtFitTables() {
  const wraps = [...document.querySelectorAll(".gt-split .gt-table-wrap")];
  const area = document.querySelector(".content-area");
  if (!wraps.length) return;
  wraps.forEach(w => { w.style.height = ""; });
  // telefon: karty jedna pod drugą, przewija się strona
  if (!area || window.matchMedia("(max-width: 768px)").matches) return;

  const split = document.querySelector(".gt-split");
  const sideBySide = getComputedStyle(split).gridTemplateColumns.trim().split(" ").filter(Boolean).length > 1;
  const tables = sideBySide ? 1 : wraps.length;          // tabele jedna pod drugą dzielą się wysokością
  const areaTop = area.getBoundingClientRect().top;
  const top = wraps[0].getBoundingClientRect().top - areaTop + area.scrollTop;
  // wstępnie: całe miejsce pod pierwszą tabelą, potem odjęcie tego, co wystaje (tytuły, nagłówki, marginesy)
  let height = Math.floor((area.clientHeight - top - 34) / tables);
  const apply = h => wraps.forEach(w => { w.style.height = `${h}px`; });
  if (height < GT_MIN_TABLE) return;
  apply(height);
  for (let pass = 0; pass < 2; pass++) {
    const extra = area.scrollHeight - area.clientHeight;
    if (extra <= 0) break;
    height -= Math.ceil(extra / tables);
    if (height < GT_MIN_TABLE) {            // za niskie okno - pełna wysokość, przewija się tylko strona
      wraps.forEach(w => { w.style.height = ""; });
      return;
    }
    apply(height);
  }
}
window.addEventListener("resize", gtFitTables);

// Nagłówek (kafelki tygodni ładują się osobno), komunikat i filtry zmieniają wysokość - tabele dopasowują się na nowo
let gtFitObserver = null;
function gtWatchLayout() {
  if (gtFitObserver) gtFitObserver.disconnect();
  if (typeof ResizeObserver === "undefined") return;
  let pending = false;
  gtFitObserver = new ResizeObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; gtFitTables(); });
  });
  [".gt-hero", "#gt-banner", ".gt-filters", ".gt-split-box"].forEach(sel => {
    const el = document.querySelector(sel);
    if (el) gtFitObserver.observe(el);
  });
}

function gtSelectPerson(i) {
  const p = gtPeopleView[i];
  if (!p) return;
  gtSelKey = p.key;
  document.querySelectorAll("#gt-people-body tr.gt-person").forEach((tr, k) => tr.classList.toggle("sel", k === i));
  gtRenderEntries();
}

// Druga tabela: odbicia osoby wybranej w pierwszej
function gtRenderEntries() {
  const body = document.getElementById("gt-body");
  const title = document.getElementById("gt-entries-title");
  if (!body) return;
  const p = gtPeopleView.find(x => x.key === gtSelKey);
  if (title) title.textContent = p ? `Odbicia: ${p.name}` : "Odbicia";
  if (!p) {
    body.innerHTML = `<tr><td colspan="7" class="gt-empty">Wybierz osobę z listy.</td></tr>`;
    return;
  }
  const edit = gtCanEdit();
  body.innerHTML = p.rows.map(r => {
    const wd = new Date(`${r.work_date}T12:00:00`).getDay();
    return `
      <tr class="${r.verified ? "" : gtRowClass(r.issues)}">
        <td data-label="Data">${gtPlDate(r.work_date)} <span class="gt-sub inline">${GT_WEEKDAYS[wd]}</span></td>
        <td data-label="Zmiana" class="gt-time">${rtEsc(gtShiftLabel(r))}</td>
        <td data-label="Wejście" class="gt-time">${gtTimeHtml(r.entry_at, r.work_date)}</td>
        <td data-label="Wyjście" class="gt-time">${gtTimeHtml(r.exit_at, r.work_date)}</td>
        <td data-label="Na terenie" class="gt-time"><b>${gtStayMinutes(r) !== null ? gtFmtStay(gtStayMinutes(r)) : "—"}</b></td>
        <td data-label="Uwagi">${gtIssuesHtml(r)}</td>
        <td data-label="" class="gt-actions">${edit ? `
          <button type="button" class="gt-icon" title="Popraw" aria-label="Popraw" onclick="gtOpenEdit(${Number(r.id)})"><i class="fa-solid fa-pen"></i></button>
          <button type="button" class="gt-icon danger" title="Usuń" aria-label="Usuń" onclick="gtDelete(this, ${Number(r.id)})"><i class="fa-solid fa-trash"></i></button>` : ""}</td>
      </tr>`;
  }).join("");
}

function gtResetFilters() {
  ["gt-filter-search", "gt-filter-firm"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  const r = document.getElementById("gt-filter-review");
  if (r) r.checked = false;
  gtRender();
}

function gtShowBanner(type, text) {
  const el = document.getElementById("gt-banner");
  if (!el) return;
  el.className = `gt-banner visible ${type}`;
  el.innerHTML = `<i class="fa-solid ${type === "success" ? "fa-circle-check" : "fa-triangle-exclamation"}"></i><span>${rtEsc(text)}</span>`;
  gtFitTables();       // komunikat przesuwa tabele w dół
  clearTimeout(gtBannerTimer);
  if (type === "success") {
    gtBannerTimer = setTimeout(() => { el.classList.remove("visible"); gtFitTables(); }, 10000);
  }
}

// ---------- Dopasowanie osoby z bramy do Bazy pracowników ----------
// Imię i nazwisko z pliku są tylko do odczytu; pracownika z Bazy można zmienić (także przy zgodnym nazwisku).
// Zmiana obejmuje wszystkie odbicia tej osoby (każdy miesiąc) i jest zapamiętywana dla kolejnych plików.
function gtOpenPerson(i) {
  const p = gtPeopleView[i];
  if (!p || !gtCanEdit()) return;
  gtPersonEdit = p;
  const names = gtSplitName(p.gateName);
  document.getElementById("gt-person-first").value = names.first;
  document.getElementById("gt-person-last").value = names.last;
  document.getElementById("gt-person-info").textContent =
    `${p.personId !== null ? `Numer osoby w systemie bramy: ${p.personId}` : "Brak numeru osoby w systemie bramy"}` +
    `${p.firm ? ` · ${p.firm}` : ""} · ${gtCountText(p.rows.length)} w tym miesiącu`;
  document.getElementById("gt-person-search").value = "";
  gtFillPersonSelect(p.employeeId);
  const unlink = document.getElementById("gt-person-unlink");
  if (unlink) {
    unlink.style.display = p.employeeId ? "" : "none";
    unlink.dataset.armed = "";
    unlink.classList.remove("armed");
    unlink.innerHTML = `<i class="fa-solid fa-link-slash"></i> Usuń dopasowanie`;
  }
  gtPersonMsg("");
  toggleModal("modal-gt-person", true);
}

// Lista pracowników w oknie dopasowania (imię, potem nazwisko); wyszukiwarka zawęża listę, wybrany pracownik zostaje na liście
function gtFillPersonSelect(selected) {
  const sel = document.getElementById("gt-person-emp");
  if (!sel) return;
  const current = selected !== undefined ? selected : (Number(sel.value) || null);
  const q = gtNorm(document.getElementById("gt-person-search")?.value || "");
  // tylko aktywni pracownicy, którzy nie są dopasowani do innej osoby z bramy;
  // obecne dopasowanie tej osoby zostaje na liście zawsze (także nieaktywny pracownik)
  const taken = gtMatchedNames(gtPersonEdit?.personId ?? null);
  const list = gtEmployees.filter(e => Number(e.id) === Number(current) ||
    (e.active !== false && !taken[e.id] && (!q || q.split(" ").every(t => gtNorm(`${e.first_name} ${e.last_name}`).includes(t)))))
    .sort((a, b) => `${a.first_name || ""} ${a.last_name || ""}`.localeCompare(`${b.first_name || ""} ${b.last_name || ""}`, "pl"));
  sel.innerHTML = `<option value=""${current ? "" : " selected"}>— brak dopasowania (osoba nierozpoznana) —</option>` +
    list.map(e => `<option value="${e.id}"${Number(e.id) === Number(current) ? " selected" : ""}${taken[e.id] ? ` class="gt-taken"` : ""}>${taken[e.id] ? "✓ " : ""}${rtEsc(`${e.first_name || ""} ${e.last_name || ""}`.trim())}${e.business?.business ? ` · ${rtEsc(e.business.business)}` : ""}${e.active === false ? " (nieaktywny)" : ""}${taken[e.id] ? ` — dopasowany: ${rtEsc(taken[e.id])}` : ""}</option>`).join("");
}

// { [employee_id]: "imiona z bramy" } - pracownicy dopasowani do osób z bramy (bez pominiętej osoby)
function gtMatchedNames(skipPersonId) {
  const out = {};
  Object.entries(gtPeople).forEach(([pid, empId]) => {
    if (!empId || String(pid) === String(skipPersonId)) return;
    out[empId] = out[empId] ? `${out[empId]}, ${gtPeopleNames[pid] || pid}` : (gtPeopleNames[pid] || pid);
  });
  return out;
}

// ---------- Pracownicy z Bazy bez dopasowania do osoby z bramy ----------
function gtOpenUnmatched() {
  const search = document.getElementById("gt-unm-search");
  if (search) search.value = "";
  gtRenderUnmatched();
  toggleModal("modal-gt-unmatched", true);
  search?.focus();
}

function gtRenderUnmatched() {
  const body = document.getElementById("gt-unm-body");
  if (!body) return;
  const matched = gtMatchedNames(null);
  const all = gtEmployees.filter(e => e.active !== false && !matched[e.id]);
  const q = gtNorm(document.getElementById("gt-unm-search")?.value || "");
  const list = all.filter(e => !q || q.split(" ").every(t => gtNorm(`${e.first_name} ${e.last_name} ${e.business?.business || ""}`).includes(t)))
    .sort((a, b) => `${a.first_name || ""} ${a.last_name || ""}`.localeCompare(`${b.first_name || ""} ${b.last_name || ""}`, "pl"));
  const active = gtEmployees.filter(e => e.active !== false).length;
  document.getElementById("gt-unm-count").textContent =
    `Bez dopasowania: ${all.length} z ${active} aktywnych pracowników${q ? ` · widoczne: ${list.length}` : ""}`;
  body.innerHTML = list.map(e => `
    <tr>
      <td data-label="Pracownik" class="gt-name">${rtEsc(`${e.first_name || ""} ${e.last_name || ""}`.trim())}</td>
      <td data-label="Firma">${rtEsc(e.business?.business || "-")}</td>
    </tr>`).join("") || `<tr><td colspan="2" class="gt-empty">${all.length ? "Brak pracowników spełniających kryteria." : "Wszyscy aktywni pracownicy są dopasowani."}</td></tr>`;
}

// Usunięcie dopasowania osoby z bramy (dwa kliknięcia, drugie w ciągu 3,5 s): osoba wraca do nierozpoznanych
function gtUnlinkPerson(btn) {
  if (!gtPersonEdit || gtBusy) return;
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.classList.add("armed");
    btn.textContent = "Na pewno? Kliknij ponownie";
    setTimeout(() => {
      if (btn.isConnected && btn.dataset.armed === "1") {
        btn.dataset.armed = "";
        btn.classList.remove("armed");
        btn.innerHTML = `<i class="fa-solid fa-link-slash"></i> Usuń dopasowanie`;
      }
    }, 3500);
    return;
  }
  document.getElementById("gt-person-emp").value = "";
  gtSavePerson();
}

function gtPersonMsg(text) {
  const el = document.getElementById("gt-person-msg");
  if (!el) return;
  el.textContent = text;
  el.style.display = text ? "block" : "none";
}

async function gtSavePerson() {
  const p = gtPersonEdit;
  if (!p || gtBusy || !gtCanEdit()) return;
  const empId = Number(document.getElementById("gt-person-emp").value) || null;
  const emp = empId ? gtEmpById[empId] : null;
  const names = emp ? { first: emp.first_name || "", last: emp.last_name || "" } : gtSplitName(p.gateName);

  gtBusy = true;
  const btn = document.getElementById("gt-person-save");
  if (btn) btn.disabled = true;
  try {
    // zapamiętanie dla kolejnych plików
    if (p.personId !== null) {
      const { error } = await supabaseClient.from("gate_people").upsert({
        gate_person_id: p.personId, gate_name: p.gateName, employee_id: empId, updated_at: new Date().toISOString()
      });
      if (error) throw error;
      gtPeople[p.personId] = empId;
      gtPeopleNames[p.personId] = p.gateName;
    }
    // wszystkie odbicia tej osoby, także z innych miesięcy
    let query = supabaseClient.from("gate_entries").select("id, issues");
    query = p.personId !== null ? query.eq("gate_person_id", p.personId) : query.eq("gate_name", p.gateName);
    const { data: rows, error: rErr } = await query;
    if (rErr) throw rErr;
    const list = rows || [];
    for (let i = 0; i < list.length; i += 20) {
      const results = await Promise.all(list.slice(i, i + 20).map(o => supabaseClient.from("gate_entries").update({
        employee_id: empId, first_name: names.first, last_name: names.last,
        issues: [...(o.issues || []).filter(x => x !== "nierozpoznany" && x !== "dopasowanie"), ...(empId ? [] : ["nierozpoznany"])],
        edited_by: currentUser?.id ?? null, edited_at: new Date().toISOString()
      }).eq("id", o.id)));
      const failed = results.find(r => r.error);
      if (failed) throw failed.error;
    }

    logAction("Dopasowanie osoby z bramy", `${p.gateName}${p.personId !== null ? ` [${p.personId}]` : ""} → ` +
      `${emp ? gtEmpName(empId) : "brak dopasowania"} (${gtCountText(list.length)})`);
    toggleModal("modal-gt-person", false);
    if (typeof savedToast === "function") savedToast();
    gtShowBanner("success", emp
      ? `${p.gateName} z bramy to teraz ${gtEmpName(empId)} – zmieniono ${gtCountText(list.length)}. Kolejne pliki rozpoznają tę osobę same.`
      : `${p.gateName}: usunięto dopasowanie (${gtCountText(list.length)}).`);
    await gtLoad();
  } catch (err) {
    console.error("Błąd dopasowania osoby z bramy:", err);
    gtPersonMsg("Nie udało się zapisać: " + (err.message || err));
  } finally {
    gtBusy = false;
    if (btn) btn.disabled = false;
  }
}

// ---------- Kasowanie (dwa kliknięcia, drugie w ciągu 3,5 s) ----------
async function gtDelete(btn, id) {
  if (!gtCanEdit()) return;
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.classList.add("armed");
    btn.innerHTML = "Na pewno?";
    setTimeout(() => {
      if (btn.isConnected && btn.dataset.armed === "1") {
        btn.dataset.armed = "";
        btn.classList.remove("armed");
        btn.innerHTML = `<i class="fa-solid fa-trash"></i>`;
      }
    }, 3500);
    return;
  }
  btn.disabled = true;
  const row = gtRows.find(r => Number(r.id) === Number(id));
  const { data, error } = await supabaseClient.from("gate_entries").delete().eq("id", id).select("id");
  if (error || !data || !data.length) {
    gtShowBanner("error", "Nie udało się usunąć odbicia" + (error ? ": " + error.message : " (brak uprawnień w bazie)."));
    btn.disabled = false;
    return;
  }
  logAction("Usunięcie odbicia z bramy", row
    ? `${gtDisplayName(row)}, ${gtPlDate(row.work_date)}, ${gtHm(row.entry_at) || "—"}–${gtHm(row.exit_at) || "—"}` : `id ${id}`);
  gtRows = gtRows.filter(r => Number(r.id) !== Number(id));
  gtRender();
}

// ---------- Poprawianie odbicia (dzień, zmiana, godziny; pracownika zmienia okno dopasowania osoby) ----------
function gtOpenEdit(id) {
  const r = gtRows.find(x => Number(x.id) === Number(id));
  if (!r || !gtCanEdit()) return;
  gtEditId = r.id;
  document.getElementById("gt-edit-gate").textContent =
    `${gtDisplayName(r)}${gtNorm(gtDisplayName(r)) !== gtNorm(r.gate_name) ? ` (z bramy: ${r.gate_name})` : ""}` +
    `${r.firm ? ` · ${r.firm}` : ""}${r.source_file ? ` · plik ${r.source_file}` : ""}`;
  document.getElementById("gt-edit-date").value = r.work_date || "";
  document.getElementById("gt-edit-shift").value = r.shift || "Zmiana I";
  document.getElementById("gt-edit-in").value = r.entry_at ? String(r.entry_at).slice(0, 16) : "";
  document.getElementById("gt-edit-out").value = r.exit_at ? String(r.exit_at).slice(0, 16) : "";
  document.getElementById("gt-edit-verified").checked = true;
  gtEditMsg("");
  toggleModal("modal-gt-edit", true);
}

function gtEditMsg(text) {
  const el = document.getElementById("gt-edit-msg");
  if (!el) return;
  el.textContent = text;
  el.style.display = text ? "block" : "none";
}

// Uwagi przeliczane po poprawce (zostają, ale "sprawdzone" je wycisza)
function gtIssuesFor(inMs, outMs, employeeId) {
  const issues = [];
  if (inMs === null) issues.push("brak_wejscia");
  if (outMs === null) issues.push("brak_wyjscia");
  const h = gtHours(inMs, outMs);
  if (h !== null && h > GT_LONG_HOURS) issues.push("dlugi_pobyt");
  if (!employeeId) issues.push("nierozpoznany");
  return issues;
}

async function gtSaveEdit() {
  const r = gtRows.find(x => Number(x.id) === Number(gtEditId));
  if (!r || gtBusy) return;
  const workDate = document.getElementById("gt-edit-date").value;
  const shift = document.getElementById("gt-edit-shift").value;
  const inMs = gtParseIso(document.getElementById("gt-edit-in").value);
  const outMs = gtParseIso(document.getElementById("gt-edit-out").value);
  const verified = document.getElementById("gt-edit-verified").checked;

  if (!workDate) return gtEditMsg("Wybierz dzień.");
  if (inMs === null && outMs === null) return gtEditMsg("Podaj przynajmniej wejście albo wyjście.");
  if (inMs !== null && outMs !== null && outMs <= inMs) return gtEditMsg("Wyjście musi być po wejściu.");
  if (inMs !== null && outMs !== null && outMs - inMs > 24 * 3600000) return gtEditMsg("Odbicie nie może trwać dłużej niż 24 h.");

  // dopasowanie częściowe zostaje, dopóki nie potwierdzi go okno dopasowania osoby
  const keepPartial = (r.issues || []).includes("dopasowanie") && r.employee_id ? ["dopasowanie"] : [];
  const changes = {
    work_date: workDate,
    shift,
    entry_at: inMs !== null ? gtIso(inMs) : null,
    exit_at: outMs !== null ? gtIso(outMs) : null,
    hours: gtHours(inMs, outMs),
    issues: [...gtIssuesFor(inMs, outMs, r.employee_id), ...keepPartial],
    verified,
    edited_by: currentUser?.id ?? null,
    edited_at: new Date().toISOString()
  };

  gtBusy = true;
  const btn = document.getElementById("gt-edit-save");
  if (btn) btn.disabled = true;
  try {
    const { data, error } = await supabaseClient.from("gate_entries").update(changes).eq("id", r.id).select("id");
    if (error) throw error;
    if (!data || !data.length) throw new Error("brak uprawnień w bazie albo odbicie zostało usunięte");
    logAction("Poprawa odbicia z bramy", `${gtDisplayName(r)}, ${gtPlDate(workDate)}, ` +
      `${changes.entry_at ? gtHm(changes.entry_at) : "—"}–${changes.exit_at ? gtHm(changes.exit_at) : "—"}`);
    toggleModal("modal-gt-edit", false);
    if (typeof savedToast === "function") savedToast();
    await gtLoad();
  } catch (err) {
    console.error("Błąd zapisu odbicia:", err);
    gtEditMsg("Nie udało się zapisać: " + (err.message || err));
  } finally {
    gtBusy = false;
    if (btn) btn.disabled = false;
  }
}

// ---------- Wczytanie pliku z bramy ----------
function gtLoadScript(url) {
  if (window.XLSX) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Nie udało się pobrać biblioteki do odczytu Excela. Sprawdź połączenie z internetem."));
    document.head.appendChild(s);
  });
}

function gtPickFile() {
  if (!gtCanEdit()) return;
  const input = document.getElementById("gt-file");
  if (input) { input.value = ""; input.click(); }
}

async function gtOnFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  gtShowBanner("warning", `Wczytywanie pliku ${file.name}...`);
  try {
    await gtLoadScript(GT_XLSX_URL);
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    gtImport = gtParseRows(rows, file.name);
    document.getElementById("gt-banner").className = "gt-banner";
    gtImpResetFilters();
    toggleModal("modal-gt-import", true);
  } catch (err) {
    console.error("Błąd odczytu pliku z bramy:", err);
    gtShowBanner("error", err.message || String(err));
  }
}

// Wiersze arkusza -> przejścia -> odbicia (wejście + wyjście)
function gtParseRows(rows, fileName) {
  const headerIdx = rows.findIndex(r => r && r.some(c => String(c ?? "").trim() === "Czas") && r.some(c => String(c ?? "").trim() === "Osoba"));
  if (headerIdx < 0) throw new Error("To nie wygląda na plik z bramy: brak nagłówków „Czas” i „Osoba”.");
  const head = rows[headerIdx].map(c => String(c ?? "").trim());
  const col = name => head.indexOf(name);
  const cTime = col("Czas"), cGroup = col("Grupa"), cEvent = col("Zdarzenie"), cPlace = col("Lokalizacja"), cSource = col("Źródło"), cPerson = col("Osoba");

  const events = rows.slice(headerIdx + 1).filter(r => r && gtCellTime(r[cTime]) !== null && r[cPerson]);
  // jedno przejście = trzy wiersze; liczy się "Przyznanie dostępu na Przejściu"
  const passRows = cEvent >= 0 && events.some(r => /przej/i.test(String(r[cEvent] ?? "")))
    ? events.filter(r => /przej/i.test(String(r[cEvent] ?? "")))
    : events;

  const passes = [];
  passRows.forEach(r => {
    const where = `${r[cSource] ?? ""} ${r[cPlace] ?? ""}`;
    const dir = /_WE\b|WEJ/i.test(where) ? "in" : /_WY\b|WYJ/i.test(where) ? "out" : null;
    if (!dir) return;
    const p = String(r[cPerson]).trim().match(/^\[(\d+)\]\s*:?\s*(.+)$/);
    passes.push({
      t: gtCellTime(r[cTime]),
      dir,
      personId: p ? Number(p[1]) : null,
      name: (p ? p[2] : String(r[cPerson])).trim(),
      firm: String(r[cGroup] ?? "").replace(/^\[\d+\]\s*/, "").trim() || null
    });
  });
  passes.sort((a, b) => a.t - b.t);

  // parowanie osobno dla każdej osoby
  const byPerson = new Map();
  passes.forEach(p => {
    const key = p.personId ?? `n:${gtNorm(p.name)}`;
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key).push(p);
  });

  const entries = [];
  const add = (first, inP, outP) => {
    const inMs = inP ? inP.t : null, outMs = outP ? outP.t : null;
    const match = gtMatchEmployee(first.personId, first.name);
    const { shift, workDate } = gtShiftOf(inMs, outMs);
    const emp = match ? gtEmpById[match.id] : null;
    const names = emp ? { first: emp.first_name || "", last: emp.last_name || "" } : gtSplitName(first.name);
    entries.push({
      event_key: `${first.personId ?? gtNorm(first.name)}|${gtIso(inMs ?? outMs)}`,
      gate_person_id: first.personId,
      gate_name: first.name,
      employee_id: match ? match.id : null,
      first_name: names.first,
      last_name: names.last,
      firm: (inP || outP).firm,
      work_date: workDate,
      shift,
      entry_at: inMs !== null ? gtIso(inMs) : null,
      exit_at: outMs !== null ? gtIso(outMs) : null,
      hours: gtHours(inMs, outMs),
      issues: [...gtIssuesFor(inMs, outMs, match ? match.id : null), ...(match && match.how === "częściowe" ? ["dopasowanie"] : [])],
      matchHow: match ? match.how : null
    });
  };

  byPerson.forEach(list => {
    let open = null, last = null;
    list.forEach(p => {
      // ponowne odbicie w tym samym kierunku w ciągu 2 min - to samo przejście
      if (last && last.dir === p.dir && p.t - last.t <= GT_DOUBLE_MIN * 60000) return;
      last = p;
      if (p.dir === "in") {
        if (open) add(open, open, null);
        open = p;
      } else if (open && p.t - open.t <= GT_MAX_HOURS * 3600000) {
        add(open, open, p);
        open = null;
      } else {
        if (open) { add(open, open, null); open = null; }
        add(p, null, p);
      }
    });
    if (open) add(open, open, null);
  });
  entries.sort((a, b) => (a.work_date + a.last_name).localeCompare(b.work_date + b.last_name, "pl"));
  entries.forEach((e, i) => { e._i = i; });      // numer odbicia w pliku (usuwanie z importu przed zapisem)

  const times = passes.map(p => p.t);
  return {
    fileName,
    events: events.length,
    passes: passes.length,
    from: times.length ? Math.min(...times) : null,
    to: times.length ? Math.max(...times) : null,
    entries,
    removed: new Set()
  };
}

// Odbicia z pliku widoczne po filtrach podglądu (nazwisko, firma, tylko nierozpoznane), bez usuniętych - tylko one są zapisywane
function gtImpVisible() {
  const imp = gtImport;
  if (!imp) return [];
  const q = gtNorm(document.getElementById("gt-imp-search")?.value || "");
  const firm = document.getElementById("gt-imp-firm")?.value || "";
  const onlyReview = !!document.getElementById("gt-imp-review")?.checked;
  return imp.entries.filter(e =>
    (!firm || e.firm === firm) &&
    !imp.removed.has(e._i) &&
    (!onlyReview || e.issues.includes("nierozpoznany")) &&
    (!q || q.split(" ").every(t => gtNorm(`${e.employee_id ? gtEmpName(e.employee_id) : ""} ${e.gate_name}`).includes(t))));
}

// Usunięcie odbicia z importu przed zapisem (zostaje w pliku, nie trafi do bazy)
function gtImpRemove(i) {
  if (!gtImport) return;
  gtImport.removed.add(i);
  gtRenderPreview();
}

function gtImpRestore() {
  if (!gtImport) return;
  gtImport.removed.clear();
  gtRenderPreview();
}

function gtImpResetFilters() {
  const imp = gtImport;
  const search = document.getElementById("gt-imp-search");
  if (search) search.value = "";
  const review = document.getElementById("gt-imp-review");
  if (review) review.checked = false;
  const firmSel = document.getElementById("gt-imp-firm");
  if (firmSel && imp) {
    const firms = [...new Set(imp.entries.map(e => e.firm).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pl"));
    firmSel.innerHTML = `<option value="">Wszystkie firmy</option>` + firms.map(f => `<option>${rtEsc(f)}</option>`).join("");
  }
  gtRenderPreview();
}

function gtRenderPreview() {
  const imp = gtImport;
  if (!imp) return;
  const list = gtImpVisible();
  const filtered = list.length !== imp.entries.length;
  const removed = imp.removed.size;
  const count = issue => list.filter(e => e.issues.includes(issue)).length;
  const complete = list.filter(e => !gtReviewIssues(e.issues).length).length;
  const unknown = [...new Map(list.filter(e => !e.employee_id).map(e => [e.gate_person_id ?? e.gate_name, e.gate_name])).values()];
  const people = new Set(list.map(e => e.gate_person_id ?? e.gate_name)).size;
  const fmt = ms => ms === null ? "—" : `${gtPlDate(gtIso(ms))} ${gtHm(gtIso(ms))}`;

  document.getElementById("gt-imp-file").textContent = `${imp.fileName} · ${fmt(imp.from)} – ${fmt(imp.to)} · przejścia przez bramę: ${imp.passes}`;
  document.getElementById("gt-imp-stats").innerHTML = `
    <div class="gt-stat"><span>Odbicia do zapisu</span><b>${list.length}${filtered ? `<small> z ${imp.entries.length}</small>` : ""}</b></div>
    <div class="gt-stat"><span>Osoby</span><b>${people}</b></div>
    <div class="gt-stat ok"><span>Kompletne</span><b>${complete}</b></div>
    <div class="gt-stat ${list.length - complete ? "warn" : ""}"><span>Do weryfikacji</span><b>${list.length - complete}</b></div>`;
  document.getElementById("gt-imp-issues").innerHTML = [
    ["brak_wyjscia", count("brak_wyjscia")], ["brak_wejscia", count("brak_wejscia")],
    ["dlugi_pobyt", count("dlugi_pobyt")], ["nierozpoznany", count("nierozpoznany")], ["dopasowanie", count("dopasowanie")]
  ].filter(([, n]) => n).map(([k, n]) => `<span class="gt-tag ${GT_ISSUES[k].cls}">${GT_ISSUES[k].label}: ${n}</span>`).join(" ") +
    (removed ? `<div class="gt-unknown">Usunięte z importu: <b class="gt-removed">${removed}</b> – nie trafią do bazy. <button type="button" class="gt-link" onclick="gtImpRestore()">Przywróć usunięte</button></div>` : "") +
    (unknown.length ? `<div class="gt-unknown"><b>Osoby nierozpoznane w Bazie pracowników (${unknown.length}):</b> ${unknown.map(rtEsc).join(", ")}.
      Zapiszą się z imieniem i nazwiskiem z bramy; przypiszesz je potem przyciskiem „Popraw”.</div>` : "");

  document.getElementById("gt-imp-body").innerHTML = list.map(e => `
    <tr class="${gtRowClass(e.issues)}">
      <td data-label="Pracownik" class="gt-name">${rtEsc(e.employee_id ? gtEmpName(e.employee_id) : e.gate_name)}${e.employee_id && gtNorm(gtEmpName(e.employee_id)) !== gtNorm(e.gate_name) ? `<span class="gt-sub">z bramy: ${rtEsc(e.gate_name)}</span>` : ""}</td>
      <td data-label="Firma">${rtEsc(e.firm || "-")}</td>
      <td data-label="Data">${gtPlDate(e.work_date)}</td>
      <td data-label="Zmiana" class="gt-time">${rtEsc(gtShiftLabel(e))}</td>
      <td data-label="Wejście" class="gt-time">${gtTimeHtml(e.entry_at, e.work_date)}</td>
      <td data-label="Wyjście" class="gt-time">${gtTimeHtml(e.exit_at, e.work_date)}</td>
      <td data-label="Na terenie" class="gt-time">${gtStayMinutes(e) !== null ? gtFmtStay(gtStayMinutes(e)) : "—"}</td>
      <td data-label="Uwagi">${gtIssuesHtml(e)}</td>
      <td data-label="" class="gt-actions"><button type="button" class="gt-icon danger" title="Usuń z importu" aria-label="Usuń z importu" onclick="gtImpRemove(${e._i})"><i class="fa-solid fa-trash"></i></button></td>
    </tr>`).join("") || `<tr><td colspan="9" class="gt-empty">${imp.entries.length ? "Brak odbić spełniających kryteria." : "W pliku nie ma przejść przez bramę."}</td></tr>`;
  const save = document.getElementById("gt-imp-save");
  if (save) {
    save.disabled = !list.length;
    save.textContent = filtered ? `Zapisz widoczne (${list.length})` : "Zapisz do bazy";
  }
  gtImpMsg("");
}

function gtImpMsg(text, color = "var(--danger)") {
  const el = document.getElementById("gt-imp-msg");
  if (!el) return;
  el.textContent = text;
  el.style.color = color;
  el.style.display = text ? "block" : "none";
}

// ---------- Zapis do bazy ----------
async function gtSaveImport() {
  const imp = gtImport;
  if (!imp || gtBusy || !gtCanEdit()) return;
  const entries = gtImpVisible();          // tylko odbicia widoczne po filtrach podglądu
  if (!entries.length) return;
  const partial = entries.length !== imp.entries.length;
  gtBusy = true;
  const btn = document.getElementById("gt-imp-save");
  if (btn) { btn.disabled = true; btn.textContent = "Zapisywanie..."; }
  try {
    // 1. Osoby z bramy: zapamiętaj nowe (rozpoznane od razu z pracownikiem)
    const newPeople = [...new Map(entries.filter(e => e.gate_person_id !== null && !(e.gate_person_id in gtPeople))
      // dopasowanie częściowe nie jest zapamiętywane, dopóki ktoś go nie potwierdzi przyciskiem "Popraw"
      .map(e => [e.gate_person_id, { gate_person_id: e.gate_person_id, gate_name: e.gate_name, employee_id: e.matchHow === "częściowe" ? null : e.employee_id }])).values()];
    if (newPeople.length) {
      const { error } = await supabaseClient.from("gate_people").upsert(newPeople, { onConflict: "gate_person_id", ignoreDuplicates: true });
      if (error) throw error;
      newPeople.forEach(p => {
        gtPeople[p.gate_person_id] = p.employee_id;
        gtPeopleNames[p.gate_person_id] = p.gate_name;
      });
    }

    // 2. Samo wyjście może domknąć odbicie z poprzedniego pliku, w którym zabrakło wyjścia
    const exitsOnly = entries.filter(e => !e.entry_at && e.gate_person_id !== null);
    const closed = new Set();
    if (exitsOnly.length) {
      const earliest = Math.min(...exitsOnly.map(e => gtParseIso(e.exit_at))) - GT_MAX_HOURS * 3600000;
      const { data: open, error } = await supabaseClient.from("gate_entries")
        .select("id, gate_person_id, employee_id, entry_at, verified")
        .in("gate_person_id", [...new Set(exitsOnly.map(e => e.gate_person_id))])
        .is("exit_at", null)
        .gte("entry_at", gtIso(earliest));
      if (error) throw error;
      for (const e of exitsOnly) {
        const outMs = gtParseIso(e.exit_at);
        const prev = (open || []).filter(o => o.gate_person_id === e.gate_person_id && !closed.has(o.id))
          .map(o => ({ ...o, inMs: gtParseIso(o.entry_at) }))
          .filter(o => o.inMs < outMs && outMs - o.inMs <= GT_MAX_HOURS * 3600000)
          .sort((a, b) => b.inMs - a.inMs)[0];
        if (!prev) continue;
        const { error: uErr } = await supabaseClient.from("gate_entries").update({
          exit_at: e.exit_at,
          hours: gtHours(prev.inMs, outMs),
          issues: gtIssuesFor(prev.inMs, outMs, prev.employee_id),
          verified: false
        }).eq("id", prev.id);
        if (uErr) throw uErr;
        closed.add(prev.id);
        e.mergedInto = prev.id;
      }
    }

    // 2b. Pełne odbicie (wejście + wyjście), które w bazie jest rozbite na dwa niekompletne wpisy
    //     (np. z wcześniejszego wgrania): wpis z wejściem dostaje wyjście, wpis z samym wyjściem znika
    const pairs = entries.filter(e => e.entry_at && e.exit_at && e.gate_person_id !== null && !e.mergedInto);
    const exitKey = e => `${e.gate_person_id}|${e.exit_at}`;
    for (let i = 0; i < pairs.length; i += 200) {
      const part = pairs.slice(i, i + 200);
      const [{ data: openRows, error: oErr }, { data: exitRows, error: xErr }] = await Promise.all([
        supabaseClient.from("gate_entries").select("id, event_key, employee_id").in("event_key", part.map(e => e.event_key)).is("exit_at", null),
        supabaseClient.from("gate_entries").select("id, event_key").in("event_key", part.map(exitKey)).is("entry_at", null)
      ]);
      if (oErr) throw oErr;
      if (xErr) throw xErr;
      for (const e of part) {
        const open = (openRows || []).find(o => o.event_key === e.event_key);
        const lone = (exitRows || []).find(o => o.event_key === exitKey(e));
        if (!open) continue;
        const inMs = gtParseIso(e.entry_at), outMs = gtParseIso(e.exit_at);
        const { error: uErr } = await supabaseClient.from("gate_entries").update({
          exit_at: e.exit_at, hours: gtHours(inMs, outMs),
          issues: gtIssuesFor(inMs, outMs, open.employee_id), verified: false
        }).eq("id", open.id);
        if (uErr) throw uErr;
        if (lone) {
          const { error: dErr } = await supabaseClient.from("gate_entries").delete().eq("id", lone.id);
          if (dErr) throw dErr;
        }
        closed.add(open.id);
        e.mergedInto = open.id;
      }
    }

    // 3. Odbicia; to samo odbicie wgrane drugi raz jest pomijane (unikalny event_key)
    const rows = entries.filter(e => !e.mergedInto).map(e => ({
      event_key: e.event_key, gate_person_id: e.gate_person_id, gate_name: e.gate_name, employee_id: e.employee_id,
      first_name: e.first_name, last_name: e.last_name, firm: e.firm, work_date: e.work_date, shift: e.shift,
      entry_at: e.entry_at, exit_at: e.exit_at, hours: e.hours, issues: e.issues, verified: false,
      source_file: imp.fileName, imported_by: currentUser?.id ?? null
    }));
    let added = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const { data, error } = await supabaseClient.from("gate_entries")
        .upsert(rows.slice(i, i + 500), { onConflict: "event_key", ignoreDuplicates: true })
        .select("id");
      if (error) throw error;
      added += (data || []).length;
    }
    const skipped = rows.length - added;

    logAction("Wgranie odbić z bramy", `Plik ${imp.fileName}${partial ? ` (wybrane ${entries.length} z ${imp.entries.length})` : ""}: nowe odbicia ${added}` +
      (closed.size ? `, domknięte wcześniejsze ${closed.size}` : "") + (skipped ? `, pominięte (już w bazie) ${skipped}` : ""));
    toggleModal("modal-gt-import", false);
    if (typeof savedToast === "function") savedToast();
    gtShowBanner("success", `Zapisano odbicia z pliku ${imp.fileName}: nowe ${added}` +
      (closed.size ? `, domknięte wcześniejsze (brakujące wyjście) ${closed.size}` : "") +
      (skipped ? `, pominięte, bo już były w bazie: ${skipped}` : "") + ".");
    gtImport = null;

    // pokaż miesiąc, którego dotyczy plik (ostatnie odbicie w pliku)
    if (imp.to !== null) {
      const d = new Date(imp.to);
      gtYear = d.getUTCFullYear();
      gtMonth = d.getUTCMonth() + 1;
    }
    await gtLoad();
  } catch (err) {
    console.error("Błąd zapisu odbić:", err);
    gtImpMsg("Nie udało się zapisać: " + (err.message || err));
  } finally {
    gtBusy = false;
    if (btn) btn.disabled = false;
    if (gtImport && btn) btn.textContent = partial ? `Zapisz widoczne (${entries.length})` : "Zapisz do bazy";
  }
}
