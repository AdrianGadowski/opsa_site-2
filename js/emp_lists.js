// ==========================================
// MODUŁ: PRYWATNE LISTY PRACOWNIKÓW (Rozliczenie czasu -> filtr "Lista")
// Tabele: employee_lists, employee_list_members (sql/25_listy_pracownikow.sql)
// Każdy użytkownik widzi tylko swoje listy (pilnuje tego baza - RLS).
// Działa w Rozliczeniu czasu (report_time.js) i w Harmonogramie (schedule.js) - patrz rtlCtx().
// Wymaga: supabaseClient, toggleModal, logAction (app.js), rtEsc (report_time.js)
// ==========================================

let rtlLists = [];             // [{ id, name, members: Set(id pracownika) }]
let rtlEditId = null;          // edytowana lista; null = nowa
let rtlChecked = new Set();    // zaznaczeni pracownicy w oknie list
let rtlDeleteArmed = false;    // pierwszy klik "Usuń listę" tylko uzbraja przycisk
let rtlBusy = false;

// Strona, na której działa filtr: Harmonogram albo Rozliczenie czasu
function rtlCtx() {
  if (document.getElementById("sh-table-body")) {
    return { employees: () => shEmployees, visible: shVisibleEmployees, render: shRenderTable };
  }
  return { employees: () => rtEmployees, visible: rtVisibleEmployees, render: rtRenderTable };
}

// Pole filtra "Moja lista" na bieżącej stronie
function rtlFilterEl() {
  return document.getElementById("sh-filter-list") || document.getElementById("rt-filter-list");
}

// Pobiera listy zalogowanego użytkownika i odświeża filtr "Lista"
async function rtlLoad() {
  try {
    const { data, error } = await supabaseClient
      .from("employee_lists")
      .select("id, name, employee_list_members ( employee_id )")
      .order("name");
    if (error) throw error;
    rtlLists = (data || [])
      .map(l => ({
        id: l.id,
        name: l.name,
        members: new Set((l.employee_list_members || []).map(m => Number(m.employee_id)))
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "pl", { numeric: true }));
    rtlFillFilter();
    return true;
  } catch (err) {
    console.warn("Nie udało się pobrać list pracowników:", err.message || err);
    rtlLists = [];
    rtlFillFilter();
    return false;
  }
}

function rtlFillFilter() {
  const sel = rtlFilterEl();
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">Wszyscy pracownicy</option>` +
    rtlLists.map(l => `<option value="${l.id}">${rtEsc(l.name)} (${l.members.size})</option>`).join("");
  // wybrana lista zostaje, jeśli nadal istnieje
  sel.value = rtlLists.some(l => String(l.id) === current) ? current : "";
}

// Zbiór pracowników wybranej w filtrze listy; null = bez filtra listy
function rtlFilterSet() {
  const id = rtlFilterEl()?.value;
  if (!id) return null;
  const list = rtlLists.find(l => String(l.id) === String(id));
  return list ? list.members : null;
}

// ---------- Okno "Moje listy" ----------
function rtlMsg(text, ok) {
  const el = document.getElementById("rtl-msg");
  if (!el) return;
  el.textContent = text || "";
  el.style.display = text ? "block" : "none";
  el.style.color = ok ? "#0b7a57" : "var(--danger)";
}

async function rtlOpen() {
  rtlMsg("");
  toggleModal("modal-rt-lists", true);
  const ok = await rtlLoad();
  if (!ok) {
    rtlMsg("Nie udało się pobrać list. Jeśli to pierwsze użycie, administrator musi uruchomić w Supabase skrypt sql/25_listy_pracownikow.sql.");
  }
  // otwiera listę wybraną w filtrze albo nową
  const current = rtlFilterEl()?.value;
  rtlPick(current || "");
}

function rtlClose() {
  toggleModal("modal-rt-lists", false);
}

// Wybór listy do edycji ("" = nowa lista)
function rtlPick(value) {
  const list = value ? rtlLists.find(l => String(l.id) === String(value)) : null;
  rtlEditId = list ? list.id : null;
  rtlChecked = new Set(list ? list.members : []);
  rtlDeleteArmed = false;

  const pick = document.getElementById("rtl-pick");
  pick.innerHTML = `<option value="">+ Nowa lista</option>` +
    rtlLists.map(l => `<option value="${l.id}">${rtEsc(l.name)}</option>`).join("");
  pick.value = list ? String(list.id) : "";

  document.getElementById("rtl-name").value = list ? list.name : "";
  document.getElementById("rtl-search").value = "";
  const del = document.getElementById("rtl-delete");
  del.style.display = list ? "" : "none";
  del.innerHTML = `<i class="fa-solid fa-trash"></i> Usuń listę`;
  del.classList.remove("armed");
  rtlRender();
  if (!list) document.getElementById("rtl-name").focus();
}

// Nowa lista od razu z pracownikami widocznymi w tabeli (z bieżącymi filtrami)
function rtlFromVisible() {
  rtlChecked = new Set(rtlCtx().visible().map(e => Number(e.id)));
  rtlRender();
}

function rtlVisible() {
  const q = (document.getElementById("rtl-search")?.value || "").toLowerCase().trim();
  const all = rtlCtx().employees();
  if (!q) return all;
  return all.filter(e => {
    const n1 = `${e.first_name || ""} ${e.last_name || ""}`.toLowerCase();
    const n2 = `${e.last_name || ""} ${e.first_name || ""}`.toLowerCase();
    const extra = `${e.department?.department || ""} ${e.business?.business || ""}`.toLowerCase();
    return n1.includes(q) || n2.includes(q) || extra.includes(q);
  });
}

function rtlRender() {
  const box = document.getElementById("rtl-items");
  if (!box) return;
  const list = rtlVisible();
  document.getElementById("rtl-count").textContent = `Zaznaczono: ${rtlChecked.size}`;

  const allOn = list.length > 0 && list.every(e => rtlChecked.has(Number(e.id)));
  const toggle = document.getElementById("rtl-toggle-all");
  toggle.textContent = allOn ? "Odznacz widocznych" : "Zaznacz widocznych";
  toggle.disabled = list.length === 0;

  box.innerHTML = list.length
    ? list.map(e => {
        const id = Number(e.id);
        const on = rtlChecked.has(id);
        return `
          <label class="rtl-item ${on ? "on" : ""}">
            <input type="checkbox" ${on ? "checked" : ""} onchange="rtlToggle(${id}, this.checked)" />
            <span class="nm">${rtEsc(e.first_name)} ${rtEsc(e.last_name)}</span>
            <span class="sub">${rtEsc(e.department?.department || "-")} • ${rtEsc(e.business?.business || "-")}</span>
          </label>`;
      }).join("")
    : `<div class="rtl-empty">Brak pracowników spełniających kryteria.</div>`;
}

function rtlToggle(id, on) {
  if (on) rtlChecked.add(id); else rtlChecked.delete(id);
  rtlRender();
}

function rtlToggleAll() {
  const list = rtlVisible();
  const allOn = list.every(e => rtlChecked.has(Number(e.id)));
  list.forEach(e => { if (allOn) rtlChecked.delete(Number(e.id)); else rtlChecked.add(Number(e.id)); });
  rtlRender();
}

async function rtlSave() {
  if (rtlBusy) return;
  const name = document.getElementById("rtl-name").value.trim().replace(/\s+/g, " ");
  if (!name) return rtlMsg("Podaj nazwę listy.");
  if (name.length > 60) return rtlMsg("Nazwa listy może mieć najwyżej 60 znaków.");
  if (rtlLists.some(l => l.id !== rtlEditId && l.name.toLowerCase() === name.toLowerCase())) {
    return rtlMsg(`Masz już listę o nazwie „${name}”.`);
  }
  if (rtlChecked.size === 0) return rtlMsg("Zaznacz przynajmniej jednego pracownika.");

  const btn = document.getElementById("rtl-save");
  rtlBusy = true;
  btn.disabled = true;
  rtlMsg("");
  const isNew = rtlEditId === null;

  try {
    let listId = rtlEditId;
    if (isNew) {
      const { data, error } = await supabaseClient.from("employee_lists").insert({ name }).select("id");
      if (error) throw error;
      listId = data[0].id;
    } else {
      const { data, error } = await supabaseClient.from("employee_lists").update({ name }).eq("id", listId).select("id");
      if (error) throw error;
      if (!data || !data.length) throw new Error("lista nie istnieje albo nie należy do Ciebie");
      const { error: delErr } = await supabaseClient.from("employee_list_members").delete().eq("list_id", listId);
      if (delErr) throw delErr;
    }

    const members = [...rtlChecked].map(employee_id => ({ list_id: listId, employee_id }));
    const { error: memErr } = await supabaseClient.from("employee_list_members").insert(members);
    if (memErr) throw memErr;

    logAction(isNew ? "Utworzenie listy pracowników" : "Zmiana listy pracowników",
      `${name} (pracowników: ${members.length})`);

    await rtlLoad();
    // zapisana lista od razu staje się filtrem
    const sel = rtlFilterEl();
    if (sel) sel.value = String(listId);
    rtlCtx().render();
    rtlClose();
  } catch (err) {
    console.error("Błąd zapisu listy pracowników:", err);
    const dup = String(err.code) === "23505";
    rtlMsg(dup ? `Masz już listę o nazwie „${name}”.` : "Nie udało się zapisać listy: " + (err.message || err));
  } finally {
    rtlBusy = false;
    btn.disabled = false;
  }
}

async function rtlDelete() {
  if (rtlBusy || rtlEditId === null) return;
  const del = document.getElementById("rtl-delete");
  if (!rtlDeleteArmed) {
    rtlDeleteArmed = true;
    del.classList.add("armed");
    del.innerHTML = `<i class="fa-solid fa-trash"></i> Na pewno usunąć?`;
    return;
  }

  const list = rtlLists.find(l => l.id === rtlEditId);
  rtlBusy = true;
  del.disabled = true;
  try {
    const { error } = await supabaseClient.from("employee_lists").delete().eq("id", rtlEditId);
    if (error) throw error;
    logAction("Usunięcie listy pracowników", list ? list.name : String(rtlEditId));
    await rtlLoad();
    rtlCtx().render();
    rtlPick("");
    rtlMsg("Lista została usunięta.", true);
  } catch (err) {
    console.error("Błąd usuwania listy pracowników:", err);
    rtlMsg("Nie udało się usunąć listy: " + (err.message || err));
  } finally {
    rtlBusy = false;
    del.disabled = false;
  }
}
