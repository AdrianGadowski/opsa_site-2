// ==========================================
// EKRAN LOGOWANIA: ZEGAR I ZMIANY (nowy wygląd, css/login-v2.css)
// Duży zegar-kołowrotek (HH:MM:SS), data, kafelki zmian I / II / III z bieżącą zmianą i paskiem postępu.
// W ostatnich 15 minutach zmiany: pomarańczowy pasek i "kończy się".
// Zmiany jak w całym systemie: I 06:30–14:30, II 14:30–22:30, III 22:30–06:30.
// Niezależny od app.js; odświeża się tylko, gdy ekran logowania jest widoczny.
// ==========================================
(() => {
  const overlay = document.getElementById("auth-overlay");
  const clock = document.getElementById("lv2-clock");
  if (!overlay || !clock) return;

  const NAMES = ["I", "II", "III"];
  const RANGES = ["06:30–14:30", "14:30–22:30", "22:30–06:30"];
  const SHIFT_START = 390;   // 06:30 w minutach
  const SHIFT_LEN = 480;     // 8 h
  const ENDING_MIN = 15;     // "kończy się" na tyle minut przed końcem

  // ---------- Zegar-kołowrotek: HH:MM i mniejsze :SS ----------
  // Zmieniająca się cyfra wjeżdża z góry, stara wyjeżdża w dół; przy kilku zmianach naraz kolejno od prawej.
  // Nowa cyfra godzin i minut przez chwilę świeci kolorem żaru.
  clock.innerHTML = `<span class="reel"></span><span class="reel"></span><span class="colon">:</span><span class="reel"></span><span class="reel"></span>` +
    `<span class="secs"><span class="colon">:</span><span class="reel"></span><span class="reel"></span></span>`;
  const reels = [...clock.querySelectorAll(".reel")];
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let shown = "";

  function renderClock(digits) {
    if (digits === shown) return;
    const prev = reduceMotion ? "" : shown;
    shown = digits;
    let delay = 0;
    for (let i = reels.length - 1; i >= 0; i--) {
      const reel = reels[i];
      const next = digits[i];
      if (prev && prev[i] === next) continue;
      const old = reel.querySelector("span:not(.out)");
      const span = document.createElement("span");
      span.textContent = next;
      if (prev) {
        span.className = "in";
        span.style.animationDelay = `${delay}ms`;
        if (old) {
          old.className = "out";
          old.style.animationDelay = `${delay}ms`;
          setTimeout(() => old.remove(), 750 + delay);
        }
        if (i < 4) {
          reel.classList.add("flash");
          setTimeout(() => reel.classList.remove("flash"), 1300 + delay);
        }
        delay += 110;
      } else if (old) {
        old.remove();
      }
      reel.appendChild(span);
    }
  }

  function clockTick() {
    if (overlay.style.display === "none") return;
    const now = new Date();
    const p = n => String(n).padStart(2, "0");
    renderClock(`${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`);
  }

  function tick() {
    if (overlay.style.display === "none") return;
    const now = new Date();
    const p = n => String(n).padStart(2, "0");
    const m = (now.getHours() * 60 + now.getMinutes() - SHIFT_START + 1440) % 1440;
    const idx = Math.floor(m / SHIFT_LEN);
    const left = SHIFT_LEN - (m % SHIFT_LEN);

    const date = document.getElementById("lv2-date");
    if (date) {
      const text = now.toLocaleDateString("pl-PL", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      date.textContent = text.charAt(0).toUpperCase() + text.slice(1);
    }
    const shift = document.getElementById("lv2-shift");
    if (shift) {
      shift.textContent = `Trwa zmiana ${NAMES[idx]} (${RANGES[idx]}) — do końca ${Math.floor(left / 60)} h ${left % 60} min`;
    }
    overlay.querySelectorAll(".lv2-left [data-seg]").forEach(seg => {
      const on = Number(seg.dataset.seg) === idx;
      seg.classList.toggle("on", on);
      seg.classList.toggle("ending", on && left <= ENDING_MIN);
      const bar = seg.querySelector(".bar i");
      if (bar) bar.style.width = on ? `${((m % SHIFT_LEN) / SHIFT_LEN) * 100}%` : "0";
    });
  }

  clockTick();
  setInterval(clockTick, 1000);
  tick();
  setInterval(tick, 15000);
  // po wylogowaniu ekran wraca - od razu aktualna godzina
  new MutationObserver(() => { clockTick(); tick(); }).observe(overlay, { attributes: true, attributeFilter: ["style"] });
})();

// ==========================================
// ZAKŁADKI LOGOWANIA: zaznaczenie "pływa" do wybranej zakładki (jak wskaźnik w menu bocznym)
// Reaguje na zmianę klasy "on" (setLoginMode), ukrycie zakładek (moduły) i zmianę rozmiaru okna.
// ==========================================
(() => {
  const tabs = document.querySelector("#auth-overlay.lv2 .login-tabs");
  if (!tabs) return;

  const indicator = document.createElement("span");
  indicator.className = "lt-indicator";
  indicator.setAttribute("aria-hidden", "true");
  tabs.prepend(indicator);

  let wasVisible = false;
  let movingTimer = null;

  function place(instant) {
    const active = tabs.querySelector("button.on");
    if (!active || active.offsetParent === null || !tabs.offsetWidth) {
      indicator.classList.remove("visible");
      wasVisible = false;
      return;
    }
    const skip = instant || !wasVisible;
    if (skip) indicator.classList.add("no-anim");
    indicator.style.width = `${active.offsetWidth}px`;
    indicator.style.height = `${active.offsetHeight}px`;
    indicator.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    indicator.classList.add("visible");
    if (skip) {
      void indicator.offsetWidth;            // bez animacji przy pierwszym pokazaniu
      indicator.classList.remove("no-anim");
    } else {
      indicator.classList.add("is-moving");
      clearTimeout(movingTimer);
      movingTimer = setTimeout(() => indicator.classList.remove("is-moving"), 500);
    }
    wasVisible = true;
  }

  // zmiany samego wskaźnika są pomijane - inaczej obserwator wywoływałby się w kółko
  new MutationObserver(records => {
    if (records.some(r => r.target !== indicator)) place(false);
  }).observe(tabs, { subtree: true, attributes: true, attributeFilter: ["class", "style"] });
  addEventListener("resize", () => place(true));
  // ekran logowania wraca po wylogowaniu
  const overlay = document.getElementById("auth-overlay");
  if (overlay) new MutationObserver(() => place(true)).observe(overlay, { attributes: true, attributeFilter: ["style"] });
  requestAnimationFrame(() => place(true));
  document.fonts?.ready.then(() => place(true));
})();

// ==========================================
// KAFELKI ZMIAN 3D: po najechaniu kafelek przechyla się za kursorem
// ==========================================
(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  document.querySelectorAll("#auth-overlay.lv2 .lv2-left .seg").forEach(seg => {
    seg.addEventListener("mousemove", e => {
      const r = seg.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;    // -0.5 .. 0.5
      const y = (e.clientY - r.top) / r.height - 0.5;
      seg.style.setProperty("--ry", `${(x * 16).toFixed(1)}deg`);
      seg.style.setProperty("--rx", `${(-y * 12 - 6).toFixed(1)}deg`);
    });
    seg.addEventListener("mouseleave", () => {
      seg.style.removeProperty("--ry");
      seg.style.removeProperty("--rx");
    });
  });
})();

// ==========================================
// KARTA LOGOWANIA 3D: połysk światła podążający za kursorem (karta się nie przechyla)
// (tylko mysz; na dotyku i przy ograniczonych animacjach - bez ruchu)
// ==========================================
(() => {
  const card = document.querySelector("#auth-overlay.lv2 .unified-auth-card");
  if (!card || window.matchMedia("(prefers-reduced-motion: reduce), (hover: none)").matches) return;
  card.addEventListener("mousemove", e => {
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;      // 0..1
    const y = (e.clientY - r.top) / r.height;
    card.classList.add("tilting");
    card.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
    card.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
  });
  card.addEventListener("mouseleave", () => {
    card.classList.remove("tilting");
  });
})();
