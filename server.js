#!/usr/bin/env node
'use strict';

const http = require('http');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 7890;

// -------------------------------------------------------------------
// Classification System Prompt
// -------------------------------------------------------------------
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
// Spawn claude CLI and return parsed result
// -------------------------------------------------------------------
function classifyWithClaude(userPrompt) {
  return new Promise((resolve, reject) => {
    // Use -p with no positional arg — prompt is piped via stdin.
    // Passing tweet text as a CLI argument fails when it starts
    // with dashes (CLI parser interprets "--- tweet_0 ..." as a flag).
    const args = [
      '-p',
      '--system-prompt', CLASSIFICATION_SYSTEM_PROMPT,
      '--output-format', 'json',
      '--model', 'sonnet',
      '--no-session-persistence',
      '--tools', '',
    ];

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
    });

    // Pipe user prompt via stdin
    proc.stdin.write(userPrompt);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        // --output-format json wraps output in { "result": "..." }
        const outer = JSON.parse(stdout);
        const resultText = outer.result || stdout;

        // Strip markdown fences if present
        let cleaned = resultText.trim();
        if (cleaned.startsWith('```')) {
          cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
        }

        const verdicts = JSON.parse(cleaned);
        resolve(verdicts);
      } catch (e) {
        reject(new Error(`Failed to parse claude output: ${e.message}\nRaw: ${stdout}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

// -------------------------------------------------------------------
// HTTP request body reader
// -------------------------------------------------------------------
const MAX_BODY_BYTES = 1024 * 1024; // 1MB

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// -------------------------------------------------------------------
// CORS headers
// -------------------------------------------------------------------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// -------------------------------------------------------------------
// HTTP Server
// -------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Classification endpoint
  if (req.method === 'POST' && req.url === '/classify') {
    try {
      const body = await readBody(req);
      const tweets = JSON.parse(body);

      if (!Array.isArray(tweets) || tweets.length === 0) {
        res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Expected non-empty array of tweets' }));
        return;
      }

      // Build user prompt from tweets
      const parts = tweets.map((t, i) =>
        `--- tweet_${i} (id: ${t.id}) ---\n${t.text || '[no text]'}`
      );
      const userPrompt = parts.join('\n\n');

      console.log(`[X-Shield Server] Classifying batch of ${tweets.length} tweets`);

      const verdicts = await classifyWithClaude(userPrompt);

      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ verdicts }));
    } catch (e) {
      console.error('[X-Shield Server] Classification error:', e.message);
      res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 404 for everything else
  res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, HOST, () => {
  console.log(`[X-Shield Server] Listening on http://${HOST}:${PORT}`);
});
