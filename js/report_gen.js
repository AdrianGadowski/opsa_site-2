// ==========================================
// MODUŁ: GENEROWANIE RAPORTÓW PDF
// Uprawnienie: users.allow_report_generate (sql/45_generowanie_raportow.sql).
// Raporty powstają tylko dla zamkniętego miesiąca (Closed_Periods) i tylko z zatwierdzonych raportów.
//   * raport pracownika: formatka Flowline albo wspólna MDB / Depo, układ jak w starym programie
//     (employee_list.py): cała zawartość zmniejszona proporcjonalnie na jedną stronę A4,
//   * zestawienie zbiorcze firmy: pracownicy, godziny obecne i nieobecne, miejsce na podpis, sumy na końcu.
// Zbiorczo: Chrome / Edge zapisują do wskazanego folderu (reports/rok/firma/MM_miesiąc), inne przeglądarki - ZIP.
// Biblioteki (jsPDF, JSZip) i czcionka ładują się dopiero przy pierwszym generowaniu.
// Czcionka Liberation Sans: te same szerokości znaków co Arial, polskie i ukraińskie litery, licencja OFL.
// Wymaga: supabaseClient, logAction (app.js), rtEsc (report_time.js), rpFetchAll, RP_MONTHS (reports.js),
//         rpaApprovedOnly, rpaFilterApproved (report_approval.js), opIsLocked (options.js).
// ==========================================

const RG_JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
const RG_JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
const RG_FONT_URL = "fonts/LiberationSans-Regular.ttf";
const RG_FONT = "LiberationSans";
const RG_ASCENT = 0.905;                 // linia bazowa tekstu w wierszu (jak czcionka Arial w starym programie)
const RG_A4 = { w: 595.28, h: 841.89 };
const RG_LOGOS = { flowline: "images/flow_logo.png", depo: "images/depo_logo.png", mdb: "images/mdb_logo.png" };
const RG_NO_FIRM = "Brak firmy";

let rgYear = 0;
let rgMonth = 0;                         // 1-12
let rgClosed = false;
let rgPeople = [];                       // [{ id, first, last, firm, dept, present, absent, days }]
let rgLoadToken = 0;
let rgBusy = false;
let rgFontBase64 = null;
const rgLogoCache = {};

// ---------- Start i wybór miesiąca ----------
async function initReportGenView() {
  const now = new Date();
  // domyślnie poprzedni miesiąc - bieżący zwykle nie jest jeszcze zamknięty
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  rgYear = prev.getFullYear();
  rgMonth = prev.getMonth() + 1;
  await rgLoad();
}

function rgStep(delta) {
  if (rgBusy) return;
  const d = new Date(rgYear, rgMonth - 1 + delta, 1);
  const now = new Date();
  if (d > new Date(now.getFullYear(), now.getMonth(), 1)) return;
  rgYear = d.getFullYear();
  rgMonth = d.getMonth() + 1;
  rgLoad();
}

function rgMm() {
  return String(rgMonth).padStart(2, "0");
}

function rgMonthName() {
  return RP_MONTHS[rgMonth - 1];
}

function rgBanner(type, text) {
  const el = document.getElementById("rg-banner");
  if (!el) return;
  el.className = `rg-banner${text ? ` visible ${type}` : ""}`;
  el.textContent = text || "";
}

// ---------- Dane ----------
async function rgLoad() {
  const content = document.getElementById("rg-content");
  if (!content) return;
  const token = ++rgLoadToken;
  rgPeople = [];
  rgBanner("", "");
  document.getElementById("rg-month").textContent = `${rgMonthName()} ${rgYear}`;
  const now = new Date();
  document.getElementById("rg-next").disabled = rgYear === now.getFullYear() && rgMonth === now.getMonth() + 1;
  content.innerHTML = `<div class="card rg-empty"><i class="fa-solid fa-spinner fa-spin"></i> Ładowanie...</div>`;

  try {
    rgClosed = await opIsLocked(`${rgYear}-${rgMm()}`);
    if (token !== rgLoadToken) return;
    if (!rgClosed) {
      content.innerHTML = `
        <div class="card rg-closed">
          <i class="fa-solid fa-lock-open"></i>
          <b>${rtEsc(rgMonthName())} ${rgYear} nie jest zamknięty</b>
          <span>Raporty można wygenerować po zamknięciu miesiąca (Opcje → Blokada miesiąca).</span>
        </div>`;
      return;
    }

    const approved = await rpaApprovedOnly();
    const [employees, users, rows] = await Promise.all([
      rpFetchAll(() => supabaseClient.from("employees").select(`
        id, first_name, last_name,
        business:business_id ( business ),
        department:department_id ( department )`)),
      rpFetchAll(() => supabaseClient.from("users").select("id, name, last_name")),
      rpFetchAll(() => rpaFilterApproved(supabaseClient
        .from("work_reports")
        .select("report_date, shift, start_time, end_time, total_hours, at_work, first_name_id, add_first_name_id")
        .like("report_date", `%.${rgMm()}.${rgYear}`), approved))
    ]);
    if (token !== rgLoadToken) return;
    rgPeople = rgBuildPeople(employees, users, rows);
    rgRender();
  } catch (err) {
    if (token !== rgLoadToken) return;
    console.error("Błąd pobierania danych raportów:", err);
    content.innerHTML = "";
    rgBanner("error", "Nie udało się pobrać danych: " + (err.message || err));
  }
}

// Kolejność zmian w dniu: I, II, III, potem reszta
function rgShiftOrder(shift) {
  const s = String(shift || "").toUpperCase();
  if (/\bIII\b|3/.test(s)) return 3;
  if (/\bII\b|2/.test(s)) return 2;
  if (/\bI\b|1/.test(s)) return 1;
  return 4;
}

function rgBuildPeople(employees, users, rows) {
  const empById = new Map(employees.map(e => [Number(e.id), e]));
  const authorById = new Map(users.map(u => [Number(u.id), `${u.name || ""} ${u.last_name || ""}`.trim()]));
  const time = t => (t ? String(t).slice(0, 5) : "-");
  const byEmp = new Map();

  rows.forEach(r => {
    const id = Number(r.first_name_id);
    let person = byEmp.get(id);
    if (!person) {
      const e = empById.get(id);
      person = {
        id,
        first: String(e?.first_name || "").trim(),
        last: String(e?.last_name || (e ? "" : `Pracownik #${id}`)).trim(),
        firm: String(e?.business?.business || "").trim() || RG_NO_FIRM,
        dept: String(e?.department?.department || "").trim() || "Nieznany",
        present: 0,
        absent: 0,
        days: new Map()
      };
      byEmp.set(id, person);
    }
    const hours = parseFloat(String(r.total_hours ?? "").replace(",", ".")) || 0;
    const away = r.at_work === false;
    if (away) person.absent += hours; else person.present += hours;
    const day = String(r.report_date || "").trim();
    if (!person.days.has(day)) person.days.set(day, []);
    person.days.get(day).push({
      away,
      shift: r.shift || "",
      from: time(r.start_time),
      to: time(r.end_time),
      hours,
      author: authorById.get(Number(r.add_first_name_id)) || "-"
    });
  });

  // w dniu: według zmian; przy tej samej zmianie najpierw praca, potem nieobecność
  byEmp.forEach(p => p.days.forEach(list => list.sort((a, b) =>
    rgShiftOrder(a.shift) - rgShiftOrder(b.shift) || Number(a.away) - Number(b.away))));

  return [...byEmp.values()].sort((a, b) =>
    `${a.last} ${a.first}`.localeCompare(`${b.last} ${b.first}`, "pl"));
}

function rgFirms() {
  return [...new Set(rgPeople.map(p => p.firm))].sort((a, b) => a.localeCompare(b, "pl"));
}

function rgLogoUrl(firm) {
  return RG_LOGOS[String(firm).trim().toLowerCase()] || null;
}

// Godziny jak w starych raportach: 8 albo 5.5
function rgHours(v) {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

function rgTotal(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

// ---------- Widok ----------
function rgRender() {
  const content = document.getElementById("rg-content");
  if (!content) return;
  if (!rgPeople.length) {
    content.innerHTML = `
      <div class="card rg-closed">
        <i class="fa-solid fa-file-circle-xmark"></i>
        <b>Brak zatwierdzonych raportów</b>
        <span>W miesiącu ${rtEsc(rgMonthName())} ${rgYear} nie ma godzin do wygenerowania.</span>
      </div>`;
    return;
  }

  const tiles = rgFirms().map((firm, i) => {
    const people = rgPeople.filter(p => p.firm === firm);
    const present = people.reduce((s, p) => s + p.present, 0);
    const absent = people.reduce((s, p) => s + p.absent, 0);
    const logo = rgLogoUrl(firm);
    return `
      <div class="rg-firm">
        <div class="rg-firm-head"><b>${rtEsc(firm)}</b>${logo ? `<img src="${logo}" alt="" />` : ""}</div>
        <div class="rg-firm-nums">
          <div><b>${people.length}</b><span>pracowników</span></div>
          <div><b class="ok">${rgTotal(present)}</b><span>godz. obecne</span></div>
          <div><b class="no">${rgTotal(absent)}</b><span>godz. nieobecne</span></div>
        </div>
        <div class="rg-firm-btns">
          <button type="button" class="rg-btn main" data-rg-action onclick="rgSaveSummary(${i})"><i class="fa-solid fa-file-pdf"></i> Raport zbiorczy</button>
          <button type="button" class="rg-btn" data-rg-action onclick="rgBulkPeople(${i})"><i class="fa-solid fa-folder-open"></i> Raporty pracowników</button>
        </div>
      </div>`;
  }).join("");

  const firmOptions = rgFirms().map((firm, i) => `<option value="${i}">${rtEsc(firm)}</option>`).join("");
  content.innerHTML = `
    <div class="rg-all">
      <h4>Firmy</h4>
      <div class="rg-all-btns">
        <button type="button" class="rg-btn" data-rg-action onclick="rgBulkSummaries()"><i class="fa-solid fa-layer-group"></i> Wszystkie raporty zbiorcze</button>
        <button type="button" class="rg-btn main" data-rg-action onclick="rgBulkPeople(null)"><i class="fa-solid fa-folder-open"></i> Wszystkie raporty pracowników</button>
      </div>
    </div>
    <div class="rg-firms">${tiles}</div>
    <div class="card" style="padding: 0; overflow: hidden;">
      <div class="rg-tools">
        <input type="text" id="rg-search" class="form-control" placeholder="Szukaj pracownika..." oninput="rgRenderList()" autocomplete="off" aria-label="Szukaj pracownika" />
        <select id="rg-firm" class="form-control" onchange="rgRenderList()" aria-label="Firma">
          <option value="">Wszystkie firmy</option>${firmOptions}
        </select>
      </div>
      <div style="overflow-x: auto;">
        <table class="rg-table">
          <thead><tr><th>Pracownik</th><th>Firma</th><th>Dział</th><th>Obecne</th><th>Nieobecne</th><th></th></tr></thead>
          <tbody id="rg-list"></tbody>
        </table>
      </div>
    </div>`;
  rgRenderList();
}

function rgRenderList() {
  const body = document.getElementById("rg-list");
  if (!body) return;
  const q = (document.getElementById("rg-search").value || "").toLowerCase().trim();
  const firmIdx = document.getElementById("rg-firm").value;
  const firm = firmIdx === "" ? null : rgFirms()[Number(firmIdx)];
  const list = rgPeople.filter(p => (!firm || p.firm === firm) &&
    (!q || `${p.first} ${p.last}`.toLowerCase().includes(q) || `${p.last} ${p.first}`.toLowerCase().includes(q)));
  body.innerHTML = list.length ? list.map(p => `
    <tr>
      <td data-label="Pracownik"><b>${rtEsc(p.last)}</b> ${rtEsc(p.first)}</td>
      <td data-label="Firma">${rtEsc(p.firm)}</td>
      <td data-label="Dział">${rtEsc(p.dept)}</td>
      <td data-label="Obecne" class="ok">${rgTotal(p.present)} h</td>
      <td data-label="Nieobecne" class="no">${rgTotal(p.absent)} h</td>
      <td data-label=""><button type="button" class="rg-btn" data-rg-action onclick="rgSavePerson(${p.id})"><i class="fa-solid fa-file-pdf"></i> PDF</button></td>
    </tr>`).join("") : `<tr><td colspan="6" class="rg-empty">Brak pracowników</td></tr>`;
  rgSyncBusy();
}

function rgSyncBusy() {
  document.querySelectorAll("#rg-content [data-rg-action]").forEach(b => { b.disabled = rgBusy; });
}

// ---------- Biblioteki, czcionka, logo ----------
function rgLoadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Nie udało się pobrać biblioteki. Sprawdź połączenie z internetem."));
    document.head.appendChild(s);
  });
}

function rgBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

async function rgFetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nie udało się pobrać pliku ${url} (${res.status}).`);
  return res.arrayBuffer();
}

async function rgReadyPdf() {
  if (!window.jspdf) await rgLoadScript(RG_JSPDF_URL);
  if (!rgFontBase64) rgFontBase64 = rgBase64(await rgFetchBuffer(RG_FONT_URL));
}

async function rgLogo(firm) {
  const url = rgLogoUrl(firm);
  if (!url) return null;
  if (!rgLogoCache[url]) rgLogoCache[url] = new Uint8Array(await rgFetchBuffer(url));
  return rgLogoCache[url];
}

function rgNewDoc() {
  const doc = new window.jspdf.jsPDF({ unit: "pt", format: "a4", compress: true });
  doc.addFileToVFS(`${RG_FONT}.ttf`, rgFontBase64);
  doc.addFont(`${RG_FONT}.ttf`, RG_FONT, "normal");
  doc.setFont(RG_FONT, "normal");
  return doc;
}

// ---------- Rysowanie: wszystko w jednostkach układu, przeskalowane o s od punktu (ox, oy) ----------
function rgPen(doc, s, ox, oy) {
  return {
    s,
    rect(x, y, w, h, fill) {
      doc.setFillColor(fill);
      doc.rect(ox + x * s, oy + y * s, w * s, h * s, "F");
    },
    box(x, y, w, h, color, width = 0.5) {
      doc.setDrawColor(color);
      doc.setLineWidth(width * s);
      doc.rect(ox + x * s, oy + y * s, w * s, h * s, "S");
    },
    line(x1, y1, x2, y2, color, width = 0.5) {
      doc.setDrawColor(color);
      doc.setLineWidth(width * s);
      doc.line(ox + x1 * s, oy + y1 * s, ox + x2 * s, oy + y2 * s);
    },
    // y = górna krawędź wiersza tekstu
    text(str, x, y, size, color = "#000000", align = "left") {
      doc.setFontSize(size * s);
      doc.setTextColor(color);
      doc.text(String(str), ox + x * s, oy + (y + size * RG_ASCENT) * s, { align });
    },
    image(data, x, y, w, h) {
      doc.addImage(data, "PNG", ox + x * s, oy + y * s, w * s, h * s);
    }
  };
}

// Wiersze tekstu mierzone w rozmiarze układu (bez skali)
function rgWrap(doc, text, width, size) {
  doc.setFontSize(size);
  return doc.splitTextToSize(String(text), width);
}

// Przygotowanie tabeli: wysokości wierszy z zawijaniem tekstu (marginesy komórek 6 pt jak w starym programie)
function rgMeasure(doc, cols, rows, pad) {
  rows.forEach(row => {
    row.lines = row.cells.map((c, i) => rgWrap(doc, c.t, cols[i] - 12, row.size));
    row.h = Math.max(...row.lines.map(l => l.length)) * row.lead + pad * 2;
  });
  return rows.reduce((sum, r) => sum + r.h, 0);
}

function rgDrawTable(pen, x, y, cols, rows, grid) {
  const width = cols.reduce((a, b) => a + b, 0);
  let top = y;
  rows.forEach(row => {
    if (row.bg) pen.rect(x, top, width, row.h, row.bg);
    let left = x;
    row.cells.forEach((c, i) => {
      const lines = row.lines[i];
      const start = top + (row.h - lines.length * row.lead) / 2;
      lines.forEach((line, n) => pen.text(line, left + cols[i] / 2, start + n * row.lead, row.size, c.c || row.color, "center"));
      left += cols[i];
    });
    top += row.h;
  });
  // siatka na wierzchu tła
  let lineY = y;
  pen.line(x, lineY, x + width, lineY, grid);
  rows.forEach(row => {
    lineY += row.h;
    pen.line(x, lineY, x + width, lineY, grid);
  });
  let lineX = x;
  pen.line(lineX, y, lineX, lineY, grid);
  cols.forEach(w => {
    lineX += w;
    pen.line(lineX, y, lineX, lineY, grid);
  });
  return lineY;
}

// Wiersze tabeli godzin: każdy dzień miesiąca, wiersze nieobecności na czerwono; bez powodu nieobecności
function rgHourRows(person, style) {
  const rows = [{
    size: style.headSize, lead: style.headLead, color: "#FFFFFF", bg: "#1F77B4",
    cells: ["Data", "Zmiana", "Od - Do", "Suma godzin", "Wystawił raport / Uwagi"].map(t => ({ t }))
  }];
  const days = new Date(rgYear, rgMonth, 0).getDate();
  const body = (cells, absence) => {
    const index = rows.length;
    rows.push({
      size: style.size, lead: style.lead, color: "#000000", cells,
      bg: absence ? "#FDF2F2" : index % 2 === 0 ? "#F9F9FB" : null
    });
  };
  const red = "#D9383A";
  for (let d = 1; d <= days; d++) {
    const date = `${String(d).padStart(2, "0")}.${rgMm()}.${rgYear}`;
    const entries = person.days.get(date);
    if (!entries) {
      body([{ t: date }, { t: "-" }, { t: "-" }, { t: "0 godz." }, { t: "-" }], false);
      continue;
    }
    entries.forEach((e, i) => {
      const range = e.from === "-" && e.away ? "-" : `${e.from} - ${e.to}`;
      body(e.away
        ? [{ t: i ? "" : date }, { t: `${e.shift ? `${e.shift} - ` : ""}Nieobecność`, c: red }, { t: range }, { t: `${rgHours(e.hours)} godz.` }, { t: e.author, c: red }]
        : [{ t: i ? "" : date }, { t: e.shift }, { t: range }, { t: `${rgHours(e.hours)} godz.` }, { t: e.author }], e.away);
    });
  }
  return rows;
}

// Skala jak "KeepInFrame" w starym programie: całość na jednej stronie, dostępne miejsce pomniejszone o 12 pt
function rgFit(contentW, contentH, availW, availH) {
  return Math.min(1, availW / contentW, availH / contentH);
}

// ---------- Raport pracownika: MDB, Depo i inne firmy ----------
async function rgDocStandard(person) {
  const doc = rgNewDoc();
  const logo = await rgLogo(person.firm);
  const cols = [70, 130, 80, 80, 200];
  const tableW = 560;
  const rows = rgHourRows(person, { headSize: 9, headLead: 11, size: 8, lead: 10 });
  const tableH = rgMeasure(doc, cols, rows, 2.5);

  const headerH = 46;
  const contentH = headerH + 8 + 14 + 10 + tableH + 12 + 14 + 4 + 14;
  const margin = 25;
  const availW = RG_A4.w - margin * 2 - 12;
  const availH = RG_A4.h - margin * 2 - 12;
  const s = rgFit(tableW, contentH, availW, availH);
  const pen = rgPen(doc, s, margin + 6, margin + 6);
  const frameW = availW / s;
  const tableX = (frameW - tableW) / 2;      // tabele na środku, zwykły tekst od lewej krawędzi

  pen.text("Miesięczny raport godzinowy i nieobecności", tableX + 6, 3, 16, "#333333");
  pen.text(`Okres raportowania: ${rgMonthName()} ${rgYear}`, tableX + 6, 29, 10, "#666666");
  if (logo) pen.image(logo, tableX + tableW - 6 - 114, (headerH - 31) / 2, 114, 31);

  let y = headerH + 8;
  pen.text(`Pracownik: ${person.first} ${person.last} | Firma: ${person.firm} | Dział: ${person.dept}`, 0, y, 10, "#222222");
  y += 14 + 10;
  y = rgDrawTable(pen, tableX, y, cols, rows, "#E5E5EA") + 12;
  pen.text(`Suma godzin przepracowanych w miesiącu: ${rgTotal(person.present)} godz.`, 0, y, 11, "#2EA44F");
  y += 14 + 4;
  pen.text(`Suma godzin nieobecności w miesiącu: ${rgTotal(person.absent)} godz.`, 0, y, 11, "#D9383A");
  return doc;
}

// ---------- Raport pracownika: formatka Flowline ----------
const RG_FL_PL = [
  "Pamiętaj!",
  "Raport godzinowy jest dokumentem, na podstawie którego następuje rozliczenie z pracodawcą.",
  "- Naliczenie wynagrodzenia następuje wyłącznie po przedstawieniu raportu."
];
const RG_FL_UA = [
  "Пам'ятай!",
  "- Облік робочого часу є документом, на підставі якого відбувається розрахунок з роботодавцем",
  "- Нарахування заробітної плати відбувається тільки після представлення обліку робочого часу"
];

async function rgDocFlowline(person) {
  const doc = rgNewDoc();
  const logo = await rgLogo(person.firm);
  const cols = [65, 115, 85, 80, 200];
  const tableW = 545;
  const rows = rgHourRows(person, { headSize: 8, headLead: 10, size: 7.5, lead: 9 });
  const tableH = rgMeasure(doc, cols, rows, 1.6);

  const noteLines = (list, width) => list.flatMap(t => rgWrap(doc, t, width, 6.5));
  const notePl = noteLines(RG_FL_PL, 270);
  const noteUa = noteLines(RG_FL_UA, 275);
  const noteH = Math.max(notePl.length, noteUa.length) * 8 + 2;

  const contentH = 32 + 4 + 15 + 6 + 30 + 6 + tableH + 5 + 32 + 5 + noteH + 4 + 9;
  const marginX = 25;
  const marginY = 20;
  const availW = RG_A4.w - marginX * 2 - 12;
  const availH = RG_A4.h - marginY * 2 - 12;
  const s = rgFit(tableW, contentH, availW, availH);
  const pen = rgPen(doc, s, marginX + 6, marginY + 6);
  const frameW = availW / s;
  const x = (frameW - tableW) / 2;

  if (logo) pen.image(logo, x + 6, 0, 120, 32);
  else pen.text("flowline", x + 6, 8, 16, "#1F77B4");
  let y = 32 + 4;

  pen.text("RAPORT WYKONANIA USŁUGI", frameW / 2, y, 12, "#000000", "center");
  y += 15 + 6;

  const month = `${rgMm()}/${rgYear}`;
  pen.text(`Imię i nazwisko pracownika: ${person.first} ${person.last}`, x, y + 2, 8.5);
  pen.text(`Miesiąc: ${month}`, x + 335, y + 2, 8.5);
  pen.text("Zakład pracy: ODLEWNIE POLSKIE S.A", x, y + 17, 8.5);
  pen.text("Adres: STARACHOWICE, ul. ROGOWSKIEGO 22", x + 335, y + 17, 8.5);
  y += 30 + 6;

  y = rgDrawTable(pen, x, y, cols, rows, "#D0D0D0") + 5;

  // podsumowanie i miejsce na podpisy
  const sum = [135, 140, 135, 135];
  const boxH = 32;
  pen.rect(x, y, sum[0], boxH, "#F4F8FA");
  pen.rect(x + sum[0], y, sum[1], boxH, "#FDF2F2");
  pen.box(x, y, tableW, boxH, "#888888");
  let left = x;
  sum.slice(0, 3).forEach(w => {
    left += w;
    pen.line(left, y, left, y + boxH, "#888888");
  });
  const center = i => x + sum.slice(0, i).reduce((a, b) => a + b, 0) + sum[i] / 2;
  pen.text("Łączna liczba godzin pracy:", center(0), y + 2, 7.5, "#000000", "center");
  pen.text(`${rgTotal(person.present)} godz.`, center(0), y + 12, 9, "#2EA44F", "center");
  pen.text("Łączna liczba godzin nieobecności:", center(1), y + 2, 7.5, "#000000", "center");
  pen.text(`${rgTotal(person.absent)} godz.`, center(1), y + 12, 9, "#D9383A", "center");
  pen.text("Data, podpis pracownika:", center(2), y + 2, 7.5, "#000000", "center");
  pen.text("Data, podpis kierownika, pieczątka:", center(3), y + 2, 7.5, "#000000", "center");
  y += boxH + 5;

  // pouczenia PL / UA
  notePl.forEach((line, i) => pen.text(line, x, y + 1 + i * 8, 6.5));
  noteUa.forEach((line, i) => pen.text(line, x + 270, y + 1 + i * 8, 6.5));
  y += noteH + 4;

  pen.text("FLOWLINE sp. z o.o. ul. Stefana Batorego 4, 31-135 Kraków | NIP: 6762687406", frameW / 2, y, 7, "#555555", "center");
  return doc;
}

function rgPersonDoc(person) {
  return String(person.firm).trim().toLowerCase() === "flowline" ? rgDocFlowline(person) : rgDocStandard(person);
}

// ---------- Zestawienie zbiorcze firmy (jedna firma = jeden dokument, tyle stron, ile trzeba) ----------
async function rgDocSummary(firm) {
  const doc = rgNewDoc();
  const logo = await rgLogo(firm);
  const people = rgPeople.filter(p => p.firm === firm);
  const margin = 36;
  const cols = [195, 90, 105, RG_A4.w - margin * 2 - 390];
  const tableW = cols.reduce((a, b) => a + b, 0);
  const pen = rgPen(doc, 1, margin, margin);
  const pageBottom = RG_A4.h - margin * 2 - 16;       // miejsce na numer strony
  const rowH = 26;
  const totalsH = 44;

  const head = [{
    size: 9, lead: 11, color: "#FFFFFF", bg: "#1F77B4",
    cells: ["Imię i nazwisko", "Godziny obecne", "Godziny nieobecne", "Podpis pracownika"].map(t => ({ t }))
  }];
  rgMeasure(doc, cols, head, 5);

  pen.text("Zbiorcze zestawienie godzin", 0, 4, 16, "#333333");
  pen.text(`Firma: ${firm}   |   Okres: ${rgMonthName()} ${rgYear}`, 0, 28, 10, "#666666");
  if (logo) pen.image(logo, tableW - 114, 0, 114, 31);
  let y = 50;
  y = rgDrawTable(pen, 0, y, cols, head, "#9AA1A9");

  people.forEach((p, i) => {
    if (y + rowH > pageBottom) {
      doc.addPage();
      y = rgDrawTable(pen, 0, 0, cols, head, "#9AA1A9");
    }
    const row = [{
      size: 9, lead: 11, color: "#1F2328", bg: i % 2 ? "#F9F9FB" : null,
      cells: [{ t: `${p.first} ${p.last}`.trim() }, { t: `${rgTotal(p.present)} godz.`, c: "#2EA44F" }, { t: `${rgTotal(p.absent)} godz.`, c: "#D9383A" }, { t: "" }]
    }];
    rgMeasure(doc, cols, row, 5);
    row[0].h = Math.max(row[0].h, rowH);                // wiersz wysoki na podpis
    y = rgDrawTable(pen, 0, y, cols, row, "#9AA1A9");
  });

  if (y + 14 + totalsH > pageBottom) {
    doc.addPage();
    y = 0;
  } else {
    y += 14;
  }
  const present = people.reduce((s, p) => s + p.present, 0);
  const absent = people.reduce((s, p) => s + p.absent, 0);
  const half = tableW / 2;
  pen.rect(0, y, half, totalsH, "#EAF7EF");
  pen.rect(half, y, half, totalsH, "#FDF2F2");
  pen.box(0, y, tableW, totalsH, "#888888");
  pen.line(half, y, half, y + totalsH, "#888888");
  pen.text(`${firm}: łącznie godzin przepracowanych`, half / 2, y + 8, 9, "#333333", "center");
  pen.text(`${rgTotal(present)} godz.`, half / 2, y + 22, 13, "#2EA44F", "center");
  pen.text(`${firm}: łącznie godzin nieobecnych`, half + half / 2, y + 8, 9, "#333333", "center");
  pen.text(`${rgTotal(absent)} godz.`, half + half / 2, y + 22, 13, "#D9383A", "center");

  const pages = doc.getNumberOfPages();
  for (let n = 1; n <= pages; n++) {
    doc.setPage(n);
    pen.text(`Strona ${n} z ${pages}`, tableW, RG_A4.h - margin * 2 - 8, 8, "#8B919A", "right");
  }
  return doc;
}

// ---------- Nazwy plików i zapis ----------
function rgSafeName(text) {
  return String(text).replace(/[\\/:*?"<>|]+/g, "-").trim() || "brak";
}

function rgPersonFile(p) {
  return rgSafeName(`${p.last}_${p.first}_${rgYear}_${rgMm()}.pdf`);
}

function rgSummaryFile(firm) {
  return rgSafeName(`Zbiorczy_${firm}_${rgYear}_${rgMm()}.pdf`);
}

function rgFolder(firm) {
  return ["reports", String(rgYear), rgSafeName(firm), `${rgMm()}_${rgMonthName()}`];
}

// Miejsce zapisu wielu plików: wybrany folder (Chrome, Edge) albo ZIP.
// Okno wyboru folderu musi otworzyć się od razu po kliknięciu. null = rezygnacja.
async function rgOpenSaver() {
  if (window.showDirectoryPicker) {
    let root;
    try {
      root = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch (err) {
      if (err.name === "AbortError") return null;
      throw err;
    }
    return {
      async write(path, name, blob) {
        let dir = root;
        for (const part of path) dir = await dir.getDirectoryHandle(part, { create: true });
        const file = await dir.getFileHandle(name, { create: true });
        const out = await file.createWritable();
        await out.write(blob);
        await out.close();
      },
      async finish() {}
    };
  }
  if (!window.JSZip) await rgLoadScript(RG_JSZIP_URL);
  const zip = new window.JSZip();
  return {
    async write(path, name, blob) {
      zip.file([...path, name].join("/"), blob);
    },
    async finish() {
      const blob = await zip.generateAsync({ type: "blob" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `Raporty_${rgYear}_${rgMm()}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    }
  };
}

// Wspólna otoczka generowania: blokada przycisków, kontrola zamknięcia miesiąca, błędy
async function rgRun(work) {
  if (rgBusy) return;
  rgBusy = true;
  rgSyncBusy();
  rgBanner("", "");
  try {
    if (!(await opIsLocked(`${rgYear}-${rgMm()}`))) {
      rgBanner("error", "Miesiąc nie jest już zamknięty. Raportów nie wygenerowano.");
      return;
    }
    await rgReadyPdf();
    await work();
  } catch (err) {
    console.error("Błąd generowania raportów:", err);
    rgBanner("error", "Nie udało się wygenerować raportów: " + (err.message || err));
  } finally {
    rgBusy = false;
    rgSyncBusy();
  }
}

function rgSavePerson(id) {
  const person = rgPeople.find(p => p.id === id);
  if (!person) return;
  rgRun(async () => {
    (await rgPersonDoc(person)).save(rgPersonFile(person));
    logAction("Raport PDF pracownika", `${person.first} ${person.last}, ${rgMonthName()} ${rgYear}`);
    savedToast("Raport gotowy");
  });
}

function rgSaveSummary(firmIndex) {
  const firm = rgFirms()[firmIndex];
  if (!firm) return;
  rgRun(async () => {
    (await rgDocSummary(firm)).save(rgSummaryFile(firm));
    logAction("Raport zbiorczy PDF", `${firm}, ${rgMonthName()} ${rgYear}`);
    savedToast("Raport gotowy");
  });
}

// Wiele plików: jobs = [{ path, name, make() }]
async function rgBulk(jobs, label) {
  if (rgBusy || !jobs.length) return;
  let saver;
  try {
    saver = await rgOpenSaver();
  } catch (err) {
    rgBanner("error", "Nie udało się otworzyć miejsca zapisu: " + (err.message || err));
    return;
  }
  if (!saver) return;
  rgRun(async () => {
    for (let i = 0; i < jobs.length; i++) {
      rgBanner("warning", `Generowanie: ${i + 1} z ${jobs.length}...`);
      await new Promise(r => setTimeout(r));           // strona odświeża licznik między plikami
      const doc = await jobs[i].make();
      await saver.write(jobs[i].path, jobs[i].name, doc.output("blob"));
    }
    await saver.finish();
    logAction(label, `${rgMonthName()} ${rgYear}, plików: ${jobs.length}`);
    rgBanner("success", `Gotowe. Wygenerowano plików: ${jobs.length}.`);
  });
}

function rgBulkPeople(firmIndex) {
  const firm = firmIndex === null ? null : rgFirms()[firmIndex];
  const people = rgPeople.filter(p => !firm || p.firm === firm);
  rgBulk(people.map(p => ({ path: rgFolder(p.firm), name: rgPersonFile(p), make: () => rgPersonDoc(p) })),
    "Raporty PDF pracowników");
}

function rgBulkSummaries() {
  rgBulk(rgFirms().map(firm => ({ path: rgFolder(firm), name: rgSummaryFile(firm), make: () => rgDocSummary(firm) })),
    "Raporty zbiorcze PDF");
}
