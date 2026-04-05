// ── Quota Tracking ──────────────────────────────
// YouTube API costs: list=1, insert=50, delete=50 per call
const DAILY_QUOTA = 10000;

function getPacificDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

async function getQuotaUsage() {
  const { quotaUsage } = await chrome.storage.local.get('quotaUsage');
  const today = getPacificDateString();
  if (quotaUsage && quotaUsage.date === today) {
    return quotaUsage;
  }
  return { units: 0, date: today };
}

async function trackQuota(units) {
  const usage = await getQuotaUsage();
  usage.units += units;
  await chrome.storage.local.set({ quotaUsage: usage });
}

export async function getQuotaStats() {
  const usage = await getQuotaUsage();
  return {
    used: usage.units,
    limit: DAILY_QUOTA,
    remaining: Math.max(0, DAILY_QUOTA - usage.units),
    date: usage.date,
  };
}

// ── Auth ─────────────────────────────────────────

let cachedToken = null;

export async function getAuthToken(interactive = true) {
  if (cachedToken) return cachedToken;
  const token = await chrome.identity.getAuthToken({ interactive });
  cachedToken = token.token;
  return cachedToken;
}

async function fetchWithAuth(url, options = {}) {
  let token = await getAuthToken();
  let response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
  });

  if (response.status === 401) {
    await chrome.identity.removeCachedAuthToken({ token });
    cachedToken = null;
    token = await getAuthToken();
    response = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
    });
  }

  return response;
}

export async function fetchPlaylists() {
  const playlists = [];
  let pageToken = '';

  do {
    const url = `https://www.googleapis.com/youtube/v3/playlists?part=snippet,contentDetails&mine=true&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetchWithAuth(url);
    await trackQuota(1); // playlists.list = 1 unit
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      checkForQuotaError(res, err);
      const msg = err.error?.message || `HTTP ${res.status}`;
      throw new Error(`Failed to fetch playlists: ${msg}`);
    }
    const data = await res.json();
    for (const item of data.items || []) {
      playlists.push({
        id: item.id,
        title: item.snippet.title,
        itemCount: item.contentDetails?.itemCount ?? -1,
      });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return playlists;
}

export class QuotaExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

function checkForQuotaError(res, errBody) {
  if (res.status === 403) {
    const reason = errBody?.error?.errors?.[0]?.reason;
    const msg = errBody?.error?.message || '';
    if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded' ||
        reason === 'dailyLimitExceeded' || msg.toLowerCase().includes('quota') ||
        msg.toLowerCase().includes('limit exceeded')) {
      throw new QuotaExceededError('YouTube API daily quota exceeded.');
    }
  }
}

export async function addVideoToPlaylist(playlistId, videoId) {
  const url = 'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet';
  const body = {
    snippet: {
      playlistId,
      resourceId: { kind: 'youtube#video', videoId },
    },
  };

  const res = await fetchWithAuth(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await trackQuota(50); // playlistItems.insert = 50 units

  if (res.status === 409) {
    return { success: true, duplicate: true };
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    checkForQuotaError(res, err);
    throw new Error(err.error?.message || `API error ${res.status}`);
  }

  return { success: true, duplicate: false };
}

export async function removeVideoFromPlaylists(videoId, playlistIds) {
  const removed = [];
  for (const plId of playlistIds) {
    // Find the playlistItem ID for this video in this playlist
    const listUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=id&playlistId=${plId}&videoId=${videoId}&maxResults=1`;
    const listRes = await fetchWithAuth(listUrl);
    await trackQuota(1); // playlistItems.list = 1 unit
    if (!listRes.ok) continue;
    const listData = await listRes.json();
    const itemId = listData.items?.[0]?.id;
    if (!itemId) continue;

    const delUrl = `https://www.googleapis.com/youtube/v3/playlistItems?id=${itemId}`;
    const delRes = await fetchWithAuth(delUrl, { method: 'DELETE' });
    await trackQuota(50); // playlistItems.delete = 50 units
    if (delRes.ok || delRes.status === 204) {
      removed.push(plId);
    }
  }
  return removed;
}

// No TTL - cache lives until manually cleared or force-refreshed

async function fetchPlaylistItems(playlistId) {
  const videoIds = [];
  let pageToken = '';
  do {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetchWithAuth(url);
    await trackQuota(1); // playlistItems.list = 1 unit
    if (!res.ok) break;
    const data = await res.json();
    for (const item of data.items || []) {
      const vid = item.snippet?.resourceId?.videoId;
      if (vid) videoIds.push(vid);
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return videoIds;
}

export async function buildPlaylistMap(onProgress, forceRefresh = false) {
  // Load per-playlist cache
  const { playlistCache } = await chrome.storage.local.get('playlistCache');
  const cached = playlistCache?.playlists || {};
  const fullRefresh = forceRefresh;

  // Fetch current playlists with item counts
  const playlists = await fetchPlaylists();

  const newCache = {};
  const map = {};
  let reused = 0;
  let fetched = 0;

  for (let i = 0; i < playlists.length; i++) {
    const pl = playlists[i];
    const prev = cached[pl.id];

    // Reuse cache if item count matches and we're not forcing full refresh
    const canReuse = !fullRefresh && prev && prev.itemCount === pl.itemCount;

    if (canReuse) {
      reused++;
      newCache[pl.id] = { ...prev, title: pl.title };
      if (onProgress) onProgress(i + 1, playlists.length, false, true);

      // Rebuild map from cached videoIds
      for (const vid of prev.videoIds) {
        if (!map[vid]) map[vid] = [];
        if (!map[vid].some(p => p.id === pl.id)) {
          map[vid].push({ id: pl.id, title: pl.title });
        }
      }
    } else {
      fetched++;
      if (onProgress) onProgress(i + 1, playlists.length, false, false);

      const videoIds = await fetchPlaylistItems(pl.id);

      newCache[pl.id] = {
        id: pl.id,
        title: pl.title,
        itemCount: pl.itemCount,
        videoIds,
      };

      for (const vid of videoIds) {
        if (!map[vid]) map[vid] = [];
        if (!map[vid].some(p => p.id === pl.id)) {
          map[vid].push({ id: pl.id, title: pl.title });
        }
      }
    }
  }

  // Save updated cache
  await chrome.storage.local.set({
    playlistCache: { playlists: newCache, timestamp: Date.now() },
  });

  return { map, reused, fetched };
}

export async function clearPlaylistMapCache() {
  await chrome.storage.local.remove('playlistCache');
}

export async function getCacheStats() {
  const { playlistCache } = await chrome.storage.local.get('playlistCache');
  if (!playlistCache) return { exists: false };

  const json = JSON.stringify(playlistCache);
  const sizeBytes = new Blob([json]).size;
  const playlistCount = Object.keys(playlistCache.playlists || {}).length;
  let videoCount = 0;
  for (const pl of Object.values(playlistCache.playlists || {})) {
    videoCount += pl.videoIds?.length || 0;
  }

  return {
    exists: true,
    sizeBytes,
    playlistCount,
    videoCount,
    timestamp: playlistCache.timestamp,
  };
}
