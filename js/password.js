// ==========================================
// WYMUSZONA ZMIANA HASŁA
// Kolumna must_change_password (bool) w tabelach users i employees:
// true = przy najbliższym logowaniu trzeba ustawić własne hasło.
// Bez tej kolumny w bazie logowanie działa jak dotąd (zmiana nie jest wymuszana).
// Wymaga: supabaseClient, toggleModal (app.js)
// ==========================================

const FORCE_PASSWORD_MIN = 6;

let forcePasswordCtx = null;   // { table, id, current, onDone(newPassword) }
let forcePasswordSaving = false;

// Czy konto musi zmienić hasło. Błąd odczytu (np. brak kolumny) = nie wymuszaj.
async function passwordChangeRequired(table, id) {
  try {
    const { data, error } = await supabaseClient
      .from(table)
      .select("must_change_password")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return !!(data && data.must_change_password);
  } catch (err) {
    console.warn(`Nie udało się sprawdzić must_change_password w tabeli ${table}:`, err);
    return false;
  }
}

// Ustawia znacznik po zmianie hasła przez kogoś innego (true) albo przez właściciela (false).
// Błąd (np. brak kolumny) nie przerywa zapisu, który ten znacznik uzupełnia.
async function setPasswordChangeRequired(table, id, required, column = "id") {
  try {
    const { error } = await supabaseClient
      .from(table)
      .update({ must_change_password: required })
      .eq(column, id);
    if (error) throw error;
  } catch (err) {
    console.warn(`Nie udało się ustawić must_change_password w tabeli ${table}:`, err);
  }
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

function cancelForcePassword() {
  forcePasswordCtx = null;
  toggleModal("modal-force-password", false);
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
    const { data, error } = await supabaseClient
      .from(ctx.table)
      .update({ password: next, must_change_password: false })
      .eq("id", ctx.id)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) throw new Error("brak uprawnień w bazie");

    forcePasswordCtx = null;
    toggleModal("modal-force-password", false);
    ctx.onDone(next);
  } catch (err) {
    console.error("Błąd ustawiania nowego hasła:", err);
    forcePasswordMsg("Nie udało się zapisać hasła: " + (err.message || err));
  } finally {
    forcePasswordSaving = false;
    if (btn) btn.disabled = false;
  }
}
