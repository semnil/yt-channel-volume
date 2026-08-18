// content.js — YT Channel Volume
// Reads YouTube's Content Loudness and applies automatic or saved per-channel gain.
// loudnessDb extraction is handled by page-bridge.js (MAIN world).

(() => {
  'use strict';

  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch (_) { return false; }
  }

  const YT_REFERENCE_LUFS = -14;
  const DEFAULT_TARGET_LUFS = -18;
  const DEFAULT_AUTO_APPLY_LOUDNESS = false;
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
  let currentChannelVideoId = '';
  let currentLoudnessDb = null;
  let currentLoudnessVideoId = '';
  let currentGain = 1.0;
  let targetLufs = DEFAULT_TARGET_LUFS;
  let defaultAutoApplyLoudnessVideo = DEFAULT_AUTO_APPLY_LOUDNESS;
  let defaultAutoApplyLoudnessLive = DEFAULT_AUTO_APPLY_LOUDNESS;
  let currentAutoApplyLoudnessVideo = false;
  let currentAutoApplyLoudnessLive = false;
  /** 'live' (live stream / archive) or 'video' (regular video / shorts) */
  let currentVideoType = 'video';
  let currentVideoTypeDetected = false;
  let currentIsLiveNow = false;
  let showGainOverlay = false;

  // ── Storage helpers ────────────────────────────────────────────────

  async function loadSettings() {
    if (!isContextValid()) return { targetLufs };
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const s = data[SETTINGS_KEY] || {};
    targetLufs = s.targetLufs ?? DEFAULT_TARGET_LUFS;
    defaultAutoApplyLoudnessVideo =
      s.autoApplyLoudnessVideoDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
    defaultAutoApplyLoudnessLive =
      s.autoApplyLoudnessLiveDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
    showGainOverlay = !!s.showGainOverlay;
    return { targetLufs, defaultAutoApplyLoudnessVideo, defaultAutoApplyLoudnessLive };
  }

  async function saveSettings(settings) {
    if (!isContextValid()) return;
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const merged = { ...data[SETTINGS_KEY] || {}, ...settings };
    targetLufs = merged.targetLufs ?? targetLufs;
    defaultAutoApplyLoudnessVideo =
      merged.autoApplyLoudnessVideoDefault ?? defaultAutoApplyLoudnessVideo;
    defaultAutoApplyLoudnessLive =
      merged.autoApplyLoudnessLiveDefault ?? defaultAutoApplyLoudnessLive;
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

  function extractAutoApplyOverride(entry, videoType) {
    if (!entry) return null;
    const key = videoType === 'live'
      ? 'autoApplyLoudnessLive'
      : 'autoApplyLoudnessVideo';
    if (key in entry) return !!entry[key];
    // Migration: the first implementation used one flag for both types.
    if ('autoApplyLoudness' in entry) return !!entry.autoApplyLoudness;
    return null;
  }

  function resolveAutoApplyForType(entry, videoType) {
    const override = extractAutoApplyOverride(entry, videoType);
    if (override !== null) return override;
    return videoType === 'live'
      ? defaultAutoApplyLoudnessLive
      : defaultAutoApplyLoudnessVideo;
  }

  function setCurrentAutoApplyFromEntry(entry) {
    currentAutoApplyLoudnessVideo = resolveAutoApplyForType(entry, 'video');
    currentAutoApplyLoudnessLive = resolveAutoApplyForType(entry, 'live');
  }

  function isCurrentAutoApplyEnabled(videoType = currentVideoType) {
    return videoType === 'live'
      ? currentAutoApplyLoudnessLive
      : currentAutoApplyLoudnessVideo;
  }

  async function loadChannelEntry(channelId) {
    if (!channelId || !isContextValid()) return null;
    const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
    const all = data[CHANNEL_VOLUMES_KEY] || {};
    return all[channelId] || null;
  }

  async function loadChannelGain(channelId, videoType) {
    const entry = await loadChannelEntry(channelId);
    return extractGainForType(entry, videoType);
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

  async function saveChannelAutoApply(channelId, name, enabled, videoType, url) {
    if (!channelId || !isContextValid()) return;
    const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
    const all = data[CHANNEL_VOLUMES_KEY] || {};
    const entry = all[channelId] || { name: name || channelId };
    if (name) entry.name = name;
    if (url) entry.url = url;

    // Expand the legacy all-types flag before updating one type.
    if ('autoApplyLoudness' in entry) {
      entry.autoApplyLoudnessVideo = !!entry.autoApplyLoudness;
      entry.autoApplyLoudnessLive = !!entry.autoApplyLoudness;
      delete entry.autoApplyLoudness;
    }

    const key = videoType === 'live'
      ? 'autoApplyLoudnessLive'
      : 'autoApplyLoudnessVideo';
    // Store both true and false so an explicit per-channel choice can override
    // the all-channel default without modifying any saved gain.
    entry[key] = !!enabled;
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

  function isBridgeMessageForCurrentVideo(videoId) {
    if (!videoId) return true;
    const urlVideoId = getUrlVideoId();
    if (!urlVideoId) return true;
    if (location.pathname === '/watch') return videoId === urlVideoId;
    // `/live/<handle>` does not necessarily contain a video ID. Only compare
    // the path segment when it has the shape of a YouTube video ID.
    if (location.pathname.startsWith('/live/') && urlVideoId.length === 11) {
      return videoId === urlVideoId;
    }
    return true;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== '__yt_channel_volume__') return;

    const bridgeVideoId = typeof event.data.videoId === 'string'
      ? event.data.videoId
      : '';
    // A queued response for the previous video may arrive after the URL has
    // already changed. It must not mutate channel, loudness, or gain state.
    if (!isBridgeMessageForCurrentVideo(bridgeVideoId)) return;

    const db = event.data.loudnessDb;
    const hasLoudness = db !== null && db !== undefined && !isNaN(db);
    const loudnessVideoChanged = bridgeVideoId &&
      bridgeVideoId !== currentLoudnessVideoId;
    if (loudnessVideoChanged) {
      // `null` is meaningful for a new video: it clears the previous video's
      // LUFS so Auto uses the saved fallback instead of stale loudness data.
      currentLoudnessVideoId = bridgeVideoId;
      currentLoudnessDb = hasLoudness ? db : null;
    } else if (hasLoudness) {
      currentLoudnessDb = db;
    }
    if (event.data.isLiveContent !== undefined) {
      currentVideoType = event.data.isLiveContent ? 'live' : 'video';
      currentVideoTypeDetected = true;
      currentIsLiveNow = !!event.data.isLiveNow;
    }
    // Only accept channelId if it came with valid data for current video.
    // isLiveContent is always boolean from page-bridge.js; undefined only
    // signals malformed / spoofed messages. Premiere videos report
    // isLiveContent=false with db=null, so relying on db alone loses their
    // channelId and leaves saved gain unapplied.
    const bridgeChId = event.data.channelId;
    const hasValidData = hasLoudness || event.data.isLiveContent !== undefined;
    if (hasValidData && bridgeChId && bridgeChId.startsWith('UC')) {
      if (bridgeVideoId) currentChannelVideoId = bridgeVideoId;
      const oldId = currentChannel.id;
      const idChanged = oldId !== bridgeChId;
      if (idChanged) {
        currentChannel.id = bridgeChId;
        currentChannel.url = 'https://www.youtube.com/channel/' + bridgeChId;
        currentAutoApplyLoudnessVideo = false;
        currentAutoApplyLoudnessLive = false;
        // Bridge author comes from the current video's player response — it is
        // authoritative for bridgeChId. Prefer it over DOM, which may lag the
        // SPA navigation and still describe the previous channel.
        currentChannel.name = event.data.author || getChannelDisplayName() || bridgeChId;
      } else {
        const nameIsStub = !currentChannel.name || currentChannel.name === bridgeChId;
        if (event.data.author) {
          currentChannel.name = event.data.author;
        } else if (nameIsStub) {
          currentChannel.name = getChannelDisplayName() || currentChannel.name;
        }
      }
      // Backfill: orphan @handle entries in storage (saved before UC ever
      // surfaced for the user) are adopted when name matches author. This is
      // the only path that mutates storage automatically; it is safe because
      // the name-match gate prevents cross-channel adoption. No longer trigger
      // migration purely from id-shape (@handle startsWith), which conflated
      // stale DOM reads with genuine legacy entries and caused silent data
      // corruption on SPA navigation.
      if (event.data.author && isContextValid()) {
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
    if (applyAutomaticLoudnessGain()) {
      notifyPopup();
    } else {
      applyPreferredGain().then(notifyPopup);
    }
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

  function applyAutomaticLoudnessGain() {
    if (!isCurrentAutoApplyEnabled() || currentLoudnessDb === null) return false;
    const gain = calcGainFromLoudness(currentLoudnessDb);
    currentGain = gain;
    setGain(gain);
    return true;
  }

  async function applyPreferredGain() {
    const requestedVideoId = getUrlVideoId();
    const requestedChannelId = currentChannel.id;
    const requestedVideoType = currentVideoType;
    const entry = await loadChannelEntry(requestedChannelId);

    // Ignore a storage result that belongs to state superseded by SPA
    // navigation, bridge metadata, or a settings change.
    if (requestedVideoId !== getUrlVideoId() ||
        requestedChannelId !== currentChannel.id ||
        requestedVideoType !== currentVideoType) return;

    setCurrentAutoApplyFromEntry(entry);
    currentGain = isCurrentAutoApplyEnabled(requestedVideoType) && currentLoudnessDb !== null
      ? calcGainFromLoudness(currentLoudnessDb)
      : extractGainForType(entry, requestedVideoType) ?? 1.0;
    setGain(currentGain);
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

  function fillCurrentChannelNameFromDomFallback() {
    const nameIsStub = !currentChannel.name || currentChannel.name === currentChannel.id;
    if (!nameIsStub) return;
    const freshName = getChannelDisplayName();
    if (freshName) currentChannel.name = freshName;
  }

  // Returns UC-format channel id only. The modern YouTube owner widget
  // commonly renders `/@handle` links, but during SPA navigation those links
  // update asynchronously and can still point to the previous channel. Using
  // the @handle as an identifier conflates two different channels; we refuse
  // it and wait for page-bridge to provide the authoritative UC from the new
  // video's player response.
  function detectChannel() {
    const displayName = getChannelDisplayName();

    const canonical = document.querySelector('link[rel="canonical"][href*="/channel/"]');
    if (canonical) {
      const m = canonical.href.match(/\/channel\/(UC[A-Za-z0-9_-]+)/);
      if (m) {
        return {
          id: m[1],
          name: displayName || m[1],
          url: 'https://www.youtube.com/channel/' + m[1]
        };
      }
    }

    const ownerLink = document.querySelector(
      '#owner a[href*="/channel/"], ' +
      'ytd-video-owner-renderer a[href*="/channel/"]'
    );
    if (ownerLink) {
      const mCh = ownerLink.href.match(/\/channel\/(UC[A-Za-z0-9_-]+)/);
      if (mCh) {
        return {
          id: mCh[1],
          name: displayName || mCh[1],
          url: 'https://www.youtube.com/channel/' + mCh[1]
        };
      }
    }

    const metaChannel = document.querySelector('meta[itemprop="channelId"]');
    if (metaChannel) {
      const id = metaChannel.content;
      return {
        id,
        name: displayName || id,
        url: 'https://www.youtube.com/channel/' + id
      };
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

    const prevVideoId = _lastVideoId;
    _lastVideoId = getUrlVideoId();
    const videoIdChanged = prevVideoId && prevVideoId !== _lastVideoId;
    const hasEarlyBridgeLoudness = !!_lastVideoId &&
      currentLoudnessVideoId === _lastVideoId;
    const hasEarlyBridgeChannel = !!_lastVideoId &&
      currentChannelVideoId === _lastVideoId;
    // On cross-video navigation, clear prior channel so stale data from the
    // previous video cannot leak into the new video's state. detectChannel()
    // may return empty when DOM is mid-transition — bridge will provide UC
    // shortly via requestLoudnessWithRetry. If the bridge already delivered
    // metadata for this URL, preserve that authoritative state instead.
    if (videoIdChanged && !hasEarlyBridgeChannel) {
      currentChannel = { id: '', name: '', url: '' };
      currentChannelVideoId = '';
      currentAutoApplyLoudnessVideo = false;
      currentAutoApplyLoudnessLive = false;
    }

    const ch = detectChannel();
    if (ch.id && !hasEarlyBridgeChannel) currentChannel = ch;

    if (!hasEarlyBridgeLoudness) {
      currentLoudnessDb = null;
      currentLoudnessVideoId = '';
      currentVideoType = 'video';
      currentVideoTypeDetected = false;
      currentIsLiveNow = false;
    }

    await loadSettings();
    // Use the latest bridge state if it arrived before or during the settings
    // read. This avoids replacing an already calculated archive gain with the
    // navigation-time fallback.
    await applyPreferredGain();
    notifyPopup();

    // Fetch loudness + videoType + channelId. Auto mode applies the calculated
    // per-video gain; otherwise the saved channel/type gain remains in use.
    requestLoudnessWithRetry(10, 500).then(async () => {
      await applyPreferredGain();
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
      autoApplyLoudness: isCurrentAutoApplyEnabled(),
      autoApplyLoudnessVideo: currentAutoApplyLoudnessVideo,
      autoApplyLoudnessLive: currentAutoApplyLoudnessLive,
      videoType: currentVideoType,
      videoTypeDetected: currentVideoTypeDetected,
      isLiveNow: currentIsLiveNow,
      isWatchPage: isWatchPage()
    };
  }

  let _lastNotifiedState = '';
  function notifyPopup() {
    if (!isContextValid()) return;
    const state = getState();
    const key = state.loudnessDb + '|' + state.gain + '|' + state.channel.id + '|' + state.channel.name + '|' + state.videoType + '|' + state.videoTypeDetected + '|' + state.isLiveNow + '|' + state.autoApplyLoudnessVideo + '|' + state.autoApplyLoudnessLive;
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
        targetLufs = s.targetLufs ?? DEFAULT_TARGET_LUFS;
        defaultAutoApplyLoudnessVideo =
          s.autoApplyLoudnessVideoDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
        defaultAutoApplyLoudnessLive =
          s.autoApplyLoudnessLiveDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
        showGainOverlay = !!s.showGainOverlay;
        applyPreferredGain().then(() => {
          updateGainOverlay();
          notifyPopup();
        });
      }
      if (changes[CHANNEL_VOLUMES_KEY] && currentChannel.id) {
        const all = changes[CHANNEL_VOLUMES_KEY].newValue || {};
        const oldAll = changes[CHANNEL_VOLUMES_KEY].oldValue || {};
        const entry = all[currentChannel.id];
        const oldEntry = oldAll[currentChannel.id];
        const previousAutoApplyVideo = resolveAutoApplyForType(oldEntry, 'video');
        const previousAutoApplyLive = resolveAutoApplyForType(oldEntry, 'live');
        const previousAutoApply = currentVideoType === 'live'
          ? previousAutoApplyLive
          : previousAutoApplyVideo;
        setCurrentAutoApplyFromEntry(entry);
        const currentAutoApply = isCurrentAutoApplyEnabled();
        const currentTypeAutoApplyChanged = previousAutoApply !== currentAutoApply;
        const anyAutoApplyChanged =
          previousAutoApplyVideo !== currentAutoApplyLoudnessVideo ||
          previousAutoApplyLive !== currentAutoApplyLoudnessLive;
        const gain = currentAutoApply && currentLoudnessDb !== null
          ? calcGainFromLoudness(currentLoudnessDb)
          : (entry ? extractGainForType(entry, currentVideoType) : 1.0);
        if (gain == null && !currentTypeAutoApplyChanged) {
          if (anyAutoApplyChanged) notifyPopup();
          return;
        }
        const nextGain = gain ?? 1.0;
        if (nextGain !== currentGain) {
          currentGain = nextGain;
          setGain(nextGain);
        }
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
      if (isCurrentAutoApplyEnabled()) {
        sendResponse({ ok: false, reason: 'auto apply enabled' });
        return true;
      }
      if (currentLoudnessDb === null || !currentChannel.id) {
        sendResponse({ ok: false, reason: 'no loudness data' });
        return true;
      }
      // The bridge author is authoritative. DOM is only a fallback while the
      // current name is still empty or a channel-ID placeholder.
      fillCurrentChannelNameFromDomFallback();
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
      fillCurrentChannelNameFromDomFallback();
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
        currentAutoApplyLoudnessVideo = false;
        currentAutoApplyLoudnessLive = false;
        currentGain = 1.0;
        setGain(currentGain);
        notifyPopup();
        sendResponse({ ok: true });
      });
      return true;
    }

    if (msg.type === 'setAutoApplyLoudness') {
      if (!currentChannel.id || msg.channelId !== currentChannel.id) {
        sendResponse({ ok: false, reason: 'channel mismatch' });
        return true;
      }
      const videoType = msg.videoType === 'live' ? 'live' : 'video';
      fillCurrentChannelNameFromDomFallback();
      saveChannelAutoApply(
        currentChannel.id,
        currentChannel.name,
        !!msg.enabled,
        videoType,
        currentChannel.url
      ).then(async () => {
        await applyPreferredGain();
        notifyPopup();
        sendResponse({ ok: true, ...getState() });
      });
      return true;
    }

    if (msg.type === 'setTargetLufs') {
      const { value } = msg;
      saveSettings({ targetLufs: value }).then(() => {
        applyAutomaticLoudnessGain();
        notifyPopup();
        sendResponse({ ok: true });
      });
      return true;
    }

    if (msg.type === 'forceDetect') {
      const urlVideoId = new URL(location.href).searchParams.get('v') || '';
      const stale = !currentChannel.id || (urlVideoId && urlVideoId !== _lastVideoId);
      // Diagnostic dump: captures every input used to judge channel / videoType
      // so a mismatched popup display can be reproduced post-hoc. Fires only on
      // popup open, so console noise is bounded.
      try {
        const canonical = document.querySelector('link[rel="canonical"]');
        const ownerUc = document.querySelector('#owner a[href*="/channel/"], ytd-video-owner-renderer a[href*="/channel/"]');
        const ownerHandle = document.querySelector('#owner a[href*="/@"], ytd-video-owner-renderer a[href*="/@"]');
        const metaCh = document.querySelector('meta[itemprop="channelId"]');
        const nameEl = document.querySelector('#owner #channel-name a, ytd-video-owner-renderer #channel-name a');
        console.log('[YTCV][popup-open]', {
          url: location.href,
          pathname: location.pathname,
          urlVideoId,
          lastVideoId: _lastVideoId,
          stale,
          applyRunning: _applyRunning,
          currentChannel: { ...currentChannel },
          currentVideoType,
          currentIsLiveNow,
          currentLoudnessDb,
          currentGain,
          dom: {
            canonicalHref: canonical?.href || null,
            ownerChannelHref: ownerUc?.href || null,
            ownerHandleHref: ownerHandle?.href || null,
            metaChannelId: metaCh?.content || null,
            channelNameText: nameEl?.textContent?.trim() || null
          }
        });
      } catch (_) { /* logging must never break flow */ }
      // Also request MAIN-world diagnostic from page-bridge (player response,
      // movie_player state, flexy data — none visible from ISOLATED world).
      try { window.postMessage({ type: '__yt_channel_volume_diag__' }, '*'); } catch (_) {}

      async function sendDetectedState() {
        if (!currentVideoTypeDetected) {
          await requestLoudnessWithRetry(4, 250);
        } else {
          requestLoudness();
        }
        // A bridge response can change the channel and start an asynchronous
        // preference load. Resolve it before the popup becomes visible.
        await applyPreferredGain();
        sendResponse(getState());
      }

      if (stale && !_applyRunning) {
        triggerApply().then(sendDetectedState);
      } else {
        sendDetectedState();
      }
      return true;
    }
  });

  // Test-only: expose internals for state transition testing
  if (typeof globalThis.__TEST_YTCV__ !== 'undefined') {
    globalThis.__YTCV__ = {
      get state() {
        return {
          currentChannel, currentChannelVideoId,
          currentGain, currentLoudnessDb, currentLoudnessVideoId,
          currentVideoType, currentVideoTypeDetected, currentIsLiveNow, showGainOverlay,
          currentAutoApplyLoudnessVideo, currentAutoApplyLoudnessLive,
          _lastVideoId, _lastProcessedVideo, _applyRunning, connectedVideo,
          targetLufs, defaultAutoApplyLoudnessVideo,
          defaultAutoApplyLoudnessLive, gainNode, audioCtx
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
      saveChannelAutoApply,
      applyPreferredGain,
      notifyPopup,
      // Setters for test setup
      _set(key, val) {
        switch (key) {
          case 'currentChannel': currentChannel = val; break;
          case 'currentChannelVideoId': currentChannelVideoId = val; break;
          case 'currentGain': currentGain = val; break;
          case 'currentVideoType': currentVideoType = val; break;
          case 'currentVideoTypeDetected': currentVideoTypeDetected = val; break;
          case '_lastVideoId': _lastVideoId = val; break;
          case '_lastProcessedVideo': _lastProcessedVideo = val; break;
          case '_applyRunning': _applyRunning = val; break;
          case 'targetLufs': targetLufs = val; break;
          case 'defaultAutoApplyLoudnessVideo': defaultAutoApplyLoudnessVideo = val; break;
          case 'defaultAutoApplyLoudnessLive': defaultAutoApplyLoudnessLive = val; break;
          case 'currentAutoApplyLoudnessVideo': currentAutoApplyLoudnessVideo = val; break;
          case 'currentAutoApplyLoudnessLive': currentAutoApplyLoudnessLive = val; break;
          case 'currentLoudnessDb': currentLoudnessDb = val; break;
          case 'currentLoudnessVideoId': currentLoudnessVideoId = val; break;
        }
      }
    };
  }
})();
