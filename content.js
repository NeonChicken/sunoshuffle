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

  // ─── State ─────────────────────────────────────────────────────────────────
  let audio = new Audio();
  audio.preload = 'auto';

  let shuffleActive = false;
  let currentSong   = null;
  let progressInterval = null;
  let overlayMinimized = false;
  let scanCancelled = false;

  // ─── DOM References (overlay) ──────────────────────────────────────────────
  let overlay, titleEl, counterEl, imgEl, progressFill, timeEl, playPauseBtn, spinnerEl;

  // ─── DOM Scraping ──────────────────────────────────────────────────────────

  function scrapeVisibleSongs(accumulator) {
    // Strategy 1: elements with data-clip-id attribute (most precise)
    document.querySelectorAll('[data-clip-id]').forEach(el => {
      const id = el.getAttribute('data-clip-id');
      if (!id || accumulator.has(id)) return;
      const title = extractTitle(el) || `Song ${id.slice(0, 8)}`;
      const image_url = extractImage(el, id);
      accumulator.set(id, { id, title, audio_url: `https://cdn1.suno.ai/${id}.mp3`, image_url });
    });

    // Strategy 2: anchor links pointing to /song/{uuid}
    document.querySelectorAll('a[href*="/song/"]').forEach(a => {
      const m = a.href.match(/\/song\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (!m) return;
      const id = m[1];
      if (accumulator.has(id)) return;
      const container = a.closest('[data-clip-id]') || a.closest('li') || a.closest('[role="row"]') || a.parentElement;
      const title = (container ? extractTitle(container) : null) || `Song ${id.slice(0, 8)}`;
      const image_url = container ? extractImage(container, id) : null;
      accumulator.set(id, { id, title, audio_url: `https://cdn1.suno.ai/${id}.mp3`, image_url });
    });

    // Strategy 3: CDN thumbnail images whose src contains a UUID
    document.querySelectorAll('img[src*="suno"]').forEach(img => {
      const m = (img.src || '').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (!m) return;
      const id = m[1];
      if (accumulator.has(id)) return;
      const container = img.closest('[data-clip-id]') || img.closest('li') || img.closest('[role="row"]') || img.parentElement;
      const title = (container ? extractTitle(container) : null) || `Song ${id.slice(0, 8)}`;
      accumulator.set(id, { id, title, audio_url: `https://cdn1.suno.ai/${id}.mp3`, image_url: img.src });
    });
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
    if (!container) return `https://cdn2.suno.ai/image_${id}.jpeg`;
    const img = container.querySelector('img');
    return img?.src || `https://cdn2.suno.ai/image_${id}.jpeg`;
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

    // Restore position / minimized state
    chromeSafe(() => {
      chrome.storage.local.get(['overlayPos', 'overlayMinimized'], (data) => {
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
      });
    });

    overlay.querySelector('#ss-minimize').addEventListener('click', toggleMinimize);
    overlay.querySelector('#ss-play-pause').addEventListener('click', togglePlayPause);
    overlay.querySelector('#ss-skip').addEventListener('click', skipSong);
    overlay.querySelector('#ss-stop').addEventListener('click', stopCurrentSong);
    overlay.querySelector('#ss-prev').addEventListener('click', prevSong);
    overlay.querySelector('#ss-progress-bar').addEventListener('click', seekTo);
    overlay.querySelector('#ss-cancel-scan').addEventListener('click', () => { scanCancelled = true; });

    makeDraggable(overlay, overlay.querySelector('#ss-header'));
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
    if (!audio.duration) return;
    const ratio = audio.currentTime / audio.duration;
    if (progressFill) progressFill.style.width = (ratio * 100) + '%';
    if (timeEl) timeEl.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration);
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
    if (!audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
  }

  // ─── Playback ──────────────────────────────────────────────────────────────

  function pauseSunoNativePlayer() {
    document.querySelectorAll('audio').forEach(el => {
      if (el !== audio && !el.paused) el.pause();
    });
  }

  function playSong(song, index, total) {
    navigating = false;
    const gen = ++playGen;   // every new song gets a unique generation
    currentSong = song;
    setSpinner(true);
    setCurrentSongUI(song, index, total);

    audio.src = song.audio_url;
    audio.load();
    audio.play()
      .then(() => {
        if (gen !== playGen) return;   // a newer song already took over
        setSpinner(false); startProgressTracking(); pauseSunoNativePlayer();
      })
      .catch(() => {
        if (gen !== playGen) return;   // skip aborted this play() — not a real failure
        setSpinner(false);
        const alt = song.audio_url.replace('cdn1.suno.ai', 'cdn2.suno.ai');
        if (audio.src !== alt) {
          audio.src = alt;
          audio.play()
            .then(() => { if (gen === playGen) { startProgressTracking(); pauseSunoNativePlayer(); } })
            .catch(() => {
              if (gen !== playGen) return;
              console.warn('[SunoShuffle] Skipping unplayable song'); advanceQueue();
            });
        } else {
          advanceQueue();
        }
      });
  }

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
    if (!shuffleActive) return;
    if (audio.paused) {
      audio.play(); if (playPauseBtn) playPauseBtn.textContent = '\u23f8'; startProgressTracking();
    } else {
      audio.pause(); if (playPauseBtn) playPauseBtn.textContent = '\u25b6'; stopProgressTracking();
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
    playGen++;              // invalidate any pending .catch() from the paused song
    audio.pause();
    stopProgressTracking();
    advanceQueue();
  }

  function prevSong() {
    if (!shuffleActive || navigating) return;
    navigating = true;
    playGen++;
    audio.pause();
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
    audio.pause();
    audio.currentTime = 0;
    stopProgressTracking();
    if (progressFill) progressFill.style.width = '0%';
    if (timeEl)       timeEl.textContent = '0:00';
    if (playPauseBtn) playPauseBtn.textContent = '\u25b6';
  }

  function stopShuffle() {
    shuffleActive = false;
    navigating = false;
    audio.pause(); audio.src = '';
    stopProgressTracking();
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

  audio.addEventListener('ended',  () => { if (shuffleActive && !navigating) advanceQueue(); });
  audio.addEventListener('pause',  () => { if (playPauseBtn) playPauseBtn.textContent = '\u25b6'; });
  audio.addEventListener('play',   () => { if (playPauseBtn) playPauseBtn.textContent = '\u23f8'; });
  audio.addEventListener('error',  () => {
    if (!shuffleActive) return;
    const gen = playGen;
    console.warn('[SunoShuffle] Audio error, skipping in 1s\u2026');
    setTimeout(() => {
      // Ignore if a newer song already started (gen changed) or a skip is in-flight
      if (gen !== playGen || !shuffleActive || navigating) return;
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
    chrome.storage.local.get(['queue', 'currentSong'], (data) => {
      if (!data) return;
      if (data.currentSong || (data.queue && data.queue.length > 0)) {
        createOverlay();
        if (data.currentSong && titleEl) {
          titleEl.textContent = data.currentSong.title + ' (paused)';
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

})();
