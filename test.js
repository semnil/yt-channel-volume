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
globalThis.chrome = {
  runtime: { id: 'test-extension-id' },
  i18n: { getMessage: () => '' },
  storage: {
    local: {
      get(key) {
        if (key === null) return Promise.resolve(JSON.parse(JSON.stringify(mockStorage)));
        return Promise.resolve({ [key]: mockStorage[key] });
      },
      set(obj) {
        Object.assign(mockStorage, JSON.parse(JSON.stringify(obj)));
        return Promise.resolve();
      },
      remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete mockStorage[key];
        return Promise.resolve();
      }
    }
  }
};
globalThis.document = { createElement: () => ({ set textContent(v) {}, get innerHTML() { return ''; } }) };
const fs = require('fs');
// Replace const/let with var so eval exposes to global scope
const src = fs.readFileSync('./utils.js', 'utf8').replace(/^(const|let) /gm, 'var ');
eval(src);

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
assert(optionsSrc.indexOf("if (area !== 'local') return;") !== -1 &&
  optionsSrc.indexOf("if (area !== 'local') return;") <
    optionsSrc.indexOf('if (loadFailed) return;'),
  'the storage listener takes nothing on a page whose load failed');
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
// One read of both keys: a page that shows what it read shows both or neither,
// so the line it puts up names the read that failed rather than half of one.
assert(/chrome\.storage\.local\.get\(\[SETTINGS_KEY, CHANNEL_VOLUMES_KEY\]\)/.test(optionsSrc),
  'the initial load reads the settings and the channels together');

section('the initial read does not undo what arrived while it was out');
// The read is issued before a change that lands during it, and returns what
// storage held when it was issued, so applying it unconditionally puts the
// older value back on a page that has already shown the newer one.
assert(/const settingsAt = settingsRevision;[\s\S]{0,120}const channelsAt = channelRevision;[\s\S]{0,200}chrome\.storage\.local\.get\(\[SETTINGS_KEY, CHANNEL_VOLUMES_KEY\]\)/
  .test(optionsSrc),
  'the load records both revisions before it issues its read');
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

section('packaging');

// What the archive holds, by name and by the digest of its bytes. Reading the
// bytes is the point: namelist() alone answers for the names only.
const heldInZip = (dir, archive) => {
  const read = require('child_process').spawnSync('python3', ['-c',
    'import hashlib, sys, zipfile\n'
    + 'held = zipfile.ZipFile(sys.argv[1])\n'
    + 'for name in held.namelist():\n'
    + '    print(name, hashlib.sha256(held.read(name)).hexdigest())',
    archive], { cwd: dir, encoding: 'utf8' });
  assert(read.status === 0, `reading ${archive} — ${(read.stderr || '').trim()}`);
  return (read.stdout || '').trim().split('\n').filter(Boolean)
    .map(line => line.split(' '));
};
// pack.py selects by reference rather than by name, so what it leaves out is
// answered by running it rather than by reading a list.
const listed = require('child_process').spawnSync('python3', ['-B', 'pack.py', '--list'],
  { encoding: 'utf8' });
assert(listed.status === 0, `pack.py --list runs — ${(listed.stderr || '').trim()}`);
const packaged = listed.stdout.split('\n').map(line => line.trim()).filter(Boolean);
const packagedUnder = prefix => packaged.some(name => name === prefix || name.startsWith(prefix + '/'));
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
  const names = (run.stdout || '').trim().split('\n').filter(Boolean);
  const backslashed = names.filter(name => name.includes('\\'));
  assert(backslashed.length === 0,
    `every name inside ${where}'s package stays POSIX on Windows — ${backslashed.join(', ')}`);
  return names;
}

// A drive letter reads as relative to posixpath, and on Windows it resolves
// against the same drive — so `C:/content.js` would package what `content.js`
// names, under a path Chrome does not accept. On this host it merely misses,
// which is why the reference is put to pack.py under Windows path semantics.
{
  const driveProbe = [
    'import ntpath, os, builtins, types, importlib.util',
    'spec = importlib.util.spec_from_file_location("packmod", "pack.py")',
    'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
    'real, real_open, real_os = os.path, builtins.open, os',
    'ROOT = "C:" + chr(92) + "repo"',
    'here = real.realpath(".")',
    'host = lambda p: p.replace(ROOT, here).replace(chr(92), "/")',
    'win = lambda p: p.replace(here, ROOT).replace("/", chr(92))',
    'class W:',
    '    isabs, normpath, join, dirname = ntpath.isabs, ntpath.normpath, ntpath.join, ntpath.dirname',
    '    realpath = staticmethod(lambda p: win(real.realpath(host(p))))',
    '    isfile = staticmethod(lambda p: real.isfile(host(p)))',
    '    isdir = staticmethod(lambda p: real.isdir(host(p)))',
    '    abspath = staticmethod(lambda p: win(real.abspath(host(p))))',
    'mod.os = types.SimpleNamespace(path=W, listdir=lambda p: real_os.listdir(host(p)),',
    '                               remove=real_os.remove, sep=chr(92))',
    'mod.open = lambda p, *a, **k: real_open(host(p), *a, **k)',
    'for name in ["content.js", "C:/content.js", "C:content.js", "c:content.js"]:',
    '    print(name, mod._resolve(ROOT, name) is not None)'
  ].join('\n');
  const run = require('child_process').spawnSync('python3', ['-B', '-c', driveProbe],
    { encoding: 'utf8' });
  if (run.error) {
    console.log(`  (drive-letter check skipped: ${run.error.message})`);
  } else {
    assert(run.status === 0, `the drive-letter probe runs — ${(run.stderr || '').trim()}`);
    const answers = Object.fromEntries((run.stdout || '').trim().split('\n')
      .filter(Boolean).map(line => line.split(' ')));
    assert(answers['content.js'] === 'True',
      'a path inside the package still resolves under Windows path semantics');
    for (const named of ['C:/content.js', 'C:content.js', 'c:content.js']) {
      assert(answers[named] === 'False', `${named} names a drive and is refused`);
    }
  }
}

{
  const onWindows = namesOnWindows('.', 'this repository');
  if (onWindows) {
    assert(JSON.stringify(onWindows) === JSON.stringify(packaged),
      `the package holds the same names on either host — ${onWindows.join(', ')}`);
  }
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

  // The mockups spell out UI text that lives in _locales, so it can drift.
  const drawnLabels = {
    auto_label: 'autoApplyLoudness',
    target_desc: 'targetLufsDesc',
    all_auto_label: 'allChannelsAutoApply',
    all_auto_desc: 'allChannelsAutoApplyDesc',
    unit_label: 'displayUnit',
    unit_desc: 'displayUnitDesc',
    overlay_label: 'showGainOverlay',
    overlay_desc: 'showGainOverlayDesc',
    clear_all: 'clearAll',
  };
  for (const lang of langs) {
    const localeFile = `./_locales/${lang}/messages.json`;
    assert(fs.existsSync(localeFile), `${localeFile} exists for the language the mockups draw`);
    if (!fs.existsSync(localeFile)) { continue; }
    const start = genSrc.indexOf(`'${lang}': {`);
    const block = start === -1 ? '' : genSrc.slice(start, genSrc.indexOf('video_title', start));
    const messages = JSON.parse(fs.readFileSync(localeFile, 'utf8'));
    for (const [drawn, messageKey] of Object.entries(drawnLabels)) {
      const value = block.match(new RegExp(`'${drawn}': '([^']*)'`));
      assert(value && messages[messageKey] && value[1] === messages[messageKey].message,
        `gen_screenshots.py draws ${lang} ${drawn} exactly as ${messageKey}`);
    }
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
  const ciYaml = fs.readFileSync('./.github/workflows/ci.yaml', 'utf8');
  // What this file spawns skips itself where pillow is missing, so CI has to
  // have it before the suite rather than after — in the same job, since a
  // step in another one installs nothing here.
  const testJob = ciYaml.slice(ciYaml.indexOf('\n  test:'));
  const pillowInstalled = testJob.indexOf('pip install pillow==');
  const suiteRun = testJob.indexOf('run: node test.js');
  assert(pillowInstalled > -1, 'the test job installs pillow');
  assert(suiteRun > -1, 'the test job runs node test.js');
  assert(pillowInstalled < suiteRun,
    'CI installs pillow before it runs the suite that spawns the check');
  const redrawInto = ciYaml.match(/gen_screenshots\.py --out (.+)/);
  const uploads = ciYaml.match(/path: (.+)\n\s+if-no-files-found/);
  assert(redrawInto, 'the CI redraw names a directory to write into');
  assert(uploads, 'the CI upload names a path');
  if (redrawInto && uploads) {
    const dir = text => text.trim().replace(/\/$/, '');
    assert(dir(uploads[1]) === dir(redrawInto[1]), 'CI uploads the directory it redrew into');
    assert(!redrawInto[1].includes(outDir), 'the CI redraw does not write over the committed images');
  }
}
assert(!packagedUnder('screenshots'),
  'a screenshots/ left over from before the move stays out of the store zip');
assert(!packaged.includes('.DS_Store'),
  'the finder metadata macOS drops beside the manifest stays out of the store zip');

// The checks above read the package this repository produces. This one packs a
// tree built to carry a referenced file of each kind beside an unreferenced one,
// and reads back what landed in the zip.
{
  const box = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'ytcv-pack-'));
  fs.copyFileSync('./pack.py', `${box}/pack.py`);
  fs.writeFileSync(`${box}/manifest.json`, JSON.stringify({
    manifest_version: 3,
    version: '0.0.0',
    default_locale: 'ja',
    content_scripts: [{ js: ['utils.js', 'content.js'] }],
    background: { service_worker: 'background.js' },
    options_page: 'options.html',
    action: { default_popup: 'popup.html', default_icon: { 16: 'icons/icon16.png' } },
    icons: { 16: 'icons/icon16.png' }
  }));
  fs.writeFileSync(`${box}/utils.js`, 'utils.js');
  fs.writeFileSync(`${box}/content.js`, 'content.js');
  // Two arguments, spelled two ways: a walk that stops at the first one
  // leaves the second out of the package with nothing saying so.
  fs.writeFileSync(`${box}/background.js`,
    'importScripts(\'lib/first.js\', "lib/second.js");\n');
  fs.mkdirSync(`${box}/lib`);
  fs.writeFileSync(`${box}/lib/first.js`, 'lib/first.js');
  fs.writeFileSync(`${box}/lib/second.js`, 'lib/second.js');
  // Spellings a browser reads alike. The expected list below is written out by
  // hand rather than scanned, so it does not inherit whatever this page's
  // markup happens to exercise.
  fs.writeFileSync(`${box}/options.html`,
    '<script src="options.js"></script>\n'
    + "<script src='sub/deep.js'></script>\n"
    + '<link rel="stylesheet" href="options.style">\n');
  fs.writeFileSync(`${box}/options.js`, 'options.js');
  fs.writeFileSync(`${box}/options.style`, 'options.style');
  fs.mkdirSync(`${box}/sub`);
  fs.writeFileSync(`${box}/sub/deep.js`, 'sub/deep.js');
  fs.writeFileSync(`${box}/popup.html`,
    '<SCRIPT SRC="popup.js"></SCRIPT>\n'
    + '<script src=bare.js></script>\n'
    + '<script  src = "spaced.js" ></script>\n'
    + '<link href="popup.css">\n'
    + '<!-- <script src="commented.js"></script> -->\n');
  fs.writeFileSync(`${box}/popup.js`, 'popup.js');
  fs.writeFileSync(`${box}/bare.js`, 'bare.js');
  fs.writeFileSync(`${box}/spaced.js`, 'spaced.js');
  fs.writeFileSync(`${box}/popup.css`, 'popup.css');
  fs.writeFileSync(`${box}/commented.js`, '');
  fs.mkdirSync(`${box}/icons`);
  fs.writeFileSync(`${box}/icons/icon16.png`, 'icons/icon16.png');
  fs.mkdirSync(`${box}/_locales/ja`, { recursive: true });
  fs.writeFileSync(`${box}/_locales/ja/messages.json`, '{}');
  fs.mkdirSync(`${box}/_locales/en`, { recursive: true });
  fs.writeFileSync(`${box}/_locales/en/messages.json`, '{"a":{"message":"b"}}');
  fs.writeFileSync(`${box}/LICENSE`, 'MIT License\n');
  const REFERENCED = [
    'LICENSE', '_locales/en/messages.json', '_locales/ja/messages.json',
    'background.js', 'bare.js',
    'content.js', 'icons/icon16.png', 'lib/first.js', 'lib/second.js',
    'manifest.json', 'options.html', 'options.js',
    'options.style', 'popup.css', 'popup.html', 'popup.js', 'spaced.js', 'sub/deep.js',
    'utils.js'
  ];

  // Nothing references these, whatever their extension says. The root .md and
  // .py come from what the repository actually carries rather than from a list
  // kept here, so a documentation file added upstairs is seeded here too.
  fs.writeFileSync(`${box}/.DS_Store`, '');
  fs.writeFileSync(`${box}/.env`, 'TOKEN=secret');
  fs.writeFileSync(`${box}/notes.html`, '<p>notes</p>');
  fs.writeFileSync(`${box}/review-probe.js`, '');
  fs.writeFileSync(`${box}/yt-channel-volume-0.0.0-old.zip`, '');
  fs.writeFileSync(`${box}/icons/source.svg`, '');
  fs.writeFileSync(`${box}/_locales/ja/notes.txt`, '');
  fs.mkdirSync(`${box}/__pycache__`);
  fs.writeFileSync(`${box}/__pycache__/content.cpython-314.pyc`, '');
  // commented.js is in the tree and named only inside an HTML comment, which a
  // browser never asks for.
  const seeded = ['.DS_Store', '.env', 'notes.html', 'review-probe.js', 'icons/source.svg',
    '_locales/ja/notes.txt', '__pycache__', 'commented.js'];
  for (const name of [
    ...fs.readdirSync('.').filter(name => fs.statSync(name).isFile() && /\.(md|py)$/i.test(name)),
    ...['docs', 'tools'].filter(name => fs.existsSync(name))
  ]) {
    if (fs.existsSync(`${box}/${name}`)) { continue; }
    if (fs.statSync('./' + name).isDirectory()) {
      fs.mkdirSync(`${box}/${name}`);
      fs.writeFileSync(`${box}/${name}/seed`, '');
    } else {
      fs.writeFileSync(`${box}/${name}`, '');
    }
    seeded.push(name);
  }
  for (const name of ['README.md', 'README.ja.md', 'docs']) {
    assert(seeded.includes(name), `${name} is in the tree pack.py is pointed at`);
  }
  assert(!seeded.includes('LICENSE'), 'the licence is expected in the zip, not kept out of it');

  const packed = require('child_process').spawnSync('python3', ['-B', 'pack.py'],
    { cwd: box, encoding: 'utf8' });
  if (packed.error) {
    console.log(`  (pack run skipped: ${packed.error.message})`);
  } else {
    assert(packed.status === 0, `pack.py runs — ${(packed.stderr || '').trim()}`);
    // The names say nothing about what is under them: a packer writing empty
    // entries under these names passes a comparison of names alone.
    const held = heldInZip(box, 'yt-channel-volume-0.0.0.zip');
    const names = held.map(([name]) => name).sort();
    assert(JSON.stringify(names) === JSON.stringify(REFERENCED.slice().sort()),
      `pack.py carries the referenced files and nothing else — got ${names.join(', ')}`);
    for (const name of seeded) {
      assert(!names.some(entry => entry === name || entry.startsWith(name + '/')),
        `pack.py keeps ${name} out of the store zip`);
    }
    for (const [name, digest] of held) {
      const onDisk = require('crypto').createHash('sha256')
        .update(fs.readFileSync(`${box}/${name}`)).digest('hex');
      assert(digest === onDisk, `${name} in the package is the file of that name`);
    }
    // Without this the comparison above would hold for a packer that wrote
    // nothing at all, since an empty entry matches an empty file.
    const ofNothing = require('crypto').createHash('sha256').update('').digest('hex');
    assert(held.some(([, digest]) => digest !== ofNothing),
      'the fixture gives the packer something to get wrong');
    const boxOnWindows = namesOnWindows(box, 'the fixture');
    if (boxOnWindows) {
      assert(JSON.stringify(boxOnWindows.slice().sort()) === JSON.stringify(REFERENCED.slice().sort()),
        `the fixture packs the same names on either host — ${boxOnWindows.join(', ')}`);
    }
  }
  fs.rmSync(box, { recursive: true, force: true });
}

// options.js has no DOM harness here, so its half of the cross-context
// contract is asserted against the source.
// A path that resolves outside the package would carry a file nobody reviewed
// into the store zip under a name that looks local. Deleting the rule that
// refuses one left this suite green until these ran.
{
  const nodeOs = require('os');
  const nodePath = require('path');
  const spawn = require('child_process').spawnSync;
  const tmpRoot = fs.realpathSync(nodeOs.tmpdir());
  const outside = fs.mkdtempSync(nodePath.join(tmpRoot, 'ytcv-outside-'));
  fs.writeFileSync(nodePath.join(outside, 'secret.js'), 'SECRET');
  fs.writeFileSync(nodePath.join(outside, 'messages.json'), '{}');
  const escapeManifest = (references, extra = {}) => JSON.stringify({
    manifest_version: 3,
    version: '1.0.0',
    content_scripts: [{ js: references }],
    ...extra
  });
  // The package sits one level down: a case that reaches outside it with ..
  // writes into its own parent, never into the shared temp root.
  const runEscape = build => {
    const parent = fs.mkdtempSync(nodePath.join(tmpRoot, 'ytcv-escape-'));
    const fixture = nodePath.join(parent, 'package');
    fs.mkdirSync(fixture);
    fs.copyFileSync('./pack.py', nodePath.join(fixture, 'pack.py'));
    build(fixture);
    const result = spawn('python3', ['-B', 'pack.py', '--list'],
      { cwd: fixture, encoding: 'utf8' });
    fs.rmSync(parent, { recursive: true, force: true });
    return result;
  };
  const refused = (result, pattern, what) => {
    assert(result.status !== 0, `pack.py refuses ${what}`);
    assert(pattern.test(result.stderr || ''),
      `the refusal of ${what} names it — got ${(result.stderr || '').trim()}`);
  };
  try {
    // A symlinked parent directory: only the last name looks local.
    refused(runEscape(fixture => {
      fs.writeFileSync(nodePath.join(fixture, 'manifest.json'),
        escapeManifest(['linked/secret.js']));
      fs.symlinkSync(outside, nodePath.join(fixture, 'linked'));
    }), /linked\/secret\.js/, 'a reference through a symlinked parent');

    refused(runEscape(fixture => {
      fs.writeFileSync(nodePath.join(fixture, 'manifest.json'),
        escapeManifest(['../secret.js']));
      const sibling = nodePath.join(nodePath.dirname(fixture), 'secret.js');
      assert(sibling.startsWith(tmpRoot + nodePath.sep) && nodePath.dirname(sibling) !== tmpRoot,
        'the climb lands inside this case, not in the shared temp root');
      fs.writeFileSync(sibling, 'SIBLING');
    }), /\.\.\/secret\.js/, 'a reference climbing out with ..');

    // Absolute and pointing at a path with no link anywhere in it: the only
    // thing between it and the zip is the rule against absolute paths.
    assert(fs.realpathSync(outside) === outside, 'the outside path has no link in it');
    refused(runEscape(fixture => {
      fs.writeFileSync(nodePath.join(fixture, 'manifest.json'),
        escapeManifest([nodePath.join(outside, 'secret.js')]));
    }), /secret\.js/, 'an absolute reference');

    // The locale directories are listed rather than referenced, and one of
    // them can be a link just as easily.
    refused(runEscape(fixture => {
      fs.writeFileSync(nodePath.join(fixture, 'manifest.json'),
        escapeManifest([], { default_locale: 'ja' }));
      fs.mkdirSync(nodePath.join(fixture, '_locales'));
      fs.symlinkSync(outside, nodePath.join(fixture, '_locales', 'ja'));
    }), /_locales\/ja\/messages\.json/, 'a symlinked locale directory');

    refused(runEscape(fixture => {
      fs.writeFileSync(nodePath.join(fixture, 'manifest.json'),
        escapeManifest([], { default_locale: 'ja' }));
      fs.symlinkSync(outside, nodePath.join(fixture, '_locales'));
    }), /_locales\//, 'a symlinked _locales');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

// A zip built around a missing file is a broken extension, not a smaller one.
{
  const nodeOs = require('os');
  const nodePath = require('path');
  const spawn = require('child_process').spawnSync;
  const fixture = fs.mkdtempSync(
    nodePath.join(fs.realpathSync(nodeOs.tmpdir()), 'ytcv-missing-'));
  fs.writeFileSync(nodePath.join(fixture, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    version: '1.0.0',
    content_scripts: [{ js: ['content.js'] }]
  }));
  fs.copyFileSync('./pack.py', nodePath.join(fixture, 'pack.py'));
  const missing = spawn('python3', ['-B', 'pack.py', '--list'],
    { cwd: fixture, encoding: 'utf8' });
  assert(missing.status !== 0, 'pack.py refuses a reference with no file behind it');
  assert(/content\.js/.test(missing.stderr || ''),
    'the refusal names the file it could not find');

  // A referenced symlink resolves outside the package: it is not packed
  // silently in place of the file it points at.
  fs.writeFileSync(nodePath.join(fixture, 'elsewhere.js'), '//');
  fs.symlinkSync(nodePath.join(fixture, 'elsewhere.js'),
    nodePath.join(fixture, 'content.js'));
  const linked = spawn('python3', ['-B', 'pack.py', '--list'],
    { cwd: fixture, encoding: 'utf8' });
  assert(linked.status !== 0, 'pack.py refuses a reference reaching its file through a link');
  assert(/content\.js/.test(linked.stderr || ''), 'the refusal names it');
  fs.rmSync(fixture, { recursive: true, force: true });
}


// gen_icons.py writes beside itself rather than beside whatever directory it
// was started from, and where there is no face to draw the mark with it says so
// instead of saving one drawn with Pillow's own and reporting success.
{
  const nodeOs = require('os');
  const nodePath = require('path');
  const spawn = require('child_process').spawnSync;
  const tmpRoot = fs.realpathSync(nodeOs.tmpdir());
  const source = fs.readFileSync('./gen_icons.py', 'utf8');
  const committed = fs.readdirSync('./icons').filter(name => /^icon\d+\.png$/.test(name)).sort();
  assert(committed.length > 0, 'the tree carries the icons gen_icons.py draws');

  const beside = fs.mkdtempSync(nodePath.join(tmpRoot, 'ytcv-icons-'));
  const elsewhere = fs.mkdtempSync(nodePath.join(tmpRoot, 'ytcv-cwd-'));
  fs.writeFileSync(nodePath.join(beside, 'gen_icons.py'), source);
  fs.mkdirSync(nodePath.join(beside, 'icons'));
  // Both directories can take the icons, so which one holds them is the answer.
  fs.mkdirSync(nodePath.join(elsewhere, 'icons'));
  const drawn = spawn('python3', ['-B', nodePath.join(beside, 'gen_icons.py')],
    { cwd: elsewhere, encoding: 'utf8' });
  if (drawn.error || drawn.status === 3) {
    console.log(`  (icon check skipped: ${(drawn.error || drawn.stderr || '').toString().trim()})`);
  } else {
    assert(drawn.status === 0,
      `gen_icons.py draws — ${(drawn.stderr || '').trim()}`);
    assert(JSON.stringify(fs.readdirSync(nodePath.join(beside, 'icons')).sort())
      === JSON.stringify(committed),
      'gen_icons.py writes the icons beside itself');
    assert(fs.readdirSync(nodePath.join(elsewhere, 'icons')).length === 0,
      'gen_icons.py writes nothing under the directory it was started from');
  }

  // The same script with nowhere to find a face. It runs wherever pillow is,
  // so this half needs no system font of its own.
  const faceless = fs.mkdtempSync(nodePath.join(tmpRoot, 'ytcv-faceless-'));
  fs.mkdirSync(nodePath.join(faceless, 'icons'));
  const withoutAFace = source.replace(/^FONT_PATHS = \[[^\]]*\]/m,
    "FONT_PATHS = ['/no/such/face.ttf']");
  assert(withoutAFace !== source, 'gen_icons.py lists the faces it looks for in FONT_PATHS');
  fs.writeFileSync(nodePath.join(faceless, 'gen_icons.py'), withoutAFace);
  const refused = spawn('python3', ['-B', nodePath.join(faceless, 'gen_icons.py')],
    { cwd: faceless, encoding: 'utf8' });
  if (refused.error || refused.status === 3) {
    console.log(`  (faceless check skipped: ${(refused.error || refused.stderr || '').toString().trim()})`);
  } else {
    assert(refused.status !== 0, 'gen_icons.py turns down a machine with no face to draw with');
    assert(/no face here to draw the mark with/.test(refused.stderr || ''),
      `the refusal says what it could not find — got ${(refused.stderr || '').trim()}`);
    assert(/no\/such\/face\.ttf/.test(refused.stderr || ''),
      'the refusal names where it looked');
    assert(fs.readdirSync(nodePath.join(faceless, 'icons')).length === 0,
      'nothing is saved under the brand letter when there is no face for it');
  }
  for (const dir of [beside, elsewhere, faceless]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}


// Every key that names a file is followed, a page is read for what it pulls in
// whatever it is called, and a stylesheet is read for what it reaches.
{
  const nodePath = require('path');
  const spawn = require('child_process').spawnSync;
  const box = fs.mkdtempSync(nodePath.join(fs.realpathSync(require('os').tmpdir()), 'ytcv-keys-'));
  const write = (relative, body = relative) => {
    const target = nodePath.join(box, relative);
    fs.mkdirSync(nodePath.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };
  write('manifest.json', JSON.stringify({
      manifest_version: 3,
      version: '1.0.0',
      // One path rather than a size for each: the other spelling Chrome takes.
      action: { default_popup: 'popup.htm', default_icon: 'brand.png' },
      devtools_page: 'devtools.html',
      side_panel: { default_path: 'panel.html' },
      chrome_url_overrides: { newtab: 'newtab.html' },
      sandbox: { pages: ['sandboxed.html'] },
      storage: { managed_schema: 'schema.json' },
      declarative_net_request: {
        rule_resources: [{ id: 'r', enabled: true, path: 'rules.json' }]
      },
      content_scripts: [{ js: ['content.js'], css: ['styles.css'] }],
      web_accessible_resources: [
        { resources: ['exposed.js', '/loose.png', '//spare.js', '/',
                      'images/*.png', '/lib/*.js'],
          matches: ['https://example.com/*'] }
      ]
    }));
  // Chrome loads a page under whatever name the key gives it.
  write('popup.htm', '<script src="popup.js"></script>\n');
  write('popup.js');
  write('devtools.html');
  write('panel.html');
  write('newtab.html');
  write('sandboxed.html');
  write('schema.json', '{}');
  write('rules.json', '[]');
  write('content.js');
  write('exposed.js');
  write('styles.css', '@import "theme.css";\n'
      + 'body { background: url(bg.png) }\n'
      + '/* url(commented.png) */\n'
      + 'a { background: url("https://example.com/remote.png") }\n'
      + 'b { background: url(#within) }\n'
      + 'c { background: url("__MSG_@@extension_id__/asset.png") }\n');
  write('theme.css', 'body { color: red }\n');
  write('bg.png');
  write('brand.png');
  // In a comment, remote, a fragment of the sheet, and a name Chrome
  // substitutes a message into: none of them is a file this can resolve.
  write('commented.png');
  // A resource entry is a pattern Chrome matches against the extension's
  // own files, so what it names is packed. The three beside it are the
  // ones it does not name: a different extension, a different directory,
  // and one the pattern reaches only because '*' passes over a slash.
  write('images/logo.png');
  write('images/deep/inner.png');
  write('images/notes.txt');
  // The pattern has to name the whole of what it matches: this one begins
  // with a name it does name and goes on past it.
  write('images/logo.png.bak');
  // Where a pattern names files exactly, those are the files it names:
  // this one folds onto it and is not among them.
  write('images/OTHER.PNG');
  // What a pattern names is read by what it is: this one imports, and
  // what it imports is packed with it.
  write('lib/helper.js', "importScripts('inner.js');\n");
  write('lib/inner.js');
  write('lib/notes.txt');
  // A resource is written from the extension's root, and the documented
  // form writes that root as a leading slash: '/loose.png' and '/lib/*.js'
  // name what 'loose.png' and 'lib/*.js' name. A slash on its own names
  // nothing, and one written twice is still the root.
  write('loose.png');
  write('spare.js');
  write('stray.png');
  write('LICENSE', 'MIT License\n');
  fs.copyFileSync('./pack.py', nodePath.join(box, 'pack.py'));

  const listed = spawn('python3', ['-B', 'pack.py', '--list'], { cwd: box, encoding: 'utf8' });
  assert(listed.status === 0, `pack.py --list runs over the key fixture — ${(listed.stderr || '').trim()}`);
  const held = listed.stdout.split('\n').map(line => line.trim()).filter(Boolean).sort();
  assert(JSON.stringify(held) === JSON.stringify([
      'LICENSE', 'bg.png', 'brand.png', 'content.js', 'devtools.html', 'exposed.js',
      'images/deep/inner.png', 'images/logo.png', 'lib/helper.js', 'lib/inner.js',
      'loose.png', 'manifest.json', 'newtab.html', 'panel.html', 'popup.htm',
      'popup.js', 'rules.json', 'sandboxed.html', 'schema.json', 'spare.js',
      'styles.css', 'theme.css'
    ]),
    `the package follows every key that names a file — got ${held.join(', ')}`);

  // Each of these says the key was walked rather than the file happening to be
  // carried some other way.
  // A pattern cannot name a file that is not there, so what says it was
  // matched is that the file is in the list above and its neighbours are
  // not. These are the names that fail when the key stops being walked.
  for (const gone of ['panel.html', 'rules.json', 'schema.json', 'theme.css',
    'bg.png', 'brand.png', 'exposed.js', 'popup.js', 'lib/inner.js']) {
    fs.rmSync(nodePath.join(box, gone));
    const refused = spawn('python3', ['-B', 'pack.py', '--list'], { cwd: box, encoding: 'utf8' });
    assert(refused.status !== 0, `pack.py refuses a package missing ${gone}`);
    assert(new RegExp(gone.replace('.', '\\.')).test(refused.stderr || ''),
      `the refusal names ${gone}`);
    write(gone);
  }
  fs.rmSync(box, { recursive: true, force: true });
}


// What version a tag stands for. Chrome reads the manifest's version as numbers
// alone, so a prerelease shows its name in version_name and keeps the numbers it
// is built on in version. The release runs this script, so this runs it too.
{
  const nodeOs = require('os');
  const nodePath = require('path');
  const spawn = require('child_process').spawnSync;
  const script = './tools/verify-version.sh';
  assert(fs.existsSync(script), 'the release script is in the tree');
  // A step that stopped calling it would leave every case below passing.
  const release = fs.readFileSync('./.github/workflows/release.yaml', 'utf8');
  assert(release.includes('tools/verify-version.sh'),
    'the release workflow runs the version script');

  const box = fs.mkdtempSync(nodePath.join(fs.realpathSync(nodeOs.tmpdir()), 'ytcv-version-'));
  const ask = (manifest, tag) => {
    const at = nodePath.join(box, 'manifest.json');
    fs.writeFileSync(at, JSON.stringify(manifest));
    return spawn('bash', [script, at, tag], { encoding: 'utf8' });
  };
  for (const [shape, manifest, tag, wanted] of [
    ['a release tag against a numeric version',
      { version: '1.2.0' }, 'v1.2.0', null],
    ['a prerelease tag against the name beside the version',
      { version: '1.2.0', version_name: '1.2.0-rc1' }, 'v1.2.0-rc1', null],
    ['a tag that is not the version', { version: '1.2.0' }, 'v1.2.1',
      /does not match tag/],
    ['a release tag against a manifest showing a prerelease',
      { version: '1.2.0', version_name: '1.2.0-rc1' }, 'v1.2.0', /does not match tag/],
    ['a name that is not built on the version',
      { version: '1.2.0', version_name: '9.9.9-rc1' }, 'v9.9.9-rc1',
      /does not begin with version/],
    ['a manifest naming no version', { name: 'p' }, 'v1.2.0', /names no version/]
  ]) {
    const run = ask(manifest, tag);
    if (wanted === null) {
      assert(run.status === 0, `${shape} passes — ${(run.stdout + run.stderr).trim()}`);
    } else {
      assert(run.status !== 0, `${shape} is refused`);
      assert(wanted.test(run.stdout + run.stderr),
        `${shape} says why — ${(run.stdout + run.stderr).trim()}`);
    }
  }
  fs.rmSync(box, { recursive: true, force: true });
}

// A tag moves and a commit does not, so every action this repository runs is
// named by the commit its version tag names, with that version written beside
// it. Nothing here reaches the network: what the commit is was settled when it
// was written down, and this only holds the shape.
{
  const workflows = './.github/workflows';
  const files = fs.readdirSync(workflows).filter(name => /\.ya?ml$/.test(name));
  assert(files.length > 0, 'the repository carries workflows');
  let named = 0;
  for (const name of files) {
    for (const line of fs.readFileSync(`${workflows}/${name}`, 'utf8').split('\n')) {
      if (!/^\s*-?\s*uses:/.test(line)) { continue; }
      named += 1;
      assert(/^\s*-?\s*uses:\s+[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+\s*$/.test(line),
        `${name} names an action by a commit and the version beside it — ${line.trim()}`);
    }
  }
  // Without this the loop above would pass over a workflow that runs nothing.
  assert(named > 0, 'the workflows run actions');
}

// A file the package has to carry is not one it takes when it happens to be
// there. The release workflow runs pack.py and uploads what it writes without
// running any of this, so an omission that still exits 0 ships.
{
  const nodePath = require('path');
  const nodeOs = require('os');
  const runPack = (box, args) => require('child_process')
    .spawnSync('python3', ['-B', 'pack.py', ...args], { cwd: box, encoding: 'utf8' });
  const buildMinimal = () => {
    const box = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ytcv-required-'));
    fs.copyFileSync('./pack.py', `${box}/pack.py`);
    fs.writeFileSync(`${box}/manifest.json`, JSON.stringify({
      manifest_version: 3,
      version: '0.0.0',
      default_locale: 'ja',
      name: '__MSG_extName__',
      content_scripts: [{ js: ['content.js'] }]
    }));
    fs.writeFileSync(`${box}/content.js`, '');
    fs.mkdirSync(`${box}/_locales/ja`, { recursive: true });
    // The manifest asks for extName, so the catalog answers for it.
    fs.writeFileSync(`${box}/_locales/ja/messages.json`,
      JSON.stringify({ extName: { message: 'Minimal' } }));
    fs.writeFileSync(`${box}/LICENSE`, 'MIT License\n');
    return box;
  };

  const whole = buildMinimal();
  const listed = runPack(whole, ['--list']);
  if (listed.error) {
    console.log(`  (required-file check skipped: ${listed.error.message})`);
    fs.rmSync(whole, { recursive: true, force: true });
  } else {
    assert(listed.status === 0, `the whole tree packs — ${(listed.stderr || '').trim()}`);
    assert(JSON.stringify(listed.stdout.split('\n').map(line => line.trim()).filter(Boolean).sort())
      === JSON.stringify(['LICENSE', '_locales/ja/messages.json', 'content.js', 'manifest.json']),
      `the whole tree carries the licence and the default locale — ${listed.stdout.trim()}`);
    fs.rmSync(whole, { recursive: true, force: true });

    const writeCatalog = (box, catalog) =>
      fs.writeFileSync(`${box}/_locales/ja/messages.json`, JSON.stringify(catalog));
    const readBoxJson = box => JSON.parse(fs.readFileSync(`${box}/manifest.json`, 'utf8'));
    // A value the manifest carries as it stands. JSON.stringify spells no
    // NaN, no comment and no escape, and the manifest is where Chrome reads
    // all three.
    const appendRaw = (box, raw) => fs.writeFileSync(`${box}/manifest.json`,
      `${JSON.stringify(readBoxJson(box)).slice(0, -1)},${raw}}`);
    const editManifest = (box, change) => {
      const manifest = JSON.parse(fs.readFileSync(`${box}/manifest.json`, 'utf8'));
      change(manifest);
      fs.writeFileSync(`${box}/manifest.json`, JSON.stringify(manifest));
    };
    // The third entry, where a case carries one, is what the refusal has to say.
    // Without it a rule can be deleted and a later check refuses the same input
    // for another reason, and the case cannot tell the two apart.
    for (const [broken, breakIt, diagnosis] of [
      ['the licence gone', box => fs.rmSync(`${box}/LICENSE`)],
      ["the default locale's messages gone", box => fs.rmSync(`${box}/_locales/ja/messages.json`)],
      ['_locales gone', box => fs.rmSync(`${box}/_locales`, { recursive: true })],
      // Chrome reads _locales and default_locale as one contract: a directory
      // with nothing naming it is an extension it declines to load.
      ['no default_locale, and _locales still here',
        box => editManifest(box, m => { delete m.default_locale; })],
      ['default_locale set to an empty string',
        box => editManifest(box, m => { m.default_locale = ''; })],
      ['default_locale set to something that is not a string',
        box => editManifest(box, m => { m.default_locale = 7; })],
      ['default_locale naming a directory that is not there',
        box => editManifest(box, m => { m.default_locale = 'de'; })],
      ['a manifest reference naming a drive rather than a path inside the package',
        box => editManifest(box, m => { m.content_scripts = [{ js: ['C:/content.js'] }]; })],
      // Chrome resolves __MSG_name__ against the default locale's catalog, in
      // the manifest and in the stylesheets it serves. A placeholder with
      // nothing to resolve it against is an extension it declines to load.
      ['a message the manifest asks for and no locale assets at all',
        box => {
          fs.rmSync(`${box}/_locales`, { recursive: true });
          editManifest(box, m => { delete m.default_locale; });
        },
        /asks for extName and names no default_locale/],
      ['default_locale written as null',
        box => editManifest(box, m => { m.default_locale = null; }),
        /default_locale is not a locale name: None/],
      ['default_locale written as a path rather than a name',
        box => editManifest(box, m => { m.default_locale = 'ja/'; }),
        /default_locale is not one name under _locales: 'ja\/'/],
      ['default_locale written as a directory that means the one above',
        box => editManifest(box, m => { m.default_locale = '..'; }),
        /default_locale is not one name under _locales: '\.\.'/],
      ['a message the manifest asks for that the catalog does not answer',
        box => editManifest(box, m => { m.name = '__MSG_absentKey__'; }),
        /the manifest uses absentKey, which .* does not answer for/],
      ['a reference spelled with escapes that nothing answers',
        box => appendRaw(box, '"description":"__MSG_\\u0061bsent__"'),
        /the manifest uses absent, which .* does not answer for/],
      ['a message a packaged stylesheet asks for that the catalog does not answer',
        box => {
          fs.writeFileSync(`${box}/styles.css`, 'body { content: "__MSG_absentKey__" }\n');
          editManifest(box, m => {
            m.content_scripts = [{ js: ['content.js'], css: ['styles.css'] }];
          });
        },
        /styles\.css uses absentKey, which .* does not answer for/],
      ['a catalog that is not JSON',
        box => fs.writeFileSync(`${box}/_locales/ja/messages.json`, '{ broken'),
        /messages\.json is not readable as JSON/],
      // Chrome's parser allows comments; it does not allow a trailing comma or
      // a block comment left open.
      ['a trailing comma in a catalog',
        box => fs.writeFileSync(`${box}/_locales/ja/messages.json`,
          '{ "extName": { "message": "x" }, }'),
        /messages\.json is not readable as JSON/],
      ['a block comment a catalog never closes',
        box => fs.writeFileSync(`${box}/_locales/ja/messages.json`,
          '{ /* "extName": { "message": "x" } }'),
        /never closed/],
      ['a trailing comma in the manifest',
        box => fs.writeFileSync(`${box}/manifest.json`,
          '{ "manifest_version": 3, "version": "0.0.0", }'),
        /manifest\.json is not readable as JSON/],
      // Chrome reads the catalog rather than taking it on faith, and declines to
      // load the extension over any of these.
      ['a catalog whose top level is not an object',
        box => writeCatalog(box, [{ extName: { message: 'x' } }]),
        /is not a message catalog: the top level is a list/],
      ['an entry with no message element',
        box => writeCatalog(box, { extName: { description: 'x' } }),
        /gives extName no message element/],
      ['an entry whose message is not text',
        box => writeCatalog(box, { extName: { message: 7 } }),
        /gives extName no message element/],
      ['an entry that is not an object',
        box => writeCatalog(box, { extName: 'x' }),
        /gives extName a str, not an object/],
      ['a name Chrome cannot read',
        box => writeCatalog(box, { 'ext-name': { message: 'x' }, extName: { message: 'y' } }),
        /names a message Chrome cannot read/],
      ['a placeholder with no content',
        box => writeCatalog(box,
          { extName: { message: 'x $A$', placeholders: { a: { example: 'y' } } } }),
        /gives extName\.a no content/],
      // A pattern that names nothing is one Chrome takes as well. A pattern
      // that names nothing until the spelling is folded is the tree carrying
      // the files another way, and the package would go out without them —
      // which the walk cannot say, because it lists real paths and matches
      // them, so a spelling that differs reads as nothing to match.
      ['a resource pattern whose directory the tree spells another way',
        box => {
          fs.mkdirSync(`${box}/images`);
          fs.writeFileSync(`${box}/images/logo.png`, 'x');
          editManifest(box, m => {
            m.web_accessible_resources = [{ resources: ['Images/*.png'],
              matches: ['https://example.com/*'] }];
          });
        },
        /the tree spells this another way: Images\/\*\.png/],
      ['a resource pattern whose extension the tree spells another way',
        box => {
          fs.mkdirSync(`${box}/images`);
          fs.writeFileSync(`${box}/images/logo.png`, 'x');
          editManifest(box, m => {
            m.web_accessible_resources = [{ resources: ['images/*.PNG'],
              matches: ['https://example.com/*'] }];
          });
        },
        /the tree spells this another way: images\/\*\.PNG/],
      // A name that is nowhere and a name spelled another way are different
      // mistakes, and each is said as itself.
      ['a reference with no file behind it',
        box => fs.rmSync(`${box}/content.js`),
        /referenced file is missing or not a regular file: content\.js/],
      // A host that opens a name without regard to case hands back the file
      // the tree carries, and the package would hold two entries for the one
      // file — one of them under a name no other host can open.
      ['a reference the tree spells another way',
        box => editManifest(box, m => {
          m.content_scripts = [{ js: ['Content.js'] }];
        }),
        /the tree spells this another way: Content\.js/],
      // Outside a resource entry a leading slash is an absolute path, and an
      // absolute path names a file the package cannot carry.
      ['a reference beginning at the root of the host',
        box => editManifest(box, m => {
          m.content_scripts = [{ js: ['/content.js'] }];
        }),
        /reference leaves the package: \/content\.js/],
      // A backslash is an ordinary character in a name on this host and a
      // separator on the one the package is written for. The file is on disk
      // under that very name, so what refuses it is the rule and not its
      // absence.
      ['a reference spelled with a backslash',
        box => {
          fs.writeFileSync(`${box}/sub\\content.js`, '');
          editManifest(box, m => {
            m.content_scripts = [{ js: ['content.js', 'sub\\content.js'] }];
          });
        },
        /reference leaves the package: sub\\content\.js/],
      // Chrome reads a version as one to four numbers, each below 2**32, the
      // first written without a leading zero. Its own message about the range
      // says 0 to 65536, which is not the bound it applies.
      ['a version carrying a prerelease suffix',
        box => editManifest(box, m => { m.version = '1.0.0-rc1'; }),
        /version is not one Chrome reads: '1\.0\.0-rc1'/],
      ['a version whose first part carries a leading zero',
        box => editManifest(box, m => { m.version = '01.1.0'; }),
        /version is not one Chrome reads: '01\.1\.0'/],
      ['a version part past the largest number one holds',
        box => editManifest(box, m => { m.version = '1.0.4294967296'; }),
        /version is not one Chrome reads: '1\.0\.4294967296'/],
      ['a version of five parts',
        box => editManifest(box, m => { m.version = '1.0.0.0.0'; }),
        /version is not one Chrome reads: '1\.0\.0\.0\.0'/],
      // A prerelease shows its name in version_name, which Chrome reads as any
      // text at all and refuses when it is not text.
      ['a version_name that is not text',
        box => editManifest(box, m => { m.version_name = 7; }),
        /version_name is not text: 7/],
      ['a version written as a number rather than text',
        box => editManifest(box, m => { m.version = 100; }),
        /version is not one Chrome reads: 100/],
      ['a version with no version at all',
        box => editManifest(box, m => { delete m.version; }),
        /version is not one Chrome reads: None/],
      ['a default_locale that is no locale at all',
        box => {
          fs.renameSync(`${box}/_locales/ja`, `${box}/_locales/jp`);
          editManifest(box, m => { m.default_locale = 'jp'; });
        },
        /is not a locale the store carries: 'jp'/],
      ['a locale the browser loads and the store does not carry',
        box => {
          fs.renameSync(`${box}/_locales/ja`, `${box}/_locales/nb`);
          editManifest(box, m => { m.default_locale = 'nb'; });
        },
        /is not a locale the store carries: 'nb'/],
      // Chrome reads a JSON number as a double. NaN and the infinities are
      // Python's spelling of a number rather than JSON's, and a literal too
      // large for a double is one Chrome declines to read at all.
      ['a manifest holding a number only Python reads',
        box => appendRaw(box, '"x":NaN'),
        /manifest\.json is not readable as JSON: NaN is not a JSON value/],
      ['a catalog holding a number only Python reads',
        box => fs.writeFileSync(`${box}/_locales/ja/messages.json`,
          '{"extName":{"message":"x","description":Infinity}}'),
        /messages\.json is not readable as JSON: Infinity is not a JSON value/],
      ['a fraction larger than a number holds',
        box => appendRaw(box, '"x":1e400'),
        /is not readable as JSON: 1e400 is out of the range a number holds/],
      ['an integer larger than a number holds',
        box => appendRaw(box, `"x":1${'0'.repeat(400)}`),
        /is not readable as JSON: 10+ is out of the range a number holds/],
      // A comment stands between the tokens it separated. Dropped outright it
      // joins them into one the author never wrote.
      ['a number a block comment splits',
        box => appendRaw(box, '"x":1/**/2'),
        /manifest\.json is not readable as JSON: Expecting ',' delimiter/],
      ['a keyword a block comment splits',
        box => appendRaw(box, '"x":tr/**/ue'),
        /manifest\.json is not readable as JSON: Expecting value/],
      // Every field Chrome localizes is asked, not the first of them alone.
      ['a title the action asks for that the catalog does not answer',
        box => editManifest(box, m => {
          m.action = { default_title: '__MSG_absentTitle__' };
        }),
        /the manifest uses absentTitle, which .* does not answer for/],
      ['a description a command asks for that the catalog does not answer',
        box => editManifest(box, m => {
          m.commands = { go: { description: '__MSG_absentCommand__' } };
        }),
        /the manifest uses absentCommand, which .* does not answer for/],
      ['a name an input component asks for that the catalog does not answer',
        box => editManifest(box, m => {
          m.input_components = [{ name: '__MSG_absentComponent__' }];
        }),
        /the manifest uses absentComponent, which .* does not answer for/],
      ['a message under @@ that Chrome does not define',
        box => editManifest(box, m => { m.description = '__MSG_@@bogus__'; }),
        /the manifest uses @@bogus, which .* does not answer for/],
      ['the one message Chrome reads everywhere but the manifest, in the manifest',
        box => editManifest(box, m => { m.description = '__MSG_@@extension_id__'; }),
        /the manifest uses @@extension_id/],
      ['a message referring to a placeholder nothing defines',
        box => writeCatalog(box, { extName: { message: 'hello $WHO$' } }),
        /gives extName no placeholder named WHO/],
      ['placeholders written as null',
        box => writeCatalog(box, { extName: { message: 'x', placeholders: null } }),
        /gives extName placeholders that are not an object/],
      ['a placeholder Chrome cannot read',
        box => writeCatalog(box, { extName: { message: 'x $BAD_NAME$',
          placeholders: { 'bad-name': { content: '$1' } } } }),
        /names a placeholder Chrome cannot read/],
      // A doubled delimiter opens an empty candidate rather than escaping
      // anything, so $$NAME$$ asks for NAME; and two references share a
      // delimiter, so $A$$B$ is A then B.
      ['a doubled dollar around a name nothing defines',
        box => writeCatalog(box, { extName: { message: '$$NAME$$' } }),
        /gives extName no placeholder named NAME/],
      // A name is matched whole: Chromium walks every character of it, while a
      // pattern anchored with $ stops before a trailing newline.
      ['a message name ending in a newline',
        box => writeCatalog(box, { extName: { message: 'x' }, 'trailing\n': { message: 'y' } }),
        /names a message Chrome cannot read/],
      ['a placeholder name ending in a newline',
        box => writeCatalog(box,
          { extName: { message: 'x', placeholders: { 'a\n': { content: '$1' } } } }),
        /names a placeholder Chrome cannot read/],
      // Chrome supplies the reserved five and refuses a catalog that answers for
      // one of them, without regard to case. The extension id is not among them.
      ['a catalog answering for a message Chrome reserves',
        box => writeCatalog(box,
          { extName: { message: 'x' }, '@@ui_locale': { message: 'y' } }),
        /answers for @@ui_locale, which Chrome reserves/],
      ['a catalog answering for a reserved name spelled in capitals',
        box => writeCatalog(box,
          { extName: { message: 'x' }, '@@BIDI_DIR': { message: 'y' } }),
        /answers for @@BIDI_DIR, which Chrome reserves/],
      // The manifest is localized before Chrome has an extension id, so the name
      // is matched there without regard to case as everywhere else.
      ['the extension id asked for in capitals in the manifest',
        box => editManifest(box, m => { m.description = '__MSG_@@EXTENSION_ID__'; }),
        /the manifest uses @@EXTENSION_ID/],
      ['two references sharing a delimiter, one of them undefined',
        box => writeCatalog(box, { extName: { message: '$A$$B$',
          placeholders: { ab: { content: '$1' } } } }),
        /gives extName no placeholder named A/],
      // The second reference is what the shared delimiter opens, so it has to be
      // the one that fails here: a walk restarting past the delimiter never
      // reaches it.
      ['the second of two references sharing a delimiter undefined',
        box => writeCatalog(box, { extName: { message: '$A$$B$',
          placeholders: { a: { content: '$1' } } } }),
        /gives extName no placeholder named B/]
    ]) {
      const box = buildMinimal();
      // A package built earlier stands here, so a refusal has something to spare.
      const built = runPack(box, []);
      assert(built.status === 0, `pack.py runs on the whole tree — ${(built.stderr || '').trim()}`);
      const zip = `${box}/yt-channel-volume-0.0.0.zip`;
      const before = fs.statSync(zip).size;
      breakIt(box);
      for (const args of [['--list'], []]) {
        const refused = runPack(box, args);
        assert(refused.status !== 0,
          `pack.py ${args.join(' ')} refuses a package with ${broken}`.replace('  ', ' '));
        assert(!/^\s*\+ /m.test(refused.stdout || ''),
          `pack.py names nothing as packed with ${broken}`);
        // A traceback exits non-zero too, and says what broke rather than what
        // is wrong with the package.
        assert(!/Traceback \(most recent call last\)/.test(refused.stderr || ''),
          `pack.py says what is wrong with ${broken}, instead of raising`);
        if (diagnosis) {
          assert(diagnosis.test(refused.stderr || ''),
            `pack.py names ${diagnosis} for ${broken} — said: ${(refused.stderr || '').trim()}`);
        }
      }
      assert(fs.existsSync(zip) && fs.statSync(zip).size === before,
        `the package built before is left alone with ${broken}`);
      fs.rmSync(box, { recursive: true, force: true });
    }

    // Resolving every name answers for one that is missing; reading one can
    // still fail. What the package built last is worth is that it stays.
    for (const unreadable of ['LICENSE', '_locales/ja/messages.json']) {
      const box = buildMinimal();
      const built = runPack(box, []);
      assert(built.status === 0, `pack.py runs on the whole tree — ${(built.stderr || '').trim()}`);
      const zip = `${box}/yt-channel-volume-0.0.0.zip`;
      const before = fs.statSync(zip).size;
      const entries = require('child_process').spawnSync('python3',
        ['-c', 'import zipfile,sys;print(len(zipfile.ZipFile(sys.argv[1]).namelist()))', zip],
        { encoding: 'utf8' }).stdout.trim();
      fs.chmodSync(`${box}/${unreadable}`, 0o000);
      let denied = true;
      try { fs.readFileSync(`${box}/${unreadable}`); denied = false; } catch { /* denied */ }
      if (!denied) {
        // Running as a user the mode does not stop, so the case cannot be made.
        console.log(`  (read-failure check skipped: ${unreadable} is readable at mode 000)`);
        fs.chmodSync(`${box}/${unreadable}`, 0o644);
        fs.rmSync(box, { recursive: true, force: true });
        continue;
      }
      const failed = runPack(box, []);
      fs.chmodSync(`${box}/${unreadable}`, 0o644);
      assert(failed.status !== 0, `pack.py fails when ${unreadable} cannot be read`);
      assert(fs.existsSync(zip) && fs.statSync(zip).size === before,
        `the package built before survives a read failure on ${unreadable}`);
      const after = require('child_process').spawnSync('python3',
        ['-c', 'import zipfile,sys;print(len(zipfile.ZipFile(sys.argv[1]).namelist()))', zip],
        { encoding: 'utf8' }).stdout.trim();
      assert(after === entries,
        `the package built before still carries ${entries} entries, not ${after}`);
      assert(!fs.readdirSync(box).some(name => name.endsWith('.part')),
        'a half-built package is not left beside the one that stands');
      fs.rmSync(box, { recursive: true, force: true });
    }

    // Four shapes Chrome reads without complaint. Each is a rule the checks above
    // could over-reach into: a name with an @ in it, Chrome's own message where
    // it is allowed, a literal dollar, and a positional argument in a
    // placeholder's content.
    for (const [shape, arrange] of [
      ['a message named with an @ in it', box => {
        writeCatalog(box, { 'foo@bar': { message: 'x' } });
        editManifest(box, m => { m.name = '__MSG_foo@bar__'; });
      }],
      ['the extension id read from a stylesheet', box => {
        fs.writeFileSync(`${box}/styles.css`,
          'body { background: url("__MSG_@@extension_id__") }\n');
        editManifest(box, m => {
          m.content_scripts = [{ js: ['content.js'], css: ['styles.css'] }];
        });
      }],
      ['a positional argument in a placeholder', box => writeCatalog(box,
        { extName: { message: 'hi $WHO$', placeholders: { who: { content: '$1' } } } })],
      ['two references sharing a delimiter, both defined', box => writeCatalog(box,
        { extName: { message: '$A$$B$',
          placeholders: { a: { content: '$1' }, b: { content: '$2' } } } })],
      ['a placeholder named with an @ in it', box => writeCatalog(box,
        { extName: { message: '$A@B$', placeholders: { 'a@b': { content: '$1' } } } })],
      ['a description that is not text',
        box => writeCatalog(box, { extName: { message: 'x', description: 7 } })],
      ['an example that is not text', box => writeCatalog(box,
        { extName: { message: 'x $A$', placeholders: { a: { content: '$1', example: 7 } } } })],
      ['two names differing only in case', box => writeCatalog(box,
        { extName: { message: 'x' }, EXTNAME: { message: 'y' } })],
      ['a catalog answering for a name under @@', box => {
        writeCatalog(box, { extName: { message: 'x' }, '@@custom': { message: 'y' } });
        editManifest(box, m => { m.description = '__MSG_@@custom__'; });
      }],
      // The extension id is the catalog's to answer for: Chrome does not supply
      // it to the manifest, and refusing the name outright would take this too.
      ['a catalog answering for the extension id, asked for in the manifest', box => {
        writeCatalog(box,
          { extName: { message: 'x' }, '@@extension_id': { message: 'y' } });
        editManifest(box, m => { m.description = '__MSG_@@extension_id__'; });
      }],
      // A candidate that is not a name is passed over rather than refused, so a
      // reference whose name ends in a newline names nothing at all. It goes in
      // a stylesheet because the manifest is read as the JSON text it is, where
      // a newline is written as an escape and never reaches a candidate.
      // Chrome reads both files with a byte order mark and with comments, and
      // reads neither the // in a URL nor the /* in a message as one.
      ['a byte order mark on the manifest', box => {
        const text = fs.readFileSync(`${box}/manifest.json`, 'utf8');
        fs.writeFileSync(`${box}/manifest.json`, '\uFEFF' + text);
      }],
      ['a byte order mark on the catalog', box => {
        const text = fs.readFileSync(`${box}/_locales/ja/messages.json`, 'utf8');
        fs.writeFileSync(`${box}/_locales/ja/messages.json`, '\uFEFF' + text);
      }],
      ['a line comment in the manifest', box => {
        const text = fs.readFileSync(`${box}/manifest.json`, 'utf8');
        fs.writeFileSync(`${box}/manifest.json`, '{\n  // what this is\n' + text.slice(1));
      }],
      ['a line comment in the catalog', box => fs.writeFileSync(
        `${box}/_locales/ja/messages.json`,
        '{\n  // the name\n  "extName": { "message": "x" }\n}')],
      ['a block comment in the catalog', box => fs.writeFileSync(
        `${box}/_locales/ja/messages.json`,
        '{\n  /* the name */\n  "extName": { "message": "x" }\n}')],
      // The manifest is walked as the values it decoded to: a reference inside a
      // comment is one Chrome dropped before parsing, a reference spelled with
      // escapes is one it decoded, and an object key is not a field it localizes.
      ['a reference nothing answers, inside a line comment', box => {
        const text = fs.readFileSync(`${box}/manifest.json`, 'utf8');
        fs.writeFileSync(`${box}/manifest.json`,
          '{\n  // "description": "__MSG_absent__"\n' + text.slice(1));
      }],
      ['a reference nothing answers, inside a block comment', box => {
        const text = fs.readFileSync(`${box}/manifest.json`, 'utf8');
        fs.writeFileSync(`${box}/manifest.json`,
          '{\n  /* "description": "__MSG_absent__" */\n' + text.slice(1));
      }],
      ['the extension id inside a comment', box => {
        const text = fs.readFileSync(`${box}/manifest.json`, 'utf8');
        fs.writeFileSync(`${box}/manifest.json`,
          '{\n  // "description": "__MSG_@@extension_id__"\n' + text.slice(1));
      }],
      ['a reference spelled with escapes that the catalog answers', box => {
        writeCatalog(box, { extName: { message: 'x' }, absent: { message: 'y' } });
        appendRaw(box, '"description":"__MSG_\\u0061bsent__"');
      }],
      ['a reference in an object key rather than a value',
        box => editManifest(box, m => { m['__MSG_absent__'] = 'x'; })],
      ['a comment opener inside a string value', box => {
        editManifest(box, m => { m.homepage_url = 'https://example.com/*'; });
        // The escaped quote is the point: a scanner that does not step over it
        // ends the string early and reads the // after it as a comment.
        writeCatalog(box, { extName: { message: 'a \" b // c /* d' } });
      }],
      ['a reference whose candidate is not a name', box => {
        fs.writeFileSync(`${box}/styles.css`, 'body { content: "__MSG_abc\n__" }\n');
        editManifest(box, m => {
          m.content_scripts = [{ js: ['content.js'], css: ['styles.css'] }];
        });
      }],
      ['the extension id asked for in capitals from a stylesheet', box => {
        fs.writeFileSync(`${box}/styles.css`,
          'body { background: url("__MSG_@@EXTENSION_ID__") }\n');
        editManifest(box, m => {
          m.content_scripts = [{ js: ['content.js'], css: ['styles.css'] }];
        });
      }],
      // The three sides of the version rule that a stricter one would refuse.
      // Without these, refusing every version would stay green.
      ['a version of four parts',
        box => editManifest(box, m => { m.version = '1.0.0.0'; })],
      ['a leading zero in a part that is not the first',
        box => editManifest(box, m => { m.version = '1.01.0'; })],
      ['a version part at the largest number one holds',
        box => editManifest(box, m => { m.version = '4294967295'; })],
      // The shape a prerelease takes: Chrome reads the version and shows the
      // name. Without this the rule above would refuse the only shape that
      // lets the prerelease branch of the release grammar build anything.
      ['a prerelease named beside the version Chrome reads', box => {
        editManifest(box, m => {
          m.version = '1.2.0';
          m.version_name = '1.2.0-rc1';
        });
      }],
      // Naming nothing has nothing to do with spelling: Chrome takes a pattern
      // that matches no file, so this does too.
      ['a resource pattern that names nothing', box => {
        fs.mkdirSync(`${box}/images`);
        fs.writeFileSync(`${box}/images/logo.png`, 'x');
        editManifest(box, m => {
          m.web_accessible_resources = [{ resources: ['images/*.svg'],
            matches: ['https://example.com/*'] }];
        });
      }],
      // The spelling is compared, not folded: a name the tree really carries
      // in capitals is the name that opens it. Without this the rule above
      // could refuse every reference and stay green.
      ['a name the tree carries in capitals', box => {
        fs.renameSync(`${box}/content.js`, `${box}/Content.js`);
        editManifest(box, m => { m.content_scripts = [{ js: ['Content.js'] }]; });
      }],
      // The Norwegian the store does carry, which is the name an extension
      // reaching for nb is told to use instead. Without this the rule above
      // could refuse every locale and stay green.
      ['a locale the store carries under a name of its own', box => {
        fs.renameSync(`${box}/_locales/ja`, `${box}/_locales/no`);
        editManifest(box, m => { m.default_locale = 'no'; });
      }],
      // Outside the fields Chrome localizes, a reference is not a reference:
      // the string reaches the browser as it stands, a file name included.
      ['a content script named like a message', box => {
        fs.renameSync(`${box}/content.js`, `${box}/__MSG_absent__.js`);
        editManifest(box, m => {
          m.content_scripts = [{ js: ['__MSG_absent__.js'] }];
        });
      }],
      ['a reference in a field Chrome leaves as it stands',
        box => editManifest(box, m => { m.author = { email: '__MSG_absent__' }; })]
    ]) {
      const box = buildMinimal();
      arrange(box);
      const listed = runPack(box, ['--list']);
      assert(listed.status === 0,
        `${shape} packs — ${(listed.stderr || '').trim()}`);
      fs.rmSync(box, { recursive: true, force: true });
    }

    // A message Chrome defines itself needs no catalog entry. Without this the
    // rule above could refuse every @@ name and stay green.
    {
      const box = buildMinimal();
      const manifest = JSON.parse(fs.readFileSync(`${box}/manifest.json`, 'utf8'));
      manifest.description = '__MSG_@@ui_locale__';
      fs.writeFileSync(`${box}/manifest.json`, JSON.stringify(manifest));
      const listed = runPack(box, ['--list']);
      assert(listed.status === 0,
        `a message Chrome defines packs — ${(listed.stderr || '').trim()}`);
      fs.rmSync(box, { recursive: true, force: true });
    }

    // Asking for no message, an extension needs no catalog and no locale name.
    // Without this the contract above could refuse everything and stay green.
    {
      const box = buildMinimal();
      fs.rmSync(`${box}/_locales`, { recursive: true });
      const manifest = JSON.parse(fs.readFileSync(`${box}/manifest.json`, 'utf8'));
      delete manifest.default_locale;
      manifest.name = 'Plain';
      fs.writeFileSync(`${box}/manifest.json`, JSON.stringify(manifest));
      const listed = runPack(box, ['--list']);
      assert(listed.status === 0,
        `an extension asking for no message packs — ${(listed.stderr || '').trim()}`);
      assert(JSON.stringify(listed.stdout.split('\n').map(line => line.trim()).filter(Boolean).sort())
        === JSON.stringify(['LICENSE', 'content.js', 'manifest.json']),
        `it carries what it names and nothing else — ${listed.stdout.trim()}`);
      fs.rmSync(box, { recursive: true, force: true });
    }

    // A name the walk reaches and the locale sweep or DISTRIBUTION_FILES reaches
    // too. zipfile writes the second entry and warns on stderr, which the
    // release path does not read.
    {
      const box = buildMinimal();
      const manifest = JSON.parse(fs.readFileSync(`${box}/manifest.json`, 'utf8'));
      manifest.web_accessible_resources = [
        { resources: ['LICENSE', '_locales/ja/messages.json'], matches: ['*://*/*'] }
      ];
      fs.writeFileSync(`${box}/manifest.json`, JSON.stringify(manifest));
      const listed = runPack(box, ['--list']);
      assert(listed.status === 0, `pack.py --list runs — ${(listed.stderr || '').trim()}`);
      const names = listed.stdout.split('\n').map(line => line.trim()).filter(Boolean);
      assert(names.length === new Set(names).size,
        `each name enters the package once — ${names.join(', ')}`);
      fs.rmSync(box, { recursive: true, force: true });
    }

    // An argument nobody recognised is not an instruction to rewrite the package.
    {
      const box = buildMinimal();
      const built = runPack(box, []);
      assert(built.status === 0, `pack.py runs on the whole tree — ${(built.stderr || '').trim()}`);
      const zip = `${box}/yt-channel-volume-0.0.0.zip`;
      const stamp = fs.statSync(zip).mtimeMs;
      for (const argument of [['--lst'], ['-l'], ['--help'], ['--list', 'extra']]) {
        const refused = runPack(box, argument);
        assert(refused.status !== 0, `pack.py refuses ${argument.join(' ')}`);
        assert(!/^\s*\+ /m.test(refused.stdout || ''),
          `pack.py packs nothing for ${argument.join(' ')}`);
      }
      assert(fs.statSync(zip).mtimeMs === stamp,
        'the package standing there is not rewritten by an argument nobody recognised');
      fs.rmSync(box, { recursive: true, force: true });
    }
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
assert(!/updateChannelVolumes\(/.test(contentSrc) && !/updateChannelVolumes\(/.test(optionsSrc),
  'no page performs a channel read-modify-write of its own');
for (const write of Object.keys(CHANNEL_WRITES)) {
  assert(contentSrc.includes(`'${write}'`) || optionsSrc.includes(`'${write}'`),
    `channel write ${write} is requested by a page`);
}

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

  // ── Summary ────────────────────────────────────────────────────────

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runMigrationTests();
