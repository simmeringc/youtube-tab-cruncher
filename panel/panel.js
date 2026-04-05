const $ = (id) => document.getElementById(id);

let playlists = [];
let port = null;
let countdownInterval = null;
let lastResultsLength = 0;

const screens = {
  auth: $('auth-screen'),
  setup: $('setup-screen'),
  active: $('active-screen'),
  complete: $('complete-screen'),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, resolve);
  });
}

function connectPort() {
  port = chrome.runtime.connect({ name: 'panel' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'STATE_UPDATE') renderState(msg.state);
  });
}

// ── Toast ────────────────────────────────────────

function showToast(text, type = 'success') {
  const container = $('toast-container');
  // Limit to 3 visible toasts
  while (container.children.length >= 3) {
    container.firstChild.remove();
  }
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = text;
  container.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

function showError(errorMsg, action) {
  const errEl = $('auth-error');
  const isQuota = errorMsg.toLowerCase().includes('quota') ||
                  errorMsg.includes('403') ||
                  errorMsg.toLowerCase().includes('limit exceeded');

  const actionLabel = action ? `<div class="error-action">Failed while: ${action}</div>` : '';

  if (isQuota) {
    errEl.innerHTML = `
      ${actionLabel}
      <strong>Quota exceeded.</strong> Resets in <strong class="quota-timer"></strong>.
      <div class="quota-details">
        <p>The YouTube Data API allows 10,000 units per day. Each video added costs 50 units (~200 adds/day). Scanning playlists costs 1 unit per page.</p>
        <div class="quota-links">
          <a href="https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas" target="_blank" rel="noopener">Check your quota usage</a>
          <a href="https://developers.google.com/youtube/v3/getting-started#quota" target="_blank" rel="noopener">YouTube API quota docs</a>
        </div>
      </div>`;
    startQuotaCountdown(errEl);
  } else {
    errEl.innerHTML = `${actionLabel}<strong>Error:</strong> ${esc(errorMsg)}`;
  }
  errEl.classList.remove('hidden');
  showScreen('auth');
}

function checkForNewResults(state) {
  if (!state.results || state.results.length <= lastResultsLength) return;

  const newResults = state.results.slice(lastResultsLength);
  for (const r of newResults) {
    if (r.status === 'added') {
      const name = playlists.find(p => p.id === r.playlistId)?.title || 'playlist';
      showToast(`Added to ${name}`);
    } else if (r.status === 'removed') {
      showToast(r.reason || 'Removed from playlists', 'warning');
    } else if (r.status === 'skipped' && r.reason) {
      showToast(`Skipped: ${r.reason}`, 'info');
    } else if (r.status === 'error') {
      showToast(`Error: ${r.error || 'failed'}`, 'error');
    }
  }
  lastResultsLength = state.results.length;
}

// ── Rendering ────────────────────────────────────

function renderState(state) {
  clearCountdown();

  if (!state || state.status === 'idle') {
    lastResultsLength = 0;
    showScreen('setup');
    return;
  }

  if (state.status === 'complete') {
    showScreen('complete');
    renderResults(state.results);
    checkForNewResults(state);

    // Show quota error if processing was stopped by it
    const quotaEl = $('quota-error');
    clearQuotaCountdown();
    if (state.quotaError) {
      quotaEl.innerHTML = `
        <span class="banner-label">Quota exceeded</span>
        <p>YouTube API daily quota reached. Resets in <strong class="quota-timer"></strong>.</p>
        <div class="quota-details">
          <p>The YouTube Data API allows 10,000 units per day. Each video added to a playlist costs 50 units, so you can add about 200 videos per day. Listing and scanning playlists costs 1 unit per page.</p>
          <p>You can request a quota increase from Google if you need more.</p>
          <div class="quota-links">
            <a href="https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas" target="_blank" rel="noopener">Check your quota usage</a>
            <a href="https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas?service=youtube.googleapis.com" target="_blank" rel="noopener">Request quota increase</a>
            <a href="https://developers.google.com/youtube/v3/getting-started#quota" target="_blank" rel="noopener">YouTube API quota docs</a>
          </div>
        </div>`;
      quotaEl.classList.remove('hidden');
      startQuotaCountdown(quotaEl);
    } else {
      quotaEl.classList.add('hidden');
    }
    return;
  }

  showScreen('active');
  checkForNewResults(state);

  // Show default playlist link
  const plLink = $('default-playlist-link');
  if (state.defaultPlaylistId) {
    const plName = playlists.find(p => p.id === state.defaultPlaylistId)?.title || 'Playlist';
    const anchor = $('default-pl-anchor');
    anchor.href = `https://www.youtube.com/playlist?list=${state.defaultPlaylistId}`;
    anchor.textContent = plName;
    plLink.classList.remove('hidden');
  } else {
    plLink.classList.add('hidden');
  }

  const total = state.allTabs.length;
  const current = state.currentIndex;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;

  const labels = {
    loading: 'Loading playlists...',
    preview: 'Ready',
    starting: 'Switching...',
    reviewing: 'Reviewing...',
    paused: 'Paused',
    stopped: 'Stopped',
  };
  const hideCount = state.status === 'preview' || state.status === 'loading';
  $('progress-text').textContent = labels[state.status] || 'Processing...';
  $('progress-count').textContent = hideCount ? '' : `${current + 1} / ${total}`;
  $('progress-fill').style.width = hideCount ? '0%' : `${pct}%`;

  // Current tab
  const tab = state.currentTab;
  $('current-yt').classList.add('hidden');
  $('current-other').classList.add('hidden');
  $('existing-playlists').classList.add('hidden');

  if (tab && tab.isYouTube) {
    $('current-yt').classList.remove('hidden');
    $('video-thumb').src = `https://img.youtube.com/vi/${tab.videoId}/mqdefault.jpg`;
    $('video-title').textContent = cleanTitle(tab.title);
    $('video-id').textContent = tab.videoId;

    if (tab.existingPlaylists && tab.existingPlaylists.length > 0) {
      $('existing-playlists').classList.remove('hidden');
      $('existing-list').textContent = tab.existingPlaylists.join(', ');
    }
  } else if (tab) {
    $('current-other').classList.remove('hidden');
    $('other-title').textContent = tab.title;
    $('other-url').textContent = truncateUrl(tab.url);
  }

  // Controls
  $('controls-loading').classList.add('hidden');
  $('controls-preview').classList.add('hidden');
  $('controls-reviewing').classList.add('hidden');
  $('controls-paused').classList.add('hidden');
  $('controls-stopped').classList.add('hidden');

  if (state.status === 'loading') {
    $('controls-loading').classList.remove('hidden');
    renderLoadingProgress(state.loadingProgress);
  } else if (state.status === 'preview') {
    $('controls-preview').classList.remove('hidden');
    renderPreview(state);
  } else if (state.status === 'reviewing') {
    $('controls-reviewing').classList.remove('hidden');
    startCountdown(state.reviewUntil);
  } else if (state.status === 'paused') {
    $('controls-paused').classList.remove('hidden');
  } else if (state.status === 'stopped') {
    $('controls-stopped').classList.remove('hidden');
  }

  renderHistory(state.results);
}

function renderLoadingProgress(progress) {
  if (!progress) {
    $('loading-detail').textContent = 'Loading playlists...';
    return;
  }
  if (progress.total > 0) {
    const suffix = progress.reusedFromCache ? ' (cached)' : '';
    $('loading-detail').textContent = `Scanning playlist ${progress.current} of ${progress.total}${suffix}`;
  }
}

function renderPreview(state) {
  const c = state.previewCounts;
  if (!c) return;

  let html = `<strong>${c.youtube}</strong> YouTube video${c.youtube !== 1 ? 's' : ''}`;
  if (c.other > 0) html += `, <strong>${c.other}</strong> other tab${c.other !== 1 ? 's' : ''}`;
  $('preview-counts').innerHTML = html;

  // Cache info
  const cacheEl = $('cache-info');
  if (c.reused > 0) {
    cacheEl.innerHTML = `${c.reused} playlist${c.reused !== 1 ? 's' : ''} cached, ${c.fetched} refreshed. <a id="refresh-cache">Force full refresh</a>`;
    cacheEl.classList.remove('hidden');
  } else {
    cacheEl.classList.add('hidden');
  }
}

// Refresh cache handler (delegated since element is dynamic)
document.addEventListener('click', (e) => {
  if (e.target.id === 'refresh-cache') {
    e.preventDefault();
    (async () => {
      const playlistId = $('default-playlist').value;
      if (!playlistId) return;
      const win = await chrome.windows.getCurrent();
      await send({
        type: 'START',
        defaultPlaylistId: playlistId,
        windowId: win.id,
        reviewDelayMs: countdownSeconds * 1000,
        forceRefresh: true,
      });
    })();
  }
});

// ── Countdown ────────────────────────────────────

function startCountdown(reviewUntil) {
  updateCountdownText(reviewUntil);
  countdownInterval = setInterval(() => updateCountdownText(reviewUntil), 200);
}

function updateCountdownText(reviewUntil) {
  const s = Math.max(0, Math.ceil((reviewUntil - Date.now()) / 1000));
  $('countdown').textContent = s > 0 ? `Adding in ${s}s...` : 'Adding...';
}

function clearCountdown() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
}

// ── Quota Reset Countdown ────────────────────────

let quotaInterval = null;

function getQuotaResetTime() {
  // YouTube API quota resets at midnight Pacific time
  const now = new Date();
  // Get current time in Pacific
  const pacific = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  // Next midnight Pacific
  const resetPacific = new Date(pacific);
  resetPacific.setDate(resetPacific.getDate() + 1);
  resetPacific.setHours(0, 0, 0, 0);
  // Convert back to local ms difference
  const diffMs = resetPacific.getTime() - pacific.getTime();
  return Date.now() + diffMs;
}

function formatCountdownHMS(ms) {
  if (ms <= 0) return 'any moment now';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (h === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

function startQuotaCountdown(el) {
  clearQuotaCountdown();
  const resetAt = getQuotaResetTime();
  function update() {
    const remaining = resetAt - Date.now();
    el.querySelector('.quota-timer').textContent = formatCountdownHMS(remaining);
    if (remaining <= 0) clearQuotaCountdown();
  }
  update();
  quotaInterval = setInterval(update, 1000);
}

function clearQuotaCountdown() {
  if (quotaInterval) { clearInterval(quotaInterval); quotaInterval = null; }
}

// ── Helpers ──────────────────────────────────────

function truncateUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    return u.hostname + (path.length > 40 ? path.slice(0, 40) + '...' : path);
  } catch { return url; }
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function cleanTitle(title) {
  return (title || 'Unknown').replace(/ - YouTube$/, '');
}

function populatePlaylistDropdown(el, list) {
  el.innerHTML = '';
  for (const pl of list) {
    const opt = document.createElement('option');
    opt.value = pl.id;
    opt.textContent = pl.title;
    el.appendChild(opt);
  }
}

function buildItemRow(r, index, context) {
  const row = document.createElement('div');
  row.className = 'item-row';

  const url = r.videoId ? `https://www.youtube.com/watch?v=${r.videoId}` : '';

  const thumbHtml = r.videoId
    ? `<a href="${url}" target="_blank" rel="noopener"><img class="item-thumb" src="https://img.youtube.com/vi/${r.videoId}/default.jpg" alt=""></a>`
    : '';

  const title = cleanTitle(r.title);
  const titleHtml = r.videoId
    ? `<a href="${url}" target="_blank" rel="noopener" class="item-title" title="${esc(title)}">${esc(title)}</a>`
    : `<span class="item-title" title="${esc(title)}">${esc(title)}</span>`;

  const btnHtml = r.videoId
    ? `<button class="btn-icon" data-video-id="${r.videoId}" data-index="${index}" data-context="${context}" title="Add to selected playlist">+</button>`
    : '';

  const badgeTitle = r.reason ? ` title="${esc(r.reason)}"` : '';
  row.innerHTML = `
    ${thumbHtml}
    ${titleHtml}
    <span class="badge badge-${r.status}"${badgeTitle}>${r.status}</span>
    ${btnHtml}
  `;
  return row;
}

// ── History (live during processing) ─────────────

function renderHistory(results) {
  const section = $('history-section');
  if (!results || results.length === 0) { section.classList.add('hidden'); return; }

  section.classList.remove('hidden');
  $('history-count').textContent = results.length;

  const list = $('history-list');
  list.innerHTML = '';
  for (let i = results.length - 1; i >= 0; i--) {
    list.appendChild(buildItemRow(results[i], i, 'history'));
  }
}

// ── Results (complete screen) ────────────────────

function renderResults(results) {
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;

  const labels = { added: 'added', duplicate: 'duplicates', skipped: 'skipped', removed: 'removed', closed: 'closed', error: 'errors' };
  const parts = Object.entries(labels)
    .filter(([k]) => counts[k])
    .map(([k, v]) => `${counts[k]} ${v}`);
  $('results-summary').textContent = parts.join(', ') || 'No tabs processed';

  const list = $('results-list');
  list.innerHTML = '';
  for (let i = 0; i < results.length; i++) {
    list.appendChild(buildItemRow(results[i], i, 'complete'));
  }
}

// ── Playlists ────────────────────────────────────

async function loadPlaylists() {
  const res = await send({ type: 'GET_PLAYLISTS' });
  if (res.error) {
    showError(res.error, 'loading your playlists');
    return false;
  }
  playlists = res.playlists;
  for (const id of ['default-playlist', 'override-playlist', 'history-playlist', 'complete-playlist']) {
    populatePlaylistDropdown($(id), playlists);
  }

  // Restore last-used playlist
  const { lastPlaylistId } = await chrome.storage.local.get('lastPlaylistId');
  if (lastPlaylistId && playlists.some(p => p.id === lastPlaylistId)) {
    $('default-playlist').value = lastPlaylistId;
  }

  return true;
}

// ── Reassign ─────────────────────────────────────

async function handleReassign(btn) {
  const videoId = btn.dataset.videoId;
  const selectId = btn.dataset.context === 'complete' ? 'complete-playlist' : 'history-playlist';
  const playlistId = $(selectId).value;
  if (!videoId || !playlistId) return;

  btn.textContent = '...';
  btn.disabled = true;

  const res = await send({ type: 'HISTORY_ADD', videoId, playlistId });

  if (res.error) {
    btn.textContent = '!';
    btn.classList.add('fail');
    showToast(`Failed: ${res.error}`, 'error');
  } else {
    btn.textContent = res.duplicate ? 'dup' : 'ok';
    btn.classList.add('success');
  }

  setTimeout(() => {
    btn.textContent = '+';
    btn.disabled = false;
    btn.classList.remove('success', 'fail');
  }, 1500);
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-icon');
  if (btn) handleReassign(btn);
});

// ── Quota Monitor ────────────────────────────────

let quotaRefreshInterval = null;

async function refreshQuota() {
  const stats = await send({ type: 'GET_QUOTA' });
  if (!stats) return;

  const pct = Math.min(100, Math.round((stats.used / stats.limit) * 100));
  const remaining = stats.remaining;
  const addsLeft = Math.floor(remaining / 50);

  $('quota-bar-fill').style.width = `${pct}%`;
  $('quota-bar-fill').className = 'quota-bar-fill' +
    (pct >= 90 ? ' danger' : pct >= 70 ? ' warning' : '');

  $('quota-text').textContent = `${remaining.toLocaleString()} / ${stats.limit.toLocaleString()} units remaining (~${addsLeft} adds left)`;
}

function startQuotaRefresh() {
  refreshQuota();
  if (!quotaRefreshInterval) {
    quotaRefreshInterval = setInterval(refreshQuota, 5000);
  }
}

// ── Settings ─────────────────────────────────────

let countdownSeconds = 3;

async function loadSettings() {
  const settings = await chrome.storage.local.get(['reviewSeconds']);
  countdownSeconds = settings.reviewSeconds || 3;
  $('countdown-value').textContent = countdownSeconds;
}

function saveCountdownSetting() {
  chrome.storage.local.set({ reviewSeconds: countdownSeconds });
  $('countdown-value').textContent = countdownSeconds;
}

$('countdown-down').addEventListener('click', () => {
  countdownSeconds = Math.max(1, countdownSeconds - 1);
  saveCountdownSetting();
});

$('countdown-up').addEventListener('click', () => {
  countdownSeconds = Math.min(15, countdownSeconds + 1);
  saveCountdownSetting();
});

// ── Cache Stats ─────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function timeAgo(timestamp) {
  const mins = Math.round((Date.now() - timestamp) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

async function loadCacheStats() {
  const stats = await send({ type: 'GET_CACHE_STATS' });
  const el = $('cache-stats');
  if (!stats?.exists) {
    el.textContent = 'No cache';
    return;
  }
  el.textContent = `${stats.playlistCount} playlists, ${stats.videoCount} videos (${formatBytes(stats.sizeBytes)}) \u00b7 Updated ${timeAgo(stats.timestamp)}`;
}

// ── Init ─────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  connectPort();
  await loadSettings();

  const state = await send({ type: 'GET_STATE' });
  loadCacheStats();
  startQuotaRefresh();

  if (state && state.status !== 'idle') {
    // Sync toast counter so reopening doesn't re-fire old toasts
    lastResultsLength = state.results?.length || 0;
    loadPlaylists();
    renderState(state);
  } else {
    const ok = await loadPlaylists();
    showScreen(ok ? 'setup' : 'auth');
  }
});

// ── Actions ──────────────────────────────────────

$('auth-btn').addEventListener('click', async () => {
  $('auth-btn').textContent = 'Signing in...';
  $('auth-error').classList.add('hidden');
  try {
    const res = await send({ type: 'AUTH' });
    if (res?.error) {
      showError(res.error, 'signing in');
      $('auth-btn').textContent = 'Sign in with Google';
      return;
    }
    const ok = await loadPlaylists();
    if (ok) showScreen('setup');
  } catch (err) {
    showError(err.message || 'Sign in failed', 'signing in');
  }
  $('auth-btn').textContent = 'Sign in with Google';
});

$('start-btn').addEventListener('click', async () => {
  const playlistId = $('default-playlist').value;
  if (!playlistId) return;

  // Remember last playlist
  chrome.storage.local.set({ lastPlaylistId: playlistId });

  const win = await chrome.windows.getCurrent();
  $('start-btn').textContent = 'Scanning...';
  const res = await send({
    type: 'START',
    defaultPlaylistId: playlistId,
    windowId: win.id,
    reviewDelayMs: countdownSeconds * 1000,
  });
  $('start-btn').textContent = 'Scan Tabs';
  if (res?.error) {
    showError(res.error, 'scanning tabs');
  }
});

$('go-btn').addEventListener('click', () => send({ type: 'CONFIRM_START' }));
$('cancel-btn').addEventListener('click', async () => {
  await send({ type: 'RESET' });
  lastResultsLength = 0;
  showScreen('setup');
});

$('live-countdown-down').addEventListener('click', () => {
  countdownSeconds = Math.max(1, countdownSeconds - 1);
  saveCountdownSetting();
  send({ type: 'ADJUST_TIMER', reviewDelayMs: countdownSeconds * 1000 });
});

$('live-countdown-up').addEventListener('click', () => {
  countdownSeconds = Math.min(15, countdownSeconds + 1);
  saveCountdownSetting();
  send({ type: 'ADJUST_TIMER', reviewDelayMs: countdownSeconds * 1000 });
});

$('pause-btn').addEventListener('click', () => send({ type: 'PAUSE' }));
$('continue-btn').addEventListener('click', () => send({ type: 'CONTINUE' }));
$('skip-reviewing-btn').addEventListener('click', () => send({ type: 'SKIP_REVIEWING' }));
$('remove-reviewing-btn').addEventListener('click', () => send({ type: 'REMOVE_AND_SKIP' }));
$('add-default-btn').addEventListener('click', () => send({ type: 'ADD_TO_DEFAULT' }));
$('skip-btn').addEventListener('click', () => send({ type: 'SKIP' }));
$('remove-paused-btn').addEventListener('click', () => send({ type: 'REMOVE_AND_SKIP' }));
$('resume-scan-btn').addEventListener('click', () => send({ type: 'RESUME_SCAN' }));
$('finish-btn').addEventListener('click', () => send({ type: 'FINISH' }));

$('override-btn').addEventListener('click', () => {
  const playlistId = $('override-playlist').value;
  if (playlistId) send({ type: 'ADD_TO_PLAYLIST', playlistId });
});

$('clear-cache-btn').addEventListener('click', async () => {
  await send({ type: 'CLEAR_CACHE' });
  loadCacheStats();
});

$('reset-btn').addEventListener('click', async () => {
  await send({ type: 'RESET' });
  lastResultsLength = 0;
  const ok = await loadPlaylists();
  showScreen(ok ? 'setup' : 'auth');
  loadCacheStats();
});
