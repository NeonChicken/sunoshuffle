// popup.js

const LIKED_URL = 'https://suno.com/playlist/liked';

// DEV tag for unpacked installs (never shown in the Web Store build)
chrome.management.getSelf().then((self) => {
  if (self.installType !== 'development') return;
  const tag = document.createElement('span');
  tag.className = 'dev-tag';
  tag.textContent = 'DEV';
  document.getElementById('app-name').appendChild(tag);
}).catch(() => {});

const $ = (id) => document.getElementById(id);
const btnStart      = $('btn-start');
const btnResume     = $('btn-resume');
const btnCancelScan = $('btn-cancel-scan');
const btnResetPos   = $('btn-reset-pos');
const btnClear      = $('btn-clear');
const msgEl         = $('message');

let sunoTab = null;   // the Suno tab we act on (active one preferred)

function showMsg(text, type = '') {
  msgEl.textContent = text;
  msgEl.className = type;
}

function clearMsg() { showMsg(''); }

function setBusy(on) {
  btnStart.disabled = on;
  btnResume.disabled = on;
  btnClear.disabled = on;
}

function pageName(tab) {
  if (!tab) return null;
  const t = (tab.title || '')
    .replace(/\s*\|\s*Suno\s*$/i, '')
    .replace(/\s+by\s+@\S+$/i, '')
    .trim();
  return t || new URL(tab.url).pathname;
}

function updateStatusUI(status) {
  const has = !!(status && status.currentSong);
  $('now-label').textContent = has ? (status.sourceName ? `Shuffling ${status.sourceName}` : 'Last played') : 'Nothing queued yet';
  $('now-title').textContent = has ? status.currentSong.title : '';
  $('now-meta').textContent = has
    ? `${Math.max(1, status.queueIndex)} of ${status.queueLength}  ·  cycle ${(status.queueCycle || 0) + 1}`
    : 'Open a playlist and press Shuffle';
  const art = $('now-art');
  if (has && status.currentSong.image_url) {
    art.src = status.currentSong.image_url;
    art.hidden = false;
  } else {
    art.hidden = true;
  }
  btnResume.hidden = !has;
}

async function findSunoTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && /^https:\/\/suno\.com\//.test(active.url || '')) return active;
  const tabs = await chrome.tabs.query({ url: 'https://suno.com/*' });
  return tabs[0] || null;
}

function updateTargetUI() {
  if (sunoTab) {
    $('target-label').hidden = false;
    $('target-label').textContent = 'Page';
    $('target-name').textContent = pageName(sunoTab);
    btnStart.textContent = 'Shuffle this page';
  } else {
    $('target-label').hidden = true;
    $('target-name').textContent = 'Suno isn’t open in this window.';
    btnStart.textContent = 'Open your Liked songs';
  }
}

function sendToContent(tab, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      resolve(chrome.runtime.lastError ? undefined : response);
    });
  });
}

const UNREACHABLE = 'Can’t reach the Suno tab. Refresh it (F5) and try again.';

async function focusTab(tab) {
  // Switching tabs closes this popup, so only do it when the Suno tab isn't already in front.
  if (tab.active) return;
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
}

// ── Shuffle this page ─────────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  clearMsg();

  if (!sunoTab) {
    await chrome.tabs.create({ url: LIKED_URL });
    window.close();
    return;
  }

  setBusy(true);
  btnCancelScan.hidden = false;
  btnCancelScan.onclick = () => sendToContent(sunoTab, { type: 'CANCEL_SCAN' });
  showMsg('Scanning the page…');

  try {
    await focusTab(sunoTab);
    const res = await sendToContent(sunoTab, { type: 'START_SHUFFLE' });
    if (res === undefined) {
      showMsg(UNREACHABLE, 'error');
    } else if (!res || !res.success) {
      showMsg(res?.error || 'Couldn’t start the shuffle.', 'error');
    } else {
      showMsg(`Shuffling ${res.count} songs`, 'success');
      updateStatusUI(await chrome.runtime.sendMessage({ type: 'GET_STATUS' }));
    }
  } catch (e) {
    showMsg('Error: ' + e.message, 'error');
  } finally {
    btnCancelScan.hidden = true;
    setBusy(false);
  }
});

// ── Resume ────────────────────────────────────────────────────────────────────
btnResume.addEventListener('click', async () => {
  clearMsg();
  if (!sunoTab) {
    await chrome.tabs.create({ url: LIKED_URL });
    window.close();
    return;
  }
  setBusy(true);
  try {
    await focusTab(sunoTab);
    const res = await sendToContent(sunoTab, { type: 'RESUME_SHUFFLE' });
    if (res === undefined) showMsg(UNREACHABLE, 'error');
    else if (res && res.success) window.close();
    else showMsg('Couldn’t resume. Try Shuffle this page.', 'error');
  } catch (e) {
    showMsg('Error: ' + e.message, 'error');
  } finally {
    setBusy(false);
  }
});

// ── Reset player position ─────────────────────────────────────────────────────
btnResetPos.addEventListener('click', async () => {
  clearMsg();
  await chrome.storage.local.remove('overlayPos');
  if (sunoTab) await sendToContent(sunoTab, { type: 'RESET_OVERLAY_POS' });
  showMsg('Player moved back to the corner.', 'success');
});

// ── Clear history ─────────────────────────────────────────────────────────────
btnClear.addEventListener('click', async () => {
  if (!confirm('Clear the queue and play history? The next shuffle starts fresh.')) return;
  clearMsg();
  setBusy(true);
  try {
    if (sunoTab) await sendToContent(sunoTab, { type: 'CONTENT_STOP' });
    await chrome.runtime.sendMessage({ type: 'CLEAR_QUEUE' });
    showMsg('Queue and history cleared.', 'success');
    updateStatusUI(null);
  } catch (e) {
    showMsg('Error: ' + e.message, 'error');
  } finally {
    setBusy(false);
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  sunoTab = await findSunoTab();
  updateTargetUI();
  try {
    updateStatusUI(await chrome.runtime.sendMessage({ type: 'GET_STATUS' }));
  } catch {
    updateStatusUI(null);
  }
})();
