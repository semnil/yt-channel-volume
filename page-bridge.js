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
      channelId = data?.videoDetails?.channelId || '';
      author = data?.videoDetails?.author || '';
    } catch (_) {}
    return { db, isLiveContent, isLiveNow, channelId, author };
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
      // On /live/HANDLE form, pathname id may be a channel handle, not a videoId.
      // Accept in that case to avoid false negatives.
      if (!cur || cur.length !== 11) return true;
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

  function extractFromYtPlayer() {
    try {
      const flexy = document.querySelector('ytd-watch-flexy');
      if (flexy) {
        const pr = flexy.__data?.playerResponse || flexy.playerResponse;
        if (pr && isCurrentVideo(pr)) {
          return extractFromPlayerResponse(pr);
        }
      }
    } catch (_) {}

    try {
      const player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        const pr = player.getPlayerResponse();
        if (pr && isCurrentVideo(pr)) {
          return extractFromPlayerResponse(pr);
        }
      }
    } catch (_) {}

    return { db: null, isLiveContent: false, isLiveNow: false, channelId: '', author: '' };
  }

  // ── On-demand extraction (content script can request) ──────────────

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== '__yt_channel_volume_request__') return;

    let result = { db: null, isLiveContent: false, isLiveNow: false, channelId: '', author: '' };

    const resp = _capturedResp || window.ytInitialPlayerResponse;
    if (resp && isCurrentVideo(resp)) {
      result = extractFromPlayerResponse(resp);
    }

    // Only fall back if no useful data was extracted at all
    if (result.db === null && !result.channelId) {
      result = extractFromYtPlayer();
    }

    postResult(result, 'request');
  });
})();
