(() => {
  const tools = document.getElementById('search-tools');
  const status = document.getElementById('startup-status');
  const recovery = document.getElementById('startup-recovery');
  const message = document.getElementById('startup-message');

  function showRecovery(text) {
    if (!tools.inert) return;
    status.hidden = true;
    recovery.hidden = false;
    message.textContent = text;
  }

  const timeout = setTimeout(() => showRecovery('RasterRaid is taking longer to open.'), 6000);
  document.addEventListener('rasterraid:ready', () => clearTimeout(timeout), { once: true });
  document.getElementById('rasterraid-module').addEventListener('error', () => {
    clearTimeout(timeout);
    showRecovery('RasterRaid couldn’t load.');
  }, { once: true });
})();
