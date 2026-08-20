// test-navigation.js — Navigation & state transition tests for content.js
// Run: node test-navigation.js

const fs = require('fs');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error('  FAIL:', msg); }
}
function section(name) { console.log(name); }

// ── Mock environment ─────────────────────────────────────────────────

let mockLocation = { pathname: '/watch', search: '?v=abc123', href: 'https://www.youtube.com/watch?v=abc123' };
let mockStorage = {};
let mockVideoEl = { id: 'mock-video-1' };
let mockDOMElements = {};
let mockEventListeners = {};
let mockRuntimeMessageListeners = [];
let mockSentMessages = [];
let mockPostMessages = [];
let mockPostMessageHandler = null;

function cloneStorageValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function resetMocks() {
  mockLocation = { pathname: '/watch', search: '?v=abc123', href: 'https://www.youtube.com/watch?v=abc123' };
  mockStorage = {};
  mockVideoEl = { id: 'mock-video-1' };
  mockDOMElements = {};
  mockEventListeners = {};
  mockRuntimeMessageListeners = [];
  mockSentMessages = [];
  mockPostMessages = [];
  mockPostMessageHandler = null;
}

function setURL(path, videoId) {
  mockLocation.pathname = path;
  if (videoId) {
    mockLocation.search = '?v=' + videoId;
    mockLocation.href = 'https://www.youtube.com' + path + '?v=' + videoId;
  } else {
    mockLocation.search = '';
    mockLocation.href = 'https://www.youtube.com' + path;
  }
}

// Minimal DOM mock
globalThis.document = {
  querySelector(sel) {
    // video element
    if (sel.includes('video.html5-main-video') || (sel === 'video')) return mockVideoEl;
    if (sel.includes('.ytp-volume-area')) return null;
    if (sel.includes('ytd-watch-flexy')) return null;
    if (sel.includes('movie_player')) return null;
    // channel name (getChannelDisplayName)
    if (sel.includes('#channel-name')) return mockDOMElements['channelName'] || null;
    // canonical link (detectChannel method 1)
    if (sel.includes('rel="canonical"')) return mockDOMElements['canonical'] || null;
    // owner link (detectChannel method 2) — combined selector includes both #owner and ytd-video-owner-renderer
    if (sel.includes('a[href')) return mockDOMElements['ownerLink'] || null;
    // meta channel ID (detectChannel method 3)
    if (sel.includes('itemprop="channelId"')) return mockDOMElements['metaChannel'] || null;
    if (sel.includes('itemprop="name"')) return mockDOMElements['metaName'] || null;
    return null;
  },
  querySelectorAll() { return []; },
  addEventListener(type, fn) {
    mockEventListeners[type] = mockEventListeners[type] || [];
    mockEventListeners[type].push(fn);
  },
  createElement(tag) {
    return {
      style: { cssText: '' },
      textContent: '',
      parentNode: null,
      appendChild() {},
      removeChild() {},
    };
  },
  contains() { return true; },
  get documentElement() { return { }; },
  get visibilityState() { return 'visible'; },
  get readyState() { return 'complete'; },
};

globalThis.window = {
  addEventListener(type, fn) {
    mockEventListeners[type] = mockEventListeners[type] || [];
    mockEventListeners[type].push(fn);
  },
  postMessage(data) {
    mockPostMessages.push(data);
    if (mockPostMessageHandler) mockPostMessageHandler(data);
  },
};

globalThis.location = new Proxy({}, {
  get(_, prop) { return mockLocation[prop]; }
});

// URL constructor
globalThis.URL = class {
  constructor(href) { this._href = href; }
  get searchParams() {
    const s = this._href.split('?')[1] || '';
    return { get(k) { const m = s.match(new RegExp('[?&]?' + k + '=([^&]*)')); return m ? m[1] : ''; } };
  }
  get pathname() {
    const after = this._href.replace(/^https?:\/\/[^/]+/, '');
    return after.split('?')[0].split('#')[0];
  }
};

// Chrome API mock
globalThis.chrome = {
  runtime: {
    id: 'test-extension-id',
    sendMessage(message) {
      mockSentMessages.push(message);
      return Promise.resolve();
    },
    onMessage: {
      addListener(fn) { mockRuntimeMessageListeners.push(fn); }
    },
  },
  storage: {
    local: {
      get(key) {
        if (Array.isArray(key)) {
          return Promise.resolve(Object.fromEntries(
            key.filter(k => Object.prototype.hasOwnProperty.call(mockStorage, k))
              .map(k => [k, cloneStorageValue(mockStorage[k])])
          ));
        }
        if (key === null) return Promise.resolve(cloneStorageValue(mockStorage));
        return Promise.resolve(
          Object.prototype.hasOwnProperty.call(mockStorage, key)
            ? { [key]: cloneStorageValue(mockStorage[key]) }
            : {}
        );
      },
      set(obj) {
        for (const [key, value] of Object.entries(obj)) {
          mockStorage[key] = cloneStorageValue(value);
        }
        return Promise.resolve();
      },
      remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete mockStorage[key];
        return Promise.resolve();
      },
    },
    onChanged: {
      _listeners: [],
      addListener(fn) { this._listeners.push(fn); },
    },
  },
  i18n: { getMessage: () => '' },
  tabs: { sendMessage() { return Promise.resolve(); } },
};

// MutationObserver mock
globalThis.MutationObserver = class {
  constructor(cb) { this._cb = cb; globalThis.__mutationObserverCb = cb; }
  observe() {}
  disconnect() {}
};

// AudioContext mock
globalThis.AudioContext = class {
  constructor() { this.state = 'running'; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  createMediaElementSource() {
    return { connect() {}, disconnect() {} };
  }
  createGain() {
    return { gain: { value: 1.0 }, connect() {} };
  }
};

// ── Load content.js ──────────────────────────────────────────────────

globalThis.__TEST_YTCV__ = true;

vm.runInThisContext(fs.readFileSync('./utils.js', 'utf8'), { filename: 'utils.js' });
vm.runInThisContext(fs.readFileSync('./content.js', 'utf8'), { filename: 'content.js' });

const ytcv = globalThis.__YTCV__;
assert(!!ytcv, 'Test export available');

// Helper to simulate page-bridge message
function simulateBridgeMessage(data) {
  const listeners = mockEventListeners['message'] || [];
  for (const fn of listeners) {
    fn({ source: globalThis.window, data: { type: '__yt_channel_volume__', ...data } });
  }
}

function simulateRuntimeMessage(data) {
  return new Promise((resolve) => {
    const listener = mockRuntimeMessageListeners[0];
    if (!listener) {
      resolve(undefined);
      return;
    }
    listener(data, {}, resolve);
  });
}

// Helper to fire yt-navigate-finish
function fireNavigateFinish() {
  const listeners = mockEventListeners['yt-navigate-finish'] || [];
  for (const fn of listeners) fn();
}

// Helper to fire visibilitychange
function fireVisibilityChange() {
  const listeners = mockEventListeners['visibilitychange'] || [];
  for (const fn of listeners) fn();
}

// Helper to fire observer
function fireObserver() {
  if (globalThis.__mutationObserverCb) globalThis.__mutationObserverCb();
}

// Helper to fire chrome.storage.onChanged
function simulateStorageChange(changes) {
  for (const fn of chrome.storage.onChanged._listeners) fn(changes, 'local');
}

// Helper to wait for async
function tick() { return new Promise(r => setTimeout(r, 10)); }

// ── Tests ────────────────────────────────────────────────────────────

async function runTests() {

  // ── P01: New tab with URL ──────────────────────────────────────────

  section('P01: New tab with URL');
  // Initial triggerApply was called during eval. Check state.
  await tick();
  assert(ytcv.state._lastVideoId === 'abc123', 'video ID captured');
  assert(ytcv.state._lastProcessedVideo === mockVideoEl, 'video element tracked');
  assert(ytcv.state.currentGain === 1.0, 'unsaved channel → gain 1.0');

  // ── P02: Reload (simulated by resetting state and re-triggering) ──

  section('P02: Reload (re-trigger)');
  ytcv._set('_lastProcessedVideo', null);
  ytcv._set('_lastVideoId', '');
  ytcv._set('currentChannel', { id: '', name: '', url: '' });
  await ytcv.triggerApply();
  assert(ytcv.state._lastVideoId === 'abc123', 'video ID re-captured');
  assert(ytcv.state.currentGain === 1.0, 'gain reset to 1.0');

  // ── P03: Home → video click (SPA) ─────────────────────────────────

  section('P03: Home → video click (SPA)');
  setURL('/', null);
  ytcv._set('_lastProcessedVideo', null);
  ytcv._set('_lastVideoId', '');
  // Navigate to watch page
  setURL('/watch', 'vid003');
  fireNavigateFinish();
  await tick();
  assert(ytcv.state._lastVideoId === 'vid003', 'new video ID after SPA nav');

  // ── P04: Video A → Video B (SPA, same tab, yt-navigate-finish) ────

  section('P04: Video A → Video B (SPA, yt-navigate-finish)');
  // Save gain for channel B
  mockStorage['channelVolumes'] = { 'UCtest_B': { name: 'Ch B', gainVideo: 0.63, gainLive: 0.8 } };
  mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCtest_B' };
  setURL('/watch', 'vid004');
  fireNavigateFinish();
  await tick();
  assert(ytcv.state._lastVideoId === 'vid004', 'video ID updated');
  assert(ytcv.state.currentChannel.id === 'UCtest_B', 'channel detected');
  assert(ytcv.state.currentGain === 0.63, 'saved gainVideo applied');

  // ── P05: Video A → Video B (no yt-navigate-finish, observer URL) ──

  section('P05: Video A → Video B (observer URL change)');
  mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCtest_B' };
  setURL('/watch', 'vid005');
  // yt-navigate-finish not fired, observer detects URL change
  fireObserver();
  await tick();
  assert(ytcv.state._lastVideoId === 'vid005', 'observer detected URL change');

  // ── P06: Video → Channel page (non-watch) ─────────────────────────

  section('P06: Video → Channel page (non-watch)');
  const gainBefore = ytcv.state.currentGain;
  setURL('/@SomeChannel', null);
  fireNavigateFinish();
  await tick();
  // isWatchPage() = false → triggerApply returns early
  assert(ytcv.isWatchPage() === false, 'not watch page');
  assert(ytcv.state.currentGain === gainBefore, 'gain preserved (no reset on non-watch)');

  // ── P07: Channel page → Video (SPA) ───────────────────────────────

  section('P07: Channel page → Video (SPA)');
  mockStorage['channelVolumes'] = { 'UCtest_C': { name: 'Ch C', gainVideo: 1.5 } };
  mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCtest_C' };
  setURL('/watch', 'vid007');
  fireNavigateFinish();
  await tick();
  assert(ytcv.state._lastVideoId === 'vid007', 'video ID after channel→video');
  assert(ytcv.state.currentGain === 1.5, 'gain for Ch C applied');

  // ── P08: Playlist auto-advance ─────────────────────────────────────

  section('P08: Playlist auto-advance');
  setURL('/watch', 'vid008');
  // Same video element, URL changed
  fireObserver();
  await tick();
  assert(ytcv.state._lastVideoId === 'vid008', 'playlist advance detected via observer');

  // ── P09: Live stream ends → autoplay ───────────────────────────────

  section('P09: Live stream ends → autoplay redirect');
  setURL('/watch', 'vid009');
  fireObserver();
  await tick();
  assert(ytcv.state._lastVideoId === 'vid009', 'autoplay redirect detected');

  // ── P10: Background tab ────────────────────────────────────────────

  section('P10: Background tab → activate');
  ytcv._set('_lastProcessedVideo', null);
  ytcv._set('_lastVideoId', '');
  setURL('/watch', 'vid010');
  fireVisibilityChange();
  await tick();
  assert(ytcv.state._lastVideoId === 'vid010', 'visibility change triggered apply');

  // ── P11: Browser back ──────────────────────────────────────────────

  section('P11: Browser back (popstate)');
  mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCtest_B' };
  setURL('/watch', 'vid004');
  const popListeners = mockEventListeners['popstate'] || [];
  for (const fn of popListeners) fn();
  await tick();
  assert(ytcv.state._lastVideoId === 'vid004', 'popstate triggered re-apply');

  // ── P12: Tab switch (already processed) ────────────────────────────

  section('P12: Tab switch (already processed, no re-apply)');
  const vidBefore = ytcv.state._lastVideoId;
  fireVisibilityChange(); // _lastProcessedVideo is set → should not trigger
  await tick();
  assert(ytcv.state._lastVideoId === vidBefore, 'no re-apply on tab switch');

  // ── P13: Shorts page ───────────────────────────────────────────────

  section('P13: Shorts page (not watch)');
  setURL('/shorts', 'short001');
  fireNavigateFinish();
  await tick();
  assert(ytcv.isWatchPage() === false, '/shorts is not watch page');

  // ── P14: Extension context invalidated ─────────────────────────────

  section('P14: Extension context invalidated');
  // Simulate by removing runtime.id
  const origId = chrome.runtime.id;
  chrome.runtime.id = undefined;
  setURL('/watch', 'vid014');
  fireNavigateFinish();
  await tick();
  // Should not crash, triggerApply returns early
  assert(ytcv.state._lastVideoId !== 'vid014', 'no apply when context invalid');
  chrome.runtime.id = origId; // restore

  // ── P15: Saved → Unsaved channel (SPA) ─────────────────────────────

  section('P15: Saved → Unsaved channel');
  mockStorage['channelVolumes'] = {}; // empty
  mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCunsaved' };
  setURL('/watch', 'vid015');
  fireNavigateFinish();
  await tick();
  assert(ytcv.state.currentGain === 1.0, 'unsaved channel → passthrough');

  // ── P16: Observer + yt-navigate both silent ────────────────────────

  section('P16: No trigger fires (same URL, same video)');
  const lastVid = ytcv.state._lastVideoId;
  const lastGain = ytcv.state.currentGain;
  // URL unchanged, video unchanged → observer should not trigger
  fireObserver();
  await tick();
  assert(ytcv.state._lastVideoId === lastVid, 'no spurious re-apply');
  assert(ytcv.state.currentGain === lastGain, 'gain unchanged');

  // ── P17: Same video reload ─────────────────────────────────────────

  section('P17: Same video reload');
  ytcv._set('_lastProcessedVideo', null);
  ytcv._set('_lastVideoId', '');
  ytcv._set('currentChannel', { id: '', name: '', url: '' });
  setURL('/watch', 'vid015');
  await ytcv.triggerApply();
  assert(ytcv.state._lastVideoId === 'vid015', 'reload re-captured');
  assert(ytcv.state.currentGain === 1.0, 'unsaved → 1.0 after reload');

  // ── P18: Muted background tab with saved channel ───────────────────

  section('P18: Muted background tab (saved channel)');
  mockStorage['channelVolumes'] = { 'UCmuted': { name: 'Muted Ch', gainVideo: 0.5 } };
  mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCmuted' };
  ytcv._set('_lastProcessedVideo', null);
  ytcv._set('_lastVideoId', '');
  setURL('/watch', 'vid018');
  await ytcv.triggerApply();
  assert(ytcv.state.currentGain === 0.5, 'saved gain applied even for muted tab');

  // ── Live archive: /live/<id> applies gainLive after loudness ───────

  section('Archive /live/<id>: gainLive applied after loudness resolves');
  mockStorage['channelVolumes'] = { 'UCarch': { name: 'Ch Arch', gainLive: 2.0 } };
  mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCarch' };
  ytcv._set('_lastProcessedVideo', null);
  ytcv._set('_lastVideoId', '');
  ytcv._set('currentChannel', { id: '', name: '', url: '' });
  ytcv._set('currentGain', 1.0);
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', null);
  mockLocation.pathname = '/live/j0nen00qp2o';
  mockLocation.search = '';
  mockLocation.href = 'https://www.youtube.com/live/j0nen00qp2o';
  await ytcv.triggerApply();
  assert(ytcv.state.currentVideoType === 'video', 'initial videoType=video (before loudness)');
  assert(ytcv.state.currentGain === 1.0, 'initial gain=1.0 (no gainVideo saved)');
  simulateBridgeMessage({
    loudnessDb: -5.0,
    isLiveContent: true,
    isLiveNow: false,
    channelId: 'UCarch'
  });
  await tick();
  await tick();
  await tick();
  assert(ytcv.state.currentVideoType === 'live', 'videoType updated to live after bridge message');
  assert(ytcv.state.currentGain === 2.0, 'gainLive=2.0 applied after reload');

  section('Backfill: orphan @handle entry adopted via author name match');
  mockStorage['channelVolumes'] = {
    '@orphan_handle': { name: 'Orphan Ch', gainLive: 2.5, gainVideo: 1.3, url: 'https://www.youtube.com/@orphan_handle' }
  };
  mockDOMElements['canonical'] = null;
  mockDOMElements['ownerLink'] = null;
  mockDOMElements['metaChannel'] = null;
  ytcv._set('currentChannel', { id: '', name: '', url: '' });
  simulateBridgeMessage({
    loudnessDb: -5.0,
    isLiveContent: true,
    isLiveNow: false,
    channelId: 'UCadopt',
    author: 'Orphan Ch'
  });
  await tick();
  await tick();
  assert(mockStorage['channelVolumes']['UCadopt']?.gainLive === 2.5, 'gainLive migrated to UC');
  assert(mockStorage['channelVolumes']['UCadopt']?.gainVideo === 1.3, 'gainVideo migrated to UC');
  assert(!mockStorage['channelVolumes']['@orphan_handle'], '@handle entry removed');
  assert(mockStorage['channelVolumes']['UCadopt']?.url === 'https://www.youtube.com/channel/UCadopt', 'url updated to UC form');

  section('Backfill: UC entry already exists — do not clobber');
  mockStorage['channelVolumes'] = {
    '@old_handle2': { name: 'Same Name', gainLive: 2.5 },
    'UCexists': { name: 'Same Name', gainLive: 0.8 }
  };
  ytcv._set('currentChannel', { id: '', name: '', url: '' });
  simulateBridgeMessage({
    loudnessDb: -5.0,
    isLiveContent: true,
    channelId: 'UCexists',
    author: 'Same Name'
  });
  await tick();
  await tick();
  assert(mockStorage['channelVolumes']['UCexists']?.gainLive === 0.8, 'existing UC entry preserved');
  assert(mockStorage['channelVolumes']['@old_handle2']?.gainLive === 2.5, '@handle entry not touched when UC exists');

  section('Archive /live/<id>: channelId from bridge when DOM detection fails');
  mockStorage['channelVolumes'] = { 'UCarch3': { name: 'Ch Arch3', gainLive: 1.7 } };
  mockDOMElements['canonical'] = null;
  mockDOMElements['ownerLink'] = null;
  mockDOMElements['metaChannel'] = null;
  ytcv._set('_lastProcessedVideo', null);
  ytcv._set('_lastVideoId', '');
  ytcv._set('currentChannel', { id: '', name: '', url: '' });
  ytcv._set('currentGain', 1.0);
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', null);
  mockLocation.pathname = '/live/abc99999999';
  mockLocation.search = '';
  mockLocation.href = 'https://www.youtube.com/live/abc99999999';
  await ytcv.triggerApply();
  assert(ytcv.state.currentChannel.id === '', 'initial channel id empty (DOM unavailable)');
  simulateBridgeMessage({
    loudnessDb: -4.0,
    isLiveContent: true,
    isLiveNow: false,
    channelId: 'UCarch3'
  });
  await tick();
  await tick();
  await tick();
  assert(ytcv.state.currentChannel.id === 'UCarch3', 'channelId adopted from bridge');
  assert(ytcv.state.currentGain === 1.7, 'gainLive=1.7 applied via reload after bridge supplies channelId');

  // ── Bridge message: channelId correction ───────────────────────────

  section('Bridge: channelId @handle → UC correction');
  ytcv._set('currentChannel', { id: '@test_handle', name: 'Test', url: '' });
  simulateBridgeMessage({ loudnessDb: -5.0, isLiveContent: false, channelId: 'UCcorrected' });
  assert(ytcv.state.currentChannel.id === 'UCcorrected', 'channelId corrected to UC format');

  section('Bridge: channelId not overwritten without valid data');
  ytcv._set('currentChannel', { id: 'UCkeep', name: 'Keep', url: '' });
  simulateBridgeMessage({ loudnessDb: null, isLiveContent: undefined, channelId: 'UCwrong' });
  assert(ytcv.state.currentChannel.id === 'UCkeep', 'channelId not overwritten with invalid data');

  section('Bridge: isLiveContent sets videoType');
  ytcv._set('currentChannel', { id: 'UCtest', name: 'T', url: '' });
  // True live stream: isLiveContent=true, no loudnessDb (unprocessed).
  simulateBridgeMessage({ loudnessDb: null, isLiveContent: true, isLiveNow: true, channelId: 'UCtest' });
  assert(ytcv.state.currentVideoType === 'live', 'live stream without loudness → live');
  assert(ytcv.state.currentIsLiveNow === true, 'isLiveNow set');

  section('Bridge: premiere has isLiveContent=false');
  ytcv._set('currentChannel', { id: 'UCpremiere', name: 'P', url: '' });
  // Premiere: isLiveContent=false (verified via probe), isLiveNow=true during airing
  simulateBridgeMessage({ loudnessDb: -3.0, isLiveContent: false, isLiveNow: true, channelId: 'UCpremiere' });
  assert(ytcv.state.currentVideoType === 'video', 'premiere isLiveContent=false → video');

  section('Bridge: regular video');
  ytcv._set('currentChannel', { id: 'UCvideo', name: 'V', url: '' });
  simulateBridgeMessage({ loudnessDb: -5.0, isLiveContent: false, isLiveNow: false, channelId: 'UCvideo' });
  assert(ytcv.state.currentVideoType === 'video', 'regular video → video');

  // ── _applyRunning guard ────────────────────────────────────────────

  section('Guard: _applyRunning prevents concurrent execution');
  ytcv._set('_applyRunning', true);
  ytcv._set('_lastVideoId', '');
  setURL('/watch', 'vid_guard');
  await ytcv.triggerApply();
  assert(ytcv.state._lastVideoId !== 'vid_guard', 'blocked by _applyRunning');
  ytcv._set('_applyRunning', false);

  // ── isWatchPage ────────────────────────────────────────────────────

  section('isWatchPage');
  setURL('/watch', 'x');
  assert(ytcv.isWatchPage() === true, '/watch → true');
  setURL('/shorts', 'x');
  assert(ytcv.isWatchPage() === false, '/shorts → false');
  setURL('/', null);
  assert(ytcv.isWatchPage() === false, '/ → false');
  setURL('/results', null);
  assert(ytcv.isWatchPage() === false, '/results → false');
  mockLocation.pathname = '/live/abc12345678';
  mockLocation.search = '';
  mockLocation.href = 'https://www.youtube.com/live/abc12345678';
  assert(ytcv.isWatchPage() === true, '/live/<id> → true');
  assert(ytcv.getUrlVideoId() === 'abc12345678', '/live/<id> → videoId extracted');
  setURL('/watch', 'abc123');
  assert(ytcv.getUrlVideoId() === 'abc123', '/watch?v=<id> → videoId extracted');

  // ── calcGainFromLoudness ───────────────────────────────────────────

  section('calcGainFromLoudness');
  ytcv._set('targetLufs', -18);
  const g1 = ytcv.calcGainFromLoudness(0);
  assert(Math.abs(g1 - Math.pow(10, -4/20)) < 0.001, 'loudnessDb=0 → correct gain');
  const g2 = ytcv.calcGainFromLoudness(5);
  assert(Math.abs(g2 - Math.pow(10, -4/20)) < 0.001, 'loudnessDb=5 (loud) → same as 0 (YouTube normalizes)');
  const g3 = ytcv.calcGainFromLoudness(-6);
  assert(Math.abs(g3 - Math.pow(10, 2/20)) < 0.001, 'loudnessDb=-6 → boost');

  section('commitGain keeps state, audio, and popup projection synchronized');
  const committedGain = 0.55;
  const messagesBeforeCommit = mockSentMessages.length;
  ytcv.commitGain(committedGain);
  assert(ytcv.state.currentGain === committedGain, 'committed gain stored in canonical state');
  assert(ytcv.state.gainNode.gain.value === committedGain, 'committed gain applied to GainNode');
  assert(mockSentMessages.length === messagesBeforeCommit + 1,
    'committed gain publishes one popup state update');
  assert(mockSentMessages.at(-1)?.gain === committedGain,
    'popup state update contains the same committed gain');

  // ── Per-channel automatic LUFS application ─────────────────────────

  section('Auto LUFS: enabling for current channel applies calculated gain');
  const autoEntry = { name: 'Auto Ch', gainVideo: 0.4, gainLive: 0.7, autoApplyLoudnessVideo: true };
  mockStorage['channelVolumes'] = { 'UCauto': autoEntry };
  ytcv._set('currentChannel', { id: 'UCauto', name: 'Auto Ch', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('currentGain', 0.4);
  ytcv._set('targetLufs', -18);
  ytcv._set('currentAutoApplyLoudnessVideo', false);
  ytcv._set('currentAutoApplyLoudnessLive', false);
  simulateStorageChange({
    channelVolumes: {
      oldValue: { 'UCauto': { name: 'Auto Ch', gainVideo: 0.4 } },
      newValue: { 'UCauto': autoEntry }
    }
  });
  const expectedAutoGain = Math.pow(10, 2/20);
  assert(ytcv.state.currentAutoApplyLoudnessVideo === true, 'video auto flag enabled for current channel');
  assert(ytcv.state.currentAutoApplyLoudnessLive === false, 'live auto flag remains disabled');
  assert(Math.abs(ytcv.state.currentGain - expectedAutoGain) < 0.001, 'detected LUFS overrides saved gain');
  const exposedAutoState = ytcv.getState();
  assert(!('autoApplyLoudness' in exposedAutoState), 'unused aggregate auto state is omitted');
  assert(!('videoTypeDetected' in exposedAutoState), 'internal detection state is omitted');
  assert(exposedAutoState.autoApplyLoudnessVideo === true, 'video auto flag exposed to popup state');
  assert(exposedAutoState.autoApplyLoudnessLive === false, 'live auto flag exposed to popup state');

  section('Auto LUFS: Video setting does not enable Live');
  ytcv._set('currentVideoType', 'live');
  await ytcv.applyPreferredGain();
  assert(ytcv.getState().autoApplyLoudnessLive === false, 'current live type remains manual');
  assert(ytcv.state.currentGain === 0.7, 'live uses its saved gain while only video auto is enabled');
  ytcv._set('currentVideoType', 'video');
  await ytcv.applyPreferredGain();

  section('Popup state: internal type detection does not emit a redundant update');
  ytcv._set('currentVideoTypeDetected', false);
  ytcv._set('currentGain', 0.4321);
  ytcv.notifyPopup();
  const messagesBeforeDetectionOnlyChange = mockSentMessages.length;
  ytcv._set('currentVideoTypeDetected', true);
  ytcv.notifyPopup();
  assert(mockSentMessages.length === messagesBeforeDetectionOnlyChange,
    'internal detection transition is absent from popup state deduplication');

  section('Auto LUFS: Target LUFS change recalculates current video');
  simulateStorageChange({
    autoLoudnessSettings: {
      newValue: { targetLufs: -20, displayUnit: '%', showGainOverlay: false }
    }
  });
  await tick();
  assert(Math.abs(ytcv.state.currentGain - 1.0) < 0.001, 'new target applied immediately');

  section('Auto LUFS: disabling restores saved channel gain');
  const manualEntry = { name: 'Auto Ch', gainVideo: 0.4 };
  mockStorage['channelVolumes'] = { 'UCauto': manualEntry };
  simulateStorageChange({
    channelVolumes: {
      oldValue: { 'UCauto': autoEntry },
      newValue: { 'UCauto': manualEntry }
    }
  });
  assert(ytcv.state.currentAutoApplyLoudnessVideo === false, 'video auto flag disabled for current channel');
  assert(ytcv.state.currentGain === 0.4, 'saved gain restored when auto is disabled');

  section('Auto LUFS: no loudness falls back to saved channel gain');
  const liveFallbackEntry = { name: 'Live Fallback', gainLive: 0.7, autoApplyLoudnessLive: true };
  mockStorage['channelVolumes'] = { 'UCfallback': liveFallbackEntry };
  ytcv._set('currentChannel', { id: 'UCfallback', name: 'Live Fallback', url: '' });
  ytcv._set('currentVideoType', 'live');
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('currentGain', 1.0);
  simulateStorageChange({
    channelVolumes: {
      oldValue: { 'UCfallback': { name: 'Live Fallback', gainLive: 0.7 } },
      newValue: { 'UCfallback': liveFallbackEntry }
    }
  });
  assert(ytcv.state.currentGain === 0.7, 'saved live gain used when LUFS is unavailable');
  ytcv._set('targetLufs', -18);
  ytcv._set('currentLoudnessDb', -6);
  await ytcv.applyPreferredGain();
  assert(Math.abs(ytcv.state.currentGain - expectedAutoGain) < 0.001, 'live auto applies calculated gain when LUFS is available');

  section('Auto LUFS: bridge loudness stores the calculated gain');
  mockStorage['channelVolumes'] = {
    'UCbridgeLearn': { name: 'Bridge Learn', autoApplyLoudnessVideo: true }
  };
  setURL('/watch', 'BRIDGELEARN');
  ytcv._set('currentChannel', { id: 'UCbridgeLearn', name: 'Bridge Learn', url: '' });
  ytcv._set('currentChannelVideoId', 'BRIDGELEARN');
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('currentLoudnessVideoId', '');
  ytcv._set('currentAutoApplyLoudnessVideo', true);
  ytcv._set('currentGain', 1.0);
  ytcv._set('targetLufs', -18);
  simulateBridgeMessage({
    videoId: 'BRIDGELEARN',
    loudnessDb: -6,
    isLiveContent: false,
    channelId: 'UCbridgeLearn',
    author: 'Bridge Learn'
  });
  await tick();
  assert(Math.abs(ytcv.state.currentGain - expectedAutoGain) < 0.001,
    'bridge loudness applies the calculated gain');
  assert(Math.abs(mockStorage['channelVolumes']['UCbridgeLearn'].gainVideo - expectedAutoGain) < 0.001,
    'bridge loudness stores the calculated gain as the channel gain');
  assert(!('autoApplyLoudnessLive' in mockStorage['channelVolumes']['UCbridgeLearn']),
    'storing an Auto gain does not touch the other type');

  section('Auto LUFS: archive gain becomes the same-channel live gain');
  // Keep this regression independent of mutable, real YouTube content.
  const comparedArchiveVideoId = 'ARCHIVE0001';
  const comparedLiveVideoId = 'LIVESTREAM1';
  mockStorage['channelVolumes'] = {
    'UCsharedLive': {
      name: 'Shared Live Channel',
      gainLive: 0.4,
      autoApplyLoudnessLive: true
    }
  };
  setURL('/watch', comparedArchiveVideoId);
  ytcv._set('currentChannel', {
    id: 'UCsharedLive',
    name: 'Shared Live Channel',
    url: 'https://www.youtube.com/channel/UCsharedLive'
  });
  ytcv._set('currentChannelVideoId', comparedArchiveVideoId);
  ytcv._set('currentVideoType', 'live');
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('currentLoudnessVideoId', comparedArchiveVideoId);
  ytcv._set('currentAutoApplyLoudnessLive', true);
  ytcv._set('targetLufs', -18);
  await ytcv.applyPreferredGain();
  assert(Math.abs(ytcv.state.currentGain - expectedAutoGain) < 0.001,
    'archive applies calculated live gain');
  assert(Math.abs(mockStorage['channelVolumes']['UCsharedLive'].gainLive - expectedAutoGain) < 0.001,
    'calculated gain becomes the channel live gain');

  setURL('/watch', comparedLiveVideoId);
  ytcv._set('currentChannelVideoId', comparedLiveVideoId);
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('currentLoudnessVideoId', comparedLiveVideoId);
  ytcv._set('currentGain', 0.4);
  await ytcv.applyPreferredGain();
  assert(Math.abs(ytcv.state.currentGain - expectedAutoGain) < 0.001,
    'same-channel live without LUFS loads the stored channel gain');

  section('Auto LUFS: switching Auto off keeps the level Auto was playing');
  const autoOffResponse = await simulateRuntimeMessage({
    type: 'setAutoApplyLoudness',
    channelId: 'UCsharedLive',
    videoType: 'live',
    enabled: false
  });
  assert(autoOffResponse?.ok === true, 'per-channel Auto OFF accepted');
  assert(ytcv.state.currentAutoApplyLoudnessLive === false, 'live Auto flag cleared');
  assert(Math.abs(ytcv.state.currentGain - expectedAutoGain) < 0.001,
    'live without LUFS keeps the same gain after Auto is switched off');
  assert(Math.abs(ytcv.state.gainNode.gain.value - expectedAutoGain) < 0.001,
    'GainNode keeps the same level after Auto is switched off');

  section('Auto LUFS: learned gain synchronizes to open live tab');
  mockStorage['channelVolumes']['UCsharedLive'].autoApplyLoudnessLive = true;
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('currentAutoApplyLoudnessLive', true);
  ytcv._set('currentGain', 0.4);
  ytcv.notifyPopup();
  const messagesBeforeGainSync = mockSentMessages.length;
  const syncedLiveEntry = {
    name: 'Shared Live Channel',
    gainLive: expectedAutoGain,
    autoApplyLoudnessLive: true
  };
  mockStorage['channelVolumes'] = { 'UCsharedLive': syncedLiveEntry };
  simulateStorageChange({
    channelVolumes: {
      oldValue: { 'UCsharedLive': { name: 'Shared Live Channel', gainLive: 0.4, autoApplyLoudnessLive: true } },
      newValue: { 'UCsharedLive': syncedLiveEntry }
    }
  });
  assert(Math.abs(ytcv.state.currentGain - expectedAutoGain) < 0.001,
    'open live tab immediately applies the gain another tab learned');
  assert(Math.abs(ytcv.state.gainNode.gain.value - expectedAutoGain) < 0.001,
    'synchronized gain reaches live tab GainNode');
  assert(mockSentMessages.length === messagesBeforeGainSync + 1 &&
    Math.abs(mockSentMessages.at(-1).gain - expectedAutoGain) < 0.001,
    'synchronized gain publishes matching popup state');

  section('Auto LUFS: stale preference read cannot undo a cross-tab gain');
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('currentAutoApplyLoudnessLive', true);
  ytcv._set('currentGain', 0.4);
  const originalStorageGet = chrome.storage.local.get;
  let resolveStaleGainRead;
  chrome.storage.local.get = key => {
    if (key === 'channelVolumes') {
      return new Promise(resolve => { resolveStaleGainRead = resolve; });
    }
    return originalStorageGet(key);
  };
  const staleApply = ytcv.applyPreferredGain();
  const newerLearnedGain = 0.8;
  const newerLiveEntry = {
    name: 'Shared Live Channel',
    gainLive: newerLearnedGain,
    autoApplyLoudnessLive: true
  };
  mockStorage['channelVolumes'] = { 'UCsharedLive': newerLiveEntry };
  simulateStorageChange({
    channelVolumes: {
      oldValue: { 'UCsharedLive': syncedLiveEntry },
      newValue: { 'UCsharedLive': newerLiveEntry }
    }
  });
  resolveStaleGainRead({
    channelVolumes: { 'UCsharedLive': syncedLiveEntry }
  });
  await staleApply;
  chrome.storage.local.get = originalStorageGet;
  assert(ytcv.state.currentGain === newerLearnedGain,
    'older async preference load does not overwrite a cross-tab gain');
  assert(ytcv.state.gainNode.gain.value === newerLearnedGain,
    'newest cross-tab gain remains applied to GainNode');

  section('Auto LUFS: hidden-type gain update leaves the current type applied');
  const hiddenTypeChannelId = 'UChiddenType';
  const hiddenTypeEntry = {
    name: 'Hidden Type',
    gainVideo: 0.2,
    gainLive: 0.65,
    autoApplyLoudnessLive: true
  };
  mockStorage['channelVolumes'] = { [hiddenTypeChannelId]: hiddenTypeEntry };
  ytcv._set('currentChannel', { id: hiddenTypeChannelId, name: 'Hidden Type', url: '' });
  ytcv._set('currentVideoType', 'live');
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('currentAutoApplyLoudnessLive', true);
  ytcv._set('currentGain', 1.0);
  const storageGetBeforeHiddenType = chrome.storage.local.get;
  let resolveHiddenTypeRead;
  chrome.storage.local.get = key => {
    if (key === 'channelVolumes') {
      return new Promise(resolve => { resolveHiddenTypeRead = resolve; });
    }
    return storageGetBeforeHiddenType(key);
  };
  const hiddenTypeApply = ytcv.applyPreferredGain();
  const hiddenTypeUpdated = { ...hiddenTypeEntry, gainVideo: 0.5 };
  mockStorage['channelVolumes'] = { [hiddenTypeChannelId]: hiddenTypeUpdated };
  simulateStorageChange({
    channelVolumes: {
      oldValue: { [hiddenTypeChannelId]: hiddenTypeEntry },
      newValue: { [hiddenTypeChannelId]: hiddenTypeUpdated }
    }
  });
  resolveHiddenTypeRead({ channelVolumes: { [hiddenTypeChannelId]: hiddenTypeEntry } });
  await hiddenTypeApply;
  chrome.storage.local.get = storageGetBeforeHiddenType;
  assert(ytcv.state.currentGain === 0.65,
    'hidden Video gain update leaves the Live gain applied');
  assert(ytcv.state.gainNode.gain.value === 0.65,
    'applied Live gain still reaches GainNode');
  assert(mockStorage['channelVolumes'][hiddenTypeChannelId].gainVideo === 0.5,
    'stale Live preference read does not roll back the hidden Video gain');

  section('Auto LUFS: manual save replaces the gain Auto learned');
  const learnedLiveEntry = {
    name: 'Shared Live Channel',
    gainLive: 0.4,
    autoApplyLoudnessLive: true
  };
  mockStorage['channelVolumes'] = { 'UCsharedLive': learnedLiveEntry };
  ytcv._set('currentChannel', {
    id: 'UCsharedLive',
    name: 'Shared Live Channel',
    url: 'https://www.youtube.com/channel/UCsharedLive'
  });
  ytcv._set('currentVideoType', 'live');
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('currentAutoApplyLoudnessLive', true);
  const manualGainResponse = await simulateRuntimeMessage({
    type: 'setGain',
    channelId: 'UCsharedLive',
    gain: 0.6
  });
  assert(manualGainResponse?.ok === true, 'manual gain save succeeds while Auto lacks LUFS');
  assert(mockStorage['channelVolumes']['UCsharedLive'].gainLive === 0.6,
    'manual live gain replaces the gain Auto stored');
  assert(mockStorage['channelVolumes']['UCsharedLive'].autoApplyLoudnessLive === true,
    'adjusting the level Auto falls back to does not switch Auto off');
  await ytcv.applyPreferredGain();
  assert(ytcv.state.currentGain === 0.6,
    'live without LUFS uses the manually saved gain');

  section('Auto LUFS: detected loudness blocks manual gain changes');
  const detectedManualChannelId = 'UCdetectedManual';
  mockStorage['channelVolumes'] = {
    [detectedManualChannelId]: {
      name: 'Detected Manual',
      gainVideo: 0.4,
      autoApplyLoudnessVideo: true
    }
  };
  ytcv._set('currentChannel', {
    id: detectedManualChannelId,
    name: 'Detected Manual',
    url: ''
  });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', 4);
  ytcv._set('currentAutoApplyLoudnessVideo', true);
  ytcv._set('targetLufs', -18);
  await ytcv.applyPreferredGain();
  const detectedAutoGain = ytcv.state.currentGain;
  assert(mockStorage['channelVolumes'][detectedManualChannelId].gainVideo === detectedAutoGain,
    'Auto stores the calculated gain as the channel gain');
  const storedDetectedManualBefore = JSON.stringify(
    mockStorage['channelVolumes'][detectedManualChannelId]
  );
  const liveManualResponse = await simulateRuntimeMessage({
    type: 'setGainLive',
    gain: 3.0
  });
  assert(liveManualResponse?.ok === false,
    'real-time manual gain is rejected while detected loudness controls Auto');
  assert(ytcv.state.currentGain === detectedAutoGain,
    'rejected real-time gain does not replace the calculated Auto gain');
  const savedManualResponse = await simulateRuntimeMessage({
    type: 'setGain',
    channelId: detectedManualChannelId,
    gain: 3.0
  });
  assert(savedManualResponse?.ok === false,
    'saved manual gain is rejected while detected loudness controls Auto');
  assert(JSON.stringify(mockStorage['channelVolumes'][detectedManualChannelId]) ===
    storedDetectedManualBefore,
    'rejected manual gain leaves the stored channel gain unchanged');
  await ytcv.applyPreferredGain();
  assert(ytcv.state.currentGain === detectedAutoGain,
    'preference re-resolution keeps the same calculated Auto gain');

  section('Auto LUFS: concurrent learning keeps every channel entry');
  mockStorage['channelVolumes'] = {};
  await Promise.all([
    ytcv.saveChannelGain('UCconcurrentA', 'Concurrent A', 0.55, 'video', ''),
    ytcv.saveChannelGain('UCconcurrentB', 'Concurrent B', 0.85, 'live', '')
  ]);
  assert(mockStorage['channelVolumes']['UCconcurrentA']?.gainVideo === 0.55,
    'concurrent channel A gain remains stored');
  assert(mockStorage['channelVolumes']['UCconcurrentB']?.gainLive === 0.85,
    'concurrent channel B gain remains stored');

  section('Auto LUFS: a placeholder name never replaces the stored channel name');
  mockStorage['channelVolumes'] = { 'UCnamed': { name: 'Named Channel', gainVideo: 0.5 } };
  await ytcv.saveChannelGain('UCnamed', 'UCnamed', 0.7, 'video', '');
  assert(mockStorage['channelVolumes']['UCnamed'].name === 'Named Channel',
    'a name equal to the channel ID leaves the stored name in place');
  assert(mockStorage['channelVolumes']['UCnamed'].gainVideo === 0.7,
    'the gain is still stored under the placeholder name');
  mockStorage['channelVolumes'] = {};
  await ytcv.saveChannelGain('UCunnamed', 'UCunnamed', 0.7, 'video', '');
  assert(mockStorage['channelVolumes']['UCunnamed'].name === 'UCunnamed',
    'a new channel falls back to the channel ID as its name');

  section('Auto LUFS: re-applying the same gain does not rewrite storage');
  mockStorage['channelVolumes'] = {
    'UCrepeat': { name: 'Repeat Ch', gainVideo: 0.55 }
  };
  const storageSetBeforeRepeat = chrome.storage.local.set;
  let channelVolumeWrites = 0;
  chrome.storage.local.set = obj => {
    if (Object.prototype.hasOwnProperty.call(obj, 'channelVolumes')) channelVolumeWrites++;
    return storageSetBeforeRepeat(obj);
  };
  await ytcv.saveChannelGain('UCrepeat', 'Repeat Ch', 0.55, 'video', '');
  assert(channelVolumeWrites === 0, 'an unchanged gain is not written again');
  await ytcv.saveChannelGain('UCrepeat', 'Repeat Ch', 0.6, 'video', '');
  assert(channelVolumeWrites === 1, 'a changed gain is written');
  chrome.storage.local.set = storageSetBeforeRepeat;

  section('Auto LUFS: early bridge for next video clears stale loudness');
  const oldVideoId = 'AAAAAAAAAAA';
  const nextVideoId = 'BBBBBBBBBBB';
  mockStorage['channelVolumes'] = {
    'UCchannelB': {
      name: 'Channel B',
      gainVideo: 0.4,
      autoApplyLoudnessVideo: true
    }
  };
  setURL('/watch', nextVideoId);
  ytcv._set('currentChannel', { id: 'UCchannelA', name: 'Channel A', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', -20);
  ytcv._set('currentLoudnessVideoId', oldVideoId);
  ytcv._set('currentAutoApplyLoudnessVideo', true);
  ytcv._set('targetLufs', -18);
  simulateBridgeMessage({
    videoId: nextVideoId,
    loudnessDb: null,
    isLiveContent: false,
    channelId: 'UCchannelB',
    author: 'Channel B'
  });
  await tick();
  await tick();
  assert(ytcv.state.currentLoudnessVideoId === nextVideoId, 'loudness state associated with next video');
  assert(ytcv.state.currentLoudnessDb === null, 'next video null clears previous video loudness');
  assert(ytcv.state.currentGain === 0.4, 'next video uses saved fallback instead of stale auto gain');

  simulateBridgeMessage({
    videoId: oldVideoId,
    loudnessDb: -20,
    isLiveContent: false,
    channelId: 'UCchannelA',
    author: 'Channel A'
  });
  await tick();
  assert(ytcv.state.currentChannel.id === 'UCchannelB', 'late previous-video bridge response ignored');
  assert(ytcv.state.currentLoudnessDb === null, 'late response does not restore stale loudness');
  assert(ytcv.state.currentGain === 0.4, 'late response does not change fallback gain');

  section('Auto LUFS: early archive gain survives delayed navigation apply');
  const liveVideoId = 'CCCCCCCCCCC';
  const archiveVideoId = 'DDDDDDDDDDD';
  mockStorage['autoLoudnessSettings'] = {
    targetLufs: -18,
    autoApplyLoudnessVideoDefault: false,
    autoApplyLoudnessLiveDefault: false
  };
  mockStorage['channelVolumes'] = {
    'UCarchiveB': {
      name: 'Archive B',
      gainLive: 0.4,
      autoApplyLoudnessLive: true
    }
  };
  mockDOMElements['canonical'] = {
    href: 'https://www.youtube.com/channel/UCstaleLiveA'
  };
  mockDOMElements['channelName'] = { textContent: 'Stale Live A' };
  ytcv._set('_lastVideoId', liveVideoId);
  ytcv._set('currentChannel', {
    id: 'UCliveA',
    name: 'Live A',
    url: 'https://www.youtube.com/channel/UCliveA'
  });
  ytcv._set('currentChannelVideoId', liveVideoId);
  ytcv._set('currentVideoType', 'live');
  ytcv._set('currentVideoTypeDetected', true);
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('currentLoudnessVideoId', liveVideoId);
  ytcv._set('currentAutoApplyLoudnessLive', true);
  ytcv._set('currentGain', 0.4);
  ytcv.commitGain(0.4);

  setURL('/watch', archiveVideoId);
  simulateBridgeMessage({
    videoId: archiveVideoId,
    loudnessDb: -6,
    isLiveContent: true,
    isLiveNow: false,
    channelId: 'UCarchiveB',
    author: 'Archive B'
  });
  await tick();
  await tick();
  assert(Math.abs(ytcv.state.currentGain - expectedAutoGain) < 0.001,
    'archive bridge applies calculated gain before navigation handler');

  await ytcv.applyVideoVolume();
  assert(ytcv.state.currentChannel.id === 'UCarchiveB',
    'delayed navigation preserves bridge channel over stale DOM');
  assert(ytcv.state.currentVideoType === 'live',
    'delayed navigation preserves archive type');
  assert(ytcv.state.currentLoudnessDb === -6,
    'delayed navigation preserves archive loudness');
  assert(Math.abs(ytcv.state.currentGain - expectedAutoGain) < 0.001,
    'delayed navigation does not replace calculated gain with fallback');
  assert(Math.abs(ytcv.state.gainNode.gain.value - expectedAutoGain) < 0.001,
    'calculated archive gain remains applied to audio node');
  mockDOMElements['canonical'] = null;
  mockDOMElements['channelName'] = null;

  section('Popup: forceDetect waits for adjusted archive gain');
  const popupArchiveVideoId = 'EEEEEEEEEEE';
  mockStorage['channelVolumes'] = {
    'UCpopupArchive': {
      name: 'Popup Archive',
      gainLive: 0.4,
      autoApplyLoudnessLive: true
    }
  };
  setURL('/live/' + popupArchiveVideoId, null);
  ytcv._set('_lastVideoId', popupArchiveVideoId);
  ytcv._set('currentChannel', {
    id: 'UCpopupArchive',
    name: 'Popup Archive',
    url: 'https://www.youtube.com/channel/UCpopupArchive'
  });
  ytcv._set('currentChannelVideoId', popupArchiveVideoId);
  ytcv._set('currentVideoType', 'live');
  ytcv._set('currentVideoTypeDetected', true);
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('currentLoudnessVideoId', popupArchiveVideoId);
  ytcv._set('currentAutoApplyLoudnessLive', true);
  ytcv._set('currentGain', 0.4);
  ytcv._set('targetLufs', -18);
  ytcv.commitGain(0.4);
  mockPostMessageHandler = (data) => {
    if (data.type !== '__yt_channel_volume_request__') return;
    setTimeout(() => simulateBridgeMessage({
      videoId: popupArchiveVideoId,
      loudnessDb: -6,
      isLiveContent: true,
      isLiveNow: false,
      channelId: 'UCpopupArchive',
      author: 'Popup Archive'
    }), 0);
  };
  const popupState = await simulateRuntimeMessage({ type: 'forceDetect' });
  mockPostMessageHandler = null;
  assert(popupState?.contentLufs === -20,
    'popup response contains archive LUFS instead of stale fallback state');
  assert(Math.abs(popupState?.gain - expectedAutoGain) < 0.001,
    'popup response contains adjusted archive gain');
  assert(Math.abs(ytcv.state.gainNode.gain.value - expectedAutoGain) < 0.001,
    'popup refresh leaves adjusted gain applied to audio node');

  section('Auto LUFS: saving flag preserves per-type gains');
  mockStorage['channelVolumes'] = {
    'UCpersistAuto': { name: 'Persist Auto', gainVideo: 0.6, gainLive: 1.4 }
  };
  await ytcv.saveChannelAutoApply('UCpersistAuto', 'Persist Auto', true, 'video', 'https://example.com');
  const persistedAuto = mockStorage['channelVolumes']['UCpersistAuto'];
  assert(persistedAuto.autoApplyLoudnessVideo === true, 'video auto flag persisted on channel entry');
  assert(!persistedAuto.autoApplyLoudnessLive, 'live auto flag remains disabled');
  assert(persistedAuto.gainVideo === 0.6, 'gainVideo preserved while saving auto flag');
  assert(persistedAuto.gainLive === 1.4, 'gainLive preserved while saving auto flag');
  await ytcv.saveChannelAutoApply('UCpersistAuto', 'Persist Auto', true, 'live', 'https://example.com');
  assert(mockStorage['channelVolumes']['UCpersistAuto'].autoApplyLoudnessVideo === true,
    'video auto flag preserved when enabling live');
  assert(mockStorage['channelVolumes']['UCpersistAuto'].autoApplyLoudnessLive === true,
    'live auto flag enabled independently');
  await ytcv.saveChannelAutoApply('UCpersistAuto', 'Persist Auto', false, 'video', 'https://example.com');
  assert(!mockStorage['channelVolumes']['UCpersistAuto'].autoApplyLoudnessVideo,
    'video auto flag disabled independently');
  assert(mockStorage['channelVolumes']['UCpersistAuto'].autoApplyLoudnessLive === true,
    'live auto flag remains enabled');

  mockStorage['channelVolumes']['UClegacyAuto'] = { name: 'Legacy Auto', autoApplyLoudness: true };
  await ytcv.saveChannelAutoApply('UClegacyAuto', 'Legacy Auto', false, 'video', '');
  const migratedAuto = mockStorage['channelVolumes']['UClegacyAuto'];
  assert(!migratedAuto.autoApplyLoudness, 'legacy all-types auto flag removed on update');
  assert(!migratedAuto.autoApplyLoudnessVideo, 'updated legacy video flag disabled');
  assert(migratedAuto.autoApplyLoudnessLive === true, 'legacy live flag preserved as enabled');

  mockStorage['channelVolumes']['UCautoOnly'] = { name: 'Auto Only', autoApplyLoudnessVideo: true };
  await ytcv.saveChannelAutoApply('UCautoOnly', 'Auto Only', false, 'video', '');
  assert(mockStorage['channelVolumes']['UCautoOnly'].autoApplyLoudnessVideo === false,
    'explicit disabled state retained for all-channel default override');

  section('Auto LUFS defaults: a manual save pins Auto against a later default');
  mockStorage['channelVolumes'] = { 'UCdefaultAuto': { name: 'Default Auto' } };
  ytcv._set('currentChannel', { id: 'UCdefaultAuto', name: 'Default Auto', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('defaultAutoApplyLoudnessVideo', false);
  ytcv._set('defaultAutoApplyLoudnessLive', false);
  ytcv._set('currentAutoApplyLoudnessVideo', false);
  ytcv._set('currentAutoApplyLoudnessLive', false);
  await simulateRuntimeMessage({
    type: 'setGain',
    channelId: 'UCdefaultAuto',
    gain: 0.45
  });
  const pinnedEntry = mockStorage['channelVolumes']['UCdefaultAuto'];
  assert(pinnedEntry.gainVideo === 0.45, 'manual Video gain saved');
  assert(pinnedEntry.autoApplyLoudnessVideo === false,
    'manual save records the Auto state it was made under');
  assert(!('autoApplyLoudnessLive' in pinnedEntry),
    'the untouched type keeps inheriting the all-channel default');

  ytcv._set('defaultAutoApplyLoudnessVideo', true);
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('targetLufs', -18);
  const pinnedEntryBefore = JSON.stringify(pinnedEntry);
  await ytcv.applyPreferredGain();
  assert(ytcv.state.currentAutoApplyLoudnessVideo === false,
    'a pinned manual gain stays manual when the all-channel default turns ON');
  assert(ytcv.state.currentAutoApplyLoudnessLive === false, 'live keeps independent all-channel OFF');
  assert(ytcv.state.currentGain === 0.45, 'pinned manual Video gain remains applied');
  assert(JSON.stringify(mockStorage['channelVolumes']['UCdefaultAuto']) === pinnedEntryBefore,
    'resolving a pinned channel writes nothing');

  mockStorage['channelVolumes']['UCunconfiguredAuto'] = { name: 'Unconfigured Auto' };
  ytcv._set('currentChannel', {
    id: 'UCunconfiguredAuto',
    name: 'Unconfigured Auto',
    url: ''
  });
  await ytcv.applyPreferredGain();
  assert(ytcv.state.currentAutoApplyLoudnessVideo === true,
    'channel type without an explicit choice inherits all-channel ON');
  assert(Math.abs(ytcv.state.currentGain - expectedAutoGain) < 0.001,
    'unconfigured channel type applies automatic gain');
  const inheritedEntry = mockStorage['channelVolumes']['UCunconfiguredAuto'];
  assert(Math.abs(inheritedEntry.gainVideo - expectedAutoGain) < 0.001,
    'Auto stores its calculated gain on an inherited channel');
  assert(!('autoApplyLoudnessVideo' in inheritedEntry),
    'storing the gain does not pin the inherited default');

  section('Auto LUFS defaults: SPA navigation cannot mix channel metadata');
  const navigationSourceId = 'UCnavSource';
  mockStorage['channelVolumes'] = {
    [navigationSourceId]: {
      name: 'Channel A',
      url: 'https://www.youtube.com/channel/UCnavSource'
    }
  };
  setURL('/watch', 'NAVIGATE001');
  ytcv._set('currentChannel', {
    id: navigationSourceId,
    name: 'Channel A',
    url: 'https://www.youtube.com/channel/UCnavSource'
  });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('defaultAutoApplyLoudnessVideo', true);
  const originalStorageSet = chrome.storage.local.set;
  let releaseChannelSave;
  chrome.storage.local.set = obj => {
    Object.assign(mockStorage, obj);
    if (!releaseChannelSave &&
        Object.prototype.hasOwnProperty.call(obj, 'channelVolumes')) {
      return new Promise(resolve => { releaseChannelSave = resolve; });
    }
    return Promise.resolve();
  };
  const navigationApply = ytcv.applyPreferredGain();
  await tick();
  setURL('/watch', 'NAVIGATE002');
  ytcv._set('currentChannel', {
    id: 'UCnavTarget',
    name: 'Channel B',
    url: 'https://www.youtube.com/channel/UCnavTarget'
  });
  releaseChannelSave();
  await navigationApply;
  chrome.storage.local.set = originalStorageSet;
  assert(mockStorage['channelVolumes'][navigationSourceId].name === 'Channel A',
    'source channel name is not replaced after SPA navigation');
  assert(mockStorage['channelVolumes'][navigationSourceId].url ===
    'https://www.youtube.com/channel/UCnavSource',
    'source channel URL is not replaced after SPA navigation');
  assert(!('autoApplyLoudnessVideo' in mockStorage['channelVolumes'][navigationSourceId]),
    'inherited default remains unset after a delayed Auto gain save');

  mockStorage['channelVolumes']['UCdefaultAuto'] = {
    name: 'Default Auto',
    gainVideo: 0.45,
    gainLive: 0.8
  };
  ytcv._set('currentChannel', { id: 'UCdefaultAuto', name: 'Default Auto', url: '' });
  await ytcv.saveChannelAutoApply('UCdefaultAuto', 'Default Auto', false, 'video', '');
  await ytcv.applyPreferredGain();
  const explicitOffEntry = mockStorage['channelVolumes']['UCdefaultAuto'];
  assert(explicitOffEntry.autoApplyLoudnessVideo === false, 'per-channel OFF recorded explicitly');
  assert(explicitOffEntry.gainVideo === 0.45 && explicitOffEntry.gainLive === 0.8,
    'recording per-channel OFF preserves saved gains');
  assert(ytcv.state.currentAutoApplyLoudnessVideo === false, 'per-channel OFF overrides all-channel ON');
  assert(ytcv.state.currentGain === 0.45, 'explicit OFF restores saved video gain');

  ytcv._set('currentAutoApplyLoudnessVideo', false);
  ytcv._set('currentAutoApplyLoudnessLive', false);
  ytcv._set('defaultAutoApplyLoudnessVideo', false);
  ytcv._set('defaultAutoApplyLoudnessLive', false);
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('targetLufs', -18);

  // ── Channel detection fallback ──────────────────────────────────────

  section('detectChannel: canonical link');
  mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCcanon123' };
  mockDOMElements['ownerLink'] = null;
  const chCanon = ytcv.detectChannel();
  assert(chCanon.id === 'UCcanon123', 'canonical → UC ID');
  mockDOMElements['canonical'] = null;

  section('detectChannel: @handle-only owner link returns empty (UC awaited from bridge)');
  // Modern YouTube owner links often use /@handle form, but the @handle is
  // unsafe as an identifier during SPA navigation (stale reads leak between
  // channels). detectChannel refuses it; bridge supplies the authoritative UC.
  mockDOMElements['ownerLink'] = { href: 'https://www.youtube.com/@sleepfreaks' };
  mockDOMElements['channelName'] = { textContent: 'SLEEP FREAKS' };
  const chOwner = ytcv.detectChannel();
  assert(chOwner.id === '', '@handle owner link → empty id');
  assert(chOwner.name === '', 'name empty when no UC available');
  mockDOMElements['ownerLink'] = null;
  mockDOMElements['channelName'] = null;

  section('detectChannel: owner link with /channel/ UC ID');
  mockDOMElements['ownerLink'] = { href: 'https://www.youtube.com/channel/UCowner456' };
  const chOwnerUC = ytcv.detectChannel();
  assert(chOwnerUC.id === 'UCowner456', 'owner link UC ID detected');
  mockDOMElements['ownerLink'] = null;

  section('detectChannel: Japanese handle also refused');
  mockDOMElements['ownerLink'] = { href: 'https://www.youtube.com/@%E3%82%86%E3%81%A3%E3%81%8F%E3%82%8A' };
  const chJp = ytcv.detectChannel();
  assert(chJp.id === '', 'Japanese @handle owner link → empty id');
  mockDOMElements['ownerLink'] = null;

  section('detectChannel: meta tag fallback');
  mockDOMElements['metaChannel'] = { content: 'UCmeta789' };
  const chMeta = ytcv.detectChannel();
  assert(chMeta.id === 'UCmeta789', 'meta tag channelId detected');
  mockDOMElements['metaChannel'] = null;

  section('detectChannel: nothing found');
  const chNone = ytcv.detectChannel();
  assert(chNone.id === '', 'no channel → empty id');
  assert(chNone.name === '', 'no channel → empty name');

  // ── Data integrity: channelId overwrite must update name ────────────

  section('Data: @handle-only DOM yields empty currentChannel, bridge supplies UC+name');
  mockDOMElements['canonical'] = null;
  mockDOMElements['ownerLink'] = { href: 'https://www.youtube.com/@old_handle' };
  mockDOMElements['channelName'] = { textContent: 'Old Channel' };
  setURL('/watch', 'vid_data1');
  ytcv._set('_lastProcessedVideo', null);
  ytcv._set('_lastVideoId', '');
  ytcv._set('currentChannel', { id: '', name: '', url: '' });
  await ytcv.triggerApply();
  // DOM only provides @handle → detectChannel returns empty; wait for bridge.
  assert(ytcv.state.currentChannel.id === '', 'initial: empty (@handle refused)');
  assert(ytcv.state.currentChannel.name === '', 'initial: empty name');
  // Bridge provides authoritative UC + author for the current video.
  simulateBridgeMessage({ loudnessDb: -5.0, isLiveContent: false, channelId: 'UCnew123', author: 'New Channel' });
  assert(ytcv.state.currentChannel.id === 'UCnew123', 'bridge provided UC id');
  assert(ytcv.state.currentChannel.name === 'New Channel', 'name from author');
  assert(ytcv.state.currentChannel.url === 'https://www.youtube.com/channel/UCnew123', 'url from UC');

  section('Data: bridge author is authoritative over any stale in-memory name');
  // Even if somehow we held an old name, a cross-channel bridge update must
  // overwrite it with author (the player response for the current video).
  ytcv._set('currentChannel', { id: 'UCprev', name: 'Prev Channel Name', url: '' });
  mockDOMElements['channelName'] = null;
  simulateBridgeMessage({ loudnessDb: -3.0, isLiveContent: false, channelId: 'UCfresh', author: 'Fresh Channel' });
  assert(ytcv.state.currentChannel.id === 'UCfresh', 'id updated');
  assert(ytcv.state.currentChannel.name === 'Fresh Channel', 'name replaced by author');

  section('Data: Auto toggle preserves authoritative bridge author');
  mockStorage['channelVolumes'] = {
    'UCchannelB': { name: 'Channel B', gainVideo: 0.4 }
  };
  setURL('/watch', 'BBBBBBBBBBB');
  ytcv._set('currentChannel', {
    id: 'UCchannelB',
    name: 'Channel B',
    url: 'https://www.youtube.com/channel/UCchannelB'
  });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', null);
  mockDOMElements['channelName'] = { textContent: 'Stale Channel A' };
  const toggleResponse = await simulateRuntimeMessage({
    type: 'setAutoApplyLoudness',
    channelId: 'UCchannelB',
    enabled: true,
    videoType: 'video'
  });
  assert(toggleResponse?.ok === true, 'Auto toggle succeeds');
  assert(mockStorage['channelVolumes']['UCchannelB'].name === 'Channel B',
    'stale DOM does not overwrite authoritative bridge author');

  section('Data: Auto toggle uses DOM only for a placeholder name');
  mockStorage['channelVolumes']['UCchannelC'] = { name: 'UCchannelC', gainVideo: 0.5 };
  ytcv._set('currentChannel', {
    id: 'UCchannelC',
    name: 'UCchannelC',
    url: 'https://www.youtube.com/channel/UCchannelC'
  });
  mockDOMElements['channelName'] = { textContent: 'Channel C' };
  const stubToggleResponse = await simulateRuntimeMessage({
    type: 'setAutoApplyLoudness',
    channelId: 'UCchannelC',
    enabled: false,
    videoType: 'video'
  });
  assert(stubToggleResponse?.ok === true, 'Auto toggle succeeds for placeholder name');
  assert(mockStorage['channelVolumes']['UCchannelC'].name === 'Channel C',
    'DOM fills an empty or channel-ID placeholder name');
  mockDOMElements['channelName'] = null;

  // ── Data integrity: saveChannelGain preserves other fields ─────────

  section('Data: saveChannelGain preserves existing gainLive when saving gainVideo');
  mockStorage['channelVolumes'] = {
    'UCpreserve': { name: 'Preserve Ch', gainLive: 0.8, gainVideo: 1.0, url: 'https://example.com' }
  };
  ytcv._set('currentChannel', { id: 'UCpreserve', name: 'Preserve Ch', url: 'https://example.com' });
  ytcv._set('currentVideoType', 'video');
  // Verify gainLive is preserved in storage
  const preserveEntry = mockStorage['channelVolumes']['UCpreserve'];
  assert(preserveEntry.gainLive === 0.8, 'gainLive preserved in storage');
  assert(preserveEntry.gainVideo === 1.0, 'gainVideo present in storage');

  section('Data: id-shape @handle migration is NOT performed (corruption prevention)');
  // Legacy @handle → UC migration triggered purely by id-shape was the root
  // cause of silent cross-channel storage corruption on SPA navigation. It has
  // been removed. Only name-matched backfill migrates orphan @handle entries.
  mockStorage['channelVolumes'] = {
    '@migrate_handle': { name: 'Migrate Ch', gainVideo: 0.7 },
    'UCexisting': { name: 'Existing UC Ch', gainVideo: 0.3, gainLive: 0.4 }
  };
  ytcv._set('currentChannel', { id: '@migrate_handle', name: 'Migrate Ch', url: '' });
  // No author in bridge message → backfill condition not met.
  simulateBridgeMessage({ loudnessDb: -2.0, isLiveContent: false, channelId: 'UCexisting' });
  await tick();
  const storageAfter = mockStorage['channelVolumes'];
  assert(storageAfter['UCexisting'].gainVideo === 0.3, 'existing UC entry not overwritten');
  assert(storageAfter['UCexisting'].gainLive === 0.4, 'existing UC gainLive preserved');
  assert('@migrate_handle' in storageAfter, '@handle entry untouched (no automatic migration)');

  section('Data: orphan @handle entry adopted via backfill when author matches');
  mockStorage['channelVolumes'] = {
    '@new_handle': { name: 'New Handle Ch', gainVideo: 0.6 }
  };
  ytcv._set('currentChannel', { id: '', name: '', url: '' });
  simulateBridgeMessage({ loudnessDb: -1.0, isLiveContent: false, channelId: 'UCbrand_new', author: 'New Handle Ch' });
  await tick();
  await tick();
  const storageAfter2 = mockStorage['channelVolumes'];
  assert('UCbrand_new' in storageAfter2, 'UC entry created via backfill');
  assert(storageAfter2['UCbrand_new'].gainVideo === 0.6, 'gain migrated via backfill');
  assert(!('@new_handle' in storageAfter2), '@handle deleted after backfill');

  // ── Cross-tab sync via storage.onChanged ───────────────────────────

  section('Sync: onChanged applies new gainVideo for current channel');
  ytcv._set('currentChannel', { id: 'UCsync1', name: 'Sync Ch', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentGain', 1.0);
  simulateStorageChange({
    channelVolumes: { newValue: { 'UCsync1': { name: 'Sync Ch', gainVideo: 0.5, gainLive: 0.9 } } }
  });
  assert(ytcv.state.currentGain === 0.5, 'currentGain updated to new gainVideo');

  section('Sync: onChanged applies gainLive when currentVideoType=live');
  ytcv._set('currentChannel', { id: 'UCsync2', name: 'Sync Ch', url: '' });
  ytcv._set('currentVideoType', 'live');
  ytcv._set('currentGain', 1.0);
  simulateStorageChange({
    channelVolumes: { newValue: { 'UCsync2': { name: 'Sync Ch', gainVideo: 0.3, gainLive: 0.7 } } }
  });
  assert(ytcv.state.currentGain === 0.7, 'currentGain updated to new gainLive');

  section('Sync: onChanged ignores unrelated channel');
  ytcv._set('currentChannel', { id: 'UCsync3', name: 'Sync Ch', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentGain', 1.0);
  simulateStorageChange({
    channelVolumes: { newValue: { 'UCother': { name: 'Other', gainVideo: 0.2 } } }
  });
  assert(ytcv.state.currentGain === 1.0, 'gain unchanged for non-matching channel');

  section('Sync: onChanged no-op when gain is unchanged');
  ytcv._set('currentChannel', { id: 'UCsync4', name: 'Sync Ch', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentGain', 0.4);
  ytcv.notifyPopup();
  const sentBefore = mockSentMessages.length;
  simulateStorageChange({
    channelVolumes: { newValue: { 'UCsync4': { name: 'Sync Ch', gainVideo: 0.4 } } }
  });
  assert(ytcv.state.currentGain === 0.4, 'gain unchanged (dedup)');
  assert(mockSentMessages.length === sentBefore, 'no popup notify on dedup');

  section('Sync: onChanged applies legacy {gain} format');
  ytcv._set('currentChannel', { id: 'UClegacy', name: 'Legacy Ch', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentGain', 1.0);
  simulateStorageChange({
    channelVolumes: { newValue: { 'UClegacy': { name: 'Legacy Ch', gain: 0.6 } } }
  });
  assert(ytcv.state.currentGain === 0.6, 'legacy gain format applied');

  section('Sync: onChanged resets to 1.0 when entry is deleted in another tab');
  ytcv._set('currentChannel', { id: 'UCdel', name: 'Del Ch', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentGain', 0.5);
  simulateStorageChange({
    channelVolumes: { newValue: {} }
  });
  assert(ytcv.state.currentGain === 1.0, 'gain reset to 1.0 on remote delete');

  section('Sync: onChanged ignores entry with null gain for current type');
  ytcv._set('currentChannel', { id: 'UCsync5', name: 'Sync Ch', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentGain', 1.0);
  simulateStorageChange({
    channelVolumes: { newValue: { 'UCsync5': { name: 'Sync Ch', gainLive: 0.8 } } }
  });
  assert(ytcv.state.currentGain === 1.0, 'gain unchanged when gainVideo missing');

  // ── isLiveNow transition (waiting → live) ─────────────────────────

  section('isLiveNow: bridge update from false to true triggers notifyPopup');
  ytcv._set('currentChannel', { id: 'UCliveTransition', name: 'Live Ch', url: '' });
  ytcv._set('currentVideoType', 'live');
  simulateBridgeMessage({ loudnessDb: null, isLiveContent: true, isLiveNow: false, channelId: 'UCliveTransition', author: 'Live Ch' });
  assert(ytcv.state.currentIsLiveNow === false, 'initially not live');
  const stateBeforeLive = ytcv.getState();
  simulateBridgeMessage({ loudnessDb: null, isLiveContent: true, isLiveNow: true, channelId: 'UCliveTransition', author: 'Live Ch' });
  assert(ytcv.state.currentIsLiveNow === true, 'transitioned to live');
  const stateAfterLive = ytcv.getState();
  assert(stateAfterLive.isLiveNow === true, 'getState.isLiveNow is true after transition');
  assert(stateAfterLive.videoType === 'live', 'videoType remains live');

  section('isLiveNow: notifyPopup dedup key distinguishes isLiveNow change');
  function buildNotifyKey(s) {
    return s.loudnessDb + '|' + s.gain + '|' + s.channel.id + '|' + s.channel.name + '|' + s.videoType + '|' + s.isLiveNow;
  }
  const keyBefore = buildNotifyKey(stateBeforeLive);
  const keyAfter = buildNotifyKey(stateAfterLive);
  assert(keyBefore !== keyAfter, 'dedup key differs when isLiveNow changes');

  // ── Summary ────────────────────────────────────────────────────────

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
