/*
 * X-Shield Background Service Worker
 * Handles classification via local server, caching, time tracking,
 * stats, and lockout enforcement.
 *
 * Design principle: FAIL CLOSED. If anything goes wrong (server down,
 * errors, malformed responses), all tweets are filtered.
 */

'use strict';

// -------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------
const LOCAL_SERVER = 'http://127.0.0.1:7890';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_MAX_ENTRIES = 500;
const DEFAULT_TIME_LIMIT_SECONDS = 900; // 15 minutes
const LOCKOUT_CLOSE_DELAY_MS = 3000;

const CLASSIFICATION_SYSTEM_PROMPT = `You are X-Shield, a content filter that protects users from emotional manipulation on social media. Your job is to evaluate tweets and determine whether each one is healthy to see or designed to hijack emotions for engagement.

## Your Classification Task

For each tweet, respond with a JSON array of verdicts:
[{"id": "tweet_0", "verdict": "show" | "filter", "reason": "brief explanation"}]

## What to FILTER (hide from the user)

Filter tweets whose PRIMARY PURPOSE is to provoke emotional reactions for engagement rather than to inform, connect, or create. Look for these patterns:

### Obvious Manipulation
- Rage bait: inflammatory headlines, provocative claims designed to trigger outrage
- Engagement bait: "Like if you agree", "RT if you're brave enough", "Most people won't share this"
- Manufactured urgency: "This needs to go viral", "SHARE BEFORE THEY DELETE THIS"
- Outrage farming: cherry-picked examples designed to make you angry at a group

### Subtle Manipulation (CRITICAL -- catch these)
- "Just asking questions" that are actually loaded assertions designed to stoke outrage
- Screenshots or quote-tweets of someone's bad take, posted to trigger a pile-on -- the value isn't the information, it's the collective dunking
- Moral superiority signaling: "I can't believe people actually think X" -- the purpose is to feel righteous, not to persuade
- Tribal framing: reducing complex, nuanced issues to us-vs-them narratives. If a tweet makes you feel like "my team" is good and "their team" is bad, it's manipulation
- Selective framing: technically true facts arranged to provoke rather than inform. Real journalism contextualizes; manipulation cherry-picks
- Doom amplification: presenting solvable problems as existential, irreversible catastrophes. The goal is despair and helpless scrolling, not action
- Ratio/dunk culture: quote tweets or replies whose purpose is humiliation, not dialogue
- Emotional bait disguised as questions: "Am I the only one who thinks...?", "Why is nobody talking about...?"
- Performative outrage: the person posting isn't genuinely upset -- they're performing outrage for their audience
- Victimhood competition: framing everything through who's more oppressed/persecuted
- Catastrophizing for engagement: "This is the END of X" / "X is DEAD" / hyperbolic declarations
- Ragebait through comparison: "X got this but Y got that" -- designed to trigger feelings of injustice
- Concern trolling: pretending to care about something in order to attack it

## What to SHOW (keep visible)

The bar for showing is HIGH. Only show tweets that provide clear, positive value in one of these categories:

**Enriching:** Content that makes you smarter, more informed, or more capable
- Factual news reporting -- negative news is fine IF presented to inform, not inflame
- Scientific findings, research, data presented factually
- Educational content, explainers, thoughtful analysis with nuance
- Practical information: how-tos, professional insights, genuine recommendations

**Artistic/Creative:** Content that inspires or expresses genuine creativity
- Original creative work: art, writing, music, photography, projects
- Thoughtful commentary on creative work

**Connecting:** Content that fosters genuine human connection
- Personal updates, life events, authentic sharing from people the user follows
- Community building, support, encouragement
- Genuine questions seeking information or perspectives

**NOT sufficient to show (filter these even though they're "not bad"):**
- Generic opinions that add no new insight
- Low-effort humor, memes, shitposts (entertaining != enriching)
- Hot takes, even mild ones -- if it's reactive commentary without depth, filter it
- "Interesting" threads that are really just repackaged common knowledge for engagement
- Self-promotion disguised as advice

## Key Principle: Intent Over Topic

The same topic can be healthy or toxic depending on intent:
- "New study shows microplastic levels in blood increased 50% since 2020 [link to paper]" -> SHOW (factual, informative)
- "They're POISONING us and nobody cares!!!" -> FILTER (outrage farming, no actionable information)
- "I disagree with this policy because [reasoned argument]" -> SHOW (good faith debate)
- "Anyone who supports this policy is literally insane" -> FILTER (tribal, dehumanizing)

## When in Doubt: FILTER

If you're unsure, lean toward FILTERING the tweet. The user has explicitly chosen to prioritize mental clarity over completeness. Missing a borderline tweet costs nothing. Letting manipulation through costs cognitive health.

Only show tweets that are clearly enriching, educational, artistic, genuinely informative, or authentically connecting. If a tweet is borderline or you can't determine clear positive value, filter it. The bar is HIGH -- this feed should feel like a curated library, not a town square.

## Response Format

Return ONLY valid JSON. No markdown, no explanation outside the JSON:
[{"id": "tweet_0", "verdict": "show", "reason": "personal update about weekend project"}, ...]`;

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
let cacheMemory = null;  // in-memory mirror, loaded once from storage
let cacheDirty = false;

async function loadCacheIntoMemory() {
  if (cacheMemory !== null) return;
  const { cache } = await chrome.storage.local.get('cache');
  cacheMemory = cache || {};
}

async function flushCacheToStorage() {
  if (!cacheDirty || cacheMemory === null) return;
  await chrome.storage.local.set({ cache: cacheMemory });
  cacheDirty = false;
}

// Flush dirty cache to storage every 5 seconds
setInterval(flushCacheToStorage, 5000);

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

async function setCacheEntry(hash, verdict, reason) {
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

  cacheMemory[hash] = { verdict, reason, timestamp: Date.now() };
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
  const { settings } = await chrome.storage.local.get('settings');
  return (settings && typeof settings.timeLimitSeconds === 'number')
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
    const fresh = { date: today, filtered: 0, shown: 0, analyzed: 0 };
    await chrome.storage.local.set({ dailyStats: fresh });
    return fresh;
  }

  return dailyStats;
}

async function updateDailyStats(filtered, shown) {
  const stats = await getDailyStats();
  stats.filtered += filtered;
  stats.shown += shown;
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
// Claude API classification
// -------------------------------------------------------------------
async function classifyBatch(tweets) {
  console.log(`[X-Shield] Classifying batch of ${tweets.length} tweets`);

  // Build payload — plain tweet array for the local server
  const payload = tweets.map((t) => ({ id: t.id, text: t.text }));

  // Helper that attempts the server call, with one retry on failure
  async function attemptServerCall() {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response;
      try {
        response = await fetch(`${LOCAL_SERVER}/classify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (e) {
        console.error(`[X-Shield] Server request failed (attempt ${attempt}/${maxAttempts}):`, e);
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return { error: 'server request failed' };
      }

      if (!response.ok) {
        let errorBody = '';
        try { errorBody = await response.text(); } catch (e) { /* ignore */ }
        console.error('[X-Shield] Server returned status', response.status, errorBody);
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return { error: `server error: ${response.status}` };
      }

      let body;
      try {
        body = await response.json();
      } catch (e) {
        console.error('[X-Shield] Failed to parse server response:', e);
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return { error: 'malformed server response' };
      }

      return { body };
    }
  }

  const serverResult = await attemptServerCall();
  if (serverResult.error) {
    return filterAllVerdicts(tweets, serverResult.error);
  }
  const body = serverResult.body;

  // Server returns { verdicts: [...] } directly
  const verdicts = body.verdicts;

  if (!Array.isArray(verdicts)) {
    console.error('[X-Shield] Verdicts is not an array:', verdicts);
    return filterAllVerdicts(tweets, 'malformed verdict structure');
  }

  // Map the response verdicts (which use tweet_0, tweet_1, ...) back to
  // the original tweet IDs. Also normalize verdict values.
  const results = [];
  for (let i = 0; i < tweets.length; i++) {
    const tweet = tweets[i];
    const hash = contentHash(tweet.text + (tweet.imageUrls || []).join(','));

    // Find matching verdict from the server response
    const serverVerdict = verdicts.find((v) => v.id === `tweet_${i}`);

    let verdict;
    let reason;

    if (serverVerdict && serverVerdict.verdict === 'show') {
      verdict = 'allow';
      reason = serverVerdict.reason || 'approved';
    } else if (serverVerdict) {
      verdict = 'block';
      reason = serverVerdict.reason || 'filtered';
    } else {
      // No matching verdict for this tweet — fail closed
      verdict = 'block';
      reason = 'no verdict returned — fail closed';
    }

    // Cache the result
    await setCacheEntry(hash, verdict, reason);

    results.push({
      id: tweet.id,
      verdict,
      reason,
      hash,
    });
  }

  return results;
}

// -------------------------------------------------------------------
// Direct Anthropic API classification (api mode)
// -------------------------------------------------------------------
async function classifyBatchAPI(tweets, apiKey) {
  console.log(`[X-Shield] Classifying batch of ${tweets.length} tweets via Anthropic API`);

  // Build the user prompt in the same format as the local server
  const userPrompt = tweets.map((t, i) =>
    `--- tweet_${i} (id: ${t.id}) ---\n${t.text || '[no text]'}`
  ).join('\n\n');

  // Helper that attempts the API call, with one retry on failure
  async function attemptAPICall() {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response;
      try {
        response = await fetch('https://api.anthropic.com/v1/messages', {
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
        });
      } catch (e) {
        console.error(`[X-Shield] API request failed (attempt ${attempt}/${maxAttempts}):`, e);
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return { error: 'API request failed' };
      }

      if (!response.ok) {
        let errorBody = '';
        try { errorBody = await response.text(); } catch (e) { /* ignore */ }
        console.error('[X-Shield] API returned status', response.status, errorBody);
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return { error: `API error: ${response.status}` };
      }

      let body;
      try {
        body = await response.json();
      } catch (e) {
        console.error('[X-Shield] Failed to parse API response:', e);
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return { error: 'malformed API response' };
      }

      return { body };
    }
  }

  const apiResult = await attemptAPICall();
  if (apiResult.error) {
    return filterAllVerdicts(tweets, apiResult.error);
  }
  const body = apiResult.body;

  // Extract text from the response content blocks
  let rawText = '';
  if (body.content && Array.isArray(body.content)) {
    rawText = body.content.map((block) => block.text || '').join('');
  }

  // Strip markdown code fences if present
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

  // Map the response verdicts back to the original tweet IDs and normalize
  const results = [];
  for (let i = 0; i < tweets.length; i++) {
    const tweet = tweets[i];
    const hash = contentHash(tweet.text + (tweet.imageUrls || []).join(','));

    const serverVerdict = verdicts.find((v) => v.id === `tweet_${i}`);

    let verdict;
    let reason;

    if (serverVerdict && serverVerdict.verdict === 'show') {
      verdict = 'allow';
      reason = serverVerdict.reason || 'approved';
    } else if (serverVerdict) {
      verdict = 'block';
      reason = serverVerdict.reason || 'filtered';
    } else {
      verdict = 'block';
      reason = 'no verdict returned — fail closed';
    }

    // Cache the result
    await setCacheEntry(hash, verdict, reason);

    results.push({
      id: tweet.id,
      verdict,
      reason,
      hash,
    });
  }

  return results;
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
// Message handler
// -------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    sendResponse(null);
    return false;
  }

  // Security: only accept messages from our own extension
  if (sender.id !== chrome.runtime.id) {
    sendResponse(null);
    return false;
  }

  // All handlers are async, so we return true to keep the message channel open
  (async () => {
    try {
      switch (message.type) {

        case 'CHECK_LOCKOUT': {
          const { locked } = await chrome.storage.local.get('locked');
          sendResponse({ locked: locked === true });
          break;
        }

        case 'CHECK_API_KEY': {
          const { settings, apiKey } = await chrome.storage.local.get(['settings', 'apiKey']);
          const mode = (settings && settings.classificationMode) || 'local';
          if (mode === 'api') {
            sendResponse({ hasKey: !!(apiKey && apiKey.trim()), mode: 'api' });
          } else {
            try {
              const healthCheck = await fetch(`${LOCAL_SERVER}/health`);
              sendResponse({ hasKey: healthCheck.ok, mode: 'local' });
            } catch (e) {
              sendResponse({ hasKey: false, mode: 'local' });
            }
          }
          break;
        }

        case 'HEARTBEAT': {
          // Use storage lock to prevent concurrent heartbeats from
          // clobbering each other's read-modify-write
          await withStorageLock(async () => {
            const usage = await getDailyUsage();
            const timeLimit = await getTimeLimit();

            // Check if already locked
            const { locked } = await chrome.storage.local.get('locked');
            if (locked === true) {
              sendResponse({ timeRemaining: 0, locked: true });
              return;
            }

            // Increment usage by 10 seconds (heartbeat interval)
            usage.seconds += 10;
            await chrome.storage.local.set({ dailyUsage: usage });

            const timeRemaining = Math.max(0, timeLimit - usage.seconds);

            // Check if limit exceeded
            if (usage.seconds >= timeLimit) {
              await enforceLockout();
              sendResponse({ timeRemaining: 0, locked: true });
            } else {
              sendResponse({ timeRemaining, locked: false });
            }
          });
          break;
        }

        case 'CLASSIFY_BATCH': {
          const tweets = message.tweets;
          if (!tweets || !Array.isArray(tweets) || tweets.length === 0) {
            sendResponse({ verdicts: [] });
            break;
          }

          // Check cache first for each tweet
          const uncached = [];
          const cachedResults = [];

          for (const tweet of tweets) {
            const hash = contentHash(tweet.text + (tweet.imageUrls || []).join(','));
            const cached = await getCacheEntry(hash);

            if (cached) {
              cachedResults.push({
                id: tweet.id,
                verdict: cached.verdict,
                reason: cached.reason,
                hash,
              });
            } else {
              uncached.push(tweet);
            }
          }

          // Classify any uncached tweets via API
          let apiResults = [];
          if (uncached.length > 0) {
            const { settings: classifySettings, apiKey: classifyApiKey } = await chrome.storage.local.get(['settings', 'apiKey']);
            const classifyMode = (classifySettings && classifySettings.classificationMode) || 'local';
            if (classifyMode === 'api' && classifyApiKey && classifyApiKey.trim()) {
              apiResults = await classifyBatchAPI(uncached, classifyApiKey.trim());
            } else {
              apiResults = await classifyBatch(uncached);
            }
          }

          const allVerdicts = [...cachedResults, ...apiResults];

          // Update daily stats
          let filtered = 0;
          let shown = 0;
          for (const v of allVerdicts) {
            if (v.verdict === 'allow') {
              shown++;
            } else {
              filtered++;
            }
          }
          await updateDailyStats(filtered, shown);

          sendResponse({ verdicts: allVerdicts });
          break;
        }

        case 'GET_STATS': {
          const stats = await getDailyStats();
          const usage = await getDailyUsage();
          const timeLimit = await getTimeLimit();

          sendResponse({
            filtered: stats.filtered,
            shown: stats.shown,
            analyzed: stats.analyzed,
            timeUsed: usage.seconds,
            timeLimit,
          });
          break;
        }

        case 'RESET_STATS': {
          const today = todayString();
          await chrome.storage.local.set({
            dailyStats: { date: today, filtered: 0, shown: 0, analyzed: 0 },
          });
          sendResponse({ success: true });
          break;
        }

        case 'SET_API_KEY': {
          const key = (message.key || '').trim();
          await chrome.storage.local.set({ apiKey: key });
          sendResponse({ success: true });
          break;
        }

        case 'SET_MODE': {
          const newMode = message.mode === 'api' ? 'api' : 'local';
          const { settings: modeSettings } = await chrome.storage.local.get('settings');
          const updated = modeSettings || {};
          updated.classificationMode = newMode;
          await chrome.storage.local.set({ settings: updated });
          // Notify all x.com tabs so they can update overlay
          const tabs = await chrome.tabs.query({ url: 'https://x.com/*' });
          for (const tab of tabs) {
            try {
              await chrome.tabs.sendMessage(tab.id, { type: 'MODE_CHANGED', mode: newMode });
            } catch (e) { /* content script may not be loaded */ }
          }
          sendResponse({ success: true, mode: newMode });
          break;
        }

        default:
          sendResponse(null);
      }
    } catch (e) {
      console.error('[X-Shield] Message handler error:', e);
      sendResponse(null);
    }
  })();

  // Return true to indicate we will call sendResponse asynchronously
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
      dailyStats: { date: today, filtered: 0, shown: 0, analyzed: 0 },
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
      settings: { timeLimitSeconds: DEFAULT_TIME_LIMIT_SECONDS },
    });
  }

  if (!existing.dailyUsage) {
    await chrome.storage.local.set({
      dailyUsage: { date: today, seconds: 0 },
    });
  }

  if (!existing.dailyStats) {
    await chrome.storage.local.set({
      dailyStats: { date: today, filtered: 0, shown: 0, analyzed: 0 },
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
