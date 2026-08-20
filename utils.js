// utils.js — Shared constants and utilities for popup / options pages

const SETTINGS_KEY = 'autoLoudnessSettings';
const CHANNEL_VOLUMES_KEY = 'channelVolumes';
// Legacy Auto-learned gain storage, folded into CHANNEL_VOLUMES_KEY on load.
const LEGACY_AUTO_FALLBACKS_KEY = 'autoLoudnessFallbacks';
const LEGACY_AUTO_FALLBACK_KEY_PREFIX = 'autoLoudnessFallback:';
const YT_REFERENCE_LUFS = -14;
const DEFAULT_TARGET_LUFS = -18;
const DEFAULT_AUTO_APPLY_LOUDNESS = false;

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

function formatAutoGain(gain, displayUnit, autoLabel = 'Auto') {
  const formatted = formatGain(gain ?? 1.0, displayUnit);
  return `${autoLabel} (${formatted.text}${formatted.unit})`;
}

function normalizeStoredGain(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function gainKeyFor(videoType) {
  return videoType === 'live' ? 'gainLive' : 'gainVideo';
}

function autoApplyKeyFor(videoType) {
  return videoType === 'live' ? 'autoApplyLoudnessLive' : 'autoApplyLoudnessVideo';
}

function getChannelGain(entry, videoType) {
  if (!entry) return null;
  if ('gain' in entry && !('gainLive' in entry) && !('gainVideo' in entry)) {
    return entry.gain;
  }
  return entry[gainKeyFor(videoType)] ?? null;
}

// Expands the legacy single-gain format so both types stay independent.
function setChannelGain(entry, videoType, gain) {
  if ('gain' in entry && !('gainLive' in entry) && !('gainVideo' in entry)) {
    entry.gainLive = entry.gain;
    entry.gainVideo = entry.gain;
    delete entry.gain;
  }
  entry[gainKeyFor(videoType)] = gain;
}

// Expands the legacy all-types flag so one type can be set on its own.
function setChannelAutoApply(entry, videoType, enabled) {
  if ('autoApplyLoudness' in entry) {
    entry.autoApplyLoudnessVideo = !!entry.autoApplyLoudness;
    entry.autoApplyLoudnessLive = !!entry.autoApplyLoudness;
    delete entry.autoApplyLoudness;
  }
  entry[autoApplyKeyFor(videoType)] = !!enabled;
}

function hasExplicitAutoApply(entry, videoType) {
  if (!entry) return false;
  return autoApplyKeyFor(videoType) in entry || 'autoApplyLoudness' in entry;
}

function resolveAutoApplySetting(entry, videoType, defaultValue) {
  if (!entry) return !!defaultValue;
  const autoKey = autoApplyKeyFor(videoType);
  if (autoKey in entry) return !!entry[autoKey];
  if ('autoApplyLoudness' in entry) return !!entry.autoApplyLoudness;
  return !!defaultValue;
}

// One-time upgrade. Auto used to store the gain it learned under its own key,
// so switching Auto off swapped the applied value for a separately kept manual
// gain. Fold the learned values into the single per-channel gain, and record
// the Auto state that a saved gain used to imply, then drop the old keys.
async function migrateLegacyAutoGains() {
  const stored = await chrome.storage.local.get(null);
  const legacyKeys = Object.keys(stored).filter(
    key => key.startsWith(LEGACY_AUTO_FALLBACK_KEY_PREFIX)
  );
  const hasLegacyAggregate =
    Object.prototype.hasOwnProperty.call(stored, LEGACY_AUTO_FALLBACKS_KEY);
  if (!legacyKeys.length && !hasLegacyAggregate) return false;

  const all = stored[CHANNEL_VOLUMES_KEY] || {};
  const settings = stored[SETTINGS_KEY] || {};
  const defaults = {
    video: settings.autoApplyLoudnessVideoDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS,
    live: settings.autoApplyLoudnessLiveDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS
  };

  for (const entry of Object.values(all)) {
    for (const videoType of ['video', 'live']) {
      if (hasExplicitAutoApply(entry, videoType)) continue;
      if (getChannelGain(entry, videoType) === null) continue;
      setChannelAutoApply(entry, videoType, false);
    }
  }

  const legacyAggregate = stored[LEGACY_AUTO_FALLBACKS_KEY] || {};
  for (const [channelId, entry] of Object.entries(all)) {
    for (const videoType of ['video', 'live']) {
      if (!resolveAutoApplySetting(entry, videoType, defaults[videoType])) continue;
      const granularKey =
        `${LEGACY_AUTO_FALLBACK_KEY_PREFIX}${channelId}:${videoType}`;
      const learned = Object.prototype.hasOwnProperty.call(stored, granularKey)
        ? normalizeStoredGain(stored[granularKey])
        : normalizeStoredGain(legacyAggregate[channelId]?.[gainKeyFor(videoType)]);
      if (learned === null) continue;
      setChannelGain(entry, videoType, learned);
    }
  }

  await chrome.storage.local.set({ [CHANNEL_VOLUMES_KEY]: all });
  const removeKeys = hasLegacyAggregate
    ? legacyKeys.concat(LEGACY_AUTO_FALLBACKS_KEY)
    : legacyKeys;
  await chrome.storage.local.remove(removeKeys);
  return true;
}

function isManualGainLocked(autoApplyEnabled, hasLoudness) {
  return !!autoApplyEnabled && !!hasLoudness;
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
