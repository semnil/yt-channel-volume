// popup.js — YT Channel Volume

(() => {
  'use strict';

  applyI18n();

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
  // The display is redrawn whenever content.js says its state moved, and a
  // gesture takes longer than that: the viewer takes hold of the slider, the
  // video changes, the viewer lets go. A gesture is made against the state
  // that was on screen when it began, so it takes a copy then and carries that
  // one to every message it sends — the previews during the drag as well as
  // the save at the end. Read at send time instead, the drag would move the
  // level of the video it moved to and save its gain under it.
  let sliderAppliesTo = null;
  let activeTabId = null;
  let hasLoudness = false;
  let currentLoudnessDb = null;
  // A live stream's own level, where the player names one; it goes before the
  // response's level.
  let currentLiveLkfs = null;
  let currentContentLufs = null;
  let currentTargetLufs = DEFAULT_TARGET_LUFS;
  let lastGain = 1.0;
  let displayUnit = '%';
  let currentVideoType = 'video';
  let autoApplyLoudnessVideo = false;
  let autoApplyLoudnessLive = false;
  // The last save the viewer asked for did not land (createSaveNotice in
  // core/common.js). It stands until a save lands or the tab is on another
  // channel or type.
  const saveNotice = createSaveNotice();

  function fmtGain(gain) { return formatGain(gain, displayUnit); }

  // Use shared calcGain / calcLiveGain from utils.js
  function suggestedGain() {
    return currentLiveLkfs !== null
      ? calcLiveGain(currentLiveLkfs, currentTargetLufs)
      : calcGain(currentLoudnessDb, currentTargetLufs);
  }

  // ── UI refresh ─────────────────────────────────────────────────────

  function refreshDisplay() {
    if (hasLoudness) {
      setCardValue(contentLufsEl, currentContentLufs.toFixed(1), ' LUFS');
    } else {
      setUnknown(contentLufsEl);
    }

    if (hasLoudness) {
      const f = fmtGain(suggestedGain());
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
    volumeValueEl.textContent = formatGainText(lastGain, displayUnit);

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
    currentLiveLkfs = Number.isFinite(state.liveLkfs) ? state.liveLkfs : null;
    currentContentLufs = hasLoudness ? state.contentLufs : null;
    lastGain = state.gain ?? 1.0;
    currentVideoType = state.videoType || 'video';
    saveNotice.showOwner(currentChannel.id ? currentChannel.id + '|' + currentVideoType : '');
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

    liveLevelWanted = !!state.isLiveNow || currentLiveLkfs !== null;
    askLiveLevelLater();

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
      const typeLabel = currentVideoType === 'live' ? msg('typeLive') : msg('typeVideo');
      applyBtn.disabled = false;
      applyBtn.textContent = msg('applyToChannelWithValue', [formatGainText(suggestedGain(), displayUnit)]) + ' (' + typeLabel + ')';
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
    // The save failure is the viewer's own last action, so it takes the hint's
    // place.
    saveNotice.draw(applyHint);
  }

  // ── Send messages to content script ────────────────────────────────

  function sendMsg(msg) {
    return sendTabMessage(activeTabId, msg);
  }

  function readState() {
    sendMsg({ type: 'getState' }).then(state => {
      if (state) updateUI(state);
    }).catch(() => {});
  }

  // While the page shows a stream on air or a live level, the live level is
  // asked for again every LIVE_LEVEL_ASK_MS for as long as the popup is open;
  // content.js answers with stateChanged once the bridge has read it.
  const LIVE_LEVEL_ASK_MS = 1000;
  let liveLevelWanted = false;
  let liveLevelAskSet = false;

  function askLiveLevelLater() {
    if (!liveLevelWanted || liveLevelAskSet) return;
    liveLevelAskSet = true;
    setTimeout(() => {
      liveLevelAskSet = false;
      if (!liveLevelWanted) return;
      sendMsg({ type: 'askLiveLevel' }).catch(() => {});
      askLiveLevelLater();
    }, LIVE_LEVEL_ASK_MS);
  }

  function sendManualGain(msg) {
    sendMsg(msg).then(resp => {
      if (!resp?.ok) readState();
    }).catch(() => {});
  }

  // A save that did not land, refused or failed, is said so, and the state is
  // read again: the tab has the level storage holds.
  function sendGainSave(msg) {
    const answered = saveNotice.send();
    sendMsg(msg).catch(() => null).then(resp => {
      const saved = answered(resp);
      updateApplyBtn();
      if (!saved) readState();
    });
  }

  // ── Event handlers ─────────────────────────────────────────────────

  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  applyBtn.addEventListener('click', () => {
    const answered = saveNotice.send();
    sendMsg({ type: 'applyLoudness', appliesTo: currentAppliesTo }).catch(() => null).then(resp => {
      // Whether it went through or not, what is on screen came from before the
      // gesture and is read again; one that did not is said so.
      answered(resp);
      updateApplyBtn();
      readState();
    });
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
  // A drag begins where the pointer goes down or a key is pressed on the
  // slider. Chrome fires no change when the value ends where it began, so a
  // release can pass unseen: the start of the next gesture is what says the
  // one before it is over. Taking the copy here rather than on every movement
  // keeps a drag on the state it began on.
  const beginSliderGesture = () => {
    sliderAppliesTo = currentAppliesTo;
    sliderGestureEnded = false;
  };
  // A drag also ends where the popup loses focus during it. Chrome fires
  // `change` at that blur, ahead of the blur itself, and that change saves;
  // the input and change that come after it belong to no gesture until the
  // next press.
  let sliderPointerHeld = false;
  let sliderGestureEnded = false;
  // A key held on the slider is one gesture as well: each repeat previews,
  // and the gain is saved once, when the last key that moves the value is let
  // go. Losing focus while a key is held ends it there, as a blur ends a drag,
  // and saves the gain reached. A key that moves no value (Tab, a modifier)
  // leaves the gesture as it is.
  let sliderKeyHeld = false;
  let sliderKeyMoved = false;
  const sliderKeys = createSliderKeys();
  // Only the primary button drags the slider; another button moves no value,
  // and its release goes to the window, so it begins no gesture.
  volumeSlider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    sliderPointerHeld = true;
    sliderKeyHeld = false;
    sliderKeys.clear();
    beginSliderGesture();
  });
  // A key repeat is not a new press, and does not end what a blur ended.
  volumeSlider.addEventListener('keydown', (e) => {
    if (!sliderKeys.press(e)) return;
    sliderKeyHeld = true;
    sliderKeyMoved = false;
    beginSliderGesture();
  });
  const endSliderKeyHold = () => {
    sliderKeys.clear();
    if (!sliderKeyHeld) return;
    sliderKeyHeld = false;
    if (sliderKeyMoved) saveSliderGain();
  };
  volumeSlider.addEventListener('keyup', (e) => {
    if (sliderKeys.release(e)) endSliderKeyHold();
  });
  const releaseSliderPointer = () => { sliderPointerHeld = false; };
  volumeSlider.addEventListener('pointerup', releaseSliderPointer);
  volumeSlider.addEventListener('pointercancel', releaseSliderPointer);
  // While the pointer or a key is held on the slider after a preview it has
  // not saved, the preview is sent again every PREVIEW_KEEP_ALIVE_MS, so the
  // tab keeps the gesture for as long as it is held and ends it once the
  // sending stops.
  const PREVIEW_KEEP_ALIVE_MS = 1000;
  let previewUnsaved = false;
  let keepAliveSet = false;

  function keepPreviewAlive() {
    if (keepAliveSet) return;
    keepAliveSet = true;
    setTimeout(() => {
      keepAliveSet = false;
      if (!(sliderPointerHeld || sliderKeyHeld) || !previewUnsaved || !currentChannel.id) return;
      sendManualGain({ type: 'setGainLive', appliesTo: sliderAppliesTo, gain: lastGain });
      keepPreviewAlive();
    }, PREVIEW_KEEP_ALIVE_MS);
  }

  const endSliderGestureOnBlur = () => {
    if (!sliderPointerHeld && !sliderKeyHeld) return;
    endSliderKeyHold();
    sliderPointerHeld = false;
    sliderGestureEnded = true;
    sliderAppliesTo = null;
  };
  window.addEventListener('blur', endSliderGestureOnBlur);
  volumeSlider.addEventListener('blur', endSliderGestureOnBlur);

  volumeSlider.addEventListener('input', () => {
    if (sliderGestureEnded) return;
    if (sliderKeyHeld) sliderKeyMoved = true;
    // An input that arrived without either of those begins one too.
    if (sliderAppliesTo === null) sliderAppliesTo = currentAppliesTo;
    const pct = Number(volumeSlider.value);
    const gain = percentToGain(pct);
    lastGain = gain;
    const f = fmtGain(gain);
    volumeValueEl.textContent = f.text + f.unit;
    setCardValue(currentVolEl, f.text, f.unit, 'current');
    if (currentChannel.id) {
      sendManualGain({
        type: 'setGainLive',
        appliesTo: sliderAppliesTo,
        gain
      });
      previewUnsaved = true;
      keepPreviewAlive();
    }
  });

  function saveSliderGain() {
    const appliesTo = sliderAppliesTo ?? currentAppliesTo;
    sliderAppliesTo = null;
    previewUnsaved = false;
    if (currentChannel.id) {
      sendGainSave({
        type: 'setGain',
        appliesTo,
        gain: lastGain
      });
    }
  }

  // change: save to storage on slider release; a key held waits for keyup
  volumeSlider.addEventListener('change', () => {
    if (sliderGestureEnded) {
      // The thumb goes back to the gain the blur saved.
      volumeSlider.value = gainToPercent(lastGain);
      return;
    }
    if (sliderKeyHeld) return;
    saveSliderGain();
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
        sendGainSave({
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

  async function init() {
    try {
      // Load display unit preference. A popup that cannot read the settings is
      // one the extension cannot reach as it stands, and says so as it does
      // for a tab it cannot reach.
      let settings;
      try {
        settings = await readSettings();
      } catch (err) {
        console.error('[YTCV] settings not read', err);
        mainEl.style.display = 'none';
        reloadNeededEl.style.display = '';
        return;
      }
      displayUnit = settings.displayUnit || '%';

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
            retryGetState(8, 500, {
              done: () => hasLoudness,
              ask: () => chrome.tabs.sendMessage(activeTabId, { type: 'getState' }),
              take: updateUI
            });
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
      revealPage();
    }
  }

  init();
})();
