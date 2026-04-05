export function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (!['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(u.hostname)) return null;

    if (u.pathname === '/watch' && u.searchParams.has('v')) {
      return u.searchParams.get('v');
    }
    const match = u.pathname.match(/^\/(shorts|live)\/([a-zA-Z0-9_-]{11})/);
    if (match) return match[2];

    return null;
  } catch {
    return null;
  }
}

export async function queryAllTabs(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  return tabs.map((tab) => {
    const videoId = extractVideoId(tab.url || '');
    return {
      tabId: tab.id,
      url: tab.url || '',
      videoId,
      title: tab.title || 'Untitled',
      isYouTube: !!videoId,
      discarded: tab.discarded || false,
    };
  });
}
