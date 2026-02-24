// ===== DOM Elements =====
const els = {
  apiKeyDisplay: document.getElementById('api-key-display'),
  apiKeyInputGroup: document.getElementById('api-key-input-group'),
  apiKeyMasked: document.querySelector('.api-key-masked'),
  inputApiKey: document.getElementById('input-api-key'),
  btnSaveKey: document.getElementById('btn-save-key'),
  btnChangeKey: document.getElementById('btn-change-key'),
  inputTimeLimit: document.getElementById('input-time-limit'),
  timeUsedText: document.getElementById('time-used-text'),
  progressBar: document.getElementById('progress-bar'),
  statAnalyzed: document.getElementById('stat-analyzed'),
  statFiltered: document.getElementById('stat-filtered'),
  statShown: document.getElementById('stat-shown'),
  filteredPct: document.getElementById('filtered-pct'),
  btnResetStats: document.getElementById('btn-reset-stats'),
};

let refreshInterval = null;

// ===== Initialization =====
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  loadStats();
  startAutoRefresh();
  bindEvents();
});

// ===== Settings =====
function loadSettings() {
  chrome.storage.local.get(['apiKey', 'settings'], (result) => {
    // API Key
    if (result.apiKey) {
      showApiKeyConfigured();
    } else {
      showApiKeyInput();
    }

    // Time limit — stored as settings.timeLimitSeconds in seconds, display as minutes
    const timeLimitMinutes = (result.settings && typeof result.settings.timeLimitSeconds === 'number')
      ? result.settings.timeLimitSeconds / 60
      : 15;
    els.inputTimeLimit.value = timeLimitMinutes;
  });
}

function showApiKeyConfigured() {
  els.apiKeyDisplay.classList.remove('hidden');
  els.apiKeyInputGroup.classList.add('hidden');
}

function showApiKeyInput() {
  els.apiKeyDisplay.classList.add('hidden');
  els.apiKeyInputGroup.classList.remove('hidden');
  els.inputApiKey.value = '';
}

function saveApiKey() {
  const apiKey = els.inputApiKey.value.trim();
  if (!apiKey) return;

  chrome.storage.local.set({ apiKey }, () => {
    showApiKeyConfigured();
    // Notify any open x.com tabs so they can remove the API key overlay
    chrome.tabs.query({ url: 'https://x.com/*' }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'API_KEY_SET' }).catch(() => {});
      }
    });
  });
}

function saveTimeLimit() {
  let value = parseInt(els.inputTimeLimit.value, 10);
  if (isNaN(value) || value < 1) value = 1;
  if (value > 1440) value = 1440;
  els.inputTimeLimit.value = value;

  // Merge into existing settings to avoid clobbering other settings keys
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
      updateDisplay({ timeUsed: 0, timeLimit: 900, analyzed: 0, filtered: 0, shown: 0 });
      return;
    }
    updateDisplay(response || { timeUsed: 0, timeLimit: 900, analyzed: 0, filtered: 0, shown: 0 });
  });
}

function updateDisplay(stats) {
  // background.js sends timeUsed and timeLimit in seconds — convert to minutes for display
  const timeUsedMinutes = (stats.timeUsed || 0) / 60;
  const timeLimitMinutes = (stats.timeLimit || 900) / 60;
  const pct = timeLimitMinutes > 0 ? Math.min((timeUsedMinutes / timeLimitMinutes) * 100, 100) : 0;

  // Time text
  els.timeUsedText.textContent = `${Math.round(timeUsedMinutes * 10) / 10} / ${timeLimitMinutes} minutes`;

  // Progress bar width
  els.progressBar.style.width = `${pct}%`;

  // Progress bar color
  els.progressBar.classList.remove('amber', 'red');
  if (pct >= 100) {
    els.progressBar.classList.add('red');
  } else if (pct > 80) {
    els.progressBar.classList.add('amber');
  }

  // Stats
  const analyzed = stats.analyzed || 0;
  const filtered = stats.filtered || 0;
  const shown = stats.shown || 0;

  els.statAnalyzed.textContent = analyzed;
  els.statFiltered.textContent = filtered;
  els.statShown.textContent = shown;

  // Filtered percentage
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

// ===== Auto-Refresh =====
function startAutoRefresh() {
  refreshInterval = setInterval(loadStats, 5000);
}

// Clean up on popup close
window.addEventListener('unload', () => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
});

// ===== Event Bindings =====
function bindEvents() {
  els.btnSaveKey.addEventListener('click', saveApiKey);

  els.inputApiKey.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveApiKey();
  });

  els.btnChangeKey.addEventListener('click', showApiKeyInput);

  els.inputTimeLimit.addEventListener('change', saveTimeLimit);

  els.btnResetStats.addEventListener('click', resetStats);
}
