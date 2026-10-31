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
// The settings' own area, apart from local as Chrome keeps it.
let mockSyncStorage = {};
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
  mockSyncStorage = {};
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
    sync: {
      get(key) {
        return Promise.resolve(
          Object.prototype.hasOwnProperty.call(mockSyncStorage, key)
            ? { [key]: cloneStorageValue(mockSyncStorage[key]) }
            : {}
        );
      },
      set(obj) {
        for (const [key, value] of Object.entries(obj)) {
          mockSyncStorage[key] = cloneStorageValue(value);
        }
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

// The live follow asks content.js's page for a level every 10 s. Its timer is
// held here rather than left to fire into whichever case is running ten
// seconds later, and a case runs it when it means to. Every other delay passes
// through as it is.
const LIVE_FOLLOW_MS = 10000;
const heldLiveFollows = [];
// The end of a slider preview that its input stopped coming for is held the
// same way, so a preview a case leaves open ends when a case says so.
const PREVIEW_IDLE_MS = 2000;
const heldPreviewEnds = [];
const passedSetTimeout = globalThis.setTimeout;
const passedClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const list = ms === LIVE_FOLLOW_MS ? heldLiveFollows : ms === PREVIEW_IDLE_MS ? heldPreviewEnds : null;
  if (!list) return passedSetTimeout(fn, ms, ...args);
  const held = { fn, ms };
  list.push(held);
  return held;
};
globalThis.clearTimeout = (timer) => {
  for (const list of [heldLiveFollows, heldPreviewEnds]) {
    const at = list.indexOf(timer);
    if (at > -1) { list.splice(at, 1); return; }
  }
  passedClearTimeout(timer);
};
// Runs the follows held now (not ones they set) and hands back how many ran.
async function runLiveFollows() {
  const due = heldLiveFollows.splice(0);
  for (const timer of due) timer.fn();
  await tick();
  return due.length;
}
async function runPreviewEnds() {
  const due = heldPreviewEnds.splice(0);
  for (const timer of due) timer.fn();
  await tick();
  return due.length;
}

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

vm.runInThisContext(fs.readFileSync('./core/common.js', 'utf8'), { filename: 'core/common.js' });
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

// Helper to fire chrome.storage.onChanged. Chrome fires one event per area,
// and the settings are the one key that lives in sync.
function simulateStorageChange(changes) {
  const synced = {};
  const local = {};
  for (const [key, change] of Object.entries(changes)) {
    (key === SETTINGS_KEY ? synced : local)[key] = change;
  }
  for (const [area, part] of [['sync', synced], ['local', local]]) {
    if (!Object.keys(part).length) continue;
    for (const fn of chrome.storage.onChanged._listeners) fn(part, area);
  }
}

// Helper to wait for async
function tick() { return new Promise(r => setTimeout(r, 10)); }


// ── page-bridge.js ───────────────────────────────────────────────────
// The MAIN-world half of the pair. No suite in any of the three extensions
// had ever loaded a bridge, so everything it decides — which answers it
// refuses, where it reads the level from, what it puts in a message — was
// held by nothing. It runs in a context of its own here: the page's window,
// the fetch it wraps, and the DOM it reads.

function createBridge({ pathname = '/watch', videoId = 'urlVideoIdA', preassigned = null, hookRefused = false, stored = {}, manualTimers = false } = {}) {
  const posted = [];
  const pendingTimers = [];
  let playerListeners = {};
  const listeners = {};
  const logged = [];
  let flexy = null;
  let canonical = null;
  let moviePlayer = null;
  let fetchAnswer = null;
  let fetchRejection = null;
  let fetchFailure = null;
  let lastFetchFailure = null;
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
    // What the player keeps in localStorage, by key, as the strings it wrote.
    localStorage: { getItem: (key) => (key in stored ? stored[key] : null) },
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
      if (fetchFailure) {
        // Made inside the call, so its stack names what called fetch, as the
        // TypeError of a request Chrome could not make does; rejected
        // afterwards, the way such a request fails.
        const reason = fetchFailure();
        fetchFailure = null;
        lastFetchFailure = reason;
        fromNetwork = new Promise((resolve, reject) => { setTimeout(() => reject(reason), 0); });
        return fromNetwork;
      }
      fromNetwork = fetchRejection
        ? Promise.reject(fetchRejection)
        : Promise.resolve({ clone: () => ({ json: () => Promise.resolve(body) }), args });
      return fromNetwork;
    }
  };

  const sandbox = {
    window, location, console: { log: (...args) => logged.push(args) },
    URL, Promise, JSON, Object, Math, Date, String, Number, Boolean,
    // The page's timers, left out of what keeps this run alive — or, for a
    // case that counts them, held until the case runs them.
    setTimeout: manualTimers
      ? (fn, ms) => { const t = { fn, ms }; pendingTimers.push(t); return t; }
      : (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimeout: manualTimers
      ? (t) => { const at = pendingTimers.indexOf(t); if (at > -1) pendingTimers.splice(at, 1); }
      : clearTimeout,
    document: {
      querySelector: (selector) => (selector.includes('ytd-watch-flexy') ? flexy
        : selector.includes('rel="canonical"') ? canonical : null),
      getElementById: (id) => (id === 'movie_player' ? moviePlayer : null)
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // document_start is early, but not always early enough: the page can have
  // assigned its response before the bridge is there to hook the assignment.
  if (preassigned) window.ytInitialPlayerResponse = preassigned;
  // A page that will not let the assignment be hooked: the bridge catches the
  // refusal and reads the property as it stands from then on.
  if (hookRefused) {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      value: preassigned, writable: true, configurable: false, enumerable: true
    });
  }
  vm.runInContext(fs.readFileSync('./page-bridge.js', 'utf8'), sandbox, {
    filename: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page-bridge.js'
  });

  const deliver = (data) => {
    for (const fn of listeners['message'] || []) fn({ source: window, data });
  };

  return {
    posted,
    logged,
    setUrl,
    // The page's canonical link, which on a channel's live URL names the stream.
    setCanonical(href) { canonical = href ? { href } : null; },
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
    // The next request fails with an error made in the page's realm: a
    // TypeError, or an Error carrying the name given.
    failNextFetchInPage(errorName, message) {
      const make = vm.runInContext(
        '(name, message) => { if (name === "TypeError") return new TypeError(message); const e = new Error(message); e.name = name; return e; }',
        sandbox
      );
      fetchFailure = () => make(errorName, message);
    },
    lastFetchFailure: () => lastFetchFailure,
    // A promise the page rejects itself, with a TypeError made in its realm.
    pageRejects(message) {
      return vm.runInContext(`Promise.reject(new TypeError(${JSON.stringify(message)}))`, sandbox);
    },
    // Unhandled rejections as Node reports them, which is for a promise with no
    // handler; each is dispatched to the page's listeners as the window
    // dispatches one. `reportedFor` lists, per report for that promise, whether
    // a listener prevented its default.
    watchUnhandledRejections() {
      const seen = [];
      const onRejection = (reason, promise) => {
        const event = { reason, promise, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        for (const fn of listeners['unhandledrejection'] || []) fn(event);
        seen.push(event);
      };
      process.on('unhandledRejection', onRejection);
      return {
        reportedFor: (promise) => seen.filter((event) => event.promise === promise).map((event) => event.defaultPrevented),
        stop: () => process.off('unhandledRejection', onRejection)
      };
    },
    networkCalls,
    window,
    // Method 3 and the on-demand path: what content.js asks for.
    async request() { deliver({ type: '__yt_channel_volume_request__' }); await tick(); },
    async diagnose() { deliver({ type: '__yt_channel_volume_diag__' }); await tick(); },
    // The live ask, from this window or, for a case that names one, another.
    async askLive(source = window) {
      for (const fn of (listeners['message'] || []).slice()) fn({ source, data: { type: '__yt_channel_volume_live_ask__' } });
      await tick();
    },
    // A message that reached this window from somewhere else — another frame,
    // or the page's own script posting to it.
    async deliverAs(source, data) {
      for (const fn of (listeners['message'] || []).slice()) fn({ source, data });
      await tick();
    },
    setFlexy(playerResponse) { flexy = playerResponse ? { __data: { playerResponse } } : null; },
    // The player, answering with the response given and with whatever else a
    // case hands it — its stable volume setting, its stats. What it is asked to
    // listen for is kept, so a case can fire what the player would announce.
    setMoviePlayer(playerResponse, extra = {}) {
      playerListeners = {};
      moviePlayer = playerResponse
        ? {
          getPlayerResponse: () => playerResponse,
          addEventListener(type, fn) { (playerListeners[type] ||= []).push(fn); },
          ...extra
        }
        : null;
    },
    playerListenerCount: (type) => (playerListeners[type] || []).length,
    // Runs the timers pending now (not ones they set) and hands back their delays.
    async runTimers() {
      const due = pendingTimers.splice(0);
      for (const t of due) t.fn();
      await tick();
      return due.map((t) => t.ms);
    },
    pendingTimers: () => pendingTimers.length,
    async playerAnnounces(type) {
      for (const fn of (playerListeners[type] || []).slice()) fn('Default');
      await tick();
    },
    last() { return posted[posted.length - 1]; }
  };
}

const playerResponse = (over = {}) => ({
  playerConfig: {
    audioConfig: {
      ...('loudnessDb' in over && over.loudnessDb === undefined ? {} : { loudnessDb: over.loudnessDb ?? -7.5 }),
      ...(over.perceptualLoudnessDb !== undefined ? { perceptualLoudnessDb: over.perceptualLoudnessDb } : {}),
      ...(over.loudnessTargetLkfs === null ? {} : { loudnessTargetLkfs: over.loudnessTargetLkfs ?? -14 })
    }
  },
  ...(over.drcLoudnessDb !== undefined ? {
    streamingData: {
      adaptiveFormats: [
        { itag: 251, loudnessDb: over.loudnessDb ?? -7.5 },
        { itag: 251, isDrc: true, loudnessDb: over.drcLoudnessDb }
      ]
    }
  } : {}),
  videoDetails: {
    videoId: over.videoId ?? 'urlVideoIdA',
    channelId: over.channelId ?? 'UCbridge',
    author: over.author ?? 'Bridge Ch',
    isLiveContent: over.isLiveContent ?? false,
    isLive: over.isLive ?? false
  }
});

// The popup, run for real against the content script above. Nothing ran
// popup.js in this repository before — it was read as text and matched against
// regular expressions — so every branch of it, and every message it builds,
// was reached by nobody.
function makePopup({ tabUrl = 'https://www.youtube.com/watch?v=abc', answer = null, displayUnit = '%' } = {}) {
  const nodes = new Map();
  const popupTimers = [];
  const asked = [];
  const attempts = [];
  const broadcastListeners = [];
  const node = (id) => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {
        id, listeners: {}, dataset: {}, style: {}, children: [], offsetWidth: 0,
        value: '', disabled: false, checked: false,
        // Writing textContent replaces every child with one piece of text,
        // and writing innerHTML replaces what the element holds. The popup
        // empties a card both ways before drawing into it again.
        _textContent: '',
        get textContent() { return this._textContent; },
        set textContent(text) { this._textContent = text; this.children.length = 0; },
        // Writing innerHTML replaces what the element holds; the popup empties
        // a card that way before drawing into it again.
        _innerHTML: '',
        get innerHTML() { return this._innerHTML; },
        set innerHTML(markup) { this._innerHTML = markup; if (!markup) this.children.length = 0; },
        classList: {
          add: (...names) => names.forEach((c) => classes.add(c)),
          remove: (...names) => names.forEach((c) => classes.delete(c)),
          contains: (c) => classes.has(c)
        },
        get className() { return [...classes].join(' '); },
        set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
        appendChild(child) { this.children.push(child); return child; },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
      });
    }
    return nodes.get(id);
  };
  const presets = [50, 100, 200, 400].map((percent) => {
    const button = node(`preset-${percent}`);
    button.dataset.vol = String(percent);
    return button;
  });
  const windowListeners = {};
  const popupSandbox = {
    window: { addEventListener: (type, fn) => (windowListeners[type] ||= []).push(fn) },
    console: { log() {}, warn() {}, error() {} },
    Promise, Math, JSON, Date, Object, Array, Number, String, Boolean, isNaN, parseFloat, parseInt,
    setTimeout: (fn) => { popupTimers.push(fn); return popupTimers.length; },
    clearTimeout() {},
    requestAnimationFrame: (fn) => fn(),
    document: {
      body: node('body'),
      documentElement: node('html'),
      getElementById: node,
      createElement: () => node(`made-${nodes.size}`),
      querySelectorAll: (selector) => (selector === '.presets button' ? presets : [])
    },
    chrome: {
      // The key, followed by what it was handed to put into the message.
      i18n: { getMessage: (key, substitutions) => [key].concat(substitutions ?? []).join(' ') },
      tabs: {
        query: async () => (tabUrl === null ? [] : [{ id: 9, url: tabUrl }]),
        // Chrome refuses a message addressed to no tab rather than delivering
        // it, and the attempt is recorded before the refusal: a message sent
        // nowhere was still one the popup tried to send.
        sendMessage: async (tabId, message) => {
          attempts.push(tabId);
          if (typeof tabId !== 'number') {
            throw new TypeError('Error in invocation of tabs.sendMessage: no matching signature');
          }
          asked.push(JSON.parse(JSON.stringify(message)));
          if (answer) return answer(message);
          return simulateRuntimeMessage(message);
        }
      },
      runtime: {
        openOptionsPage() {},
        onMessage: { addListener: (fn) => broadcastListeners.push(fn) }
      },
      storage: { sync: { get: async () => ({ [SETTINGS_KEY]: { displayUnit } }) } }
    }
  };
  popupSandbox.globalThis = popupSandbox;
  vm.createContext(popupSandbox);
  vm.runInContext(fs.readFileSync('./core/common.js', 'utf8'), popupSandbox, { filename: 'core/common.js' });
  vm.runInContext(fs.readFileSync('./utils.js', 'utf8'), popupSandbox, { filename: 'utils.js' });
  vm.runInContext(fs.readFileSync('./popup.js', 'utf8'), popupSandbox, { filename: 'popup.js' });
  return {
    node, presets, asked, attempts,
    // The popup's own start-up is a storage read, a tab lookup and a
    // forceDetect, and forceDetect is answered from a .then. Waiting a fixed
    // number of turns says nothing about whether it has drawn; the channel on
    // screen does.
    async ready() {
      for (let turn = 0; turn < 40; turn++) {
        const shown = node('channelName').textContent;
        if (shown && shown !== 'channelNotDetected') return;
        await tick();
      }
      throw new Error('the popup never drew a channel');
    },
    // For a case whose popup is not meant to draw a channel at all.
    async settled() { for (let turn = 0; turn < 6; turn++) await tick(); },
    // The broadcast content.js sends whenever its state moves.
    async broadcast() {
      const state = await simulateRuntimeMessage({ type: 'getState' });
      for (const fn of broadcastListeners) fn({ type: 'stateChanged', ...state }, { tab: { id: 9 } });
      await tick();
    },
    // A disabled control receives no event: the browser does not dispatch one,
    // so what protects a gesture is the disabling, not a guard in the handler.
    async fire(id, type, event = {}) {
      if (node(id).disabled) { await tick(); return; }
      for (const fn of node(id).listeners[type] || []) await fn({ target: node(id), ...event });
      await tick();
    },
    // The popup's own window losing focus.
    async blurWindow() {
      for (const fn of windowListeners.blur || []) await fn({});
      await tick();
    },
    async firePreset(index, type) {
      const button = presets[index];
      if (button.disabled) { await tick(); return; }
      for (const fn of button.listeners[type] || []) await fn({ target: button });
      await tick();
    },
    // A message as it arrives at the popup, from a tab of the case's choosing.
    async deliver(message, tabId = 9) {
      for (const fn of broadcastListeners) fn(message, { tab: { id: tabId } });
      await tick();
    },
    async runTimers() {
      const due = popupTimers.splice(0);
      for (const fn of due) await fn();
      await tick();
    }
  };
}

// A gesture as the popup makes one: it carries the state the popup was drawn
// from, which content.js hands out with every answer.
async function popupGesture(msg) {
  const state = await simulateRuntimeMessage({ type: 'getState' });
  return simulateRuntimeMessage({ appliesTo: state?.appliesTo, ...msg });
}

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
  // After a navigation the page can still name the channel of the video
  // left, so the channel waits for the bridge to name it for this video.
  assert(ytcv.state.currentChannel.id === '', 'the page is not taken for the channel');
  simulateBridgeMessage({ videoId: 'vid004', isLiveContent: false, channelId: 'UCtest_B' });
  await tick();
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
  simulateBridgeMessage({ videoId: 'vid007', isLiveContent: false, channelId: 'UCtest_C' });
  await tick();
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

  // A channel's live URL names no video; the page's canonical link does, when
  // the channel has a stream on air or coming.
  section('isWatchPage: a channel\'s live URL');
  {
    const priorCanonical = mockDOMElements['canonical'];
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/watch?v=chLiveVid01' };
    for (const path of ['/@someHandle/live', '/channel/UCsomeChannel/live', '/c/someName/live',
      '/user/someName/live', '/someName/live', '/@someHandle/live/']) {
      setURL(path, null);
      assert(ytcv.isWatchPage() === true && ytcv.getUrlVideoId() === 'chLiveVid01',
        `${path} with a stream → the video the canonical link names (${ytcv.isWatchPage()} / ${ytcv.getUrlVideoId()})`);
    }
    for (const path of ['/@someHandle/videos', '/@someHandle/live/extra', '/live', '/a/b/live']) {
      setURL(path, null);
      assert(ytcv.isWatchPage() === false && ytcv.getUrlVideoId() === '',
        `${path} is not a channel's live URL (${ytcv.isWatchPage()} / ${ytcv.getUrlVideoId()})`);
    }
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCsomeChannel' };
    setURL('/@someHandle/live', null);
    assert(ytcv.isWatchPage() === false && ytcv.getUrlVideoId() === '',
      `with nothing on air or coming, the page is the channel's (${ytcv.isWatchPage()} / ${ytcv.getUrlVideoId()})`);
    mockDOMElements['canonical'] = null;
    assert(ytcv.isWatchPage() === false && ytcv.getUrlVideoId() === '',
      `and with no canonical link, nothing is named (${ytcv.isWatchPage()} / ${ytcv.getUrlVideoId()})`);
    mockDOMElements['canonical'] = priorCanonical;
  }
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
  ytcv._set('currentChannelVideoId', ytcv.getUrlVideoId());
  ytcv._set('currentVideoType', 'video');
  ytcv._set('targetLufs', -18);

  // Auto is doing the applying; the button must not write over it.
  ytcv._set('currentAutoApplyLoudnessVideo', true);
  ytcv._set('currentLoudnessDb', -6);
  const whileAuto = await popupGesture({ type: 'applyLoudness' });
  assert(whileAuto?.ok === false && whileAuto?.reason === 'auto apply enabled',
    `with Auto on it is declined — got ${JSON.stringify(whileAuto)}`);

  // Auto off, but nothing measured to apply.
  ytcv._set('currentAutoApplyLoudnessVideo', false);
  ytcv._set('currentLoudnessDb', null);
  const withoutLoudness = await popupGesture({ type: 'applyLoudness' });
  assert(withoutLoudness?.ok === false && withoutLoudness?.reason === 'no loudness data',
    `with nothing measured it is declined — got ${JSON.stringify(withoutLoudness)}`);

  // Measured, but the page has not said whose channel it is yet. Applying now
  // would move the level the viewer hears with nothing able to remember it;
  // a state with no channel for the video is not one a gesture is taken on.
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('currentChannel', { id: '', name: '', url: '' });
  const gainBeforeIdless = ytcv.state.currentGain;
  const withoutChannel = await popupGesture({ type: 'applyLoudness' });
  await tick();
  assert(withoutChannel?.ok === false && withoutChannel?.reason === 'state moved',
    `with no channel known it is declined — got ${JSON.stringify(withoutChannel)}`);
  assert(ytcv.state.currentGain === gainBeforeIdless,
    `and the gain that is playing is left alone (${ytcv.state.currentGain})`);
  assert(Object.keys(mockStorage['channelVolumes']).length === 1,
    'and no channel is written');

  // And with none of the three in the way it goes through. Without this the
  // refusals above would hold for a handler that declined everything.
  ytcv._set('currentChannel', { id: 'UCapply', name: 'Apply Ch', url: 'https://y/UCapply' });
  ytcv._set('currentChannelVideoId', ytcv.getUrlVideoId());
  const applied = await popupGesture({ type: 'applyLoudness' });
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
  ytcv._set('_lastVideoId', 'BRIDGELEARN');
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

  section('Auto LUFS: a new level for the same video replaces the gain');
  {
    // Turning stable volume over swaps the rendition under the video the page
    // is on; the bridge answers again with that rendition's level.
    simulateBridgeMessage({
      videoId: 'BRIDGELEARN', loudnessDb: -0.33, isLiveContent: false,
      channelId: 'UCbridgeLearn', author: 'Bridge Learn', source: 'audio-change'
    });
    await tick();
    const stable = calcGain(-0.33, -18);
    assert(Math.abs(ytcv.state.currentGain - stable) < 0.001,
      `the stable rendition's gain is played (${ytcv.state.currentGain})`);
    assert(Math.abs(mockStorage['channelVolumes']['UCbridgeLearn'].gainVideo - stable) < 0.001,
      `and stored (${mockStorage['channelVolumes']['UCbridgeLearn'].gainVideo})`);

    simulateBridgeMessage({
      videoId: 'BRIDGELEARN', loudnessDb: -12.39, isLiveContent: false,
      channelId: 'UCbridgeLearn', author: 'Bridge Learn', source: 'audio-change'
    });
    await tick();
    const plain = calcGain(-12.39, -18);
    assert(Math.abs(ytcv.state.currentGain - plain) < 0.001,
      `and the plain rendition's once it is back (${ytcv.state.currentGain})`);
    assert(ytcv.getState().contentLufs === YT_REFERENCE_LUFS - 12.39,
      `the level shown follows it (${ytcv.getState().contentLufs})`);
  }

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
  ytcv._set('_lastVideoId', comparedArchiveVideoId);
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
  ytcv._set('_lastVideoId', comparedLiveVideoId);
  ytcv._set('currentChannelVideoId', comparedLiveVideoId);
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('currentLoudnessVideoId', comparedLiveVideoId);
  ytcv._set('currentGain', 0.4);
  await ytcv.applyPreferredGain();
  assert(Math.abs(ytcv.state.currentGain - expectedAutoGain) < 0.001,
    'same-channel live without LUFS loads the stored channel gain');

  section('Auto LUFS: switching Auto off keeps the level Auto was playing');
  const autoOffResponse = await popupGesture({
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
  const manualGainResponse = await popupGesture({
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

  // ── Stored gains are held against the plain rendition ──────────────

  // One video's two renditions: the stable one is 12.06 dB louder than the
  // plain one.
  const PLAIN_DB = -12.39;
  const STABLE_DB = -0.33;
  const closeTo = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
  const enterVideo = (channelId, videoId, videoType, entry) => {
    mockStorage['channelVolumes'] = entry ? { [channelId]: entry } : {};
    setURL('/watch', videoId);
    ytcv._set('_lastVideoId', videoId);
    ytcv._set('currentChannel', { id: channelId, name: entry?.name || channelId, url: 'https://www.youtube.com/channel/' + channelId });
    ytcv._set('currentChannelVideoId', videoId);
    ytcv._set('currentVideoType', videoType);
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('currentBaseLoudnessDb', null);
    ytcv._set('currentLoudnessVideoId', '');
    ytcv._set('currentAutoApplyLoudnessVideo', !!entry?.autoApplyLoudnessVideo);
    ytcv._set('currentAutoApplyLoudnessLive', !!entry?.autoApplyLoudnessLive);
    ytcv._set('targetLufs', -18);
  };
  const bridgeSays = async (channelId, videoId, over) => {
    simulateBridgeMessage({
      videoId, isLiveContent: false, isLiveNow: false, channelId, author: 'Rendition Ch', ...over
    });
    await tick();
  };

  section('Stable volume: Auto stores the plain rendition\'s gain, and a stream on air plays it');
  {
    enterVideo('UCrendition', 'ARCHIVESTB1', 'live', { name: 'Rendition Ch', autoApplyLoudnessLive: true });
    await bridgeSays('UCrendition', 'ARCHIVESTB1', {
      isLiveContent: true, loudnessDb: STABLE_DB, baseLoudnessDb: PLAIN_DB
    });
    assert(closeTo(ytcv.state.currentGain, calcGain(STABLE_DB, -18)),
      `the archive plays at the stable rendition's gain (${ytcv.state.currentGain})`);
    assert(closeTo(mockStorage['channelVolumes']['UCrendition'].gainLive, calcGain(PLAIN_DB, -18)),
      `and stores the plain rendition's (${mockStorage['channelVolumes']['UCrendition'].gainLive})`);
    assert(mockStorage['channelVolumes']['UCrendition'].gainLivePlain === true,
      'marked as held against it');

    // On air there is neither a level nor a stable rendition.
    setURL('/watch', 'ONAIRSTB001');
    ytcv._set('_lastVideoId', 'ONAIRSTB001');
    ytcv._set('currentChannelVideoId', 'ONAIRSTB001');
    await bridgeSays('UCrendition', 'ONAIRSTB001', {
      isLiveContent: true, isLiveNow: true, loudnessDb: null, baseLoudnessDb: null
    });
    assert(closeTo(ytcv.state.currentGain, calcGain(PLAIN_DB, -18)),
      `the stream on air plays the stored gain as it is (${ytcv.state.currentGain})`);
  }

  section('Stable volume: a stored gain is carried to the rendition playing');
  {
    enterVideo('UCcarried', 'CARRIEDVID1', 'video', { name: 'Carried Ch', gainVideo: 2.0, gainVideoPlain: true, autoApplyLoudnessVideo: false });
    await bridgeSays('UCcarried', 'CARRIEDVID1', { loudnessDb: STABLE_DB, baseLoudnessDb: PLAIN_DB });
    const ratio = renditionGainRatio(STABLE_DB, PLAIN_DB);
    assert(closeTo(ytcv.state.currentGain, 2.0 * ratio),
      `the stable rendition plays the stored gain less what it raised (${ytcv.state.currentGain})`);
    assert(mockStorage['channelVolumes']['UCcarried'].gainVideo === 2.0,
      'playing it stores nothing');

    await bridgeSays('UCcarried', 'CARRIEDVID1', { loudnessDb: PLAIN_DB, baseLoudnessDb: PLAIN_DB, source: 'audio-change' });
    assert(closeTo(ytcv.state.currentGain, 2.0),
      `the plain rendition plays it as it is (${ytcv.state.currentGain})`);

    // Stored from another tab, it is carried the same way.
    await bridgeSays('UCcarried', 'CARRIEDVID1', { loudnessDb: STABLE_DB, baseLoudnessDb: PLAIN_DB, source: 'audio-change' });
    simulateStorageChange({
      channelVolumes: { newValue: { UCcarried: { name: 'Carried Ch', gainVideo: 3.0, gainVideoPlain: true, autoApplyLoudnessVideo: false } } }
    });
    assert(closeTo(ytcv.state.currentGain, 3.0 * ratio),
      `a gain another tab stored is carried too (${ytcv.state.currentGain})`);
    simulateStorageChange({
      channelVolumes: { newValue: { UCcarried: { name: 'Carried Ch', gainVideo: 3.0, autoApplyLoudnessVideo: false } } }
    });
    assert(ytcv.state.currentGain === 3.0,
      `and one stored without the mark plays as it is (${ytcv.state.currentGain})`);
  }

  section('Stable volume: a gain stored before the mark plays as it did');
  {
    enterVideo('UCunmarked', 'UNMARKEDVD1', 'video', { name: 'Unmarked Ch', gainVideo: 2.0, autoApplyLoudnessVideo: false });
    await bridgeSays('UCunmarked', 'UNMARKEDVD1', { loudnessDb: STABLE_DB, baseLoudnessDb: PLAIN_DB });
    assert(ytcv.state.currentGain === 2.0,
      `the stable rendition plays it unchanged (${ytcv.state.currentGain})`);
    await bridgeSays('UCunmarked', 'UNMARKEDVD1', { loudnessDb: PLAIN_DB, baseLoudnessDb: PLAIN_DB, source: 'audio-change' });
    assert(ytcv.state.currentGain === 2.0, `and so does the plain one (${ytcv.state.currentGain})`);

    // Chosen again on the stable rendition, it is stored marked from then on.
    await bridgeSays('UCunmarked', 'UNMARKEDVD1', { loudnessDb: STABLE_DB, baseLoudnessDb: PLAIN_DB, source: 'audio-change' });
    const set = await popupGesture({ type: 'setGain', channelId: 'UCunmarked', gain: 0.5 });
    const stored = mockStorage['channelVolumes']['UCunmarked'];
    assert(set?.ok === true && stored.gainVideoPlain === true &&
      closeTo(stored.gainVideo, 0.5 / renditionGainRatio(STABLE_DB, PLAIN_DB)),
      `a manual save stores it marked, against the plain rendition (${JSON.stringify(stored)})`);
    assert(ytcv.state.currentGain === 0.5, `and plays the level chosen (${ytcv.state.currentGain})`);
    assert(!('gainLivePlain' in stored), 'the other type is left as it was');
  }

  section('Stable volume: a manual gain is stored against the plain rendition');
  {
    enterVideo('UCmanualStb', 'MANUALSTB01', 'video', { name: 'Manual Stable Ch', gainVideo: 1.5, gainVideoPlain: true, autoApplyLoudnessVideo: false });
    await bridgeSays('UCmanualStb', 'MANUALSTB01', { loudnessDb: STABLE_DB, baseLoudnessDb: PLAIN_DB });
    const ratio = renditionGainRatio(STABLE_DB, PLAIN_DB);

    const set = await popupGesture({ type: 'setGain', channelId: 'UCmanualStb', gain: 0.5 });
    assert(set?.ok === true, `the slider's save succeeds (${JSON.stringify(set)})`);
    assert(ytcv.state.currentGain === 0.5, `the level heard is the one chosen (${ytcv.state.currentGain})`);
    assert(closeTo(mockStorage['channelVolumes']['UCmanualStb'].gainVideo, 0.5 / ratio),
      `and it is stored as the plain rendition's (${mockStorage['channelVolumes']['UCmanualStb'].gainVideo})`);
    await ytcv.applyPreferredGain();
    assert(closeTo(ytcv.state.currentGain, 0.5),
      `read back, it plays at the level chosen (${ytcv.state.currentGain})`);

    // The plain rendition's gain for 200% here passes 600%: it is stored at 600%.
    const loud = await popupGesture({ type: 'setGain', channelId: 'UCmanualStb', gain: 2.0 });
    assert(loud?.ok === true && 2.0 / ratio > 6, `a gain whose plain rendition's passes 600% saves (${JSON.stringify(loud)})`);
    assert(mockStorage['channelVolumes']['UCmanualStb'].gainVideo === 6,
      `and is stored at 600% (${mockStorage['channelVolumes']['UCmanualStb'].gainVideo})`);

    const applied = await popupGesture({ type: 'applyLoudness' });
    assert(applied?.ok === true && closeTo(applied?.gain, calcGain(STABLE_DB, -18)),
      `"Apply to channel" plays the stable rendition's gain (${JSON.stringify(applied)})`);
    assert(closeTo(mockStorage['channelVolumes']['UCmanualStb'].gainVideo, calcGain(PLAIN_DB, -18)),
      `and stores the plain rendition's (${mockStorage['channelVolumes']['UCmanualStb'].gainVideo})`);
    assert(mockStorage['channelVolumes']['UCmanualStb'].gainVideoPlain === true, 'marked');
  }

  section('Stable volume: a gain chosen on air is stored to play as it is');
  {
    // On air there is no level, so the plain rendition's is not known either.
    enterVideo('UConAir', 'ONAIRMANUAL', 'live', { name: 'On Air Ch', autoApplyLoudnessLive: false });
    await bridgeSays('UConAir', 'ONAIRMANUAL', { isLiveContent: true, isLiveNow: true, loudnessDb: null, baseLoudnessDb: null });
    const set = await popupGesture({ type: 'setGain', channelId: 'UConAir', gain: 2.0 });
    const stored = mockStorage['channelVolumes']['UConAir'];
    assert(set?.ok === true && stored.gainLive === 2.0 && !('gainLivePlain' in stored),
      `the gain is stored as chosen, unmarked (${JSON.stringify(stored)})`);
    await ytcv.applyPreferredGain();
    assert(ytcv.state.currentGain === 2.0, `read back on air, it plays as chosen (${ytcv.state.currentGain})`);

    // The archive of the same channel, on either rendition.
    setURL('/watch', 'ARCHIVEAIR1');
    ytcv._set('currentChannelVideoId', 'ARCHIVEAIR1');
    await bridgeSays('UConAir', 'ARCHIVEAIR1', { isLiveContent: true, loudnessDb: STABLE_DB, baseLoudnessDb: PLAIN_DB });
    assert(ytcv.state.currentGain === 2.0, `an archive on the stable rendition plays it as it is (${ytcv.state.currentGain})`);
    await bridgeSays('UConAir', 'ARCHIVEAIR1', { isLiveContent: true, loudnessDb: PLAIN_DB, baseLoudnessDb: PLAIN_DB, source: 'audio-change' });
    assert(ytcv.state.currentGain === 2.0, `and on the plain one (${ytcv.state.currentGain})`);

    // Another tab stores it the same way; this tab plays it as it is.
    await bridgeSays('UConAir', 'ARCHIVEAIR1', { isLiveContent: true, loudnessDb: STABLE_DB, baseLoudnessDb: PLAIN_DB, source: 'audio-change' });
    simulateStorageChange({ channelVolumes: { newValue: { UConAir: { ...stored, gainLive: 1.5 } } } });
    assert(ytcv.state.currentGain === 1.5, `a gain another tab stored on air plays as it is here (${ytcv.state.currentGain})`);

    // Chosen again where the plain level is known, it is marked and carried.
    const again = await popupGesture({ type: 'setGain', channelId: 'UConAir', gain: 0.5 });
    const marked = mockStorage['channelVolumes']['UConAir'];
    assert(again?.ok === true && marked.gainLivePlain === true &&
      closeTo(marked.gainLive, 0.5 / renditionGainRatio(STABLE_DB, PLAIN_DB)),
      `a gain chosen on the archive is marked and held against the plain rendition (${JSON.stringify(marked)})`);
    await bridgeSays('UConAir', 'ARCHIVEAIR1', { isLiveContent: true, loudnessDb: PLAIN_DB, baseLoudnessDb: PLAIN_DB, source: 'audio-change' });
    assert(closeTo(ytcv.state.currentGain, 0.5 / renditionGainRatio(STABLE_DB, PLAIN_DB)),
      `and the plain rendition plays it carried (${ytcv.state.currentGain})`);
  }

  section('Stable volume: a channel with no stored gain is left alone');
  {
    enterVideo('UCnothingStb', 'NOTHINGSTB1', 'video', null);
    ytcv._set('currentGain', 1.0);
    await bridgeSays('UCnothingStb', 'NOTHINGSTB1', { loudnessDb: STABLE_DB, baseLoudnessDb: PLAIN_DB });
    assert(ytcv.state.currentGain === 1.0,
      `the stable rendition does not move a gain nobody stored (${ytcv.state.currentGain})`);
  }

  section('Stable volume: with no base level the level playing stands in');
  {
    enterVideo('UCnoBase', 'NOBASESTB01', 'video', { name: 'No Base Ch', autoApplyLoudnessVideo: true });
    await bridgeSays('UCnoBase', 'NOBASESTB01', { loudnessDb: STABLE_DB });
    assert(closeTo(mockStorage['channelVolumes']['UCnoBase'].gainVideo, calcGain(STABLE_DB, -18)),
      `Auto stores the gain it plays (${mockStorage['channelVolumes']['UCnoBase'].gainVideo})`);
    assert(!('gainVideoPlain' in mockStorage['channelVolumes']['UCnoBase']),
      'unmarked, since no plain level was known');

    enterVideo('UCnanBase', 'NANBASESTB1', 'video', { name: 'NaN Base Ch', autoApplyLoudnessVideo: true });
    await bridgeSays('UCnanBase', 'NANBASESTB1', { loudnessDb: STABLE_DB, baseLoudnessDb: NaN });
    assert(closeTo(mockStorage['channelVolumes']['UCnanBase'].gainVideo, calcGain(STABLE_DB, -18)),
      `and a base that is not a number counts as none (${mockStorage['channelVolumes']['UCnanBase'].gainVideo})`);
  }

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
  const liveManualResponse = await popupGesture({
    type: 'setGainLive',
    gain: 3.0
  });
  assert(liveManualResponse?.ok === false,
    'real-time manual gain is rejected while detected loudness controls Auto');
  assert(ytcv.state.currentGain === detectedAutoGain,
    'rejected real-time gain does not replace the calculated Auto gain');
  const savedManualResponse = await popupGesture({
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
  ytcv._set('currentBaseLoudnessDb', -6);
  mockStorage['channelVolumes'] = {
    'UCrepeat': { name: 'Repeat Ch', gainVideo: 0.55, gainVideoPlain: true }
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
  // A gain stored before the mark existed is written once, to carry it.
  mockStorage['channelVolumes'] = { 'UCrepeat': { name: 'Repeat Ch', gainVideo: 0.55 } };
  await ytcv.saveChannelGain('UCrepeat', 'Repeat Ch', 0.55, 'video', '');
  assert(channelVolumeWrites === 2 && mockStorage['channelVolumes']['UCrepeat'].gainVideoPlain === true,
    `an unmarked gain is written once, marked (${channelVolumeWrites})`);
  await ytcv.saveChannelGain('UCrepeat', 'Repeat Ch', 0.55, 'video', '');
  assert(channelVolumeWrites === 2, `and then left alone (${channelVolumeWrites})`);
  chrome.storage.local.set = storageSetBeforeRepeat;
  ytcv._set('currentBaseLoudnessDb', null);

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
  mockSyncStorage['autoLoudnessSettings'] = {
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
  await popupGesture({
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
    { type: 'setGain', gain: 0.3 },
    { type: 'setGainLive', gain: 0.3 }
  ]) {
    // Made against the state in hand, so what refuses them is the throw and
    // not a state that has moved.
    const reply = await popupGesture(message);
    assert(reply?.ok === false && reply?.reason !== 'state moved',
      `${message.type} answers when the apply throws — got ${JSON.stringify(reply)}`);
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
  await popupGesture({ type: 'setGainLive', gain: 0.3 });
  assert(ytcv.state.currentGain === 0.3, 'the preview is playing');
  const rejectedSave = await popupGesture({
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
  mockSyncStorage = { autoLoudnessSettings: { targetLufs: -18, autoApplyLoudnessVideoDefault: true } };
  mockStorage = {
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
  mockSyncStorage = { autoLoudnessSettings: { targetLufs: -18, autoApplyLoudnessVideoDefault: true } };
  mockStorage = {
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
  mockSyncStorage = { autoLoudnessSettings: { targetLufs: -18, autoApplyLoudnessVideoDefault: true } };
  mockStorage = {
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
  mockSyncStorage = { autoLoudnessSettings: { targetLufs: -18, autoApplyLoudnessVideoDefault: true } };
  mockStorage = {
    channelVolumes: { 'UCshared': { name: 'Shared Ch', gainVideo: 0.5, url: '' } }
  };
  ytcv._set('currentChannel', { id: 'UCshared', name: 'Shared Ch', url: '' });
  ytcv._set('currentChannelVideoId', ytcv.getUrlVideoId());
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
  await popupGesture({ type: 'setGain', channelId: 'UCshared', gain: 0.7 });
  assert(mockStorage['channelVolumes']['UCshared'].autoApplyLoudnessVideo === true,
    'a save made after adopting the mark records Auto as on, not off');

  section('Legacy fold: the mark alone re-resolves this tab');
  mockSyncStorage = { autoLoudnessSettings: { targetLufs: -18, autoApplyLoudnessVideoDefault: true } };
  mockStorage = {
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
  const realGetForMutex = chrome.storage.sync.get;
  let settingsReads = 0;
  chrome.storage.sync.get = key => {
    if (key === 'autoLoudnessSettings') settingsReads++;
    return realGetForMutex(key);
  };
  await Promise.all([ytcv.triggerApply(), ytcv.triggerApply()]);
  chrome.storage.sync.get = realGetForMutex;
  assert(settingsReads === 1,
    'the second call is turned away instead of running a second apply');

  section('Legacy fold: a failed fold keeps the old rule instead of Auto');
  mockSyncStorage = { autoLoudnessSettings: { targetLufs: -18, autoApplyLoudnessVideoDefault: true } };
  mockStorage = {
    channelVolumes: { 'UCfoldfail': { name: 'Fold Fail', gainVideo: 0.5, url: '' } }
  };
  mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCfoldfail' };
  setURL('/watch', 'FOLDFAIL001');
  ytcv._set('currentChannel', { id: 'UCfoldfail', name: 'Fold Fail', url: '' });
  ytcv._set('currentChannelVideoId', ytcv.getUrlVideoId());
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
  ytcv._set('currentChannelVideoId', ytcv.getUrlVideoId());
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('currentAutoApplyLoudnessVideo', false);
  const storageSetBeforeFailure = chrome.storage.local.set;
  chrome.storage.local.set = () => Promise.reject(new Error('storage write failed'));
  const failedGain = await popupGesture({
    type: 'setGain', channelId: 'UCwritefail', gain: 0.3
  });
  assert(failedGain?.ok === false, 'a rejected manual save answers the popup instead of hanging');
  const failedToggle = await popupGesture({
    type: 'setAutoApplyLoudness', channelId: 'UCwritefail', videoType: 'video', enabled: true
  });
  assert(failedToggle?.ok === false, 'a rejected Auto toggle answers the popup instead of hanging');
  ytcv._set('currentLoudnessDb', -6);
  ytcv._set('targetLufs', -18);
  ytcv._set('currentAutoApplyLoudnessVideo', false);
  const failedApply = await popupGesture({ type: 'applyLoudness' });
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
  const failedApplyToggle = await popupGesture({
    type: 'setAutoApplyLoudness', channelId: 'UCwritefail', videoType: 'video', enabled: true
  });
  assert(failedApplyToggle?.ok === false,
    'a throw from the apply after the write still answers the popup');
  contestedCtx.createMediaElementSource = realCreateSource;
  mockVideoEl = videoBeforeThrow;
  ytcv._set('currentLoudnessDb', null);
  await popupGesture({
    type: 'setAutoApplyLoudness', channelId: 'UCwritefail', videoType: 'video', enabled: false
  });

  // One rejection must not poison the queue every later save runs through.
  const recovered = await popupGesture({
    type: 'setGain', channelId: 'UCwritefail', gain: 0.44
  });
  assert(recovered?.ok === true, 'the next save succeeds after a rejected write');
  assert(mockStorage['channelVolumes']['UCwritefail'].gainVideo === 0.44,
    'the write queue survives a rejection');

  section('Auto LUFS defaults: an inherited Auto stays on after a manual save');
  mockStorage['channelVolumes'] = { 'UCinherit': { name: 'Inherit Ch' } };
  ytcv._set('currentChannel', { id: 'UCinherit', name: 'Inherit Ch', url: '' });
  ytcv._set('currentChannelVideoId', ytcv.getUrlVideoId());
  ytcv._set('currentVideoType', 'live');
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('defaultAutoApplyLoudnessLive', true);
  await ytcv.applyPreferredGain();
  assert(ytcv.state.currentAutoApplyLoudnessLive === true, 'the channel inherits Auto ON');
  // Auto is on but this live stream has no LUFS, so the slider is live and the
  // user adjusts the level Auto falls back to.
  await popupGesture({ type: 'setGain', channelId: 'UCinherit', gain: 0.55 });
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
  ytcv._set('currentGain', 0.5);
  await chrome.runtime.sendMessage({ type: 'store:deleteChannel', channelId: 'UCdeleted' });
  simulateStorageChange({
    channelVolumes: {
      oldValue: { UCdeleted: { name: 'Deleted Ch', gainVideo: 0.5 } },
      newValue: {}
    }
  });
  await tick();
  assert(!('UCdeleted' in mockStorage['channelVolumes']), 'the entry is gone');
  // The all-channel default covers this channel again the moment its own entry
  // is gone, and there is a measurement in hand, so Auto takes it over rather
  // than dropping to passthrough.
  assert(Math.abs(ytcv.state.currentGain - ytcv.calcGainFromLoudness(-6)) < 0.001,
    `the default takes the channel over at once (${ytcv.state.currentGain})`);
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
  mockSyncStorage = { autoLoudnessSettings: { targetLufs: -18 } };
  mockStorage = {
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
  mockSyncStorage = { autoLoudnessSettings: { targetLufs: -18 } };
  mockStorage = {
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
  mockSyncStorage = { autoLoudnessSettings: { targetLufs: -18, autoApplyLoudnessVideoDefault: true } };
  mockStorage = {
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
  mockSyncStorage = { autoLoudnessSettings: { targetLufs: -18, autoApplyLoudnessVideoDefault: true } };
  mockStorage = {
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
  delete mockSyncStorage['autoLoudnessSettings'];
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
  ytcv._set('_lastVideoId', 'NAVIGATE001');
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
  mockDOMElements['metaChannel'] = { content: '@meta_handle' };
  const chMetaHandle = ytcv.detectChannel();
  assert(chMetaHandle.id === '', `a meta tag outside the UC form names no channel (${chMetaHandle.id})`);
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
  ytcv._set('currentChannelVideoId', ytcv.getUrlVideoId());
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentLoudnessDb', null);
  mockDOMElements['channelName'] = { textContent: 'Stale Channel A' };
  const toggleResponse = await popupGesture({
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
  ytcv._set('currentChannelVideoId', ytcv.getUrlVideoId());
  mockDOMElements['channelName'] = { textContent: 'Channel C' };
  const stubToggleResponse = await popupGesture({
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
  ytcv._set('_lastVideoId', 'BACKFILL001');
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

  section('Bridge message: on a channel\'s live URL, the video the canonical link names is compared');
  ytcv._set('currentChannel', { id: '', name: '', url: '' });
  ytcv._set('currentChannelVideoId', '');
  ytcv._set('currentLoudnessVideoId', '');
  ytcv._set('currentLoudnessDb', null);
  setURL('/@liveHandle/live', null);
  mockDOMElements['canonical'] = { href: 'https://www.youtube.com/watch?v=cHaNnElLiV1' };
  simulateBridgeMessage({
    loudnessDb: -7, isLiveContent: true, isLiveNow: true,
    videoId: 'zZzZzZzZzZz', channelId: 'UCstale', author: 'Stale Ch'
  });
  await tick();
  assert(ytcv.state.currentLoudnessDb === null && ytcv.state.currentChannel.id === '',
    `an answer queued for another video is dropped (${ytcv.state.currentLoudnessDb} / ${ytcv.state.currentChannel.id})`);
  simulateBridgeMessage({
    loudnessDb: -7, isLiveContent: true, isLiveNow: true,
    videoId: 'cHaNnElLiV1', channelId: 'UCchLive', author: 'Channel Live'
  });
  await tick();
  assert(ytcv.state.currentLoudnessDb === -7 && ytcv.state.currentChannel.id === 'UCchLive',
    `the answer for the stream the page shows is taken (${ytcv.state.currentLoudnessDb} / ${ytcv.state.currentChannel.id})`);
  mockDOMElements['canonical'] = null;

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

  // A script in the page's own world can post the bridge's message as well as
  // the bridge can. What it carries becomes state, and through Auto's save a
  // stored entry, only where each field is of the type the bridge sends.
  section('Bridge message: a field of the wrong type is not taken');
  mockStorage['channelVolumes'] = {
    '@typed_handle': { name: 'Typed Handle', gainVideo: 0.4 }
  };
  setURL('/watch', 'typedVid1');
  ytcv._set('_lastVideoId', 'typedVid1');
  ytcv._set('currentChannel', { id: 'UCtyped', name: 'Typed', url: 'https://www.youtube.com/channel/UCtyped' });
  ytcv._set('currentChannelVideoId', 'typedVid1');
  ytcv._set('currentLoudnessDb', null);
  ytcv._set('currentLoudnessVideoId', '');
  ytcv._set('currentVideoType', 'video');
  ytcv._set('currentAutoApplyLoudnessVideo', false);
  ytcv._set('targetLufs', -18);
  ytcv._set('defaultAutoApplyLoudnessVideo', true);

  simulateBridgeMessage({
    videoId: 'typedVid1', loudnessDb: '5', isLiveContent: false, channelId: 'UCtyped', author: 'Typed'
  });
  await tick();
  assert(ytcv.state.currentLoudnessDb === null,
    `a level that is not a number is not a level (${JSON.stringify(ytcv.state.currentLoudnessDb)})`);
  assert(ytcv.getState().contentLufs === null,
    `and the popup is given none (${JSON.stringify(ytcv.getState().contentLufs)})`);

  simulateBridgeMessage({
    videoId: 'typedVid1', loudnessDb: -6, isLiveContent: false, channelId: 'UCtyped', author: { not: 'text' }
  });
  await tick();
  await tick();
  assert(typeof ytcv.state.currentChannel.name === 'string',
    `an author that is not text does not name the channel (${JSON.stringify(ytcv.state.currentChannel.name)})`);
  assert(typeof mockStorage['channelVolumes']['UCtyped']?.name === 'string',
    `and Auto's save does not store it as the name (${JSON.stringify(mockStorage['channelVolumes']['UCtyped'])})`);

  simulateBridgeMessage({
    videoId: 'typedVid1', loudnessDb: -6, isLiveContent: false, channelId: 'UC"><b>', author: 'Typed Handle'
  });
  await tick();
  await tick();
  assert(ytcv.state.currentChannel.id === 'UCtyped',
    `a channel id outside the UC form names no channel (${ytcv.state.currentChannel.id})`);
  assert(!Object.keys(mockStorage['channelVolumes']).some((key) => key.includes('<')),
    `and nothing is stored under it (${Object.keys(mockStorage['channelVolumes'])})`);
  assert(mockStorage['channelVolumes']['@typed_handle']?.gainVideo === 0.4,
    'and no handle entry is moved to it');

  let threwOnChannelId = null;
  try {
    simulateBridgeMessage({
      videoId: 'typedVid1', loudnessDb: -6, isLiveContent: false, channelId: 42, author: 'Typed'
    });
  } catch (err) {
    threwOnChannelId = err;
  }
  await tick();
  assert(threwOnChannelId === null,
    `a channel id that is not text is turned away rather than thrown on (${threwOnChannelId && threwOnChannelId.message})`);

  ytcv._set('currentLoudnessDb', null);
  simulateBridgeMessage({
    videoId: 'typedVid1', loudnessDb: null, isLiveContent: 'yes', channelId: 'UCother_typed', author: 'Other'
  });
  await tick();
  assert(ytcv.state.currentVideoType === 'video',
    `a live flag that is not a boolean does not set the type (${ytcv.state.currentVideoType})`);
  assert(ytcv.state.currentChannel.id === 'UCtyped',
    `and a message carrying nothing else names no channel (${ytcv.state.currentChannel.id})`);
  ytcv._set('defaultAutoApplyLoudnessVideo', false);
  ytcv._set('currentLoudnessDb', null);

  // The worker is the one place every channel write passes through, and it
  // answers a message that does not describe a channel as refused.
  section('Worker: a channel write that does not describe a channel is refused');
  mockStorage['channelVolumes'] = {
    UCkept: { name: 'Kept', gainVideo: 0.5 },
    '@kept_handle': { name: 'Kept Handle', gainVideo: 0.7 }
  };
  const keptBefore = JSON.stringify(mockStorage['channelVolumes']);
  const refusedWrites = [
    { type: 'store:saveChannelGain', channelId: 'UCkept', name: 'Kept', gain: 'loud', videoType: 'video', url: '' },
    { type: 'store:saveChannelGain', channelId: 'UCkept', name: 'Kept', gain: NaN, videoType: 'video', url: '' },
    { type: 'store:saveChannelGain', channelId: '__proto__', name: 'Kept', gain: 0.9, videoType: 'video', url: '' },
    { type: 'store:saveChannelGain', channelId: 'UCkept', name: 'Kept', gain: 0.9, videoType: 'video', url: 7 },
    { type: 'store:saveChannelAutoApply', channelId: '@kept_handle', name: 'Kept', enabled: true, videoType: 'video', url: '' },
    { type: 'store:adoptHandleEntry', channelId: 'UC"><b>', authorName: 'Kept Handle', url: '' },
    { type: 'store:adoptHandleEntry', channelId: 'UCadopter', authorName: { not: 'text' }, url: '' },
    { type: 'store:deleteChannel' },
    { type: 'store:deleteChannel', channelId: '' },
    { type: 'store:deleteChannel', channelId: ['UCkept'] }
  ];
  for (const write of refusedWrites) {
    const answer = await chrome.runtime.sendMessage(write);
    assert(answer?.ok === false && answer?.reason === 'invalid-mutation',
      `${write.type} ${JSON.stringify(write)} is refused (${JSON.stringify(answer)})`);
  }
  assert(JSON.stringify(mockStorage['channelVolumes']) === keptBefore,
    `and none of them touches the map (${JSON.stringify(mockStorage['channelVolumes'])})`);
  // A name that is not text is dropped, not refused: the write lands and the
  // row keeps the name it has.
  const namelessWrites = [
    { type: 'store:saveChannelGain', channelId: 'UCkept', name: { not: 'text' }, gain: 0.8, videoType: 'video', url: '' },
    { type: 'store:saveChannelAutoApply', channelId: 'UCkept', name: 7, enabled: true, videoType: 'video', url: '' }
  ];
  for (const write of namelessWrites) {
    const answer = await chrome.runtime.sendMessage(write);
    assert(answer?.ok === true && mockStorage['channelVolumes']['UCkept'].name === 'Kept',
      `${write.type} ${JSON.stringify(write)} lands and keeps the name (${JSON.stringify(answer)}, ${JSON.stringify(mockStorage['channelVolumes']['UCkept'])})`);
  }
  assert(mockStorage['channelVolumes']['UCkept'].gainVideo === 0.8 && mockStorage['channelVolumes']['UCkept'].autoApplyLoudnessVideo === true,
    `and both of them land (${JSON.stringify(mockStorage['channelVolumes']['UCkept'])})`);
  const acceptedWrite = await chrome.runtime.sendMessage({
    type: 'store:saveChannelGain', channelId: 'UCkept', name: 'Kept', gain: 0.9, videoType: 'video', url: ''
  });
  assert(acceptedWrite?.ok === true && mockStorage['channelVolumes']['UCkept'].gainVideo === 0.9,
    `a write that describes a channel still lands (${JSON.stringify(acceptedWrite)})`);
  mockStorage['channelVolumes'] = {};

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
  ytcv._set('_lastVideoId', 'writeVid1');
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

  // ── What a write nobody asked for leaves behind ─────────────────────

  // Auto's save is made again by the next video, the next navigation and the
  // next apply, so the start of a stretch of failures is named at info, which
  // Chrome keeps out of the extension's error list, and the error is left for a
  // write that failed after another. reportFailure keeps the console clear
  // after an extension reload, which is the one cause of these failures that is
  // not worth reporting. The state it reads is the state at the failure, not at
  // the request: a save already in flight is what fails on the reload.
  section('A write nobody asked for: where a stretch of failures starts');
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
  const realConsoleInfo = console.info;
  const realSet = chrome.storage.local.set;
  let reported = [];
  let noted = [];
  // A FAIL of this suite goes to console.error, so the console is only taken
  // for the apply itself and given back before anything is asserted.
  const captureConsole = () => {
    console.error = (...args) => { reported.push(args[0]); };
    console.info = (...args) => { noted.push(args[0]); };
  };
  const releaseConsole = () => {
    console.error = realConsoleError;
    console.info = realConsoleInfo;
  };
  const applyWithConsoleTaken = async () => {
    captureConsole();
    await ytcv.applyPreferredGain();
    await tick();
    releaseConsole();
  };
  const refuseWrites = () => Promise.reject(new Error('storage write failed'));
  chrome.storage.local.set = refuseWrites;
  await applyWithConsoleTaken();
  // The service worker logs its own side of the same failure; content.js's is
  // the one this is about.
  const fromContent = () => reported.filter(m => String(m).includes('auto gain not stored'));
  const notedByContent = () => noted.filter(m => String(m).includes('auto gain not stored'));
  assert(notedByContent().length === 1,
    `the first failure on a live context is named (${JSON.stringify(noted)})`);
  assert(fromContent().length === 0,
    `and left where Chrome does not collect it (${JSON.stringify(reported)})`);

  section('A write nobody asked for: a stretch that a second write did not end');
  await applyWithConsoleTaken();
  assert(fromContent().length === 1,
    `a write that failed after another is reported (${JSON.stringify(reported)})`);
  await applyWithConsoleTaken();
  assert(fromContent().length === 1,
    `and the stretch is reported once, not per write (${JSON.stringify(reported)})`);
  assert(notedByContent().length === 1,
    `the stretch keeps the one line it started with (${JSON.stringify(noted)})`);

  section('A write nobody asked for: one that lands ends the stretch');
  chrome.storage.local.set = realSet;
  await applyWithConsoleTaken();
  reported = [];
  noted = [];
  // The worker skips a write that changes nothing, so the failing write that
  // follows carries a gain the entry does not already hold.
  ytcv._set('currentLoudnessDb', -12);
  chrome.storage.local.set = refuseWrites;
  await applyWithConsoleTaken();
  assert(notedByContent().length === 1 && fromContent().length === 0,
    `the next failure opens a stretch of its own (${JSON.stringify([noted, reported])})`);

  section('Extension reload: the failure it causes is named nowhere');
  const idBeforeReload = chrome.runtime.id;
  reported = [];
  noted = [];
  chrome.storage.local.set = () => {
    // The reload is what makes the write fail, so it is gone by the rejection.
    chrome.runtime.id = undefined;
    return Promise.reject(new Error('storage write failed'));
  };
  await applyWithConsoleTaken();
  chrome.runtime.id = idBeforeReload;
  chrome.storage.local.set = realSet;
  assert(fromContent().length === 0 && notedByContent().length === 0,
    `the same failure after a reload is named nowhere (${JSON.stringify([noted, reported])})`);

  // The bridge sends the handle adoption before Auto's own save, and on a
  // channel that already has its UC entry the worker writes nothing and answers
  // ok. Each label keeps a stretch of its own, so that answer does not stand in
  // for the save that keeps failing.
  section('A write nobody asked for: one label does not end another label\'s stretch');
  mockStorage['channelVolumes'] = {
    UCshared: {
      name: 'Shared Ch',
      autoApplyLoudnessVideo: true,
      url: 'https://www.youtube.com/channel/UCshared'
    }
  };
  setURL('/watch', 'sharedVid1');
  ytcv._set('currentChannel', { id: '', name: '', url: '' });
  ytcv._set('_lastVideoId', null);
  ytcv._set('appliedVideoId', 'sharedVid1');
  ytcv._set('_lastProcessedVideo', null);
  ytcv._set('storageMigrated', true);
  ytcv._set('storageReady', Promise.resolve());
  const bridgeMessageWithAuthor = async (loudnessDb) => {
    captureConsole();
    simulateBridgeMessage({
      loudnessDb, isLiveContent: false, channelId: 'UCshared', author: 'Shared Ch'
    });
    await tick();
    await tick();
    await tick();
    await tick();
    releaseConsole();
  };
  // A write that lands ends whatever stretch the cases above were left in, and
  // it stores a gain the failing writes that follow do not repeat (the worker
  // skips a write that changes nothing).
  chrome.storage.local.set = realSet;
  await bridgeMessageWithAuthor(-3);
  reported = [];
  noted = [];
  chrome.storage.local.set = refuseWrites;
  await bridgeMessageWithAuthor(-6);
  assert(notedByContent().length === 1 && fromContent().length === 0,
    `the first save failure is named at info (${JSON.stringify([noted, reported])})`);
  await bridgeMessageWithAuthor(-6);
  assert(fromContent().length === 1,
    `the save that failed after it is reported (${JSON.stringify(reported)})`);
  await bridgeMessageWithAuthor(-6);
  assert(fromContent().length === 1,
    `and that stretch is reported once (${JSON.stringify(reported)})`);
  const adoption = () => [...noted, ...reported]
    .filter(m => String(m).includes('handle entry not adopted'));
  assert(adoption().length === 0,
    `the adoption that wrote nothing is named nowhere (${JSON.stringify(adoption())})`);
  chrome.storage.local.set = realSet;

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

  section('Bridge: a page that will not let the assignment be hooked');
  {
    // The hook is wrapped in a catch, so a page that refuses it leaves the
    // bridge reading the property as it stands. Nothing it captured of its own
    // is there to fall back on, and the ask still has to be answered.
    const bridge = createBridge({ hookRefused: true });
    bridge.assign(playerResponse({ loudnessDb: -9.5, channelId: 'UCunhooked' }));

    await bridge.request();

    assert(bridge.last()?.loudnessDb === -9.5,
      `the ask is answered from the property the page wrote (${bridge.last()?.loudnessDb})`);
    assert(bridge.last()?.channelId === 'UCunhooked',
      `naming the channel it carries (${bridge.last()?.channelId})`);
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

  section('Bridge: a request that could not be made on a watch page stays out of the error list');
  {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
    const bridge = createBridge();
    const watch = bridge.watchUnhandledRejections();
    try {
      const handled = bridge.pageRejects('Failed to fetch');
      handled.catch(() => {});
      const pageOwn = bridge.pageRejects('Failed to fetch');
      bridge.failNextFetchInPage('TypeError', 'Failed to fetch');
      const noHandler = bridge.window.fetch('https://www.youtube.com/other');
      bridge.failNextFetchInPage('TypeError', 'Failed to fetch');
      const thenOnly = bridge.window.fetch('https://www.youtube.com/other').then((res) => res);
      bridge.failNextFetchInPage('TypeError', 'Failed to fetch');
      const awaited = (async () => { await bridge.window.fetch('https://www.youtube.com/other'); })();
      bridge.failNextFetchInPage('AbortError', 'signal is aborted without reason');
      const aborted = bridge.window.fetch('https://www.youtube.com/other');
      bridge.failNextFetchInPage('TypeError', 'something else');
      const otherTypeError = bridge.window.fetch('https://www.youtube.com/other');
      bridge.failNextFetchInPage('TypeError', 'Failed to fetch');
      const madeHereFailedAway = bridge.window.fetch('https://www.youtube.com/other');
      bridge.setUrl('/feed/subscriptions', '');
      await settle();
      await settle();

      assert(same(watch.reportedFor(handled), []), 'a promise with a handler is not reported at all');
      assert(same(watch.reportedFor(pageOwn), [false]),
        'the same TypeError from a promise the page rejected itself is reported and left as it is');
      assert(same(watch.reportedFor(noHandler), [true]),
        'a request the page left with no handler is reported, with its default prevented');
      assert(same(watch.reportedFor(thenOnly), [true]), 'and so is the promise a then made from it');
      assert(same(watch.reportedFor(awaited), [true]), 'and the promise of an async function that awaited it');
      assert(same(watch.reportedFor(aborted), [false]), 'an aborted request is reported and left as it is');
      assert(same(watch.reportedFor(otherTypeError), [false]), 'so is a request that failed with another TypeError');
      assert(same(watch.reportedFor(madeHereFailedAway), [true]),
        'a request made on the watch page is quietened when it fails after the page left');
    } finally {
      watch.stop();
    }
  }

  section('Bridge: a request made off a watch page is left as it is');
  {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
    const bridge = createBridge({ pathname: '/feed/subscriptions' });
    const watch = bridge.watchUnhandledRejections();
    try {
      bridge.failNextFetchInPage('TypeError', 'Failed to fetch');
      const offPage = bridge.window.fetch('https://www.youtube.com/other');
      bridge.failNextFetchInPage('TypeError', 'Failed to fetch');
      const madeAwayFailedHere = bridge.window.fetch('https://www.youtube.com/other');
      bridge.setUrl('/watch', 'urlVideoIdA');
      await settle();
      await settle();
      assert(same(watch.reportedFor(offPage), [false]), 'a request made on another page is reported and left as it is');
      assert(same(watch.reportedFor(madeAwayFailedHere), [false]),
        'and so is one made before the page reached a watch page');
    } finally {
      watch.stop();
    }

    const handedBack = createBridge();
    handedBack.failNextFetchInPage('TypeError', 'Failed to fetch');
    const call = await handedBack.fetchPlayer(playerResponse(), 'https://www.youtube.com/other');
    assert(call.returned === call.fromNetwork, 'the page is handed the promise the network gave');
    let caught = null;
    await Promise.resolve(call.returned).catch((err) => { caught = err; });
    assert(caught === handedBack.lastFetchFailure(), 'and it rejects with the reason the network gave');
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

  section('Bridge: a channel\'s live URL is a watch page, and the canonical link names the stream');
  {
    const bridge = createBridge();
    bridge.setUrl('/@liveHandle/live', null);
    bridge.setCanonical('https://www.youtube.com/watch?v=urlVideoIdA');
    bridge.assign(playerResponse({ videoId: 'urlVideoIdA' }));
    assert(bridge.posted.length === 1 && bridge.last()?.videoId === 'urlVideoIdA',
      `the assignment is read, for the stream the link names (${bridge.posted.length} / ${bridge.last()?.videoId})`);
    await bridge.fetchPlayer(playerResponse({ videoId: 'someOtherId' }));
    assert(bridge.posted.length === 1,
      `an answer for another programme is not passed on (${bridge.posted.length})`);

    // The player's own level is taken only while its stats name that stream.
    const pr = playerResponse({ videoId: 'urlVideoIdA' });
    const stats = { volume: '100%/95% (cont.-13.6dB tgt.-14.0dB)', codecs: 'av01.0.04M.08 (397) / opus (251)' };
    bridge.setMoviePlayer(pr, {
      getStatsForNerds: () => ({ ...stats, video_id_and_cpn: 'urlVideoIdA / JHCF WP0H HBKP KJCD 1DSG' })
    });
    await bridge.request();
    assert(Math.abs(bridge.last()?.loudnessDb - 0.4) < 1e-9 && bridge.last()?.videoId === 'urlVideoIdA',
      `the stats line naming the stream gives the level played (${bridge.last()?.loudnessDb})`);

    const offAir = createBridge();
    offAir.setUrl('/@liveHandle/live', null);
    offAir.setCanonical('https://www.youtube.com/channel/UCliveHandle');
    offAir.assign(playerResponse({ videoId: 'urlVideoIdA' }));
    assert(offAir.posted.length === 0,
      `with nothing on air or coming the page is the channel's, and nothing is passed on (${offAir.posted.length})`);
  }

  section('Bridge: the level it reads when the first field is absent');
  {
    const bridge = createBridge();
    // perceptualLoudnessDb is read as an absolute level, put against the target.
    const perceptual = playerResponse();
    delete perceptual.playerConfig.audioConfig.loudnessDb;
    perceptual.playerConfig.audioConfig.perceptualLoudnessDb = -26.5;
    bridge.assign(perceptual);
    assert(bridge.last()?.loudnessDb === -12.5,
      `the second field stands in for the first, against the target (${bridge.last()?.loudnessDb})`);

    const untargeted = playerResponse({ loudnessTargetLkfs: null });
    delete untargeted.playerConfig.audioConfig.loudnessDb;
    untargeted.playerConfig.audioConfig.perceptualLoudnessDb = -26.5;
    bridge.assign(untargeted);
    assert(bridge.last()?.loudnessDb === null,
      `and with no target to put it against, there is no level (${bridge.last()?.loudnessDb})`);

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

  // ── Stable volume: the level of the rendition the player plays ─────

  const DRC_PREF = 'yt-player-drc-pref';
  const storedPref = (data, expiration = 1822019732480) =>
    JSON.stringify({ data: String(data), expiration, creation: 1790483732480 });

  section('Stable volume: a setting nothing answers for is taken as on');
  {
    // At load the player is not there yet and a viewer who never touched the
    // setting has nothing stored; the player plays the stable rendition then.
    const bridge = createBridge();
    bridge.assign(playerResponse({ loudnessDb: -12.39, drcLoudnessDb: -0.33 }));
    assert(bridge.last()?.loudnessDb === -0.33,
      `the level is the stable rendition's (${bridge.last()?.loudnessDb})`);
  }

  section('Stable volume: the setting the player stored decides it before the player is there');
  {
    const off = createBridge({ stored: { [DRC_PREF]: storedPref(0) } });
    off.assign(playerResponse({ loudnessDb: -12.39, drcLoudnessDb: -0.33 }));
    assert(off.last()?.loudnessDb === -12.39,
      `stored off, the level is the plain rendition's (${off.last()?.loudnessDb})`);

    const on = createBridge({ stored: { [DRC_PREF]: storedPref(1) } });
    on.assign(playerResponse({ loudnessDb: -12.39, drcLoudnessDb: -0.33 }));
    assert(on.last()?.loudnessDb === -0.33,
      `stored on, the stable rendition's (${on.last()?.loudnessDb})`);

    // The player drops an entry past its expiration and falls back to on.
    const lapsed = createBridge({ stored: { [DRC_PREF]: storedPref(0, 1) } });
    lapsed.assign(playerResponse({ loudnessDb: -12.39, drcLoudnessDb: -0.33 }));
    assert(lapsed.last()?.loudnessDb === -0.33,
      `an expired entry counts for nothing (${lapsed.last()?.loudnessDb})`);

    const garbled = createBridge({ stored: { [DRC_PREF]: '{not json' } });
    garbled.assign(playerResponse({ loudnessDb: -12.39, drcLoudnessDb: -0.33 }));
    assert(garbled.last()?.loudnessDb === -0.33,
      `nor does one that cannot be read (${garbled.last()?.loudnessDb})`);

    const unknown = createBridge({ stored: { [DRC_PREF]: storedPref(2) } });
    unknown.assign(playerResponse({ loudnessDb: -12.39, drcLoudnessDb: -0.33 }));
    assert(unknown.last()?.loudnessDb === -0.33,
      `nor one holding neither 0 nor 1 (${unknown.last()?.loudnessDb})`);
  }

  section('Stable volume: the player\'s own setting comes before what it stored');
  {
    const bridge = createBridge({ stored: { [DRC_PREF]: storedPref(1) } });
    const pr = playerResponse({ loudnessDb: -12.39, drcLoudnessDb: -0.33 });
    bridge.assign(pr);
    bridge.setMoviePlayer(pr, { getDrcUserPreference: () => 0 });
    await bridge.request();
    assert(bridge.last()?.loudnessDb === -12.39,
      `the player says off, and the plain rendition's level is answered (${bridge.last()?.loudnessDb})`);

    const odd = createBridge({ stored: { [DRC_PREF]: storedPref(0) } });
    odd.assign(pr);
    odd.setMoviePlayer(pr, { getDrcUserPreference: () => 'on' });
    await odd.request();
    assert(odd.last()?.loudnessDb === -12.39,
      `an answer from the player that is neither 0 nor 1 leaves it to the stored one (${odd.last()?.loudnessDb})`);

    const unset = createBridge();
    unset.assign(pr);
    unset.setMoviePlayer(pr, { getDrcUserPreference: () => 2 });
    await unset.request();
    assert(unset.last()?.loudnessDb === -0.33,
      `and with nothing stored, to the default (${unset.last()?.loudnessDb})`);
  }

  section('Stable volume: a video with no stable rendition keeps its plain level');
  {
    const bridge = createBridge({ stored: { [DRC_PREF]: storedPref(1) } });
    bridge.assign(playerResponse({ loudnessDb: -12.39 }));
    assert(bridge.last()?.loudnessDb === -12.39,
      `the setting is on and there is nothing to switch to (${bridge.last()?.loudnessDb})`);

    const levelless = createBridge();
    const pr = playerResponse({ loudnessDb: -12.39 });
    pr.streamingData = { adaptiveFormats: [{ itag: 251, isDrc: true }] };
    levelless.assign(pr);
    assert(levelless.last()?.loudnessDb === -12.39,
      `nor where the stable rendition carries no level (${levelless.last()?.loudnessDb})`);
  }

  section('Stable volume: turning it over mid-video answers again');
  {
    const bridge = createBridge();
    const pr = playerResponse({ loudnessDb: -12.39, drcLoudnessDb: -0.33 });
    bridge.assign(pr);
    let preference = 1;
    bridge.setMoviePlayer(pr, { getDrcUserPreference: () => preference });
    await bridge.request();
    await bridge.request();
    assert(bridge.playerListenerCount('onPlaybackAudioChange') === 1,
      `the player is listened to once however often it is asked (${bridge.playerListenerCount('onPlaybackAudioChange')})`);
    assert(bridge.last()?.loudnessDb === -0.33, `on, the stable level (${bridge.last()?.loudnessDb})`);

    const before = bridge.posted.length;
    preference = 0;
    await bridge.playerAnnounces('onPlaybackAudioChange');
    assert(bridge.posted.length === before + 1,
      `the change is answered once (${bridge.posted.length - before})`);
    assert(bridge.last()?.loudnessDb === -12.39 && bridge.last()?.source === 'audio-change',
      `with the plain level, saying why (${bridge.last()?.loudnessDb} / ${bridge.last()?.source})`);
    assert(bridge.last()?.videoId === 'urlVideoIdA' && bridge.last()?.channelId === 'UCbridge',
      `for the video and channel the page is on (${bridge.last()?.videoId} / ${bridge.last()?.channelId})`);

    preference = 1;
    await bridge.playerAnnounces('onPlaybackAudioChange');
    assert(bridge.last()?.loudnessDb === -0.33, `and back again (${bridge.last()?.loudnessDb})`);

    const left = bridge.posted.length;
    bridge.setUrl('/results', '');
    await bridge.playerAnnounces('onPlaybackAudioChange');
    assert(bridge.posted.length === left,
      `off a watch page the announcement is left alone (${bridge.posted.length - left})`);
  }

  // ── The level the player names for what it plays ───────────────────

  // The player's stats-for-nerds, as it answers for the video in the URL once
  // it has chosen its formats. Before it has, `codecs` is empty and `cont.` is
  // the response's own level.
  const statsFor = (volume, { id = 'urlVideoIdA', codecs = 'av01.0.04M.08 (397) / opus (251)' } = {}) =>
    ({ volume, video_id_and_cpn: `${id} / JHCF WP0H HBKP KJCD 1DSG`, codecs });
  const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

  section('Playing level: the player\'s own level takes over from the response');
  {
    // A dubbed track the response does not describe: its level comes from the
    // player alone.
    const bridge = createBridge();
    const pr = playerResponse({ loudnessDb: 6.96, drcLoudnessDb: 0 });
    bridge.assign(pr);
    bridge.setMoviePlayer(pr, { getStatsForNerds: () => statsFor('100%/95% (cont.-13.6dB tgt.-14.0dB)') });
    await bridge.request();
    assert(near(bridge.last()?.loudnessDb, 0.4),
      `the level is the player's, against the target (${bridge.last()?.loudnessDb})`);

    const drc = createBridge();
    const drcPr = playerResponse({ loudnessDb: -12.39, drcLoudnessDb: -0.33 });
    drc.assign(drcPr);
    drc.setMoviePlayer(drcPr, {
      getDrcUserPreference: () => 0,
      getStatsForNerds: () => statsFor('100%/100% DRC (cont.-14.3dB tgt.-14.0dB)')
    });
    await drc.request();
    assert(near(drc.last()?.loudnessDb, -0.3),
      `and it wins over the setting where the two disagree (${drc.last()?.loudnessDb})`);
  }

  section('Playing level: a named level a rendition rounds to is taken as the response gives it');
  {
    const described = () => {
      const pr = playerResponse({ loudnessDb: -12.389999 });
      pr.playerConfig.audioConfig.trackAbsoluteLoudnessLkfs = -26.389999;
      pr.streamingData = { adaptiveFormats: [
        { itag: 251, loudnessDb: -12.389999, trackAbsoluteLoudnessLkfs: -26.389999 },
        { itag: 251, isDrc: true, loudnessDb: -0.32999992, trackAbsoluteLoudnessLkfs: -14.33 }
      ] };
      return pr;
    };
    const answerFor = async (volume, pr = described()) => {
      const bridge = createBridge({ manualTimers: true });
      bridge.assign(pr);
      bridge.setMoviePlayer(pr, { getStatsForNerds: () => statsFor(volume) });
      await bridge.request();
      return bridge.last();
    };

    const plain = await answerFor('100%/100% (cont.-26.4dB tgt.-14.0dB)');
    assert(plain?.loudnessDb === -12.389999 && plain?.baseLoudnessDb === -12.389999,
      `the plain rendition's level, exactly, and so the same as the base (${plain?.loudnessDb} / ${plain?.baseLoudnessDb})`);
    const stable = await answerFor('100%/100% DRC (cont.-14.3dB tgt.-14.0dB)');
    assert(stable?.loudnessDb === -0.32999992, `the stable rendition's, exactly (${stable?.loudnessDb})`);

    const unlisted = await answerFor('100%/100% (cont.-20.0dB tgt.-14.0dB)');
    assert(near(unlisted?.loudnessDb, -6), `a level no rendition rounds to is taken as named (${unlisted?.loudnessDb})`);

    // Two renditions round to the one level and disagree below it.
    const split = described();
    split.streamingData.adaptiveFormats.push(
      { itag: 140, loudnessDb: 0.43000031, trackAbsoluteLoudnessLkfs: -13.57 },
      { itag: 140, loudnessDb: 0.39000034, trackAbsoluteLoudnessLkfs: -13.61 }
    );
    const either = await answerFor('100%/95% (cont.-13.6dB tgt.-14.0dB)', split);
    assert(near(either?.loudnessDb, 0.4), `renditions that disagree leave the named level (${either?.loudnessDb})`);

    // A rendition with no absolute level cannot be matched.
    const bare = described();
    delete bare.streamingData.adaptiveFormats[1].trackAbsoluteLoudnessLkfs;
    const unmatched = await answerFor('100%/100% DRC (cont.-14.3dB tgt.-14.0dB)', bare);
    assert(near(unmatched?.loudnessDb, -0.3), `a rendition with no absolute level is not matched (${unmatched?.loudnessDb})`);

    // A match needs no target to put it against: the rendition carries its level.
    const untargeted = described();
    delete untargeted.playerConfig.audioConfig.loudnessTargetLkfs;
    const matchedAlone = await answerFor('100%/100% DRC (cont.-14.3dB tgt.-14.0dB)', untargeted);
    assert(matchedAlone?.loudnessDb === -0.32999992, `a match stands without a target (${matchedAlone?.loudnessDb})`);

    // A response that describes no rendition at all: nothing to match, and no
    // target either.
    const bareResponse = playerResponse();
    delete bareResponse.playerConfig;
    const nothing = await answerFor('100%/100% DRC (cont.-14.3dB tgt.-14.0dB)', bareResponse);
    assert(nothing?.loudnessDb === null && nothing?.source === 'request',
      `a response with no player config is answered, with no level (${nothing?.loudnessDb} / ${nothing?.source})`);

    // The player names this video's level, and nothing on the page answers
    // for this video.
    const alone = createBridge({ manualTimers: true });
    alone.setMoviePlayer(described(), {
      getPlayerResponse: () => null,
      getStatsForNerds: () => statsFor('100%/100% DRC (cont.-14.3dB tgt.-14.0dB)')
    });
    await alone.request();
    assert(alone.last()?.source === 'request' && alone.last()?.loudnessDb === null,
      `with no response for the video the ask is still answered, with no level (${alone.last()?.source} / ${alone.last()?.loudnessDb})`);
  }

  section('Playing level: a line the player has not settled is not taken');
  {
    const pr = playerResponse({ loudnessDb: -12.39, drcLoudnessDb: -0.33 });
    const cases = [
      ['before it names its formats', statsFor('100%/100% (cont.-26.4dB tgt.-14.0dB)', { codecs: '' })],
      ['for another video', statsFor('100%/100% (cont.-26.4dB tgt.-14.0dB)', { id: 'someOtherId' })],
      ['with no level in it, as on a live stream', statsFor('100%/100%')],
      ['when asking throws', () => { throw new Error('the player is gone'); }]
    ];
    for (const [what, stats] of cases) {
      const bridge = createBridge({ manualTimers: true });
      bridge.assign(pr);
      bridge.setMoviePlayer(pr, { getStatsForNerds: typeof stats === 'function' ? stats : () => stats });
      await bridge.request();
      assert(bridge.last()?.loudnessDb === -0.33,
        `${what}, the response's level is answered (${bridge.last()?.loudnessDb})`);
    }

    const untargeted = createBridge({ manualTimers: true });
    const noTarget = playerResponse({ loudnessDb: -12.39, drcLoudnessDb: -0.33, loudnessTargetLkfs: null });
    untargeted.assign(noTarget);
    untargeted.setMoviePlayer(noTarget, { getStatsForNerds: () => statsFor('100%/100% DRC (cont.-14.3dB tgt.-14.0dB)') });
    await untargeted.request();
    assert(untargeted.last()?.loudnessDb === -0.33,
      `a level with no target to put it against is not taken (${untargeted.last()?.loudnessDb})`);
    // The look the load started finds a level named and answers once more,
    // with the response's level, and looks no further.
    const before = untargeted.posted.length;
    await untargeted.runTimers();
    assert(untargeted.posted.length - before <= 1 && untargeted.last()?.loudnessDb === -0.33 && untargeted.pendingTimers() === 0,
      `and it is not waited for any further (${untargeted.posted.length - before} / ${untargeted.pendingTimers()})`);
  }

  section('Playing level: answered again once the player names it');
  {
    const bridge = createBridge({ manualTimers: true });
    const pr = playerResponse({ loudnessDb: 6.96, drcLoudnessDb: 0 });
    bridge.assign(pr);
    let stats = statsFor('100%/45% (cont.-7.0dB tgt.-14.0dB)', { codecs: '' });
    bridge.setMoviePlayer(pr, { getStatsForNerds: () => stats });
    await bridge.request();
    await bridge.request();
    assert(bridge.pendingTimers() === 1,
      `one look is pending however often it is asked (${bridge.pendingTimers()})`);

    const before = bridge.posted.length;
    const delays = await bridge.runTimers();
    assert(delays.length === 1 && delays[0] === 250, `looked at after 250 ms (${delays})`);
    assert(bridge.posted.length === before, `nothing is answered while it is unsettled (${bridge.posted.length - before})`);

    stats = statsFor('100%/95% (cont.-13.6dB tgt.-14.0dB)');
    await bridge.runTimers();
    assert(bridge.posted.length === before + 1, `answered once it is settled (${bridge.posted.length - before})`);
    assert(near(bridge.last()?.loudnessDb, 0.4) && bridge.last()?.source === 'playing',
      `with the player's level, saying why (${bridge.last()?.loudnessDb} / ${bridge.last()?.source})`);
    assert(bridge.pendingTimers() === 0, `and the looking stops (${bridge.pendingTimers()})`);
  }

  section('Playing level: no route answers the response over the player');
  {
    // The player has named what it plays; a response that arrives after that,
    // by any route and in any order, is answered with the player's level.
    const pr = playerResponse({ loudnessDb: -12.39, drcLoudnessDb: -0.33 });
    const routes = {
      define: (b) => b.assign(pr),
      fetch: (b) => b.fetchPlayer(pr),
      request: (b) => b.request(),
      'audio-change': (b) => b.playerAnnounces('onPlaybackAudioChange')
    };
    const orders = [
      ['request', 'fetch', 'define', 'audio-change'],
      ['audio-change', 'define', 'fetch', 'request'],
      ['fetch', 'audio-change', 'request', 'define'],
      ['define', 'request', 'audio-change', 'fetch']
    ];
    for (const order of orders) {
      const bridge = createBridge({ manualTimers: true });
      bridge.setMoviePlayer(pr, {
        getDrcUserPreference: () => 0,
        getStatsForNerds: () => statsFor('100%/95% (cont.-13.6dB tgt.-14.0dB)')
      });
      await bridge.request();
      const from = bridge.posted.length;
      for (const route of order) await routes[route](bridge);
      const answered = bridge.posted.slice(from);
      assert(answered.length === 4 && answered.every((m) => near(m.loudnessDb, 0.4) && m.baseLoudnessDb === -12.39),
        `${order.join(' → ')}: every answer is the player's level (${answered.map((m) => m.source + ' ' + m.loudnessDb).join(', ')})`);
    }

    // Turned over mid-video, a response that comes after the change is
    // answered with what the player plays after it.
    const bridge = createBridge({ manualTimers: true });
    bridge.assign(pr);
    let stats = statsFor('100%/100% DRC (cont.-14.3dB tgt.-14.0dB)');
    let preference = 1;
    bridge.setMoviePlayer(pr, { getDrcUserPreference: () => preference, getStatsForNerds: () => stats });
    await bridge.request();
    preference = 0;
    stats = statsFor('100%/100% (cont.-26.4dB tgt.-14.0dB)');
    await bridge.playerAnnounces('onPlaybackAudioChange');
    await bridge.fetchPlayer(playerResponse({ loudnessDb: -12.39, drcLoudnessDb: -0.33 }));
    assert(bridge.last()?.source === 'fetch' && near(bridge.last()?.loudnessDb, -12.4),
      `a player request answered after the change carries the plain level (${bridge.last()?.source} ${bridge.last()?.loudnessDb})`);
    preference = 1;
    stats = statsFor('100%/100% DRC (cont.-14.3dB tgt.-14.0dB)');
    await bridge.playerAnnounces('onPlaybackAudioChange');
    await bridge.fetchPlayer(playerResponse({ loudnessDb: -12.39, drcLoudnessDb: -0.33 }));
    assert(near(bridge.last()?.loudnessDb, -0.3),
      `and turned back, the stable level (${bridge.last()?.loudnessDb})`);
    assert(bridge.pendingTimers() === 0, `with nothing left looking (${bridge.pendingTimers()})`);
  }

  section('Playing level: the looking a load starts ends when the player is read');
  {
    const bridge = createBridge({ manualTimers: true });
    const pr = playerResponse({ loudnessDb: -12.39, drcLoudnessDb: -0.33 });
    bridge.assign(pr);
    assert(bridge.pendingTimers() === 1, `the load, with no player yet, starts looking (${bridge.pendingTimers()})`);
    bridge.setMoviePlayer(pr, { getStatsForNerds: () => statsFor('100%/100% DRC (cont.-14.3dB tgt.-14.0dB)') });
    await bridge.request();
    assert(bridge.pendingTimers() === 0, `an answer with the player's level stops it (${bridge.pendingTimers()})`);
  }

  section('Playing level: the looking gives up, and stops off a watch page');
  {
    // A live stream names no level at all.
    const bridge = createBridge({ manualTimers: true });
    const pr = playerResponse({ loudnessDb: -12.39 });
    bridge.assign(pr);
    bridge.setMoviePlayer(pr, { getStatsForNerds: () => statsFor('100%/100%') });
    await bridge.request();
    let looks = 0;
    while (bridge.pendingTimers() > 0 && looks < 100) {
      await bridge.runTimers();
      looks += 1;
    }
    assert(looks === 40, `it is looked at 40 times, 10 s in all (${looks})`);

    const left = createBridge({ manualTimers: true });
    left.assign(pr);
    let stats = statsFor('100%/100% (cont.-26.4dB tgt.-14.0dB)', { codecs: '' });
    left.setMoviePlayer(pr, { getStatsForNerds: () => stats });
    await left.request();
    const before = left.posted.length;
    left.setUrl('/results', '');
    stats = statsFor('100%/100% (cont.-26.4dB tgt.-14.0dB)');
    await left.runTimers();
    assert(left.posted.length === before && left.pendingTimers() === 0,
      `off a watch page it answers nothing and stops (${left.posted.length - before} / ${left.pendingTimers()})`);
  }

  section('Base level: the plain rendition\'s level goes with every answer');
  {
    const bridge = createBridge({ manualTimers: true });
    const pr = playerResponse({ loudnessDb: -12.39, drcLoudnessDb: -0.33 });
    bridge.assign(pr);
    assert(bridge.last()?.loudnessDb === -0.33 && bridge.last()?.baseLoudnessDb === -12.39,
      `from load, the stable level plays and the plain one is the base (${bridge.last()?.loudnessDb} / ${bridge.last()?.baseLoudnessDb})`);

    await bridge.fetchPlayer(pr);
    assert(bridge.last()?.source === 'fetch' && bridge.last()?.baseLoudnessDb === -12.39,
      `from a player request (${bridge.last()?.source} / ${bridge.last()?.baseLoudnessDb})`);

    bridge.setMoviePlayer(pr, { getStatsForNerds: () => statsFor('100%/95% (cont.-13.6dB tgt.-14.0dB)') });
    await bridge.request();
    assert(near(bridge.last()?.loudnessDb, 0.4) && bridge.last()?.baseLoudnessDb === -12.39,
      `and where the player names what it plays (${bridge.last()?.loudnessDb} / ${bridge.last()?.baseLoudnessDb})`);

    const perceptual = createBridge();
    const absolute = playerResponse();
    delete absolute.playerConfig.audioConfig.loudnessDb;
    absolute.playerConfig.audioConfig.perceptualLoudnessDb = -26.5;
    perceptual.assign(absolute);
    assert(perceptual.last()?.baseLoudnessDb === -12.5,
      `the absolute field, against the target, is a base as well (${perceptual.last()?.baseLoudnessDb})`);

    const none = createBridge();
    const empty = playerResponse();
    empty.playerConfig.audioConfig = {};
    none.assign(empty);
    assert(none.last()?.baseLoudnessDb === null, `with no level there is no base (${none.last()?.baseLoudnessDb})`);
    await none.request();
    assert(none.last()?.baseLoudnessDb === null, `asked, still none (${none.last()?.baseLoudnessDb})`);
  }

  section('Live level: the level the player names on air goes with the answer');
  {
    // A stream on air: the response describes no level of its own.
    const onAirResponse = () => playerResponse({ loudnessDb: undefined, isLiveContent: true, isLive: true });
    const answerFor = async (stats) => {
      const bridge = createBridge({ manualTimers: true });
      const pr = onAirResponse();
      bridge.setMoviePlayer(pr, { getStatsForNerds: () => stats });
      bridge.assign(pr);
      const defined = bridge.last();
      await bridge.fetchPlayer(pr);
      const fetched = bridge.last();
      await bridge.request();
      return { defined, fetched, asked: bridge.last(), bridge };
    };

    const onAir = await answerFor(statsFor('100%/100% (live.-24.8dB)'));
    for (const [route, answer] of [['define', onAir.defined], ['fetch', onAir.fetched], ['request', onAir.asked]]) {
      assert(answer?.source === route && answer?.liveLkfs === -24.8,
        `${route}: the live level is answered as named (${answer?.source} / ${answer?.liveLkfs})`);
      assert(answer?.loudnessDb === null,
        `${route}: and the level the response describes is left as it was (${answer?.loudnessDb})`);
    }
    assert(onAir.bridge.pendingTimers() === 0,
      `with the live level in hand nothing is looked at again (${onAir.bridge.pendingTimers()})`);
    const whole = await answerFor(statsFor('100%/100% (live.-16dB)'));
    assert(whole.asked?.liveLkfs === -16, `a level with no decimals is read too (${whole.asked?.liveLkfs})`);

    for (const [what, stats] of [
      ['during an ad, which names another video', statsFor('100%/100% (live.-24.8dB)', { id: 'someOtherId' })],
      ['before the player names its formats', statsFor('100%/100% (live.-24.8dB)', { codecs: '' })],
      ['on a line that names no live level', statsFor('100%/100%')]
    ]) {
      const answered = await answerFor(stats);
      assert(answered.asked?.liveLkfs === null && answered.defined?.liveLkfs === null,
        `${what}, no live level is answered (${answered.asked?.liveLkfs})`);
    }

    // A video's own level is not a live one.
    const vod = await answerFor(statsFor('100%/95% (cont.-13.6dB tgt.-14.0dB)'));
    assert(vod.asked?.liveLkfs === null && near(vod.asked?.loudnessDb, 0.4),
      `a cont. level is the rendition's, and not a live level (${vod.asked?.liveLkfs} / ${vod.asked?.loudnessDb})`);
  }

  section('Live level: the looking answers again once the player names it, and stops');
  {
    const bridge = createBridge({ manualTimers: true });
    const pr = playerResponse({ loudnessDb: undefined, isLiveContent: true, isLive: true });
    bridge.assign(pr);
    let stats = statsFor('100%/100%', { codecs: '' });
    bridge.setMoviePlayer(pr, { getStatsForNerds: () => stats });
    await bridge.request();
    assert(bridge.pendingTimers() === 1, `a look is pending (${bridge.pendingTimers()})`);
    const before = bridge.posted.length;
    await bridge.runTimers();
    assert(bridge.posted.length === before, `nothing is answered before the level is named (${bridge.posted.length - before})`);

    stats = statsFor('100%/100% (live.-16.0dB)');
    await bridge.runTimers();
    assert(bridge.posted.length === before + 1 && bridge.last()?.source === 'playing' && bridge.last()?.liveLkfs === -16,
      `answered once the live level is named, saying why (${bridge.posted.length - before} / ${bridge.last()?.source} / ${bridge.last()?.liveLkfs})`);
    assert(bridge.pendingTimers() === 0, `and the looking stops (${bridge.pendingTimers()})`);

    // The live level gone again: an answer without it looks once more.
    stats = statsFor('100%/100%');
    await bridge.request();
    assert(bridge.last()?.liveLkfs === null && bridge.pendingTimers() === 1,
      `a line that lost it is answered with none, and looked at again (${bridge.last()?.liveLkfs} / ${bridge.pendingTimers()})`);
  }

  section('Live level: asked for alone, it is answered with the level the line names now');
  {
    const bridge = createBridge();
    const pr = playerResponse({ loudnessDb: undefined, isLiveContent: true, isLive: true });
    bridge.assign(pr);
    let stats = statsFor('100%/100% (live.-16.0dB)');
    bridge.setMoviePlayer(pr, { getStatsForNerds: () => stats });
    const answers = () => bridge.posted.filter((m) => m?.type === '__yt_channel_volume_live__');
    const full = () => bridge.posted.filter((m) => m?.type === '__yt_channel_volume__').length;
    const fullBefore = full();
    await bridge.askLive();
    assert(answers().length === 1 && answers()[0].liveLkfs === -16 && answers()[0].videoId === 'urlVideoIdA',
      `the level and the video it is for (${JSON.stringify(answers())})`);
    assert(full() === fullBefore, `and no full answer goes with it (${full() - fullBefore})`);

    stats = statsFor('100%/100% (live.-12.3dB)');
    await bridge.askLive();
    assert(answers().length === 2 && answers()[1].liveLkfs === -12.3, `asked again, the level now (${answers()[1]?.liveLkfs})`);

    stats = statsFor('100%/100% (live.-12.3dB)', { id: 'someOtherId' });
    await bridge.askLive();
    assert(answers().length === 3 && answers()[2].liveLkfs === null, `during an ad, no level (${answers()[2]?.liveLkfs})`);

    await bridge.askLive({});
    assert(answers().length === 3, `an ask from another window is not answered (${answers().length})`);

    bridge.setUrl('/feed/subscriptions', null);
    await bridge.askLive();
    assert(answers().length === 3, `off a watch page it is not answered (${answers().length})`);
  }

  section('Stable volume: what the popup-open dump reports');
  {
    const bridge = createBridge({ stored: { [DRC_PREF]: storedPref(0) } });
    const pr = playerResponse({ loudnessDb: -12.39, drcLoudnessDb: -0.33 });
    bridge.assign(pr);
    bridge.setMoviePlayer(pr, {
      getStatsForNerds: () => statsFor('100%/100% (cont.-26.4dB tgt.-14.0dB)')
    });
    await bridge.diagnose();
    const [, dump] = bridge.logged[bridge.logged.length - 1] || [];
    assert(dump?.drcPreference?.value === 0 && dump?.drcPreference?.from === 'storage',
      `the setting and where it was read (${JSON.stringify(dump?.drcPreference)})`);
    assert(dump?.captured?.loudnessDb === -12.39 && dump?.captured?.drcLoudnessDb === -0.33,
      `both levels the response carries (${dump?.captured?.loudnessDb} / ${dump?.captured?.drcLoudnessDb})`);
    assert(dump?.playerVolume === '100%/100% (cont.-26.4dB tgt.-14.0dB)',
      `and the player's own volume line (${dump?.playerVolume})`);
    assert(dump?.playingLkfs === -26.4 && dump?.liveLkfs === null,
      `with the level read from it, and no live level (${dump?.playingLkfs} / ${dump?.liveLkfs})`);

    const onAir = createBridge();
    const livePr = playerResponse({ loudnessDb: undefined, isLiveContent: true, isLive: true });
    onAir.assign(livePr);
    onAir.setMoviePlayer(livePr, { getStatsForNerds: () => statsFor('50%/50% (live.-12.3dB)') });
    await onAir.diagnose();
    const [, live] = onAir.logged[onAir.logged.length - 1] || [];
    assert(live?.playerVolume === '50%/50% (live.-12.3dB)' && live?.liveLkfs === -12.3 && live?.playingLkfs === null,
      `on air, the live level read from the line (${live?.playerVolume} / ${live?.liveLkfs} / ${live?.playingLkfs})`);

    const bare = createBridge();
    bare.assign(pr);
    await bare.diagnose();
    const [, without] = bare.logged[bare.logged.length - 1] || [];
    assert(without?.playerVolume === null && without?.drcPreference?.from === 'default',
      `with no player, no line and the default (${without?.playerVolume} / ${without?.drcPreference?.from})`);
    assert(without?.playingLkfs === null && without?.liveLkfs === null,
      `and no level (${without?.playingLkfs} / ${without?.liveLkfs})`);
  }

  // ── After a reload, and what a message has to be to be read ────────

  // The write path was put to this already; the reads and the popup were not.
  section('Extension reload: nothing is read either');
  {
    mockStorage['channelVolumes'] = { UCread: { name: 'Read Ch', gainVideo: 0.5 } };
    mockSyncStorage['autoLoudnessSettings'] = { targetLufs: -20, displayUnit: '%' };
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

  // The settings are read on every apply; after a reload the apply may touch
  // storage in neither direction, and the popup is still owed an answer.
  section('Extension reload: an apply reads nothing and the popup is answered');
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
    const answer = await simulateRuntimeMessage({ type: 'getState' });
    await tick();
    chrome.storage.local.get = realGet;
    chrome.storage.local.set = realSet;
    chrome.runtime.id = idBefore;
    assert(reads === 0, `an apply after a reload reads nothing (${reads})`);
    assert(writes === 0, `and writes nothing either (${writes})`);
    assert(answer?.appliesTo !== undefined,
      `while the popup is still answered (${JSON.stringify(answer)})`);
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

  // ── What the popup asks for, and what is refused ───────────────────

  section('Popup: the state it asks for over the port');
  {
    setURL('/watch', 'askVid');
    ytcv._set('currentChannel', { id: 'UCask', name: 'Ask Ch', url: 'https://y/UCask' });
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentLoudnessDb', -7);
    ytcv._set('currentGain', 1.4);
    const state = await simulateRuntimeMessage({ type: 'getState' });
    assert(state?.channel?.id === 'UCask',
      `the channel being watched is answered (${state?.channel?.id})`);
    assert(state?.gain === 1.4 && state?.loudnessDb === -7,
      `with the gain and the level (${state?.gain} / ${state?.loudnessDb})`);
  }

  section('Popup: a message this content script does not handle');
  {
    const answer = await simulateRuntimeMessage({ type: 'somethingElse' }, { expectNoAnswer: true });
    assert(answer === undefined,
      `a message of another kind is declined rather than answered (${JSON.stringify(answer)})`);
  }

  section('Popup: a gesture made against a state the tab has left');
  {
    mockStorage['channelVolumes'] = {
      UChere: { name: 'Here Ch', gainVideo: 0.5, url: 'https://y/UChere' },
      UCgone: { name: 'Gone Ch', gainVideo: 0.9, url: 'https://y/UCgone' }
    };
    setURL('/watch', 'mismatchVid');
    ytcv._set('currentChannel', { id: 'UChere', name: 'Here Ch', url: 'https://y/UChere' });
    ytcv._set('currentChannelVideoId', ytcv.getUrlVideoId());
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentGain', 0.5);
    ytcv._set('currentAutoApplyLoudnessVideo', false);
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('storageMigrated', true);
    // What the popup was drawn from before the tab moved on.
    const stale = 'UCgone|video';

    const live = await simulateRuntimeMessage({ type: 'setGainLive', appliesTo: stale, gain: 0.2 });
    assert(live?.ok === false && live?.reason === 'state moved',
      `the preview is refused — got ${JSON.stringify(live)}`);
    assert(ytcv.state.currentGain === 0.5,
      `so the level never moves for it (${ytcv.state.currentGain})`);

    const saved = await simulateRuntimeMessage({ type: 'setGain', appliesTo: stale, gain: 0.2 });
    await tick();
    assert(saved?.ok === false && saved?.reason === 'state moved',
      `and the save with it — got ${JSON.stringify(saved)}`);
    assert(mockStorage['channelVolumes']['UCgone'].gainVideo === 0.9,
      `the channel the popup was drawn from is untouched (${mockStorage['channelVolumes']['UCgone'].gainVideo})`);
    assert(mockStorage['channelVolumes']['UChere'].gainVideo === 0.5,
      'and so is the one being watched');
    assert(ytcv.state.currentGain === 0.5,
      `with the level left where storage has it (${ytcv.state.currentGain})`);

    const toggled = await simulateRuntimeMessage({
      type: 'setAutoApplyLoudness', appliesTo: stale, enabled: true
    });
    await tick();
    assert(toggled?.ok === false && toggled?.reason === 'state moved',
      `an Auto toggle from that state is refused too — got ${JSON.stringify(toggled)}`);
    assert(!('autoApplyLoudnessVideo' in mockStorage['channelVolumes']['UCgone']),
      'and no Auto state is pinned on the channel it named');

    // A gesture carrying no state at all — a popup that never read one.
    const nameless = await simulateRuntimeMessage({ type: 'setGain', gain: 0.2 });
    await tick();
    assert(nameless?.ok === false && nameless?.reason === 'state moved',
      `a gesture carrying no state is refused — got ${JSON.stringify(nameless)}`);

    // The same gesture, carrying the state the tab is actually in.
    const now = await popupGesture({ type: 'setGain', gain: 0.2 });
    await tick();
    assert(now?.ok === true, `the gesture made against this state goes through — got ${JSON.stringify(now)}`);
    assert(mockStorage['channelVolumes']['UChere'].gainVideo === 0.2,
      `and it saves under the channel being watched (${mockStorage['channelVolumes']['UChere'].gainVideo})`);
    assert(mockStorage['channelVolumes']['UChere'].name === 'Here Ch',
      'keeping its own name');
    assert(mockStorage['channelVolumes']['UCgone'].name === 'Gone Ch',
      'and leaving the other one its own');
  }

  section('Popup: a state captured before the tab moved, replayed after');
  {
    mockStorage['channelVolumes'] = {
      UCwas: { name: 'Was Ch', gainVideo: 0.4, url: '' },
      UCnow: { name: 'Now Ch', gainVideo: 0.7, url: '' }
    };
    setURL('/watch', 'replayVid');
    ytcv._set('currentChannel', { id: 'UCwas', name: 'Was Ch', url: '' });
    ytcv._set('currentChannelVideoId', ytcv.getUrlVideoId());
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentGain', 0.4);
    ytcv._set('currentAutoApplyLoudnessVideo', false);
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('storageMigrated', true);
    // The popup is drawn, and the slider is dragged while that state holds.
    const drawnFrom = (await simulateRuntimeMessage({ type: 'getState' })).appliesTo;
    const preview = await simulateRuntimeMessage({ type: 'setGainLive', appliesTo: drawnFrom, gain: 0.15 });
    assert(preview?.ok === true, `the preview goes through while the state holds — got ${JSON.stringify(preview)}`);
    assert(ytcv.state.currentGain === 0.15, 'and the level follows the slider');

    // The tab moves to another channel before the slider is released.
    ytcv._set('currentChannel', { id: 'UCnow', name: 'Now Ch', url: '' });
    ytcv._set('currentChannelVideoId', ytcv.getUrlVideoId());
    const released = await simulateRuntimeMessage({ type: 'setGain', appliesTo: drawnFrom, gain: 0.15 });
    await tick();
    assert(released?.ok === false && released?.reason === 'state moved',
      `the release is refused — got ${JSON.stringify(released)}`);
    assert(ytcv.state.currentGain === 0.7,
      `and the level goes back to what storage has for the channel now playing (${ytcv.state.currentGain})`);
    assert(mockStorage['channelVolumes']['UCwas'].gainVideo === 0.4,
      'with nothing written for the channel the popup was drawn from');
    assert(mockStorage['channelVolumes']['UCnow'].gainVideo === 0.7,
      'and nothing for the one being watched');
  }

  section('Popup: the same channel under the other type is another state');
  {
    mockStorage['channelVolumes'] = { UCswap: { name: 'Swap Ch', gainVideo: 0.5, gainLive: 0.9 } };
    setURL('/watch', 'swapVid');
    ytcv._set('currentChannel', { id: 'UCswap', name: 'Swap Ch', url: '' });
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentGain', 0.5);
    ytcv._set('currentAutoApplyLoudnessVideo', false);
    ytcv._set('currentAutoApplyLoudnessLive', false);
    ytcv._set('currentLoudnessDb', null);
    const drawnOnVideo = (await simulateRuntimeMessage({ type: 'getState' })).appliesTo;
    // The bridge says this is a stream after all, and the popup's gesture
    // arrives afterwards.
    ytcv._set('currentVideoType', 'live');
    const late = await simulateRuntimeMessage({ type: 'setGain', appliesTo: drawnOnVideo, gain: 0.25 });
    await tick();
    assert(late?.ok === false && late?.reason === 'state moved',
      `a gesture made under the other type is refused — got ${JSON.stringify(late)}`);
    assert(mockStorage['channelVolumes']['UCswap'].gainVideo === 0.5
      && mockStorage['channelVolumes']['UCswap'].gainLive === 0.9,
      'and neither slot is written');
  }

  section('Popup: another channel under the same type is another state');
  {
    mockStorage['channelVolumes'] = {
      UCleft: { name: 'Left Ch', gainVideo: 0.4 },
      UCstay: { name: 'Stay Ch', gainVideo: 0.6 }
    };
    setURL('/watch', 'sameTypeVid');
    ytcv._set('currentChannel', { id: 'UCleft', name: 'Left Ch', url: '' });
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentGain', 0.4);
    ytcv._set('currentAutoApplyLoudnessVideo', false);
    const drawnOnLeft = (await simulateRuntimeMessage({ type: 'getState' })).appliesTo;
    ytcv._set('currentChannel', { id: 'UCstay', name: 'Stay Ch', url: '' });
    const late = await simulateRuntimeMessage({ type: 'setGain', appliesTo: drawnOnLeft, gain: 0.25 });
    await tick();
    assert(late?.ok === false && late?.reason === 'state moved',
      `a gesture made on another channel of the same type is refused — got ${JSON.stringify(late)}`);
    assert(mockStorage['channelVolumes']['UCleft'].gainVideo === 0.4
      && mockStorage['channelVolumes']['UCstay'].gainVideo === 0.6,
      'and neither channel is written');
  }

  section('Popup: the state a gesture is made against names the type as well');
  {
    mockStorage['channelVolumes'] = { UCtypes: { name: 'Types Ch', gainVideo: 0.5, gainLive: 0.9 } };
    setURL('/watch', 'typeVid');
    ytcv._set('currentChannel', { id: 'UCtypes', name: 'Types Ch', url: '' });
    ytcv._set('currentVideoType', 'live');
    ytcv._set('currentGain', 0.9);
    ytcv._set('currentAutoApplyLoudnessLive', false);
    ytcv._set('currentLoudnessDb', null);
    // The popup was drawn while the same channel was playing a video.
    const asVideo = await simulateRuntimeMessage({
      type: 'setGain', appliesTo: 'UCtypes|video', gain: 0.25
    });
    await tick();
    assert(asVideo?.ok === false && asVideo?.reason === 'state moved',
      `a gesture for the other type is refused — got ${JSON.stringify(asVideo)}`);
    assert(mockStorage['channelVolumes']['UCtypes'].gainVideo === 0.5,
      `the type it was made for keeps its gain (${mockStorage['channelVolumes']['UCtypes'].gainVideo})`);
    assert(mockStorage['channelVolumes']['UCtypes'].gainLive === 0.9,
      'and the type being watched keeps its own');
  }

  section('Popup on open: what counts as a video it has not applied yet');
  {
    mockStorage['channelVolumes'] = { UCopen: { name: 'Open Ch', gainVideo: 0.35 } };
    setURL('/watch', 'openVid');
    mockVideoEl = { id: 'popup-open-video' };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCopen' };
    ytcv._set('currentChannel', { id: 'UCopen', name: 'Open Ch', url: '' });
    ytcv._set('_lastVideoId', 'openVid');
    ytcv._set('_lastProcessedVideo', mockVideoEl);
    ytcv._set('currentGain', 1.0);
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('storageMigrated', true);
    ytcv._set('_applyRunning', false);
    // The video in the URL is the one already taken up, so opening the popup
    // answers from what is in hand rather than running an apply over it.
    ytcv._set('_lastProcessedVideo', null);
    const same = await simulateRuntimeMessage({ type: 'forceDetect' });
    await tick();
    assert(same?.channel?.id === 'UCopen', `the popup is answered (${same?.channel?.id})`);
    assert(ytcv.state._lastProcessedVideo === null,
      `and no apply was run over a video already taken up (${ytcv.state._lastProcessedVideo})`);

    // A navigation the extension has not caught up with: the URL names a video
    // that was never applied, so opening the popup applies it.
    setURL('/watch', 'newVid');
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCopen' };
    // The channel comes from the bridge after a navigation.
    mockPostMessageHandler = (data) => {
      if (data.type !== '__yt_channel_volume_request__') return;
      setTimeout(() => simulateBridgeMessage({ videoId: 'newVid', isLiveContent: false, channelId: 'UCopen' }), 0);
    };
    const moved = await simulateRuntimeMessage({ type: 'forceDetect' });
    mockPostMessageHandler = null;
    await tick();
    assert(moved?.channel?.id === 'UCopen', 'the popup is answered there too');
    assert(ytcv.state._lastVideoId === 'newVid',
      `and the video the URL names is taken up (${ytcv.state._lastVideoId})`);
    assert(ytcv.state._lastProcessedVideo === mockVideoEl,
      'with the element the page is playing');
  }

  section('Popup: a handler that throws names the message in the console');
  {
    setURL('/watch', 'throwVid');
    ytcv._set('currentChannel', { id: 'UCthrow', name: 'Throw Ch', url: '' });
    ytcv._set('currentChannelVideoId', ytcv.getUrlVideoId());
    ytcv._set('currentLoudnessDb', -6);
    ytcv._set('currentAutoApplyLoudnessVideo', false);
    ytcv._set('targetLufs', -18);
    const realConsoleError = console.error;
    const reported = [];
    console.error = (...args) => { reported.push(args[0]); };
    const throwingCtx = ytcv.state.audioCtx;
    const realCreate = throwingCtx.createMediaElementSource;
    throwingCtx.createMediaElementSource = () => { throw new Error('InvalidStateError'); };
    const videoBefore = mockVideoEl;
    mockVideoEl = { id: 'owned-elsewhere' };
    const answer = await popupGesture({ type: 'applyLoudness' });
    await tick();
    throwingCtx.createMediaElementSource = realCreate;
    mockVideoEl = videoBefore;
    console.error = realConsoleError;
    assert(answer?.ok === false && answer?.reason === 'request failed',
      `the popup is told the request failed — got ${JSON.stringify(answer)}`);
    assert(reported.some(m => String(m).startsWith('[YTCV] applyLoudness failed')),
      `and the console names the message that failed (${JSON.stringify(reported)})`);
  }

  // ── What an apply carries over a navigation, and what it drops ─────

  section('Apply: what the bridge already said for this video is kept');
  {
    mockStorage['channelVolumes'] = { UCearly: { name: 'Early Ch', gainVideo: 0.5 } };
    setURL('/watch', 'earlyVid');
    mockVideoEl = { id: 'early-video' };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCstale' };
    ytcv._set('storageMigrated', true);
    ytcv._set('storageSettled', true);
    ytcv._set('_lastVideoId', 'previousVid');
    ytcv._set('_lastProcessedVideo', null);
    ytcv._set('_applyRunning', false);
    // The bridge answered for the video the URL now names, before the apply
    // for that navigation ran.
    ytcv._set('currentChannel', { id: 'UCearly', name: 'Early Ch', url: 'https://y/UCearly' });
    ytcv._set('currentChannelVideoId', 'earlyVid');
    ytcv._set('currentLoudnessVideoId', 'earlyVid');
    ytcv._set('currentLoudnessDb', -6);
    ytcv._set('currentVideoType', 'live');
    await ytcv.applyVideoVolume();
    await tick();
    assert(ytcv.state.currentChannel.id === 'UCearly',
      `the channel the bridge named is kept over the DOM (${ytcv.state.currentChannel.id})`);
    assert(ytcv.state.currentLoudnessDb === -6,
      `and so is the level it gave (${ytcv.state.currentLoudnessDb})`);
    assert(ytcv.state.currentVideoType === 'live',
      `and the type it decided (${ytcv.state.currentVideoType})`);
  }

  section('Apply: a video the bridge has not spoken for starts clean');
  {
    mockStorage['channelVolumes'] = {};
    setURL('/watch', 'freshVid');
    mockVideoEl = { id: 'fresh-video' };
    mockDOMElements['canonical'] = null;
    mockDOMElements['ownerLink'] = null;
    mockDOMElements['metaChannel'] = null;
    ytcv._set('_lastVideoId', 'previousVid');
    ytcv._set('_lastProcessedVideo', null);
    ytcv._set('_applyRunning', false);
    // What is in hand belongs to the video the tab has left.
    ytcv._set('currentChannel', { id: 'UCprevious', name: 'Previous Ch', url: 'https://y/UCprevious' });
    ytcv._set('currentChannelVideoId', 'previousVid');
    ytcv._set('currentLoudnessVideoId', 'previousVid');
    ytcv._set('currentLoudnessDb', -9);
    ytcv._set('currentVideoType', 'live');
    ytcv._set('currentAutoApplyLoudnessVideo', true);
    ytcv._set('currentAutoApplyLoudnessLive', true);
    await ytcv.applyVideoVolume();
    await tick();
    assert(ytcv.state.currentChannel.id === '',
      `the channel of the video left behind is dropped (${ytcv.state.currentChannel.id})`);
    assert(ytcv.state.currentLoudnessDb === null,
      `its level with it (${ytcv.state.currentLoudnessDb})`);
    assert(ytcv.state.currentVideoType === 'video',
      `and the type goes back to what a page starts as (${ytcv.state.currentVideoType})`);
    assert(ytcv.state.currentAutoApplyLoudnessVideo === false
      && ytcv.state.currentAutoApplyLoudnessLive === false,
      'and the Auto state read for that channel is dropped too');
    assert(ytcv.state._lastProcessedVideo === mockVideoEl,
      'while the element the page is playing is taken up');
  }

  section('Apply: the first video of a tab is not a navigation');
  {
    mockStorage['channelVolumes'] = { UCfirst: { name: 'First Ch', gainVideo: 0.25 } };
    setURL('/watch', 'firstVid');
    mockVideoEl = { id: 'first-video' };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCfirst' };
    ytcv._set('_lastVideoId', '');
    ytcv._set('_lastProcessedVideo', null);
    ytcv._set('_applyRunning', false);
    // The bridge answered before the first apply ran; with no previous video
    // there is nothing to clear, and the answer stands.
    ytcv._set('currentChannel', { id: 'UCfirst', name: 'First Ch', url: '' });
    ytcv._set('currentChannelVideoId', '');
    ytcv._set('currentLoudnessVideoId', 'firstVid');
    ytcv._set('currentLoudnessDb', -4);
    await ytcv.applyVideoVolume();
    await tick();
    assert(ytcv.state.currentLoudnessDb === -4,
      `the level for this video is kept on the first apply (${ytcv.state.currentLoudnessDb})`);
    assert(ytcv.state.currentChannel.id === 'UCfirst', 'and the channel with it');

    // The same first apply, with nothing in the DOM to name the channel and a
    // bridge answer that carried no video id: there is no previous video to
    // have left, so what is in hand is this video's and stays.
    mockDOMElements['canonical'] = null;
    ytcv._set('_lastVideoId', '');
    ytcv._set('_lastProcessedVideo', null);
    ytcv._set('currentChannel', { id: 'UCfirst', name: 'First Ch', url: '' });
    ytcv._set('currentChannelVideoId', '');
    await ytcv.applyVideoVolume();
    await tick();
    assert(ytcv.state.currentChannel.id === 'UCfirst',
      `nothing is cleared where there is no previous video (${ytcv.state.currentChannel.id})`);
  }

  section('Apply: a page with no player, and a page that is not a watch page');
  {
    setURL('/watch', 'noPlayerVid');
    const videoBefore = mockVideoEl;
    mockVideoEl = null;
    ytcv._set('_lastVideoId', 'keptVid');
    ytcv._set('_lastProcessedVideo', null);
    ytcv._set('_applyRunning', false);
    await ytcv.applyVideoVolume();
    await tick();
    assert(ytcv.state._lastVideoId === 'keptVid',
      `a page with no player is left where it was (${ytcv.state._lastVideoId})`);
    assert(ytcv.state._lastProcessedVideo === null, 'with no element taken up');

    mockVideoEl = videoBefore;
    setURL('/feed/subscriptions', null);
    await ytcv.applyVideoVolume();
    await tick();
    assert(ytcv.state._lastVideoId === 'keptVid',
      `and so is a page that is not a watch page (${ytcv.state._lastVideoId})`);
    setURL('/watch', 'keptVid');
  }

  section('Apply: the settings are read before the gain is worked out');
  {
    mockStorage['channelVolumes'] = { UCsettings: { name: 'Settings Ch', autoApplyLoudnessVideo: true } };
    mockSyncStorage['autoLoudnessSettings'] = { targetLufs: -24, displayUnit: '%' };
    setURL('/watch', 'settingsVid');
    mockVideoEl = { id: 'settings-video' };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCsettings' };
    ytcv._set('targetLufs', -18);
    ytcv._set('_lastVideoId', 'settingsVid');
    ytcv._set('_lastProcessedVideo', null);
    ytcv._set('_applyRunning', false);
    ytcv._set('currentChannel', { id: 'UCsettings', name: 'Settings Ch', url: '' });
    ytcv._set('currentChannelVideoId', 'settingsVid');
    ytcv._set('currentLoudnessVideoId', 'settingsVid');
    ytcv._set('currentLoudnessDb', -6);
    ytcv._set('currentAutoApplyLoudnessVideo', true);
    await ytcv.applyVideoVolume();
    await tick();
    assert(ytcv.state.targetLufs === -24,
      `the target stored is the one in hand afterwards (${ytcv.state.targetLufs})`);
    assert(Math.abs(ytcv.state.currentGain - ytcv.calcGainFromLoudness(-6)) < 0.001,
      `and the gain is worked out from it (${ytcv.state.currentGain})`);
  }

  section('Settings: read from local until the worker has moved them to sync');
  {
    mockStorage['channelVolumes'] = { UClocalset: { name: 'Local Set Ch', autoApplyLoudnessVideo: true } };
    delete mockSyncStorage['autoLoudnessSettings'];
    mockStorage['autoLoudnessSettings'] = { targetLufs: -22, displayUnit: '%' };
    setURL('/watch', 'localSetVid');
    mockVideoEl = { id: 'local-set-video' };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UClocalset' };
    ytcv._set('targetLufs', -18);
    ytcv._set('_lastVideoId', 'localSetVid');
    ytcv._set('_lastProcessedVideo', null);
    ytcv._set('_applyRunning', false);
    ytcv._set('currentChannel', { id: 'UClocalset', name: 'Local Set Ch', url: '' });
    ytcv._set('currentChannelVideoId', 'localSetVid');
    ytcv._set('currentLoudnessVideoId', 'localSetVid');
    ytcv._set('currentLoudnessDb', -6);
    ytcv._set('currentAutoApplyLoudnessVideo', true);
    await ytcv.applyVideoVolume();
    await tick();
    assert(ytcv.state.targetLufs === -22,
      `settings not moved yet are the ones played by (${ytcv.state.targetLufs})`);

    // The move writes sync, then clears local. The clearing comes as a local
    // change with no new value, and taking it would put every setting back to
    // its default.
    mockSyncStorage['autoLoudnessSettings'] = { targetLufs: -22, displayUnit: '%' };
    delete mockStorage['autoLoudnessSettings'];
    for (const fn of chrome.storage.onChanged._listeners) {
      fn({ autoLoudnessSettings: { oldValue: { targetLufs: -22, displayUnit: '%' } } }, 'local');
    }
    await tick();
    assert(ytcv.state.targetLufs === -22,
      `the copy leaving local is not a change of settings (${ytcv.state.targetLufs})`);
    mockSyncStorage['autoLoudnessSettings'] = { targetLufs: -20, displayUnit: '%' };
    simulateStorageChange({ autoLoudnessSettings: { newValue: { targetLufs: -20, displayUnit: '%' } } });
    await tick();
    assert(ytcv.state.targetLufs === -20,
      `settings another machine synced are taken (${ytcv.state.targetLufs})`);
    assert(Math.abs(ytcv.state.currentGain - ytcv.calcGainFromLoudness(-6)) < 0.001,
      `and played by (${ytcv.state.currentGain})`);
    mockSyncStorage['autoLoudnessSettings'] = { targetLufs: -18, displayUnit: '%' };
    simulateStorageChange({ autoLoudnessSettings: { newValue: { targetLufs: -18, displayUnit: '%' } } });
    await tick();
  }

  section('Settings: a change that came in while the read was out is not undone by it');
  {
    // The read is answered with what sync held when it was made; the change
    // that came in meanwhile is newer, and is what goes on being played by.
    mockStorage['channelVolumes'] = { UCreadrace: { name: 'Read Race Ch', autoApplyLoudnessVideo: true } };
    mockSyncStorage['autoLoudnessSettings'] = { targetLufs: -20, displayUnit: '%' };
    setURL('/watch', 'readRaceVid');
    mockVideoEl = { id: 'read-race-video' };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCreadrace' };
    ytcv._set('targetLufs', -18);
    ytcv._set('_lastVideoId', 'readRaceVid');
    ytcv._set('_lastProcessedVideo', null);
    ytcv._set('_applyRunning', false);
    ytcv._set('currentChannel', { id: 'UCreadrace', name: 'Read Race Ch', url: '' });
    ytcv._set('currentChannelVideoId', 'readRaceVid');
    ytcv._set('currentLoudnessVideoId', 'readRaceVid');
    ytcv._set('currentLoudnessDb', -6);
    ytcv._set('currentAutoApplyLoudnessVideo', true);
    const realGet = chrome.storage.sync.get;
    let releaseRead;
    const readHeld = new Promise((resolve) => { releaseRead = resolve; });
    let held = true;
    chrome.storage.sync.get = (key) => {
      if (!held) return realGet(key);
      held = false;
      const snapshot = realGet(key);
      return readHeld.then(() => snapshot);
    };
    const applying = ytcv.applyVideoVolume();
    await tick();
    mockSyncStorage['autoLoudnessSettings'] = { targetLufs: -24, displayUnit: '%' };
    simulateStorageChange({ autoLoudnessSettings: { newValue: { targetLufs: -24, displayUnit: '%' } } });
    await tick();
    releaseRead();
    await applying;
    await tick();
    chrome.storage.sync.get = realGet;
    assert(ytcv.state.targetLufs === -24,
      `the target the change brought stands (${ytcv.state.targetLufs})`);
    assert(Math.abs(ytcv.state.currentGain - ytcv.calcGainFromLoudness(-6)) < 0.001 &&
      Math.abs(ytcv.calcGainFromLoudness(-6) - calcGain(-6, -24)) < 0.001,
      `and the gain is worked out from it (${ytcv.state.currentGain})`);
    mockSyncStorage['autoLoudnessSettings'] = { targetLufs: -18, displayUnit: '%' };
    simulateStorageChange({ autoLoudnessSettings: { newValue: { targetLufs: -18, displayUnit: '%' } } });
    await tick();
  }

  // ── Waiting for what the next step needs ───────────────────────────
  // Dropping an await leaves the suite green in six places, and one of those
  section('Apply: the target is in hand before the gain is worked out');
  {
    // Writes an earlier case left in flight land on whatever map is there when
    // they arrive, so this one lets them settle before laying down its own.
    await tick();
    await tick();
    mockStorage['channelVolumes'] = { UCorder: { name: 'Order Ch', autoApplyLoudnessVideo: true } };
    mockSyncStorage['autoLoudnessSettings'] = { targetLufs: -24, displayUnit: '%' };
    setURL('/watch', 'orderVid');
    mockVideoEl = { id: 'order-video' };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCorder' };
    ytcv._set('targetLufs', -18);
    ytcv._set('_lastVideoId', 'orderVid');
    ytcv._set('_lastProcessedVideo', null);
    ytcv._set('_applyRunning', false);
    ytcv._set('currentChannel', { id: 'UCorder', name: 'Order Ch', url: '' });
    ytcv._set('currentChannelVideoId', 'orderVid');
    ytcv._set('currentLoudnessVideoId', 'orderVid');
    ytcv._set('currentLoudnessDb', -6);
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentAutoApplyLoudnessVideo', true);
    ytcv._set('storageMigrated', true);
    ytcv._set('storageSettled', true);
    // The settings read is held, so the gain cannot be worked out from a target
    // that happened to land in time.
    const realGet = chrome.storage.sync.get;
    let releaseSettings;
    const heldSettings = new Promise((resolve) => { releaseSettings = resolve; });
    chrome.storage.sync.get = (key) =>
      (key === 'autoLoudnessSettings' ? heldSettings.then(() => realGet(key)) : realGet(key));
    const applying = ytcv.applyVideoVolume();
    await tick();
    releaseSettings();
    await applying;
    chrome.storage.sync.get = realGet;
    assert(ytcv.state.targetLufs === -24,
      `the target stored is the one in hand afterwards (${ytcv.state.targetLufs})`);
    assert(Math.abs(ytcv.state.currentGain - ytcv.calcGainFromLoudness(-6)) < 0.001,
      `and the gain is worked out from it (${ytcv.state.currentGain})`);
  }

  // ── Waiting for what the next step needs ───────────────────────────
  // Dropping an await leaves the suite green in six places, and one of those
  section('Apply: the target is in hand before the gain is worked out');
  {
    // Writes an earlier case left in flight land on whatever map is there when
    // they arrive, so this one lets them settle before laying down its own.
    await tick();
    await tick();
    mockStorage['channelVolumes'] = { UCorder: { name: 'Order Ch', autoApplyLoudnessVideo: true } };
    mockSyncStorage['autoLoudnessSettings'] = { targetLufs: -24, displayUnit: '%' };
    setURL('/watch', 'orderVid');
    mockVideoEl = { id: 'order-video' };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCorder' };
    ytcv._set('targetLufs', -18);
    ytcv._set('_lastVideoId', 'orderVid');
    ytcv._set('_lastProcessedVideo', null);
    ytcv._set('_applyRunning', false);
    ytcv._set('currentChannel', { id: 'UCorder', name: 'Order Ch', url: '' });
    ytcv._set('currentChannelVideoId', 'orderVid');
    ytcv._set('currentLoudnessVideoId', 'orderVid');
    ytcv._set('currentLoudnessDb', -6);
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentAutoApplyLoudnessVideo', true);
    ytcv._set('storageMigrated', true);
    ytcv._set('storageSettled', true);
    // Read before the retry that follows can put it right: the gain the apply
    // itself worked out is the one this asks about.
    await ytcv.applyVideoVolume();
    assert(ytcv.state.targetLufs === -24,
      `the stored target is in hand when the apply returns (${ytcv.state.targetLufs})`);
    assert(Math.abs(ytcv.state.currentGain - ytcv.calcGainFromLoudness(-6)) < 0.001,
      `and the gain it applied was worked out from it (${ytcv.state.currentGain})`);
    await tick();
  }

  section('Apply: the popup is told after the gain has been applied');
  {
    mockStorage['channelVolumes'] = { UCtold: { name: 'Told Ch', gainVideo: 0.35 } };
    mockSyncStorage['autoLoudnessSettings'] = { targetLufs: -18, displayUnit: '%' };
    setURL('/watch', 'toldVid');
    mockVideoEl = { id: 'told-video' };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCtold' };
    ytcv._set('_lastVideoId', 'toldVid');
    ytcv._set('_lastProcessedVideo', null);
    ytcv._set('_applyRunning', false);
    ytcv._set('currentChannel', { id: 'UCtold', name: 'Told Ch', url: '' });
    ytcv._set('currentChannelVideoId', 'toldVid');
    ytcv._set('currentLoudnessVideoId', 'toldVid');
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentAutoApplyLoudnessVideo', false);
    ytcv._set('currentGain', 1.0);
    ytcv.notifyPopup();
    mockSentMessages.length = 0;
    await ytcv.applyVideoVolume();
    const told = mockSentMessages.filter(m => m?.type === 'stateChanged');
    assert(told.length > 0, `the popup is told (${told.length})`);
    assert(told[0]?.gain === 0.35,
      `and what it is told is the gain now playing (${JSON.stringify(told[0]?.gain)})`);
    await tick();
  }

  section('Apply: the fold is waited for before the video is taken up');
  {
    mockSyncStorage = { autoLoudnessSettings: { targetLufs: -18 } };
    mockStorage = {
      channelVolumes: { UCfoldwait: { name: 'Fold Wait Ch', gainVideo: 0.45 } }
    };
    setURL('/watch', 'foldWaitVid');
    mockVideoEl = { id: 'fold-wait-video' };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCfoldwait' };
    ytcv._set('storageMigrated', false);
    ytcv._set('storageSettled', true);
    ytcv._set('_lastVideoId', '');
    ytcv._set('_lastProcessedVideo', null);
    ytcv._set('_applyRunning', false);
    ytcv._set('currentChannel', { id: 'UCfoldwait', name: 'Fold Wait Ch', url: '' });
    ytcv._set('currentGain', 1.0);
    // The fold is held, so the apply cannot take the video up on the strength
    // of a fold that happened to land first.
    const realSend = chrome.runtime.sendMessage;
    let releaseFold;
    const heldFold = new Promise((resolve) => { releaseFold = resolve; });
    chrome.runtime.sendMessage = (msg) =>
      (msg?.type === 'store:migrateLegacyGains'
        ? heldFold.then(() => realSend(msg))
        : realSend(msg));
    const applying = ytcv.triggerApply();
    await tick();
    assert(ytcv.state._lastProcessedVideo === null,
      `the video is not taken up while the fold is still out (${ytcv.state._lastProcessedVideo})`);
    releaseFold();
    await applying;
    chrome.runtime.sendMessage = realSend;
    assert(ytcv.state.storageMigrated === true,
      `the fold has landed by the time the apply returns (${ytcv.state.storageMigrated})`);
    assert(ytcv.state._lastProcessedVideo === mockVideoEl,
      'and the video was taken up in the same run');
    await tick();
  }

  // ── Which link names the channel, and what it is called ───────────

  section('Channel detection: the three places a UC can be, in order');
  {
    setURL('/watch', 'detectVid');
    mockDOMElements['channelName'] = { textContent: 'The Name On Screen' };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCcanonical' };
    mockDOMElements['ownerLink'] = { href: 'https://www.youtube.com/channel/UCowner' };
    mockDOMElements['metaChannel'] = { content: 'UCmeta' };
    assert(ytcv.detectChannel().id === 'UCcanonical',
      `the canonical link is taken first (${ytcv.detectChannel().id})`);

    mockDOMElements['canonical'] = null;
    assert(ytcv.detectChannel().id === 'UCowner',
      `the owner link comes next (${ytcv.detectChannel().id})`);

    mockDOMElements['ownerLink'] = null;
    assert(ytcv.detectChannel().id === 'UCmeta',
      `and the meta tag last (${ytcv.detectChannel().id})`);

    mockDOMElements['metaChannel'] = null;
    assert(ytcv.detectChannel().id === '',
      `with nothing there, nothing is named (${ytcv.detectChannel().id})`);
  }

  section('Channel detection: a link that is there but carries no UC');
  {
    // The page keeps the element and puts a handle in it during an SPA
    // navigation. A handle is not an identifier here, so the next place is
    // asked rather than the id being taken from what is in hand.
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/@some-handle' };
    mockDOMElements['ownerLink'] = { href: 'https://www.youtube.com/channel/UCowner' };
    mockDOMElements['metaChannel'] = null;
    assert(ytcv.detectChannel().id === 'UCowner',
      `a canonical carrying no UC hands on (${ytcv.detectChannel().id})`);

    mockDOMElements['canonical'] = null;
    mockDOMElements['ownerLink'] = { href: 'https://www.youtube.com/@some-handle' };
    mockDOMElements['metaChannel'] = { content: 'UCmeta' };
    assert(ytcv.detectChannel().id === 'UCmeta',
      `and so does an owner link carrying none (${ytcv.detectChannel().id})`);

    mockDOMElements['ownerLink'] = { href: 'https://www.youtube.com/@some-handle' };
    mockDOMElements['metaChannel'] = null;
    assert(ytcv.detectChannel().id === '',
      `with a handle everywhere, nothing is named (${ytcv.detectChannel().id})`);
  }

  section('Channel detection: what the channel is called');
  {
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCnamed' };
    mockDOMElements['ownerLink'] = null;
    mockDOMElements['metaChannel'] = null;
    mockDOMElements['channelName'] = { textContent: '  The Name On Screen  ' };
    let found = ytcv.detectChannel();
    assert(found.name === 'The Name On Screen',
      `the name on screen is taken, trimmed (${JSON.stringify(found.name)})`);
    assert(found.url === 'https://www.youtube.com/channel/UCnamed',
      `and the url is built from the id (${found.url})`);

    // Nothing on screen: the meta tag the page carries for the title.
    mockDOMElements['channelName'] = { textContent: '   ' };
    mockDOMElements['metaName'] = { content: 'The Name In The Head' };
    found = ytcv.detectChannel();
    assert(found.name === 'The Name In The Head',
      `an element holding only spaces is not a name (${JSON.stringify(found.name)})`);

    // Nothing anywhere: the id stands in, so the popup shows something stable.
    mockDOMElements['channelName'] = null;
    mockDOMElements['metaName'] = null;
    found = ytcv.detectChannel();
    assert(found.name === 'UCnamed',
      `with no name to be had the id stands in (${found.name})`);

    // The same stand-in for each of the other two places.
    mockDOMElements['canonical'] = null;
    mockDOMElements['ownerLink'] = { href: 'https://www.youtube.com/channel/UCowner' };
    assert(ytcv.detectChannel().name === 'UCowner', 'for the owner link as well');
    mockDOMElements['ownerLink'] = null;
    mockDOMElements['metaChannel'] = { content: 'UCmeta' };
    assert(ytcv.detectChannel().name === 'UCmeta', 'and for the meta tag');
    mockDOMElements['metaChannel'] = null;
  }

  // ── What the bridge's answer moves, and what it leaves ─────────────

  section('Bridge message: a level for the video already in hand, and for a new one');
  {
    setURL('/watch', 'levelVid');
    mockStorage['channelVolumes'] = {};
    ytcv._set('currentChannel', { id: 'UClevel', name: 'Level Ch', url: '' });
    ytcv._set('currentChannelVideoId', 'levelVid');
    ytcv._set('currentLoudnessVideoId', 'levelVid');
    ytcv._set('currentLoudnessDb', -6);
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentAutoApplyLoudnessVideo', false);
    ytcv._set('storageMigrated', true);

    // A second answer for the same video that carries no level leaves the one
    // in hand alone: the bridge answers more than once per video.
    simulateBridgeMessage({ loudnessDb: null, isLiveContent: false, videoId: 'levelVid', channelId: 'UClevel' });
    await tick();
    assert(ytcv.state.currentLoudnessDb === -6,
      `a second answer with no level leaves the one in hand (${ytcv.state.currentLoudnessDb})`);

    // An answer for another video with no level clears it: the new video has
    // none, and the old video's level must not stand in for it.
    setURL('/watch', 'nextVid');
    simulateBridgeMessage({ loudnessDb: null, isLiveContent: false, videoId: 'nextVid', channelId: 'UClevel' });
    await tick();
    assert(ytcv.state.currentLoudnessDb === null,
      `an answer for another video with none clears it (${ytcv.state.currentLoudnessDb})`);
  }

  section('Bridge message: an answer that says nothing about the type');
  {
    setURL('/watch', 'typeSilentVid');
    ytcv._set('currentChannel', { id: 'UCsilent', name: 'Silent Ch', url: '' });
    ytcv._set('currentChannelVideoId', 'typeSilentVid');
    ytcv._set('currentLoudnessVideoId', 'typeSilentVid');
    ytcv._set('currentLoudnessDb', -6);
    // The bridge said this is a stream that is on air; `_set` does not carry
    // isLiveNow, so the state comes from a message that does.
    simulateBridgeMessage({
      loudnessDb: -6, isLiveContent: true, isLiveNow: true,
      videoId: 'typeSilentVid', channelId: 'UCsilent'
    });
    await tick();
    assert(ytcv.state.currentVideoType === 'live' && ytcv.state.currentIsLiveNow === true,
      'the stream is on air to begin with');
    // A diagnostic answer carries a level and no isLiveContent at all.
    simulateBridgeMessage({ loudnessDb: -8, videoId: 'typeSilentVid', channelId: 'UCsilent' });
    await tick();
    assert(ytcv.state.currentVideoType === 'live',
      `the type in hand is left alone (${ytcv.state.currentVideoType})`);
    assert(ytcv.state.currentIsLiveNow === true, 'and so is whether it is on air');
    assert(ytcv.state.currentLoudnessDb === -8, 'while the level it did carry is taken');
  }

  section('Bridge message: the orphan entry saved before a UC ever surfaced');
  {
    setURL('/watch', 'adoptVid');
    mockStorage['channelVolumes'] = {
      '@orphan_handle': { name: 'Orphan Ch', gainVideo: 0.42 }
    };
    ytcv._set('currentChannel', { id: '', name: '', url: '' });
    ytcv._set('currentChannelVideoId', '');
    ytcv._set('currentLoudnessVideoId', '');
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('currentVideoType', 'video');
    ytcv._set('storageMigrated', true);
    mockSentMessages.length = 0;
    // The bridge names the channel and the author, so the entry saved under
    // the handle is adopted by the UC that now names it.
    simulateBridgeMessage({
      loudnessDb: -5, isLiveContent: false, videoId: 'adoptVid',
      channelId: 'UCadopted', author: 'Orphan Ch'
    });
    await tick();
    await tick();
    assert('UCadopted' in mockStorage['channelVolumes'],
      `the entry moves to the UC (${JSON.stringify(Object.keys(mockStorage['channelVolumes']))})`);
    assert(mockStorage['channelVolumes']['UCadopted'].gainVideo === 0.42,
      'carrying the gain that was saved under the handle');
    assert(!('@orphan_handle' in mockStorage['channelVolumes']), 'and the handle entry is gone');

    // An answer with no author cannot say which entry belongs to this channel,
    // so nothing is adopted.
    mockStorage['channelVolumes'] = { '@another_handle': { name: 'Another Ch', gainVideo: 0.31 } };
    ytcv._set('currentChannel', { id: '', name: '', url: '' });
    ytcv._set('currentChannelVideoId', '');
    ytcv._set('currentLoudnessVideoId', '');
    mockSentMessages.length = 0;
    simulateBridgeMessage({
      loudnessDb: -5, isLiveContent: false, videoId: 'adoptVid', channelId: 'UCnoauthor'
    });
    await tick();
    await tick();
    assert(!mockSentMessages.some(m => m?.type === 'store:adoptHandleEntry'),
      `no adoption is asked for without an author (${JSON.stringify(mockSentMessages.map(m => m?.type))})`);
    assert('@another_handle' in mockStorage['channelVolumes'],
      'and the handle entry stays where it is');
  }

  section('Bridge message: Auto answers the message, or the saved gain does');
  {
    setURL('/watch', 'autoAnswerVid');
    mockStorage['channelVolumes'] = {
      UCauto: { name: 'Auto Ch', gainVideo: 0.33, autoApplyLoudnessVideo: true }
    };
    ytcv._set('currentChannel', { id: 'UCauto', name: 'Auto Ch', url: '' });
    ytcv._set('currentChannelVideoId', 'autoAnswerVid');
    ytcv._set('currentLoudnessVideoId', '');
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentAutoApplyLoudnessVideo', true);
    ytcv._set('currentGain', 1.0);
    ytcv._set('targetLufs', -18);
    ytcv._set('storageMigrated', true);
    ytcv._set('storageSettled', true);
    simulateBridgeMessage({
      loudnessDb: -6, isLiveContent: false, videoId: 'autoAnswerVid', channelId: 'UCauto'
    });
    // Read before anything is awaited: Auto answers the message where it
    // stands, and the saved-gain path is what would need a read first.
    assert(Math.abs(ytcv.state.currentGain - ytcv.calcGainFromLoudness(-6)) < 0.001,
      `Auto works the gain out as the message is handled (${ytcv.state.currentGain})`);
    await tick();
    assert(Math.abs(ytcv.state.currentGain - ytcv.calcGainFromLoudness(-6)) < 0.001,
      'and it is still that gain once everything has settled');
  }

  // ── The audio chain, and the overlay's place in the player ─────────

  section('Audio chain: with no player element there is nothing to build on');
  {
    const videoBefore = mockVideoEl;
    mockVideoEl = null;
    ytcv._set('gainNode', null);
    ytcv._set('sourceNode', null);
    ytcv._set('connectedVideo', null);
    ytcv._set('currentGain', 1.0);
    ytcv.commitGain(1.6);
    assert(ytcv.state.currentGain === 1.6,
      `the gain asked for is what the extension holds (${ytcv.state.currentGain})`);
    assert(ytcv.state.gainNode === null,
      `and nothing is built on an element that is not there (${ytcv.state.gainNode})`);
    assert(ytcv.state.connectedVideo === null, 'with no element taken up');
    mockVideoEl = videoBefore;
  }

  section('Audio chain: a gain of exactly 1.0 builds nothing');
  {
    // Passthrough is the state the extension leaves the page in, and taking the
    // element for it is what makes Live Caption flicker.
    mockVideoEl = { id: 'passthrough-video' };
    ytcv._set('gainNode', null);
    ytcv._set('sourceNode', null);
    ytcv._set('connectedVideo', null);
    ytcv._set('currentGain', 1.35);
    ytcv.commitGain(1.0);
    assert(ytcv.state.currentGain === 1.0, 'the gain is passthrough');
    assert(ytcv.state.gainNode === null,
      `and the element is left alone (${ytcv.state.gainNode})`);
    assert(ytcv.state.connectedVideo === null, 'with no element taken up for it');

    // Any other gain does take it up, and from then on passthrough goes through
    // the chain that is already there.
    ytcv.commitGain(1.2);
    assert(ytcv.state.gainNode !== null && ytcv.state.connectedVideo === mockVideoEl,
      'a gain that is not passthrough takes the element up');
    ytcv.commitGain(1.0);
    assert(ytcv.state.gainNode.gain.value === 1.0,
      `and passthrough then runs through the chain that exists (${ytcv.state.gainNode.gain.value})`);
  }

  section('Overlay: the player has no volume area yet');
  {
    const areaBefore = mockDOMElements['volumeArea'];
    const area = mockElement('div');
    mockDOMElements['volumeArea'] = area;
    simulateStorageChange({
      autoLoudnessSettings: { newValue: { targetLufs: -18, displayUnit: '%', showGainOverlay: true } }
    });
    await tick();
    ytcv.commitGain(1.8);
    assert(area.children.length === 1, `the overlay is in the player (${area.children.length})`);

    // The player's own controls sit beside the overlay, and a redraw leaves it
    // where it is rather than moving it to the end of the row.
    const ownControl = mockElement('button');
    area.appendChild(ownControl);
    ytcv.commitGain(1.85);
    assert(area.children.length === 2,
      `the row holds the overlay and the player's own control (${area.children.length})`);
    assert(area.children[0].textContent === '185%',
      `with the overlay still first and reading the gain (${area.children[0].textContent})`);
    assert(area.children[1] === ownControl, 'and the control after it');
    area.removeChild(ownControl);

    // The player is torn down: nothing to put it in, and the overlay that was
    // up is left where it was rather than being moved into nothing.
    mockDOMElements['volumeArea'] = null;
    ytcv.commitGain(1.9);
    assert(area.children.length === 1,
      `with no volume area the overlay stays where it was (${area.children.length})`);
    assert(area.children[0].textContent === '185%',
      `with the reading it had when the player was there (${area.children[0].textContent})`);

    simulateStorageChange({
      autoLoudnessSettings: { newValue: { targetLufs: -18, displayUnit: '%', showGainOverlay: false } }
    });
    await tick();
    ytcv.commitGain(1.0);
    mockDOMElements['volumeArea'] = areaBefore;
  }

  // ── The rest of what a rule-driven sweep found standing ────────────

  section('Storage: a write the worker turns down says why');
  {
    const realSend = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (msg) =>
      (String(msg?.type).startsWith('store:')
        ? Promise.resolve({ ok: false, reason: 'the worker said no' })
        : realSend(msg));
    let failure = null;
    await ytcv.saveChannelGain('UCreason', 'Reason Ch', 0.5, 'video', '', false)
      .catch((err) => { failure = err; });
    chrome.runtime.sendMessage = realSend;
    assert(failure instanceof Error, `the caller is told the write failed (${failure})`);
    assert(String(failure?.message) === 'the worker said no',
      `in the words the worker used (${failure?.message})`);

    // A worker that answers nothing at all still fails, in words of our own.
    chrome.runtime.sendMessage = (msg) =>
      (String(msg?.type).startsWith('store:') ? Promise.resolve(undefined) : realSend(msg));
    let silent = null;
    await ytcv.saveChannelGain('UCsilent', 'Silent Ch', 0.5, 'video', '', false)
      .catch((err) => { silent = err; });
    chrome.runtime.sendMessage = realSend;
    assert(String(silent?.message) === 'channel write failed',
      `a worker that says nothing is a failure too (${silent?.message})`);
  }

  section('Auto LUFS: what stops Auto from answering a message');
  {
    setURL('/watch', 'autoStopVid');
    mockStorage['channelVolumes'] = { UCstop: { name: 'Stop Ch', gainVideo: 0.4 } };
    ytcv._set('currentChannel', { id: 'UCstop', name: 'Stop Ch', url: '' });
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentAutoApplyLoudnessVideo', true);
    ytcv._set('currentLoudnessDb', -6);
    ytcv._set('targetLufs', -18);
    ytcv._set('currentGain', 1.0);
    ytcv._set('storageMigrated', true);

    // Before the fold has settled, Auto does not answer: the map is still in
    // the old shape and reading it under the current rule would take a manual
    // gain for one Auto is allowed to overwrite.
    ytcv._set('storageSettled', false);
    ytcv.notifyPopup();
    mockSentMessages.length = 0;
    simulateBridgeMessage({ loudnessDb: -6, isLiveContent: false, videoId: 'autoStopVid', channelId: 'UCstop' });
    assert(ytcv.state.currentGain === 1.0,
      `nothing is applied while the fold has not settled (${ytcv.state.currentGain})`);
    await tick();
    await tick();
    // Auto declining is what sends the message down the saved-gain path, which
    // waits for the fold itself: the channel ends up at what storage holds.
    assert(ytcv.state.currentGain === 0.4,
      `and the saved gain takes the message instead (${ytcv.state.currentGain})`);
    ytcv._set('currentGain', 1.0);

    // With the fold settled but no measurement, Auto has nothing to work from.
    ytcv._set('storageSettled', true);
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('currentLoudnessVideoId', '');
    ytcv._set('currentGain', 1.0);
    simulateBridgeMessage({ loudnessDb: null, isLiveContent: false, videoId: 'autoStopVid', channelId: 'UCstop' });
    assert(ytcv.state.currentGain === 1.0,
      `nor with no level to work from (${ytcv.state.currentGain})`);
    await tick();
    await tick();
    assert(ytcv.state.currentGain === 0.4,
      `the saved gain answers that one instead (${ytcv.state.currentGain})`);
  }

  section('Navigation: what each trigger asks for');
  {
    setURL('/watch', 'triggerVid');
    mockStorage['channelVolumes'] = { UCtrigger: { name: 'Trigger Ch', gainVideo: 0.65 } };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCtrigger' };
    mockVideoEl = { id: 'trigger-video' };
    ytcv._set('storageMigrated', true);
    ytcv._set('storageSettled', true);

    // A tab brought to the front that has never taken a video up runs an apply.
    ytcv._set('_lastProcessedVideo', null);
    ytcv._set('_lastVideoId', '');
    ytcv._set('_applyRunning', false);
    ytcv._set('currentGain', 1.0);
    fireVisibilityChange();
    await tick();
    assert(ytcv.state._lastProcessedVideo === mockVideoEl,
      `coming back to a tab that never applied takes the video up (${ytcv.state._lastProcessedVideo})`);

    // Brought to the front again, with the video already taken up, it does not.
    ytcv._set('currentGain', 1.0);
    ytcv._set('_applyRunning', false);
    fireVisibilityChange();
    await tick();
    assert(ytcv.state.currentGain === 1.0,
      `and coming back to one that has applies nothing (${ytcv.state.currentGain})`);

    // An apply already running is not joined by another trigger.
    ytcv._set('_applyRunning', true);
    ytcv._set('_lastProcessedVideo', null);
    ytcv._set('currentGain', 1.0);
    fireNavigateFinish();
    await tick();
    assert(ytcv.state._lastProcessedVideo === null,
      `a trigger arriving during an apply is turned away (${ytcv.state._lastProcessedVideo})`);
    ytcv._set('_applyRunning', false);
  }

  section('Upgrade: the fold is asked for once, and only until it lands');
  {
    mockSyncStorage = { autoLoudnessSettings: { targetLufs: -18 } };
    mockStorage = {
      channelVolumes: { UConce: { name: 'Once Ch', gainVideo: 0.3 } }
    };
    ytcv._set('storageMigrated', false);
    ytcv._set('storageSettled', true);
    mockSentMessages.length = 0;
    // Two triggers in flight at once ask the worker for one fold.
    await Promise.all([ytcv.foldLegacyGains(), ytcv.foldLegacyGains()]);
    const asks = mockSentMessages.filter(m => m?.type === 'store:migrateLegacyGains').length;
    assert(asks === 1, `two callers ask for one fold (${asks})`);
    assert(ytcv.state.storageMigrated === true, 'and it lands');

    // Once it has landed, nothing asks again.
    mockSentMessages.length = 0;
    await ytcv.foldLegacyGains();
    assert(mockSentMessages.filter(m => m?.type === 'store:migrateLegacyGains').length === 0,
      'a fold that has landed is not asked for again');
  }

  section('Audio: the context the page has not let start yet');
  {
    mockVideoEl = { id: 'gesture-video' };
    ytcv._set('gainNode', null);
    ytcv._set('sourceNode', null);
    ytcv._set('connectedVideo', null);
    ytcv._set('currentGain', 1.0);
    ytcv.commitGain(1.5);
    const ctx = ytcv.state.audioCtx;
    ctx.state = 'suspended';
    mockAudioAsks.resumes = 0;
    for (const fn of mockEventListeners['click'] || []) fn({ type: 'click' });
    assert(mockAudioAsks.resumes === 1,
      `a click starts the context the page left suspended (${mockAudioAsks.resumes})`);
    assert(ctx.state === 'running', 'and it is running afterwards');

    mockAudioAsks.resumes = 0;
    for (const fn of mockEventListeners['click'] || []) fn({ type: 'click' });
    assert(mockAudioAsks.resumes === 0,
      `a context already running is not asked again (${mockAudioAsks.resumes})`);
  }

  // ── The last five the sweep left standing ──────────────────────────

  section('Bridge message: naming a channel the answer has just introduced');
  {
    setURL('/watch', 'introVid');
    mockStorage['channelVolumes'] = {};
    mockDOMElements['channelName'] = { textContent: 'The Name On Screen' };
    ytcv._set('currentChannel', { id: '', name: '', url: '' });
    ytcv._set('currentChannelVideoId', '');
    ytcv._set('currentLoudnessVideoId', '');
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('storageMigrated', true);
    // With an author, that is the name — the DOM can still describe the video
    // the tab has left.
    simulateBridgeMessage({
      loudnessDb: -5, isLiveContent: false, videoId: 'introVid',
      channelId: 'UCintro', author: 'The Author'
    });
    await tick();
    assert(ytcv.state.currentChannel.name === 'The Author',
      `the author names a channel it introduces (${ytcv.state.currentChannel.name})`);

    // With no author, the screen answers.
    ytcv._set('currentChannel', { id: '', name: '', url: '' });
    ytcv._set('currentChannelVideoId', '');
    ytcv._set('currentLoudnessVideoId', '');
    simulateBridgeMessage({
      loudnessDb: -5, isLiveContent: false, videoId: 'introVid', channelId: 'UCintro2'
    });
    await tick();
    assert(ytcv.state.currentChannel.name === 'The Name On Screen',
      `the screen names it when the answer does not (${ytcv.state.currentChannel.name})`);

    // With neither, the id stands in so the popup has something to show.
    mockDOMElements['channelName'] = null;
    mockDOMElements['metaName'] = null;
    ytcv._set('currentChannel', { id: '', name: '', url: '' });
    ytcv._set('currentChannelVideoId', '');
    ytcv._set('currentLoudnessVideoId', '');
    simulateBridgeMessage({
      loudnessDb: -5, isLiveContent: false, videoId: 'introVid', channelId: 'UCintro3'
    });
    await tick();
    assert(ytcv.state.currentChannel.name === 'UCintro3',
      `and the id stands in when nothing else can (${ytcv.state.currentChannel.name})`);
  }

  section('Popup open: a level already in hand answers without waiting');
  {
    setURL('/watch', 'haveVid');
    mockStorage['channelVolumes'] = { UChave: { name: 'Have Ch', gainVideo: 0.5 } };
    ytcv._set('currentChannel', { id: 'UChave', name: 'Have Ch', url: '' });
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentLoudnessDb', -9);
    ytcv._set('currentLoudnessVideoId', 'haveVid');
    ytcv._set('_lastVideoId', 'haveVid');
    ytcv._set('_lastProcessedVideo', mockVideoEl);
    ytcv._set('_applyRunning', false);
    ytcv._set('storageMigrated', true);
    let asks = 0;
    mockPostMessageHandler = (data) => {
      if (data?.type === '__yt_channel_volume_request__') asks += 1;
    };
    const answer = await simulateRuntimeMessage({ type: 'forceDetect' });
    mockPostMessageHandler = null;
    assert(answer?.loudnessDb === -9,
      `the level in hand is what the popup is told (${answer?.loudnessDb})`);
    assert(asks === 1,
      `and the bridge is asked once rather than ten times over (${asks})`);
  }

  section('Auto LUFS: a channel that is not on Auto lets the saved gain stand');
  {
    setURL('/watch', 'notAutoVid');
    mockStorage['channelVolumes'] = { UCnotauto: { name: 'Not Auto Ch', gainVideo: 0.45 } };
    ytcv._set('currentChannel', { id: 'UCnotauto', name: 'Not Auto Ch', url: '' });
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentAutoApplyLoudnessVideo', false);
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('currentLoudnessVideoId', '');
    ytcv._set('currentGain', 1.0);
    ytcv._set('storageMigrated', true);
    ytcv._set('storageSettled', true);
    simulateBridgeMessage({
      loudnessDb: -6, isLiveContent: false, videoId: 'notAutoVid', channelId: 'UCnotauto'
    });
    assert(ytcv.state.currentGain === 1.0,
      `Auto does not answer for a channel that is not on it (${ytcv.state.currentGain})`);
    await tick();
    await tick();
    assert(ytcv.state.currentGain === 0.45,
      `the saved gain answers instead (${ytcv.state.currentGain})`);
  }

  section('Apply: the answer that arrives after the apply is applied too');
  {
    setURL('/watch', 'lateVid');
    mockStorage['channelVolumes'] = {
      UClate: { name: 'Late Ch', gainVideo: 0.2, autoApplyLoudnessVideo: true }
    };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UClate' };
    mockVideoEl = { id: 'late-video' };
    ytcv._set('targetLufs', -18);
    ytcv._set('_lastVideoId', 'lateVid');
    ytcv._set('_lastProcessedVideo', null);
    ytcv._set('_applyRunning', false);
    ytcv._set('currentChannel', { id: 'UClate', name: 'Late Ch', url: '' });
    ytcv._set('currentChannelVideoId', 'lateVid');
    ytcv._set('currentLoudnessVideoId', '');
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentAutoApplyLoudnessVideo', true);
    ytcv._set('currentGain', 1.0);
    ytcv._set('storageMigrated', true);
    ytcv._set('storageSettled', true);
    // The bridge answers while the apply is asking for it.
    mockPostMessageHandler = (data) => {
      if (data?.type !== '__yt_channel_volume_request__') return;
      mockPostMessageHandler = null;
      simulateBridgeMessage({
        loudnessDb: -6, isLiveContent: false, videoId: 'lateVid', channelId: 'UClate'
      });
    };
    await ytcv.applyVideoVolume();
    await tick();
    await tick();
    mockPostMessageHandler = null;
    assert(Math.abs(ytcv.state.currentGain - ytcv.calcGainFromLoudness(-6)) < 0.001,
      `the level that arrived while the apply asked for it is applied (${ytcv.state.currentGain})`);
    assert(mockStorage['channelVolumes']['UClate'].gainVideo !== 0.2,
      `and stored as the channel's gain (${mockStorage['channelVolumes']['UClate'].gainVideo})`);
  }

  section('Apply: the popup is told the gain the late answer settled on');
  {
    setURL('/watch', 'settleVid');
    mockStorage['channelVolumes'] = { UCsettle: { name: 'Settle Ch', gainVideo: 0.55 } };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCsettle' };
    mockVideoEl = { id: 'settle-video' };
    ytcv._set('_lastVideoId', 'settleVid');
    ytcv._set('_lastProcessedVideo', null);
    ytcv._set('_applyRunning', false);
    ytcv._set('currentChannel', { id: 'UCsettle', name: 'Settle Ch', url: '' });
    ytcv._set('currentChannelVideoId', 'settleVid');
    ytcv._set('currentLoudnessVideoId', '');
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentAutoApplyLoudnessVideo', false);
    ytcv._set('currentGain', 1.0);
    ytcv._set('storageMigrated', true);
    ytcv._set('storageSettled', true);
    // Another tab saves a new gain while this apply is waiting for the bridge,
    // and the answer that ends the wait carries no level of its own.
    mockPostMessageHandler = (data) => {
      if (data?.type !== '__yt_channel_volume_request__') return;
      mockPostMessageHandler = null;
      mockStorage['channelVolumes'] = { UCsettle: { name: 'Settle Ch', gainVideo: 0.8 } };
      simulateBridgeMessage({
        loudnessDb: null, isLiveContent: false, videoId: 'settleVid', channelId: 'UCsettle'
      });
    };
    await ytcv.applyVideoVolume();
    mockSentMessages.length = 0;
    await tick();
    await tick();
    mockPostMessageHandler = null;
    assert(ytcv.state.currentGain === 0.8,
      `the gain the wait settled on is applied (${ytcv.state.currentGain})`);
    const told = mockSentMessages.filter(m => m?.type === 'stateChanged');
    assert(told.length > 0, `and the popup is told (${told.length})`);
    assert(!told.some((m) => m?.gain === 0.55),
      `and it is not told the gain from before the wait on the way (${JSON.stringify(told.map((m) => m?.gain))})`);
    assert(told[told.length - 1]?.gain === 0.8,
      `what it ends up with is the gain that settled (${told[told.length - 1]?.gain})`);
  }

  section('Observer: a video the page swapped under the extension');
  {
    setURL('/watch', 'swapVid2');
    mockStorage['channelVolumes'] = { UCswapped: { name: 'Swapped Ch', gainVideo: 0.55 } };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCswapped' };
    // The channel was named for this video before the element changed.
    ytcv._set('currentChannel', { id: 'UCswapped', name: 'Swapped Ch', url: '' });
    ytcv._set('currentChannelVideoId', 'swapVid2');
    ytcv._set('storageMigrated', true);
    ytcv._set('storageSettled', true);
    ytcv._set('_lastVideoId', 'swapVid2');
    ytcv._set('_applyRunning', false);
    ytcv._set('currentGain', 1.0);
    const firstVideo = { id: 'observer-first' };
    mockVideoEl = firstVideo;
    ytcv._set('_lastProcessedVideo', firstVideo);
    // The page replaces the element without changing the URL.
    mockVideoEl = { id: 'observer-second' };
    fireObserver();
    await tick();
    assert(ytcv.state._lastProcessedVideo === mockVideoEl,
      `the element that replaced it is taken up (${ytcv.state._lastProcessedVideo?.id})`);
    assert(ytcv.state.currentGain === 0.55,
      `and the channel's gain is applied to it (${ytcv.state.currentGain})`);
  }

  section('Popup: Apply is a gesture made against a state as well');
  {
    mockStorage['channelVolumes'] = {
      UCold: { name: 'Old Ch', gainVideo: 0.5, url: '' },
      UCnew: { name: 'New Ch', gainVideo: 0.6, url: '' }
    };
    setURL('/watch', 'applyVidA');
    ytcv._set('currentChannel', { id: 'UCold', name: 'Old Ch', url: '' });
    ytcv._set('currentChannelVideoId', ytcv.getUrlVideoId());
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentLoudnessDb', -6);
    ytcv._set('currentLoudnessVideoId', 'applyVidA');
    ytcv._set('currentAutoApplyLoudnessVideo', false);
    ytcv._set('currentGain', 0.5);
    ytcv._set('targetLufs', -18);
    ytcv._set('storageMigrated', true);
    const drawnFrom = (await simulateRuntimeMessage({ type: 'getState' })).appliesTo;

    // The tab moves to another channel before the click is delivered.
    setURL('/watch', 'applyVidB');
    ytcv._set('currentChannel', { id: 'UCnew', name: 'New Ch', url: '' });
    ytcv._set('currentChannelVideoId', ytcv.getUrlVideoId());
    ytcv._set('currentLoudnessDb', -4);
    ytcv._set('currentLoudnessVideoId', 'applyVidB');
    ytcv._set('currentGain', 0.6);
    const stale = await simulateRuntimeMessage({ type: 'applyLoudness', appliesTo: drawnFrom });
    await tick();
    assert(stale?.ok === false && stale?.reason === 'state moved',
      `an Apply made against the state before is refused — got ${JSON.stringify(stale)}`);
    assert(mockStorage['channelVolumes']['UCnew'].gainVideo === 0.6,
      `the channel now being watched is not written (${mockStorage['channelVolumes']['UCnew'].gainVideo})`);
    assert(mockStorage['channelVolumes']['UCold'].gainVideo === 0.5,
      'and neither is the one the popup was drawn from');
    assert(ytcv.state.currentGain === 0.6,
      `with the level left where it was (${ytcv.state.currentGain})`);

    // The same channel and type, a different video: the measurement on screen
    // belongs to the video that was playing, not to this one.
    const drawnOnB = (await simulateRuntimeMessage({ type: 'getState' })).appliesTo;
    setURL('/watch', 'applyVidC');
    ytcv._set('currentLoudnessDb', -2);
    ytcv._set('currentLoudnessVideoId', 'applyVidC');
    const otherVideo = await simulateRuntimeMessage({ type: 'applyLoudness', appliesTo: drawnOnB });
    await tick();
    assert(otherVideo?.ok === false && otherVideo?.reason === 'state moved',
      `an Apply for another video of the same channel is refused — got ${JSON.stringify(otherVideo)}`);
    assert(mockStorage['channelVolumes']['UCnew'].gainVideo === 0.6,
      `with nothing written for it (${mockStorage['channelVolumes']['UCnew'].gainVideo})`);

    // Made against the state in hand, once the bridge has named the channel
    // for this video, it applies.
    ytcv._set('currentChannelVideoId', 'applyVidC');
    const now = await popupGesture({ type: 'applyLoudness' });
    await tick();
    assert(now?.ok === true, `the Apply made against this state goes through — got ${JSON.stringify(now)}`);
    assert(Math.abs(mockStorage['channelVolumes']['UCnew'].gainVideo - ytcv.calcGainFromLoudness(-2)) < 0.001,
      `and saves the gain the measurement asks for (${mockStorage['channelVolumes']['UCnew'].gainVideo})`);
  }

  section('Popup: a video changing on its own is a new state to be told about');
  {
    setURL('/watch', 'tokenVidA');
    mockStorage['channelVolumes'] = { UCtoken: { name: 'Token Ch', gainVideo: 0.5 } };
    ytcv._set('currentChannel', { id: 'UCtoken', name: 'Token Ch', url: '' });
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentLoudnessDb', -6);
    ytcv._set('currentLoudnessVideoId', 'tokenVidA');
    ytcv._set('currentGain', 0.5);
    ytcv.notifyPopup();
    mockSentMessages.length = 0;
    // Everything the popup shows is the same; only the video is another one.
    setURL('/watch', 'tokenVidB');
    ytcv._set('currentLoudnessVideoId', 'tokenVidB');
    ytcv.notifyPopup();
    const told = mockSentMessages.filter(m => m?.type === 'stateChanged');
    assert(told.length === 1,
      `the popup is told the state moved (${told.length})`);
    assert(told[0]?.appliesTo !== undefined && told[0]?.appliesTo.includes('tokenVidB'),
      `and what it is told names the video now playing (${told[0]?.appliesTo})`);
  }

  // ── Summary ────────────────────────────────────────────────────────

  // ── What the popup draws, and what it sends ──

  section('Popup: the channel, the level and the gain it is given');
  {
    const popup = makePopup({
      answer: async () => ({
        isWatchPage: true,
        channel: { id: 'UCdraw', name: 'Draw Ch', url: '' },
        appliesTo: 'UCdraw|video|drawVid',
        loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.5,
        targetLufs: -18, videoType: 'video', isLiveNow: false,
        autoApplyLoudnessVideo: false, autoApplyLoudnessLive: false
      })
    });
    await popup.ready();
    assert(popup.node('html').lang === 'pageLanguage',
      'the page declares the language the catalog answers with');
    const drawn = (el) => popup.node(el).textContent
      + (popup.node(el).children[0] ? popup.node(el).children[0].textContent : '');
    assert(popup.node('channelName').textContent === 'Draw Ch',
      `the channel is named (${popup.node('channelName').textContent})`);
    assert(drawn('contentLufs') === (YT_REFERENCE_LUFS - 6).toFixed(1) + ' LUFS',
      `the level is drawn with its unit (${drawn('contentLufs')})`);
    assert(drawn('suggestedVol') === String(gainToPercent(calcGain(-6, -18))) + '%',
      `the suggested gain comes from the level and the target (${drawn('suggestedVol')})`);
    assert(drawn('currentVol') === '150%', `the gain in force is drawn (${drawn('currentVol')})`);
    assert(Number(popup.node('volumeSlider').value) === 150,
      `and the slider stands at it (${popup.node('volumeSlider').value})`);
    assert(popup.node('videoTypeBadge').style.display === 'none',
      'a video that is not live carries no LIVE badge');
    assert(popup.node('autoVideoControl').style.display === ''
      && popup.node('autoLiveControl').style.display === 'none',
      'and the Auto control on screen is the one for videos');
    assert(popup.node('applyBtn').disabled === false, 'the apply button can be pressed');
    assert(popup.node('applyBtn').textContent.includes('typeVideo'),
      `and names the type it would save under (${popup.node('applyBtn').textContent})`);
    assert(popup.node('autoApplyLiveToggle').disabled === true,
      'the Auto toggle for live is not available while a video is being watched');
    assert(popup.node('autoApplyVideoToggle').disabled === false,
      'and the one for videos is');
  }

  section('Popup: a premiere is not a live stream');
  {
    // isLiveNow is true for a premiere as well, so the badge takes both.
    const premiere = makePopup({
      answer: async () => ({
        isWatchPage: true,
        channel: { id: 'UCpre', name: 'Premiere Ch', url: '' },
        appliesTo: 'UCpre|video|preVid',
        loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
        targetLufs: -18, videoType: 'video', isLiveNow: true
      })
    });
    await premiere.ready();
    assert(premiere.node('videoTypeBadge').style.display === 'none',
      'a premiere carries no LIVE badge');

    const live = makePopup({
      answer: async () => ({
        isWatchPage: true,
        channel: { id: 'UClive', name: 'Live Ch', url: '' },
        appliesTo: 'UClive|live|liveVid',
        loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
        targetLufs: -18, videoType: 'live', isLiveNow: true
      })
    });
    await live.ready();
    assert(live.node('videoTypeBadge').style.display === ''
      && live.node('videoTypeBadge').textContent === 'typeLive',
      `a live stream carries it (${live.node('videoTypeBadge').textContent})`);
    assert(live.node('autoLiveControl').style.display === ''
      && live.node('autoVideoControl').style.display === 'none',
      'and the Auto control on screen is the one for live');
    assert(live.node('applyBtn').textContent.includes('typeLive'),
      `the apply button names live as what it would save under (${live.node('applyBtn').textContent})`);
    assert(live.node('autoApplyVideoToggle').disabled === true
      && live.node('autoApplyLiveToggle').disabled === false,
      'and the toggles swap with it');
  }

  section('Popup: what it says when it does not know');
  {
    const noLevel = makePopup({
      answer: async () => ({
        isWatchPage: true,
        channel: { id: 'UCnone', name: 'None Ch', url: '' },
        appliesTo: 'UCnone|video|noneVid',
        loudnessDb: null, contentLufs: null, gain: 1.0, targetLufs: -18, videoType: 'video'
      })
    });
    await noLevel.ready();
    assert(noLevel.node('contentLufs').textContent === '---',
      `the level is unknown (${noLevel.node('contentLufs').textContent})`);
    assert(noLevel.node('suggestedVol').textContent === '---',
      `so is the gain it would suggest (${noLevel.node('suggestedVol').textContent})`);
    assert(noLevel.node('suggestedVol').className.split(' ').includes('suggested'),
      `an unknown suggestion is still the suggestion card (${noLevel.node('suggestedVol').className})`);
    assert(noLevel.node('applyBtn').disabled === true, 'the apply button cannot be pressed');

    const noChannel = makePopup({
      answer: async () => ({
        isWatchPage: true,
        channel: { id: '', name: '' },
        loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0, targetLufs: -18
      })
    });
    await noChannel.settled();
    assert(noChannel.node('channelName').textContent === 'channelNotDetected',
      `a page with no channel says so (${noChannel.node('channelName').textContent})`);
    assert(noChannel.node('applyHint').textContent === 'hintNoChannel',
      `and the hint says why (${noChannel.node('applyHint').textContent})`);
    assert(noChannel.node('autoApplyVideoToggle').disabled === true
      && noChannel.node('autoApplyLiveToggle').disabled === true,
      'with neither Auto toggle available');
  }

  section('Popup: Auto takes the manual controls, and says it has');
  {
    const auto = makePopup({
      answer: async () => ({
        isWatchPage: true,
        channel: { id: 'UCauto', name: 'Auto Ch', url: '' },
        appliesTo: 'UCauto|video|autoVid',
        loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.2,
        targetLufs: -18, videoType: 'video', autoApplyLoudnessVideo: true
      })
    });
    await auto.ready();
    assert(auto.node('applyBtn').disabled === true,
      'with Auto on there is nothing to apply by hand');
    assert(auto.node('applyHint').textContent === 'hintAutoApplyEnabled',
      `and the hint says so (${auto.node('applyHint').textContent})`);
    assert(auto.node('fallbackBadge').style.display === 'none',
      'a level in hand needs no fallback badge');

    // Auto on with no level to follow: the badge says the gain is a fallback.
    const fallback = makePopup({
      answer: async () => ({
        isWatchPage: true,
        channel: { id: 'UCfall', name: 'Fallback Ch', url: '' },
        appliesTo: 'UCfall|video|fallVid',
        loudnessDb: null, contentLufs: null, gain: 1.2,
        targetLufs: -18, videoType: 'video', autoApplyLoudnessVideo: true
      })
    });
    await fallback.ready();
    assert(fallback.node('fallbackBadge').style.display === '',
      `Auto with no level to follow says the gain is a fallback (${fallback.node('fallbackBadge').style.display})`);
    // With no level to follow, the gain that stands is the viewer's own, so
    // the manual controls stay theirs to move.
    assert(fallback.node('volumeSlider').disabled === false,
      'and the slider is still theirs to move');
    assert(auto.node('volumeSlider').disabled === true,
      'while Auto with a level to follow takes it');
  }

  section('Popup: which screen it opens on');
  {
    const elsewhere = makePopup({ tabUrl: 'https://example.com/' });
    await elsewhere.settled();
    assert(elsewhere.node('main').style.display === 'none'
      && elsewhere.node('notYt').style.display === '',
      `a tab that is not YouTube gets its own screen (${elsewhere.node('notYt').style.display})`);
    assert(elsewhere.asked.length === 0,
      `and nothing is asked of it (${JSON.stringify(elsewhere.asked)})`);

    const noTab = makePopup({ tabUrl: null });
    await noTab.settled();
    assert(noTab.node('notYt').style.display === '',
      'so does a window with no active tab');

    // A gesture made on a screen that never found a tab has nowhere to go.
    const noTabGesture = makePopup({ tabUrl: null });
    await noTabGesture.settled();
    await noTabGesture.firePreset(1, 'click');
    await noTabGesture.fire('volumeSlider', 'change');
    await noTabGesture.fire('applyBtn', 'click');
    assert(noTabGesture.attempts.length === 0,
      `nothing is sent from a screen with no tab behind it (${JSON.stringify(noTabGesture.attempts)})`);

    const notWatch = makePopup({ answer: async () => ({ isWatchPage: false }) });
    await notWatch.settled();
    assert(notWatch.node('main').style.display === 'none'
      && notWatch.node('notWatch').style.display === '',
      `a page that is not a watch page gets its own (${notWatch.node('notWatch').style.display})`);

    const gone = makePopup({ answer: async () => { throw new Error('Receiving end does not exist'); } });
    await gone.settled();
    assert(gone.node('main').style.display === 'none'
      && gone.node('reloadNeeded').style.display === '',
      `a page that cannot answer is asked to be reloaded (${gone.node('reloadNeeded').style.display})`);
  }

  section('Popup: a broadcast from its own tab only');
  {
    // The tab has applied its video and holds the channel named for it.
    ytcv._set('currentChannel', { id: 'UCownTab', name: 'Own Tab', url: '' });
    ytcv._set('_lastVideoId', ytcv.getUrlVideoId());
    ytcv._set('currentChannelVideoId', ytcv.getUrlVideoId());
    const popup = makePopup();
    await popup.ready();
    const drawn = popup.node('channelName').textContent;
    await popup.deliver({
      type: 'stateChanged',
      channel: { id: 'UCother', name: 'Another Tab', url: '' },
      appliesTo: 'UCother|video|otherVid', gain: 1.0, targetLufs: -18
    }, 10);
    assert(popup.node('channelName').textContent === drawn,
      `another tab's state is not drawn (${popup.node('channelName').textContent})`);
    await popup.deliver({
      type: 'somethingElse',
      channel: { id: 'UCkind', name: 'Another Kind', url: '' },
      appliesTo: 'UCkind|video|kindVid', gain: 1.0, targetLufs: -18
    });
    assert(popup.node('channelName').textContent === drawn,
      `nor is a message of another kind (${popup.node('channelName').textContent})`);
  }

  section('Popup: the unit the settings name');
  {
    const asDb = makePopup({
      displayUnit: 'dB',
      answer: async () => ({
        isWatchPage: true,
        channel: { id: 'UCdb', name: 'dB Ch', url: '' },
        appliesTo: 'UCdb|video|dbVid',
        loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 2.0,
        targetLufs: -18, videoType: 'video'
      })
    });
    await asDb.ready();
    const inDb = formatGain(2.0, 'dB');
    assert(asDb.node('volumeValue').textContent === inDb.text + inDb.unit,
      `the figure beside the slider is in dB (${asDb.node('volumeValue').textContent})`);
    assert(Number(asDb.node('volumeSlider').value) === 200,
      `while the slider itself still stands in percent (${asDb.node('volumeSlider').value})`);
  }

  section('Popup: the Auto toggle it sends, and what it does with the answer');
  {
    const watching = (over = {}) => ({
      isWatchPage: true,
      channel: { id: 'UCtoggle', name: 'Toggle Ch', url: '' },
      appliesTo: 'UCtoggle|video|toggleVid',
      loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
      targetLufs: -18, videoType: 'video',
      autoApplyLoudnessVideo: false, autoApplyLoudnessLive: false,
      ...over
    });

    // The answer to the toggle is drawn from directly.
    const accepted = makePopup({
      answer: async (message) => (message.type === 'setAutoApplyLoudness'
        ? { ok: true, ...watching({ autoApplyLoudnessVideo: true, gain: 1.4 }) }
        : watching())
    });
    await accepted.ready();
    accepted.asked.length = 0;
    accepted.node('autoApplyVideoToggle').checked = true;
    await accepted.fire('autoApplyVideoToggle', 'change');
    const sent = accepted.asked.filter((m) => m.type === 'setAutoApplyLoudness');
    assert(sent.length === 1 && sent[0].enabled === true,
      `the toggle sends what it was moved to (${JSON.stringify(sent)})`);
    assert(sent[0].appliesTo === 'UCtoggle|video|toggleVid',
      `against the state on screen (${sent[0].appliesTo})`);
    assert(accepted.asked.filter((m) => m.type === 'getState').length === 0,
      `an accepted answer is drawn from without asking again (${JSON.stringify(accepted.asked)})`);
    assert(accepted.node('applyHint').textContent === 'hintAutoApplyEnabled',
      `and the screen follows it (${accepted.node('applyHint').textContent})`);

    // A refused one is not: the write may have landed, so the page is asked.
    const refused = makePopup({
      answer: async (message) => (message.type === 'setAutoApplyLoudness'
        ? { ok: false, reason: 'state moved' }
        : watching())
    });
    await refused.ready();
    refused.asked.length = 0;
    refused.node('autoApplyVideoToggle').checked = true;
    await refused.fire('autoApplyVideoToggle', 'change');
    assert(refused.asked.filter((m) => m.type === 'getState').length === 1,
      `a refused answer sends the popup back to the page (${JSON.stringify(refused.asked)})`);
    assert(refused.node('autoApplyVideoToggle').checked === false,
      `and the toggle goes back to what the page holds (${refused.node('autoApplyVideoToggle').checked})`);

    // A toggle for the type not being watched is not sent at all.
    const wrongType = makePopup({ answer: async () => watching() });
    await wrongType.ready();
    wrongType.asked.length = 0;
    wrongType.node('autoApplyLiveToggle').disabled = false;
    wrongType.node('autoApplyLiveToggle').checked = true;
    await wrongType.fire('autoApplyLiveToggle', 'change');
    assert(wrongType.asked.length === 0,
      `the toggle for the other type sends nothing (${JSON.stringify(wrongType.asked)})`);
  }

  section('Popup: a page with no channel sends nothing');
  {
    const noChannel = makePopup({
      answer: async () => ({
        isWatchPage: true,
        channel: { id: '', name: '' },
        loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
        targetLufs: -18, videoType: 'video'
      })
    });
    await noChannel.settled();
    noChannel.asked.length = 0;
    noChannel.node('volumeSlider').value = '30';
    await noChannel.fire('volumeSlider', 'input');
    await noChannel.fire('volumeSlider', 'change');
    await noChannel.firePreset(0, 'click');
    await noChannel.fire('applyBtn', 'click');
    assert(noChannel.asked.length === 0,
      `nothing is sent with no channel to save under (${JSON.stringify(noChannel.asked)})`);
  }

  section('Popup: a gain the page turns down sends it back to the page');
  {
    const turnedDown = makePopup({
      answer: async (message) => (message.type === 'setGain'
        ? { ok: false, reason: 'state moved' }
        : {
          isWatchPage: true,
          channel: { id: 'UCturn', name: 'Turn Ch', url: '' },
          appliesTo: 'UCturn|video|turnVid',
          loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
          targetLufs: -18, videoType: 'video'
        })
    });
    await turnedDown.ready();
    turnedDown.asked.length = 0;
    turnedDown.node('volumeSlider').value = '30';
    await turnedDown.fire('volumeSlider', 'input');
    await turnedDown.fire('volumeSlider', 'change');
    assert(turnedDown.asked.filter((m) => m.type === 'getState').length > 0,
      `a refused gain is followed by a re-read (${JSON.stringify(turnedDown.asked)})`);
    assert(Number(turnedDown.node('volumeSlider').value) === 100,
      `and the slider goes back to what the page holds (${turnedDown.node('volumeSlider').value})`);

    // One the page takes is not re-read.
    const taken = makePopup({
      answer: async () => ({
        isWatchPage: true,
        channel: { id: 'UCtaken', name: 'Taken Ch', url: '' },
        appliesTo: 'UCtaken|video|takenVid',
        loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
        targetLufs: -18, videoType: 'video', ok: true
      })
    });
    await taken.ready();
    taken.asked.length = 0;
    taken.node('volumeSlider').value = '30';
    await taken.fire('volumeSlider', 'input');
    await taken.fire('volumeSlider', 'change');
    assert(taken.asked.filter((m) => m.type === 'getState').length === 0,
      `a gain the page takes is not read back (${JSON.stringify(taken.asked)})`);
  }

  section('Popup: how long it goes on asking for a level');
  {
    const withLevel = (level) => ({
      isWatchPage: true,
      channel: { id: 'UCask', name: 'Ask Ch', url: '' },
      appliesTo: 'UCask|video|askVid',
      loudnessDb: level, contentLufs: level === null ? null : YT_REFERENCE_LUFS + level,
      gain: 1.0, targetLufs: -18, videoType: 'video'
    });

    let asks = 0;
    const never = makePopup({ answer: async () => { asks += 1; return withLevel(null); } });
    await never.ready();
    for (let round = 0; round < 12; round++) await never.runTimers();
    assert(asks === 9, `the forceDetect and eight retries, and no more (${asks})`);

    let known = 0;
    const atOnce = makePopup({ answer: async () => { known += 1; return withLevel(-6); } });
    await atOnce.ready();
    await atOnce.runTimers();
    assert(known === 1, `a level answered at once is not asked for again (${known})`);

    let quiet = 0;
    const unanswered = makePopup({
      answer: async (message) => {
        quiet += 1;
        return message.type === 'getState' ? undefined : withLevel(null);
      }
    });
    await unanswered.ready();
    for (let round = 0; round < 5; round++) await unanswered.runTimers();
    assert(quiet === 2, `an ask that goes unanswered ends the waiting (${quiet})`);

    let arrived = 0;
    const byBroadcast = makePopup({ answer: async () => { arrived += 1; return withLevel(null); } });
    await byBroadcast.ready();
    await byBroadcast.deliver({ type: 'stateChanged', ...withLevel(-6) });
    const before = arrived;
    for (let round = 0; round < 3; round++) await byBroadcast.runTimers();
    assert(arrived === before,
      `a level that arrived another way is not asked for again (${arrived - before})`);
  }

  section('Popup: a card with no unit, and a target it was not told');
  {
    const popup = makePopup();
    await popup.ready();
    await popup.deliver({
      type: 'stateChanged',
      channel: { id: 'UCunit', name: 'Unit Ch', url: '' },
      appliesTo: 'UCunit|video|unitVid',
      loudnessDb: null, contentLufs: null, gain: 1.0, targetLufs: -18, videoType: 'video'
    });
    assert(popup.node('contentLufs').children.length === 0,
      `an unknown level carries no unit beside it (${popup.node('contentLufs').children.length})`);
    assert(popup.node('contentLufs').className.split(' ').includes('unknown'),
      `and says it is unknown (${popup.node('contentLufs').className})`);

    await popup.deliver({
      type: 'stateChanged',
      channel: { id: 'UCunit', name: 'Unit Ch', url: '' },
      appliesTo: 'UCunit|video|unitVid',
      loudnessDb: -9, contentLufs: YT_REFERENCE_LUFS - 9, gain: 1.0,
      targetLufs: -12, videoType: 'video'
    });
    const withTarget = popup.node('suggestedVol').textContent;
    assert(withTarget === String(gainToPercent(calcGain(-9, -12))),
      `the suggestion follows the target it was given (${withTarget})`);
    await popup.deliver({
      type: 'stateChanged',
      channel: { id: 'UCunit', name: 'Unit Ch', url: '' },
      appliesTo: 'UCunit|video|unitVid',
      loudnessDb: -9, contentLufs: YT_REFERENCE_LUFS - 9, gain: 1.0, videoType: 'video'
    });
    assert(popup.node('suggestedVol').textContent === withTarget,
      `a state naming no target leaves it where it was (${popup.node('suggestedVol').textContent})`);
  }

  section('Popup: a toggle the page cannot answer for goes back from memory');
  {
    const watching = {
      isWatchPage: true,
      channel: { id: 'UCback', name: 'Back Ch', url: '' },
      appliesTo: 'UCback|video|backVid',
      loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
      targetLufs: -18, videoType: 'video',
      autoApplyLoudnessVideo: false, autoApplyLoudnessLive: false
    };
    // The toggle is refused and the page then answers nothing: there is no
    // state to draw, so the toggle goes back to what this popup last knew.
    let drawn = 0;
    const silent = makePopup({
      answer: async (message) => {
        if (message.type === 'setAutoApplyLoudness') return { ok: false, reason: 'state moved' };
        drawn += 1;
        return drawn === 1 ? watching : undefined;
      }
    });
    await silent.ready();
    silent.node('autoApplyVideoToggle').checked = true;
    await silent.fire('autoApplyVideoToggle', 'change');
    assert(silent.node('autoApplyVideoToggle').checked === false,
      `the toggle goes back to what the popup last knew (${silent.node('autoApplyVideoToggle').checked})`);
    assert(silent.node('autoApplyVideoToggle').disabled === false,
      'and is left available, the video being the one on screen');
    assert(silent.node('autoApplyLiveToggle').disabled === true,
      'while the one for the other type stays unavailable');

    // The same when the page cannot be reached at all.
    let reached = 0;
    const unreachable = makePopup({
      answer: async (message) => {
        if (message.type === 'setAutoApplyLoudness') return { ok: false, reason: 'state moved' };
        reached += 1;
        if (reached === 1) return watching;
        throw new Error('Receiving end does not exist');
      }
    });
    await unreachable.ready();
    unreachable.node('autoApplyVideoToggle').checked = true;
    await unreachable.fire('autoApplyVideoToggle', 'change');
    assert(unreachable.node('autoApplyVideoToggle').checked === false,
      `a page that cannot be reached leaves the toggle where the popup had it (${unreachable.node('autoApplyVideoToggle').checked})`);
    assert(unreachable.node('autoApplyVideoToggle').disabled === false,
      'and available again rather than stuck');
  }

  section('Popup: a preset saves, and an answer of nothing draws nothing');
  {
    const popup = makePopup({
      answer: async (message) => (message.type === 'setGain'
        ? { ok: true }
        : {
          isWatchPage: true,
          channel: { id: 'UCpreset', name: 'Preset Ch', url: '' },
          appliesTo: 'UCpreset|video|presetVid',
          loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
          targetLufs: -18, videoType: 'video'
        })
    });
    await popup.ready();
    popup.asked.length = 0;
    await popup.firePreset(2, 'click');
    const saves = popup.asked.filter((m) => m.type === 'setGain');
    assert(saves.length === 1 && saves[0].gain === 2,
      `a preset saves the gain it names (${JSON.stringify(saves)})`);
    assert(saves[0].appliesTo === 'UCpreset|video|presetVid',
      `against the state on screen (${saves[0].appliesTo})`);

    // A forceDetect answered with nothing draws nothing, and is not mistaken
    // for a page that cannot answer.
    const silent = makePopup({ answer: async () => undefined });
    await silent.settled();
    assert(silent.node('channelName').textContent === '',
      `an answer of nothing draws nothing (${silent.node('channelName').textContent})`);
    assert(silent.node('reloadNeeded').style.display === undefined
      && silent.node('notWatch').style.display === undefined
      && silent.node('main').style.display === undefined,
      'and sends the popup to no other screen');
  }

  section('Popup: a refused toggle draws what the page holds, not what the popup had');
  {
    // The re-read answers a state that differs from the one on screen. Drawing
    // it is the whole point of asking; putting the toggle back from memory
    // would leave the rest of the screen at the state before the gesture.
    let reads = 0;
    const moved = makePopup({
      answer: async (message) => {
        if (message.type === 'setAutoApplyLoudness') return { ok: false, reason: 'state moved' };
        reads += 1;
        return reads === 1
          ? {
            isWatchPage: true,
            channel: { id: 'UCfirst', name: 'First Ch', url: '' },
            appliesTo: 'UCfirst|video|firstVid',
            loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
            targetLufs: -18, videoType: 'video', autoApplyLoudnessVideo: false
          }
          : {
            isWatchPage: true,
            channel: { id: 'UCsecond', name: 'Second Ch', url: '' },
            appliesTo: 'UCsecond|video|secondVid',
            loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.75,
            targetLufs: -18, videoType: 'video', autoApplyLoudnessVideo: true
          };
      }
    });
    await moved.ready();
    moved.node('autoApplyVideoToggle').checked = true;
    await moved.fire('autoApplyVideoToggle', 'change');
    assert(moved.node('channelName').textContent === 'Second Ch',
      `the screen follows what the page answered (${moved.node('channelName').textContent})`);
    assert(Number(moved.node('volumeSlider').value) === 175,
      `the gain with it (${moved.node('volumeSlider').value})`);
    assert(moved.node('autoApplyVideoToggle').checked === true,
      `and the toggle stands where the page has it, not where the popup had it (${moved.node('autoApplyVideoToggle').checked})`);
  }

  section('Popup: a toggle put back for a type no longer on screen is not left available');
  {
    // The gesture is made on a video. While the answer is out the tab moves to
    // a live stream, and the re-read answers nothing, so the toggle is put back
    // from memory — for a type that is no longer the one being watched.
    let held;
    const holding = new Promise((resolve) => { held = resolve; });
    let reads = 0;
    const popup = makePopup({
      answer: async (message) => {
        if (message.type === 'setAutoApplyLoudness') {
          await holding;
          return { ok: false, reason: 'state moved' };
        }
        reads += 1;
        return reads === 1
          ? {
            isWatchPage: true,
            channel: { id: 'UCswap', name: 'Swap Ch', url: '' },
            appliesTo: 'UCswap|video|swapVid',
            loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
            targetLufs: -18, videoType: 'video',
            autoApplyLoudnessVideo: false, autoApplyLoudnessLive: true
          }
          : undefined;
      }
    });
    await popup.ready();
    popup.node('autoApplyVideoToggle').checked = true;
    const gesture = popup.fire('autoApplyVideoToggle', 'change');
    await tick();

    // The tab moves to a live stream while the answer is out.
    await popup.deliver({
      type: 'stateChanged',
      channel: { id: 'UCswap', name: 'Swap Ch', url: '' },
      appliesTo: 'UCswap|live|liveVid',
      loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
      targetLufs: -18, videoType: 'live', isLiveNow: true,
      autoApplyLoudnessVideo: false, autoApplyLoudnessLive: true
    });
    held();
    await gesture;
    await tick();

    assert(popup.node('autoApplyVideoToggle').disabled === true,
      `the toggle for videos is not left available on a live stream (${popup.node('autoApplyVideoToggle').disabled})`);
    assert(popup.node('autoApplyVideoToggle').checked === false,
      `and stands at the saved choice for videos (${popup.node('autoApplyVideoToggle').checked})`);
  }

  // The same, with the page unreachable rather than answering nothing: the
  // toggle is put back from the saved choice for its own type, and left
  // unavailable because that type is not the one on screen.
  {
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    let reads = 0;
    const popup = makePopup({
      answer: async (message) => {
        if (message.type === 'setAutoApplyLoudness') {
          await waiting;
          return { ok: false, reason: 'state moved' };
        }
        reads += 1;
        if (reads > 1) throw new Error('Receiving end does not exist');
        return {
          isWatchPage: true,
          channel: { id: 'UCgone', name: 'Gone Ch', url: '' },
          appliesTo: 'UCgone|video|goneVid',
          loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
          targetLufs: -18, videoType: 'video',
          autoApplyLoudnessVideo: false, autoApplyLoudnessLive: true
        };
      }
    });
    await popup.ready();
    popup.node('autoApplyVideoToggle').checked = true;
    const gesture = popup.fire('autoApplyVideoToggle', 'change');
    await tick();
    await popup.deliver({
      type: 'stateChanged',
      channel: { id: 'UCgone', name: 'Gone Ch', url: '' },
      appliesTo: 'UCgone|live|goneLive',
      loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
      targetLufs: -18, videoType: 'live', isLiveNow: true,
      autoApplyLoudnessVideo: false, autoApplyLoudnessLive: true
    });
    release();
    await gesture;
    await tick();
    assert(popup.node('autoApplyVideoToggle').checked === false,
      `a page that cannot be reached puts the toggle back from its own type's choice (${popup.node('autoApplyVideoToggle').checked})`);
    assert(popup.node('autoApplyVideoToggle').disabled === true,
      `and leaves it unavailable, the video not being on screen (${popup.node('autoApplyVideoToggle').disabled})`);
  }

  section('Popup: a drag that ended without a change does not hold the next one');
  {
    // Chrome fires change only when the value differs from where the gesture
    // began. A redraw that puts the slider back where it started makes the
    // release fire nothing at all, so nothing tells the popup the drag is over.
    const popup = makePopup({
      answer: async (message) => (message.type === 'setGainLive' || message.type === 'setGain'
        ? { ok: true }
        : {
          isWatchPage: true,
          channel: { id: 'UCfirst', name: 'First Ch', url: '' },
          appliesTo: 'UCfirst|video|first',
          loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
          targetLufs: -18, videoType: 'video'
        })
    });
    await popup.ready();

    // A drag on the first video, interrupted by the tab moving on.
    popup.node('volumeSlider').value = '140';
    await popup.fire('volumeSlider', 'pointerdown');
    await popup.fire('volumeSlider', 'input');
    await popup.deliver({
      type: 'stateChanged',
      channel: { id: 'UCsecond', name: 'Second Ch', url: '' },
      appliesTo: 'UCsecond|video|second',
      loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
      targetLufs: -18, videoType: 'video'
    });
    // The release fires nothing: the redraw put the slider back where it began.
    await popup.fire('volumeSlider', 'pointerup');

    // A new drag, on the video now playing.
    popup.asked.length = 0;
    popup.node('volumeSlider').value = '300';
    await popup.fire('volumeSlider', 'pointerdown');
    await popup.fire('volumeSlider', 'input');
    await popup.fire('volumeSlider', 'change');

    const previews = popup.asked.filter((m) => m.type === 'setGainLive');
    const saves = popup.asked.filter((m) => m.type === 'setGain');
    assert(previews.length === 1 && previews[0].appliesTo === 'UCsecond|video|second',
      `the new drag previews against the video it began on (${JSON.stringify(previews)})`);
    assert(saves.length === 1 && saves[0].appliesTo === 'UCsecond|video|second',
      `and saves against it (${JSON.stringify(saves)})`);

    // The keyboard begins one the same way, and saves when the key is let go.
    popup.asked.length = 0;
    popup.node('volumeSlider').value = '250';
    await popup.fire('volumeSlider', 'keydown', { key: 'ArrowRight' });
    await popup.fire('volumeSlider', 'input');
    await popup.fire('volumeSlider', 'change');
    await popup.fire('volumeSlider', 'keyup', { key: 'ArrowRight' });
    const byKey = popup.asked.filter((m) => m.type === 'setGain');
    assert(byKey.length === 1 && byKey[0].appliesTo === 'UCsecond|video|second',
      `a key on the slider saves against the video on screen (${JSON.stringify(byKey)})`);
  }

  section('Popup: a drag in progress keeps the state it began on');
  {
    const popup = makePopup({
      answer: async (message) => (message.type === 'setGainLive' || message.type === 'setGain'
        ? { ok: true }
        : {
          isWatchPage: true,
          channel: { id: 'UCheld', name: 'Held Ch', url: '' },
          appliesTo: 'UCheld|video|heldA',
          loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
          targetLufs: -18, videoType: 'video'
        })
    });
    await popup.ready();

    popup.asked.length = 0;
    popup.node('volumeSlider').value = '140';
    await popup.fire('volumeSlider', 'pointerdown');
    await popup.fire('volumeSlider', 'input');

    // The tab moves on, and the drag goes on. Every message it sends still
    // belongs to the video it began on, so the one now playing is untouched.
    await popup.deliver({
      type: 'stateChanged',
      channel: { id: 'UCheld', name: 'Held Ch', url: '' },
      appliesTo: 'UCheld|video|heldB',
      loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
      targetLufs: -18, videoType: 'video'
    });
    popup.node('volumeSlider').value = '180';
    await popup.fire('volumeSlider', 'input');
    await popup.fire('volumeSlider', 'change');
    assert(popup.asked.filter((m) => m.appliesTo === 'UCheld|video|heldB').length === 0,
      `nothing the drag sends belongs to the video it moved to (${JSON.stringify(popup.asked)})`);
    assert(popup.asked.filter((m) => m.appliesTo === 'UCheld|video|heldA').length === 3,
      `and all of it to the one it began on (${JSON.stringify(popup.asked)})`);
  }

  // ── The popup and the content script, joined up ──

  section('Popup: a slider released after the video changed saves against the one it was moved on');
  {
    mockStorage['channelVolumes'] = {};
    mockSyncStorage['autoLoudnessSettings'] = { targetLufs: -18, displayUnit: '%' };
    setURL('/watch', 'popVidA');
    mockVideoEl = { id: 'popup-video-a' };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCpopup' };
    ytcv._set('currentChannel', { id: 'UCpopup', name: 'Popup Ch', url: '' });
    ytcv._set('currentVideoType', 'video');
    ytcv._set('_lastVideoId', 'popVidA');
    ytcv._set('currentGain', 1.0);
    ytcv._set('currentLoudnessDb', -6);

    const popup = makePopup();
    await popup.ready();
    const drawnOn = (await simulateRuntimeMessage({ type: 'getState' })).appliesTo;

    // The viewer takes hold of the slider on popVidA.
    popup.node('volumeSlider').value = '25';
    await popup.fire('volumeSlider', 'input');

    // The tab moves to another video of the same channel, and content.js tells
    // the popup about it.
    setURL('/watch', 'popVidB');
    ytcv._set('_lastVideoId', 'popVidB');
    await popup.broadcast();
    assert((await simulateRuntimeMessage({ type: 'getState' })).appliesTo !== drawnOn,
      'two videos of one channel are two states, not one');

    await popup.fire('volumeSlider', 'change');
    const saves = popup.asked.filter((m) => m.type === 'setGain');
    assert(saves.length === 1, `one save is sent (${saves.length})`);
    assert(saves[0].appliesTo === drawnOn,
      `carrying the state it was made on (${saves[0].appliesTo})`);
    assert(mockStorage['channelVolumes']['UCpopup'] === undefined,
      `and nothing is saved for the video moved to (${JSON.stringify(mockStorage['channelVolumes'])})`);
  }

  section('Popup: a slider released with the tab where it was saves the gain');
  {
    mockStorage['channelVolumes'] = {};
    setURL('/watch', 'popVidC');
    mockVideoEl = { id: 'popup-video-c' };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCkept' };
    ytcv._set('currentChannel', { id: 'UCkept', name: 'Kept Ch', url: '' });
    ytcv._set('currentChannelVideoId', ytcv.getUrlVideoId());
    ytcv._set('currentVideoType', 'video');
    ytcv._set('_lastVideoId', 'popVidC');
    ytcv._set('currentGain', 1.0);

    const popup = makePopup();
    await popup.ready();
    popup.node('volumeSlider').value = '25';
    await popup.fire('volumeSlider', 'input');
    await popup.broadcast();
    await popup.fire('volumeSlider', 'change');
    await tick();
    assert(Math.abs(mockStorage['channelVolumes']['UCkept']?.gainVideo - 0.25) < 1e-9,
      `an ordinary release saves the gain (${JSON.stringify(mockStorage['channelVolumes']['UCkept'])})`);
  }

  section('Popup: the preview during a drag belongs to the video the drag began on');
  {
    mockStorage['channelVolumes'] = {};
    setURL('/watch', 'popVidD');
    mockVideoEl = { id: 'popup-video-d' };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCpreview' };
    ytcv._set('currentChannel', { id: 'UCpreview', name: 'Preview Ch', url: '' });
    ytcv._set('currentChannelVideoId', ytcv.getUrlVideoId());
    ytcv._set('currentVideoType', 'video');
    ytcv._set('_lastVideoId', 'popVidD');
    ytcv._set('currentGain', 1.0);

    const popup = makePopup();
    await popup.ready();
    popup.node('volumeSlider').value = '40';
    await popup.fire('volumeSlider', 'input');
    assert(Math.abs(ytcv.state.currentGain - 0.4) < 1e-9,
      `the preview moves the level of the video being watched (${ytcv.state.currentGain})`);

    setURL('/watch', 'popVidE');
    ytcv._set('_lastVideoId', 'popVidE');
    ytcv._set('currentGain', 1.0);
    await popup.broadcast();

    popup.node('volumeSlider').value = '60';
    await popup.fire('volumeSlider', 'input');
    assert(ytcv.state.currentGain === 1.0,
      `the drag does not move the level of the video moved to (${ytcv.state.currentGain})`);
  }

  // content.js decides three things once, as it loads: whether to fold the
  // legacy gains, whether to listen for settings changes, and whether to hand
  // its internals to a test. The copy this file loaded took every yes, so a
  // second copy is run in a context of its own to read the other side.
  function loadContentStartup({ contextValid = true, testFlag = true } = {}) {
    const vmMod = require('vm');
    const sent = [];
    const storageListeners = [];
    const messageListeners = [];
    const sandbox = {
      console: { log() {}, warn() {}, error() {}, info() {} },
      Promise, Math, JSON, Date, Object, Array, String, Number, Boolean, Symbol,
      isNaN, parseFloat, parseInt, Set, Map, WeakSet, WeakMap, Error, TypeError, RegExp,
      setTimeout: () => 0,
      clearTimeout() {},
      setInterval: () => 0,
      clearInterval() {},
      URL,
      // A page the extension does not act on: the startup decisions still run,
      // and everything they lead to stops at the first watch-page check.
      location: { pathname: '/feed/subscriptions', href: 'https://www.youtube.com/feed/subscriptions', search: '' },
      MutationObserver: class { observe() {} disconnect() {} },
      window: { addEventListener() {}, postMessage() {} },
      document: {
        readyState: 'complete',
        visibilityState: 'visible',
        documentElement: {},
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
        contains: () => true
      },
      chrome: {
        runtime: {
          ...(contextValid ? { id: 'test-extension-id' } : {}),
          async sendMessage(message) { sent.push(message); return { ok: true }; },
          onMessage: { addListener: (fn) => messageListeners.push(fn) }
        },
        storage: {
          local: {
            async get() { return {}; },
            async set() {}
          },
          onChanged: { addListener: (fn) => storageListeners.push(fn) }
        }
      }
    };
    if (testFlag) sandbox.__TEST_YTCV__ = true;
    sandbox.globalThis = sandbox;
    vmMod.createContext(sandbox);
    vmMod.runInContext(fs.readFileSync('./core/common.js', 'utf8'), sandbox, { filename: 'core/common.js' });
    vmMod.runInContext(fs.readFileSync('./utils.js', 'utf8'), sandbox, { filename: 'utils.js' });
    vmMod.runInContext(fs.readFileSync('./content.js', 'utf8'), sandbox, { filename: 'content.js' });
    return { sent, storageListeners, messageListeners, exported: sandbox.__YTCV__ };
  }

  section('Startup: what a copy of content.js decides as it loads');
  {
    const live = loadContentStartup({});
    await tick();
    assert(live.sent.some((m) => m.type === 'store:migrateLegacyGains'),
      `a runtime it can reach is asked to fold the legacy gains (${live.sent.map((m) => m.type).join(', ')})`);
    assert(live.storageListeners.length === 1,
      `and settings changes are listened for (${live.storageListeners.length})`);

    const invalidated = loadContentStartup({ contextValid: false });
    await tick();
    assert(invalidated.sent.length === 0,
      `a runtime the reload invalidated is asked nothing (${invalidated.sent.map((m) => m.type).join(', ')})`);
    assert(invalidated.storageListeners.length === 0,
      `and nothing is listened for on it (${invalidated.storageListeners.length})`);
    // The write refuses on its own, so the fold resolves having done nothing.
    // Marking the profile folded on the strength of that leaves this tab
    // reading the map under the new rule with nothing folded into it.
    assert(invalidated.exported?.state.storageMigrated === false,
      `and the profile is not marked folded by a fold that never ran (${invalidated.exported?.state.storageMigrated})`);

    const shipped = loadContentStartup({ testFlag: false });
    await tick();
    assert(shipped.exported === undefined,
      'the internals are handed to nobody where no test asked for them');
    assert(live.exported !== undefined, 'and to a test that did');
  }

  section('The worker takes the writes and leaves the rest alone');
  {
    // Every tab's saves and the popup's own broadcasts share one channel. The
    // worker answers the saves; a message it does not own has to be left for
    // whoever does, unclaimed and unanswered. Chrome keeps the port open where
    // any one listener claims the message, so each listener is asked.
    const notMine = [
      { type: 'stateChanged', gain: 1 },
      { type: 'store:noSuchWrite' },
      { type: 42 },
      {}
    ];
    for (const message of notMine) {
      let answered = 'nothing';
      let claimed = false;
      for (const fn of mockWorkerListeners) {
        const kept = fn(message, {}, (payload) => { answered = payload; });
        if (kept !== false) claimed = kept;
      }
      assert(claimed === false,
        `${JSON.stringify(message)} is not claimed by the worker (${claimed})`);
      assert(answered === 'nothing',
        `and is not answered by it (${JSON.stringify(answered)})`);
    }

    // The ones it does own are claimed and answered.
    let ownAnswer;
    let ownClaimed = null;
    for (const fn of mockWorkerListeners) {
      if (fn({ type: 'store:clearChannels' }, {}, (payload) => { ownAnswer = payload; }) === true) ownClaimed = true;
    }
    assert(ownClaimed === true, 'a write it owns is claimed');
    for (let turn = 0; turn < 6; turn++) await tick();
    assert(ownAnswer?.ok === true, `and answered (${JSON.stringify(ownAnswer)})`);
  }

  section('The dump the popup\'s opening writes');
  {
    // A display that disagreed with the page is reproduced from this dump, so
    // what it says about the DOM has to be what the DOM held.
    const priorCanonical = mockDOMElements['canonical'];
    const priorOwner = mockDOMElements['ownerLink'];
    const priorMeta = mockDOMElements['metaChannel'];
    const priorName = mockDOMElements['channelName'];
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCdiag' };
    mockDOMElements['ownerLink'] = { href: 'https://www.youtube.com/channel/UCowner' };
    mockDOMElements['metaChannel'] = { content: 'UCmeta' };
    mockDOMElements['channelName'] = { textContent: '  Diag Channel  ' };
    ytcv._set('currentBaseLoudnessDb', -9.5);
    ytcv._set('currentLiveLkfs', -21.5);

    const logs = [];
    const realLog = console.log;
    console.log = (...args) => logs.push(args);
    mockPostMessageHandler = () => {
      setTimeout(() => simulateBridgeMessage({
        loudnessDb: -2, isLiveContent: false, isLiveNow: false,
        channelId: 'UCdiag', author: 'Diag Channel'
      }), 0);
    };
    try {
      await simulateRuntimeMessage({ type: 'forceDetect' });
    } finally {
      console.log = realLog;
      mockPostMessageHandler = null;
      ytcv._set('currentBaseLoudnessDb', null);
      ytcv._set('currentLiveLkfs', null);
      mockDOMElements['canonical'] = priorCanonical;
      mockDOMElements['ownerLink'] = priorOwner;
      mockDOMElements['metaChannel'] = priorMeta;
      mockDOMElements['channelName'] = priorName;
    }

    const dump = logs.find((args) => args[0] === '[YTCV][popup-open]')?.[1];
    assert(!!dump, 'the popup opening writes a dump');
    assert(dump?.dom?.canonicalHref === 'https://www.youtube.com/channel/UCdiag',
      `naming the canonical link (${dump?.dom?.canonicalHref})`);
    assert(dump?.dom?.ownerChannelHref === 'https://www.youtube.com/channel/UCowner',
      `the owner link (${dump?.dom?.ownerChannelHref})`);
    assert(dump?.dom?.ownerHandleHref === 'https://www.youtube.com/channel/UCowner',
      `the handle link (${dump?.dom?.ownerHandleHref})`);
    assert(dump?.dom?.metaChannelId === 'UCmeta',
      `the channel the meta names (${dump?.dom?.metaChannelId})`);
    assert(dump?.dom?.channelNameText === 'Diag Channel',
      `and the name as it reads, trimmed (${dump?.dom?.channelNameText})`);
    assert(dump?.currentBaseLoudnessDb === -9.5,
      `and the base level stored gains are held against (${dump?.currentBaseLoudnessDb})`);
    assert(dump?.currentLiveLkfs === -21.5,
      `and the live level the tab holds (${dump?.currentLiveLkfs})`);
  }

  section('The dump says whether the audio chain holds the element the page plays');
  {
    // Whether the chain survives the player swapping its audio is read from
    // this dump, so it has to tell the element the chain was built on from the
    // one the page holds now.
    const priorVideo = mockVideoEl;
    const priorConnected = ytcv.state.connectedVideo;
    const priorGainNode = ytcv.state.gainNode;
    const dumpNow = async () => {
      const logs = [];
      const realLog = console.log;
      console.log = (...args) => logs.push(args);
      mockPostMessageHandler = () => {
        setTimeout(() => simulateBridgeMessage({
          loudnessDb: -2, isLiveContent: false, isLiveNow: false,
          channelId: 'UCdiag', author: 'Diag Channel'
        }), 0);
      };
      try {
        await simulateRuntimeMessage({ type: 'forceDetect' });
      } finally {
        console.log = realLog;
        mockPostMessageHandler = null;
      }
      return logs.find((args) => args[0] === '[YTCV][popup-open]')?.[1]?.audioChain;
    };
    try {
      const chainVideo = { id: 'chain-video' };
      mockVideoEl = chainVideo;
      ytcv._set('connectedVideo', chainVideo);
      ytcv._set('gainNode', { gain: { value: 0.4 } });
      const held = await dumpNow();
      assert(held?.connected === true && held?.connectedIsPageVideo === true,
        `built on the element the page plays (${JSON.stringify(held)})`);
      assert(held?.gainNodeValue === 0.4, `with the gain the node holds (${held?.gainNodeValue})`);

      ytcv._set('connectedVideo', chainVideo);
      mockVideoEl = { id: 'replaced-video' };
      const replaced = await dumpNow();
      assert(replaced?.connectedIsPageVideo === false,
        `and says so once the page plays another element (${JSON.stringify(replaced)})`);

      ytcv._set('connectedVideo', null);
      ytcv._set('gainNode', null);
      const none = await dumpNow();
      assert(none?.connected === false && none?.connectedIsPageVideo === null && none?.gainNodeValue === null,
        `and that there is none before one is built (${JSON.stringify(none)})`);
    } finally {
      mockVideoEl = priorVideo;
      ytcv._set('connectedVideo', priorConnected);
      ytcv._set('gainNode', priorGainNode);
    }
  }

  section('Apply: a page that is not a watch page starts nothing');
  {
    // The fold is retried on every apply until it lands, so a page the
    // extension does not act on must not be one of those applies.
    const priorPath = mockLocation.pathname;
    const priorHref = mockLocation.href;
    ytcv._set('storageMigrated', false);
    ytcv._set('_applyRunning', false);
    mockLocation.pathname = '/feed/subscriptions';
    mockLocation.href = 'https://www.youtube.com/feed/subscriptions';
    const before = mockSentMessages.length;

    await ytcv.triggerApply();

    assert(mockSentMessages.length === before,
      `nothing is asked of the worker there (${mockSentMessages.length - before})`);
    assert(ytcv.state.storageMigrated === false, 'and the fold is left for a page that is one');

    mockLocation.pathname = priorPath;
    mockLocation.href = priorHref;
    ytcv._set('storageMigrated', true);
  }

  section('Apply: the notify that follows the level carries the gain it applied');
  {
    // The level arrives after the first draw, and the gain it resolves to is
    // applied before the popup is told. Telling it first leaves the popup
    // showing the gain from before the level, with nothing to correct it: the
    // notify that would is the one that already went.
    const priorPath = mockLocation.pathname;
    const priorHref = mockLocation.href;
    const priorSearch = mockLocation.search;
    const priorChannels = mockStorage['channelVolumes'];
    mockLocation.pathname = '/watch';
    mockLocation.search = '?v=vidLate';
    mockLocation.href = 'https://www.youtube.com/watch?v=vidLate';
    mockStorage['channelVolumes'] = { UClate: { name: 'Late Ch', gainVideo: 0.4 } };
    ytcv._set('currentChannel', { id: '', name: '', url: '' });
    ytcv._set('currentGain', 1.0);
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('_lastVideoId', '');
    ytcv._set('_applyRunning', false);
    mockSentMessages.length = 0;
    mockPostMessageHandler = () => {
      setTimeout(() => simulateBridgeMessage({
        loudnessDb: 0, isLiveContent: false, isLiveNow: false,
        channelId: 'UClate', author: 'Late Ch'
      }), 0);
    };

    await ytcv.applyVideoVolume();
    for (let turn = 0; turn < 10; turn++) await tick();
    mockPostMessageHandler = null;

    const broadcasts = mockSentMessages.filter((m) => m.type === 'stateChanged');
    const last = broadcasts[broadcasts.length - 1];
    assert(broadcasts.length > 0, 'the popup is told something');
    assert(Math.abs((last?.gain ?? 0) - 0.4) < 1e-9,
      `and what it is told last is the gain in force (${last?.gain})`);
    assert(Math.abs(ytcv.state.currentGain - 0.4) < 1e-9,
      `which is the gain the channel had saved (${ytcv.state.currentGain})`);

    mockLocation.pathname = priorPath;
    mockLocation.search = priorSearch;
    mockLocation.href = priorHref;
    mockStorage['channelVolumes'] = priorChannels;
  }

  // ── The worker's settings move ───────────────────────────────────
  section('Worker: the fold is answered once the settings move has settled');
  {
    // A worker of its own, started on a profile whose settings are still in
    // local, with the move's read of sync held. The options page offers its
    // controls once the fold answers, so a fold answered inside the move would
    // let a save land that the move then puts back to local's older copy.
    const local = {
      [SETTINGS_KEY]: { targetLufs: -18, displayUnit: '%' },
      [UNIFIED_GAINS_KEY]: true
    };
    const synced = {};
    let releaseSyncRead;
    const syncReadHeld = new Promise((resolve) => { releaseSyncRead = resolve; });
    let syncReads = 0;
    const listeners = [];
    const area = (held, holdRead) => ({
      async get(key) {
        if (holdRead && syncReads++ === 0) await syncReadHeld;
        if (key === null) return cloneStorageValue(held);
        const keys = Array.isArray(key) ? key : [key];
        return Object.fromEntries(keys.filter((k) => k in held).map((k) => [k, cloneStorageValue(held[k])]));
      },
      async set(obj) { Object.assign(held, cloneStorageValue(obj)); },
      async remove(keys) { for (const k of [].concat(keys)) delete held[k]; }
    });
    const worker = {
      console: { log() {}, info() {}, warn() {}, error() {} },
      Promise, Object, Array, JSON, Math, Number, String, Boolean, Error, TypeError,
      chrome: {
        runtime: { id: 'worker', onMessage: { addListener: (fn) => listeners.push(fn) } },
        storage: { local: area(local, false), sync: area(synced, true) }
      }
    };
    worker.globalThis = worker;
    worker.importScripts = () => {};
    vm.createContext(worker);
    vm.runInContext(fs.readFileSync('./core/common.js', 'utf8'), worker, { filename: 'core/common.js' });
    vm.runInContext(fs.readFileSync('./utils.js', 'utf8'), worker, { filename: 'utils.js' });
    vm.runInContext(fs.readFileSync('./background.js', 'utf8'), worker, { filename: 'background.js' });

    let answer;
    const kept = listeners[0]({ type: 'store:migrateLegacyGains' }, {}, (r) => { answer = r; });
    for (let turn = 0; turn < 5; turn++) await tick();
    assert(kept === true, 'the fold keeps its answer open');
    assert(answer === undefined, `and gives none while the move is out (${JSON.stringify(answer)})`);
    releaseSyncRead();
    for (let turn = 0; turn < 5; turn++) await tick();
    assert(answer?.ok === true, `the fold answers once the move has settled (${JSON.stringify(answer)})`);
    assert(synced[SETTINGS_KEY]?.targetLufs === -18 && !(SETTINGS_KEY in local),
      'by then the settings are in sync and local is clear');
    // What the page saves after that answer is the move's to keep, not undo.
    synced[SETTINGS_KEY] = { targetLufs: -30, displayUnit: 'dB' };
    let again;
    listeners[0]({ type: 'store:migrateLegacyGains' }, {}, (r) => { again = r; });
    for (let turn = 0; turn < 5; turn++) await tick();
    assert(again?.ok === true && synced[SETTINGS_KEY].targetLufs === -30,
      `a save made after the fold answered stands (${JSON.stringify(synced[SETTINGS_KEY])})`);
  }

  section('Worker: a save an open options page makes while a later start moves is not put back');
  {
    // A move that failed leaves the settings in local; the options page stays
    // open, and a later worker start moves again while the page saves. The
    // move read sync empty before the save landed.
    const local = { [SETTINGS_KEY]: { targetLufs: -18, displayUnit: '%', showGainOverlay: false } };
    const synced = {};
    let releaseSyncRead;
    const syncReadHeld = new Promise((resolve) => { releaseSyncRead = resolve; });
    let syncReads = 0;
    const listeners = [];
    const area = (held, holdRead) => ({
      async get(key) {
        const snapshot = cloneStorageValue(held);
        if (holdRead && syncReads++ === 0) await syncReadHeld;
        const keys = Array.isArray(key) ? key : [key];
        return Object.fromEntries(keys.filter((k) => k in snapshot).map((k) => [k, snapshot[k]]));
      },
      async set(obj) { Object.assign(held, cloneStorageValue(obj)); },
      async remove(keys) { for (const k of [].concat(keys)) delete held[k]; }
    });
    const worker = {
      console: { log() {}, info() {}, warn() {}, error() {} },
      Promise, Object, Array, JSON, Math, Number, String, Boolean, Error, TypeError,
      chrome: {
        runtime: { id: 'worker', onMessage: { addListener: (fn) => listeners.push(fn) } },
        storage: { local: area(local, false), sync: area(synced, true) }
      }
    };
    worker.globalThis = worker;
    worker.importScripts = () => {};
    vm.createContext(worker);
    vm.runInContext(fs.readFileSync('./core/common.js', 'utf8'), worker, { filename: 'core/common.js' });
    vm.runInContext(fs.readFileSync('./utils.js', 'utf8'), worker, { filename: 'utils.js' });
    vm.runInContext(fs.readFileSync('./background.js', 'utf8'), worker, { filename: 'background.js' });

    // The move has read local and is waiting on sync before the save comes in.
    for (let turn = 0; turn < 3; turn++) await tick();
    assert(syncReads === 1, `the move's read of sync is out (${syncReads})`);
    let answer;
    const kept = listeners[0](
      { type: 'store:saveSetting', key: 'targetLufs', value: -30 }, {}, (r) => { answer = r; });
    for (let turn = 0; turn < 5; turn++) await tick();
    assert(kept === true && answer === undefined,
      `the save is held while the move is out (${JSON.stringify(answer)})`);
    releaseSyncRead();
    for (let turn = 0; turn < 5; turn++) await tick();
    assert(answer?.ok === true, `and answered once it lands (${JSON.stringify(answer)})`);
    assert(synced[SETTINGS_KEY]?.targetLufs === -30 && synced[SETTINGS_KEY]?.displayUnit === '%',
      `the save stands, with the settings the move brought (${JSON.stringify(synced[SETTINGS_KEY])})`);
    assert(!(SETTINGS_KEY in local), 'and local is clear');

    const errors = [];
    worker.console.error = (...args) => errors.push(args.map(String).join(' '));
    let refused;
    listeners[0]({ type: 'store:saveSetting', key: 'targetLufs', value: 'loud' }, {}, (r) => { refused = r; });
    for (let turn = 0; turn < 3; turn++) await tick();
    assert(refused?.ok === false && refused.reason === 'invalid-mutation',
      `a value the field cannot hold is refused as such (${JSON.stringify(refused)})`);
    assert(errors.length === 1 && /^\[YTCV\] store:saveSetting rejected as invalid /.test(errors[0]),
      `and reported as such (${errors.join(' | ')})`);

    // A storage failure is answered by the table the write came from.
    worker.chrome.storage.sync.set = () => Promise.reject(new Error('QUOTA_BYTES_PER_ITEM quota exceeded'));
    let settingFailed;
    listeners[0]({ type: 'store:saveSetting', key: 'targetLufs', value: -24 }, {}, (r) => { settingFailed = r; });
    for (let turn = 0; turn < 5; turn++) await tick();
    assert(settingFailed?.ok === false && settingFailed.reason === 'settings-update-failed',
      `a settings save storage refuses is answered as such (${JSON.stringify(settingFailed)})`);
    worker.chrome.storage.local.set = () => Promise.reject(new Error('IO error'));
    let channelFailed;
    listeners[0]({ type: 'store:saveChannelGain', channelId: 'UCfailed', name: 'Failed', gain: 0.5, videoType: 'video', url: '' },
      {}, (r) => { channelFailed = r; });
    for (let turn = 0; turn < 5; turn++) await tick();
    assert(channelFailed?.ok === false && channelFailed.reason === 'storage-update-failed',
      `and a channel write storage refuses as one of its own (${JSON.stringify(channelFailed)})`);

    // A write that names its own reason is answered with it, and one the
    // stored state blocks is reported as such.
    errors.length = 0;
    const channelWrites = vm.runInContext('CHANNEL_WRITES', worker);
    const clearChannels = channelWrites.clearChannels;
    channelWrites.clearChannels = () => Promise.reject(
      Object.assign(new Error('channelVolumes is not an object'), { reason: 'stored-state-invalid' }));
    let blocked;
    listeners[0]({ type: 'store:clearChannels' }, {}, (r) => { blocked = r; });
    for (let turn = 0; turn < 5; turn++) await tick();
    channelWrites.clearChannels = clearChannels;
    assert(blocked?.ok === false && blocked.reason === 'stored-state-invalid',
      `a write the stored state blocks is answered as such (${JSON.stringify(blocked)})`);
    assert(errors.length === 1 && /^\[YTCV\] store:clearChannels blocked by the stored state /.test(errors[0]),
      `and reported as such (${errors.join(' | ')})`);

    // A message that names no write is left alone, and named unless it is the
    // popup's.
    const warned = [];
    worker.console.warn = (...args) => warned.push(args.map(String).join(' '));
    const unanswered = () => { throw new Error('answered'); };
    assert(listeners[0]({ type: 'stateChanged' }, {}, unanswered) === false && warned.length === 0,
      `the popup's stateChanged is left alone unnamed (${warned.join(' | ')})`);
    assert(listeners[0]({ type: 'store:toString' }, {}, unanswered) === false &&
      warned.length === 1 && warned[0] === '[YTCV] unknown message type store:toString',
      `a write the worker does not have is left alone and named (${warned.join(' | ')})`);
  }

  // ── options.js ────────────────────────────────────────────────────
  section('options page');

  // The settings page, run for real. It builds its table as markup and puts it
  // in with innerHTML, so the stub keeps what an element holds as either text
  // or markup and serialises text the way a browser does -- which is the whole
  // of what utils' esc() does with the element it writes into.
  function makeOptions({
    settings = {},
    localSettings = null,
    channels = {},
    failStorageGet = false,
    failStorageSet = false,
    failMutation = '',
    deferStorageGet = false
  } = {}) {
    // The two areas the page reads, apart as Chrome keeps them: the settings
    // in sync, the channels in local.
    // `localSettings` stands for a profile the worker has not moved yet: the
    // settings are in local and sync holds none.
    const synced = localSettings ? {} : { [SETTINGS_KEY]: { ...settings } };
    const stored = { [CHANNEL_VOLUMES_KEY]: JSON.parse(JSON.stringify(channels)) };
    if (localSettings) stored[SETTINGS_KEY] = { ...localSettings };

    const sent = [];
    const errors = [];
    const confirms = [];
    let confirmAnswer = true;
    const storageListeners = [];
    const pendingReads = [];
    const nodes = new Map();
    const made = [];
    const deleteButtons = new Map();
    // A parser hands back the attribute's value, not its markup, so what the
    // page reads from dataset is the id itself however it was escaped.
    const unescapeAttr = (value) => value
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const escapeText = (text) => String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const markupWithin = (element) => {
      let markup = element._content.kind === 'markup' ? element._content.value : '';
      for (const child of element.children) markup += markupWithin(child);
      return markup;
    };
    const makeNode = (id) => {
      const classes = new Set();
      const element = {
        id, listeners: {}, dataset: {}, style: {}, children: [], offsetWidth: 0,
        value: '', checked: false, disabled: false,
        _content: { kind: 'text', value: '' },
        get textContent() { return this._content.kind === 'text' ? this._content.value : ''; },
        set textContent(text) {
          this._content = { kind: 'text', value: String(text) };
          this.children.length = 0;
        },
        get innerHTML() {
          return this._content.kind === 'text'
            ? escapeText(this._content.value)
            : this._content.value;
        },
        set innerHTML(markup) {
          this._content = { kind: 'markup', value: String(markup) };
          this.children.length = 0;
        },
        classList: {
          add: (...names) => names.forEach((name) => classes.add(name)),
          remove: (...names) => names.forEach((name) => classes.delete(name)),
          contains: (name) => classes.has(name),
          toggle(name, force) {
            const on = force === undefined ? !classes.has(name) : !!force;
            if (on) classes.add(name); else classes.delete(name);
            return on;
          }
        },
        get className() { return [...classes].join(' '); },
        set className(value) {
          classes.clear();
          String(value).split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
        },
        appendChild(child) { this.children.push(child); return child; },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        // The rows go in as markup, so the buttons the page wires afterwards
        // are answered out of the ids that markup carries.
        querySelectorAll(selector) {
          if (selector !== '.ch-del') return [];
          return [...markupWithin(element).matchAll(/class="ch-del" data-id="([^"]*)"([^>]*)>/g)]
            .map(([, escaped, rest]) => {
              const id = unescapeAttr(escaped);
              if (!deleteButtons.has(id)) {
                const button = makeNode(`del-${id}`);
                button.dataset.id = id;
                deleteButtons.set(id, button);
              }
              const button = deleteButtons.get(id);
              button.disabled = rest.includes('disabled');
              return button;
            });
        }
      };
      return element;
    };
    const node = (id) => {
      if (!nodes.has(id)) nodes.set(id, makeNode(id));
      return nodes.get(id);
    };
    const body = node('body');
    body.className = 'initializing';
    const unitButtons = ['%', 'dB'].map((unit) => {
      const button = makeNode(`unit-${unit}`);
      button.dataset.unit = unit;
      button.disabled = true;
      return button;
    });
    node('unitToggle').querySelectorAll = (selector) => (selector === 'button' ? unitButtons : []);
    for (const id of [
      'targetSlider', 'defaultAutoVideoToggle', 'defaultAutoLiveToggle', 'overlayToggle', 'clearAllBtn'
    ]) {
      node(id).disabled = true;
    }
    node('settingsError').className = 'hidden';
    const i18nNodes = ['optTitle', 'optTarget'].map((key) => {
      const element = makeNode(`i18n-${key}`);
      element.dataset.i18n = key;
      return element;
    });

    const windowListeners = {};
    const storageArea = (held) => ({
      get: async (keys) => {
        if (deferStorageGet) {
          await new Promise((resolve) => { pendingReads.push(resolve); });
        }
        if (failStorageGet) throw new Error('storage unavailable');
        const wanted = Array.isArray(keys) ? keys : [keys];
        const answer = {};
        for (const key of wanted) {
          if (key in held) answer[key] = JSON.parse(JSON.stringify(held[key]));
        }
        return answer;
      },
      // A write lands after the turn that asked for it, not during it.
      set: async (patch) => {
        await Promise.resolve();
        if (failStorageSet) throw new Error('storage full');
        Object.assign(held, JSON.parse(JSON.stringify(patch)));
      }
    });

    const sandbox = {
      window: { addEventListener: (type, fn) => (windowListeners[type] ||= []).push(fn) },
      console: { log() {}, warn() {}, error: (...args) => errors.push(args) },
      Promise, Math, JSON, Date, Object, Array, Number, String, Boolean, isNaN, parseFloat, parseInt,
      setTimeout: (fn) => { fn(); return 0; },
      requestAnimationFrame: (fn) => fn(),
      confirm(message) { confirms.push(message); return confirmAnswer; },
      document: {
        body,
        documentElement: node('html'),
        getElementById: node,
        createElement: (tag) => {
          const element = makeNode(`made-${made.length}-${tag}`);
          made.push(element);
          return element;
        },
        querySelectorAll: (selector) => (selector === '[data-i18n]' ? i18nNodes : [])
      },
      chrome: {
        i18n: { getMessage: (key) => key },
        storage: {
          local: storageArea(stored),
          sync: storageArea(synced),
          onChanged: { addListener: (fn) => storageListeners.push(fn) }
        },
        runtime: {
          sendMessage: async (message) => {
            sent.push(JSON.parse(JSON.stringify(message)));
            if (failMutation && message.type === failMutation) {
              return { ok: false, reason: 'store refused' };
            }
            // The settings writes run as the worker runs them, against the
            // areas this page reads.
            const settingsWrites = vm.runInContext('SETTINGS_WRITES', sandbox);
            const settingsWrite = message.type.startsWith('store:') &&
              Object.prototype.hasOwnProperty.call(settingsWrites, message.type.slice(6))
              ? settingsWrites[message.type.slice(6)]
              : null;
            if (settingsWrite) {
              try {
                await settingsWrite(message);
              } catch (err) {
                return { ok: false, reason: 'storage-update-failed' };
              }
            }
            return { ok: true };
          }
        }
      }
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync('./core/common.js', 'utf8'), sandbox, { filename: 'core/common.js' });
    vm.runInContext(fs.readFileSync('./utils.js', 'utf8'), sandbox, { filename: 'utils.js' });
    vm.runInContext(fs.readFileSync('./options.js', 'utf8'), sandbox, { filename: 'options.js' });

    const settle = async () => { for (let turn = 0; turn < 12; turn++) await tick(); };
    return {
      node, body, unitButtons, i18nNodes, sent, errors, confirms, stored, synced,
      answerConfirm(answer) { confirmAnswer = answer; },
      listMarkup() { return markupWithin(node('channelList')); },
      deleteButton(id) {
        node('channelList').querySelectorAll('.ch-del');
        return deleteButtons.get(id);
      },
      async settle() { await settle(); },
      // Reads of either area fail from here on.
      failReads() { failStorageGet = true; },
      async releaseStorage() {
        assert(pendingReads.length > 0, 'a read is being held');
        for (const resolve of pendingReads.splice(0)) resolve();
        await settle();
      },
      async fire(id, type, event = {}) {
        for (const fn of node(id).listeners[type] || []) await fn({ target: node(id), ...event });
        await settle();
      },
      async clickUnit(unit) {
        const button = unitButtons.find((candidate) => candidate.dataset.unit === unit);
        for (const fn of node('unitToggle').listeners.click || []) {
          await fn({ target: { closest: () => button } });
        }
        await settle();
      },
      async clickAwayFromUnits() {
        for (const fn of node('unitToggle').listeners.click || []) {
          await fn({ target: { closest: () => null } });
        }
        await settle();
      },
      async clickDelete(id) {
        node('channelList').querySelectorAll('.ch-del');
        const button = deleteButtons.get(id);
        assert(!!button, `there is a delete button for ${id}`);
        if (!button) return;
        for (const fn of button.listeners.click || []) await fn({ target: button });
        await settle();
      },
      // The page's own window losing focus.
      async blurWindow() {
        for (const fn of windowListeners.blur || []) await fn({});
        await settle();
      },
      // Named, the area is the one every change is fired in; otherwise each key
      // is fired in its own, one event per area as Chrome fires them.
      async fireStorage(changes, area) {
        const byArea = new Map();
        for (const [key, change] of Object.entries(changes)) {
          const into = area || (key === SETTINGS_KEY ? 'sync' : 'local');
          if (!byArea.has(into)) byArea.set(into, {});
          byArea.get(into)[key] = change;
        }
        for (const [into, part] of byArea) {
          for (const fn of storageListeners) fn(part, into);
        }
        await settle();
      }
    };
  }

  {
    const options = makeOptions({
      settings: {
        targetLufs: -20, displayUnit: 'dB', showGainOverlay: true,
        autoApplyLoudnessVideoDefault: true, autoApplyLoudnessLiveDefault: false
      },
      channels: {
        UC1: { name: 'Alpha', gainVideo: 2, url: 'https://www.youtube.com/channel/UC1' },
        UC2: { name: 'Beta', gainLive: 2, gainLivePlain: true, autoApplyLoudnessLive: false, url: 'https://www.youtube.com/channel/UC2' },
        UC3: { name: 'Gamma', gainLive: 2, autoApplyLoudnessLive: false, url: 'https://www.youtube.com/channel/UC3' }
      }
    });
    await options.settle();

    assert(options.node('targetSlider').value === -20, 'the stored target reaches the slider');
    assert(options.node('targetValue').textContent === '-20 LUFS', 'and is named beside it');
    assert(options.node('overlayToggle').checked === true, 'the overlay choice reaches its toggle');
    assert(options.node('defaultAutoVideoToggle').checked === true, 'and each Auto default reaches its own');
    assert(options.node('defaultAutoLiveToggle').checked === false, 'including the one that is off');
    assert(options.unitButtons.find((b) => b.dataset.unit === 'dB').classList.contains('active'),
      'the stored unit is the active button');
    assert(options.i18nNodes.every((el) => el.textContent === el.dataset.i18n),
      'every node carrying a key is given its message');
    assert(options.node('html').lang === 'pageLanguage',
      'and the page declares the language the catalog answers with');
    assert(options.listMarkup().includes('Alpha'), 'the stored channels are drawn');
    assert(options.listMarkup().includes('Beta') && options.listMarkup().includes('Gamma') &&
      (options.listMarkup().match(/6\.0 dB/g) || []).length === 3,
      'a gain is listed as stored, marked or not');
    assert(options.node('targetSlider').disabled === false, 'the controls are offered once the load lands');
    assert(options.unitButtons.every((b) => b.disabled === false), 'the unit buttons with them');
    assert(options.body.classList.contains('initializing') === false, 'and the page is shown');
    assert(options.sent[0]?.type === 'store:migrateLegacyGains', 'the legacy fold is asked for first');
  }

  {
    const options = makeOptions();
    await options.settle();

    assert(options.node('targetSlider').value === DEFAULT_TARGET_LUFS,
      'settings naming no target fall back to the default');
    assert(options.node('defaultAutoVideoToggle').checked === DEFAULT_AUTO_APPLY_LOUDNESS,
      'and naming no Auto default to that one');
    assert(options.unitButtons.find((b) => b.dataset.unit === '%').classList.contains('active'),
      'and to per cent');
    assert(options.listMarkup().includes('noSavedChannels'), 'an empty store says there is nothing saved');
  }

  {
    const options = makeOptions({ failStorageGet: true });
    await options.settle();

    assert(options.node('settingsError').classList.contains('hidden') === false,
      'a load that failed says so');
    assert(options.node('targetSlider').disabled === true,
      'and leaves the controls as the markup ships them');
    assert(options.body.classList.contains('initializing') === false,
      'and the page is shown either way -- one that never appears cannot be operated');
    assert(options.listMarkup() === '', 'and no channel list is drawn from a list it never read');
  }
  {
    // A control changed on a page whose load failed writes nothing and leaves
    // the line that says so.
    const options = makeOptions({ failStorageGet: true });
    await options.settle();
    const shown = options.node('settingsError').textContent;
    options.node('targetSlider').value = '-24';
    await options.fire('targetSlider', 'change');
    assert(options.node('settingsError').classList.contains('hidden') === false &&
      options.node('settingsError').textContent === shown,
      `a change on a page that could not load leaves the line (${options.node('settingsError').className} / ${options.node('settingsError').textContent})`);
  }

  {
    const options = makeOptions({ failStorageGet: true });
    await options.settle();

    // Another tab writes after this page has given up on its own read.
    await options.fireStorage({
      [CHANNEL_VOLUMES_KEY]: { newValue: { UC1: { name: 'Alpha', gainVideo: 2 } } }
    });

    assert(options.listMarkup() === '',
      'what another tab writes is not put on a page whose own read never landed');
  }

  {
    const options = makeOptions({ failMutation: 'store:migrateLegacyGains' });
    await options.settle();

    assert(options.node('targetSlider').disabled === false,
      'a legacy fold that was refused still leaves the page loaded');
    assert(options.errors.some((args) => String(args[0]).includes('legacy auto gains')),
      'and the refusal is named');
  }

  {
    const options = makeOptions({
      channels: {
        UC2: { name: 'Beta', gainVideo: 3 },
        UC1: { name: 'Alpha', gainVideo: 0.5, gainLive: 1.5 },
        UC3: { name: 'Gamma' }
      }
    });
    await options.settle();
    const markup = options.listMarkup();

    assert(markup.indexOf('Alpha') < markup.indexOf('Beta')
      && markup.indexOf('Beta') < markup.indexOf('Gamma'), 'the rows are in name order');
    assert(markup.includes('>50%<') && markup.includes('>150%<'),
      `both of one channel's gains are shown (${markup.replace(/\s+/g, ' ').slice(0, 200)})`);
    assert((markup.match(/>—</g) || []).length >= 2, 'a gain that was never saved is a dash');
    assert(!markup.includes('href='), 'a channel with no url is not a link');
  }

  // A stored name that is not text is drawn and sorted as the channel id, so
  // the row is listed and can be deleted.
  {
    const options = makeOptions({
      channels: {
        UCobject: { name: { not: 'text' }, gainVideo: 2 },
        UCbeta: { name: 'Beta', gainVideo: 1 },
        UCnameless: { gainVideo: 0.5 }
      }
    });
    await options.settle();
    const markup = options.listMarkup();

    assert(options.node('settingsError').classList.contains('hidden') === true,
      `a stored name that is not text does not fail the load (${options.errors.map(String).join(' | ')})`);
    assert(options.node('clearAllBtn').disabled === false, 'and the page is left to be operated');
    assert(markup.includes('>UCobject<') && !markup.includes('[object Object]'),
      'the row is drawn under its channel id');
    assert(markup.includes('>UCnameless<'), 'and so is a row with no name at all');
    assert(markup.indexOf('Beta') < markup.indexOf('UCnameless')
      && markup.indexOf('UCnameless') < markup.indexOf('UCobject'),
      'in the order of what each row shows');
    assert(options.deleteButton('UCobject')?.disabled === false, 'and it can be deleted');
  }

  {
    const options = makeOptions({
      settings: { autoApplyLoudnessVideoDefault: true },
      channels: { UC1: { name: 'Alpha', gainVideo: 2 } }
    });
    await options.settle();

    assert(options.listMarkup().includes('labelAuto'),
      'a channel following the Auto default is drawn as Auto');
    assert(options.listMarkup().includes('ch-vol auto'), 'and its cell is marked');
  }

  {
    const options = makeOptions({
      channels: { UC1: { name: 'Alpha', gainVideo: 2 } },
      deferStorageGet: true
    });
    await options.settle();

    // Nothing has been read, so there is nothing to delete from yet.
    assert(options.body.classList.contains('initializing') === true,
      'the page waits for the read it has out');

    await options.releaseStorage();
    assert(options.deleteButton('UC1')?.disabled === false,
      'deleting is offered once the load has read what it would delete from');
  }

  {
    const options = makeOptions({ channels: { UC1: { name: 'Alpha', gainVideo: 2 } } });
    await options.settle();
    options.sent.length = 0;

    await options.clickDelete('UC1');

    assert(options.sent.length === 1 && options.sent[0].type === 'store:deleteChannel',
      'the delete goes to the worker');
    assert(options.sent[0].channelId === 'UC1', 'naming the channel it is for');
    assert(options.listMarkup().includes('Alpha'),
      'and the table is not redrawn from a read of its own');

    // The worker's write comes back as the notification that carries the list.
    await options.fireStorage({ [CHANNEL_VOLUMES_KEY]: { newValue: {} } });
    assert(options.listMarkup().includes('noSavedChannels'), 'which is what redraws it');
  }

  {
    const options = makeOptions({ channels: { UC1: { name: 'Alpha', gainVideo: 2 } } });
    await options.settle();
    options.sent.length = 0;

    options.answerConfirm(false);
    await options.fire('clearAllBtn', 'click');
    assert(options.confirms.length === 1, 'clearing all asks first');
    assert(options.sent.length === 0, 'and a refusal sends nothing');

    options.answerConfirm(true);
    await options.fire('clearAllBtn', 'click');
    assert(options.sent.length === 1 && options.sent[0].type === 'store:clearChannels',
      'agreeing sends the clear');
  }

  {
    const options = makeOptions({ channels: { UC1: { name: 'Alpha', gainVideo: 2 } } });
    await options.settle();

    options.node('defaultAutoVideoToggle').checked = true;
    await options.fire('defaultAutoVideoToggle', 'change');

    assert(options.synced[SETTINGS_KEY].autoApplyLoudnessVideoDefault === true,
      'the Auto default is saved');
    assert(options.listMarkup().includes('labelAuto'),
      'and the table is redrawn under the new default');
    assert(options.node('defaultAutoVideoToggle').disabled === false,
      'and the toggle is handed back');
  }

  {
    const options = makeOptions({ settings: { targetLufs: -18 } });
    await options.settle();

    options.node('targetSlider').value = '-24';
    await options.fire('targetSlider', 'input');
    assert(options.node('targetValue').textContent === '-24 LUFS', 'dragging names the value');
    assert(options.synced[SETTINGS_KEY].targetLufs === -18, 'and saves nothing until the drag ends');

    await options.fire('targetSlider', 'change');
    assert(options.synced[SETTINGS_KEY].targetLufs === -24, 'the end of the drag saves it');
  }

  {
    const options = makeOptions({ settings: { targetLufs: -20, showGainOverlay: true } });
    await options.settle();

    options.node('overlayToggle').checked = false;
    await options.fire('overlayToggle', 'change');
    assert(options.synced[SETTINGS_KEY].showGainOverlay === false, 'the overlay choice is saved');
    assert(options.synced[SETTINGS_KEY].targetLufs === -20, 'and the target survives the write');
  }

  {
    const options = makeOptions({
      settings: { displayUnit: '%' },
      channels: { UC1: { name: 'Alpha', gainVideo: 2 } }
    });
    await options.settle();
    assert(options.listMarkup().includes('200%'), 'per cent to begin with');

    await options.clickUnit('dB');
    assert(options.synced[SETTINGS_KEY].displayUnit === 'dB', 'the unit is saved');
    assert(options.unitButtons.find((b) => b.dataset.unit === 'dB').classList.contains('active'),
      'the button pressed becomes the active one');
    assert(options.listMarkup().includes('6.0 dB'), 'and the table is redrawn in it');

    const before = options.listMarkup();
    await options.clickAwayFromUnits();
    assert(options.listMarkup() === before, 'a click landing on no button changes nothing');
  }

  {
    const options = makeOptions({
      settings: { targetLufs: -18, displayUnit: '%' },
      channels: { UC1: { name: 'Alpha', gainVideo: 2 } }
    });
    await options.settle();

    await options.fireStorage({
      [SETTINGS_KEY]: { newValue: { targetLufs: -26, displayUnit: 'dB' } }
    });
    assert(options.node('targetSlider').value === -26, 'a target saved elsewhere moves the slider');
    assert(options.unitButtons.find((b) => b.dataset.unit === 'dB').classList.contains('active'),
      'and a unit saved elsewhere moves the active button');
    assert(options.listMarkup().includes('6.0 dB'), 'and the table is redrawn in it');

    await options.fireStorage({
      [CHANNEL_VOLUMES_KEY]: { newValue: { UC9: { name: 'Zeta', gainVideo: 1 } } }
    });
    assert(options.listMarkup().includes('Zeta') && !options.listMarkup().includes('Alpha'),
      'the list a notification carries is the list drawn');
  }

  {
    const options = makeOptions({ settings: { targetLufs: -18 } });
    await options.settle();
    // The worker moving the settings to sync clears the copy local held; that
    // removal is not a change of settings, and drawing it would put the
    // defaults on screen.
    await options.fireStorage({ [SETTINGS_KEY]: { oldValue: { targetLufs: -18 } } }, 'local');
    assert(options.node('targetSlider').value === -18,
      'the settings key leaving local is not this page to draw');
    await options.fireStorage({ [SETTINGS_KEY]: { newValue: { targetLufs: -26 } } }, 'local');
    assert(options.node('targetSlider').value === -18,
      'nor is one written there');
    await options.fireStorage({ [CHANNEL_VOLUMES_KEY]: { newValue: { UC9: { name: 'Zeta', gainVideo: 1 } } } }, 'sync');
    assert(!options.listMarkup().includes('Zeta'),
      'and channels are taken from local alone');
    await options.fireStorage({ [SETTINGS_KEY]: { newValue: { targetLufs: -26 } } }, 'sync');
    assert(options.node('targetSlider').value === -26,
      'settings another machine synced are drawn');
  }

  {
    // The worker moves the settings at its start, which can come after the page
    // has read them; until then they are where the profile saved them.
    const options = makeOptions({
      localSettings: { targetLufs: -22, displayUnit: 'dB', showGainOverlay: true }
    });
    await options.settle();
    assert(options.node('targetSlider').value === -22,
      'settings not moved to sync yet are read from local');
    assert(options.node('overlayToggle').checked === true, 'all of them');
    await options.clickUnit('%');
    assert(JSON.stringify(options.synced[SETTINGS_KEY]) ===
      JSON.stringify({ targetLufs: -22, displayUnit: '%', showGainOverlay: true }),
      `a save goes to sync and carries the rest of them with it (${JSON.stringify(options.synced[SETTINGS_KEY])})`);
  }

  {
    // The read is still out when another tab's write arrives. What the read
    // then brings back is older than what is already on the page.
    const options = makeOptions({
      settings: { targetLufs: -18 },
      channels: { UC1: { name: 'Alpha', gainVideo: 2 } },
      deferStorageGet: true
    });
    await options.settle();

    await options.fireStorage({
      [SETTINGS_KEY]: { newValue: { targetLufs: -26 } },
      [CHANNEL_VOLUMES_KEY]: { newValue: { UC9: { name: 'Zeta', gainVideo: 1 } } }
    });
    assert(options.node('targetSlider').value === -26, 'the notification is on the page');

    await options.releaseStorage();
    assert(options.node('targetSlider').value === -26,
      'and the older read that lands after it does not put it back');
    assert(options.listMarkup().includes('Zeta') && !options.listMarkup().includes('Alpha'),
      'nor the channel list it was carrying');
  }

  {
    // This page's own fold was refused, so it is still reading the map under
    // the pre-fold rule: a legacy gain with no Auto flag counts as manual, and
    // the Auto default does not reach it.
    const options = makeOptions({
      failMutation: 'store:migrateLegacyGains',
      settings: { autoApplyLoudnessVideoDefault: true },
      channels: { UC1: { name: 'Alpha', gain: 2 } }
    });
    await options.settle();
    assert(options.listMarkup().includes('200%'), 'a legacy gain reads as the manual value it holds');
    assert(!options.listMarkup().includes('labelAuto'), 'and not as Auto');

    // Another context folds the profile, and says so through storage.
    await options.fireStorage({ [UNIFIED_GAINS_KEY]: { newValue: true } });

    assert(options.listMarkup().includes('labelAuto'),
      'once it is folded the Auto default reaches the channel');

    // The mark arriving twice is the same mark, not a reason to draw again.
    const settled = options.listMarkup();
    await options.fireStorage({ [UNIFIED_GAINS_KEY]: { newValue: true } });
    assert(options.listMarkup() === settled, 'and the same mark again changes nothing');
  }

  {
    // The markup ships the controls disabled and the handler refuses as well.
    // A gesture already on its way when the page loaded takes the second one.
    const options = makeOptions({ settings: { targetLufs: -18 }, deferStorageGet: true });
    await options.settle();

    options.node('targetSlider').value = '-24';
    await options.fire('targetSlider', 'change');
    await options.releaseStorage();

    assert(options.synced[SETTINGS_KEY].targetLufs === -18,
      'a page that has not read the settings does not write one back');
  }

  {
    const options = makeOptions({ failStorageGet: true });
    await options.settle();

    options.node('defaultAutoVideoToggle').checked = true;
    await options.fire('defaultAutoVideoToggle', 'change');

    // Holding no list, the table draws none rather than reading one of its own.
    assert(options.listMarkup() === '', 'a page holding no list draws none');
    assert(options.node('defaultAutoVideoToggle').checked === true,
      'and drawing none is not a failure that puts the toggle back');
  }

  {
    // A notification can arrive while the page's own read is still out. The
    // table it draws then is one the page cannot yet delete from.
    const options = makeOptions({ deferStorageGet: true });
    await options.settle();
    await options.fireStorage({
      [CHANNEL_VOLUMES_KEY]: { newValue: { UC1: { name: 'Alpha', gainVideo: 2 } } }
    });
    assert(options.listMarkup().includes('Alpha'), 'the list the notification carried is drawn');
    assert(options.deleteButton('UC1')?.disabled === true, 'with its deletion refused');
    options.sent.length = 0;

    await options.clickDelete('UC1');

    assert(options.sent.filter((m) => m.type === 'store:deleteChannel').length === 0,
      'and a click that arrives anyway deletes nothing');
  }

  {
    // This page's own fold was refused, so it reads the map under the old rule
    // until the mark itself says otherwise.
    const options = makeOptions({
      failMutation: 'store:migrateLegacyGains',
      settings: { autoApplyLoudnessVideoDefault: true },
      channels: { UC1: { name: 'Alpha', gain: 2 } }
    });
    await options.settle();
    assert(options.listMarkup().includes('200%'), 'the legacy gain reads as manual to begin with');

    await options.fireStorage({ [SETTINGS_KEY]: { newValue: { autoApplyLoudnessVideoDefault: true } } });

    assert(options.listMarkup().includes('200%') && !options.listMarkup().includes('labelAuto'),
      'a change that is not the mark does not move the table onto the new rule');

    await options.fireStorage({ [CHANNEL_VOLUMES_KEY]: { newValue: { UC1: { name: 'Alpha', gain: 2 } } } });
    assert(options.listMarkup().includes('200%') && !options.listMarkup().includes('labelAuto'),
      'nor does a change of the channels');
  }

  {
    // A change in an area other than sync and local is not this extension's.
    const options = makeOptions({ channels: { UC1: { name: 'Alpha', gainVideo: 2 } } });
    await options.settle();
    await options.fireStorage({ [CHANNEL_VOLUMES_KEY]: { newValue: { UC2: { name: 'Beta', gainVideo: 3 } } } }, 'session');
    assert(options.listMarkup().includes('Alpha') && !options.listMarkup().includes('Beta'),
      'a channel map in another area draws nothing');
  }

  {
    const options = makeOptions({
      failMutation: 'store:deleteChannel',
      channels: { UC1: { name: 'Alpha', gainVideo: 2 } }
    });
    await options.settle();

    await options.clickDelete('UC1');

    const named = options.errors.filter((args) => String(args[0]).includes('channel not deleted'));
    assert(named.length === 1, `a refused delete is named (${options.errors.length} logged)`);
    assert(String(named[0]?.[1]?.message) === 'store refused',
      `carrying the reason the store gave (${named[0]?.[1]?.message})`);
  }

  {
    const options = makeOptions({
      failMutation: 'store:clearChannels',
      channels: { UC1: { name: 'Alpha', gainVideo: 2 } }
    });
    await options.settle();

    await options.fire('clearAllBtn', 'click');

    assert(options.errors.some((args) => String(args[0]).includes('channels not cleared')),
      'a refused clear is named');
  }

  {
    // The two defaults are read per column, so a channel with no flag of its
    // own follows the default for the type of that column and not the other.
    const options = makeOptions({
      settings: { autoApplyLoudnessVideoDefault: true, autoApplyLoudnessLiveDefault: false },
      channels: { UC1: { name: 'Alpha', gainVideo: 2, gainLive: 3 } }
    });
    await options.settle();
    const cells = options.listMarkup().match(/<td class="ch-vol[^"]*">[^<]*</g) || [];

    assert(cells.length === 2, `the row has a cell for each type (${cells.length})`);
    assert(cells[0].includes('ch-vol auto') && cells[0].includes('labelAuto'),
      `the video column follows the video default (${cells[0]})`);
    assert(!cells[1].includes('auto') && cells[1].includes('300%'),
      `and the live column follows the live one (${cells[1]})`);
  }

  {
    // The gain the page shows is the one it saved. A save that did not happen
    // leaves the toggle where the stored value stands, not where the click did.
    const options = makeOptions({ failStorageSet: true });
    await options.settle();

    options.node('defaultAutoVideoToggle').checked = true;
    await options.fire('defaultAutoVideoToggle', 'change');
    assert(options.node('defaultAutoVideoToggle').checked === false,
      'a video default that could not be saved goes back');
    assert(options.node('defaultAutoVideoToggle').disabled === false,
      'and the toggle is handed back either way');

    options.node('defaultAutoLiveToggle').checked = true;
    await options.fire('defaultAutoLiveToggle', 'change');
    assert(options.node('defaultAutoLiveToggle').checked === false,
      'and so does a live default');
    assert(options.node('defaultAutoLiveToggle').disabled === false, 'with its toggle handed back');
  }

  {
    // The channel id comes from the page. Every value the table writes goes
    // inside a quoted attribute, so a quote that survived would close that
    // attribute and put whatever follows on the tag as one of its own.
    const hostile = 'UC1" onclick="steal()';
    const options = makeOptions({ channels: { [hostile]: { name: 'Hostile', gainVideo: 2 } } });
    await options.settle();
    const markup = options.listMarkup();

    assert(markup.includes('data-id="UC1&quot; onclick=&quot;steal()" title='),
      `the whole id stays inside the attribute it was written into (${markup.replace(/\s+/g, ' ').slice(0, 240)})`);
    assert(options.deleteButton(hostile)?.dataset.id === hostile,
      'and the button still names the channel it is for');
  }

  section('Apply: the popup is told a level and the gain that goes with it');
  {
    // The level arrives while the channel's own entry is still being read. The
    // popup is drawn from what it is told, so a message pairing the new level
    // with the gain from before it is a screen that never existed.
    mockStorage['channelVolumes'] = {
      UCpair: { name: 'Pair Ch', gainVideo: 0.5, autoApplyLoudnessVideo: true }
    };
    setURL('/watch', 'pairVid');
    mockVideoEl = { id: 'pair-video' };
    mockDOMElements['canonical'] = { href: 'https://www.youtube.com/channel/UCpair' };
    ytcv._set('storageMigrated', true);
    ytcv._set('storageSettled', true);
    ytcv._set('_lastVideoId', 'pairVid');
    ytcv._set('_lastProcessedVideo', null);
    ytcv._set('_applyRunning', false);
    ytcv._set('currentChannel', { id: 'UCpair', name: 'Pair Ch', url: '' });
    ytcv._set('currentChannelVideoId', 'pairVid');
    ytcv._set('currentLoudnessDb', null);
    ytcv._set('currentLoudnessVideoId', '');
    ytcv._set('currentVideoType', 'video');
    ytcv._set('currentGain', 0.5);
    ytcv.notifyPopup();
    mockSentMessages.length = 0;

    const applying = ytcv.applyVideoVolume();
    // The bridge answers while the apply is still out.
    simulateBridgeMessage({ loudnessDb: -6, isLiveContent: false, channelId: 'UCpair' });
    await applying;
    await tick();

    const told = mockSentMessages.filter((m) => m?.type === 'stateChanged');
    const stale = told.filter((m) => m.loudnessDb === -6 && m.gain === 0.5);
    assert(stale.length === 0,
      `no message carries the new level beside the gain from before it (${JSON.stringify(told.map((m) => [m.loudnessDb, m.gain]))})`);
    assert(told.some((m) => m.loudnessDb === -6),
      `and the level does reach the popup (${JSON.stringify(told.map((m) => [m.loudnessDb, m.gain]))})`);
  }

  // ── A live stream's own level, followed while it is on air ───────────
  {
    const LIVE_CH = 'UCliveFollow';
    const LIVE_URL = 'https://www.youtube.com/channel/' + LIVE_CH;
    const LIVE_VID = 'liveFollowVid';
    const close = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
    const liveGain = (lkfs, target = -18) => Math.max(0, Math.min(6, Math.pow(10, (target - lkfs) / 20)));
    const settle = async () => { for (let turn = 0; turn < 3; turn++) await tick(); };
    const entryNow = () => mockStorage['channelVolumes'][LIVE_CH];
    const liveSaves = () => mockSentMessages.filter((m) => m?.type === 'store:saveChannelGain' && m.channelId === LIVE_CH);
    // A live gain rises by no more than 1.5 dB for every 30 s since a live level
    // last set it. A case that means the next level to play in full lets that
    // time pass first; `ago` moves when that was by the milliseconds given.
    const ago = (ms) => {
      const from = ytcv.state.liveRaiseFrom;
      if (from) ytcv._set('liveRaiseFrom', { ...from, at: from.at - ms });
    };
    const raiseInFull = () => ago(3600000);
    // A level that rose 1 dB or more over the one named before it is taken 3 dB
    // louder. A case about something else answers with no level before it.
    const noRise = () => ytcv._set('liveLevelBefore', null);
    const dbOver = (gain, base) => Math.round(20 * Math.log10(gain / base) * 100) / 100;
    // A tab on a stream, with the follow from any case before this one ended.
    const onAir = ({ type = 'live', isLiveNow = true, autoLive = true, autoVideo = false, entry = {} } = {}) => {
      ytcv._set('currentAutoApplyLoudnessVideo', false);
      ytcv._set('currentAutoApplyLoudnessLive', false);
      ytcv._set('currentLiveLkfs', null);
      ytcv._set('currentIsLiveNow', false);
      ytcv.syncLiveFollow();
      mockStorage['channelVolumes'] = { [LIVE_CH]: { name: 'Live Follow', url: LIVE_URL, ...entry } };
      setURL('/watch', LIVE_VID);
      mockPostMessageHandler = null;
      ytcv._set('storageReady', Promise.resolve());
      ytcv._set('storageMigrated', true);
      ytcv._set('storageSettled', true);
      ytcv._set('_lastVideoId', LIVE_VID);
      ytcv._set('_lastProcessedVideo', mockVideoEl);
      ytcv._set('_applyRunning', false);
      ytcv._set('currentChannel', { id: LIVE_CH, name: 'Live Follow', url: LIVE_URL });
      ytcv._set('currentChannelVideoId', LIVE_VID);
      ytcv._set('currentLoudnessVideoId', LIVE_VID);
      ytcv._set('currentLoudnessDb', null);
      ytcv._set('currentBaseLoudnessDb', null);
      ytcv._set('liveSaveBaseline', null);
      ytcv._set('liveRaiseFrom', null);
      ytcv._set('liveLevelBefore', null);
      ytcv._set('liveLevelRise', null);
      ytcv._set('currentVideoType', type);
      ytcv._set('currentVideoTypeDetected', true);
      ytcv._set('currentIsLiveNow', isLiveNow);
      ytcv._set('currentAutoApplyLoudnessLive', autoLive);
      ytcv._set('currentAutoApplyLoudnessVideo', autoVideo);
      // What the start cap reads is taken from the entry with the Auto flags.
      ytcv._set('storedLiveGain', typeof entry.gainLive === 'number' ? entry.gainLive : null);
      ytcv._set('defaultAutoApplyLoudnessLive', false);
      ytcv._set('defaultAutoApplyLoudnessVideo', false);
      ytcv._set('targetLufs', -18);
      ytcv._set('currentGain', 1.0);
      mockSentMessages.length = 0;
    };
    // What the bridge sends for the stream: no level of the response's own,
    // and the live level the player names, if it names one.
    const liveAnswer = (liveLkfs, over = {}) => simulateBridgeMessage({
      videoId: LIVE_VID, loudnessDb: null, baseLoudnessDb: null,
      isLiveContent: true, isLiveNow: true, channelId: LIVE_CH, author: 'Live Follow',
      liveLkfs, source: 'request', ...over
    });

    section('Live level: Auto plays the level the player names on air, as it stands');
    {
      onAir({ entry: { autoApplyLoudnessLive: true } });
      liveAnswer(-10);
      await settle();
      assert(close(ytcv.state.currentGain, Math.pow(10, -8 / 20)),
        `live -10 against -18 is 8 dB down (${ytcv.state.currentGain})`);
      assert(!close(ytcv.state.currentGain, calcGain(-10 - YT_REFERENCE_LUFS, -18)),
        `and not where YouTube's normalization would put it (${ytcv.state.currentGain})`);
      assert(ytcv.state.currentLiveLkfs === -10, `the level is held (${ytcv.state.currentLiveLkfs})`);

      raiseInFull();
      liveAnswer(-24.8, { loudnessDb: -6, baseLoudnessDb: -6 });
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-24.8)),
        `a live level goes before a level the response describes (${ytcv.state.currentGain})`);

      // A field of another type counts as absent.
      for (const odd of ['-20', NaN, Infinity, true]) {
        liveAnswer(odd);
        await settle();
        assert(ytcv.state.currentLiveLkfs === null, `a live level of ${String(odd)} is not taken (${ytcv.state.currentLiveLkfs})`);
      }
    }

    section('Live level: followed every 10 s while it is on air');
    {
      onAir({ entry: { autoApplyLoudnessLive: true } });
      liveAnswer(-24.8);
      await settle();
      assert(heldLiveFollows.length === 1 && heldLiveFollows[0].ms === LIVE_FOLLOW_MS,
        `one follow waits 10 s (${heldLiveFollows.map((t) => t.ms)})`);

      let next = -23.0;
      mockPostMessageHandler = (data) => {
        if (data?.type === '__yt_channel_volume_request__') liveAnswer(next);
      };
      mockPostMessages.length = 0;
      noRise();
      const ran = await runLiveFollows();
      await settle();
      assert(ran === 1 && mockPostMessages.filter((m) => m?.type === '__yt_channel_volume_request__').length === 1,
        `the follow asks the bridge once (${ran} / ${mockPostMessages.length})`);
      assert(close(ytcv.state.currentGain, liveGain(-23)),
        `and the level it answers with is played (${ytcv.state.currentGain})`);
      assert(heldLiveFollows.length === 1, `with the next follow set (${heldLiveFollows.length})`);

      next = -21.5;
      noRise();
      await runLiveFollows();
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-21.5)) && heldLiveFollows.length === 1,
        `and again 10 s on (${ytcv.state.currentGain} / ${heldLiveFollows.length})`);

      // A follow the bridge does not answer still sets the next one.
      mockPostMessageHandler = null;
      await runLiveFollows();
      assert(heldLiveFollows.length === 1, `an unanswered follow sets the next (${heldLiveFollows.length})`);
    }

    section('Live level: a lower gain plays at once, a higher one rises 1.5 dB for every 30 s');
    {
      onAir({ entry: { autoApplyLoudnessLive: true } });
      liveAnswer(-14);
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-14)),
        `the first live gain for the video plays as it stands (${ytcv.state.currentGain})`);

      ago(10000);
      liveAnswer(-24);
      await settle();
      const afterTen = ytcv.state.currentGain;
      assert(dbOver(afterTen, liveGain(-14)) >= 0.5 && dbOver(afterTen, liveGain(-14)) < 0.51,
        `10 s on, a gain 10 dB higher rises 0.5 dB (${dbOver(afterTen, liveGain(-14))})`);
      ago(30000);
      liveAnswer(-24);
      await settle();
      assert(dbOver(ytcv.state.currentGain, afterTen) >= 1.5 && dbOver(ytcv.state.currentGain, afterTen) < 1.51,
        `30 s on, 1.5 dB more (${dbOver(ytcv.state.currentGain, afterTen)})`);
      raiseInFull();
      liveAnswer(-24);
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-24)), `given the time, it gets there (${ytcv.state.currentGain})`);

      noRise();
      liveAnswer(-12);
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-12)), `a lower gain plays at once (${ytcv.state.currentGain})`);
      liveAnswer(-30);
      await settle();
      assert(dbOver(ytcv.state.currentGain, liveGain(-12)) < 0.01,
        `with no time since, a higher one does not rise (${dbOver(ytcv.state.currentGain, liveGain(-12))})`);

      // Another tab storing a gain plays this tab's level under the same limit.
      const entry = { name: 'Live Follow', url: LIVE_URL, gainLive: 0.9, autoApplyLoudnessLive: true };
      mockStorage['channelVolumes'] = { [LIVE_CH]: entry };
      simulateStorageChange({
        channelVolumes: { oldValue: { [LIVE_CH]: { ...entry, gainLive: 0.8 } }, newValue: { [LIVE_CH]: entry } }
      });
      await settle();
      assert(dbOver(ytcv.state.currentGain, liveGain(-12)) < 0.01,
        `nor does another tab's store raise it (${dbOver(ytcv.state.currentGain, liveGain(-12))})`);

      // A target moved in the settings plays at once.
      simulateStorageChange({ autoLoudnessSettings: { newValue: { targetLufs: -14 } } });
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-30, -14)),
        `a new target plays as it stands (${ytcv.state.currentGain})`);
      simulateStorageChange({ autoLoudnessSettings: { newValue: { targetLufs: -18 } } });
      await settle();

      // No multiple raises a gain of 0, so a level over it plays as it stands.
      ytcv._set('currentGain', 0);
      noRise();
      liveAnswer(-24);
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-24)), `over a gain of 0 the level plays as it stands (${ytcv.state.currentGain})`);

      // Another video's first live gain plays as it stands.
      setURL('/watch', 'liveRaiseVid2');
      liveAnswer(-30, { videoId: 'liveRaiseVid2' });
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-30)),
        `another video's first live gain plays as it stands (${ytcv.state.currentGain})`);
      setURL('/watch', LIVE_VID);
    }

    section('Live level: a settings change that leaves Target LUFS alone does not lift the gain');
    {
      const settings = (over) => simulateStorageChange({
        autoLoudnessSettings: { newValue: { targetLufs: -18, displayUnit: '%', showGainOverlay: false, ...over } }
      });
      onAir({ entry: { autoApplyLoudnessLive: true, gainLive: 1.0 } });
      liveAnswer(-28);
      await settle();
      const capped = ytcv.state.currentGain;
      assert(close(dbOver(capped, 1.0), 3), `the first gain is capped (${dbOver(capped, 1.0)})`);
      settings({ displayUnit: 'dB' });
      await settle();
      assert(dbOver(ytcv.state.currentGain, capped) < 0.01,
        `the display unit changed under the cap leaves it (${dbOver(ytcv.state.currentGain, capped)})`);
      assert(entryNow().gainLive === 1.0, `and nothing is stored while the cap holds it (${entryNow().gainLive})`);

      noRise();
      liveAnswer(-14);
      await settle();
      ago(10000);
      liveAnswer(-28);
      await settle();
      const rising = ytcv.state.currentGain;
      settings({ displayUnit: 'dB', showGainOverlay: true });
      await settle();
      assert(dbOver(ytcv.state.currentGain, rising) < 0.01,
        `the gain overlay turned on while it rises leaves it (${dbOver(ytcv.state.currentGain, rising)})`);

      settings({ targetLufs: -16, displayUnit: 'dB', showGainOverlay: true });
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-28, -16)), `a new target plays as it stands (${ytcv.state.currentGain})`);
      settings({});
      await settle();
    }

    section('Live level: after a message with no live level, a rise counts again from the level coming back');
    {
      onAir({ entry: { autoApplyLoudnessLive: true } });
      liveAnswer(-14);
      await settle();
      const stored = entryNow().gainLive;
      ago(300000);
      liveAnswer(null);
      await settle();
      assert(close(stored, liveGain(-14)) && ytcv.state.currentGain === stored,
        `with no live level the stored gain plays (${stored} / ${ytcv.state.currentGain})`);
      liveAnswer(-24);
      await settle();
      assert(dbOver(ytcv.state.currentGain, stored) < 0.01,
        `the level coming back starts from the gain playing (${dbOver(ytcv.state.currentGain, stored)})`);
      ago(30000);
      liveAnswer(-24);
      await settle();
      assert(dbOver(ytcv.state.currentGain, stored) >= 1.5 && dbOver(ytcv.state.currentGain, stored) < 1.51,
        `and 30 s on rises 1.5 dB (${dbOver(ytcv.state.currentGain, stored)})`);
    }

    section('Live level: turning Auto on plays the level at once, and a rise after it waits');
    {
      onAir({ autoLive: false, entry: { autoApplyLoudnessLive: false } });
      liveAnswer(-14);
      await settle();
      const on = await popupGesture({ type: 'setAutoApplyLoudness', enabled: true });
      await settle();
      assert(on?.ok === true && close(ytcv.state.currentGain, liveGain(-14)),
        `the level in hand plays as it stands (${JSON.stringify(on?.ok)} / ${ytcv.state.currentGain})`);
      liveAnswer(-24);
      await settle();
      assert(dbOver(ytcv.state.currentGain, liveGain(-14)) < 0.01,
        `a higher gain right after does not rise (${dbOver(ytcv.state.currentGain, liveGain(-14))})`);
    }

    section('Live level: what the follow runs for, and what ends it');
    {
      // An archive: not on air, and no live level.
      onAir({ isLiveNow: false, entry: { autoApplyLoudnessLive: true } });
      liveAnswer(null, { isLiveNow: false });
      await settle();
      assert(heldLiveFollows.length === 0, `an archive is not followed (${heldLiveFollows.length})`);

      // On air before the player names a level.
      liveAnswer(null);
      await settle();
      assert(heldLiveFollows.length === 1, `a stream on air is followed before it names a level (${heldLiveFollows.length})`);

      // A live level with the stream not said to be on air.
      onAir({ isLiveNow: false, entry: { autoApplyLoudnessLive: true } });
      liveAnswer(-20, { isLiveNow: false });
      await settle();
      assert(heldLiveFollows.length === 1, `a live level is followed on its own (${heldLiveFollows.length})`);

      // Leaving the watch page.
      setURL('/results', '');
      fireNavigateFinish();
      await settle();
      assert(heldLiveFollows.length === 0, `leaving the watch page ends it (${heldLiveFollows.length})`);

      // Auto going off in another tab.
      onAir({ entry: { autoApplyLoudnessLive: true } });
      liveAnswer(-20);
      await settle();
      assert(heldLiveFollows.length === 1, `followed again (${heldLiveFollows.length})`);
      const offEntry = { name: 'Live Follow', url: LIVE_URL, gainLive: 0.5, autoApplyLoudnessLive: false };
      mockStorage['channelVolumes'] = { [LIVE_CH]: offEntry };
      simulateStorageChange({
        channelVolumes: {
          oldValue: { [LIVE_CH]: { name: 'Live Follow', url: LIVE_URL, autoApplyLoudnessLive: true } },
          newValue: { [LIVE_CH]: offEntry }
        }
      });
      await settle();
      assert(heldLiveFollows.length === 0 && ytcv.state.currentGain === 0.5,
        `Auto going off ends it and the saved gain plays (${heldLiveFollows.length} / ${ytcv.state.currentGain})`);

      // Auto going off from this tab's popup.
      onAir({ entry: { autoApplyLoudnessLive: true } });
      liveAnswer(-20);
      await settle();
      const toggled = await popupGesture({ type: 'setAutoApplyLoudness', enabled: false });
      await settle();
      assert(toggled?.ok === true && heldLiveFollows.length === 0,
        `and so does the popup's toggle (${JSON.stringify(toggled?.ok)} / ${heldLiveFollows.length})`);
    }

    section('Live level: what is stored, and when');
    {
      // Auto inherited from the all-channel default, over a gain held against
      // the plain rendition, under which the start cap leaves the first gain.
      onAir({ autoLive: true, entry: { gainLive: 2.0, gainLivePlain: true } });
      ytcv._set('defaultAutoApplyLoudnessLive', true);
      liveAnswer(-24.8);
      await settle();
      assert(liveSaves().length === 1, `the first level is stored (${liveSaves().length})`);
      assert(close(entryNow().gainLive, liveGain(-24.8)), `as the live gain (${entryNow().gainLive})`);
      assert(!('gainLivePlain' in entryNow()), 'to play as it is, with the mark it had taken off');
      assert(!('autoApplyLoudnessLive' in entryNow()) && !('autoApplyLoudnessVideo' in entryNow()),
        `with no Auto flag written, so the channel goes on following the default (${JSON.stringify(entryNow())})`);
      assert(entryNow().name === 'Live Follow' && entryNow().url === LIVE_URL, 'under the channel being watched');

      liveAnswer(-24.0);
      await settle();
      assert(liveSaves().length === 1 && close(ytcv.state.currentGain, liveGain(-24.0)),
        `0.8 dB is played and not stored (${liveSaves().length} / ${ytcv.state.currentGain})`);
      assert(close(entryNow().gainLive, liveGain(-24.8)), `the stored gain stays (${entryNow().gainLive})`);

      // Measured from what was stored, not from the last level played.
      liveAnswer(-23.7);
      await settle();
      assert(liveSaves().length === 2 && close(entryNow().gainLive, liveGain(-23.7)),
        `1.1 dB from the stored gain is stored, though 0.3 dB from the last (${liveSaves().length} / ${entryNow().gainLive})`);
      raiseInFull();
      liveAnswer(-24.8);
      await settle();
      assert(liveSaves().length === 3 && close(entryNow().gainLive, liveGain(-24.8)),
        `and 1.1 dB the other way (${liveSaves().length} / ${entryNow().gainLive})`);

      // The target moving moves the gain with it.
      simulateStorageChange({
        autoLoudnessSettings: { newValue: { targetLufs: -20, autoApplyLoudnessLiveDefault: true } }
      });
      await settle();
      assert(liveSaves().length === 4 && close(entryNow().gainLive, liveGain(-24.8, -20)),
        `a new target is stored (${liveSaves().length} / ${entryNow().gainLive})`);

      // A write that fails is tried again by the next evaluation.
      const setBefore = chrome.storage.local.set;
      chrome.storage.local.set = () => Promise.reject(new Error('storage write failed'));
      noRise();
      liveAnswer(-21);
      await settle();
      assert(liveSaves().length === 5 && close(entryNow().gainLive, liveGain(-24.8, -20)),
        `a write that fails leaves the stored gain (${liveSaves().length} / ${entryNow().gainLive})`);
      assert(close(ytcv.state.currentGain, liveGain(-21, -20)), `and the level still plays (${ytcv.state.currentGain})`);
      chrome.storage.local.set = setBefore;
      liveAnswer(-21);
      await settle();
      assert(liveSaves().length === 6 && close(entryNow().gainLive, liveGain(-21, -20)),
        `the next one tries again, and lands (${liveSaves().length} / ${entryNow().gainLive})`);

      // Before the fold has landed nothing is stored.
      ytcv._set('storageMigrated', false);
      noRise();
      liveAnswer(-17);
      await settle();
      assert(liveSaves().length === 6 && close(ytcv.state.currentGain, liveGain(-17, -20)),
        `before the fold the level plays and is not stored (${liveSaves().length} / ${ytcv.state.currentGain})`);
      const beforeFold = await ytcv.evaluateLiveSave('check');
      assert(beforeFold.decision === 'delta' && beforeFold.saved === false && beforeFold.reason === 'before fold',
        `and the evaluation says why (${JSON.stringify(beforeFold)})`);
      ytcv._set('storageMigrated', true);

      // One write at a time.
      const holdSet = chrome.storage.local.set;
      let releaseSet = null;
      chrome.storage.local.set = (obj) => new Promise((resolve) => { releaseSet = () => resolve(holdSet(obj)); });
      ytcv._set('currentLiveLkfs', -15);
      const first = ytcv.evaluateLiveSave('first');
      await settle();
      const second = await ytcv.evaluateLiveSave('second');
      assert(second.saved === false && second.reason === 'save in flight' && liveSaves().length === 7,
        `a second write is not sent while one is out (${JSON.stringify(second)} / ${liveSaves().length})`);
      chrome.storage.local.set = holdSet;
      releaseSet();
      const firstDone = await first;
      assert(firstDone.decision === 'delta' && firstDone.saved === true && firstDone.ok === true && firstDone.source === 'first',
        `the one that was out lands (${JSON.stringify(firstDone)})`);
      assert(close(firstDone.gain, liveGain(-15, -20)) && close(firstDone.baselineGain, liveGain(-21, -20))
        && close(firstDone.deltaDb, 6),
        `and says what it compared (${firstDone.gain} / ${firstDone.baselineGain} / ${firstDone.deltaDb})`);
      const under = await ytcv.evaluateLiveSave('under');
      assert(under.decision === 'skip' && under.saved === false && under.ok === null && close(under.deltaDb, 0),
        `the same level again is a skip (${JSON.stringify(under)})`);

      // Another video is a first level again.
      setURL('/watch', 'liveFollowVid2');
      ytcv._set('_lastVideoId', 'liveFollowVid2');
      const opened = await ytcv.evaluateLiveSave('open');
      assert(opened.decision === 'open' && opened.saved === true && opened.ok === true && opened.baselineGain === null,
        `another video's first level is stored whatever it is (${JSON.stringify(opened)})`);
      setURL('/watch', LIVE_VID);
      ytcv._set('_lastVideoId', LIVE_VID);

      // A level lost falls back to the gain stored.
      ytcv._set('liveSaveBaseline', { videoId: LIVE_VID, videoType: 'live', gain: liveGain(-21, -20) });
      ytcv._set('currentLiveLkfs', -21);
      raiseInFull();
      liveAnswer(-20.5);
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-20.5, -20)), `a level close by plays (${ytcv.state.currentGain})`);
      const storedBeforeLoss = entryNow().gainLive;
      liveAnswer(null);
      await settle();
      assert(ytcv.state.currentLiveLkfs === null && close(ytcv.state.currentGain, storedBeforeLoss)
        && !close(storedBeforeLoss, liveGain(-20.5, -20)),
        `an answer without a live level plays the stored gain (${ytcv.state.currentLiveLkfs} / ${ytcv.state.currentGain} / ${storedBeforeLoss})`);
      assert(heldLiveFollows.length === 1, `and the stream is still followed (${heldLiveFollows.length})`);
      ytcv._set('targetLufs', -18);

      // A navigation to another video forgets what was stored for this one.
      ytcv._set('liveSaveBaseline', { videoId: LIVE_VID, videoType: 'live', gain: 1 });
      setURL('/watch', 'liveFollowVid3');
      await ytcv.applyVideoVolume();
      assert(ytcv.state.liveSaveBaseline === null && ytcv.state.currentLiveLkfs === null,
        `a new video starts with nothing stored and no live level (${JSON.stringify(ytcv.state.liveSaveBaseline)} / ${ytcv.state.currentLiveLkfs})`);
      // The apply goes on asking the bridge until it answers.
      simulateBridgeMessage({ videoId: 'liveFollowVid3', isLiveContent: true, isLiveNow: false, channelId: LIVE_CH });
      await settle();
    }

    section('Live level: a change is measured to the 0.1 dB the player names');
    {
      onAir({ entry: { autoApplyLoudnessLive: true } });
      ytcv._set('targetLufs', -30);
      liveAnswer(-45.5);
      await settle();
      assert(liveSaves().length === 1, `the first level is stored (${liveSaves().length})`);
      // The two gains are 1.0 dB apart as the player names them, and a hair
      // under it as the arithmetic comes out.
      const exact = gainChangeDb(liveGain(-44.5, -30), liveGain(-45.5, -30));
      assert(exact < 1 && exact > 0.999, `the exact change falls just short of 1 dB (${exact})`);
      noRise();
      liveAnswer(-44.5);
      await settle();
      assert(liveSaves().length === 2 && close(entryNow().gainLive, liveGain(-44.5, -30)),
        `a change the player names as 1.0 dB is stored (${liveSaves().length} / ${entryNow().gainLive})`);

      // Measured from -44.5 stored, whether or not the line above stored it.
      ytcv._set('liveSaveBaseline', { videoId: LIVE_VID, videoType: 'live', gain: liveGain(-44.5, -30) });
      const savesBefore = liveSaves().length;
      ytcv._set('currentLiveLkfs', -43.6);
      const under = await ytcv.evaluateLiveSave('check');
      assert(under.decision === 'skip' && under.deltaDb === 0.9 && under.saved === false && liveSaves().length === savesBefore,
        `0.9 dB is a skip, and says 0.9 (${JSON.stringify(under)} / ${liveSaves().length})`);
      // And a 0.9 dB change whose arithmetic comes out a hair over it.
      ytcv._set('liveSaveBaseline', { videoId: LIVE_VID, videoType: 'live', gain: liveGain(-45.2, -30) });
      ytcv._set('currentLiveLkfs', -44.3);
      const over = gainChangeDb(liveGain(-44.3, -30), liveGain(-45.2, -30));
      const nearly = await ytcv.evaluateLiveSave('check');
      assert(over > 0.9 && nearly.decision === 'skip' && nearly.deltaDb === 0.9 && liveSaves().length === savesBefore,
        `0.9 dB a hair over is a skip too (${over} / ${JSON.stringify(nearly)})`);
      ytcv._set('liveSaveBaseline', { videoId: LIVE_VID, videoType: 'live', gain: liveGain(-44.5, -30) });
      ytcv._set('currentLiveLkfs', -43.5);
      ytcv._set('currentGain', liveGain(-43.5, -30));
      const at = await ytcv.evaluateLiveSave('check');
      assert(at.decision === 'delta' && at.deltaDb === 1 && at.saved === true && at.ok === true,
        `1.0 dB is a delta, and says 1 (${JSON.stringify(at)})`);
      ytcv._set('targetLufs', -18);
    }

    section('Live level: what was stored for one type does not stand for the other');
    {
      // Auto on for both types. A message that names the stream as a video,
      // then the stream as itself: each type's slot gets its own first store.
      onAir({ autoLive: true, autoVideo: true, entry: { autoApplyLoudnessLive: true, autoApplyLoudnessVideo: true } });
      liveAnswer(-24.8, { isLiveContent: false });
      await settle();
      assert(ytcv.state.currentVideoType === 'video' && close(entryNow().gainVideo, liveGain(-24.8)) && !('gainLive' in entryNow()),
        `stored as the video gain while the type is a video (${ytcv.state.currentVideoType} / ${JSON.stringify(entryNow())})`);
      liveAnswer(-24.8);
      await settle();
      assert(ytcv.state.currentVideoType === 'live' && close(entryNow().gainLive, liveGain(-24.8)) && liveSaves().length === 2,
        `the first evaluation as live stores the live gain too (${ytcv.state.currentVideoType} / ${JSON.stringify(entryNow())} / ${liveSaves().length})`);
      const again = await ytcv.evaluateLiveSave('again');
      assert(again.decision === 'skip' && again.saved === false && liveSaves().length === 2,
        `and the same type again is a skip (${JSON.stringify(again)})`);

      // The other way round: stored as live, then evaluated as a video.
      ytcv._set('currentVideoType', 'video');
      ytcv._set('currentLiveLkfs', -24.5);
      const asVideo = await ytcv.evaluateLiveSave('video');
      assert(asVideo.decision === 'open' && asVideo.saved === true && asVideo.ok === true
        && close(entryNow().gainVideo, liveGain(-24.5)) && close(entryNow().gainLive, liveGain(-24.8)),
        `a video after live is a first store for the video slot (${JSON.stringify(asVideo)} / ${JSON.stringify(entryNow())})`);
      const videoAgain = await ytcv.evaluateLiveSave('video again');
      assert(videoAgain.decision === 'skip' && videoAgain.saved === false,
        `and the same type again is a skip (${JSON.stringify(videoAgain)})`);
    }

    section('Live level: an evaluation stores nothing it is not following');
    {
      onAir({ entry: { autoApplyLoudnessLive: true } });
      ytcv._set('currentLiveLkfs', -20);
      const watched = { id: LIVE_CH, name: 'Live Follow', url: LIVE_URL };
      const idBefore = chrome.runtime.id;
      for (const [what, take, give] of [
        ['with no channel', () => ytcv._set('currentChannel', { id: '', name: '', url: '' }), () => ytcv._set('currentChannel', watched)],
        ['with Auto off', () => ytcv._set('currentAutoApplyLoudnessLive', false), () => ytcv._set('currentAutoApplyLoudnessLive', true)],
        ['with no live level', () => ytcv._set('currentLiveLkfs', null), () => ytcv._set('currentLiveLkfs', -20)],
        ['with the extension reloaded', () => { chrome.runtime.id = undefined; }, () => { chrome.runtime.id = idBefore; }]
      ]) {
        take();
        const result = await ytcv.evaluateLiveSave(what);
        give();
        await settle();
        assert(result.saved === false && result.reason === 'not following' && liveSaves().length === 0,
          `${what} nothing is stored (${JSON.stringify(result)} / ${liveSaves().length})`);
      }
      // With all four in place, and the level's gain playing, it is.
      ytcv._set('currentGain', liveGain(-20));
      const control = await ytcv.evaluateLiveSave('control');
      assert(control.saved === true && control.ok === true && liveSaves().length === 1,
        `with all of them in place it is stored (${JSON.stringify(control)} / ${liveSaves().length})`);

      // The apply is over once what it stores has landed.
      onAir({ entry: { autoApplyLoudnessLive: true } });
      ytcv._set('currentLiveLkfs', -22);
      await ytcv.applyPreferredGain();
      assert(close(entryNow().gainLive, liveGain(-22)),
        `the apply returns with the live gain stored (${entryNow().gainLive})`);
    }

    section('Live level: with Auto off it is shown, not followed or stored');
    {
      onAir({ autoLive: false, entry: { gainLive: 0.5, gainLivePlain: true, autoApplyLoudnessLive: false } });
      liveAnswer(-24.8, { loudnessDb: -6, baseLoudnessDb: -6 });
      await settle();
      assert(ytcv.state.currentGain === 0.5, `the saved gain plays (${ytcv.state.currentGain})`);
      assert(liveSaves().length === 0 && heldLiveFollows.length === 0,
        `nothing is stored or followed (${liveSaves().length} / ${heldLiveFollows.length})`);
      const shown = ytcv.getState();
      assert(shown.liveLkfs === -24.8 && shown.contentLufs === -24.8,
        `the popup is given the live level as the Loudness (${shown.liveLkfs} / ${shown.contentLufs})`);
      const preview = await popupGesture({ type: 'setGainLive', gain: 0.6 });
      assert(preview?.ok === true, `the manual controls are free (${JSON.stringify(preview)})`);

      const applied = await popupGesture({ type: 'applyLoudness' });
      await settle();
      assert(applied?.ok === true && close(applied.gain, liveGain(-24.8)),
        `Apply to channel takes the live level over the response's (${JSON.stringify(applied)})`);
      assert(close(entryNow().gainLive, liveGain(-24.8)) && !('gainLivePlain' in entryNow()),
        `and stores it to play as it is (${JSON.stringify(entryNow())})`);
      assert(entryNow().autoApplyLoudnessLive === false,
        `as a manual choice, with the Auto state written (${entryNow().autoApplyLoudnessLive})`);
      assert(close(ytcv.state.currentGain, liveGain(-24.8)), `and plays it (${ytcv.state.currentGain})`);
    }

    section('Live level: it takes the manual controls while Auto applies it');
    {
      onAir({ entry: { autoApplyLoudnessLive: true } });
      liveAnswer(-24.8);
      await settle();
      const preview = await popupGesture({ type: 'setGainLive', gain: 2 });
      const save = await popupGesture({ type: 'setGain', gain: 2 });
      assert(preview?.ok === false && preview?.reason === 'auto apply controls current gain'
        && save?.ok === false && save?.reason === 'auto apply controls current gain',
        `the slider and the presets are refused (${JSON.stringify(preview)} / ${JSON.stringify(save)})`);
      assert(close(ytcv.state.currentGain, liveGain(-24.8)), `and the live gain stays (${ytcv.state.currentGain})`);
    }

    section('Live level: the popup is shown it, and told when it moves');
    {
      onAir({ entry: { autoApplyLoudnessLive: true } });
      ytcv._set('targetLufs', -6);
      liveAnswer(-40);
      await settle();
      mockSentMessages.length = 0;
      liveAnswer(-41);
      await settle();
      const told = mockSentMessages.filter((m) => m?.type === 'stateChanged');
      assert(ytcv.state.currentGain === 6 && told.some((m) => m.liveLkfs === -41 && m.contentLufs === -41),
        `a level that moves under a gain held at its limit still reaches the popup (${JSON.stringify(told.map((m) => [m.liveLkfs, m.gain]))})`);
      ytcv._set('targetLufs', -18);

      const drawnIn = (popup, id) => popup.node(id).textContent
        + (popup.node(id).children[0] ? popup.node(id).children[0].textContent : '');
      const popup = makePopup({
        answer: async () => ({
          isWatchPage: true,
          channel: { id: LIVE_CH, name: 'Live Follow', url: '' },
          appliesTo: LIVE_CH + '|live|' + LIVE_VID,
          loudnessDb: -6, liveLkfs: -24.8, contentLufs: -24.8, gain: 1.0,
          targetLufs: -18, videoType: 'live', isLiveNow: true,
          autoApplyLoudnessVideo: false, autoApplyLoudnessLive: false
        })
      });
      await popup.ready();
      const suggested = String(gainToPercent(calcLiveGain(-24.8, -18))) + '%';
      assert(drawnIn(popup, 'contentLufs') === '-24.8 LUFS', `the Loudness is the live level (${drawnIn(popup, 'contentLufs')})`);
      assert(drawnIn(popup, 'suggestedVol') === suggested,
        `the suggestion is worked out from it (${drawnIn(popup, 'suggestedVol')} / ${suggested})`);
      assert(popup.node('applyBtn').disabled === false
        && popup.node('applyBtn').textContent.startsWith('applyToChannelWithValue ' + suggested),
        `and Apply to channel offers it (${popup.node('applyBtn').textContent})`);
      assert(popup.node('fallbackBadge').style.display === 'none', 'a live level is a level detected');
    }

    section('Live level: the popup on open does not wait for a level in hand');
    {
      onAir({ autoLive: false, entry: { autoApplyLoudnessLive: false } });
      ytcv._set('currentLiveLkfs', -24.8);
      let asks = 0;
      mockPostMessageHandler = (data) => {
        if (data?.type === '__yt_channel_volume_request__') asks += 1;
      };
      const answer = await simulateRuntimeMessage({ type: 'forceDetect' });
      mockPostMessageHandler = null;
      assert(answer?.liveLkfs === -24.8 && asks === 1,
        `the live level in hand is answered after one ask (${answer?.liveLkfs} / ${asks})`);
    }

    section('Live level: a premiere names one too, and Auto for videos follows it');
    {
      onAir({ type: 'video', autoLive: false, autoVideo: true, entry: { gainLive: 0.5, autoApplyLoudnessVideo: true } });
      liveAnswer(-20, { isLiveContent: false });
      await settle();
      assert(ytcv.state.currentVideoType === 'video' && close(ytcv.state.currentGain, liveGain(-20)),
        `it plays as a video, at the live level (${ytcv.state.currentVideoType} / ${ytcv.state.currentGain})`);
      assert(close(entryNow().gainVideo, liveGain(-20)) && entryNow().gainLive === 0.5,
        `and is stored as the video gain (${JSON.stringify(entryNow())})`);
      assert(heldLiveFollows.length === 1, `and followed (${heldLiveFollows.length})`);
    }

    section('Live level: a gain another tab stored does not displace this tab\'s level');
    {
      onAir({ entry: { autoApplyLoudnessLive: true } });
      liveAnswer(-24.8);
      await settle();
      const elsewhere = { name: 'Live Follow', url: LIVE_URL, gainLive: 0.2, autoApplyLoudnessLive: true };
      simulateStorageChange({
        channelVolumes: { oldValue: { [LIVE_CH]: entryNow() }, newValue: { [LIVE_CH]: elsewhere } }
      });
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-24.8)),
        `this tab goes on playing its own level (${ytcv.state.currentGain})`);
    }

    section('Start cap: the first live gain for a stream is held to 3 dB over the stored live gain, and rises from there');
    {
      // Stored 1.0 against -18: a live level of -28 would play 10 dB above it.
      onAir({ entry: { autoApplyLoudnessLive: true, gainLive: 1.0 } });
      liveAnswer(-28);
      await settle();
      assert(close(dbOver(ytcv.state.currentGain, 1.0), 3),
        `the first gain plays 3 dB over the stored one (${dbOver(ytcv.state.currentGain, 1.0)})`);
      const capped = await simulateRuntimeMessage({ type: 'getState' });
      assert(capped?.liveLkfs === -28 && capped?.contentLufs === -28 && !('liveGateHolds' in capped),
        `the level is shown as it is named (${capped?.liveLkfs} / ${capped?.contentLufs} / ${JSON.stringify(capped)})`);
      assert(liveSaves().length === 0 && entryNow().gainLive === 1.0,
        `nothing is stored while the cap holds it (${liveSaves().length} / ${JSON.stringify(entryNow())})`);
      assert(heldLiveFollows.length === 1, `and the stream is followed on (${heldLiveFollows.length})`);
      const preview = await popupGesture({ type: 'setGainLive', gain: 0.8 });
      assert(preview?.ok === false && preview?.reason === 'auto apply controls current gain',
        `the manual controls stay locked (${JSON.stringify(preview)})`);

      ago(30000);
      liveAnswer(-28);
      await settle();
      assert(close(dbOver(ytcv.state.currentGain, 1.0), 4.5) && liveSaves().length === 0,
        `30 s on it has risen 1.5 dB more, and still nothing is stored (${dbOver(ytcv.state.currentGain, 1.0)} / ${liveSaves().length})`);
      raiseInFull();
      liveAnswer(-28);
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-28)) && liveSaves().length === 1
        && close(entryNow().gainLive, liveGain(-28)) && !('liveGateOpenFor' in entryNow()),
        `once it reaches the level, the level's gain is stored, naming no stream (${liveSaves().length} / ${JSON.stringify(entryNow())})`);

      // Within the cap, the first gain plays as it stands.
      onAir({ entry: { autoApplyLoudnessLive: true, gainLive: 1.0 } });
      liveAnswer(-20);
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-20)), `2 dB over plays as it stands (${ytcv.state.currentGain})`);
    }

    section('Start cap: which first gains it holds');
    {
      // Nothing stored for live: nothing to hold the gain to.
      onAir({ entry: { autoApplyLoudnessLive: true, gainVideo: 1.0 } });
      liveAnswer(-40);
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-40)), `with no live gain stored the level plays (${ytcv.state.currentGain})`);

      // A live gain stored at 0 holds nothing either.
      onAir({ entry: { autoApplyLoudnessLive: true, gainLive: 0 } });
      liveAnswer(-40);
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-40)), `with 0 stored the level plays (${ytcv.state.currentGain})`);

      // A level played as a video is not held.
      onAir({ type: 'video', autoVideo: true, entry: { autoApplyLoudnessVideo: true, gainLive: 1.0, gainVideo: 1.0 } });
      liveAnswer(-40, { isLiveContent: false });
      await settle();
      assert(ytcv.state.currentVideoType === 'video' && close(ytcv.state.currentGain, liveGain(-40)),
        `a video plays the level (${ytcv.state.currentVideoType} / ${ytcv.state.currentGain})`);

      // A gain another tab stores later is no new start: the gain playing holds.
      onAir({ entry: { autoApplyLoudnessLive: true, gainLive: 0.5 } });
      liveAnswer(-24);
      await settle();
      const first = ytcv.state.currentGain;
      assert(close(dbOver(first, 0.5), 3), `12 dB over 0.5 plays 3 dB over (${dbOver(first, 0.5)})`);
      const after = { name: 'Live Follow', url: LIVE_URL, gainLive: 4, autoApplyLoudnessLive: true };
      mockStorage['channelVolumes'] = { [LIVE_CH]: after };
      simulateStorageChange({
        channelVolumes: { oldValue: { [LIVE_CH]: { ...after, gainLive: 0.5 } }, newValue: { [LIVE_CH]: after } }
      });
      await settle();
      assert(dbOver(ytcv.state.currentGain, first) < 0.01,
        `another tab's store does not lift it (${dbOver(ytcv.state.currentGain, first)})`);

      // Auto turned on in the popup plays the level in hand as it stands.
      onAir({ entry: { autoApplyLoudnessLive: true, gainLive: 1.0 } });
      liveAnswer(-40);
      await settle();
      const off = await popupGesture({ type: 'setAutoApplyLoudness', enabled: false });
      await settle();
      const on = await popupGesture({ type: 'setAutoApplyLoudness', enabled: true });
      await settle();
      assert(off?.ok === true && on?.ok === true && close(ytcv.state.currentGain, liveGain(-40)),
        `turned off and on, the level plays as it stands (${JSON.stringify([off?.ok, on?.ok])} / ${ytcv.state.currentGain})`);
      assert(close(entryNow().gainLive, liveGain(-40)) && entryNow().autoApplyLoudnessLive === true && !('liveGateOpenFor' in entryNow()),
        `and is stored with the flag (${JSON.stringify(entryNow())})`);
    }

    section('Start cap: what is stored while it holds is what plays when the level goes');
    {
      // The level lost: the stored gain plays, and it is the one from before.
      onAir({ entry: { autoApplyLoudnessLive: true, gainLive: 1.0 } });
      liveAnswer(-28);
      await settle();
      liveAnswer(null);
      await settle();
      assert(ytcv.state.currentGain === 1.0 && entryNow().gainLive === 1.0,
        `with the level lost the stored gain from before plays (${ytcv.state.currentGain} / ${entryNow().gainLive})`);

      // The stream opened again: the cap is taken from that same stored gain.
      onAir({ entry: { autoApplyLoudnessLive: true, gainLive: entryNow().gainLive } });
      liveAnswer(-28);
      await settle();
      assert(close(dbOver(ytcv.state.currentGain, 1.0), 3), `opened again it is capped again (${dbOver(ytcv.state.currentGain, 1.0)})`);

      // Auto turned off: the stored gain from before plays.
      const off = await popupGesture({ type: 'setAutoApplyLoudness', enabled: false });
      await settle();
      assert(off?.ok === true && ytcv.state.currentGain === 1.0, `with Auto off the stored gain from before plays (${ytcv.state.currentGain})`);

      // An evaluation with the gain playing under the level's says so.
      onAir({ entry: { autoApplyLoudnessLive: true } });
      ytcv._set('currentLiveLkfs', -20);
      ytcv._set('currentGain', liveGain(-20) * 0.99);
      const held = await ytcv.evaluateLiveSave('held');
      assert(held.decision === 'open' && held.saved === false && held.reason === 'held under the level' && liveSaves().length === 0,
        `a gain held under the level's is not stored (${JSON.stringify(held)})`);
      ytcv._set('currentGain', liveGain(-20));
      const reached = await ytcv.evaluateLiveSave('reached');
      assert(reached.saved === true && reached.ok === true && close(entryNow().gainLive, liveGain(-20)),
        `the level's gain playing is stored (${JSON.stringify(reached)})`);
    }

    section('Rise cut: a level 1 dB or more over the one named before it is taken 3 dB louder');
    {
      onAir({ entry: { autoApplyLoudnessLive: true } });
      liveAnswer(-30);
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-30)), `the first level plays (${ytcv.state.currentGain})`);
      liveAnswer(-28.9);
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-25.9)) && ytcv.state.liveLevelRise === 1.1,
        `1.1 dB up plays as if 3 dB louder (${ytcv.state.currentGain} / ${ytcv.state.liveLevelRise})`);
      assert(close(entryNow().gainLive, liveGain(-30)), `and nothing is stored while the cut holds it (${entryNow().gainLive})`);
      liveAnswer(-28.9);
      await settle();
      assert(dbOver(ytcv.state.currentGain, liveGain(-25.9)) < 0.01,
        `the same level again does not lift it with no time since (${dbOver(ytcv.state.currentGain, liveGain(-25.9))})`);
      ago(60000);
      liveAnswer(-28.9);
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-28.9)) && close(entryNow().gainLive, liveGain(-28.9)),
        `60 s on it is back at the level's gain, which is stored (${ytcv.state.currentGain} / ${entryNow().gainLive})`);

      // The rise is taken to 0.1 dB before it is compared.
      raiseInFull();
      liveAnswer(-31.4);
      await settle();
      liveAnswer(-30.4);
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-27.4)), `1.0 dB up, taken to 0.1 dB, counts (${ytcv.state.currentGain})`);
      raiseInFull();
      liveAnswer(-31.3);
      await settle();
      raiseInFull();
      liveAnswer(-30.4);
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-30.4)), `0.9 dB up does not (${ytcv.state.currentGain})`);

      // Auto turned on plays the level in hand as it stands, however it rose.
      onAir({ autoLive: false, entry: { autoApplyLoudnessLive: false } });
      liveAnswer(-30);
      await settle();
      liveAnswer(-28.9);
      await settle();
      const on = await popupGesture({ type: 'setAutoApplyLoudness', enabled: true });
      await settle();
      assert(on?.ok === true && close(ytcv.state.currentGain, liveGain(-28.9)),
        `turned on after a rise, the level plays as it stands (${JSON.stringify(on?.ok)} / ${ytcv.state.currentGain})`);

      // A level named for another video is not what this one rose over.
      setURL('/watch', 'liveRiseVid2');
      liveAnswer(-25, { videoId: 'liveRiseVid2' });
      await settle();
      assert(ytcv.state.liveLevelRise === null && close(ytcv.state.currentGain, liveGain(-25)),
        `another video's first level is no rise (${ytcv.state.liveLevelRise} / ${ytcv.state.currentGain})`);
      setURL('/watch', LIVE_VID);
    }

    section('Live level: read alone for the popup, it becomes the level in hand, and Auto\'s is left as it is');
    {
      const liveRead = (liveLkfs, { videoId = LIVE_VID, source = globalThis.window, type = '__yt_channel_volume_live__' } = {}) => {
        for (const fn of mockEventListeners['message'] || []) {
          fn({ source, data: { type, videoId, liveLkfs } });
        }
      };
      onAir({ entry: { autoApplyLoudnessLive: true } });
      liveAnswer(-24.8);
      await settle();
      const playing = ytcv.state.currentGain;
      mockSentMessages.length = 0;
      const saves = liveSaves().length;
      liveRead(-20);
      await settle();
      assert(ytcv.state.readLiveLkfs === -20 && ytcv.state.currentGain === playing && liveSaves().length === saves,
        `the level is taken, and nothing is applied or stored (${ytcv.state.readLiveLkfs} / ${ytcv.state.currentGain} / ${liveSaves().length - saves})`);
      assert(ytcv.state.currentLiveLkfs === -24.8,
        `Auto's level stays the one the full answer named (${ytcv.state.currentLiveLkfs})`);
      assert(mockSentMessages.some((m) => m?.type === 'stateChanged' && m.liveLkfs === -20 && m.contentLufs === -20),
        `and the popup is told (${JSON.stringify(mockSentMessages.map((m) => m?.liveLkfs))})`);

      for (const [what, read] of [
        ['another video\'s level', () => liveRead(-30, { videoId: 'someOtherVideo' })],
        ['an answer naming no level', () => liveRead(null)],
        ['a level that is not a number', () => liveRead('-30')],
        ['a message from another window', () => liveRead(-30, { source: {} })],
        ['a message of another type', () => liveRead(-30, { type: '__some_page_message__' })]
      ]) {
        read();
        await settle();
        assert(ytcv.state.readLiveLkfs === -20, `${what} leaves the level in hand (${ytcv.state.readLiveLkfs})`);
      }

      // With Auto off, Apply to channel applies the level read last.
      onAir({ autoLive: false, entry: { autoApplyLoudnessLive: false } });
      liveAnswer(-24.8);
      await settle();
      liveRead(-20);
      await settle();
      const applied = await popupGesture({ type: 'applyLoudness' });
      await settle();
      assert(applied?.ok === true && close(ytcv.state.currentGain, liveGain(-20)) && close(entryNow().gainLive, liveGain(-20)),
        `Apply to channel plays and stores it (${JSON.stringify(applied)} / ${ytcv.state.currentGain} / ${entryNow().gainLive})`);

      // The popup's ask goes to the page.
      mockPostMessages.length = 0;
      const asked = await simulateRuntimeMessage({ type: 'askLiveLevel' });
      assert(asked?.ok === true && mockPostMessages.filter((m) => m?.type === '__yt_channel_volume_live_ask__').length === 1,
        `asked by the popup, the bridge is asked (${JSON.stringify(asked)} / ${JSON.stringify(mockPostMessages)})`);

      // A level read on one stream is not carried to the next video.
      onAir({ entry: { autoApplyLoudnessLive: true } });
      liveAnswer(-24.8);
      await settle();
      liveRead(-20);
      await settle();
      setURL('/watch', 'nextVideoAfterRead');
      fireNavigateFinish();
      await settle();
      const next = ytcv.getState();
      assert(ytcv.state.readLiveLkfs === null && next.liveLkfs === null && next.contentLufs === null,
        `a navigation to another video lets the level in hand go (${ytcv.state.readLiveLkfs} / ${next.liveLkfs} / ${next.contentLufs})`);
    }

    section('Live level: a level read for the popup is not what Auto re-applies or stores in between full answers');
    {
      const liveRead = (liveLkfs) => {
        for (const fn of mockEventListeners['message'] || []) {
          fn({ source: globalThis.window, data: { type: '__yt_channel_volume_live__', videoId: LIVE_VID, liveLkfs } });
        }
      };
      onAir({ entry: { autoApplyLoudnessLive: true } });
      liveAnswer(-24.8);
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-24.8)) && close(entryNow().gainLive, liveGain(-24.8)),
        `the full answer plays and stores its level (${ytcv.state.currentGain} / ${entryNow().gainLive})`);
      liveRead(-20);
      await settle();
      const saves = liveSaves().length;

      // Another tab stores a gain for another channel: the change notification
      // re-applies Auto for this channel.
      const other = { name: 'Other', url: 'https://www.youtube.com/channel/UCotherChannel', gainVideo: 0.5 };
      const before = { ...mockStorage['channelVolumes'] };
      mockStorage['channelVolumes'] = { ...before, UCotherChannel: other };
      simulateStorageChange({
        channelVolumes: { oldValue: before, newValue: mockStorage['channelVolumes'] }
      });
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-24.8)),
        `another channel's store leaves Auto playing the full answer's level (${ytcv.state.currentGain})`);

      // A settings write that changes neither the target nor Auto re-applies
      // Auto's gain through applyPreferredGain, which decides what to store.
      for (const showGainOverlay of [true, false]) {
        simulateStorageChange({
          autoLoudnessSettings: { newValue: { targetLufs: -18, displayUnit: '%', showGainOverlay } }
        });
        await settle();
      }
      assert(close(ytcv.state.currentGain, liveGain(-24.8)) && close(entryNow().gainLive, liveGain(-24.8))
        && liveSaves().length === saves,
        `the overlay switched on and off plays and stores nothing new (${ytcv.state.currentGain} / ${entryNow().gainLive} / ${liveSaves().length - saves})`);
      const shown = ytcv.getState();
      assert(shown.liveLkfs === -20 && shown.contentLufs === -20,
        `the popup goes on being shown the level read (${shown.liveLkfs} / ${shown.contentLufs})`);

      // The next full answer naming that level is what Auto takes.
      noRise();
      liveAnswer(-20);
      await settle();
      assert(ytcv.state.currentLiveLkfs === -20 && close(ytcv.state.currentGain, liveGain(-20))
        && close(entryNow().gainLive, liveGain(-20)),
        `a full answer of -20 plays and stores it (${ytcv.state.currentGain} / ${entryNow().gainLive})`);

      // Turning Auto on is a gesture made against what the popup shows: the
      // level in hand is played, stored, and is Auto's from then on.
      onAir({ autoLive: false, entry: { autoApplyLoudnessLive: false } });
      liveAnswer(-24.8);
      await settle();
      liveRead(-20);
      await settle();
      const on = await popupGesture({ type: 'setAutoApplyLoudness', enabled: true });
      await settle();
      assert(on?.ok === true && ytcv.state.currentLiveLkfs === -20 && close(ytcv.state.currentGain, liveGain(-20))
        && close(entryNow().gainLive, liveGain(-20)) && entryNow().autoApplyLoudnessLive === true,
        `Auto turned on plays and stores the level in hand (${JSON.stringify(on?.ok)} / ${ytcv.state.currentLiveLkfs} / ${ytcv.state.currentGain} / ${entryNow().gainLive})`);
      simulateStorageChange({
        autoLoudnessSettings: { newValue: { targetLufs: -18, displayUnit: '%', showGainOverlay: true } }
      });
      await settle();
      assert(close(ytcv.state.currentGain, liveGain(-20)),
        `and goes on playing it when Auto is re-applied (${ytcv.state.currentGain})`);
    }

    section('Live level: the popup asks for it every second while it is open on a stream');
    {
      const stateWith = (over) => ({
        isWatchPage: true,
        channel: { id: LIVE_CH, name: 'Live Follow', url: '' },
        appliesTo: LIVE_CH + '|live|' + LIVE_VID,
        loudnessDb: null, liveLkfs: -24.8, contentLufs: -24.8, gain: 1.0,
        targetLufs: -18, videoType: 'live', isLiveNow: true,
        autoApplyLoudnessVideo: false, autoApplyLoudnessLive: false,
        ...over
      });
      const popup = makePopup({ answer: async () => stateWith({}) });
      await popup.ready();
      const asks = () => popup.asked.filter((m) => m.type === 'askLiveLevel').length;
      assert(asks() === 0, `nothing is asked before a second has passed (${asks()})`);
      await popup.runTimers();
      assert(asks() === 1, `a second on, it is asked (${asks()})`);

      // A level that reaches the popup is drawn, and asking goes on once a second.
      await popup.deliver({ type: 'stateChanged', ...stateWith({ liveLkfs: -20, contentLufs: -20 }) });
      const drawnIn = (id) => popup.node(id).textContent + (popup.node(id).children[0] ? popup.node(id).children[0].textContent : '');
      assert(drawnIn('contentLufs') === '-20.0 LUFS'
        && drawnIn('suggestedVol') === String(gainToPercent(calcLiveGain(-20, -18))) + '%',
        `the new level is drawn (${drawnIn('contentLufs')} / ${drawnIn('suggestedVol')})`);
      await popup.runTimers();
      assert(asks() === 2, `and asked once more a second on, not once per state drawn (${asks()})`);

      // A page that no longer shows a stream stops it.
      await popup.deliver({ type: 'stateChanged', ...stateWith({ isLiveNow: false, liveLkfs: null, contentLufs: null }) });
      await popup.runTimers();
      await popup.runTimers();
      assert(asks() === 2, `a page with no stream is not asked about (${asks()})`);

      const video = makePopup({
        answer: async () => stateWith({ videoType: 'video', isLiveNow: false, liveLkfs: null, loudnessDb: -6, contentLufs: -20 })
      });
      await video.ready();
      await video.runTimers();
      assert(video.asked.filter((m) => m.type === 'askLiveLevel').length === 0, 'a video is not asked about');

      // On air before the player names a level, it is asked for all the same.
      const early = makePopup({ answer: async () => stateWith({ liveLkfs: null, contentLufs: null }) });
      await early.ready();
      await early.runTimers();
      assert(early.asked.filter((m) => m.type === 'askLiveLevel').length === 1,
        `a stream on air with no level yet is asked about (${early.asked.filter((m) => m.type === 'askLiveLevel').length})`);
    }

    section('Auto turned on stores the gain it plays with the flag, whenever the change arrives');
    {
      // The harness's storage tells the tab of nothing. Here each channel
      // write's change is told at a point the case picks: never, as the write
      // lands, while the apply after it reads the entry, or once it is over.
      const realGet = chrome.storage.local.get;
      const realSet = chrome.storage.local.set;
      const tell = ([oldValue, newValue]) => simulateStorageChange({ channelVolumes: { oldValue, newValue } });
      const changesTold = (ordering) => {
        let held = [];
        chrome.storage.local.set = function (obj) {
          const before = cloneStorageValue(mockStorage['channelVolumes']);
          const written = realSet.call(this, obj);
          if ('channelVolumes' in obj && ordering !== 'none') {
            const change = [before, cloneStorageValue(mockStorage['channelVolumes'])];
            if (ordering === 'beforeResponse') tell(change);
            else held.push(change);
          }
          return written;
        };
        chrome.storage.local.get = function (key) {
          if (ordering === 'duringApply' && held.length && key === 'channelVolumes') {
            const due = held;
            held = [];
            due.forEach(tell);
          }
          return realGet.call(this, key);
        };
        return {
          async afterApply() {
            if (ordering !== 'afterApply') return;
            const due = held;
            held = [];
            due.forEach(tell);
            await settle();
          },
          stop() { chrome.storage.local.set = realSet; chrome.storage.local.get = realGet; }
        };
      };
      const toggle = async (changes, enabled) => {
        const answer = await popupGesture({ type: 'setAutoApplyLoudness', enabled });
        await settle();
        await changes.afterApply();
        return answer;
      };

      for (const ordering of ['none', 'beforeResponse', 'duringApply', 'afterApply']) {
        // A stream on air, Auto off, 0.5 stored.
        onAir({ autoLive: false, entry: { gainLive: 0.5, autoApplyLoudnessLive: false } });
        liveAnswer(-24.8);
        await settle();
        const liveBefore = ytcv.state.currentGain;
        let changes = changesTold(ordering);
        const liveOn = await toggle(changes, true);
        const liveOnEntry = { ...entryNow() };
        const liveOnGain = ytcv.state.currentGain;
        const liveSavesOn = liveSaves().length;
        // The follow that comes next with the same level stores nothing more.
        const followed = await ytcv.evaluateLiveSave('follow');
        const liveOff = await toggle(changes, false);
        changes.stop();
        assert(liveBefore === 0.5 && liveOn?.ok === true && close(liveOnGain, liveGain(-24.8)),
          `${ordering}, live: turning Auto on plays its gain (${liveBefore} / ${JSON.stringify(liveOn?.ok)} / ${liveOnGain})`);
        assert(close(liveOnEntry.gainLive, liveGain(-24.8)) && !('gainLivePlain' in liveOnEntry)
          && liveOnEntry.autoApplyLoudnessLive === true && liveSavesOn === 1,
          `${ordering}, live: and stores it unmarked with the flag, in one write (${JSON.stringify(liveOnEntry)} / ${liveSavesOn})`);
        assert(followed.decision === 'skip' && followed.saved === false && liveSaves().length === 1,
          `${ordering}, live: the follow after it is a skip, not a second open (${JSON.stringify(followed)})`);
        assert(liveOff?.ok === true && close(ytcv.state.currentGain, liveGain(-24.8))
          && entryNow().autoApplyLoudnessLive === false,
          `${ordering}, live: turning it off again plays what was stored (${ytcv.state.currentGain} / ${JSON.stringify(entryNow())})`);

        // A video whose level is known, Auto off, 0.5 stored.
        onAir({ type: 'video', autoLive: false, autoVideo: false, entry: { gainVideo: 0.5, autoApplyLoudnessVideo: false } });
        simulateBridgeMessage({
          videoId: LIVE_VID, loudnessDb: 4, baseLoudnessDb: 4, isLiveContent: false, isLiveNow: false,
          channelId: LIVE_CH, author: 'Live Follow', source: 'request'
        });
        await settle();
        const videoBefore = ytcv.state.currentGain;
        changes = changesTold(ordering);
        const videoOn = await toggle(changes, true);
        const videoOnEntry = { ...entryNow() };
        const videoOnGain = ytcv.state.currentGain;
        const videoOff = await toggle(changes, false);
        changes.stop();
        assert(videoBefore === 0.5 && videoOn?.ok === true && close(videoOnGain, calcGain(4, -18)),
          `${ordering}, video: turning Auto on plays its gain (${videoBefore} / ${JSON.stringify(videoOn?.ok)} / ${videoOnGain})`);
        assert(close(videoOnEntry.gainVideo, calcGain(4, -18)) && videoOnEntry.gainVideoPlain === true
          && videoOnEntry.autoApplyLoudnessVideo === true,
          `${ordering}, video: and stores it against the plain rendition with the flag (${JSON.stringify(videoOnEntry)})`);
        assert(videoOff?.ok === true && close(ytcv.state.currentGain, calcGain(4, -18))
          && entryNow().autoApplyLoudnessVideo === false,
          `${ordering}, video: turning it off again plays what was stored (${ytcv.state.currentGain} / ${JSON.stringify(entryNow())})`);
      }

      // With no level known the flag is written alone.
      onAir({ autoLive: false, entry: { gainLive: 0.5, autoApplyLoudnessLive: false } });
      liveAnswer(null);
      await settle();
      const flagOnly = await popupGesture({ type: 'setAutoApplyLoudness', enabled: true });
      await settle();
      assert(flagOnly?.ok === true && ytcv.state.currentGain === 0.5 && entryNow().gainLive === 0.5
        && entryNow().autoApplyLoudnessLive === true && liveSaves().length === 0
        && mockSentMessages.some((m) => m?.type === 'store:saveChannelAutoApply'),
        `with no level known only the flag is written and the gain stays (${ytcv.state.currentGain} / ${JSON.stringify(entryNow())})`);

      // A write that fails puts the stored gain back before it answers.
      onAir({ autoLive: false, entry: { gainLive: 0.5, autoApplyLoudnessLive: false } });
      liveAnswer(-24.8);
      await settle();
      chrome.storage.local.set = () => Promise.reject(new Error('storage write failed'));
      const refused = await popupGesture({ type: 'setAutoApplyLoudness', enabled: true });
      await settle();
      chrome.storage.local.set = realSet;
      assert(refused?.ok === false && refused?.reason === 'request failed',
        `a write that fails is answered as failed (${JSON.stringify(refused)})`);
      assert(ytcv.state.currentGain === 0.5 && entryNow().gainLive === 0.5 && entryNow().autoApplyLoudnessLive === false,
        `and the stored gain plays again (${ytcv.state.currentGain} / ${JSON.stringify(entryNow())})`);

      // A flag written alone that fails moves no gain: nothing was played
      // ahead of it.
      onAir({ autoLive: false, entry: { gainLive: 0.5, autoApplyLoudnessLive: false } });
      liveAnswer(null);
      await settle();
      ytcv._set('currentGain', 0.9);
      chrome.storage.local.set = () => Promise.reject(new Error('storage write failed'));
      const flagRefused = await popupGesture({ type: 'setAutoApplyLoudness', enabled: true });
      await settle();
      chrome.storage.local.set = realSet;
      assert(flagRefused?.ok === false && flagRefused?.reason === 'request failed' && ytcv.state.currentGain === 0.9,
        `a flag alone that fails is answered as failed, with the gain where it was (${JSON.stringify(flagRefused)} / ${ytcv.state.currentGain})`);
    }

    // Leave nothing following for the cases after these.
    onAir({ autoLive: false });
    ytcv._set('currentIsLiveNow', false);
    ytcv.syncLiveFollow();
  }

  // ── Gain state transitions ─────────────────────────────────────────
  {
    const TT_CH = 'UCtransit';
    const TT_URL = 'https://www.youtube.com/channel/' + TT_CH;
    const TT_VID = 'transitVid';
    const settle = async () => { for (let turn = 0; turn < 3; turn++) await tick(); };
    // A tab that has applied a video of one channel, with nothing the cases
    // before it left behind.
    const onVideo = async ({ entry = { gainVideo: 0.5, autoApplyLoudnessVideo: false }, loudnessDb = null } = {}) => {
      ytcv.endPreview();
      heldPreviewEnds.length = 0;
      ytcv._set('currentAutoApplyLoudnessVideo', false);
      ytcv._set('currentAutoApplyLoudnessLive', false);
      ytcv._set('currentLiveLkfs', null);
      ytcv._set('currentIsLiveNow', false);
      ytcv.syncLiveFollow();
      mockSyncStorage = { autoLoudnessSettings: { targetLufs: -18 } };
      mockStorage = {
        unifiedGains: true,
        channelVolumes: { [TT_CH]: { name: 'Transit', url: TT_URL, ...entry } }
      };
      mockDOMElements = {};
      mockVideoEl = { id: 'transit-video' };
      setURL('/watch', TT_VID);
      mockPostMessageHandler = null;
      ytcv._set('storageReady', Promise.resolve());
      ytcv._set('storageMigrated', true);
      ytcv._set('storageSettled', true);
      ytcv._set('_lastVideoId', TT_VID);
      ytcv._set('_lastProcessedVideo', mockVideoEl);
      ytcv._set('_applyRunning', false);
      ytcv._set('currentChannel', { id: TT_CH, name: 'Transit', url: TT_URL });
      ytcv._set('currentChannelVideoId', TT_VID);
      ytcv._set('currentLoudnessVideoId', TT_VID);
      ytcv._set('currentLoudnessDb', loudnessDb);
      ytcv._set('currentBaseLoudnessDb', loudnessDb);
      ytcv._set('liveSaveBaseline', null);
      ytcv._set('liveRaiseFrom', null);
      ytcv._set('liveLevelBefore', null);
      ytcv._set('liveLevelRise', null);
      ytcv._set('currentVideoType', 'video');
      ytcv._set('currentVideoTypeDetected', true);
      ytcv._set('defaultAutoApplyLoudnessLive', false);
      ytcv._set('defaultAutoApplyLoudnessVideo', false);
      ytcv._set('targetLufs', -18);
      await ytcv.applyPreferredGain();
      await settle();
      mockSentMessages.length = 0;
    };
    // The console and Node's report of a rejection nobody handled, taken for
    // the trigger alone and given back before anything is asserted.
    const watchFailures = () => {
      const reported = [];
      const unhandled = [];
      const realConsoleError = console.error;
      const onUnhandled = (reason) => { unhandled.push(String(reason?.message || reason)); };
      process.on('unhandledRejection', onUnhandled);
      console.error = (...args) => { reported.push(String(args[0])); };
      return {
        reported, unhandled,
        stop() {
          console.error = realConsoleError;
          process.off('unhandledRejection', onUnhandled);
        }
      };
    };
    const failChannelReads = () => {
      const realGet = chrome.storage.local.get;
      chrome.storage.local.get = (key) => (key === CHANNEL_VOLUMES_KEY
        ? Promise.reject(new Error('channel read failed'))
        : realGet(key));
      return () => { chrome.storage.local.get = realGet; };
    };

    section('Apply failures: an apply that cannot read the channel says so, wherever it was started');
    for (const [what, trigger, count] of [
      ['a bridge message', () => simulateBridgeMessage({ videoId: TT_VID, loudnessDb: -6, isLiveContent: false, channelId: TT_CH }), 1],
      ['a settings change', () => simulateStorageChange({ [SETTINGS_KEY]: { newValue: { targetLufs: -20 } } }), 1],
      ['the fold mark from another context', () => {
        ytcv._set('storageMigrated', false);
        simulateStorageChange({ [UNIFIED_GAINS_KEY]: { newValue: true } });
      }, 1],
      // The bridge message ends the wait of the navigation's retry, and both
      // the message's apply and the retry's read the channel.
      ['the retry after a navigation', async () => {
        await ytcv.applyVideoVolume();
        const restore = failChannelReads();
        simulateBridgeMessage({ videoId: TT_VID, loudnessDb: -6, isLiveContent: false, channelId: TT_CH });
        return restore;
      }, 2]
    ]) {
      await onVideo();
      const watched = watchFailures();
      let restore = what.startsWith('the retry') ? null : failChannelReads();
      restore = (await trigger()) || restore;
      await settle();
      restore();
      watched.stop();
      const named = watched.reported.filter((line) => line.includes('[YTCV] apply failed'));
      assert(watched.unhandled.length === 0 && named.length === count,
        `${what}: a failed read is reported as a failed apply (${JSON.stringify(watched)})`);
    }
    ytcv._set('targetLufs', -18);

    section('Settings page: a setting that could not be saved goes back to the stored one, and says so');
    for (const [what, act, shows] of [
      ['Target LUFS', async (options) => {
        options.node('targetSlider').value = '-24';
        await options.fire('targetSlider', 'input');
        await options.fire('targetSlider', 'change');
      }, (options) => options.node('targetSlider').value === -18 &&
        options.node('targetValue').textContent === '-18 LUFS'],
      ['Gain overlay', async (options) => {
        options.node('overlayToggle').checked = true;
        await options.fire('overlayToggle', 'change');
      }, (options) => options.node('overlayToggle').checked === false],
      ['Display unit', async (options) => {
        await options.clickUnit('dB');
      }, (options) => options.unitButtons.find((b) => b.dataset.unit === '%').classList.contains('active') &&
        !options.unitButtons.find((b) => b.dataset.unit === 'dB').classList.contains('active') &&
        options.listMarkup().includes('50%')]
    ]) {
      const watched = watchFailures();
      const options = makeOptions({
        settings: { targetLufs: -18, displayUnit: '%', showGainOverlay: false },
        channels: { UCsaved: { name: 'Saved', gainVideo: 0.5 } },
        failStorageSet: true
      });
      await options.settle();
      await act(options);
      await options.settle();
      watched.stop();
      assert(shows(options),
        `${what}: the control shows the stored value again`);
      assert(options.node('settingsError').classList.contains('hidden') === false &&
        options.node('settingsError').textContent === 'settingsSaveFailed',
        `${what}: and the page says the setting was not saved (${options.node('settingsError').className} / ${options.node('settingsError').textContent})`);
      assert(watched.unhandled.length === 0,
        `${what}: the failed write is taken, not left unhandled (${JSON.stringify(watched.unhandled)})`);
      assert(options.synced[SETTINGS_KEY].targetLufs === -18 && options.synced[SETTINGS_KEY].displayUnit === '%' &&
        options.synced[SETTINGS_KEY].showGainOverlay === false,
        `${what}: what storage holds is what the page went back to`);
    }
    {
      // A write that lands takes the line down again.
      const options = makeOptions({ settings: { targetLufs: -18 } });
      await options.settle();
      options.node('settingsError').textContent = 'settingsSaveFailed';
      options.node('settingsError').classList.remove('hidden');
      options.node('targetSlider').value = '-20';
      await options.fire('targetSlider', 'change');
      assert(options.synced[SETTINGS_KEY].targetLufs === -20 &&
        options.node('settingsError').classList.contains('hidden') === true,
        'a setting that is saved takes the line down');
    }
    {
      // A write that fails, with the read back failing as well: nothing is put
      // back, and the line asks for a reload instead.
      const options = makeOptions({ settings: { targetLufs: -18 }, failStorageSet: true });
      await options.settle();
      options.failReads();
      options.node('targetSlider').value = '-24';
      await options.fire('targetSlider', 'input');
      await options.fire('targetSlider', 'change');
      assert(options.node('settingsError').classList.contains('hidden') === false &&
        options.node('settingsError').textContent === 'settingsLoadFailed',
        `a failed save that could not be read back asks for a reload (${options.node('settingsError').textContent})`);
    }

    section('Audio chain refused: the gain in hand stays the one playing');
    {
      // Another owner of the element makes createMediaElementSource throw.
      // The tab's context exists by then: the stored 0.5 built a chain.
      let realCreate = null;
      const refuseChain = () => {
        const ctx = ytcv.state.audioCtx;
        realCreate = ctx.createMediaElementSource;
        ctx.createMediaElementSource = () => {
          throw new Error('InvalidStateError: already connected');
        };
        ytcv._set('gainNode', null);
        ytcv._set('sourceNode', null);
        ytcv._set('connectedVideo', null);
        mockVideoEl = { id: 'owned-elsewhere' };
      };
      await onVideo();
      refuseChain();
      const watched = watchFailures();
      const refused = await popupGesture({ type: 'setGain', gain: 2.0 });
      watched.stop();
      ytcv.state.audioCtx.createMediaElementSource = realCreate;
      assert(refused?.ok === false, `the save is refused (${JSON.stringify(refused)})`);
      assert(ytcv.state.currentGain === 0.5 && ytcv.getState().gain === 0.5,
        `the gain the tab reports is the one still playing (${ytcv.state.currentGain} / ${ytcv.getState().gain})`);
      assert(mockStorage.channelVolumes[TT_CH].gainVideo === 0.5, 'and nothing was stored');

      // Auto's own apply of a bridge message, refused the same way.
      await onVideo({ entry: { gainVideo: 0.5, autoApplyLoudnessVideo: true } });
      refuseChain();
      const autoWatched = watchFailures();
      let escaped = null;
      try {
        simulateBridgeMessage({ videoId: TT_VID, loudnessDb: -6, isLiveContent: false, isLiveNow: true, channelId: TT_CH });
      } catch (err) {
        escaped = err;
      }
      await settle();
      autoWatched.stop();
      ytcv.state.audioCtx.createMediaElementSource = realCreate;
      assert(escaped === null, `the message listener takes the throw (${escaped && escaped.message})`);
      assert(autoWatched.reported.some((line) => line.includes('[YTCV] apply failed')),
        `and reports it as a failed apply (${JSON.stringify(autoWatched.reported)})`);
      assert(ytcv.state.currentGain === 0.5, `the gain in hand is the one still playing (${ytcv.state.currentGain})`);
      assert(ytcv.state.liveFollowTimer !== null, 'the rest of the message is handled: the follow is set');
      ytcv._set('currentAutoApplyLoudnessVideo', false);
      ytcv._set('currentIsLiveNow', false);
      ytcv.syncLiveFollow();
    }

    section('Slider preview: a gain from elsewhere waits for the gesture to end');
    {
      await onVideo();
      const told = () => mockSentMessages.filter((m) => m?.type === 'stateChanged').map((m) => m.gain);
      await popupGesture({ type: 'setGainLive', gain: 3.0 });
      assert(ytcv.state.currentGain === 3.0, 'the preview plays');
      // A rendition change re-applies the stored gain, another tab writes this
      // channel, and the target moves, all while the slider is held.
      simulateBridgeMessage({ videoId: TT_VID, loudnessDb: -6, isLiveContent: false, channelId: TT_CH, source: 'audio-change' });
      await settle();
      const otherTab = { name: 'Transit', url: TT_URL, gainVideo: 0.62, autoApplyLoudnessVideo: false };
      simulateStorageChange({ [CHANNEL_VOLUMES_KEY]: {
        oldValue: { [TT_CH]: mockStorage.channelVolumes[TT_CH] }, newValue: { [TT_CH]: otherTab }
      } });
      mockStorage.channelVolumes[TT_CH] = otherTab;
      simulateStorageChange({ [SETTINGS_KEY]: { newValue: { targetLufs: -20 } } });
      await settle();
      assert(ytcv.state.currentGain === 3.0 && ytcv.state.gainNode.gain.value === 3.0,
        `the preview keeps playing over each of them (${ytcv.state.currentGain})`);
      assert(told().every((gain) => gain === 3.0),
        `and the popup is told the gain it is previewing (${JSON.stringify(told())})`);
      const saved = await popupGesture({ type: 'setGain', gain: 3.0 });
      await settle();
      assert(saved?.ok === true && mockStorage.channelVolumes[TT_CH].gainVideo === 3.0 && ytcv.state.currentGain === 3.0,
        `the release saves the gain the slider was moved to (${JSON.stringify(saved)} / ${mockStorage.channelVolumes[TT_CH].gainVideo})`);
      ytcv._set('targetLufs', -18);

      // The player puts another element in place while the slider is held:
      // the chain moves to it at the preview's gain, as it does with no preview.
      await onVideo();
      const unheld = { id: 'replaced-without-preview' };
      mockVideoEl = unheld;
      fireObserver();
      await settle();
      assert(ytcv.state.connectedVideo === unheld,
        `with no preview the chain moves to the element put in place (${ytcv.state.connectedVideo?.id})`);
      await onVideo();
      await popupGesture({ type: 'setGainLive', gain: 3.0 });
      const replaced = { id: 'replaced-during-preview' };
      mockVideoEl = replaced;
      fireObserver();
      await settle();
      assert(ytcv.state.connectedVideo === replaced && ytcv.state.gainNode.gain.value === 3.0
        && ytcv.state.currentGain === 3.0,
        `during a preview it moves there too, at the preview's gain (${ytcv.state.connectedVideo?.id} / ${ytcv.state.gainNode.gain.value})`);
      await popupGesture({ type: 'setGain', gain: 3.0 });
      await settle();

      // A gesture whose input stops without a save: once it has been quiet for
      // PREVIEW_IDLE_MS, what storage holds is applied.
      await onVideo();
      await popupGesture({ type: 'setGainLive', gain: 3.0 });
      simulateBridgeMessage({ videoId: TT_VID, loudnessDb: -6, isLiveContent: false, channelId: TT_CH, source: 'audio-change' });
      await settle();
      assert(ytcv.state.currentGain === 3.0, `the preview holds (${ytcv.state.currentGain})`);
      const ended = await runPreviewEnds();
      await settle();
      assert(ended === 1 && ytcv.state.currentGain === 0.5 && ytcv.state.gainNode.gain.value === 0.5,
        `the quiet gesture ends and the stored gain plays (${ended} / ${ytcv.state.currentGain})`);
      assert(told().at(-1) === 0.5, `and the popup is told so (${JSON.stringify(told())})`);

      // A save refused after a preview puts back what storage holds: here
      // another tab turned Auto on while the level was known.
      await onVideo({ loudnessDb: -6 });
      await popupGesture({ type: 'setGainLive', gain: 3.0 });
      const autoOn = { name: 'Transit', url: TT_URL, gainVideo: 0.5, autoApplyLoudnessVideo: true };
      simulateStorageChange({ [CHANNEL_VOLUMES_KEY]: {
        oldValue: { [TT_CH]: mockStorage.channelVolumes[TT_CH] }, newValue: { [TT_CH]: autoOn }
      } });
      mockStorage.channelVolumes[TT_CH] = autoOn;
      await settle();
      assert(ytcv.state.currentGain === 3.0, `the preview holds over the Auto gain (${ytcv.state.currentGain})`);
      const refused = await popupGesture({ type: 'setGain', gain: 3.0 });
      await settle();
      const autoGain = calcGain(-6, -18);
      assert(refused?.ok === false && ytcv.state.currentGain === autoGain && told().at(-1) === autoGain,
        `the refused save plays and tells what storage now says (${JSON.stringify(refused)} / ${ytcv.state.currentGain})`);
      assert(heldPreviewEnds.length === 0, 'and nothing is left waiting to end it again');

      // A save refused with nothing previewed is answered at once, and nothing
      // is applied or stored again.
      await onVideo({ entry: { gainVideo: 0.5, autoApplyLoudnessVideo: true }, loudnessDb: -6 });
      const lockedNow = await popupGesture({ type: 'setGain', gain: 3.0 });
      await settle();
      assert(lockedNow?.ok === false && lockedNow?.reason === 'auto apply controls current gain' &&
        mockSentMessages.filter((m) => m?.type === 'store:saveChannelGain').length === 0,
        `a locked save with nothing previewed stores nothing (${JSON.stringify(mockSentMessages.filter((m) => m?.type?.startsWith('store:')))})`);

      // A live level the bridge names while a preview holds works out no live
      // gain. Another tab's write during it works one out, held back as any
      // gain from elsewhere, so the raise count goes on from the gain the
      // preview plays: once the gesture ends, the live gain rises from there
      // by no more than the raise limit.
      const liveEntry = { name: 'Transit', url: TT_URL, gainLive: 0.5, autoApplyLoudnessLive: true };
      await onVideo({ entry: liveEntry });
      ytcv._set('liveRaiseFrom', null);
      ytcv._set('liveLevelBefore', null);
      ytcv._set('liveLevelRise', null);
      simulateBridgeMessage({ videoId: TT_VID, isLiveContent: true, isLiveNow: true, channelId: TT_CH });
      await settle();
      assert(ytcv.state.currentVideoType === 'live' && ytcv.state.currentGain === 0.5,
        `the stream plays its stored gain before a level is named (${ytcv.state.currentGain})`);
      await popupGesture({ type: 'setGainLive', gain: 3.0 });
      simulateBridgeMessage({ videoId: TT_VID, liveLkfs: -30, isLiveContent: true, isLiveNow: true, channelId: TT_CH });
      await settle();
      assert(ytcv.state.currentGain === 3.0 && ytcv.state.liveRaiseFrom === null,
        `the live level the bridge names is held back and no live gain is worked out (${ytcv.state.currentGain} / ${JSON.stringify(ytcv.state.liveRaiseFrom)})`);
      simulateStorageChange({ [CHANNEL_VOLUMES_KEY]: {
        oldValue: { [TT_CH]: liveEntry }, newValue: { [TT_CH]: { ...liveEntry, name: 'Transit Live' } }
      } });
      await settle();
      const raisedFrom = ytcv.state.liveRaiseFrom;
      assert(ytcv.state.currentGain === 3.0 && raisedFrom?.videoId === TT_VID && Number.isFinite(raisedFrom?.at),
        `another tab's write works a live gain out, and the preview still plays (${ytcv.state.currentGain} / ${JSON.stringify(raisedFrom)})`);
      const lockedSave = await popupGesture({ type: 'setGain', gain: 3.0 });
      await settle();
      const levelGain = calcLiveGain(-30, -18);
      const raiseLimit = 3.0 * Math.pow(10, 1.5 * (Date.now() - raisedFrom?.at) / 30000 / 20);
      assert(lockedSave?.ok === false && ytcv.state.currentGain >= 3.0 &&
        ytcv.state.currentGain <= raiseLimit && ytcv.state.currentGain < levelGain,
        `the gesture's end raises the live gain from the preview's by no more than the raise limit (${JSON.stringify(lockedSave)} / ${ytcv.state.currentGain} of ${levelGain})`);

      // A preview whose state has moved holds nothing back.
      await onVideo();
      await popupGesture({ type: 'setGainLive', gain: 3.0 });
      simulateBridgeMessage({ videoId: TT_VID, loudnessDb: -6, isLiveContent: true, channelId: TT_CH });
      await settle();
      assert(ytcv.state.currentVideoType === 'live' && ytcv.state.currentGain === 1.0,
        `the live type's gain plays at once (${ytcv.state.currentGain})`);
      ytcv.endPreview();
    }

    section('Slider preview: a slider still held is sent again, and the tab waits for it');
    {
      // The popup: while the pointer stays down after a preview, the preview
      // goes again once a second; let go of, it stops.
      const popup = makePopup({
        answer: async (message) => (message.type === 'setGainLive' || message.type === 'setGain'
          ? { ok: true }
          : {
            isWatchPage: true,
            channel: { id: TT_CH, name: 'Transit', url: TT_URL },
            appliesTo: TT_CH + '|video|' + TT_VID,
            loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
            targetLufs: -18, videoType: 'video'
          })
      });
      await popup.ready();
      popup.asked.length = 0;
      const previews = () => popup.asked.filter((m) => m.type === 'setGainLive');
      popup.node('volumeSlider').value = '300';
      await popup.fire('volumeSlider', 'pointerdown');
      await popup.fire('volumeSlider', 'input');
      await popup.runTimers();
      await popup.runTimers();
      assert(previews().length === 3 && previews().every((m) => m.gain === 3.0 && m.appliesTo === TT_CH + '|video|' + TT_VID),
        `the held preview is sent again each second (${JSON.stringify(previews())})`);
      await popup.fire('volumeSlider', 'pointerup');
      await popup.runTimers();
      await popup.runTimers();
      assert(previews().length === 3, `and no longer once the pointer is let go of (${previews().length})`);
      popup.asked.length = 0;
      popup.node('volumeSlider').value = '200';
      await popup.fire('volumeSlider', 'pointerdown');
      await popup.fire('volumeSlider', 'input');
      await popup.fire('volumeSlider', 'change');
      await popup.runTimers();
      assert(previews().length === 1, `nor after the preview is saved (${previews().length})`);
      // Inputs one after another while held set one wait: the preview goes
      // again once a second, not once for each input.
      await popup.fire('volumeSlider', 'pointerup');
      await popup.runTimers();
      popup.asked.length = 0;
      popup.node('volumeSlider').value = '250';
      await popup.fire('volumeSlider', 'pointerdown');
      await popup.fire('volumeSlider', 'input');
      await popup.fire('volumeSlider', 'input');
      await popup.fire('volumeSlider', 'input');
      await popup.runTimers();
      assert(previews().length === 4, `three inputs held a second send the preview again once (${previews().length})`);
      await popup.fire('volumeSlider', 'pointerup');
      await popup.runTimers();

      // The tab: each preview starts the wait again, and once they stop the
      // gesture ends 2 s after the last one with the stored gain.
      await onVideo();
      await popupGesture({ type: 'setGainLive', gain: 3.0 });
      await popupGesture({ type: 'setGainLive', gain: 3.0 });
      assert(heldPreviewEnds.length === 1 && ytcv.state.currentGain === 3.0,
        `a preview sent again restarts the one wait (${heldPreviewEnds.length})`);
      const ended = await runPreviewEnds();
      await settle();
      assert(ended === 1 && ytcv.state.currentGain === 0.5,
        `a gesture whose previews stopped ends with the stored gain, nothing else having come (${ytcv.state.currentGain})`);
    }

    section('Settings change: Auto\'s save dropped by a notification during its read is made again');
    {
      await onVideo({ entry: { gainVideo: 0.7, gainVideoPlain: true, autoApplyLoudnessVideo: true }, loudnessDb: -6 });
      const realGet = chrome.storage.local.get;
      let releaseRead = null;
      chrome.storage.local.get = (key) => {
        if (key !== CHANNEL_VOLUMES_KEY || releaseRead) return realGet(key);
        return new Promise((resolve) => { releaseRead = () => resolve(realGet(key)); });
      };
      mockSyncStorage.autoLoudnessSettings = { targetLufs: -22 };
      simulateStorageChange({ [SETTINGS_KEY]: { oldValue: { targetLufs: -18 }, newValue: { targetLufs: -22 } } });
      await tick();
      // Another tab's save on another channel lands while this tab reads.
      simulateStorageChange({ [CHANNEL_VOLUMES_KEY]: {
        oldValue: mockStorage.channelVolumes,
        newValue: { ...mockStorage.channelVolumes, UCelsewhere: { name: 'Elsewhere', gainVideo: 0.3 } }
      } });
      releaseRead();
      await settle();
      chrome.storage.local.get = realGet;
      const target = calcGain(-6, -22);
      const stored = mockSentMessages.filter((m) => m?.type === 'store:saveChannelGain' && m.channelId === TT_CH);
      assert(stored.length === 1 && stored[0].gain === target && mockStorage.channelVolumes[TT_CH].gainVideo === target,
        `the new target's gain is stored for the channel (${JSON.stringify(stored.map((m) => m.gain))} / ${mockStorage.channelVolumes[TT_CH].gainVideo})`);
      assert(ytcv.state.currentGain === target, `and it is the one playing (${ytcv.state.currentGain})`);
      ytcv._set('targetLufs', -18);
    }

    section('Auto\'s own save: made by a tab that is playing the video');
    for (const [what, element, stores] of [
      ['paused', { paused: true, muted: false, volume: 1 }, false],
      ['muted', { paused: false, muted: true, volume: 1 }, false],
      ['at a volume of 0', { paused: false, muted: false, volume: 0 }, true],
      ['playing', { paused: false, muted: false, volume: 1 }, true]
    ]) {
      await onVideo({ entry: { gainVideo: 0.5, autoApplyLoudnessVideo: true }, loudnessDb: -6 });
      Object.assign(mockVideoEl, element);
      // A new level for the video, and a new target: both store Auto's gain.
      simulateBridgeMessage({ videoId: TT_VID, loudnessDb: -9, baseLoudnessDb: -9, isLiveContent: false, channelId: TT_CH });
      await settle();
      simulateStorageChange({ [SETTINGS_KEY]: { newValue: { targetLufs: -20 } } });
      await settle();
      const auto = mockSentMessages.filter((m) => m?.type === 'store:saveChannelGain' && m.channelId === TT_CH);
      assert((auto.length > 0) === stores,
        `a tab ${what} ${stores ? 'stores' : 'stores nothing'} (${JSON.stringify(auto.map((m) => m.gain))})`);
      assert(ytcv.state.currentGain === calcGain(-9, -20), `and it plays Auto's gain either way (${ytcv.state.currentGain})`);
      ytcv._set('targetLufs', -18);
    }
    {
      // The live save.
      await onVideo({ entry: { gainVideo: 0.5, autoApplyLoudnessVideo: true } });
      Object.assign(mockVideoEl, { paused: true });
      simulateBridgeMessage({ videoId: TT_VID, isLiveContent: false, liveLkfs: -20, channelId: TT_CH });
      await settle();
      const decided = await ytcv.evaluateLiveSave('apply');
      assert(decided.reason === 'not playing' && decided.saved === false &&
        mockSentMessages.filter((m) => m?.type === 'store:saveChannelGain').length === 0,
        `a paused tab makes no live save (${JSON.stringify(decided)})`);
      Object.assign(mockVideoEl, { paused: false });
      const resumed = await ytcv.evaluateLiveSave('apply');
      assert(resumed.saved === true && resumed.ok === true, `and makes it once it plays (${JSON.stringify(resumed)})`);
      ytcv._set('currentLiveLkfs', null);
      ytcv._set('currentAutoApplyLoudnessVideo', false);
      ytcv.syncLiveFollow();
    }

    section('Auto\'s own save: a tab that starts playing makes it then');
    {
      const firePlay = async (target) => {
        for (const fn of mockEventListeners['play'] || []) fn({ target });
        await settle();
      };
      for (const [what, element, stores] of [
        ['playing', { paused: false, muted: false }, true],
        ['muted', { paused: false, muted: true }, false]
      ]) {
        await onVideo({ entry: { gainVideo: 0.5, autoApplyLoudnessVideo: true }, loudnessDb: -6 });
        Object.assign(mockVideoEl, { paused: true, muted: false });
        simulateBridgeMessage({ videoId: TT_VID, loudnessDb: -9, baseLoudnessDb: -9, isLiveContent: false, channelId: TT_CH });
        await settle();
        const auto = () => mockSentMessages.filter((m) => m?.type === 'store:saveChannelGain' && m.channelId === TT_CH);
        assert(auto().length === 0, `nothing is stored while the video is paused (${JSON.stringify(auto())})`);
        Object.assign(mockVideoEl, element);
        await firePlay(mockVideoEl);
        assert((auto().length === 1 && auto()[0].gain === calcGain(-9, -18)) === stores,
          `the play of a tab ${what} ${stores ? 'stores Auto\'s gain' : 'stores nothing'} (${JSON.stringify(auto().map((m) => m.gain))})`);
      }
      // A play of another element is not this video starting.
      await onVideo({ entry: { gainVideo: 0.5, autoApplyLoudnessVideo: true }, loudnessDb: -6 });
      mockSentMessages.length = 0;
      await firePlay({ id: 'an-ad-preview' });
      assert(mockSentMessages.filter((m) => m?.type === 'store:saveChannelGain').length === 0,
        'a play of another element applies nothing');
    }

    section('Navigation: nothing a message brings is stored before the first apply for the new URL');
    {
      await onVideo({ entry: { gainVideo: 0.5, autoApplyLoudnessVideo: true } });
      mockSyncStorage.autoLoudnessSettings.autoApplyLoudnessVideoDefault = true;
      ytcv._set('defaultAutoApplyLoudnessVideo', true);
      const stores = () => mockSentMessages.filter((m) => m?.type === 'store:saveChannelGain');
      // The URL has moved on and no apply has run for it: the tab still holds
      // the channel it left.
      setURL('/watch', 'nextVid');
      mockVideoEl = { id: 'transit-video-next' };
      // The answer before a response names the video, carrying a live level,
      // and then one carrying a level for the video.
      simulateBridgeMessage({ videoId: 'nextVid', loudnessDb: null, baseLoudnessDb: null, isLiveContent: false,
        isLiveNow: false, channelId: '', author: '', liveLkfs: -19.6, source: 'playing' });
      await settle();
      simulateBridgeMessage({ videoId: 'nextVid', loudnessDb: -6, isLiveContent: false, channelId: '', source: 'request' });
      await settle();
      assert(stores().length === 0,
        `nothing is stored into the channel the tab left (${JSON.stringify(stores())})`);
      assert(mockStorage.channelVolumes[TT_CH].gainVideo === 0.5, 'which keeps its own gain');
      // The stop is for what a message brings: a settings change in the same
      // window stores as it does at any other time.
      mockSyncStorage.autoLoudnessSettings = { targetLufs: -20, autoApplyLoudnessVideoDefault: true };
      simulateStorageChange({ [SETTINGS_KEY]: { newValue: { ...mockSyncStorage.autoLoudnessSettings } } });
      await settle();
      assert(stores().length === 1,
        `a settings change before the first apply still makes Auto's save (${JSON.stringify(stores())})`);
      mockSentMessages.length = 0;
      mockSyncStorage.autoLoudnessSettings = { targetLufs: -18, autoApplyLoudnessVideoDefault: true };
      simulateStorageChange({ [SETTINGS_KEY]: { newValue: { ...mockSyncStorage.autoLoudnessSettings } } });
      await settle();
      mockSentMessages.length = 0;

      // Once the first apply has run, what a message brings is stored again.
      await ytcv.applyVideoVolume();
      simulateBridgeMessage({ videoId: 'nextVid', loudnessDb: -6, isLiveContent: false, channelId: 'UCnext', author: 'Next' });
      await settle();
      assert(stores().length > 0 && stores().every((m) => m.channelId === 'UCnext'),
        `after the first apply the new channel's Auto gain is stored (${JSON.stringify(stores().map((m) => m.channelId))})`);
      ytcv._set('defaultAutoApplyLoudnessVideo', false);
      ytcv._set('currentLiveLkfs', null);
      ytcv._set('currentAutoApplyLoudnessVideo', false);
      ytcv.syncLiveFollow();
    }
    {
      // The answer the bridge gives before any response names the video does
      // not say what kind of video it is.
      const bridge = createBridge();
      await bridge.request();
      assert(bridge.last()?.isLiveContent === null,
        `the answer with no response says nothing about the type (${JSON.stringify(bridge.last()?.isLiveContent)})`);
      await onVideo();
      ytcv._set('currentVideoType', 'live');
      simulateBridgeMessage({ ...bridge.last(), videoId: TT_VID });
      await settle();
      assert(ytcv.state.currentVideoType === 'live', 'and the tab keeps the type it knows');
      const answered = createBridge();
      answered.assign(playerResponse({ loudnessDb: -6.5 }));
      await answered.request();
      assert(answered.last()?.isLiveContent === false, 'a response that names the video still does');
    }

    section('Bridge: a player response that names no video is not an answer');
    {
      const bridge = createBridge();
      // A live stream's ad break comes back from /youtubei/v1/player/ad_break
      // with no videoDetails.
      const adBreak = { adBreakHeartbeatParams: 'x', playerAds: [] };
      await bridge.fetchPlayer(adBreak, 'https://www.youtube.com/youtubei/v1/player/ad_break?prettyPrint=false');
      assert(bridge.posted.length === 0, `an ad break's response is not passed on (${JSON.stringify(bridge.posted)})`);
      await bridge.fetchPlayer({ videoDetails: {} });
      assert(bridge.posted.length === 0, 'nor one whose videoDetails name no video');
      await bridge.fetchPlayer(playerResponse({ loudnessDb: -3.25, isLiveContent: true }));
      assert(bridge.posted.length === 1 && bridge.last()?.isLiveContent === true,
        `while the player response for the URL's video is (${JSON.stringify(bridge.last())})`);
    }

    section('Popup gestures: refused until the channel is named for the URL\'s video');
    {
      await onVideo({ entry: { gainVideo: 0.5, autoApplyLoudnessVideo: false } });
      // The URL has moved on to a video of another channel, and something
      // redraws the popup before the tab has named that video's channel.
      setURL('/watch', 'otherChannelVid');
      ytcv.notifyPopup();
      const drawn = await simulateRuntimeMessage({ type: 'getState' });
      for (const gesture of [
        { type: 'setGainLive', gain: 0 },
        { type: 'setGain', gain: 0 },
        { type: 'setAutoApplyLoudness', enabled: true }
      ]) {
        const answer = await simulateRuntimeMessage({ appliesTo: drawn.appliesTo, ...gesture });
        await settle();
        assert(answer?.ok === false && answer?.reason === 'state moved',
          `${gesture.type} against the channel the tab left is refused (${JSON.stringify(answer)})`);
      }
      assert(mockSentMessages.filter((m) => m?.type?.startsWith('store:save')).length === 0 &&
        mockStorage.channelVolumes[TT_CH].gainVideo === 0.5,
        `and nothing is written into it (${JSON.stringify(mockStorage.channelVolumes[TT_CH])})`);
      // Once the bridge names the video's channel, a gesture is taken.
      simulateBridgeMessage({ videoId: 'otherChannelVid', loudnessDb: -6, isLiveContent: false, channelId: 'UCotherCh', author: 'Other' });
      await settle();
      const taken = await popupGesture({ type: 'setGain', gain: 0.8 });
      await settle();
      assert(taken?.ok === true && mockStorage.channelVolumes.UCotherCh?.gainVideo !== undefined,
        `a gesture after it saves under the channel named (${JSON.stringify(taken)})`);
    }

    section('Navigation: the page\'s channel is not taken after a navigation');
    {
      await onVideo();
      // The page still names the channel of the video left.
      mockDOMElements['canonical'] = { href: TT_URL };
      setURL('/watch', 'staleDomVid');
      await ytcv.applyVideoVolume();
      assert(ytcv.state.currentChannel.id === '' && ytcv.getState().channel.id === '',
        `the channel of the video left is not taken from the page (${ytcv.state.currentChannel.id})`);
      // Nor when the same video is applied again for a new element.
      mockVideoEl = { id: 'transit-video-swapped' };
      await ytcv.applyVideoVolume();
      assert(ytcv.state.currentChannel.id === '', `nor on a second apply of that video (${ytcv.state.currentChannel.id})`);
      // The bridge names the video's channel.
      simulateBridgeMessage({ videoId: 'staleDomVid', isLiveContent: false, channelId: 'UCstaleDomNew', author: 'New' });
      await settle();
      assert(ytcv.state.currentChannel.id === 'UCstaleDomNew', `the bridge names it (${ytcv.state.currentChannel.id})`);
      mockDOMElements = {};
    }

    section('Start cap: the first live gain once a navigation names the channel is held by it');
    {
      // Stream B stores 0.5 for live and follows Auto there. Its level of
      // -19.6 asks for more than 3 dB over 0.5, so the cap holds the first
      // gain to 0.5 at 3 dB over.
      const B_CH = 'UCstreamB';
      const B_VID = 'streamBVid';
      const B_ENTRY = { name: 'Stream B', url: 'https://www.youtube.com/channel/' + B_CH, gainLive: 0.5, autoApplyLoudnessLive: true };
      const capped = 0.5 * Math.pow(10, 3 / 20);
      const close = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
      const toStreamB = () => {
        setURL('/watch', B_VID);
        mockVideoEl = { id: 'stream-b-video' };
      };
      // What the bridge answers before a player response names the video: no
      // type, no channel, and the live level where the player already names it.
      const unnamedAnswer = (liveLkfs) => simulateBridgeMessage({ videoId: B_VID, loudnessDb: null, baseLoudnessDb: null,
        isLiveContent: null, isLiveNow: false, channelId: '', author: '', liveLkfs, source: 'playing' });
      const streamBAnswer = (liveLkfs) => simulateBridgeMessage({ videoId: B_VID, loudnessDb: null, baseLoudnessDb: null,
        isLiveContent: true, isLiveNow: true, channelId: B_CH, author: 'Stream B', liveLkfs, source: 'request' });
      const raiseFrom = () => JSON.stringify(ytcv.state.liveRaiseFrom);
      // The first live gain once the channel is named is the cap's; the apply
      // the navigation runs after the bridge answers can raise it from there by
      // no more than the raise limit for the time since.
      let since = 0;
      const heldByCap = () => ytcv.state.currentGain >= capped - 1e-9 &&
        ytcv.state.currentGain <= capped * Math.pow(10, 1.5 * (Date.now() - since) / 30000 / 20) + 1e-9;

      // A live level that reaches the tab after the URL moved and before the
      // channel is named for it, while the channel left follows Auto for the
      // type in hand (videos here).
      await onVideo({ entry: { gainVideo: 0.5, autoApplyLoudnessVideo: true } });
      mockStorage.channelVolumes[B_CH] = { ...B_ENTRY };
      toStreamB();
      unnamedAnswer(-19.6);
      await settle();
      assert(ytcv.state.liveRaiseFrom === null,
        `a live gain played before the channel is named starts no raise count (${raiseFrom()})`);
      since = Date.now();
      await ytcv.applyVideoVolume();
      streamBAnswer(-19.6);
      await settle();
      assert(ytcv.state.currentChannel.id === B_CH && heldByCap(),
        `the first live gain once B is named is held by B's start cap (${ytcv.state.currentGain} / ${capped})`);

      // From one stream to another: the unknown type keeps the stream left's
      // live type, and its channel stores 3.0, a cap that holds nothing.
      await onVideo({ entry: { gainLive: 3.0, autoApplyLoudnessLive: true } });
      mockStorage.channelVolumes[B_CH] = { ...B_ENTRY };
      simulateBridgeMessage({ videoId: TT_VID, loudnessDb: null, baseLoudnessDb: null, isLiveContent: true,
        isLiveNow: true, channelId: TT_CH, author: 'Transit', liveLkfs: -19.6, source: 'request' });
      await settle();
      assert(ytcv.state.currentVideoType === 'live' && ytcv.state.liveRaiseFrom?.videoId === TT_VID,
        `the stream left plays its live level (${ytcv.state.currentVideoType} / ${raiseFrom()})`);
      toStreamB();
      unnamedAnswer(-19.6);
      await settle();
      assert(ytcv.state.currentVideoType === 'live' && ytcv.state.liveRaiseFrom?.videoId !== B_VID,
        `the level before B is named starts no count for B's stream (${ytcv.state.currentVideoType} / ${raiseFrom()})`);
      since = Date.now();
      await ytcv.applyVideoVolume();
      streamBAnswer(-19.6);
      await settle();
      assert(heldByCap(),
        `B's first live gain is held by B's start cap (${ytcv.state.currentGain} / ${capped})`);

      // A stream visited before in the page, after another channel's video in
      // between: the count from that visit is gone with the channel.
      await onVideo();
      mockStorage.channelVolumes[B_CH] = { ...B_ENTRY };
      toStreamB();
      await ytcv.applyVideoVolume();
      streamBAnswer(-19.6);
      await settle();
      streamBAnswer(null);
      await settle();
      assert(ytcv.state.liveRaiseFrom?.videoId === B_VID,
        `the first visit counts from B's stream (${raiseFrom()})`);
      setURL('/watch', TT_VID);
      mockVideoEl = { id: 'transit-video-again' };
      await ytcv.applyVideoVolume();
      simulateBridgeMessage({ videoId: TT_VID, loudnessDb: -6, isLiveContent: false, channelId: TT_CH, author: 'Transit' });
      await settle();
      assert(ytcv.state.currentChannel.id === TT_CH && ytcv.state.liveRaiseFrom === null,
        `another channel named drops the count (${raiseFrom()})`);
      toStreamB();
      since = Date.now();
      await ytcv.applyVideoVolume();
      streamBAnswer(-19.6);
      await settle();
      assert(heldByCap(),
        `back on B's stream, its first live gain is held by the start cap again (${ytcv.state.currentGain} / ${capped})`);

      // From a channel's video to its own stream, the bridge naming the same
      // channel for the stream before the navigation's apply: the level before
      // that, played as a video, starts no count either.
      const SAME_STREAM = 'transitStreamVid';
      await onVideo({ entry: { gainVideo: 0.5, autoApplyLoudnessVideo: true, gainLive: 0.5, autoApplyLoudnessLive: true } });
      setURL('/watch', SAME_STREAM);
      mockVideoEl = { id: 'transit-stream-video' };
      simulateBridgeMessage({ videoId: SAME_STREAM, loudnessDb: null, baseLoudnessDb: null, isLiveContent: null,
        isLiveNow: false, channelId: '', author: '', liveLkfs: -19.6, source: 'playing' });
      await settle();
      simulateBridgeMessage({ videoId: SAME_STREAM, loudnessDb: null, baseLoudnessDb: null, isLiveContent: true,
        isLiveNow: true, channelId: TT_CH, author: 'Transit', liveLkfs: -19.6, source: 'request' });
      await settle();
      assert(ytcv.state.currentVideoType === 'live' && close(ytcv.state.currentGain, capped),
        `the stream's first live gain once named is held by the start cap (${ytcv.state.currentGain} / ${capped})`);
      ytcv._set('currentLiveLkfs', null);
      ytcv._set('currentAutoApplyLoudnessLive', false);
      ytcv._set('currentIsLiveNow', false);
      ytcv.syncLiveFollow();
    }

    section('Extension reload: a failed save it causes is not reported');
    {
      await onVideo();
      const watched = watchFailures();
      const realId = chrome.runtime.id;
      const realSet = chrome.storage.local.set;
      chrome.storage.local.set = () => {
        // The reload is what makes the write fail, so it is gone by the rejection.
        chrome.runtime.id = undefined;
        return Promise.reject(new Error('storage write failed'));
      };
      const answer = await popupGesture({ type: 'setGain', gain: 0.8 });
      await settle();
      chrome.storage.local.set = realSet;
      chrome.runtime.id = realId;
      watched.stop();
      assert(answer?.ok === false && !watched.reported.some((m) => m.includes('setGain failed')),
        `a save the reload failed is answered and not reported (${JSON.stringify(answer)} / ${JSON.stringify(watched.reported)})`);
    }

    section('Live level: a message that names no video is the URL\'s video\'s');
    {
      await onVideo({ entry: { autoApplyLoudnessLive: true } });
      const liveAnswer = (over) => simulateBridgeMessage({ loudnessDb: null, baseLoudnessDb: null,
        isLiveContent: true, isLiveNow: true, channelId: TT_CH, author: 'Transit', source: 'request', ...over });
      liveAnswer({ videoId: TT_VID, liveLkfs: -20 });
      await settle();
      liveAnswer({ liveLkfs: -18 });
      await settle();
      assert(ytcv.state.liveLevelRise === 2 && Math.abs(ytcv.state.currentGain - calcLiveGain(-15, -18)) < 1e-9,
        `the level it names rose over the one the URL's video named, and is taken 3 dB louder (${ytcv.state.liveLevelRise} / ${ytcv.state.currentGain})`);
      ytcv._set('currentLiveLkfs', null);
      ytcv._set('currentAutoApplyLoudnessLive', false);
      ytcv._set('currentIsLiveNow', false);
      ytcv.syncLiveFollow();
    }

    section('Storage: a change in an area other than sync and local is not this extension\'s');
    {
      await onVideo();
      const elsewhere = { [CHANNEL_VOLUMES_KEY]: {
        oldValue: {}, newValue: { [TT_CH]: { name: 'Transit', url: TT_URL, gainVideo: 2.0 } }
      } };
      for (const fn of chrome.storage.onChanged._listeners) fn(elsewhere, 'session');
      await settle();
      assert(ytcv.state.currentGain === 0.5, `a channel map in another area moves nothing (${ytcv.state.currentGain})`);
    }

    section('Fold: a local change that is not the mark leaves a failed fold on the old rule');
    {
      await onVideo();
      ytcv._set('storageMigrated', false);
      const entry = mockStorage.channelVolumes[TT_CH];
      simulateStorageChange({ [CHANNEL_VOLUMES_KEY]: { oldValue: { [TT_CH]: entry }, newValue: { [TT_CH]: { ...entry } } } });
      await settle();
      assert(ytcv.state.storageMigrated === false, 'a change of the channels is not the mark');
      ytcv._set('storageMigrated', true);
    }

    section('Settings page: the unit already in use writes nothing');
    {
      const options = makeOptions({ settings: { displayUnit: 'dB' }, channels: { UCsaved: { name: 'Saved', gainVideo: 2 } } });
      await options.settle();
      options.sent.length = 0;
      await options.clickUnit('dB');
      assert(options.sent.filter((m) => m.type === 'store:saveSetting').length === 0,
        `clicking the active unit writes nothing (${JSON.stringify(options.sent)})`);
      assert(options.unitButtons.find((b) => b.dataset.unit === 'dB').classList.contains('active') &&
        options.listMarkup().includes('6.0 dB'), 'and the page stays as it was');
      await options.clickUnit('%');
      assert(options.sent.filter((m) => m.type === 'store:saveSetting' && m.value === '%').length === 1,
        'while the other unit is written');
    }

    section('Popup: a key held on the slider previews each repeat and saves once');
    {
      const popup = makePopup({
        answer: async (message) => (message.type === 'setGainLive' || message.type === 'setGain'
          ? { ok: true }
          : {
            isWatchPage: true,
            channel: { id: TT_CH, name: 'Transit', url: TT_URL },
            appliesTo: TT_CH + '|video|' + TT_VID,
            loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
            targetLufs: -18, videoType: 'video'
          })
      });
      await popup.ready();
      const press = async (values) => {
        // A held key: one keydown, then for each repeat an input and a change.
        await popup.fire('volumeSlider', 'keydown', { key: 'ArrowRight' });
        for (const value of values) {
          popup.node('volumeSlider').value = String(value);
          await popup.fire('volumeSlider', 'input');
          await popup.fire('volumeSlider', 'change');
        }
      };
      popup.asked.length = 0;
      await press([105, 110, 115, 120, 125, 130, 135, 140, 145, 150]);
      assert(popup.asked.filter((m) => m.type === 'setGain').length === 0,
        `nothing is saved while the key is held (${JSON.stringify(popup.asked.filter((m) => m.type === 'setGain'))})`);
      await popup.fire('volumeSlider', 'keyup', { key: 'ArrowRight' });
      const previews = popup.asked.filter((m) => m.type === 'setGainLive');
      const saves = popup.asked.filter((m) => m.type === 'setGain');
      assert(previews.length === 10 && saves.length === 1 && saves[0].gain === 1.5,
        `each repeat previews and the release saves the gain reached, once (${previews.length} / ${JSON.stringify(saves)})`);

      // A single press is one gesture of one repeat.
      popup.asked.length = 0;
      await press([155]);
      await popup.fire('volumeSlider', 'keyup', { key: 'ArrowRight' });
      assert(popup.asked.filter((m) => m.type === 'setGain' && m.gain === 1.55).length === 1,
        `a single press saves once (${JSON.stringify(popup.asked)})`);

      // A key held at a value the repeats no longer move keeps its preview
      // alive the way a held pointer does, until the key is let go.
      popup.asked.length = 0;
      await press([160]);
      await popup.runTimers();
      await popup.runTimers();
      assert(popup.asked.filter((m) => m.type === 'setGainLive' && m.gain === 1.6).length === 3,
        `the held key's preview is sent again each second (${JSON.stringify(popup.asked)})`);
      await popup.fire('volumeSlider', 'keyup', { key: 'ArrowRight' });
      await popup.runTimers();
      assert(popup.asked.filter((m) => m.type === 'setGainLive').length === 3 &&
        popup.asked.filter((m) => m.type === 'setGain' && m.gain === 1.6).length === 1,
        `and the keyup saves it and ends the sending (${JSON.stringify(popup.asked)})`);

      // A press that does not move the value saves nothing.
      popup.asked.length = 0;
      await popup.fire('volumeSlider', 'keydown', { key: 'ArrowRight' });
      await popup.fire('volumeSlider', 'keyup', { key: 'ArrowRight' });
      assert(popup.asked.length === 0, `a press at an end sends nothing (${JSON.stringify(popup.asked)})`);

      // The popup losing focus while the key is held ends the gesture there.
      popup.asked.length = 0;
      await press([160, 165]);
      await popup.blurWindow();
      popup.node('volumeSlider').value = '170';
      await popup.fire('volumeSlider', 'input');
      await popup.fire('volumeSlider', 'change');
      await popup.fire('volumeSlider', 'keyup', { key: 'ArrowRight' });
      const atBlur = popup.asked.filter((m) => m.type === 'setGain');
      assert(atBlur.length === 1 && atBlur[0].gain === 1.65 &&
        popup.asked.filter((m) => m.type === 'setGainLive').length === 2,
        `the gain reached at the blur is saved, and nothing after it is sent (${JSON.stringify(popup.asked)})`);

      // The mouse after a key: a drag saves at its release as before.
      popup.asked.length = 0;
      popup.node('volumeSlider').value = '200';
      await popup.fire('volumeSlider', 'pointerdown');
      await popup.fire('volumeSlider', 'input');
      await popup.fire('volumeSlider', 'change');
      await popup.fire('volumeSlider', 'pointerup');
      assert(popup.asked.filter((m) => m.type === 'setGain' && m.gain === 2.0).length === 1,
        `a drag after it saves at its release (${JSON.stringify(popup.asked)})`);
    }

    section('Settings page: a key held on Target LUFS writes once');
    {
      const options = makeOptions({ settings: { targetLufs: -18 } });
      await options.settle();
      const writes = () => options.sent.filter((m) => m.type === 'store:saveSetting');
      const hold = async (values) => {
        await options.fire('targetSlider', 'keydown', { key: 'ArrowRight' });
        for (const value of values) {
          options.node('targetSlider').value = String(value);
          await options.fire('targetSlider', 'input');
          await options.fire('targetSlider', 'change');
        }
      };
      await hold([-19, -20, -21, -22, -23]);
      assert(writes().length === 0 && options.node('targetValue').textContent === '-23 LUFS',
        `while the key is held only the label moves (${writes().length} / ${options.node('targetValue').textContent})`);
      await options.fire('targetSlider', 'keyup', { key: 'ArrowRight' });
      assert(writes().length === 1 && writes()[0].value === -23 && options.synced[SETTINGS_KEY].targetLufs === -23,
        `the release writes the target reached, once (${JSON.stringify(writes())})`);

      // Losing focus with the key held writes there.
      options.sent.length = 0;
      await hold([-24, -25]);
      await options.blurWindow();
      await options.fire('targetSlider', 'keyup', { key: 'ArrowRight' });
      assert(writes().length === 1 && writes()[0].value === -25,
        `a blur during the hold writes the target reached, once (${JSON.stringify(writes())})`);

      // A repeat at the slider's end moves no value, and the hold still writes
      // what the repeats before it moved to.
      options.sent.length = 0;
      await hold([-26]);
      await options.fire('targetSlider', 'keydown', { key: 'ArrowRight' });
      await options.fire('targetSlider', 'keyup', { key: 'ArrowRight' });
      assert(writes().length === 1 && writes()[0].value === -26,
        `a repeat that moves nothing keeps the hold's write (${JSON.stringify(writes())})`);

      // A drag still writes at its change.
      options.sent.length = 0;
      options.node('targetSlider').value = '-12';
      await options.fire('targetSlider', 'input');
      await options.fire('targetSlider', 'change');
      assert(writes().length === 1 && writes()[0].value === -12, `a drag writes at its end (${JSON.stringify(writes())})`);
    }

    section('Settings page: a drag on Target LUFS that loses focus ends there');
    {
      const options = makeOptions({ settings: { targetLufs: -18 } });
      await options.settle();
      const writes = () => options.sent.filter((m) => m.type === 'store:saveSetting');
      const slider = () => options.node('targetSlider');
      const move = async (value) => {
        slider().value = String(value);
        await options.fire('targetSlider', 'input');
      };
      // Chrome fires the change at the blur, ahead of the blur itself, and that
      // change writes.
      await options.fire('targetSlider', 'pointerdown');
      await move(-21);
      await options.fire('targetSlider', 'change');
      await options.blurWindow();
      assert(writes().length === 1 && writes()[0].value === -21,
        `the change at the blur writes the value reached, once (${JSON.stringify(writes())})`);
      // Focus comes back with the button held and the thumb moves on: the
      // release's change writes nothing and puts the slider back.
      await move(-25);
      await options.fire('targetSlider', 'change');
      await options.fire('targetSlider', 'pointerup');
      assert(writes().length === 1 && Number(slider().value) === -21 && options.node('targetValue').textContent === '-21 LUFS',
        `after the blur the drag writes nothing more, and the slider and its label go back (${writes().length} / ${slider().value} / ${options.node('targetValue').textContent})`);

      // The next press is a drag of its own.
      options.sent.length = 0;
      await options.fire('targetSlider', 'pointerdown');
      await move(-12);
      await options.fire('targetSlider', 'change');
      await options.fire('targetSlider', 'pointerup');
      assert(writes().length === 1 && writes()[0].value === -12, `the next press writes at its change (${JSON.stringify(writes())})`);

      // A blur with nothing pressed ends nothing: the change after it writes.
      options.sent.length = 0;
      await options.blurWindow();
      await options.fire('targetSlider', 'blur');
      await move(-15);
      await options.fire('targetSlider', 'change');
      assert(writes().length === 1 && writes()[0].value === -15,
        `a change after a blur with nothing pressed writes as before (${JSON.stringify(writes())})`);

      // A key held when the window loses focus writes there, and a repeat of
      // that key is no new press: what it moves goes back, and nothing more is
      // written.
      options.sent.length = 0;
      await options.fire('targetSlider', 'keydown', { key: 'ArrowRight' });
      await move(-16);
      await options.fire('targetSlider', 'change');
      await options.blurWindow();
      await options.fire('targetSlider', 'keydown', { key: 'ArrowRight', repeat: true });
      await move(-17);
      await options.fire('targetSlider', 'change');
      await options.fire('targetSlider', 'keyup', { key: 'ArrowRight' });
      assert(writes().length === 1 && writes()[0].value === -16 && Number(slider().value) === -16,
        `a key held through a blur writes once there, and its repeats after it do not (${JSON.stringify(writes())} / ${slider().value})`);
    }

    section('Slider keys: a key that moves no value is no hold, and a hold ends with the last key let go');
    {
      const key = (name, repeat = false) => ({ key: name, repeat });
      // The popup.
      const popup = makePopup({
        answer: async (message) => (message.type === 'setGainLive' || message.type === 'setGain'
          ? { ok: true }
          : {
            isWatchPage: true,
            channel: { id: TT_CH, name: 'Transit', url: TT_URL },
            appliesTo: TT_CH + '|video|' + TT_VID,
            loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
            targetLufs: -18, videoType: 'video'
          })
      });
      await popup.ready();
      const saves = () => popup.asked.filter((m) => m.type === 'setGain').map((m) => m.gain);
      const slide = async (value) => {
        popup.node('volumeSlider').value = String(value);
        await popup.fire('volumeSlider', 'input');
      };
      // Tab during a drag: the change ahead of the blur saves the value shown.
      popup.asked.length = 0;
      await popup.fire('volumeSlider', 'pointerdown');
      await slide(150);
      await popup.fire('volumeSlider', 'keydown', key('Tab'));
      await popup.fire('volumeSlider', 'change');
      await popup.fire('volumeSlider', 'blur');
      await popup.fire('volumeSlider', 'pointerup');
      assert(JSON.stringify(saves()) === '[1.5]' && Number(popup.node('volumeSlider').value) === 150,
        `popup: Tab during a drag leaves the drag to save the gain shown (${JSON.stringify(saves())} / ${popup.node('volumeSlider').value})`);
      // Two arrow keys over each other: one save, when the last is let go.
      popup.asked.length = 0;
      await popup.fire('volumeSlider', 'keydown', key('ArrowRight'));
      await slide(155);
      await popup.fire('volumeSlider', 'change');
      await popup.fire('volumeSlider', 'keydown', key('ArrowLeft'));
      await slide(150);
      await popup.fire('volumeSlider', 'change');
      await popup.fire('volumeSlider', 'keyup', key('ArrowLeft'));
      for (const value of [155, 160, 165]) {
        await popup.fire('volumeSlider', 'keydown', key('ArrowRight', true));
        await slide(value);
        await popup.fire('volumeSlider', 'change');
      }
      await popup.fire('volumeSlider', 'keyup', key('ArrowRight'));
      assert(JSON.stringify(saves()) === '[1.65]',
        `popup: two arrow keys held over each other save once, at the last let go (${JSON.stringify(saves())})`);
      // Tab alone saves nothing, and a press after it saves as before.
      popup.asked.length = 0;
      await popup.fire('volumeSlider', 'keydown', key('Tab'));
      await popup.fire('volumeSlider', 'keyup', key('Tab'));
      assert(popup.asked.length === 0, `popup: Tab alone sends nothing (${JSON.stringify(popup.asked)})`);
      await popup.fire('volumeSlider', 'keydown', key('ArrowRight'));
      await slide(170);
      await popup.fire('volumeSlider', 'change');
      await popup.fire('volumeSlider', 'keyup', key('ArrowRight'));
      assert(JSON.stringify(saves()) === '[1.7]', `popup: a press after it saves as before (${JSON.stringify(saves())})`);
      // A second key pressed during a hold is part of it: one that moves
      // nothing (↑ at the top, after End) leaves the move made before it saved.
      popup.asked.length = 0;
      await popup.fire('volumeSlider', 'keydown', key('End'));
      await slide(600);
      await popup.fire('volumeSlider', 'change');
      await popup.fire('volumeSlider', 'keydown', key('ArrowUp'));
      await popup.fire('volumeSlider', 'keyup', key('ArrowUp'));
      await popup.fire('volumeSlider', 'keyup', key('End'));
      assert(JSON.stringify(saves()) === '[6]',
        `popup: a second key that moves nothing leaves the hold's move saved (${JSON.stringify(saves())})`);

      // The settings page.
      const options = makeOptions({ settings: { targetLufs: -18 } });
      await options.settle();
      const writes = () => options.sent.filter((m) => m.type === 'store:saveSetting').map((m) => m.value);
      const target = () => options.node('targetSlider');
      const move = async (value) => {
        target().value = String(value);
        await options.fire('targetSlider', 'input');
      };
      await options.fire('targetSlider', 'pointerdown');
      await move(-21);
      await options.fire('targetSlider', 'keydown', key('Tab'));
      await options.fire('targetSlider', 'change');
      await options.fire('targetSlider', 'blur');
      await options.fire('targetSlider', 'pointerup');
      assert(JSON.stringify(writes()) === '[-21]' && Number(target().value) === -21 &&
        options.node('targetValue').textContent === '-21 LUFS',
        `settings: Tab during a drag leaves the drag to write the target shown (${JSON.stringify(writes())} / ${target().value} / ${options.node('targetValue').textContent})`);
      options.sent.length = 0;
      await options.fire('targetSlider', 'keydown', key('ArrowRight'));
      await move(-17);
      await options.fire('targetSlider', 'change');
      await options.fire('targetSlider', 'keydown', key('ArrowLeft'));
      await move(-18);
      await options.fire('targetSlider', 'change');
      await options.fire('targetSlider', 'keyup', key('ArrowLeft'));
      for (const value of [-17, -16, -15]) {
        await options.fire('targetSlider', 'keydown', key('ArrowRight', true));
        await move(value);
        await options.fire('targetSlider', 'change');
      }
      await options.fire('targetSlider', 'keyup', key('ArrowRight'));
      assert(JSON.stringify(writes()) === '[-15]',
        `settings: two arrow keys held over each other write once, at the last let go (${JSON.stringify(writes())})`);
      options.sent.length = 0;
      await options.fire('targetSlider', 'keydown', key('Tab'));
      await options.fire('targetSlider', 'keyup', key('Tab'));
      assert(writes().length === 0, `settings: Tab alone writes nothing (${JSON.stringify(writes())})`);
      await options.fire('targetSlider', 'keydown', key('ArrowRight'));
      await move(-14);
      await options.fire('targetSlider', 'change');
      await options.fire('targetSlider', 'keyup', key('ArrowRight'));
      assert(JSON.stringify(writes()) === '[-14]', `settings: a press after it writes as before (${JSON.stringify(writes())})`);

      // The change notification of one write lands while the next press is
      // held: the slider stays where the press moved it, and the release
      // writes that; a press that moved nothing draws the target that arrived.
      const shown = () => `${target().value} / ${options.node('targetValue').textContent}`;
      const notify = (value) => options.fireStorage({ [SETTINGS_KEY]: { newValue: { targetLufs: value } } }, 'sync');
      options.sent.length = 0;
      await options.fire('targetSlider', 'keydown', key('ArrowRight'));
      await move(-13);
      await options.fire('targetSlider', 'change');
      await options.fire('targetSlider', 'keyup', key('ArrowRight'));
      await options.fire('targetSlider', 'keydown', key('ArrowRight'));
      await move(-12);
      await options.fire('targetSlider', 'change');
      await notify(-13);
      assert(shown() === '-12 / -12 LUFS', `settings: a notification during a hold leaves the slider where it was moved (${shown()})`);
      await options.fire('targetSlider', 'keyup', key('ArrowRight'));
      assert(JSON.stringify(writes()) === '[-13,-12]' && shown() === '-12 / -12 LUFS',
        `settings: and the release writes the value it moved to (${JSON.stringify(writes())}, ${shown()})`);
      options.sent.length = 0;
      await options.fire('targetSlider', 'pointerdown');
      await move(-11);
      await notify(-12);
      assert(shown() === '-11 / -11 LUFS', `settings: a notification during a drag leaves the slider under the pointer (${shown()})`);
      await options.fire('targetSlider', 'pointerup');
      await options.fire('targetSlider', 'change');
      assert(JSON.stringify(writes()) === '[-11]' && shown() === '-11 / -11 LUFS',
        `settings: a drag whose pointerup comes ahead of its change writes the drag (${JSON.stringify(writes())}, ${shown()})`);
      options.sent.length = 0;
      await options.fire('targetSlider', 'pointerdown');
      await notify(-20);
      await options.fire('targetSlider', 'pointerup');
      assert(writes().length === 0 && shown() === '-20 / -20 LUFS',
        `settings: a pointer let go of with nothing moved draws the target that arrived (${JSON.stringify(writes())}, ${shown()})`);
      await options.fire('targetSlider', 'keydown', key('ArrowRight'));
      await notify(-21);
      await options.fire('targetSlider', 'keyup', key('ArrowRight'));
      assert(writes().length === 0 && shown() === '-21 / -21 LUFS',
        `settings: and so does a key let go of with nothing moved, writing nothing over it (${JSON.stringify(writes())}, ${shown()})`);
      await options.fire('targetSlider', 'pointerdown');
      await notify(-22);
      await options.blurWindow();
      await options.fire('targetSlider', 'pointerup');
      assert(writes().length === 0 && shown() === '-22 / -22 LUFS',
        `settings: a press that moved nothing and ends at a blur draws it too (${JSON.stringify(writes())}, ${shown()})`);
      // A drag that comes back to where it began fires no change at its
      // release, let go of or ended by a blur: the target that arrived is drawn.
      options.sent.length = 0;
      assert(shown() === '-22 / -22 LUFS', `settings: the drag begins on -22 (${shown()})`);
      await options.fire('targetSlider', 'pointerdown');
      await move(-14);
      await notify(-25);
      await move(-22);
      await options.fire('targetSlider', 'pointerup');
      assert(writes().length === 0 && shown() === '-25 / -25 LUFS',
        `settings: a drag let go of where it began draws the target that arrived (${JSON.stringify(writes())}, ${shown()})`);
      await options.fire('targetSlider', 'pointerdown');
      await move(-20);
      await notify(-26);
      await move(-25);
      await options.blurWindow();
      await options.fire('targetSlider', 'pointerup');
      assert(writes().length === 0 && shown() === '-26 / -26 LUFS',
        `settings: and so does one a blur ends where it began (${JSON.stringify(writes())}, ${shown()})`);
      await notify(-18);
    }

    section('Settings change: Auto\'s own save follows the target and the defaults alone');
    for (const [what, next, stores] of [
      ['the display unit', { targetLufs: -18, displayUnit: 'dB' }, false],
      ['the gain overlay', { targetLufs: -18, showGainOverlay: true }, false],
      ['the target', { targetLufs: -22 }, true],
      ['the Video default', { targetLufs: -18, autoApplyLoudnessVideoDefault: true }, true],
      ['the Live default', { targetLufs: -18, autoApplyLoudnessLiveDefault: true }, true]
    ]) {
      await onVideo({ entry: { gainVideo: 0.5, autoApplyLoudnessVideo: true }, loudnessDb: -6 });
      mockSyncStorage.autoLoudnessSettings = { ...next };
      simulateStorageChange({ [SETTINGS_KEY]: { oldValue: { targetLufs: -18 }, newValue: { ...next } } });
      await settle();
      const saves = mockSentMessages.filter((m) => m?.type === 'store:saveChannelGain');
      assert((saves.length > 0) === stores,
        `a change of ${what} ${stores ? 'stores' : 'stores nothing'} (${JSON.stringify(saves.map((m) => m.gain))})`);
      assert(ytcv.state.currentGain === calcGain(-6, next.targetLufs),
        `and the gain is applied again either way (${ytcv.state.currentGain})`);
      ytcv._set('targetLufs', -18);
    }
    {
      // The live save the same way: a first live level is stored only for a
      // change that moves what Auto works out.
      await onVideo({ entry: { gainVideo: 0.5, autoApplyLoudnessVideo: true } });
      ytcv._set('currentLiveLkfs', -20);
      simulateStorageChange({ [SETTINGS_KEY]: { oldValue: { targetLufs: -18 }, newValue: { targetLufs: -18, displayUnit: 'dB' } } });
      await settle();
      assert(mockSentMessages.filter((m) => m?.type === 'store:saveChannelGain').length === 0,
        'a change of the unit makes no live save');
      simulateStorageChange({ [SETTINGS_KEY]: { oldValue: { targetLufs: -18 }, newValue: { targetLufs: -20, displayUnit: 'dB' } } });
      await settle();
      assert(mockSentMessages.filter((m) => m?.type === 'store:saveChannelGain').length === 1,
        'while a change of the target does');
      ytcv._set('currentLiveLkfs', null);
      ytcv._set('currentAutoApplyLoudnessVideo', false);
      ytcv._set('targetLufs', -18);
      ytcv.syncLiveFollow();
    }

    section('Popup: the thumb goes back to the gain a blur saved');
    {
      const popup = makePopup({
        answer: async (message) => (message.type === 'setGainLive' || message.type === 'setGain'
          ? { ok: true }
          : {
            isWatchPage: true,
            channel: { id: TT_CH, name: 'Transit', url: TT_URL },
            appliesTo: TT_CH + '|video|' + TT_VID,
            loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
            targetLufs: -18, videoType: 'video'
          })
      });
      await popup.ready();
      popup.node('volumeSlider').value = '165';
      await popup.fire('volumeSlider', 'pointerdown');
      await popup.fire('volumeSlider', 'input');
      await popup.fire('volumeSlider', 'change');
      await popup.blurWindow();
      // Focus comes back with the button held and the thumb moves on; the
      // release's change is not taken.
      popup.node('volumeSlider').value = '210';
      await popup.fire('volumeSlider', 'input');
      await popup.fire('volumeSlider', 'change');
      assert(Number(popup.node('volumeSlider').value) === 165,
        `the thumb shows the gain the blur saved (${popup.node('volumeSlider').value})`);
      assert(popup.node('volumeValue').textContent === '165%', 'and so does the figure beside it');
    }

    section('Popup: a drag the popup loses focus during ends there');
    {
      const popup = makePopup({
        answer: async (message) => (message.type === 'setGainLive' || message.type === 'setGain'
          ? { ok: true }
          : {
            isWatchPage: true,
            channel: { id: TT_CH, name: 'Transit', url: TT_URL },
            appliesTo: TT_CH + '|video|' + TT_VID,
            loudnessDb: -6, contentLufs: YT_REFERENCE_LUFS - 6, gain: 1.0,
            targetLufs: -18, videoType: 'video'
          })
      });
      await popup.ready();
      popup.asked.length = 0;
      popup.node('volumeSlider').value = '165';
      await popup.fire('volumeSlider', 'pointerdown');
      await popup.fire('volumeSlider', 'input');
      // Chrome fires change at the blur, then the blur.
      await popup.fire('volumeSlider', 'change');
      await popup.blurWindow();
      // Focus comes back with the button still held, the drag goes on, and
      // the release fires change again.
      popup.node('volumeSlider').value = '210';
      await popup.fire('volumeSlider', 'input');
      await popup.fire('volumeSlider', 'change');
      await popup.fire('volumeSlider', 'pointerup');
      const saves = popup.asked.filter((m) => m.type === 'setGain');
      const previews = popup.asked.filter((m) => m.type === 'setGainLive');
      assert(saves.length === 1 && saves[0].gain === 1.65,
        `the value at the blur is the one saved, once (${JSON.stringify(saves)})`);
      assert(previews.length === 1 && previews[0].gain === 1.65,
        `and the drag after it previews nothing (${JSON.stringify(previews)})`);

      // The next press begins a gesture of its own.
      popup.asked.length = 0;
      popup.node('volumeSlider').value = '120';
      await popup.fire('volumeSlider', 'pointerdown');
      await popup.fire('volumeSlider', 'input');
      await popup.fire('volumeSlider', 'change');
      await popup.fire('volumeSlider', 'pointerup');
      assert(popup.asked.filter((m) => m.type === 'setGainLive').length === 1 &&
        popup.asked.filter((m) => m.type === 'setGain' && m.gain === 1.2).length === 1,
        `a press after it previews and saves again (${JSON.stringify(popup.asked)})`);

      // A key repeat is not a press: after a blur ends a drag, only a new
      // press takes input again.
      popup.node('volumeSlider').value = '120';
      await popup.fire('volumeSlider', 'pointerdown');
      await popup.fire('volumeSlider', 'input');
      await popup.fire('volumeSlider', 'change');
      await popup.blurWindow();
      popup.asked.length = 0;
      popup.node('volumeSlider').value = '125';
      await popup.fire('volumeSlider', 'keydown', { key: 'ArrowRight', repeat: true });
      await popup.fire('volumeSlider', 'input');
      await popup.fire('volumeSlider', 'change');
      assert(popup.asked.length === 0, `a key repeat after the blur sends nothing (${JSON.stringify(popup.asked)})`);
      popup.node('volumeSlider').value = '130';
      await popup.fire('volumeSlider', 'keydown', { key: 'ArrowRight' });
      await popup.fire('volumeSlider', 'input');
      await popup.fire('volumeSlider', 'change');
      await popup.fire('volumeSlider', 'keyup', { key: 'ArrowRight' });
      assert(popup.asked.filter((m) => m.type === 'setGain' && m.gain === 1.3).length === 1,
        `while a new key press saves again (${JSON.stringify(popup.asked)})`);

      // A blur with no drag under way ends nothing.
      popup.asked.length = 0;
      await popup.blurWindow();
      popup.node('volumeSlider').value = '130';
      await popup.fire('volumeSlider', 'input');
      await popup.fire('volumeSlider', 'change');
      assert(popup.asked.filter((m) => m.type === 'setGain' && m.gain === 1.3).length === 1,
        `an input after a blur that came between gestures is still taken (${JSON.stringify(popup.asked)})`);
    }
  }

  section('The mutation sweep\'s own record');
  {
    // tools/mutation/equivalents.md says why each surviving mutant is one the
    // code cannot be told apart from. A reason outlives the line it was written
    // against unless something asks; this asks, without running a sweep.
    //
    // Not during one, though: a sweep holds a mutated source, the check reads
    // that source, and every mutant of a line named there would fail it. That
    // reads as a kill and inflates the very score the list is keeping.
    if (fs.existsSync('./.mutation-sweep-running')) {
      assert(true, 'a sweep is holding a mutated source, so the record is not read');
    } else {
      const run = require('child_process').spawnSync(
        'node', ['tools/mutation/sweep.mjs', '--verify'], { encoding: 'utf8' }
      );
      assert(run.status === 0 && /every one of them still a site the code has/.test(run.stdout),
        `every mutant the suite lets through is still one the code has (${(run.stderr || run.stdout).trim()})`);
    }
  }

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
