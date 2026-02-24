/*
 * X-Shield Content Script
 * Runs on x.com — intercepts tweets, classifies them via the background
 * service worker, and hides anything that fails the AI filter.
 *
 * Design principle: FAIL CLOSED. If anything goes wrong (message passing
 * errors, malformed responses, missing API key), tweets stay hidden.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------
  const BATCH_SIZE = 5;
  const BATCH_TIMEOUT_MS = 3000;
  const HEARTBEAT_INTERVAL_MS = 10000;
  const SPA_POLL_INTERVAL_MS = 1000;

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  const verdictCache = new Map();       // contentHash -> verdict string
  const elementMap = new Map();         // tweetId -> DOM element
  let batchQueue = [];                  // { id, text, element }
  let batchTimer = null;
  let lastUrl = location.href;

  // ---------------------------------------------------------------
  // Content hash — simple djb2-style hash returning a hex string
  // ---------------------------------------------------------------
  function contentHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0; // convert to 32-bit int
    }
    return (hash >>> 0).toString(16);
  }

  // ---------------------------------------------------------------
  // Safe message sender — wraps chrome.runtime.sendMessage with
  // error handling. Returns null on failure so callers can fail
  // closed.
  // ---------------------------------------------------------------
  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // ---------------------------------------------------------------
  // Redirect to blocked page
  // ---------------------------------------------------------------
  function redirectToBlocked() {
    window.location.href = chrome.runtime.getURL('blocked.html');
  }

  // ---------------------------------------------------------------
  // Listen for lockout broadcasts from background
  // ---------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'LOCKOUT') {
      redirectToBlocked();
    }
    if (msg && msg.type === 'MODE_CHANGED') {
      removeApiKeyOverlay();
      (async () => {
        const resp = await sendMessage({ type: 'CHECK_API_KEY' });
        if (!resp || !resp.hasKey) {
          showApiKeyOverlay((resp && resp.mode) || 'local');
        }
      })();
    }
  });

  // ---------------------------------------------------------------
  // Server unavailable overlay — fail closed, hide all tweets
  // ---------------------------------------------------------------
  function showApiKeyOverlay(mode) {
    // Avoid duplicates
    if (document.querySelector('.x-shield-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'x-shield-overlay';

    if (mode === 'api') {
      overlay.textContent =
        'X-Shield: Set your Anthropic API key in the extension popup to use X.';
    } else {
      overlay.textContent =
        'X-Shield: Start the local server (node server.js) to use X.';
    }
    document.body.appendChild(overlay);

    // Also hide any tweets already on the page
    hideAllTweets();
  }

  function removeApiKeyOverlay() {
    const overlay = document.querySelector('.x-shield-overlay');
    if (overlay) overlay.remove();
  }

  function hideAllTweets() {
    const tweets = document.querySelectorAll('article[data-testid="tweet"]');
    tweets.forEach((tweet) => {
      if (!tweet.classList.contains('x-shield-approved') &&
          !tweet.classList.contains('x-shield-filtered')) {
        tweet.classList.add('x-shield-pending');
      }
    });
  }

  // ---------------------------------------------------------------
  // Tweet content extraction
  // ---------------------------------------------------------------
  function extractTweetContent(article) {
    // Primary tweet text
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const text = textEl ? textEl.textContent.trim() : '';

    // Author — pull from the user name element within the tweet
    let author = '';
    const userNameEl = article.querySelector(
      '[data-testid="User-Name"]'
    );
    if (userNameEl) {
      // The first link inside typically holds the display name
      const nameLink = userNameEl.querySelector('a');
      if (nameLink) {
        author = nameLink.textContent.trim();
      }
    }

    // Quote tweet text — nested tweet content inside the article
    let quoteTweetText = '';
    const quoteEl = article.querySelector(
      '[data-testid="quoteTweet"] [data-testid="tweetText"]'
    );
    if (quoteEl) {
      quoteTweetText = quoteEl.textContent.trim();
    }

    // Link preview / card text
    let linkPreviewText = '';
    const cardEl = article.querySelector('[data-testid="card.wrapper"]');
    if (cardEl) {
      linkPreviewText = cardEl.textContent.trim() || '';
    }

    // Compose full text for classification
    const parts = [text];
    if (author) parts.push('Author: ' + author);
    if (quoteTweetText) parts.push('Quote: ' + quoteTweetText);
    if (linkPreviewText) parts.push('Link: ' + linkPreviewText);
    const fullText = parts.join('\n');

    return { text: fullText };
  }

  // ---------------------------------------------------------------
  // Apply verdict to a tweet element
  // ---------------------------------------------------------------
  function applyVerdict(element, verdict) {
    element.classList.remove('x-shield-pending');

    if (verdict === 'allow') {
      element.classList.add('x-shield-approved');
      element.classList.remove('x-shield-filtered');
    } else {
      // Any non-"allow" verdict (including "block", undefined, null,
      // malformed) results in filtering — fail closed
      element.classList.add('x-shield-filtered');
      element.classList.remove('x-shield-approved');
    }
  }

  // ---------------------------------------------------------------
  // Batch queue management
  // ---------------------------------------------------------------
  function addToBatchQueue(item) {
    batchQueue.push(item);

    // Start timer on first item
    if (batchQueue.length === 1) {
      batchTimer = setTimeout(flushBatch, BATCH_TIMEOUT_MS);
    }

    // Flush immediately at batch size
    if (batchQueue.length >= BATCH_SIZE) {
      flushBatch();
    }
  }

  async function flushBatch() {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }

    if (batchQueue.length === 0) return;

    // Take current queue and reset
    const batch = batchQueue;
    batchQueue = [];

    // Store element references keyed by id before sending
    const batchElements = new Map();
    const payload = batch.map((item) => {
      batchElements.set(item.id, item.element);
      elementMap.set(item.id, item.element);
      return {
        id: item.id,
        text: item.text,
      };
    });

    // Send to background for classification
    const response = await sendMessage({
      type: 'CLASSIFY_BATCH',
      tweets: payload,
    });

    // If response is null or malformed, mark tweets as unclassified so they
    // become visible with a warning indicator instead of staying hidden forever.
    if (!response || !response.verdicts || !Array.isArray(response.verdicts)) {
      for (const [, el] of batchElements) {
        el.classList.remove('x-shield-pending');
        el.classList.add('x-shield-unclassified');
      }
      return;
    }

    // Apply verdicts
    response.verdicts.forEach((v) => {
      if (!v || typeof v.id === 'undefined' || typeof v.verdict === 'undefined') {
        // Malformed entry — skip, tweet stays hidden (fail closed)
        return;
      }

      const element = batchElements.get(v.id) || elementMap.get(v.id);
      if (!element) return;

      applyVerdict(element, v.verdict);

      // Cache the verdict by content hash if we have one
      if (v.hash) {
        verdictCache.set(v.hash, v.verdict);
      }

      // Clean up element references to prevent memory leak
      batchElements.delete(v.id);
      elementMap.delete(v.id);
    });

    // For any tweets in the batch that did NOT receive a verdict,
    // they stay hidden (fail closed) — clean up references anyway
    for (const id of batchElements.keys()) {
      elementMap.delete(id);
    }
  }

  // ---------------------------------------------------------------
  // Process a newly observed tweet article
  // ---------------------------------------------------------------
  function processTweet(article) {
    // Guard: skip if already processed
    if (article.classList.contains('x-shield-pending') ||
        article.classList.contains('x-shield-approved') ||
        article.classList.contains('x-shield-filtered') ||
        article.classList.contains('x-shield-unclassified')) {
      return;
    }

    // Step 1: extract content BEFORE hiding (innerText requires visibility)
    const { text } = extractTweetContent(article);
    const hash = contentHash(text);

    // Step 2: hide immediately (fail closed)
    article.classList.add('x-shield-pending');

    // Step 3: check local verdict cache
    if (verdictCache.has(hash)) {
      applyVerdict(article, verdictCache.get(hash));
      return;
    }

    // Step 4: generate unique id and queue for batch classification
    const tweetId = hash + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    addToBatchQueue({
      id: tweetId,
      text: text,
      element: article,
      hash: hash,
    });
  }

  // ---------------------------------------------------------------
  // Scan a DOM node (and its subtree) for tweet articles
  // ---------------------------------------------------------------
  function scanForTweets(root) {
    if (!root || !root.querySelectorAll) return;

    // Check if the root itself is a tweet
    if (root.matches && root.matches('article[data-testid="tweet"]')) {
      processTweet(root);
    }

    // Check children
    const articles = root.querySelectorAll('article[data-testid="tweet"]');
    articles.forEach(processTweet);
  }

  // ---------------------------------------------------------------
  // MutationObserver setup
  // ---------------------------------------------------------------
  function setupObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          scanForTweets(node);
        }
      }
    });

    observer.observe(document.body, {
      subtree: true,
      childList: true,
    });

    return observer;
  }

  // ---------------------------------------------------------------
  // Time tracking heartbeat
  // ---------------------------------------------------------------
  function startHeartbeat() {
    setInterval(async () => {
      if (document.visibilityState !== 'visible') return;

      const response = await sendMessage({ type: 'HEARTBEAT' });

      if (response && response.locked === true) {
        redirectToBlocked();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // ---------------------------------------------------------------
  // SPA navigation handling
  // ---------------------------------------------------------------
  function setupNavigationWatcher() {
    const onNavigate = () => {
      const currentUrl = location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        // Clear batch queue on navigation — observer stays active
        // as it watches document.body with subtree:true
        if (batchTimer) {
          clearTimeout(batchTimer);
          batchTimer = null;
        }
        batchQueue = [];

        // Strip x-shield classes from existing tweets so recycled DOM
        // elements get re-classified on the new page
        const tweets = document.querySelectorAll(
          'article[data-testid="tweet"].x-shield-pending,' +
          'article[data-testid="tweet"].x-shield-approved,' +
          'article[data-testid="tweet"].x-shield-filtered,' +
          'article[data-testid="tweet"].x-shield-unclassified'
        );
        tweets.forEach((tweet) => {
          tweet.classList.remove('x-shield-pending', 'x-shield-approved', 'x-shield-filtered', 'x-shield-unclassified');
        });

        // Re-scan to pick up all visible tweets on the new page
        scanForTweets(document.body);
      }
    };

    // Prefer modern Navigation API if available
    if (typeof navigation !== 'undefined' && navigation.addEventListener) {
      navigation.addEventListener('navigatesuccess', onNavigate);
    } else {
      // Fallback: poll for URL changes
      setInterval(onNavigate, SPA_POLL_INTERVAL_MS);
    }
  }

  // ---------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------
  async function init() {
    // 1. Check lockout status
    const lockoutResponse = await sendMessage({ type: 'CHECK_LOCKOUT' });
    if (lockoutResponse && lockoutResponse.locked === true) {
      redirectToBlocked();
      return;
    }

    // 2. Check API key
    const apiKeyResponse = await sendMessage({ type: 'CHECK_API_KEY' });
    if (!apiKeyResponse || !apiKeyResponse.hasKey) {
      const mode = (apiKeyResponse && apiKeyResponse.mode) || 'local';
      showApiKeyOverlay(mode);

      // Poll for server availability — retry every 5 seconds
      const serverRetryInterval = setInterval(async () => {
        const resp = await sendMessage({ type: 'CHECK_API_KEY' });
        if (resp && resp.hasKey) {
          clearInterval(serverRetryInterval);
          removeApiKeyOverlay();
          setupNavigationWatcher();
          setupObserver();
          scanForTweets(document.body);
        }
      }, 5000);

      // Don't proceed with observer setup — fail closed
      // Still start heartbeat so lockout can kick in
      startHeartbeat();
      return;
    }

    // 3. Start time tracking heartbeat
    startHeartbeat();

    // 4. Set up SPA navigation handling
    setupNavigationWatcher();

    // 5. Set up MutationObserver
    setupObserver();

    // 6. Process any tweets already in the DOM
    scanForTweets(document.body);
  }

  // Kick off
  init();
})();
