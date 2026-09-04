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
      isLiveContent: info.isLiveContent,
      isLiveNow: info.isLiveNow,
      channelId: info.channelId,
      author: info.author,
      source
    }, '*');
  }

  function extractFromPlayerResponse(data) {
    let db = null;
    let isLiveContent = false;
    let isLiveNow = false;
    let videoId = '';
    let channelId = '';
    let author = '';
    try {
      db = data?.playerConfig?.audioConfig?.loudnessDb;
      if (typeof db !== 'number') {
        db = data?.playerConfig?.audioConfig?.perceptualLoudnessDb;
        if (typeof db !== 'number') db = null;
      }
      isLiveContent = !!data?.videoDetails?.isLiveContent;
      isLiveNow = !!data?.videoDetails?.isLive;
      videoId = data?.videoDetails?.videoId || '';
      channelId = data?.videoDetails?.channelId || '';
      author = data?.videoDetails?.author || '';
    } catch (_) {}
    return { db, isLiveContent, isLiveNow, videoId, channelId, author };
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
          postResult(extractFromPlayerResponse(val), 'define');
        }
      },
      configurable: true,
      enumerable: true
    });
  } catch (_) {}

  // ── Method 2: Hook fetch for SPA navigation ───────────────────────

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const result = origFetch.apply(this, args);
    const url = (typeof args[0] === 'string') ? args[0] : (args[0]?.url || '');
    if (url.includes('/youtubei/v1/player')) {
      result.then(resp => resp.clone().json()).then(data => {
        if (isWatchPage() && isCurrentVideo(data)) {
          postResult(extractFromPlayerResponse(data), 'fetch');
        }
      }).catch(() => {});
    }
    return result;
  };

  // ── Method 3: Extract from ytplayer config (SPA navigation) ────────
  // YouTube stores player data in DOM element's data property on SPA nav.

  // The page holds a player response in two places, and they can disagree: the
  // element keeps the one the page was built with, the player the one it is
  // running now.
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

    let result = {
      db: null,
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

    // Whichever answer the level came from, the page's own responses are what
    // say a stream has started: the one kept from load can name a video this
    // tab has left, and the element can hold the response from before the
    // stream began.
    if (!result.isLiveNow && onPage.some(pr => !!pr?.videoDetails?.isLive)) {
      result.isLiveNow = true;
    }

    postResult(result, 'request');
  });

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
        loudnessDb: pr.playerConfig?.audioConfig?.loudnessDb
      } : null;
      console.log('[YTCV][bridge-diag]', {
        urlVideoId: currentVideoId(),
        captured: summarize(cap),
        flexy: summarize(flexyPr),
        moviePlayer: summarize(mpPr)
      });
    } catch (_) { /* logging must never break flow */ }
  });
})();
