import { handleMessage, onTabUpdated, onTabRemoved, onAlarm, addPort } from './state-machine.js';
import { fetchPlaylists, getAuthToken, getCacheStats, clearPlaylistMapCache, getQuotaStats } from './youtube-api.js';

// Click extension icon -> open side panel
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Handle messages from the side panel
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === 'GET_PLAYLISTS') {
        const playlists = await fetchPlaylists();
        sendResponse({ playlists });
      } else if (message.type === 'GET_CACHE_STATS') {
        const stats = await getCacheStats();
        sendResponse(stats);
      } else if (message.type === 'GET_QUOTA') {
        const stats = await getQuotaStats();
        sendResponse(stats);
      } else if (message.type === 'CLEAR_CACHE') {
        await clearPlaylistMapCache();
        sendResponse({ ok: true });
      } else if (message.type === 'AUTH') {
        await getAuthToken(true);
        sendResponse({ ok: true });
      } else {
        const result = await handleMessage(message);
        sendResponse(result);
      }
    } catch (err) {
      sendResponse({ error: err.message });
    }
  })();
  return true;
});

// Live state updates via port
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'panel') {
    addPort(port);
  }
});

// Tab events
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  onTabUpdated(tabId, changeInfo);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  onTabRemoved(tabId);
});

// Keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === 'pause-review') {
    handleMessage({ type: 'PAUSE' });
  }
});

// Alarms
chrome.alarms.onAlarm.addListener((alarm) => {
  onAlarm(alarm);
});
