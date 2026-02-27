#!/usr/bin/env node
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const CLASSIFICATION_SYSTEM_PROMPT = require('./system-prompt.js');

const HOST = '127.0.0.1';
const PORT = 7890;
const POOL_SIZE = 3;

// -------------------------------------------------------------------
// CLI args for spawning claude processes
// -------------------------------------------------------------------
const CLAUDE_ARGS = [
  '-p',
  '--system-prompt', CLASSIFICATION_SYSTEM_PROMPT,
  '--output-format', 'json',
  '--model', 'sonnet',
  '--no-session-persistence',
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

    // Wait for the CLI to finish initializing before marking ready.
    // Without this, stdin data can arrive during arg parsing and get
    // misinterpreted as CLI options (defense-in-depth alongside the
    // [tweet_N] delimiter which avoids flag-like prefixes).
    entry.ready = new Promise(resolve => setTimeout(resolve, 1500));

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
async function classifyWithClaude(userPrompt) {
  const entry = pool.acquire();

  // Wait for the CLI to finish initializing before writing to stdin
  await entry.ready;

  const { proc } = entry;

  return new Promise((resolve, reject) => {
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
        `[tweet_${i}]\n${t.text || '[no text]'}`
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
