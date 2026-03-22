// popup.js

const btnStart     = document.getElementById('btn-start');
const btnResume    = document.getElementById('btn-resume');
const btnReshuffle = document.getElementById('btn-reshuffle');
const btnClear     = document.getElementById('btn-clear');
const msgEl        = document.getElementById('message');
const nowTitle     = document.getElementById('now-playing-title');
const queueInfo    = document.getElementById('queue-info');

function showMsg(text, type = '') {
  msgEl.textContent = text;
  msgEl.className = type;
}

function clearMsg() {
  msgEl.textContent = '';
  msgEl.className = '';
}

function setLoading(on) {
  btnStart.disabled     = on;
  btnResume.disabled    = on;
  btnReshuffle.disabled = on;
  btnClear.disabled     = on;
}

function updateStatusUI(status) {
  if (status && status.currentSong) {
    nowTitle.textContent = status.currentSong.title;
    const played  = status.queueIndex;
    const total   = status.queueLength;
    const cycle   = status.queueCycle || 0;
    queueInfo.textContent = `Queue: ${played} / ${total}  ·  Cycle: ${cycle + 1}`;
    btnResume.disabled    = false;
    btnReshuffle.disabled = false;
  } else if (status && status.queueLength > 0) {
    nowTitle.textContent  = '—';
    queueInfo.textContent = `Queue: ${status.queueIndex} / ${status.queueLength}  ·  Cycle: ${(status.queueCycle || 0) + 1}`;
    btnResume.disabled    = false;
    btnReshuffle.disabled = false;
  } else {
    nowTitle.textContent  = '—';
    queueInfo.textContent = 'Queue: — / —  ·  Cycle: —';
    btnResume.disabled    = true;
    btnReshuffle.disabled = true;
  }
}

// Get the active suno.com tab, preferring the focused/active one
async function getSunoTab() {
  const active = await chrome.tabs.query({ active: true, url: 'https://suno.com/*' });
  if (active.length > 0) return active[0];
  const tabs = await chrome.tabs.query({ url: 'https://suno.com/*' });
  return tabs.length > 0 ? tabs[0] : null;
}

async function ensureSunoTab() {
  let tab = await getSunoTab();
  if (!tab) {
    // Open suno.com in a new tab
    tab = await chrome.tabs.create({ url: 'https://suno.com/library' });
    // Wait briefly for content script to load
    await new Promise(r => setTimeout(r, 2000));
  }
  return tab;
}

async function sendToContent(tab, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

// ── Start Shuffle ─────────────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  clearMsg();
  setLoading(true);
  showMsg('Opening Suno and loading songs…');

  try {
    const tab = await ensureSunoTab();
    await chrome.tabs.update(tab.id, { active: true });

    // Small delay to ensure content script is ready after potential navigation
    await new Promise(r => setTimeout(r, 500));

    const res = await sendToContent(tab, { type: 'START_SHUFFLE' });

    if (!res || !res.success) {
      showMsg(res?.error || 'Failed to start shuffle. Try reloading suno.com.', 'error');
    } else {
      showMsg(`Loaded ${res.count} songs (${res.total} total). Shuffling!`, 'success');
      // Refresh status
      const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      updateStatusUI(status);
    }
  } catch (e) {
    showMsg('Error: ' + e.message, 'error');
  } finally {
    setLoading(false);
  }
});

// ── Resume ────────────────────────────────────────────────────────────────────
btnResume.addEventListener('click', async () => {
  clearMsg();
  setLoading(true);
  showMsg('Resuming…');

  try {
    const tab = await ensureSunoTab();
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise(r => setTimeout(r, 400));

    const res = await sendToContent(tab, { type: 'RESUME_SHUFFLE' });
    if (res && res.success) {
      showMsg('Resumed!', 'success');
    } else {
      showMsg('Could not resume. Try Start Shuffle.', 'error');
    }
  } catch (e) {
    showMsg('Error: ' + e.message, 'error');
  } finally {
    setLoading(false);
  }
});

// ── Re-shuffle ────────────────────────────────────────────────────────────────
btnReshuffle.addEventListener('click', async () => {
  clearMsg();
  setLoading(true);
  showMsg('Re-shuffling remaining songs…');

  try {
    // Delegate entirely to the content script so FETCH_AND_SHUFFLE runs with tab context
    const tab = await ensureSunoTab();
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise(r => setTimeout(r, 400));

    const res = await sendToContent(tab, { type: 'START_SHUFFLE' });
    if (!res || !res.success) {
      showMsg(res?.error || 'Re-shuffle failed.', 'error');
    } else {
      showMsg(`Re-shuffled ${res.count} songs.`, 'success');
      const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      updateStatusUI(status);
    }
  } catch (e) {
    showMsg('Error: ' + e.message, 'error');
  } finally {
    setLoading(false);
  }
});

// ── Clear ─────────────────────────────────────────────────────────────────────
btnClear.addEventListener('click', async () => {
  if (!confirm('Clear queue and all played history? This will reset everything.')) return;

  clearMsg();
  setLoading(true);

  try {
    // Stop playback in content script if active
    const tab = await getSunoTab();
    if (tab) {
      await sendToContent(tab, { type: 'CONTENT_STOP' });
    }

    await chrome.runtime.sendMessage({ type: 'CLEAR_QUEUE' });
    showMsg('Queue and history cleared.', 'success');
    updateStatusUI(null);
  } catch (e) {
    showMsg('Error: ' + e.message, 'error');
  } finally {
    setLoading(false);
  }
});

// ── Init: load current status ─────────────────────────────────────────────────
(async () => {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    updateStatusUI(status);
  } catch {
    // Background not ready yet
  }
})();
