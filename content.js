// content.js — Overlay player + DOM scraper injected into suno.com

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

  // ─── Suno's native player ──────────────────────────────────────────────────
  // Suno no longer serves plain MP3s (cdn1/cdn2 URLs return 403 and the new media files
  // are only playable through Suno's own player). So instead of running our own <audio>,
  // we drive Suno's player: navigate to the song page, press its Play button, and observe
  // this element for progress / end-of-track.
  const PLAYER_ID = 'active-audio-play';
  function getPlayer() { return document.getElementById(PLAYER_ID); }

  let savedVolume = null;        // user's overlay volume (0..1), applied to Suno's player
  let currentIndex = 0;
  let currentTotal = 0;
  let starting = false;          // true while we are switching Suno's player to a new song
  let suppressForeignPlay = false; // pause anything Suno auto-plays until we press Play ourselves
  const AUTOPLAY_KEY = 'ssAutoplay'; // survives a full page reload during a song switch
  const AUTOPLAY_TTL = 45000;

  function log(...args) { console.info('[SunoShuffle]', ...args); }
  let awaitingGesture = false;   // autoplay was blocked; next ▶ click retries currentSong

  let shuffleActive = false;
  let currentSong   = null;
  let progressInterval = null;
  let overlayMinimized = false;
  let scanCancelled = false;
  let volumeSlider  = null;
  let pendingResume = false;

  // ─── DOM References (overlay) ──────────────────────────────────────────────
  let overlay, titleEl, counterEl, imgEl, progressFill, timeEl, playPauseBtn, spinnerEl;

  // ─── DOM Scraping ──────────────────────────────────────────────────────────

  const SONG_HREF_RE = /\/song\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
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

    // Strategy 2: anchor links pointing to /song/{uuid}.
    // Current Suno markup: <a href="/song/{id}">Title</a> inside an unattributed row div.
    // (Thumbnail UUIDs are NOT clip ids anymore, so images are never used to discover songs.)
    document.querySelectorAll('a[href*="/song/"]').forEach(a => {
      if (a.closest('#ss-overlay')) return;
      const m = (a.getAttribute('href') || '').match(SONG_HREF_RE);
      if (!m) return;
      const id = m[1].toLowerCase();

      const linkText = a.textContent.trim();
      const hasLinkTitle = linkText.length >= 1 && linkText.length <= 150 && !isDurationString(linkText);
      const existing = accumulator.get(id);
      if (existing && (strongTitleIds.has(id) || !hasLinkTitle)) return;

      const container = findSongRow(a, id);
      const title = hasLinkTitle ? linkText : (extractTitle(container) || `Song ${id.slice(0, 8)}`);
      if (hasLinkTitle) strongTitleIds.add(id);
      accumulator.set(id, { id, title, image_url: existing?.image_url || extractImage(container, id) });
    });
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

    // Named test-id first
    const byTestId = container.querySelector('[data-testid*="title"], [data-testid*="name"]');
    if (byTestId) {
      const t = byTestId.textContent.trim();
      if (t && !isDurationString(t)) return t;
    }

    // Collect all leaf-text candidates, rank them
    const candidates = [];
    for (const el of container.querySelectorAll('p, span, div, h1, h2, h3, a')) {
      if (el.childElementCount > 0) continue;
      const text = el.textContent.trim();
      if (!text || text.length < 2 || text.length > 150) continue;
      if (isDurationString(text)) continue;   // skip "2:34", "1:23:45"
      if (/^\d+$/.test(text)) continue;       // skip pure numbers
      candidates.push(text);
    }

    if (candidates.length === 0) return null;

    // Song titles are short; descriptions are long.
    // Cap at 80 chars, then take the first remaining candidate in DOM order
    // (title elements appear before description elements in the markup).
    const titled = candidates.filter(t => t.length <= 80);
    return (titled.length > 0 ? titled : candidates)[0];
  }

  function isDurationString(text) {
    // Matches "2:34", "02:34", "1:23:45"
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

  /**
   * Find the element that actually scrolls the song list.
   * Suno renders the list inside a scrollable div, not the window.
   */
  function findScrollContainer() {
    // Walk every element and return the tallest one with overflow scroll/auto
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

  /**
   * Scroll the page (or its inner scrollable container) to load all lazily-rendered
   * songs, accumulating them into a Map even as virtual scroll removes earlier nodes.
   */
  async function loadAllSongsFromCurrentPage() {
    scanCancelled = false;
    strongTitleIds.clear();
    const songs = new Map();
    let lastSize = -1;
    let staleRounds = 0;
    const MAX_STALE = 6;        // 6 × 2000ms = 12s of no new songs before stopping
    const STEP = 600;           // scroll 600px per tick — small enough to trigger observers

    setOverlayStatus('Scanning… (0 songs)');
    setScanningUI(true);

    // Find scroll container once (it may not exist yet, retry briefly)
    let container = null;
    for (let attempt = 0; attempt < 5 && !container; attempt++) {
      container = findScrollContainer();
      if (!container) await sleep(600);
    }

    function scrollDown() {
      if (container) container.scrollTop += STEP;
      window.scrollBy({ top: STEP, behavior: 'instant' });
    }

    function scrollToTop() {
      if (container) container.scrollTop = 0;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    while (staleRounds < MAX_STALE && !scanCancelled) {
      scrapeVisibleSongs(songs);

      if (songs.size > lastSize) {
        staleRounds = 0;
        lastSize = songs.size;
        setOverlayStatus(`Scanning… (${songs.size} songs)`);
      } else {
        staleRounds++;
      }

      scrollDown();
      await sleep(2000);
    }

    setScanningUI(false);
    scrollToTop();
    return Array.from(songs.values());
  }

  // ─── Overlay ───────────────────────────────────────────────────────────────

  function createOverlay() {
    if (document.getElementById('ss-overlay')) {
      // Already exists — just re-cache references
      overlay      = document.getElementById('ss-overlay');
      titleEl      = document.getElementById('ss-song-title');
      counterEl    = document.getElementById('ss-counter');
      imgEl        = document.getElementById('ss-img');
      progressFill = document.getElementById('ss-progress-fill');
      timeEl       = document.getElementById('ss-time');
      playPauseBtn = document.getElementById('ss-play-pause');
      spinnerEl    = document.getElementById('ss-spinner');
      volumeSlider = document.getElementById('ss-volume-slider');
      return;
    }

    overlay = document.createElement('div');
    overlay.id = 'ss-overlay';
    overlay.innerHTML = [
      '<div id="ss-header">',
      '  <span id="ss-drag-handle" title="Drag to move">\u2847</span>',
      '  <span id="ss-title-bar">Suno Shuffle</span>',
      '  <button id="ss-minimize" title="Minimize">\u2212</button>',
      '</div>',
      '<div id="ss-body">',
      '  <div id="ss-art-wrap">',
      '    <img id="ss-img" src="" alt="" />',
      '    <div id="ss-spinner"></div>',
      '  </div>',
      '  <div id="ss-info">',
      '    <div id="ss-song-title">Not playing</div>',
      '    <div id="ss-progress-wrap">',
      '      <div id="ss-progress-bar"><div id="ss-progress-fill"></div></div>',
      '      <span id="ss-time">0:00</span>',
      '    </div>',
      '    <div id="ss-counter">\u2014 / \u2014</div>',
      '  </div>',
      '  <div id="ss-controls">',
      '    <button id="ss-prev"       title="Previous">\u23ee</button>',
      '    <button id="ss-play-pause" title="Play / Pause">\u23f8</button>',
      '    <button id="ss-skip"       title="Skip">\u23ed</button>',
      '    <button id="ss-stop"       title="Stop shuffle">\u25a0</button>',
      '  </div>',
      '  <div id="ss-volume-row">',
      '    <span id="ss-vol-icon">&#x1F50A;</span>',
      '    <input id="ss-volume-slider" type="range" min="0" max="100" value="100" />',
      '  </div>',
      '  <button id="ss-cancel-scan">Stop scanning, play found songs</button>',
      '</div>',
    ].join('\n');

    document.body.appendChild(overlay);

    titleEl      = overlay.querySelector('#ss-song-title');
    counterEl    = overlay.querySelector('#ss-counter');
    imgEl        = overlay.querySelector('#ss-img');
    progressFill = overlay.querySelector('#ss-progress-fill');
    timeEl       = overlay.querySelector('#ss-time');
    playPauseBtn = overlay.querySelector('#ss-play-pause');
    spinnerEl    = overlay.querySelector('#ss-spinner');
    volumeSlider = overlay.querySelector('#ss-volume-slider');

    // Restore position / minimized state
    chromeSafe(() => {
      chrome.storage.local.get(['overlayPos', 'overlayMinimized', 'overlayVolume'], (data) => {
        if (!data) return;
        if (data.overlayPos) {
          overlay.style.left   = data.overlayPos.x + 'px';
          overlay.style.top    = data.overlayPos.y + 'px';
          overlay.style.right  = 'auto';
          overlay.style.bottom = 'auto';
        }
        if (data.overlayMinimized) {
          overlayMinimized = true;
          overlay.classList.add('ss-minimized');
          overlay.querySelector('#ss-minimize').textContent = '+';
        }
        if (data.overlayVolume != null) {
          savedVolume = data.overlayVolume;
          if (volumeSlider) volumeSlider.value = Math.round(data.overlayVolume * 100);
        }
      });
    });

    overlay.querySelector('#ss-minimize').addEventListener('click', toggleMinimize);
    overlay.querySelector('#ss-play-pause').addEventListener('click', togglePlayPause);
    overlay.querySelector('#ss-skip').addEventListener('click', skipSong);
    overlay.querySelector('#ss-stop').addEventListener('click', stopCurrentSong);
    overlay.querySelector('#ss-prev').addEventListener('click', prevSong);
    overlay.querySelector('#ss-progress-bar').addEventListener('click', seekTo);
    overlay.querySelector('#ss-cancel-scan').addEventListener('click', () => { scanCancelled = true; });
    overlay.querySelector('#ss-volume-slider').addEventListener('input', (e) => {
      const v = e.target.value / 100;
      savedVolume = v;
      const p = getPlayer();
      if (p) p.volume = v;
      chromeSafe(() => chrome.storage.local.set({ overlayVolume: v }));
    });

    makeDraggable(overlay, overlay.querySelector('#ss-header'));

    chromeSafe(() => {
      chrome.runtime.sendMessage({ type: 'IS_DEV' }, (res) => {
        if (chrome.runtime.lastError || !res?.dev) return;
        const bar = overlay.querySelector('#ss-title-bar');
        if (bar && !bar.querySelector('.ss-dev-tag')) {
          const tag = document.createElement('span');
          tag.className = 'ss-dev-tag';
          tag.textContent = 'DEV';
          bar.appendChild(tag);
        }
      });
    });
  }

  function makeDraggable(el, handle) {
    let startX, startY, startLeft, startTop;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startLeft = rect.left; startTop = rect.top;

      function onMove(e) {
        const newLeft = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  startLeft + e.clientX - startX));
        const newTop  = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, startTop  + e.clientY - startY));
        el.style.left = newLeft + 'px'; el.style.top = newTop + 'px';
        el.style.right = 'auto'; el.style.bottom = 'auto';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        chromeSafe(() => chrome.storage.local.set({ overlayPos: { x: parseInt(el.style.left), y: parseInt(el.style.top) } }));
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ─── UI helpers ────────────────────────────────────────────────────────────

  function toggleMinimize() {
    overlayMinimized = !overlayMinimized;
    overlay.classList.toggle('ss-minimized', overlayMinimized);
    overlay.querySelector('#ss-minimize').textContent = overlayMinimized ? '+' : '\u2212';
    chromeSafe(() => chrome.storage.local.set({ overlayMinimized }));
  }

  function setScanningUI(scanning) {
    if (!overlay) return;
    const controls   = overlay.querySelector('#ss-controls');
    const cancelBtn  = overlay.querySelector('#ss-cancel-scan');
    if (controls)  controls.style.display  = scanning ? 'none' : 'flex';
    if (cancelBtn) cancelBtn.style.display = scanning ? 'block' : 'none';
  }

  function setSpinner(on) {
    if (spinnerEl) spinnerEl.style.display = on ? 'block' : 'none';
    if (imgEl) imgEl.style.opacity = on ? '0.3' : '1';
  }

  function setOverlayStatus(text) {
    if (titleEl) titleEl.textContent = text;
  }

  function formatTime(secs) {
    if (!isFinite(secs)) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function updateProgress() {
    const p = getPlayer();
    if (!p || !p.duration || !isFinite(p.duration)) return;
    const ratio = p.currentTime / p.duration;
    if (progressFill) progressFill.style.width = (ratio * 100) + '%';
    if (timeEl) timeEl.textContent = formatTime(p.currentTime) + ' / ' + formatTime(p.duration);
  }

  function startProgressTracking() {
    if (progressInterval) clearInterval(progressInterval);
    progressInterval = setInterval(updateProgress, 500);
  }

  function stopProgressTracking() {
    if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
  }

  function setCurrentSongUI(song, index, total) {
    if (!overlay) return;
    if (titleEl)      { titleEl.textContent = song.title; titleEl.title = song.title; }
    if (counterEl)    counterEl.textContent = `${index + 1} / ${total}`;
    if (progressFill) progressFill.style.width = '0%';
    if (timeEl)       timeEl.textContent = '0:00';
    if (playPauseBtn) playPauseBtn.textContent = '\u23f8';
    if (imgEl) {
      if (song.image_url) { imgEl.src = song.image_url; imgEl.style.display = 'block'; }
      else imgEl.style.display = 'none';
    }
  }

  function seekTo(e) {
    const p = getPlayer();
    if (!p || !p.duration || !isFinite(p.duration)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    p.currentTime = ((e.clientX - rect.left) / rect.width) * p.duration;
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

  function songPlayButtons() {
    return [...document.querySelectorAll('button[aria-label="Play"]')].filter(b => !b.closest('#ss-overlay'));
  }

  function isPlayingNewSource(prevSrc) {
    const p = getPlayer();
    return !!(p && !p.paused && p.currentSrc && p.currentSrc !== prevSrc);
  }

  /**
   * Make Suno's player play `song`.
   * Resolves to 'playing' | 'blocked' (autoplay policy needs a user click) | 'failed' | 'reload' | 'stale'.
   */
  async function startOnSunoPlayer(song, gen) {
    const path = `/song/${song.id}`;

    // Silence whatever Suno queued up itself (e.g. its own auto-advance at track end).
    suppressForeignPlay = true;
    const p0 = getPlayer();
    if (p0 && !p0.paused) p0.pause();

    // If the switch turns into a full page reload, the freshly injected content script
    // picks this up and continues playing instead of sitting paused.
    await storageSet({ [AUTOPLAY_KEY]: { id: song.id, at: Date.now(), failures: consecutiveFailures } });
    if (gen !== playGen) return 'stale';

    if (location.pathname !== path) {
      // Mark the current page's Play buttons so we don't click a stale one mid-transition.
      songPlayButtons().forEach(b => { b.dataset.ssStale = '1'; });
      const navOk = await routerNavigate(path);
      log('navigate', path, navOk ? 'via router' : 'router unavailable → full load');
      if (gen !== playGen) return 'stale';
      if (!navOk) {
        location.assign(path);
        return 'reload';
      }
      if (!await waitFor(() => location.pathname === path, 6000)) return 'failed';
    } else {
      songPlayButtons().forEach(b => { delete b.dataset.ssStale; });
    }

    let btn = await waitFor(() => songPlayButtons().find(b => !b.dataset.ssStale), 6000);
    if (gen !== playGen) return 'stale';
    if (!btn) btn = songPlayButtons()[0];   // DOM node may have been reused across pages
    if (!btn) return 'failed';

    for (let attempt = 0; attempt < 2; attempt++) {
      const prevSrc = getPlayer()?.currentSrc || '';
      suppressForeignPlay = false;
      log('pressing Play for', song.id, attempt ? '(retry)' : '');
      btn.click();
      if (await waitFor(() => isPlayingNewSource(prevSrc) || gen !== playGen, 10000, 200)) {
        return gen !== playGen ? 'stale' : 'playing';
      }
      if (gen !== playGen) return 'stale';
      const p = getPlayer();
      // Source loaded but not playing → autoplay policy blocked the start.
      if (p && p.currentSrc && p.currentSrc !== prevSrc && p.paused) return 'blocked';
      btn = songPlayButtons()[0] || btn;
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
    starting = true;
    setSpinner(true);
    setCurrentSongUI(song, index, total);

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
    setSpinner(false);
    chromeSafe(() => chrome.storage.local.remove(AUTOPLAY_KEY));

    if (result === 'playing') {
      const p = getPlayer();
      if (p && savedVolume != null) p.volume = savedVolume;
      startProgressTracking();
    } else if (result === 'blocked') {
      awaitingGesture = true;
      if (playPauseBtn) playPauseBtn.textContent = '▶';
      if (titleEl) titleEl.textContent = song.title + ' — press ▶ to start';
    } else if (result === 'failed') {
      // Don't silently burn through the whole queue if Suno's page structure changed again.
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        awaitingGesture = true;
        if (playPauseBtn) playPauseBtn.textContent = '▶';
        if (titleEl) titleEl.textContent = 'Could not start Suno’s player — press ▶ to retry';
        return;
      }
      console.warn('[SunoShuffle] Could not start song on Suno player, skipping:', song.id);
      advanceQueue();
      return;
    }
    if (result === 'playing') consecutiveFailures = 0;
  }

  const MAX_CONSECUTIVE_FAILURES = 3;
  let consecutiveFailures = 0;

  function advanceQueue() {
    if (!shuffleActive) return;
    chromeSafe(() => {
      chrome.runtime.sendMessage({ type: 'GET_NEXT_SONG' }, (response) => {
        if (!shuffleActive || chrome.runtime.lastError || !response) return;
        if (response.done) {
          // Queue exhausted — reshuffle the same song list for a new cycle
          setOverlayStatus('Reshuffling…');
          chrome.runtime.sendMessage({ type: 'RESHUFFLE_STORED' }, (res) => {
            if (!shuffleActive) return;
            if (res?.song) {
              playSong(res.song, res.index, res.total);
            } else {
              navigating = false;
              setOverlayStatus('All songs played. Press Start Shuffle to scan again.');
              shuffleActive = false;
            }
          });
        } else {
          playSong(response.song, response.index, response.total);
        }
      });
    });
  }

  // ─── Controls ──────────────────────────────────────────────────────────────

  function togglePlayPause() {
    if (!shuffleActive) {
      if (!pendingResume) return;
      pendingResume = false;
      chromeSafe(() => {
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (status) => {
          if (status?.currentSong) {
            shuffleActive = true;
            playSong(status.currentSong, Math.max(0, status.queueIndex - 1), status.queueLength);
          }
        });
      });
      return;
    }
    if (awaitingGesture && currentSong) {
      // This click is a real user gesture, so Suno's player is now allowed to start.
      playSong(currentSong, currentIndex, currentTotal);
      return;
    }
    const p = getPlayer();
    if (!p) return;
    if (p.paused) {
      p.play().catch(() => {});
      if (playPauseBtn) playPauseBtn.textContent = '\u23f8';
      startProgressTracking();
    } else {
      p.pause();
      if (playPauseBtn) playPauseBtn.textContent = '\u25b6';
      stopProgressTracking();
    }
  }

  // navigating + playGen together prevent concurrent queue advances.
  // navigating blocks new skip/prev clicks while one is in-flight.
  // playGen is incremented on every skip/prev/playSong so that stale
  // .catch() / error callbacks from interrupted plays are silently ignored.
  let navigating = false;
  let playGen    = 0;

  function skipSong() {
    if (!shuffleActive || navigating) return;
    navigating = true;
    suppressForeignPlay = true;
    playGen++;              // invalidate any in-flight start of the previous song
    stopProgressTracking();
    advanceQueue();
  }

  function prevSong() {
    if (!shuffleActive || navigating) return;
    navigating = true;
    suppressForeignPlay = true;
    playGen++;
    stopProgressTracking();
    chromeSafe(() => {
      chrome.runtime.sendMessage({ type: 'STEP_BACK' }, (resp) => {
        if (resp?.song) {
          playSong(resp.song, resp.index, resp.total);
        } else {
          navigating = false;
        }
      });
    });
  }

  // Stop = pause the current song and rewind to the beginning.
  // The queue stays intact; pressing play resumes from the start of the song.
  function stopCurrentSong() {
    if (!overlay) return;
    const p = getPlayer();
    if (p) { p.pause(); p.currentTime = 0; }
    stopProgressTracking();
    if (progressFill) progressFill.style.width = '0%';
    if (timeEl)       timeEl.textContent = '0:00';
    if (playPauseBtn) playPauseBtn.textContent = '\u25b6';
  }

  function stopShuffle() {
    shuffleActive = false;
    navigating = false;
    starting = false;
    awaitingGesture = false;
    suppressForeignPlay = false;
    playGen++;
    chromeSafe(() => chrome.storage.local.remove(AUTOPLAY_KEY));
    const p = getPlayer();
    if (p && !p.paused) p.pause();
    stopProgressTracking();
    setSpinner(false);
    currentSong = null;
    if (overlay) {
      setOverlayStatus('Shuffle stopped');
      if (counterEl)    counterEl.textContent   = '\u2014';
      if (progressFill) progressFill.style.width = '0%';
      if (timeEl)       timeEl.textContent       = '0:00';
      if (playPauseBtn) playPauseBtn.textContent  = '\u25b6';
      if (imgEl)        imgEl.src                 = '';
    }
  }

  // ─── Main start flow ───────────────────────────────────────────────────────

  async function startShuffle() {
    shuffleActive = true;
    createOverlay();
    overlay.style.display = 'block';

    const songs = await loadAllSongsFromCurrentPage();

    if (!songs || songs.length === 0) {
      setOverlayStatus('No songs found on this page.');
      shuffleActive = false;
      return { success: false, error: 'No songs found on this page. Navigate to your Liked songs on suno.com/me first.' };
    }

    setOverlayStatus(`Building queue from ${songs.length} songs\u2026`);

    return new Promise((resolve) => {
      chromeSafe(() => {
        chrome.runtime.sendMessage({ type: 'BUILD_QUEUE', songs }, (res) => {
          if (!res?.success) {
            setOverlayStatus('Error: ' + (res?.error || 'Could not build queue'));
            shuffleActive = false;
            resolve({ success: false, error: res?.error });
            return;
          }

          chrome.runtime.sendMessage({ type: 'GET_NEXT_SONG' }, (resp) => {
            if (resp?.song) {
              playSong(resp.song, resp.index, resp.total);
              resolve({ success: true, count: res.count, total: res.total });
            } else {
              setOverlayStatus('No songs to play.');
              shuffleActive = false;
              resolve({ success: false, error: 'Empty queue' });
            }
          });
        });
      });
    });
  }

  // ─── Audio events ──────────────────────────────────────────────────────────

  // Media events don't bubble, but they do pass through the capture phase \u2014 listening on
  // document keeps working even if Suno replaces its <audio> element.
  function onPlayerEvent(type, handler) {
    document.addEventListener(type, (e) => {
      if (e.target && e.target.id === PLAYER_ID) handler(e.target);
    }, true);
  }

  onPlayerEvent('ended', () => {
    if (shuffleActive && !navigating && !starting && currentSong) {
      suppressForeignPlay = true;   // block Suno's own auto-advance immediately
      advanceQueue();
    }
  });
  onPlayerEvent('pause', () => {
    if (!shuffleActive || starting) return;
    if (playPauseBtn) playPauseBtn.textContent = '\u25b6';
  });
  onPlayerEvent('play', (p) => {
    if (!shuffleActive) return;
    if (suppressForeignPlay) { p.pause(); return; }
    if (playPauseBtn) playPauseBtn.textContent = '\u23f8';
    startProgressTracking();
  });
  onPlayerEvent('volumechange', (p) => {
    if (volumeSlider && !starting) volumeSlider.value = Math.round(p.volume * 100);
  });
  onPlayerEvent('error', () => {
    if (!shuffleActive || starting) return;
    const gen = playGen;
    console.warn('[SunoShuffle] Suno player error, skipping in 1s\u2026');
    setTimeout(() => {
      // Ignore if a newer song already started (gen changed) or a skip is in-flight
      if (gen !== playGen || !shuffleActive || navigating || starting) return;
      advanceQueue();
    }, 1000);
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
            shuffleActive = true;
            createOverlay();
            overlay.style.display = 'block';
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
      if (overlay) overlay.style.display = 'none';
      sendResponse({ success: true });
    }

    if (message.type === 'CANCEL_SCAN') {
      scanCancelled = true;
      sendResponse({ success: true });
    }

    if (message.type === 'RESET_OVERLAY_POS') {
      if (overlay) {
        overlay.style.left   = '';
        overlay.style.top    = '';
        overlay.style.right  = '24px';
        overlay.style.bottom = '24px';
      }
      sendResponse({ success: true });
    }

    if (message.type === 'PING') {
      sendResponse({ active: shuffleActive, hasSong: !!currentSong });
    }
  });

  // ─── Restore overlay on page navigation ───────────────────────────────────

  chromeSafe(() => {
    chrome.storage.local.get(['queue', 'currentSong', 'queueIndex', AUTOPLAY_KEY], (data) => {
      if (!data) return;

      // A song switch turned into a full page reload: keep the shuffle going.
      const ap = data[AUTOPLAY_KEY];
      if (ap) chrome.storage.local.remove(AUTOPLAY_KEY);
      if (ap && data.currentSong && ap.id === data.currentSong.id &&
          Date.now() - ap.at < AUTOPLAY_TTL && location.pathname === `/song/${ap.id}`) {
        log('page reloaded mid-switch — resuming', ap.id);
        consecutiveFailures = ap.failures || 0;
        shuffleActive = true;
        createOverlay();
        overlay.style.display = 'block';
        playSong(data.currentSong, Math.max(0, (data.queueIndex || 1) - 1), (data.queue || []).length);
        return;
      }

      if (data.currentSong || (data.queue && data.queue.length > 0)) {
        createOverlay();
        if (data.currentSong) {
          pendingResume = true;
          if (playPauseBtn) playPauseBtn.textContent = '\u25b6';
          if (titleEl) { titleEl.textContent = data.currentSong.title + ' (paused)'; }
          if (data.queue && counterEl) counterEl.textContent = `\u2014 / ${data.queue.length}`;
          if (data.currentSong.image_url && imgEl) {
            imgEl.src = data.currentSong.image_url;
            imgEl.style.display = 'block';
          }
        }
      }
    });
  });

  // ─── Utilities ─────────────────────────────────────────────────────────────

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function storageSet(obj) {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime?.id) return resolve();
        chrome.storage.local.set(obj, () => resolve());
      } catch (e) { resolve(); }
    });
  }

})();
