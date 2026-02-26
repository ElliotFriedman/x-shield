'use strict';

(function() {
  const MAX_TABLE_ROWS = 500;
  const tbody = document.getElementById('table-body');
  const statsContainer = document.getElementById('stats-container');
  const filterIndicator = document.getElementById('filter-indicator');
  const filterName = document.getElementById('filter-name');
  let emptyRow = document.getElementById('empty-row');
  let activeFilter = null;
  let latestTimestamp = 0;

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function isSafeUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch (e) {
      return false;
    }
  }

  function formatTime(ts) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return month + '/' + day + ' ' + time;
  }

  // Map internal verdict names to display labels
  const verdictLabels = { nourish: 'nourish', allow: 'show', block: 'filter', distill: 'distill' };

  function updateStats(stats) {
    document.getElementById('stat-total').textContent = stats.total || 0;
    document.getElementById('stat-nourish').textContent = stats.nourish || 0;
    document.getElementById('stat-allow').textContent = stats.allow || 0;
    document.getElementById('stat-block').textContent = stats.block || 0;
    document.getElementById('stat-distill').textContent = stats.distill || 0;
  }

  function createRow(entry, animate) {
    const tr = document.createElement('tr');
    if (animate) tr.className = 'new-row';
    const verdict = (entry.verdict || 'block').toLowerCase();
    tr.setAttribute('data-verdict', verdict);

    const text = entry.tweetText || '';
    const reason = entry.reason || '';
    const distilled = entry.distilled || '';
    const time = formatTime(entry.timestamp);
    const truncated = text.length > 200;
    const displayText = truncated ? text.substring(0, 200) : text;
    const displayLabel = verdictLabels[verdict] || verdict;
    const url = entry.tweetUrl || '';
    const safeUrl = isSafeUrl(url) ? url : '';

    tr.innerHTML =
      '<td class="time">' + escapeHtml(time) + '</td>' +
      '<td class="link-cell">' + (safeUrl ? '<a href="' + escapeHtml(safeUrl) + '" target="_blank" rel="noopener" style="color:#4a9eff;text-decoration:none" title="Open tweet">&#x2197;</a>' : '') + '</td>' +
      '<td class="verdict-cell"><span class="badge ' + escapeHtml(verdict) + '">' + escapeHtml(displayLabel) + '</span></td>' +
      '<td class="tweet-text"><div class="tweet-content' + (truncated ? ' truncated' : '') + '">' + escapeHtml(displayText) + '</div></td>' +
      '<td class="reason">' + escapeHtml(reason) + '</td>' +
      '<td class="distilled-cell">' + escapeHtml(distilled) + '</td>';

    if (truncated) {
      const div = tr.querySelector('.tweet-content');
      let expanded = false;
      div.addEventListener('click', function() {
        expanded = !expanded;
        this.textContent = expanded ? text : displayText;
        this.className = 'tweet-content' + (expanded ? ' expanded' : ' truncated');
      });
    }
    return tr;
  }

  function trimTableRows() {
    while (tbody.children.length > MAX_TABLE_ROWS) {
      tbody.removeChild(tbody.lastChild);
    }
  }

  function loadHistory(verdict) {
    const msg = { type: 'GET_LOG_HISTORY', limit: 500 };
    if (verdict) msg.verdict = verdict;

    chrome.runtime.sendMessage(msg, function(response) {
      if (chrome.runtime.lastError || !response) {
        console.error('[X-Shield] loadHistory failed:', chrome.runtime.lastError);
        return;
      }

      updateStats(response.stats || {});

      // Clear table
      tbody.innerHTML = '';
      emptyRow = null;

      const entries = response.entries || [];
      if (entries.length === 0) {
        emptyRow = document.createElement('tr');
        emptyRow.className = 'empty-state';
        emptyRow.id = 'empty-row';
        emptyRow.innerHTML = '<td colspan="6"><div class="icon">&#x229B;</div><p>No classifications logged yet.</p></td>';
        tbody.appendChild(emptyRow);
        latestTimestamp = 0;
        return;
      }

      const frag = document.createDocumentFragment();
      for (let i = 0; i < entries.length; i++) {
        frag.appendChild(createRow(entries[i], false));
      }
      tbody.appendChild(frag);

      // Track newest timestamp for polling
      latestTimestamp = entries[0].timestamp || 0;
    });
  }

  // Polling for new entries
  function pollForUpdates() {
    const msg = { type: 'GET_LOG_HISTORY', limit: 50 };
    if (activeFilter) msg.verdict = activeFilter;

    chrome.runtime.sendMessage(msg, function(response) {
      if (chrome.runtime.lastError || !response) {
        console.error('[X-Shield] pollForUpdates failed:', chrome.runtime.lastError);
        return;
      }

      updateStats(response.stats || {});

      const entries = response.entries || [];
      if (entries.length === 0) return;

      const newestTs = entries[0].timestamp || 0;
      if (newestTs <= latestTimestamp) return;

      // Collect new entries
      const newEntries = [];
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].timestamp > latestTimestamp) {
          newEntries.push(entries[i]);
        } else {
          break;
        }
      }

      if (newEntries.length > 0) {
        if (emptyRow && emptyRow.parentNode) {
          emptyRow.parentNode.removeChild(emptyRow);
          emptyRow = null;
        }
        // Insert newest first at top of table
        for (let j = newEntries.length - 1; j >= 0; j--) {
          const row = createRow(newEntries[j], true);
          if (tbody.firstChild) {
            tbody.insertBefore(row, tbody.firstChild);
          } else {
            tbody.appendChild(row);
          }
        }
        latestTimestamp = newestTs;
        trimTableRows();
      }
    });
  }

  // Verdict filtering via stat cards
  function setFilter(verdict) {
    if (activeFilter === verdict) verdict = null;
    activeFilter = verdict;

    const cards = document.querySelectorAll('.stat-card');
    if (verdict) {
      statsContainer.classList.add('filtered');
      for (let i = 0; i < cards.length; i++) {
        cards[i].classList.toggle('active', cards[i].classList.contains(verdict));
      }
      filterIndicator.classList.add('visible');
      filterName.textContent = verdictLabels[verdict] || verdict;
    } else {
      statsContainer.classList.remove('filtered');
      for (let i = 0; i < cards.length; i++) {
        cards[i].classList.remove('active');
      }
      filterIndicator.classList.remove('visible');
    }

    // Reload with filter applied server-side
    loadHistory(verdict);
  }

  document.querySelectorAll('.stat-card').forEach(function(card) {
    card.addEventListener('click', function() {
      const classes = this.className.split(' ');
      let verdict = null;
      const verdicts = ['nourish', 'allow', 'block', 'distill'];
      for (let i = 0; i < classes.length; i++) {
        if (verdicts.indexOf(classes[i]) !== -1) { verdict = classes[i]; break; }
      }
      if (this.classList.contains('total')) {
        setFilter(null);
      } else if (verdict) {
        setFilter(verdict);
      }
    });
  });

  document.getElementById('btn-clear-filter').addEventListener('click', function() {
    setFilter(null);
  });

  // Clear log
  document.getElementById('btn-clear').addEventListener('click', function() {
    if (!confirm('Clear all logged classifications? This cannot be undone.')) return;
    chrome.runtime.sendMessage({ type: 'CLEAR_LOG' }, function() {
      if (chrome.runtime.lastError) return;
      tbody.innerHTML = '';
      emptyRow = document.createElement('tr');
      emptyRow.className = 'empty-state';
      emptyRow.id = 'empty-row';
      emptyRow.innerHTML = '<td colspan="6"><div class="icon">&#x229B;</div><p>Log cleared.</p></td>';
      tbody.appendChild(emptyRow);
      latestTimestamp = 0;
      updateStats({ total: 0, nourish: 0, allow: 0, block: 0, distill: 0 });
    });
  });

  // Initial load
  loadHistory(null);

  // Poll every 10 seconds
  setInterval(pollForUpdates, 10000);
})();
