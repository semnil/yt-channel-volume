// test-navigation.js — Navigation & state transition tests for content.js
// Run: node test-navigation.js

const fs = require('fs');

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
let mockSentMessages = [];
let mockPostMessages = [];

function resetMocks() {
  mockLocation = { pathname: '/watch', search: '?v=abc123', href: 'https://www.youtube.com/watch?v=abc123' };
  mockStorage = {};
  mockVideoEl = { id: 'mock-video-1' };
  mockDOMElements = {};
  mockEventListeners = {};
  mockSentMessages = [];
  mockPostMessages = [];
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
  postMessage(data) { mockPostMessages.push(data); },
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
    sendMessage() { return Promise.resolve(); },
    onMessage: { addListener() {} },
  },
  storage: {
    local: {
      get(key) {
        return Promise.resolve({ [key]: mockStorage[key] || {} });
      },
      set(obj) {
        Object.assign(mockStorage, obj);
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

const contentSrc = fs.readFileSync('./content.js', 'utf8');
eval(contentSrc);

const ytcv = globalThis.__YTCV__;
assert(!!ytcv, 'Test export available');

// Helper to simulate page-bridge message
function simulateBridgeMessage(data) {
  const listeners = mockEventListeners['message'] || [];
  for (const fn of listeners) {
    fn({ source: globalThis.window, data: { type: '__yt_channel_volume__', ...data } });
  }
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
  simulateBridgeMessage({ loudnessDb: -3.0, isLiveContent: true, isLiveNow: true, channelId: 'UCtest' });
  assert(ytcv.state.currentVideoType === 'live', 'videoType set to live');
  assert(ytcv.state.currentIsLiveNow === true, 'isLiveNow set');

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

  // ── Channel detection fallback ──────────────────────────────────────

  section('detectChannel: canonical link');
  mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCcanon123' };
  mockDOMElements['ownerLink'] = null;
  const chCanon = ytcv.detectChannel();
  assert(chCanon.id === 'UCcanon123', 'canonical → UC ID');
  mockDOMElements['canonical'] = null;

  section('detectChannel: #owner a[href*="/@"] (watch-metadata-refresh layout)');
  mockDOMElements['ownerLink'] = { href: 'https://www.youtube.com/@sleepfreaks' };
  mockDOMElements['channelName'] = { textContent: 'SLEEP FREAKS' };
  const chOwner = ytcv.detectChannel();
  assert(chOwner.id === '@sleepfreaks', 'owner link @handle detected');
  assert(chOwner.name === 'SLEEP FREAKS', 'display name from #channel-name');
  assert(chOwner.url === 'https://www.youtube.com/@sleepfreaks', 'URL from handle');
  mockDOMElements['ownerLink'] = null;
  mockDOMElements['channelName'] = null;

  section('detectChannel: owner link with /channel/ UC ID');
  mockDOMElements['ownerLink'] = { href: 'https://www.youtube.com/channel/UCowner456' };
  const chOwnerUC = ytcv.detectChannel();
  assert(chOwnerUC.id === 'UCowner456', 'owner link UC ID detected');
  mockDOMElements['ownerLink'] = null;

  section('detectChannel: Japanese handle');
  mockDOMElements['ownerLink'] = { href: 'https://www.youtube.com/@%E3%82%86%E3%81%A3%E3%81%8F%E3%82%8A' };
  const chJp = ytcv.detectChannel();
  assert(chJp.id === '@ゆっくり', 'Japanese handle decoded');
  assert(chJp.url === 'https://www.youtube.com/@ゆっくり', 'Japanese handle URL');
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

  section('Data: bridge channelId update refreshes name');
  mockDOMElements['canonical'] = null;
  mockDOMElements['ownerLink'] = { href: 'https://www.youtube.com/@old_handle' };
  mockDOMElements['channelName'] = { textContent: 'Old Channel' };
  setURL('/watch', 'vid_data1');
  ytcv._set('_lastProcessedVideo', null);
  ytcv._set('_lastVideoId', '');
  await ytcv.triggerApply();
  // State should have old channel info
  assert(ytcv.state.currentChannel.id === '@old_handle', 'initial: @old_handle');
  assert(ytcv.state.currentChannel.name === 'Old Channel', 'initial: Old Channel');
  // Simulate bridge returning new channelId with updated DOM
  mockDOMElements['channelName'] = { textContent: 'New Channel' };
  simulateBridgeMessage({ loudnessDb: -5.0, isLiveContent: false, channelId: 'UCnew123' });
  assert(ytcv.state.currentChannel.id === 'UCnew123', 'bridge updated id to UC');
  assert(ytcv.state.currentChannel.name === 'New Channel', 'name refreshed from DOM');
  assert(ytcv.state.currentChannel.url === 'https://www.youtube.com/channel/UCnew123', 'url updated to UC');

  section('Data: bridge channelId does not overwrite name with stale DOM');
  ytcv._set('currentChannel', { id: '@stale', name: 'Stale Name', url: '' });
  mockDOMElements['channelName'] = null; // DOM not yet updated
  simulateBridgeMessage({ loudnessDb: -3.0, isLiveContent: false, channelId: 'UCfresh' });
  assert(ytcv.state.currentChannel.id === 'UCfresh', 'id updated');
  assert(ytcv.state.currentChannel.name === 'Stale Name', 'name kept when DOM empty');

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

  section('Data: @handle migration preserves data, does not overwrite existing UC entry');
  mockStorage['channelVolumes'] = {
    '@migrate_handle': { name: 'Migrate Ch', gainVideo: 0.7 },
    'UCexisting': { name: 'Existing UC Ch', gainVideo: 0.3, gainLive: 0.4 }
  };
  ytcv._set('currentChannel', { id: '@migrate_handle', name: 'Migrate Ch', url: '' });
  simulateBridgeMessage({ loudnessDb: -2.0, isLiveContent: false, channelId: 'UCexisting' });
  await tick();
  // UCexisting already exists → migration should NOT overwrite it
  const storageAfter = mockStorage['channelVolumes'];
  assert(storageAfter['UCexisting'].gainVideo === 0.3, 'existing UC entry not overwritten');
  assert(storageAfter['UCexisting'].gainLive === 0.4, 'existing UC gainLive preserved');
  // @handle entry should still exist (not deleted because UC already existed)
  assert('@migrate_handle' in storageAfter, '@handle kept when UC exists');

  section('Data: @handle migration moves data when UC does not exist');
  mockStorage['channelVolumes'] = {
    '@new_handle': { name: 'New Handle Ch', gainVideo: 0.6 }
  };
  ytcv._set('currentChannel', { id: '@new_handle', name: 'New Handle Ch', url: '' });
  simulateBridgeMessage({ loudnessDb: -1.0, isLiveContent: false, channelId: 'UCbrand_new' });
  await tick();
  const storageAfter2 = mockStorage['channelVolumes'];
  assert('UCbrand_new' in storageAfter2, 'UC entry created');
  assert(storageAfter2['UCbrand_new'].gainVideo === 0.6, 'gain migrated');
  assert(!('@new_handle' in storageAfter2), '@handle deleted after migration');

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

  // ── Summary ────────────────────────────────────────────────────────

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
