// utils.js — Shared constants and utilities for popup / options pages

const SETTINGS_KEY = 'autoLoudnessSettings';
const CHANNEL_VOLUMES_KEY = 'channelVolumes';
const YT_REFERENCE_LUFS = -14;
const DEFAULT_TARGET_LUFS = -18;

function gainToPercent(gain) { return Math.round(gain * 100); }
function percentToGain(pct) { return pct / 100; }

function gainToDb(gain) {
  if (gain <= 0) return '-Inf';
  return (20 * Math.log10(gain)).toFixed(1);
}

function msg(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

/** @returns {{ text: string, unit: string }} */
function formatGain(gain, displayUnit) {
  if (displayUnit === 'dB') return { text: gainToDb(gain), unit: ' dB' };
  return { text: String(gainToPercent(gain)), unit: '%' };
}

function calcGain(loudnessDb, targetLufs) {
  const effectiveLufs = loudnessDb > 0
    ? YT_REFERENCE_LUFS
    : YT_REFERENCE_LUFS + loudnessDb;
  const compensationDb = targetLufs - effectiveLufs;
  const gain = Math.pow(10, compensationDb / 20);
  if (!isFinite(gain)) return 1.0;
  return Math.max(0, Math.min(6, gain));
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
