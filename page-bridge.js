// page-bridge.js — runs in the page's MAIN world (at document_start) so it can reach
// things the isolated content script can't:
//   1. Suno's Next.js router, for client-side navigation without a full reload.
//   2. navigator.mediaSession, so keyboard media keys (next / previous) go through the
//      shuffle instead of Suno's own queue while a shuffle is running.
// Communication with the content script is via window.postMessage ({ __ssBridge: ... }).

(function () {
  'use strict';
  if (window.__sunoShuffleBridge) return;
  window.__sunoShuffleBridge = true;

  // Same-origin app paths only (e.g. /song/{id}, /playlist/{id}, /me): no protocol, no "//".
  const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9@._~\-\/]*$/;
  let shuffleActive = false;

  // ── Media keys ────────────────────────────────────────────────────────────
  const OURS = ['nexttrack', 'previoustrack'];
  const sunoHandlers = {};
  const ms = navigator.mediaSession;
  let setHandler = null;

  function dispatcher(action) {
    return (details) => {
      if (shuffleActive) {
        window.postMessage({ __ssBridge: 'media', action }, location.origin);
      } else if (typeof sunoHandlers[action] === 'function') {
        sunoHandlers[action](details);
      }
    };
  }

  if (ms && typeof ms.setActionHandler === 'function') {
    setHandler = ms.setActionHandler.bind(ms);
    ms.setActionHandler = function (action, handler) {
      if (OURS.includes(action)) {
        sunoHandlers[action] = handler;
        // Keep the key wired to our dispatcher while shuffling; otherwise mirror Suno exactly.
        return setHandler(action, (shuffleActive || handler) ? dispatcher(action) : null);
      }
      return setHandler(action, handler);
    };
  }

  function applyMediaHandlers() {
    if (!setHandler) return;
    for (const action of OURS) {
      try {
        setHandler(action, (shuffleActive || sunoHandlers[action]) ? dispatcher(action) : null);
      } catch (e) { /* action unsupported */ }
    }
  }

  // ── Messages from the content script ─────────────────────────────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data.__ssBridge !== 'string') return;

    if (e.data.__ssBridge === 'state') {
      shuffleActive = !!e.data.active;
      applyMediaHandlers();
      return;
    }

    if (e.data.__ssBridge !== 'nav') return;
    const { reqId, path } = e.data;
    let ok = false;
    // Only plain same-origin paths are accepted from the message channel.
    if (typeof path === 'string' && SAFE_PATH.test(path)) {
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
