/*
 * X-Shield Background Service Worker
 * Handles classification via local server, caching, time tracking,
 * stats, and lockout enforcement.
 *
 * Design principle: FAIL CLOSED. If anything goes wrong (server down,
 * errors, malformed responses), all tweets are filtered.
 */

'use strict';

// System prompt shared with server.js — single source of truth
importScripts('system-prompt.js');
// CLASSIFICATION_SYSTEM_PROMPT is now available as a global variable

// -------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------
const LOCAL_SERVER = 'http://127.0.0.1:7890';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_MAX_ENTRIES = 500;
const DEFAULT_TIME_LIMIT_SECONDS = 900; // 15 minutes
const LOCKOUT_CLOSE_DELAY_MS = 3000;
const RETRY_DELAY_MS = 1000;
const MAX_RETRY_ATTEMPTS = 2;

// -------------------------------------------------------------------
// Hashing utility — djb2 hash matching content.js
// -------------------------------------------------------------------
function contentHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(16);
}

// -------------------------------------------------------------------
// Cache helpers — in-memory mirror with periodic flush to storage
// -------------------------------------------------------------------
let cacheMemory = null;
let cacheDirty = false;
let cacheLoadPromise = null;

async function loadCacheIntoMemory() {
  if (cacheMemory !== null) return;
  if (!cacheLoadPromise) {
    cacheLoadPromise = (async () => {
      const { cache } = await chrome.storage.local.get('cache');
      cacheMemory = cache || {};
    })();
  }
  await cacheLoadPromise;
}

async function flushCacheToStorage() {
  if (!cacheDirty || cacheMemory === null) return;
  await chrome.storage.local.set({ cache: cacheMemory });
  cacheDirty = false;
}

// Flush dirty cache to storage every 5 seconds
setInterval(flushCacheToStorage, 5000);

// -------------------------------------------------------------------
// IndexedDB tweet log — persistent classification history (opt-in)
// -------------------------------------------------------------------
function openLogDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('xshield-log', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('classifications')) {
        const store = db.createObjectStore('classifications', { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp');
        store.createIndex('verdict', 'verdict');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const logDBReady = openLogDB();

let logBuffer = [];

async function flushLogBuffer() {
  if (logBuffer.length === 0) return;
  const settings = await getSettings();
  if (!settings.loggingEnabled) {
    logBuffer = [];
    return;
  }

  const batch = logBuffer;
  logBuffer = [];

  try {
    const db = await logDBReady;
    await new Promise((resolve, reject) => {
      const tx = db.transaction('classifications', 'readwrite');
      const store = tx.objectStore('classifications');
      for (const entry of batch) {
        store.add(entry);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('[X-Shield] Failed to flush log buffer:', e);
  }
}

setInterval(flushLogBuffer, 3000);

async function getCacheEntry(hash) {
  await loadCacheIntoMemory();
  if (!cacheMemory[hash]) return null;

  const entry = cacheMemory[hash];
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    delete cacheMemory[hash];
    cacheDirty = true;
    return null;
  }

  return entry;
}

async function setCacheEntry(hash, verdict, reason, distilled) {
  await loadCacheIntoMemory();

  // LRU eviction: if at capacity, remove oldest entries
  const keys = Object.keys(cacheMemory);
  if (keys.length >= CACHE_MAX_ENTRIES) {
    const sorted = keys.sort((a, b) => (cacheMemory[a].timestamp || 0) - (cacheMemory[b].timestamp || 0));
    const toRemove = sorted.slice(0, keys.length - CACHE_MAX_ENTRIES + 1);
    for (const key of toRemove) {
      delete cacheMemory[key];
    }
  }

  const entry = { verdict, reason, timestamp: Date.now() };
  if (distilled) entry.distilled = distilled;
  cacheMemory[hash] = entry;
  cacheDirty = true;
}

async function cleanExpiredCache() {
  await loadCacheIntoMemory();

  const now = Date.now();
  for (const key of Object.keys(cacheMemory)) {
    if (now - cacheMemory[key].timestamp > CACHE_TTL_MS) {
      delete cacheMemory[key];
      cacheDirty = true;
    }
  }

  await flushCacheToStorage();
}

// -------------------------------------------------------------------
// Date utilities
// -------------------------------------------------------------------
function todayString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getNextMidnightMs() {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return tomorrow.getTime();
}

// -------------------------------------------------------------------
// Storage mutex — serializes read-modify-write operations
// -------------------------------------------------------------------
let storageMutex = Promise.resolve();

function withStorageLock(fn) {
  storageMutex = storageMutex.then(fn, fn);
  return storageMutex;
}

// -------------------------------------------------------------------
// Settings helper
// -------------------------------------------------------------------
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return settings || {};
}

// -------------------------------------------------------------------
// Daily usage helpers
// -------------------------------------------------------------------
async function getDailyUsage() {
  const { dailyUsage } = await chrome.storage.local.get('dailyUsage');
  const today = todayString();

  if (!dailyUsage || dailyUsage.date !== today) {
    const fresh = { date: today, seconds: 0 };
    await chrome.storage.local.set({ dailyUsage: fresh });
    return fresh;
  }

  return dailyUsage;
}

async function getTimeLimit() {
  const settings = await getSettings();
  return (typeof settings.timeLimitSeconds === 'number')
    ? settings.timeLimitSeconds
    : DEFAULT_TIME_LIMIT_SECONDS;
}

// -------------------------------------------------------------------
// Daily stats helpers
// -------------------------------------------------------------------
async function getDailyStats() {
  const { dailyStats } = await chrome.storage.local.get('dailyStats');
  const today = todayString();

  if (!dailyStats || dailyStats.date !== today) {
    const fresh = { date: today, filtered: 0, shown: 0, analyzed: 0, nourished: 0, distilled: 0 };
    await chrome.storage.local.set({ dailyStats: fresh });
    return fresh;
  }

  return dailyStats;
}

async function updateDailyStats(filtered, shown, nourished, distilled) {
  const stats = await getDailyStats();
  stats.filtered += filtered;
  stats.shown += shown;
  stats.nourished += (nourished || 0);
  stats.distilled += (distilled || 0);
  stats.analyzed += filtered + shown;
  await chrome.storage.local.set({ dailyStats: stats });
}

// -------------------------------------------------------------------
// Fail-closed verdict generator
// -------------------------------------------------------------------
function filterAllVerdicts(tweets, reason) {
  return tweets.map((t) => ({
    id: t.id,
    verdict: 'block',
    reason: reason || 'classification unavailable — fail closed',
  }));
}

// -------------------------------------------------------------------
// Verdict normalization — shared between local server and API modes
// -------------------------------------------------------------------
const NOURISH_VERDICTS = ['nourish', 'beneficial', 'nurture', 'promote'];
const SHOW_VERDICTS = ['show', 'allow', 'approve', 'keep', 'display', 'visible'];
const DISTILL_VERDICTS = ['distill', 'rewrite', 'summarize'];

function normalizeVerdict(serverVerdict) {
  if (!serverVerdict || typeof serverVerdict.verdict !== 'string') {
    return { verdict: 'block', reason: 'no verdict returned — fail closed' };
  }

  const v = serverVerdict.verdict.toLowerCase();

  if (NOURISH_VERDICTS.includes(v)) {
    return { verdict: 'nourish', reason: serverVerdict.reason || 'nourishing content' };
  }
  if (DISTILL_VERDICTS.includes(v)) {
    return { verdict: 'distill', reason: serverVerdict.reason || 'distilled', distilled: serverVerdict.distilled || null };
  }
  if (SHOW_VERDICTS.includes(v)) {
    return { verdict: 'allow', reason: serverVerdict.reason || 'approved' };
  }
  return { verdict: 'block', reason: serverVerdict.reason || 'filtered' };
}

async function normalizeAndCacheVerdicts(tweets, rawVerdicts) {
  const results = [];
  for (let i = 0; i < tweets.length; i++) {
    const tweet = tweets[i];
    const hash = contentHash(tweet.text + (tweet.imageUrls || []).join(','));
    const serverVerdict = rawVerdicts.find((v) => v.id === `tweet_${i}`);
    const { verdict, reason, distilled } = normalizeVerdict(serverVerdict);

    await setCacheEntry(hash, verdict, reason, distilled);

    const entry = { id: tweet.id, verdict, reason, hash };
    if (distilled) entry.distilled = distilled;
    results.push(entry);
  }
  return results;
}

// -------------------------------------------------------------------
// Shared retry logic for fetch requests
// -------------------------------------------------------------------
async function fetchWithRetry(url, options, label) {
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (e) {
      console.error(`[X-Shield] ${label} request failed (attempt ${attempt}/${MAX_RETRY_ATTEMPTS}):`, e);
      if (attempt < MAX_RETRY_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      return { error: `${label} request failed` };
    }

    if (!response.ok) {
      let errorBody = '';
      try { errorBody = await response.text(); } catch (e) { /* ignore */ }
      console.error(`[X-Shield] ${label} returned status`, response.status, errorBody);
      if (attempt < MAX_RETRY_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      return { error: `${label} error: ${response.status}` };
    }

    let body;
    try {
      body = await response.json();
    } catch (e) {
      console.error(`[X-Shield] Failed to parse ${label} response:`, e);
      if (attempt < MAX_RETRY_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      return { error: `malformed ${label} response` };
    }

    return { body };
  }
}

// -------------------------------------------------------------------
// Claude API classification
// -------------------------------------------------------------------
async function classifyBatch(tweets) {
  console.log(`[X-Shield] Classifying batch of ${tweets.length} tweets`);
  const payload = tweets.map((t) => ({ id: t.id, text: t.text, url: t.url || '' }));

  const result = await fetchWithRetry(
    `${LOCAL_SERVER}/classify`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    'Server'
  );

  if (result.error) return filterAllVerdicts(tweets, result.error);

  const verdicts = result.body.verdicts;
  if (!Array.isArray(verdicts)) {
    console.error('[X-Shield] Verdicts is not an array:', verdicts);
    return filterAllVerdicts(tweets, 'malformed verdict structure');
  }

  return normalizeAndCacheVerdicts(tweets, verdicts);
}

// -------------------------------------------------------------------
// Direct Anthropic API classification (api mode)
// -------------------------------------------------------------------
async function classifyBatchAPI(tweets, apiKey) {
  console.log(`[X-Shield] Classifying batch of ${tweets.length} tweets via Anthropic API`);

  const userPrompt = tweets.map((t, i) =>
    `[tweet_${i}]\n${t.text || '[no text]'}`
  ).join('\n\n');

  const result = await fetchWithRetry(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: CLASSIFICATION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    },
    'API'
  );

  if (result.error) return filterAllVerdicts(tweets, result.error);

  let rawText = '';
  if (result.body.content && Array.isArray(result.body.content)) {
    rawText = result.body.content.map((block) => block.text || '').join('');
  }

  rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let verdicts;
  try {
    verdicts = JSON.parse(rawText);
  } catch (e) {
    console.error('[X-Shield] Failed to parse verdicts from API response:', e, rawText);
    return filterAllVerdicts(tweets, 'malformed verdict JSON from API');
  }

  if (!Array.isArray(verdicts)) {
    console.error('[X-Shield] Verdicts is not an array:', verdicts);
    return filterAllVerdicts(tweets, 'malformed verdict structure from API');
  }

  return normalizeAndCacheVerdicts(tweets, verdicts);
}

// -------------------------------------------------------------------
// Lockout enforcement — send LOCKOUT to all x.com tabs, then close
// -------------------------------------------------------------------
async function enforceLockout() {
  await chrome.storage.local.set({ locked: true });

  const tabs = await chrome.tabs.query({ url: 'https://x.com/*' });

  // Send lockout message to all x.com tabs
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'LOCKOUT' });
    } catch (e) {
      // Tab may not have content script loaded — that's fine
    }
  }

  // Use an alarm to close tabs (setTimeout is unreliable in MV3 service workers)
  chrome.alarms.create('closeLockoutTabs', { delayInMinutes: 0.05 }); // ~3 seconds
}

// -------------------------------------------------------------------
// Verdict counting helper
// -------------------------------------------------------------------
function countVerdicts(verdicts) {
  let filtered = 0, shown = 0, nourished = 0, distilled = 0;
  for (const v of verdicts) {
    if (v.verdict === 'nourish') { shown++; nourished++; }
    else if (v.verdict === 'allow') { shown++; }
    else if (v.verdict === 'distill') { shown++; distilled++; }
    else { filtered++; }
  }
  return { filtered, shown, nourished, distilled };
}

// -------------------------------------------------------------------
// Per-type message handlers
// -------------------------------------------------------------------
async function handleCheckLockout() {
  const { locked } = await chrome.storage.local.get('locked');
  return { locked: locked === true };
}

async function handleCheckApiKey() {
  const settings = await getSettings();
  const mode = settings.classificationMode || 'local';
  if (mode === 'api') {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    return { hasKey: !!(apiKey && apiKey.trim()), mode: 'api' };
  }
  try {
    const healthCheck = await fetch(`${LOCAL_SERVER}/health`);
    return { hasKey: healthCheck.ok, mode: 'local' };
  } catch (e) {
    return { hasKey: false, mode: 'local' };
  }
}

async function handleHeartbeat() {
  return new Promise((resolve) => {
    withStorageLock(async () => {
      try {
        const usage = await getDailyUsage();
        const timeLimit = await getTimeLimit();
        const { locked } = await chrome.storage.local.get('locked');

        if (locked === true) {
          resolve({ timeRemaining: 0, locked: true });
          return;
        }

        usage.seconds += 10;
        await chrome.storage.local.set({ dailyUsage: usage });
        const timeRemaining = Math.max(0, timeLimit - usage.seconds);

        if (usage.seconds >= timeLimit) {
          await enforceLockout();
          resolve({ timeRemaining: 0, locked: true });
        } else {
          resolve({ timeRemaining, locked: false });
        }
      } catch (e) {
        console.error('[X-Shield] Heartbeat error:', e);
        resolve({ timeRemaining: 0, locked: false });
      }
    });
  });
}

async function handleClassifyBatch(message) {
  const tweets = message.tweets;
  if (!tweets || !Array.isArray(tweets) || tweets.length === 0) {
    return { verdicts: [] };
  }

  const uncached = [];
  const cachedResults = [];

  for (const tweet of tweets) {
    const hash = contentHash(tweet.text + (tweet.imageUrls || []).join(','));
    const cached = await getCacheEntry(hash);
    if (cached) {
      const entry = { id: tweet.id, verdict: cached.verdict, reason: cached.reason, hash };
      if (cached.distilled) entry.distilled = cached.distilled;
      cachedResults.push(entry);
    } else {
      uncached.push(tweet);
    }
  }

  const settings = await getSettings();

  let apiResults = [];
  if (uncached.length > 0) {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    const classifyMode = settings.classificationMode || 'local';
    if (classifyMode === 'api' && apiKey && apiKey.trim()) {
      apiResults = await classifyBatchAPI(uncached, apiKey.trim());
    } else {
      apiResults = await classifyBatch(uncached);
    }
  }

  const allVerdicts = [...cachedResults, ...apiResults];

  // Push classification entries to the log buffer (if logging enabled)
  if (settings.loggingEnabled) {
    const tweetMap = new Map(tweets.map(t => [t.id, t]));
    const cachedSet = new Set(cachedResults);
    for (const v of allVerdicts) {
      const tweet = tweetMap.get(v.id);
      logBuffer.push({
        timestamp: Date.now(),
        tweetText: tweet ? tweet.text : '',
        tweetUrl: tweet ? (tweet.url || '') : '',
        tweetHash: v.hash || '',
        verdict: v.verdict,
        reason: v.reason || '',
        distilled: v.distilled || null,
        cached: cachedSet.has(v),
      });
    }
  }

  const stats = countVerdicts(allVerdicts);
  await updateDailyStats(stats.filtered, stats.shown, stats.nourished, stats.distilled);

  const feedReorderingEnabled = settings.feedReorderingEnabled !== false;
  return { verdicts: allVerdicts, feedReorderingEnabled };
}

async function handleGetStats() {
  const stats = await getDailyStats();
  const usage = await getDailyUsage();
  const timeLimit = await getTimeLimit();
  const settings = await getSettings();
  const feedReorderingEnabled = settings.feedReorderingEnabled !== false;

  return {
    filtered: stats.filtered, shown: stats.shown, analyzed: stats.analyzed,
    nourished: stats.nourished || 0, distilled: stats.distilled || 0,
    timeUsed: usage.seconds, timeLimit, feedReorderingEnabled,
  };
}

async function handleResetStats() {
  const today = todayString();
  await chrome.storage.local.set({
    dailyStats: { date: today, filtered: 0, shown: 0, analyzed: 0, nourished: 0, distilled: 0 },
  });
  return { success: true };
}

async function handleSetApiKey(message) {
  const key = (message.key || '').trim();
  await chrome.storage.local.set({ apiKey: key });
  return { success: true };
}

async function handleSetMode(message) {
  const newMode = message.mode === 'api' ? 'api' : 'local';
  const settings = await getSettings();
  settings.classificationMode = newMode;
  await chrome.storage.local.set({ settings });

  const tabs = await chrome.tabs.query({ url: 'https://x.com/*' });
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'MODE_CHANGED', mode: newMode });
    } catch (e) { /* content script may not be loaded */ }
  }
  return { success: true, mode: newMode };
}

// -------------------------------------------------------------------
// Tweet log message handlers
// -------------------------------------------------------------------
async function handleSetLogging(message) {
  const settings = await getSettings();
  settings.loggingEnabled = !!message.enabled;
  await chrome.storage.local.set({ settings });
  return { success: true, enabled: settings.loggingEnabled };
}

async function handleGetLogCount() {
  try {
    const db = await logDBReady;
    return new Promise((resolve) => {
      const tx = db.transaction('classifications', 'readonly');
      const req = tx.objectStore('classifications').count();
      req.onsuccess = () => resolve({ count: req.result });
      req.onerror = () => resolve({ count: 0 });
    });
  } catch (e) {
    return { count: 0 };
  }
}

async function handleExportLog() {
  await flushLogBuffer();
  try {
    const db = await logDBReady;
    return new Promise((resolve) => {
      const tx = db.transaction('classifications', 'readonly');
      const index = tx.objectStore('classifications').index('timestamp');
      const entries = [];
      const req = index.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          entries.push(cursor.value);
          cursor.continue();
        } else {
          resolve({ entries });
        }
      };
      req.onerror = () => resolve({ entries: [] });
    });
  } catch (e) {
    return { entries: [] };
  }
}

async function handleGetLogHistory(message) {
  await flushLogBuffer();
  try {
    const db = await logDBReady;
    const VALID_VERDICTS = ['nourish', 'allow', 'block', 'distill'];
    const verdictFilter = VALID_VERDICTS.includes(message.verdict) ? message.verdict : null;
    const limit = Math.max(1, Math.min(parseInt(message.limit, 10) || 200, 5000));
    const offset = Math.max(0, parseInt(message.offset, 10) || 0);

    // Single cursor pass — same proven pattern as handleExportLog
    const allEntries = await new Promise((resolve, reject) => {
      const tx = db.transaction('classifications', 'readonly');
      const index = tx.objectStore('classifications').index('timestamp');
      const results = [];
      const req = index.openCursor(null, 'prev');
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => reject(req.error);
    });

    // Compute stats from collected entries
    const stats = { total: allEntries.length, nourish: 0, allow: 0, block: 0, distill: 0 };
    for (const entry of allEntries) {
      if (VALID_VERDICTS.includes(entry.verdict)) stats[entry.verdict]++;
    }

    // Filter and paginate
    const filtered = verdictFilter
      ? allEntries.filter(e => e.verdict === verdictFilter)
      : allEntries;
    const entries = filtered.slice(offset, offset + limit);

    return { entries, stats };
  } catch (e) {
    console.error('[X-Shield] GET_LOG_HISTORY error:', e);
    return { entries: [], stats: { total: 0, nourish: 0, allow: 0, block: 0, distill: 0 } };
  }
}

async function handleClearLog() {
  logBuffer = [];
  try {
    const db = await logDBReady;
    return new Promise((resolve) => {
      const tx = db.transaction('classifications', 'readwrite');
      const req = tx.objectStore('classifications').clear();
      req.onsuccess = () => resolve({ success: true });
      req.onerror = () => resolve({ success: false });
    });
  } catch (e) {
    return { success: false };
  }
}

// -------------------------------------------------------------------
// Message handler — dispatcher
// -------------------------------------------------------------------
const MESSAGE_HANDLERS = {
  CHECK_LOCKOUT: handleCheckLockout,
  CHECK_API_KEY: handleCheckApiKey,
  HEARTBEAT: handleHeartbeat,
  CLASSIFY_BATCH: handleClassifyBatch,
  GET_STATS: handleGetStats,
  RESET_STATS: handleResetStats,
  SET_API_KEY: handleSetApiKey,
  SET_MODE: handleSetMode,
  SET_LOGGING: handleSetLogging,
  GET_LOG_COUNT: handleGetLogCount,
  EXPORT_LOG: handleExportLog,
  CLEAR_LOG: handleClearLog,
  GET_LOG_HISTORY: handleGetLogHistory,
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) { sendResponse(null); return false; }
  if (sender.id !== chrome.runtime.id) { sendResponse(null); return false; }

  const handler = MESSAGE_HANDLERS[message.type];
  if (!handler) { sendResponse(null); return false; }

  (async () => {
    try {
      const result = await handler(message);
      sendResponse(result);
    } catch (e) {
      console.error(`[X-Shield] ${message.type} handler error:`, e);
      sendResponse(null);
    }
  })();

  return true;
});

// -------------------------------------------------------------------
// Alarm handler — daily reset and cache cleanup
// -------------------------------------------------------------------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'closeLockoutTabs') {
    const tabsToClose = await chrome.tabs.query({ url: 'https://x.com/*' });
    for (const tab of tabsToClose) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (e) {
        // Tab may already be closed
      }
    }
    return;
  }

  if (alarm.name === 'dailyReset') {
    const today = todayString();

    // Reset daily usage
    await chrome.storage.local.set({
      dailyUsage: { date: today, seconds: 0 },
    });

    // Clear locked flag
    await chrome.storage.local.set({ locked: false });

    // Clean expired cache entries
    await cleanExpiredCache();

    // Reset daily stats
    await chrome.storage.local.set({
      dailyStats: { date: today, filtered: 0, shown: 0, analyzed: 0, nourished: 0, distilled: 0 },
    });

    console.log('[X-Shield] Daily reset complete');
  }
});

// -------------------------------------------------------------------
// Install handler — initialize storage defaults and alarms
// -------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  const today = todayString();

  // Initialize storage defaults (only set if not already present)
  const existing = await chrome.storage.local.get([
    'settings', 'dailyUsage', 'dailyStats', 'cache', 'locked',
  ]);

  if (!existing.settings) {
    await chrome.storage.local.set({
      settings: { timeLimitSeconds: DEFAULT_TIME_LIMIT_SECONDS, feedReorderingEnabled: true },
    });
  }

  if (!existing.dailyUsage) {
    await chrome.storage.local.set({
      dailyUsage: { date: today, seconds: 0 },
    });
  }

  if (!existing.dailyStats) {
    await chrome.storage.local.set({
      dailyStats: { date: today, filtered: 0, shown: 0, analyzed: 0, nourished: 0, distilled: 0 },
    });
  }

  if (!existing.cache) {
    await chrome.storage.local.set({ cache: {} });
  }

  if (existing.locked === undefined) {
    await chrome.storage.local.set({ locked: false });
  }

  // Set up daily reset alarm at next midnight, repeating every 24 hours
  chrome.alarms.create('dailyReset', {
    when: getNextMidnightMs(),
    periodInMinutes: 1440,
  });

  console.log('[X-Shield] Extension installed and initialized');
});

// -------------------------------------------------------------------
// Activate handler — clean expired cache
// -------------------------------------------------------------------
self.addEventListener('activate', async () => {
  await cleanExpiredCache();
  console.log('[X-Shield] Service worker activated, cache cleaned');
});
