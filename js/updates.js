// ==========================================
// MODUŁ: ZMIANY I AKTUALIZACJE (updates)
// Wymaga: supabaseClient, toggleModal (z app.js) oraz pomocniczych rt* (z report_time.js)
// ==========================================

// Tabela wpisów: id, version, name_change, date, progress, add_data, sort_order
const UP_TABLE = "update_list";
// Tabela wersji: name, version (wiersze "aktualna_wersja" i "wersja_w_budowie")
const UP_VERSION_TABLE = "Check_version";
const UP_KEY_ACTIVE = "aktualna_wersja";
const UP_KEY_PROGRESS = "wersja_w_budowie";

let upItems = [];
let upActive = "";           // wersja aktywna ("" = nie ustawiono)
let upProgress = "";         // wersja w budowie
let upDeleteId = null;
let upDeleteTimer = null;
let upBusy = false;
let upBannerTimer = null;
let upFilter = "all";        // "all" | "todo" | "done"
let upCollapsed = {};        // { [wersja]: true/false } — ręcznie zwinięte lub rozwinięte grupy
let upFresh = true;          // pierwszy render po wejściu w widok
let upGroupKeys = [];      // wersje w kolejności ostatniego renderu (indeks -> wersja)

// ---------- Pomocnicze ----------
function upToday() {
  return rtIsoToPl(rtTodayIso());
}

function upIsDone(item) {
  return item.progress === true || item.progress === 1;
}

// Porównanie numerów wersji: "1.10.0" > "1.9.2"
function upCompareVersions(a, b) {
  const pa = String(a).split(".").map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return String(a).localeCompare(String(b));
}

function upShowBanner(type, text) {
  const el = document.getElementById("up-banner");
  if (!el) return;
  const icon = type === "success" ? "fa-circle-check" : "fa-triangle-exclamation";
  el.className = `up-banner visible ${type}`;
  el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${rtEsc(text)}</span>`;
  clearTimeout(upBannerTimer);
  upBannerTimer = setTimeout(() => el.classList.remove("visible"), 8000);
}

function upFindItem(id) {
  return upItems.find(i => Number(i.id) === Number(id)) || null;
}

// ---------- Inicjalizacja ----------
async function initUpdatesView() {
  upItems = [];
  upActive = "";
  upProgress = "";
  upFilter = "all";
  upCollapsed = {};
  upFresh = true;

  await upLoadVersions();

  const ver = document.getElementById("up-add-version");
  if (ver) ver.value = upProgress;

  await upLoad();
}

// ---------- Wersje (aktywna / w budowie) ----------
function upRenderBadges() {
  const a = document.getElementById("up-badge-active");
  const p = document.getElementById("up-badge-progress");
  if (a) a.textContent = `v${upActive || "—"}`;
  setTopbarVersion(upActive);
  if (p) p.textContent = `v${upProgress || "—"}`;

  // Pasek postępu wersji w budowie
  const wrap = document.getElementById("up-hero-prog");
  if (!wrap) return;
  const items = upItems.filter(i => String(i.version || "").trim() === upProgress);
  if (!upProgress || items.length === 0) {
    wrap.style.display = "none";
    return;
  }
  const done = items.filter(upIsDone).length;
  const pct = Math.round((done / items.length) * 100);
  wrap.style.display = "";
  document.getElementById("up-hero-prog-label").textContent =
    `Postęp wersji ${upProgress}: ukończono ${done} z ${items.length}`;
  document.getElementById("up-hero-prog-pct").textContent = `${pct}%`;
  document.getElementById("up-hero-prog-bar").style.width = `${pct}%`;
}

async function upLoadVersions() {
  const { data, error } = await supabaseClient.from(UP_VERSION_TABLE).select("name, version");

  if (error) {
    console.error("Błąd pobierania wersji:", error);
    upShowBanner("warning", `Nie udało się pobrać wersji z tabeli ${UP_VERSION_TABLE}: ${error.message}`);
  } else {
    (data || []).forEach(row => {
      const name = String(row.name || "").trim().toLowerCase();
      const version = String(row.version || "").trim();
      if (name === UP_KEY_ACTIVE) upActive = version;
      else if (name === UP_KEY_PROGRESS) upProgress = version;
    });
  }
  upRenderBadges();
}

const UP_NEW_VERSION = "__new__";

// Listy wyboru: wersje z wpisów (z postępem) + obecnie ustawione + opcja wpisania nowej
function upOpenVersions() {
  const stats = {};
  upItems.forEach(i => {
    const v = String(i.version || "").trim();
    if (!v) return;
    if (!stats[v]) stats[v] = { total: 0, done: 0 };
    stats[v].total++;
    if (upIsDone(i)) stats[v].done++;
  });

  const versions = [...new Set([...Object.keys(stats), upActive, upProgress].filter(Boolean))]
    .sort((a, b) => upCompareVersions(b, a));

  const options = versions.map(v => {
    const s = stats[v];
    const info = s ? `ukończono ${s.done}/${s.total}` : "brak wpisów";
    return `<option value="${rtEsc(v)}">${rtEsc(v)} — ${info}</option>`;
  }).join("") + `<option value="${UP_NEW_VERSION}">+ Nowa wersja...</option>`;

  [["active", upActive], ["progress", upProgress]].forEach(([kind, current]) => {
    const sel = document.getElementById(`up-ver-${kind}`);
    sel.innerHTML = options;
    sel.value = current || versions[0] || UP_NEW_VERSION;
    document.getElementById(`up-ver-${kind}-new`).value = "";
    upOnVersionSelect(kind, false);
  });

  document.getElementById("up-ver-msg").style.display = "none";
  toggleModal("modal-up-versions", true);
}

// Pole tekstowe pojawia się tylko po wybraniu "+ Nowa wersja..."
function upOnVersionSelect(kind, focus = true) {
  const sel = document.getElementById(`up-ver-${kind}`);
  const input = document.getElementById(`up-ver-${kind}-new`);
  const isNew = sel.value === UP_NEW_VERSION;
  input.style.display = isNew ? "" : "none";
  if (isNew && focus) input.focus();
}

function upVersionValue(kind) {
  const sel = document.getElementById(`up-ver-${kind}`);
  const raw = sel.value === UP_NEW_VERSION ? document.getElementById(`up-ver-${kind}-new`).value : sel.value;
  return raw.trim().replace(/^v\s*/i, "");
}

async function upSetVersion(key, version) {
  const { data, error } = await supabaseClient
    .from(UP_VERSION_TABLE)
    .update({ version })
    .ilike("name", key)
    .select("name");
  if (error) throw error;

  if (!data || data.length === 0) {
    const { error: insertErr } = await supabaseClient.from(UP_VERSION_TABLE).insert({ name: key, version });
    if (insertErr) throw insertErr;
  }
}

async function upSaveVersions() {
  if (upBusy) return;
  const newActive = upVersionValue("active");
  const newProgress = upVersionValue("progress");
  const msg = document.getElementById("up-ver-msg");
  const btn = document.getElementById("up-ver-save");

  if (!newActive || !newProgress) {
    msg.textContent = "Oba pola wersji muszą być uzupełnione.";
    msg.style.display = "block";
    return;
  }

  upBusy = true;
  if (btn) btn.disabled = true;
  try {
    await upSetVersion(UP_KEY_ACTIVE, newActive);
    upActive = newActive;
    await upSetVersion(UP_KEY_PROGRESS, newProgress);
    upProgress = newProgress;

    const ver = document.getElementById("up-add-version");
    if (ver) ver.value = upProgress;

    toggleModal("modal-up-versions", false);
    logAction("Zmiana wersji systemu", `aktywna: ${newActive}, w budowie: ${newProgress}`);
    upShowBanner("success", "Wersje zostały zaktualizowane.");
  } catch (err) {
    console.error("Błąd zapisu wersji:", err);
    msg.textContent = "Nie udało się zapisać wersji: " + (err.message || err);
    msg.style.display = "block";
  } finally {
    upBusy = false;
    if (btn) btn.disabled = false;
    upRenderBadges();
    upRender();
  }
}

// ---------- Lista wpisów ----------
async function upLoad() {
  const list = document.getElementById("up-list");
  if (!list) return;

  const { data, error } = await supabaseClient
    .from(UP_TABLE)
    .select("*")
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    console.error("Błąd pobierania listy aktualizacji:", error);
    upItems = [];
    list.innerHTML = `<div class="card" style="text-align:center;color:var(--danger);">
      Nie udało się pobrać listy aktualizacji: ${rtEsc(error.message)}</div>`;
    return;
  }

  upItems = data || [];
  upRender();
}

// Grupy wersji: aktywna, w budowie, potem pozostałe od najnowszej
function upGroups() {
  const map = new Map();
  upItems.forEach(item => {
    const ver = String(item.version || "Inne").trim() || "Inne";
    if (!map.has(ver)) map.set(ver, []);
    map.get(ver).push(item);
  });

  const rank = v => (v === upActive ? 0 : v === upProgress ? 1 : 2);
  return [...map.entries()].sort((a, b) =>
    rank(a[0]) - rank(b[0]) || upCompareVersions(b[0], a[0])
  );
}

function upRowHtml(item, idx, total) {
  const id = Number(item.id);
  const done = upIsDone(item);
  // Kolejność zmienia się względem całej grupy, więc strzałki tylko bez filtra
  const reorder = upFilter === "all";

  return `
    <div class="up-item ${done ? "done" : ""}">
      <label class="up-check" title="${done ? "Oznacz jako niewykonane" : "Oznacz jako wykonane"}">
        <input type="checkbox" ${done ? "checked" : ""} aria-label="Wykonano" onchange="upToggle(${id}, this)" />
        <span class="box"><i class="fa-solid fa-check"></i></span>
      </label>
      <div class="body">
        <div class="txt">${rtEsc(item.name_change)}</div>
        <div class="meta">
          <span><i class="fa-solid fa-calendar-plus"></i> Dodano ${rtEsc(item.add_data || "-")}</span>
          ${done && item.date ? `<span class="ok"><i class="fa-solid fa-circle-check"></i> Wykonano ${rtEsc(item.date)}</span>` : ""}
        </div>
      </div>
      <div class="up-actions">
        ${reorder ? `
        <button type="button" class="up-act" title="Przesuń wyżej" aria-label="Przesuń wyżej" ${idx === 0 ? "disabled" : ""} onclick="upMove(${id}, -1)"><i class="fa-solid fa-chevron-up"></i></button>
        <button type="button" class="up-act" title="Przesuń niżej" aria-label="Przesuń niżej" ${idx === total - 1 ? "disabled" : ""} onclick="upMove(${id}, 1)"><i class="fa-solid fa-chevron-down"></i></button>` : ""}
        <button type="button" class="up-act del" title="Usuń wpis" aria-label="Usuń wpis" onclick="upOpenDelete(${id})"><i class="fa-solid fa-trash"></i></button>
      </div>
    </div>`;
}

function upRenderFilter() {
  const el = document.getElementById("up-filter");
  if (!el) return;
  const done = upItems.filter(upIsDone).length;
  const tabs = [
    ["all", "Wszystkie", upItems.length],
    ["todo", "Do zrobienia", upItems.length - done],
    ["done", "Ukończone", done]
  ];
  el.innerHTML = tabs.map(([key, label, n]) => `
    <button type="button" class="${upFilter === key ? "on" : ""}" aria-pressed="${upFilter === key}" onclick="upSetFilter('${key}')">
      ${label} <span class="n">${n}</span>
    </button>`).join("");
}

function upSetFilter(key) {
  upFilter = key;
  upRender();
}

function upToggleGroup(index) {
  const version = upGroupKeys[index];
  if (version === undefined) return;
  const section = document.getElementById(`up-ver-${index}`);
  const collapsed = !(section && section.classList.contains("collapsed"));
  upCollapsed[version] = collapsed;
  if (section) {
    section.classList.toggle("collapsed", collapsed);
    section.querySelector(".up-ver-head")?.setAttribute("aria-expanded", String(!collapsed));
  }
}

function upRender() {
  const list = document.getElementById("up-list");
  if (!list) return;

  upRenderBadges();
  upRenderFilter();

  if (upItems.length === 0) {
    list.innerHTML = `<div class="up-empty"><i class="fa-solid fa-lightbulb"></i>
      Brak wpisów w historii zmian. Dodaj swój pierwszy pomysł powyżej.</div>`;
    return;
  }

  const groups = upGroups();
  upGroupKeys = groups.map(g => g[0]);

  const html = groups.map(([version, items], index) => {
    const visible = items.filter(it =>
      upFilter === "all" || (upFilter === "done") === upIsDone(it));
    if (visible.length === 0) return "";

    const doneCount = items.filter(upIsDone).length;
    const complete = doneCount === items.length;
    const pct = Math.round((doneCount / items.length) * 100);
    const kind = version === upActive ? "active" : version === upProgress ? "progress" : "";
    const chip = kind === "active" ? "Aktualna" : kind === "progress" ? "W budowie" : complete ? "Ukończona" : "Zaplanowana";
    const icon = kind === "progress" ? "fa-hammer" : (kind === "active" || complete) ? "fa-check" : "fa-flag";

    // Domyślnie zwinięte są tylko w pełni ukończone wersje archiwalne
    const collapsed = upCollapsed[version] ?? (upFilter === "all" && !kind && complete);

    return `
      <section class="up-ver ${kind} ${complete ? "complete" : ""} ${collapsed ? "collapsed" : ""}" id="up-ver-${index}" style="animation-delay: ${index * 50}ms;">
        <div class="up-node"><i class="fa-solid ${icon}"></i></div>
        <div class="up-ver-card">
          <button type="button" class="up-ver-head" aria-expanded="${!collapsed}" onclick="upToggleGroup(${index})">
            <span class="name">v${rtEsc(version)}</span>
            <span class="up-chip">${chip}</span>
            <span class="spacer"></span>
            <span class="up-mini" aria-hidden="true"><span style="width: ${pct}%;"></span></span>
            <span class="cnt" title="Ukończono ${doneCount} z ${items.length}">${doneCount}/${items.length}</span>
            <i class="fa-solid fa-chevron-down chev"></i>
          </button>
          <div class="up-ver-body">
            ${visible.map(it => upRowHtml(it, items.indexOf(it), items.length)).join("")}
          </div>
        </div>
      </section>`;
  }).join("");

  // Animacja wejścia tylko przy pierwszym wyświetleniu, nie po każdej akcji
  const fresh = upFresh ? " fresh" : "";
  upFresh = false;

  list.innerHTML = html.trim()
    ? `<div class="up-timeline${fresh}">${html}</div>`
    : `<div class="up-empty"><i class="fa-solid fa-filter"></i>
        ${upFilter === "done" ? "Żaden wpis nie jest jeszcze ukończony." : "Wszystko zrobione — brak wpisów do wykonania."}</div>`;
}

// ---------- Akcje na wpisach ----------
async function upAddEntry() {
  if (upBusy) return;
  const verEl = document.getElementById("up-add-version");
  const descEl = document.getElementById("up-add-desc");
  const version = verEl.value.trim().replace(/^v\s*/i, "");
  const desc = descEl.value.trim();

  if (!version || !desc) {
    upShowBanner("warning", "Wprowadź numer wersji oraz treść zmiany przed zapisaniem.");
    return;
  }

  const btn = document.getElementById("up-add-btn");
  upBusy = true;
  if (btn) btn.disabled = true;

  try {
    // Kolejny sort_order na podstawie dotychczasowego maksimum
    const { data: maxRows, error: maxErr } = await supabaseClient
      .from(UP_TABLE)
      .select("sort_order")
      .not("sort_order", "is", null)
      .order("sort_order", { ascending: false })
      .limit(1);
    if (maxErr) throw maxErr;
    const nextOrder = maxRows && maxRows.length ? (Number(maxRows[0].sort_order) || 0) + 1 : 1;

    const { error } = await supabaseClient.from(UP_TABLE).insert({
      version,
      name_change: desc,
      add_data: upToday(),
      progress: false,
      date: null,
      sort_order: nextOrder
    });
    if (error) throw error;

    logAction("Dodanie wpisu aktualizacji", `v${version}: ${desc}`);
    descEl.value = "";
    await upLoad();
    descEl.focus();
  } catch (err) {
    console.error("Błąd dodawania wpisu:", err);
    upShowBanner("warning", "Nie udało się dodać wpisu: " + (err.message || err));
  } finally {
    upBusy = false;
    if (btn) btn.disabled = false;
  }
}

async function upToggle(id, checkbox) {
  const done = checkbox.checked;
  checkbox.disabled = true;

  const { error } = await supabaseClient
    .from(UP_TABLE)
    .update({ progress: done, date: done ? upToday() : null })
    .eq("id", id);

  if (error) {
    console.error("Błąd zmiany statusu wpisu:", error);
    upShowBanner("warning", "Nie udało się zaktualizować statusu: " + error.message);
  }
  await upLoad();
}

// Zamienia sort_order z sąsiednim wpisem tej samej wersji (dir: -1 w górę, 1 w dół)
async function upMove(id, dir) {
  if (upBusy) return;
  const group = upGroups().map(g => g[1]).find(items => items.some(i => Number(i.id) === Number(id)));
  if (!group) return;
  const idx = group.findIndex(i => Number(i.id) === Number(id));
  const current = group[idx];
  const target = group[idx + dir];
  if (!target) return;

  let currentOrder = current.sort_order ?? 0;
  const targetOrder = target.sort_order ?? 0;
  // identyczny sort_order — rozsuń, żeby zamiana coś zmieniła
  if (currentOrder === targetOrder) currentOrder = targetOrder + dir * -1;

  upBusy = true;
  try {
    const r1 = await supabaseClient.from(UP_TABLE).update({ sort_order: targetOrder }).eq("id", current.id);
    if (r1.error) throw r1.error;
    const r2 = await supabaseClient.from(UP_TABLE).update({ sort_order: currentOrder }).eq("id", target.id);
    if (r2.error) throw r2.error;
  } catch (err) {
    console.error("Błąd zmiany kolejności:", err);
    upShowBanner("warning", "Nie udało się zmienić kolejności wpisów: " + (err.message || err));
  } finally {
    upBusy = false;
  }
  await upLoad();
}

// ---------- Usuwanie (okno potwierdzenia z odliczaniem 3 s) ----------
function upOpenDelete(id) {
  const item = upFindItem(id);
  if (!item) return;
  upDeleteId = item.id;

  document.getElementById("up-delete-target").innerText = item.name_change || `ID: ${item.id}`;

  const confirmBtn = document.getElementById("up-btn-confirm-delete");

  if (upDeleteTimer) {
    clearInterval(upDeleteTimer);
    upDeleteTimer = null;
  }

  let secondsLeft = 3;
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerText = `Tak (${secondsLeft}s)`;

    upDeleteTimer = setInterval(() => {
      secondsLeft--;
      if (secondsLeft > 0) {
        confirmBtn.innerText = `Tak (${secondsLeft}s)`;
      } else {
        clearInterval(upDeleteTimer);
        upDeleteTimer = null;
        confirmBtn.disabled = false;
        confirmBtn.innerText = "Tak";
      }
    }, 1000);
  }

  toggleModal("modal-up-delete-confirm", true);
}

function upCloseDelete() {
  upDeleteId = null;
  if (upDeleteTimer) {
    clearInterval(upDeleteTimer);
    upDeleteTimer = null;
  }
  toggleModal("modal-up-delete-confirm", false);
}

async function upConfirmDelete() {
  if (upDeleteId === null || upBusy) return;
  const id = upDeleteId;

  const confirmBtn = document.getElementById("up-btn-confirm-delete");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerText = "Usuwanie...";
  }

  upBusy = true;
  const { data, error } = await supabaseClient.from(UP_TABLE).delete().eq("id", id).select("id");
  upBusy = false;

  upCloseDelete();

  if (error) {
    console.error("Błąd usuwania wpisu:", error);
    upShowBanner("warning", "Nie udało się usunąć wpisu: " + error.message);
  } else if (!data || data.length === 0) {
    upShowBanner("warning", "Wpis nie został usunięty (brak uprawnień w bazie lub został już usunięty).");
  } else {
    logAction("Usunięcie wpisu aktualizacji", `id ${id}`);
  }
  await upLoad();
}
