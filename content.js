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

  async function loadChannelGain(channelId, videoType) {
    if (!channelId || !isContextValid()) return null;
    const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
    const all = data[CHANNEL_VOLUMES_KEY] || {};
    const entry = all[channelId];
    if (!entry) return null;
    // Migration: old format had single `gain` → treat as both
    if ('gain' in entry && !('gainLive' in entry) && !('gainVideo' in entry)) {
      return entry.gain;
    }
    const key = videoType === 'live' ? 'gainLive' : 'gainVideo';
    return entry[key] ?? null;
  }

  async function saveChannelGain(channelId, name, gain, videoType, url) {
    if (!channelId || !isContextValid()) return;
    const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
    const all = data[CHANNEL_VOLUMES_KEY] || {};
    const entry = all[channelId] || { name };
    entry.name = name;
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
    // Use channelId from player response to fix ID (always UC format)
    const bridgeChId = event.data.channelId;
    if (bridgeChId && bridgeChId.startsWith('UC') && currentChannel.id !== bridgeChId) {
      const oldId = currentChannel.id;
      currentChannel.id = bridgeChId;
      if (!currentChannel.url || currentChannel.url.includes('/@')) {
        currentChannel.url = 'https://www.youtube.com/channel/' + bridgeChId;
      }
      // Migrate @handle entry to UC format in storage
      if (oldId && oldId.startsWith('@') && isContextValid()) {
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

  let loudnessReady = Promise.resolve();
  let _lastVideoId = '';

  async function applyVideoVolume() {
    if (!isWatchPage()) return;
    const video = document.querySelector('video.html5-main-video, video');
    if (!video) return;

    _lastVideoId = new URL(location.href).searchParams.get('v') || '';

    const ch = detectChannel();
    currentChannel = ch;

    await loadSettings();

    currentLoudnessDb = null;
    currentVideoType = 'video';
    currentIsLiveNow = false;

    // Try to load gain for 'video' first, then correct after videoType is known
    const initialGain = await loadChannelGain(ch.id, 'video');
    currentGain = initialGain ?? 1.0;
    setGain(currentGain);
    notifyPopup();

    // Fetch loudness + videoType + channelId, then re-apply if changed
    const initialType = currentVideoType;
    const initialChId = ch.id;
    loudnessReady = requestLoudnessWithRetry(10, 500).then(async () => {
      const chIdChanged = currentChannel.id !== initialChId;
      if (currentVideoType !== initialType || chIdChanged) {
        const typeGain = await loadChannelGain(currentChannel.id, currentVideoType);
        if (typeGain !== null) {
          currentGain = typeGain;
          setGain(currentGain);
        }
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
    const key = state.loudnessDb + '|' + state.gain + '|' + state.channel.id + '|' + state.videoType;
    if (key === _lastNotifiedState) return;
    _lastNotifiedState = key;
    chrome.runtime.sendMessage({ type: 'stateChanged', ...state }).catch(() => {});
  }

  // ── Navigation handling (YouTube SPA) ──────────────────────────────

  function isWatchPage() {
    return location.pathname === '/watch';
  }

  let applyTimer = null;

  function scheduleApply() {
    if (!isContextValid()) { observer.disconnect(); return; }
    if (!isWatchPage()) return;
    clearTimeout(applyTimer);
    applyTimer = setTimeout(applyVideoVolume, 800);
  }

  document.addEventListener('yt-navigate-finish', scheduleApply);
  window.addEventListener('popstate', scheduleApply);

  const observer = new MutationObserver((mutations) => {
    if (!isWatchPage()) return;
    // Skip mutations inside caption/chat overlays to avoid flickering
    for (const m of mutations) {
      const t = m.target;
      if (t.closest && t.closest('.ytp-caption-window-container, #chat-messages, .ytp-ad-overlay-container')) {
        return;
      }
    }
    const video = document.querySelector('video.html5-main-video, video');
    if (video && video !== connectedVideo) {
      scheduleApply();
      return;
    }
    const sm = location.search.match(/[?&]v=([^&]+)/);
    const vid = sm ? sm[1] : '';
    if (vid && vid !== _lastVideoId) {
      scheduleApply();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (isWatchPage()) scheduleApply();

  // React to settings changes (e.g. overlay toggle from options page)
  if (isContextValid()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[SETTINGS_KEY]) {
        const s = changes[SETTINGS_KEY].newValue || {};
        showGainOverlay = !!s.showGainOverlay;
        updateGainOverlay();
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
      const { channelId, name, gain } = msg;
      currentGain = gain;
      setGain(gain);
      saveChannelGain(channelId, name, gain, currentVideoType, currentChannel.url).then(() => {
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
      if (stale) {
        applyVideoVolume().then(() => {
          loudnessReady.then(() => {
            sendResponse(getState());
          });
        });
      } else {
        loudnessReady.then(() => {
          sendResponse(getState());
        });
      }
      return true;
    }
  });
})();
