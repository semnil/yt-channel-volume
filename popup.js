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
  const fallbackBadge = document.getElementById('fallbackBadge');
  const applyBtn = document.getElementById('applyBtn');
  const applyHint = document.getElementById('applyHint');
  const autoVideoControl = document.getElementById('autoVideoControl');
  const autoLiveControl = document.getElementById('autoLiveControl');
  const autoApplyVideoToggle = document.getElementById('autoApplyVideoToggle');
  const autoApplyLiveToggle = document.getElementById('autoApplyLiveToggle');
  const volumeSlider = document.getElementById('volumeSlider');
  const presetButtons = document.querySelectorAll('.presets button');
  const volumeValueEl = document.getElementById('volumeValue');
  const settingsBtn = document.getElementById('settingsBtn');
  const mainEl = document.getElementById('main');
  const notWatchEl = document.getElementById('notWatch');
  const notYtEl = document.getElementById('notYt');
  const reloadNeededEl = document.getElementById('reloadNeeded');

  let currentChannel = { id: '', name: '' };
  // What the state on screen was when it was drawn. It goes back with every
  // gesture, so a gesture made against a state the tab has left is refused
  // rather than applied to the one that replaced it.
  let currentAppliesTo = '';
  let activeTabId = null;
  let hasLoudness = false;
  let currentLoudnessDb = null;
  let currentTargetLufs = DEFAULT_TARGET_LUFS;
  let lastGain = 1.0;
  let displayUnit = '%';
  let currentVideoType = 'video';
  let autoApplyLoudnessVideo = false;
  let autoApplyLoudnessLive = false;

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
    const autoApplyCurrentType = currentVideoType === 'live'
      ? autoApplyLoudnessLive
      : autoApplyLoudnessVideo;
    fallbackBadge.style.display = autoApplyCurrentType && !hasLoudness ? '' : 'none';
    const manualGainLocked = isManualGainLocked(autoApplyCurrentType, hasLoudness);
    volumeSlider.disabled = manualGainLocked;
    presetButtons.forEach(btn => { btn.disabled = manualGainLocked; });

    volumeSlider.value = gainToPercent(lastGain);
    const fv = fmtGain(lastGain);
    volumeValueEl.textContent = fv.text + fv.unit;

    updateApplyBtn();
  }

  function updateUI(state) {
    if (state.channel?.id) {
      currentChannel = state.channel;
      currentAppliesTo = state.appliesTo || '';
      channelNameEl.textContent = state.channel.name;
      channelNameEl.classList.remove('empty');
    } else {
      currentChannel = { id: '', name: '' };
      currentAppliesTo = '';
      channelNameEl.textContent = msg('channelNotDetected');
      channelNameEl.classList.add('empty');
    }

    hasLoudness = state.contentLufs !== null && state.contentLufs !== undefined;
    currentLoudnessDb = state.loudnessDb;
    lastGain = state.gain ?? 1.0;
    currentVideoType = state.videoType || 'video';
    autoApplyLoudnessVideo = !!state.autoApplyLoudnessVideo;
    autoApplyLoudnessLive = !!state.autoApplyLoudnessLive;
    autoApplyVideoToggle.checked = autoApplyLoudnessVideo;
    autoApplyLiveToggle.checked = autoApplyLoudnessLive;
    const isLive = currentVideoType === 'live';
    autoVideoControl.style.display = isLive ? 'none' : '';
    autoLiveControl.style.display = isLive ? '' : 'none';
    autoApplyVideoToggle.disabled = !currentChannel.id || isLive;
    autoApplyLiveToggle.disabled = !currentChannel.id || !isLive;

    if (state.targetLufs !== undefined) {
      currentTargetLufs = state.targetLufs;
    }

    // LIVE badge: premieres have isLiveNow=true but videoType='video'
    if (state.isLiveNow && state.videoType === 'live') {
      videoTypeBadge.textContent = msg('typeLive');
      videoTypeBadge.className = 'type-badge live';
      videoTypeBadge.style.display = '';
    } else {
      videoTypeBadge.style.display = 'none';
    }

    refreshDisplay();
  }

  function updateApplyBtn() {
    const autoApplyCurrentType = currentVideoType === 'live'
      ? autoApplyLoudnessLive
      : autoApplyLoudnessVideo;
    if (autoApplyCurrentType && currentChannel.id) {
      applyBtn.disabled = true;
      applyBtn.textContent = msg('applyToChannel');
      applyHint.textContent = msg('hintAutoApplyEnabled');
    } else if (hasLoudness && currentChannel.id) {
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

  function sendManualGain(msg) {
    sendMsg(msg).then(resp => {
      if (resp?.ok) return;
      sendMsg({ type: 'getState' }).then(state => {
        if (state) updateUI(state);
      }).catch(() => {});
    }).catch(() => {});
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

  function resyncFromContent(toggle, videoType) {
    sendMsg({ type: 'getState' }).then(state => {
      if (state) {
        updateUI(state);
        return;
      }
      toggle.checked = videoType === 'live'
        ? autoApplyLoudnessLive
        : autoApplyLoudnessVideo;
      toggle.disabled = !currentChannel.id || currentVideoType !== videoType;
    }).catch(() => {
      toggle.checked = videoType === 'live'
        ? autoApplyLoudnessLive
        : autoApplyLoudnessVideo;
      toggle.disabled = !currentChannel.id || currentVideoType !== videoType;
    });
  }

  function handleAutoApplyChange(toggle, videoType) {
    if (!currentChannel.id || videoType !== currentVideoType) return;
    const enabled = toggle.checked;
    toggle.disabled = true;
    sendMsg({
      type: 'setAutoApplyLoudness',
      appliesTo: currentAppliesTo,
      enabled
    }).then(resp => {
      if (resp?.ok) {
        updateUI(resp);
      } else {
        // The write may have landed before the failure, so show what the page
        // holds rather than assuming the toggle never moved.
        resyncFromContent(toggle, videoType);
      }
    }).catch(() => {
      resyncFromContent(toggle, videoType);
    });
  }

  autoApplyVideoToggle.addEventListener('change', () => {
    handleAutoApplyChange(autoApplyVideoToggle, 'video');
  });

  autoApplyLiveToggle.addEventListener('change', () => {
    handleAutoApplyChange(autoApplyLiveToggle, 'live');
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
      sendManualGain({
        type: 'setGainLive',
        appliesTo: currentAppliesTo,
        gain
      });
    }
  });

  // change: save to storage on slider release
  volumeSlider.addEventListener('change', () => {
    if (currentChannel.id) {
      sendManualGain({
        type: 'setGain',
        appliesTo: currentAppliesTo,
        gain: lastGain
      });
    }
  });

  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const pct = Number(btn.dataset.vol);
      const gain = percentToGain(pct);
      lastGain = gain;
      volumeSlider.value = pct;
      const f = fmtGain(gain);
      volumeValueEl.textContent = f.text + f.unit;
      setCardValue(currentVolEl, f.text, f.unit, 'current');
      if (currentChannel.id) {
        sendManualGain({
          type: 'setGain',
          appliesTo: currentAppliesTo,
          gain
        });
      }
    });
  });

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type === 'stateChanged' && sender.tab?.id === activeTabId) {
      updateUI(msg);
    }
  });

  // ── Init ───────────────────────────────────────────────────────────

  function revealPopup() {
    // Commit the checked states while transitions are disabled, then reveal
    // the fully initialized popup on the next frame.
    void document.body.offsetWidth;
    requestAnimationFrame(() => {
      document.body.classList.remove('initializing');
    });
  }

  async function init() {
    try {
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
        // sendMessage rejects when content.js is unreachable. The most common
        // cause is runtime context invalidation: when this or another extension
        // is reloaded, existing tabs' content scripts lose their chrome.runtime
        // connection. The page must be reloaded for content.js to be re-injected.
        mainEl.style.display = 'none';
        reloadNeededEl.style.display = '';
      }
    } finally {
      revealPopup();
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
