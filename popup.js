// popup.js — YT Channel Volume

(() => {
  'use strict';

  // Apply data-i18n attributes
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = msg(el.dataset.i18n);
  });

  const channelNameEl = document.getElementById('channelName');
  const videoTypeBadge = document.getElementById('videoTypeBadge');
  const contentLufsEl = document.getElementById('contentLufs');
  const suggestedVolEl = document.getElementById('suggestedVol');
  const currentVolEl = document.getElementById('currentVol');
  const applyBtn = document.getElementById('applyBtn');
  const applyHint = document.getElementById('applyHint');
  const volumeSlider = document.getElementById('volumeSlider');
  const volumeValueEl = document.getElementById('volumeValue');
  const settingsBtn = document.getElementById('settingsBtn');
  const mainEl = document.getElementById('main');
  const notWatchEl = document.getElementById('notWatch');
  const notYtEl = document.getElementById('notYt');

  let currentChannel = { id: '', name: '' };
  let activeTabId = null;
  let hasLoudness = false;
  let currentLoudnessDb = null;
  let currentTargetLufs = DEFAULT_TARGET_LUFS;
  let lastGain = 1.0;
  let displayUnit = '%';
  let currentVideoType = 'video';

  function fmtGain(gain) { return formatGain(gain, displayUnit); }

  // Use shared calcGain from utils.js

  function setCardValue(el, text, unitText, extraClass) {
    el.innerHTML = '';
    el.classList.remove('unknown');
    if (extraClass) el.className = 'value ' + extraClass;
    el.textContent = text;
    if (unitText) {
      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = unitText;
      el.appendChild(unit);
    }
  }

  function setUnknown(el, extraClass) {
    el.textContent = '---';
    el.className = 'value ' + (extraClass || '') + ' unknown';
  }

  // ── UI refresh ─────────────────────────────────────────────────────

  function refreshDisplay() {
    if (hasLoudness) {
      const contentLufs = YT_REFERENCE_LUFS + currentLoudnessDb;
      setCardValue(contentLufsEl, contentLufs.toFixed(1), ' LUFS');
    } else {
      setUnknown(contentLufsEl);
    }

    if (hasLoudness) {
      const sg = calcGain(currentLoudnessDb, currentTargetLufs);
      const f = fmtGain(sg);
      setCardValue(suggestedVolEl, f.text, f.unit, 'suggested');
    } else {
      setUnknown(suggestedVolEl, 'suggested');
    }

    const fc = fmtGain(lastGain);
    setCardValue(currentVolEl, fc.text, fc.unit, 'current');

    volumeSlider.value = gainToPercent(lastGain);
    const fv = fmtGain(lastGain);
    volumeValueEl.textContent = fv.text + fv.unit;

    updateApplyBtn();
  }

  function updateUI(state) {
    if (state.channel?.id) {
      currentChannel = state.channel;
      channelNameEl.textContent = state.channel.name;
      channelNameEl.classList.remove('empty');
    }

    hasLoudness = state.contentLufs !== null && state.contentLufs !== undefined;
    currentLoudnessDb = state.loudnessDb;
    lastGain = state.gain ?? 1.0;
    currentVideoType = state.videoType || 'video';

    if (state.targetLufs !== undefined) {
      currentTargetLufs = state.targetLufs;
    }

    // LIVE badge: only shown for currently active live streams
    if (state.isLiveNow) {
      videoTypeBadge.textContent = msg('typeLive');
      videoTypeBadge.className = 'type-badge live';
      videoTypeBadge.style.display = '';
    } else {
      videoTypeBadge.style.display = 'none';
    }

    refreshDisplay();
  }

  function updateApplyBtn() {
    if (hasLoudness && currentChannel.id) {
      const sg = calcGain(currentLoudnessDb, currentTargetLufs);
      const f = fmtGain(sg);
      const typeLabel = currentVideoType === 'live' ? msg('typeLive') : msg('typeVideo');
      applyBtn.disabled = false;
      applyBtn.textContent = msg('applyToChannelWithValue', [f.text + f.unit]) + ' (' + typeLabel + ')';
      applyHint.textContent = '';
    } else if (!currentChannel.id) {
      applyBtn.disabled = true;
      applyBtn.textContent = msg('applyToChannel');
      applyHint.textContent = msg('hintNoChannel');
    } else {
      applyBtn.disabled = true;
      applyBtn.textContent = msg('applyToChannel');
      applyHint.textContent = msg('hintNoLoudness');
    }
  }

  // ── Send messages to content script ────────────────────────────────

  function sendMsg(msg) {
    if (!activeTabId) return Promise.reject();
    return chrome.tabs.sendMessage(activeTabId, msg);
  }

  // ── Event handlers ─────────────────────────────────────────────────

  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  applyBtn.addEventListener('click', () => {
    sendMsg({ type: 'applyLoudness' }).then(resp => {
      if (resp?.ok) {
        sendMsg({ type: 'getState' }).then(state => {
          if (state) updateUI(state);
        }).catch(() => {});
      }
    }).catch(() => {});
  });

  // input: real-time gain change (no storage write)
  volumeSlider.addEventListener('input', () => {
    const pct = Number(volumeSlider.value);
    const gain = percentToGain(pct);
    lastGain = gain;
    const f = fmtGain(gain);
    volumeValueEl.textContent = f.text + f.unit;
    setCardValue(currentVolEl, f.text, f.unit, 'current');
    if (currentChannel.id) {
      sendMsg({
        type: 'setGainLive',
        gain
      }).catch(() => {});
    }
  });

  // change: save to storage on slider release
  volumeSlider.addEventListener('change', () => {
    if (currentChannel.id) {
      sendMsg({
        type: 'setGain',
        channelId: currentChannel.id,
        name: currentChannel.name,
        gain: lastGain
      }).catch(() => {});
    }
  });

  document.querySelectorAll('.presets button').forEach(btn => {
    btn.addEventListener('click', () => {
      const pct = Number(btn.dataset.vol);
      const gain = percentToGain(pct);
      lastGain = gain;
      volumeSlider.value = pct;
      const f = fmtGain(gain);
      volumeValueEl.textContent = f.text + f.unit;
      setCardValue(currentVolEl, f.text, f.unit, 'current');
      if (currentChannel.id) {
        sendMsg({
          type: 'setGain',
          channelId: currentChannel.id,
          name: currentChannel.name,
          gain
        }).catch(() => {});
      }
    });
  });

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type === 'stateChanged' && sender.tab?.id === activeTabId) {
      updateUI(msg);
    }
  });

  // ── Init ───────────────────────────────────────────────────────────

  async function init() {
    // Load display unit preference
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    displayUnit = data[SETTINGS_KEY]?.displayUnit || '%';

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url?.includes('youtube.com')) {
      mainEl.style.display = 'none';
      notYtEl.style.display = '';
      return;
    }

    activeTabId = tab.id;

    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'forceDetect' });
      if (resp) {
        if (!resp.isWatchPage) {
          mainEl.style.display = 'none';
          notWatchEl.style.display = '';
          return;
        }
        updateUI(resp);
        if (resp.contentLufs === null || resp.contentLufs === undefined) {
          retryGetState(8, 500);
        }
      }
    } catch (_) {
      channelNameEl.textContent = msg('channelNotDetected');
      channelNameEl.classList.add('empty');
    }
  }

  function retryGetState(remaining, intervalMs) {
    if (remaining <= 0 || hasLoudness) return;
    setTimeout(async () => {
      if (hasLoudness) return; // stateChanged already delivered loudness
      try {
        const resp = await chrome.tabs.sendMessage(activeTabId, { type: 'getState' });
        if (resp) {
          updateUI(resp);
          if (!hasLoudness && remaining > 1) {
            retryGetState(remaining - 1, intervalMs);
          }
        }
      } catch (_) {}
    }, intervalMs);
  }

  init();
})();
