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
// zakładka Modele - słownik modeli z wagą (tabela modele, sql/13).
const ZW_LINES = ["Lora", "HWS", "HWS-D", "SMS"];
const ZW_MODELS_TAB = "Modele";

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

function zwNum(value) {
  return Number(value || 0).toLocaleString("pl-PL");
}

// Waga z jednostką, np. "1 250 kg"
function zwKg(value) {
  return `${zwNum(value)} kg`;
}

function zwToday() {
  return zwIso(new Date());
}

function zwIso(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- Zmiany ----------
// Zmiana III trwa przez północ i należy do dnia, w którym się zaczęła.
// Luka 06:30-06:40 między zmianą III a I jest liczona do zmiany III.
const ZW_SHIFTS = [
  { name: "Zmiana I", from: "06:40", to: "14:30" },
  { name: "Zmiana II", from: "14:30", to: "22:30" },
  { name: "Zmiana III", from: "22:30", to: "06:40" }
];
let zwShift = "";            // filtr zmiany ("" = wszystkie)

function zwMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Zmiana trwająca w podanej chwili
function zwShiftAt(date) {
  const t = date.getHours() * 60 + date.getMinutes();
  if (t >= zwMinutes("06:40") && t < zwMinutes("14:30")) return "Zmiana I";
  if (t >= zwMinutes("14:30") && t < zwMinutes("22:30")) return "Zmiana II";
  return "Zmiana III";
}

// Dzień produkcyjny: przed 06:40 trwa jeszcze zmiana III z poprzedniego dnia
function zwProductionDate(date) {
  const d = new Date(date);
  if (d.getHours() * 60 + d.getMinutes() < zwMinutes("06:40")) d.setDate(d.getDate() - 1);
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
  const dateEl = document.getElementById("zw-date");
  if (dateEl) dateEl.value = zwDate;
  const shiftEl = document.getElementById("zw-shift");
  if (shiftEl) {
    shiftEl.innerHTML = `<option value="">Wszystkie zmiany</option>` +
      ZW_SHIFTS.map(s => `<option value="${s.name}">${zwShiftLabel(s.name)}</option>`).join("");
    shiftEl.value = zwShift;
  }
  zwRenderTabs();
  zwShowTab();
}

function zwRenderTabs() {
  const el = document.getElementById("zw-tabs");
  if (el) {
    el.innerHTML = [...ZW_LINES, ZW_MODELS_TAB].map(tab => `
      <button type="button" role="tab" class="${tab === zwTab ? "on" : ""} ${tab === ZW_MODELS_TAB ? "models" : ""}"
              aria-selected="${tab === zwTab}" data-tab="${rtEsc(tab)}" onclick="zwSetTab(this.dataset.tab)">
        ${tab === ZW_MODELS_TAB ? `<i class="fa-solid fa-cubes"></i> ` : ""}${rtEsc(tab)}
      </button>`).join("");
  }

  const sub = document.getElementById("zw-model-tabs");
  if (sub) {
    sub.innerHTML = ["", ...ZW_LINES].map(line => `
      <button type="button" class="${line === zwModelLine ? "on" : ""}" aria-pressed="${line === zwModelLine}"
              data-line="${rtEsc(line)}" onclick="zwSetModelLine(this.dataset.line)">${rtEsc(line || "Wszystkie")}</button>`).join("");
  }
}

function zwSetTab(tab) {
  if (tab === zwTab || ![...ZW_LINES, ZW_MODELS_TAB].includes(tab)) return;
  zwTab = tab;
  zwRenderTabs();
  zwShowTab();
}

function zwShowTab() {
  const models = zwTab === ZW_MODELS_TAB;
  document.getElementById("zw-pours-card").style.display = models ? "none" : "";
  document.getElementById("zw-models-card").style.display = models ? "" : "none";
  if (models) {
    zwLoadModels();
  } else {
    document.getElementById("zw-pours-title").textContent = `Zalewy — ${zwTab}`;
    zwLoadPours();
  }
}

function zwOnDateChange() {
  zwDate = document.getElementById("zw-date").value || zwToday();
  zwLoadPours();
}

function zwOnShiftChange() {
  zwShift = document.getElementById("zw-shift").value || "";
  zwLoadPours();
}

// =====================================================================
// ZALEWY
// =====================================================================
async function zwLoadPours() {
  const tbody = document.getElementById("zw-pours-body");
  if (!tbody || !zwUser) return;
  const token = ++zwLoadToken;

  tbody.innerHTML = `<tr><td colspan="12" class="ep-empty"><i class="fa-solid fa-spinner fa-spin"></i> Ładowanie zalewów...</td></tr>`;
  document.getElementById("zw-sum").innerHTML = "";

  let query = supabaseClient
    .from("zalewy")
    .select("id, data_zalewu, zmiana, numer_kadzi, temperatura_metalu, acel, metal_kadz, model_id, nr_modelu, waga, ilosc_form, waga_razem, proba_przylana, uwagi, created_at, created_by, model:model_id ( nr_modelu, weight )")
    .eq("linia", zwTab)
    .eq("data_zalewu", zwDate)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (zwShift) query = query.eq("zmiana", zwShift);

  const { data, error } = await query;
  if (token !== zwLoadToken) return;

  if (error) {
    console.error("Błąd pobierania zalewów:", error);
    zwPours = [];
    tbody.innerHTML = `<tr><td colspan="12" class="ep-empty" style="color: var(--danger);">
      Nie udało się pobrać zalewów: ${rtEsc(error.message)}</td></tr>`;
    return;
  }

  // kolejność zmian I, II, III; w zmianie według czasu wpisu
  zwPours = (data || []).sort((a, b) =>
    zwShiftOrder(a.zmiana) - zwShiftOrder(b.zmiana) || String(a.created_at).localeCompare(String(b.created_at)));
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
    weight: rows.reduce((s, p) => s + zwPourTotal(p), 0),
    ladles: new Set(rows.map(p => `${p.zmiana}|${String(p.numer_kadzi || "").trim()}`)).size
  };
}

function zwRenderPours() {
  const tbody = document.getElementById("zw-pours-body");
  const sum = document.getElementById("zw-sum");
  if (!tbody) return;

  const total = zwSums(zwPours);
  sum.innerHTML = `
    <div class="zw-tile"><div class="lbl">Kadzi</div><div class="val">${zwNum(total.ladles)}</div></div>
    <div class="zw-tile"><div class="lbl">Zalanych form</div><div class="val">${zwNum(total.forms)}</div></div>
    <div class="zw-tile main"><div class="lbl">Waga łącznie</div><div class="val">${zwKg(total.weight)}</div></div>`;

  const scope = zwShift ? zwShiftLabel(zwShift) : "wszystkie zmiany";
  if (zwPours.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" class="ep-empty">Brak zalewów na linii ${rtEsc(zwTab)} (${rtEsc(scope)}) w wybranym dniu. Dodaj pierwszy przyciskiem „Dodaj kadź”.</td></tr>`;
    return;
  }

  const showShifts = !zwShift; // przy jednej zmianie nagłówki zmian są zbędne
  let html = "";

  zwGroupBy(zwPours, p => p.zmiana || "").forEach((shiftRows, shiftName) => {
    if (showShifts) {
      html += `<tr class="zw-shifthead"><td colspan="12"><i class="fa-solid fa-clock"></i> ${rtEsc(zwShiftLabel(shiftName))}</td></tr>`;
    }

    zwGroupBy(shiftRows, p => String(p.numer_kadzi || "").trim() || "-").forEach((rows, ladle) => {
      rows.forEach(p => {
        html += `
          <tr>
            <td>${zwTime(p.created_at)}</td>
            <td class="zw-nr">${rtEsc(p.numer_kadzi || "-")}</td>
            <td>${p.temperatura_metalu === null ? "-" : `${rtEsc(p.temperatura_metalu)} °C`}</td>
            <td>${p.acel === null ? "-" : rtEsc(Number(p.acel).toLocaleString("pl-PL", { maximumFractionDigits: 3 }))}</td>
            <td class="zw-weight">${p.metal_kadz === null || p.metal_kadz === undefined ? "-" : zwKg(p.metal_kadz)}</td>
            <td class="zw-model">${rtEsc(p.nr_modelu || p.model?.nr_modelu || "-")}</td>
            <td class="zw-weight">${zwPourWeight(p) === null ? "-" : zwKg(zwPourWeight(p))}</td>
            <td class="zw-weight">${zwNum(p.ilosc_form)}</td>
            <td class="zw-total">${zwKg(zwPourTotal(p))}</td>
            <td>${p.proba_przylana ? `<span class="zw-sample yes"><i class="fa-solid fa-flask"></i> Tak</span>` : `<span class="zw-sample">Nie</span>`}</td>
            <td class="zw-note">${p.uwagi ? `<span title="${rtEsc(p.uwagi)}">${rtEsc(p.uwagi)}</span>` : ""}</td>
            <td class="zw-actions">
              <button type="button" class="zw-act" title="Edytuj" aria-label="Edytuj zalew" onclick="zwOpenPour(${Number(p.id)})"><i class="fa-solid fa-pen"></i></button>
              <button type="button" class="zw-act del" title="Usuń" aria-label="Usuń zalew" onclick="zwOpenDelete('pour', ${Number(p.id)})"><i class="fa-solid fa-trash"></i></button>
            </td>
          </tr>`;
      });
    });

    if (showShifts) {
      const s = zwSums(shiftRows);
      html += `
        <tr class="zw-shifttotal">
          <td colspan="7">Razem ${rtEsc(shiftName || "bez zmiany")} (kadzi: ${zwNum(s.ladles)})</td>
          <td class="zw-weight">${zwNum(s.forms)}</td>
          <td class="zw-total">${zwKg(s.weight)}</td>
          <td></td>
          <td></td>
          <td></td>
        </tr>`;
    }
  });

  html += `
    <tr class="zw-grandtotal">
      <td colspan="7">Razem ${rtEsc(zwTab)}, ${rtEsc(rtIsoToPl(zwDate))}, ${rtEsc(scope)}</td>
      <td class="zw-weight">${zwNum(total.forms)}</td>
      <td class="zw-total">${zwKg(total.weight)}</td>
      <td></td>
      <td></td>
      <td></td>
    </tr>`;
  tbody.innerHTML = html;
}

// ---------- Okno zalewu (dodawanie / edycja) ----------
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

let zwPendingPour = null;    // zalew czekający na potwierdzenie ostrzeżenia o numerze kadzi

function zwOpenLadleWarning(text) {
  document.getElementById("zw-warn-text").textContent = text;
  toggleModal("modal-zw-warn", true);
}

// "Popraw numer" - wraca do okna zalewu
function zwCloseLadleWarning() {
  zwPendingPour = null;
  toggleModal("modal-zw-warn", false);
  document.getElementById("zw-pour-ladle")?.focus();
}

// "Zapisz mimo to"
async function zwConfirmLadleWarning() {
  const payload = zwPendingPour;
  zwPendingPour = null;
  toggleModal("modal-zw-warn", false);
  if (payload) await zwDoSavePour(payload, false);
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
  document.getElementById("zw-pour-acel").value = p ? (p.acel ?? "") : "";
  document.getElementById("zw-pour-metal").value = p ? (p.metal_kadz ?? "") : "";
  document.getElementById("zw-pour-forms").value = p ? p.ilosc_form : "";
  document.getElementById("zw-pour-notes").value = p ? (p.uwagi || "") : "";
  document.getElementById("zw-pour-sample").checked = !!(p && p.proba_przylana);
  // nowy wpis: numer kadzi = ostatnia kadź ze wszystkich linii + 1 (pole można zmienić)
  if (!p) zwSuggestLadle();

  // Zmiany nie wybiera się: przy nowym wpisie wynika z aktualnej godziny (ustawia ją baza),
  // przy edycji zostaje zapisana
  const now = new Date();
  const shiftName = p ? p.zmiana : zwShiftAt(now);
  const shiftDay = p ? p.data_zalewu : zwProductionDate(now);
  document.getElementById("zw-pour-shift").innerHTML =
    `<i class="fa-solid fa-clock"></i> ${rtEsc(zwShiftLabel(shiftName))}, ${rtEsc(rtIsoToPl(shiftDay))}` +
    `<span>${p ? "zmiana zapisana przy dodaniu" : "według aktualnej godziny"}</span>`;
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

// Podgląd: waga modelu x ilość form
function zwPourPreview() {
  const el = document.getElementById("zw-pour-preview");
  if (!el) return;
  const model = zwLineModels.find(m => String(m.id) === document.getElementById("zw-pour-model").value);
  const forms = Number(document.getElementById("zw-pour-forms").value);
  if (!model || model.weight === null || !(forms > 0)) {
    el.textContent = "Razem: wybierz model i ilość form";
    return;
  }
  el.innerHTML = `Razem: ${zwKg(model.weight)} × ${zwNum(forms)} = <strong>${zwKg(model.weight * forms)}</strong>`;
}

async function zwSavePour() {
  if (zwBusy) return;
  const ladle = document.getElementById("zw-pour-ladle").value.trim();
  const tempRaw = document.getElementById("zw-pour-temp").value.trim();
  const acelRaw = document.getElementById("zw-pour-acel").value.trim().replace(",", ".");
  const metalRaw = document.getElementById("zw-pour-metal").value.trim().replace(/\s/g, "");
  const modelId = document.getElementById("zw-pour-model").value;
  const formsRaw = document.getElementById("zw-pour-forms").value.trim();
  const notes = document.getElementById("zw-pour-notes").value.trim();
  const sample = document.getElementById("zw-pour-sample").checked;

  if (!ladle) return zwPourMsg("Podaj numer kadzi.");
  if (ladle.length !== ZW_LADLE_DIGITS || !/^\d+$/.test(ladle)) {
    return zwPourMsg(`Numer kadzi musi mieć dokładnie ${ZW_LADLE_DIGITS} cyfr (np. 0000123).`);
  }
  if (tempRaw !== "" && !/^\d+$/.test(tempRaw)) return zwPourMsg("Temperatura metalu musi być liczbą całkowitą (°C).");
  if (acelRaw !== "" && !/^-?\d+(\.\d+)?$/.test(acelRaw)) return zwPourMsg("ACEL musi być liczbą, np. 4,25.");
  if (metalRaw === "") return zwPourMsg("Podaj, ile metalu wlano do kadzi (kg).");
  if (!/^\d+$/.test(metalRaw) || Number(metalRaw) <= 0) return zwPourMsg("Metal wlany do kadzi musi być liczbą całkowitą większą od zera (kg).");
  if (!modelId) return zwPourMsg("Wybierz model.");
  if (!/^\d+$/.test(formsRaw) || Number(formsRaw) <= 0) return zwPourMsg("Ilość form musi być liczbą całkowitą większą od zera.");

  const payload = {
    numer_kadzi: ladle,
    linia: zwTab,
    temperatura_metalu: tempRaw === "" ? null : Number(tempRaw),
    acel: acelRaw === "" ? null : Number(acelRaw),
    metal_kadz: Number(metalRaw),
    model_id: Number(modelId),
    ilosc_form: Number(formsRaw),
    proba_przylana: sample,
    uwagi: notes || null
  };
  const editing = zwPourEditId !== null;

  // Ostrzeżenie (z możliwością zapisu mimo to): ten sam / cofnięty numer albo duży skok
  // na tym samym piecu, albo 8. kadź z rzędu z jednego pieca.
  if (!editing) {
    let warning = null;
    try {
      warning = await zwLadleWarning(ladle);
    } catch (err) {
      console.error("Błąd sprawdzania numeru kadzi:", err);
    }
    if (warning) {
      zwPendingPour = payload;
      zwOpenLadleWarning(warning);
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
      const dateEl = document.getElementById("zw-date");
      const shiftEl = document.getElementById("zw-shift");
      if (dateEl) dateEl.value = zwDate;
      if (shiftEl) shiftEl.value = zwShift;
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
  let title, question, target;
  if (kind === "model") {
    const m = zwModels.find(x => Number(x.id) === Number(id));
    if (!m) return;
    [title, question, target] = ["Usuwanie modelu", "Czy na pewno chcesz usunąć model", `${m.nr_modelu} (linie: ${zwModelLines(m).join(", ") || "brak"})`];
  } else {
    const p = zwPours.find(x => Number(x.id) === Number(id));
    if (!p) return;
    [title, question, target] = ["Usuwanie zalewu", "Czy na pewno chcesz usunąć zalew",
      `kadź ${p.numer_kadzi}, model ${p.nr_modelu || "-"}, form: ${p.ilosc_form}`];
  }
  zwDelete = { kind, id };
  document.getElementById("zw-delete-title").innerText = title;
  document.getElementById("zw-delete-question").innerText = question;
  document.getElementById("zw-delete-target").innerText = target;

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
