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

  const VERDICT_PRIORITY = { nourish: 0, allow: 1, distill: 2, block: 3, pending: 4 };
  const TWEET_SELECTOR = 'article[data-testid="tweet"]';
  const CELL_SELECTOR = '[data-testid="cellInnerDiv"]';
  const X_SHIELD_CLASSES = ['x-shield-pending', 'x-shield-approved', 'x-shield-filtered', 'x-shield-distilled', 'x-shield-nourished', 'x-shield-unclassified'];

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  const verdictCache = new Map();       // contentHash -> verdict string
  const elementMap = new Map();         // tweetId -> DOM element
  let batchQueue = [];                  // { id, text, element }
  let batchTimer = null;
  let lastUrl = location.href;
  let observer = null;
  let observerPauseDepth = 0;

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
            console.warn('[X-Shield] sendMessage error:', chrome.runtime.lastError.message, 'for', msg.type);
            resolve(null);
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        console.warn('[X-Shield] sendMessage exception:', e.message, 'for', msg.type);
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
    // Hide standard tweet articles and notification tweet cells
    const elements = document.querySelectorAll(
      TWEET_SELECTOR + ', ' + CELL_SELECTOR
    );
    elements.forEach((el) => {
      if (!el.matches(TWEET_SELECTOR) && !el.querySelector('[data-testid="tweetText"]')) return;
      if (!X_SHIELD_CLASSES.some(cls => cls !== 'x-shield-pending' && cls !== 'x-shield-unclassified' && el.classList.contains(cls))) {
        el.classList.add('x-shield-pending');
      }
    });
  }

  // ---------------------------------------------------------------
  // Tweet content extraction
  // ---------------------------------------------------------------
  function extractTweetParts(article) {
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const text = textEl ? textEl.textContent.trim() : '';

    let author = '';
    const userNameEl = article.querySelector('[data-testid="User-Name"]');
    if (userNameEl) {
      const nameLink = userNameEl.querySelector('a');
      if (nameLink) author = nameLink.textContent.trim();
    }

    let quoteTweetText = '';
    const quoteEl = article.querySelector('[data-testid="quoteTweet"] [data-testid="tweetText"]');
    if (quoteEl) quoteTweetText = quoteEl.textContent.trim();

    let linkPreviewText = '';
    const cardEl = article.querySelector('[data-testid="card.wrapper"]');
    if (cardEl) linkPreviewText = cardEl.textContent.trim() || '';

    let url = '';
    const timeLink = article.querySelector('a[href*="/status/"] time');
    if (timeLink) {
      const anchor = timeLink.closest('a');
      if (anchor) url = 'https://x.com' + anchor.getAttribute('href');
    }

    return { text, author, quoteTweetText, linkPreviewText, url };
  }

  function formatForClassification(parts) {
    const segments = [parts.text];
    if (parts.author) segments.push('Author: ' + parts.author);
    if (parts.quoteTweetText) segments.push('Quote: ' + parts.quoteTweetText);
    if (parts.linkPreviewText) segments.push('Link: ' + parts.linkPreviewText);
    return segments.join('\n');
  }

  function extractTweetContent(article) {
    const parts = extractTweetParts(article);
    return { text: formatForClassification(parts), url: parts.url };
  }

  // ---------------------------------------------------------------
  // Apply verdict to a tweet element
  // ---------------------------------------------------------------
  function applyVerdict(element, verdict, distilled) {
    element.classList.remove('x-shield-pending');

    const VERDICT_TO_CLASS = {
      nourish: 'x-shield-nourished',
      distill: 'x-shield-distilled',
      allow: 'x-shield-approved',
    };

    // Remove all verdict classes first
    element.classList.remove('x-shield-filtered', 'x-shield-approved', 'x-shield-distilled', 'x-shield-nourished');

    const targetClass = VERDICT_TO_CLASS[verdict];
    if (targetClass) {
      element.classList.add(targetClass);
      if (verdict === 'distill' && distilled) {
        applyDistilledText(element, distilled);
      }
    } else {
      // Fail closed: any unrecognized verdict gets filtered
      element.classList.add('x-shield-filtered');
    }
  }

  // ---------------------------------------------------------------
  // Replace tweet text with distilled version
  // ---------------------------------------------------------------
  function applyDistilledText(article, distilledText) {
    const textEl = article.querySelector('[data-testid="tweetText"]');
    if (!textEl) return;

    // Replace text content, preserving the element
    textEl.textContent = distilledText;

    // Add a subtle label if not already present
    if (!article.querySelector('.x-shield-distilled-label')) {
      const label = document.createElement('span');
      label.className = 'x-shield-distilled-label';
      label.textContent = 'distilled by X-Shield';
      textEl.parentNode.insertBefore(label, textEl.nextSibling);
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

  function findElementByContentHash(hash) {
    if (!hash) return null;
    const pending = document.querySelectorAll(
      TWEET_SELECTOR + '.x-shield-pending, ' + CELL_SELECTOR + '.x-shield-pending'
    );
    for (const candidate of pending) {
      const { text: candidateText } = extractTweetContent(candidate);
      if (contentHash(candidateText) === hash) {
        return candidate;
      }
    }
    return null;
  }

  function resolveElement(id, batchElements, batchHashes, verdictHash) {
    let element = batchElements.get(id) || elementMap.get(id);
    if (!element || !element.isConnected) {
      const hash = batchHashes.get(id) || verdictHash;
      element = findElementByContentHash(hash);
    }
    return element;
  }

  function cleanDisconnectedElements() {
    for (const [id, element] of elementMap) {
      if (!element.isConnected) {
        elementMap.delete(id);
      }
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

    // Store element references and content hashes keyed by id before sending
    const batchElements = new Map();
    const batchHashes = new Map();
    const payload = batch.map((item) => {
      batchElements.set(item.id, item.element);
      batchHashes.set(item.id, item.hash);
      elementMap.set(item.id, item.element);
      return {
        id: item.id,
        text: item.text,
        url: item.url || '',
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
      for (const [id, el] of batchElements) {
        el.classList.remove('x-shield-pending');
        el.classList.add('x-shield-unclassified');
        elementMap.delete(id);
      }
      return;
    }

    // Thread context: on a thread page, don't filter the thread author's
    // tweets — upgrade "block" to "allow" so the thread remains readable
    const onThread = isOnThreadPage();
    const threadAuthor = onThread ? getThreadAuthor() : null;

    // Apply verdicts
    const batchVerdictInfo = new Map();

    response.verdicts.forEach((v) => {
      if (!v || typeof v.id === 'undefined' || typeof v.verdict === 'undefined') {
        // Malformed entry — skip, tweet stays hidden (fail closed)
        return;
      }

      let verdict = v.verdict;

      // Cache the verdict by content hash first — even if element is gone,
      // future instances of the same tweet will get the cached verdict
      if (v.hash) {
        verdictCache.set(v.hash, { verdict, distilled: v.distilled });
      }

      let element = resolveElement(v.id, batchElements, batchHashes, v.hash);

      if (!element || !element.isConnected) {
        // Element is truly gone — verdict is cached, will apply on re-detection
        batchElements.delete(v.id);
        elementMap.delete(v.id);
        return;
      }

      // Thread coherence: upgrade filtered tweets from the thread author
      // to "allow" so the thread doesn't have gaps
      if (onThread && verdict === 'block' && threadAuthor) {
        const tweetAuthor = getAuthorFromElement(element);
        if (tweetAuthor === threadAuthor) {
          verdict = 'allow';
        }
      }

      applyVerdict(element, verdict, v.distilled);

      // Track for reordering
      batchVerdictInfo.set(v.id, { element, verdict });

      // Clean up element references to prevent memory leak
      batchElements.delete(v.id);
      elementMap.delete(v.id);
    });

    // Reorder this batch by verdict priority
    reorderBatch(batchVerdictInfo, response.feedReorderingEnabled !== false);

    // For any tweets in the batch that did NOT receive a verdict,
    // they stay hidden (fail closed) — clean up references anyway
    for (const id of batchElements.keys()) {
      elementMap.delete(id);
    }
  }

  // ---------------------------------------------------------------
  // Thread detection — prevent filtering individual tweets from a
  // thread, which creates gaps and breaks readability
  // ---------------------------------------------------------------
  function isOnThreadPage() {
    return /^\/[^/]+\/status\/\d+/.test(location.pathname);
  }

  function getThreadAuthor() {
    // On a thread page like /user/status/123, the author is in the URL
    const match = location.pathname.match(/^\/([^/]+)\/status\/\d+/);
    return match ? match[1].toLowerCase() : null;
  }

  function getAuthorFromElement(element) {
    const userNameEl = element.querySelector('[data-testid="User-Name"]');
    if (!userNameEl) return null;
    // The handle link (second link) contains @username
    const links = userNameEl.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      if (href && /^\/[^/]+$/.test(href)) {
        return href.slice(1).toLowerCase();
      }
    }
    return null;
  }

  // ---------------------------------------------------------------
  // Feed reordering — sort tweets within each batch by verdict priority
  // ---------------------------------------------------------------

  function isOnFeedPage() {
    const path = location.pathname;
    return path === '/' || path === '/home';
  }

  function getCellWrapper(article) {
    // Walk up from the article to find the cellInnerDiv wrapper
    // X.com structure: div[data-testid="cellInnerDiv"] > ... > article
    return article.closest('[data-testid="cellInnerDiv"]');
  }

  function reorderBatch(batchElements, feedReorderingEnabled) {
    if (!feedReorderingEnabled || !isOnFeedPage()) return;

    // Collect cellInnerDiv wrappers with their verdict priorities
    const entries = [];
    for (const [id, info] of batchElements) {
      const cell = getCellWrapper(info.element);
      if (!cell) continue;

      // Only reorder cells that contain tweet articles (skip ads, "who to follow", etc.)
      if (!cell.querySelector(TWEET_SELECTOR)) continue;

      const priority = VERDICT_PRIORITY[info.verdict] ?? VERDICT_PRIORITY.pending;
      entries.push({ cell, priority, id });
    }

    if (entries.length < 2) return;

    // All cells must share the same parent for reordering to work
    const parent = entries[0].cell.parentElement;
    if (!parent) return;
    const allSameParent = entries.every(e => e.cell.parentElement === parent);
    if (!allSameParent) return;

    // Sort by priority (lower = higher priority = appears first)
    entries.sort((a, b) => a.priority - b.priority);

    // Snapshot children once to avoid repeated Array.from + indexOf
    const children = Array.from(parent.children);

    // Check if already in order — skip DOM manipulation if so
    const currentOrder = entries.map(e => children.indexOf(e.cell));
    const isSorted = currentOrder.every((val, i) => i === 0 || val >= currentOrder[i - 1]);
    if (isSorted) return;

    // Preserve scroll position
    const firstVisible = entries.find(e => {
      const rect = e.cell.getBoundingClientRect();
      return rect.top >= 0 && rect.top < window.innerHeight;
    });
    const firstVisibleTop = firstVisible ? firstVisible.cell.getBoundingClientRect().top : null;

    // Pause MutationObserver during reorder
    pauseObserver();

    // Reorder: insert each cell before the next sibling of the previous one
    // Find the earliest position among our entries
    let referenceNode = null;
    let earliestIndex = Infinity;
    for (const entry of entries) {
      const idx = children.indexOf(entry.cell);
      if (idx < earliestIndex) {
        earliestIndex = idx;
        referenceNode = parent.children[idx];
      }
    }

    // Insert all entries starting at the earliest position
    for (const entry of entries) {
      parent.insertBefore(entry.cell, referenceNode);
      referenceNode = entry.cell.nextSibling;
    }

    // Restore scroll position
    if (firstVisible && firstVisibleTop !== null) {
      const newTop = firstVisible.cell.getBoundingClientRect().top;
      const drift = newTop - firstVisibleTop;
      if (Math.abs(drift) > 1) {
        window.scrollBy(0, drift);
      }
    }

    resumeObserver();
  }

  // ---------------------------------------------------------------
  // Hide "For you" tab — only show the "Following" tab
  // ---------------------------------------------------------------
  function hideForYouTab() {
    const tabs = document.querySelectorAll('[role="tab"]');
    for (const tab of tabs) {
      if (tab.textContent.trim() === 'For you') {
        // Walk up to the direct child of the tablist and hide it
        let node = tab;
        while (node && node.parentElement) {
          if (node.parentElement.getAttribute('role') === 'tablist') {
            node.style.display = 'none';
            break;
          }
          node = node.parentElement;
        }
      }
    }
  }

  // ---------------------------------------------------------------
  // Process a newly observed tweet article
  // ---------------------------------------------------------------
  function processTweet(article) {
    // Guard: skip if already processed
    if (X_SHIELD_CLASSES.some(cls => article.classList.contains(cls))) {
      return;
    }

    // Step 1: extract content BEFORE hiding (innerText requires visibility)
    const { text, url } = extractTweetContent(article);
    const hash = contentHash(text);

    // Step 2: hide immediately (fail closed)
    article.classList.add('x-shield-pending');

    // Step 3: check local verdict cache
    if (verdictCache.has(hash)) {
      const cached = verdictCache.get(hash);
      applyVerdict(article, cached.verdict, cached.distilled);
      return;
    }

    // Step 4: generate unique id and queue for batch classification
    const tweetId = hash + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    addToBatchQueue({
      id: tweetId,
      text: text,
      url: url,
      element: article,
      hash: hash,
    });
  }

  // ---------------------------------------------------------------
  // Notification tweet detection — on /notifications, X renders
  // tweet content inside plain divs (cellInnerDiv) instead of
  // article[data-testid="tweet"]. Detect these by checking for
  // tweetText inside a cellInnerDiv that has no article wrapper.
  // ---------------------------------------------------------------
  function isNotificationTweet(cell) {
    return cell.querySelector('[data-testid="tweetText"]') &&
           !cell.querySelector(TWEET_SELECTOR);
  }

  // ---------------------------------------------------------------
  // Scan a DOM node (and its subtree) for tweet articles and
  // notification tweet cells
  // ---------------------------------------------------------------
  function scanForTweets(root) {
    if (!root || !root.querySelectorAll) return;

    // Standard tweet articles (feed, thread, search pages)
    if (root.matches && root.matches(TWEET_SELECTOR)) {
      processTweet(root);
    }
    const articles = root.querySelectorAll(TWEET_SELECTOR);
    articles.forEach(processTweet);

    // Notification tweet cells (no article wrapper)
    if (root.matches && root.matches(CELL_SELECTOR) && isNotificationTweet(root)) {
      processTweet(root);
    }
    const cells = root.querySelectorAll(CELL_SELECTOR);
    for (const cell of cells) {
      if (isNotificationTweet(cell)) processTweet(cell);
    }
  }

  // ---------------------------------------------------------------
  // MutationObserver setup
  // ---------------------------------------------------------------
  function setupObserver() {
    observer = new MutationObserver((mutations) => {
      if (observerPauseDepth > 0) return;
      let checkTabs = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          scanForTweets(node);
          if (!checkTabs && (node.querySelector?.('[role="tablist"]') || node.getAttribute?.('role') === 'tablist')) {
            checkTabs = true;
          }
        }
      }
      if (checkTabs) hideForYouTab();
    });

    observer.observe(document.body, {
      subtree: true,
      childList: true,
    });

    return observer;
  }

  function pauseObserver() {
    observerPauseDepth++;
  }

  function resumeObserver() {
    queueMicrotask(() => {
      if (observerPauseDepth > 0) observerPauseDepth--;
    });
  }

  // ---------------------------------------------------------------
  // Time tracking heartbeat
  // ---------------------------------------------------------------
  function startHeartbeat() {
    setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      cleanDisconnectedElements();

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
        // Hide "For you" tab on every navigation
        hideForYouTab();
        // Clear batch queue on navigation — observer stays active
        // as it watches document.body with subtree:true
        if (batchTimer) {
          clearTimeout(batchTimer);
          batchTimer = null;
        }
        batchQueue = [];

        // Strip x-shield classes from existing tweets and notification
        // cells so recycled DOM elements get re-classified on the new page
        const shieldedSelector = X_SHIELD_CLASSES.map(cls =>
          TWEET_SELECTOR + '.' + cls + ', ' + CELL_SELECTOR + '.' + cls
        ).join(', ');
        const shielded = document.querySelectorAll(shieldedSelector);
        shielded.forEach((el) => {
          el.classList.remove(...X_SHIELD_CLASSES);
          const label = el.querySelector('.x-shield-distilled-label');
          if (label) label.remove();
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
  // Notification suppression — strip (N) from tab title and lock
  // the favicon to prevent badged icons from triggering compulsive
  // checking.
  // ---------------------------------------------------------------
  function setupNotificationSuppression() {
    // --- Title: strip "(N) " prefix ---
    function cleanTitle() {
      const cleaned = document.title.replace(/^\(\d+\+?\)\s*/, '');
      if (cleaned !== document.title) {
        document.title = cleaned;
      }
    }

    cleanTitle();

    const titleEl = document.querySelector('title');
    if (titleEl) {
      new MutationObserver(cleanTitle).observe(titleEl, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    // --- Favicon: lock to the plain X icon ---
    // Capture the initial clean favicon, then prevent X from swapping
    // in a badged version by reverting any changes.
    const existingIcon = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
    const cleanHref = existingIcon ? existingIcon.href : null;

    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeName === 'LINK' && /icon/i.test(node.rel || '')) {
            if (cleanHref && node.href !== cleanHref) {
              node.href = cleanHref;
            }
          }
        }
      }
    }).observe(document.head, { childList: true });

    // Also catch attribute mutations on existing icon links
    if (existingIcon) {
      new MutationObserver(() => {
        if (cleanHref && existingIcon.href !== cleanHref) {
          existingIcon.href = cleanHref;
        }
      }).observe(existingIcon, { attributes: true, attributeFilter: ['href'] });
    }
  }

  // ---------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------
  async function init() {
    // 0. Suppress notification counts in tab title and favicon
    setupNotificationSuppression();

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

    // 3. Hide "For you" tab
    hideForYouTab();

    // 4. Start time tracking heartbeat
    startHeartbeat();

    // 5. Set up SPA navigation handling
    setupNavigationWatcher();

    // 6. Set up MutationObserver
    setupObserver();

    // 7. Process any tweets already in the DOM
    scanForTweets(document.body);
  }

  // Kick off
  init();
})();
