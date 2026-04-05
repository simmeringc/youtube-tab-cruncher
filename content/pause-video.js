// Injected into YouTube tabs to pause and keep paused.
// YouTube's player can restart playback after an initial pause,
// so we intercept the play event and re-pause for a window of time.
(function pauseVideos() {
  const KEEP_PAUSED_MS = 5000;
  const endTime = Date.now() + KEEP_PAUSED_MS;

  function pauseAll() {
    document.querySelectorAll('video').forEach(v => {
      if (!v.paused) v.pause();
    });
  }

  // Intercept play events and re-pause
  function onPlay(e) {
    if (Date.now() < endTime) {
      e.target.pause();
    } else {
      // Stop intercepting after the window expires
      document.removeEventListener('play', onPlay, true);
    }
  }

  document.addEventListener('play', onPlay, true);

  // Initial pause + retries for elements not yet in DOM
  pauseAll();
  let attempts = 0;
  const interval = setInterval(() => {
    pauseAll();
    if (++attempts >= 15 || Date.now() >= endTime) {
      clearInterval(interval);
    }
  }, 300);
})();
