// ==========================================
// MODUŁ: ZGŁOSZENIA NIEOBECNOŚCI
// Tabela absence_requests (sql/27_zgloszenia_nieobecnosci.sql).
//  * Portal pracownika: "Zgłoś nieobecność" + lista "Moje zgłoszenia" (anulowanie oczekujących).
//  * Mistrz (rola "Mistrz") widzi zgłoszenia pracowników swojego działu i je akceptuje/odrzuca
//    (widok "absences"); administrator - wszystkie. Akceptacja wpisuje dni do harmonogramu.
//  * Dymek z liczbą oczekujących zgłoszeń przy nazwisku w menu, przy pozycji menu i na przycisku menu (telefon).
// Wymaga: supabaseClient, toggleModal, logAction, currentUser, isAdminRoleName (app.js),
//         rtEsc (report_time.js), epEmployee / epLoadSchedule (employee_portal.js)
// ==========================================

const AB_REASONS = {
  urlop: "Urlop",
  urlop_na_zadanie: "Urlop na żądanie",
  l4: "L4 (zwolnienie lekarskie)",
  opieka: "Opieka",
  inny: "Inny"
};
const AB_STATUS = {
  pending: { label: "Oczekuje", cls: "pending", icon: "fa-hourglass-half" },
  approved: { label: "Zaakceptowane", cls: "approved", icon: "fa-circle-check" },
  rejected: { label: "Odrzucone", cls: "rejected", icon: "fa-circle-xmark" },
  cancelled: { label: "Anulowane", cls: "cancelled", icon: "fa-ban" }
};
const AB_POLL_MS = 60000;    // odświeżanie licznika zgłoszeń
const AB_HISTORY_DAYS = 90;  // ile dni wstecz pokazywać rozpatrzone

let abPollTimer = null;
let abBusy = false;
let abTab = "pending";       // widok mistrza: "pending" | "done"
let abRows = [];
let abDecide = null;         // { id, approve } w oknie decyzji
let abCancelArmed = null;    // id zgłoszenia, którego anulowanie czeka na potwierdzenie

// ---------- Pomocnicze ----------
function abIso(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function abPl(iso) {
  const [y, m, d] = String(iso || "").split("-");
  return y ? `${d}.${m}.${y}` : "-";
}

function abDays(from, to) {
  return Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
}

// Termin zgłoszenia: daty + zakres (cały dzień, zmiana albo godziny)
function abRange(r) {
  const n = abDays(r.date_from, r.date_to);
  const dates = r.date_from === r.date_to
    ? `${abPl(r.date_from)} (1 dzień)`
    : `${abPl(r.date_from)} – ${abPl(r.date_to)} (${n} dni)`;
  return `${dates} • ${abSpanText(r.time_from, r.time_to)}`;
}

function abSpanText(from, to) {
  if (!from || !to) return "cały dzień";
  const preset = SH_PRESETS.find(p => p.from === from && p.to === to);
  return preset ? `zmiana ${preset.label} (${from}–${to})` : `godz. ${from}–${to}`;
}

// ---------- Zakres w oknie zgłoszenia: cały dzień / zmiana I, II, III / własne godziny ----------
let abSpan = { mode: "day", from: "", to: "" };

function abSetSpan(mode) {
  const preset = SH_PRESETS.find(p => p.label === mode);
  if (mode === "day") abSpan = { mode, from: "", to: "" };
  else if (preset) abSpan = { mode, from: preset.from, to: preset.to };
  else abSpan = { mode: "hours", from: abSpan.mode === "hours" ? abSpan.from : "", to: abSpan.mode === "hours" ? abSpan.to : "" };

  document.querySelectorAll("#ab-span button").forEach(b => {
    const on = b.dataset.span === abSpan.mode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
  document.getElementById("ab-hours").style.display = abSpan.mode === "hours" ? "" : "none";
  ["from", "to"].forEach(w => {
    const btn = document.getElementById(`ab-time-${w}`);
    const v = abSpan[w];
    btn.dataset.value = v;
    btn.textContent = v || "--:--";
    btn.classList.toggle("empty", !v);
  });
  const info = document.getElementById("ab-span-info");
  if (info) {
    info.textContent = abSpan.mode === "day" ? "Nieobecność przez cały dzień."
      : abSpan.mode === "hours" ? (abSpan.from && abSpan.to ? `Nieobecność w godz. ${abSpan.from}–${abSpan.to}.` : "Wybierz godziny od i do.")
      : `Nieobecność na zmianie ${abSpan.mode}: ${abSpan.from}–${abSpan.to}.`;
  }
}

// Własne godziny: okienko z kafelkami (jak w Rozliczeniu czasu)
function abOpenSpanTime(which) {
  const other = abSpan[which === "from" ? "to" : "from"];
  const filter = t => t !== other;
  rtPickerOpen(document.getElementById(`ab-time-${which}`), {
    key: `ab|${which}`,
    label: which === "from" ? "Od" : "Do",
    name: "nieobecność",
    top: RT_TOP_TIMES.filter(filter),
    rest: RT_OTHER_TIMES.filter(filter),
    value: abSpan[which],
    onPick: value => {
      abSpan[which] = value || "";
      abSetSpan("hours");
      if (which === "from" && value && !abSpan.to) abOpenSpanTime("to");
      else document.getElementById(`ab-time-${which}`)?.focus();
    }
  });
}

function abReason(r) {
  return AB_REASONS[r.reason] || r.reason;
}

function abStatusHtml(status) {
  const s = AB_STATUS[status] || { label: status, cls: "", icon: "fa-circle" };
  return `<span class="ab-status ${s.cls}"><i class="fa-solid ${s.icon}"></i> ${s.label}</span>`;
}

// =====================================================
// 1. PORTAL PRACOWNIKA
// =====================================================
async function abPortalLoad() {
  const el = document.getElementById("ep-abs-list");
  if (!el || !epEmployee) return;
  const empId = epEmployee.id;

  const since = new Date();
  since.setDate(since.getDate() - AB_HISTORY_DAYS);
  const { data, error } = await supabaseClient
    .from("absence_requests")
    .select("id, date_from, date_to, time_from, time_to, reason, description, status, created_at, decided_at, decision_note")
    .eq("employee_id", empId)
    .or(`status.eq.pending,date_to.gte.${abIso(since)}`)
    .order("date_from", { ascending: false })
    .limit(20);
  if (!epEmployee || epEmployee.id !== empId) return;

  if (error) {
    console.warn("Zgłoszenia nieobecności: błąd pobierania:", error.message);
    el.innerHTML = `<div class="ep-abs-empty">Nie udało się pobrać zgłoszeń.</div>`;
    return;
  }
  const rows = data || [];
  const item = r => `
        <div class="ep-abs-item ${AB_STATUS[r.status]?.cls || ""}">
          <div class="main">
            <div class="when">${rtEsc(abRange(r))}</div>
            <div class="why">${rtEsc(abReason(r))}${r.description ? ` — ${rtEsc(r.description)}` : ""}</div>
            ${r.decision_note ? `<div class="note"><i class="fa-solid fa-comment"></i> ${rtEsc(r.decision_note)}</div>` : ""}
          </div>
          <div class="side">
            ${abStatusHtml(r.status)}
            ${r.status === "pending"
              ? `<button type="button" class="ep-abs-cancel${abCancelArmed === r.id ? " armed" : ""}" onclick="abPortalCancel(${Number(r.id)})">
                   ${abCancelArmed === r.id ? "Na pewno anulować?" : "Anuluj"}</button>`
              : ""}
          </div>
        </div>`;

  // Oczekujące widać zawsze; rozpatrzone (i anulowane) są zwinięte pod przyciskiem
  const pending = rows.filter(r => r.status === "pending");
  const done = rows.filter(r => r.status !== "pending");
  el.innerHTML =
    (pending.length
      ? pending.map(item).join("")
      : `<div class="ep-abs-empty">Nie masz zgłoszeń czekających na rozpatrzenie.</div>`) +
    (done.length
      ? `<button type="button" id="ep-abs-more" class="ep-abs-more${abShowDone ? " open" : ""}" onclick="abToggleDone()"
           aria-expanded="${abShowDone}" aria-controls="ep-abs-done">
           <span class="txt">${abShowDone ? "Ukryj" : "Pokaż"} rozpatrzone</span><span class="cnt">${done.length}</span><i class="fa-solid fa-chevron-down"></i>
         </button>
         <div class="ep-abs-done${abShowDone ? " open" : ""}" id="ep-abs-done"><div class="in">${done.map(item).join("")}</div></div>`
      : "");
}

let abShowDone = false;      // portal: rozwinięta lista rozpatrzonych zgłoszeń

// Rozwija / zwija listę z animacją (bez przebudowy listy)
function abToggleDone() {
  abShowDone = !abShowDone;
  const btn = document.getElementById("ep-abs-more");
  const box = document.getElementById("ep-abs-done");
  if (!btn || !box) return abPortalLoad();
  btn.classList.toggle("open", abShowDone);
  btn.setAttribute("aria-expanded", String(abShowDone));
  btn.querySelector(".txt").textContent = `${abShowDone ? "Ukryj" : "Pokaż"} rozpatrzone`;
  box.classList.toggle("open", abShowDone);
}

async function abPortalCancel(id) {
  if (abBusy) return;
  if (abCancelArmed !== id) {
    abCancelArmed = id;
    abPortalLoad();
    return;
  }
  abBusy = true;
  const { error } = await supabaseClient.rpc("app_absence_cancel", { p_id: id });
  abBusy = false;
  abCancelArmed = null;
  if (error) {
    alert("Nie udało się anulować zgłoszenia: " + error.message);
  } else {
    logAction("Anulowanie zgłoszenia nieobecności", `id ${id}`);
  }
  abPortalLoad();
}

function abMsg(id, text, ok) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || "";
  el.style.display = text ? "block" : "none";
  el.style.color = ok ? "#0b7a57" : "var(--danger)";
}

async function abOpenRequest() {
  if (!epEmployee) return;
  const today = abIso(new Date());
  document.getElementById("ab-from").value = today;
  document.getElementById("ab-to").value = today;
  document.getElementById("ab-reason").value = "urlop";
  document.getElementById("ab-desc").value = "";
  abMsg("ab-req-msg", "");
  abSyncDays();
  abSetSpan("day");
  toggleModal("modal-ab-request", true);

  // kto rozpatrzy zgłoszenie: mistrzowie działu pracownika
  const who = document.getElementById("ab-approvers");
  const dept = epEmployee.department?.department;
  who.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Sprawdzanie mistrzów działu...`;
  const { data, error } = await supabaseClient.rpc("app_absence_approvers");
  if (error) {
    who.innerHTML = `<i class="fa-solid fa-user-tie"></i> Zgłoszenie trafi do mistrza działu ${rtEsc(dept || "")}.`;
    return;
  }
  const names = (data || []).map(r => r.name).filter(Boolean);
  who.className = `ab-approvers${names.length ? "" : " warn"}`;
  who.innerHTML = names.length
    ? `<i class="fa-solid fa-user-tie"></i><div>Zgłoszenie zaakceptuje mistrz działu <b>${rtEsc(dept || "-")}</b>:<ul class="ab-approver-list">${names.map(n => `<li>${rtEsc(n)}</li>`).join("")}</ul></div>`
    : `<i class="fa-solid fa-triangle-exclamation"></i><div>${dept ? `Dział <b>${rtEsc(dept)}</b> nie ma przypisanego mistrza` : "Nie masz przypisanego działu"} — zgłoszenie rozpatrzy administrator.</div>`;
}

function abCloseRequest() {
  toggleModal("modal-ab-request", false);
}

// Szybkie zakresy: dziś, jutro, do końca tygodnia (piątku)
function abQuick(kind) {
  const d = new Date();
  let from = new Date(d), to = new Date(d);
  if (kind === "tomorrow") {
    from.setDate(d.getDate() + 1);
    to = new Date(from);
  } else if (kind === "week") {
    const toFriday = (5 - d.getDay() + 7) % 7;
    to.setDate(d.getDate() + toFriday);
  }
  document.getElementById("ab-from").value = abIso(from);
  document.getElementById("ab-to").value = abIso(to);
  abSyncDays();
}

function abSyncDays() {
  const fromEl = document.getElementById("ab-from");
  const toEl = document.getElementById("ab-to");
  if (toEl.value && fromEl.value && toEl.value < fromEl.value) toEl.value = fromEl.value;
  toEl.min = fromEl.value || "";
  const info = document.getElementById("ab-days");
  if (info) {
    const n = fromEl.value && toEl.value ? abDays(fromEl.value, toEl.value) : 0;
    info.textContent = n ? `Liczba dni: ${n}` : "";
  }
}

async function abSubmitRequest() {
  if (abBusy || !epEmployee) return;
  const from = document.getElementById("ab-from").value;
  const to = document.getElementById("ab-to").value;
  const reason = document.getElementById("ab-reason").value;
  const desc = document.getElementById("ab-desc").value.trim();

  if (!from || !to) return abMsg("ab-req-msg", "Podaj daty od i do.");
  if (to < from) return abMsg("ab-req-msg", "Data „do” nie może być wcześniejsza niż „od”.");
  if (abDays(from, to) > 61) return abMsg("ab-req-msg", "Jedno zgłoszenie może obejmować najwyżej 61 dni.");
  if (reason === "inny" && !desc) return abMsg("ab-req-msg", "Przy powodzie „Inny” opisz krótko przyczynę.");
  if (abSpan.mode !== "day" && (!abSpan.from || !abSpan.to)) return abMsg("ab-req-msg", "Wybierz godziny od i do.");
  if (abSpan.mode !== "day" && abSpan.from === abSpan.to) return abMsg("ab-req-msg", "Godziny od i do muszą się różnić.");

  const btn = document.getElementById("ab-submit");
  abBusy = true;
  btn.disabled = true;
  abMsg("ab-req-msg", "");
  try {
    const { error } = await supabaseClient.from("absence_requests").insert({
      employee_id: epEmployee.id,
      date_from: from,
      date_to: to,
      reason,
      description: desc || null,
      time_from: abSpan.mode === "day" ? null : abSpan.from,
      time_to: abSpan.mode === "day" ? null : abSpan.to
    });
    if (error) throw error;
    logAction("Zgłoszenie nieobecności", `${abPl(from)}–${abPl(to)}, ${abSpanText(abSpan.from, abSpan.to)}, ${AB_REASONS[reason]}`);
    abCloseRequest();
    abPortalLoad();
  } catch (err) {
    console.error("Błąd zgłoszenia nieobecności:", err);
    abMsg("ab-req-msg", "Nie udało się wysłać zgłoszenia: " + (err.message || err));
  } finally {
    abBusy = false;
    btn.disabled = false;
  }
}

// =====================================================
// 2. MISTRZ: LICZNIK W MENU
// =====================================================
function abCanReview() {
  if (!currentUser) return false;
  const role = String(currentUser.role?.role || "").trim().toLowerCase();
  return role === "mistrz" || isAdminRoleName(currentUser.role?.role);
}

function abSetBadge(count) {
  const n = Number(count) || 0;
  const text = n > 99 ? "99+" : String(n);
  const bell = document.getElementById("ab-bell");
  if (bell) {
    bell.style.display = abCanReview() ? "" : "none";
    bell.classList.toggle("has", n > 0);
    bell.title = n ? `Zgłoszenia nieobecności do rozpatrzenia: ${n}` : "Zgłoszenia nieobecności";
  }
  document.querySelectorAll(".ab-badge").forEach(b => {
    b.textContent = text;
    b.style.display = n > 0 ? "" : "none";
  });
  document.getElementById("topbar-menu-btn")?.classList.toggle("ab-dot", n > 0);
}

async function abRefreshBadge() {
  if (!abCanReview()) {
    abSetBadge(0);
    return;
  }
  const { count, error } = await supabaseClient
    .from("absence_requests")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  if (error) {
    console.warn("Zgłoszenia nieobecności: licznik niedostępny:", error.message);
    abSetBadge(0);
    return;
  }
  abSetBadge(count);
}

// Start po zalogowaniu użytkownika; zatrzymuje się sam po wylogowaniu
function abStartBadge() {
  clearInterval(abPollTimer);
  const nav = document.getElementById("nav-absences");
  if (nav) nav.style.display = abCanReview() ? "block" : "none";
  if (!abCanReview()) {
    abSetBadge(0);
    return;
  }
  abRefreshBadge();
  abPollTimer = setInterval(() => {
    if (!currentUser) {
      clearInterval(abPollTimer);
      abSetBadge(0);
      return;
    }
    if (!document.hidden) abRefreshBadge();
  }, AB_POLL_MS);
}

// =====================================================
// 3. MISTRZ: WIDOK "ZGŁOSZENIA NIEOBECNOŚCI"
// =====================================================
async function initAbsencesView() {
  abTab = "pending";
  const hint = document.getElementById("ab-hint");
  if (hint) {
    const admin = isAdminRoleName(currentUser?.role?.role);
    const dept = currentUser?.department?.department;
    hint.innerHTML = admin
      ? `<i class="fa-solid fa-user-shield"></i> Jako administrator widzisz zgłoszenia ze wszystkich działów.`
      : dept
        ? `<i class="fa-solid fa-user-tie"></i> Widzisz zgłoszenia pracowników działu <b>${rtEsc(dept)}</b>.`
        : `<i class="fa-solid fa-triangle-exclamation"></i> Twoje konto nie ma przypisanego działu, więc nie zobaczysz żadnych zgłoszeń. Poproś administratora o przypisanie działu.`;
  }
  if (typeof pushRefreshButtons === "function") pushRefreshButtons();
  await abLoad();
}

function abSetTab(tab) {
  abTab = tab;
  document.querySelectorAll(".ab-tab").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  abLoad();
}

async function abLoad() {
  const tbody = document.getElementById("ab-body");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" class="ab-empty"><i class="fa-solid fa-spinner fa-spin"></i> Ładowanie zgłoszeń...</td></tr>`;

  const since = new Date();
  since.setDate(since.getDate() - AB_HISTORY_DAYS);
  let q = supabaseClient
    .from("absence_requests")
    .select(`id, employee_id, department_id, date_from, date_to, time_from, time_to, reason, description, status, created_at, decided_at, decision_note, decided_by,
      employee:employee_id ( first_name, last_name ),
      department:department_id ( department ),
      decider:decided_by ( name, last_name )`);
  q = abTab === "pending"
    ? q.eq("status", "pending").order("date_from", { ascending: true })
    : q.neq("status", "pending").gte("created_at", since.toISOString()).order("created_at", { ascending: false }).limit(300);

  const { data, error } = await q;
  if (error) {
    console.error("Błąd pobierania zgłoszeń nieobecności:", error);
    tbody.innerHTML = `<tr><td colspan="7" class="ab-empty" style="color: var(--danger);">
      Nie udało się pobrać zgłoszeń: ${rtEsc(error.message)}. Jeśli to pierwsze użycie, administrator musi uruchomić sql/27_zgloszenia_nieobecnosci.sql.</td></tr>`;
    return;
  }
  abRows = data || [];
  if (abTab === "pending") abSetBadge(abRows.length);
  abRender();
}

function abRender() {
  const tbody = document.getElementById("ab-body");
  const head = document.getElementById("ab-head-action");
  if (!tbody) return;
  if (head) head.textContent = abTab === "pending" ? "" : "Rozpatrzył";

  if (!abRows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="ab-empty">${abTab === "pending"
      ? "Brak zgłoszeń do rozpatrzenia."
      : `Brak rozpatrzonych zgłoszeń z ostatnich ${AB_HISTORY_DAYS} dni.`}</td></tr>`;
    return;
  }

  tbody.innerHTML = abRows.map(r => {
    const name = r.employee ? `${r.employee.first_name || ""} ${r.employee.last_name || ""}`.trim() : `Pracownik #${r.employee_id}`;
    const created = r.created_at ? new Date(r.created_at).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" }) : "-";
    const decider = r.decider ? `${r.decider.name || ""} ${r.decider.last_name || ""}`.trim() : "";
    const decided = r.decided_at ? new Date(r.decided_at).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" }) : "";
    const id = Number(r.id);
    return `
      <tr>
        <td class="ab-name">${rtEsc(name)}</td>
        <td>${rtEsc(r.department?.department || "-")}</td>
        <td class="ab-when">${rtEsc(abRange(r))}</td>
        <td>${rtEsc(abReason(r))}${r.description ? `<div class="ab-desc">${rtEsc(r.description)}</div>` : ""}</td>
        <td class="ab-muted">${rtEsc(created)}</td>
        <td>${abStatusHtml(r.status)}${r.decision_note ? `<div class="ab-desc"><i class="fa-solid fa-comment"></i> ${rtEsc(r.decision_note)}</div>` : ""}</td>
        <td class="ab-actions">${r.status === "pending"
          ? `<button type="button" class="ab-btn ok" onclick="abOpenDecide(${id}, true)"><i class="fa-solid fa-check"></i> Akceptuj</button>
             <button type="button" class="ab-btn no" onclick="abOpenDecide(${id}, false)"><i class="fa-solid fa-xmark"></i> Odrzuć</button>`
          : `<span class="ab-muted">${rtEsc(decider || (r.status === "cancelled" ? "pracownik" : "-"))}${decided ? `<br>${rtEsc(decided)}` : ""}</span>`}</td>
      </tr>`;
  }).join("");
}

function abOpenDecide(id, approve) {
  const r = abRows.find(x => Number(x.id) === Number(id));
  if (!r) return;
  abDecide = { id, approve };
  const name = r.employee ? `${r.employee.first_name || ""} ${r.employee.last_name || ""}`.trim() : `Pracownik #${r.employee_id}`;
  document.getElementById("ab-dec-title").textContent = approve ? "Akceptacja nieobecności" : "Odrzucenie zgłoszenia";
  document.getElementById("ab-dec-summary").innerHTML =
    `<b>${rtEsc(name)}</b><br>${rtEsc(abRange(r))}<br>${rtEsc(abReason(r))}${r.description ? ` — ${rtEsc(r.description)}` : ""}`;
  document.getElementById("ab-dec-info").textContent = approve
    ? "Po akceptacji te dni zostaną wpisane do harmonogramu jako zgłoszona nieobecność."
    : "Pracownik zobaczy w portalu, że zgłoszenie zostało odrzucone, razem z komentarzem.";
  const note = document.getElementById("ab-dec-note");
  note.value = "";
  note.placeholder = approve ? "Komentarz (opcjonalnie)" : "Powód odrzucenia (zalecany)";
  const btn = document.getElementById("ab-dec-confirm");
  btn.className = approve ? "btn-primary" : "btn-danger";
  btn.innerHTML = approve ? `<i class="fa-solid fa-check"></i> Akceptuj` : `<i class="fa-solid fa-xmark"></i> Odrzuć`;
  abMsg("ab-dec-msg", "");
  toggleModal("modal-ab-decide", true);
  note.focus();
}

function abCloseDecide() {
  abDecide = null;
  toggleModal("modal-ab-decide", false);
}

async function abConfirmDecide() {
  if (!abDecide || abBusy) return;
  const { id, approve } = abDecide;
  const r = abRows.find(x => Number(x.id) === Number(id));
  const note = document.getElementById("ab-dec-note").value.trim().slice(0, 200);
  const btn = document.getElementById("ab-dec-confirm");
  abBusy = true;
  btn.disabled = true;
  try {
    const { error } = await supabaseClient.rpc("app_absence_decide", { p_id: id, p_approve: approve, p_note: note || null });
    if (error) throw error;
    const name = r && r.employee ? `${r.employee.first_name || ""} ${r.employee.last_name || ""}`.trim() : `id ${id}`;
    logAction(approve ? "Akceptacja nieobecności" : "Odrzucenie nieobecności",
      `${name}${r ? ", " + abRange(r) + ", " + abReason(r) : ""}${note ? " — " + note : ""}`);
    abCloseDecide();
    await abLoad();
    abRefreshBadge();
  } catch (err) {
    console.error("Błąd rozpatrzenia zgłoszenia:", err);
    abMsg("ab-dec-msg", "Nie udało się zapisać decyzji: " + (err.message || err));
  } finally {
    abBusy = false;
    btn.disabled = false;
  }
}
