// ==========================================
// EFEKTY EKRANU LOGOWANIA - ISKRY Z ODLEWNI
// Niezależny od app.js. Ładuj PO app.js.
// ==========================================
(() => {
  const overlay = document.getElementById("auth-overlay");
  const canvas = document.getElementById("foundry-sparks");
  const iconBox = document.getElementById("auth-icon-box");
  if (!overlay || !canvas) return;

  const ctx = canvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const MAX_SPARKS = 260;
  let sparks = [];
  let width = 0;
  let height = 0;
  let rafId = null;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Iskra unosząca się znad rozgrzanego metalu
  function spawnRising() {
    if (sparks.length >= MAX_SPARKS) return;
    const floorY = height - (width < 480 ? 50 : 70);
    sparks.push({
      x: Math.random() * width,
      y: floorY + Math.random() * 14,
      vx: (Math.random() - 0.5) * 0.9,
      vy: -(0.7 + Math.random() * 2.2),
      life: 0,
      max: 110 + Math.random() * 140,
      size: 0.8 + Math.random() * 1.7,
      hue: 36 + Math.random() * 16,
      wobble: Math.random() * Math.PI * 2
    });
  }

  // Wybuch iskier (po poprawnym zalogowaniu) - z okolic karty
  function burst(cx, cy, count = 90) {
    for (let i = 0; i < count; i++) {
      if (sparks.length >= MAX_SPARKS + 120) break;
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.5 + Math.random() * 5.5;
      sparks.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1,
        life: 0,
        max: 55 + Math.random() * 60,
        size: 1 + Math.random() * 2,
        hue: 38 + Math.random() * 14,
        wobble: Math.random() * Math.PI * 2
      });
    }
  }

  function tick() {
    ctx.clearRect(0, 0, width, height);

    // Gęstość iskier zależna od szerokości ekranu
    const rate = width < 600 ? 0.5 : 1.1;
    if (Math.random() < rate) spawnRising();
    if (Math.random() < rate * 0.5) spawnRising();

    ctx.globalCompositeOperation = "lighter";

    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life++;
      s.wobble += 0.08;
      s.vx += Math.sin(s.wobble) * 0.02;
      s.vy += 0.012; // lekka grawitacja - iskra zwalnia i opada
      s.x += s.vx;
      s.y += s.vy;

      const t = s.life / s.max;
      if (t >= 1 || s.y < -10 || s.x < -10 || s.x > width + 10) {
        sparks.splice(i, 1);
        continue;
      }

      const flicker = 0.75 + Math.random() * 0.25;
      const alpha = (1 - t) * flicker;
      const lightness = 62 - t * 18; // od żółtej do ciemnej pomarańczy

      // halo
      ctx.fillStyle = `hsla(${s.hue}, 100%, ${lightness}%, ${alpha * 0.18})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size * 3.2, 0, Math.PI * 2);
      ctx.fill();

      // rdzeń
      ctx.fillStyle = `hsla(${s.hue}, 100%, ${lightness + 14}%, ${alpha})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = "source-over";
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (rafId !== null || reduceMotion) return;
    resize();
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    sparks = [];
  }

  window.addEventListener("resize", () => { if (rafId !== null) resize(); });

  // Zatrzymaj animację, gdy nakładka jest ukryta (po zalogowaniu), wznów po wylogowaniu
  new MutationObserver(() => {
    if (overlay.style.display === "none") stop();
    else start();
  }).observe(overlay, { attributes: true, attributeFilter: ["style"] });

  // Wybuch iskier w momencie pokazania zielonego ptaszka
  if (iconBox && !reduceMotion) {
    new MutationObserver(() => {
      if (iconBox.classList.contains("state-success")) {
        const rect = iconBox.getBoundingClientRect();
        burst(rect.left + rect.width / 2, rect.top + rect.height / 2);
      }
    }).observe(iconBox, { attributes: true, attributeFilter: ["class"] });
  }

  // Enter w polach loguje (bez zmian w app.js)
  ["login-input", "password-input"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const btn = document.getElementById("btn-login");
      if (btn && !btn.disabled && typeof handleLogin === "function") {
        e.preventDefault();
        handleLogin();
      }
    });
  });

  start();
})();
// ==========================================
// DODATKI FORMULARZA: podgląd hasła i ostrzeżenie o Caps Locku
// ==========================================
(() => {
  const input = document.getElementById("password-input");
  const toggle = document.getElementById("login-pass-toggle");
  const capsHint = document.getElementById("login-caps-hint");
  if (!input) return;

  if (toggle) {
    toggle.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      const label = show ? "Ukryj hasło" : "Pokaż hasło";
      toggle.setAttribute("aria-label", label);
      toggle.title = label;
      toggle.innerHTML = `<i class="fa-solid ${show ? "fa-eye-slash" : "fa-eye"}"></i>`;
      input.focus();
    });
  }

  if (capsHint) {
    const update = (e) => {
      if (typeof e.getModifierState !== "function") return;
      capsHint.classList.toggle("visible", e.getModifierState("CapsLock"));
    };
    input.addEventListener("keydown", update);
    input.addEventListener("keyup", update);
    input.addEventListener("blur", () => capsHint.classList.remove("visible"));
  }
})();
