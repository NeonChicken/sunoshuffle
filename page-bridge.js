// page-bridge.js — runs in the page's MAIN world so it can reach Suno's Next.js router.
// The isolated content script asks it (via window.postMessage) to client-side navigate
// to a song page without a full reload, so the shuffle state and Suno's player survive.

(function () {
  'use strict';
  if (window.__sunoShuffleBridge) return;
  window.__sunoShuffleBridge = true;

  const SONG_PATH = /^\/song\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__ssBridge !== 'nav') return;
    const { reqId, path } = e.data;
    let ok = false;
    // Only ever navigate to song pages — nothing else is accepted from the message channel.
    if (typeof path === 'string' && SONG_PATH.test(path)) {
      try {
        const router = window.next && window.next.router;
        if (router && typeof router.push === 'function') {
          router.push(path);
          ok = true;
        }
      } catch (err) {
        console.warn('[SunoShuffle bridge] router.push failed', err);
      }
    }
    window.postMessage({ __ssBridge: 'nav-result', reqId, ok }, location.origin);
  });
})();
