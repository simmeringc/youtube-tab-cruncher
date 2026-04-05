import { addVideoToPlaylist, removeVideoFromPlaylists, buildPlaylistMap, clearPlaylistMapCache, QuotaExceededError } from './youtube-api.js';
import { queryAllTabs, extractVideoId } from './tab-manager.js';

const HEARTBEAT_ALARM = 'yt-pl-heartbeat';
const TAB_LOAD_TIMEOUT_MS = 10000;
const DEFAULT_REVIEW_DELAY_MS = 3000;

// Dev mode: loops the countdown forever without adding to playlist or closing
// the tab. On each loop, re-reads the current tab's URL so the thumbnail stays
// in sync with whatever video is actually playing. For taking screenshots.
// Toggled via the checkbox on the setup screen (stored in chrome.storage.local).
async function isDevMode() {
  const { devMode } = await chrome.storage.local.get('devMode');
  return !!devMode;
}

let reviewTimer = null;

function defaultState() {
  return {
    status: 'idle', // idle | loading | preview | starting | reviewing | paused | stopped | complete
    defaultPlaylistId: null,
    targetWindowId: null,
    allTabs: [],
    currentIndex: 0,
    results: [],
    currentTab: null,
    reviewUntil: null,
    reviewDelayMs: DEFAULT_REVIEW_DELAY_MS,
    loadingProgress: null,
    previewCounts: null,
    waitingForTabLoad: null,
    quotaError: null,
  };
}

async function getState() {
  const { state } = await chrome.storage.session.get('state');
  return state || defaultState();
}

async function setState(state) {
  await chrome.storage.session.set({ state });
  broadcastState(state);
}

const ports = new Set();

export function addPort(port) {
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
}

function broadcastState(state) {
  for (const port of ports) {
    try {
      port.postMessage({ type: 'STATE_UPDATE', state });
    } catch {
      ports.delete(port);
    }
  }
}

function closeTab(tabId) {
  if (tabId) chrome.tabs.remove(tabId).catch(() => {});
}

export async function handleMessage(message) {
  const state = await getState();

  switch (message.type) {
    case 'GET_STATE':
      return state;

    case 'START': {
      const loadingState = {
        ...defaultState(),
        status: 'loading',
        defaultPlaylistId: message.defaultPlaylistId,
        targetWindowId: message.windowId,
        reviewDelayMs: message.reviewDelayMs || DEFAULT_REVIEW_DELAY_MS,
      };
      await setState(loadingState);

      let tabs, mapResult;
      try {
        let lastProgressUpdate = 0;
        const onProgress = (current, total, _cached, reusedFromCache) => {
          // Throttle: only update UI every 300ms or on fetched (slow) playlists
          const now = Date.now();
          if (reusedFromCache && now - lastProgressUpdate < 300) return;
          lastProgressUpdate = now;
          loadingState.loadingProgress = { current, total, reusedFromCache };
          setState(loadingState); // fire and forget, don't await
        };

        [tabs, mapResult] = await Promise.all([
          queryAllTabs(message.windowId),
          buildPlaylistMap(onProgress, message.forceRefresh || false),
        ]);
      } catch (err) {
        // Reset to idle so the user can try again
        await setState(defaultState());
        return { error: err.message };
      }

      await chrome.storage.session.set({ playlistMap: mapResult.map });

      const ytCount = tabs.filter(t => t.isYouTube).length;

      loadingState.status = 'preview';
      loadingState.loadingProgress = null;
      loadingState.allTabs = tabs;
      loadingState.previewCounts = {
        youtube: ytCount,
        other: tabs.length - ytCount,
        reused: mapResult.reused,
        fetched: mapResult.fetched,
      };
      await setState(loadingState);
      return { ok: true };
    }

    case 'REFRESH_CACHE': {
      await clearPlaylistMapCache();
      return { ok: true };
    }

    case 'CONFIRM_START': {
      if (state.status === 'preview') {
        state.status = 'starting';
        state.previewCounts = null;

        // Dev mode: pre-populate history with fake results for all YouTube tabs
        // except the first one (which stays as the "current" tab for screenshots).
        if (await isDevMode()) {
          const ytIndices = state.allTabs
            .map((t, i) => (t.isYouTube ? i : -1))
            .filter(i => i !== -1);
          for (const idx of ytIndices.slice(1)) {
            const tab = state.allTabs[idx];
            state.results.push({
              videoId: tab.videoId,
              title: tab.title,
              playlistId: state.defaultPlaylistId,
              status: Math.random() < 0.7 ? 'added' : 'skipped',
              reason: 'Dev mode dummy',
            });
          }
        }

        await setState(state);
        startHeartbeat();
        scheduleProcessNext();
      }
      return { ok: true };
    }

    case 'ADJUST_TIMER': {
      state.reviewDelayMs = message.reviewDelayMs || DEFAULT_REVIEW_DELAY_MS;
      if (state.status === 'reviewing' && state.reviewUntil) {
        // Reschedule the current countdown with the new delay
        clearTimeout(reviewTimer);
        reviewTimer = null;
        const newUntil = Date.now() + state.reviewDelayMs;
        state.reviewUntil = newUntil;
        await setState(state);
        reviewTimer = setTimeout(() => finishReview(), state.reviewDelayMs);
      } else {
        await setState(state);
      }
      return { ok: true };
    }

    case 'PAUSE':
      if (state.status === 'reviewing') {
        clearTimeout(reviewTimer);
        reviewTimer = null;
        state.status = 'paused';
        state.reviewUntil = null;
        await setState(state);
      }
      return { ok: true };

    case 'ADD_TO_DEFAULT': {
      if (state.status === 'paused') {
        const tab = state.allTabs[state.currentIndex];
        const tabId = tab?.tabId;
        if (tab && tab.isYouTube) {
          try {
            const result = await addVideoToPlaylist(state.defaultPlaylistId, tab.videoId);
            if (result.duplicate) {
              state.results.push({
                videoId: tab.videoId, title: tab.title,
                playlistId: state.defaultPlaylistId,
                status: 'skipped', reason: 'Already in this playlist',
              });
            } else {
              state.results.push({
                videoId: tab.videoId, title: tab.title,
                playlistId: state.defaultPlaylistId, status: 'added',
              });
            }
          } catch (err) {
            if (err instanceof QuotaExceededError) {
              state.quotaError = err.message;
              state.status = 'complete';
              state.currentTab = null;
              await setState(state);
              stopHeartbeat();
              return { ok: true };
            }
            state.results.push({
              videoId: tab.videoId, title: tab.title,
              playlistId: state.defaultPlaylistId,
              status: 'error', error: err.message,
            });
          }
        }
        advance(state);
        await setState(state);
        closeTab(tabId);
        startHeartbeat();
        scheduleProcessNext();
      }
      return { ok: true };
    }

    case 'ADD_TO_PLAYLIST': {
      if (state.status === 'paused') {
        const tab = state.allTabs[state.currentIndex];
        const tabId = tab?.tabId;
        if (tab && tab.isYouTube) {
          try {
            const result = await addVideoToPlaylist(message.playlistId, tab.videoId);
            if (result.duplicate) {
              state.results.push({
                videoId: tab.videoId, title: tab.title,
                playlistId: message.playlistId,
                status: 'skipped', reason: 'Already in this playlist',
              });
            } else {
              state.results.push({
                videoId: tab.videoId, title: tab.title,
                playlistId: message.playlistId, status: 'added',
              });
            }
          } catch (err) {
            if (err instanceof QuotaExceededError) {
              state.quotaError = err.message;
              state.status = 'complete';
              state.currentTab = null;
              await setState(state);
              stopHeartbeat();
              return { ok: true };
            }
            state.results.push({
              videoId: tab.videoId, title: tab.title,
              playlistId: message.playlistId,
              status: 'error', error: err.message,
            });
          }
        }
        advance(state);
        await setState(state);
        closeTab(tabId);
        startHeartbeat();
        scheduleProcessNext();
      }
      return { ok: true };
    }

    case 'REMOVE_AND_SKIP': {
      if (state.status === 'reviewing' || state.status === 'paused') {
        clearTimeout(reviewTimer);
        reviewTimer = null;
        const tab = state.allTabs[state.currentIndex];
        const tabId = tab?.tabId;
        if (tab && tab.isYouTube) {
          // Look up which playlists contain this video
          const { playlistMap } = await chrome.storage.session.get('playlistMap');
          const entries = (playlistMap && playlistMap[tab.videoId]) || [];
          const plIds = entries.map(e => e.id);
          let removedCount = 0;
          if (plIds.length > 0) {
            const removed = await removeVideoFromPlaylists(tab.videoId, plIds);
            removedCount = removed.length;
            // Update the session playlistMap
            if (playlistMap && playlistMap[tab.videoId]) {
              delete playlistMap[tab.videoId];
              await chrome.storage.session.set({ playlistMap });
            }
          }
          state.results.push({
            videoId: tab.videoId,
            title: tab.title,
            status: 'removed',
            reason: removedCount > 0
              ? `Removed from ${removedCount} playlist${removedCount !== 1 ? 's' : ''}`
              : 'Not in any playlists',
          });
        }
        advance(state);
        await setState(state);
        closeTab(tabId);
        startHeartbeat();
        scheduleProcessNext();
      }
      return { ok: true };
    }

    case 'CONTINUE': {
      if (state.status === 'reviewing') {
        clearTimeout(reviewTimer);
        reviewTimer = null;
        // Do exactly what finishReview does, but immediately
        await doFinishReview(state);
      }
      return { ok: true };
    }

    case 'SKIP_REVIEWING': {
      if (state.status === 'reviewing') {
        clearTimeout(reviewTimer);
        reviewTimer = null;
        const tab = state.allTabs[state.currentIndex];
        const tabId = tab?.tabId;
        if (tab) {
          state.results.push({
            videoId: tab.videoId || null,
            title: tab.title,
            status: 'skipped',
          });
        }
        advance(state);
        await setState(state);
        closeTab(tabId);
        scheduleProcessNext();
      }
      return { ok: true };
    }

    case 'SKIP': {
      if (state.status === 'paused') {
        const tab = state.allTabs[state.currentIndex];
        const tabId = tab?.tabId;
        if (tab) {
          state.results.push({
            videoId: tab.videoId || null,
            title: tab.title,
            status: 'skipped',
          });
        }
        advance(state);
        await setState(state);
        closeTab(tabId);
        startHeartbeat();
        scheduleProcessNext();
      }
      return { ok: true };
    }

    case 'RESUME_SCAN': {
      if (state.status === 'stopped') {
        while (state.currentIndex < state.allTabs.length) {
          const t = state.allTabs[state.currentIndex];
          if (t.isYouTube) break;
          state.currentIndex++;
        }
        state.currentTab = null;
        state.status = 'starting';
        await setState(state);
        startHeartbeat();
        scheduleProcessNext();
      }
      return { ok: true };
    }

    case 'FINISH': {
      if (state.status !== 'idle' && state.status !== 'complete') {
        clearTimeout(reviewTimer);
        reviewTimer = null;
        state.status = 'complete';
        state.currentTab = null;
        state.reviewUntil = null;
        await setState(state);
        stopHeartbeat();
      }
      return { ok: true };
    }

    case 'HISTORY_ADD': {
      const { videoId, playlistId } = message;
      try {
        const result = await addVideoToPlaylist(playlistId, videoId);
        return { ok: true, duplicate: result.duplicate };
      } catch (err) {
        return { error: err.message };
      }
    }

    case 'RESET':
      clearTimeout(reviewTimer);
      reviewTimer = null;
      await setState(defaultState());
      stopHeartbeat();
      return { ok: true };

    default:
      return { error: 'Unknown message type' };
  }
}

function advance(state) {
  state.currentIndex++;
  state.currentTab = null;
  state.reviewUntil = null;
  state.status = 'starting';
}

function scheduleProcessNext() {
  setTimeout(() => processNext(), 300);
}

async function processNext() {
  const state = await getState();

  if (state.status !== 'starting') return;
  if (state.waitingForTabLoad) return;

  if (state.currentIndex >= state.allTabs.length) {
    state.status = 'complete';
    state.currentTab = null;
    await setState(state);
    stopHeartbeat();
    return;
  }

  const tabInfo = state.allTabs[state.currentIndex];

  let tab;
  try {
    tab = await chrome.tabs.get(tabInfo.tabId);
  } catch {
    state.currentIndex++;
    await setState(state);
    scheduleProcessNext();
    return;
  }

  try {
    await chrome.tabs.update(tabInfo.tabId, { active: true });
  } catch {
    state.currentIndex++;
    await setState(state);
    scheduleProcessNext();
    return;
  }

  if (tab.discarded || tab.status === 'unloaded') {
    state.waitingForTabLoad = tabInfo.tabId;
    state.currentTab = tabInfo;
    await setState(state);
    try {
      await chrome.tabs.reload(tabInfo.tabId);
    } catch {
      state.waitingForTabLoad = null;
      state.currentIndex++;
      await setState(state);
      scheduleProcessNext();
      return;
    }
    chrome.alarms.create('tab-load-timeout', { delayInMinutes: TAB_LOAD_TIMEOUT_MS / 60000 });
    return;
  }

  // Refresh tab info
  tabInfo.url = tab.url || tabInfo.url;
  tabInfo.title = tab.title || tabInfo.title;
  tabInfo.videoId = extractVideoId(tabInfo.url);
  tabInfo.isYouTube = !!tabInfo.videoId;
  state.allTabs[state.currentIndex] = tabInfo;
  state.currentTab = tabInfo;

  if (tabInfo.isYouTube) {
    chrome.scripting.executeScript({
      target: { tabId: tabInfo.tabId },
      files: ['content/pause-video.js'],
    }).catch(() => {});

    // Look up existing playlists (now stored as {id, title} objects)
    const { playlistMap } = await chrome.storage.session.get('playlistMap');
    const entries = (playlistMap && playlistMap[tabInfo.videoId]) || [];
    tabInfo.existingPlaylists = entries.map(e => e.title);
    tabInfo.alreadyInDefault = entries.some(e => e.id === state.defaultPlaylistId);
    state.allTabs[state.currentIndex] = tabInfo;

    const delay = state.reviewDelayMs || DEFAULT_REVIEW_DELAY_MS;
    state.status = 'reviewing';
    state.reviewUntil = Date.now() + delay;
    await setState(state);
    reviewTimer = setTimeout(() => finishReview(), delay);
  } else {
    state.status = 'stopped';
    await setState(state);
    stopHeartbeat();
  }
}

async function doFinishReview(state) {
  const tab = state.allTabs[state.currentIndex];
  const tabId = tab?.tabId;

  if (tab && tab.isYouTube) {
    if (tab.alreadyInDefault) {
      state.results.push({
        videoId: tab.videoId,
        title: tab.title,
        playlistId: state.defaultPlaylistId,
        status: 'skipped',
        reason: 'Already in this playlist',
      });
    } else {
      try {
        const result = await addVideoToPlaylist(state.defaultPlaylistId, tab.videoId);
        if (result.duplicate) {
          state.results.push({
            videoId: tab.videoId, title: tab.title,
            playlistId: state.defaultPlaylistId,
            status: 'skipped', reason: 'Already in this playlist',
          });
        } else {
          state.results.push({
            videoId: tab.videoId, title: tab.title,
            playlistId: state.defaultPlaylistId, status: 'added',
          });
        }
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          state.results.push({
            videoId: tab.videoId, title: tab.title,
            playlistId: state.defaultPlaylistId,
            status: 'error', error: 'Quota exceeded',
          });
          state.quotaError = err.message;
          state.status = 'complete';
          state.currentTab = null;
          await setState(state);
          stopHeartbeat();
          return;
        }
        state.results.push({
          videoId: tab.videoId, title: tab.title,
          playlistId: state.defaultPlaylistId,
          status: 'error', error: err.message,
        });
      }
    }
  }

  advance(state);
  await setState(state);
  closeTab(tabId);
  scheduleProcessNext();
}

async function finishReview() {
  reviewTimer = null;
  const state = await getState();
  if (state.status !== 'reviewing') return;

  if (await isDevMode()) {
    // Re-read the current tab's URL so the thumbnail matches whatever video is
    // actually on screen (the user may have navigated within the tab).
    const tabInfo = state.currentTab;
    if (tabInfo) {
      try {
        const tab = await chrome.tabs.get(tabInfo.tabId);
        tabInfo.url = tab.url || tabInfo.url;
        tabInfo.title = tab.title || tabInfo.title;
        const liveVideoId = extractVideoId(tabInfo.url);
        if (liveVideoId) tabInfo.videoId = liveVideoId;
        tabInfo.isYouTube = !!tabInfo.videoId;
        state.currentTab = tabInfo;
        state.allTabs[state.currentIndex] = tabInfo;
      } catch {}
    }
    const delay = state.reviewDelayMs || DEFAULT_REVIEW_DELAY_MS;
    state.reviewUntil = Date.now() + delay;
    await setState(state);
    reviewTimer = setTimeout(() => finishReview(), delay);
    return;
  }

  await doFinishReview(state);
}

export async function onTabUpdated(tabId, changeInfo) {
  if (changeInfo.status !== 'complete') return;

  const state = await getState();
  if (state.waitingForTabLoad !== tabId) return;

  chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/pause-video.js'],
  }).catch(() => {});

  state.waitingForTabLoad = null;
  await setState(state);
  chrome.alarms.clear('tab-load-timeout');
  processNext();
}

export async function onTabRemoved(tabId) {
  const state = await getState();

  if (state.status !== 'idle' && state.status !== 'complete' && state.status !== 'stopped') {
    const idx = state.allTabs.findIndex((t, i) => i > state.currentIndex && t.tabId === tabId);
    if (idx !== -1) {
      state.allTabs.splice(idx, 1);
      await setState(state);
    }
  }
}

export async function onAlarm(alarm) {
  if (alarm.name === HEARTBEAT_ALARM) {
    const state = await getState();
    if (state.status === 'reviewing' && state.reviewUntil && Date.now() >= state.reviewUntil) {
      finishReview();
    } else if (state.status === 'starting' && !state.waitingForTabLoad) {
      processNext();
    }
  } else if (alarm.name === 'tab-load-timeout') {
    const state = await getState();
    if (state.waitingForTabLoad) {
      const tab = state.allTabs[state.currentIndex];
      if (tab) {
        state.results.push({
          videoId: tab.videoId,
          title: tab.title,
          status: 'error',
          error: 'Tab failed to load',
        });
      }
      state.waitingForTabLoad = null;
      advance(state);
      await setState(state);
      processNext();
    }
  }
}

function startHeartbeat() {
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.4 });
}

function stopHeartbeat() {
  chrome.alarms.clear(HEARTBEAT_ALARM);
}
