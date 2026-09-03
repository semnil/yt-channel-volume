// content.js — YT Channel Volume
// Reads YouTube's Content Loudness and applies automatic or saved per-channel gain.
// loudnessDb extraction is handled by page-bridge.js (MAIN world).

(() => {
  'use strict';

  // A failed save leaves the GainNode at a level nothing recorded, and a failed
  // apply leaves the popup waiting. Extension reload is the documented cause
  // and needs no console noise; any other cause has to be visible.
  function reportFailure(what, err) {
    if (!isContextValid()) return;
    console.error('[YTCV] ' + what, err);
  }

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
  // Invalidates asynchronous preference reads when a newer storage change has
  // already been applied. Without this, an older read can undo a cross-tab
  // gain update after storage.onChanged commits it.
  let storageRevision = 0;
  // Resolves once the legacy fold has been attempted; `storageMigrated` says
  // whether it succeeded. Until it has, the channel map still holds the
  // pre-unification shape, where a gain without an Auto flag meant Auto was
  // off — resolving it under the current rule hands the channel to Auto and
  // overwrites the gain the user saved.
  let storageReady = Promise.resolve();
  let storageSettled = true;
  let storageMigrated = false;
  let foldInFlight = null;

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

  function resolveAutoApplyForType(entry, videoType) {
    const defaultValue = videoType === 'live'
      ? defaultAutoApplyLoudnessLive
      : defaultAutoApplyLoudnessVideo;
    return resolveAutoApplySetting(entry, videoType, defaultValue, !storageMigrated);
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

  function isCurrentManualGainLocked() {
    return isManualGainLocked(
      isCurrentAutoApplyEnabled(),
      currentLoudnessDb !== null
    );
  }

  async function loadChannelEntry(channelId) {
    if (!channelId || !isContextValid()) return null;
    const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
    const all = data[CHANNEL_VOLUMES_KEY] || {};
    return all[channelId] || null;
  }

  // Channel writes go to the service worker, the one context that performs
  // them. A read-modify-write done here would race the other tabs, which all
  // hold the same channel map.
  async function requestChannelWrite(type, payload) {
    if (!isContextValid()) return;
    const response = await chrome.runtime.sendMessage({
      type: 'store:' + type, ...payload
    });
    if (!response?.ok) {
      throw new Error(response?.reason || 'channel write failed');
    }
  }

  // `autoApply` pins the Auto state that was in effect for a manual save, so
  // an all-channel default cannot later take over a gain the user chose. Auto
  // writes its own gain without it and keeps following the default.
  function saveChannelGain(channelId, name, gain, videoType, url, autoApply) {
    if (!channelId) return Promise.resolve();
    return requestChannelWrite('saveChannelGain', {
      channelId, name, gain, videoType, url, autoApply
    });
  }

  function saveManualChannelGain(channelId, name, gain, videoType, url) {
    return saveChannelGain(
      channelId, name, gain, videoType, url, isCurrentAutoApplyEnabled(videoType)
    );
  }

  function saveChannelAutoApply(channelId, name, enabled, videoType, url) {
    if (!channelId) return Promise.resolve();
    return requestChannelWrite('saveChannelAutoApply', {
      channelId, name, enabled, videoType, url
    });
  }

  function deleteChannelGain(channelId) {
    if (!channelId) return Promise.resolve();
    return requestChannelWrite('deleteChannel', { channelId });
  }

  // ── Loudness from page-bridge.js (MAIN world) ─────────────────────

  let loudnessWaiters = [];

  // The bridge answers for the video it read, and `getUrlVideoId` gives the
  // video the URL names — `?v=` where there is one, the `/live/` path segment
  // otherwise. An answer naming another video was queued for a page this tab
  // has already left.
  function isBridgeMessageForCurrentVideo(videoId) {
    if (!videoId) return true;
    const urlVideoId = getUrlVideoId();
    if (!urlVideoId) return true;
    return videoId === urlVideoId;
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
      // LUFS so Auto uses the saved channel gain instead of stale loudness.
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
        // Sent before Auto's own save for this message, so the worker decides
        // the adoption against a map that does not hold that gain yet.
        requestChannelWrite('adoptHandleEntry', {
          channelId: bridgeChId,
          authorName,
          url: 'https://www.youtube.com/channel/' + bridgeChId
        }).catch(err => reportFailure('handle entry not adopted', err));
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
    return calcGain(loudnessDb, targetLufs);
  }

  function applyAutomaticLoudnessGain() {
    // Before the fold, fall through to applyPreferredGain, which waits for it.
    if (!storageSettled) return false;
    if (!isCurrentAutoApplyEnabled() || currentLoudnessDb === null) return false;
    const gain = calcGainFromLoudness(currentLoudnessDb);
    const channelId = currentChannel.id;
    const videoType = currentVideoType;
    commitGain(gain);
    // The calculated gain becomes the channel's stored gain, so a later video
    // of the same channel without Content Loudness keeps the same level. Not
    // before the fold, though: a flagless gain is what a pre-unification
    // manual save looks like, and the fold would pin this channel Auto-off.
    if (storageMigrated) {
      saveChannelGain(
        channelId, currentChannel.name, gain, videoType, currentChannel.url
      ).catch(err => reportFailure('auto gain not stored', err));
    }
    return true;
  }

  async function applyPreferredGain() {
    await storageReady;
    const requestedVideoId = getUrlVideoId();
    const requestedChannelId = currentChannel.id;
    const requestedVideoType = currentVideoType;
    const requestedStorageRevision = storageRevision;
    const entry = await loadChannelEntry(requestedChannelId);

    // Ignore a storage result that belongs to state superseded by SPA
    // navigation, bridge metadata, or a settings change.
    if (requestedVideoId !== getUrlVideoId() ||
        requestedChannelId !== currentChannel.id ||
        requestedVideoType !== currentVideoType ||
        requestedStorageRevision !== storageRevision) return;

    setCurrentAutoApplyFromEntry(entry);
    const autoEnabled = isCurrentAutoApplyEnabled(requestedVideoType);
    const hasLoudness = currentLoudnessDb !== null;
    const gain = autoEnabled && hasLoudness
      ? calcGainFromLoudness(currentLoudnessDb)
      : getChannelGain(entry, requestedVideoType) ?? 1.0;
    commitGain(gain);
    if (autoEnabled && hasLoudness && storageMigrated) {
      // The gain is already playing. A failed write must not abort the caller —
      // `forceDetect` answers the popup from this path.
      await saveChannelGain(
        requestedChannelId, currentChannel.name, gain,
        requestedVideoType, currentChannel.url
      ).catch(err => reportFailure('auto gain not stored', err));
    }
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

  function applyGainToAudio(value) {
    if (value === 1.0 && !gainNode) {
      updateGainOverlay();
      return;
    }
    if (!ensureAudioChain()) return;
    gainNode.gain.value = value;
    updateGainOverlay();
  }

  // The only production path that changes gain. Keeping logical state, the
  // GainNode, and popup projection in one commit prevents one surface from
  // retaining an older value than the others.
  function commitGain(value) {
    const numeric = Number(value);
    const clamped = Number.isFinite(numeric)
      ? Math.max(0, Math.min(6, numeric))
      : 1.0;
    currentGain = clamped;
    applyGainToAudio(clamped);
    notifyPopup();
    return clamped;
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

    if (!_overlayEl) {
      _overlayEl = document.createElement('span');
      _overlayEl.style.cssText =
        'font-size:11px;font-weight:700;color:#4ecdc4;margin-left:6px;' +
        'font-variant-numeric:tabular-nums;pointer-events:none;white-space:nowrap;' +
        'line-height:normal;display:inline-flex;align-items:center;';
    }
    _overlayEl.textContent = Math.round(currentGain * 100) + '%';
    // A rebuilt player is a different volume area, and appending moves the
    // overlay already made into it rather than leaving a copy in the old one.
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
      autoApplyLoudnessVideo: currentAutoApplyLoudnessVideo,
      autoApplyLoudnessLive: currentAutoApplyLoudnessLive,
      videoType: currentVideoType,
      isLiveNow: currentIsLiveNow,
      isWatchPage: isWatchPage()
    };
  }

  let _lastNotifiedState = '';
  function notifyPopup() {
    if (!isContextValid()) return;
    const state = getState();
    const key = state.loudnessDb + '|' + state.gain + '|' + state.channel.id + '|' + state.channel.name + '|' + state.videoType + '|' + state.isLiveNow + '|' + state.autoApplyLoudnessVideo + '|' + state.autoApplyLoudnessLive;
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
    // Taken before the fold is awaited: a second call that arrives during that
    // wait would otherwise pass this check and run a second apply.
    if (_applyRunning) return;
    _applyRunning = true;
    try {
      // A fold that failed leaves the profile on the old rule, so retry it on
      // every apply until it lands rather than waiting for the next page load.
      if (!storageMigrated) await foldLegacyGains();
      await applyVideoVolume();
    } catch (err) {
      reportFailure('apply failed', err);
    } finally {
      _applyRunning = false;
    }
  }

  // A failed fold is not fatal: the profile stays on the pre-unification rule,
  // where a saved gain means Auto is off, so playback still uses what the user
  // saved and Auto cannot overwrite it.
  function foldLegacyGains() {
    if (storageMigrated) return storageReady;
    if (foldInFlight) return foldInFlight;
    storageSettled = false;
    foldInFlight = requestChannelWrite('migrateLegacyGains', {})
      .then(() => { storageMigrated = true; })
      .catch(err => reportFailure('legacy auto gains not folded in', err))
      .then(() => { storageSettled = true; foldInFlight = null; });
    storageReady = foldInFlight;
    return storageReady;
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

  // Fold any pre-unification Auto gains into channelVolumes before the first
  // apply reads them. A concurrent tab writing the same result is harmless.
  if (isContextValid()) {
    foldLegacyGains().then(() => { if (isWatchPage()) triggerApply(); });
  } else if (isWatchPage()) {
    triggerApply();
  }

  // React to settings changes (e.g. overlay toggle from options page)
  if (isContextValid()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      // Another context may have folded the profile while this one's own fold
      // failed. The mark is the canonical state, so adopt it here rather than
      // waiting for the next apply — this event's channel data is already in
      // the folded shape and must be read under the current rule.
      if (changes[UNIFIED_GAINS_KEY]?.newValue === true && !storageMigrated) {
        storageMigrated = true;
        storageSettled = true;
        foldInFlight = null;
        storageRevision++;
        if (!changes[CHANNEL_VOLUMES_KEY]) {
          applyPreferredGain().then(notifyPopup);
        }
      }
      if (changes[SETTINGS_KEY] || changes[CHANNEL_VOLUMES_KEY]) {
        storageRevision++;
      }
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
          : (entry ? getChannelGain(entry, currentVideoType) : 1.0);
        if (gain == null && !currentTypeAutoApplyChanged) {
          if (anyAutoApplyChanged) notifyPopup();
          return;
        }
        const nextGain = gain ?? 1.0;
        if (nextGain !== currentGain) {
          commitGain(nextGain);
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

  // A manual gain is only a gain once it is stored: leaving playback on a
  // value storage refused would show the user a level that reverts at the
  // next navigation. The slider's live preview has already moved the gain by
  // then, so the level to go back to is the one storage still holds.
  function restoreGainAfterFailedSave() {
    return applyPreferredGain().catch(err =>
      reportFailure('gain not restored after a failed save', err));
  }

  function respondOnce(sendResponse) {
    let answered = false;
    return payload => {
      if (answered) return;
      answered = true;
      sendResponse(payload);
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const reply = respondOnce(sendResponse);
    try {
      return handleMessage(msg, reply);
    } catch (err) {
      // commitGain and the DOM reads around it run synchronously here.
      reportFailure((msg?.type || 'message') + ' failed', err);
      reply({ ok: false, reason: 'request failed' });
      return true;
    }
  });

  function handleMessage(msg, sendResponse) {
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
      commitGain(gain);
      saveManualChannelGain(currentChannel.id, currentChannel.name, gain, currentVideoType, currentChannel.url).then(() => {
        notifyPopup();
        sendResponse({ ok: true, gain });
      }).catch(err => {
        reportFailure('applyLoudness failed', err);
        // Answer after the restore, so the state the popup reads back is the
        // level that is playing.
        restoreGainAfterFailedSave().then(() =>
          sendResponse({ ok: false, reason: 'request failed' }));
      });
      return true;
    }

    if (msg.type === 'setGainLive') {
      if (isCurrentManualGainLocked()) {
        sendResponse({ ok: false, reason: 'auto apply controls current gain' });
        return true;
      }
      commitGain(msg.gain);
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'setGain') {
      if (isCurrentManualGainLocked()) {
        sendResponse({ ok: false, reason: 'auto apply controls current gain' });
        return true;
      }
      const { channelId, gain } = msg;
      fillCurrentChannelNameFromDomFallback();
      commitGain(gain);
      saveManualChannelGain(channelId, currentChannel.name, gain, currentVideoType, currentChannel.url).then(() => {
        notifyPopup();
        sendResponse({ ok: true });
      }).catch(err => {
        reportFailure('setGain failed', err);
        restoreGainAfterFailedSave().then(() =>
          sendResponse({ ok: false, reason: 'request failed' }));
      });
      return true;
    }

    if (msg.type === 'clearChannel') {
      const { channelId } = msg;
      deleteChannelGain(channelId).then(() => {
        currentAutoApplyLoudnessVideo = false;
        currentAutoApplyLoudnessLive = false;
        commitGain(1.0);
        notifyPopup();
        sendResponse({ ok: true });
      }).catch(err => {
        reportFailure('clearChannel failed', err);
        sendResponse({ ok: false, reason: 'request failed' });
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
      }).catch(err => {
        reportFailure('setAutoApplyLoudness failed', err);
        sendResponse({ ok: false, reason: 'request failed' });
      });
      return true;
    }

    if (msg.type === 'setTargetLufs') {
      const { value } = msg;
      saveSettings({ targetLufs: value }).then(() => {
        applyAutomaticLoudnessGain();
        notifyPopup();
        sendResponse({ ok: true });
      }).catch(err => {
        reportFailure('setTargetLufs failed', err);
        sendResponse({ ok: false, reason: 'request failed' });
      });
      return true;
    }

    if (msg.type === 'forceDetect') {
      const urlVideoId = getUrlVideoId();
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
        // Always wait for the current video's bridge response. When videoType
        // was already known, the previous implementation sent the request but
        // returned the old fallback state before the archive LUFS arrived.
        await requestLoudnessWithRetry(4, 250);
        // A bridge response can change the channel and start an asynchronous
        // preference load. Resolve it before the popup becomes visible.
        await applyPreferredGain();
        sendResponse(getState());
      }

      const detected = stale && !_applyRunning
        ? triggerApply().then(sendDetectedState)
        : Promise.resolve().then(sendDetectedState);
      detected.catch(err => {
        reportFailure('forceDetect failed', err);
        sendResponse({ ok: false, reason: 'request failed' });
      });
      return true;
    }
  }

  // Test-only: expose internals for state transition testing
  if (typeof globalThis.__TEST_YTCV__ !== 'undefined') {
    globalThis.__YTCV__ = {
      get state() {
        return {
          currentChannel, currentChannelVideoId,
          currentGain, currentLoudnessDb, currentLoudnessVideoId,
          currentVideoType, currentVideoTypeDetected, currentIsLiveNow, showGainOverlay,
          currentAutoApplyLoudnessVideo, currentAutoApplyLoudnessLive,
          storageSettled, storageMigrated,
          _lastVideoId, _lastProcessedVideo, _applyRunning, connectedVideo,
          targetLufs, defaultAutoApplyLoudnessVideo,
          defaultAutoApplyLoudnessLive, gainNode, audioCtx
        };
      },
      applyVideoVolume,
      triggerApply,
      detectChannel,
      getChannelDisplayName,
      commitGain,
      getState,
      isWatchPage,
      getUrlVideoId,
      calcGainFromLoudness,
      loadChannelEntry,
      saveChannelGain,
      saveManualChannelGain,
      saveChannelAutoApply,
      deleteChannelGain,
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
          case 'storageReady': storageReady = val; break;
          case 'storageSettled': storageSettled = val; break;
          case 'storageMigrated': storageMigrated = val; break;
          case 'currentLoudnessVideoId': currentLoudnessVideoId = val; break;
        }
      }
    };
  }
})();
