# X-Shield

**AI-powered content filter for X (Twitter) that protects your mental health.**

## Why This Exists

Social media is engineered to hijack your brain. Every algorithm, every recommendation, every "trending" section is optimized for one thing: keeping you engaged. And what keeps you engaged isn't what's good for you — it's outrage, fear, conflict, and manufactured controversy. The content that makes you doom-scroll for hours is the digital equivalent of junk food: engineered to be irresistible, impossible to stop consuming, and deeply harmful over time.

Consuming unfiltered social media and expecting it not to affect your mental health is like eating fast food for every meal and being surprised when your health deteriorates. The rage bait, the pile-ons, the tribal "us vs. them" framing, the performative outrage — none of it adds value to your life. It just drains your cognitive energy and leaves you anxious, angry, and exhausted.

X-Shield interrupts the doom-scroll loop. It sits between you and your feed, using AI to evaluate every tweet before you see it. Content designed to manipulate your emotions — rage bait, engagement farming, outrage porn, tribal dunking — gets filtered out silently. What remains is the content that actually enriches your life: genuine information, creative work, authentic human connection, and thoughtful analysis.

Think of it as a nutritionist for your information diet. You still get to use social media, but you only see the content that's actually worth your attention.

X-Shield also includes a **daily time limit**. Once you've spent your allotted time on X, the extension closes all X tabs and blocks further access until the next day. Because even healthy content consumed endlessly is still a time sink — your attention is finite, and it deserves to be spent intentionally.

## How It Works

X-Shield is a Chrome/Brave extension with a **fail-closed** design — tweets are hidden by default and only shown after AI classification approves them.

1. A tweet appears in your feed
2. X-Shield immediately hides it (you never see unclassified content)
3. The tweet text is sent to Claude (Anthropic's AI) for classification
4. Claude evaluates whether the tweet is genuinely enriching or just engagement bait
5. Approved tweets fade in. Everything else stays hidden.

If anything goes wrong — server down, API error, malformed response — tweets stay hidden. The system never fails open.

## Two Classification Modes

X-Shield supports two ways to connect to Claude for classification. Choose the one that fits your setup:

### Option A: Claude Code (Recommended — Free)

Routes classification through a local Node.js server that calls the Claude CLI. If you have a Claude Max subscription, this costs nothing extra.

**Requirements:**
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Claude Max subscription
- Node.js installed

**Setup:**
1. Clone and start the server:
   ```bash
   git clone git@github.com:ElliotFriedman/x-shield.git
   cd x-shield
   node server.js
   ```
   You should see: `[X-Shield Server] Listening on http://127.0.0.1:7890`

2. Load the extension:
   - Go to `chrome://extensions` (or `brave://extensions`)
   - Enable "Developer mode"
   - Click "Load unpacked" and select the `x-shield` directory

3. Open the extension popup and make sure "Claude Code" is selected (it's the default)
4. The popup should show "Local server: connected"
5. Open [x.com](https://x.com) — tweets will be classified automatically

**Note:** The local server must be running whenever you use X. If it's not running, X-Shield will show an overlay prompting you to start it.

### Option B: API Key (Pay-Per-Use)

Calls the Anthropic API directly from the browser extension. No local server needed, but you pay per token.

**Requirements:**
- An [Anthropic API key](https://console.anthropic.com/)

**Setup:**
1. Clone and load the extension:
   ```bash
   git clone git@github.com:ElliotFriedman/x-shield.git
   ```
   - Go to `chrome://extensions` (or `brave://extensions`)
   - Enable "Developer mode"
   - Click "Load unpacked" and select the `x-shield` directory

2. Open the extension popup
3. Switch the toggle to "API Key"
4. Enter your Anthropic API key and click Save
5. Open [x.com](https://x.com) — tweets will be classified automatically

## Features

- **AI classification** — Every tweet evaluated by Claude for emotional manipulation, rage bait, engagement farming, and low-value content
- **Fail-closed design** — If anything goes wrong, tweets stay hidden rather than slipping through
- **Daily time limit** — Configurable timer (default 15 minutes). Once reached, all X tabs close and access is blocked until the next day
- **Dual classification modes** — Claude Code (free via CLI) or API Key (pay-per-use) — switch anytime from the popup
- **Caching** — Classification results cached for 24 hours so repeated content isn't re-classified
- **Distraction removal** — Trending sidebar, "Who to follow", "You might like", and "Relevant people" sections are all hidden

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
