// content.js — YT Channel Volume
// Reads YouTube's Content Loudness (informational) and applies saved per-channel gain.
// loudnessDb extraction is handled by page-bridge.js (MAIN world).

(() => {
  'use strict';

  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch (_) { return false; }
  }

  const YT_REFERENCE_LUFS = -14;
  const DEFAULT_TARGET_LUFS = -18;
  const SETTINGS_KEY = 'autoLoudnessSettings';
  const CHANNEL_VOLUMES_KEY = 'channelVolumes';

  /** @type {AudioContext | null} */
  let audioCtx = null;
  /** @type {GainNode | null} */
  let gainNode = null;
  /** @type {MediaElementAudioSourceNode | null} */
  let sourceNode = null;
  /** @type {HTMLVideoElement | null} */
  let connectedVideo = null;

  let currentChannel = { id: '', name: '', url: '' };
  let currentLoudnessDb = null;
  let currentGain = 1.0;
  let targetLufs = DEFAULT_TARGET_LUFS;
  /** 'live' (live stream / archive) or 'video' (regular video / shorts) */
  let currentVideoType = 'video';
  let currentIsLiveNow = false;
  let showGainOverlay = false;

  // ── Storage helpers ────────────────────────────────────────────────

  async function loadSettings() {
    if (!isContextValid()) return { targetLufs };
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const s = data[SETTINGS_KEY] || {};
    targetLufs = s.targetLufs ?? DEFAULT_TARGET_LUFS;
    showGainOverlay = !!s.showGainOverlay;
    return { targetLufs };
  }

  async function saveSettings(settings) {
    if (!isContextValid()) return;
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const merged = { ...data[SETTINGS_KEY] || {}, ...settings };
    targetLufs = merged.targetLufs ?? targetLufs;
    await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  }

  function extractGainForType(entry, videoType) {
    if (!entry) return null;
    // Migration: old format had single `gain` → treat as both
    if ('gain' in entry && !('gainLive' in entry) && !('gainVideo' in entry)) {
      return entry.gain;
    }
    const key = videoType === 'live' ? 'gainLive' : 'gainVideo';
    return entry[key] ?? null;
  }

  async function loadChannelGain(channelId, videoType) {
    if (!channelId || !isContextValid()) return null;
    const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
    const all = data[CHANNEL_VOLUMES_KEY] || {};
    return extractGainForType(all[channelId], videoType);
  }

  async function saveChannelGain(channelId, name, gain, videoType, url) {
    if (!channelId || !isContextValid()) return;
    const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
    const all = data[CHANNEL_VOLUMES_KEY] || {};
    const entry = all[channelId] || { name: name || channelId };
    if (name) entry.name = name;
    if (url) entry.url = url;
    // Migrate old format
    if ('gain' in entry && !('gainLive' in entry) && !('gainVideo' in entry)) {
      entry.gainLive = entry.gain;
      entry.gainVideo = entry.gain;
      delete entry.gain;
    }
    const key = videoType === 'live' ? 'gainLive' : 'gainVideo';
    entry[key] = gain;
    all[channelId] = entry;
    await chrome.storage.local.set({ [CHANNEL_VOLUMES_KEY]: all });
  }

  async function deleteChannelGain(channelId) {
    if (!channelId || !isContextValid()) return;
    const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
    const all = data[CHANNEL_VOLUMES_KEY] || {};
    delete all[channelId];
    await chrome.storage.local.set({ [CHANNEL_VOLUMES_KEY]: all });
  }

  // ── Loudness from page-bridge.js (MAIN world) ─────────────────────

  let loudnessWaiters = [];

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== '__yt_channel_volume__') return;

    const db = event.data.loudnessDb;
    if (db !== null && db !== undefined && !isNaN(db)) {
      currentLoudnessDb = db;
    }
    if (event.data.isLiveContent !== undefined) {
      currentVideoType = event.data.isLiveContent ? 'live' : 'video';
      currentIsLiveNow = !!event.data.isLiveNow;
    }
    // Only accept channelId if it came with valid data for current video.
    // isLiveContent is always boolean from page-bridge.js; undefined only
    // signals malformed / spoofed messages. Premiere videos report
    // isLiveContent=false with db=null, so relying on db alone loses their
    // channelId and leaves saved gain unapplied.
    const bridgeChId = event.data.channelId;
    const hasValidData = (db !== null && db !== undefined) || event.data.isLiveContent !== undefined;
    if (hasValidData && bridgeChId && bridgeChId.startsWith('UC')) {
      const oldId = currentChannel.id;
      const idChanged = oldId !== bridgeChId;
      if (idChanged) {
        currentChannel.id = bridgeChId;
        currentChannel.url = 'https://www.youtube.com/channel/' + bridgeChId;
      }
      // Upgrade name if missing, still the raw ID fallback, or stale from prior channel
      const nameIsStub = !currentChannel.name
        || currentChannel.name === oldId
        || currentChannel.name === bridgeChId;
      const isHandleMigration = idChanged && oldId && oldId.startsWith('@');
      if (idChanged && !isHandleMigration) {
        // True channel navigation (UCa → UCb): previous name belongs to old channel.
        // Prefer author (from this video's player response — guaranteed correct for new id).
        currentChannel.name = event.data.author || getChannelDisplayName() || bridgeChId;
      } else if (isHandleMigration) {
        // @handle → UC: same channel. Refresh from DOM if available, else keep existing.
        const freshName = getChannelDisplayName();
        if (freshName) currentChannel.name = freshName;
        else if (nameIsStub && event.data.author) currentChannel.name = event.data.author;
      } else if (nameIsStub) {
        const freshName = getChannelDisplayName();
        if (freshName) currentChannel.name = freshName;
        else if (event.data.author) currentChannel.name = event.data.author;
      }
      // Migrate @handle entry to UC format in storage
      if (idChanged && oldId && oldId.startsWith('@') && isContextValid()) {
        chrome.storage.local.get(CHANNEL_VOLUMES_KEY).then(data => {
          const all = data[CHANNEL_VOLUMES_KEY] || {};
          if (all[oldId] && !all[bridgeChId]) {
            all[bridgeChId] = all[oldId];
            all[bridgeChId].url = currentChannel.url;
            delete all[oldId];
            chrome.storage.local.set({ [CHANNEL_VOLUMES_KEY]: all });
          }
        });
      }
      // Backfill: orphan @handle entries (saved before UC ever surfaced in
      // this tab) never hit the idChanged path above. When we learn the UC
      // id and have an author name, statically adopt any same-name @handle
      // entry so the user's saved gain resurfaces.
      if (bridgeChId.startsWith('UC') && event.data.author && isContextValid()) {
        const authorName = event.data.author;
        chrome.storage.local.get(CHANNEL_VOLUMES_KEY).then(data => {
          const all = data[CHANNEL_VOLUMES_KEY] || {};
          if (all[bridgeChId]) return;
          const match = Object.entries(all).find(([k, v]) =>
            k.startsWith('@') && v.name === authorName
          );
          if (!match) return;
          const [oldKey, val] = match;
          all[bridgeChId] = {
            ...val,
            url: 'https://www.youtube.com/channel/' + bridgeChId
          };
          delete all[oldKey];
          chrome.storage.local.set({ [CHANNEL_VOLUMES_KEY]: all });
        });
      }
    }
    notifyPopup();
    const waiters = loudnessWaiters;
    loudnessWaiters = [];
    for (const resolve of waiters) resolve(db);
  });

  function requestLoudness() {
    window.postMessage({ type: '__yt_channel_volume_request__' }, '*');
  }

  function requestLoudnessWithRetry(maxAttempts, intervalMs) {
    return new Promise((resolve) => {
      let attempts = 0;
      function attempt() {
        attempts++;
        const timer = setTimeout(() => {
          const idx = loudnessWaiters.indexOf(waiterFn);
          if (idx >= 0) loudnessWaiters.splice(idx, 1);
          if (currentLoudnessDb !== null) {
            resolve(currentLoudnessDb);
          } else if (attempts < maxAttempts) {
            attempt();
          } else {
            resolve(null);
          }
        }, intervalMs);

        function waiterFn(db) {
          clearTimeout(timer);
          resolve(db);
        }
        loudnessWaiters.push(waiterFn);
        requestLoudness();
      }
      attempt();
    });
  }

  // ── Gain calculation ───────────────────────────────────────────────

  function calcGainFromLoudness(loudnessDb) {
    // YouTube only attenuates loud content (loudnessDb > 0) to -14 LUFS.
    // Quiet content (loudnessDb <= 0) is not boosted.
    const effectiveLufs = loudnessDb > 0
      ? YT_REFERENCE_LUFS
      : YT_REFERENCE_LUFS + loudnessDb;
    const compensationDb = targetLufs - effectiveLufs;
    const gain = Math.pow(10, compensationDb / 20);
    if (!isFinite(gain)) return 1.0;
    return Math.max(0, Math.min(6, gain));
  }

  // ── Channel detection ──────────────────────────────────────────────

  function getChannelDisplayName() {
    const el = document.querySelector(
      '#owner #channel-name #text a, ' +
      '#owner #channel-name a, ' +
      'ytd-video-owner-renderer #channel-name #text a, ' +
      'ytd-video-owner-renderer #channel-name a, ' +
      '#upload-info #channel-name a'
    );
    const name = el?.textContent?.trim();
    if (name) return name;
    const meta = document.querySelector('link[itemprop="name"]');
    return meta?.content || '';
  }

  function detectChannel() {
    const displayName = getChannelDisplayName();
    let url = '';

    const canonical = document.querySelector('link[rel="canonical"][href*="/channel/"]');
    if (canonical) {
      const m = canonical.href.match(/\/channel\/(UC[A-Za-z0-9_-]+)/);
      if (m) {
        url = 'https://www.youtube.com/channel/' + m[1];
        return { id: m[1], name: displayName || m[1], url };
      }
    }

    const ownerLink = document.querySelector(
      '#owner a[href*="/channel/"], ' +
      '#owner a[href*="/@"], ' +
      'ytd-video-owner-renderer a[href*="/channel/"], ' +
      'ytd-video-owner-renderer a[href*="/@"]'
    );
    if (ownerLink) {
      const href = ownerLink.href;
      const mCh = href.match(/\/channel\/(UC[A-Za-z0-9_-]+)/);
      if (mCh) {
        url = 'https://www.youtube.com/channel/' + mCh[1];
        return { id: mCh[1], name: displayName || mCh[1], url };
      }
      const mHandle = href.match(/\/@([^/?#]+)/);
      if (mHandle) {
        const handle = decodeURIComponent(mHandle[1]);
        url = 'https://www.youtube.com/@' + handle;
        return { id: '@' + handle, name: displayName || handle, url };
      }
    }

    const metaChannel = document.querySelector('meta[itemprop="channelId"]');
    if (metaChannel) {
      const id = metaChannel.content;
      url = 'https://www.youtube.com/channel/' + id;
      return { id, name: displayName || id, url };
    }

    return { id: '', name: '', url: '' };
  }

  // ── Web Audio API ──────────────────────────────────────────────────
  // Defer audio chain creation until a non-passthrough gain is needed.
  // createMediaElementSource causes a momentary audio interruption that
  // triggers Live Caption flickering; avoid it when gain is 1.0.

  function ensureAudioChain() {
    const video = document.querySelector('video.html5-main-video, video');
    if (!video) return false;
    if (connectedVideo === video && gainNode) return true;

    if (sourceNode) {
      try { sourceNode.disconnect(); } catch (_) { /* ok */ }
      sourceNode = null;
    }

    if (!audioCtx) {
      audioCtx = new AudioContext();
    }

    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    sourceNode = audioCtx.createMediaElementSource(video);
    gainNode = audioCtx.createGain();
    sourceNode.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    connectedVideo = video;
    return true;
  }

  function setGain(value) {
    const clamped = Math.max(0, Math.min(6, value));
    if (clamped === 1.0 && !gainNode) {
      updateGainOverlay();
      return;
    }
    if (!ensureAudioChain()) return;
    gainNode.gain.value = clamped;
    updateGainOverlay();
  }

  // ── Gain overlay on YouTube player ──────────────────────────────────

  let _overlayEl = null;

  function updateGainOverlay() {
    if (!showGainOverlay || currentGain === 1.0) {
      if (_overlayEl) {
        if (_overlayEl.parentNode) _overlayEl.parentNode.removeChild(_overlayEl);
        _overlayEl = null;
      }
      return;
    }
    const volumeArea = document.querySelector('.ytp-volume-area');
    if (!volumeArea) return;

    // Recreate if detached from document (SPA navigation rebuilds DOM)
    if (_overlayEl && !document.contains(_overlayEl)) {
      _overlayEl = null;
    }
    if (!_overlayEl) {
      _overlayEl = document.createElement('span');
      _overlayEl.style.cssText =
        'font-size:11px;font-weight:700;color:#4ecdc4;margin-left:6px;' +
        'font-variant-numeric:tabular-nums;pointer-events:none;white-space:nowrap;' +
        'line-height:normal;display:inline-flex;align-items:center;';
    }
    _overlayEl.textContent = Math.round(currentGain * 100) + '%';
    if (_overlayEl.parentNode !== volumeArea) {
      volumeArea.appendChild(_overlayEl);
    }
  }

  // ── Apply saved volume for current channel ─────────────────────────

  let _lastVideoId = '';

  async function applyVideoVolume() {
    if (!isWatchPage()) return;
    const video = document.querySelector('video.html5-main-video, video');
    if (!video) return;
    _lastProcessedVideo = video;

    _lastVideoId = getUrlVideoId();

    const ch = detectChannel();
    currentChannel = ch;

    await loadSettings();

    currentLoudnessDb = null;
    currentVideoType = 'video';
    currentIsLiveNow = false;

    const initialGain = await loadChannelGain(ch.id, 'video');
    currentGain = initialGain ?? 1.0;
    setGain(currentGain);
    notifyPopup();

    // Fetch loudness + videoType + channelId, then re-apply if changed
    const initialType = currentVideoType;
    const initialChId = ch.id;
    requestLoudnessWithRetry(10, 500).then(async () => {
      const chIdChanged = currentChannel.id !== initialChId;
      if (chIdChanged) {
        // Re-detect display name since DOM has likely updated
        const freshName = getChannelDisplayName();
        if (freshName) currentChannel.name = freshName;
      }
      if (currentVideoType !== initialType || chIdChanged) {
        const typeGain = await loadChannelGain(currentChannel.id, currentVideoType);
        currentGain = typeGain ?? 1.0;
        setGain(currentGain);
      }
      notifyPopup();
    });
  }

  function getState() {
    const contentLufs = currentLoudnessDb !== null
      ? YT_REFERENCE_LUFS + currentLoudnessDb
      : null;
    return {
      channel: currentChannel,
      gain: currentGain,
      loudnessDb: currentLoudnessDb,
      contentLufs,
      targetLufs,
      videoType: currentVideoType,
      isLiveNow: currentIsLiveNow,
      isWatchPage: isWatchPage()
    };
  }

  let _lastNotifiedState = '';
  function notifyPopup() {
    if (!isContextValid()) return;
    const state = getState();
    const key = state.loudnessDb + '|' + state.gain + '|' + state.channel.id + '|' + state.channel.name + '|' + state.videoType;
    if (key === _lastNotifiedState) return;
    _lastNotifiedState = key;
    chrome.runtime.sendMessage({ type: 'stateChanged', ...state }).catch(() => {});
  }

  // ── Navigation handling (YouTube SPA) ──────────────────────────────

  function isWatchPage() {
    const p = location.pathname;
    return p === '/watch' || p.startsWith('/live/');
  }

  function getUrlVideoId() {
    try {
      const u = new URL(location.href);
      const q = u.searchParams.get('v');
      if (q) return q;
      const m = u.pathname.match(/^\/live\/([^/?#]+)/);
      return m ? m[1] : '';
    } catch (_) { return ''; }
  }

  /** Track the video element we've processed (separate from connectedVideo which tracks audio chain) */
  let _lastProcessedVideo = null;
  let _applyRunning = false;

  async function triggerApply() {
    if (!isContextValid()) { observer.disconnect(); return; }
    if (!isWatchPage()) return;
    if (_applyRunning) return;
    _applyRunning = true;
    try {
      await applyVideoVolume();
    } finally {
      _applyRunning = false;
    }
  }

  document.addEventListener('yt-navigate-finish', triggerApply);
  window.addEventListener('popstate', triggerApply);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isWatchPage() && !_lastProcessedVideo) {
      triggerApply();
    }
  });

  const observer = new MutationObserver(() => {
    if (!isWatchPage()) return;
    const video = document.querySelector('video.html5-main-video, video');
    if (video && _lastProcessedVideo && video !== _lastProcessedVideo) {
      triggerApply();
      return;
    }
    const vid = getUrlVideoId();
    if (vid && vid !== _lastVideoId) {
      triggerApply();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (isWatchPage()) triggerApply();

  // React to settings changes (e.g. overlay toggle from options page)
  if (isContextValid()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[SETTINGS_KEY]) {
        const s = changes[SETTINGS_KEY].newValue || {};
        showGainOverlay = !!s.showGainOverlay;
        updateGainOverlay();
      }
      if (changes[CHANNEL_VOLUMES_KEY] && currentChannel.id) {
        const all = changes[CHANNEL_VOLUMES_KEY].newValue || {};
        const entry = all[currentChannel.id];
        const gain = entry ? extractGainForType(entry, currentVideoType) : 1.0;
        if (gain == null || gain === currentGain) return;
        currentGain = gain;
        setGain(gain);
        notifyPopup();
      }
    });
  }

  document.addEventListener('click', () => {
    if (audioCtx?.state === 'suspended') {
      audioCtx.resume();
    }
  }, { once: true });

  // ── Message handler (from popup) ───────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'getState') {
      sendResponse(getState());
      return true;
    }

    if (msg.type === 'applyLoudness') {
      if (currentLoudnessDb === null || !currentChannel.id) {
        sendResponse({ ok: false, reason: 'no loudness data' });
        return true;
      }
      // Re-detect name at save time (DOM may have updated since initial detection)
      const freshName = getChannelDisplayName();
      if (freshName) currentChannel.name = freshName;
      const gain = calcGainFromLoudness(currentLoudnessDb);
      currentGain = gain;
      setGain(gain);
      saveChannelGain(currentChannel.id, currentChannel.name, gain, currentVideoType, currentChannel.url).then(() => {
        notifyPopup();
        sendResponse({ ok: true, gain });
      });
      return true;
    }

    if (msg.type === 'setGainLive') {
      currentGain = msg.gain;
      setGain(msg.gain);
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'setGain') {
      const { channelId, gain } = msg;
      const freshName = getChannelDisplayName();
      if (freshName) currentChannel.name = freshName;
      currentGain = gain;
      setGain(gain);
      saveChannelGain(channelId, currentChannel.name, gain, currentVideoType, currentChannel.url).then(() => {
        notifyPopup();
        sendResponse({ ok: true });
      });
      return true;
    }

    if (msg.type === 'clearChannel') {
      const { channelId } = msg;
      deleteChannelGain(channelId).then(() => {
        currentGain = 1.0;
        setGain(currentGain);
        notifyPopup();
        sendResponse({ ok: true });
      });
      return true;
    }

    if (msg.type === 'setTargetLufs') {
      const { value } = msg;
      saveSettings({ targetLufs: value }).then(() => {
        notifyPopup();
        sendResponse({ ok: true });
      });
      return true;
    }

    if (msg.type === 'forceDetect') {
      const urlVideoId = new URL(location.href).searchParams.get('v') || '';
      const stale = !currentChannel.id || (urlVideoId && urlVideoId !== _lastVideoId);
      if (stale && !_applyRunning) {
        triggerApply().then(() => {
          sendResponse(getState());
        });
      } else {
        sendResponse(getState());
      }
      return true;
    }
  });

  // Test-only: expose internals for state transition testing
  if (typeof globalThis.__TEST_YTCV__ !== 'undefined') {
    globalThis.__YTCV__ = {
      get state() {
        return {
          currentChannel, currentGain, currentLoudnessDb,
          currentVideoType, currentIsLiveNow, showGainOverlay,
          _lastVideoId, _lastProcessedVideo, _applyRunning, connectedVideo,
          targetLufs, gainNode, audioCtx
        };
      },
      applyVideoVolume,
      triggerApply,
      detectChannel,
      getChannelDisplayName,
      setGain,
      getState,
      isWatchPage,
      getUrlVideoId,
      calcGainFromLoudness,
      loadChannelGain,
      notifyPopup,
      // Setters for test setup
      _set(key, val) {
        switch (key) {
          case 'currentChannel': currentChannel = val; break;
          case 'currentGain': currentGain = val; break;
          case 'currentVideoType': currentVideoType = val; break;
          case '_lastVideoId': _lastVideoId = val; break;
          case '_lastProcessedVideo': _lastProcessedVideo = val; break;
          case '_applyRunning': _applyRunning = val; break;
          case 'targetLufs': targetLufs = val; break;
          case 'currentLoudnessDb': currentLoudnessDb = val; break;
        }
      }
    };
  }
})();
