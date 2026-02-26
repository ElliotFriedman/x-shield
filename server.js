#!/usr/bin/env node
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const { readFileSync } = require('fs');
const { join } = require('path');
const CLASSIFICATION_SYSTEM_PROMPT = require('./system-prompt.js');

const HOST = '127.0.0.1';
const PORT = 7890;
const POOL_SIZE = 3;
const DEBUG = process.env.DEBUG === 'true';
const HISTORY_MAX = 200;

// -------------------------------------------------------------------
// Debug: classification history + SSE clients
// -------------------------------------------------------------------
const classificationHistory = [];
const sseClients = new Set();

// Send SSE heartbeat every 30s to detect dead connections
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(':heartbeat\n\n');
    } catch (e) {
      sseClients.delete(client);
    }
  }
}, 30000);

function recordClassification(tweets, verdicts) {
  const timestamp = new Date().toISOString();
  for (let i = 0; i < verdicts.length; i++) {
    const tweet = tweets[i] || {};
    const entry = {
      timestamp,
      tweetId: tweet.id || `unknown_${i}`,
      url: tweet.url || null,
      text: tweet.text || '',
      verdict: verdicts[i].verdict,
      reason: verdicts[i].reason || '',
      distilled: verdicts[i].distilled || null,
    };
    classificationHistory.push(entry);
    if (classificationHistory.length > HISTORY_MAX) {
      classificationHistory.shift();
    }

    // Push to SSE clients
    for (const client of sseClients) {
      client.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
  }

  if (DEBUG) {
    const COLORS = { nourish: '\x1b[36m', show: '\x1b[32m', filter: '\x1b[31m', distill: '\x1b[35m' };
    const RESET = '\x1b[0m';
    for (const v of verdicts) {
      const tweet = tweets.find((t, j) => `tweet_${j}` === v.id) || {};
      const color = COLORS[v.verdict] || '';
      const text = (tweet.text || '').replace(/\n/g, ' ').slice(0, 120);
      console.log(`${color}[${v.verdict.toUpperCase()}]${RESET} ${text}${tweet.text && tweet.text.length > 120 ? '...' : ''}`);
      console.log(`         reason: ${v.reason || 'none'}`);
      if (v.distilled) {
        console.log(`         distilled: ${v.distilled.slice(0, 120)}`);
      }
    }
  }
}

// -------------------------------------------------------------------
// CLI args for spawning claude processes
// -------------------------------------------------------------------
const CLAUDE_ARGS = [
  '-p',
  '--system-prompt', CLASSIFICATION_SYSTEM_PROMPT,
  '--output-format', 'json',
  '--model', 'sonnet',
  '--no-session-persistence',
  '--tools', '',
];

// -------------------------------------------------------------------
// Pre-spawn Process Pool
//
// `claude -p` with no positional argument blocks on stdin. We spawn
// processes in advance so they load the CLI bundle and authenticate
// before any request arrives. When a request comes in, we grab a warm
// process, pipe the prompt to its stdin, and collect the result.
// -------------------------------------------------------------------
class ProcessPool {
  constructor(size) {
    this._size = size;
    this._pool = [];
    for (let i = 0; i < size; i++) {
      this._pool.push(this._spawnWarm());
    }
    console.log(`[X-Shield Server] Pre-spawned ${size} claude processes`);
  }

  _spawnWarm() {
    const proc = spawn('claude', CLAUDE_ARGS, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const entry = { proc, alive: true };

    proc.on('error', (err) => {
      console.error('[X-Shield Server] Warm process error:', err.message);
      entry.alive = false;
    });

    proc.on('exit', () => {
      entry.alive = false;
    });

    return entry;
  }

  acquire() {
    // Remove any dead processes
    this._pool = this._pool.filter((e) => e.alive);

    const entry = this._pool.shift();

    // Refill in the background
    this._refill();

    if (entry) {
      return entry;
    }

    // Pool was empty — spawn on demand
    console.log('[X-Shield Server] Pool empty, spawning on-demand process');
    return this._spawnWarm();
  }

  _refill() {
    // Count how many warm processes we need
    const alive = this._pool.filter((e) => e.alive).length;
    const needed = this._size - alive;
    for (let i = 0; i < needed; i++) {
      this._pool.push(this._spawnWarm());
    }
  }
}

const pool = new ProcessPool(POOL_SIZE);

// -------------------------------------------------------------------
// Parse Claude CLI output, handling outer JSON wrapper and code fences
// -------------------------------------------------------------------
function parseClaudeOutput(raw) {
  // --output-format json wraps output in { "result": "..." }
  let text = raw;
  try {
    const outer = JSON.parse(raw);
    text = outer.result || raw;
  } catch (e) {
    // Not wrapped in outer JSON — use raw output
  }

  // Strip markdown code fences if present
  text = text.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
  }

  return JSON.parse(text);
}

// -------------------------------------------------------------------
// Classify using a warm claude process from the pool
// -------------------------------------------------------------------
function classifyWithClaude(userPrompt) {
  return new Promise((resolve, reject) => {
    const { proc } = pool.acquire();

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    // Pipe user prompt via stdin, then close to signal EOF
    proc.stdin.write(userPrompt);
    proc.stdin.end();

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('claude process timed out after 60s'));
    }, 60000);

    proc.on('close', (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        const verdicts = parseClaudeOutput(stdout);
        resolve(verdicts);
      } catch (e) {
        reject(new Error(`Failed to parse claude output: ${e.message}\nRaw: ${stdout.slice(0, 500)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
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

const DEBUG_DASHBOARD_HTML = readFileSync(join(__dirname, 'debug-dashboard.html'), 'utf-8');

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

  // Debug dashboard
  if (req.method === 'GET' && req.url === '/debug') {
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/html' });
    res.end(DEBUG_DASHBOARD_HTML);
    return;
  }

  // Debug SSE event stream
  if (req.method === 'GET' && req.url === '/debug/events') {
    res.writeHead(200, {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    req.on('error', () => sseClients.delete(res));
    // Send initial heartbeat to confirm connection
    res.write(':connected\n\n');
    return;
  }

  // Debug API — classification history with summary stats
  if (req.method === 'GET' && req.url === '/debug/api') {
    const stats = { total: 0, nourish: 0, show: 0, filter: 0, distill: 0 };
    for (const entry of classificationHistory) {
      stats.total++;
      if (stats.hasOwnProperty(entry.verdict)) {
        stats[entry.verdict]++;
      }
    }
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stats, history: classificationHistory }));
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

      recordClassification(tweets, verdicts);

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
  console.log(`[X-Shield Server] Debug dashboard: http://${HOST}:${PORT}/debug`);
  if (DEBUG) {
    console.log('[X-Shield Server] DEBUG mode enabled — verbose classification logging to terminal');
  }
});
