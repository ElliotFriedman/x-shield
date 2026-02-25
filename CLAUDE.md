# X-Shield — Project Context

## What This Is

X-Shield is a Chrome/Brave browser extension that uses Claude AI to filter manipulative content from X (Twitter) feeds in real-time. It evaluates every tweet before the user sees it, hiding rage bait, engagement farming, tribal dunking, and emotional manipulation while letting genuine content through. It also enforces a configurable daily time limit on X usage.

## The Problem

Social media algorithms optimize for engagement, not well-being. The content that keeps users scrolling — outrage, tribal conflict, manufactured controversy — is harmful over time. Users have no native tools to filter by intent or emotional manipulation. X-Shield acts as an AI nutritionist for your information diet: you still use X, but only see content worth your attention.

## Core Design Principle: Fail-Closed

Tweets are **hidden by default** and only shown after AI classification approves them. If anything goes wrong (server down, API error, malformed response), tweets stay hidden. The system never fails open.

## Architecture Overview

```
x.com (content.js)  →  background.js (service worker)  →  Claude AI
   MutationObserver        routing, caching, time tracking     classification
   tweet extraction        stats, lockout enforcement
   verdict application
```

### Data Flow
1. `content.js` detects new tweets via MutationObserver, immediately hides them (`visibility: hidden`)
2. Tweet text extracted (author, body, quote-tweets, link previews) and batched (5 tweets or 3s timeout)
3. Batch sent to `background.js` via `chrome.runtime.sendMessage`
4. `background.js` checks in-memory cache (24h TTL, 500 entry LRU). Cache hits return immediately.
5. Cache misses routed to Claude for classification (two modes, see below)
6. Verdicts returned to `content.js` and applied to DOM: fade in (show), stay hidden (filter), or rewrite (distill)

### Two Classification Modes

**Claude Code (recommended, free with Claude Max):**
- Local Node.js server on `127.0.0.1:7890` (`server.js`)
- Pre-spawns 3 warm `claude -p` CLI processes to avoid cold-start latency
- Tweets piped via stdin, JSON verdicts returned via stdout
- Zero npm dependencies, zero API costs

**API Key (pay-per-use):**
- Direct HTTPS calls to `api.anthropic.com/v1/messages` from the service worker
- Model: `claude-sonnet-4-20250514`
- API key stored in `chrome.storage.local`

## File Map

| File | Role |
|---|---|
| `manifest.json` | Chrome MV3 extension config, permissions, content script registration |
| `content.js` | Runs on x.com. MutationObserver detects tweets, extracts text, batches for classification, applies verdicts to DOM. Handles SPA navigation (Navigation API with URL-polling fallback). Also sends heartbeat every 10s for time tracking. |
| `background.js` | Service worker. Routes classification requests (local server or API), manages in-memory cache with periodic flush to storage, tracks daily usage time, enforces lockout when time limit exceeded, maintains daily stats. |
| `server.js` | Local HTTP server (port 7890). Maintains pool of 3 pre-warmed `claude -p` processes. `POST /classify` accepts tweet array, pipes to Claude via stdin, returns JSON verdicts. `GET /health` for status checks. Holds the full system prompt. |
| `styles.css` | Injected into x.com. CSS classes for tweet states (pending/approved/filtered/distilled/unclassified). Also hides sidebar, trending, "Who to follow", and recommendation sections. |
| `popup.html` / `popup.js` / `popup.css` | Extension popup UI. Mode toggle (Claude Code vs API Key), server health indicator, API key input, daily time limit setting, live stats display (analyzed/filtered/shown). |
| `blocked.html` / `blocked.js` | Full-screen lockout page shown when daily time limit reached. Countdown to midnight reset. |

## Classification Logic (3 Verdicts)

The system prompt (duplicated in `server.js` and `background.js`) defines three verdicts:

- **`show`** — Genuine content: factual reporting, educational content, original creative work, authentic personal updates, opinions backed by reasoning, humor/memes
- **`filter`** — Pure manipulation: rage bait, engagement bait ("like if you agree"), manufactured urgency, tribal dunking, moral superiority signaling, performative outrage, AI slop, dehumanizing language, dismissive one-liners
- **`distill`** — Real information wrapped in manipulation: factual data delivered with tribal framing or inflammatory language. Claude rewrites to extract facts in neutral tone, shown with a purple border and "distilled by X-Shield" label

**Key nuance:** Classification is based on **intent and delivery**, not topic. Negative news reported factually → show. Same news wrapped in outrage framing → distill or filter. Quote-tweets evaluated holistically — if quoted content is rage bait, the outer tweet gets filtered even if its commentary seems reasonable.

## Caching

- In-memory cache mirror loaded from `chrome.storage.local` on startup
- Keyed by content hash (SHA-256 of tweet text)
- 24-hour TTL per entry, LRU eviction at 500 entries
- Dirty flag with 5-second periodic flush to storage
- Prevents re-classifying identical tweets across page loads

## Time Tracking & Lockout

- `content.js` sends heartbeat to `background.js` every 10 seconds
- Background increments `dailyUsage.seconds`, stored in `chrome.storage.local`
- When usage exceeds `settings.timeLimitSeconds` (default 900 = 15 min), `enforceLockout()` fires
- All x.com tabs receive LOCKOUT message and redirect to `blocked.html`
- `blocked.html` shows countdown timer to midnight
- Daily alarm resets usage, stats, and lockout flag at midnight

## CSS Tweet States

| Class | Behavior |
|---|---|
| `.x-shield-pending` | `visibility: hidden` — hidden while awaiting classification (preserves layout) |
| `.x-shield-approved` | Visible with fade-in animation |
| `.x-shield-filtered` | `display: none` — completely removed from view |
| `.x-shield-distilled` | Visible with purple left border + label |
| `.x-shield-unclassified` | Visible with yellow warning border (classification failed) |

## Storage Schema

```
chrome.storage.local:
  settings.timeLimitSeconds  — daily limit in seconds (default 900)
  settings.classificationMode — 'local' or 'api'
  apiKey                      — Anthropic API key (API mode only)
  cache                       — { [contentHash]: { verdict, reason, timestamp, distilled? } }
  dailyUsage                  — { date, seconds }
  dailyStats                  — { date, filtered, shown, analyzed }
  locked                      — boolean, true when limit exceeded
```

## Important Implementation Details

- **Text extraction timing:** Tweet text must be extracted BEFORE applying `visibility: hidden` CSS, because `innerText` returns empty string for hidden elements. The code uses `textContent` which is DOM-only and works regardless of CSS visibility.
- **SPA navigation:** X is a single-page app. Content script uses the Navigation API (with URL-polling fallback) to detect route changes, clear pending batches, and strip stale X-Shield classes from recycled DOM elements.
- **Process pool:** `server.js` pre-spawns 3 `claude -p` processes with the system prompt loaded. When a classification request arrives, it grabs a warm process from the pool, pipes tweets via stdin, and reads the JSON response. Pool auto-refills in the background.
- **Zero dependencies:** The entire project is vanilla JavaScript with no build step, no npm packages, no bundler. `server.js` uses only Node.js built-in modules (`http`, `crypto`, `child_process`).
- **Message security:** `background.js` only accepts messages from its own extension ID (`sender.id === chrome.runtime.id`).

## Testing

Test fixtures live in `tests/fixtures/` organized by expected verdict:
- `tests/fixtures/show/` — tweets that should be approved
- `tests/fixtures/filter/` — tweets that should be hidden
- `tests/fixtures/distill/` — tweets that should be rewritten
