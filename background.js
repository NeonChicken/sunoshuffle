// background.js — Service worker: queue management only (no API calls)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeTitle(title) {
  return (title || '')
    .replace(/\s*\((Edit|FAV|ULTRAFAV)\)\s*/gi, '')
    .trim()
    .toLowerCase();
}

function fisherYatesShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Shuffle with constraint: no two consecutive songs share the same normalized title.
 */
function constrainedShuffle(songs) {
  if (songs.length <= 1) return [...songs];
  let arr = fisherYatesShuffle(songs);

  for (let pass = 0; pass < 20; pass++) {
    let collisionFound = false;
    for (let i = 1; i < arr.length; i++) {
      const prevNorm = normalizeTitle(arr[i - 1].title);
      const currNorm = normalizeTitle(arr[i].title);
      if (currNorm !== prevNorm) continue;

      collisionFound = true;
      let swapped = false;
      const afterINorm = i + 1 < arr.length ? normalizeTitle(arr[i + 1].title) : null;

      for (let j = i + 1; j < arr.length; j++) {
        const jNorm      = normalizeTitle(arr[j].title);
        const beforeJNorm = normalizeTitle(arr[j - 1].title);
        const afterJNorm  = j + 1 < arr.length ? normalizeTitle(arr[j + 1].title) : null;

        const jFitsAtI = jNorm !== prevNorm && (afterINorm === null || jNorm !== afterINorm);
        const iFitsAtJ = currNorm !== beforeJNorm && (afterJNorm === null || currNorm !== afterJNorm);

        if (jFitsAtI && iFitsAtJ) {
          [arr[i], arr[j]] = [arr[j], arr[i]];
          swapped = true;
          break;
        }
      }

      if (!swapped) {
        for (let j = 0; j < i - 1; j++) {
          const jNorm       = normalizeTitle(arr[j].title);
          const afterJNorm  = normalizeTitle(arr[j + 1].title);
          const beforeJNorm = j > 0 ? normalizeTitle(arr[j - 1].title) : null;
          if (jNorm !== prevNorm && (afterINorm === null || jNorm !== afterINorm) &&
              currNorm !== (beforeJNorm || '') && currNorm !== afterJNorm) {
            [arr[i], arr[j]] = [arr[j], arr[i]];
            break;
          }
        }
      }
    }
    if (!collisionFound) break;
  }

  return arr;
}

// ─── Message handlers ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  // ── BUILD_QUEUE — called by content script after DOM scraping ─────────────
  if (message.type === 'BUILD_QUEUE') {
    (async () => {
      const allSongs = message.songs || [];
      if (allSongs.length === 0) {
        sendResponse({ success: false, error: 'No songs were found in the DOM.' });
        return;
      }

      const stored = await chrome.storage.local.get(['playedIds', 'queueCycle']);
      const playedIds = new Set(stored.playedIds || []);
      const queueCycle = stored.queueCycle || 0;

      let unplayed = allSongs.filter(s => !playedIds.has(s.id));
      if (unplayed.length === 0) {
        unplayed = allSongs;
        await chrome.storage.local.set({ playedIds: [], queueCycle: queueCycle + 1 });
      }

      const queue = constrainedShuffle(unplayed);

      await chrome.storage.local.set({
        queue,
        songsPool: allSongs,
        queueIndex: 0,
        totalSongs: allSongs.length,
        lastUpdated: Date.now(),
      });

      sendResponse({ success: true, count: queue.length, total: allSongs.length });
    })();
    return true;
  }

  // ── RESHUFFLE_STORED — reshuffle the same song list for a new cycle ────────
  if (message.type === 'RESHUFFLE_STORED') {
    (async () => {
      const stored = await chrome.storage.local.get(['songsPool', 'queueCycle']);
      const allSongs = stored.songsPool || [];

      if (allSongs.length === 0) {
        sendResponse({ done: true });
        return;
      }

      const queueCycle = (stored.queueCycle || 0) + 1;
      const queue = constrainedShuffle(allSongs);

      await chrome.storage.local.set({
        queue,
        queueIndex: 1,          // we immediately hand out index 0
        playedIds: [queue[0].id],
        currentSong: queue[0],
        queueCycle,
      });

      sendResponse({ song: queue[0], index: 0, total: queue.length });
    })();
    return true;
  }

  // ── GET_NEXT_SONG ─────────────────────────────────────────────────────────
  if (message.type === 'GET_NEXT_SONG') {
    (async () => {
      const stored = await chrome.storage.local.get(['queue', 'queueIndex', 'playedIds']);
      const queue = stored.queue || [];
      const index = stored.queueIndex || 0;

      if (index >= queue.length) {
        sendResponse({ done: true });
        return;
      }

      const song = queue[index];
      const playedIds = stored.playedIds || [];
      if (!playedIds.includes(song.id)) playedIds.push(song.id);

      await chrome.storage.local.set({ queueIndex: index + 1, playedIds, currentSong: song });
      sendResponse({ song, index, total: queue.length });
    })();
    return true;
  }

  // ── GET_STATUS ────────────────────────────────────────────────────────────
  if (message.type === 'GET_STATUS') {
    (async () => {
      const stored = await chrome.storage.local.get(['queue', 'queueIndex', 'currentSong', 'totalSongs', 'queueCycle']);
      sendResponse({
        queueLength: (stored.queue || []).length,
        queueIndex: stored.queueIndex || 0,
        currentSong: stored.currentSong || null,
        totalSongs: stored.totalSongs || 0,
        queueCycle: stored.queueCycle || 0,
      });
    })();
    return true;
  }

  // ── CLEAR_QUEUE ───────────────────────────────────────────────────────────
  if (message.type === 'CLEAR_QUEUE') {
    chrome.storage.local.remove(
      ['queue', 'songsPool', 'queueIndex', 'playedIds', 'currentSong', 'totalSongs', 'queueCycle', 'lastUpdated'],
      () => sendResponse({ success: true })
    );
    return true;
  }

  // ── STEP_BACK ─────────────────────────────────────────────────────────────
  if (message.type === 'STEP_BACK') {
    (async () => {
      const stored = await chrome.storage.local.get(['queue', 'queueIndex', 'playedIds']);
      const queue = stored.queue || [];
      const index = stored.queueIndex || 0;

      const targetIndex = Math.max(0, index - 2);
      const song = queue[targetIndex] || null;

      let playedIds = stored.playedIds || [];
      playedIds = playedIds.slice(0, Math.max(0, playedIds.length - 2));

      await chrome.storage.local.set({ queueIndex: targetIndex + 1, playedIds, currentSong: song });
      sendResponse({ song, index: targetIndex, total: queue.length });
    })();
    return true;
  }
});
