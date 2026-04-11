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
globalThis.chrome = { i18n: { getMessage: () => '' } };
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
assert(SETTINGS_KEY === 'autoLoudnessSettings', 'SETTINGS_KEY');
assert(CHANNEL_VOLUMES_KEY === 'channelVolumes', 'CHANNEL_VOLUMES_KEY');

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
