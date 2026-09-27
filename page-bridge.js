// page-bridge.js — Runs in MAIN world (page context)
// Extracts loudnessDb from YouTube's player response and relays to content script.

(() => {
  'use strict';

  const MSG_TYPE = '__yt_channel_volume__';

  function isWatchPage() {
    const p = location.pathname;
    return p === '/watch' || p.startsWith('/live/');
  }

  function postResult(info, source) {
    window.postMessage({
      type: MSG_TYPE,
      videoId: info.videoId || currentVideoId(),
      loudnessDb: info.db,
      baseLoudnessDb: info.baseDb,
      isLiveContent: info.isLiveContent,
      isLiveNow: info.isLiveNow,
      channelId: info.channelId,
      author: info.author,
      source
    }, '*');
  }

  // Stable volume, the player's setting, plays a rendition of the audio of its
  // own (an adaptive format marked `isDrc`), and that rendition carries a level
  // of its own. The setting is read from the player; before the player is
  // there, from the entry the player keeps in localStorage; and where neither
  // answers it is taken as on, as the player takes it.
  const DRC_PREFERENCE_KEY = 'yt-player-drc-pref';

  function drcPreference() {
    try {
      const player = document.getElementById('movie_player');
      if (player && typeof player.getDrcUserPreference === 'function') {
        const value = player.getDrcUserPreference();
        if (value === 0 || value === 1) return { value, from: 'player' };
      }
    } catch (_) {}
    try {
      const stored = JSON.parse(window.localStorage.getItem(DRC_PREFERENCE_KEY));
      const expired = typeof stored?.expiration === 'number' &&
        stored.expiration > 0 && stored.expiration < Date.now();
      if (stored && !expired) {
        const value = JSON.parse(stored.data);
        if (value === 0 || value === 1) return { value, from: 'storage' };
      }
    } catch (_) {}
    return { value: 1, from: 'default' };
  }

  function drcLoudnessDb(data) {
    const formats = data?.streamingData?.adaptiveFormats;
    if (!Array.isArray(formats)) return null;
    const drc = formats.find((f) => f?.isDrc === true && typeof f.loudnessDb === 'number');
    return drc ? drc.loudnessDb : null;
  }

  // loudnessDb is a level against the response's loudness target; an absolute
  // level (LKFS) is put on that footing by taking the target off it. Without a
  // target there is nothing to put it against.
  function relativeToTarget(lkfs, data) {
    const target = data?.playerConfig?.audioConfig?.loudnessTargetLkfs;
    return typeof lkfs === 'number' && typeof target === 'number' ? lkfs - target : null;
  }

  // The level of what the player is playing now, as its stats-for-nerds volume
  // line names it: `cont.<LKFS>dB` belongs to the rendition it chose, whichever
  // audio track, stable volume or voice boost chose it. The line is taken only
  // once the player names the formats it plays (before that it carries the
  // response's level) and only while it names the video the URL does.
  function playingLoudnessLkfs() {
    try {
      const player = document.getElementById('movie_player');
      if (!player || typeof player.getStatsForNerds !== 'function') return null;
      const stats = player.getStatsForNerds();
      if (!stats?.codecs) return null;
      const videoId = currentVideoId();
      if (!videoId || String(stats.video_id_and_cpn).split(' / ')[0] !== videoId) return null;
      const m = /\bcont\.(-?\d+(?:\.\d+)?)dB\b/.exec(String(stats.volume));
      return m ? Number(m[1]) : null;
    } catch (_) {
      return null;
    }
  }

  // `db` is the level of the rendition played; `baseDb` is the level of the
  // plain rendition the response describes (`audioConfig`), before stable
  // volume, which is what a stored gain is held against.
  function extractFromPlayerResponse(data) {
    let db = null;
    let baseDb = null;
    let isLiveContent = false;
    let isLiveNow = false;
    let videoId = '';
    let channelId = '';
    let author = '';
    try {
      db = data?.playerConfig?.audioConfig?.loudnessDb;
      if (typeof db !== 'number') {
        db = relativeToTarget(data?.playerConfig?.audioConfig?.perceptualLoudnessDb, data);
      }
      baseDb = db;
      const drcDb = drcPreference().value === 1 ? drcLoudnessDb(data) : null;
      if (drcDb !== null) db = drcDb;
      isLiveContent = !!data?.videoDetails?.isLiveContent;
      isLiveNow = !!data?.videoDetails?.isLive;
      videoId = data?.videoDetails?.videoId || '';
      channelId = data?.videoDetails?.channelId || '';
      author = data?.videoDetails?.author || '';
    } catch (_) {}
    return { db, baseDb, isLiveContent, isLiveNow, videoId, channelId, author };
  }

  function currentVideoId() {
    try {
      const u = new URL(location.href);
      const q = u.searchParams.get('v');
      if (q) return q;
      const m = u.pathname.match(/^\/live\/([^/?#]+)/);
      return m ? m[1] : '';
    } catch (_) { return ''; }
  }

  function isCurrentVideo(data) {
    try {
      const vid = data?.videoDetails?.videoId;
      if (!vid) return true;
      const cur = currentVideoId();
      // Where the URL names no video there is nothing to compare against.
      if (!cur) return true;
      return vid === cur;
    } catch (_) { return true; }
  }

  // ── Method 1: Intercept ytInitialPlayerResponse assignment ─────────

  let _capturedResp = null;

  try {
    if (window.ytInitialPlayerResponse) {
      _capturedResp = window.ytInitialPlayerResponse;
    }

    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      get() { return _capturedResp; },
      set(val) {
        _capturedResp = val;
        if (val && isWatchPage() && isCurrentVideo(val)) {
          postResult(preferPlayingLevel(extractFromPlayerResponse(val), val), 'define');
        }
      },
      configurable: true,
      enumerable: true
    });
  } catch (_) {}

  // A request made on a watch page goes through requestMadeOnWatchPage below,
  // and the TypeError a request that could not be made rejects with carries the
  // stack of the call that made it. An unhandled rejection whose reason is that
  // TypeError, with that function in its stack, has its default prevented. Any
  // other rejection is left as it is.
  const WATCH_REQUEST_FRAME = /\bat requestMadeOnWatchPage \(chrome-extension:\/\//;
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (r instanceof TypeError && r.message === 'Failed to fetch' && WATCH_REQUEST_FRAME.test(String(r.stack))) {
      e.preventDefault();
    }
  });

  // ── Method 2: Hook fetch for SPA navigation ───────────────────────

  const origFetch = window.fetch;
  function requestMadeOnWatchPage(page, fetchArgs) {
    return origFetch.apply(page, fetchArgs);
  }
  window.fetch = function (...args) {
    const result = isWatchPage() ? requestMadeOnWatchPage(this, args) : origFetch.apply(this, args);
    const url = (typeof args[0] === 'string') ? args[0] : (args[0]?.url || '');
    if (url.includes('/youtubei/v1/player')) {
      result.then(resp => resp.clone().json()).then(data => {
        if (isWatchPage() && isCurrentVideo(data)) {
          postResult(preferPlayingLevel(extractFromPlayerResponse(data), data), 'fetch');
        }
      }).catch(() => {});
    }
    return result;
  };

  // ── Method 3: Extract from ytplayer config (SPA navigation) ────────
  // YouTube stores player data in DOM element's data property on SPA nav.

  // The page holds a player response in two places, and they can disagree: the
  // element keeps the one the page was built with, the player the one it is
  // running now. They are returned in that order — oldest first — and only for
  // the video the URL names.
  function currentPlayerResponses() {
    const found = [];
    try {
      const flexy = document.querySelector('ytd-watch-flexy');
      const pr = flexy?.__data?.playerResponse || flexy?.playerResponse;
      if (pr) found.push(pr);
    } catch (_) {}

    try {
      const player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        const pr = player.getPlayerResponse();
        if (pr) found.push(pr);
      }
    } catch (_) {}

    return found.filter(isCurrentVideo);
  }

  // ── On-demand extraction (content script can request) ──────────────

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== '__yt_channel_volume_request__') return;
    watchAudioChanges();
    answerCurrentVideo('request');
  });

  // Turning stable volume on or off swaps the rendition under the same video,
  // and the player announces it with onPlaybackAudioChange. The answer is given
  // again then, so the level follows the rendition being played.
  const watchedPlayers = new WeakSet();
  function watchAudioChanges() {
    try {
      const player = document.getElementById('movie_player');
      if (!player || watchedPlayers.has(player) || typeof player.addEventListener !== 'function') return;
      watchedPlayers.add(player);
      player.addEventListener('onPlaybackAudioChange', () => {
        if (isWatchPage()) answerCurrentVideo('audio-change');
      });
    } catch (_) {}
  }

  function answerCurrentVideo(source) {
    let result = {
      db: null,
      baseDb: null,
      isLiveContent: false,
      isLiveNow: false,
      videoId: currentVideoId(),
      channelId: '',
      author: ''
    };

    const onPage = currentPlayerResponses();

    const resp = _capturedResp || window.ytInitialPlayerResponse;
    if (resp && isCurrentVideo(resp)) {
      result = extractFromPlayerResponse(resp);
    }

    // Only fall back if no useful data was extracted at all
    if (result.db === null && !result.channelId) {
      if (onPage.length) result = extractFromPlayerResponse(onPage[0]);
    }

    // Whichever answer the level came from, whether a stream is on air right
    // now is taken from the most current answer that names this video: the
    // player over the element, the element over the one kept from load. Taking
    // it from any of them that says yes would leave the badge up after the
    // stream has ended, since only the player knows that it has.
    const newest = onPage.length
      ? onPage[onPage.length - 1]
      : (resp && isCurrentVideo(resp) ? resp : null);
    result.isLiveNow = !!newest?.videoDetails?.isLive;

    postResult(preferPlayingLevel(result, newest), source);
  }

  // Whichever route an answer takes, the level of what the player is playing
  // takes over from the one the response describes, and answering with it ends
  // the looking below. Until the player names what it plays, the response's
  // level stands, and the player is looked at again until it does.
  function preferPlayingLevel(result, data) {
    const lkfs = playingLoudnessLkfs();
    const playing = relativeToTarget(lkfs, data);
    if (playing !== null) {
      result.db = playing;
      stopFollowing();
    } else if (lkfs === null && isWatchPage()) {
      followPlaying();
    }
    return result;
  }

  // Looked at every FOLLOW_INTERVAL_MS, FOLLOW_ATTEMPTS times at most, and
  // answered again (source `playing`) the first time the player names a level.
  const FOLLOW_INTERVAL_MS = 250;
  const FOLLOW_ATTEMPTS = 40;
  let followTimer = null;
  function followPlaying() {
    if (followTimer !== null) return;
    let attempts = 0;
    const look = () => {
      followTimer = null;
      if (!isWatchPage()) return;
      if (playingLoudnessLkfs() !== null) {
        answerCurrentVideo('playing');
        return;
      }
      attempts += 1;
      if (attempts < FOLLOW_ATTEMPTS) followTimer = setTimeout(look, FOLLOW_INTERVAL_MS);
    };
    followTimer = setTimeout(look, FOLLOW_INTERVAL_MS);
  }

  function stopFollowing() {
    clearTimeout(followTimer);
    followTimer = null;
  }

  // ── Diagnostic dump (MAIN-world visibility for popup-open) ─────────
  // Content script cannot read `_capturedResp` / movie_player methods from
  // ISOLATED world. When the popup opens, content.js posts this message to
  // force page-bridge to log what it can actually see.

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== '__yt_channel_volume_diag__') return;
    try {
      const cap = _capturedResp;
      const flexy = document.querySelector('ytd-watch-flexy');
      const flexyPr = flexy?.__data?.playerResponse || flexy?.playerResponse;
      const moviePlayer = document.getElementById('movie_player');
      const mpPr = moviePlayer && typeof moviePlayer.getPlayerResponse === 'function'
        ? moviePlayer.getPlayerResponse() : null;
      const summarize = (pr) => pr?.videoDetails ? {
        videoId: pr.videoDetails.videoId,
        channelId: pr.videoDetails.channelId,
        author: pr.videoDetails.author,
        isLiveContent: !!pr.videoDetails.isLiveContent,
        isLive: !!pr.videoDetails.isLive,
        loudnessDb: pr.playerConfig?.audioConfig?.loudnessDb,
        drcLoudnessDb: drcLoudnessDb(pr)
      } : null;
      let playerVolume = null;
      try {
        if (moviePlayer && typeof moviePlayer.getStatsForNerds === 'function') {
          playerVolume = moviePlayer.getStatsForNerds()?.volume ?? null;
        }
      } catch (_) {}
      console.log('[YTCV][bridge-diag]', {
        urlVideoId: currentVideoId(),
        captured: summarize(cap),
        flexy: summarize(flexyPr),
        moviePlayer: summarize(mpPr),
        drcPreference: drcPreference(),
        playerVolume,
        playingLkfs: playingLoudnessLkfs()
      });
    } catch (_) { /* logging must never break flow */ }
  });
})();
