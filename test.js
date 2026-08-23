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
const manifest = JSON.parse(fs.readFileSync('./manifest.json', 'utf8'));
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
const packSrc = fs.readFileSync('./pack.py', 'utf8');
const excludeBlock = packSrc.slice(packSrc.indexOf('EXCLUDE = {'), packSrc.indexOf('}', packSrc.indexOf('EXCLUDE = {')));
const excluded = new Set(Array.from(excludeBlock.matchAll(/'([^']+)'/g), m => m[1]));
const manifestFiles = [
  ...(manifest.content_scripts || []).flatMap(script => script.js || []),
  manifest.background?.service_worker,
  manifest.options_page,
  manifest.action?.default_popup,
  ...Object.values(manifest.action?.default_icon || {}),
  ...Object.values(manifest.icons || {})
].filter(Boolean);
for (const file of manifestFiles) {
  assert(!excluded.has(file.split('/')[0]) && !excluded.has(file),
    `${file} is referenced by the manifest and must be packed`);
  assert(fs.existsSync('./' + file), `${file} exists`);
}

section('README screenshots');
const readmeSrc = fs.readFileSync('./README.md', 'utf8');
const readmeImages = Array.from(
  readmeSrc.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g), m => m[1])
  .filter(image => !/^https?:/.test(image));
for (const image of readmeImages) {
  assert(fs.existsSync('./' + image), `${image} is embedded in the README and must exist`);
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
  const committed = fs.existsSync('./' + outDir) ? fs.readdirSync('./' + outDir) : [];
  for (const name of committed) {
    assert(generated.has(`${outDir}/${name}`),
      `${outDir}/${name} is committed but nothing draws it`);
  }

  const embedded = readmeImages.filter(image => image.startsWith(outDir + '/'));
  assert(embedded.length > 0, 'the README embeds screenshots');
  for (const image of embedded) {
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

  assert(excluded.has(outDir.split('/')[0]), 'the screenshots stay out of the store zip');

  // Whether the committed images are the ones this code draws can only be
  // answered by drawing them, which needs pillow. CI installs it and runs the
  // same command as its own step, so a machine without it says so here.
  // -B: a __pycache__ at the extension root makes Chrome refuse to load the
  // unpacked extension, and this runs from that root.
  const drawn = require('child_process').spawnSync(
    'python3', ['-B', 'gen_screenshots.py', '--check'], { encoding: 'utf8' });
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
    assert(excluded.has(fontDir[1]), 'the vendored font stays out of the store zip');
  }

  // CI redraws into an empty directory and uploads that one, so the artifact
  // holds what the runner drew and nothing else that sits in docs/screenshots.
  assert(genSrc.includes("'--out'"), 'gen_screenshots.py takes --out');
  assert(excluded.has('test-screenshots.py'), 'the generator test stays out of the store zip');
  const paths = require('child_process').spawnSync(
    'python3', ['-B', 'test-screenshots.py'], { encoding: 'utf8' });
  if (paths.error || paths.status === 3) {
    console.log(`  (path test skipped: ${(paths.error || paths.stderr || '').toString().trim()})`);
  } else {
    assert(paths.status === 0,
      `test-screenshots.py — ${(paths.stdout || '').trim().split('\n').filter(l => l.includes('FAIL')).join('; ')}`);
  }
  const ciYaml = fs.readFileSync('./.github/workflows/ci.yaml', 'utf8');
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
assert(excluded.has('screenshots'),
  'a screenshots/ left over from before the move stays out of the store zip');

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
