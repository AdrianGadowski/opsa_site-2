// ==========================================
// WYMUSZONA ZMIANA HASŁA
// Kolumna must_change_password (bool) w tabelach users i employees:
// true = po zalogowaniu trzeba ustawić własne hasło, zanim wejdzie się dalej.
// Hasła trzyma Supabase Auth. Zmianę robi funkcja bazy app_change_own_password,
// która sprawdza dotychczasowe hasło, zapisuje nowe i zdejmuje znacznik.
// Wymaga: supabaseClient, toggleModal (app.js)
// ==========================================

const FORCE_PASSWORD_MIN = 6;

let forcePasswordCtx = null;   // { current, onDone(), onCancel() } - użytkownik jest już zalogowany hasłem tymczasowym
let forcePasswordSaving = false;

// Zmiana własnego hasła zalogowanej osoby (użytkownik systemu albo pracownik)
async function changeOwnPassword(current, next) {
  const { error } = await supabaseClient.rpc("app_change_own_password", {
    p_current: current,
    p_new: next
  });
  if (error) throw error;
}

// ---------- Okno ustawiania własnego hasła ----------
function openForcePassword(ctx) {
  forcePasswordCtx = ctx;
  document.getElementById("force-pass-new").value = "";
  document.getElementById("force-pass-repeat").value = "";
  forcePasswordMsg("");
  toggleModal("modal-force-password", true);
  document.getElementById("force-pass-new").focus();
}

// Rezygnacja: bez własnego hasła nie ma wejścia, więc sesja jest zamykana
function cancelForcePassword() {
  const ctx = forcePasswordCtx;
  forcePasswordCtx = null;
  toggleModal("modal-force-password", false);
  if (ctx && ctx.onCancel) ctx.onCancel();
}

function forcePasswordMsg(text) {
  const el = document.getElementById("force-pass-msg");
  if (!el) return;
  el.textContent = text;
  el.style.display = text ? "block" : "none";
}

async function submitForcePassword() {
  const ctx = forcePasswordCtx;
  if (!ctx || forcePasswordSaving) return;

  const next = document.getElementById("force-pass-new").value;
  const repeat = document.getElementById("force-pass-repeat").value;

  if (next.length < FORCE_PASSWORD_MIN) {
    forcePasswordMsg(`Hasło musi mieć co najmniej ${FORCE_PASSWORD_MIN} znaków.`);
    return;
  }
  if (next !== repeat) {
    forcePasswordMsg("Hasło i jego powtórzenie różnią się.");
    return;
  }
  if (next === ctx.current) {
    forcePasswordMsg("Nowe hasło musi być inne niż dotychczasowe.");
    return;
  }

  const btn = document.getElementById("force-pass-save");
  forcePasswordSaving = true;
  if (btn) btn.disabled = true;
  forcePasswordMsg("");

  try {
    await changeOwnPassword(ctx.current, next);

    forcePasswordCtx = null;
    toggleModal("modal-force-password", false);
    ctx.onDone();
  } catch (err) {
    console.error("Błąd ustawiania nowego hasła:", err);
    forcePasswordMsg("Nie udało się zapisać hasła: " + (err.message || err));
  } finally {
    forcePasswordSaving = false;
    if (btn) btn.disabled = false;
  }
}
