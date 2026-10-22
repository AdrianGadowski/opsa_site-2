// ==========================================
// MODUŁ: KOMUNIKATY (sql/33_komunikaty.sql)
//  1. Odbiorca (użytkownik albo pracownik w portalu): nieprzeczytane aktywne komunikaty wyskakują
//     w oknie po zalogowaniu i w trakcie pracy (sprawdzanie co minutę); koperta z liczbą otwiera skrzynkę.
//  2. Autor (uprawnienie "Komunikaty"): widok "messages" - tworzenie, edycja, zakończenie, usuwanie
//     i potwierdzenia odczytu (kto przeczytał, kto nie).
// Treść: proste formatowanie - **pogrubienie**, *kursywa*, "- " lista, [tekst](https://adres), adresy https.
// Wymaga: supabaseClient, toggleModal, logAction, currentUser, hasPermission (app.js), rtEsc (report_time.js),
//         rpFetchAll (reports.js), epEmployee (employee_portal.js)
// ==========================================

const MSG_PRIORITY = {
  info: { label: "Informacja", icon: "fa-circle-info" },
  important: { label: "Ważne", icon: "fa-triangle-exclamation" },
  urgent: { label: "Pilne", icon: "fa-bell" }
};
const MSG_POLL_MS = 60000;

// ---------- Formatowanie treści (bezpieczne: najpierw zamiana znaków HTML) ----------
function msgInline(text) {
  return rtEsc(text)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
}

function msgFormat(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  let html = "", list = false;
  lines.forEach(line => {
    const item = line.match(/^\s*[-•]\s+(.*)$/);
    if (item) {
      if (!list) { html += "<ul>"; list = true; }
      html += `<li>${msgInline(item[1])}</li>`;
      return;
    }
    if (list) { html += "</ul>"; list = false; }
    html += line.trim() ? `<p>${msgInline(line)}</p>` : "";
  });
  if (list) html += "</ul>";
  return html || `<p class="msg-muted">(brak treści)</p>`;
}

function msgDate(ts) {
  return ts ? new Date(ts).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" }) : "-";
}

// =====================================================
// 1. ODBIORCA: wyskakujące okno i skrzynka
// =====================================================
let msgList = [];            // komunikaty zalogowanej osoby (app_my_announcements)
let msgQueue = [];           // nieprzeczytane aktywne - do pokazania w oknie
let msgPollTimer = null;
let msgPopupBusy = false;
let msgAvailable = false;    // czy baza ma moduł (sql/33)

function msgLoggedIn() {
  return (typeof currentUser !== "undefined" && !!currentUser) || (typeof epEmployee !== "undefined" && !!epEmployee);
}

// Start po zalogowaniu (użytkownik albo pracownik); zatrzymuje się sam po wylogowaniu
function msgStart() {
  clearInterval(msgPollTimer);
  msgQueue = [];
  msgFetch(true);
  msgPollTimer = setInterval(() => {
    if (!msgLoggedIn()) {
      clearInterval(msgPollTimer);
      msgSetBadges(0, false);
      return;
    }
    if (!document.hidden) msgFetch(true);
  }, MSG_POLL_MS);
}

async function msgFetch(showPopup) {
  if (!msgLoggedIn()) return;
  const { data, error } = await supabaseClient.rpc("app_my_announcements");
  if (error) {
    msgAvailable = false;
    msgSetBadges(0, false);
    console.warn("Komunikaty niedostępne:", error.message);
    return;
  }
  msgAvailable = true;
  msgList = data || [];
  const unread = msgList.filter(m => m.active && !m.read_at);
  msgSetBadges(unread.length, true);

  if (showPopup) {
    unread
      .slice()
      .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))
      .forEach(m => { if (!msgQueue.some(q => q.id === m.id)) msgQueue.push(m); });
    if (msgQueue.length && !document.getElementById("modal-msg-popup")?.classList.contains("active")) msgShowNext();
  }
}

function msgSetBadges(count, visible) {
  document.querySelectorAll("[data-msg-env]").forEach(btn => {
    btn.style.display = visible ? "" : "none";
    btn.classList.toggle("has", count > 0);
    btn.title = count ? `Komunikaty: ${count} nieprzeczytane` : "Komunikaty";
  });
  document.querySelectorAll(".msg-badge").forEach(b => {
    b.textContent = count > 99 ? "99+" : String(count);
    b.style.display = count > 0 ? "" : "none";
  });
}

// Okno z komunikatem: pilne i wymagające potwierdzenia zamyka tylko "Przeczytałem"
function msgShowNext() {
  const m = msgQueue[0];
  if (!m) {
    toggleModal("modal-msg-popup", false);
    return;
  }
  const p = MSG_PRIORITY[m.priority] || MSG_PRIORITY.info;
  const ack = m.require_ack || m.priority === "urgent";
  const box = document.getElementById("msg-popup-box");
  box.className = `modal-box msg-popup ${m.priority}`;
  document.getElementById("msg-popup-prio").innerHTML = `<i class="fa-solid ${p.icon}"></i> ${p.label}`;
  document.getElementById("msg-popup-count").textContent = msgQueue.length > 1 ? `1 z ${msgQueue.length}` : "";
  document.getElementById("msg-popup-title").textContent = m.title;
  document.getElementById("msg-popup-meta").textContent =
    `${m.author ? m.author + " • " : ""}${msgDate(m.starts_at)}${m.updated_at ? " • zmieniono " + msgDate(m.updated_at) : ""}`;
  document.getElementById("msg-popup-body").innerHTML = msgFormat(m.body);
  const btn = document.getElementById("msg-popup-ok");
  // zawsze "Przeczytałem" (przy kilku komunikatach: "Przeczytałem — dalej")
  btn.innerHTML = `<i class="fa-solid fa-check"></i> Przeczytałem${msgQueue.length > 1 ? " — dalej" : ""}`;
  document.getElementById("msg-popup-later").style.display = ack ? "none" : "";
  toggleModal("modal-msg-popup", true);
  btn.focus();
}

// "Przeczytałem" / "Zamknij" / "Dalej": zapis odczytu i następny komunikat
async function msgPopupOk() {
  if (msgPopupBusy) return;
  const m = msgQueue[0];
  if (!m) return msgShowNext();
  msgPopupBusy = true;
  const ack = m.require_ack || m.priority === "urgent";
  const { error } = await supabaseClient.rpc("app_announcement_read", { p_id: m.id, p_ack: ack });
  msgPopupBusy = false;
  if (error) {
    alert("Nie udało się zapisać odczytu: " + error.message);
    return;
  }
  msgQueue.shift();
  const item = msgList.find(x => x.id === m.id);
  if (item) { item.read_at = new Date().toISOString(); item.acked = item.acked || ack; }
  msgSetBadges(msgList.filter(x => x.active && !x.read_at).length, true);
  msgShowNext();
}

// "Później": zamyka okno bez oznaczania (zwykłe komunikaty); wróci przy następnym sprawdzeniu
function msgPopupLater() {
  msgQueue = [];
  toggleModal("modal-msg-popup", false);
}

// ---------- Skrzynka "Moje komunikaty" ----------
async function msgOpenInbox() {
  toggleModal("modal-msg-inbox", true);
  const el = document.getElementById("msg-inbox-list");
  el.innerHTML = `<div class="msg-empty"><i class="fa-solid fa-spinner fa-spin"></i> Ładowanie...</div>`;
  await msgFetch(false);
  msgRenderInbox();
}

function msgCloseInbox() {
  toggleModal("modal-msg-inbox", false);
}

function msgRenderInbox() {
  const el = document.getElementById("msg-inbox-list");
  if (!el) return;
  if (!msgAvailable) {
    el.innerHTML = `<div class="msg-empty">Komunikaty są niedostępne.</div>`;
    return;
  }
  if (!msgList.length) {
    el.innerHTML = `<div class="msg-empty">Nie masz komunikatów z ostatnich 60 dni.</div>`;
    return;
  }
  el.innerHTML = msgList.map(m => {
    const p = MSG_PRIORITY[m.priority] || MSG_PRIORITY.info;
    const unread = !m.read_at;
    return `
      <details class="msg-item ${m.priority}${unread ? " unread" : ""}${m.active ? "" : " ended"}" ontoggle="msgInboxToggle(this, ${Number(m.id)})">
        <summary>
          <span class="dot"><i class="fa-solid ${p.icon}"></i></span>
          <span class="t">${rtEsc(m.title)}</span>
          <span class="d">${rtEsc(msgDate(m.starts_at))}${m.active ? "" : " • zakończony"}</span>
          ${unread ? `<span class="new">nowy</span>` : ""}
        </summary>
        <div class="msg-body">${msgFormat(m.body)}</div>
        <div class="msg-foot">${m.author ? "Od: " + rtEsc(m.author) + " • " : ""}${m.read_at ? "Przeczytano " + rtEsc(msgDate(m.read_at)) : "Nieprzeczytany"}${m.acked ? " • potwierdzono" : ""}</div>
      </details>`;
  }).join("");
}

// Rozwinięcie nieprzeczytanego komunikatu w skrzynce oznacza go jako przeczytany
async function msgInboxToggle(el, id) {
  if (!el.open) return;
  const m = msgList.find(x => Number(x.id) === Number(id));
  if (!m || m.read_at) return;
  const ack = m.require_ack || m.priority === "urgent";
  const { error } = await supabaseClient.rpc("app_announcement_read", { p_id: m.id, p_ack: ack });
  if (error) return;
  m.read_at = new Date().toISOString();
  m.acked = m.acked || ack;
  msgQueue = msgQueue.filter(q => q.id !== m.id);
  el.classList.remove("unread");
  el.querySelector(".new")?.remove();
  msgSetBadges(msgList.filter(x => x.active && !x.read_at).length, true);
}

// =====================================================
// 2. AUTOR: widok "Komunikaty"
// =====================================================
let msgDict = { users: [], employees: [], depts: [], roles: [] };
let msgItems = [];           // komunikaty z celami i odczytami
let msgEditId = null;        // edytowany komunikat; null = nowy
let msgT = null;             // wybór odbiorców w oknie
let msgDeleteArmed = null;
let msgSaving = false;
let msgDetailRows = [];
let msgDetailFilter = "all";

function msgEmptyTargets() {
  return { allUsers: false, userDepts: new Set(), userRoles: new Set(), users: new Set(), empDepts: new Set(), emps: new Set() };
}

async function initMessagesView() {
  const tbody = document.getElementById("msg-body");
  try {
    const [users, employees, depts, roles] = await Promise.all([
      rpFetchAll(() => supabaseClient.from("users").select("id, name, last_name, department_id, role_id")),
      rpFetchAll(() => supabaseClient.from("employees").select("id, first_name, last_name, department_id, active").eq("active", true)),
      rpFetchAll(() => supabaseClient.from("department").select("id, department")),
      rpFetchAll(() => supabaseClient.from("role").select("id, role"))
    ]);
    const byName = (a, b) => a.localeCompare(b, "pl", { numeric: true });
    msgDict.users = users
      .map(u => ({ ...u, label: `${u.name || ""} ${u.last_name || ""}`.trim() || `Użytkownik #${u.id}` }))
      .sort((a, b) => byName(a.label, b.label));
    msgDict.employees = employees
      .map(e => ({ ...e, label: `${e.first_name || ""} ${e.last_name || ""}`.trim() || `Pracownik #${e.id}` }))
      .sort((a, b) => byName(a.label, b.label));
    msgDict.depts = depts.map(d => ({ id: d.id, label: d.department || `Dział #${d.id}` })).sort((a, b) => byName(a.label, b.label));
    msgDict.roles = roles.map(r => ({ id: r.id, label: r.role || `Rola #${r.id}` })).sort((a, b) => byName(a.label, b.label));
  } catch (err) {
    console.error("Komunikaty: błąd słowników:", err);
  }
  await msgLoadItems();
}

async function msgLoadItems() {
  const tbody = document.getElementById("msg-body");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="6" class="msg-empty"><i class="fa-solid fa-spinner fa-spin"></i> Ładowanie komunikatów...</td></tr>`;
  try {
    const [items, targets, reads] = await Promise.all([
      rpFetchAll(() => supabaseClient.from("announcements").select("*")),
      rpFetchAll(() => supabaseClient.from("announcement_targets").select("id, announcement_id, kind, ref_id")),
      rpFetchAll(() => supabaseClient.from("announcement_reads").select("id, announcement_id, acked"))
    ]);
    msgItems = items
      .map(a => ({
        ...a,
        targets: targets.filter(t => t.announcement_id === a.id),
        reads: reads.filter(r => r.announcement_id === a.id).length,
        acks: reads.filter(r => r.announcement_id === a.id && r.acked).length
      }))
      .sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));
    msgRenderItems();
  } catch (err) {
    console.error("Komunikaty: błąd pobierania:", err);
    tbody.innerHTML = `<tr><td colspan="6" class="msg-empty" style="color: var(--danger);">
      Nie udało się pobrać komunikatów: ${rtEsc(err.message || err)}. Jeśli to pierwsze użycie, administrator musi uruchomić sql/33_komunikaty.sql.</td></tr>`;
  }
}

// Cele -> zbiór odbiorców (do liczenia i podsumowania)
function msgTargetsFromRows(rows) {
  const t = msgEmptyTargets();
  rows.forEach(r => {
    if (r.kind === "all_users") t.allUsers = true;
    else if (r.kind === "user_dept") t.userDepts.add(Number(r.ref_id));
    else if (r.kind === "user_role") t.userRoles.add(Number(r.ref_id));
    else if (r.kind === "user") t.users.add(Number(r.ref_id));
    else if (r.kind === "emp_dept") t.empDepts.add(Number(r.ref_id));
    else if (r.kind === "employee") t.emps.add(Number(r.ref_id));
  });
  return t;
}

function msgRecipients(t) {
  const users = msgDict.users.filter(u => t.allUsers || t.users.has(Number(u.id)) ||
    t.userDepts.has(Number(u.department_id)) || t.userRoles.has(Number(u.role_id)));
  const emps = msgDict.employees.filter(e => t.emps.has(Number(e.id)) || t.empDepts.has(Number(e.department_id)));
  return { users, emps };
}

function msgTargetsSummary(t) {
  const name = (list, id) => (list.find(x => Number(x.id) === Number(id)) || {}).label || `#${id}`;
  const parts = [];
  if (t.allUsers) parts.push("wszyscy użytkownicy");
  if (t.userDepts.size) parts.push("użytkownicy działu: " + [...t.userDepts].map(id => name(msgDict.depts, id)).join(", "));
  if (t.userRoles.size) parts.push("rola: " + [...t.userRoles].map(id => name(msgDict.roles, id)).join(", "));
  if (t.users.size) parts.push(`wybrani użytkownicy (${t.users.size})`);
  if (t.empDepts.size) parts.push("pracownicy działu: " + [...t.empDepts].map(id => name(msgDict.depts, id)).join(", "));
  if (t.emps.size) parts.push(`wybrani pracownicy (${t.emps.size})`);
  return parts.join(" • ") || "brak odbiorców";
}

function msgStatus(a) {
  const now = Date.now();
  if (a.closed_at || (a.ends_at && new Date(a.ends_at).getTime() <= now)) return { cls: "ended", label: "Zakończony" };
  if (new Date(a.starts_at).getTime() > now) return { cls: "planned", label: "Zaplanowany" };
  return { cls: "active", label: "Aktywny" };
}

function msgRenderItems() {
  const tbody = document.getElementById("msg-body");
  if (!tbody) return;
  if (!msgItems.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="msg-empty">Nie ma jeszcze komunikatów. Utwórz pierwszy przyciskiem „Nowy komunikat”.</td></tr>`;
    return;
  }
  tbody.innerHTML = msgItems.map(a => {
    const t = msgTargetsFromRows(a.targets);
    const rec = msgRecipients(t);
    const total = rec.users.length + rec.emps.length;
    const pct = total ? Math.round((a.reads / total) * 100) : 0;
    const p = MSG_PRIORITY[a.priority] || MSG_PRIORITY.info;
    const st = msgStatus(a);
    const id = Number(a.id);
    return `
      <tr>
        <td class="msg-title-cell"><span class="msg-prio ${a.priority}" title="${p.label}"><i class="fa-solid ${p.icon}"></i></span>
          <div><b>${rtEsc(a.title)}</b><div class="msg-sub">${rtEsc(msgTargetsSummary(t))}</div></div></td>
        <td class="msg-c">${rtEsc(msgDate(a.starts_at))}${a.ends_at ? `<div class="msg-sub">do ${rtEsc(msgDate(a.ends_at))}</div>` : ""}</td>
        <td class="msg-c"><span class="msg-status ${st.cls}">${st.label}</span></td>
        <td class="msg-c">
          <div class="msg-progress" title="Przeczytało ${a.reads} z ${total}${a.require_ack ? `, potwierdziło ${a.acks}` : ""}"><span style="width: ${Math.min(pct, 100)}%;"></span></div>
          <div class="msg-sub">${a.reads} z ${total}${a.require_ack ? ` • potw. ${a.acks}` : ""}</div>
        </td>
        <td class="msg-c">${a.push ? `<i class="fa-solid fa-mobile-screen" title="Wysłano powiadomienie push"></i>` : ""}${a.require_ack ? ` <i class="fa-solid fa-signature" title="Wymaga potwierdzenia"></i>` : ""}</td>
        <td class="msg-actions">
          <button type="button" class="link-btn" title="Kto przeczytał" onclick="msgOpenDetails(${id})"><i class="fa-solid fa-eye"></i></button>
          <button type="button" class="link-btn" title="Edytuj" onclick="msgOpenEditor(${id})"><i class="fa-solid fa-pen"></i></button>
          <button type="button" class="link-btn" title="Kopiuj jako nowy" onclick="msgOpenEditor(${id}, true)"><i class="fa-solid fa-copy"></i></button>
          ${st.cls !== "ended" ? `<button type="button" class="link-btn" title="Zakończ teraz" onclick="msgClose(${id})"><i class="fa-solid fa-stop"></i></button>` : ""}
          <button type="button" class="link-btn msg-del${msgDeleteArmed === id ? " armed" : ""}" title="${msgDeleteArmed === id ? "Kliknij ponownie, aby usunąć" : "Usuń"}" onclick="msgDelete(${id})">
            <i class="fa-solid fa-trash"></i>${msgDeleteArmed === id ? " Usunąć?" : ""}</button>
        </td>
      </tr>`;
  }).join("");
}

// ---------- Edytor ----------
function msgLocalInput(date) {
  const d = new Date(date);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function msgOpenEditor(id, copy) {
  const a = id ? msgItems.find(x => Number(x.id) === Number(id)) : null;
  msgEditId = a && !copy ? a.id : null;
  msgT = a ? msgTargetsFromRows(a.targets) : msgEmptyTargets();

  document.getElementById("msg-ed-title").textContent = msgEditId ? "Edycja komunikatu" : "Nowy komunikat";
  document.getElementById("msg-f-title").value = a ? a.title : "";
  document.getElementById("msg-f-body").value = a ? a.body : "";
  document.querySelectorAll("input[name=msg-prio]").forEach(r => { r.checked = r.value === (a ? a.priority : "info"); });
  document.getElementById("msg-f-start").value = msgLocalInput(a && !copy ? a.starts_at : new Date());
  document.getElementById("msg-f-end").value = a && a.ends_at && !copy ? msgLocalInput(a.ends_at) : "";
  document.getElementById("msg-f-ack").checked = a ? !!a.require_ack : false;
  document.getElementById("msg-f-push").checked = a ? !!a.push : true;
  document.getElementById("msg-f-push").disabled = !!msgEditId;   // push idzie tylko przy wysłaniu
  document.getElementById("msg-push-note").style.display = msgEditId ? "" : "none";
  document.getElementById("msg-search-users").value = "";
  document.getElementById("msg-search-emps").value = "";
  document.getElementById("msg-ed-msg").style.display = "none";
  document.getElementById("msg-save").innerHTML = msgEditId
    ? `<i class="fa-solid fa-floppy-disk"></i> Zapisz zmiany`
    : `<i class="fa-solid fa-paper-plane"></i> Wyślij komunikat`;
  msgRenderTargets();
  msgPreview();
  toggleModal("modal-msg-edit", true);
  document.getElementById("msg-f-title").focus();
}

function msgCloseEditor() {
  toggleModal("modal-msg-edit", false);
}

// Pasek formatowania: wstawia znaczniki wokół zaznaczenia
function msgWrap(kind) {
  const ta = document.getElementById("msg-f-body");
  const s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e);
  let insert;
  if (kind === "b") insert = `**${sel || "pogrubiony tekst"}**`;
  else if (kind === "i") insert = `*${sel || "kursywa"}*`;
  else if (kind === "list") insert = (sel || "pozycja").split("\n").map(l => `- ${l}`).join("\n");
  else if (kind === "link") {
    const url = prompt("Adres strony (https://...)", "https://");
    if (!url || !/^https?:\/\//.test(url)) return;
    insert = `[${sel || "link"}](${url})`;
  }
  const before = ta.value.slice(0, s);
  const needsNl = kind === "list" && before && !before.endsWith("\n");
  ta.value = before + (needsNl ? "\n" : "") + insert + ta.value.slice(e);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = s + (needsNl ? 1 : 0) + insert.length;
  msgPreview();
}

function msgPreview() {
  const el = document.getElementById("msg-preview");
  if (el) el.innerHTML = msgFormat(document.getElementById("msg-f-body").value);
}

// ---------- Wybór odbiorców ----------
function msgChip(set, id, label, group) {
  const on = set.has(Number(id));
  return `<button type="button" class="msg-chip${on ? " on" : ""}" aria-pressed="${on}" onclick="msgToggle('${group}', ${Number(id)})">${rtEsc(label)}</button>`;
}

function msgRenderTargets() {
  const t = msgT;
  document.getElementById("msg-all-users").checked = t.allUsers;
  document.getElementById("msg-user-depts").innerHTML = msgDict.depts.map(d => msgChip(t.userDepts, d.id, d.label, "userDepts")).join("") || `<span class="msg-muted">brak działów</span>`;
  document.getElementById("msg-user-roles").innerHTML = msgDict.roles.map(r => msgChip(t.userRoles, r.id, r.label, "userRoles")).join("");
  document.getElementById("msg-emp-depts").innerHTML = msgDict.depts.map(d => msgChip(t.empDepts, d.id, d.label, "empDepts")).join("") || `<span class="msg-muted">brak działów</span>`;
  msgRenderPeople("users");
  msgRenderPeople("emps");
  msgCount();
}

function msgRenderPeople(kind) {
  const isUsers = kind === "users";
  const q = (document.getElementById(isUsers ? "msg-search-users" : "msg-search-emps").value || "").toLowerCase().trim();
  const set = isUsers ? msgT.users : msgT.emps;
  const deptName = id => (msgDict.depts.find(d => Number(d.id) === Number(id)) || {}).label || "-";
  const list = (isUsers ? msgDict.users : msgDict.employees)
    .filter(p => !q || p.label.toLowerCase().includes(q) || deptName(p.department_id).toLowerCase().includes(q));
  document.getElementById(isUsers ? "msg-users-list" : "msg-emps-list").innerHTML = list.length
    ? list.map(p => `
        <label class="msg-person${set.has(Number(p.id)) ? " on" : ""}">
          <input type="checkbox" ${set.has(Number(p.id)) ? "checked" : ""} onchange="msgToggle('${isUsers ? "users" : "emps"}', ${Number(p.id)})" />
          <span class="nm">${rtEsc(p.label)}</span><span class="sub">${rtEsc(deptName(p.department_id))}</span>
        </label>`).join("")
    : `<div class="msg-muted" style="padding: 10px;">Brak osób spełniających kryteria.</div>`;
  document.getElementById(isUsers ? "msg-users-count" : "msg-emps-count").textContent = set.size ? `zaznaczono: ${set.size}` : "";
}

function msgToggle(group, id) {
  const set = msgT[group];
  if (set.has(id)) set.delete(id); else set.add(id);
  if (group === "users" || group === "emps") msgRenderPeople(group);
  else msgRenderTargets();
  msgCount();
}

function msgToggleAllUsers(on) {
  msgT.allUsers = on;
  msgCount();
}

function msgCount() {
  const r = msgRecipients(msgT);
  document.getElementById("msg-count").innerHTML =
    `Komunikat zobaczy: <b>${r.users.length}</b> ${r.users.length === 1 ? "użytkownik" : "użytkowników"} i <b>${r.emps.length}</b> ${r.emps.length === 1 ? "pracownik" : "pracowników"}`;
}

function msgEdMsg(text) {
  const el = document.getElementById("msg-ed-msg");
  el.textContent = text;
  el.style.display = text ? "block" : "none";
}

function msgTargetRows(id) {
  const t = msgT, rows = [];
  if (t.allUsers) rows.push({ announcement_id: id, kind: "all_users", ref_id: null });
  t.userDepts.forEach(x => rows.push({ announcement_id: id, kind: "user_dept", ref_id: x }));
  t.userRoles.forEach(x => rows.push({ announcement_id: id, kind: "user_role", ref_id: x }));
  t.users.forEach(x => rows.push({ announcement_id: id, kind: "user", ref_id: x }));
  t.empDepts.forEach(x => rows.push({ announcement_id: id, kind: "emp_dept", ref_id: x }));
  t.emps.forEach(x => rows.push({ announcement_id: id, kind: "employee", ref_id: x }));
  return rows;
}

async function msgSave() {
  if (msgSaving) return;
  const title = document.getElementById("msg-f-title").value.trim();
  const body = document.getElementById("msg-f-body").value.trim();
  const priority = (document.querySelector("input[name=msg-prio]:checked") || {}).value || "info";
  const startRaw = document.getElementById("msg-f-start").value;
  const endRaw = document.getElementById("msg-f-end").value;
  const starts = startRaw ? new Date(startRaw) : new Date();
  const ends = endRaw ? new Date(endRaw) : null;
  const rec = msgRecipients(msgT);

  if (!title) return msgEdMsg("Wpisz temat komunikatu.");
  if (title.length > 120) return msgEdMsg("Temat może mieć najwyżej 120 znaków.");
  if (body.length > 5000) return msgEdMsg("Treść może mieć najwyżej 5000 znaków.");
  if (!msgTargetRows(0).length) return msgEdMsg("Wybierz odbiorców komunikatu.");
  if (!rec.users.length && !rec.emps.length) return msgEdMsg("Wybrane grupy nie obejmują teraz nikogo. Sprawdź odbiorców.");
  if (ends && ends <= starts) return msgEdMsg("Koniec wyświetlania musi być po początku.");

  const payload = {
    title, body, priority,
    require_ack: document.getElementById("msg-f-ack").checked,
    starts_at: starts.toISOString(),
    ends_at: ends ? ends.toISOString() : null
  };
  const btn = document.getElementById("msg-save");
  msgSaving = true;
  btn.disabled = true;
  msgEdMsg("");
  try {
    let id = msgEditId;
    if (id) {
      const { error } = await supabaseClient.from("announcements")
        .update({ ...payload, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) throw error;
      const { error: delErr } = await supabaseClient.from("announcement_targets").delete().eq("announcement_id", id);
      if (delErr) throw delErr;
    } else {
      const { data, error } = await supabaseClient.from("announcements")
        .insert({ ...payload, push: document.getElementById("msg-f-push").checked }).select("id");
      if (error) throw error;
      id = data[0].id;
    }
    const { error: tErr } = await supabaseClient.from("announcement_targets").insert(msgTargetRows(id));
    if (tErr) throw tErr;
    if (!msgEditId) {
      const { error: pErr } = await supabaseClient.rpc("app_announcement_publish", { p_id: id });
      if (pErr) console.warn("Komunikaty: push nie został wysłany:", pErr.message);
    }
    logAction(msgEditId ? "Zmiana komunikatu" : "Wysłanie komunikatu",
      `${title} — odbiorcy: ${rec.users.length} użytk., ${rec.emps.length} prac.`);
    msgCloseEditor();
    await msgLoadItems();
    msgFetch(true);           // autor też może być odbiorcą
  } catch (err) {
    console.error("Komunikaty: błąd zapisu:", err);
    msgEdMsg("Nie udało się zapisać komunikatu: " + (err.message || err));
  } finally {
    msgSaving = false;
    btn.disabled = false;
  }
}

// ---------- Zakończenie i usuwanie ----------
async function msgClose(id) {
  const a = msgItems.find(x => Number(x.id) === Number(id));
  const { error } = await supabaseClient.from("announcements").update({ closed_at: new Date().toISOString() }).eq("id", id);
  if (error) return alert("Nie udało się zakończyć komunikatu: " + error.message);
  logAction("Zakończenie komunikatu", a ? a.title : `id ${id}`);
  msgLoadItems();
}

async function msgDelete(id) {
  if (msgDeleteArmed !== id) {
    msgDeleteArmed = id;
    msgRenderItems();
    setTimeout(() => { if (msgDeleteArmed === id) { msgDeleteArmed = null; msgRenderItems(); } }, 4000);
    return;
  }
  msgDeleteArmed = null;
  const a = msgItems.find(x => Number(x.id) === Number(id));
  const { error } = await supabaseClient.from("announcements").delete().eq("id", id);
  if (error) return alert("Nie udało się usunąć komunikatu: " + error.message);
  logAction("Usunięcie komunikatu", a ? a.title : `id ${id}`);
  msgLoadItems();
}

// ---------- Kto przeczytał ----------
async function msgOpenDetails(id) {
  const a = msgItems.find(x => Number(x.id) === Number(id));
  document.getElementById("msg-det-title").textContent = a ? a.title : "Komunikat";
  document.getElementById("msg-det-body").innerHTML = a ? msgFormat(a.body) : "";
  document.getElementById("msg-det-list").innerHTML = `<div class="msg-empty"><i class="fa-solid fa-spinner fa-spin"></i> Ładowanie...</div>`;
  msgDetailFilter = "all";
  document.querySelectorAll(".msg-det-tab").forEach(b => b.classList.toggle("on", b.dataset.f === "all"));
  toggleModal("modal-msg-details", true);

  const { data, error } = await supabaseClient.rpc("app_announcement_recipients", { p_id: id });
  if (error) {
    document.getElementById("msg-det-list").innerHTML = `<div class="msg-empty" style="color: var(--danger);">Nie udało się pobrać odbiorców: ${rtEsc(error.message)}</div>`;
    return;
  }
  msgDetailRows = data || [];
  msgDetailAck = !!(a && a.require_ack);
  msgRenderDetails();
}

let msgDetailAck = false;

function msgDetailTab(f) {
  msgDetailFilter = f;
  document.querySelectorAll(".msg-det-tab").forEach(b => b.classList.toggle("on", b.dataset.f === f));
  msgRenderDetails();
}

function msgRenderDetails() {
  const rows = msgDetailRows.filter(r =>
    msgDetailFilter === "all" || (msgDetailFilter === "read" ? !!r.read_at : !r.read_at));
  const read = msgDetailRows.filter(r => r.read_at).length;
  document.getElementById("msg-det-stats").textContent =
    `Przeczytało ${read} z ${msgDetailRows.length}${msgDetailAck ? `, potwierdziło ${msgDetailRows.filter(r => r.acked).length}` : ""}`;
  document.getElementById("msg-det-list").innerHTML = rows.length
    ? `<table class="msg-det-table"><tbody>${rows.map(r => `
        <tr>
          <td><b>${rtEsc(r.name)}</b><div class="msg-sub">${r.kind === "user" ? "użytkownik" : "pracownik"}${r.department ? " • " + rtEsc(r.department) : ""}</div></td>
          <td class="msg-c">${r.read_at
            ? `<span class="msg-status active"><i class="fa-solid fa-check"></i> ${rtEsc(msgDate(r.read_at))}</span>${msgDetailAck && r.acked ? `<div class="msg-sub">potwierdzono</div>` : ""}`
            : `<span class="msg-status unread">Nie przeczytał</span>`}</td>
        </tr>`).join("")}</tbody></table>`
    : `<div class="msg-empty">Brak osób w tej grupie.</div>`;
}

function msgCloseDetails() {
  toggleModal("modal-msg-details", false);
}
