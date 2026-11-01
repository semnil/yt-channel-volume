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
  const autoErrorEl = document.getElementById('autoError');
  const volumeSlider = document.getElementById('volumeSlider');
  const presetButtons = document.querySelectorAll('.presets button');
  const volumeValueEl = document.getElementById('volumeValue');
  const settingsBtn = document.getElementById('settingsBtn');
  const mainEl = document.getElementById('main');
  const statusLineEl = document.getElementById('statusLine');

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
  // The channel and type the gesture was made for, which its save's notice
  // is left to.
  let sliderOwner = '';
  let activeTabId = null;
  let hasLoudness = false;
  let currentLoudnessDb = null;
  // A live stream's own level, where the player names one; it goes before the
  // response's level.
  let currentLiveLkfs = null;
  let currentContentLufs = null;
  let currentTargetLufs = DEFAULT_TARGET_LUFS;
  let lastGain = 1.0;
  // Advanced each time the popup draws a gain of its own (a slider move, a
  // preset): the answer to an ask made before it is from before that gain,
  // and is not drawn.
  let ownGainDrawn = 0;
  let displayUnit = '%';
  let currentVideoType = 'video';
  let autoApplyLoudnessVideo = false;
  let autoApplyLoudnessLive = false;
  // The last save the viewer asked for did not land (createSaveNotice in
  // core/common.js). It stands until a save lands or the tab is on another
  // channel or type.
  const saveNotice = createSaveNotice();
  const ownerKey = () => (currentChannel.id ? currentChannel.id + '|' + currentVideoType : '');
  // An Auto toggle's save that is still out. Until it is answered, the toggles,
  // the manual controls and Apply are out of use: a gain saved then would pin
  // the Auto state from before the toggle.
  let autoUpdatePending = false;
  // The channel and type a toggle not saved was made for. The line saying so
  // stands only while the popup shows that channel and type.
  let autoErrorOwner = '';

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
    // The gain is saved against a channel, so there is nothing to set on a
    // page that has none.
    const manualDisabled = manualGainLocked || autoUpdatePending || !currentChannel.id;
    volumeSlider.disabled = manualDisabled;
    presetButtons.forEach(btn => { btn.disabled = manualDisabled; });

    volumeSlider.value = gainToPercent(lastGain);
    volumeValueEl.textContent = formatGainText(lastGain, displayUnit);

    updateApplyBtn();
  }

  function updateUI(state) {
    if (state.channel?.id) {
      currentChannel = state.channel;
      currentAppliesTo = state.appliesTo || '';
    } else {
      currentChannel = { id: '', name: '' };
      currentAppliesTo = '';
    }
    drawOwnerName(channelNameEl, currentChannel.name, 'channelNotDetected');

    hasLoudness = state.contentLufs !== null && state.contentLufs !== undefined;
    currentLoudnessDb = state.loudnessDb;
    currentLiveLkfs = Number.isFinite(state.liveLkfs) ? state.liveLkfs : null;
    currentContentLufs = hasLoudness ? state.contentLufs : null;
    lastGain = state.gain ?? 1.0;
    currentVideoType = state.videoType || 'video';
    saveNotice.showOwner(ownerKey());
    if (autoErrorOwner && autoErrorOwner !== ownerKey()) {
      autoErrorOwner = '';
      autoErrorEl.style.display = 'none';
    }
    autoApplyLoudnessVideo = !!state.autoApplyLoudnessVideo;
    autoApplyLoudnessLive = !!state.autoApplyLoudnessLive;
    const isLive = currentVideoType === 'live';
    autoVideoControl.style.display = isLive ? 'none' : '';
    autoLiveControl.style.display = isLive ? '' : 'none';
    drawAutoToggles();

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
    if (autoUpdatePending) applyBtn.disabled = true;
  }

  // ── Send messages to content script ────────────────────────────────

  function sendMsg(msg) {
    return sendTabMessage(activeTabId, msg);
  }

  function readState() {
    const drawnAt = ownGainDrawn;
    sendMsg({ type: 'getState' }).then(state => {
      if (state && drawnAt === ownGainDrawn) updateUI(state);
    }).catch(() => {});
  }

  // While the page shows a stream on air or a live level, the live level is
  // asked for again every LIVE_LEVEL_ASK_MS for as long as the popup is open;
  // content.js holds it in the state once the bridge has read it, and the
  // popup draws it at its next ask.
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
  function sendGainSave(msg, owner) {
    const answered = saveNotice.send(owner);
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
    sendMsg({ type: 'applyLoudness', appliesTo: currentAppliesTo, targetLufs: currentTargetLufs }).catch(() => null).then(resp => {
      // Whether it went through or not, what is on screen came from before the
      // gesture and is read again; one that did not is said so.
      answered(resp);
      updateApplyBtn();
      readState();
    });
  });

  // Both Auto toggles, from the Auto state, channel and type the popup holds.
  // While a toggle's save is out, they keep what was clicked and are out of use.
  function drawAutoToggles() {
    if (!autoUpdatePending) {
      autoApplyVideoToggle.checked = autoApplyLoudnessVideo;
      autoApplyLiveToggle.checked = autoApplyLoudnessLive;
    }
    const isLive = currentVideoType === 'live';
    autoApplyVideoToggle.disabled = autoUpdatePending || !currentChannel.id || isLive;
    autoApplyLiveToggle.disabled = autoUpdatePending || !currentChannel.id || !isLive;
  }

  function resyncFromContent() {
    const putBack = () => {
      drawAutoToggles();
      refreshDisplay();
    };
    sendMsg({ type: 'getState' }).then(state => {
      if (state) {
        updateUI(state);
        return;
      }
      putBack();
    }).catch(putBack);
  }

  function handleAutoApplyChange(toggle, videoType) {
    if (autoUpdatePending || !currentChannel.id || videoType !== currentVideoType) return;
    const enabled = toggle.checked;
    const owner = ownerKey();
    autoUpdatePending = true;
    autoErrorOwner = '';
    autoErrorEl.style.display = 'none';
    toggle.disabled = true;
    refreshDisplay();
    sendMsg({
      type: 'setAutoApplyLoudness',
      appliesTo: currentAppliesTo,
      enabled
    }).catch(() => null).then(resp => {
      autoUpdatePending = false;
      if (resp?.ok) {
        updateUI(resp);
        return;
      }
      // The write may have landed before the failure, so show what the page
      // holds rather than assuming the toggle never moved, and say it was not
      // saved, while the popup still shows the channel and type it was for.
      if (owner === ownerKey()) {
        autoErrorOwner = owner;
        autoErrorEl.style.display = '';
      }
      resyncFromContent();
    });
  }

  autoApplyVideoToggle.addEventListener('change', () => {
    handleAutoApplyChange(autoApplyVideoToggle, 'video');
  });

  autoApplyLiveToggle.addEventListener('change', () => {
    handleAutoApplyChange(autoApplyLiveToggle, 'live');
  });

  // One save per gesture on the slider, heard while it moves
  // (holdPopupSlider in core/common.js), against the state the gesture began
  // on.
  holdPopupSlider(volumeSlider, {
    begin: () => {
      sliderAppliesTo = currentAppliesTo;
      sliderOwner = ownerKey();
    },
    draw: (percent) => {
      ownGainDrawn++;
      lastGain = percentToGain(percent);
      const f = fmtGain(lastGain);
      volumeValueEl.textContent = f.text + f.unit;
      setCardValue(currentVolEl, f.text, f.unit, 'current');
    },
    canPreview: () => !!currentChannel.id,
    preview: (percent) => {
      sendManualGain({ type: 'setGainLive', appliesTo: sliderAppliesTo, gain: percentToGain(percent) });
    },
    save: (percent) => {
      if (!currentChannel.id) return;
      sendGainSave({ type: 'setGain', appliesTo: sliderAppliesTo, gain: percentToGain(percent) }, sliderOwner);
    }
  });

  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const pct = Number(btn.dataset.vol);
      const gain = percentToGain(pct);
      ownGainDrawn++;
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

  // The unit follows the settings in sync while the popup is open
  // (followDisplayUnit in core/common.js), and the first read does not undo a
  // change that arrived while it was out.
  const readDisplayUnit = followDisplayUnit((unit) => {
    displayUnit = unit;
    refreshDisplay();
  });

  // ── Init ───────────────────────────────────────────────────────────

  async function init() {
    try {
      // Load display unit preference. A popup that cannot read the settings is
      // one the extension cannot reach as it stands, and says so as it does
      // for a tab it cannot reach.
      try {
        const unit = await readDisplayUnit();
        if (unit !== null) displayUnit = unit;
      } catch (err) {
        console.error('[YTCV] settings not read', err);
        showPopupStatus(statusLineEl, mainEl, 'reloadPageNeeded');
        return;
      }

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !isSiteTab(tab, 'youtube.com')) {
        showPopupStatus(statusLineEl, mainEl, 'openOnYoutube');
        return;
      }

      activeTabId = tab.id;

      // forceDetect at open, then the state every second while the popup is
      // open (pollTabState in core/common.js).
      await pollTabState(() => askTab('getState'), () => askTab('forceDetect'));
    } finally {
      revealPage();
    }
  }

  // What the tab answered: a watch page's state drawn, or the line that says
  // why there is nothing to act on. An answer of nothing draws nothing.
  function showState(state) {
    if (!state) return;
    if (!state.isWatchPage) {
      showPopupStatus(statusLineEl, mainEl, 'openOnVideoPage');
      return;
    }
    hidePopupStatus(statusLineEl, mainEl);
    updateUI(state);
  }

  async function askTab(type) {
    const drawnAt = ownGainDrawn;
    let state;
    try {
      state = await chrome.tabs.sendMessage(activeTabId, { type });
    } catch (_) {
      // sendMessage rejects when content.js is unreachable. The most common
      // cause is runtime context invalidation: when this or another extension
      // is reloaded, existing tabs' content scripts lose their chrome.runtime
      // connection. The page must be reloaded for content.js to be re-injected.
      showPopupStatus(statusLineEl, mainEl, 'reloadPageNeeded');
      return;
    }
    if (drawnAt === ownGainDrawn) showState(state);
  }

  init();
})();
