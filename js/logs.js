// ==========================================
// MODUŁ: LOGI (logs)
// Dziennik zdarzeń z tabeli app_logs: kto, kiedy i co zrobił.
// Dwie zakładki: użytkownicy systemu i pracownicy (portal z godzinami).
// Wpisy dodaje funkcja logAction (app.js) przez funkcję bazy app_log.
// Wymaga: supabaseClient (app.js), rtEsc (report_time.js)
// ==========================================

const LG_PAGE = 200;         // ile wpisów pobierać naraz

let lgKind = "user";         // zakładka: "user" | "employee"
let lgRows = [];
let lgHasMore = false;
let lgLoadToken = 0;
let lgLoading = false;

function lgFormatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || "-");
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Rodzaj zdarzenia do oznaczenia kolorem (obok zawsze jest nazwa zdarzenia)
function lgCategory(action) {
  const a = String(action || "").toLowerCase();
  if (/^logowanie|^wylogowanie/.test(a)) return "auth";
  if (/usunięcie|zablokowanie/.test(a)) return "danger";
  if (/dodanie|utworzenie|dopisanie/.test(a)) return "add";
  return "edit";
}

// Początek wybranego okresu jako data ISO; null = bez ograniczenia
function lgSince() {
  const value = document.getElementById("lg-filter-period")?.value || "7";
  if (value === "all") return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (Number(value) - 1)); // "1" = od dzisiejszej północy
  return d.toISOString();
}

async function initLogsView() {
  lgKind = "user";
  lgRows = [];
  lgRenderTabs();
  await lgLoad(false);
}

function lgRenderTabs() {
  document.querySelectorAll("#lg-tabs button").forEach(btn => {
    const on = btn.dataset.kind === lgKind;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-selected", String(on));
  });
}

function lgSetKind(kind) {
  if (kind === lgKind) return;
  lgKind = kind;
  lgRenderTabs();
  const actionSel = document.getElementById("lg-filter-action");
  if (actionSel) actionSel.value = "";
  lgLoad(false);
}

// append = true dokleja starsze wpisy do już pokazanych
async function lgLoad(append) {
  const tbody = document.getElementById("lg-table-body");
  if (!tbody) return;
  const token = ++lgLoadToken;
  const offset = append ? lgRows.length : 0;

  lgLoading = true;
  lgSyncMore();
  if (!append) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:30px;">
      <i class="fa-solid fa-spinner fa-spin"></i> Ładowanie logów...</td></tr>`;
  }

  let query = supabaseClient
    .from("app_logs")
    .select("id, created_at, actor_name, action, details")
    .eq("actor_kind", lgKind)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + LG_PAGE - 1);
  const since = lgSince();
  if (since) query = query.gte("created_at", since);

  const { data, error } = await query;
  if (token !== lgLoadToken) return; // zmieniono zakładkę albo okres
  lgLoading = false;

  if (error) {
    console.error("Błąd pobierania logów:", error);
    lgRows = [];
    lgHasMore = false;
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--danger);padding:25px;">
      Nie udało się pobrać logów: ${rtEsc(error.message)}</td></tr>`;
    lgSyncMore();
    return;
  }

  lgRows = append ? lgRows.concat(data || []) : (data || []);
  lgHasMore = (data || []).length === LG_PAGE;
  lgFillActions();
  lgRender();
}

// Lista rodzajów zdarzeń z pobranych wpisów
function lgFillActions() {
  const sel = document.getElementById("lg-filter-action");
  if (!sel) return;
  const prev = sel.value;
  const actions = [...new Set(lgRows.map(r => r.action).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pl"));
  sel.innerHTML = `<option value="">Wszystkie zdarzenia</option>` +
    actions.map(a => `<option value="${rtEsc(a)}">${rtEsc(a)}</option>`).join("");
  if (actions.includes(prev)) sel.value = prev;
}

function lgVisibleRows() {
  const q = (document.getElementById("lg-filter-search")?.value || "").toLowerCase().trim();
  const action = document.getElementById("lg-filter-action")?.value || "";
  return lgRows.filter(r =>
    (!action || r.action === action) &&
    (!q || `${r.actor_name || ""} ${r.action || ""} ${r.details || ""}`.toLowerCase().includes(q)));
}

function lgSyncMore() {
  const btn = document.getElementById("lg-more");
  if (!btn) return;
  btn.style.display = lgHasMore ? "" : "none";
  btn.disabled = lgLoading;
}

function lgRender() {
  const tbody = document.getElementById("lg-table-body");
  const info = document.getElementById("lg-info");
  if (!tbody) return;

  const list = lgVisibleRows();
  if (info) {
    const loaded = `${lgRows.length}${lgHasMore ? "+" : ""}`;
    info.textContent = list.length === lgRows.length ? `Wpisów: ${loaded}` : `Wpisów: ${list.length} z ${loaded}`;
  }
  lgSyncMore();

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:30px;">
      ${lgRows.length === 0 ? "Brak wpisów w wybranym okresie." : "Brak wpisów spełniających podane kryteria."}</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(r => `
    <tr>
      <td class="lg-date">${rtEsc(lgFormatDate(r.created_at))}</td>
      <td class="lg-who">${rtEsc(r.actor_name || "-")}</td>
      <td><span class="lg-chip ${lgCategory(r.action)}">${rtEsc(r.action || "-")}</span></td>
      <td class="lg-details">${rtEsc(r.details || "")}</td>
    </tr>`).join("");
}
