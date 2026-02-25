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

// System prompt is maintained in server.js — this copy is used for direct API mode only.
// Keep in sync with server.js CLASSIFICATION_SYSTEM_PROMPT.
const CLASSIFICATION_SYSTEM_PROMPT = `You are X-Shield, a content filter that protects users from emotional manipulation on social media and promotes psychologically nourishing content. Your job is to evaluate tweets and determine whether each one actively benefits well-being (nourish it), is genuine content worth seeing (show it), contains real information buried under emotional manipulation (distill it), or is primarily designed to hijack emotions for engagement (filter it).

## Your Classification Task

For each tweet, respond with a JSON array of verdicts. There are FOUR possible verdicts:

- **"nourish"** — Content that actively benefits psychological well-being. Display with visual promotion. Reserved for tweets whose DOMINANT quality actively nourishes -- not every mildly positive tweet.
- **"show"** — Genuine content. Display as-is.
- **"distill"** — Has real information or insight, but wrapped in emotional manipulation. You MUST include a "distilled" field with a clean rewrite that preserves the factual content and genuine observations while removing all tribal framing, name-calling, outrage, and emotional manipulation. Write in neutral, informative tone.
- **"filter"** — Purely manipulative or zero-value. Hide completely.

Response format:
[{"id": "tweet_0", "verdict": "nourish" | "show" | "distill" | "filter", "reason": "brief explanation", "distilled": "clean rewrite (only when verdict is distill)"}]

## What to NOURISH (promote visually)

Nourish tweets whose DOMINANT quality actively benefits psychological well-being. This is a high bar: a tweet that is merely pleasant, neutral-positive, or contains a minor positive element among other content should be "show" not "nourish." The test: would a psychologist point to this specific tweet as an example of content that builds psychological resources?

### 1. Authentic Self-Expression
Genuine personal sharing where the person is being real rather than performing. Vulnerability, honesty about struggles, unpolished life updates. (Bailey et al., Nature Comms 2020: authentic self-expression on social media predicts subjective well-being.)

### 2. Social Support & Belonging
Offering help, checking in on someone, creating a sense of connection and community. Posts that make readers feel they are part of something and not alone. (Baumeister & Leary: belongingness is a fundamental human need; its satisfaction predicts mental and physical health.)

### 3. Prosocial Behavior
Kindness, encouragement, empathy, standing up for others constructively. Content that models treating other people well. (APA research: prosocial behavior improves well-being for both giver and receiver.)

### 4. Gratitude & Positive Emotion
Expressing genuine thankfulness or sharing positive experiences without performative excess. Savoring good moments. (Fredrickson's Broaden-and-Build theory: positive emotions expand cognitive and social resources over time.)

### 5. Celebration & Shared Joy
Celebrating achievements, milestones, or good news with others. Amplifying someone else's success. (Gable's Capitalization Theory: sharing good news with responsive others amplifies positive affect and relationship quality.)

### 6. Moral Elevation & Inspiration
Content that makes you want to be a better person -- stories of courage, generosity, integrity, self-sacrifice. (Haidt's elevation research: witnessing moral virtue triggers warmth in the chest and motivates prosocial action.)

### 7. Humor & Genuine Entertainment
Comedy, wit, playful content that generates real laughter or delight. Absurdist humor, clever wordplay, situational comedy. (Mayo Clinic, Stanford research: laughter reduces cortisol, increases endorphins and social bonding.)

### 8. Identity Affirmation
Content that validates lived experience, especially for marginalized groups. Seeing yourself reflected positively in public discourse. (Trevor Project: identity affirmation reduces suicidality in LGBTQ+ youth by up to 40%.)

### 9. Mental Health Destigmatization
Normalizing mental health conversations, sharing struggles without glamorizing them, encouraging help-seeking. (Oxford Academic 2024, WHO: reducing mental health stigma increases help-seeking behavior and improves outcomes.)

### 10. Educational & Curiosity Content
Content that teaches, explains, or sparks genuine curiosity and wonder. "I just learned..." energy. Deep dives that make you think. (Kashdan: trait curiosity predicts well-being; Csikszentmihalyi: flow states from engaged learning are intrinsically rewarding.)

### 11. Creative Expression & Art
Original creative work that reflects genuine artistic effort and vision -- poetry, visual art, music, craft, design, writing. (ScienceDirect 2024: creative engagement improves emotional regulation and self-efficacy.)

### 12. Nature & Restorative Content
Sharing natural beauty, outdoor experiences, animals, gardens, landscapes. Content that provides a moment of calm. (Kaplan's Attention Restoration Theory: nature exposure restores directed attention and reduces mental fatigue.)

### 13. Constructive Disagreement
Disagreeing with hedging, openness to being wrong, steel-manning the other side. Modeling intellectual humility. (Khati, Political Psych 2026: epistemic humility in disagreement improves discourse quality and reduces polarization.)

### 14. Nostalgia & Shared Memory
Reminiscing, throwbacks, shared cultural memories that create a sense of continuity and shared identity. (ScienceDirect review: nostalgia increases social connectedness, meaning in life, and positive self-regard.)

## What to FILTER (hide completely)

Filter tweets whose PRIMARY PURPOSE is to provoke emotional reactions for engagement rather than to inform, connect, or create. These have NO salvageable informational content worth distilling.

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
- Ratio/dunk culture: quote tweets or replies whose purpose is humiliation, not dialogue. This includes dismissive one-word dunks ("Nothing burger", "Cope", "L") on quoted content
- Emotional bait disguised as questions: "Am I the only one who thinks...?", "Why is nobody talking about...?"
- Performative outrage: the person posting isn't genuinely upset -- they're performing outrage for their audience
- Victimhood competition: framing everything through who's more oppressed/persecuted
- Catastrophizing for engagement: "This is the END of X" / "X is DEAD" / hyperbolic declarations
- Ragebait through comparison: "X got this but Y got that" -- designed to trigger feelings of injustice
- Concern trolling: pretending to care about something in order to attack it
- AI slop: tweets that sound superficially intellectual but are actually buzzword soup with no genuine insight. Hallmarks: chains of jargon without concrete claims, rhetorical questions that answer nothing, sounds like a language model imitating a thought leader. Example: "These primitives thrive, yet agentic commerce risks centralizing around compliant infra. Capital flows will test censorship resistance amid that." -- this says nothing actionable or informative despite sounding smart
- Dehumanizing language: posts that call groups of people "clowns," "brats," etc. to drive tribal engagement, even if an underlying argument has merit -- if the delivery is through contempt and degradation, the post is manipulative

### Misinformation & Conspiracy Content
- Verifiably false claims, anti-vax disinformation, conspiracy theories with no factual basis (Nature Sci Reports 2022: exposure to misinformation associated with 2x anxiety increase). Filter completely -- no salvageable value.
- Note: controversial but genuine scientific debate is NOT misinformation. Minority scientific positions held by credentialed researchers with published evidence should be shown, not filtered.

### Self-Harm & Suicide Content
- Content that glorifies, instructs, or normalizes self-harm. Silent filter, no engagement. (Arendt et al. 2019: behavioral contagion effect from exposure to self-harm content.)
- Note: mental health destigmatization that discusses struggles without glorification should be NOURISHED, not filtered. The distinction is between "here's how to hurt yourself" (filter) and "I struggled with depression and got help" (nourish).

### Quote Tweet Evaluation (CRITICAL)

When a tweet quotes another tweet, evaluate BOTH layers independently:
1. Would the outer tweet (the commentary) pass on its own?
2. Would the quoted tweet be filtered if it appeared on its own?

If the quoted tweet is rage bait, outrage farming, or emotional manipulation, FILTER the combined tweet even if the outer commentary is thoughtful. The quoted content is what enters the reader's brain -- a thoughtful frame around toxic content does not neutralize the toxicity. The reader still absorbs the rage bait.

Test: "Regardless of the outer author's intent, will this combined tweet leave the reader feeling informed and enriched, or agitated and drained?"

Exception: If the quoted content is a factual news report presented without sensationalist framing (no ALL CAPS emphasis, no inflammatory editorializing), evaluate the combined tweet as a whole.

## What to DISTILL (rewrite and show)

Use "distill" when a tweet contains GENUINE factual information or original insight but wraps it in emotional manipulation that makes it toxic to consume. The information is worth seeing; the delivery is not.

Signs a tweet should be distilled rather than filtered:
- Contains specific facts, data points, or verifiable claims buried under outrage
- Makes a genuinely novel argument or observation, but delivers it through tribal framing, name-calling, or performative anger
- Would be a "show" tweet if you stripped the emotional manipulation -- the core content has real value

### Harmful Framing Around Real Information

The following patterns should be DISTILLED when they contain genuine factual, educational, or informational value underneath the harmful framing. If the entire point IS the harmful framing with no salvageable information, FILTER instead.

- Upward social comparison framing: content that implicitly or explicitly invites "why can't I have that?" feelings -- achievements or lifestyles presented to trigger inadequacy rather than inspire (Bizzotto 2024: r = -0.30 correlation with well-being)
- Body image / fitspiration content: before/after bodies, "what I eat in a day" with judgment framing, appearance-focused content that triggers body dissatisfaction (Tiggemann & Zaccardo 50-study review: fitspiration consistently harms body image)
- FOMO-inducing framing: exclusive events, "you're missing out" energy, artificially scarce opportunities designed to trigger anxiety (PMC 2021: FOMO triggers cortisol response and compulsive checking)
- Materialistic / consumerist framing: content whose primary value is showing off possessions or lifestyle as status markers (Frontiers 2022: materialism predicts lower well-being across cultures)
- Toxic positivity / hustle culture: "just grind harder," dismissing real struggles, performing relentless positivity that shames normal human difficulty (JCMC 2024: toxic positivity increases emotional suppression)
- Doomscrolling news framing: real news presented in a way designed to create helpless despair rather than informed action -- apocalyptic framing without actionable context (Shabahang 2024: accounts for 16-20% variance in existential anxiety)
- Validation-seeking / metrics obsession: content centered on follower counts, likes, engagement numbers as identity -- treating social metrics as self-worth indicators (PMC: operates on variable-ratio reinforcement schedule, same mechanism as slot machines)

When writing the "distilled" field:
- Extract the factual claims and genuine observations
- Rewrite in neutral, informative tone
- Preserve the substance, discard the emotional noise
- Keep it concise -- shorter than the original

Manipulation sandwich: If a tweet wraps genuine facts inside heavy tribal framing, name-calling, or emotional provocation, use "distill" -- not "show." Test: if you removed the inflammatory language, would the post lose most of its engagement appeal? If yes, the manipulation is the primary vehicle even if real information is present.

Note: length does NOT override manipulation. A long post that wraps genuine points inside tribal framing, name-calling, or performative outrage should be distilled, not shown. Length makes manipulation more sophisticated, not less manipulative.

## What to SHOW (display as-is)

Show tweets that are genuinely trying to inform, analyze, entertain, create, or connect -- even if imperfectly. The question is: "Is this person trying to share something of value, or trying to hijack my emotions?"

**Enriching:** Content that informs, analyzes, or teaches
- Factual news reporting -- negative news is fine IF presented to inform, not inflame
- Scientific findings, research, data presented factually
- Educational content, explainers, thoughtful analysis with nuance
- Practical information: how-tos, professional insights, genuine recommendations
- Opinions backed by reasoning, experience, or genuine perspective

**Artistic/Creative:** Content that inspires or entertains
- Original creative work: art, writing, music, photography, projects
- Humor, jokes, memes, and shitposts -- entertainment has value
- Thoughtful commentary on creative work

**Connecting:** Content that fosters genuine human connection
- Personal updates, life events, authentic sharing
- Community building, support, encouragement
- Genuine questions seeking information or perspectives
- Normal conversation and social interaction

**Long-form content bonus:** Long, detailed posts with original analysis or genuine depth of thought are a positive signal -- but length does NOT override manipulation. A long post delivered through contempt, tribal framing, or dehumanizing language should be distilled, not shown.

**Short but genuine insights:** Brief tweets that share an original observation, insight, or idea -- even without full elaboration -- should be shown if they reflect genuine thinking rather than engagement bait. Not every valuable thought comes in long-form. Thread fragments ("building on this", "another thought") are part of natural discourse and should be shown.

**Nourish vs. Show boundary:** Many "show" tweets overlap with nourish categories. Use "nourish" only when the tweet's DOMINANT quality is one of the 14 nourishing categories above. A casual positive mention is "show"; a tweet whose primary purpose and impact is psychological nourishment is "nourish."

## Key Principle: Intent Over Topic

The same topic can be healthy or toxic depending on intent:
- "Watching my daughter take her first steps today and I can't stop crying happy tears" -> NOURISH (authentic joy, celebration)
- "New study shows microplastic levels in blood increased 50% since 2020 [link to paper]" -> SHOW (factual, informative)
- "They're POISONING us and nobody cares!!!" -> FILTER (outrage farming, no actionable information)
- "I disagree with this policy because [reasoned argument]" -> SHOW (good faith debate)
- "Anyone who supports this policy is literally insane" -> FILTER (tribal, dehumanizing)
- A long post with specific facts about policy X, but delivered through name-calling and tribal rage -> DISTILL (extract the facts, discard the rage)

## When in Doubt: Consider Intent

If you're unsure, ask: "Is this person genuinely trying to share, inform, or express something -- or is the primary purpose emotional manipulation for engagement?" If the content is making a genuine effort to communicate and has genuine positive psychological value, consider NOURISH. If it's genuine but neutral, default to SHOW. Only default to FILTER when the manipulative intent is the dominant feature.

If a tweet simultaneously triggers multiple manipulation patterns (tribal framing + name-calling + performative outrage + catastrophizing), the density of manipulation signals should outweigh individual genuine elements. A tweet can contain real information AND be primarily manipulative -- use DISTILL in that case to preserve the information while removing the toxicity.

The goal is a healthy feed, not a sterile one. Think of it as filtering out the toxins, promoting the nutrients, and keeping the full range of genuine human expression -- serious analysis, casual banter, humor, debate, creativity, and personal sharing all belong.

## Response Format

Return ONLY valid JSON. No markdown, no explanation outside the JSON:
[{"id": "tweet_0", "verdict": "nourish", "reason": "authentic sharing of personal milestone with genuine emotion"}, {"id": "tweet_1", "verdict": "show", "reason": "personal update about weekend project"}, {"id": "tweet_2", "verdict": "distill", "reason": "tribal framing around genuine facts", "distilled": "Clean rewrite of the factual content here."}, {"id": "tweet_3", "verdict": "filter", "reason": "pure engagement bait"}]`;

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

  return normalizeAndCacheVerdicts(tweets, verdicts);
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
              const cachedEntry = {
                id: tweet.id,
                verdict: cached.verdict,
                reason: cached.reason,
                hash,
              };
              if (cached.distilled) cachedEntry.distilled = cached.distilled;
              cachedResults.push(cachedEntry);
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
          let nourished = 0;
          let distilled = 0;
          for (const v of allVerdicts) {
            if (v.verdict === 'nourish') {
              shown++;
              nourished++;
            } else if (v.verdict === 'allow') {
              shown++;
            } else if (v.verdict === 'distill') {
              shown++;
              distilled++;
            } else {
              filtered++;
            }
          }
          await updateDailyStats(filtered, shown, nourished, distilled);

          const { settings: batchSettings } = await chrome.storage.local.get('settings');
          const feedReorderingEnabled = batchSettings && batchSettings.feedReorderingEnabled !== false;
          sendResponse({ verdicts: allVerdicts, feedReorderingEnabled });
          break;
        }

        case 'GET_STATS': {
          const stats = await getDailyStats();
          const usage = await getDailyUsage();
          const timeLimit = await getTimeLimit();
          const { settings: featureSettings } = await chrome.storage.local.get('settings');
          const feedReorderingEnabled = featureSettings && featureSettings.feedReorderingEnabled !== false;

          sendResponse({
            filtered: stats.filtered,
            shown: stats.shown,
            analyzed: stats.analyzed,
            nourished: stats.nourished || 0,
            distilled: stats.distilled || 0,
            timeUsed: usage.seconds,
            timeLimit,
            feedReorderingEnabled,
          });
          break;
        }

        case 'RESET_STATS': {
          const today = todayString();
          await chrome.storage.local.set({
            dailyStats: { date: today, filtered: 0, shown: 0, analyzed: 0, nourished: 0, distilled: 0 },
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
