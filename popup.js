const LOCAL_SERVER = 'http://127.0.0.1:7890';

// ===== DOM Elements =====
const els = {
  btnModeLocal: document.getElementById('btn-mode-local'),
  btnModeApi: document.getElementById('btn-mode-api'),
  modeLocalSettings: document.getElementById('mode-local-settings'),
  modeApiSettings: document.getElementById('mode-api-settings'),
  serverStatusText: document.getElementById('server-status-text'),
  inputApiKey: document.getElementById('input-api-key'),
  btnSaveApiKey: document.getElementById('btn-save-api-key'),
  apiKeyStatus: document.getElementById('api-key-status'),
  inputTimeLimit: document.getElementById('input-time-limit'),
  timeUsedText: document.getElementById('time-used-text'),
  progressBar: document.getElementById('progress-bar'),
  statAnalyzed: document.getElementById('stat-analyzed'),
  statFiltered: document.getElementById('stat-filtered'),
  statShown: document.getElementById('stat-shown'),
  statNourished: document.getElementById('stat-nourished'),
  statDistilled: document.getElementById('stat-distilled'),
  filteredPct: document.getElementById('filtered-pct'),
  btnResetStats: document.getElementById('btn-reset-stats'),
  btnLogOff: document.getElementById('btn-log-off'),
  btnLogOn: document.getElementById('btn-log-on'),
  logControls: document.getElementById('log-controls'),
  logCountText: document.getElementById('log-count-text'),
  btnExportLog: document.getElementById('btn-export-log'),
  btnClearLog: document.getElementById('btn-clear-log'),
};

let refreshInterval = null;
let currentMode = 'local';

// ===== Initialization =====
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  loadStats();
  startAutoRefresh();
  bindEvents();
});

// ===== Mode Switching =====
function updateModeUI(mode) {
  currentMode = mode;

  if (mode === 'api') {
    els.btnModeApi.classList.add('active');
    els.btnModeLocal.classList.remove('active');
    els.modeLocalSettings.classList.add('hidden');
    els.modeApiSettings.classList.remove('hidden');
  } else {
    els.btnModeLocal.classList.add('active');
    els.btnModeApi.classList.remove('active');
    els.modeLocalSettings.classList.remove('hidden');
    els.modeApiSettings.classList.add('hidden');
  }
}

function switchMode(mode) {
  chrome.runtime.sendMessage({ type: 'SET_MODE', mode }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.success) {
      updateModeUI(response.mode);
      if (response.mode === 'local') {
        checkServerStatus();
      }
    }
  });
}

// ===== API Key =====
function saveApiKey() {
  const key = els.inputApiKey.value.trim();
  if (!key) return;

  chrome.runtime.sendMessage({ type: 'SET_API_KEY', key }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.success) {
      els.inputApiKey.value = '';
      els.inputApiKey.placeholder = 'sk-ant-****' + key.slice(-4);
      els.apiKeyStatus.textContent = 'Key saved';
      els.apiKeyStatus.classList.remove('api-key-error');
      els.apiKeyStatus.classList.add('api-key-saved');
      setTimeout(() => { els.apiKeyStatus.textContent = ''; }, 2000);
    }
  });
}

// ===== Server Status =====
function checkServerStatus() {
  fetch(`${LOCAL_SERVER}/health`)
    .then((res) => {
      if (res.ok) {
        els.serverStatusText.textContent = 'Local server: connected';
        els.serverStatusText.classList.remove('server-disconnected');
        els.serverStatusText.classList.add('server-connected');
      } else {
        els.serverStatusText.textContent = 'Local server: error';
        els.serverStatusText.classList.remove('server-connected');
        els.serverStatusText.classList.add('server-disconnected');
      }
    })
    .catch(() => {
      els.serverStatusText.textContent = 'Local server: disconnected';
      els.serverStatusText.classList.remove('server-connected');
      els.serverStatusText.classList.add('server-disconnected');
    });
}

// ===== Settings =====
function loadSettings() {
  checkServerStatus();

  chrome.storage.local.get(['settings', 'apiKey'], (result) => {
    // Time limit
    const timeLimitMinutes = (result.settings && typeof result.settings.timeLimitSeconds === 'number')
      ? result.settings.timeLimitSeconds / 60
      : 15;
    els.inputTimeLimit.value = timeLimitMinutes;

    // Mode
    const mode = (result.settings && result.settings.classificationMode) || 'local';
    updateModeUI(mode);

    // API key — show masked placeholder if key exists
    if (result.apiKey && result.apiKey.trim()) {
      els.inputApiKey.placeholder = 'sk-ant-****' + result.apiKey.slice(-4);
    }

    // Logging toggle
    updateLoggingUI(!!(result.settings && result.settings.loggingEnabled));
  });
}

function saveTimeLimit() {
  let value = parseInt(els.inputTimeLimit.value, 10);
  if (isNaN(value) || value < 1) value = 1;
  if (value > 1440) value = 1440;
  els.inputTimeLimit.value = value;

  chrome.storage.local.get('settings', (result) => {
    const settings = result.settings || {};
    settings.timeLimitSeconds = value * 60;
    chrome.storage.local.set({ settings }, () => {
      loadStats();
    });
  });
}

// ===== Stats =====
function loadStats() {
  chrome.runtime.sendMessage({ type: 'GET_STATS' }, (response) => {
    if (chrome.runtime.lastError) {
      updateDisplay({ timeUsed: 0, timeLimit: 900, analyzed: 0, filtered: 0, shown: 0, nourished: 0, distilled: 0 });
      return;
    }
    updateDisplay(response || { timeUsed: 0, timeLimit: 900, analyzed: 0, filtered: 0, shown: 0, nourished: 0, distilled: 0 });
  });
}

function updateDisplay(stats) {
  const timeUsedMinutes = (stats.timeUsed || 0) / 60;
  const timeLimitMinutes = (stats.timeLimit || 900) / 60;
  const pct = timeLimitMinutes > 0 ? Math.min((timeUsedMinutes / timeLimitMinutes) * 100, 100) : 0;

  els.timeUsedText.textContent = `${Math.round(timeUsedMinutes * 10) / 10} / ${timeLimitMinutes} minutes`;

  els.progressBar.style.width = `${pct}%`;

  els.progressBar.classList.remove('amber', 'red');
  if (pct >= 100) {
    els.progressBar.classList.add('red');
  } else if (pct > 80) {
    els.progressBar.classList.add('amber');
  }

  const analyzed = stats.analyzed || 0;
  const filtered = stats.filtered || 0;
  const shown = stats.shown || 0;
  const nourished = stats.nourished || 0;
  const distilled = stats.distilled || 0;

  els.statAnalyzed.textContent = analyzed;
  els.statFiltered.textContent = filtered;
  els.statShown.textContent = shown;
  els.statNourished.textContent = nourished;
  els.statDistilled.textContent = distilled;

  if (analyzed > 0) {
    const filteredPct = ((filtered / analyzed) * 100).toFixed(1);
    els.filteredPct.textContent = `${filtered} of ${analyzed} tweets filtered (${filteredPct}%)`;
  } else {
    els.filteredPct.textContent = '';
  }
}

function resetStats() {
  chrome.runtime.sendMessage({ type: 'RESET_STATS' }, () => {
    loadStats();
  });
}

// ===== Tweet Log =====
let loggingEnabled = false;

function updateLoggingUI(enabled) {
  loggingEnabled = enabled;
  if (enabled) {
    els.btnLogOn.classList.add('active');
    els.btnLogOff.classList.remove('active');
    els.logControls.classList.remove('hidden');
    loadLogCount();
  } else {
    els.btnLogOff.classList.add('active');
    els.btnLogOn.classList.remove('active');
    els.logControls.classList.add('hidden');
  }
}

function toggleLogging(enabled) {
  chrome.runtime.sendMessage({ type: 'SET_LOGGING', enabled }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.success) {
      updateLoggingUI(response.enabled);
    }
  });
}

function loadLogCount() {
  chrome.runtime.sendMessage({ type: 'GET_LOG_COUNT' }, (response) => {
    if (chrome.runtime.lastError) return;
    const count = (response && response.count) || 0;
    els.logCountText.textContent = `${count} ${count === 1 ? 'entry' : 'entries'} logged`;
  });
}

function exportLog() {
  els.btnExportLog.textContent = 'Exporting...';
  els.btnExportLog.disabled = true;
  chrome.runtime.sendMessage({ type: 'EXPORT_LOG' }, (response) => {
    els.btnExportLog.textContent = 'Export JSON';
    els.btnExportLog.disabled = false;
    if (chrome.runtime.lastError) return;
    const entries = (response && response.entries) || [];
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `x-shield-log-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

function clearLog() {
  if (!confirm('Clear all logged classifications? This cannot be undone.')) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_LOG' }, () => {
    if (chrome.runtime.lastError) return;
    loadLogCount();
  });
}

// ===== Auto-Refresh =====
function startAutoRefresh() {
  refreshInterval = setInterval(() => {
    loadStats();
    if (currentMode === 'local') {
      checkServerStatus();
    }
    if (loggingEnabled) {
      loadLogCount();
    }
  }, 5000);
}

window.addEventListener('unload', () => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
});

// ===== Event Bindings =====
function bindEvents() {
  els.btnModeLocal.addEventListener('click', () => switchMode('local'));
  els.btnModeApi.addEventListener('click', () => switchMode('api'));
  els.btnSaveApiKey.addEventListener('click', saveApiKey);
  els.inputApiKey.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveApiKey();
  });
  els.inputTimeLimit.addEventListener('change', saveTimeLimit);
  els.btnResetStats.addEventListener('click', resetStats);
  els.btnLogOff.addEventListener('click', () => toggleLogging(false));
  els.btnLogOn.addEventListener('click', () => toggleLogging(true));
  els.btnExportLog.addEventListener('click', exportLog);
  els.btnClearLog.addEventListener('click', clearLog);
}
