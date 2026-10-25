// ==========================================
// MODUŁ: PLAN ZALEWU (panel użytkownika)
// Plan każdej zmiany na wybranej linii: kadzie, metal w kadziach (t) i formy do zalania.
// Tabela zalew_cele (sql/40-42) - jeden wpis na linię, dzień i zmianę; puste pola = brak planu.
// Pod planem wykonanie z Zalewu (tabela zalewy). Doba i cały tydzień liczą się same.
//  * Uprawnienia: allow_pour_plan_view (podgląd), allow_pour_plan_edit (edycja).
//  * Plan zmiany, która już się skończyła, zmienia tylko administrator (pilnuje też baza).
//  * "Skopiuj poprzedni tydzień" i "Wypełnij tydzień" tylko wpisują liczby - zapis przyciskiem "Zapisz plan".
// Wymaga: supabaseClient, hasPermission, isAdminRoleName, logAction, toggleModal (app.js), rtEsc, rtIsoToPl
//         (report_time.js), rpFetchAll (reports.js), dbWeekOfYear (dashboard.js), ZW_LINES, ZW_SHIFTS, ZW_DAY_NAMES,
//         zwIso, zwAddDays, zwMondayOf, zwProductionDate, zwShiftLabel, zwSums, zwNum, zwTons (zalew.js).
// ==========================================

const PP_FIELDS = ["kadzie", "metal_kg", "formy"];

let ppMonday = null;         // poniedziałek oglądanego tygodnia (rrrr-mm-dd)
let ppLine = "Lora";
let ppPlan = {};             // { "rrrr-mm-dd|Zmiana I": { kadzie, metal_kg, formy } } - zapisane w bazie
let ppEdits = {};            // niezapisane zmiany, ten sam klucz
let ppReal = [];             // zalewy tygodnia na linii (wykonanie)
let ppToken = 0;
let ppBusy = false;
let ppBannerTimer = null;

function ppCanEdit() {
  return hasPermission("allow_pour_plan_edit");
}

function ppIsAdmin() {
  return isAdminRoleName(currentUser?.role?.role);
}

// Czy zmiana już się skończyła (I o 14:30, II o 22:30, III o 06:30 następnego dnia)
function ppShiftEnded(day, shift) {
  const end = { "Zmiana I": "14:30", "Zmiana II": "22:30", "Zmiana III": "06:30" }[shift] || "06:30";
  const d = new Date(`${day}T${end}:00`);
  if (shift === "Zmiana III") d.setDate(d.getDate() + 1);
  return d <= new Date();
}

// Czy zmiana już się zaczęła (I o 06:30, II o 14:30, III o 22:30 tego dnia)
function ppShiftStarted(day, shift) {
  const start = { "Zmiana I": "06:30", "Zmiana II": "14:30", "Zmiana III": "22:30" }[shift] || "06:30";
  return new Date(`${day}T${start}:00`) <= new Date();
}

// Czy komórkę można edytować: uprawnienie i zmiana jeszcze trwa / przed nami (administrator - zawsze)
function ppEditable(day, shift) {
  return ppCanEdit() && (ppIsAdmin() || !ppShiftEnded(day, shift));
}

function ppKey(day, shift) {
  return `${day}|${shift}`;
}

// Plan komórki: niezapisana zmiana albo stan z bazy
function ppValue(day, shift) {
  const k = ppKey(day, shift);
  return ppEdits[k] || ppPlan[k] || { kadzie: null, metal_kg: null, formy: null };
}

function ppShowBanner(type, text) {
  const el = document.getElementById("pp-banner");
  if (!el) return;
  el.className = `pp-banner visible ${type}`;
  el.innerHTML = `<i class="fa-solid ${type === "success" ? "fa-circle-check" : "fa-triangle-exclamation"}"></i><span>${rtEsc(text)}</span>`;
  clearTimeout(ppBannerTimer);
  ppBannerTimer = setTimeout(() => el.classList.remove("visible"), 8000);
}

// Pola liczbowe: tylko cyfry; metal - cyfry i jeden przecinek (tony)
function ppDigits(el) {
  const clean = el.value.replace(/\D/g, "");
  if (clean !== el.value) el.value = clean;
}

function ppDecimal(el) {
  let v = el.value.replace(/\./g, ",").replace(/[^\d,]/g, "");
  const i = v.indexOf(",");
  if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/,/g, "").slice(0, 1);   // jedno miejsce po przecinku
  if (v !== el.value) el.value = v;
}

// "30,5" -> 30500 kg; "" -> null
function ppTonsToKg(text) {
  const t = String(text || "").trim().replace(",", ".");
  return t === "" ? null : Math.round(Number(t) * 1000);
}

function ppKgToTons(kg) {
  return kg === null || kg === undefined ? "" : String(Number(kg) / 1000).replace(".", ",");
}

// ---------- Start i nawigacja ----------
async function initPourPlanView() {
  ppEdits = {};
  ppMonday = zwMondayOf(zwProductionDate(new Date()));
  if (!ZW_LINES.includes(ppLine)) ppLine = ZW_LINES[0];
  document.getElementById("pp-actions").style.display = ppCanEdit() ? "" : "none";
  await ppLoad();
}

// Niezapisane zmiany przepadają przy zmianie tygodnia / linii - najpierw pytanie w oknie ostrzeżenia
// (jak inne ostrzeżenia w aplikacji). Wynik: true = przejdź dalej bez zapisu, false = zostań.
let ppDiscardResolve = null;

function ppConfirmDiscard() {
  const n = Object.keys(ppEdits).length;
  if (!n) return Promise.resolve(true);
  document.getElementById("pp-discard-text").innerHTML =
    `Masz niezapisane zmiany planu: <b>${n}</b> ${n === 1 ? "zmiana" : n < 5 ? "zmiany" : "zmian"} na linii <b>${rtEsc(ppLine)}</b>.<br>Jeśli przejdziesz dalej, przepadną.`;
  toggleModal("modal-pp-discard", true);
  return new Promise(resolve => { ppDiscardResolve = resolve; });
}

function ppCloseDiscard(ok) {
  toggleModal("modal-pp-discard", false);
  const resolve = ppDiscardResolve;
  ppDiscardResolve = null;
  if (resolve) resolve(ok);
}

async function ppStepWeek(delta) {
  if (!(await ppConfirmDiscard())) return;
  ppMonday = delta === 0 ? zwMondayOf(zwProductionDate(new Date())) : zwAddDays(ppMonday, delta * 7);
  ppEdits = {};
  ppLoad();
}

async function ppSetLine(line) {
  if (line === ppLine || !ZW_LINES.includes(line) || !(await ppConfirmDiscard())) return;
  ppLine = line;
  ppEdits = {};
  ppLoad();
}

// Plan z bazy dla linii i tygodnia -> { klucz: wartości }
async function ppFetchPlan(line, monday) {
  const { data, error } = await supabaseClient
    .from("zalew_cele")
    .select("dzien, zmiana, kadzie, metal_kg, formy")
    .eq("linia", line)
    .gte("dzien", monday)
    .lte("dzien", zwAddDays(monday, 6));
  if (error) throw error;
  const plan = {};
  (data || []).forEach(r => { plan[ppKey(r.dzien, r.zmiana)] = { kadzie: r.kadzie, metal_kg: r.metal_kg, formy: r.formy }; });
  return plan;
}

// true = plan wczytany (false: błąd albo w międzyczasie zmieniono tydzień / linię)
async function ppLoad() {
  const table = document.getElementById("pp-table");
  if (!table) return;
  const token = ++ppToken;
  const sunday = zwAddDays(ppMonday, 6);

  const [y, m, d] = ppMonday.split("-").map(Number);
  document.getElementById("pp-week-label").innerHTML =
    `<b>Tydzień ${dbWeekOfYear(y, m, d)}</b><span>${rtEsc(rtIsoToPl(ppMonday).slice(0, 5))}–${rtEsc(rtIsoToPl(sunday))}</span>`;
  document.getElementById("pp-this-week").disabled = ppMonday === zwMondayOf(zwProductionDate(new Date()));
  document.getElementById("pp-lines").innerHTML = ZW_LINES.map(line => `
    <button type="button" role="tab" class="${line === ppLine ? "on" : ""}" aria-selected="${line === ppLine}"
            onclick="ppSetLine('${rtEsc(line)}')">${rtEsc(line)}</button>`).join("");
  document.getElementById("pp-hint").innerHTML = !ppCanEdit()
    ? `<i class="fa-solid fa-eye"></i>Podgląd planu - zmieniać może osoba z uprawnieniem „Plan zalewu – edycja”.`
    : ppIsAdmin()
      ? `<i class="fa-solid fa-user-shield"></i>Jako administrator możesz zmieniać także plan zmian, które już się skończyły.`
      : `<i class="fa-solid fa-lock"></i>Plan zmian, które już się skończyły, może zmienić tylko administrator.`;
  table.innerHTML = `<tbody><tr><td style="text-align:center;color:var(--text-muted);padding:30px;"><i class="fa-solid fa-spinner fa-spin"></i> Ładowanie planu...</td></tr></tbody>`;
  ppSyncSave();

  try {
    const [plan, real] = await Promise.all([
      ppFetchPlan(ppLine, ppMonday),
      rpFetchAll(() => supabaseClient
        .from("zalewy")
        .select("id, data_zalewu, zmiana, numer_kadzi, metal_kadz, ilosc_form")
        .eq("linia", ppLine)
        .gte("data_zalewu", ppMonday)
        .lte("data_zalewu", sunday))
    ]);
    if (token !== ppToken) return;
    ppPlan = plan;
    ppReal = real;
    ppRender();
    return true;
  } catch (err) {
    if (token !== ppToken) return;
    console.error("Błąd pobierania planu zalewu:", err);
    table.innerHTML = `<tbody><tr><td style="text-align:center;color:var(--danger);padding:30px;">
      Nie udało się pobrać planu: ${rtEsc(err.message || err)}</td></tr></tbody>`;
  }
}

// ---------- Tabela ----------
function ppDays() {
  return Array.from({ length: 7 }, (_, i) => zwAddDays(ppMonday, i));
}

function ppShifts() {
  return ZW_SHIFTS.map(s => s.name);
}

// Wykonanie (zalewy) dla dni i zmian
function ppRealSums(days, shifts) {
  return zwSums(ppReal.filter(r => days.includes(r.data_zalewu) && shifts.includes(r.zmiana)));
}

// Suma planu dla dni i zmian; null w polu, gdy żadna komórka nie ma planu
function ppPlanSums(days, shifts) {
  const sums = { kadzie: null, metal_kg: null, formy: null };
  days.forEach(day => shifts.forEach(shift => {
    const v = ppValue(day, shift);
    PP_FIELDS.forEach(f => { if (v[f] !== null && v[f] !== undefined) sums[f] = (sums[f] || 0) + Number(v[f]); });
  }));
  return sums;
}

function ppCellHtml(day, shift) {
  const v = ppValue(day, shift);
  const k = ppKey(day, shift);
  const edit = ppEditable(day, shift);
  const field = (label, f, value, numeric) => edit
    ? `<div class="pp-in"><label>${label}</label>
        <input type="text" data-k="${k}" data-f="${f}" value="${rtEsc(value)}" inputmode="${numeric ? "numeric" : "decimal"}"
               maxlength="${f === "metal_kg" ? 6 : 5}" class="${ppFieldDirty(k, f) ? "dirty" : ""}" aria-label="${label}: ${rtEsc(shift)}, ${rtEsc(rtIsoToPl(day))}"
               oninput="${numeric ? "ppDigits(this)" : "ppDecimal(this)"}; ppOnInput(this)" /></div>`
    : `<div class="pp-in"><label>${label}</label><span class="ro${value === "" ? " empty" : ""}">${value === "" ? "—" : rtEsc(value)}</span></div>`;
  const real = ppRealSums([day], [shift]);
  const started = ppShiftStarted(day, shift) || real.ladles > 0;
  // wykonanie pod każdą zaplanowaną liczbą (zielone, gdy plan osiągnięty)
  const doneCol = (value, plan, fmt) =>
    `<span class="${plan && value >= plan ? "done" : ""}">wyk. <b>${fmt(value)}</b></span>`;
  // zmiana, która właśnie trwa: pomarańczowa ramka i znaczek "Trwa" (jak w Dashboardzie Zalewu)
  const live = ppShiftStarted(day, shift) && !ppShiftEnded(day, shift);
  return `<td${live ? ` class="pp-now"` : ""}>${live ? `<span class="pp-live"><i></i>Trwa</span>` : ""}
    <div class="pp-cell">
      ${field("Kadzie", "kadzie", v.kadzie ?? "", true)}
      ${field("Metal (t)", "metal_kg", ppKgToTons(v.metal_kg), false)}
      ${field("Formy", "formy", v.formy ?? "", true)}
    </div>
    <div class="pp-real">${started
      ? `${doneCol(real.ladles, v.kadzie, zwNum)}${doneCol(real.metal, v.metal_kg, zwTons)}${doneCol(real.forms, v.formy, zwNum)}`
      : `<span class="pp-before">jeszcze przed zmianą</span>`}</div>
    ${!edit && ppCanEdit() ? `<div class="pp-lockrow" title="Plan zakończonej zmiany zmienia administrator"><i class="fa-solid fa-lock pp-lock"></i> zmiana zakończona</div>` : ""}
  </td>`;
}

// Doba / tydzień: plan nad wykonaniem
function ppTotalsHtml(days, shifts) {
  const p = ppPlanSums(days, shifts);
  const r = ppRealSums(days, shifts);
  const col = (label, plan, real, fmt) => `<div><span class="k">${label}</span><b>${plan === null ? "—" : fmt(plan)}</b><small>wyk. ${fmt(real)}</small></div>`;
  return `<div class="pp-totals">
    ${col("Kadzie", p.kadzie, r.ladles, zwNum)}
    ${col("Metal", p.metal_kg, r.metal, zwTons)}
    ${col("Formy", p.formy, r.forms, zwNum)}
  </div>`;
}

function ppRender() {
  const table = document.getElementById("pp-table");
  if (!table) return;
  const days = ppDays();
  const shifts = ppShifts();
  const today = zwProductionDate(new Date());

  const head = `<thead><tr><th>Dzień</th>${shifts.map(s => `<th>${rtEsc(zwShiftLabel(s))}</th>`).join("")}<th>Doba (plan / wykonanie)</th></tr></thead>`;
  const body = days.map((day, i) => `
    <tr class="${day === today ? "today" : ""}${i === 5 ? " sat" : i === 6 ? " sun" : ""}">
      <th class="pp-day">${ZW_DAY_NAMES[i]}<span>${rtEsc(rtIsoToPl(day))}</span></th>
      ${shifts.map(shift => ppCellHtml(day, shift)).join("")}
      <td class="pp-sum" id="pp-day-${day}">${ppTotalsHtml([day], shifts)}</td>
    </tr>`).join("");
  const foot = `<tfoot><tr>
      <th class="pp-day">Cały tydzień<span>${rtEsc(ppLine)}</span></th>
      ${shifts.map((shift, i) => `<td class="pp-sum" id="pp-week-${i}">${ppTotalsHtml(days, [shift])}</td>`).join("")}
      <td class="pp-sum" id="pp-week-all">${ppTotalsHtml(days, shifts)}</td>
    </tr></tfoot>`;
  table.innerHTML = head + `<tbody>${body}</tbody>` + foot;
  ppSyncRings();
  // zaznaczone pole też ma żółtą obwódkę (łączy się z sąsiednimi zmienionymi) - raz na tabelę
  if (!table.dataset.rings) {
    table.dataset.rings = "1";
    table.addEventListener("focusin", () => ppSyncRings());
    table.addEventListener("focusout", () => setTimeout(ppSyncRings, 0));   // po przejściu fokusu dalej
  }
  ppSyncSave();
}

// Żółte obwódki: pole zmienione albo zaznaczone (hl); sąsiednie podświetlone pola tej samej zmiany
// łączą się w jedną obwódkę (jl - połączone z lewym, jr - z prawym); ✓ (ck) na ostatnim zmienionym polu
function ppSyncRings() {
  document.querySelectorAll("#pp-table .pp-cell").forEach(cell => {
    const items = [...cell.querySelectorAll(".pp-in")];
    const hl = items.map(el => {
      const input = el.querySelector("input");
      return !!input && (input.classList.contains("dirty") || input === document.activeElement);
    });
    items.forEach((el, i) => {
      const dirty = !!el.querySelector("input.dirty");
      el.classList.toggle("hl", hl[i]);
      el.classList.toggle("jl", hl[i] && !!hl[i - 1]);
      el.classList.toggle("jr", hl[i] && !!hl[i + 1]);
      el.classList.toggle("ck", dirty && !hl[i + 1]);
    });
  });
}

// Sumy doby i tygodnia bez przebudowy tabeli (pole, w którym się pisze, nie traci kursora)
function ppRefreshTotals(day) {
  const days = ppDays();
  const shifts = ppShifts();
  const dayEl = document.getElementById(`pp-day-${day}`);
  if (dayEl) dayEl.innerHTML = ppTotalsHtml([day], shifts);
  shifts.forEach((shift, i) => {
    const el = document.getElementById(`pp-week-${i}`);
    if (el) el.innerHTML = ppTotalsHtml(days, [shift]);
  });
  const all = document.getElementById("pp-week-all");
  if (all) all.innerHTML = ppTotalsHtml(days, shifts);
}

// Czy jedno pole komórki różni się od zapisanego planu
function ppFieldDirty(k, f) {
  const e = ppEdits[k];
  if (!e) return false;
  const saved = ppPlan[k] || {};
  return (e[f] ?? null) !== (saved[f] ?? null);
}

// Wpisanie liczby: zapamiętaj zmianę (albo ją usuń, gdy wróciła do stanu z bazy)
function ppOnInput(el) {
  const k = el.dataset.k;
  const [day, shift] = k.split("|");
  const v = { ...ppValue(day, shift) };
  v[el.dataset.f] = el.dataset.f === "metal_kg" ? ppTonsToKg(el.value) : (el.value === "" ? null : Number(el.value));
  const saved = ppPlan[k] || { kadzie: null, metal_kg: null, formy: null };
  const same = PP_FIELDS.every(f => (v[f] ?? null) === (saved[f] ?? null));
  if (same) delete ppEdits[k];
  else ppEdits[k] = v;
  // podświetlone tylko pola, które różnią się od zapisanego planu (nie cała zmiana)
  document.querySelectorAll(`#pp-table input[data-k="${k}"]`).forEach(i => i.classList.toggle("dirty", ppFieldDirty(k, i.dataset.f)));
  ppSyncRings();
  ppRefreshTotals(day);
  ppSyncSave();
}

function ppSyncSave() {
  const btn = document.getElementById("pp-save");
  if (!btn) return;
  const n = Object.keys(ppEdits).length;
  btn.disabled = !n || ppBusy;
  btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> ${n ? `Zapisz plan (${n})` : "Zapisz plan"}`;
}

// ---------- Zapis ----------
// Komórka z planem -> zapis (insert albo zmiana); komórka bez żadnej liczby -> usunięcie wpisu
async function ppSave() {
  const keys = Object.keys(ppEdits);
  if (!keys.length || ppBusy || !ppCanEdit()) return false;
  ppBusy = true;
  ppSyncSave();
  const upserts = [];
  const deletes = [];
  keys.forEach(k => {
    const [dzien, zmiana] = k.split("|");
    const v = ppEdits[k];
    if (PP_FIELDS.every(f => v[f] === null || v[f] === undefined)) {
      if (ppPlan[k]) deletes.push({ dzien, zmiana });
    } else {
      upserts.push({ linia: ppLine, dzien, zmiana, kadzie: v.kadzie ?? null, metal_kg: v.metal_kg ?? null, formy: v.formy ?? null });
    }
  });

  try {
    if (upserts.length) {
      const { error } = await supabaseClient.from("zalew_cele").upsert(upserts, { onConflict: "linia,dzien,zmiana" });
      if (error) throw error;
    }
    for (const d of deletes) {
      const { error } = await supabaseClient.from("zalew_cele").delete()
        .eq("linia", ppLine).eq("dzien", d.dzien).eq("zmiana", d.zmiana);
      if (error) throw error;
    }
    const [y, m, dd] = ppMonday.split("-").map(Number);
    logAction("Zmiana planu zalewu", `${ppLine}, tydzień ${dbWeekOfYear(y, m, dd)} (${rtIsoToPl(ppMonday)}): zmienionych zmian ${keys.length}` +
      keys.slice(0, 6).map(k => {
        const [day, shift] = k.split("|");
        const v = ppEdits[k];
        return `; ${rtIsoToPl(day).slice(0, 5)} ${shift.replace("Zmiana ", "")}: ${v.kadzie ?? "-"} kadzi, ${ppKgToTons(v.metal_kg) || "-"} t, ${v.formy ?? "-"} form`;
      }).join("") + (keys.length > 6 ? "; ..." : ""));
    ppEdits = {};
    ppShowBanner("success", `Zapisano plan: ${ppLine}, zmienionych zmian: ${keys.length}.`);
    ppBusy = false;
    await ppLoad();
    return true;
  } catch (err) {
    console.error("Błąd zapisu planu zalewu:", err);
    ppShowBanner("warning", "Nie udało się zapisać planu: " + (err.message || err));
  } finally {
    ppBusy = false;
    ppSyncSave();
  }
}

// ---------- Skopiuj poprzedni tydzień ----------
// Wpisuje plan sprzed tygodnia do zmian, które można edytować (zapis dopiero przyciskiem "Zapisz plan")
async function ppCopyPrevWeek() {
  if (!ppCanEdit()) return;
  let prev;
  try {
    prev = await ppFetchPlan(ppLine, zwAddDays(ppMonday, -7));
  } catch (err) {
    ppShowBanner("warning", "Nie udało się pobrać poprzedniego tygodnia: " + (err.message || err));
    return;
  }
  let copied = 0, skipped = 0;
  ppDays().forEach(day => ppShifts().forEach(shift => {
    const src = prev[ppKey(zwAddDays(day, -7), shift)];
    if (!src) return;
    if (!ppEditable(day, shift)) { skipped++; return; }
    const saved = ppPlan[ppKey(day, shift)] || {};
    if (PP_FIELDS.every(f => (src[f] ?? null) === (saved[f] ?? null))) return;
    ppEdits[ppKey(day, shift)] = { kadzie: src.kadzie, metal_kg: src.metal_kg, formy: src.formy };
    copied++;
  }));
  ppRender();
  if (!copied) {
    ppShowBanner("warning", Object.keys(prev).length ? "Plan poprzedniego tygodnia jest taki sam albo dotyczy tylko zakończonych zmian." : "Poprzedni tydzień nie ma planu na tej linii.");
    return;
  }
  ppShowBanner("success", `Skopiowano plan z poprzedniego tygodnia: ${copied} zmian${skipped ? ` (pominięto zakończone: ${skipped})` : ""}. Sprawdź i kliknij „Zapisz plan”.`);
}

// ---------- Wyczyść wszystko ----------
// Najpierw pytanie z numerem tygodnia; "Tak" aktywne po 3 s (jak usuwanie w Zalewie)
let ppClearTimer = null;

function ppAskClearAll() {
  if (!ppCanEdit()) return;
  const hasPlan = ppDays().some(day => ppShifts().some(shift => {
    const v = ppValue(day, shift);
    return PP_FIELDS.some(f => v[f] !== null && v[f] !== undefined);
  }));
  if (!hasPlan) { ppClearAll(); return; }   // nic do czyszczenia - od razu komunikat

  const [y, m, d] = ppMonday.split("-").map(Number);
  document.getElementById("pp-clear-text").innerHTML =
    `Wyczyścić cały plan na linii <b>${rtEsc(ppLine)}</b><br>dla tygodnia <b>${dbWeekOfYear(y, m, d)}</b> ` +
    `(${rtEsc(rtIsoToPl(ppMonday).slice(0, 5))}–${rtEsc(rtIsoToPl(zwAddDays(ppMonday, 6)))})?` +
    `<br><span style="color: var(--text-muted); font-size: 0.86rem;">Plan zostanie od razu usunięty.</span>`;

  const btn = document.getElementById("pp-clear-confirm");
  clearInterval(ppClearTimer);
  let secondsLeft = 3;
  btn.disabled = true;
  btn.innerText = `Tak (${secondsLeft}s)`;
  ppClearTimer = setInterval(() => {
    secondsLeft--;
    if (secondsLeft > 0) {
      btn.innerText = `Tak (${secondsLeft}s)`;
    } else {
      clearInterval(ppClearTimer);
      ppClearTimer = null;
      btn.disabled = false;
      btn.innerText = "Tak";
    }
  }, 1000);
  toggleModal("modal-pp-clear", true);
}

function ppCloseClear(ok) {
  clearInterval(ppClearTimer);
  ppClearTimer = null;
  toggleModal("modal-pp-clear", false);
  if (ok) ppClearAll();
}

// Czyści plan zmian, które można edytować (zakończone - tylko administrator); zapis dopiero przyciskiem "Zapisz plan"
// Po potwierdzeniu plan od razu znika z bazy (bez podświetlania pól i bez "Zapisz plan")
async function ppClearAll() {
  if (!ppCanEdit() || ppBusy) return;
  const empty = { kadzie: null, metal_kg: null, formy: null };
  let cleared = 0, skipped = 0;
  ppDays().forEach(day => ppShifts().forEach(shift => {
    const k = ppKey(day, shift);
    const cur = ppValue(day, shift);
    if (PP_FIELDS.every(f => cur[f] === null || cur[f] === undefined)) return;   // już pusta
    if (!ppEditable(day, shift)) { skipped++; return; }
    if (ppPlan[k]) ppEdits[k] = { ...empty };   // zapisany plan - do usunięcia przy zapisie
    else delete ppEdits[k];                     // tylko niezapisane liczby - po prostu znikają
    cleared++;
  }));
  if (!cleared) {
    ppShowBanner("warning", skipped ? "Plan mają tylko zakończone zmiany - może je zmienić administrator." : "Ten tydzień nie ma planu na tej linii.");
    return;
  }
  // zapis od razu: usuwa wpisy z bazy i wczytuje tabelę na nowo (nic nie zostaje podświetlone)
  if (Object.keys(ppEdits).length) {
    if (!(await ppSave())) { ppRender(); return; }   // błąd - komunikat z ppSave, zmiany zostają do ponownego zapisu
  } else {
    ppRender();                                       // były tylko niezapisane liczby - nic do usunięcia z bazy
  }
  ppShowBanner("success", `Wyczyszczono i zapisano plan: ${ppLine}, zmian: ${cleared}` +
    `${skipped ? ` (zakończonych nie zmieniono: ${skipped})` : ""}.`);
}

// ---------- Wypełnij tydzień ----------
let ppFillLine = null;       // linia wybrana w oknie "Wypełnij tydzień"

function ppOpenFill() {
  if (!ppCanEdit()) return;
  ppFillLine = ppLine;
  ppRenderFillLines();
  document.getElementById("pp-fill-info").textContent = `Tydzień ${rtIsoToPl(ppMonday).slice(0, 5)}–${rtIsoToPl(zwAddDays(ppMonday, 6))}. Puste pole = bez zmiany tej liczby.`;
  document.getElementById("pp-fill-msg").style.display = "none";
  toggleModal("modal-pp-fill", true);
  document.getElementById("pp-fill-ladles").focus();
}

function ppRenderFillLines() {
  document.getElementById("pp-fill-lines").innerHTML = ZW_LINES.map(line => `
    <button type="button" role="radio" class="${line === ppFillLine ? "on" : ""}" aria-checked="${line === ppFillLine}"
            onclick="ppSetFillLine('${rtEsc(line)}')">${rtEsc(line)}</button>`).join("");
}

function ppSetFillLine(line) {
  if (!ZW_LINES.includes(line)) return;
  ppFillLine = line;
  ppRenderFillLines();
}

async function ppApplyFill() {
  const ladles = document.getElementById("pp-fill-ladles").value.trim();
  const metal = document.getElementById("pp-fill-metal").value.trim();
  const forms = document.getElementById("pp-fill-forms").value.trim();
  const shifts = [...document.querySelectorAll(".pp-fill-shift:checked")].map(c => c.value);
  const skipWeekend = document.getElementById("pp-fill-weekend").checked;
  const onlyEmpty = document.getElementById("pp-fill-empty").checked;
  const msg = document.getElementById("pp-fill-msg");
  if (!ladles && !metal && !forms) {
    msg.textContent = "Wpisz co najmniej jedną liczbę.";
    msg.style.display = "block";
    return;
  }
  if (!shifts.length) {
    msg.textContent = "Zaznacz co najmniej jedną zmianę.";
    msg.style.display = "block";
    return;
  }

  // inna linia niż oglądana: plan przełącza się na nią (niezapisane zmiany - najpierw pytanie) i tam wypełnia
  if (ppFillLine && ppFillLine !== ppLine) {
    toggleModal("modal-pp-fill", false);          // ostrzeżenie zamiast okna wypełniania
    if (!(await ppConfirmDiscard())) { toggleModal("modal-pp-fill", true); return; }
    ppLine = ppFillLine;
    ppEdits = {};
    if (!(await ppLoad()) || ppLine !== ppFillLine) return;   // błąd albo w międzyczasie wybrano inną linię
  }

  let filled = 0;
  ppDays().forEach((day, i) => {
    if (skipWeekend && i >= 5) return;
    shifts.forEach(shift => {
      if (!ppEditable(day, shift)) return;
      const cur = ppValue(day, shift);
      if (onlyEmpty && PP_FIELDS.some(f => cur[f] !== null && cur[f] !== undefined)) return;
      const v = { ...cur };
      if (ladles) v.kadzie = Number(ladles);
      if (metal) v.metal_kg = ppTonsToKg(metal);
      if (forms) v.formy = Number(forms);
      const saved = ppPlan[ppKey(day, shift)] || {};
      if (PP_FIELDS.every(f => (v[f] ?? null) === (saved[f] ?? null))) delete ppEdits[ppKey(day, shift)];
      else ppEdits[ppKey(day, shift)] = v;
      filled++;
    });
  });
  toggleModal("modal-pp-fill", false);
  ppRender();
  ppShowBanner(filled ? "success" : "warning", filled
    ? `Wypełniono ${filled} zmian na linii ${ppLine}. Sprawdź i kliknij „Zapisz plan”.`
    : "Żadna zmiana nie pasowała (zakończone, weekend albo już zaplanowane).");
}
