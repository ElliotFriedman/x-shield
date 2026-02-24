(() => {
  "use strict";

  const countdownEl = document.getElementById("countdown");

  function msUntilMidnight() {
    const now = new Date();
    const midnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0, 0, 0, 0
    );
    return midnight - now;
  }

  function formatTime(ms) {
    if (ms <= 0) return "00:00:00";

    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");

    return `${hh}:${mm}:${ss}`;
  }

  function tick() {
    const remaining = msUntilMidnight();

    if (remaining <= 0) {
      countdownEl.textContent = "00:00:00";
      // Small delay to let the background alarm clear the locked flag
      setTimeout(() => { window.location.href = "https://x.com"; }, 5000);
      return;
    }

    countdownEl.textContent = formatTime(remaining);
  }

  // Run immediately, then every second
  tick();
  setInterval(tick, 1000);
})();
