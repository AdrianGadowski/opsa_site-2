// ==========================================
// MODUŁ: PODGLĄD GODZIN PRACOWNIKA (okno w bazie pracowników)
// Źródło: work_reports dla jednego pracownika i wybranego miesiąca
// Wymaga: supabaseClient, cachedEmployees, toggleModal (app.js), rt* (report_time.js),
//         rpFetchAll / RP_MONTHS / RP_YEARS_BACK (reports.js)
// ==========================================

const EH_WEEKDAYS = ["niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota"];

let ehEmpId = null;
let ehLoadToken = 0;

function ehOpen(empId) {
  const emp = cachedEmployees.find(e => Number(e.id) === Number(empId));
  if (!emp) return;
  ehEmpId = emp.id;

  document.getElementById("eh-name").textContent =
    `${emp.first_name || ""} ${emp.last_name || ""}`.trim() || `Pracownik #${emp.id}`;
  document.getElementById("eh-sub").textContent =
    `${emp.business?.business || "Brak firmy"} • ${emp.department?.department || "Brak działu"}`;

  // Przy każdym otwarciu: bieżący rok i miesiąc
  const now = new Date();
  const y = now.getFullYear();
  const current = String(now.getMonth() + 1).padStart(2, "0");
  document.getElementById("eh-year").innerHTML = Array.from({ length: RP_YEARS_BACK + 1 }, (_, i) =>
    `<option value="${y - i}">${y - i}</option>`).join("");
  document.getElementById("eh-month").innerHTML = RP_MONTHS.map((name, i) => {
    const v = String(i + 1).padStart(2, "0");
    return `<option value="${v}"${v === current ? " selected" : ""}>${name}</option>`;
  }).join("");

  toggleModal("modal-eh", true);
  ehLoad();
}

function ehClose() {
  ehEmpId = null;
  ehLoadToken++;
  toggleModal("modal-eh", false);
}

async function ehLoad() {
  const body = document.getElementById("eh-body");
  if (!body || ehEmpId === null) return;

  const year = document.getElementById("eh-year").value;
  const month = document.getElementById("eh-month").value;
  const token = ++ehLoadToken;

  body.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:30px;">
    <i class="fa-solid fa-spinner fa-spin"></i> Ładowanie godzin...</td></tr>`;

  try {
    const [rows, gate] = await Promise.all([
      ehFetchMonth(ehEmpId, year, month, await rpaApprovedOnly()),
      ehFetchGate(ehEmpId, Number(year), Number(month))
    ]);
    if (token !== ehLoadToken) return; // zmieniono miesiąc albo zamknięto okno

    ehRender(rows, Number(year), Number(month), gate);
  } catch (err) {
    if (token !== ehLoadToken) return;
    console.error("Błąd pobierania godzin pracownika:", err);
    document.getElementById("eh-tiles").innerHTML = "";
    document.getElementById("eh-pending-note").style.display = "none";
    body.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--danger);padding:25px;">
      Nie udało się pobrać godzin: ${rtEsc(err.message || err)}</td></tr>`;
  }
}

// Godziny z miesiąca: zatwierdzone i do zatwierdzenia, odrzucone raporty są ukryte
// (sql/34; przed nim nie ma statusu - wszystkie raporty). Używane też w portalu pracownika.
function ehFetchMonth(empId, year, month, hasStatus) {
  return rpFetchAll(() => {
    const query = supabaseClient
      .from("work_reports")
      .select(`id, report_date, shift, start_time, end_time, total_hours, at_work, number_report${hasStatus ? ", approval_status" : ""}`)
      .eq("first_name_id", empId)
      .like("report_date", `%.${month}.${year}`);
    return hasStatus ? query.in("approval_status", ["approved", "pending"]) : query;
  });
}

// Odbicia z bramy pracownika w miesiącu (sql/46): { "RRRR-MM-DD": [odbicia] } według dnia zmiany.
// Bez tabeli albo dostępu - "error" (kolumny z kreskami). Błąd nie blokuje godzin.
async function ehFetchGate(empId, year, month) {
  const mm = String(month).padStart(2, "0");
  const last = String(new Date(year, month, 0).getDate()).padStart(2, "0");
  try {
    const { data, error } = await supabaseClient
      .from("gate_entries")
      .select("work_date, shift, entry_at, exit_at")
      .eq("employee_id", empId)
      .gte("work_date", `${year}-${mm}-01`)
      .lte("work_date", `${year}-${mm}-${last}`);
    if (error) throw error;
    const byDay = {};
    (data || []).sort((a, b) => String(a.entry_at || a.exit_at || "").localeCompare(String(b.entry_at || b.exit_at || "")))
      .forEach(g => { (byDay[g.work_date] ||= []).push(g); });
    return byDay;
  } catch (err) {
    console.warn("Odbicia z bramy niedostępne w podglądzie godzin:", err.message || err);
    return "error";
  }
}

// Odbicie dla wpisu: z tej samej zmiany co wpis, inaczej pierwsze w dniu
function ehGateEntry(gate, iso, shift) {
  const list = !gate || gate === "error" ? [] : (gate[iso] || []);
  return list.find(g => shift && g.shift === shift) || list[0];
}

// Od / Do zgodne z bramą: Od - wejście przed nią (albo o niej), Do - wyjście po niej (albo o niej).
// Zielone / czerwone; brak odbicia = czerwone. Nieobecność i brak danych z bramy - bez koloru.
function ehGateMatch(gate, iso, r, which) {
  if (!gate || gate === "error" || r.at_work === false || !r.start_time || !r.end_time) return "";
  const e = ehGateEntry(gate, iso, r.shift);
  const at = which === "from" ? e?.entry_at : e?.exit_at;
  const title = ok => which === "from"
    ? (ok ? "Wejście z bramy przed rozpoczęciem pracy" : "Godzina rozpoczęcia nie zgadza się z wejściem z bramy")
    : (ok ? "Wyjście z bramy po zakończeniu pracy" : "Godzina zakończenia nie zgadza się z wyjściem z bramy");
  if (!at) return ` class="eh-gate-bad" title="${title(false)}"`;
  // godziny wpisu na osi czasu dnia (Do przed Od = następny dzień, np. III zmiana)
  const toMs = hm => Date.parse(`${iso}T${String(hm).slice(0, 5)}:00Z`);
  const start = toMs(r.start_time);
  let end = toMs(r.end_time);
  if (end <= start) end += 86400000;
  const g = Date.parse(`${String(at).slice(0, 16)}:00Z`);
  const ok = which === "from" ? g <= start : g >= end;
  return ` class="${ok ? "eh-gate-ok" : "eh-gate-bad"}" title="${title(ok)}"`;
}

// Komórki Wejście / Wyjście
function ehGateCells(gate, iso, shift) {
  if (gate === undefined) return "";
  const e = ehGateEntry(gate, iso, shift);
  const title = gate === "error" ? "Odbicia z bramy są niedostępne" : e ? "" : "Brak odbicia z bramy w tym dniu";
  const t = title ? ` title="${title}"` : "";
  return `<td class="eh-gate"${t}>${rpGateTime(e?.entry_at, iso)}</td><td class="eh-gate"${t}>${rpGateTime(e?.exit_at, iso)}</td>`;
}

// Buduje kafelki podsumowania i wiersze tabeli miesiąca (używane też w portalu pracownika).
// gate (tylko Baza pracowników) - odbicia z bramy; bez niego tabela nie ma kolumn Wejście / Wyjście.
function ehBuild(rows, year, month, gate) {
  const byDay = new Map();
  let present = 0, absent = 0;
  let pendP = 0, pendA = 0;    // do zatwierdzenia: osobno, poza głównymi liczbami
  const workDays = new Set(), absentDays = new Set();

  rows.forEach(r => {
    const day = Number(String(r.report_date || "").split(".")[0]);
    const hours = parseFloat(r.total_hours) || 0;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);

    if (r.approval_status === "pending") {
      if (r.at_work === false) pendA += hours;
      else pendP += hours;
    } else if (r.at_work === false) {
      absent += hours;
      absentDays.add(day);
    } else {
      present += hours;
      workDays.add(day);
    }
  });

  const pendNote = hours => (hours > 0 ? `<div class="pend">+ ${rtFmtHours(hours)} do zatwierdzenia</div>` : "");
  const tilesHtml = `
    <div class="eh-tile ok"><div class="lbl">Godziny przepracowane</div><div class="val">${rtFmtHours(present)}</div>${pendNote(pendP)}</div>
    <div class="eh-tile absent"><div class="lbl">Godziny nieobecne</div><div class="val">${rtFmtHours(absent)}</div>${pendNote(pendA)}</div>
    <div class="eh-tile"><div class="lbl">Dni pracy</div><div class="val">${workDays.size}</div></div>
    <div class="eh-tile"><div class="lbl">Dni z nieobecnością</div><div class="val">${absentDays.size}</div></div>`;

  // Cały miesiąc dzień po dniu; dni bez wpisu też mają wiersz
  const daysInMonth = new Date(year, month, 0).getDate();
  const mm = String(month).padStart(2, "0");
  let html = "";

  for (let day = 1; day <= daysInMonth; day++) {
    const weekday = new Date(year, month - 1, day).getDay();
    const cls = weekday === 6 ? "sat" : weekday === 0 ? "sun" : "";
    const iso = `${year}-${mm}-${String(day).padStart(2, "0")}`;
    const dayCell = `<td><span class="day">${String(day).padStart(2, "0")}.${mm}</span><span class="wd">${EH_WEEKDAYS[weekday]}</span></td>`;
    const entries = (byDay.get(day) || []).sort((a, b) =>
      String(a.start_time || "").localeCompare(String(b.start_time || "")));

    if (entries.length === 0) {
      html += `<tr class="none ${cls}">${dayCell}<td>—</td><td>—</td><td>—</td><td>—</td>${ehGateCells(gate, iso, null)}<td>—</td><td>—</td></tr>`;
      continue;
    }

    entries.forEach(r => {
      const pending = r.approval_status === "pending";
      html += `
        <tr class="${cls}${pending ? " pending" : ""}">
          ${dayCell}
          <td>${rtEsc(r.shift || "-")}</td>
          <td${ehGateMatch(gate, iso, r, "from")}>${rtEsc(r.start_time || "-")}</td>
          <td${ehGateMatch(gate, iso, r, "to")}>${rtEsc(r.end_time || "-")}</td>
          <td class="hrs${r.at_work === false ? " absent" : ""}">${rtFmtHours(parseFloat(r.total_hours) || 0)}</td>
          ${ehGateCells(gate, iso, r.shift)}
          <td>${r.at_work === false
            ? `<span class="eh-pill absent">Nieobecność</span>`
            : pending ? "" : `<span class="eh-pill ok">Obecność</span>`}${pending ? `<span class="eh-pill wait"><i class="fa-solid fa-hourglass-half"></i> Do zatwierdzenia</span>` : ""}</td>
          <td>${rtEsc(r.number_report ?? "-")}</td>
        </tr>`;
    });
  }

  return { tilesHtml, bodyHtml: html, hasPending: pendP + pendA > 0 };
}

function ehRender(rows, year, month, gate) {
  const built = ehBuild(rows, year, month, gate);
  document.getElementById("eh-tiles").innerHTML = built.tilesHtml;
  document.getElementById("eh-body").innerHTML = built.bodyHtml;
  document.getElementById("eh-pending-note").style.display = built.hasPending ? "" : "none";
}
