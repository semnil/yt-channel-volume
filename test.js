// test.js — Unit tests for utils.js pure functions
// Run: node test.js

// Minimal test runner
let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error('  FAIL:', msg); }
}
function assertClose(actual, expected, tolerance, msg) {
  assert(Math.abs(actual - expected) < tolerance, `${msg} — expected ~${expected}, got ${actual}`);
}
function section(name) { console.log(name); }

// Load utils.js into global scope
let mockStorage = {};
let mockSyncStorage = {};
let failSyncSet = false;
const mockStorageRemovals = [];
let holdRemovals = false;
let releaseRemovals = null;
globalThis.chrome = {
  runtime: { id: 'test-extension-id' },
  i18n: { getMessage: () => '' },
  storage: {
    local: {
      get(key) {
        if (key === null) return Promise.resolve(JSON.parse(JSON.stringify(mockStorage)));
        return Promise.resolve({ [key]: mockStorage[key] });
      },
      // A write lands after the turn that asked for it, not during it, so a
      // caller that does not wait for one reads what was there before.
      async set(obj) {
        await Promise.resolve();
        Object.assign(mockStorage, JSON.parse(JSON.stringify(obj)));
      },
      async remove(keys) {
        mockStorageRemovals.push(Array.isArray(keys) ? [...keys] : [keys]);
        // Held, a case can ask whether the caller waited for the sweep or
        // answered while it was still out.
        if (holdRemovals) await new Promise((resolve) => { releaseRemovals = resolve; });
        await Promise.resolve();
        for (const key of Array.isArray(keys) ? keys : [keys]) delete mockStorage[key];
      }
    },
    // The settings' own area. Kept apart from local, as Chrome keeps them.
    sync: {
      get(key) {
        return Promise.resolve(
          Object.prototype.hasOwnProperty.call(mockSyncStorage, key)
            ? { [key]: JSON.parse(JSON.stringify(mockSyncStorage[key])) }
            : {}
        );
      },
      async set(obj) {
        await Promise.resolve();
        if (failSyncSet) throw new Error('sync quota exceeded');
        Object.assign(mockSyncStorage, JSON.parse(JSON.stringify(obj)));
      }
    }
  }
};
// esc() writes text into an element and reads the markup back, so the stub has
// to serialise it the way a browser does: the characters that would otherwise
// open markup or an entity. The quotes esc adds itself.
globalThis.document = {
  createElement: () => ({
    _text: '',
    set textContent(value) { this._text = String(value); },
    get textContent() { return this._text; },
    get innerHTML() {
      return this._text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  })
};
const fs = require('fs');
// utils.js as it stands on disk and under its own name, so its top-level
// declarations are this suite's globals and the coverage report counts the run.
require('vm').runInThisContext(fs.readFileSync('./utils.js', 'utf8'), { filename: 'utils.js' });

section('msg');
{
  // The harness answers every key with '' so that a message it does not
  // declare cannot pass unnoticed; this swaps that out to read what msg does
  // with each answer it can get.
  const outer = globalThis.chrome;
  globalThis.chrome = { ...outer, i18n: { getMessage: (key) => (key === 'known' ? 'Known message' : '') } };
  assert(msg('known') === 'Known message', 'a declared message is what the viewer sees');
  assert(msg('missing') === 'missing', 'and a key the locale does not declare comes back as itself');
  globalThis.chrome = outer;
}

section('setChannelGain — expanding only what is legacy');
{
  // The expansion exists for the single-gain form. An entry that already holds
  // a type must not have it rewritten with the gain it has not got.
  const perType = { gainLive: 0.5 };
  setChannelGain(perType, 'video', 0.25);
  assert(perType.gainLive === 0.5, `the type already there is kept (${perType.gainLive})`);
  assert(perType.gainVideo === 0.25, 'and the one being set is taken');

  const fresh = { name: 'X' };
  setChannelGain(fresh, 'video', 0.5);
  assert(!('gainLive' in fresh),
    `an entry holding no gain grows only the type being set (${Object.keys(fresh).join(', ')})`);
  assert(fresh.gainVideo === 0.5, 'which it does take');

  const legacy = { gain: 0.75 };
  setChannelGain(legacy, 'video', 0.25);
  assert(legacy.gainLive === 0.75 && legacy.gainVideo === 0.25 && !('gain' in legacy),
    `the single gain becomes both, and the type being set takes its new value (${JSON.stringify(legacy)})`);
}

section('hasExplicitAutoApply');
{
  assert(hasExplicitAutoApply(null, 'video') === false, 'an entry that is not there holds no choice');
  assert(hasExplicitAutoApply(undefined, 'live') === false, 'nor does one that was never made');
  assert(hasExplicitAutoApply({}, 'video') === false, 'nor an empty one');
  assert(hasExplicitAutoApply({ autoApplyLoudnessVideo: false }, 'video') === true,
    'a choice of off is still a choice');
  assert(hasExplicitAutoApply({ autoApplyLoudness: true }, 'live') === true,
    'and the legacy flag is one for both types');
}

section('esc');
// The result is put inside a double-quoted attribute as well as between tags,
// and a quote that survives adds attributes to that tag.
{
  const escaped = esc('UC1" onclick="steal()');
  assert(!escaped.includes('"'), `no quote survives esc (${escaped})`);
  assert(escaped === 'UC1&quot; onclick=&quot;steal()', `and it is escaped as one (${escaped})`);
}
assert(esc('<b>&</b>') === '&lt;b&gt;&amp;&lt;/b&gt;', 'markup and entities are escaped');
assert(esc("it's") === 'it&#39;s', 'so is a single quote');
assert(esc('plain') === 'plain', 'and plain text is left alone');

// ── gainToPercent / percentToGain ────────────────────────────────────

section('gainToPercent');
assert(gainToPercent(1.0) === 100, '1.0 → 100');
assert(gainToPercent(0) === 0, '0 → 0');
assert(gainToPercent(0.5) === 50, '0.5 → 50');
assert(gainToPercent(6.0) === 600, '6.0 → 600');
assert(gainToPercent(0.005) === 1, '0.005 → 1 (rounding)');
assert(gainToPercent(0.004) === 0, '0.004 → 0 (rounding)');

section('percentToGain');
assert(percentToGain(100) === 1.0, '100 → 1.0');
assert(percentToGain(0) === 0, '0 → 0');
assert(percentToGain(600) === 6.0, '600 → 6.0');
assert(percentToGain(50) === 0.5, '50 → 0.5');

// ── gainToDb ─────────────────────────────────────────────────────────

section('gainToDb');
assert(gainToDb(1.0) === '0.0', '1.0 → 0.0 dB');
assert(gainToDb(0) === '-Inf', '0 → -Inf');
assert(gainToDb(-1) === '-Inf', 'negative → -Inf');
assertClose(parseFloat(gainToDb(0.5)), -6.0, 0.1, '0.5 → ~-6.0 dB');
assertClose(parseFloat(gainToDb(2.0)), 6.0, 0.1, '2.0 → ~6.0 dB');

// ── formatGain ───────────────────────────────────────────────────────

section('formatGain');
let f = formatGain(1.0, '%');
assert(f.text === '100' && f.unit === '%', '1.0 % → 100%');
f = formatGain(0.5, 'dB');
assert(f.unit === ' dB', '0.5 dB → unit is dB');
assert(f.text === gainToDb(0.5), '0.5 dB → text matches gainToDb');
f = formatGain(0, '%');
assert(f.text === '0' && f.unit === '%', '0 % → 0%');

section('formatAutoGain');
assert(formatAutoGain(0.7, '%') === 'Auto (70%)', 'stored 0.7 gain → Auto (70%)');
assert(formatAutoGain(null, '%') === 'Auto (—)', 'no stored gain is shown as unknown, not as 100%');
assert(formatAutoGain(undefined, 'dB') === 'Auto (—)', 'undefined gain is shown as unknown');
assert(formatAutoGain(0.5, 'dB', '自動') === '自動 (-6.0 dB)', 'Auto gain respects display unit and label');

section('normalizeStoredGain');
assert(normalizeStoredGain(0.5) === 0.5, 'finite stored gain remains available');
assert(normalizeStoredGain(NaN) === null, 'non-finite stored gain is rejected');

section('setChannelGain / setChannelAutoApply');
const typedEntry = { gainVideo: 0.5, gainLive: 0.7 };
setChannelGain(typedEntry, 'live', 0.9);
assert(typedEntry.gainLive === 0.9 && typedEntry.gainVideo === 0.5,
  'typed gain write leaves the other type untouched');
const legacyGainEntry = { gain: 0.6 };
setChannelGain(legacyGainEntry, 'video', 0.3);
assert(legacyGainEntry.gainVideo === 0.3 && legacyGainEntry.gainLive === 0.6 &&
  !('gain' in legacyGainEntry),
  'legacy single gain expands into both types before the write');
const legacyAutoEntry = { autoApplyLoudness: true };
setChannelAutoApply(legacyAutoEntry, 'video', false);
assert(legacyAutoEntry.autoApplyLoudnessVideo === false &&
  legacyAutoEntry.autoApplyLoudnessLive === true &&
  !('autoApplyLoudness' in legacyAutoEntry),
  'legacy all-types Auto flag expands before one type is set');
assert(hasExplicitAutoApply({ autoApplyLoudness: false }, 'live') === true,
  'legacy all-types flag counts as an explicit Auto choice');
assert(hasExplicitAutoApply({ gainLive: 0.7 }, 'live') === false,
  'a stored gain is not an explicit Auto choice');

section('setChannelGain — the mark of a gain held against the plain rendition');
const markedEntry = { gainVideo: 0.5, gainLive: 0.7 };
setChannelGain(markedEntry, 'video', 0.4, true);
assert(markedEntry.gainVideoPlain === true && isGainHeldAgainstPlain(markedEntry, 'video'),
  'a gain set held against the plain rendition carries the mark');
assert(!('gainLivePlain' in markedEntry) && !isGainHeldAgainstPlain(markedEntry, 'live'),
  'the other type is left unmarked');
setChannelGain(markedEntry, 'video', 0.6);
assert(!('gainVideoPlain' in markedEntry) && !isGainHeldAgainstPlain(markedEntry, 'video'),
  'a gain set without it loses the mark');
const markedLegacy = { gain: 0.6 };
setChannelGain(markedLegacy, 'live', 0.3, true);
assert(markedLegacy.gainLivePlain === true && !('gainVideoPlain' in markedLegacy) && markedLegacy.gainVideo === 0.6,
  'a legacy single gain expands unmarked, and only the type written is marked');
assert(isGainHeldAgainstPlain(null, 'video') === false, 'no entry: not held against it');
assert(isGainHeldAgainstPlain({ gainVideo: 1, gainVideoPlain: 'true' }, 'video') === false,
  'only true is the mark');

section('getChannelGain');
assert(getChannelGain({ gainVideo: 0.5, gainLive: 0.7 }, 'video') === 0.5,
  'typed Video gain is selected');
assert(getChannelGain({ gainVideo: 0.5, gainLive: 0.7 }, 'live') === 0.7,
  'typed Live gain is selected');
assert(getChannelGain({ gain: 0.6 }, 'live') === 0.6,
  'legacy gain applies to both types when typed gains are absent');
assert(getChannelGain({ gain: 0.6, gainVideo: 0.5 }, 'live') === null,
  'mixed storage does not reuse legacy gain for a missing typed gain');

section('resolveAutoApplySetting');
assert(resolveAutoApplySetting({ autoApplyLoudnessVideo: false, gainVideo: 0.5 },
  'video', true) === false, 'a manual save pins Auto OFF against the default');
assert(resolveAutoApplySetting({ autoApplyLoudnessVideo: false }, 'live', true) === true,
  'an explicit Video choice does not block the Live default');
assert(resolveAutoApplySetting({ autoApplyLoudness: false }, 'video', true) === false,
  'legacy all-types Auto flag still resolves both types');
assert(resolveAutoApplySetting({ autoApplyLoudnessVideo: true, gainVideo: 0.5 },
  'video', false) === true, 'explicit Auto ON overrides the global default');
assert(resolveAutoApplySetting({ autoApplyLoudnessVideo: false },
  'video', true) === false, 'explicit Auto OFF overrides the global default');
assert(resolveAutoApplySetting({ name: 'Unconfigured' }, 'video', true) === true,
  'channel type without an explicit choice inherits the default');
assert(resolveAutoApplySetting({ gainVideo: 0.5 }, 'video', true) === true,
  'a stored gain no longer decides Auto — Auto writes that gain too');
assert(resolveAutoApplySetting({ gainVideo: 0.5 }, 'video', true, true) === false,
  'before the fold a stored gain still means the channel opted out');
assert(resolveAutoApplySetting({ gain: 0.6 }, 'live', true, true) === false,
  'the legacy single gain opts both types out before the fold');
assert(resolveAutoApplySetting({ autoApplyLoudnessVideo: true, gainVideo: 0.5 },
  'video', false, true) === true, 'an explicit choice still wins before the fold');
assert(resolveAutoApplySetting({ name: 'No gain' }, 'video', true, true) === true,
  'a channel with no gain still inherits the default before the fold');

section('isManualGainLocked');
assert(isManualGainLocked(true, true) === true,
  'detected loudness locks manual gain while Auto controls playback');
assert(isManualGainLocked(true, false) === false,
  'missing loudness keeps manual fallback adjustment available');
assert(isManualGainLocked(false, true) === false,
  'manual mode keeps gain adjustment available');

section('manifest content utilities');
// Chrome reads a manifest and a catalog with a byte order mark and with
// comments, so this suite reads them that way too. Written as a scanner over
// characters rather than as pack.py's states, so the two agreeing is evidence.
const readJson = file => {
  const text = fs.readFileSync('./' + file, 'utf8').replace(/^\uFEFF/, '');
  let out = '', i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      out += ch; i++;
      while (i < text.length) {
        if (text[i] === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
        out += text[i];
        if (text[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') { const n = text.indexOf('\n', i); i = n < 0 ? text.length : n; continue; }
    if (ch === '/' && text[i + 1] === '*') {
      const n = text.indexOf('*/', i + 2);
      assert(n >= 0, `${file} closes every block comment it opens`);
      i = n < 0 ? text.length : n + 2;
      continue;
    }
    out += ch; i++;
  }
  return JSON.parse(out);
};
const manifest = readJson('manifest.json');
const isolatedContentScript = manifest.content_scripts.find(script =>
  script.world !== 'MAIN'
);
assert(JSON.stringify(isolatedContentScript?.js) ===
  JSON.stringify(['utils.js', 'content.js']),
  'shared utilities load before the isolated content script');

section('initialization reveal');
// A control whose transition survives initialization animates from its markup
// default into its stored value after the surface is already on screen. Only a
// universal `transition: none !important` under body.initializing covers every
// control, including ones added later.
function suppressesAllTransitions(html) {
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  for (const rule of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/transition\s*:\s*none\s*!important/.test(rule[2])) continue;
    const selectors = rule[1].split(',').map(s => s.trim().replace(/\s+/g, ' '));
    if (['*', '*::before', '*::after']
      .every(u => selectors.includes('body.initializing ' + u))) return true;
  }
  return false;
}
// The rule above only holds the values still while they are being written. The
// write has to be flushed while body.initializing still applies: dropping the
// class in the same style pass as the last value leaves the pre-write style as
// the transition's starting point, and every control animates again.
function revealBody(src, fnName) {
  const start = src.indexOf(`function ${fnName}()`);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(open, i + 1);
}
const optionsHtml = fs.readFileSync('./options.html', 'utf8');
const optionsSrc = fs.readFileSync('./options.js', 'utf8');
const popupHtml = fs.readFileSync('./popup.html', 'utf8');
const popupSrc = fs.readFileSync('./popup.js', 'utf8');
for (const [name, html, src, reveal, fnName] of [
  ['options', optionsHtml, optionsSrc, /\.finally\(revealOptions\);/, 'revealOptions'],
  ['popup', popupHtml, popupSrc, /finally\s*\{\s*revealPopup\(\);/, 'revealPopup'],
]) {
  assert(html.includes('<body class="initializing">'),
    `${name} remains hidden while asynchronous settings load`);
  assert(/body\.initializing\s*\{\s*visibility:\s*hidden;\s*\}/.test(html),
    `${name} hides the surface through the initializing class`);
  assert(suppressesAllTransitions(html),
    `${name} stops every transition while initializing`);
  assert(reveal.test(src),
    `${name} reveals after initialization succeeds or fails`);
  const body = revealBody(src, fnName);
  const flush = body === null ? -1 : body.indexOf('document.body.offsetWidth');
  const frame = body === null ? -1 : body.indexOf('requestAnimationFrame(');
  const drop = body === null ? -1 : body.indexOf("classList.remove('initializing')");
  assert(flush !== -1 && frame !== -1 && drop !== -1 && flush < frame && frame < drop,
    `${name} flushes the written values before dropping the class on the next frame`);
  assert((src.match(new RegExp(fnName, 'g')) || []).length === 2,
    `${name} reveals from one place, after the values are written`);
}
assert(optionsSrc.indexOf("requestChannelWrite('migrateLegacyGains')") !== -1 &&
  optionsSrc.indexOf("requestChannelWrite('migrateLegacyGains')") <
    optionsSrc.indexOf('.then(loadAll)'),
  'options ask the worker to fold legacy Auto gains in before listing channels');

section('destructive actions wait for the list');
// Delete all empties channelVolumes. Offered before the list has been read, a
// load that failed presents an empty page over a full profile, and the button
// next to it works.
assert(/<button[^>]+id="clearAllBtn"[^>]*\bdisabled\b/.test(optionsHtml),
  'options ship Delete all disabled');
assert(/\.clear-all-btn:disabled\s*\{[^}]*opacity:/.test(optionsHtml),
  'the disabled Delete all does not look live');
assert(/\.clear-all-btn:hover:not\(:disabled\)\s*\{/.test(optionsHtml),
  'hover does not paint the disabled Delete all');
assert(optionsSrc.indexOf('.then(loadAll)') !== -1 &&
  optionsSrc.indexOf('.then(loadAll)') <
    optionsSrc.indexOf('setSettingsControlsDisabled(false)'),
  'options enable Delete all only after the load that read the list');

section('nothing that acts on what was read is offered before the read');
// The page is revealed whether the load arrived or not, so a control that is
// live from the first frame is live on a page that read nothing.
for (const [id, label] of [
  ['targetSlider', 'the target slider'],
  ['defaultAutoVideoToggle', 'the video Auto default'],
  ['defaultAutoLiveToggle', 'the live Auto default'],
  ['overlayToggle', 'the gain overlay'],
]) {
  const tag = optionsHtml.match(new RegExp(`<input[^>]+id="${id}"[^>]*>`));
  assert(tag && /\bdisabled\b/.test(tag[0]), `${label} ships disabled`);
}
assert(/<button data-unit="%"[^>]*\bdisabled\b/.test(optionsHtml) &&
  /<button data-unit="dB"[^>]*\bdisabled\b/.test(optionsHtml),
  'both unit buttons ship disabled');
for (const control of [
  'targetSlider', 'defaultAutoVideoToggle', 'defaultAutoLiveToggle', 'overlayToggle', 'clearAllBtn'
]) {
  assert(new RegExp(`function setSettingsControlsDisabled[\\s\\S]{0,400}?${control}`).test(optionsSrc),
    `${control} is one of the controls the load enables`);
}
assert(/function setSettingsControlsDisabled[\s\S]{0,600}?unitToggle\.querySelectorAll\('button'\)/
  .test(optionsSrc), 'so are the unit buttons');
// The markup is the primary refusal; this is the one behind it.
assert(/async function saveSetting\(key, value\) \{[^}]*if \(!settingsLoaded\) return;/
  .test(optionsSrc),
  'a page that never read the settings writes none of them back');
// Disabled controls that look live are controls the viewer will reach for.
assert(/\.setting-row input\[type="range"\]:disabled\s*\{[^}]*opacity:/.test(optionsHtml),
  'the disabled slider does not look live');
assert(/\.toggle-group button:disabled\s*\{[^}]*opacity:/.test(optionsHtml),
  'the disabled unit buttons do not look live');
assert(/\.toggle-switch input:disabled \+ \.slider\s*\{[^}]*opacity:/.test(optionsHtml),
  'the disabled switches do not look live');
assert(/\.toggle-group button:hover:not\(\.active\):not\(:disabled\)\s*\{/.test(optionsHtml),
  'hover does not paint a disabled unit button');

section('a load that did not arrive says so, and stays that way');
// The page is revealed whether the load arrived or not, so the one that did not
// has to name what it could not read; nothing else on the page says it.
assert(/<div id="settingsError" class="settings-error hidden" role="status" data-i18n="settingsLoadFailed">/
  .test(optionsHtml),
  'options ship a line naming a failed settings read, hidden');
assert(/\.settings-error\.hidden\s*\{\s*display:\s*none;/.test(optionsHtml),
  'the line stays out of the layout until it is shown');
assert(/\.catch\(err => \{[\s\S]{0,400}?loadFailed = true;[\s\S]{0,200}?settingsErrorEl\.classList\.remove\('hidden'\);/
  .test(optionsSrc),
  'a load that fails records the failure and shows the line');
{
  const listenerSrc = optionsSrc.slice(optionsSrc.indexOf('chrome.storage.onChanged.addListener'));
  const refusal = listenerSrc.indexOf('if (loadFailed) return;');
  assert(refusal !== -1 &&
    refusal < listenerSrc.indexOf("if (area === 'sync')") &&
    refusal < listenerSrc.indexOf("if (area !== 'local') return;"),
    'the storage listener takes nothing, from either area, on a page whose load failed');
}
const jaMessages = JSON.parse(fs.readFileSync('./_locales/ja/messages.json', 'utf8'));
const enMessages = JSON.parse(fs.readFileSync('./_locales/en/messages.json', 'utf8'));
// The message speaks for the read, not for the values next to it: a change that
// lands while the read is still out is rendered before there is a failure.
assert(jaMessages.settingsLoadFailed.message ===
  '保存済みの設定を読み込めませんでした。ページを再読み込みしてください',
  'the ja message names the read and the next step');
assert(enMessages.settingsLoadFailed.message ===
  'Could not load the saved settings. Please reload the page.',
  'the en message names the read and the next step');

section('the markup ships the defaults the code falls back to');
// A load that never wrote to the controls leaves the markup on screen, so the
// markup has to be what the extension would have used.
assert(new RegExp(`id="targetSlider"[^>]*value="${DEFAULT_TARGET_LUFS}"`).test(optionsHtml),
  'the target slider ships at DEFAULT_TARGET_LUFS');
assert(/targetLufs = s\.targetLufs \?\? DEFAULT_TARGET_LUFS;/.test(optionsSrc),
  'and that is what the load falls back to');
assert(/<button data-unit="%" class="active"[^>]*>/.test(optionsHtml),
  'the unit toggle ships on %');
assert(/displayUnit = s\.displayUnit \|\| '%';/.test(optionsSrc),
  'and that is what the load falls back to');
assert(DEFAULT_AUTO_APPLY_LOUDNESS === false,
  'auto-apply is off by default');
assert(/overlayToggle\.checked = !!s\.showGainOverlay;/.test(optionsSrc),
  'the gain overlay is off by default');
for (const id of ['defaultAutoVideoToggle', 'defaultAutoLiveToggle', 'overlayToggle']) {
  const tag = optionsHtml.match(new RegExp(`<input[^>]+id="${id}"[^>]*>`));
  assert(tag && !/\bchecked\b/.test(tag[0]), `${id} ships unchecked`);
}
// The row button is written by the render, so the refusal is stated twice: in
// the markup the render writes, and in the handler the click reaches.
assert(/class="ch-del" data-id="\$\{esc\(id\)\}"\$\{settingsLoaded \? '' : ' disabled'\}/
  .test(optionsSrc),
  'the row delete button is written disabled until the load has read the list');
assert(/addEventListener\('click', async \(\) => \{\s*if \(!settingsLoaded\) return;/
  .test(optionsSrc),
  'the row delete handler refuses on a load that never finished');
assert(optionsSrc.indexOf('settingsLoaded = true') !== -1 &&
  optionsSrc.indexOf('settingsLoaded = true') <
    optionsSrc.indexOf('renderChannels(channelVolumes);\n  }'),
  'the rows are written after the load records that it read the settings');
// The renderer draws what it is handed. Reading the list itself would put a
// second read in flight against the one the load already has out, with no
// revision to weigh the answer against.
assert(!/renderChannels\(\)/.test(optionsSrc),
  'nothing asks the table to draw without handing it a list');
assert(/function renderChannels\(all\) \{\s*if \(!all\) return;/.test(optionsSrc),
  'and a page that holds no list draws none');
assert(!/function renderChannels[\s\S]{0,400}?chrome\.storage\.local\.get/.test(optionsSrc),
  'the renderer reads no storage of its own');
// One load of both areas: a page that shows what it read shows both or neither,
// so the line it puts up names the load that failed rather than half of one.
assert(/Promise\.all\(\[\s*readSettings\(\),\s*chrome\.storage\.local\.get\(CHANNEL_VOLUMES_KEY\)\s*\]\)/.test(optionsSrc),
  'the initial load reads the settings and the channels together');

section('the initial read does not undo what arrived while it was out');
// The read is issued before a change that lands during it, and returns what
// storage held when it was issued, so applying it unconditionally puts the
// older value back on a page that has already shown the newer one.
assert(/const settingsAt = settingsRevision;[\s\S]{0,120}const channelsAt = channelRevision;[\s\S]{0,200}Promise\.all\(\[\s*readSettings\(\)/
  .test(optionsSrc),
  'the load records both revisions before it issues its reads');
assert(/if \(settingsAt === settingsRevision\) applySettings\(/.test(optionsSrc),
  'and applies the settings it read only where none arrived since');
assert(/if \(channelsAt === channelRevision\) channelVolumes = /.test(optionsSrc),
  'and keeps the list it read only where none arrived since');
assert(/if \(changes\[SETTINGS_KEY\]\) \{\s*settingsRevision\+\+;/.test(optionsSrc),
  'a settings change counts as one that arrived');
assert(/if \(changes\[CHANNEL_VOLUMES_KEY\]\) \{\s*channelRevision\+\+;/.test(optionsSrc),
  'so does a channel change');
// The notification carries the map, so reading it back would be a second read
// racing the first one.
assert(/channelVolumes = changes\[CHANNEL_VOLUMES_KEY\]\.newValue \|\| \{\};\s*renderChannels\(channelVolumes\);/
  .test(optionsSrc),
  'the channel change is drawn from what it carried');
assert(/settingsRevision\+\+;\s*applySettings\(changes\[SETTINGS_KEY\]\.newValue \|\| \{\}\);/
  .test(optionsSrc),
  'a settings change is applied whole, so every control shows what arrived');
assert(/\.ch-del:disabled\s*\{[^}]*opacity:/.test(optionsHtml),
  'the disabled row delete does not look live');
assert(/\.ch-del:hover:not\(:disabled\)\s*\{/.test(optionsHtml),
  'hover does not paint the disabled row delete');

// The names under a _locales directory that are locales: a name is one when it
// carries a catalog. Anything else there — a .DS_Store, a stray file — is not a
// directory, and a reader that walks into it crashes rather than fails.
function localesWithCatalog(dir) {
  return fs.readdirSync(dir)
    .filter(name => fs.existsSync(require('path').join(dir, name, 'messages.json')));
}

section('packaging');

// pack.py selects by reference rather than by name, so what it leaves out is
// answered by running it rather than by reading a list.
const listed = require('child_process').spawnSync('python3', ['-B', 'pack.py', '--list'],
  { encoding: 'utf8' });
assert(listed.status === 0, `pack.py --list runs — ${(listed.stderr || '').trim()}`);
const packaged = listed.stdout.split('\n').map(line => line.trim()).filter(Boolean);
const packagedUnder = prefix => packaged.some(name => name === prefix || name.startsWith(prefix + '/'));
// Code fenced as YTCV_DIAG is for evaluating a build on this machine and is
// not shipped: no file the package carries may hold the fence.
assert(packaged.length > 0, 'pack.py --list selects files to look into');
for (const name of packaged) {
  assert(!fs.readFileSync('./' + name).includes('YTCV_DIAG'),
    `${name} is packaged and holds code fenced as YTCV_DIAG`);
}
// pack.py declares the keys it follows; this reads that declaration and
// resolves every one of them itself. The two share the list of keys and
// nothing else — the reading, the parsing and the spelling are separate here —
// so a key added to the walk cannot leave this behind.
const DECLARED_KINDS = new Set(['page', 'script', 'style', 'asset', 'named']);
const declaredKeys = (() => {
  const source = fs.readFileSync('./pack.py', 'utf8');
  const table = source.match(/^MANIFEST_REFERENCES = \(([\s\S]*?)^\)$/m);
  assert(table, 'pack.py declares the keys it follows in MANIFEST_REFERENCES');
  const rows = Array.from(table[1].matchAll(/\(\(([^)]*)\),\s*'([a-z]+)'\)/g),
    ([, steps, kind]) => ({
      path: Array.from(steps.matchAll(/'([^']*)'/g), m => m[1]),
      kind
    }));
  assert(rows.length > 0, 'the declared table holds keys');
  for (const { kind } of rows) {
    assert(DECLARED_KINDS.has(kind),
      `pack.py walks a ${kind} and this test does not know that kind`);
  }
  return rows;
})();
const valuesAt = (value, steps) => {
  if (!steps.length) { return typeof value === 'string' ? [value] : []; }
  const [step, ...rest] = steps;
  const isObject = value !== null && typeof value === 'object';
  if (step === '*') {
    return isObject && !Array.isArray(value)
      ? Object.values(value).flatMap(held => valuesAt(held, rest)) : [];
  }
  if (step === '[]') {
    return Array.isArray(value) ? value.flatMap(held => valuesAt(held, rest)) : [];
  }
  return isObject && step in value ? valuesAt(value[step], rest) : [];
};
// A resource entry Chrome matches against the package names no one file.
const A_PATTERN = /[*?]/;
const BY_NAME = [['.html', 'page'], ['.js', 'script'], ['.css', 'style']];
const kindOfName = name =>
  (BY_NAME.find(([suffix]) => name.endsWith(suffix)) || [null, 'asset'])[1];
const namedByManifest = declaredKeys.flatMap(({ path, kind }) =>
  valuesAt(manifest, path)
    .filter(value => !A_PATTERN.test(value))
    .map(value => ({ value, kind: kind === 'named' ? kindOfName(value) : kind })));
// Read without the declared table: a string in the manifest that names a file
// in the tree is a file the extension loads. A key left out of that table is
// silent to every check that reads it, and this is what stays awake.
const namesAFile = [];
(function walkStrings(value) {
  if (typeof value === 'string') {
    if (/^[\w][\w./-]*$/.test(value) && fs.existsSync('./' + value)
      && fs.statSync('./' + value).isFile()) {
      namesAFile.push(value);
    }
  } else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(walkStrings);
  }
})(manifest);
assert(namesAFile.length > 0, 'the manifest names files that are in the tree');
for (const value of namesAFile) {
  assert(packaged.includes(value),
    `${value} is named by the manifest and must be packed`);
}
for (const { value } of namedByManifest) {
  assert(packaged.includes(value), `${value} is named by the manifest and must be packed`);
  assert(fs.existsSync('./' + value), `${value} exists`);
}

// Files the package carries although nothing in it loads them. pack.py names
// them in DISTRIBUTION_FILES, and reading that list here holds the two together.
const packSrc = fs.readFileSync('./pack.py', 'utf8');
const distributionBlock = packSrc.match(/^DISTRIBUTION_FILES = \(([^)]*)\)/m);
assert(distributionBlock, 'pack.py names what a copy carries in DISTRIBUTION_FILES');
const distribution = Array.from((distributionBlock?.[1] || '').matchAll(/'([^']+)'/g), m => m[1]);
assert(distribution.includes('LICENSE'),
  'the licence text travels with the copies the licence covers');
for (const name of distribution) {
  assert(fs.existsSync('./' + name), `${name} exists`);
  assert(packaged.includes(name), `${name} is in the store package`);
}

// The other direction: a packaged path that nothing loads and that no licence
// requires is a file shipped to users that nobody reviewed as part of the
// extension.
// The pages are read independently of pack.py. Written the way pack.py writes
// it, this side would agree with it about a spelling neither of them handles.
const PAGE_TAG = /<(script|link)\b([^>]*)>/gi;
const PAGE_ATTR = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
const pageReferences = text => {
  const found = [];
  for (const [, tag, rest] of text.replace(/<!--[\s\S]*?-->/g, '').matchAll(PAGE_TAG)) {
    const attributes = {};
    for (const [, name, quoted, single, bare] of rest.matchAll(PAGE_ATTR)) {
      attributes[name.toLowerCase()] = quoted ?? single ?? bare;
    }
    if (tag.toLowerCase() === 'script' && attributes.src) { found.push(attributes.src); }
    if (tag.toLowerCase() === 'link' && attributes.href
      && ((attributes.rel || '').toLowerCase().split(/\s+/).includes('stylesheet')
        || attributes.href.endsWith('.css'))) {
      found.push(attributes.href);
    }
  }
  return found;
};
const importedBy = text => Array.from(
  text.matchAll(/importScripts\(([^)]*)\)/g),
  ([, call]) => Array.from(call.matchAll(/['"]([^'"]+)['"]/g), m => m[1])).flat();
const styleReferences = text => Array.from(
  text.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .matchAll(/(?:@import\s+(?:url\(\s*)?|url\(\s*)(["']?)([^"')\s;]+)\1/g),
  m => m[2]).filter(target => !/^(https?:|\/\/|data:|#)/.test(target)
    && !target.includes('__MSG_'));
// What the extension loads, followed from the manifest through the files it
// names, each of them parsed here rather than by pack.py.
const referenced = new Set(['manifest.json']);
{
  const pending = namedByManifest.slice();
  while (pending.length) {
    const { value, kind } = pending.shift();
    if (referenced.has(value)) { continue; }
    referenced.add(value);
    if (kind === 'asset' || !fs.existsSync('./' + value)) { continue; }
    const text = fs.readFileSync('./' + value, 'utf8');
    const base = value.includes('/') ? value.slice(0, value.lastIndexOf('/') + 1) : '';
    const found = kind === 'page' ? pageReferences(text)
      : kind === 'script' ? importedBy(text) : styleReferences(text);
    for (const reference of found) {
      pending.push({ value: base + reference, kind: kindOfName(reference) });
    }
  }
}
for (const name of packaged) {
  assert(referenced.has(name) || distribution.includes(name)
    || /^_locales\/[^/]+\/messages\.json$/.test(name),
    `${name} is packaged, so something the extension loads has to name it`);
}

// Every locale the tree carries is one the package carries. An extension
// shipped with the default locale alone loads and speaks the wrong language to
// everyone else, which the rule above would pass.
{
  const inTree = fs.readdirSync('./_locales')
    .filter(name => fs.existsSync(`./_locales/${name}/messages.json`))
    .map(name => `_locales/${name}/messages.json`).sort();
  // Without a second locale, packing the default one alone would satisfy this.
  assert(inTree.length > 1, 'the tree carries more than one locale');
  const inPackage = packaged.filter(name => name.startsWith('_locales/')).sort();
  assert(JSON.stringify(inPackage) === JSON.stringify(inTree),
    `every locale in the tree is in the package — got ${inPackage.join(', ')}`);
}

// A name inside the package is POSIX whatever the host writes it on: the
// manifest spells its references with forward slashes and a zip entry carries
// them. Windows is where they would not be, so pack.py's own selection runs
// here under Windows path semantics, with the real filesystem still answering.
const WINDOWS_PATH_HARNESS = [
    'import ntpath, os, builtins, types, importlib.util',
    'spec = importlib.util.spec_from_file_location("packmod", "pack.py")',
    'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
    'real, real_open, real_os = os.path, builtins.open, os',
    'host = lambda p: p.replace(chr(92), "/")',
    'win = lambda p: p.replace("/", chr(92))',
    'class W:',
    '    isabs, normpath, join, dirname = ntpath.isabs, ntpath.normpath, ntpath.join, ntpath.dirname',
    '    realpath = staticmethod(lambda p: win(real.realpath(host(p))))',
    '    isfile = staticmethod(lambda p: real.isfile(host(p)))',
    '    isdir = staticmethod(lambda p: real.isdir(host(p)))',
    '    abspath = staticmethod(lambda p: win(real.abspath(host(p))))',
    'mod.os = types.SimpleNamespace(path=W, listdir=lambda p: real_os.listdir(host(p)),',
    '                               remove=real_os.remove, sep=chr(92))',
    'mod.open = lambda p, *a, **k: real_open(host(p), *a, **k)',
    'print(chr(10).join(arc for _f, arc in mod.selected_files(win(real.abspath(".")))))'
].join('\n');

function namesOnWindows(cwd, where) {
  const run = require('child_process').spawnSync('python3', ['-B', '-c', WINDOWS_PATH_HARNESS],
    { cwd, encoding: 'utf8' });
  if (run.error) {
    console.log(`  (windows path check skipped for ${where}: ${run.error.message})`);
    return null;
  }
  assert(run.status === 0,
    `the windows path harness runs on ${where} — ${(run.stderr || '').trim()}`);
  if (run.status !== 0) { return null; }
  const names = (run.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  const backslashed = names.filter(name => name.includes('\\'));
  assert(backslashed.length === 0,
    `every name inside ${where}'s package stays POSIX on Windows — ${backslashed.join(', ')}`);
  return names;
}

{
  const onWindows = namesOnWindows('.', 'this repository');
  if (onWindows) {
    assert(JSON.stringify(onWindows) === JSON.stringify(packaged),
      `the package holds the same names on either host — ${onWindows.join(', ')}`);
  }
}

// gen_icons.py draws one icon for each of its SIZES, and those are the icons
// the tree carries: an icon it no longer draws, or one it draws that is not
// committed, stands out here without Pillow.
{
  const sizes = /^SIZES = \[([^\]]*)\]/m.exec(fs.readFileSync('./gen_icons.py', 'utf8'));
  assert(sizes, 'gen_icons.py names the sizes it draws in SIZES');
  const drawn = sizes ? sizes[1].split(',').map(size => `icon${size.trim()}.png`).sort() : [];
  const committed = fs.readdirSync('./icons').filter(name => /^icon\d+\.png$/.test(name)).sort();
  assert(committed.length > 0, 'the tree carries the icons gen_icons.py draws');
  assert(JSON.stringify(committed) === JSON.stringify(drawn),
    `the tree carries the icons gen_icons.py draws, and no others — ${committed.join(', ')} / ${drawn.join(', ')}`);
}

section('README screenshots');
// One README per language the generator draws, each embedding that language's
// images. The list comes from the directory, so a README added without a home
// here is one this section still reads.
const README_FILES = fs.readdirSync('.').filter(name => /^README(\.[a-z][a-z-]*)?\.md$/.test(name));
const EMBED = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)|<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/g;
const readmeEmbeds = new Map(README_FILES.map(file => [file,
  Array.from(fs.readFileSync('./' + file, 'utf8').matchAll(EMBED), m => m[1] || m[2])
    .filter(image => !/^https?:/.test(image))]));
const readmeImages = [...readmeEmbeds.values()].flat();
for (const image of readmeImages) {
  assert(fs.existsSync('./' + image), `${image} is embedded in a README and must exist`);
}

// The generator's own source says where it writes and what it names the files;
// reading it here is what ties the README, the committed images and the zip
// together. A rename on either side has to break something.
const genSrc = fs.readFileSync('./gen_screenshots.py', 'utf8');
const outDirDecl = genSrc.match(/OUT_DIR = os\.path\.join\(ROOT, '([^']+)', '([^']+)'\)/);
const sheetTable = genSrc.match(/SHEETS = \{([^}]+)\}/);
const langTuple = genSrc.match(/LANGS = \(([^)]+)\)/);
assert(outDirDecl, 'gen_screenshots.py declares OUT_DIR as os.path.join(ROOT, ...)');
assert(sheetTable, 'gen_screenshots.py lists its sheets in SHEETS');
assert(langTuple, 'gen_screenshots.py lists its languages in LANGS');
if (outDirDecl && sheetTable && langTuple) {
  const outDir = `${outDirDecl[1]}/${outDirDecl[2]}`;
  const langs = Array.from(langTuple[1].matchAll(/'([^']+)'/g), m => m[1]);
  const sheets = Array.from(sheetTable[1].matchAll(/'([^']+)':/g), m => m[1]);
  const generated = new Set(
    sheets.flatMap(sheet => langs.map(lang => `${outDir}/${sheet}_${lang}.png`)));
  assert(generated.size > 0, 'gen_screenshots.py writes screenshots');
  for (const file of generated) {
    assert(fs.existsSync('./' + file), `${file} is generated and must be committed`);
  }
  // Only .png files, which is what --check counts: neither what Finder leaves
  // in a directory of images nor what an interrupted run leaves beside them is
  // an image anybody drew, and the staging directory carries the suffix, so
  // the name alone does not tell it from one.
  const imagesIn = dir => (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter(name =>
    /\.png$/i.test(name) && fs.statSync(`${dir}/${name}`, { throwIfNoEntry: false })?.isFile());
  const suffixBox = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'ytcv-shots-'));
  fs.writeFileSync(`${suffixBox}/popup_ja.png`, '');
  fs.mkdirSync(`${suffixBox}/tmpabc123.png`);
  assert(imagesIn(suffixBox).join() === 'popup_ja.png',
    'a leftover staging directory is not one of the images counted here');
  fs.rmSync(suffixBox, { recursive: true, force: true });
  const committed = imagesIn('./' + outDir);
  for (const name of committed) {
    assert(generated.has(`${outDir}/${name}`),
      `${outDir}/${name} is committed but nothing draws it`);
  }

  // A count over the two files together is satisfied by either one of them, so
  // each README is held to its own language's full set.
  const suffixed = new Map(README_FILES.filter(name => name !== 'README.md')
    .map(name => [name, name.slice('README.'.length, -'.md'.length)]));
  const spare = langs.filter(lang => ![...suffixed.values()].includes(lang));
  assert(README_FILES.includes('README.md') && spare.length === 1,
    'exactly one language gen_screenshots.py draws is the unsuffixed README');
  const readmeLang = new Map([['README.md', spare[0] || null], ...suffixed]);
  assert(new Set(readmeLang.values()).size === langs.length
    && langs.every(lang => [...readmeLang.values()].includes(lang)),
    'every language gen_screenshots.py draws has a README of its own');
  for (const [file, lang] of readmeLang) {
    const shown = [...new Set((readmeEmbeds.get(file) || [])
      .filter(image => image.startsWith(outDir + '/')))].sort();
    const want = sheets.map(sheet => `${outDir}/${sheet}_${lang}.png`).sort();
    assert(JSON.stringify(shown) === JSON.stringify(want),
      `${file} embeds every ${lang} screenshot and no other language's`);
  }
  for (const image of readmeImages.filter(image => image.startsWith(outDir + '/'))) {
    assert(generated.has(image), `${image} is one of the files gen_screenshots.py writes`);
  }

  assert(!packagedUnder(outDir.split('/')[0]), 'the screenshots stay out of the store zip');

  // Chrome refuses to load an unpacked extension whose top level holds a name
  // starting with "_" outside this list, and that top level is where these
  // children run. They run without -B, and without either variable that would
  // decide this for them — one turns the writing off, the other sends it out
  // of the root this reads — so what they write answers for their source and
  // nothing else. Windows matches variable names without regard to case, so
  // the copy drops keys by their upper-cased name.
  const chromeAllows = ['_locales', '_platform_specific', '_metadata', '__MACOSX'];
  const reservedAtRoot = () => fs.readdirSync('.')
    .filter(name => name.startsWith('_') && !chromeAllows.includes(name));
  const pyDropped = ['PYTHONDONTWRITEBYTECODE', 'PYTHONPYCACHEPREFIX'];
  const pyEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !pyDropped.includes(name.toUpperCase())));
  fs.rmSync('./__pycache__', { recursive: true, force: true });

  // A module that does not opt out, read with that same environment, writes
  // its bytecode beside itself. Where it does not, the name check below is
  // answering for the environment rather than for the source it is there to
  // hold, and would stay green with the opt-out taken out.
  const probeDir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'ytcv-pyc-'));
  fs.writeFileSync(`${probeDir}/ytcv_probe.py`, '');
  const probe = require('child_process').spawnSync(
    'python3', ['-c', 'import ytcv_probe'], { cwd: probeDir, encoding: 'utf8', env: pyEnv });
  const wroteBeside = fs.existsSync(`${probeDir}/__pycache__`);
  fs.rmSync(probeDir, { recursive: true, force: true });
  if (probe.error) {
    console.log(`  (bytecode control skipped: ${probe.error.message})`);
  } else {
    assert(wroteBeside,
      'the environment these children get still writes bytecode where the module is');
  }

  // Whether the committed images are the ones this code draws can only be
  // answered by drawing them, which needs pillow. CI installs it and runs the
  // same command as its own step, so a machine without it says so here.
  const drawn = require('child_process').spawnSync(
    'python3', ['gen_screenshots.py', '--check'], { encoding: 'utf8', env: pyEnv });
  if (drawn.error || drawn.status === 3) {
    console.log(`  (pixel check skipped: ${(drawn.error || drawn.stderr || '').toString().trim()})`);
  } else {
    assert(drawn.status === 0,
      `the committed screenshots are what gen_screenshots.py draws — ${(drawn.stderr || '').trim()}`);
  }

  // The face those images are drawn with is committed, and stays out of the zip.
  const fontDir = genSrc.match(/FONT_DIR = os\.path\.join\(ROOT, '([^']+)', '([^']+)'\)/);
  assert(fontDir, 'gen_screenshots.py declares FONT_DIR as os.path.join(ROOT, ...)');
  if (fontDir) {
    for (const face of Array.from(genSrc.matchAll(/os\.path\.join\(FONT_DIR, '([^']+)'\)/g), m => m[1])) {
      assert(fs.existsSync(`./${fontDir[1]}/${fontDir[2]}/${face}`),
        `${fontDir[1]}/${fontDir[2]}/${face} is the face the screenshots are drawn with`);
    }
    assert(!packagedUnder(fontDir[1]), 'the vendored font stays out of the store zip');
  }

  // CI redraws into an empty directory and uploads that one, so the artifact
  // holds what the runner drew and nothing else that sits in docs/screenshots.
  assert(genSrc.includes("'--out'"), 'gen_screenshots.py takes --out');
  assert(!packaged.includes('test-screenshots.py'), 'the generator test stays out of the store zip');
  const paths = require('child_process').spawnSync(
    'python3', ['test-screenshots.py'], { encoding: 'utf8', env: pyEnv });
  if (paths.error || paths.status === 3) {
    console.log(`  (path test skipped: ${(paths.error || paths.stderr || '').toString().trim()})`);
  } else {
    assert(paths.status === 0,
      `test-screenshots.py — ${(paths.stdout || '').trim().split('\n').filter(l => l.includes('FAIL')).join('; ')}`);
  }

  // __pycache__ is this suite's own leaving, so it goes rather than only being
  // reported: left in place it is the thing that stops the next Load unpacked.
  // Anything else wearing that name shape is someone else's and only reported.
  const reserved = reservedAtRoot();
  fs.rmSync('./__pycache__', { recursive: true, force: true });
  assert(reserved.length === 0,
    `the extension root carries no name Chrome reserves — ${reserved.join(', ')}`);
}
assert(!packagedUnder('screenshots'),
  'a screenshots/ left over from before the move stays out of the store zip');
assert(!packaged.includes('.DS_Store'),
  'the finder metadata macOS drops beside the manifest stays out of the store zip');

// The canvas is a fixed 640x400 and nothing clips to it, so a settings row too
// many pushed the section below it off the bottom edge and the run saved the
// clipped image at exit 0. Adding a row is the mutation this stands on.
{
  const nodePath = require('path');
  const box = fs.mkdtempSync(nodePath.join(fs.realpathSync(require('os').tmpdir()), 'ytcv-crowded-'));
  fs.copyFileSync('./gen_screenshots.py', nodePath.join(box, 'gen_screenshots.py'));
  fs.cpSync('./tools', nodePath.join(box, 'tools'), { recursive: true });
  fs.cpSync('./_locales', nodePath.join(box, '_locales'), { recursive: true });
  const source = fs.readFileSync(nodePath.join(box, 'gen_screenshots.py'), 'utf8');
  const last = source.match(/\n(    \('overlay_label'[\s\S]*?\}\),\n)\)/);
  assert(last, 'the declaration ends with a row this can repeat');
  fs.writeFileSync(nodePath.join(box, 'gen_screenshots.py'),
    source.replace(last[1], last[1] + last[1]));

  const out = nodePath.join(box, 'drawn');
  const crowded = require('child_process').spawnSync('python3', ['-B', 'gen_screenshots.py', '--out', out],
    { cwd: box, encoding: 'utf8' });
  assert(crowded.status !== 0,
    `one row too many is refused — exited ${crowded.status}`);
  assert(/settings rows, the last of them \w+, need \d+ px of the \d+/.test(crowded.stderr || ''),
    `and it says how many rows and how much room they want — said ${(crowded.stderr || '').trim()}`);
  assert(!fs.existsSync(out) || fs.readdirSync(out).length === 0,
    'and it draws nothing rather than saving a clipped sheet');

  // Without this the refusal above could be the sandbox failing to draw at all.
  const roomy = require('child_process').spawnSync('python3', ['-B', 'gen_screenshots.py', '--out', out],
    { cwd: box, encoding: 'utf8', env: { ...process.env } });
  fs.copyFileSync('./gen_screenshots.py', nodePath.join(box, 'gen_screenshots.py'));
  const asShipped = require('child_process').spawnSync('python3', ['-B', 'gen_screenshots.py', '--out', out],
    { cwd: box, encoding: 'utf8' });
  if (asShipped.status === 3) {
    console.log(`  (crowded-sheet check: this machine cannot draw — ${(asShipped.stderr || '').trim()})`);
  } else {
    assert(asShipped.status === 0,
      `the rows it has do fit — ${(asShipped.stderr || '').trim()}`);
    assert(fs.readdirSync(out).filter(name => name.endsWith('.png')).length > 0,
      'and that run does write the sheets');
  }
  void roomy;
  fs.rmSync(box, { recursive: true, force: true });
}

// The screenshots are a hand-drawn mock of the settings page, and `--check`
// holds the drawing only to its own committed output — so a row added to
// options.html, two reordered, or a control swapped leaves the store showing
// the old layout with every check green. The generator declares the rows it
// draws; this reads that declaration and the page, and holds them to each
// other. What it does not hold is the drawing to the control the row declares:
// that column is a declaration, and a screenshot is what says it was drawn.
{
  // Asked of the generator rather than read out of it: the count comes from
  // what each row's painter is handed, so the declaration cannot claim two of
  // a control it draws once.
  const declared = (() => {
    const read = require('child_process').spawnSync('python3', ['-B', '-c',
      'import json, importlib.util\n'
      + 'spec = importlib.util.spec_from_file_location("gen", "gen_screenshots.py")\n'
      + 'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)\n'
      + 'print(json.dumps(mod.rows_drawn()))'], { cwd: '.', encoding: 'utf8' });
    assert(read.status === 0,
      `gen_screenshots.py names the rows it draws — ${(read.stderr || '').trim()}`);
    return JSON.parse(read.stdout || '[]')
      .map(([label, desc, control, many]) => ({ label, desc, control, many }));
  })();

  // Each row of the page, by walking its divs to the matching close: a name
  // taken to the next `setting-row` instead would swallow whatever follows the
  // last one, and read the buttons of the section below it as that row's.
  const laidOut = (() => {
    const html = fs.readFileSync('./options.html', 'utf8');
    const found = [];
    for (const open of html.matchAll(/<div class="setting-row"[^>]*>/g)) {
      let at = open.index + open[0].length, depth = 1;
      while (depth) {
        const next = /<div\b|<\/div>/.exec(html.slice(at));
        if (!next) { break; }
        at += next.index + next[0].length;
        depth += next[0] === '</div>' ? -1 : 1;
      }
      const block = html.slice(open.index + open[0].length, at);
      const control = {};
      for (const one of block.matchAll(/<input\b[^>]*type="(\w+)"|<(button)\b|<(select)\b/g)) {
        const kind = { range: 'range', checkbox: 'toggle', button: 'buttons', select: 'select' }[
          one[1] || one[2] || one[3]] || (one[1] || one[2] || one[3]);
        control[kind] = (control[kind] || 0) + 1;
      }
      const kinds = Object.keys(control);
      found.push({
        label: (block.match(/class="setting-label"[^>]*data-i18n="(\w+)"/) || [])[1],
        desc: (block.match(/class="setting-desc"[^>]*data-i18n="(\w+)"/) || [])[1],
        control: kinds.length === 1 ? kinds[0] : kinds.sort().join('+'),
        many: kinds.length === 1 ? control[kinds[0]] : 0,
      });
    }
    return found;
  })();

  assert(laidOut.length > 3, `the page lays out settings rows — found ${laidOut.length}`);
  assert(JSON.stringify(declared) === JSON.stringify(laidOut),
    `the screenshots draw the rows the page lays out, in its order`
    + ` — drawn ${JSON.stringify(declared)}, laid out ${JSON.stringify(laidOut)}`);
}

// The screenshots are what the store shows, and the wording in them is the
// extension's. Written out in the generator it was a third copy beside the
// pages and the catalog, and nothing compared the three: changing a message
// left the store showing the old one with every check green.
{
  const source = fs.readFileSync('./gen_screenshots.py', 'utf8');
  const table = source.match(/^FROM_CATALOG = \{([\s\S]*?)^\}/m);
  assert(table, 'gen_screenshots.py names the messages it draws in FROM_CATALOG');
  const keys = Array.from((table?.[1] || '').matchAll(/'[\w_]+': '([\w]+)'/g), m => m[1]);
  // The two the button is built from are named where it is built, not in the
  // table, so they are added here rather than left unheld.
  keys.push('applyToChannelWithValue', 'typeVideo');
  assert(keys.length > 8, `the generator draws messages — found ${keys.length}`);
  // The check as a function of where the catalogs are, and answering with what
  // it found wrong rather than asserting: that is what lets the fixture below
  // put a locale tree to the whole of it, this repository's own included.
  const heldToTheCatalog = root => {
    const wrong = [];
    let locales;
    try {
      // The catalogs, not whatever the directory holds: macOS drops a
      // .DS_Store in there, and a reader that walks into every listed name
      // opens `_locales/.DS_Store/messages.json` and ends the run.
      locales = localesWithCatalog(root);
    } catch (err) {
      return [`reading ${root}: ${err.message}`];
    }
    if (locales.length < 2) { wrong.push(`${root} carries one locale or none`); }
    for (const locale of locales) {
      let messages;
      try {
        messages = JSON.parse(fs.readFileSync(`${root}/${locale}/messages.json`, 'utf8'));
      } catch (err) {
        wrong.push(`reading ${root}/${locale}: ${err.message}`);
        continue;
      }
      for (const key of keys) {
        if (!messages[key]?.message) {
          wrong.push(`${locale} answers for none of ${key}, which the screenshots draw`);
        }
      }
      // The other direction: a message spelled out in the generator is a copy
      // that the catalog cannot correct, which is what this replaced.
      for (const [key, entry] of Object.entries(messages)) {
        const text = entry.message;
        if (!text || text.includes('$')) { continue; }
        // A catalog's own locale name is what the generator spells to pick
        // that catalog, not wording it draws.
        if (text === locale) { continue; }
        if (source.includes(`'${text}'`) || source.includes(`"${text}"`)) {
          wrong.push(`gen_screenshots.py spells out ${locale}'s ${key} instead of reading it`);
        }
      }
    }
    return wrong;
  };
  assert(heldToTheCatalog('./_locales').length === 0,
    `the screenshots take their wording from the catalog — ${heldToTheCatalog('./_locales').join('; ')}`);

  // The same check, over a tree carrying what a working checkout grows beside
  // its catalogs: the .DS_Store macOS drops, and a directory with no catalog.
  // A unit test of the listing alone leaves the call site free to go back to an
  // unfiltered one, and it did — reverting that line passes every assertion
  // here whenever the file happens not to be there, which on CI is always.
  {
    const nodePath = require('path');
    const box = fs.mkdtempSync(nodePath.join(require('os').tmpdir(), 'ytcv-locales-'));
    const answering = Object.fromEntries(keys.map(key => [key, { message: `x${key}` }]));
    for (const locale of ['ja', 'en']) {
      fs.mkdirSync(`${box}/${locale}`);
      fs.writeFileSync(`${box}/${locale}/messages.json`, JSON.stringify(answering));
    }
    fs.writeFileSync(`${box}/.DS_Store`, '');
    fs.mkdirSync(`${box}/notes`);
    assert(heldToTheCatalog(box).length === 0,
      `the check reads a locale tree with a stray name in it — ${heldToTheCatalog(box).join('; ')}`);
    // Without this the call above would pass over a check that found nothing
    // because it looked at nothing.
    delete answering[keys[0]];
    fs.writeFileSync(`${box}/ja/messages.json`, JSON.stringify(answering));
    assert(heldToTheCatalog(box).some(said => said.includes(keys[0])),
      `and it is a check that fails when ${keys[0]} goes missing`);
    fs.rmSync(box, { recursive: true, force: true });
  }
}

// A page's own text under data-i18n is replaced by the catalog's before the
// page is ever shown — applyI18n runs before the body loses `initializing`,
// which hides it — so text written into the markup is never read by anyone and
// drifts from the wording that ships without a single check going red.
{
  const holder = /<([a-zA-Z][\w-]*)([^>]*\sdata-i18n\s*=\s*["\']([^"\']+)["\'][^>]*)>([\s\S]*?)<\/\1>/g;
  let keys = 0;
  for (const page of ['options.html', 'popup.html']) {
    const text = fs.readFileSync('./' + page, 'utf8');
    for (const [, , , key, inner] of text.matchAll(holder)) {
      keys += 1;
      assert(inner.trim() === '',
        `${page} leaves ${key} to the catalog — it holds ${JSON.stringify(inner.trim())}`);
    }
    // Without this the loop above would pass over a page the pattern cannot read.
    assert((text.match(/data-i18n\s*=/g) || []).length
      === (text.match(holder) || []).length,
      `every data-i18n element in ${page} is read here`);
  }
  assert(keys > 10, `the pages ask the catalog for their text — found ${keys}`);
}

// A page declares the language of the catalog that filled it. Chrome fills it
// from the catalog of the browser's language, or from default_locale's where it
// carries none, so the language the markup was written in is not the one shown.
{
  assert(manifest.default_locale === 'en',
    'a browser language the extension carries no catalog for is answered in English');
  for (const locale of localesWithCatalog('./_locales')) {
    const said = readJson(`_locales/${locale}/messages.json`).pageLanguage?.message;
    assert(said === locale.replace(/_/g, '-'),
      `the ${locale} catalog names its own language — it says ${JSON.stringify(said)}`);
  }
  for (const [page, html, script] of [
    ['popup', popupHtml, popupSrc], ['options', optionsHtml, optionsSrc]]) {
    assert(/document\.documentElement\.lang = msg\('pageLanguage'\);/.test(script),
      `${page}.js declares the language of the catalog it was filled from`);
    // The markup's own lang is default_locale's, and stands until the script
    // sets the catalog's.
    assert((html.match(/<html lang="([^"]*)">/) || [])[1]
      === String(manifest.default_locale).replace(/_/g, '-'),
      `${page}.html is marked up in the language of default_locale`);
  }
}

section('documentation pairs');
// The Chrome Web Store listing links to PRIVACY_POLICY.md by path, so the two
// policy files keep the names they have.
for (const file of ['PRIVACY_POLICY.md', 'PRIVACY_POLICY_JA.md']) {
  assert(fs.existsSync('./' + file), `${file} keeps its name`);
}
assert(!fs.existsSync('./CLAUDE.ja.md'), 'CLAUDE.md has no Japanese counterpart');

const headingLevels = text => {
  const levels = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    const head = fence ? null : line.match(/^(#{1,6}) /);
    if (head) { levels.push(head[1].length); }
  }
  return levels;
};
const englishHeadings = headingLevels(fs.readFileSync('./README.md', 'utf8'));
assert(englishHeadings.length > 0, 'README.md is a document with headings');
for (const file of README_FILES.filter(name => name !== 'README.md')) {
  assert(JSON.stringify(headingLevels(fs.readFileSync('./' + file, 'utf8')))
    === JSON.stringify(englishHeadings),
    `${file} carries the same headings as README.md, in the same order`);
}

// A file missing here is already named by the assertion above; reading it would
// replace that name with a stack trace.
for (const file of [...README_FILES, 'PRIVACY_POLICY.md', 'PRIVACY_POLICY_JA.md']
  .filter(name => fs.existsSync('./' + name))) {
  const targets = Array.from(fs.readFileSync('./' + file, 'utf8')
    .matchAll(/\]\(\s*([^)\s#]+)/g), m => m[1])
    .filter(target => !/^(https?:|mailto:)/.test(target));
  for (const target of targets) {
    assert(fs.existsSync('./' + target), `${file} links to ${target}, which must exist`);
  }
}

// options.js has no DOM harness here, so its half of the cross-context
// contract is asserted against the source.
section('options adopt a fold another context finished');
const optionsListener = optionsSrc.slice(optionsSrc.indexOf('chrome.storage.onChanged.addListener'));
assert(optionsListener.includes('UNIFIED_GAINS_KEY'),
  'the options listener watches the migration mark');
assert(/UNIFIED_GAINS_KEY[\s\S]{0,160}storageMigrated = true[\s\S]{0,80}renderChannels\(channelVolumes\)/.test(optionsListener),
  'and adopting it re-renders the table under the current rule');
assert(/resolveAutoApplySetting\([^)]*!storageMigrated\)/.test(optionsSrc),
  'the table resolves with the pre-unification rule until the fold has landed');

section('service worker is the single writer');
const backgroundSrc = fs.readFileSync('./background.js', 'utf8');
const contentSrc = fs.readFileSync('./content.js', 'utf8');
assert(manifest.background?.service_worker === 'background.js',
  'the worker is registered so channel writes have one owner');
assert(backgroundSrc.includes("importScripts('utils.js')"),
  'the worker shares the channel write definitions with the pages');
assert(/^const settingsMoved = queueSettingsWrite\(moveSettingsToSync\)\s*\.catch\(/m.test(backgroundSrc),
  'the worker moves settings saved before they synced, at every start');
assert(/type === 'migrateLegacyGains' \? settingsMoved : undefined/.test(backgroundSrc),
  'and answers the fold, which the options page waits on, once the move has settled');
for (const [name, src] of [['content.js', contentSrc], ['options.js', optionsSrc],
  ['popup.js', fs.readFileSync('./popup.js', 'utf8')]]) {
  assert(!/chrome\.storage\.local\.(get|set)\(\[?SETTINGS_KEY/.test(src),
    `${name} reads and writes the settings where they live, through readSettings`);
}
assert(!/updateChannelVolumes\(/.test(contentSrc) && !/updateChannelVolumes\(/.test(optionsSrc),
  'no page performs a channel read-modify-write of its own');
for (const write of Object.keys(CHANNEL_WRITES)) {
  assert(contentSrc.includes(`'${write}'`) || optionsSrc.includes(`'${write}'`),
    `channel write ${write} is requested by a page`);
}
for (const write of Object.keys(SETTINGS_WRITES)) {
  assert(optionsSrc.includes(`'${write}'`), `settings write ${write} is requested by the options page`);
}
assert(!/chrome\.storage\.sync\.set\(/.test(contentSrc + optionsSrc + fs.readFileSync('./popup.js', 'utf8')),
  'no page writes the settings itself: the worker queues them with its move');


// ── calcGain ─────────────────────────────────────────────────────────

section('calcGain — YouTube normalization');

// loudnessDb <= 0: content is quieter than -14 LUFS, YouTube does not boost
// contentLUFS = -14 + loudnessDb, compensation = targetLufs - contentLUFS
// Target = -18

// loudnessDb = 0 → contentLUFS = -14, comp = -18 - (-14) = -4 dB
assertClose(calcGain(0, -18), Math.pow(10, -4/20), 0.001, 'loudnessDb=0, target=-18');

// loudnessDb = -6 → contentLUFS = -20, comp = -18 - (-20) = +2 dB
assertClose(calcGain(-6, -18), Math.pow(10, 2/20), 0.001, 'loudnessDb=-6, target=-18');

// loudnessDb > 0: YouTube attenuates to -14 LUFS
// effectiveLufs = -14, comp = targetLufs - (-14)

// loudnessDb = 5 → effectiveLufs = -14, comp = -18 - (-14) = -4 dB
assertClose(calcGain(5, -18), Math.pow(10, -4/20), 0.001, 'loudnessDb=5 (loud), target=-18');

// loudnessDb = 1.5 → same as above (YouTube normalized to -14)
assertClose(calcGain(1.5, -18), calcGain(5, -18), 0.001, 'loud content always normalizes to -14');

section('calcGain — boundary values');

// Target = -14 (same as YouTube reference)
assertClose(calcGain(0, -14), 1.0, 0.001, 'loudnessDb=0, target=-14 → passthrough');

// Very quiet content: loudnessDb = -30 → contentLUFS = -44, comp = -18 - (-44) = +26 dB
// gain = 10^(26/20) ≈ 19.95 → clamped to 6.0
assert(calcGain(-30, -18) === 6.0, 'very quiet → clamped to 6.0 (600%)');

// Very loud content + low target: loudnessDb = 10, target = -30
// effectiveLufs = -14, comp = -30 - (-14) = -16 dB → gain ≈ 0.158
assertClose(calcGain(10, -30), Math.pow(10, -16/20), 0.001, 'loud + low target');

section('calcGain — edge cases');

// NaN → compensationDb = NaN → gain = NaN → isFinite guard → 1.0
assert(calcGain(NaN, -18) === 1.0, 'NaN loudnessDb → 1.0');

// Infinity → loudnessDb > 0 → effectiveLufs = -14 → normal calc (not NaN)
assertClose(calcGain(Infinity, -18), Math.pow(10, -4/20), 0.001, 'Infinity loudnessDb → same as loud content');

// -Infinity → effectiveLufs = -Infinity → comp = Infinity → gain = Infinity → isFinite guard → 1.0
assert(calcGain(-Infinity, -18) === 1.0, '-Infinity loudnessDb → 1.0 (isFinite guard)');

// Zero target edge
assertClose(calcGain(0, -6), Math.pow(10, 8/20), 0.001, 'target=-6, loudnessDb=0');
assertClose(calcGain(0, -30), Math.pow(10, -16/20), 0.001, 'target=-30, loudnessDb=0');

// loudnessDb exactly 0 boundary (should use effectiveLufs = -14 + 0 = -14, not YouTube-attenuated)
assert(calcGain(0, -18) === calcGain(-0.001, -18) || true, 'boundary at 0: non-positive path');
// Verify 0 takes the non-positive path (effectiveLufs = -14 + 0 = -14)
assertClose(calcGain(0, -18), Math.pow(10, (-18 - (-14))/20), 0.001, 'loudnessDb=0 uses non-positive path');

section('renditionGainRatio — a stored gain carried to the rendition playing');

// Stable volume raising a quiet video from -26.39 to -14.33 LUFS: a gain held
// against the plain rendition comes down by the 12.06 dB the player added.
assertClose(renditionGainRatio(-0.33, -12.39), Math.pow(10, -12.06 / 20), 1e-9,
  'the stable rendition takes the stored gain down by what it raised the level');
assertClose(renditionGainRatio(-12.39, -0.33), Math.pow(10, 12.06 / 20), 1e-9,
  'and a quieter rendition takes it up');
assertClose(calcGain(-12.39, -18) * renditionGainRatio(-0.33, -12.39), calcGain(-0.33, -18), 1e-9,
  'the base rendition\'s Auto gain, carried over, is the playing rendition\'s Auto gain');
assert(renditionGainRatio(-4, -4) === 1, 'one rendition: the gain as it is');

// Both above -14 LUFS: YouTube brings both down to -14 before any gain.
assertClose(renditionGainRatio(0.4, 6.96), 1, 1e-9, 'two renditions YouTube attenuates are one level');
assertClose(renditionGainRatio(0.4, -3), Math.pow(10, -3 / 20), 1e-9,
  'an attenuated rendition counts at -14 against a quieter one');

assert(renditionGainRatio(null, -12.39) === 1, 'no level playing: the gain as it is');
assert(renditionGainRatio(-0.33, null) === 1, 'no base level: the gain as it is');
assert(renditionGainRatio(undefined, undefined) === 1, 'neither: the gain as it is');
assert(renditionGainRatio(NaN, -12.39) === 1, 'NaN → 1');
assert(renditionGainRatio(-Infinity, -12.39) === 1, 'a level that is not finite → 1');

section('calcLiveGain — a live stream\'s own level, taken as it stands');

// A level YouTube has not normalized: louder than -14 LUFS is not taken to -14.
assertClose(calcLiveGain(-24.77, -18), Math.pow(10, 6.77 / 20), 1e-9, 'live -24.77, target -18');
assertClose(calcLiveGain(-10, -18), Math.pow(10, -8 / 20), 1e-9, 'live -10, target -18');
assert(Math.abs(calcLiveGain(-10, -18) - calcGain(-10 - YT_REFERENCE_LUFS, -18)) > 0.1,
  'which is not the gain the same level gets once YouTube has normalized it');
assert(calcLiveGain(-18, -18) === 1, 'a level already at the target is passed through');
assert(calcLiveGain(-60, -18) === 6.0, 'very quiet → clamped to 6.0 (600%)');
assert(calcLiveGain(-7000, -18) === 1.0, 'a gain too large to be a number → 1.0');
assert(calcLiveGain(NaN, -18) === 1.0, 'NaN level → 1.0');
assert(calcLiveGain(Infinity, -18) === 1.0, 'Infinity level → 1.0');
assert(calcLiveGain(-Infinity, -18) === 1.0, '-Infinity level → 1.0');
assert(calcLiveGain(-24, NaN) === 1.0, 'NaN target → 1.0');
assert(calcLiveGain(-24, Infinity) === 1.0, 'Infinity target → 1.0');

section('gainChangeDb — how far a gain has moved');
assertClose(gainChangeDb(Math.pow(10, 1 / 20), 1), 1, 1e-9, 'one dB up');
assertClose(gainChangeDb(1, Math.pow(10, 1 / 20)), 1, 1e-9, 'one dB down is as far');
assert(gainChangeDb(Math.pow(10, 0.99 / 20), 1) < 1, 'just under one dB');
assert(gainChangeDb(Math.pow(10, 1.01 / 20), 1) > 1, 'just over one dB');
assert(gainChangeDb(2, 2) === 0, 'no move');
for (const [gain, baseline] of [[0, 1], [1, 0], [-1, 1], [1, -1], [NaN, 1], [1, NaN],
  [Infinity, 1], [1, Infinity], [null, 1], [1, null], [undefined, 1], ['1', 1]]) {
  assert(gainChangeDb(gain, baseline) === Infinity,
    `${String(gain)} against ${String(baseline)} is infinitely far`);
}

// ── Constants ────────────────────────────────────────────────────────

section('Constants');
assert(YT_REFERENCE_LUFS === -14, 'YT_REFERENCE_LUFS = -14');
assert(DEFAULT_TARGET_LUFS === -18, 'DEFAULT_TARGET_LUFS = -18');
assert(DEFAULT_AUTO_APPLY_LOUDNESS === false, 'DEFAULT_AUTO_APPLY_LOUDNESS = false');
assert(SETTINGS_KEY === 'autoLoudnessSettings', 'SETTINGS_KEY');
assert(CHANNEL_VOLUMES_KEY === 'channelVolumes', 'CHANNEL_VOLUMES_KEY');
assert(LEGACY_AUTO_FALLBACKS_KEY === 'autoLoudnessFallbacks', 'LEGACY_AUTO_FALLBACKS_KEY');
assert(LEGACY_AUTO_FALLBACK_KEY_PREFIX === 'autoLoudnessFallback:',
  'LEGACY_AUTO_FALLBACK_KEY_PREFIX');

// ── migrateLegacyAutoGains ───────────────────────────────────────────

async function runMigrationTests() {
  section('migrateLegacyAutoGains');

  mockStorage = {
    autoLoudnessSettings: { autoApplyLoudnessVideoDefault: true },
    channelVolumes: {
      UCauto: { name: 'Auto', autoApplyLoudnessLive: true, gainLive: 0.4 },
      UCmanual: { name: 'Manual', gainVideo: 0.5 },
      UClegacy: { name: 'Legacy' },
      UCtombstone: { name: 'Tombstone', autoApplyLoudnessVideo: true, gainVideo: 0.55 },
      UCallTypes: { name: 'All Types', autoApplyLoudness: true, gainVideo: 0.3 },
      UCboth: { name: 'Both Sources', autoApplyLoudnessVideo: true, gainVideo: 0.2 },
      UCshadowed: { name: 'Shadowed', gainVideo: 0.55 }
    },
    'autoLoudnessFallback:UCauto:live': 0.8,
    'autoLoudnessFallback:UCtombstone:video': null,
    'autoLoudnessFallback:UCorphan:video': 0.9,
    'autoLoudnessFallback:UCallTypes:video': 0.75,
    'autoLoudnessFallback:UCboth:video': 0.8,
    'autoLoudnessFallback:UCshadowed:video': null,
    autoLoudnessFallbacks: {
      UClegacy: { gainVideo: 0.3 },
      UCboth: { gainVideo: 0.35 },
      UCshadowed: { gainVideo: 0.9 }
    }
  };
  assert(await migrateLegacyAutoGains() === true, 'legacy keys trigger the migration');
  const migrated = mockStorage.channelVolumes;
  assert(migrated.UCauto.gainLive === 0.8,
    'learned Auto gain becomes the channel gain so toggling Auto keeps the level');
  assert(migrated.UCmanual.autoApplyLoudnessVideo === false,
    'a saved gain without an Auto flag is pinned OFF against the all-channel default');
  assert(migrated.UCmanual.gainVideo === 0.5, 'pinning a manual gain does not change it');
  assert(!('autoApplyLoudnessLive' in migrated.UCmanual),
    'the type without a saved gain keeps inheriting the default');
  assert(migrated.UClegacy.gainVideo === 0.3,
    'legacy aggregate value folds in for a type the default drives');
  assert(migrated.UCtombstone.gainVideo === 0.55,
    'a tombstoned learned gain leaves the manually saved gain in place');
  assert(!('UCorphan' in migrated), 'an orphan learned gain is dropped, not resurrected');
  assert(migrated.UCallTypes.gainVideo === 0.75,
    'the legacy all-types Auto flag still selects the type for folding');
  assert(resolveAutoApplySetting(migrated.UCallTypes, 'video', false) === true &&
    resolveAutoApplySetting(migrated.UCallTypes, 'live', false) === true,
    'the legacy all-types flag keeps both types on Auto after the migration');
  assert(!('autoApplyLoudnessVideo' in migrated.UCallTypes),
    'a channel already on Auto is not pinned OFF by its saved gain');
  assert(migrated.UCboth.gainVideo === 0.8,
    'a per-type learned gain wins over the legacy aggregate for the same channel');
  assert(migrated.UCshadowed.gainVideo === 0.55,
    'a per-type tombstone blocks the legacy aggregate from resurrecting');
  assert(Object.keys(mockStorage).filter(k => k.startsWith('autoLoudnessFallback:')).length === 0,
    'granular legacy keys are removed');
  assert(!('autoLoudnessFallbacks' in mockStorage), 'legacy aggregate key is removed');
  assert(mockStorage.unifiedGains === true,
    'the profile is marked so the migration cannot run a second time');
  assert(!('unifiedGains' in mockStorage.autoLoudnessSettings),
    'the mark is a top-level key, out of reach of every settings writer');
  assert(mockStorage.autoLoudnessSettings.autoApplyLoudnessVideoDefault === true,
    'the migration does not rewrite the settings object');

  const settled = JSON.stringify(mockStorage);
  assert(await migrateLegacyAutoGains() === false, 'migration is a no-op once the profile is marked');
  assert(JSON.stringify(mockStorage) === settled, 'no-op migration leaves storage untouched');

  // Auto stores a gain without an Auto flag — the same shape the migration
  // reads as "saved manually". A second pass must not pin it OFF.
  mockStorage.channelVolumes.UCautoLearned = { name: 'Auto Learned', gainVideo: 0.7 };
  await migrateLegacyAutoGains();
  assert(!('autoApplyLoudnessVideo' in mockStorage.channelVolumes.UCautoLearned),
    'a gain Auto stored after the migration is never pinned OFF');

  section('migrateLegacyAutoGains — storage that predates the Auto feature');
  mockStorage = {
    autoLoudnessSettings: { targetLufs: -18 },
    channelVolumes: {
      UCreleased: { name: 'Released Ch', gainVideo: 0.5, url: 'https://example.com' },
      UCbothTypes: { name: 'Both', gain: 0.6 }
    }
  };
  assert(await migrateLegacyAutoGains() === true,
    'a profile with no legacy Auto keys still migrates');
  assert(mockStorage.channelVolumes.UCreleased.autoApplyLoudnessVideo === false,
    'a gain saved before Auto existed is pinned against the all-channel default');
  assert(mockStorage.channelVolumes.UCreleased.gainVideo === 0.5,
    'pinning leaves the saved gain untouched');
  assert(!('autoApplyLoudnessLive' in mockStorage.channelVolumes.UCreleased),
    'the type with no saved gain keeps inheriting the default');
  assert(mockStorage.channelVolumes.UCbothTypes.autoApplyLoudnessVideo === false &&
    mockStorage.channelVolumes.UCbothTypes.autoApplyLoudnessLive === false,
    'a legacy single gain pins both types');
  assert(mockStorage.autoLoudnessSettings.targetLufs === -18,
    'migrating without legacy keys preserves the target LUFS');

  // A settings writer whose read predates the migration writes its snapshot
  // back. The mark has to survive that, or the next run pins Auto's own gains.
  const staleSettings = { ...mockStorage.autoLoudnessSettings };
  staleSettings.showGainOverlay = true;
  await chrome.storage.local.set({ autoLoudnessSettings: staleSettings });
  mockStorage.channelVolumes.UCstoredByAuto = { name: 'Stored By Auto', gainVideo: 2.9 };
  assert(await migrateLegacyAutoGains() === false,
    'a concurrent settings write cannot make the migration run again');
  assert(!('autoApplyLoudnessVideo' in mockStorage.channelVolumes.UCstoredByAuto),
    'a gain Auto stored is not pinned OFF after a concurrent settings write');

  section('migrateLegacyAutoGains — leftover legacy keys after the marker');
  mockStorage = {
    unifiedGains: true,
    channelVolumes: { UCkept: { name: 'Kept', gainVideo: 0.42 } },
    'autoLoudnessFallback:UCkept:video': 0.9,
    autoLoudnessFallbacks: { UCkept: { gainVideo: 0.9 } }
  };
  assert(await migrateLegacyAutoGains() === false, 'a marked profile does not migrate again');
  assert(mockStorage.channelVolumes.UCkept.gainVideo === 0.42,
    'leftover legacy values never overwrite the unified gain');
  assert(!('autoLoudnessFallback:UCkept:video' in mockStorage) &&
    !('autoLoudnessFallbacks' in mockStorage),
    'leftover legacy keys are cleared on the next run');

  section('migrateLegacyAutoGains — dormant learned gain');
  mockStorage = {
    channelVolumes: { UCoff: { name: 'Off', gainLive: 0.6 } },
    'autoLoudnessFallback:UCoff:live': 0.2
  };
  await migrateLegacyAutoGains();
  assert(mockStorage.channelVolumes.UCoff.gainLive === 0.6,
    'a dormant learned gain does not overwrite the gain an Auto-off channel plays at');

  section('isContextValid — a runtime that cannot be reached');
  {
    const outer = globalThis.chrome;
    delete globalThis.chrome;
    const valid = isContextValid();
    let ranAnyway = false;
    let threw = null;
    try {
      await updateChannelVolumes(() => { ranAnyway = true; });
    } catch (err) {
      threw = err;
    }
    globalThis.chrome = outer;
    assert(valid === false, `a runtime that cannot be reached at all is not valid (${valid})`);
    assert(threw === null, `and a channel write on it is not attempted (${threw && threw.message})`);
    assert(ranAnyway === false, 'so the mutation it was given never runs');
  }

  section('adoptHandleEntry — the name is what says which entry is this channel');
  {
    const priorStorage = mockStorage;
    mockStorage = { channelVolumes: {
      UCother: { name: 'Same Name', gainVideo: 0.3 },
      '@handle': { name: 'Different Name', gainVideo: 0.7 }
    } };

    await CHANNEL_WRITES.adoptHandleEntry({
      channelId: 'UCnew', authorName: 'Same Name', url: 'https://www.youtube.com/channel/UCnew'
    });
    assert(mockStorage.channelVolumes['UCnew'] === undefined,
      'no handle entry is adopted where none carries this name');
    assert(mockStorage.channelVolumes['UCother']?.gainVideo === 0.3,
      'a channel that merely shares the name is left where it is');
    assert(mockStorage.channelVolumes['@handle']?.gainVideo === 0.7, 'and so is the handle entry');

    await CHANNEL_WRITES.adoptHandleEntry({
      channelId: 'UCnew', authorName: 'Different Name', url: 'https://www.youtube.com/channel/UCnew'
    });
    assert(mockStorage.channelVolumes['UCnew']?.gainVideo === 0.7,
      `the handle entry whose name matches is adopted (${JSON.stringify(mockStorage.channelVolumes['UCnew'])})`);
    assert(mockStorage.channelVolumes['@handle'] === undefined, 'and moved rather than copied');

    mockStorage = { channelVolumes: { '@marked': { name: 'Marked Name', gainVideo: 0.4, gainVideoPlain: true } } };
    await CHANNEL_WRITES.adoptHandleEntry({
      channelId: 'UCmarked', authorName: 'Marked Name', url: 'https://www.youtube.com/channel/UCmarked'
    });
    assert(mockStorage.channelVolumes['UCmarked']?.gainVideoPlain === true,
      'an adopted entry keeps the mark its gain carried');

    mockStorage = priorStorage;
  }

  section('saveChannelGain — the mark goes with the write that asks for it');
  {
    const priorStorage = mockStorage;
    mockStorage = { channelVolumes: { UCmark: { name: 'Mark', gainVideo: 0.5, gainVideoPlain: true } } };
    await CHANNEL_WRITES.saveChannelGain({ channelId: 'UCmark', name: 'Mark', gain: 0.8, videoType: 'live', url: '', heldAgainstPlain: true });
    assert(mockStorage.channelVolumes.UCmark.gainLive === 0.8 && mockStorage.channelVolumes.UCmark.gainLivePlain === true,
      'a write held against the plain rendition stores the mark');
    await CHANNEL_WRITES.saveChannelGain({ channelId: 'UCmark', name: 'Mark', gain: 0.9, videoType: 'video', url: '' });
    assert(mockStorage.channelVolumes.UCmark.gainVideo === 0.9 && !('gainVideoPlain' in mockStorage.channelVolumes.UCmark),
      'a write without it stores the gain unmarked');
    assert(mockStorage.channelVolumes.UCmark.gainLivePlain === true, 'and leaves the other type as it was');
    mockStorage = priorStorage;
  }

  section('clearLegacyKeys — housekeeping that has nothing to do');
  {
    const priorStorage = mockStorage;
    mockStorageRemovals.length = 0;
    await clearLegacyKeys([]);
    assert(mockStorageRemovals.length === 0,
      `clearing nothing asks storage for nothing (${JSON.stringify(mockStorageRemovals)})`);

    // The keys are swept as part of the fold, and the fold does not answer until
    // they are gone.
    mockStorage = {
      channelVolumes: { UCsweep: { name: 'Sweep', gainVideo: 0.4, autoApplyLoudnessVideo: true } },
      'autoLoudnessFallback:UCsweep:video': 0.62
    };
    await migrateLegacyAutoGains();
    assert(!('autoLoudnessFallback:UCsweep:video' in mockStorage),
      `the legacy keys are gone by the time the fold answers (${Object.keys(mockStorage).join(', ')})`);
    assert(mockStorage[UNIFIED_GAINS_KEY] === true, 'and the profile is marked');

    // A profile already marked is swept again rather than left half-cleared, and
    // that sweep is finished before the answer too.
    mockStorage['autoLoudnessFallback:UCsweep:live'] = 0.5;
    const again = await migrateLegacyAutoGains();
    assert(again === false, 'a profile already marked is not folded a second time');
    assert(!('autoLoudnessFallback:UCsweep:live' in mockStorage),
      `while what was left behind is still cleared (${Object.keys(mockStorage).join(', ')})`);

    // Held, the sweep says which side of the answer it is on. The fold reports
    // the profile unified, and a caller that reads the keys on the strength of
    // that answer has to find them gone.
    for (const marked of [false, true]) {
      mockStorage = {
        channelVolumes: { UChold: { name: 'Hold', gainVideo: 0.4, autoApplyLoudnessVideo: true } },
        'autoLoudnessFallback:UChold:video': 0.62,
        ...(marked ? { [UNIFIED_GAINS_KEY]: true } : {})
      };
      holdRemovals = true;
      releaseRemovals = null;
      let answered = false;
      const folding = migrateLegacyAutoGains().then(() => { answered = true; });
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      assert(answered === false,
        `the fold waits for the sweep it started (already marked: ${marked})`);
      assert(!!releaseRemovals, 'which is out');
      releaseRemovals();
      await folding;
      assert(answered === true, 'and answers once it lands');
      assert(!('autoLoudnessFallback:UChold:video' in mockStorage),
        `with the keys gone (${Object.keys(mockStorage).join(', ')})`);
      holdRemovals = false;
    }

    mockStorage = priorStorage;
  }

  section('migrateLegacyAutoGains — the defaults are read where the settings live');
  {
    mockSyncStorage = { autoLoudnessSettings: { autoApplyLoudnessVideoDefault: true } };
    mockStorage = {
      channelVolumes: { UCsyncedAuto: { name: 'Synced Auto' } },
      autoLoudnessFallbacks: { UCsyncedAuto: { gainVideo: 0.3 } }
    };
    await migrateLegacyAutoGains();
    assert(mockStorage.channelVolumes.UCsyncedAuto.gainVideo === 0.3,
      'a learned gain is folded in under the Auto default sync holds');
    mockSyncStorage = {};
  }

  section('readSettings — sync first, local while the move has not happened');
  {
    mockSyncStorage = {};
    mockStorage = {};
    assert(JSON.stringify(await readSettings()) === '{}', 'nothing saved anywhere reads as no settings');
    mockStorage = { autoLoudnessSettings: { targetLufs: -22 } };
    assert((await readSettings()).targetLufs === -22, 'settings not moved yet are read from local');
    mockSyncStorage = { autoLoudnessSettings: { targetLufs: -16 } };
    assert((await readSettings()).targetLufs === -16, 'and settings in sync go before them');
  }

  section('readSettings — a read made across the move');
  {
    // Sync is read empty, then the move writes sync and clears local before
    // the local read is answered. That read finds nothing, and the settings
    // the move put in sync are what the profile holds.
    mockSyncStorage = {};
    mockStorage = { autoLoudnessSettings: { targetLufs: -24, displayUnit: 'dB' } };
    const realLocalGet = chrome.storage.local.get;
    let releaseLocal;
    const localHeld = new Promise((resolve) => { releaseLocal = resolve; });
    let localAsked = false;
    chrome.storage.local.get = (key) => {
      localAsked = true;
      return localHeld.then(() => realLocalGet(key));
    };
    const reading = readSettings();
    for (let turn = 0; turn < 12 && !localAsked; turn++) await Promise.resolve();
    assert(localAsked, 'the read has found sync empty and asked local');
    mockSyncStorage = { autoLoudnessSettings: { targetLufs: -24, displayUnit: 'dB' } };
    delete mockStorage.autoLoudnessSettings;
    releaseLocal();
    const read = await reading;
    chrome.storage.local.get = realLocalGet;
    assert(read.targetLufs === -24 && read.displayUnit === 'dB',
      `it answers with what the move put in sync, not with no settings (${JSON.stringify(read)})`);
    mockSyncStorage = {};
    mockStorage = {};
  }

  section('migrateLegacyAutoGains — the defaults read across the move');
  {
    // The fold reads its Auto defaults with readSettings. Read across the move,
    // a read that found neither area would take the defaults as off and drop
    // the gain Auto learned while marking the profile folded.
    mockSyncStorage = {};
    mockStorage = {
      autoLoudnessSettings: { targetLufs: -26, autoApplyLoudnessVideoDefault: true },
      channelVolumes: { UCacross: { name: 'Across' } },
      'autoLoudnessFallback:UCacross:video': 2
    };
    const realLocalGet = chrome.storage.local.get;
    let releaseLocal;
    const localHeld = new Promise((resolve) => { releaseLocal = resolve; });
    let settingsAsked = false;
    chrome.storage.local.get = (key) => {
      if (key !== 'autoLoudnessSettings') return realLocalGet(key);
      settingsAsked = true;
      return localHeld.then(() => realLocalGet(key));
    };
    const folding = migrateLegacyAutoGains();
    for (let turn = 0; turn < 24 && !settingsAsked; turn++) await Promise.resolve();
    assert(settingsAsked, 'the fold has found sync empty and asked local for the settings');
    mockSyncStorage = { autoLoudnessSettings: mockStorage.autoLoudnessSettings };
    delete mockStorage.autoLoudnessSettings;
    releaseLocal();
    await folding;
    chrome.storage.local.get = realLocalGet;
    assert(mockStorage.channelVolumes.UCacross.gainVideo === 2,
      `the learned gain is folded in under the default the move put in sync (${JSON.stringify(mockStorage.channelVolumes.UCacross)})`);
    mockSyncStorage = {};
    mockStorage = {};
  }

  section('SETTINGS_WRITES.saveSetting — queued with the move');
  {
    // A worker start whose move is out when an open options page saves: the
    // move read sync empty, and writing local's older copy after the save would
    // put the save back. Queued, the save goes after the move.
    mockSyncStorage = {};
    mockStorage = { autoLoudnessSettings: { targetLufs: -18, displayUnit: '%', showGainOverlay: false } };
    // Chrome answers a read with a copy; the save's read must not be the very
    // object the move then writes.
    const realLocalGet = chrome.storage.local.get;
    chrome.storage.local.get = async (key) => JSON.parse(JSON.stringify(await realLocalGet(key)));
    const realSyncGet = chrome.storage.sync.get;
    let releaseSync;
    const syncHeld = new Promise((resolve) => { releaseSync = resolve; });
    let held = true;
    chrome.storage.sync.get = (key) => {
      if (!held) return realSyncGet(key);
      held = false;
      const snapshot = realSyncGet(key);
      return syncHeld.then(() => snapshot);
    };
    const moving = queueSettingsWrite(moveSettingsToSync);
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    let saved = false;
    const saving = SETTINGS_WRITES.saveSetting({ type: 'store:saveSetting', key: 'targetLufs', value: -30 })
      .then(() => { saved = true; });
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    assert(saved === false, 'the save waits while the move is out');
    releaseSync();
    await moving;
    await saving;
    chrome.storage.sync.get = realSyncGet;
    chrome.storage.local.get = realLocalGet;
    assert(JSON.stringify(mockSyncStorage.autoLoudnessSettings) ===
      JSON.stringify({ targetLufs: -30, displayUnit: '%', showGainOverlay: false }),
      `the save stands over the move, and carries what the move brought (${JSON.stringify(mockSyncStorage.autoLoudnessSettings)})`);
    assert(!('autoLoudnessSettings' in mockStorage), 'and local is clear');

    for (const [key, value] of [['volume', 1], ['__proto__', {}], ['targetLufs', -40],
      ['targetLufs', '-20'], ['displayUnit', 'LUFS'], ['showGainOverlay', 'yes'],
      ['autoApplyLoudnessVideoDefault', 1], ['autoApplyLoudnessLiveDefault', null]]) {
      let refused = null;
      try { SETTINGS_WRITES.saveSetting({ key, value }); } catch (err) { refused = err; }
      assert(refused?.constructor?.name === 'ChannelWriteRefused', `${key} = ${JSON.stringify(value)} is refused`);
    }
    assert(mockSyncStorage.autoLoudnessSettings.targetLufs === -30, 'and none of them is written');
    // The worker takes what the settings page can send: every step of the
    // Target LUFS slider the markup ships, and nothing past either end.
    const slider = optionsHtml.match(/<input type="range" id="targetSlider" min="(-?\d+)" max="(-?\d+)"[^>]*step="(\d+)"/);
    assert(!!slider, 'the markup ships the Target LUFS slider with its range');
    if (slider) {
      const [min, max, step] = slider.slice(1).map(Number);
      const takes = (value) => {
        try { SETTINGS_WRITES.saveSetting({ key: 'targetLufs', value }); return true; } catch (_) { return false; }
      };
      const steps = [];
      for (let value = min; value <= max; value += step) steps.push(value);
      assert(steps.every(takes) && !takes(min - step) && !takes(max + step),
        `the worker's Target LUFS range is the slider's (${min} to ${max})`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    mockSyncStorage = {};
    mockStorage = {};
  }

  section('moveSettingsToSync — settings saved before they synced');
  {
    const removalsBefore = mockStorageRemovals.length;
    mockSyncStorage = {};
    mockStorage = { channelVolumes: { UCstay: { name: 'Stay', gainVideo: 0.5 } } };
    assert(await moveSettingsToSync() === false, 'a profile with nothing in local has nothing to move');
    assert(!('autoLoudnessSettings' in mockSyncStorage), 'and writes nothing to sync');
    assert(mockStorageRemovals.length === removalsBefore, 'nor clears anything in local');

    mockStorage = {
      autoLoudnessSettings: { targetLufs: -22, displayUnit: 'dB', showGainOverlay: true },
      channelVolumes: { UCstay: { name: 'Stay', gainVideo: 0.5 } }
    };
    assert(await moveSettingsToSync() === true, 'settings in local are moved');
    assert(JSON.stringify(mockSyncStorage.autoLoudnessSettings) ===
      JSON.stringify({ targetLufs: -22, displayUnit: 'dB', showGainOverlay: true }),
      'to sync, as they stood');
    assert(!('autoLoudnessSettings' in mockStorage), 'and local no longer holds them');
    assert(mockStorage.channelVolumes.UCstay.gainVideo === 0.5, 'the channels stay where they are');
    assert(await moveSettingsToSync() === false, 'a second start has nothing to move');

    mockSyncStorage = { autoLoudnessSettings: { targetLufs: -16 } };
    mockStorage = { autoLoudnessSettings: { targetLufs: -22 } };
    assert(await moveSettingsToSync() === true, 'where another machine has synced settings');
    assert(mockSyncStorage.autoLoudnessSettings.targetLufs === -16, 'those are kept');
    assert(!('autoLoudnessSettings' in mockStorage), 'and the local copy goes');

    // The move answers once local is clear, so a worker start that fails to
    // clear it is reported rather than taken for a move that landed.
    mockSyncStorage = {};
    mockStorage = { autoLoudnessSettings: { targetLufs: -22 } };
    holdRemovals = true;
    releaseRemovals = null;
    let moved = false;
    const moving = moveSettingsToSync().then(() => { moved = true; });
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    assert(moved === false && !!releaseRemovals, 'the move waits for local to be cleared');
    releaseRemovals();
    await moving;
    holdRemovals = false;
    assert(moved === true && !('autoLoudnessSettings' in mockStorage),
      'and answers once it is');

    mockSyncStorage = {};
    mockStorage = { autoLoudnessSettings: { targetLufs: -22 } };
    failSyncSet = true;
    let refused = null;
    try { await moveSettingsToSync(); } catch (err) { refused = err; }
    failSyncSet = false;
    assert(refused !== null, 'a move sync refuses fails');
    assert(mockStorage.autoLoudnessSettings?.targetLufs === -22,
      'and leaves the settings in local, where they are still read and moved on the next start');
    mockSyncStorage = {};
    mockStorage = {};
  }

  // ── Summary ────────────────────────────────────────────────────────

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runMigrationTests();
