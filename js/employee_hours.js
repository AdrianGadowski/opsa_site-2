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

  body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:30px;">
    <i class="fa-solid fa-spinner fa-spin"></i> Ładowanie godzin...</td></tr>`;

  try {
    const rows = await rpFetchAll(() => supabaseClient
      .from("work_reports")
      .select("id, report_date, shift, start_time, end_time, total_hours, at_work, number_report")
      .eq("first_name_id", ehEmpId)
      .like("report_date", `%.${month}.${year}`));
    if (token !== ehLoadToken) return; // zmieniono miesiąc albo zamknięto okno

    ehRender(rows, Number(year), Number(month));
  } catch (err) {
    if (token !== ehLoadToken) return;
    console.error("Błąd pobierania godzin pracownika:", err);
    document.getElementById("eh-tiles").innerHTML = "";
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--danger);padding:25px;">
      Nie udało się pobrać godzin: ${rtEsc(err.message || err)}</td></tr>`;
  }
}

// Buduje kafelki podsumowania i wiersze tabeli miesiąca (używane też w portalu pracownika)
function ehBuild(rows, year, month) {
  const byDay = new Map();
  let present = 0, absent = 0;
  const workDays = new Set(), absentDays = new Set();

  rows.forEach(r => {
    const day = Number(String(r.report_date || "").split(".")[0]);
    const hours = parseFloat(r.total_hours) || 0;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);

    if (r.at_work === false) {
      absent += hours;
      absentDays.add(day);
    } else {
      present += hours;
      workDays.add(day);
    }
  });

  const tilesHtml = `
    <div class="eh-tile ok"><div class="lbl">Godziny przepracowane</div><div class="val">${rtFmtHours(present)}</div></div>
    <div class="eh-tile absent"><div class="lbl">Godziny nieobecne</div><div class="val">${rtFmtHours(absent)}</div></div>
    <div class="eh-tile"><div class="lbl">Dni pracy</div><div class="val">${workDays.size}</div></div>
    <div class="eh-tile"><div class="lbl">Dni z nieobecnością</div><div class="val">${absentDays.size}</div></div>`;

  // Cały miesiąc dzień po dniu; dni bez wpisu też mają wiersz
  const daysInMonth = new Date(year, month, 0).getDate();
  const mm = String(month).padStart(2, "0");
  let html = "";

  for (let day = 1; day <= daysInMonth; day++) {
    const weekday = new Date(year, month - 1, day).getDay();
    const cls = weekday === 6 ? "sat" : weekday === 0 ? "sun" : "";
    const dayCell = `<td><span class="day">${String(day).padStart(2, "0")}.${mm}</span><span class="wd">${EH_WEEKDAYS[weekday]}</span></td>`;
    const entries = (byDay.get(day) || []).sort((a, b) =>
      String(a.start_time || "").localeCompare(String(b.start_time || "")));

    if (entries.length === 0) {
      html += `<tr class="none ${cls}">${dayCell}<td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`;
      continue;
    }

    entries.forEach(r => {
      html += `
        <tr class="${cls}">
          ${dayCell}
          <td>${rtEsc(r.shift || "-")}</td>
          <td>${rtEsc(r.start_time || "-")}</td>
          <td>${rtEsc(r.end_time || "-")}</td>
          <td class="hrs${r.at_work === false ? " absent" : ""}">${rtFmtHours(parseFloat(r.total_hours) || 0)}</td>
          <td>${r.at_work === false
            ? `<span class="eh-pill absent">Nieobecność</span>`
            : `<span class="eh-pill ok">Obecność</span>`}</td>
          <td>${rtEsc(r.number_report ?? "-")}</td>
        </tr>`;
    });
  }

  return { tilesHtml, bodyHtml: html };
}

function ehRender(rows, year, month) {
  const built = ehBuild(rows, year, month);
  document.getElementById("eh-tiles").innerHTML = built.tilesHtml;
  document.getElementById("eh-body").innerHTML = built.bodyHtml;
}
