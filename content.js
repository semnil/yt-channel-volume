// content.js — YT Channel Volume
// Applies Auto's gain, from Content Loudness or a live stream's level, or the saved per-channel gain.
// loudnessDb and live level extraction is handled by page-bridge.js (MAIN world).

(() => {
  'use strict';

  // A failed save leaves the GainNode at a level nothing recorded, and a failed
  // apply leaves the popup waiting. Extension reload is the documented cause
  // and needs no console noise; any other cause has to be visible.
  function reportFailure(what, err) {
    if (!isContextValid()) return;
    console.error('[YTCV] ' + what, err);
  }

  // A write the viewer did not ask for is made again by the next video, the
  // next navigation or the next apply. Each of them keeps a stretch of its own,
  // under the name it is reported by: the start is named at info, the error is
  // left for a write of that name that failed after another, and a write of
  // that name that lands ends the stretch. Chrome collects the error as an
  // error of the extension.
  const unaskedWriteStretches = new Map();

  function nameUnaskedWrite(what, write) {
    return write.then(() => {
      unaskedWriteStretches.delete(what);
    }, (err) => {
      if (!isContextValid()) return;
      const stretch = unaskedWriteStretches.get(what);
      if (!stretch) {
        unaskedWriteStretches.set(what, { reported: false });
        console.info('[YTCV] ' + what, err);
        return;
      }
      if (!stretch.reported) {
        stretch.reported = true;
        console.error('[YTCV] ' + what, err);
      }
    });
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
  // The level of the plain rendition the player response describes, before
  // stable volume. Stored gains are held against it.
  let currentBaseLoudnessDb = null;
  let currentLoudnessVideoId = '';
  // A live stream's own level (LKFS) as the player names it on air, from the
  // latest bridge message; null where that message carried none. This is the
  // level Auto plays and stores.
  let currentLiveLkfs = null;
  // The live level in hand: the one the latest bridge message named, or one the
  // popup's read named since. The popup is shown it and "Apply to channel" and
  // turning Auto on apply it; nothing else does, so a read alone never moves
  // what Auto plays or stores.
  let readLiveLkfs = null;
  // The live gain this page last stored, and for which video and type. A live
  // gain is stored again only when it has moved far enough from this one, for
  // the same video and type.
  let liveSaveBaseline = null;
  let liveSaveInFlight = false;
  // The video the first apply after a change of URL has run for. Until it has,
  // the tab can still hold the channel of the page it left, so a bridge
  // message makes neither Auto's own save nor the live save.
  let appliedVideoId = '';
  // When a live level last set the gain playing, and for which video; null
  // until a live gain plays for the video. `at` is null from a message that
  // names no live level until the next live gain, so a level coming back
  // starts its count from there, and -Infinity after Target LUFS changes, so
  // the next live gain plays as it stands. It is kept only while the channel
  // in hand is named for the URL's video, and null again once the bridge names
  // another channel.
  let liveRaiseFrom = null;
  // The live level the bridge last named for the video, and how far the one it
  // names now rose over it (to 0.1 dB), or null.
  let liveLevelBefore = null;
  let liveLevelRise = null;
  // The gain the channel's entry holds for live, taken with the Auto flags;
  // the first live gain a page plays is held to 3 dB over it (liveGainToPlay).
  let storedLiveGain = null;
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
  // The same for the settings alone: a settings read is answered after a change
  // that came in while it was out, and what it read is older than that change.
  let settingsRevision = 0;
  // What applyPreferredGain hands back when a change notification arrived
  // while it read the entry, and it applied nothing.
  const STORAGE_MOVED = 'storage moved';
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
    const revision = settingsRevision;
    const s = await readSettings();
    if (revision === settingsRevision) takeSettings(s);
    return { targetLufs, defaultAutoApplyLoudnessVideo, defaultAutoApplyLoudnessLive };
  }

  function takeSettings(s) {
    targetLufs = s.targetLufs ?? DEFAULT_TARGET_LUFS;
    defaultAutoApplyLoudnessVideo =
      s.autoApplyLoudnessVideoDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
    defaultAutoApplyLoudnessLive =
      s.autoApplyLoudnessLiveDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
    showGainOverlay = !!s.showGainOverlay;
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
    storedLiveGain = normalizeStoredGain(getChannelGain(entry, 'live'));
  }

  function isCurrentAutoApplyEnabled(videoType = currentVideoType) {
    return videoType === 'live'
      ? currentAutoApplyLoudnessLive
      : currentAutoApplyLoudnessVideo;
  }

  function isCurrentManualGainLocked() {
    return isManualGainLocked(
      isCurrentAutoApplyEnabled(),
      currentLoudnessDb !== null || readLiveLkfs !== null
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
    // A gain stored while the plain rendition's level is known is held
    // against it; one stored without that level plays as it is.
    return requestChannelWrite('saveChannelGain', {
      channelId, name, gain, videoType, url, autoApply,
      heldAgainstPlain: currentBaseLoudnessDb !== null
    });
  }

  function saveManualChannelGain(channelId, name, gain, videoType, url) {
    return saveChannelGain(
      channelId, name, gain, videoType, url, isCurrentAutoApplyEnabled(videoType)
    );
  }

  // A gain from a live stream's own level is the gain for what is being
  // played, so it is stored to play as it is, with any mark the type had taken
  // off. `autoApply` as above. Its callers hold a channel id already.
  function saveLiveChannelGain(channelId, name, gain, videoType, url, autoApply) {
    return requestChannelWrite('saveChannelGain', {
      channelId, name, gain, videoType, url, autoApply, heldAgainstPlain: false
    });
  }

  function saveChannelAutoApply(channelId, name, enabled, videoType, url) {
    if (!channelId) return Promise.resolve();
    return requestChannelWrite('saveChannelAutoApply', {
      channelId, name, enabled, videoType, url
    });
  }

  // ── Loudness from page-bridge.js (MAIN world) ─────────────────────

  let loudnessWaiters = [];

  // The bridge answers for the video it read, and `getUrlVideoId` gives the
  // video the URL names — `?v=` where there is one, the `/live/` path segment
  // otherwise, and on a channel's live URL the video the canonical link names.
  // An answer naming another video was queued for a page this tab has already
  // left.
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

    // A script in the page's own world can post this message too. Each field is
    // taken only where it is of the type the bridge sends.
    const db = event.data.loudnessDb;
    const hasLoudness = Number.isFinite(db);
    const baseDb = event.data.baseLoudnessDb;
    const hasBase = typeof baseDb === 'number' && !isNaN(baseDb);
    const loudnessVideoChanged = bridgeVideoId &&
      bridgeVideoId !== currentLoudnessVideoId;
    if (loudnessVideoChanged) {
      // `null` is meaningful for a new video: it clears the previous video's
      // LUFS so Auto uses the saved channel gain instead of stale loudness.
      currentLoudnessVideoId = bridgeVideoId;
      currentLoudnessDb = hasLoudness ? db : null;
      currentBaseLoudnessDb = hasBase ? baseDb : null;
    } else if (hasLoudness) {
      currentLoudnessDb = db;
      if (hasBase) currentBaseLoudnessDb = baseDb;
    }
    // Every message says what the player names now, so one without a live
    // level takes the last one away.
    currentLiveLkfs = Number.isFinite(event.data.liveLkfs) ? event.data.liveLkfs : null;
    const levelVideoId = bridgeVideoId || getUrlVideoId();
    liveLevelRise = currentLiveLkfs !== null && liveLevelBefore && liveLevelBefore.videoId === levelVideoId
      ? Math.round((currentLiveLkfs - liveLevelBefore.lkfs) * 10) / 10
      : null;
    if (currentLiveLkfs !== null) liveLevelBefore = { videoId: levelVideoId, lkfs: currentLiveLkfs };
    readLiveLkfs = currentLiveLkfs;
    if (currentLiveLkfs === null && liveRaiseFrom) liveRaiseFrom = { ...liveRaiseFrom, at: null };
    const hasLiveContent = typeof event.data.isLiveContent === 'boolean';
    if (hasLiveContent) {
      currentVideoType = event.data.isLiveContent ? 'live' : 'video';
      currentVideoTypeDetected = true;
      currentIsLiveNow = !!event.data.isLiveNow;
    }
    // Only accept channelId if it came with valid data for current video.
    // isLiveContent is always a boolean from page-bridge.js; anything else is
    // a message the bridge did not send. Premiere videos report
    // isLiveContent=false with db=null, so relying on db alone loses their
    // channelId and leaves saved gain unapplied.
    const bridgeChId = event.data.channelId;
    const author = typeof event.data.author === 'string' ? event.data.author : '';
    const hasValidData = hasLoudness || hasLiveContent;
    if (hasValidData && isChannelId(bridgeChId)) {
      if (bridgeVideoId) currentChannelVideoId = bridgeVideoId;
      const oldId = currentChannel.id;
      const idChanged = oldId !== bridgeChId;
      if (idChanged) {
        currentChannel.id = bridgeChId;
        liveRaiseFrom = null;
        currentChannel.url = 'https://www.youtube.com/channel/' + bridgeChId;
        currentAutoApplyLoudnessVideo = false;
        currentAutoApplyLoudnessLive = false;
        // Bridge author comes from the current video's player response — it is
        // authoritative for bridgeChId. Prefer it over DOM, which may lag the
        // SPA navigation and still describe the previous channel.
        currentChannel.name = author || getChannelDisplayName() || bridgeChId;
      } else {
        const nameIsStub = !currentChannel.name || currentChannel.name === bridgeChId;
        if (author) {
          currentChannel.name = author;
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
      if (author && isContextValid()) {
        // Sent before Auto's own save for this message, so the worker decides
        // the adoption against a map that does not hold that gain yet.
        nameUnaskedWrite('handle entry not adopted', requestChannelWrite('adoptHandleEntry', {
          channelId: bridgeChId,
          authorName: author,
          url: 'https://www.youtube.com/channel/' + bridgeChId
        }));
      }
    }
    const source = typeof event.data.source === 'string' ? event.data.source : '';
    // Applying Auto's gain throws where the audio chain cannot be built; the
    // follow and the waiters below run either way.
    try {
      if (applyAutomaticLoudnessGain(source)) {
        notifyPopup();
      } else {
        applyPreferredGain(source, { fromMessage: true }).then(notifyPopup)
          .catch(err => reportFailure('apply failed', err));
      }
    } catch (err) {
      reportFailure('apply failed', err);
    }
    syncLiveFollow();
    const waiters = loudnessWaiters;
    loudnessWaiters = [];
    for (const resolve of waiters) resolve(db);
  });

  function requestLoudness() {
    window.postMessage({ type: '__yt_channel_volume_request__' }, '*');
  }

  // The live level alone, which the popup asks for while it is open. A level
  // the bridge names for the video the URL does becomes the level in hand
  // (readLiveLkfs), and the popup is shown it. Auto's level is left as it is:
  // Auto takes a level only from the bridge's full answer, so nothing that
  // re-applies Auto's gain in between — a change in storage, a settings write —
  // plays or stores this one. An answer naming no level leaves the one in hand.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== '__yt_channel_volume_live__') return;
    const videoId = typeof event.data.videoId === 'string' ? event.data.videoId : '';
    if (!isBridgeMessageForCurrentVideo(videoId)) return;
    if (!Number.isFinite(event.data.liveLkfs)) return;
    readLiveLkfs = event.data.liveLkfs;
    notifyPopup();
  });

  function requestLoudnessWithRetry(maxAttempts, intervalMs) {
    return new Promise((resolve) => {
      let attempts = 0;
      function attempt() {
        attempts++;
        const timer = setTimeout(() => {
          const idx = loudnessWaiters.indexOf(waiterFn);
          if (idx >= 0) loudnessWaiters.splice(idx, 1);
          if (currentLoudnessDb !== null || currentLiveLkfs !== null) {
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

  // While Auto is on for the type being watched and the video is a stream on
  // air, or the player names a live level for it, the bridge is asked again
  // every LIVE_FOLLOW_INTERVAL_MS. Its answer goes through the message handler
  // above, which applies the level and decides whether to store it.
  const LIVE_FOLLOW_INTERVAL_MS = 10000;
  let liveFollowTimer = null;

  function shouldFollowLive() {
    return isWatchPage() && isCurrentAutoApplyEnabled() &&
      (currentIsLiveNow || currentLiveLkfs !== null);
  }

  function syncLiveFollow() {
    if (!shouldFollowLive()) {
      clearTimeout(liveFollowTimer);
      liveFollowTimer = null;
      return;
    }
    if (liveFollowTimer === null) {
      liveFollowTimer = setTimeout(followLive, LIVE_FOLLOW_INTERVAL_MS);
    }
  }

  function followLive() {
    liveFollowTimer = null;
    requestLoudness();
    syncLiveFollow();
  }

  // ── Gain calculation ───────────────────────────────────────────────

  function calcGainFromLoudness(loudnessDb) {
    return calcGain(loudnessDb, targetLufs);
  }

  // Where the base level is not known, the level playing stands in for it.
  function currentRenditionRatio() {
    return renditionGainRatio(currentLoudnessDb, currentBaseLoudnessDb ?? currentLoudnessDb);
  }

  // A gain held against the plain rendition plays carried to the rendition
  // playing; a gain stored without that mark plays as it is.
  function storedGainToPlaying(entry, videoType, gain) {
    return isGainHeldAgainstPlain(entry, videoType) ? gain * currentRenditionRatio() : gain;
  }

  function playingGainToStored(gain) {
    return gain / currentRenditionRatio();
  }

  // What Auto and "Apply to channel" store: the gain for the base rendition.
  function calcStoredGainFromLoudness() {
    return calcGainFromLoudness(currentBaseLoudnessDb ?? currentLoudnessDb);
  }

  function calcGainFromLiveLevel(liveLkfs = currentLiveLkfs) {
    return calcLiveGain(liveLkfs, targetLufs);
  }

  // The gain Auto plays for the live level it holds. A level that rose
  // LIVE_RISE_DB or more over the one the bridge named before it is taken as
  // LIVE_RISE_AHEAD_DB louder than named. A gain below the one playing is
  // played at once. One above it is played no more than LIVE_RAISE_DB higher
  // for every LIVE_RAISE_PERIOD_MS since a live level last set the gain — or
  // since a live level came back after a message that named none — and gets
  // there over the follows that come after. The first live gain played for a
  // video in this page is held to LIVE_START_CAP_DB over the gain the
  // channel's entry holds for live, where it holds one above 0 and the video
  // plays as live. One over a gain of 0 plays as it stands. Until the channel
  // in hand is named for the URL's video, a live gain neither reads the count
  // nor starts it, so the first one once a channel is named is held by the cap.
  const LIVE_RAISE_DB = 1.5;
  const LIVE_RAISE_PERIOD_MS = 30000;
  const LIVE_START_CAP_DB = 3;
  const LIVE_RISE_DB = 1;
  const LIVE_RISE_AHEAD_DB = 3;

  function liveGainToPlay() {
    const ahead = liveLevelRise !== null && liveLevelRise >= LIVE_RISE_DB ? LIVE_RISE_AHEAD_DB : 0;
    const gain = calcGainFromLiveLevel(currentLiveLkfs + ahead);
    const videoId = getUrlVideoId();
    const now = Date.now();
    const named = channelNamedForUrlVideo();
    const from = named ? liveRaiseFrom : null;
    if (named) liveRaiseFrom = { videoId, at: now };
    if (!from || from.videoId !== videoId) {
      return currentVideoType === 'live' && storedLiveGain > 0
        ? Math.min(gain, storedLiveGain * Math.pow(10, LIVE_START_CAP_DB / 20))
        : gain;
    }
    if (!(currentGain > 0)) return gain;
    const allowedDb = from.at === null ? 0 : LIVE_RAISE_DB * Math.max(0, now - from.at) / LIVE_RAISE_PERIOD_MS;
    return Math.min(gain, currentGain * Math.pow(10, allowedDb / 20));
  }

  // While a slider preview holds gains back, no live gain is worked out, so
  // liveRaiseFrom stays where it was; the preview's gain is set again on the
  // element the page plays now.
  function commitLiveGain() {
    if (previewHoldsGain()) {
      applyGainToAudio(currentGain);
      return;
    }
    commitGain(liveGainToPlay());
  }

  // Auto's own save, and the live save, are made by a tab that is playing the
  // video: not paused and not muted. A volume of 0 and a gain of 0 still count
  // as playing.
  function isVideoPlaying() {
    const video = document.querySelector('video.html5-main-video, video');
    return !!video && !video.paused && !video.muted;
  }

  function applyAutomaticLoudnessGain(source) {
    // Before the fold, fall through to applyPreferredGain, which waits for it.
    if (!storageSettled) return false;
    // A live level is what is being played now, and goes before the response's.
    // What it stores is decided apart from the apply.
    if (isCurrentAutoApplyEnabled() && currentLiveLkfs !== null) {
      commitLiveGain();
      evaluateLiveSave(source, { fromMessage: true });
      return true;
    }
    if (!isCurrentAutoApplyEnabled() || currentLoudnessDb === null) return false;
    const gain = calcGainFromLoudness(currentLoudnessDb);
    const storedGain = calcStoredGainFromLoudness();
    const channelId = currentChannel.id;
    const videoType = currentVideoType;
    commitGainFromElsewhere(gain);
    // The calculated gain becomes the channel's stored gain, so a later video
    // of the same channel without Content Loudness keeps the same level. Not
    // before the fold, though: a flagless gain is what a pre-unification
    // manual save looks like, and the fold would pin this channel Auto-off.
    if (storageMigrated && isVideoPlaying() && appliedVideoId === getUrlVideoId()) {
      nameUnaskedWrite('auto gain not stored', saveChannelGain(
        channelId, currentChannel.name, storedGain, videoType, currentChannel.url
      ));
    }
    return true;
  }

  // `fromMessage` is an apply a bridge message starts, which stores only once
  // `appliedVideoId` names the URL's video. `stores: false` applies the gain
  // and makes neither Auto's own save nor the live save.
  async function applyPreferredGain(source = 'apply', { fromMessage = false, stores = true } = {}) {
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
        requestedVideoType !== currentVideoType) return;
    if (requestedStorageRevision !== storageRevision) return STORAGE_MOVED;

    setCurrentAutoApplyFromEntry(entry);
    const autoEnabled = isCurrentAutoApplyEnabled(requestedVideoType);
    syncLiveFollow();
    if (autoEnabled && currentLiveLkfs !== null) {
      commitLiveGain();
      await evaluateLiveSave(source, { fromMessage, stores });
      return;
    }
    const hasLoudness = currentLoudnessDb !== null;
    const stored = getChannelGain(entry, requestedVideoType);
    const gain = autoEnabled && hasLoudness
      ? calcGainFromLoudness(currentLoudnessDb)
      : (stored != null ? storedGainToPlaying(entry, requestedVideoType, stored) : 1.0);
    commitGainFromElsewhere(gain);
    if (stores && autoEnabled && hasLoudness && storageMigrated && isVideoPlaying() &&
        (!fromMessage || appliedVideoId === requestedVideoId)) {
      // The gain is already playing. A failed write must not abort the caller —
      // `forceDetect` answers the popup from this path.
      await nameUnaskedWrite('auto gain not stored', saveChannelGain(
        requestedChannelId, currentChannel.name, calcStoredGainFromLoudness(),
        requestedVideoType, currentChannel.url
      ));
    }
  }

  // A live gain moves with the stream, so it is not stored on every apply: the
  // first one for a video is stored, and after that one that has moved
  // LIVE_SAVE_STEP_DB or more from the last gain stored, the move taken to the
  // 0.1 dB the player names levels in. Nothing is stored while the gain
  // playing is under the one the level asks for (the start cap, the rise cut
  // or the raise limit holding it); the gain stored is the one the level asks
  // for, once the gain playing has reached it. What was decided is handed back
  // as it stands.
  const LIVE_SAVE_STEP_DB = 1;

  async function evaluateLiveSave(source, { fromMessage = false, stores = true } = {}) {
    const videoId = getUrlVideoId();
    const videoType = currentVideoType;
    const gain = calcGainFromLiveLevel();
    // Each type stores into a slot of its own, so a gain stored for the other
    // type is no measure of this one.
    const baseline = liveSaveBaseline && liveSaveBaseline.videoId === videoId &&
      liveSaveBaseline.videoType === videoType
      ? liveSaveBaseline
      : null;
    const deltaDb = baseline ? Math.round(gainChangeDb(gain, baseline.gain) * 10) / 10 : null;
    const result = {
      decision: !baseline ? 'open' : (deltaDb >= LIVE_SAVE_STEP_DB ? 'delta' : 'skip'),
      source,
      gain,
      baselineGain: baseline ? baseline.gain : null,
      deltaDb,
      saved: false,
      ok: null,
      reason: null
    };
    if (!currentChannel.id || !isCurrentAutoApplyEnabled() ||
        currentLiveLkfs === null || !isContextValid()) {
      result.reason = 'not following';
    } else if (result.decision === 'skip') {
      result.reason = 'under step';
    } else if (!stores) {
      result.reason = 'not stored for this change';
    } else if (fromMessage && appliedVideoId !== videoId) {
      result.reason = 'before first apply';
    } else if (currentGain < gain * (1 - 1e-9)) {
      result.reason = 'held under the level';
    } else if (!storageMigrated) {
      // A flagless gain stored before the fold reads as a manual save to it.
      result.reason = 'before fold';
    } else if (!isVideoPlaying()) {
      result.reason = 'not playing';
    } else if (liveSaveInFlight) {
      result.reason = 'save in flight';
    } else {
      liveSaveInFlight = true;
      result.saved = true;
      result.ok = false;
      await nameUnaskedWrite('live gain not stored', saveLiveChannelGain(
        currentChannel.id, currentChannel.name, gain, videoType, currentChannel.url
      ).then(() => { result.ok = true; }));
      liveSaveInFlight = false;
      if (result.ok) liveSaveBaseline = { videoId, videoType, gain };
      else result.reason = 'write failed';
    }
    return result;
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
    if (metaChannel && isChannelId(metaChannel.content)) {
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
    if (value === 1.0 && !gainNode) return;
    if (!ensureAudioChain()) return;
    gainNode.gain.value = value;
  }

  // The only production path that changes gain. Keeping logical state, the
  // GainNode, and popup projection in one commit prevents one surface from
  // retaining an older value than the others. The audio goes first: where the
  // chain cannot be built, the gain stays what it was everywhere.
  function commitGain(value) {
    const numeric = Number(value);
    const clamped = Number.isFinite(numeric)
      ? Math.max(0, Math.min(6, numeric))
      : 1.0;
    applyGainToAudio(clamped);
    currentGain = clamped;
    updateGainOverlay();
    notifyPopup();
    return clamped;
  }

  // While the popup's slider previews a gain, a gain from anywhere else — a
  // bridge message, another tab's write, a settings change, the live follow —
  // is held back rather than applied. The preview lasts until its gesture
  // ends: the save (setGain) arrives, or PREVIEW_IDLE_MS pass after the last
  // preview; the popup sends the preview again while the slider is held, so
  // a gesture still held does not end. A gesture that ends with no save, and
  // a save refused after a preview, apply what storage holds then. A preview
  // whose state has moved holds nothing back.
  const PREVIEW_IDLE_MS = 2000;
  let preview = null;

  function startPreview(appliesTo) {
    if (preview) clearTimeout(preview.timer);
    preview = { appliesTo, timer: setTimeout(endIdlePreview, PREVIEW_IDLE_MS) };
  }

  function endPreview() {
    if (!preview) return;
    clearTimeout(preview.timer);
    preview = null;
  }

  function endIdlePreview() {
    endPreview();
    applyPreferredGain().then(notifyPopup)
      .catch(err => reportFailure('apply failed', err));
  }

  // Whether a slider preview holds back a gain from elsewhere now.
  function previewHoldsGain() {
    return !!preview && preview.appliesTo === currentGestureState();
  }

  // A gain held back leaves the preview's gain playing, set again on the
  // element the page plays now, so a player rebuilt under the preview is
  // connected at it.
  function commitGainFromElsewhere(value) {
    if (!previewHoldsGain()) return commitGain(value);
    applyGainToAudio(currentGain);
    return currentGain;
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
    if (videoIdChanged) liveSaveBaseline = null;

    // The page names the channel for the document's first video alone. After
    // a navigation it can still name the channel of the video left, and the
    // channel waits for the bridge, which names it for the video it answers.
    const ch = prevVideoId ? null : detectChannel();
    if (ch?.id && !hasEarlyBridgeChannel) {
      currentChannel = ch;
      currentChannelVideoId = _lastVideoId;
    }

    if (!hasEarlyBridgeLoudness) {
      currentLoudnessDb = null;
      currentBaseLoudnessDb = null;
      currentLiveLkfs = null;
      readLiveLkfs = null;
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
    appliedVideoId = _lastVideoId;
    notifyPopup();

    // Fetch loudness + videoType + channelId. Auto mode applies the calculated
    // per-video gain; otherwise the saved channel/type gain remains in use.
    requestLoudnessWithRetry(10, 500).then(async () => {
      await applyPreferredGain();
      notifyPopup();
    }).catch(err => reportFailure('apply failed', err));
  }

  // What a gesture from the popup was made against. The popup echoes it back
  // with the gesture, and a gesture whose state has moved on is not applied to
  // the state that replaced it. Derived from the state itself, so there is no
  // counter to advance and none to forget.
  function currentGestureState() {
    // The video is part of it: a navigation within one channel changes what the
    // popup is showing — the measurement above all — while the channel and the
    // type stay as they were.
    return currentChannel.id + '|' + currentVideoType + '|' + getUrlVideoId();
  }

  // Whether the channel in hand was named for the video the URL names.
  function channelNamedForUrlVideo() {
    return !!currentChannel.id && currentChannelVideoId === getUrlVideoId();
  }

  // A gesture is made against the channel in hand only once that channel was
  // named for the video the URL names; before that it can be the channel of
  // the page the tab left.
  function gestureStateMoved(msg) {
    return msg.appliesTo !== currentGestureState() || !channelNamedForUrlVideo();
  }

  function getState() {
    // A live level is already an absolute one, and goes before the response's.
    const contentLufs = readLiveLkfs !== null
      ? readLiveLkfs
      : (currentLoudnessDb !== null ? YT_REFERENCE_LUFS + currentLoudnessDb : null);
    return {
      appliesTo: currentGestureState(),
      channel: currentChannel,
      gain: currentGain,
      loudnessDb: currentLoudnessDb,
      liveLkfs: readLiveLkfs,
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
    // The state a gesture would be made against is part of the key: a video
    // changing under the popup moves nothing else it shows, and the popup has
    // to be given the state that replaced it or its next gesture is refused.
    const key = state.appliesTo + '|' + state.loudnessDb + '|' + state.liveLkfs + '|' + state.gain + '|' + state.channel.id + '|' + state.channel.name + '|' + state.videoType + '|' + state.isLiveNow + '|' + state.autoApplyLoudnessVideo + '|' + state.autoApplyLoudnessLive;
    if (key === _lastNotifiedState) return;
    _lastNotifiedState = key;
    chrome.runtime.sendMessage({ type: 'stateChanged', ...state }).catch(() => {});
  }

  // ── Navigation handling (YouTube SPA) ──────────────────────────────

  // A channel's live URL (`/@<handle>/live`, `/channel/<id>/live`, and the
  // older `/c/<name>/live`, `/user/<name>/live` and `/<name>/live`) shows the
  // stream the channel has on air, or the one it has coming, without naming
  // it in the URL; the page's canonical link names it as `/watch?v=<id>`.
  // Where the channel has neither, the page is the channel's own, and its
  // canonical link names the channel. Mirrored in page-bridge.js.
  const CHANNEL_LIVE_PATH = /^\/(?:(?:channel|c|user)\/)?[^/]+\/live\/?$/;

  function canonicalVideoId() {
    try {
      const u = new URL(document.querySelector('link[rel="canonical"]')?.href);
      return u.pathname === '/watch' ? u.searchParams.get('v') || '' : '';
    } catch (_) { return ''; }
  }

  function isWatchPage() {
    const p = location.pathname;
    return p === '/watch' || p.startsWith('/live/') ||
      (CHANNEL_LIVE_PATH.test(p) && canonicalVideoId() !== '');
  }

  function getUrlVideoId() {
    try {
      const u = new URL(location.href);
      const q = u.searchParams.get('v');
      if (q) return q;
      const m = u.pathname.match(/^\/live\/([^/?#]+)/);
      if (m) return m[1];
      return CHANNEL_LIVE_PATH.test(u.pathname) ? canonicalVideoId() : '';
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
    foldInFlight = nameUnaskedWrite('legacy auto gains not folded in',
      requestChannelWrite('migrateLegacyGains', {}).then(() => { storageMigrated = true; }))
      .then(() => { storageSettled = true; foldInFlight = null; });
    storageReady = foldInFlight;
    return storageReady;
  }

  // The page's video starting to play is applied again, and Auto's own save
  // is made then.
  document.addEventListener('play', (event) => {
    if (!isWatchPage() || event.target !== document.querySelector('video.html5-main-video, video')) return;
    applyPreferredGain('play').then(notifyPopup)
      .catch(err => reportFailure('apply failed', err));
  }, true);

  document.addEventListener('yt-navigate-finish', triggerApply);
  window.addEventListener('popstate', triggerApply);
  // Leaving a watch page ends the live follow without waiting for an apply,
  // which a page that is not a watch page does not run.
  document.addEventListener('yt-navigate-finish', syncLiveFollow);
  window.addEventListener('popstate', syncLiveFollow);
  document.addEventListener('visibilitychange', () => {
    syncLiveFollow();
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

  // React to settings changes (e.g. overlay toggle from options page, or, with
  // Chrome sync on, from another Chrome the user is signed in to). The settings
  // live in sync; the settings key in local is only the copy the worker moves
  // out of it, and its removal is not a change of settings.
  if (isContextValid()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync') {
        if (!changes[SETTINGS_KEY]) return;
        storageRevision++;
        settingsRevision++;
        const targetBefore = targetLufs;
        const videoDefaultBefore = defaultAutoApplyLoudnessVideo;
        const liveDefaultBefore = defaultAutoApplyLoudnessLive;
        takeSettings(changes[SETTINGS_KEY].newValue || {});
        if (liveRaiseFrom && targetLufs !== targetBefore) liveRaiseFrom = { ...liveRaiseFrom, at: -Infinity };
        // The gain is applied again on every settings change; Auto's own save
        // follows only a change of the target or of an all-channel default.
        const stores = targetLufs !== targetBefore ||
          defaultAutoApplyLoudnessVideo !== videoDefaultBefore ||
          defaultAutoApplyLoudnessLive !== liveDefaultBefore;
        applyPreferredGain('apply', { stores })
          // A notification that landed during the read dropped the apply,
          // Auto's save with it; it is made once more against storage as it
          // stands then.
          .then(result => (result === STORAGE_MOVED ? applyPreferredGain('apply', { stores }) : result))
          .then(() => {
            updateGainOverlay();
            notifyPopup();
          }).catch(err => reportFailure('apply failed', err));
        return;
      }
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
          applyPreferredGain().then(notifyPopup)
            .catch(err => reportFailure('apply failed', err));
        }
      }
      if (changes[CHANNEL_VOLUMES_KEY]) {
        storageRevision++;
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
        syncLiveFollow();
        const currentAutoApply = isCurrentAutoApplyEnabled();
        const currentTypeAutoApplyChanged = previousAutoApply !== currentAutoApply;
        const anyAutoApplyChanged =
          previousAutoApplyVideo !== currentAutoApplyLoudnessVideo ||
          previousAutoApplyLive !== currentAutoApplyLoudnessLive;
        const stored = entry ? getChannelGain(entry, currentVideoType) : 1.0;
        // This tab's live level goes before a gain another tab stored.
        let gain;
        if (currentAutoApply && currentLiveLkfs !== null) {
          gain = liveGainToPlay();
        } else if (currentAutoApply && currentLoudnessDb !== null && currentLiveLkfs === null) {
          gain = calcGainFromLoudness(currentLoudnessDb);
        } else gain = stored != null ? storedGainToPlaying(entry, currentVideoType, stored) : stored;
        if (gain == null && !currentTypeAutoApplyChanged) {
          if (anyAutoApplyChanged) notifyPopup();
          return;
        }
        const nextGain = gain ?? 1.0;
        if (nextGain !== currentGain) {
          commitGainFromElsewhere(nextGain);
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
    endPreview();
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

    if (msg.type === 'askLiveLevel') {
      window.postMessage({ type: '__yt_channel_volume_live_ask__' }, '*');
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'applyLoudness') {
      if (gestureStateMoved(msg)) {
        sendResponse({ ok: false, reason: 'state moved' });
        return true;
      }
      if (isCurrentAutoApplyEnabled()) {
        sendResponse({ ok: false, reason: 'auto apply enabled' });
        return true;
      }
      if ((currentLoudnessDb === null && readLiveLkfs === null) || !currentChannel.id) {
        sendResponse({ ok: false, reason: 'no loudness data' });
        return true;
      }
      // The bridge author is authoritative. DOM is only a fallback while the
      // current name is still empty or a channel-ID placeholder.
      fillCurrentChannelNameFromDomFallback();
      // A live level — the one in hand — goes before the response's, and its
      // gain is stored as it plays.
      const live = readLiveLkfs !== null;
      const gain = live ? calcGainFromLiveLevel(readLiveLkfs) : calcGainFromLoudness(currentLoudnessDb);
      commitGain(gain);
      const saved = live
        ? saveLiveChannelGain(currentChannel.id, currentChannel.name, gain, currentVideoType, currentChannel.url, isCurrentAutoApplyEnabled(currentVideoType))
        : saveManualChannelGain(currentChannel.id, currentChannel.name, calcStoredGainFromLoudness(), currentVideoType, currentChannel.url);
      saved.then(() => {
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
      if (gestureStateMoved(msg)) {
        sendResponse({ ok: false, reason: 'state moved' });
        return true;
      }
      if (isCurrentManualGainLocked()) {
        sendResponse({ ok: false, reason: 'auto apply controls current gain' });
        return true;
      }
      commitGain(msg.gain);
      startPreview(msg.appliesTo);
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'setGain') {
      // The save ends the gesture, whatever becomes of it.
      const previewed = preview !== null;
      endPreview();
      if (gestureStateMoved(msg)) {
        // The preview may have moved the level while the state still held, so
        // the level goes back to what storage has for the state now in hand.
        restoreGainAfterFailedSave().then(() =>
          sendResponse({ ok: false, reason: 'state moved' }));
        return true;
      }
      if (isCurrentManualGainLocked()) {
        if (!previewed) {
          sendResponse({ ok: false, reason: 'auto apply controls current gain' });
          return true;
        }
        // A preview went ahead of the lock, so the level goes back to what
        // storage has for the state in hand.
        restoreGainAfterFailedSave().then(() =>
          sendResponse({ ok: false, reason: 'auto apply controls current gain' }));
        return true;
      }
      const { gain } = msg;
      fillCurrentChannelNameFromDomFallback();
      commitGain(gain);
      saveManualChannelGain(currentChannel.id, currentChannel.name, playingGainToStored(currentGain), currentVideoType, currentChannel.url).then(() => {
        notifyPopup();
        sendResponse({ ok: true });
      }).catch(err => {
        reportFailure('setGain failed', err);
        restoreGainAfterFailedSave().then(() =>
          sendResponse({ ok: false, reason: 'request failed' }));
      });
      return true;
    }

    if (msg.type === 'setAutoApplyLoudness') {
      if (gestureStateMoved(msg)) {
        sendResponse({ ok: false, reason: 'state moved' });
        return true;
      }
      const videoType = currentVideoType;
      fillCurrentChannelNameFromDomFallback();
      // Turned on where a level is known, Auto plays its gain at once and that
      // gain is stored with the flag in one write, as Apply to channel stores
      // it. The live level is the one in hand, which Auto takes as its own from
      // here, as it stands. Turned off, or on with no level known, the flag is
      // written alone.
      const live = readLiveLkfs !== null;
      const storesGain = !!msg.enabled && (live || currentLoudnessDb !== null);
      let written;
      if (storesGain) {
        const videoId = getUrlVideoId();
        if (live) {
          currentLiveLkfs = readLiveLkfs;
          liveLevelRise = null;
        }
        const gain = live ? calcGainFromLiveLevel() : calcGainFromLoudness(currentLoudnessDb);
        commitGain(gain);
        written = (live
          ? saveLiveChannelGain(currentChannel.id, currentChannel.name, gain, videoType, currentChannel.url, true)
          : saveChannelGain(currentChannel.id, currentChannel.name, calcStoredGainFromLoudness(), videoType, currentChannel.url, true)
        ).then(() => {
          if (live) liveSaveBaseline = { videoId, videoType, gain };
        });
      } else {
        written = saveChannelAutoApply(
          currentChannel.id,
          currentChannel.name,
          !!msg.enabled,
          videoType,
          currentChannel.url
        );
      }
      written.then(async () => {
        await applyPreferredGain();
        notifyPopup();
        sendResponse({ ok: true, ...getState() });
      }).catch(err => {
        reportFailure('setAutoApplyLoudness failed', err);
        if (!storesGain) {
          sendResponse({ ok: false, reason: 'request failed' });
          return;
        }
        // The gain played went ahead of the write, so the level goes back to
        // what storage holds before the popup is answered.
        restoreGainAfterFailedSave().then(() =>
          sendResponse({ ok: false, reason: 'request failed' }));
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
          currentBaseLoudnessDb,
          currentLiveLkfs,
          readLiveLkfs,
          currentGain,
          audioChain: {
            connected: !!connectedVideo,
            connectedIsPageVideo: connectedVideo
              ? connectedVideo === document.querySelector('video.html5-main-video, video')
              : null,
            contextState: audioCtx?.state ?? null,
            gainNodeValue: gainNode ? gainNode.gain.value : null
          },
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
          currentGain, currentLoudnessDb, currentBaseLoudnessDb, currentLoudnessVideoId,
          currentLiveLkfs, readLiveLkfs, liveSaveBaseline, liveSaveInFlight, liveFollowTimer, liveRaiseFrom, preview, appliedVideoId,
          storedLiveGain, liveLevelBefore, liveLevelRise,
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
      endPreview,
      getState,
      isWatchPage,
      getUrlVideoId,
      calcGainFromLoudness,
      loadChannelEntry,
      saveChannelGain,
      saveManualChannelGain,
      saveChannelAutoApply,
      foldLegacyGains,
      applyPreferredGain,
      evaluateLiveSave,
      syncLiveFollow,
      notifyPopup,
      // Setters for test setup
      _set(key, val) {
        switch (key) {
          case 'currentChannel': currentChannel = val; break;
          case 'currentChannelVideoId': currentChannelVideoId = val; break;
          case 'currentGain': currentGain = val; break;
          case 'currentVideoType': currentVideoType = val; break;
          case 'currentVideoTypeDetected': currentVideoTypeDetected = val; break;
          // A video set as the last one applied is one whose first apply has
          // run; a case that means otherwise sets appliedVideoId after it.
          case '_lastVideoId': _lastVideoId = val; appliedVideoId = val; break;
          case 'appliedVideoId': appliedVideoId = val; break;
          case '_lastProcessedVideo': _lastProcessedVideo = val; break;
          case '_applyRunning': _applyRunning = val; break;
          case 'targetLufs': targetLufs = val; break;
          case 'defaultAutoApplyLoudnessVideo': defaultAutoApplyLoudnessVideo = val; break;
          case 'defaultAutoApplyLoudnessLive': defaultAutoApplyLoudnessLive = val; break;
          case 'currentAutoApplyLoudnessVideo': currentAutoApplyLoudnessVideo = val; break;
          case 'currentAutoApplyLoudnessLive': currentAutoApplyLoudnessLive = val; break;
          case 'currentLoudnessDb': currentLoudnessDb = val; break;
          case 'currentBaseLoudnessDb': currentBaseLoudnessDb = val; break;
          case 'storageReady': storageReady = val; break;
          case 'storageSettled': storageSettled = val; break;
          case 'storageMigrated': storageMigrated = val; break;
          case 'currentLoudnessVideoId': currentLoudnessVideoId = val; break;
          // As a bridge message sets it: the level in hand goes with it.
          case 'currentLiveLkfs': currentLiveLkfs = val; readLiveLkfs = val; break;
          case 'readLiveLkfs': readLiveLkfs = val; break;
          case 'currentIsLiveNow': currentIsLiveNow = val; break;
          case 'liveSaveBaseline': liveSaveBaseline = val; break;
          case 'liveRaiseFrom': liveRaiseFrom = val; break;
          case 'storedLiveGain': storedLiveGain = val; break;
          case 'liveLevelBefore': liveLevelBefore = val; break;
          case 'liveLevelRise': liveLevelRise = val; break;
          // The audio chain is built once per element and never taken down in
          // production; a case that means to ask what building it does starts
          // from nothing.
          case 'gainNode': gainNode = val; break;
          case 'sourceNode': sourceNode = val; break;
          case 'connectedVideo': connectedVideo = val; break;
        }
      }
    };
  }
})();
