# X-Shield

**AI-powered content filter for X (Twitter) that protects your mental health.**

X-Shield sits between you and your feed, using Claude AI to evaluate every tweet before you see it. Rage bait, engagement farming, tribal dunking, and emotional manipulation get filtered out silently. What remains is content that's actually worth your attention.

It also enforces a configurable **daily time limit** — once you've spent your allotted time on X, all tabs close and access is blocked until the next day.

## Quickstart

### Prerequisites

- **Node.js** (any recent version)
- **[Claude CLI](https://docs.anthropic.com/en/docs/claude-code)** installed and authenticated (`claude` command available in your terminal)
- **Claude Max subscription** (CLI usage at no extra cost)
- **Chrome or Brave** browser

### 1. Clone and start the local server

```bash
git clone git@github.com:ElliotFriedman/x-shield.git
cd x-shield
node server.js
```

You should see:

```
[X-Shield Server] Listening on http://127.0.0.1:7890
[X-Shield Server] Pre-warming 3 Claude processes...
```

Leave this terminal running.

### 2. Load the extension

1. Open `chrome://extensions` (or `brave://extensions`)
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `x-shield` directory you just cloned

### 3. Verify and browse

1. Click the X-Shield extension icon in your toolbar
2. Confirm "Claude Code" mode is selected (it's the default)
3. The popup should show **"Local server: connected"**
4. Open [x.com](https://x.com) — tweets will be classified automatically

The local server must be running whenever you use X. If it's not running, X-Shield will show an overlay prompting you to start it.

### Alternative: API Key Mode (no local server)

If you don't have a Claude Max subscription, you can use an Anthropic API key instead:

1. Load the extension (step 2 above)
2. Click the X-Shield icon and switch the toggle to **"API Key"**
3. Enter your [Anthropic API key](https://console.anthropic.com/) and click Save
4. Open [x.com](https://x.com) — no local server needed, but you pay per token

## How It Works

X-Shield uses a **fail-closed** design — tweets are hidden by default and only shown after AI classification approves them.

1. A tweet appears in your feed or notifications
2. X-Shield immediately hides it (you never see unclassified content)
3. The tweet text is sent to Claude for classification
4. Claude classifies it into one of four verdicts: **nourish** (actively beneficial), **show** (genuine content), **distill** (real info wrapped in manipulation — rewritten neutrally), or **filter** (pure manipulation, scams, zero-value)
5. Approved tweets fade in. Everything else stays hidden.

If anything goes wrong — server down, API error, malformed response — tweets stay hidden. The system never fails open.

### Classification Verdicts

| Verdict | What it means | What you see |
|---|---|---|
| **show** | Genuine content — factual reporting, creative work, authentic updates, opinions backed by reasoning | Tweet fades in normally |
| **nourish** | Actively benefits well-being — high bar, reserved for content a psychologist would point to as beneficial | Tweet shown with visual promotion |
| **distill** | Real information wrapped in manipulation — Claude rewrites it in neutral tone | Purple border + "distilled by X-Shield" label |
| **filter** | Pure manipulation — rage bait, engagement bait, tribal dunking, performative outrage | Hidden completely |

Classification is based on **intent and delivery**, not topic. Negative news reported factually gets shown. The same news wrapped in outrage framing gets distilled or filtered.

## Features

- **AI classification** — Every tweet evaluated by Claude for emotional manipulation, rage bait, engagement farming, and low-value content
- **Notifications filtering** — Scam mentions, phishing, and spam in your notifications tab are classified and hidden just like feed content
- **Fail-closed design** — If anything goes wrong, tweets stay hidden rather than slipping through
- **Daily time limit** — Configurable timer (default 15 minutes). Once reached, all X tabs close and access is blocked until the next day
- **Dual classification modes** — Claude Code (free via CLI) or API Key (pay-per-use) — switch anytime from the popup
- **Caching** — Classification results cached for 24 hours so repeated content isn't re-classified
- **Distraction removal** — Trending sidebar, "Who to follow", "You might like", and "Relevant people" sections are all hidden
- **Zero dependencies** — No npm packages, no build step, no bundler. Pure vanilla JavaScript.

## Configuration

Open the extension popup to configure:

| Setting | Description |
|---|---|
| **Classification Mode** | Toggle between "Claude Code" (local server) and "API Key" (direct API) |
| **Server Status** | Shows local server connection status (Claude Code mode only) |
| **API Key** | Enter your Anthropic API key (API Key mode only) |
| **Daily Time Limit** | Your daily X usage limit in minutes (default: 15) |
| **Stats** | Tweets analyzed, filtered, and shown today |

## Architecture

```
Browser (x.com)              Extension                    Classification
     |                          |                              |
     |  tweet appears           |                              |
     |------------------------->|                              |
     |  (hidden immediately)    |                              |
     |                          |  Claude Code mode:           |
     |                          |  POST localhost:7890 ------->| server.js → claude CLI
     |                          |                              |
     |                          |  API Key mode:               |
     |                          |  POST api.anthropic.com ---->| Anthropic API
     |                          |                              |
     |  show or hide tweet      |  verdicts                    |
     |<-------------------------|<-----------------------------|
```

| File | Purpose |
|---|---|
| `server.js` | Local HTTP server (port 7890) — bridges to Claude CLI for classification |
| `background.js` | Service worker — classification routing, caching, time tracking, lockout |
| `content.js` | Content script on x.com — DOM observation, tweet extraction, verdict display |
| `styles.css` | Injected CSS — hides pending/filtered tweets and recommendation sections |
| `popup.html/js/css` | Extension popup — mode toggle, settings, stats |
| `blocked.html/js` | Lockout page shown when daily time limit is reached |
| `manifest.json` | Chrome MV3 extension manifest |
