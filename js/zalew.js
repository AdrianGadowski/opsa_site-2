// ==========================================
// MODUŁ: ZALEW
// Osobne logowanie (zakładka "Zalew" na ekranie logowania) i własna strona po zalogowaniu.
// Na razie strona jest pusta - tylko nagłówek z imieniem i wylogowaniem.
// Konta: tabela zalew_users (login, first_name, last_name), hasła w Supabase Auth
// (patrz sql/09_zalew.sql i sql/11_zalew_hasla_przez_auth.sql).
// Wymaga: supabaseClient, loginLockTimer, loginFailedAttempts, showLoginError, clearLoginError,
//         registerFailedLogin, authEmail, isAuthNetworkError, setAuthRemember, authSignOut,
//         writeSession, clearSession (app.js), openForcePassword (password.js)
// ==========================================

const ZW_SELECT = "id, auth_id, login, first_name, last_name, must_change_password";

let zwUser = null;

async function zwFetchProfile(authId) {
  const { data, error } = await supabaseClient
    .from("zalew_users")
    .select(ZW_SELECT)
    .eq("auth_id", authId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ---------- Logowanie ----------
async function zwLogin() {
  if (!moduleEnabled("zalew")) {
    showLoginError("Moduł Zalew jest wyłączony.", false);
    return;
  }
  if (loginLockTimer) return;
  clearLoginError();

  const login = document.getElementById("login-input").value.trim();
  const password = document.getElementById("password-input").value;
  const btn = document.getElementById("btn-login");

  if (!login || !password) {
    showLoginError("Wpisz login i hasło.");
    return;
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.innerText = "Logowanie...";
    }

    // "Zapamiętaj mnie" decyduje, gdzie Supabase zapisze sesję - trzeba ustawić przed logowaniem
    setAuthRemember(!!document.getElementById("login-remember")?.checked);

    const { data: auth, error: authError } = await supabaseClient.auth.signInWithPassword({
      email: authEmail("zalew", login),
      password
    });

    if (authError) {
      if (isAuthNetworkError(authError)) {
        console.error("Błąd logowania (Zalew):", authError);
        showLoginError("Brak połączenia z serwerem. Sprawdź internet.", false);
      } else {
        registerFailedLogin();
      }
      return;
    }

    let profile;
    try {
      profile = await zwFetchProfile(auth.user.id);
    } catch (err) {
      console.error("Błąd pobierania profilu (Zalew):", err);
      await authSignOut();
      showLoginError("Błąd bazy danych. Spróbuj ponownie.", false);
      return;
    }
    if (!profile) {
      await authSignOut();
      registerFailedLogin();
      return;
    }

    loginFailedAttempts = 0;

    // Pierwsze logowanie albo hasło wpisane przez administratora: najpierw własne hasło
    if (profile.must_change_password) {
      openForcePassword({
        current: password,
        onDone: () => {
          profile.must_change_password = false;
          zwCompleteLogin(profile);
        },
        onCancel: authSignOut
      });
      return;
    }

    zwCompleteLogin(profile);
  } catch (err) {
    console.error("Niespodziewany błąd logowania (Zalew):", err);
    showLoginError("Brak połączenia z serwerem. Sprawdź internet.", false);
  } finally {
    if (btn && !loginLockTimer) {
      btn.disabled = false;
      btn.innerText = "Zaloguj się";
    }
  }
}

function zwCompleteLogin(profile) {
  zwUser = profile;
  clearSession();
  writeSession(null);
  zwOpen();
}

// Przywrócenie strony Zalew po odświeżeniu (wołane z restoreSession w app.js)
async function zwRestore(authId) {
  if (!moduleEnabled("zalew")) return false; // moduł wyłączony: sesja zostanie zamknięta
  const profile = await zwFetchProfile(authId);
  if (!profile || profile.must_change_password) return false;
  zwUser = profile;
  writeSession(null);
  zwOpen();
  return true;
}

// ---------- Strona po zalogowaniu (na razie pusta) ----------
function zwOpen() {
  if (!zwUser) return;
  const fullName = `${zwUser.first_name || ""} ${zwUser.last_name || ""}`.trim() || zwUser.login;
  document.getElementById("zw-name").textContent = fullName;

  document.getElementById("password-input").value = "";
  document.getElementById("zalew-portal").style.display = "block";
  zwInitContent();
  const overlay = document.getElementById("auth-overlay");
  if (overlay) overlay.style.display = "none";
}

function zwLogout() {
  authSignOut();
  zwUser = null;
  zwLoadToken++;
  zwModels = [];
  clearSession();

  document.getElementById("zalew-portal").style.display = "none";
  const overlay = document.getElementById("auth-overlay");
  if (overlay) {
    overlay.style.display = "flex";
    overlay.style.opacity = "1";
  }
  document.getElementById("login-input").value = "";
  document.getElementById("password-input").value = "";
  clearLoginError();
}

// ---------- Zakładki: linie (zalewy) i Modele ----------
// Zakładki Lora, HWS, HWS-D, SMS pokazują zalewy (tabela zalewy, sql/14),
// "Wszystkie linie" - zalewy ze wszystkich linii, tylko do podglądu (bez dodawania, edycji, usuwania),
// zakładka Modele - słownik modeli z wagą (tabela modele, sql/13).
const ZW_LINES = ["Lora", "HWS", "HWS-D", "SMS"];
const ZW_DASH_TAB = "Dashboard";        // podsumowanie tygodnia (pn-niedz) z podziałem na zmiany
const ZW_ALL_TAB = "Wszystkie linie";
const ZW_MODELS_TAB = "Modele";
const ZW_TABS = [ZW_DASH_TAB, ...ZW_LINES, ZW_ALL_TAB, ZW_MODELS_TAB];

// Zakładka "Wszystkie linie" (tylko podgląd)
function zwAllLines() {
  return zwTab === ZW_ALL_TAB;
}

// Liczba kolumn tabeli zalewów (w "Wszystkich liniach" dochodzi kolumna "Linia")
function zwColCount() {
  return zwAllLines() ? 14 : 13;
}

let zwTab = ZW_LINES[0];     // wybrana zakładka
let zwModelLine = "";         // filtr linii w zakładce Modele ("" = wszystkie)
let zwDate = "";             // dzień zalewów (rrrr-mm-dd)
let zwModels = [];           // modele linii w zakładce Modele
let zwPours = [];
let zwLineModels = [];       // modele linii do wyboru w oknie zalewu
let zwModelEditId = null;
let zwPourEditId = null;
let zwDelete = null;         // { kind: "model" | "pour", id }
let zwDeleteTimer = null;
let zwBusy = false;
let zwLoadToken = 0;
let zwScrapOn = null;        // czy baza ma kolumnę form zabrakowanych (sql/35); null = jeszcze nie wiadomo
let zwTargets = null;        // liczby zadane z tabeli zalew_cele (sql/40); null = jeszcze nie pobrane

function zwNum(value) {
  return Number(value || 0).toLocaleString("pl-PL");
}

// Waga z jednostką, np. "1 250 kg"
function zwKg(value) {
  return `${zwNum(value)} kg`;
}

function zwIso(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- Zmiany ----------
// Zmiana III trwa przez północ i należy do dnia, w którym się zaczęła.
// Zmiana I zaczyna się o 06:30 (jak w całym systemie), zmiana III kończy o 06:30.
const ZW_SHIFTS = [
  { name: "Zmiana I", from: "06:30", to: "14:30" },
  { name: "Zmiana II", from: "14:30", to: "22:30" },
  { name: "Zmiana III", from: "22:30", to: "06:30" }
];
let zwShift = "";            // filtr zmiany ("" = wszystkie)

function zwMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Zmiana trwająca w podanej chwili
function zwShiftAt(date) {
  const t = date.getHours() * 60 + date.getMinutes();
  if (t >= zwMinutes("06:30") && t < zwMinutes("14:30")) return "Zmiana I";
  if (t >= zwMinutes("14:30") && t < zwMinutes("22:30")) return "Zmiana II";
  return "Zmiana III";
}

// Dzień produkcyjny: przed 06:30 trwa jeszcze zmiana III z poprzedniego dnia
function zwProductionDate(date) {
  const d = new Date(date);
  if (d.getHours() * 60 + d.getMinutes() < zwMinutes("06:30")) d.setDate(d.getDate() - 1);
  return zwIso(d);
}

function zwShiftLabel(name) {
  const s = ZW_SHIFTS.find(x => x.name === name);
  return s ? `${s.name} (${s.from}–${s.to})` : (name || "Bez zmiany");
}

function zwShiftOrder(name) {
  const i = ZW_SHIFTS.findIndex(x => x.name === name);
  return i < 0 ? 99 : i;
}

// Start strony Zalewu po zalogowaniu: bieżący dzień produkcyjny i bieżąca zmiana
function zwInitContent() {
  if (!zwDate) {
    const now = new Date();
    zwDate = zwProductionDate(now);
    zwShift = zwShiftAt(now);
  }
  zwSyncPeriod();
  zwRenderTabs();
  zwShowTab();
}

// Pływające zaznaczenie zakładki (jak wskaźnik w menu): jeden element przesuwany pod wybraną zakładkę.
// Przy pierwszym pokazaniu i zmianie rozmiaru okna - bez animacji.
let zwTabIndicator = null;
let zwTabIndicatorShown = false;

function zwPlaceTabIndicator(instant) {
  const el = document.getElementById("zw-tabs");
  const active = el && el.querySelector("button.on");
  if (!zwTabIndicator || !active || !active.offsetWidth) {
    if (zwTabIndicator) zwTabIndicator.classList.remove("visible");
    zwTabIndicatorShown = false;
    return;
  }
  const skip = instant || !zwTabIndicatorShown;
  if (skip) zwTabIndicator.classList.add("no-anim");
  zwTabIndicator.style.width = `${active.offsetWidth}px`;
  zwTabIndicator.style.height = `${active.offsetHeight}px`;
  zwTabIndicator.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  zwTabIndicator.classList.add("visible");
  if (skip) {
    void zwTabIndicator.offsetWidth;     // bez przejścia przy pierwszym pokazaniu
    zwTabIndicator.classList.remove("no-anim");
  }
  zwTabIndicatorShown = true;
}
addEventListener("resize", () => zwPlaceTabIndicator(true));

function zwRenderTabs() {
  const el = document.getElementById("zw-tabs");
  if (el) {
    if (!zwTabIndicator) {
      zwTabIndicator = document.createElement("span");
      zwTabIndicator.className = "zw-tab-indicator";
      zwTabIndicator.setAttribute("aria-hidden", "true");
    }
    const icons = { [ZW_DASH_TAB]: "fa-chart-column", [ZW_ALL_TAB]: "fa-layer-group", [ZW_MODELS_TAB]: "fa-cubes" };
    el.innerHTML = ZW_TABS.map(tab => `
      <button type="button" role="tab" class="${tab === zwTab ? "on" : ""} ${tab === ZW_MODELS_TAB ? "models" : ""} ${tab === ZW_ALL_TAB ? "all" : ""} ${tab === ZW_DASH_TAB ? "dash" : ""}"
              aria-selected="${tab === zwTab}" data-tab="${rtEsc(tab)}" onclick="zwSetTab(this.dataset.tab)">
        ${icons[tab] ? `<i class="fa-solid ${icons[tab]}"></i> ` : ""}${rtEsc(tab)}
      </button>`).join("");
    // ten sam element zaznaczenia - płynie z poprzedniej zakładki do nowej
    el.prepend(zwTabIndicator);
    requestAnimationFrame(() => zwPlaceTabIndicator(false));
  }

  const sub = document.getElementById("zw-model-tabs");
  if (sub) {
    sub.innerHTML = ["", ...ZW_LINES].map(line => `
      <button type="button" class="${line === zwModelLine ? "on" : ""}" aria-pressed="${line === zwModelLine}"
              data-line="${rtEsc(line)}" onclick="zwSetModelLine(this.dataset.line)">${rtEsc(line || "Wszystkie")}</button>`).join("");
  }
}

function zwSetTab(tab) {
  if (tab === zwTab || !ZW_TABS.includes(tab)) return;
  zwTab = tab;
  zwRenderTabs();
  zwShowTab();
}

function zwShowTab() {
  const models = zwTab === ZW_MODELS_TAB;
  const dash = zwTab === ZW_DASH_TAB;
  document.getElementById("zw-pours-card").style.display = models || dash ? "none" : "";
  document.getElementById("zw-models-card").style.display = models ? "" : "none";
  document.getElementById("zw-dash-card").style.display = dash ? "" : "none";
  // dzień i zmiana w nagłówku - niepotrzebne przy modelach i dashboardzie (ten ma wybór tygodnia)
  const period = document.getElementById("zw-period");
  if (period) period.style.display = models || dash ? "none" : "";
  const dashHero = document.getElementById("zw-dash-hero");
  if (dashHero) dashHero.style.display = dash ? "" : "none";
  if (models) {
    zwLoadModels();
  } else if (dash) {
    zwDashPrefix = "zw-dash-";
    zwLoadDash();
  } else {
    const all = zwAllLines();
    document.getElementById("zw-pours-title").textContent = all ? "Zalewy — wszystkie linie" : `Zalewy — ${zwTab}`;
    // wszystkie linie: tylko podgląd - bez "Dodaj kadź", z kolumną "Linia"
    document.getElementById("zw-add-pour").style.display = all ? "none" : "";
    document.getElementById("zw-pours-info").textContent = all
      ? "Podgląd zalewów ze wszystkich linii. Kadzie dodaje się w zakładce linii."
      : "Wiersz to jeden model zalany z kadzi.";
    document.getElementById("zw-pours-table").classList.toggle("zw-all", all);
    zwLoadPours();
  }
}

// ---------- Dzień i zmiana w nagłówku: strzałki ‹ › jak w Harmonogramie ----------
// Z wybraną zmianą strzałki idą zmiana po zmianie (III -> I następnego dnia, I -> III poprzedniego);
// "Cała doba" - wszystkie zmiany dnia, strzałki idą dzień po dniu. Nie da się wyjść poza bieżącą
// zmianę (dzień produkcyjny zaczyna się o 06:30). "Teraz" wraca do bieżącej zmiany.
function zwAddDays(iso, n) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return zwIso(d);
}

// Dzień i zmiana obok wybranych (delta -1 / +1)
function zwNeighbourPeriod(day, shift, delta) {
  if (!shift) return { day: zwAddDays(day, delta), shift };
  let i = zwShiftOrder(shift) + delta;
  if (i < 0) { i = ZW_SHIFTS.length - 1; day = zwAddDays(day, -1); }
  if (i >= ZW_SHIFTS.length) { i = 0; day = zwAddDays(day, 1); }
  return { day, shift: ZW_SHIFTS[i].name };
}

// Czy dzień / zmiana są jeszcze przed nami
function zwIsFuture(day, shift) {
  const now = new Date();
  const nowDay = zwProductionDate(now);
  if (day !== nowDay) return day > nowDay;
  return !!shift && zwShiftOrder(shift) > zwShiftOrder(zwShiftAt(now));
}

function zwStepPeriod(delta) {
  const next = zwNeighbourPeriod(zwDate, zwShift, delta);
  if (zwIsFuture(next.day, next.shift)) return;
  zwDate = next.day;
  zwShift = next.shift;
  zwSyncPeriod();
  zwLoadPours();
}

// "Cała doba" <-> jedna zmiana (dziś - bieżąca, w innym dniu - zmiana I)
function zwToggleWholeDay() {
  if (zwShift) {
    zwShift = "";
  } else {
    const now = new Date();
    zwShift = zwDate === zwProductionDate(now) ? zwShiftAt(now) : ZW_SHIFTS[0].name;
  }
  zwSyncPeriod();
  zwLoadPours();
}

function zwGoNow() {
  const now = new Date();
  zwDate = zwProductionDate(now);
  zwShift = zwShiftAt(now);
  zwSyncPeriod();
  zwLoadPours();
}

// Napis w nagłówku (dzień nad zmianą) i stan przycisków
function zwSyncPeriod() {
  const label = document.getElementById("zw-period-text");
  if (label) {
    label.innerHTML = `<b>${rtEsc(rtIsoToPl(zwDate))}</b><span>${rtEsc(zwShift ? zwShiftLabel(zwShift) : "cała doba")}</span>`;
  }
  const next = zwNeighbourPeriod(zwDate, zwShift, 1);
  const nextBtn = document.getElementById("zw-next");
  if (nextBtn) nextBtn.disabled = zwIsFuture(next.day, next.shift);
  const now = new Date();
  const nowBtn = document.getElementById("zw-now");
  if (nowBtn) nowBtn.disabled = zwDate === zwProductionDate(now) && zwShift === zwShiftAt(now);
  const dayBtn = document.getElementById("zw-wholeday");
  if (dayBtn) {
    dayBtn.classList.toggle("on", !zwShift);
    dayBtn.setAttribute("aria-pressed", String(!zwShift));
  }
  const step = zwShift ? "zmiana" : "dzień";
  document.getElementById("zw-prev")?.setAttribute("title", `Poprzedni${zwShift ? "a" : ""} ${step}`);
  nextBtn?.setAttribute("title", `Następn${zwShift ? "a" : "y"} ${step}`);
}

// =====================================================================
// ZALEWY
// =====================================================================
async function zwLoadPours() {
  const tbody = document.getElementById("zw-pours-body");
  if (!tbody || !zwUser) return;
  const token = ++zwLoadToken;

  tbody.innerHTML = `<tr><td colspan="${zwColCount()}" class="ep-empty"><i class="fa-solid fa-spinner fa-spin"></i> Ładowanie zalewów...</td></tr>`;
  document.getElementById("zw-sum").innerHTML = "";
  const progress = document.getElementById("zw-progress");
  if (progress) progress.innerHTML = "";

  // formy zabrakowane (ilosc_form_brak) są dopiero po sql/35 - bez tej kolumny lista działa jak dawniej
  const build = withScrap => {
    let query = supabaseClient
      .from("zalewy")
      .select("id, data_zalewu, zmiana, linia, numer_kadzi, temperatura_metalu, acel, metal_kadz, model_id, nr_modelu, waga, ilosc_form, " +
        (withScrap ? "ilosc_form_brak, " : "") +
        "waga_razem, proba_przylana, uwagi, created_at, created_by, model:model_id ( nr_modelu, weight )")
      .eq("data_zalewu", zwDate)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (!zwAllLines()) query = query.eq("linia", zwTab);       // wszystkie linie: bez filtra linii
    return zwShift ? query.eq("zmiana", zwShift) : query;
  };

  let { data, error } = await build(zwScrapOn !== false);
  if (error && zwScrapOn !== false && (error.code === "42703" || /ilosc_form_brak/.test(error.message || ""))) {
    zwScrapOn = false;
    ({ data, error } = await build(false));
  } else if (!error) {
    zwScrapOn = zwScrapOn !== false;
  }
  if (token !== zwLoadToken) return;

  if (error) {
    console.error("Błąd pobierania zalewów:", error);
    zwPours = [];
    tbody.innerHTML = `<tr><td colspan="${zwColCount()}" class="ep-empty" style="color: var(--danger);">
      Nie udało się pobrać zalewów: ${rtEsc(error.message)}</td></tr>`;
    return;
  }

  // kolejność zmian I, II, III; w zmianie według czasu wpisu
  zwPours = (data || []).sort((a, b) =>
    zwShiftOrder(a.zmiana) - zwShiftOrder(b.zmiana) || String(a.created_at).localeCompare(String(b.created_at)));
  await zwLoadTargets();                 // liczby zadane do kafelków (raz na sesję)
  if (token !== zwLoadToken) return;
  zwRenderPours();
}


// Waga modelu w zalewie: zapisana przy zalaniu, a gdy jej brak (model nie miał wtedy wagi)
// - aktualna waga modelu z tabeli modele
function zwPourWeight(p) {
  if (p.waga !== null && p.waga !== undefined) return Number(p.waga);
  const w = p.model && p.model.weight;
  return w === null || w === undefined ? null : Number(w);
}

// Razem: waga x ilość form (gdy waga jest zapisana - wartość policzona przez bazę)
function zwPourTotal(p) {
  if (p.waga !== null && p.waga !== undefined) return Number(p.waga_razem) || 0;
  const w = zwPourWeight(p);
  return w === null ? 0 : w * (Number(p.ilosc_form) || 0);
}

function zwTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "-";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Grupuje wpisy po kluczu, zachowując kolejność pierwszego wystąpienia
function zwGroupBy(rows, keyFn) {
  const map = new Map();
  rows.forEach(r => {
    const key = keyFn(r);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  });
  return map;
}

function zwSums(rows) {
  return {
    forms: rows.reduce((s, p) => s + (Number(p.ilosc_form) || 0), 0),
    scrap: rows.reduce((s, p) => s + (Number(p.ilosc_form_brak) || 0), 0),
    // metal wlany do kadzi (kg): raz na kadź - kilka wpisów z tej samej kadzi go nie dubluje
    metal: [...zwGroupBy(rows, p => `${p.data_zalewu}|${p.zmiana}|${String(p.numer_kadzi || "").trim()}`).values()]
      .reduce((s, list) => s + Math.max(0, ...list.map(p => Number(p.metal_kadz) || 0)), 0),
    weight: rows.reduce((s, p) => s + zwPourTotal(p), 0),
    ladles: new Set(rows.map(p => `${p.data_zalewu}|${p.zmiana}|${String(p.numer_kadzi || "").trim()}`)).size
  };
}

// ---------- Realizacja: kafelki słupkowe względem liczby zadanej + aktualnie zalewany model ----------
// Liczby zadane (tabela zalew_cele, sql/40) - pobierane raz; bez tabeli kafelki pokazują same liczby.
async function zwLoadTargets() {
  if (zwTargets !== null) return;
  const { data, error } = await supabaseClient.from("zalew_cele").select("linia, dzien, zmiana, kadzie, metal_kg, formy");
  if (error) console.warn("Zalew: liczby zadane niedostępne (sql/40):", error.message);
  zwTargets = error ? [] : (data || []);
}

// Cel dla linii, zmiany i dnia: najbardziej szczegółowy wpis (dzień + zmiana, sam dzień, sama zmiana, ogólny)
function zwTargetFor(line, shift, day) {
  const fits = (zwTargets || []).filter(t => t.linia === line &&
    (!t.dzien || t.dzien === day) && (!t.zmiana || t.zmiana === shift));
  fits.sort((a, b) => ((b.dzien ? 2 : 0) + (b.zmiana ? 1 : 0)) - ((a.dzien ? 2 : 0) + (a.zmiana ? 1 : 0)));
  return fits[0] || null;
}

function zwTons(kg) {
  return `${(Number(kg || 0) / 1000).toLocaleString("pl-PL", { maximumFractionDigits: 1 })} t`;
}

// Kafelek słupkowy: liczba, cel i słupek wypełniony procentem celu (zielony po osiągnięciu celu)
function zwBarTile(label, value, target, fmt) {
  const has = target !== null && target !== undefined && Number(target) > 0;
  const pct = has ? Math.round(value / target * 100) : null;
  const fill = has ? Math.min(100, value / target * 100) : 0;
  return `
    <div class="zw-bar-tile ${!has ? "none" : pct >= 100 ? "done" : ""}">
      <div class="txt">
        <div class="lbl">${label}</div>
        <div class="val">${fmt(value)}</div>
        <div class="pct${has ? " one" : ""}">${has ? `z ${fmt(target)} · ${pct}%` : "bez liczby zadanej"}</div>
      </div>
      <div class="col" aria-hidden="true"><i style="height: ${fill}%"></i></div>
    </div>`;
}

// Zalewy z listy, ostatni wpis (najpóźniej dodany) - aktualnie zalewany model
function zwLastPour(rows) {
  return rows.reduce((last, p) => (!last || String(p.created_at) > String(last.created_at) ? p : last), null);
}

function zwRenderProgress() {
  const box = document.getElementById("zw-progress");
  if (!box) return;
  const all = zwAllLines();
  // aktualnie zalewany model (zakładka linii): ostatni wpis; formy tego modelu na tej zmianie
  let current = "";
  const last = !all && zwLastPour(zwPours);
  if (last) {
    const same = zwPours.filter(p => p.zmiana === last.zmiana && (p.model_id ?? p.nr_modelu) === (last.model_id ?? last.nr_modelu));
    const good = same.reduce((s, p) => s + (Number(p.ilosc_form) || 0), 0);
    const bad = same.reduce((s, p) => s + (Number(p.ilosc_form_brak) || 0), 0);
    current = `
      <div class="zw-current">
        <span class="lbl"><i class="fa-solid fa-fire-flame-curved"></i> Aktualnie zalewany model</span>
        <b class="model">${rtEsc(last.nr_modelu || last.model?.nr_modelu || "-")}</b>${zwPourWeight(last) === null ? "" : `
        <span class="weight">(${zwKg(zwPourWeight(last))})</span>`}
        <span class="cnt">Dobre: <b>${zwNum(good)}</b></span>
        <span class="sep" aria-hidden="true">|</span>
        <span class="cnt bad">Złe: <b>${zwNum(bad)}</b></span>
        <span class="sep" aria-hidden="true">|</span>
        <span class="cnt sum">Razem: <b>${zwNum(good + bad)}</b></span>
      </div>`;
  } else if (!all) {
    // brak zalewów w wybranym dniu / zmianie: "brak" na czerwono
    current = `
      <div class="zw-current">
        <span class="lbl"><i class="fa-solid fa-fire-flame-curved"></i> Aktualnie zalewany model</span>
        <b class="model zw-none">brak</b>
      </div>`;
  }

  // kafelki słupkowe tylko w "Wszystkich liniach"; w zakładce linii sam pasek z aktualnym modelem
  if (!all) {
    box.innerHTML = current;
    return;
  }

  // każda linia: cel = suma celów pokazanych zmian; null, gdy żadna zmiana nie ma celu
  const shifts = zwShift ? [zwShift] : ZW_SHIFTS.map(s => s.name);
  const targetSum = (line, field) => {
    const vals = shifts.map(s => zwTargetFor(line, s, zwDate)).map(t => (t && t[field] !== null ? Number(t[field]) : null));
    return vals.every(v => v === null) ? null : vals.reduce((s, v) => s + (v || 0), 0);
  };
  const groups = ZW_LINES.map(line => ({ title: line, rows: zwPours.filter(p => p.linia === line), target: f => targetSum(line, f) }));
  // "Łącznie": wszystkie linie razem; cel = suma celów linii (null, gdy żadna linia nie ma celu)
  const totalTarget = f => {
    const vals = ZW_LINES.map(line => targetSum(line, f));
    return vals.every(v => v === null) ? null : vals.reduce((s, v) => s + (v || 0), 0);
  };
  groups.push({ title: "Łącznie", rows: zwPours, target: totalTarget, total: true });

  box.innerHTML = `<div class="zw-progress-groups">${groups.map(g => {
    const s = zwSums(g.rows);
    const lastOfLine = !g.total && zwLastPour(g.rows);
    return `
      <div class="zw-progress-group${g.total ? " total" : ""}">
        <div class="zw-progress-head">${rtEsc(g.title)}${g.total ? `<span>wszystkie linie</span>` : `<span>aktualnie: ${lastOfLine
          ? `<b>${rtEsc(lastOfLine.nr_modelu || lastOfLine.model?.nr_modelu || "-")}</b>`
          : `<b class="zw-none">brak</b>`}</span>`}</div>
        <div class="zw-progress-tiles">
          ${zwBarTile("Kadzie", s.ladles, g.target("kadzie"), zwNum)}
          ${zwBarTile("Metal w kadziach", s.metal, g.target("metal_kg"), zwTons)}
          ${zwBarTile("Formy dobre", s.forms, g.target("formy"), zwNum)}
        </div>
      </div>`;
  }).join("")}</div>`;
}

// =====================================================================
// DASHBOARD: podsumowanie tygodnia (pn-niedz) - wiersze to dni, kolumny to zmiany I, II, III i doba;
// w każdej komórce kadzie i metal (względem liczby zadanej) oraz formy dobre. Na dole cały tydzień.
// Linie: wszystkie razem (cel = suma celów linii) albo jedna wybrana.
// =====================================================================
const ZW_DAY_NAMES = ["Poniedziałek", "Wtorek", "Środa", "Czwartek", "Piątek", "Sobota", "Niedziela"];
let zwDashMonday = null;     // poniedziałek oglądanego tygodnia (rrrr-mm-dd)
let zwDashLine = "";         // "" = wszystkie linie
let zwDashRows = [];
let zwDashToken = 0;
// Ten sam dashboard jest w portalu Zalewu (zw-dash-*) i na pulpicie użytkowników (db-zwd-*, views/dashboard.html)
let zwDashPrefix = "zw-dash-";
const zwDashEl = key => document.getElementById(zwDashPrefix + key);

// Pulpit użytkowników: tabela tygodnia w zakładce Zalew, od bieżącego tygodnia
function zwDashOpenInApp() {
  zwDashPrefix = "db-zwd-";
  zwDashMonday = null;
  zwLoadDash();
}

// Poniedziałek tygodnia, w którym jest dzień produkcyjny (rrrr-mm-dd)
function zwMondayOf(iso) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() - (d.getDay() + 6) % 7);
  return zwIso(d);
}

function zwDashStep(delta) {
  const current = zwMondayOf(zwProductionDate(new Date()));
  const next = delta === 0 ? current : zwAddDays(zwDashMonday || current, delta * 7);
  if (next > current) return;                    // bez przyszłych tygodni
  zwDashMonday = next;
  zwLoadDash();
}

function zwSetDashLine(line) {
  if ((line !== "" && !ZW_LINES.includes(line)) || line === zwDashLine) return;
  zwDashLine = line;
  zwRenderDash();
}

async function zwLoadDash() {
  const table = zwDashEl("table");
  if (!table || (zwDashPrefix === "zw-dash-" && !zwUser)) return;
  const current = zwMondayOf(zwProductionDate(new Date()));
  if (!zwDashMonday) zwDashMonday = current;
  const sunday = zwAddDays(zwDashMonday, 6);
  const token = ++zwDashToken;

  // tydzień: "Tydzień 43 · 19.10–25.10.2026"; "Ten tydzień" i › tylko poza bieżącym tygodniem
  const [y, m, d] = zwDashMonday.split("-").map(Number);
  const week = typeof dbWeekOfYear === "function" ? dbWeekOfYear(y, m, d) : "";
  zwDashEl("week").innerHTML =
    `<b>${week ? `Tydzień ${week}` : "Tydzień"}</b><span>${rtEsc(rtIsoToPl(zwDashMonday).slice(0, 5))}–${rtEsc(rtIsoToPl(sunday))}</span>`;
  zwDashEl("next").disabled = zwDashMonday >= current;
  zwDashEl("now").disabled = zwDashMonday === current;
  table.innerHTML = `<tbody><tr><td class="ep-empty"><i class="fa-solid fa-spinner fa-spin"></i> Ładowanie tygodnia...</td></tr></tbody>`;

  // tydzień może mieć ponad 1000 wpisów (limit jednego zapytania) - pobieranie stronami (rpFetchAll)
  let data;
  try {
    [data] = await Promise.all([
      rpFetchAll(() => supabaseClient
        .from("zalewy")
        .select("id, data_zalewu, zmiana, linia, numer_kadzi, metal_kadz, ilosc_form")
        .gte("data_zalewu", zwDashMonday)
        .lte("data_zalewu", sunday)),
      zwLoadTargets()
    ]);
  } catch (error) {
    if (token !== zwDashToken) return;
    console.error("Błąd pobierania tygodnia zalewów:", error);
    table.innerHTML = `<tbody><tr><td class="ep-empty" style="color: var(--danger);">Nie udało się pobrać zalewów: ${rtEsc(error.message || error)}</td></tr></tbody>`;
    return;
  }
  if (token !== zwDashToken) return;
  zwDashRows = data || [];
  zwRenderDash();
}

// Cel dla dnia i zmian (lista zmian) na wybranej linii albo suma linii; null, gdy nigdzie nie ma celu
function zwDashTarget(days, shifts, field) {
  const lines = zwDashLine ? [zwDashLine] : ZW_LINES;
  let sum = 0, any = false;
  days.forEach(day => shifts.forEach(shift => lines.forEach(line => {
    const t = zwTargetFor(line, shift, day);
    if (t && t[field] !== null && t[field] !== undefined) { sum += Number(t[field]); any = true; }
  })));
  return any ? sum : null;
}

// Komórka: kadzie i metal z paskiem względem liczby zadanej, formy dobre
// current = zmiana, która właśnie trwa (wyróżniona ramką i znaczkiem "Trwa")
function zwDashCell(rows, days, shifts, future, current) {
  const badge = current ? `<span class="zw-dc-live"><i></i>Trwa</span>` : "";
  const cls = name => `${name}${current ? " zw-dc-now" : ""}`.trim();
  const s = zwSums(rows);
  const items = [
    ["Kadzie", s.ladles, zwDashTarget(days, shifts, "kadzie"), zwNum],
    ["Metal", s.metal, zwDashTarget(days, shifts, "metal_kg"), zwTons],
    ["Formy", s.forms, zwDashTarget(days, shifts, "formy"), zwNum]
  ];
  const planned = target => target !== null && target > 0;
  // zmiana jeszcze się nie zaczęła: plan (wyszarzony, pod nim zegar zamiast liczby zadanej); bez planu - zegar z napisem
  if (future) {
    if (!items.some(([, , target]) => planned(target))) {
      return `<td class="zw-dc-future"><i class="fa-regular fa-clock"></i><span>Jeszcze się nie odbyła</span></td>`;
    }
    const planLine = ([label, , target, fmt]) => `<div class="zw-dc-item">
      <div class="zw-dc-row"><span class="k">${label}</span><b>${planned(target) ? fmt(target) : "—"}</b>
        <span class="t">${planned(target) ? `<i class="fa-regular fa-clock" title="Plan"></i>` : ""}</span></div>
      <div class="zw-dc-bar none"></div>
    </div>`;
    return `<td class="zw-dc-plan" title="Zmiana jeszcze się nie odbyła - plan"><div class="zw-dc">${items.map(planLine).join("")}</div></td>`;
  }
  // nic nie zaplanowano i nic nie zalano - jeden szary krzyżyk zamiast trzech zer
  if (items.every(([, value, target]) => !value && !planned(target))) {
    return `<td class="${cls("zw-dc-none")}">${badge}<i class="fa-solid fa-xmark"></i><span>Nie zaplanowano</span></td>`;
  }
  const line = ([label, value, target, fmt]) => {
    const has = planned(target);
    const pct = has ? Math.round(value / target * 100) : null;
    // bez planu i bez zalewu: szary krzyżyk zamiast zera
    const shown = !has && !value ? `<b class="x" title="Nie zaplanowano"><i class="fa-solid fa-xmark"></i></b>` : `<b>${fmt(value)}</b>`;
    // zalane bez planu - dopisek zamiast liczby zadanej
    const sub = has ? `<span class="t" title="Liczba zadana">${fmt(target)}</span>`
      : value ? `<span class="t off" title="Zalano, choć ta zmiana nie miała planu">poza planem</span>`
      : `<span class="t"></span>`;
    return `<div class="zw-dc-item">
      <div class="zw-dc-row${has && pct >= 100 ? " done" : ""}">
        <span class="k">${label}</span>${shown}${sub}
      </div>${has ? `<div class="zw-dc-bar"><i style="width: ${Math.min(100, pct)}%"></i></div>` : `<div class="zw-dc-bar none"></div>`}
    </div>`;
  };
  return `<td class="${cls("")}">${badge}<div class="zw-dc">${items.map(line).join("")}</div></td>`;
}

// Kadź w nagłówku: wykonanie liczb zadanych tygodnia (wybrana linia albo wszystkie) -
// metal w kadziach; bez celu metalu - kadzie. Płynny metal sięga tyle procent wnętrza kadzi (maks. 100%).
const ZW_LADLE_TOP = 29;      // wnętrze kadzi w rysunku (viewBox 72 x 84): góra i dno
const ZW_LADLE_BOTTOM = 76.5;

// Kadź spada z góry na swoje miejsce (animacja .drop w css/portal.css; od nowa przy każdym wywołaniu)
function zwDropLadle() {
  const svg = zwDashEl("ladle")?.querySelector(".zw-ladle");
  if (!svg) return;
  svg.classList.remove("drop");
  void svg.getBoundingClientRect();   // wymusza ponowne uruchomienie animacji
  svg.classList.add("drop");
}

function zwRenderLadle(rows, days, shifts) {
  const box = zwDashEl("ladle");
  if (!box) return;
  if (!box.firstElementChild) {
    // id przycięcia i gradientu z prefiksem - kadź jest w portalu i na pulpicie (ten sam dokument)
    const id = `${zwDashPrefix}ladle`;
    box.innerHTML = `
      <svg class="zw-ladle" viewBox="0 0 72 84" aria-hidden="true">
        <defs>
          <clipPath id="${id}-in"><path d="M16.5 29 H56.5 L52.5 73 Q52 76.5 48 76.5 H24 Q20 76.5 19.5 73 Z" /></clipPath>
          <linearGradient id="${id}-hot" gradientUnits="userSpaceOnUse" x1="0" y1="-2" x2="0" y2="51">
            <stop offset="0" stop-color="#FFE08A" /><stop offset="0.25" stop-color="#FF9F1C" />
            <stop offset="0.65" stop-color="#F25C05" /><stop offset="1" stop-color="#B8310B" />
          </linearGradient>
        </defs>
        <!-- pałąk z uchem na hak suwnicy, korpus z grubą ścianą -->
        <path class="bail" d="M8 45 V15 Q8 10 13 10 H59 Q64 10 64 15 V45" />
        <circle class="eye" cx="36" cy="6" r="3.4" />
        <path class="shell" d="M12 26 H60 L56 76 Q55.5 80 51 80 H21 Q16.5 80 16 76 Z" />
        <g clip-path="url(#${id}-in)">
          <g class="level" style="transform: translateY(${ZW_LADLE_BOTTOM}px);">
            <path class="wave" fill="url(#${id}-hot)" d="M0 0 Q5 -2.5 10 0 T20 0 T30 0 T40 0 T50 0 T60 0 T70 0 T80 0 T90 0 T100 0 V60 H0 Z" />
            <circle class="bubble" cx="28" cy="13" r="1.6" />
            <circle class="bubble b2" cx="43" cy="11" r="1.2" />
            <circle class="bubble b3" cx="35" cy="15" r="2" />
          </g>
        </g>
        <path class="shine" d="M22 34 L24 68" />
        <path class="rim" d="M10.5 26 H60.5" />
        <path class="band" d="M14.2 44 H58" /><path class="band" d="M15.2 62 H56.6" />
        <circle class="pin" cx="8" cy="47" r="4.2" /><circle class="pin" cx="64" cy="47" r="4.2" />
      </svg>
      <b class="zw-ladlepct" aria-live="polite">—</b>
      <div class="zw-ladletxt"><span>wykonanie planu tygodnia</span><small aria-live="polite"></small></div>`;
  }
  const s = zwSums(rows);
  const metalTarget = zwDashTarget(days, shifts, "metal_kg");
  const byMetal = metalTarget > 0;
  const target = byMetal ? metalTarget : zwDashTarget(days, shifts, "kadzie");
  const done = byMetal ? s.metal : s.ladles;
  const pct = target > 0 ? Math.round(done / target * 100) : null;
  const where = zwDashLine || "Wszystkie linie";
  const fill = pct === null ? 0 : Math.min(100, pct) / 100;
  const nb = text => String(text).replace(/ /g, " ");   // liczba z jednostką ("1260 t") nie łamie się między wierszami

  box.querySelector(".level").style.transform = `translateY(${ZW_LADLE_BOTTOM - (ZW_LADLE_BOTTOM - ZW_LADLE_TOP) * fill}px)`;
  box.querySelector(".zw-ladlepct").textContent = pct === null ? "—" : `${pct}%`;
  box.querySelector(".zw-ladletxt small").textContent = pct === null
    ? `${where} · brak planu`
    // krótko, żeby nagłówek mieścił się w jednym wierszu: "Lora · 504,5 / 630 t" (jednostka raz, na końcu)
    : byMetal ? `${where} · ${nb(zwTons(done).replace(/ t$/, ""))} / ${nb(zwTons(target))}` : `${where} · kadzie ${nb(zwNum(done))} / ${nb(zwNum(target))}`;
  box.classList.toggle("hot", !!pct);
  box.classList.toggle("done", pct !== null && pct >= 100);
}

function zwRenderDash() {
  const table = zwDashEl("table");
  const linesEl = zwDashEl("lines");
  if (linesEl) {
    linesEl.innerHTML = ["", ...ZW_LINES].map(line => `
      <button type="button" class="${line === zwDashLine ? "on" : ""}" aria-pressed="${line === zwDashLine}"
              onclick="zwSetDashLine('${rtEsc(line)}')">${rtEsc(line || "Wszystkie linie")}</button>`).join("");
  }
  if (!table || !zwDashMonday) return;

  const shifts = ZW_SHIFTS.map(s => s.name);
  const days = Array.from({ length: 7 }, (_, i) => zwAddDays(zwDashMonday, i));
  const rows = zwDashLine ? zwDashRows.filter(r => r.linia === zwDashLine) : zwDashRows;
  const now = new Date();
  const today = zwProductionDate(now);
  const nowShift = zwShiftAt(now);
  const pick = (day, shift) => rows.filter(r => (!day || r.data_zalewu === day) && (!shift || r.zmiana === shift));

  const head = `<thead><tr><th>Dzień</th>${shifts.map(s => `<th>${rtEsc(zwShiftLabel(s))}</th>`).join("")}<th>Doba</th></tr></thead>`;
  const body = days.map((day, i) => {
    const futureDay = day > today;
    // sobota na żółto, niedziela na niebiesko
    return `<tr class="${day === today ? "today" : ""}${i === 5 ? " sat" : i === 6 ? " sun" : ""}">
      <th class="zw-dc-day">${ZW_DAY_NAMES[i]}<span>${rtEsc(rtIsoToPl(day))}</span></th>
      ${shifts.map(shift => zwDashCell(pick(day, shift), [day], [shift], zwIsFuture(day, shift), day === today && shift === nowShift)).join("")}
      ${zwDashCell(pick(day, null), [day], shifts, futureDay)}
    </tr>`;
  }).join("");
  const foot = `<tfoot><tr>
      <th class="zw-dc-day">Cały tydzień<span>${rtEsc(zwDashLine || "wszystkie linie")}</span></th>
      ${shifts.map(shift => zwDashCell(pick(null, shift), days, [shift], false)).join("")}
      ${zwDashCell(rows, days, shifts, false)}
    </tr></tfoot>`;
  table.innerHTML = head + `<tbody>${body}</tbody>` + foot;
  zwRenderLadle(rows, days, shifts);
}

function zwRenderPours() {
  const tbody = document.getElementById("zw-pours-body");
  const sum = document.getElementById("zw-sum");
  if (!tbody) return;
  zwRenderProgress();

  const total = zwSums(zwPours);
  // "Wszystkie linie": zamiast tych kafelków jest kafelek "Łącznie" w panelu realizacji
  sum.innerHTML = zwAllLines() ? "" : `
    <div class="zw-tile"><div class="lbl">Kadzi</div><div class="val">${zwNum(total.ladles)}</div></div>
    <div class="zw-tile"><div class="lbl">Form dobrych</div><div class="val">${zwNum(total.forms)}</div></div>
    <div class="zw-tile"><div class="lbl">Form zabrakowanych</div><div class="val">${zwNum(total.scrap)}</div></div>
    <div class="zw-tile main"><div class="lbl">Łącznie wylano</div><div class="val">${zwKg(total.metal)}</div></div>`;   // metal wlany do kadzi, raz na kadź

  const scope = zwShift ? zwShiftLabel(zwShift) : "wszystkie zmiany";
  if (zwPours.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${zwColCount()}" class="ep-empty">${zwAllLines()
      ? `Brak zalewów na żadnej linii (${rtEsc(scope)}) w wybranym dniu.`
      : `Brak zalewów na linii ${rtEsc(zwTab)} (${rtEsc(scope)}) w wybranym dniu. Dodaj pierwszy przyciskiem „Dodaj kadź”.`}</td></tr>`;
    return;
  }

  const showShifts = !zwShift; // przy jednej zmianie nagłówki zmian są zbędne
  const all = zwAllLines();    // wszystkie linie: kolumna "Linia", bez edycji i usuwania
  const lead = all ? 7 : 6;    // kolumny przed sumami form w wierszach "Razem"
  let html = "";

  zwGroupBy(zwPours, p => p.zmiana || "").forEach((shiftRows, shiftName) => {
    if (showShifts) {
      html += `<tr class="zw-shifthead"><td colspan="${zwColCount()}"><i class="fa-solid fa-clock"></i> ${rtEsc(zwShiftLabel(shiftName))}</td></tr>`;
    }

    zwGroupBy(shiftRows, p => String(p.numer_kadzi || "").trim() || "-").forEach((rows, ladle) => {
      rows.forEach(p => {
        html += `
          <tr>
            <td>${zwTime(p.created_at)}</td>${all ? `
            <td class="zw-col-line">${rtEsc(p.linia || "-")}</td>` : ""}
            <td class="zw-nr">${rtEsc(p.numer_kadzi || "-")}</td>
            <td>${p.temperatura_metalu === null ? "-" : `${rtEsc(p.temperatura_metalu)} °C`}</td>
            <td>${p.acel === null ? "-" : rtEsc(Number(p.acel).toLocaleString("pl-PL", { maximumFractionDigits: 3 }))}</td>
            <td class="zw-model">${rtEsc(p.nr_modelu || p.model?.nr_modelu || "-")}</td>
            <td class="zw-weight">${zwPourWeight(p) === null ? "-" : zwKg(zwPourWeight(p))}</td>
            <td class="zw-weight">${zwNum(p.ilosc_form)}</td>
            <td class="zw-weight${Number(p.ilosc_form_brak) > 0 ? " zw-scrap" : ""}">${zwNum(p.ilosc_form_brak || 0)}</td>
            <td class="zw-total">${p.metal_kadz === null || p.metal_kadz === undefined ? "-" : zwKg(p.metal_kadz)}</td>
            <td class="zw-weight">${zwKg(zwPourTotal(p))}</td>
            <td>${p.proba_przylana ? `<span class="zw-sample yes"><i class="fa-solid fa-flask"></i> Tak</span>` : `<span class="zw-sample">Nie</span>`}</td>
            <td class="zw-note">${p.uwagi ? `<span title="${rtEsc(p.uwagi)}">${rtEsc(p.uwagi)}</span>` : `<span class="zw-note-empty">brak</span>`}</td>
            <td class="zw-actions">${all ? "" : `
              <button type="button" class="zw-act" title="Edytuj" aria-label="Edytuj zalew" onclick="zwOpenPour(${Number(p.id)})"><i class="fa-solid fa-pen"></i></button>
              <button type="button" class="zw-act del" title="Usuń" aria-label="Usuń zalew" onclick="zwOpenDelete('pour', ${Number(p.id)})"><i class="fa-solid fa-trash"></i></button>`}
            </td>
          </tr>`;
      });
    });

    if (showShifts) {
      const s = zwSums(shiftRows);
      html += `
        <tr class="zw-shifttotal">
          <td colspan="${lead}">Razem ${rtEsc(shiftName || "bez zmiany")} (kadzi: ${zwNum(s.ladles)})</td>
          <td class="zw-weight">${zwNum(s.forms)}</td>
          <td class="zw-weight">${zwNum(s.scrap)}</td>
          <td class="zw-total">${zwKg(s.metal)}</td>
          <td class="zw-weight">${zwKg(s.weight)}</td>
          <td></td>
          <td></td>
          <td></td>
        </tr>`;
    }
  });

  html += `
    <tr class="zw-grandtotal">
      <td colspan="${lead}">Razem ${rtEsc(all ? "wszystkie linie" : zwTab)}, ${rtEsc(rtIsoToPl(zwDate))}, ${rtEsc(scope)}</td>
      <td class="zw-weight">${zwNum(total.forms)}</td>
      <td class="zw-weight">${zwNum(total.scrap)}</td>
      <td class="zw-total">${zwKg(total.metal)}</td>
      <td class="zw-weight">${zwKg(total.weight)}</td>
      <td></td>
      <td></td>
      <td></td>
    </tr>`;
  tbody.innerHTML = html;
}

// ---------- Okno zalewu (dodawanie / edycja) ----------
// Pola liczbowe okna zalewu (numer kadzi, temperatura, metal, formy): przyjmują tylko cyfry -
// inne znaki (litery, spacje, przecinki) znikają od razu przy wpisywaniu i wklejaniu
function zwDigitsOnly(el) {
  const clean = el.value.replace(/\D/g, "");
  if (clean !== el.value) el.value = clean;
}

// ACEL wpisywany ciągiem: same cyfry (najwyżej 3), przecinek wstawia się sam po pierwszej
// ("432" -> "4,32"); kasowanie działa normalnie ("4,3" -> "4," -> "4")
function zwAcelInput(el) {
  const digits = el.value.replace(/\D/g, "").slice(0, 3);
  el.value = digits.length > 1 ? `${digits[0]},${digits.slice(1)}` : digits;
}

function zwPourMsg(text) {
  const el = document.getElementById("zw-pour-msg");
  if (!el) return;
  el.textContent = text;
  el.style.display = text ? "block" : "none";
}

// ---------- Numer kadzi: podpowiedź "ostatnia + 1" ----------
const ZW_LADLE_DIGITS = 7;   // numer kadzi: dokładnie 7 cyfr

// "12" -> "13", "007" -> "008", "K12" -> "K13"; bez cyfr na końcu - brak podpowiedzi
function zwNextLadle(value) {
  const m = String(value || "").trim().match(/^(.*?)(\d+)$/);
  if (!m) return "";
  const next = String(Number(m[2]) + 1).padStart(Math.max(ZW_LADLE_DIGITS, m[2].length), "0");
  return m[1] + next;
}

// Przyciski -1 / +1 przy numerze kadzi: zmienia liczbę na końcu numeru (nie schodzi poniżej 1)
function zwStepLadle(delta) {
  const input = document.getElementById("zw-pour-ladle");
  if (!input) return;
  const m = input.value.trim().match(/^(.*?)(\d+)$/);
  if (!m) {
    // pusty numer albo bez cyfr na końcu: zacznij od 1
    if (delta > 0) input.value = "1".padStart(ZW_LADLE_DIGITS, "0");
    input.focus();
    return;
  }
  const next = Math.max(1, Number(m[2]) + delta);
  input.value = m[1] + String(next).padStart(Math.max(ZW_LADLE_DIGITS, m[2].length), "0");
  input.focus();
}

// Numer kadzi: pierwsza cyfra to numer pieca (6, 7, 8...), pozostałe cyfry to kolejny
// numer kadzi z tego pieca. Piece pracują na zmianę, więc numery różnych pieców się przeplatają.
const ZW_LADLE_MAX_JUMP = 10;     // większy skok numeru na tym samym piecu = ostrzeżenie
const ZW_LADLE_MAX_IN_ROW = 7;    // tyle kadzi z rzędu z jednego pieca jest normalne (8. = ostrzeżenie)

function zwLadleFurnace(ladle) {
  return String(ladle || "").trim().charAt(0);
}

// Ostatnio zapisane kadzie (wszystkie linie), od najnowszej, bez powtórzeń numeru
// (jedna kadź może mieć kilka wpisów - po jednym na model)
async function zwFetchRecentLadles() {
  const { data, error } = await supabaseClient
    .from("zalewy")
    .select("numer_kadzi")
    .like("numer_kadzi", "_".repeat(ZW_LADLE_DIGITS))   // tylko numery 7-znakowe
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(60);
  if (error) throw error;
  const seen = new Set();
  const list = [];
  (data || []).forEach(r => {
    const n = String(r.numer_kadzi || "").trim();
    if (n && !seen.has(n)) { seen.add(n); list.push(n); }
  });
  return list;
}

// Najwyższy zapisany numer kadzi z danego pieca; null = z tego pieca jeszcze nic
async function zwFetchLastOfFurnace(furnace) {
  const { data, error } = await supabaseClient
    .from("zalewy")
    .select("numer_kadzi")
    .like("numer_kadzi", furnace + "_".repeat(ZW_LADLE_DIGITS - 1))
    .order("numer_kadzi", { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data && data[0] && String(data[0].numer_kadzi).trim()) || null;
}

// Opis problemu z numerem kadzi; null = wszystko w porządku.
// Ostrzeżenie: ten sam lub cofnięty numer na piecu, duży skok numeru na piecu,
// albo kolejna (8.) kadź z rzędu z jednego pieca. Zmiana pieca sama w sobie jest normalna.
async function zwLadleWarning(ladle) {
  const furnace = zwLadleFurnace(ladle);
  const pad = n => String(n).padStart(ZW_LADLE_DIGITS, "0");
  const [lastSame, recent] = await Promise.all([zwFetchLastOfFurnace(furnace), zwFetchRecentLadles()]);

  if (lastSame) {
    const diff = Number(ladle) - Number(lastSame);
    if (diff === 0) {
      return `Kadź ${ladle} jest już zapisana. Zapisz mimo to tylko wtedy, gdy to kolejny model z tej samej kadzi.`;
    }
    if (diff < 0) {
      return `Numer ${ladle} jest mniejszy od ostatniej kadzi z pieca ${furnace} (${lastSame}). Taka kadź mogła już być zalana.`;
    }
    if (diff > ZW_LADLE_MAX_JUMP) {
      return `Duży skok numeru na piecu ${furnace}: ostatnia kadź to ${lastSame}, a kolejna powinna mieć numer ${pad(Number(lastSame) + 1)}. Pominięto ${diff - 1} kadzi.`;
    }
  }

  // ile ostatnich kadzi z rzędu pochodzi z tego samego pieca
  let inRow = 0;
  for (const n of recent) {
    if (zwLadleFurnace(n) !== furnace) break;
    inRow++;
  }
  if (inRow >= ZW_LADLE_MAX_IN_ROW) {
    return `To będzie ${inRow + 1}. kadź z rzędu z pieca ${furnace} (zwykle z pieca wylewa się około ${ZW_LADLE_MAX_IN_ROW} kadzi). Sprawdź, czy numer pieca jest dobry.`;
  }
  return null;
}

const ZW_WEIGHT_TOLERANCE = 200;   // kg: większa różnica między wagą zalewu a metalem w kadzi = ostrzeżenie

// Waga zalewu tej kadzi (waga modelu x formy dobre, razem z innymi zapisanymi wpisami tej kadzi
// na liście) porównana z metalem wlanym do kadzi. Ostrzeżenie, gdy różnica wynosi 200 kg lub więcej;
// null = w porządku albo nie da się policzyć (model bez wagi).
function zwWeightWarning(payload) {
  const model = zwLineModels.find(m => Number(m.id) === Number(payload.model_id));
  if (!model || model.weight === null || model.weight === undefined) return null;
  const ladle = String(payload.numer_kadzi).trim();
  const others = zwPours.filter(p => String(p.numer_kadzi || "").trim() === ladle && Number(p.id) !== Number(zwPourEditId));
  const total = Number(model.weight) * payload.ilosc_form + others.reduce((s, p) => s + zwPourTotal(p), 0);
  const metal = Number(payload.metal_kadz);
  const diff = Math.abs(total - metal);
  if (diff < ZW_WEIGHT_TOLERANCE) return null;
  return `Waga zalewu${others.length ? " tej kadzi (razem z wcześniejszymi wpisami)" : ""} to <b>${zwKg(total)}</b>, ` +
    `a metalu wlano do kadzi <b>${zwKg(metal)}</b> - różnica <b>${zwKg(diff)}</b>.` +
    (total < metal ? " Jeśli z tej kadzi zalejesz jeszcze inny model, zapisz mimo to." : "");
}

let zwPendingPour = null;    // zalew czekający na potwierdzenie ostrzeżenia (numer kadzi / waga)
let zwPendingEditing = false;
let zwWarnFocus = "zw-pour-ladle";   // pole, do którego wraca "Popraw"

// Okno ostrzeżenia przed zapisem: { ladle: tekst o numerze kadzi, weight: html o wadze }
function zwOpenLadleWarning(warn) {
  const parts = [];
  if (warn.ladle) parts.push(`<p style="margin: 0 0 10px;">${rtEsc(warn.ladle)}</p>`);
  if (warn.weight) parts.push(`<p style="margin: 0;">${warn.weight}</p>`);
  document.getElementById("zw-warn-text").innerHTML = parts.join("");
  document.getElementById("zw-warn-title").textContent =
    warn.ladle && warn.weight ? "Sprawdź kadź" : warn.weight ? "Sprawdź wagę zalewu" : "Sprawdź numer kadzi";
  document.getElementById("zw-warn-back").textContent = warn.ladle ? "Popraw numer" : "Popraw";
  zwWarnFocus = warn.ladle ? "zw-pour-ladle" : "zw-pour-metal";
  toggleModal("modal-zw-warn", true);
}

// "Popraw" - wraca do okna zalewu, do pola, którego dotyczy ostrzeżenie
function zwCloseLadleWarning() {
  zwPendingPour = null;
  toggleModal("modal-zw-warn", false);
  document.getElementById(zwWarnFocus)?.focus();
}

// "Zapisz mimo to"
async function zwConfirmLadleWarning() {
  const payload = zwPendingPour;
  zwPendingPour = null;
  toggleModal("modal-zw-warn", false);
  if (payload) await zwDoSavePour(payload, zwPendingEditing);
}

async function zwSuggestLadle() {
  const input = document.getElementById("zw-pour-ladle");
  const line = zwTab;
  let last = null;
  try {
    last = (await zwFetchRecentLadles())[0] || null;
  } catch (err) {
    console.error("Błąd pobierania ostatniej kadzi:", err);
    return;
  }
  // okno zamknięte, przełączone na edycję albo ktoś już wpisał numer - nie nadpisuj
  if (zwPourEditId !== null || line !== zwTab || !input || input.value.trim()) return;

  if (!last) return; // pierwszy zalew w ogóle - numer wpisuje się ręcznie
  input.value = zwNextLadle(last);
}

async function zwOpenPour(id) {
  const p = id ? zwPours.find(x => Number(x.id) === Number(id)) : null;
  zwPourEditId = p ? p.id : null;

  document.getElementById("zw-pour-title").textContent =
    `${p ? "Edycja zalewu" : "Nowy zalew"} — ${zwTab}`;
  document.getElementById("zw-pour-ladle").value = p ? (p.numer_kadzi || "") : "";
  document.getElementById("zw-pour-temp").value = p ? (p.temperatura_metalu ?? "") : "";
  document.getElementById("zw-pour-acel").value = p && p.acel !== null && p.acel !== undefined
    ? Number(p.acel).toFixed(2).replace(".", ",") : "";
  document.getElementById("zw-pour-metal").value = p ? (p.metal_kadz ?? "") : "";
  document.getElementById("zw-pour-forms").value = p ? p.ilosc_form : "";
  document.getElementById("zw-pour-scrap").value = p && Number(p.ilosc_form_brak) > 0 ? p.ilosc_form_brak : "";
  // przed sql/35 baza nie zapisze form zabrakowanych - pole jest wtedy nieaktywne
  document.getElementById("zw-pour-scrap").disabled = zwScrapOn === false;
  document.getElementById("zw-pour-notes").value = p ? (p.uwagi || "") : "";
  document.getElementById("zw-pour-sample").checked = !!(p && p.proba_przylana);
  // nowy wpis: numer kadzi = ostatnia kadź ze wszystkich linii + 1 (pole można zmienić)
  if (!p) zwSuggestLadle();

  // Zmiany nie wybiera się i nie pokazuje w oknie: przy nowym wpisie ustawia ją baza według
  // aktualnej godziny, przy edycji zostaje zapisana
  zwPourMsg("");

  zwLineModels = [];
  zwComboSelect(null, true);
  const comboInput = document.getElementById("zw-pour-model-input");
  comboInput.placeholder = "Ładowanie modeli...";
  toggleModal("modal-zw-pour", true);
  document.getElementById(p ? "zw-pour-forms" : "zw-pour-ladle").focus();

  const line = zwTab;
  // modele linii oraz (przy nowym wpisie) model z poprzedniej kadzi na tej linii - równolegle
  const [{ data, error }, previous] = await Promise.all([
    supabaseClient
      .from("modele")
      .select("id, nr_modelu, weight")
      .contains("lines", [line]),
    p ? Promise.resolve({ data: null }) : supabaseClient
      .from("zalewy")
      .select("model_id")
      .eq("linia", line)
      .not("model_id", "is", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
  ]);
  comboInput.placeholder = "Wpisz numer, np. S-123, albo wybierz z listy";
  if (error) {
    zwPourMsg("Nie udało się pobrać modeli: " + error.message);
    return;
  }

  zwLineModels = (data || []).sort((a, b) =>
    String(a.nr_modelu || "").localeCompare(String(b.nr_modelu || ""), "pl", { numeric: true }));

  if (p && p.model_id) {
    zwComboSelect(p.model_id, true);
  } else if (!p && zwPourEditId === null) {
    // nowy zalew: model z poprzedniej kadzi na tej linii (jeśli nadal jest przypisany do linii)
    const lastModelId = previous && previous.data && previous.data[0] && previous.data[0].model_id;
    if (lastModelId && zwLineModels.some(m => Number(m.id) === Number(lastModelId))) {
      zwComboSelect(lastModelId, true);
    }
  }
  if (zwLineModels.length === 0) {
    zwPourMsg(`Na linii ${zwTab} nie ma jeszcze modeli. Dodaj je w zakładce „Modele”.`);
  }
  zwPourPreview();
}

function zwClosePour() {
  zwPourEditId = null;
  zwComboClose();
  toggleModal("modal-zw-pour", false);
}

// ---------- Pole modelu: jedno pole do wpisania i wyboru (lista podpowiedzi) ----------
// Klik albo Tab w polu zaznacza cały tekst, więc wpisanie numeru od razu zastępuje
// poprzedni model. Lista zawęża się przy każdym znaku; Enter albo klik wybiera.
// Wielkość liter, spacje i myślniki nie mają znaczenia ("S-123" = "s123").
let zwComboItems = [];       // modele widoczne na liście
let zwComboActive = -1;      // podświetlona pozycja (strzałki)

function zwNormModel(text) {
  return String(text || "").toLowerCase().replace(/[\s\-_.]/g, "");
}

function zwModelLabel(m) {
  return `${m.nr_modelu} — ${m.weight === null ? "waga brak" : zwKg(m.weight)}`;
}

// Ustawia wybrany model (null = brak); quiet = bez otwierania listy i bez przeliczania
function zwComboSelect(id, quiet) {
  const m = id === null ? null : zwLineModels.find(x => Number(x.id) === Number(id));
  document.getElementById("zw-pour-model").value = m ? String(m.id) : "";
  document.getElementById("zw-pour-model-input").value = m ? zwModelLabel(m) : "";
  zwComboClose();
  if (!quiet) zwPourPreview();
}

function zwComboRender(query) {
  const list = document.getElementById("zw-combo-list");
  if (!list) return;
  const q = zwNormModel(query);
  zwComboItems = q ? zwLineModels.filter(m => zwNormModel(m.nr_modelu).includes(q)) : zwLineModels.slice();
  // dokładne trafienie numeru na początek listy
  zwComboItems.sort((a, b) => (zwNormModel(b.nr_modelu) === q) - (zwNormModel(a.nr_modelu) === q));
  zwComboActive = zwComboItems.length ? 0 : -1;

  const current = document.getElementById("zw-pour-model").value;
  list.innerHTML = zwComboItems.length
    ? zwComboItems.map((m, i) => `
        <li role="option" id="zw-combo-opt-${i}" class="${i === zwComboActive ? "active" : ""} ${String(m.id) === current ? "selected" : ""}"
            aria-selected="${String(m.id) === current}" data-id="${Number(m.id)}"
            onmousedown="event.preventDefault(); zwComboSelect(${Number(m.id)})">
          <span class="nr">${rtEsc(m.nr_modelu)}</span>
          <span class="w">${m.weight === null ? "waga brak" : zwKg(m.weight)}</span>
        </li>`).join("")
    : `<li class="empty">${zwLineModels.length ? "Brak modelu o takim numerze" : "Brak modeli na tej linii"}</li>`;
  zwComboShow(true);
}

function zwComboShow(open) {
  const list = document.getElementById("zw-combo-list");
  const input = document.getElementById("zw-pour-model-input");
  if (list) list.classList.toggle("open", open);
  if (input) input.setAttribute("aria-expanded", String(open));
}

function zwComboClose() {
  zwComboShow(false);
  zwComboActive = -1;
}

function zwComboFocus() {
  const input = document.getElementById("zw-pour-model-input");
  input.select();               // wpisanie nowego numeru od razu zastępuje poprzedni model
  zwComboRender("");
}

function zwComboInput() {
  const input = document.getElementById("zw-pour-model-input");
  document.getElementById("zw-pour-model").value = ""; // model wybiera się dopiero z listy
  zwComboRender(input.value);
  zwPourPreview();
}

function zwComboToggle() {
  const list = document.getElementById("zw-combo-list");
  const input = document.getElementById("zw-pour-model-input");
  if (list.classList.contains("open")) {
    zwComboClose();
  } else if (document.activeElement === input) {
    zwComboRender("");          // pole już ma fokus - samo focus() nie otworzyłoby listy
  } else {
    input.focus();              // zwComboFocus otworzy pełną listę
  }
}

function zwComboMove(step) {
  if (!zwComboItems.length) return;
  zwComboActive = (zwComboActive + step + zwComboItems.length) % zwComboItems.length;
  document.querySelectorAll("#zw-combo-list li[role=option]").forEach((li, i) =>
    li.classList.toggle("active", i === zwComboActive));
  document.getElementById(`zw-combo-opt-${zwComboActive}`)?.scrollIntoView({ block: "nearest" });
}

function zwComboKey(e) {
  const open = document.getElementById("zw-combo-list").classList.contains("open");
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (!open) zwComboRender(document.getElementById("zw-pour-model-input").value);
    else zwComboMove(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (open) zwComboMove(-1);
  } else if (e.key === "Enter") {
    // Enter wybiera podświetlony model, a nie zapisuje formularza
    if (open && zwComboActive >= 0) {
      e.preventDefault();
      zwComboSelect(zwComboItems[zwComboActive].id);
      document.getElementById("zw-pour-forms").focus();
    }
  } else if (e.key === "Escape") {
    if (open) {
      e.preventDefault();
      e.stopPropagation();
      zwComboSelect(document.getElementById("zw-pour-model").value || null);
    }
  }
}

// Wyjście z pola: jeśli wpisany numer pasuje do jednego modelu - wybierz go,
// w przeciwnym razie przywróć wybrany wcześniej model (albo puste pole)
function zwComboBlur() {
  const input = document.getElementById("zw-pour-model-input");
  const hidden = document.getElementById("zw-pour-model");
  if (!hidden.value) {
    const q = zwNormModel(input.value);
    const exact = zwLineModels.filter(m => zwNormModel(m.nr_modelu) === q);
    const partial = zwLineModels.filter(m => zwNormModel(m.nr_modelu).includes(q));
    const pick = exact.length === 1 ? exact[0] : (q && partial.length === 1 ? partial[0] : null);
    zwComboSelect(pick ? pick.id : null);
    return;
  }
  zwComboSelect(hidden.value);
}

// Podgląd: waga modelu x ilość form dobrych (formy zabrakowane nie wliczają się do wagi)
function zwPourPreview() {
  const el = document.getElementById("zw-pour-preview");
  if (!el) return;
  const model = zwLineModels.find(m => String(m.id) === document.getElementById("zw-pour-model").value);
  const forms = Number(document.getElementById("zw-pour-forms").value);
  const scrap = Number(document.getElementById("zw-pour-scrap").value) || 0;
  if (!model || model.weight === null || !(forms > 0)) {
    el.textContent = "Razem: wybierz model i ilość form dobrych";
    return;
  }
  el.innerHTML = `Razem: ${zwKg(model.weight)} × ${zwNum(forms)} = <strong>${zwKg(model.weight * forms)}</strong>` +
    (scrap > 0 ? ` <span class="zw-scrap-note">(+ ${zwNum(scrap)} zabrak., bez wagi)</span>` : "");
}

async function zwSavePour() {
  if (zwBusy) return;
  const ladle = document.getElementById("zw-pour-ladle").value.trim();
  const tempRaw = document.getElementById("zw-pour-temp").value.trim();
  const acelRaw = document.getElementById("zw-pour-acel").value.trim().replace(",", ".");
  const metalRaw = document.getElementById("zw-pour-metal").value.trim().replace(/\s/g, "");
  const modelId = document.getElementById("zw-pour-model").value;
  const formsRaw = document.getElementById("zw-pour-forms").value.trim();
  const scrapRaw = document.getElementById("zw-pour-scrap").value.trim();
  const notes = document.getElementById("zw-pour-notes").value.trim();
  const sample = document.getElementById("zw-pour-sample").checked;

  if (!ladle) return zwPourMsg("Podaj numer kadzi.");
  if (ladle.length !== ZW_LADLE_DIGITS || !/^\d+$/.test(ladle)) {
    return zwPourMsg(`Numer kadzi musi mieć dokładnie ${ZW_LADLE_DIGITS} cyfr (np. 0000123).`);
  }
  // temperatura metalu: obowiązkowa, zawsze dokładnie 4 cyfry (np. 1420 °C)
  if (!/^[1-9]\d{3}$/.test(tempRaw)) return zwPourMsg("Temperatura metalu musi mieć 4 cyfry, np. 1420.");
  // ACEL: nieobowiązkowy - puste pole zapisuje się jako 0,00; wpisany musi mieć 3 cyfry (c,cc, np. 4,32)
  if (acelRaw !== "" && !/^\d\.\d{2}$/.test(acelRaw)) return zwPourMsg("ACEL musi mieć 3 cyfry, np. 4,32, albo zostaw puste.");
  if (metalRaw === "") return zwPourMsg("Podaj, ile metalu wlano do kadzi (kg).");
  if (!/^\d{1,4}$/.test(metalRaw) || Number(metalRaw) <= 0) return zwPourMsg("Metal wlany do kadzi: od 1 do 9999 kg.");
  if (!modelId) return zwPourMsg("Wybierz model.");
  // formy dobre: liczba całkowita (0, gdy wszystkie zabrakowane); zabrakowane: puste = 0
  if (!/^\d+$/.test(formsRaw)) return zwPourMsg("Ilość form dobrych musi być liczbą (0 lub więcej).");
  if (scrapRaw !== "" && !/^\d+$/.test(scrapRaw)) return zwPourMsg("Ilość form zabrakowanych musi być liczbą (0 lub więcej).");
  const scrap = scrapRaw === "" ? 0 : Number(scrapRaw);
  if (Number(formsRaw) + scrap <= 0) return zwPourMsg("Wpisz co najmniej jedną formę (dobrą lub zabrakowaną).");
  if (zwScrapOn === false && Number(formsRaw) <= 0) return zwPourMsg("Ilość form dobrych musi być większa od zera.");

  const payload = {
    numer_kadzi: ladle,
    linia: zwTab,
    temperatura_metalu: Number(tempRaw),
    acel: acelRaw === "" ? 0 : Number(acelRaw),
    metal_kadz: Number(metalRaw),
    model_id: Number(modelId),
    ilosc_form: Number(formsRaw),
    // kolumna form zabrakowanych istnieje dopiero po sql/35
    ...(zwScrapOn === false ? {} : { ilosc_form_brak: scrap }),
    proba_przylana: sample,
    uwagi: notes || null
  };
  const editing = zwPourEditId !== null;

  // Ostrzeżenia przed dodaniem kadzi (z możliwością zapisu mimo to):
  //  - numer kadzi: ten sam / cofnięty numer albo duży skok na tym samym piecu, albo 8. kadź z rzędu z jednego pieca;
  //  - waga: waga zalewu różni się od metalu wlanego do kadzi o 200 kg lub więcej.
  if (!editing) {
    let ladleWarning = null;
    try {
      ladleWarning = await zwLadleWarning(ladle);
    } catch (err) {
      console.error("Błąd sprawdzania numeru kadzi:", err);
    }
    const weightWarning = zwWeightWarning(payload);
    if (ladleWarning || weightWarning) {
      zwPendingPour = payload;
      zwPendingEditing = editing;
      zwOpenLadleWarning({ ladle: ladleWarning, weight: weightWarning });
      return;
    }
  }

  await zwDoSavePour(payload, editing);
}

// Zapis zalewu (po walidacji i ewentualnym potwierdzeniu ostrzeżenia o numerze kadzi)
async function zwDoSavePour(payload, editing) {
  const btn = document.getElementById("zw-pour-save");
  zwBusy = true;
  if (btn) btn.disabled = true;
  zwPourMsg("");

  try {
    const query = editing
      ? supabaseClient.from("zalewy").update(payload).eq("id", zwPourEditId)
      : supabaseClient.from("zalewy").insert(payload);
    const { data, error } = await query.select("id");
    if (error) throw error;
    if (!data || data.length === 0) throw new Error("brak uprawnień w bazie");


    // nowy zalew trafia do bieżącego dnia i zmiany - pokaż je, żeby wpis był widoczny
    if (!editing) {
      const now = new Date();
      zwDate = zwProductionDate(now);
      if (zwShift) zwShift = zwShiftAt(now);
      zwSyncPeriod();
    }
    zwClosePour();
    await zwLoadPours();
  } catch (err) {
    console.error("Błąd zapisu zalewu:", err);
    zwPourMsg("Nie udało się zapisać: " + (err.message || err));
  } finally {
    zwBusy = false;
    if (btn) btn.disabled = false;
  }
}

// =====================================================================
// MODELE (zakładka Modele)
// Model może być przypisany do wielu linii (kolumna lines, sql/19).
// Filtr u góry: "Wszystkie" albo jedna linia.
// =====================================================================
function zwSetModelLine(line) {
  if ((line !== "" && !ZW_LINES.includes(line)) || line === zwModelLine) return;
  zwModelLine = line;
  const search = document.getElementById("zw-search");
  if (search) search.value = "";
  zwRenderTabs();
  zwLoadModels();
}

async function zwLoadModels() {
  const tbody = document.getElementById("zw-body");
  if (!tbody || !zwUser) return;
  const token = ++zwLoadToken;
  document.getElementById("zw-line-title").textContent =
    zwModelLine ? `Modele — ${zwModelLine}` : "Modele — wszystkie linie";

  tbody.innerHTML = `<tr><td colspan="6" class="ep-empty"><i class="fa-solid fa-spinner fa-spin"></i> Ładowanie modeli...</td></tr>`;

  let query = supabaseClient
    .from("modele")
    .select("id, nr_modelu, weight, lines, last_change, name_user_change");
  if (zwModelLine) query = query.contains("lines", [zwModelLine]);
  const { data, error } = await query;
  if (token !== zwLoadToken) return; // zmieniono zakładkę albo wylogowano

  if (error) {
    console.error("Błąd pobierania modeli:", error);
    zwModels = [];
    tbody.innerHTML = `<tr><td colspan="6" class="ep-empty" style="color: var(--danger);">
      Nie udało się pobrać modeli: ${rtEsc(error.message)}</td></tr>`;
    return;
  }

  zwModels = (data || []).sort((a, b) =>
    String(a.nr_modelu || "").localeCompare(String(b.nr_modelu || ""), "pl", { numeric: true }));
  zwRenderModels();
}

// Linie modelu w kolejności zakładek
function zwModelLines(m) {
  const lines = Array.isArray(m.lines) ? m.lines : [];
  return ZW_LINES.filter(l => lines.includes(l));
}

function zwRenderModels() {
  const tbody = document.getElementById("zw-body");
  const info = document.getElementById("zw-info");
  if (!tbody) return;

  const q = (document.getElementById("zw-search")?.value || "").toLowerCase().trim();
  const list = zwModels.filter(m => !q || String(m.nr_modelu || "").toLowerCase().includes(q));
  if (info) info.textContent = list.length === zwModels.length
    ? `Modeli: ${zwModels.length}` : `Modeli: ${list.length} z ${zwModels.length}`;

  if (list.length === 0) {
    const where = zwModelLine ? `na linii ${rtEsc(zwModelLine)}` : "";
    tbody.innerHTML = `<tr><td colspan="6" class="ep-empty">
      ${zwModels.length === 0 ? `Brak modeli ${where}. Dodaj pierwszy przyciskiem „Dodaj model”.` : "Brak modeli spełniających kryteria."}</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(m => {
    const lines = zwModelLines(m);
    return `
      <tr>
        <td class="zw-nr">${rtEsc(m.nr_modelu || "-")}</td>
        <td>${lines.length
          ? lines.map(l => `<span class="zw-line-chip">${rtEsc(l)}</span>`).join("")
          : `<span class="zw-line-chip none">brak linii</span>`}</td>
        <td class="zw-weight">${m.weight === null || m.weight === undefined ? "-" : zwKg(m.weight)}</td>
        <td>${rtEsc(m.last_change || "-")}</td>
        <td>${rtEsc(m.name_user_change || "-")}</td>
        <td class="zw-actions">
          <button type="button" class="zw-act" title="Edytuj" aria-label="Edytuj model ${rtEsc(m.nr_modelu)}" onclick="zwOpenModel(${Number(m.id)})"><i class="fa-solid fa-pen"></i></button>
          <button type="button" class="zw-act del" title="Usuń" aria-label="Usuń model ${rtEsc(m.nr_modelu)}" onclick="zwOpenDelete('model', ${Number(m.id)})"><i class="fa-solid fa-trash"></i></button>
        </td>
      </tr>`;
  }).join("");
}

function zwModelMsg(text) {
  const el = document.getElementById("zw-model-msg");
  if (!el) return;
  el.textContent = text;
  el.style.display = text ? "block" : "none";
}

function zwOpenModel(id) {
  const m = id ? zwModels.find(x => Number(x.id) === Number(id)) : null;
  zwModelEditId = m ? m.id : null;

  document.getElementById("zw-model-title").textContent = m ? "Edycja modelu" : "Nowy model";
  document.getElementById("zw-model-nr").value = m ? (m.nr_modelu || "") : "";
  document.getElementById("zw-model-weight").value = m && m.weight !== null && m.weight !== undefined ? m.weight : "";

  // linie: przy edycji zapisane, przy nowym modelu - linia wybrana w filtrze (jeśli jest)
  const selected = m ? zwModelLines(m) : (zwModelLine ? [zwModelLine] : []);
  document.getElementById("zw-model-lines").innerHTML = ZW_LINES.map(line => `
    <label class="zw-line-check">
      <input type="checkbox" value="${rtEsc(line)}" ${selected.includes(line) ? "checked" : ""} />
      <span>${rtEsc(line)}</span>
    </label>`).join("");

  zwModelMsg("");
  toggleModal("modal-zw-model", true);
  document.getElementById("zw-model-nr").focus();
}

function zwCloseModel() {
  zwModelEditId = null;
  toggleModal("modal-zw-model", false);
}

async function zwSaveModel() {
  if (zwBusy) return;
  const nr = document.getElementById("zw-model-nr").value.trim();
  const weightRaw = document.getElementById("zw-model-weight").value.trim();
  const lines = [...document.querySelectorAll("#zw-model-lines input:checked")].map(i => i.value);

  if (!nr) return zwModelMsg("Podaj numer modelu.");
  // waga to liczba całkowita (kolumna int8)
  if (weightRaw !== "" && !/^\d+$/.test(weightRaw)) return zwModelMsg("Waga musi być liczbą całkowitą, bez przecinka.");
  if (lines.length === 0) return zwModelMsg("Zaznacz co najmniej jedną linię.");

  const payload = { nr_modelu: nr, weight: weightRaw === "" ? null : Number(weightRaw), lines };
  const editing = zwModelEditId !== null;
  const btn = document.getElementById("zw-model-save");
  zwBusy = true;
  if (btn) btn.disabled = true;
  zwModelMsg("");

  try {
    // numer modelu jest jeden dla wszystkich linii - sprawdź w całej tabeli
    const { data: same, error: sameErr } = await supabaseClient
      .from("modele")
      .select("id, lines")
      .ilike("nr_modelu", nr.replace(/[%_\\]/g, "\\$&"));
    if (sameErr) throw sameErr;
    const other = (same || []).find(x => Number(x.id) !== Number(zwModelEditId));
    if (other) {
      const where = zwModelLines(other).join(", ");
      zwModelMsg(`Model ${nr} już istnieje${where ? ` (linie: ${where})` : ""}. Otwórz jego edycję i zaznacz kolejną linię.`);
      return;
    }

    const query = editing
      ? supabaseClient.from("modele").update(payload).eq("id", zwModelEditId)
      : supabaseClient.from("modele").insert(payload);
    const { data, error } = await query.select("id");
    if (error) throw error;
    if (!data || data.length === 0) throw new Error("brak uprawnień w bazie");

    zwCloseModel();
    await zwLoadModels();
  } catch (err) {
    console.error("Błąd zapisu modelu:", err);
    zwModelMsg("Nie udało się zapisać: " + (err.message || err));
  } finally {
    zwBusy = false;
    if (btn) btn.disabled = false;
  }
}

// =====================================================================
// USUWANIE (model albo zalew) - okno potwierdzenia z odliczaniem 3 s
// =====================================================================
function zwOpenDelete(kind, id) {
  // okno: tytuł, pytanie, pod nim linia ("Linia: Lora"), a pod nią usuwany model / zalew
  let title, question, line, target;
  if (kind === "model") {
    const m = zwModels.find(x => Number(x.id) === Number(id));
    if (!m) return;
    const lines = zwModelLines(m);
    // "Model:" zwykłą czcionką, pogrubiony tylko numer modelu
    [title, question, target] = ["Usuwanie modelu", "Czy na pewno chcesz usunąć model?", `Model: <b>${rtEsc(m.nr_modelu)}</b>`];
    line = `${lines.length > 1 ? "Linie" : "Linia"}: ${lines.join(", ") || "brak"}`;
  } else {
    const p = zwPours.find(x => Number(x.id) === Number(id));
    if (!p) return;
    // pod linią tylko numer kadzi (jak "Model:" przy usuwaniu modelu)
    [title, question, target] = ["Usuwanie kadzi", "Czy na pewno chcesz usunąć zalew?",
      `Kadź: <b>${rtEsc(p.numer_kadzi || "-")}</b>`];
    line = `Linia: ${zwTab}`;
  }
  zwDelete = { kind, id };
  document.getElementById("zw-delete-title").innerText = title;
  document.getElementById("zw-delete-question").innerText = question;
  document.getElementById("zw-delete-line").innerText = line;
  document.getElementById("zw-delete-target").innerHTML = target;   // dane już przepuszczone przez rtEsc

  const confirmBtn = document.getElementById("zw-btn-confirm-delete");
  if (zwDeleteTimer) clearInterval(zwDeleteTimer);
  let secondsLeft = 3;
  confirmBtn.disabled = true;
  confirmBtn.innerText = `Tak (${secondsLeft}s)`;
  zwDeleteTimer = setInterval(() => {
    secondsLeft--;
    if (secondsLeft > 0) {
      confirmBtn.innerText = `Tak (${secondsLeft}s)`;
    } else {
      clearInterval(zwDeleteTimer);
      zwDeleteTimer = null;
      confirmBtn.disabled = false;
      confirmBtn.innerText = "Tak";
    }
  }, 1000);

  toggleModal("modal-zw-delete", true);
}

function zwCloseDelete() {
  zwDelete = null;
  if (zwDeleteTimer) {
    clearInterval(zwDeleteTimer);
    zwDeleteTimer = null;
  }
  toggleModal("modal-zw-delete", false);
}

async function zwConfirmDelete() {
  const target = zwDelete;
  if (!target || zwBusy) return;
  const confirmBtn = document.getElementById("zw-btn-confirm-delete");
  confirmBtn.disabled = true;
  confirmBtn.innerText = "Usuwanie...";

  zwBusy = true;
  const table = target.kind === "model" ? "modele" : "zalewy";
  const { data, error } = await supabaseClient.from(table).delete().eq("id", target.id).select("id");
  zwBusy = false;
  zwCloseDelete();

  if (error || !data || data.length === 0) {
    console.error("Błąd usuwania:", error);
    alert("Nie udało się usunąć: " + (error ? error.message : "brak uprawnień w bazie"));
  }
  if (target.kind === "model") await zwLoadModels();
  else await zwLoadPours();
}

// ---------- Esc zamyka okna Zalewu (najpierw to, które jest na wierzchu) ----------
// Lista podpowiedzi modeli obsługuje Esc sama i zatrzymuje go, więc pierwszy Esc
// zwija listę, a dopiero drugi zamyka okno.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !zwUser) return;
  const open = id => document.getElementById(id)?.classList.contains("active");

  if (open("modal-zw-warn")) zwCloseLadleWarning();
  else if (open("modal-zw-delete")) zwCloseDelete();
  else if (open("modal-zw-model")) zwCloseModel();
  else if (open("modal-zw-pour")) zwClosePour();
  else return;
  e.preventDefault();
});
