// content.js — Shuffle player overlay + song-list scanner, injected into suno.com.
//
// Playback goes through Suno's own player: Suno no longer serves plain MP3s (direct CDN
// URLs return 403 and the new media files only play through Suno's player). We press the
// song's row "Play <title>" button on the list the shuffle came from, then observe Suno's
// <audio id="active-audio-play"> for progress and end-of-track. While a shuffle runs,
// Suno's own bottom player bar is hidden and this overlay is the player.

(function () {
  'use strict';

  if (window.__sunoShuffleLoaded) return;
  window.__sunoShuffleLoaded = true;

  // Reset the guard if the extension reloads so the new content script can init.
  try {
    const _keepalive = chrome.runtime.connect({ name: 'ss-keepalive' });
    _keepalive.onDisconnect.addListener(() => { window.__sunoShuffleLoaded = false; });
  } catch (e) { /* extension context already gone */ }

  // ─── Guard: exit cleanly if extension was reloaded ─────────────────────────
  function chromeSafe(fn) {
    try {
      if (!chrome.runtime?.id) return;
      fn();
    } catch (e) {
      if (String(e).includes('Extension context invalidated')) return;
      console.warn('[SunoShuffle]', e);
    }
  }

  function log(...args) { console.info('[SunoShuffle]', ...args); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function storageSet(obj) {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime?.id) return resolve();
        chrome.storage.local.set(obj, () => resolve());
      } catch (e) { resolve(); }
    });
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime?.id) return resolve(null);
        chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res));
      } catch (e) { resolve(null); }
    });
  }

  // ─── Suno's player ─────────────────────────────────────────────────────────
  const PLAYER_ID = 'active-audio-play';
  function getPlayer() { return document.getElementById(PLAYER_ID); }

  /** Song id shown in Suno's player bar (still in the DOM while we hide the bar). */
  function getPlaybarSongId() {
    const a = document.querySelector('[data-playbar="true"] a[href*="/song/"]');
    const m = a && (a.getAttribute('href') || '').match(SONG_HREF_RE);
    return m ? m[1].toLowerCase() : null;
  }

  // ─── State ─────────────────────────────────────────────────────────────────
  const AUTOPLAY_KEY = 'ssAutoplay';   // survives a full page reload during a song switch
  const AUTOPLAY_TTL = 45000;
  const MAX_CONSECUTIVE_FAILURES = 3;

  let shuffleActive = false;
  let currentSong = null;
  let currentIndex = 0;
  let currentTotal = 0;
  let sourcePath = null;          // the playlist/library page the shuffle was started from
  let sourceName = null;          // its title, e.g. "FAVS"
  let loadedSongId = null;        // song we last loaded into Suno's player
  let ourSrc = null;              // player src of the song we started
  let starting = false;           // switching Suno's player to a new song
  let suppressForeignPlay = false;// pause anything Suno auto-plays until we press Play ourselves
  let awaitingGesture = false;    // autoplay was blocked; next ▶ retries currentSong
  let externalTakeover = false;   // user started something else in Suno
  let pendingResume = false;      // restored after a page load, paused
  let consecutiveFailures = 0;
  let scanCancelled = false;
  let savedVolume = null;
  let hideSunoBar = true;
  let progressInterval = null;

  // navigating blocks new skip/prev clicks while one is in-flight; playGen is bumped on
  // every skip/prev/playSong so stale async continuations are ignored.
  let navigating = false;
  let playGen = 0;

  function setActive(on) {
    shuffleActive = on;
    applyBarVisibility();
    window.postMessage({ __ssBridge: 'state', active: on }, location.origin);
    setHeartbeat(on);
  }

  // While this tab is shuffling it leaves a heartbeat, so other Suno tabs (e.g. a song
  // opened in a new tab) don't pop up a second, paused overlay.
  const HEARTBEAT_KEY = 'ssPlayingTab';
  const HEARTBEAT_MS = 5000;
  let heartbeatTimer = null;
  let myTabId = null;
  const myTabIdReady = sendMessage({ type: 'WHOAMI' }).then(r => { myTabId = r?.tabId ?? null; });

  function setHeartbeat(on) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (on) {
      const beat = () => myTabIdReady.then(() =>
        storageSet({ [HEARTBEAT_KEY]: { tabId: myTabId, at: Date.now() } }));
      beat();
      heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
    } else {
      chromeSafe(() => chrome.storage.local.get(HEARTBEAT_KEY, (d) => {
        if (d && d[HEARTBEAT_KEY] && d[HEARTBEAT_KEY].tabId === myTabId) chrome.storage.local.remove(HEARTBEAT_KEY);
      }));
    }
  }

  function applyBarVisibility() {
    document.documentElement.classList.toggle(
      'ss-hide-playbar', shuffleActive && hideSunoBar && !externalTakeover);
  }

  // ─── DOM Scraping ──────────────────────────────────────────────────────────

  const SONG_HREF_RE = /\/song\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const ROW_PLAY_SEL = '[role="button"][aria-label^="Play "]';
  // Song ids whose title came from the song link text itself (most reliable source).
  const strongTitleIds = new Set();

  function scrapeVisibleSongs(accumulator) {
    // Strategy 1: elements with data-clip-id attribute (older Suno markup; harmless if absent)
    document.querySelectorAll('[data-clip-id]').forEach(el => {
      const id = el.getAttribute('data-clip-id');
      if (!id || accumulator.has(id)) return;
      const title = extractTitle(el) || `Song ${id.slice(0, 8)}`;
      accumulator.set(id, { id, title, image_url: extractImage(el, id) });
    });

    // Strategy 2: <a href="/song/{id}">Title</a> inside a list row.
    // Only links inside a row with a "Play <title>" cover count, so the player bar /
    // now-playing panel links to whatever is playing don't sneak in. If Suno ever drops
    // that row button, fall back to accepting every song link.
    const anyRows = !!document.querySelector(ROW_PLAY_SEL);
    document.querySelectorAll('a[href*="/song/"]').forEach(a => {
      if (a.closest('#ss-overlay')) return;
      const m = (a.getAttribute('href') || '').match(SONG_HREF_RE);
      if (!m) return;
      const id = m[1].toLowerCase();

      const container = findSongRow(a, id);
      if (anyRows && !container.querySelector(ROW_PLAY_SEL)) return;

      const linkText = a.textContent.trim();
      const hasLinkTitle = linkText.length >= 1 && linkText.length <= 150 && !isDurationString(linkText);
      const existing = accumulator.get(id);
      if (existing && (strongTitleIds.has(id) || !hasLinkTitle)) return;

      const title = hasLinkTitle ? linkText : (extractTitle(container) || `Song ${id.slice(0, 8)}`);
      if (hasLinkTitle) strongTitleIds.add(id);
      accumulator.set(id, { id, title, image_url: existing?.image_url || extractImage(container, id) });
    });
  }

  /** Number of distinct songs whose rows are currently rendered. */
  function renderedRowCount() {
    const ids = new Set();
    document.querySelectorAll(ROW_PLAY_SEL).forEach(b => {
      let row = b;
      for (let i = 0; i < 8 && row; i++, row = row.parentElement) {
        const a = row.querySelector && row.querySelector('a[href*="/song/"]');
        const m = a && (a.getAttribute('href') || '').match(SONG_HREF_RE);
        if (m) { ids.add(m[1].toLowerCase()); break; }
      }
    });
    return ids.size;
  }

  /** Walk up from a song link to the largest ancestor that only references this one song. */
  function findSongRow(a, id) {
    let row = a;
    for (let depth = 0; depth < 8 && row.parentElement && row.parentElement !== document.body; depth++) {
      const parent = row.parentElement;
      const otherSong = [...parent.querySelectorAll('a[href*="/song/"]')].some(x => {
        const m = (x.getAttribute('href') || '').match(SONG_HREF_RE);
        return m && m[1].toLowerCase() !== id;
      });
      if (otherSong) break;
      row = parent;
    }
    return row;
  }

  function extractTitle(container) {
    if (!container) return null;
    const byTestId = container.querySelector('[data-testid*="title"], [data-testid*="name"]');
    if (byTestId) {
      const t = byTestId.textContent.trim();
      if (t && !isDurationString(t)) return t;
    }
    const candidates = [];
    for (const el of container.querySelectorAll('p, span, div, h1, h2, h3, a')) {
      if (el.childElementCount > 0) continue;
      const text = el.textContent.trim();
      if (!text || text.length < 2 || text.length > 150) continue;
      if (isDurationString(text)) continue;
      if (/^\d+$/.test(text)) continue;
      candidates.push(text);
    }
    if (candidates.length === 0) return null;
    const titled = candidates.filter(t => t.length <= 80);
    return (titled.length > 0 ? titled : candidates)[0];
  }

  function isDurationString(text) {
    return /^\d{1,2}:\d{2}(:\d{2})?$/.test(text);
  }

  function extractImage(container, id) {
    const fallback = `https://cdn2.suno.ai/image_${id}.jpeg`;
    if (!container) return fallback;
    const img = container.querySelector('img[src*="suno"]') || container.querySelector('img');
    if (!img?.src) return fallback;
    // List thumbnails are requested at ?width=100 — ask for a sharper one for the overlay.
    return img.src.replace(/([?&]width=)\d+/, '$1360');
  }

  /** Song count the page announces for its list (e.g. <ul aria-label="18 songs">), or null. */
  function expectedSongCount() {
    const counts = [];
    for (const el of document.querySelectorAll('ul[aria-label], ol[aria-label]')) {
      const m = (el.getAttribute('aria-label') || '').match(/^(\d[\d,.]*)\s+songs?$/i);
      if (m) counts.push(parseInt(m[1].replace(/[,.]/g, ''), 10));
    }
    return counts.length === 1 && counts[0] > 0 ? counts[0] : null;
  }

  /** The element that scrolls the song list (Suno uses an inner div, not the window). */
  function findScrollContainer() {
    let best = null;
    let bestScrollable = 0;
    for (const el of document.querySelectorAll('*')) {
      const style = getComputedStyle(el);
      if (style.overflowY !== 'scroll' && style.overflowY !== 'auto') continue;
      const scrollable = el.scrollHeight - el.clientHeight;
      if (scrollable > bestScrollable) {
        bestScrollable = scrollable;
        best = el;
      }
    }
    return best;
  }

  /** Some lists paginate with a button instead of infinite scroll. */
  function clickLoadMore() {
    const btn = [...document.querySelectorAll('button, [role="button"]')].find(b =>
      !b.closest('#ss-overlay') && !b.disabled &&
      /^(load|show|see)\s+more(\s+songs)?$/i.test(b.textContent.trim()));
    if (btn) { log('clicking', JSON.stringify(btn.textContent.trim())); btn.click(); }
  }

  function pageTitleName() {
    return (document.title || '')
      .replace(/\s*\|\s*Suno\s*$/i, '')
      .replace(/\s+by\s+@\S+$/i, '')
      .trim() || null;
  }

  /**
   * Scroll through the list and collect every song. Long lists load more songs as you
   * reach the bottom, so at the bottom we wait (and nudge the scroll so the loader fires)
   * until nothing new arrives. Starts from the current position, so a list the user has
   * already scrolled to the bottom is picked up immediately.
   */
  async function loadAllSongsFromCurrentPage() {
    scanCancelled = false;
    strongTitleIds.clear();
    const songs = new Map();

    const TICK = 350;              // ms between scroll steps while moving
    const BOTTOM_TICK = 500;
    const GRACE_DONE = 2500;       // at bottom and the list's "N songs" count is reached
    const GRACE_UNKNOWN = 8000;    // at bottom, count unknown
    const GRACE_MISSING = 20000;   // at bottom, but the page says more songs exist
    const HARD_LIMIT = 15 * 60 * 1000;

    ui.showScan(songs.size, 'scanning');

    let container = null;
    for (let attempt = 0; attempt < 5 && !container; attempt++) {
      container = findScrollContainer();
      if (!container) await sleep(400);
    }
    const scroller = container || document.scrollingElement;
    const pos = () => scroller.scrollTop;
    const step = () => Math.max(400, Math.round(scroller.clientHeight * 0.85));
    const startTop = pos();

    function scrollBy(dy) {
      const before = pos();
      scroller.scrollTop = before + dy;
      return pos() !== before;
    }

    function collect() {
      const before = songs.size;
      scrapeVisibleSongs(songs);
      if (songs.size !== before) ui.showScan(songs.size, 'scanning');
      return songs.size > before;
    }

    const t0 = Date.now();
    let lastGrowth = Date.now();
    let bottomSince = null;
    let lastNudge = 0;

    collect();
    while (!scanCancelled && Date.now() - t0 < HARD_LIMIT) {
      if (collect()) lastGrowth = Date.now();

      if (scrollBy(step())) {
        bottomSince = null;
        await sleep(TICK);
        continue;
      }

      // At the bottom: give lazy loading time to append more songs.
      const now = Date.now();
      if (bottomSince === null) bottomSince = now;
      const expected = expectedSongCount();
      const grace = !expected ? GRACE_UNKNOWN : (songs.size >= expected ? GRACE_DONE : GRACE_MISSING);
      if (now - Math.max(bottomSince, lastGrowth) >= grace) break;

      ui.showScan(songs.size, 'waiting', expected);
      if (now - lastNudge > 1500) {           // re-trigger the "load more" observer
        lastNudge = now;
        clickLoadMore();
        scrollBy(-300);
        await sleep(120);
        scroller.scrollTop = scroller.scrollHeight;
      }
      await sleep(BOTTOM_TICK);
    }

    // Virtualized lists drop rows that scrolled away: if we started mid-list and not every
    // collected song is still rendered, sweep the part above our starting point too.
    if (!scanCancelled && startTop > 50 && renderedRowCount() < songs.size) {
      scroller.scrollTop = 0;
      await sleep(TICK);
      while (!scanCancelled && pos() < startTop) {
        collect();
        if (!scrollBy(step())) break;
        await sleep(TICK);
      }
      collect();
    }

    scroller.scrollTop = 0;
    return Array.from(songs.values());
  }

  // ─── Overlay UI ────────────────────────────────────────────────────────────

  const ICON = {
    logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.6v12.8a1 1 0 0 0 1.52.85l10.2-6.4a1 1 0 0 0 0-1.7L9.52 4.75A1 1 0 0 0 8 5.6z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="6" width="2.2" height="12" rx="1"/><path d="M18.5 6.9v10.2a.9.9 0 0 1-1.4.74L9.4 12.74a.9.9 0 0 1 0-1.48l7.7-5.1a.9.9 0 0 1 1.4.74z"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="16.8" y="6" width="2.2" height="12" rx="1"/><path d="M5.5 6.9v10.2a.9.9 0 0 0 1.4.74l7.7-5.1a.9.9 0 0 0 0-1.48l-7.7-5.1a.9.9 0 0 0-1.4.74z"/></svg>',
    vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18 6.5a7.8 7.8 0 0 1 0 11"/></svg>',
    mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="m16 9.5 5 5"/><path d="m21 9.5-5 5"/></svg>',
    bar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 15.5h18"/></svg>',
    minimize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 12h12"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>',
  };

  const ui = (() => {
    let root = null;
    const $ = (sel) => root && root.querySelector(sel);
    let minimized = false;
    let dragging = false;     // seeking via the progress bar
    let waitingSince = null;  // scan: when we started waiting at the bottom of the list

    function ensure() {
      root = document.getElementById('ss-overlay');
      if (root) return root;

      root = document.createElement('div');
      root.id = 'ss-overlay';
      root.setAttribute('role', 'region');
      root.setAttribute('aria-label', 'Suno Shuffle player');
      root.innerHTML = `
        <div id="ss-backdrop"></div>
        <div id="ss-header">
          <span id="ss-logo">${ICON.logo}</span>
          <span id="ss-heading"><span id="ss-brand">Shuffle</span><span id="ss-source"></span></span>
          <span id="ss-header-actions">
            <button class="ss-icon-btn" id="ss-bar-toggle" type="button">${ICON.bar}</button>
            <button class="ss-icon-btn" id="ss-minimize" type="button" title="Minimize">${ICON.minimize}</button>
            <button class="ss-icon-btn" id="ss-close" type="button" title="Stop shuffle">${ICON.close}</button>
          </span>
        </div>

        <div id="ss-player">
          <div id="ss-now">
            <a id="ss-art-wrap" class="ss-song-link" draggable="false"><img id="ss-img" alt="" draggable="false" /><div id="ss-spinner"></div></a>
            <div id="ss-meta">
              <a id="ss-song-title" class="ss-song-link" draggable="false">Not playing</a>
              <div id="ss-sub"></div>
            </div>
          </div>
          <div id="ss-notice" hidden>
            <span id="ss-notice-text"></span>
            <button id="ss-notice-action" type="button"></button>
          </div>
          <div id="ss-progress">
            <div id="ss-progress-bar" role="slider" aria-label="Seek" tabindex="0">
              <div id="ss-progress-fill"></div><div id="ss-progress-thumb"></div>
            </div>
            <div id="ss-times"><span id="ss-time-cur">0:00</span><span id="ss-time-dur">0:00</span></div>
          </div>
          <div id="ss-controls">
            <button class="ss-ctrl" id="ss-prev" type="button" title="Previous">${ICON.prev}</button>
            <button id="ss-play-pause" type="button" title="Play / Pause">${ICON.play}</button>
            <button class="ss-ctrl" id="ss-skip" type="button" title="Next">${ICON.next}</button>
          </div>
          <div id="ss-bottom">
            <div id="ss-volume">
              <button class="ss-icon-btn" id="ss-mute" type="button" title="Mute">${ICON.vol}</button>
              <input id="ss-volume-slider" type="range" min="0" max="100" value="100" aria-label="Volume" />
            </div>
            <div id="ss-upnext" hidden><span class="ss-label">Next</span><span id="ss-upnext-title"></span></div>
          </div>
        </div>

        <div id="ss-scan" hidden>
          <div id="ss-scan-top">
            <div id="ss-scan-ring"></div>
            <div>
              <div id="ss-scan-count">0</div>
              <div id="ss-scan-label">songs found</div>
            </div>
          </div>
          <div id="ss-scan-status"></div>
          <div id="ss-scan-hint" hidden>${ICON.info}<span>Long list? Scroll to the bottom yourself first. Every loaded song is picked up at once.</span></div>
          <button id="ss-cancel-scan" type="button">Stop scanning &amp; play</button>
        </div>`;
      document.body.appendChild(root);

      $('#ss-minimize').addEventListener('click', toggleMinimize);
      $('#ss-close').addEventListener('click', closeShuffle);
      $('#ss-bar-toggle').addEventListener('click', toggleSunoBar);
      $('#ss-play-pause').addEventListener('click', togglePlayPause);
      $('#ss-skip').addEventListener('click', skipSong);
      $('#ss-prev').addEventListener('click', prevSong);
      $('#ss-cancel-scan').addEventListener('click', () => { scanCancelled = true; });
      $('#ss-mute').addEventListener('click', toggleMute);
      $('#ss-volume-slider').addEventListener('input', (e) => {
        const v = e.target.value / 100;
        savedVolume = v;
        const p = getPlayer();
        if (p) { p.volume = v; if (v > 0) p.muted = false; }
        setVolume(v, false);
        chromeSafe(() => chrome.storage.local.set({ overlayVolume: v }));
      });
      root.querySelectorAll('.ss-song-link').forEach(a => a.addEventListener('click', onSongLinkClick));
      setupSeek($('#ss-progress-bar'));
      makeDraggable(root, $('#ss-header'));

      chromeSafe(() => {
        chrome.storage.local.get(['overlayPos', 'overlayMinimized', 'overlayVolume', 'hideSunoBar'], (data) => {
          if (!data) return;
          if (data.overlayPos) placeAt(data.overlayPos.x, data.overlayPos.y);
          if (data.overlayMinimized) setMinimized(true, false);
          if (data.overlayVolume != null) { savedVolume = data.overlayVolume; setVolume(savedVolume, false); }
          if (data.hideSunoBar === false) hideSunoBar = false;
          updateBarToggle();
          applyBarVisibility();
        });
        chrome.runtime.sendMessage({ type: 'IS_DEV' }, (res) => {
          if (chrome.runtime.lastError || !res?.dev || $('.ss-dev-tag')) return;
          const tag = document.createElement('span');
          tag.className = 'ss-dev-tag';
          tag.textContent = 'DEV';
          $('#ss-heading').appendChild(tag);
        });
      });
      updateBarToggle();
      return root;
    }

    function placeAt(x, y) {
      // Keep it on screen even if the window got smaller since it was saved.
      const maxX = Math.max(0, window.innerWidth - root.offsetWidth);
      const maxY = Math.max(0, window.innerHeight - root.offsetHeight);
      root.style.left = Math.min(Math.max(0, x), maxX) + 'px';
      root.style.top = Math.min(Math.max(0, y), maxY) + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    }

    function resetPosition() {
      if (!root) return;
      root.style.left = ''; root.style.top = '';
      root.style.right = ''; root.style.bottom = '';
    }

    function show() { ensure(); root.hidden = false; }
    function hide() { if (root) root.hidden = true; }

    function setMinimized(on, persist = true) {
      ensure();
      minimized = on;
      root.classList.toggle('ss-minimized', on);
      $('#ss-minimize').innerHTML = on ? ICON.expand : ICON.minimize;
      $('#ss-minimize').title = on ? 'Expand' : 'Minimize';
      if (persist) chromeSafe(() => chrome.storage.local.set({ overlayMinimized: on }));
    }
    function toggleMinimize() { setMinimized(!minimized); }

    function updateBarToggle() {
      const b = $('#ss-bar-toggle');
      if (!b) return;
      b.classList.toggle('ss-active', !hideSunoBar);
      b.title = hideSunoBar ? "Show Suno's player bar" : "Hide Suno's player bar while shuffling";
      b.setAttribute('aria-pressed', String(!hideSunoBar));
    }

    function setSource(name) {
      const el = $('#ss-source');
      if (!el) return;
      el.textContent = name || '';
      el.title = name || '';
    }

    function showPlayer() { ensure(); $('#ss-player').hidden = false; $('#ss-scan').hidden = true; root.classList.remove('ss-scanning'); }

    function showScan(count, phase, expected) {
      show();
      $('#ss-player').hidden = true;
      $('#ss-scan').hidden = false;
      root.classList.add('ss-scanning');
      $('#ss-scan-count').textContent = String(count);
      $('#ss-scan-label').textContent = count === 1 ? 'song found' : 'songs found';
      const status = {
        scanning: 'Scrolling through the list…',
        waiting: expected && count < expected
          ? `Waiting for more to load (${count} of ${expected})…`
          : 'Waiting for more songs to load…',
        building: 'Shuffling…',
      }[phase] || '';
      $('#ss-scan-status').textContent = status;
      // Only worth the space on long lists, or when loading more is clearly taking a while.
      if (phase !== 'waiting') waitingSince = null;
      else if (waitingSince === null) waitingSince = Date.now();
      const slow = waitingSince !== null && Date.now() - waitingSince > 3000;
      $('#ss-scan-hint').hidden = phase === 'building' || !(count >= 40 || slow);
      $('#ss-cancel-scan').textContent = count > 0 ? `Stop scanning & play ${count}` : 'Stop scanning';
      $('#ss-cancel-scan').disabled = phase === 'building';
    }

    function setSong(song, index, total) {
      ensure();
      showPlayer();
      const t = $('#ss-song-title');
      t.textContent = song.title;
      t.title = `Open “${song.title}” (Ctrl+click: new tab)`;
      root.querySelectorAll('.ss-song-link').forEach(a => { a.href = `/song/${song.id}`; });
      $('#ss-sub').textContent = total ? `${index + 1} of ${total}` : '';
      const img = $('#ss-img');
      if (song.image_url) {
        img.src = song.image_url; img.style.visibility = 'visible';
        $('#ss-backdrop').style.backgroundImage = `url("${song.image_url.replace(/"/g, '%22')}")`;
      } else {
        img.removeAttribute('src'); img.style.visibility = 'hidden';
        $('#ss-backdrop').style.backgroundImage = '';
      }
      setProgress(0, 0);
    }

    function setIdle(title, sub) {
      ensure();
      showPlayer();
      $('#ss-song-title').textContent = title;
      $('#ss-song-title').title = '';
      root.querySelectorAll('.ss-song-link').forEach(a => a.removeAttribute('href'));
      $('#ss-sub').textContent = sub || '';
      $('#ss-img').removeAttribute('src');
      $('#ss-img').style.visibility = 'hidden';
      $('#ss-backdrop').style.backgroundImage = '';
      setProgress(0, 0);
      setPlaying(false);
      setUpNext(null);
    }

    function setPlaying(on) {
      const b = $('#ss-play-pause');
      if (!b) return;
      b.innerHTML = on ? ICON.pause : ICON.play;
      b.title = on ? 'Pause' : 'Play';
      root.classList.toggle('ss-is-playing', on);
    }

    function setLoading(on) {
      if (!root) return;
      root.classList.toggle('ss-loading', on);
    }

    function setNotice(text, actionLabel, onAction) {
      ensure();
      const n = $('#ss-notice');
      $('#ss-notice-text').textContent = text;
      const btn = $('#ss-notice-action');
      if (actionLabel && onAction) {
        btn.hidden = false;
        btn.textContent = actionLabel;
        btn.onclick = onAction;
      } else {
        btn.hidden = true;
        btn.onclick = null;
      }
      n.hidden = false;
    }
    function clearNotice() { if (root) $('#ss-notice').hidden = true; }

    function setProgress(cur, dur) {
      if (!root || dragging) return;
      const ratio = dur > 0 ? Math.min(1, cur / dur) : 0;
      root.style.setProperty('--ss-progress', (ratio * 100).toFixed(2) + '%');
      $('#ss-time-cur').textContent = formatTime(cur);
      $('#ss-time-dur').textContent = dur > 0 ? formatTime(dur) : '0:00';
      $('#ss-progress-bar').setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    }

    function setUpNext(title, newCycle) {
      const el = $('#ss-upnext');
      if (!el) return;
      if (!title && !newCycle) { el.hidden = true; return; }
      el.hidden = false;
      $('#ss-upnext-title').textContent = title || 'New shuffle cycle';
      $('#ss-upnext-title').title = title || '';
    }

    function setVolume(v, muted) {
      const s = $('#ss-volume-slider');
      if (!s) return;
      const shown = muted ? 0 : v;
      s.value = String(Math.round(shown * 100));
      s.style.setProperty('--ss-vol', Math.round(shown * 100) + '%');
      $('#ss-mute').innerHTML = shown === 0 ? ICON.mute : ICON.vol;
      $('#ss-mute').title = shown === 0 ? 'Unmute' : 'Mute';
    }

    function setupSeek(bar) {
      function ratioAt(e) {
        const r = bar.getBoundingClientRect();
        return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      }
      bar.addEventListener('pointerdown', (e) => {
        const p = getPlayer();
        if (!p || !isFinite(p.duration) || !p.duration) return;
        e.preventDefault();
        dragging = true;
        bar.setPointerCapture(e.pointerId);
        root.classList.add('ss-seeking');
        const preview = (ev) => {
          const ratio = ratioAt(ev);
          root.style.setProperty('--ss-progress', (ratio * 100).toFixed(2) + '%');
          $('#ss-time-cur').textContent = formatTime(ratio * p.duration);
        };
        preview(e);
        const move = (ev) => preview(ev);
        const up = (ev) => {
          bar.removeEventListener('pointermove', move);
          bar.removeEventListener('pointerup', up);
          bar.removeEventListener('pointercancel', up);
          dragging = false;
          root.classList.remove('ss-seeking');
          const pl = getPlayer();
          if (pl && isFinite(pl.duration)) pl.currentTime = ratioAt(ev) * pl.duration;
        };
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', up);
        bar.addEventListener('pointercancel', up);
      });
      bar.addEventListener('keydown', (e) => {
        const p = getPlayer();
        if (!p || !isFinite(p.duration)) return;
        if (e.key === 'ArrowRight') { p.currentTime = Math.min(p.duration, p.currentTime + 5); e.preventDefault(); }
        if (e.key === 'ArrowLeft')  { p.currentTime = Math.max(0, p.currentTime - 5); e.preventDefault(); }
      });
    }

    return {
      ensure, show, hide, showScan, showPlayer, setSong, setIdle, setPlaying, setLoading,
      setNotice, clearNotice, setProgress, setUpNext, setVolume, setSource, updateBarToggle,
      resetPosition, placeAt, get root() { return root; },
    };
  })();

  /**
   * Title / cover click: open the song's page. A plain click navigates client-side, so the
   * music keeps playing (the next song switches back to the list by itself); Ctrl/Cmd/Shift
   * or middle click fall through to the browser and open a new tab as usual.
   */
  async function onSongLinkClick(e) {
    const a = e.currentTarget;
    const href = a.getAttribute('href');
    if (!href) { e.preventDefault(); return; }
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (location.pathname === href) return;
    const ok = await routerNavigate(href);
    if (!ok) window.open(href, '_blank', 'noopener');
  }

  function makeDraggable(el, handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const startLeft = rect.left, startTop = rect.top;
      el.classList.add('ss-dragging');

      function onMove(ev) {
        ui.placeAt(startLeft + ev.clientX - startX, startTop + ev.clientY - startY);
      }
      function onUp() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        el.classList.remove('ss-dragging');
        chromeSafe(() => chrome.storage.local.set({ overlayPos: { x: parseInt(el.style.left), y: parseInt(el.style.top) } }));
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  function formatTime(secs) {
    if (!isFinite(secs) || secs < 0) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function updateProgress() {
    const p = getPlayer();
    if (!p || externalTakeover) return;
    ui.setProgress(p.currentTime, isFinite(p.duration) ? p.duration : 0);
  }

  function startProgressTracking() {
    if (progressInterval) clearInterval(progressInterval);
    progressInterval = setInterval(updateProgress, 250);
    updateProgress();
  }

  function stopProgressTracking() {
    if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
  }

  function toggleSunoBar() {
    hideSunoBar = !hideSunoBar;
    chromeSafe(() => chrome.storage.local.set({ hideSunoBar }));
    ui.updateBarToggle();
    applyBarVisibility();
  }

  function toggleMute() {
    const p = getPlayer();
    if (!p) return;
    if (p.muted || p.volume === 0) {
      p.muted = false;
      if (p.volume === 0) p.volume = savedVolume || 0.8;
    } else {
      p.muted = true;
    }
  }

  async function refreshUpNext() {
    const r = await sendMessage({ type: 'PEEK_NEXT' });
    ui.setUpNext(r?.song?.title || null, !!r?.newCycle);
  }

  // ─── Playback (via Suno's player) ──────────────────────────────────────────

  /** Ask the MAIN-world bridge to client-side navigate (no page reload). */
  function routerNavigate(path) {
    return new Promise((resolve) => {
      const reqId = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { window.removeEventListener('message', onMsg); resolve(false); }, 1500);
      function onMsg(e) {
        if (e.source !== window || !e.data || e.data.__ssBridge !== 'nav-result' || e.data.reqId !== reqId) return;
        window.removeEventListener('message', onMsg);
        clearTimeout(timer);
        resolve(!!e.data.ok);
      }
      window.addEventListener('message', onMsg);
      window.postMessage({ __ssBridge: 'nav', reqId, path }, location.origin);
    });
  }

  async function waitFor(fn, timeout, interval = 150) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  /** Play buttons on a song's own page (the big "Play" next to the title). */
  function songPlayButtons() {
    return [...document.querySelectorAll('button[aria-label="Play"]')].filter(b => !b.closest('#ss-overlay'));
  }

  /** The row cover button ("Play <title>") of a song rendered in a list on this page. */
  function findRowPlayButton(id) {
    for (const a of document.querySelectorAll(`a[href*="/song/${id}"]`)) {
      if (a.closest('#ss-overlay')) continue;
      const b = findSongRow(a, id).querySelector(ROW_PLAY_SEL);
      if (b) return b;
    }
    return null;
  }

  function pageHasSongList() {
    return document.querySelectorAll('a[href*="/song/"]').length > 1;
  }

  /** Scroll the list (virtualized / lazily loaded) until the song's row is rendered. */
  async function scrollToFindRow(id, gen) {
    const scrollEl = findScrollContainer() || document.scrollingElement;
    if (!scrollEl) return null;
    const startTop = scrollEl.scrollTop;
    const deadline = Date.now() + 60000;
    const passes = startTop > 0 ? [startTop, 0] : [0];
    for (const from of passes) {
      scrollEl.scrollTop = from;
      while (Date.now() < deadline) {
        await sleep(250);
        if (gen !== playGen) return null;
        const b = findRowPlayButton(id);
        if (b) { b.scrollIntoView({ block: 'center' }); return b; }
        const before = scrollEl.scrollTop;
        scrollEl.scrollTop += Math.max(300, scrollEl.clientHeight * 0.8);
        if (scrollEl.scrollTop === before) {
          await sleep(1500);                      // at the bottom: give lazy loading a chance
          if (findRowPlayButton(id)) continue;
          scrollEl.scrollTop += 300;
          if (scrollEl.scrollTop === before) break;
        }
      }
    }
    scrollEl.scrollTop = startTop;
    return null;
  }

  /** Client-side navigate. Resolves 'ok' | 'failed' | 'reload' | 'stale'. */
  async function softNavigate(path, gen) {
    const navOk = await routerNavigate(path);
    log('navigate', path, navOk ? 'via router' : 'router unavailable → full load');
    if (gen !== playGen) return 'stale';
    if (!navOk) { location.assign(path); return 'reload'; }
    return await waitFor(() => location.pathname === path, 6000) ? 'ok' : 'failed';
  }

  /** Find something to press that plays `song`, preferring to stay on the current page. */
  async function locatePlayControl(song, gen) {
    const id = song.id;
    const songPath = `/song/${id}`;

    // 1. Row in the list on the current page (no navigation at all).
    let btn = findRowPlayButton(id);
    if (btn) return { btn, how: 'row on this page' };

    // 2. Already on the song's own page.
    if (location.pathname === songPath) {
      btn = await waitFor(() => songPlayButtons()[0], 4000);
      if (btn) return { btn, how: 'song page' };
    }

    // 3. Scroll this list (the shuffle source) to render the row.
    if (pageHasSongList() && (!sourcePath || location.pathname === sourcePath)) {
      btn = await scrollToFindRow(id, gen);
      if (gen !== playGen) return { result: 'stale' };
      if (btn) return { btn, how: 'row after scrolling' };
    }

    // 4. Go back to the playlist/library the shuffle was started from.
    if (sourcePath && location.pathname !== sourcePath) {
      const r = await softNavigate(sourcePath, gen);
      if (r === 'stale' || r === 'reload') return { result: r };
      if (r === 'ok') {
        btn = await waitFor(() => findRowPlayButton(id), 8000);
        if (gen !== playGen) return { result: 'stale' };
        if (!btn && pageHasSongList()) btn = await scrollToFindRow(id, gen);
        if (gen !== playGen) return { result: 'stale' };
        if (btn) return { btn, how: 'row on source list' };
      }
    }

    // 5. Last resort: the song's own page.
    songPlayButtons().forEach(b => { b.dataset.ssStale = '1'; });
    const r = await softNavigate(songPath, gen);
    if (r !== 'ok') return { result: r };
    btn = await waitFor(() => songPlayButtons().find(b => !b.dataset.ssStale), 6000) || songPlayButtons()[0];
    if (gen !== playGen) return { result: 'stale' };
    return btn ? { btn, how: 'song page (fallback)' } : { result: 'failed' };
  }

  /**
   * Make Suno's player play `song`.
   * Resolves to 'playing' | 'blocked' (autoplay policy needs a user click) | 'failed' | 'reload' | 'stale'.
   */
  async function startOnSunoPlayer(song, gen) {
    // Silence whatever Suno queued up itself (e.g. its own auto-advance at track end).
    suppressForeignPlay = true;
    const p0 = getPlayer();
    if (p0 && !p0.paused) p0.pause();

    // If anything turns into a full page reload, the freshly injected content script
    // picks this up and continues playing instead of sitting paused.
    await storageSet({ [AUTOPLAY_KEY]: { id: song.id, at: Date.now(), failures: consecutiveFailures } });
    if (gen !== playGen) return 'stale';

    const found = await locatePlayControl(song, gen);
    if (gen !== playGen) return 'stale';
    if (!found.btn) return found.result || 'failed';
    let btn = found.btn;

    for (let attempt = 0; attempt < 2; attempt++) {
      const prevSrc = getPlayer()?.currentSrc || '';
      suppressForeignPlay = false;
      log('pressing Play for', song.id, '—', found.how, attempt ? '(retry)' : '');
      btn.click();
      const ok = await waitFor(() => {
        if (gen !== playGen) return true;
        const p = getPlayer();
        if (!p || p.paused || !p.currentSrc) return false;
        // New source, or this very song was already loaded and just resumed.
        return p.currentSrc !== prevSrc || loadedSongId === song.id;
      }, 10000, 200);
      if (gen !== playGen) return 'stale';
      if (ok) { loadedSongId = song.id; return 'playing'; }
      const p = getPlayer();
      // Source loaded but not playing -> autoplay policy blocked the start.
      if (p && p.currentSrc && p.currentSrc !== prevSrc && p.paused) { loadedSongId = song.id; return 'blocked'; }
      btn = findRowPlayButton(song.id) || songPlayButtons()[0] || btn;
    }
    return 'failed';
  }

  async function playSong(song, index, total) {
    navigating = false;
    const gen = ++playGen;   // every new song gets a unique generation
    currentSong = song;
    currentIndex = index;
    currentTotal = total;
    awaitingGesture = false;
    externalTakeover = false;
    pendingResume = false;
    starting = true;
    applyBarVisibility();
    ui.show();
    ui.clearNotice();
    ui.setSong(song, index, total);
    ui.setPlaying(true);
    ui.setLoading(true);
    refreshUpNext();

    let result;
    try {
      result = await startOnSunoPlayer(song, gen);
    } catch (e) {
      console.warn('[SunoShuffle]', e);
      result = 'failed';
    }
    if (gen !== playGen || result === 'stale') return;   // a newer song already took over
    log('start result:', result);
    if (result === 'reload') return;   // page is reloading; the AUTOPLAY_KEY marker takes over
    starting = false;
    suppressForeignPlay = false;
    ui.setLoading(false);
    chromeSafe(() => chrome.storage.local.remove(AUTOPLAY_KEY));

    if (result === 'playing') {
      consecutiveFailures = 0;
      const p = getPlayer();
      ourSrc = p?.currentSrc || null;
      if (p && savedVolume != null) p.volume = savedVolume;
      ui.setPlaying(true);
      startProgressTracking();
    } else if (result === 'blocked') {
      awaitingGesture = true;
      ui.setPlaying(false);
      ui.setNotice('Chrome blocked autoplay.', 'Play', togglePlayPause);
    } else {
      // Don't silently burn through the whole queue if Suno's page structure changed again.
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        awaitingGesture = true;
        ui.setPlaying(false);
        ui.setNotice('Couldn’t start Suno’s player.', 'Retry', togglePlayPause);
        return;
      }
      console.warn('[SunoShuffle] Could not start song on Suno player, skipping:', song.id);
      advanceQueue();
    }
  }

  function advanceQueue() {
    if (!shuffleActive) return;
    chromeSafe(() => {
      chrome.runtime.sendMessage({ type: 'GET_NEXT_SONG' }, (response) => {
        if (!shuffleActive) return;
        if (chrome.runtime.lastError || !response) {
          // Don't leave skip/prev locked forever if the background didn't answer.
          navigating = false;
          ui.setLoading(false);
          ui.setNotice('Couldn’t get the next song.', 'Retry', skipSong);
          return;
        }
        if (response.done) {
          // Queue exhausted — reshuffle the same song list for a new cycle
          chrome.runtime.sendMessage({ type: 'RESHUFFLE_STORED' }, (res) => {
            if (!shuffleActive) return;
            if (res?.song) {
              playSong(res.song, res.index, res.total);
            } else {
              navigating = false;
              setActive(false);
              ui.setIdle('All songs played', 'Start a new shuffle from the extension');
            }
          });
        } else {
          playSong(response.song, response.index, response.total);
        }
      });
    });
  }

  // ─── Takeover: the user started something else in Suno ────────────────────

  function checkTakeover() {
    if (!shuffleActive || starting || externalTakeover || !currentSong) return;
    const p = getPlayer();
    if (!p || p.paused) return;
    const barId = getPlaybarSongId();
    const foreign = barId
      ? barId !== currentSong.id
      : !!(ourSrc && p.currentSrc && p.currentSrc !== ourSrc);
    if (foreign) enterTakeover();
  }

  function enterTakeover() {
    log('user started another song in Suno — pausing shuffle');
    externalTakeover = true;
    stopProgressTracking();
    applyBarVisibility();      // give Suno's bar back while they listen to their own pick
    ui.setPlaying(false);
    ui.setProgress(0, 0);
    ui.setNotice('Playing your own pick. Shuffle paused.', 'Resume', resumeShuffle);
  }

  function resumeShuffle() {
    if (currentSong) playSong(currentSong, currentIndex, currentTotal);
  }

  // ─── Controls ──────────────────────────────────────────────────────────────

  function togglePlayPause() {
    if (!shuffleActive) {
      if (!pendingResume) return;
      pendingResume = false;
      chromeSafe(() => {
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (status) => {
          if (status?.currentSong) {
            setActive(true);
            playSong(status.currentSong, Math.max(0, status.queueIndex - 1), status.queueLength);
          }
        });
      });
      return;
    }
    if ((awaitingGesture || externalTakeover) && currentSong) {
      // A real click: Suno's player is now allowed to start.
      resumeShuffle();
      return;
    }
    const p = getPlayer();
    if (!p) return;
    if (p.paused) {
      p.play().catch(() => {});
      ui.setPlaying(true);
      startProgressTracking();
    } else {
      p.pause();
      ui.setPlaying(false);
      stopProgressTracking();
    }
  }

  function skipSong() {
    if (!shuffleActive || navigating) return;
    navigating = true;
    suppressForeignPlay = true;
    playGen++;              // invalidate any in-flight start of the previous song
    stopProgressTracking();
    ui.clearNotice();
    advanceQueue();
  }

  function prevSong() {
    if (!shuffleActive || navigating) return;
    // Like most players: past the first few seconds, "previous" restarts the song.
    const p = getPlayer();
    if (p && !externalTakeover && !starting && p.currentTime > 4) {
      p.currentTime = 0;
      return;
    }
    navigating = true;
    suppressForeignPlay = true;
    playGen++;
    stopProgressTracking();
    ui.clearNotice();
    chromeSafe(() => {
      chrome.runtime.sendMessage({ type: 'STEP_BACK' }, (resp) => {
        if (chrome.runtime.lastError) { navigating = false; return; }
        if (resp?.song) {
          playSong(resp.song, resp.index, resp.total);
        } else {
          navigating = false;
          suppressForeignPlay = false;
        }
      });
    });
  }

  function stopShuffle() {
    setActive(false);
    navigating = false;
    starting = false;
    awaitingGesture = false;
    externalTakeover = false;
    suppressForeignPlay = false;
    playGen++;
    chromeSafe(() => chrome.storage.local.remove(AUTOPLAY_KEY));
    const p = getPlayer();
    if (p && !p.paused) p.pause();
    stopProgressTracking();
    ui.setLoading(false);
    currentSong = null;
  }

  /** ✕ in the overlay: stop, hide, and keep the queue for "Resume" in the popup. */
  function closeShuffle() {
    stopShuffle();
    ui.hide();
    chromeSafe(() => chrome.storage.local.set({ overlayClosed: true }));
  }

  // ─── Main start flow ───────────────────────────────────────────────────────

  async function startShuffle() {
    setActive(true);
    playGen++;
    stopProgressTracking();
    sourcePath = location.pathname;
    sourceName = pageTitleName();
    await storageSet({ sourcePath, sourceName, overlayClosed: false });
    ui.ensure();
    ui.setSource(sourceName);
    ui.clearNotice();

    const songs = await loadAllSongsFromCurrentPage();

    if (!songs || songs.length === 0) {
      setActive(false);
      ui.setIdle('No songs found here', 'Open a playlist or your Liked songs');
      return { success: false, error: 'No songs found on this page. Open a playlist or your Liked songs, then try again.' };
    }

    ui.showScan(songs.length, 'building');
    const res = await sendMessage({ type: 'BUILD_QUEUE', songs });
    if (!res?.success) {
      setActive(false);
      ui.setIdle('Couldn’t build the queue', res?.error || '');
      return { success: false, error: res?.error || 'Could not build queue' };
    }

    const resp = await sendMessage({ type: 'GET_NEXT_SONG' });
    if (!resp?.song) {
      setActive(false);
      ui.setIdle('Nothing to play', '');
      return { success: false, error: 'Empty queue' };
    }
    playSong(resp.song, resp.index, resp.total);
    return { success: true, count: res.count, total: res.total };
  }

  // ─── Audio events ──────────────────────────────────────────────────────────

  // Media events don't bubble, but they do pass through the capture phase — listening on
  // document keeps working even if Suno replaces its <audio> element.
  function onPlayerEvent(type, handler) {
    document.addEventListener(type, (e) => {
      if (e.target && e.target.id === PLAYER_ID) handler(e.target);
    }, true);
  }

  onPlayerEvent('ended', () => {
    if (shuffleActive && !navigating && !starting && !externalTakeover && currentSong) {
      suppressForeignPlay = true;   // block Suno's own auto-advance immediately
      advanceQueue();
    }
  });
  onPlayerEvent('pause', () => {
    if (!shuffleActive || starting || externalTakeover) return;
    ui.setPlaying(false);
  });
  onPlayerEvent('play', (p) => {
    if (!shuffleActive) return;
    if (suppressForeignPlay) { p.pause(); return; }
    if (starting || externalTakeover) return;
    ui.setPlaying(true);
    startProgressTracking();
    setTimeout(checkTakeover, 700);   // let Suno's bar catch up with what's playing
  });
  onPlayerEvent('volumechange', (p) => {
    if (!starting) ui.setVolume(p.volume, p.muted);
  });
  onPlayerEvent('error', () => {
    if (!shuffleActive || starting || externalTakeover) return;
    const gen = playGen;
    console.warn('[SunoShuffle] Suno player error, skipping in 1s…');
    setTimeout(() => {
      if (gen !== playGen || !shuffleActive || navigating || starting) return;
      advanceQueue();
    }, 1000);
  });

  // Keyboard media keys (next / previous), forwarded by page-bridge.js while shuffling.
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__ssBridge !== 'media' || !shuffleActive) return;
    if (e.data.action === 'nexttrack') skipSong();
    else if (e.data.action === 'previoustrack') prevSong();
  });

  // ─── Message listeners ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

    if (message.type === 'START_SHUFFLE') {
      startShuffle()
        .then(result => sendResponse(result))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }

    if (message.type === 'RESUME_SHUFFLE') {
      chromeSafe(() => {
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (status) => {
          if (status?.currentSong) {
            if (status.sourceName) { sourceName = status.sourceName; }
            chrome.storage.local.set({ overlayClosed: false });
            setActive(true);
            ui.ensure();
            ui.setSource(sourceName);
            playSong(status.currentSong, Math.max(0, status.queueIndex - 1), status.queueLength);
            sendResponse({ success: true });
          } else {
            startShuffle().then(r => sendResponse(r));
          }
        });
      });
      return true;
    }

    if (message.type === 'CONTENT_STOP') {
      stopShuffle();
      ui.hide();
      sendResponse({ success: true });
    }

    if (message.type === 'CANCEL_SCAN') {
      scanCancelled = true;
      sendResponse({ success: true });
    }

    if (message.type === 'RESET_OVERLAY_POS') {
      ui.resetPosition();
      sendResponse({ success: true });
    }

    if (message.type === 'PING') {
      sendResponse({ active: shuffleActive, hasSong: !!currentSong });
    }
  });

  // ─── Restore on page load ──────────────────────────────────────────────────

  chromeSafe(() => {
    chrome.storage.local.get(['queue', 'currentSong', 'queueIndex', 'sourcePath', 'sourceName', 'overlayClosed', AUTOPLAY_KEY, HEARTBEAT_KEY], async (data) => {
      if (!data) return;
      await myTabIdReady;
      const hb = data[HEARTBEAT_KEY];
      const otherTabPlaying = hb && hb.tabId !== myTabId && Date.now() - hb.at < HEARTBEAT_MS * 2.5;
      if (data.sourcePath && !sourcePath) sourcePath = data.sourcePath;
      if (data.sourceName && !sourceName) sourceName = data.sourceName;
      const total = (data.queue || []).length;
      const index = Math.max(0, (data.queueIndex || 1) - 1);

      // A song switch turned into a full page reload: keep the shuffle going.
      const ap = otherTabPlaying ? null : data[AUTOPLAY_KEY];
      if (ap) chrome.storage.local.remove(AUTOPLAY_KEY);
      if (ap && data.currentSong && ap.id === data.currentSong.id && Date.now() - ap.at < AUTOPLAY_TTL) {
        log('page reloaded mid-switch — resuming', ap.id);
        consecutiveFailures = ap.failures || 0;
        setActive(true);
        ui.ensure();
        ui.setSource(sourceName);
        playSong(data.currentSong, index, total);
        return;
      }

      if (data.currentSong && !data.overlayClosed && !otherTabPlaying) {
        pendingResume = true;
        ui.ensure();
        ui.setSource(sourceName);
        ui.setSong(data.currentSong, index, total);
        ui.setPlaying(false);
        refreshUpNext();
      }
    });
  });

})();
