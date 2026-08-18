/*
 * Boekingswidget-launcher — plak dit als <script>-tag op eender welke
 * website (nu Wix, later een eigen site, maakt niet uit) om de boekingswidget
 * als POP-UP te tonen in plaats van een volledig scherm: een overlay met een
 * gecentreerd venster, de rand van de eigen website blijft zichtbaar
 * rondom. Zie README.md ("Widget embedden") voor het volledige
 * plak-en-klaar voorbeeld.
 *
 * Gebruik:
 *   <script src="https://JOUW-DOMEIN/embed.js" data-widget-url="https://JOUW-DOMEIN/widget"></script>
 *   <button data-atelierdoen-booking>Boek nu</button>
 *
 * Elk element met het attribuut data-atelierdoen-booking opent de pop-up bij
 * een klik — dat mag een knop zijn die je zelf al hebt (eigen kleur/tekst),
 * dit script bemoeit zich niet met hoe die knop eruitziet. Ook bruikbaar
 * vanuit eigen code: window.AtelierDoenBooking.open() / .close().
 */
(function () {
  "use strict";

  var currentScript = document.currentScript;
  var WIDGET_URL =
    (currentScript && currentScript.getAttribute("data-widget-url")) ||
    "/widget"; // fallback: enkel zinvol als dit script op hetzelfde domein als de widget zelf draait

  var overlay = null;
  var iframe = null;
  var lastFocused = null;
  var scrollY = 0;

  function injectStyles() {
    if (document.getElementById("atelierdoen-booking-style")) return;
    var style = document.createElement("style");
    style.id = "atelierdoen-booking-style";
    style.textContent =
      ".adb-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(20,18,15,0.55);" +
      "display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;" +
      "opacity:0;transition:opacity 0.18s ease;}" +
      ".adb-overlay.adb-open{opacity:1;}" +
      ".adb-modal{position:relative;width:min(480px,94vw);height:min(760px,92vh);" +
      "background:#1C1C1F;border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.4);" +
      "transform:translateY(8px) scale(0.98);transition:transform 0.18s ease;}" +
      ".adb-overlay.adb-open .adb-modal{transform:translateY(0) scale(1);}" +
      ".adb-modal iframe{width:100%;height:100%;border:0;display:block;background:#1C1C1F;}" +
      ".adb-close{position:absolute;top:8px;right:8px;z-index:1;width:32px;height:32px;" +
      "border-radius:50%;border:none;background:rgba(0,0,0,0.45);color:#fff;font-size:18px;" +
      "line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;}" +
      ".adb-close:hover{background:rgba(0,0,0,0.65);}" +
      "body.adb-locked{overflow:hidden;}";
    document.head.appendChild(style);
  }

  function open() {
    if (overlay) return;
    injectStyles();
    lastFocused = document.activeElement;
    scrollY = window.scrollY || window.pageYOffset;

    overlay = document.createElement("div");
    overlay.className = "adb-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    var modal = document.createElement("div");
    modal.className = "adb-modal";

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "adb-close";
    closeBtn.setAttribute("aria-label", "Sluiten");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", close);

    iframe = document.createElement("iframe");
    iframe.src = WIDGET_URL;
    iframe.title = "Boeking";
    iframe.setAttribute("loading", "eager");

    modal.appendChild(closeBtn);
    modal.appendChild(iframe);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    document.body.classList.add("adb-locked");
    document.body.style.top = "-" + scrollY + "px";
    document.body.style.position = "fixed";
    document.body.style.width = "100%";

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", onKeydown);

    // Eén frame wachten voor de transitie, anders start hij al "open". Het
    // element apart vasthouden (i.p.v. de buitenste `overlay`-variabele in
    // de closure gebruiken) — bij een supersnelle open()+close() na elkaar
    // (sneller dan twee animation frames) is `overlay` dan al terug null,
    // en zou de closure anders op een null-referentie crashen.
    var el = overlay;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.classList.add("adb-open");
      });
    });
  }

  function close() {
    if (!overlay) return;
    document.removeEventListener("keydown", onKeydown);
    document.body.classList.remove("adb-locked");
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.width = "";
    window.scrollTo(0, scrollY);

    overlay.parentNode.removeChild(overlay);
    overlay = null;
    iframe = null;
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
  }

  function onKeydown(e) {
    if (e.key === "Escape" || e.keyCode === 27) close();
  }

  document.addEventListener("click", function (e) {
    var trigger = e.target.closest && e.target.closest("[data-atelierdoen-booking]");
    if (trigger) {
      e.preventDefault();
      open();
    }
  });

  window.AtelierDoenBooking = { open: open, close: close };
})();
