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

// A node that can hold children, so a case can ask where the overlay ended up
// rather than only that something was made.
const mockDetached = new Set();
function mockElement(tag) {
  const el = {
    tagName: tag,
    style: { cssText: '' },
    textContent: '',
    parentNode: null,
    children: [],
    appendChild(child) {
      if (child.parentNode) { child.parentNode.removeChild(child); }
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      const at = el.children.indexOf(child);
      if (at > -1) { el.children.splice(at, 1); }
      if (child.parentNode === el) { child.parentNode = null; }
      return child;
    },
  };
  return el;
}

// Minimal DOM mock
globalThis.document = {
  querySelector(sel) {
    // video element
    if (sel.includes('video.html5-main-video') || (sel === 'video')) return mockVideoEl;
    if (sel.includes('.ytp-volume-area')) return mockDOMElements['volumeArea'] || null;
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
  createElement(tag) { return mockElement(tag); },
  // A case can put a node outside the document. Nothing in content.js asks
  // this today — the overlay moves rather than recreating — and the mock keeps
  // answering so that a branch which recreates a detached node is measured the
  // way a browser would run it.
  contains(node) { return !mockDetached.has(node); },
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
// runtime.sendMessage carries two things: popup notifications, and the channel
// writes background.js performs. Both are delivered as the browser does, so a
// test exercises the real service-worker path rather than a stand-in.
let mockWorkerListeners = [];
globalThis.chrome = {
  runtime: {
    id: 'test-extension-id',
    sendMessage(message) {
      mockSentMessages.push(message);
      for (const fn of mockWorkerListeners) {
        let response;
        const handled = fn(message, {}, r => { response = r; });
        if (!handled) continue;
        return new Promise(resolve => {
          const settle = () => {
            if (response === undefined) { setTimeout(settle, 1); return; }
            resolve(response);
          };
          settle();
        });
      }
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

// AudioContext mock. What it did not keep was any record of being asked: a
// resume nobody counted and a disconnect nobody counted are two of the things
// ensureAudioChain does that a case can only ask about if the mock remembers.
let mockAudioAsks = { resumes: 0, disconnects: 0 };
globalThis.AudioContext = class {
  constructor() { this.state = 'running'; }
  resume() { mockAudioAsks.resumes += 1; this.state = 'running'; return Promise.resolve(); }
  createMediaElementSource() {
    return { connect() {}, disconnect() { mockAudioAsks.disconnects += 1; } };
  }
  createGain() {
    return { gain: { value: 1.0 }, connect() {} };
  }
};

// ── Load content.js ──────────────────────────────────────────────────

globalThis.__TEST_YTCV__ = true;

// Storage as it stands when a tab loads right after the upgrade: the gain Auto
// learned still lives in a legacy key. content.js has to fold it in before its
// first apply, or the tab plays the older manual gain.
mockStorage['channelVolumes'] = {
  UCboot: { name: 'Boot Ch', gainVideo: 0.25, autoApplyLoudnessVideo: true }
};
mockStorage['autoLoudnessFallback:UCboot:video'] = 0.62;
mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCboot' };

vm.runInThisContext(fs.readFileSync('./utils.js', 'utf8'), { filename: 'utils.js' });

// background.js pulls utils.js in with importScripts, which this context has
// already evaluated. Its listener registers on the worker side of sendMessage.
globalThis.importScripts = () => {};
const workerChrome = {
  runtime: { onMessage: { addListener(fn) { mockWorkerListeners.push(fn); } } }
};
(function loadWorker() {
  const realChrome = globalThis.chrome;
  globalThis.chrome = { ...realChrome, runtime: { ...realChrome.runtime, ...workerChrome.runtime } };
  vm.runInThisContext(fs.readFileSync('./background.js', 'utf8'), { filename: 'background.js' });
  globalThis.chrome = realChrome;
})();

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

// Chrome closes the message port when the listener returns anything but true,
// and a sendResponse made after that reaches nobody. Resolving on the callback
// whatever the listener returned made that contract invisible: every handler
// answering from a .then could drop its `return true` and the popup would wait
// for ever with this suite still green.
// A listener that declines a message it does not handle answers nothing and
// keeps nothing open; a caller expecting that says so.
function simulateRuntimeMessage(data, { expectNoAnswer = false } = {}) {
  return new Promise((resolve, reject) => {
    const listener = mockRuntimeMessageListeners[0];
    if (!listener) {
      resolve(undefined);
      return;
    }
    let open = true;
    let answered = false;
    const reply = (value) => {
      if (!open) {
        reject(new Error(`${data?.type} answered after its port shut — Chrome drops that`));
        return;
      }
      answered = true;
      resolve(value);
    };
    const kept = listener(data, {}, reply);
    if (kept !== true) {
      open = false;
      // Handing back a marker and carrying on is not enough: the handler's own
      // work is still in flight and the cases after this one move the storage
      // it is holding, so the run wanders instead of stopping. This ends it.
      if (!answered && !expectNoAnswer) {
        reject(new Error(`${data?.type} neither kept its port open nor answered — `
          + 'an answer sent from a .then after this reaches nobody'));
      } else if (!answered) {
        resolve(undefined);
      }
    }
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


// ── page-bridge.js ───────────────────────────────────────────────────
// The MAIN-world half of the pair. No suite in any of the three extensions
// had ever loaded a bridge, so everything it decides — which answers it
// refuses, where it reads the level from, what it puts in a message — was
// held by nothing. It runs in a context of its own here: the page's window,
// the fetch it wraps, and the DOM it reads.

function createBridge({ pathname = '/watch', videoId = 'urlVideoIdA', preassigned = null } = {}) {
  const posted = [];
  const listeners = {};
  const logged = [];
  let flexy = null;
  let moviePlayer = null;
  let fetchAnswer = null;
  let fetchRejection = null;
  let fromNetwork = null;
  const networkCalls = [];

  const location = {};
  const setUrl = (path, id) => {
    location.pathname = path;
    location.search = id ? '?v=' + id : '';
    location.href = 'https://www.youtube.com' + path + (id ? '?v=' + id : '');
  };
  setUrl(pathname, pathname === '/watch' ? videoId : '');

  // Chrome hands a same-window postMessage back to that window's own message
  // listeners, with source === window — measured on 151, where a listener that
  // answers by posting again is called for its own answer and the cascade only
  // stops when something refuses it. The mock does the same, with a depth cap
  // so a guard that goes missing ends the run instead of spinning it.
  const CASCADE_LIMIT = 50;
  let cascade = 0;
  const window = {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    postMessage(data) {
      posted.push(data);
      cascade += 1;
      try {
        if (cascade > CASCADE_LIMIT) {
          throw new Error(`the page is answering its own message — ${cascade} deep and still posting`);
        }
        for (const fn of (listeners['message'] || []).slice()) fn({ source: window, data });
      } finally {
        cascade -= 1;
      }
    },
    // What the bridge wraps. Every call is recorded as it arrived — the
    // receiver and the argument list — because the page's own requests go
    // through here, and the answer it gives is kept so a case can ask whether
    // the page was handed that same answer back.
    fetch(...args) {
      networkCalls.push({ thisArg: this, args });
      const body = fetchAnswer;
      fromNetwork = fetchRejection
        ? Promise.reject(fetchRejection)
        : Promise.resolve({ clone: () => ({ json: () => Promise.resolve(body) }), args });
      return fromNetwork;
    }
  };

  const sandbox = {
    window, location, console: { log: (...args) => logged.push(args) },
    URL, Promise, JSON, Object, Math, Date, String, Number, Boolean,
    document: {
      querySelector: (selector) => (selector.includes('ytd-watch-flexy') ? flexy : null),
      getElementById: (id) => (id === 'movie_player' ? moviePlayer : null)
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // document_start is early, but not always early enough: the page can have
  // assigned its response before the bridge is there to hook the assignment.
  if (preassigned) window.ytInitialPlayerResponse = preassigned;
  vm.runInContext(fs.readFileSync('./page-bridge.js', 'utf8'), sandbox, { filename: 'page-bridge.js' });

  const deliver = (data) => {
    for (const fn of listeners['message'] || []) fn({ source: window, data });
  };

  return {
    posted,
    logged,
    setUrl,
    // Method 1: the page assigns its player response.
    assign(playerResponse) { window.ytInitialPlayerResponse = playerResponse; },
    // Method 2: a player request answered mid-navigation. What the page is
    // handed back comes with it, beside the answer the network gave. The
    // request is passed on as the page made it — a URL, a URL and an init, or
    // a Request object.
    async fetchPlayer(playerResponse, ...args) {
      fetchAnswer = playerResponse;
      if (!args.length) args = ['https://www.youtube.com/youtubei/v1/player?key=x'];
      const returned = window.fetch(...args);
      // A wrapper that hands the page nothing is a case's answer to give, not
      // a crash in the harness reading it.
      if (returned && typeof returned.catch === 'function') await returned.catch(() => {});
      await tick();
      fetchRejection = null;
      return { returned, fromNetwork };
    },
    failNextFetch(error) { fetchRejection = error; },
    networkCalls,
    window,
    // Method 3 and the on-demand path: what content.js asks for.
    async request() { deliver({ type: '__yt_channel_volume_request__' }); await tick(); },
    async diagnose() { deliver({ type: '__yt_channel_volume_diag__' }); await tick(); },
    // A message that reached this window from somewhere else — another frame,
    // or the page's own script posting to it.
    async deliverAs(source, data) {
      for (const fn of (listeners['message'] || []).slice()) fn({ source, data });
      await tick();
    },
    setFlexy(playerResponse) { flexy = playerResponse ? { __data: { playerResponse } } : null; },
    setMoviePlayer(playerResponse) {
      moviePlayer = playerResponse ? { getPlayerResponse: () => playerResponse } : null;
    },
    last() { return posted[posted.length - 1]; }
  };
}

const playerResponse = (over = {}) => ({
  playerConfig: { audioConfig: { loudnessDb: over.loudnessDb ?? -7.5 } },
  videoDetails: {
    videoId: over.videoId ?? 'urlVideoIdA',
    channelId: over.channelId ?? 'UCbridge',
    author: over.author ?? 'Bridge Ch',
    isLiveContent: over.isLiveContent ?? false,
    isLive: over.isLive ?? false
  }
});

// ── Tests ────────────────────────────────────────────────────────────

async function runTests() {

  // ── P01: New tab with URL ──────────────────────────────────────────

  section('P01: New tab with URL');
  // Initial triggerApply was called during eval. Check state.
  await tick();
  assert(ytcv.state._lastVideoId === 'abc123', 'video ID captured');
  assert(ytcv.state._lastProcessedVideo === mockVideoEl, 'video element tracked');
  assert(ytcv.state.currentChannel.id === 'UCboot', 'channel detected on load');
  assert(ytcv.state.currentGain === 0.62,
    'the first apply waits for the legacy Auto gain to be folded in');
  assert(mockStorage['channelVolumes'].UCboot.gainVideo === 0.62,
    'the folded gain is what the channel entry now holds');
  assert(!('autoLoudnessFallback:UCboot:video' in mockStorage),
    'the legacy key is cleared during bootstrap');
  assert(mockStorage['unifiedGains'] === true, 'bootstrap marks the profile');

  // Back to an unsaved channel for the navigation cases below.
  mockDOMElements['canonical'] = null;
  mockStorage = {};
  ytcv._set('currentChannel', { id: '', name: '', url: '' });
  ytcv._set('currentGain', 1.0);
  await ytcv.triggerApply();
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

  // setTargetLufs answers from a .then, so it is one of the handlers that has
  // to keep the port open. No test drove it at all — the whole handler, its
  // save and its answer, was reached by nothing.
  // The gain overlay: five branches of updateGainOverlay that no case reached,
  // because the DOM mock could not hand it a volume area to draw into. Driven
  // through commitGain, which is the production path that redraws it — the
  // settings handler recomputes the gain before redrawing, so it says nothing
  // about the gain the overlay is given.
  section('Gain overlay: what it puts in the player, and takes back out');
  const overlayLoudness = ytcv.state.currentLoudnessDb;
  ytcv._set('currentLoudnessDb', null);
  const overlaySetting = (on) => {
    simulateStorageChange({
      autoLoudnessSettings: {
        newValue: { targetLufs: -18, displayUnit: '%', showGainOverlay: on }
      }
    });
    return tick();
  };
  let area = mockElement('div');
  mockDOMElements['volumeArea'] = area;
  await overlaySetting(true);

  ytcv.commitGain(1.5);
  assert(area.children.length === 1,
    `the overlay is put in the player (${area.children.length} children)`);
  assert(area.children[0].textContent === '150%',
    `and reads the gain as a percentage (${area.children[0].textContent})`);
  const firstOverlay = area.children[0];

  // Committing again changes the reading, not the number of overlays.
  ytcv.commitGain(1.25);
  assert(area.children.length === 1,
    `a second commit leaves one overlay (${area.children.length})`);
  assert(area.children[0] === firstOverlay, 'and it is the one already there');
  assert(firstOverlay.textContent === '125%', 'with the gain it now plays');

  // A navigation rebuilds the player: the volume area is a new node and the
  // overlay is in the old one, outside the document. One overlay exists, and
  // it is in the player the viewer is looking at — a second one abandoned in
  // the replaced area is as wrong as none in the new one.
  const replacedArea = area;
  area = mockElement('div');
  mockDOMElements['volumeArea'] = area;
  mockDetached.add(firstOverlay);
  ytcv.commitGain(1.4);
  assert(area.children.length === 1,
    `the rebuilt player gets an overlay (${area.children.length})`);
  assert(area.children[0].textContent === '140%', 'reading the current gain');
  assert(replacedArea.children.length === 0,
    `and none is left behind in the area it replaced (${replacedArea.children.length})`);

  // At passthrough the player carries nothing of ours.
  ytcv.commitGain(1.0);
  assert(area.children.length === 0,
    `a gain of exactly 1.0 shows nothing (${area.children.length})`);
  ytcv.commitGain(1.5);
  assert(area.children.length === 1, 'back at a raised gain it is there again');

  // And with the setting off, nothing at any gain.
  await overlaySetting(false);
  ytcv.commitGain(1.6);
  assert(area.children.length === 0,
    `turned off, it is taken back out (${area.children.length})`);

  // No volume area at all — the player YouTube has not built yet.
  mockDOMElements['volumeArea'] = null;
  await overlaySetting(true);
  ytcv.commitGain(1.7);
  assert(area.children.length === 0,
    'and with no player there is nothing to put it in');

  // Put the world back for the cases after this one.
  await overlaySetting(false);
  ytcv.commitGain(1.0);
  ytcv._set('currentLoudnessDb', overlayLoudness);
  mockDetached.clear();

  // ensureAudioChain: three things it does that no case had asked about, since
  // the mock forgot being asked and the context was never anything but running.
  section('Audio chain: what building it does');
  const chainLoudness = ytcv.state.currentLoudnessDb;
  ytcv._set('currentLoudnessDb', null);
  const videoBeforeChain = mockVideoEl;

  // A new element means a new chain: the source taken for the old one has to be
  // let go, or it stays connected to a player nobody is listening to.
  mockAudioAsks.disconnects = 0;
  mockVideoEl = { id: 'chain-second-video' };
  ytcv.commitGain(1.3);
  assert(mockAudioAsks.disconnects === 1,
    `the source taken for the previous element is disconnected (${mockAudioAsks.disconnects})`);
  assert(ytcv.state.gainNode.gain.value === 1.3,
    `and the gain reaches the new GainNode (${ytcv.state.gainNode.gain.value})`);

  // Building it again for the same element takes nothing new and lets nothing go.
  mockAudioAsks.disconnects = 0;
  ytcv.commitGain(1.35);
  assert(mockAudioAsks.disconnects === 0,
    `the chain already built is kept (${mockAudioAsks.disconnects} disconnects)`);
  assert(ytcv.state.gainNode.gain.value === 1.35, 'and the gain still reaches it');

  // A context the page has not let start yet is resumed; one already running
  // is not asked again.
  mockAudioAsks.resumes = 0;
  ytcv.state.audioCtx.state = 'suspended';
  mockVideoEl = { id: 'chain-third-video' };
  ytcv.commitGain(1.4);
  assert(mockAudioAsks.resumes === 1,
    `a suspended context is resumed while the chain is built (${mockAudioAsks.resumes})`);
  assert(ytcv.state.audioCtx.state === 'running', 'and it is running afterwards');
  mockAudioAsks.resumes = 0;
  mockVideoEl = { id: 'chain-fourth-video' };
  ytcv.commitGain(1.45);
  assert(mockAudioAsks.resumes === 0,
    `a running context is not asked again (${mockAudioAsks.resumes})`);

  mockVideoEl = videoBeforeChain;
  ytcv.commitGain(1.0);
  ytcv._set('currentLoudnessDb', chainLoudness);

  // applyLoudness turns three requests down before it does anything, and no
  // case had put any of the refusals to it beside the request it does honour.
  section('Apply to channel: what it declines, and where the gain it applies lands');
  const applyLoudnessBefore = ytcv.state.currentLoudnessDb;
  const applyChannelBefore = ytcv.state.currentChannel;
  const applyStorageBefore = mockStorage['channelVolumes'];
  // The Live gain is a sentinel: an apply on a Video is not allowed to move it.
  mockStorage['channelVolumes'] = {
    'UCapply': { name: 'Apply Ch', url: 'https://y/UCapply', gainVideo: 0.5, gainLive: 0.8 }
  };
  ytcv._set('currentChannel', { id: 'UCapply', name: 'Apply Ch', url: 'https://y/UCapply' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('targetLufs', -18);

  // Auto is doing the applying; the button must not write over it.
  ytcv._set('currentAutoApplyLoudnessVideo', true);
  ytcv._set('currentLoudnessDb', -6);
  const whileAuto = await simulateRuntimeMessage({ type: 'applyLoudness' });
  assert(whileAuto?.ok === false && whileAuto?.reason === 'auto apply enabled',
    `with Auto on it is declined — got ${JSON.stringify(whileAuto)}`);

  // Auto off, but nothing measured to apply.
  ytcv._set('currentAutoApplyLoudnessVideo', false);
  ytcv._set('currentLoudnessDb', null);
  const withoutLoudness = await simulateRuntimeMessage({ type: 'applyLoudness' });
  assert(withoutLoudness?.ok === false && withoutLoudness?.reason === 'no loudness data',
    `with nothing measured it is declined — got ${JSON.stringify(withoutLoudness)}`);

  // Measured, but the page has not said whose channel it is yet. Applying now
  // would move the level the viewer hears with nothing able to remember it.
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('currentChannel', { id: '', name: '', url: '' });
  const gainBeforeIdless = ytcv.state.currentGain;
  const withoutChannel = await simulateRuntimeMessage({ type: 'applyLoudness' });
  await tick();
  assert(withoutChannel?.ok === false && withoutChannel?.reason === 'no loudness data',
    `with no channel known it is declined — got ${JSON.stringify(withoutChannel)}`);
  assert(ytcv.state.currentGain === gainBeforeIdless,
    `and the gain that is playing is left alone (${ytcv.state.currentGain})`);
  assert(Object.keys(mockStorage['channelVolumes']).length === 1,
    'and no channel is written');

  // And with none of the three in the way it goes through. Without this the
  // refusals above would hold for a handler that declined everything.
  ytcv._set('currentChannel', { id: 'UCapply', name: 'Apply Ch', url: 'https://y/UCapply' });
  const applied = await simulateRuntimeMessage({ type: 'applyLoudness' });
  await tick();
  assert(applied?.ok === true, `otherwise it applies — got ${JSON.stringify(applied)}`);
  assert(Math.abs(applied.gain - ytcv.calcGainFromLoudness(-6)) < 0.001,
    'and answers with the gain it worked out');

  // Where it landed is the whole point of the button: this channel, the type
  // being watched, as a choice Auto is not to take back over.
  const appliedEntry = mockStorage['channelVolumes']['UCapply'];
  assert(Math.abs(appliedEntry.gainVideo - applied.gain) < 0.001,
    `the gain is saved as the Video gain of this channel (${appliedEntry.gainVideo})`);
  assert(appliedEntry.gainLive === 0.8,
    `and the Live gain it was not asked about is untouched (${appliedEntry.gainLive})`);
  assert(appliedEntry.name === 'Apply Ch' && appliedEntry.url === 'https://y/UCapply',
    'under the name and url of the channel being watched');
  assert(appliedEntry.autoApplyLoudnessVideo === false,
    'pinned as a manual choice, so an all-channel default cannot take it over');
  assert(Math.abs(ytcv.state.currentGain - applied.gain) < 0.001,
    `and it is the gain now playing (${ytcv.state.currentGain})`);

  mockStorage['channelVolumes'] = applyStorageBefore;
  ytcv._set('currentLoudnessDb', applyLoudnessBefore);
  ytcv._set('currentChannel', applyChannelBefore);

  section('Auto LUFS: the popup sets Target LUFS');
  ytcv._set('currentLoudnessDb', -6);
  const settingsBefore = mockStorage['autoLoudnessSettings'];
  const targetAnswer = await simulateRuntimeMessage({ type: 'setTargetLufs', value: -14 });
  await tick();
  assert(targetAnswer?.ok === true,
    `the popup is answered — got ${JSON.stringify(targetAnswer)}`);
  assert(mockStorage['autoLoudnessSettings']?.targetLufs === -14,
    'and the target it asked for is the one stored');
  assert(ytcv.state.targetLufs === -14, 'and the one the page is working from');
  // Without this the answer above could come from a handler that stored
  // nothing, since the value it was given is the value it was already at.
  assert(settingsBefore?.targetLufs !== -14,
    'the value asked for is not the one it already held');
  ytcv._set('currentLoudnessDb', null);

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
  // The apply waits for the legacy fold before it reads storage.
  await tick();
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
  // The apply waits for the legacy fold before it reads storage.
  await tick();
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

  section('Single writer: overlapping saves keep both channels');
  mockStorage['channelVolumes'] = {};
  const realGetForOverlap = chrome.storage.local.get;
  let releaseReads;
  const readsHeld = new Promise(resolve => { releaseReads = resolve; });
  chrome.storage.local.get = key => readsHeld.then(() => realGetForOverlap(key));
  const writeA = chrome.runtime.sendMessage({
    type: 'store:saveChannelGain',
    channelId: 'UCoverlapA', name: 'Overlap A', gain: 0.5, videoType: 'video', url: ''
  });
  const writeB = chrome.runtime.sendMessage({
    type: 'store:saveChannelGain',
    channelId: 'UCoverlapB', name: 'Overlap B', gain: 0.7, videoType: 'live', url: ''
  });
  await tick();
  releaseReads();
  const [replyA, replyB] = await Promise.all([writeA, writeB]);
  chrome.storage.local.get = realGetForOverlap;
  assert(replyA?.ok === true && replyB?.ok === true, 'both saves are accepted');
  assert(mockStorage['channelVolumes']['UCoverlapA']?.gainVideo === 0.5,
    'the first channel survives a save that overlapped it');
  assert(mockStorage['channelVolumes']['UCoverlapB']?.gainLive === 0.7,
    'the second channel survives too');

  section('Sync failure: a throwing apply answers every manual handler');
  mockStorage['channelVolumes'] = {
    'UCthrows': { name: 'Throws Ch', gainVideo: 0.5, autoApplyLoudnessVideo: false }
  };
  ytcv._set('currentChannel', { id: 'UCthrows', name: 'Throws Ch', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('targetLufs', -18);
  ytcv._set('currentAutoApplyLoudnessVideo', false);
  await ytcv.applyPreferredGain();
  const gainBeforeThrows = ytcv.state.currentGain;
  const throwingCtx = ytcv.state.audioCtx;
  const realCreateForThrows = throwingCtx.createMediaElementSource;
  throwingCtx.createMediaElementSource = () => {
    throw new Error('InvalidStateError: already connected');
  };
  const videoBeforeThrows = mockVideoEl;
  mockVideoEl = { id: 'owned-by-another-extension' };
  for (const message of [
    { type: 'applyLoudness' },
    { type: 'setGain', channelId: 'UCthrows', gain: 0.3 },
    { type: 'setGainLive', gain: 0.3 }
  ]) {
    const reply = await simulateRuntimeMessage(message);
    assert(reply?.ok === false, `${message.type} answers when the apply throws`);
  }
  throwingCtx.createMediaElementSource = realCreateForThrows;
  mockVideoEl = videoBeforeThrows;
  assert(mockStorage['channelVolumes']['UCthrows'].gainVideo === 0.5,
    'nothing was stored for a manual save whose apply threw');

  section('Sync failure: forceDetect answers when its apply throws');
  mockStorage['channelVolumes'] = {
    'UCdetect': { name: 'Detect Ch', autoApplyLoudnessVideo: true }
  };
  ytcv._set('currentChannel', { id: 'UCdetect', name: 'Detect Ch', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('targetLufs', -18);
  ytcv._set('currentAutoApplyLoudnessVideo', true);
  const detectCtx = ytcv.state.audioCtx;
  const realCreateForDetect = detectCtx.createMediaElementSource;
  detectCtx.createMediaElementSource = () => {
    throw new Error('InvalidStateError: already connected');
  };
  const videoBeforeDetect = mockVideoEl;
  mockVideoEl = { id: 'owned-during-detect' };
  const detectReply = await simulateRuntimeMessage({ type: 'forceDetect' });
  detectCtx.createMediaElementSource = realCreateForDetect;
  mockVideoEl = videoBeforeDetect;
  assert(detectReply !== undefined,
    'forceDetect answers instead of leaving the popup initializing');
  assert(detectReply?.ok === false, 'and it answers with the failure');
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('currentAutoApplyLoudnessVideo', false);

  section('Storage failure: playback and storage do not diverge');
  mockStorage['channelVolumes'] = {
    'UCagree': { name: 'Agree Ch', gainVideo: 0.5, autoApplyLoudnessVideo: false }
  };
  ytcv._set('currentChannel', { id: 'UCagree', name: 'Agree Ch', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('currentAutoApplyLoudnessVideo', false);
  await ytcv.applyPreferredGain();
  assert(ytcv.state.currentGain === 0.5, 'the saved gain is playing');
  const realSetForAgree = chrome.storage.local.set;
  chrome.storage.local.set = () => Promise.reject(new Error('storage write failed'));
  // The slider previews the new level through setGainLive before the change
  // event stores it, so "the level before this save" is already the preview.
  await simulateRuntimeMessage({ type: 'setGainLive', gain: 0.3 });
  assert(ytcv.state.currentGain === 0.3, 'the preview is playing');
  const rejectedSave = await simulateRuntimeMessage({
    type: 'setGain', channelId: 'UCagree', gain: 0.3
  });
  chrome.storage.local.set = realSetForAgree;
  assert(rejectedSave?.ok === false, 'the rejected save is reported');
  assert(ytcv.state.currentGain === 0.5,
    'playback returns to the level storage still holds');
  assert(ytcv.state.gainNode.gain.value === 0.5, 'the GainNode returns with it');
  assert(ytcv.getState().gain === 0.5,
    'the popup reads the level that is actually stored');
  assert(mockStorage['channelVolumes']['UCagree'].gainVideo === 0.5,
    'the stored gain is unchanged');

  section('Legacy fold: nothing resolves channel state until it has run');
  mockStorage = {
    autoLoudnessSettings: { targetLufs: -18, autoApplyLoudnessVideoDefault: true },
    channelVolumes: { 'UCpremigration': { name: 'Pre Ch', gainVideo: 0.5, url: '' } }
  };
  mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCpremigration' };
  setURL('/watch', 'PREMIG00001');
  ytcv._set('currentChannel', { id: 'UCpremigration', name: 'Pre Ch', url: '' });
  ytcv._set('currentLoudnessVideoId', 'PREMIG00001');
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('targetLufs', -18);
  ytcv._set('defaultAutoApplyLoudnessVideo', true);
  ytcv._set('currentGain', 0.5);
  // Storage still holds the pre-unification shape: a gain with no Auto flag,
  // which the current rule reads as "follows the all-channel default".
  // A flag left over from an earlier resolution must not let the bridge's
  // fast path store a gain before the fold either.
  ytcv._set('currentAutoApplyLoudnessVideo', true);
  let releaseFold;
  ytcv._set('storageSettled', false);
  ytcv._set('storageReady', new Promise(resolve => { releaseFold = resolve; }));
  const applyDuringFold = ytcv.applyPreferredGain();
  simulateBridgeMessage({
    videoId: 'PREMIG00001', loudnessDb: -6, isLiveContent: false,
    channelId: 'UCpremigration', author: 'Pre Ch'
  });
  await tick();
  await tick();
  await tick();
  assert(ytcv.state.currentGain === 0.5, 'no gain is applied before the fold has run');
  assert(mockStorage['channelVolumes']['UCpremigration'].gainVideo === 0.5,
    'no gain is stored before the fold has run');
  await chrome.runtime.sendMessage({ type: 'store:migrateLegacyGains' });
  releaseFold();
  ytcv._set('storageSettled', true);
  await applyDuringFold;
  await tick();
  assert(mockStorage['channelVolumes']['UCpremigration'].autoApplyLoudnessVideo === false,
    'the fold pins the saved gain as the migration intends');
  assert(mockStorage['channelVolumes']['UCpremigration'].gainVideo === 0.5,
    'the gain saved before Auto existed is still the stored one');
  assert(ytcv.state.currentGain === 0.5, 'and it is what plays');
  mockDOMElements['canonical'] = null;

  section('Legacy fold: an Auto gain is not stored until the fold has landed');
  mockStorage = {
    autoLoudnessSettings: { targetLufs: -18, autoApplyLoudnessVideoDefault: true },
    channelVolumes: {}
  };
  mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCunstored' };
  setURL('/watch', 'UNSTORED001');
  ytcv._set('currentChannel', { id: 'UCunstored', name: 'Unstored Ch', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('currentLoudnessVideoId', 'UNSTORED001');
  ytcv._set('targetLufs', -18);
  ytcv._set('defaultAutoApplyLoudnessVideo', true);
  ytcv._set('storageMigrated', false);
  const realSetForUnstored = chrome.storage.local.set;
  let unstoredFoldFailed = false;
  chrome.storage.local.set = obj => {
    if (!unstoredFoldFailed && 'unifiedGains' in obj) {
      unstoredFoldFailed = true;
      return Promise.reject(new Error('fold write failed'));
    }
    return realSetForUnstored(obj);
  };
  ytcv._set('_lastProcessedVideo', null);
  await ytcv.triggerApply();
  await tick();
  assert(Math.abs(ytcv.state.currentGain - expectedAutoGain) < 0.001,
    'the calculated gain still plays while the fold has not landed');
  assert(!('UCunstored' in mockStorage['channelVolumes']),
    'but it is not stored, because a flagless gain is what the fold reads as manual');
  // The bridge's fast path stores its own gain; it has to hold back too.
  assert(ytcv.state.currentAutoApplyLoudnessVideo === true,
    'the unsaved channel is on Auto through the all-channel default');
  simulateBridgeMessage({
    videoId: 'UNSTORED001', loudnessDb: -6, isLiveContent: false,
    channelId: 'UCunstored', author: 'Unstored Ch'
  });
  await tick();
  await tick();
  assert(!('UCunstored' in mockStorage['channelVolumes']),
    'the gain the bridge path calculates is not stored before the fold either');

  chrome.storage.local.set = realSetForUnstored;
  ytcv._set('_lastProcessedVideo', null);
  await ytcv.triggerApply();
  await tick();
  const unstored = mockStorage['channelVolumes']['UCunstored'];
  assert(Math.abs(unstored?.gainVideo - expectedAutoGain) < 0.001,
    'once the fold lands the Auto gain is stored');
  assert(!('autoApplyLoudnessVideo' in unstored),
    'and it is not pinned, so the channel keeps following the all-channel default');
  assert(ytcv.state.currentAutoApplyLoudnessVideo === true,
    'the channel is still on Auto after the fold');
  mockDOMElements['canonical'] = null;

  section('Legacy fold: clearing leftovers is not part of the move');
  mockStorage = {
    autoLoudnessSettings: { targetLufs: -18, autoApplyLoudnessVideoDefault: true },
    channelVolumes: { 'UCswept': { name: 'Swept Ch', gainVideo: 0.5, url: '' } },
    'autoLoudnessFallback:UCstale:video': 0.9
  };
  mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCswept' };
  setURL('/watch', 'SWEPT000001');
  ytcv._set('currentChannel', { id: 'UCswept', name: 'Swept Ch', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('currentLoudnessVideoId', 'SWEPT000001');
  ytcv._set('storageMigrated', false);
  const realRemoveForSweep = chrome.storage.local.remove;
  chrome.storage.local.remove = () => Promise.reject(new Error('remove failed'));
  ytcv._set('_lastProcessedVideo', null);
  await ytcv.triggerApply();
  await tick();
  chrome.storage.local.remove = realRemoveForSweep;
  assert(mockStorage['unifiedGains'] === true, 'the gains are unified and marked');
  assert(ytcv.state.storageMigrated === true,
    'a failed sweep does not send the profile back to the old rule');
  assert('autoLoudnessFallback:UCstale:video' in mockStorage,
    'the leftover key is still there, waiting for a later sweep');
  await chrome.runtime.sendMessage({ type: 'store:migrateLegacyGains' });
  assert(!('autoLoudnessFallback:UCstale:video' in mockStorage),
    'the next run sweeps it');
  mockDOMElements['canonical'] = null;

  section('Legacy fold: another tab finishing it is adopted here');
  mockStorage = {
    autoLoudnessSettings: { targetLufs: -18, autoApplyLoudnessVideoDefault: true },
    channelVolumes: { 'UCshared': { name: 'Shared Ch', gainVideo: 0.5, url: '' } }
  };
  ytcv._set('currentChannel', { id: 'UCshared', name: 'Shared Ch', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('targetLufs', -18);
  ytcv._set('defaultAutoApplyLoudnessVideo', true);
  ytcv._set('storageMigrated', false);
  ytcv._set('storageSettled', true);
  ytcv._set('currentGain', 0.5);
  await ytcv.applyPreferredGain();
  assert(ytcv.state.currentAutoApplyLoudnessVideo === false,
    'this tab still reads the saved gain as Auto off');

  // The other tab folds the profile and stores its Auto gain in one write.
  const foldedEntry = { name: 'Shared Ch', gainVideo: expectedAutoGain, url: '' };
  mockStorage['unifiedGains'] = true;
  mockStorage['channelVolumes'] = { 'UCshared': foldedEntry };
  simulateStorageChange({
    unifiedGains: { newValue: true },
    channelVolumes: {
      oldValue: { 'UCshared': { name: 'Shared Ch', gainVideo: 0.5, url: '' } },
      newValue: { 'UCshared': foldedEntry }
    }
  });
  await tick();
  assert(ytcv.state.storageMigrated === true,
    'the mark another tab stored is adopted here');
  assert(ytcv.state.currentAutoApplyLoudnessVideo === true,
    'and the same event re-resolves the channel under the current rule');
  assert(Math.abs(ytcv.state.currentGain - expectedAutoGain) < 0.001,
    'the gain that tab stored is what plays');

  // A manual save from this tab must not pin a channel that is on Auto.
  ytcv._set('currentLoudnessDb', null);
  await simulateRuntimeMessage({ type: 'setGain', channelId: 'UCshared', gain: 0.7 });
  assert(mockStorage['channelVolumes']['UCshared'].autoApplyLoudnessVideo === true,
    'a save made after adopting the mark records Auto as on, not off');

  section('Legacy fold: the mark alone re-resolves this tab');
  mockStorage = {
    autoLoudnessSettings: { targetLufs: -18, autoApplyLoudnessVideoDefault: true },
    channelVolumes: { 'UCmarkonly': { name: 'Mark Only', gainVideo: 0.5, url: '' } }
  };
  ytcv._set('currentChannel', { id: 'UCmarkonly', name: 'Mark Only', url: '' });
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('storageMigrated', false);
  ytcv._set('currentGain', 0.5);
  await ytcv.applyPreferredGain();
  assert(ytcv.state.currentGain === 0.5, 'the saved gain is playing before the mark');
  mockStorage['unifiedGains'] = true;
  simulateStorageChange({ unifiedGains: { newValue: true } });
  await tick();
  assert(ytcv.state.storageMigrated === true, 'the mark is adopted');
  assert(Math.abs(ytcv.state.currentGain - expectedAutoGain) < 0.001,
    'the channel is re-resolved even when only the mark changed');

  section('Legacy fold: the apply mutex covers the wait for it');
  ytcv._set('storageMigrated', false);
  ytcv._set('_lastProcessedVideo', null);
  const realGetForMutex = chrome.storage.local.get;
  let settingsReads = 0;
  chrome.storage.local.get = key => {
    if (key === 'autoLoudnessSettings') settingsReads++;
    return realGetForMutex(key);
  };
  await Promise.all([ytcv.triggerApply(), ytcv.triggerApply()]);
  chrome.storage.local.get = realGetForMutex;
  assert(settingsReads === 1,
    'the second call is turned away instead of running a second apply');

  section('Legacy fold: a failed fold keeps the old rule instead of Auto');
  mockStorage = {
    autoLoudnessSettings: { targetLufs: -18, autoApplyLoudnessVideoDefault: true },
    channelVolumes: { 'UCfoldfail': { name: 'Fold Fail', gainVideo: 0.5, url: '' } }
  };
  mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCfoldfail' };
  setURL('/watch', 'FOLDFAIL001');
  ytcv._set('currentChannel', { id: 'UCfoldfail', name: 'Fold Fail', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('currentLoudnessVideoId', 'FOLDFAIL001');
  ytcv._set('targetLufs', -18);
  ytcv._set('defaultAutoApplyLoudnessVideo', true);
  ytcv._set('currentGain', 0.5);
  ytcv._set('storageMigrated', false);
  const realSetForFold = chrome.storage.local.set;
  let foldWriteFailed = false;
  chrome.storage.local.set = obj => {
    if (!foldWriteFailed && 'unifiedGains' in obj) {
      foldWriteFailed = true;
      return Promise.reject(new Error('fold write failed'));
    }
    return realSetForFold(obj);
  };
  ytcv._set('_lastProcessedVideo', null);
  await ytcv.triggerApply();
  await tick();
  assert(foldWriteFailed === true, 'the fold write was the one that failed');
  assert(!('unifiedGains' in mockStorage), 'a failed fold leaves the profile unmarked');
  assert(mockStorage['channelVolumes']['UCfoldfail'].gainVideo === 0.5,
    'the gain saved before Auto existed is not overwritten by a calculated one');
  assert(ytcv.state.currentAutoApplyLoudnessVideo === false,
    'an unfolded profile still reads a saved gain as Auto off');
  assert(ytcv.state.currentGain === 0.5, 'and plays the gain the user saved');

  // The next apply retries the fold, which now succeeds.
  chrome.storage.local.set = realSetForFold;
  ytcv._set('_lastProcessedVideo', null);
  await ytcv.triggerApply();
  await tick();
  assert(mockStorage['unifiedGains'] === true, 'the retry marks the profile');
  assert(mockStorage['channelVolumes']['UCfoldfail'].autoApplyLoudnessVideo === false,
    'the retry records the pin the old rule stood for');
  assert(mockStorage['channelVolumes']['UCfoldfail'].gainVideo === 0.5,
    'and the saved gain is still the stored one');
  mockDOMElements['canonical'] = null;

  section('Storage failure: a rejected write is answered, not dropped');
  mockStorage['channelVolumes'] = { 'UCwritefail': { name: 'Write Fail', gainVideo: 0.5 } };
  ytcv._set('currentChannel', { id: 'UCwritefail', name: 'Write Fail', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('currentAutoApplyLoudnessVideo', false);
  const storageSetBeforeFailure = chrome.storage.local.set;
  chrome.storage.local.set = () => Promise.reject(new Error('storage write failed'));
  const failedGain = await simulateRuntimeMessage({
    type: 'setGain', channelId: 'UCwritefail', gain: 0.3
  });
  assert(failedGain?.ok === false, 'a rejected manual save answers the popup instead of hanging');
  const failedToggle = await simulateRuntimeMessage({
    type: 'setAutoApplyLoudness', channelId: 'UCwritefail', videoType: 'video', enabled: true
  });
  assert(failedToggle?.ok === false, 'a rejected Auto toggle answers the popup instead of hanging');
  const failedDelete = await simulateRuntimeMessage({
    type: 'clearChannel', channelId: 'UCwritefail'
  });
  assert(failedDelete?.ok === false, 'a rejected delete answers the popup instead of hanging');
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('targetLufs', -18);
  ytcv._set('currentAutoApplyLoudnessVideo', false);
  const failedApply = await simulateRuntimeMessage({ type: 'applyLoudness' });
  assert(failedApply?.ok === false,
    'a rejected "apply to channel" answers the popup instead of hanging');
  ytcv._set('currentLoudnessDb', null);

  // forceDetect answers from applyPreferredGain, so an Auto write that fails
  // must not reject out of it.
  ytcv._set('currentAutoApplyLoudnessVideo', true);
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('targetLufs', -18);
  let applyRejected = false;
  await ytcv.applyPreferredGain().catch(() => { applyRejected = true; });
  assert(applyRejected === false, 'a rejected Auto gain write does not reject the apply');
  assert(Math.abs(ytcv.state.currentGain - expectedAutoGain) < 0.001,
    'the calculated gain still reaches the GainNode when the write fails');
  chrome.storage.local.set = storageSetBeforeFailure;
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('currentAutoApplyLoudnessVideo', false);

  // A throw from the apply the handler runs after the write is the same
  // problem as a rejected write: the popup is left waiting.
  // A fresh element forces the chain to be rebuilt, which is where another
  // extension owning the <video> surfaces.
  const contestedCtx = ytcv.state.audioCtx;
  const realCreateSource = contestedCtx.createMediaElementSource;
  contestedCtx.createMediaElementSource = () => {
    throw new Error('InvalidStateError: already connected');
  };
  const videoBeforeThrow = mockVideoEl;
  mockVideoEl = { id: 'contested-video' };
  ytcv._set('currentLoudnessDb', -6);
  const failedApplyToggle = await simulateRuntimeMessage({
    type: 'setAutoApplyLoudness', channelId: 'UCwritefail', videoType: 'video', enabled: true
  });
  assert(failedApplyToggle?.ok === false,
    'a throw from the apply after the write still answers the popup');
  contestedCtx.createMediaElementSource = realCreateSource;
  mockVideoEl = videoBeforeThrow;
  ytcv._set('currentLoudnessDb', null);
  await simulateRuntimeMessage({
    type: 'setAutoApplyLoudness', channelId: 'UCwritefail', videoType: 'video', enabled: false
  });

  // One rejection must not poison the queue every later save runs through.
  const recovered = await simulateRuntimeMessage({
    type: 'setGain', channelId: 'UCwritefail', gain: 0.44
  });
  assert(recovered?.ok === true, 'the next save succeeds after a rejected write');
  assert(mockStorage['channelVolumes']['UCwritefail'].gainVideo === 0.44,
    'the write queue survives a rejection');

  section('Auto LUFS defaults: an inherited Auto stays on after a manual save');
  mockStorage['channelVolumes'] = { 'UCinherit': { name: 'Inherit Ch' } };
  ytcv._set('currentChannel', { id: 'UCinherit', name: 'Inherit Ch', url: '' });
  ytcv._set('currentVideoType', 'live');
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('defaultAutoApplyLoudnessLive', true);
  await ytcv.applyPreferredGain();
  assert(ytcv.state.currentAutoApplyLoudnessLive === true, 'the channel inherits Auto ON');
  // Auto is on but this live stream has no LUFS, so the slider is live and the
  // user adjusts the level Auto falls back to.
  await simulateRuntimeMessage({ type: 'setGain', channelId: 'UCinherit', gain: 0.55 });
  assert(mockStorage['channelVolumes']['UCinherit'].autoApplyLoudnessLive === true,
    'adjusting the fallback level records the Auto state it was made under');
  ytcv._set('defaultAutoApplyLoudnessLive', false);
  await ytcv.applyPreferredGain();
  assert(ytcv.state.currentAutoApplyLoudnessLive === true,
    'the pinned ON survives the all-channel default being switched off');
  assert(ytcv.state.currentGain === 0.55, 'the adjusted fallback level is what plays');

  section('Delete: an Auto channel comes back while the all-channel default is ON');
  mockStorage['channelVolumes'] = { 'UCdeleted': { name: 'Deleted Ch', gainVideo: 0.5 } };
  ytcv._set('currentChannel', { id: 'UCdeleted', name: 'Deleted Ch', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('targetLufs', -18);
  ytcv._set('defaultAutoApplyLoudnessVideo', true);
  const deleteResponse = await simulateRuntimeMessage({
    type: 'clearChannel', channelId: 'UCdeleted'
  });
  assert(deleteResponse?.ok === true, 'the channel is deleted');
  assert(!('UCdeleted' in mockStorage['channelVolumes']), 'the entry is gone');
  assert(ytcv.state.currentGain === 1.0, 'playback returns to passthrough');
  // The all-channel default still covers this channel, so the next apply
  // manages it again and stores the gain it calculates.
  await ytcv.applyPreferredGain();
  assert(ytcv.state.currentAutoApplyLoudnessVideo === true,
    'a deleted channel inherits the all-channel default again');
  assert(Math.abs(mockStorage['channelVolumes']['UCdeleted']?.gainVideo - expectedAutoGain) < 0.001,
    'the entry is recreated with the gain Auto calculates');
  ytcv._set('defaultAutoApplyLoudnessVideo', false);
  ytcv._set('currentLoudnessDb', null);

  section('Upgrade: a save made while the fold is in flight is not rolled back');
  mockStorage = {
    autoLoudnessSettings: { targetLufs: -18 },
    channelVolumes: { 'UCinflight': { name: 'In Flight', gainVideo: 0.3 } }
  };
  const folding = migrateLegacyAutoGains();
  const savingDuringFold = ytcv.saveChannelGain(
    'UCinflight', 'In Flight', 0.75, 'video', '', false
  );
  await Promise.all([folding, savingDuringFold]);
  assert(mockStorage['channelVolumes']['UCinflight'].gainVideo === 0.75,
    'the migration folds onto what storage holds now, not onto its own snapshot');
  assert(mockStorage['channelVolumes']['UCinflight'].autoApplyLoudnessVideo === false,
    'the concurrent save is still pinned against the all-channel default');

  // The learned value is older than anything written while the fold was
  // reading it, so it must not be folded over the newer gain.
  mockStorage = {
    autoLoudnessSettings: { targetLufs: -18 },
    channelVolumes: {
      'UCnewer': { name: 'Newer', autoApplyLoudnessLive: true, gainLive: 0.4 }
    },
    'autoLoudnessFallback:UCnewer:live': 0.8
  };
  const foldingLearned = migrateLegacyAutoGains();
  const newerSave = ytcv.saveChannelGain('UCnewer', 'Newer', 0.9, 'live', '', true);
  await Promise.all([foldingLearned, newerSave]);
  assert(mockStorage['channelVolumes']['UCnewer'].gainLive === 0.9,
    'a gain written during the fold is not overwritten by the learned value');

  // Auto saves a gain with no flag — the same shape the fold reads as manual.
  // A channel that only appears while the fold is in flight is Auto's.
  mockStorage = {
    autoLoudnessSettings: { targetLufs: -18, autoApplyLoudnessVideoDefault: true },
    channelVolumes: {}
  };
  const foldingAgain = migrateLegacyAutoGains();
  const autoSaveDuringFold = ytcv.saveChannelGain('UCarrived', 'Arrived', 0.42, 'video', '');
  await Promise.all([foldingAgain, autoSaveDuringFold]);
  const arrived = mockStorage['channelVolumes']['UCarrived'];
  assert(arrived.gainVideo === 0.42, 'the gain Auto stored during the fold is kept');
  assert(!('autoApplyLoudnessVideo' in arrived),
    'a gain that arrived after the snapshot is not read as a manual save');
  assert(resolveAutoApplySetting(arrived, 'video', true) === true,
    'that channel keeps following the all-channel default');

  section('Upgrade: a gain saved before Auto existed survives the all-channel default');
  // Released 1.0.4 storage: a saved gain, no Auto flag, no learned Auto key.
  mockStorage = {
    autoLoudnessSettings: { targetLufs: -18, autoApplyLoudnessVideoDefault: true },
    channelVolumes: { 'UCreleased': { name: 'Released Ch', gainVideo: 0.5, url: '' } }
  };
  await migrateLegacyAutoGains();
  setURL('/watch', 'UPGRADE0001');
  ytcv._set('currentChannel', { id: 'UCreleased', name: 'Released Ch', url: '' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('currentLoudnessVideoId', 'UPGRADE0001');
  ytcv._set('targetLufs', -18);
  ytcv._set('defaultAutoApplyLoudnessVideo', true);
  ytcv._set('defaultAutoApplyLoudnessLive', false);
  await ytcv.applyPreferredGain();
  assert(ytcv.state.currentAutoApplyLoudnessVideo === false,
    'a pre-Auto saved gain does not inherit the all-channel default');
  assert(ytcv.state.currentGain === 0.5, 'the saved gain is what plays');
  assert(mockStorage['channelVolumes']['UCreleased'].gainVideo === 0.5,
    'the saved gain is not overwritten by a calculated one');
  delete mockStorage['autoLoudnessSettings'];
  ytcv._set('defaultAutoApplyLoudnessVideo', false);
  ytcv._set('currentLoudnessDb', null);

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

  section('Data: backfill and the Auto gain from the same message both land');
  mockStorage['channelVolumes'] = {
    '@auto_handle': { name: 'Auto Handle Ch', gainVideo: 0.6 }
  };
  setURL('/watch', 'BACKFILL001');
  ytcv._set('currentChannel', { id: '', name: '', url: '' });
  ytcv._set('currentChannelVideoId', '');
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('currentLoudnessVideoId', '');
  ytcv._set('currentVideoType', 'video');
  ytcv._set('targetLufs', -18);
  ytcv._set('defaultAutoApplyLoudnessVideo', true);
  simulateBridgeMessage({
    videoId: 'BACKFILL001', loudnessDb: -6, isLiveContent: false,
    channelId: 'UCauto_adopted', author: 'Auto Handle Ch'
  });
  await tick();
  await tick();
  await tick();
  const adopted = mockStorage['channelVolumes'];
  assert(!('@auto_handle' in adopted),
    'the orphan is adopted even though Auto writes the same entry');
  assert(Math.abs(adopted['UCauto_adopted']?.gainVideo - expectedAutoGain) < 0.001,
    'the Auto gain survives the adoption');
  assert(adopted['UCauto_adopted']?.url === 'https://www.youtube.com/channel/UCauto_adopted',
    'the adopted entry keeps the channel URL the backfill wrote');
  ytcv._set('defaultAutoApplyLoudnessVideo', false);
  ytcv._set('currentLoudnessDb', null);

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

  // ── The bridge message: which video it is for, and who names the channel ──

  // isBridgeMessageForCurrentVideo compares the message's video id with the one
  // in the URL, and no case had been on a `/live/` URL at all — the comparison
  // there was reached by nothing.
  mockStorage['channelVolumes'] = {};
  ytcv._set('storageMigrated', true);
  mockDOMElements['canonical'] = null;
  mockDOMElements['channelName'] = null;
  // A page whose URL names no video — the home page, a channel page — still
  // plays one, and there is nothing there to compare the answer against.
  section('Bridge message: a URL naming no video takes the answer as it comes');
  ytcv._set('currentChannel', { id: '', name: '', url: '' });
  ytcv._set('currentChannelVideoId', '');
  ytcv._set('currentLoudnessVideoId', '');
  ytcv._set('currentLoudnessDb', null);
  setURL('/', null);
  simulateBridgeMessage({
    loudnessDb: -8, isLiveContent: false, videoId: 'homePreview', channelId: 'UChome', author: 'Home Ch'
  });
  await tick();
  assert(ytcv.state.currentLoudnessDb === -8,
    `the answer is taken where the URL names no video (${ytcv.state.currentLoudnessDb})`);
  assert(ytcv.state.currentChannel.id === 'UChome', 'and so is the channel it names');

  section('Bridge message: a video id in the path is compared');
  ytcv._set('currentChannel', { id: '', name: '', url: '' });
  ytcv._set('currentChannelVideoId', '');
  ytcv._set('currentLoudnessVideoId', '');
  ytcv._set('currentLoudnessDb', null);
  setURL('/live/aBcDeFgHiJk', null);
  simulateBridgeMessage({
    loudnessDb: -9, isLiveContent: true, isLiveNow: true,
    videoId: 'zZzZzZzZzZz', channelId: 'UCstale', author: 'Stale Ch'
  });
  await tick();
  assert(ytcv.state.currentLoudnessDb === null,
    `an answer queued for another video is dropped (${ytcv.state.currentLoudnessDb})`);
  assert(ytcv.state.currentChannel.id === '', 'and it does not name the channel either');
  simulateBridgeMessage({
    loudnessDb: -9, isLiveContent: true, isLiveNow: true,
    videoId: 'aBcDeFgHiJk', channelId: 'UCfresh', author: 'Fresh Ch'
  });
  await tick();
  assert(ytcv.state.currentLoudnessDb === -9, 'the answer for the one being watched is taken');
  assert(ytcv.state.currentChannel.id === 'UCfresh', 'and it names the channel');

  // The name of a channel already identified has three sources with an order:
  // the bridge author is the player's own answer for this video, the DOM lags
  // an SPA navigation, and what is held is either a real name or the channel id
  // standing in for one. Only the stub case had a test.
  section('Bridge message: the author outranks the DOM for a channel already known');
  setURL('/watch', 'nameVid1');
  ytcv._set('currentChannelVideoId', '');
  ytcv._set('currentLoudnessVideoId', '');
  ytcv._set('currentChannel', { id: 'UCnamed', name: 'Saved Name', url: 'https://y/UCnamed' });
  mockDOMElements['channelName'] = { textContent: 'DOM Name' };
  simulateBridgeMessage({
    loudnessDb: -5, isLiveContent: false, videoId: 'nameVid1',
    channelId: 'UCnamed', author: 'Bridge Name'
  });
  await tick();
  assert(ytcv.state.currentChannel.name === 'Bridge Name',
    `the author names the channel (${ytcv.state.currentChannel.name})`);

  section('Bridge message: with no author, a name already held is kept over the DOM');
  ytcv._set('currentChannelVideoId', '');
  ytcv._set('currentLoudnessVideoId', '');
  ytcv._set('currentChannel', { id: 'UCnamed', name: 'Saved Name', url: 'https://y/UCnamed' });
  simulateBridgeMessage({
    loudnessDb: -5, isLiveContent: false, videoId: 'nameVid1', channelId: 'UCnamed'
  });
  await tick();
  assert(ytcv.state.currentChannel.name === 'Saved Name',
    `the DOM does not overwrite a real name (${ytcv.state.currentChannel.name})`);

  section('Bridge message: with no author, the DOM fills in for the channel id');
  ytcv._set('currentChannelVideoId', '');
  ytcv._set('currentLoudnessVideoId', '');
  ytcv._set('currentChannel', { id: 'UCnamed', name: 'UCnamed', url: 'https://y/UCnamed' });
  simulateBridgeMessage({
    loudnessDb: -5, isLiveContent: false, videoId: 'nameVid1', channelId: 'UCnamed'
  });
  await tick();
  assert(ytcv.state.currentChannel.name === 'DOM Name',
    `the id standing in for a name is replaced (${ytcv.state.currentChannel.name})`);
  mockDOMElements['channelName'] = null;

  // ── What the popup waits for, and what the observer refuses to act on ──

  // The retry exists because the bridge does not always answer the first ask.
  // Nothing had driven a slow answer: the loudness was always there before the
  // popup asked, so the interval that gives up and the one that asks again were
  // the same to every case. The answer is delivered on the second ask here, so
  // a first-timeout resolve cannot reach it.
  section('Popup open: an answer that arrives on the second ask still reaches the popup');
  setURL('/watch', 'slowVid1');
  ytcv._set('currentChannel', { id: 'UCslow', name: 'Slow Ch', url: '' });
  ytcv._set('currentChannelVideoId', '');
  ytcv._set('currentLoudnessVideoId', '');
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('_lastVideoId', 'slowVid1');
  ytcv._set('_lastProcessedVideo', mockVideoEl);
  ytcv._set('currentAutoApplyLoudnessVideo', false);
  ytcv._set('currentVideoType', 'video');
  mockStorage['channelVolumes'] = { UCslow: { name: 'Slow Ch', gainVideo: 0.5 } };
  let bridgeAsks = 0;
  mockPostMessageHandler = (data) => {
    if (data?.type !== '__yt_channel_volume_request__') return;
    bridgeAsks++;
    if (bridgeAsks === 2) {
      simulateBridgeMessage({
        loudnessDb: -11, isLiveContent: false, videoId: 'slowVid1', channelId: 'UCslow', author: 'Slow Ch'
      });
    }
  };
  const slowAnswer = await simulateRuntimeMessage({ type: 'forceDetect' });
  mockPostMessageHandler = null;
  assert(bridgeAsks >= 2, `the bridge is asked again when the first ask goes unanswered (${bridgeAsks})`);
  assert(slowAnswer?.loudnessDb === -11,
    `and the popup is answered with what arrived (${JSON.stringify(slowAnswer?.loudnessDb)})`);

  // Auto applies the gain itself and says so; the caller runs the saved-gain
  // path only when it did not. Nothing had asked what saying so is worth, and
  // the answer is invisible in the gain — both paths land on the same number.
  // It is visible in the writing: the channel is written once per message.
  section('Auto LUFS: a message Auto has answered is not applied a second time');
  mockStorage['channelVolumes'] = {
    UCwrites: { name: 'Writes Ch', gainVideo: 0.5, autoApplyLoudnessVideo: true }
  };
  setURL('/watch', 'writeVid1');
  ytcv._set('currentChannel', { id: 'UCwrites', name: 'Writes Ch', url: '' });
  ytcv._set('currentChannelVideoId', 'writeVid1');
  ytcv._set('currentLoudnessVideoId', '');
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentAutoApplyLoudnessVideo', true);
  ytcv._set('storageSettled', true);
  ytcv._set('storageMigrated', true);
  ytcv._set('targetLufs', -18);
  mockSentMessages.length = 0;
  simulateBridgeMessage({
    loudnessDb: -6, isLiveContent: false, videoId: 'writeVid1', channelId: 'UCwrites', author: 'Writes Ch'
  });
  await tick();
  await tick();
  const writesForChannel = mockSentMessages.filter(m => m?.type === 'store:saveChannelGain');
  assert(Math.abs(ytcv.state.currentGain - ytcv.calcGainFromLoudness(-6)) < 0.001,
    `Auto applies the gain (${ytcv.state.currentGain})`);
  assert(writesForChannel.length === 1,
    `and the channel is written once for the message (${writesForChannel.length})`);

  // The observer fires on every DOM change YouTube makes, which on a busy page
  // is constantly. Its two triggers are guarded against the states that look
  // like a change and are not, and no case had put either state to it.
  section('Observer: the first video seen is not a video that changed');
  setURL('/watch', 'obsVid1');
  mockVideoEl = { id: 'observer-first-video' };
  ytcv._set('_lastProcessedVideo', null);
  ytcv._set('_lastVideoId', 'obsVid1');
  ytcv._set('currentLoudnessVideoId', '');
  ytcv._set('currentLoudnessDb', -3);
  ytcv._set('_applyRunning', false);
  fireObserver();
  await tick();
  assert(ytcv.state.currentLoudnessDb === -3,
    `nothing is applied for a video nothing has processed yet (${ytcv.state.currentLoudnessDb})`);
  assert(ytcv.state._lastProcessedVideo === null, 'and the video is still unprocessed');

  section('Observer: a URL with no video id is not a video that changed');
  mockLocation.pathname = '/watch';
  mockLocation.search = '';
  mockLocation.href = 'https://www.youtube.com/watch';
  ytcv._set('_lastProcessedVideo', mockVideoEl);
  ytcv._set('_lastVideoId', 'obsVid1');
  ytcv._set('currentLoudnessDb', -3);
  ytcv._set('_applyRunning', false);
  fireObserver();
  await tick();
  assert(ytcv.state._lastVideoId === 'obsVid1',
    `an empty video id does not count as a change (${ytcv.state._lastVideoId})`);
  assert(ytcv.state.currentLoudnessDb === -3, 'and nothing is applied');

  // The observer's own watch-page guard is not what keeps an apply off a page
  // that is not a watch page — triggerApply refuses on its own, which is what
  // this asks. The guard is there so the observer does no work at all on the
  // pages that mutate the most.
  section('Apply: a page that is not a watch page is refused');
  setURL('/feed/subscriptions', null);
  ytcv._set('_lastProcessedVideo', null);
  ytcv._set('_lastVideoId', 'obsVid1');
  ytcv._set('currentLoudnessDb', -3);
  ytcv._set('_applyRunning', false);
  await ytcv.triggerApply();
  assert(ytcv.state._lastVideoId === 'obsVid1',
    `no apply runs off a watch page (${ytcv.state._lastVideoId})`);
  assert(ytcv.state._lastProcessedVideo === null, 'and no video is taken up');
  setURL('/watch', 'obsVid1');

  // ── Going quiet after a reload ──────────────────────────────────────

  // reportFailure keeps the console clear after an extension reload, which is
  // the one cause of these failures that is not worth reporting. The state it
  // reads is the state at the failure, not at the request: a save already in
  // flight is what fails on the reload. Nothing had made a failure land on an
  // invalidated context, so the check had no case either way.
  section('Extension reload: the failure it causes is not reported');
  mockStorage['channelVolumes'] = {
    UCreload: { name: 'Reload Ch', gainVideo: 0.5, autoApplyLoudnessVideo: true }
  };
  setURL('/watch', 'reloadVid1');
  ytcv._set('currentChannel', { id: 'UCreload', name: 'Reload Ch', url: 'https://y/UCreload' });
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentAutoApplyLoudnessVideo', true);
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('_lastVideoId', 'reloadVid1');
  ytcv._set('storageMigrated', true);
  ytcv._set('storageReady', Promise.resolve());
  const realConsoleError = console.error;
  const realSet = chrome.storage.local.set;
  let reported = [];
  console.error = (...args) => { reported.push(args[0]); };
  chrome.storage.local.set = () => Promise.reject(new Error('storage write failed'));
  await ytcv.applyPreferredGain();
  await tick();
  console.error = realConsoleError;
  // The service worker logs its own side of the same failure; content.js's is
  // the one this is about.
  const fromContent = () => reported.filter(m => String(m).includes('auto gain not stored'));
  assert(fromContent().length === 1,
    `a failure on a live context is reported (${JSON.stringify(reported)})`);

  const idBeforeReload = chrome.runtime.id;
  reported = [];
  console.error = (...args) => { reported.push(args[0]); };
  chrome.storage.local.set = () => {
    // The reload is what makes the write fail, so it is gone by the rejection.
    chrome.runtime.id = undefined;
    return Promise.reject(new Error('storage write failed'));
  };
  await ytcv.applyPreferredGain();
  await tick();
  console.error = realConsoleError;
  chrome.runtime.id = idBeforeReload;
  chrome.storage.local.set = realSet;
  assert(fromContent().length === 0,
    `the same failure after a reload is not (${JSON.stringify(reported)})`);

  // Every write goes through one function, and after a reload that function is
  // the last thing standing between the page and a chrome.runtime call that
  // throws. Nothing had asked it to refuse: the case below is also what the
  // startup fold's own context check leans on, since the fold does its work
  // through here.
  section('Extension reload: no write is attempted');
  mockStorage['channelVolumes'] = { UCquiet: { name: 'Quiet Ch', gainVideo: 0.5 } };
  const idBeforeQuiet = chrome.runtime.id;
  chrome.runtime.id = undefined;
  mockSentMessages.length = 0;
  await ytcv.saveChannelGain('UCquiet', 'Quiet Ch', 0.9, 'video', '');
  await ytcv.saveChannelAutoApply('UCquiet', 'Quiet Ch', true, 'video', '');
  await tick();
  chrome.runtime.id = idBeforeQuiet;
  assert(mockSentMessages.filter(m => String(m?.type).startsWith('store:')).length === 0,
    `nothing is sent to the worker after a reload (${JSON.stringify(mockSentMessages.map(m => m?.type))})`);
  assert(mockStorage['channelVolumes']['UCquiet'].gainVideo === 0.5,
    `and the channel keeps the gain it had (${mockStorage['channelVolumes']['UCquiet'].gainVideo})`);

  // The same function refuses a write with no channel to write it under. The
  // key it would use is the empty string, which is a channel the extension can
  // read back and show.
  section('A gain with no channel is not written');
  mockSentMessages.length = 0;
  await ytcv.saveChannelGain('', 'No Ch', 0.9, 'video', '');
  await ytcv.saveChannelAutoApply('', 'No Ch', true, 'video', '');
  await ytcv.deleteChannelGain('');
  await tick();
  assert(mockSentMessages.filter(m => String(m?.type).startsWith('store:')).length === 0,
    `nothing is sent for a channel with no id (${JSON.stringify(mockSentMessages.map(m => m?.type))})`);
  assert(!('' in mockStorage['channelVolumes']),
    'and no entry is made under an empty key');

  // ── page-bridge.js: what it reads, and what it refuses ──────────────

  section('Bridge: the page assigns its player response');
  {
    const bridge = createBridge();
    bridge.assign(playerResponse({ loudnessDb: -7.5, isLiveContent: true, isLive: true }));
    const msg = bridge.last();
    assert(bridge.posted.length === 1, `one message is posted (${bridge.posted.length})`);
    assert(msg?.type === '__yt_channel_volume__', `addressed to the content script (${msg?.type})`);
    assert(msg?.loudnessDb === -7.5, `carrying the level the page holds (${msg?.loudnessDb})`);
    assert(msg?.videoId === 'urlVideoIdA', `and the video it belongs to (${msg?.videoId})`);
    assert(msg?.channelId === 'UCbridge' && msg?.author === 'Bridge Ch',
      `and who published it (${msg?.channelId} / ${msg?.author})`);
    assert(msg?.isLiveContent === true && msg?.isLiveNow === true,
      `and that it is live now (${msg?.isLiveContent} / ${msg?.isLiveNow})`);
    assert(msg?.source === 'define', `saying where it came from (${msg?.source})`);
  }

  section('Bridge: a response the page had already assigned is taken');
  {
    const bridge = createBridge({ preassigned: playerResponse({ loudnessDb: -12.5 }) });
    assert(bridge.posted.length === 0,
      `nothing is posted for it on its own (${bridge.posted.length})`);
    await bridge.request();
    assert(bridge.last()?.loudnessDb === -12.5,
      `and the ask is answered from it (${bridge.last()?.loudnessDb})`);
  }

  section('Bridge: the answer from load is preferred over the page');
  {
    const bridge = createBridge();
    bridge.assign(playerResponse({ loudnessDb: -6.5, channelId: 'UCload' }));
    bridge.setFlexy(playerResponse({ loudnessDb: -3.5, channelId: 'UCpage' }));
    await bridge.request();
    assert(bridge.last()?.loudnessDb === -6.5,
      `the level answered is the one from load (${bridge.last()?.loudnessDb})`);
    assert(bridge.last()?.channelId === 'UCload',
      `and so is the channel (${bridge.last()?.channelId})`);
  }

  section('Bridge: an answer with a level and no channel is still an answer');
  {
    const bridge = createBridge();
    bridge.assign(playerResponse({ loudnessDb: -6.5, channelId: '' }));
    bridge.setFlexy(playerResponse({ loudnessDb: -3.5, channelId: 'UCpage' }));
    await bridge.request();
    assert(bridge.last()?.loudnessDb === -6.5,
      `the page does not take over from an answer that carries a level (${bridge.last()?.loudnessDb})`);
  }

  section('Bridge: an answer that cannot be read is taken as this video');
  {
    const bridge = createBridge();
    const unreadable = playerResponse();
    Object.defineProperty(unreadable, 'videoDetails', {
      get() { throw new Error('the page took it away'); }
    });
    bridge.assign(unreadable);
    assert(bridge.posted.length === 1,
      `an answer whose fields throw is still passed on (${bridge.posted.length})`);
    assert(bridge.last()?.videoId === 'urlVideoIdA',
      `named as the video the URL names (${bridge.last()?.videoId})`);
  }

  section('Bridge: an answer for another video is not passed on');
  {
    const bridge = createBridge();
    bridge.assign(playerResponse({ videoId: 'someOtherId' }));
    assert(bridge.posted.length === 0,
      `nothing is posted for a video the URL does not name (${bridge.posted.length})`);
    bridge.assign(playerResponse({ videoId: 'urlVideoIdA' }));
    assert(bridge.posted.length === 1, 'the one it does name is passed on');
  }

  section('Bridge: an answer that names no video is passed on');
  {
    const bridge = createBridge();
    bridge.assign(playerResponse({ videoId: '' }));
    assert(bridge.posted.length === 1,
      `an answer with no video id has nothing to compare (${bridge.posted.length})`);
    assert(bridge.last()?.videoId === 'urlVideoIdA',
      `so the message carries the video the URL names (${bridge.last()?.videoId})`);
  }

  section('Bridge: a watch URL naming no video takes what arrives');
  {
    const bridge = createBridge();
    bridge.setUrl('/watch', null);
    bridge.assign(playerResponse({ videoId: 'whateverPlays' }));
    assert(bridge.posted.length === 1,
      `with no id in the URL there is nothing to compare against (${bridge.posted.length})`);
    assert(bridge.last()?.videoId === 'whateverPlays',
      `and the message names the video the answer named (${bridge.last()?.videoId})`);
  }

  section('Bridge: a page that is not a watch page is left alone');
  {
    const bridge = createBridge();
    bridge.setUrl('/feed/subscriptions', null);
    bridge.assign(playerResponse());
    assert(bridge.posted.length === 0,
      `nothing is posted off a watch page (${bridge.posted.length})`);
  }

  section('Bridge: the player request a navigation makes');
  {
    const bridge = createBridge();
    await bridge.fetchPlayer(playerResponse({ loudnessDb: -3.25 }));
    assert(bridge.posted.length === 1, `the answer is read (${bridge.posted.length})`);
    assert(bridge.last()?.loudnessDb === -3.25, `for its level (${bridge.last()?.loudnessDb})`);
    assert(bridge.last()?.source === 'fetch', `named as the request it was (${bridge.last()?.source})`);

    await bridge.fetchPlayer(playerResponse({ videoId: 'someOtherId' }));
    assert(bridge.posted.length === 1, 'an answer for another video is not passed on');

    await bridge.fetchPlayer(playerResponse(), 'https://www.youtube.com/youtubei/v1/next');
    assert(bridge.posted.length === 1, 'and a request that is not for a player is not read');
  }

  section('Bridge: an archive is live content that is not live now');
  {
    const bridge = createBridge();
    bridge.assign(playerResponse({ isLiveContent: true, isLive: false }));
    assert(bridge.last()?.isLiveContent === true,
      `the recording of a stream is live content (${bridge.last()?.isLiveContent})`);
    assert(bridge.last()?.isLiveNow === false,
      `and nothing is going out now (${bridge.last()?.isLiveNow})`);
  }

  section('Bridge: the page element holding another video is not read');
  {
    const bridge = createBridge();
    bridge.setFlexy(playerResponse({ videoId: 'someOtherId', loudnessDb: -9.5, channelId: 'UCstale' }));
    await bridge.request();
    assert(bridge.last()?.loudnessDb === null,
      `a level for another video is not answered with (${bridge.last()?.loudnessDb})`);
    assert(bridge.last()?.channelId === '',
      `nor the channel it names (${JSON.stringify(bridge.last()?.channelId)})`);
    assert(bridge.last()?.videoId === 'urlVideoIdA', 'and the answer names the video being watched');
  }

  section('Bridge: the page is handed back what the network answered');
  {
    const bridge = createBridge();
    const player = await bridge.fetchPlayer(playerResponse());
    assert(player.returned === player.fromNetwork,
      'a player request reaches the page as it came off the network');
    assert(bridge.posted.length === 1, 'and it is read on the way past');
    const other = await bridge.fetchPlayer(playerResponse(), 'https://www.youtube.com/youtubei/v1/next');
    assert(other.returned === other.fromNetwork,
      'and so does a request the bridge does not read');

    // A request that failed has to fail for the page too.
    bridge.failNextFetch(new TypeError('Failed to fetch'));
    const failedPlayer = await bridge.fetchPlayer(playerResponse());
    let failed = null;
    await Promise.resolve(failedPlayer.returned).catch((err) => { failed = err; });
    assert(failed instanceof TypeError,
      `a player request that failed still fails for the page (${failed})`);
    bridge.failNextFetch(new TypeError('Failed to fetch'));
    const otherFailed = await bridge.fetchPlayer(playerResponse(), 'https://www.youtube.com/other');
    let failedOther = null;
    await Promise.resolve(otherFailed.returned).catch((err) => { failedOther = err; });
    assert(failedOther instanceof TypeError,
      `and so does one it does not read (${failedOther})`);
  }

  section('Bridge: the request reaches the network as the page made it');
  {
    const bridge = createBridge();
    const url = 'https://www.youtube.com/youtubei/v1/player?key=x';
    const init = { method: 'POST', body: '{"context":{}}' };
    await bridge.fetchPlayer(playerResponse(), url, init);
    assert(bridge.networkCalls.length === 1,
      `the network is asked once (${bridge.networkCalls.length})`);
    assert(bridge.networkCalls[0].thisArg === bridge.window,
      'on the object the page called it on');
    assert(bridge.networkCalls[0].args.length === 2,
      `with the arguments the page passed, and no more (${bridge.networkCalls[0].args.length})`);
    assert(bridge.networkCalls[0].args[0] === url && bridge.networkCalls[0].args[1] === init,
      'each of them the object the page passed, in that order');
    assert(bridge.posted.length === 1, 'and the answer is still read on the way past');
  }

  section('Bridge: a request made as a Request object is read too');
  {
    const bridge = createBridge();
    const request = { url: 'https://www.youtube.com/youtubei/v1/player?key=x' };
    await bridge.fetchPlayer(playerResponse(), request);
    assert(bridge.posted.length === 1,
      `a player request named by a Request object is read (${bridge.posted.length})`);
    assert(bridge.networkCalls[0].args[0] === request,
      'and what goes out is the object itself');

    const other = createBridge();
    await other.fetchPlayer(playerResponse(), { url: 'https://www.youtube.com/youtubei/v1/next' });
    assert(other.posted.length === 0,
      `while one for something else is not (${other.posted.length})`);
  }

  section('Bridge: a player answer off a watch page is not read');
  {
    const bridge = createBridge();
    bridge.setUrl('/feed/subscriptions', null);
    await bridge.fetchPlayer(playerResponse());
    assert(bridge.posted.length === 0,
      `a request answered off a watch page is not passed on (${bridge.posted.length})`);
  }

  section('Bridge: a /live/ URL is a watch page, and names the programme');
  {
    const bridge = createBridge();
    bridge.setUrl('/live/urlVideoIdA', null);
    bridge.assign(playerResponse({ videoId: 'urlVideoIdA' }));
    assert(bridge.posted.length === 1,
      `the assignment on a live URL is read (${bridge.posted.length})`);
    await bridge.fetchPlayer(playerResponse({ videoId: 'urlVideoIdA' }));
    assert(bridge.posted.length === 2,
      `and so is the request a navigation makes (${bridge.posted.length})`);
    bridge.assign(playerResponse({ videoId: 'someOtherId' }));
    await bridge.fetchPlayer(playerResponse({ videoId: 'someOtherId' }));
    assert(bridge.posted.length === 2,
      `an answer for another programme is passed on by neither (${bridge.posted.length})`);
  }

  section('Bridge: the level it reads when the first field is absent');
  {
    const bridge = createBridge();
    const perceptual = playerResponse();
    delete perceptual.playerConfig.audioConfig.loudnessDb;
    perceptual.playerConfig.audioConfig.perceptualLoudnessDb = -11.5;
    bridge.assign(perceptual);
    assert(bridge.last()?.loudnessDb === -11.5,
      `the second field stands in for the first (${bridge.last()?.loudnessDb})`);

    const neither = playerResponse();
    neither.playerConfig.audioConfig = {};
    bridge.assign(neither);
    assert(bridge.last()?.loudnessDb === null,
      `and with neither there is no level to report (${bridge.last()?.loudnessDb})`);
  }

  section('Bridge: answering what the content script asks for');
  {
    const bridge = createBridge();
    bridge.assign(playerResponse({ loudnessDb: -6.5 }));
    await bridge.request();
    assert(bridge.last()?.source === 'request', `the ask is answered (${bridge.last()?.source})`);
    assert(bridge.last()?.loudnessDb === -6.5,
      `from what the page gave at load (${bridge.last()?.loudnessDb})`);
  }

  section('Bridge: with nothing captured it reads the player it can see');
  {
    const bridge = createBridge();
    bridge.setFlexy(playerResponse({ loudnessDb: -9.5, channelId: 'UCflexy' }));
    await bridge.request();
    assert(bridge.last()?.loudnessDb === -9.5,
      `the page's own element answers (${bridge.last()?.loudnessDb})`);
    assert(bridge.last()?.channelId === 'UCflexy', 'with the channel it names');

    const other = createBridge();
    other.setMoviePlayer(playerResponse({ loudnessDb: -4.5, channelId: 'UCmovie' }));
    await other.request();
    assert(other.last()?.loudnessDb === -4.5,
      `and the player itself when the element is not there (${other.last()?.loudnessDb})`);

    const empty = createBridge();
    await empty.request();
    assert(empty.last()?.loudnessDb === null && empty.last()?.channelId === '',
      `with neither, the answer says so rather than staying silent (${JSON.stringify(empty.last()?.loudnessDb)})`);
    assert(empty.last()?.videoId === 'urlVideoIdA', 'and still names the video being watched');
  }

  section('Bridge: a stream that went live after the page loaded');
  {
    const bridge = createBridge();
    // The load-time answer for a stream that had not started.
    bridge.assign(playerResponse({ isLiveContent: true, isLive: false }));
    bridge.setMoviePlayer(playerResponse({ isLiveContent: true, isLive: true }));
    await bridge.request();
    assert(bridge.last()?.isLiveNow === true,
      `the player's answer is preferred over the one from load (${bridge.last()?.isLiveNow})`);

    // The page's own element holds a response too, and on a stream that was
    // waiting when the page loaded it holds the waiting one. Reading it first
    // and stopping there leaves the popup showing a stream that has started as
    // not started.
    const both = createBridge();
    both.assign(playerResponse({ isLiveContent: true, isLive: false, loudnessDb: -4.5 }));
    both.setFlexy(playerResponse({ isLiveContent: true, isLive: false, loudnessDb: -4.5 }));
    both.setMoviePlayer(playerResponse({ isLiveContent: true, isLive: true }));
    await both.request();
    assert(both.last()?.isLiveNow === true,
      `the player is asked even where the element answered first (${both.last()?.isLiveNow})`);
    assert(both.last()?.loudnessDb === -4.5,
      `and the level still comes from the answer that carries one (${both.last()?.loudnessDb})`);

    // After an SPA navigation the answer kept from load belongs to the video
    // this tab has left, so the level and the channel come from the page
    // instead — and the same two responses still have to say whether the
    // stream has started.
    const navigated = createBridge();
    navigated.assign(playerResponse({ videoId: 'someOtherId', loudnessDb: -1.5 }));
    navigated.setFlexy(playerResponse({ isLiveContent: true, isLive: false, loudnessDb: -6.5, channelId: 'UCstream' }));
    navigated.setMoviePlayer(playerResponse({ isLiveContent: true, isLive: true }));
    await navigated.request();
    assert(navigated.last()?.loudnessDb === -6.5,
      `the page answers for the video now being watched (${navigated.last()?.loudnessDb})`);
    assert(navigated.last()?.channelId === 'UCstream', 'with the channel it names');
    assert(navigated.last()?.isLiveNow === true,
      `and the stream is reported as started (${navigated.last()?.isLiveNow})`);

    // The same navigation, with nothing on the page saying it has started.
    const waiting = createBridge();
    waiting.assign(playerResponse({ videoId: 'someOtherId', loudnessDb: -1.5 }));
    waiting.setFlexy(playerResponse({ isLiveContent: true, isLive: false, loudnessDb: -6.5 }));
    await waiting.request();
    assert(waiting.last()?.isLiveNow === false,
      `a stream still waiting is not reported as started (${waiting.last()?.isLiveNow})`);

    // A stream that has ended: the player is the only answer that knows, and
    // the badge has to come down while the tab is still on the page.
    const ended = createBridge();
    ended.assign(playerResponse({ isLiveContent: true, isLive: true }));
    ended.setFlexy(playerResponse({ isLiveContent: true, isLive: true }));
    ended.setMoviePlayer(playerResponse({ isLiveContent: true, isLive: false }));
    await ended.request();
    assert(ended.last()?.isLiveNow === false,
      `a stream that has ended is no longer reported as live (${ended.last()?.isLiveNow})`);
    assert(ended.last()?.isLiveContent === true,
      'while it stays live content, which is what the gain is kept under');

    // The element is newer than the answer kept from load, and on a page that
    // has not built a player yet it is the only one that can have moved.
    const elementStarted = createBridge();
    elementStarted.assign(playerResponse({ isLiveContent: true, isLive: false }));
    elementStarted.setFlexy(playerResponse({ isLiveContent: true, isLive: true }));
    await elementStarted.request();
    assert(elementStarted.last()?.isLiveNow === true,
      `the element is taken over the answer kept from load (${elementStarted.last()?.isLiveNow})`);

    const elementEnded = createBridge();
    elementEnded.assign(playerResponse({ isLiveContent: true, isLive: true }));
    elementEnded.setFlexy(playerResponse({ isLiveContent: true, isLive: false }));
    await elementEnded.request();
    assert(elementEnded.last()?.isLiveNow === false,
      `in that direction as well (${elementEnded.last()?.isLiveNow})`);

    // The other direction of the same check: a player showing another video
    // cannot take the badge down either.
    const endedElsewhere = createBridge();
    endedElsewhere.assign(playerResponse({ isLiveContent: true, isLive: true }));
    endedElsewhere.setMoviePlayer(playerResponse({ videoId: 'someOtherId', isLiveContent: true, isLive: false }));
    await endedElsewhere.request();
    assert(endedElsewhere.last()?.isLiveNow === true,
      `a stream that ended under another video leaves this one alone (${endedElsewhere.last()?.isLiveNow})`);

    // Before the page has built a player, the only answer on hand is the one
    // kept from load, and after a navigation that one names the video the tab
    // has left.
    const bare = createBridge();
    bare.assign(playerResponse({ videoId: 'someOtherId', isLiveContent: true, isLive: true }));
    await bare.request();
    assert(bare.last()?.isLiveNow === false,
      `a stream running under the video this tab left is not this one (${bare.last()?.isLiveNow})`);

    // The player can be showing another video by the time the ask arrives.
    const elsewhere = createBridge();
    elsewhere.assign(playerResponse({ isLiveContent: true, isLive: false }));
    elsewhere.setMoviePlayer(playerResponse({ videoId: 'someOtherId', isLiveContent: true, isLive: true }));
    await elsewhere.request();
    assert(elsewhere.last()?.isLiveNow === false,
      `a stream running under another video does not make this one live (${elsewhere.last()?.isLiveNow})`);
  }

  section('Bridge: what the two listeners take, and what they leave alone');
  {
    const bridge = createBridge();
    bridge.assign(playerResponse({ loudnessDb: -6.5 }));
    const afterAssign = bridge.posted.length;

    // The answer the bridge posts comes back to it, as it does in a browser.
    // Both listeners have to leave it where it lies: answering it would answer
    // that answer in turn, and the page would post until it stopped responding.
    await bridge.request();
    assert(bridge.posted.length === afterAssign + 1,
      `an ask is answered once, and the answer is not answered again (${bridge.posted.length - afterAssign})`);
    const afterRequest = bridge.posted.length;

    await bridge.diagnose();
    assert(bridge.logged.length === 1, `the dump is written once (${bridge.logged.length})`);
    assert(bridge.posted.length === afterRequest,
      `and the dump posts nothing (${bridge.posted.length - afterRequest})`);

    // A message of another kind, from this window.
    await bridge.deliverAs(bridge.window, { type: '__something_else__' });
    assert(bridge.posted.length === afterRequest,
      `a message of another kind is left alone (${bridge.posted.length - afterRequest})`);
    assert(bridge.logged.length === 1, 'by the dump as well');

    // The right kind, from somewhere else — another frame in the page.
    const otherFrame = { name: 'an iframe' };
    await bridge.deliverAs(otherFrame, { type: '__yt_channel_volume_request__' });
    assert(bridge.posted.length === afterRequest,
      `an ask from another window is not answered (${bridge.posted.length - afterRequest})`);
    await bridge.deliverAs(otherFrame, { type: '__yt_channel_volume_diag__' });
    assert(bridge.logged.length === 1, 'and it gets no dump either');
  }

  section('Bridge: what the popup-open dump reports');
  {
    const bridge = createBridge();
    bridge.assign(playerResponse({ loudnessDb: -2.5 }));
    await bridge.diagnose();
    const [tag, dump] = bridge.logged[bridge.logged.length - 1] || [];
    assert(tag === '[YTCV][bridge-diag]', `the dump is written (${tag})`);
    assert(dump?.urlVideoId === 'urlVideoIdA', `naming the video in the URL (${dump?.urlVideoId})`);
    assert(dump?.captured?.loudnessDb === -2.5,
      `and the level the page gave (${dump?.captured?.loudnessDb})`);
    assert(dump?.flexy === null && dump?.moviePlayer === null,
      'and says outright that the other two answered nothing');

    const full = createBridge();
    full.assign(playerResponse({ loudnessDb: -2.5 }));
    full.setFlexy(playerResponse({ loudnessDb: -3.5, channelId: 'UCflexy' }));
    full.setMoviePlayer(playerResponse({ loudnessDb: -4.5, channelId: 'UCmovie', isLive: true }));
    await full.diagnose();
    const [, both] = full.logged[full.logged.length - 1] || [];
    assert(both?.flexy?.loudnessDb === -3.5 && both?.flexy?.channelId === 'UCflexy',
      `the element's answer is reported as it is (${JSON.stringify(both?.flexy?.loudnessDb)})`);
    assert(both?.moviePlayer?.loudnessDb === -4.5 && both?.moviePlayer?.isLive === true,
      `and the player's beside it (${JSON.stringify(both?.moviePlayer?.loudnessDb)})`);
    assert(both?.captured?.loudnessDb === -2.5, 'with the one from load as well');
  }

  // ── After a reload, and what a message has to be to be read ────────

  // The write path was put to this already; the reads and the popup were not.
  section('Extension reload: nothing is read either');
  {
    mockStorage['channelVolumes'] = { UCread: { name: 'Read Ch', gainVideo: 0.5 } };
    mockStorage['autoLoudnessSettings'] = { targetLufs: -20, displayUnit: '%' };
    ytcv._set('targetLufs', -18);
    const idBefore = chrome.runtime.id;
    const realGet = chrome.storage.local.get;
    let reads = 0;
    chrome.storage.local.get = (key) => { reads += 1; return realGet(key); };
    chrome.runtime.id = undefined;
    const entry = await ytcv.loadChannelEntry('UCread');
    await tick();
    chrome.storage.local.get = realGet;
    chrome.runtime.id = idBefore;
    assert(reads === 0, `no read is issued after a reload (${reads})`);
    assert(entry === null, `and the caller is told there is nothing (${JSON.stringify(entry)})`);
    assert(ytcv.state.targetLufs === -18, 'the target the page is working from is left as it was');
  }

  // The settings are read on every apply and written when the popup moves the
  // target; after a reload neither may touch storage.
  section('Extension reload: the settings are neither read nor written');
  {
    setURL('/watch', 'quietVid');
    mockVideoEl = { id: 'quiet-video' };
    ytcv._set('_lastProcessedVideo', null);
    ytcv._set('_applyRunning', false);
    ytcv._set('targetLufs', -18);
    const idBefore = chrome.runtime.id;
    const realGet = chrome.storage.local.get;
    const realSet = chrome.storage.local.set;
    let reads = 0, writes = 0;
    chrome.storage.local.get = (key) => { reads += 1; return realGet(key); };
    chrome.storage.local.set = (obj) => { writes += 1; return realSet(obj); };
    chrome.runtime.id = undefined;
    await ytcv.applyVideoVolume();
    const answer = await simulateRuntimeMessage({ type: 'setTargetLufs', value: -14 });
    await tick();
    chrome.storage.local.get = realGet;
    chrome.storage.local.set = realSet;
    chrome.runtime.id = idBefore;
    assert(reads === 0, `an apply after a reload reads nothing (${reads})`);
    assert(writes === 0, `and the target the popup asked for is not written (${writes})`);
    assert(answer?.ok === true, `while the popup is still answered (${JSON.stringify(answer)})`);
    assert(ytcv.state.targetLufs === -18,
      `and the target in hand is left as it was (${ytcv.state.targetLufs})`);
  }

  section('Extension reload: the popup is not written to');
  {
    setURL('/watch', 'quietVid');
    ytcv._set('currentChannel', { id: 'UCquiet', name: 'Quiet Ch', url: '' });
    ytcv._set('currentGain', 1.23);
    const idBefore = chrome.runtime.id;
    chrome.runtime.id = undefined;
    mockSentMessages.length = 0;
    ytcv.notifyPopup();
    chrome.runtime.id = idBefore;
    assert(mockSentMessages.length === 0,
      `nothing is sent to a popup that cannot be there (${mockSentMessages.length})`);
  }

  // The bridge posts into the page, and everything else on the page can post
  // there too — content.js reads one kind of message, from this window.
  section('Bridge message: what content.js takes it to be');
  {
    setURL('/watch', 'guardVid');
    ytcv._set('currentChannel', { id: '', name: '', url: '' });
    ytcv._set('currentChannelVideoId', '');
    ytcv._set('currentLoudnessVideoId', '');
    ytcv._set('currentLoudnessDb', null);

    // A message of another kind, from this window.
    for (const fn of mockEventListeners['message'] || []) {
      fn({ source: globalThis.window, data: { type: '__something_else__', loudnessDb: -3, channelId: 'UCother' } });
    }
    await tick();
    assert(ytcv.state.currentLoudnessDb === null,
      `a message of another kind is not read (${ytcv.state.currentLoudnessDb})`);
    assert(ytcv.state.currentChannel.id === '', 'and it does not name the channel');

    // The right kind, from another window in the page.
    for (const fn of mockEventListeners['message'] || []) {
      fn({ source: { name: 'an iframe' }, data: { type: '__yt_channel_volume__', loudnessDb: -3, isLiveContent: false, channelId: 'UCframe' } });
    }
    await tick();
    assert(ytcv.state.currentLoudnessDb === null,
      `nor is one from another window (${ytcv.state.currentLoudnessDb})`);
    assert(ytcv.state.currentChannel.id === '', 'and that one names no channel either');

    // The bridge's own, which is both.
    simulateBridgeMessage({ loudnessDb: -3, isLiveContent: false, videoId: 'guardVid', channelId: 'UCbridgeok' });
    await tick();
    assert(ytcv.state.currentLoudnessDb === -3, 'the bridge is read');
    assert(ytcv.state.currentChannel.id === 'UCbridgeok', 'and names the channel');
  }

  // ── What a change in another tab is allowed to move ────────────────

  section('Cross-tab: a change outside local storage is not one of ours');
  {
    setURL('/watch', 'syncVid');
    mockStorage['channelVolumes'] = { UCsync: { name: 'Sync Ch', gainVideo: 0.5 } };
    ytcv._set('currentChannel', { id: 'UCsync', name: 'Sync Ch', url: '' });
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('storageMigrated', true);
    ytcv._set('storageSettled', true);
    ytcv._set('currentGain', 0.5);
    for (const fn of chrome.storage.onChanged._listeners) {
      fn({ channelVolumes: { newValue: { UCsync: { name: 'Sync Ch', gainVideo: 0.9 } } } }, 'sync');
    }
    await tick();
    assert(ytcv.state.currentGain === 0.5,
      `a change in another area is left alone (${ytcv.state.currentGain})`);
  }

  section('Cross-tab: the fold mark is adopted, and only for what it is');
  {
    ytcv._set('storageMigrated', false);
    ytcv._set('storageSettled', false);
    simulateStorageChange({ autoLoudnessSettings: { newValue: { targetLufs: -18, displayUnit: '%' } } });
    await tick();
    assert(ytcv.state.storageMigrated === false,
      `a settings change is not a fold (${ytcv.state.storageMigrated})`);
    simulateStorageChange({ unifiedGains: { newValue: true } });
    await tick();
    assert(ytcv.state.storageMigrated === true, 'the mark is what says the profile was folded');
    assert(ytcv.state.storageSettled === true, 'and the wait for it is over');
  }

  section('Cross-tab: the fold mark arriving with the channels does not apply twice');
  {
    mockStorage['channelVolumes'] = { UCfold: { name: 'Fold Ch', gainVideo: 0.4 } };
    ytcv._set('currentChannel', { id: 'UCfold', name: 'Fold Ch', url: '' });
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('storageMigrated', false);
    ytcv._set('storageSettled', false);
    ytcv._set('currentGain', 1.0);
    const realGet = chrome.storage.local.get;
    let reads = 0;
    chrome.storage.local.get = (key) => { reads += 1; return realGet(key); };
    simulateStorageChange({
      unifiedGains: { newValue: true },
      channelVolumes: {
        oldValue: { UCfold: { name: 'Fold Ch', gainVideo: 0.4 } },
        newValue: { UCfold: { name: 'Fold Ch', gainVideo: 0.8 } }
      }
    });
    await tick();
    await tick();
    chrome.storage.local.get = realGet;
    assert(ytcv.state.currentGain === 0.8,
      `the gain the notification carried is applied (${ytcv.state.currentGain})`);
    assert(reads === 0,
      `and storage is not read again for what the notification already said (${reads})`);
  }

  section('Cross-tab: the Auto state that moved is the one being watched');
  {
    mockStorage['channelVolumes'] = {};
    ytcv._set('storageMigrated', true);
    ytcv._set('storageSettled', true);
    ytcv._set('currentChannel', { id: 'UCtype', name: 'Type Ch', url: '' });
    ytcv._set('currentVideoType', 'live');
    ytcv._set('currentLoudnessDb', -6);
    ytcv._set('targetLufs', -18);
    ytcv._set('currentAutoApplyLoudnessVideo', false);
    ytcv._set('currentAutoApplyLoudnessLive', false);
    ytcv._set('currentGain', 0.3);
    // Auto goes on for Live, which is the type being watched: the gain the
    // measurement asks for is applied. The Video slot moving on its own is not
    // this video's business.
    simulateStorageChange({
      channelVolumes: {
        oldValue: { UCtype: { name: 'Type Ch', gainLive: 0.3, autoApplyLoudnessLive: false } },
        newValue: { UCtype: { name: 'Type Ch', gainLive: 0.3, autoApplyLoudnessLive: true } }
      }
    });
    await tick();
    assert(Math.abs(ytcv.state.currentGain - ytcv.calcGainFromLoudness(-6)) < 0.001,
      `Auto going on for the type being watched applies the measurement (${ytcv.state.currentGain})`);

    ytcv._set('currentGain', 0.3);
    ytcv._set('currentAutoApplyLoudnessLive', false);
    ytcv._set('currentAutoApplyLoudnessVideo', false);
    simulateStorageChange({
      channelVolumes: {
        oldValue: { UCtype: { name: 'Type Ch', gainLive: 0.3, autoApplyLoudnessVideo: false } },
        newValue: { UCtype: { name: 'Type Ch', gainLive: 0.3, autoApplyLoudnessVideo: true } }
      }
    });
    await tick();
    assert(ytcv.state.currentGain === 0.3,
      `Auto going on for the other type leaves this one playing (${ytcv.state.currentGain})`);
    assert(ytcv.state.currentAutoApplyLoudnessVideo === true,
      `while the popup is told the other type moved (${JSON.stringify({v: ytcv.state.currentAutoApplyLoudnessVideo, l: ytcv.state.currentAutoApplyLoudnessLive})})`);
  }

  section('Cross-tab: a key that is not ours does not discard a read in flight');
  {
    mockStorage['channelVolumes'] = { UCrev: { name: 'Rev Ch', gainVideo: 0.45 } };
    ytcv._set('currentChannel', { id: 'UCrev', name: 'Rev Ch', url: '' });
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('currentAutoApplyLoudnessVideo', false);
    ytcv._set('currentGain', 1.0);
    ytcv._set('storageMigrated', true);
    ytcv._set('storageSettled', true);
    const realGet = chrome.storage.local.get;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    chrome.storage.local.get = (key) => held.then(() => realGet(key));
    const applying = ytcv.applyPreferredGain();
    await tick();
    // Something else in the profile moved while the read was out.
    simulateStorageChange({ somebodyElsesKey: { newValue: 1 } });
    release();
    await applying;
    chrome.storage.local.get = realGet;
    assert(ytcv.state.currentGain === 0.45,
      `the gain that was read is applied (${ytcv.state.currentGain})`);
  }

  section('Cross-tab: Auto going on with nothing saved returns to passthrough');
  {
    mockStorage['channelVolumes'] = {};
    ytcv._set('currentChannel', { id: 'UConly', name: 'Only Ch', url: '' });
    ytcv._set('currentVideoType', 'live');
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('currentAutoApplyLoudnessVideo', false);
    ytcv._set('currentAutoApplyLoudnessLive', false);
    ytcv._set('currentGain', 0.55);
    // The channel has a Video gain and nothing for Live, and Live is what is
    // being watched: turning Auto on for it with no measurement to work from
    // leaves nothing to apply, so the level returns to passthrough.
    simulateStorageChange({
      channelVolumes: {
        oldValue: { UConly: { name: 'Only Ch', gainVideo: 0.55, autoApplyLoudnessLive: false } },
        newValue: { UConly: { name: 'Only Ch', gainVideo: 0.55, autoApplyLoudnessLive: true } }
      }
    });
    await tick();
    assert(ytcv.state.currentGain === 1.0,
      `the type being watched has nothing saved, so it plays at 1.0 (${ytcv.state.currentGain})`);
  }

  section('Cross-tab: the other type moving is still worth telling the popup');
  {
    mockStorage['channelVolumes'] = {};
    ytcv._set('currentChannel', { id: 'UCtell', name: 'Tell Ch', url: '' });
    ytcv._set('currentVideoType', 'live');
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('currentAutoApplyLoudnessVideo', false);
    ytcv._set('currentAutoApplyLoudnessLive', false);
    ytcv._set('currentGain', 1.0);
    ytcv.notifyPopup();
    mockSentMessages.length = 0;
    simulateStorageChange({
      channelVolumes: {
        oldValue: { UCtell: { name: 'Tell Ch', autoApplyLoudnessVideo: false } },
        newValue: { UCtell: { name: 'Tell Ch', autoApplyLoudnessVideo: true } }
      }
    });
    await tick();
    assert(mockSentMessages.some(m => m?.type === 'stateChanged'),
      `the popup is told the other type moved (${JSON.stringify(mockSentMessages.map(m => m?.type))})`);

    // And where nothing moved at all, it is not told anything.
    mockSentMessages.length = 0;
    simulateStorageChange({
      channelVolumes: {
        oldValue: { UCtell: { name: 'Tell Ch', autoApplyLoudnessVideo: true } },
        newValue: { UCtell: { name: 'Tell Ch', autoApplyLoudnessVideo: true } }
      }
    });
    await tick();
    assert(!mockSentMessages.some(m => m?.type === 'stateChanged'),
      `a notification carrying no change says nothing (${JSON.stringify(mockSentMessages.map(m => m?.type))})`);
  }

  section('Cross-tab: which type was already on decides what moved');
  {
    mockStorage['channelVolumes'] = {};
    ytcv._set('currentChannel', { id: 'UCboth', name: 'Both Ch', url: '' });
    ytcv._set('currentVideoType', 'live');
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('currentAutoApplyLoudnessVideo', true);
    ytcv._set('currentAutoApplyLoudnessLive', false);
    ytcv._set('currentGain', 0.65);
    // Video was already on and Live was not. Live going on is a move for the
    // type being watched, even though the other type's state did not change.
    simulateStorageChange({
      channelVolumes: {
        oldValue: { UCboth: { name: 'Both Ch', gainVideo: 0.2, autoApplyLoudnessVideo: true, autoApplyLoudnessLive: false } },
        newValue: { UCboth: { name: 'Both Ch', gainVideo: 0.2, autoApplyLoudnessVideo: true, autoApplyLoudnessLive: true } }
      }
    });
    await tick();
    assert(ytcv.state.currentGain === 1.0,
      `the type being watched has nothing to apply, so it plays at 1.0 (${ytcv.state.currentGain})`);
  }

  section('Cross-tab: the live slot moving is told to the popup as well');
  {
    mockStorage['channelVolumes'] = {};
    ytcv._set('currentChannel', { id: 'UClive', name: 'Live Ch', url: '' });
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('currentAutoApplyLoudnessVideo', false);
    ytcv._set('currentAutoApplyLoudnessLive', false);
    ytcv._set('currentGain', 1.0);
    ytcv.notifyPopup();
    mockSentMessages.length = 0;
    simulateStorageChange({
      channelVolumes: {
        oldValue: { UClive: { name: 'Live Ch', autoApplyLoudnessLive: false } },
        newValue: { UClive: { name: 'Live Ch', autoApplyLoudnessLive: true } }
      }
    });
    await tick();
    assert(mockSentMessages.some(m => m?.type === 'stateChanged'),
      `a move in the Live slot reaches the popup while a Video is watched (${JSON.stringify(mockSentMessages.map(m => m?.type))})`);
  }

  section('Cross-tab: the gain this tab is already playing is not applied again');
  {
    mockStorage['channelVolumes'] = { UCsame: { name: 'Same Ch', gainVideo: 0.75 } };
    ytcv._set('currentChannel', { id: 'UCsame', name: 'Same Ch', url: '' });
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('currentAutoApplyLoudnessVideo', false);
    ytcv._set('currentGain', 0.75);
    // A fresh element, so building the audio chain is something a case can see.
    mockVideoEl = { id: 'cross-tab-video' };
    mockAudioAsks.disconnects = 0;
    simulateStorageChange({
      channelVolumes: {
        oldValue: { UCsame: { name: 'Same Ch', gainVideo: 0.75 } },
        newValue: { UCsame: { name: 'Same Ch', gainVideo: 0.75 } }
      }
    });
    await tick();
    assert(mockAudioAsks.disconnects === 0,
      `the player is not taken up again for a gain already playing (${mockAudioAsks.disconnects})`);
    assert(ytcv.state.currentGain === 0.75, 'and the gain is where it was');
  }

  section('Cross-tab: a channel with nothing saved for this type');
  {
    ytcv._set('currentChannel', { id: 'UCnone', name: 'None Ch', url: '' });
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('currentAutoApplyLoudnessVideo', false);
    ytcv._set('currentGain', 0.6);
    simulateStorageChange({
      channelVolumes: {
        oldValue: { UCnone: { name: 'None Ch', gainLive: 0.6 } },
        newValue: { UCnone: { name: 'None Ch', gainLive: 0.7 } }
      }
    });
    await tick();
    assert(ytcv.state.currentGain === 0.6,
      `a move in the other type's gain leaves this one where it is (${ytcv.state.currentGain})`);
  }

  // ── Summary ────────────────────────────────────────────────────────

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  // A rejection here is the run stopping where it stood, which is the point:
  // carrying on past a lost port runs the rest against state a handler nobody
  // is waiting for is still writing to.
  console.error('  FAIL:', err && err.message ? err.message : err);
  process.exit(1);
});
