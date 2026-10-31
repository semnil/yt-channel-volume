// utils.js — Shared constants and utilities for content / popup / options / service worker

const SETTINGS_KEY = 'autoLoudnessSettings';
const CHANNEL_VOLUMES_KEY = 'channelVolumes';
// Legacy Auto-learned gain storage, folded into CHANNEL_VOLUMES_KEY on load.
const LEGACY_AUTO_FALLBACKS_KEY = 'autoLoudnessFallbacks';
const LEGACY_AUTO_FALLBACK_KEY_PREFIX = 'autoLoudnessFallback:';
const YT_REFERENCE_LUFS = -14;
const DEFAULT_TARGET_LUFS = -18;
const DEFAULT_AUTO_APPLY_LOUDNESS = false;
// Marks a profile whose gains already went through the unification below. Auto
// stores gains without an Auto flag, which is the same shape the migration
// reads as "saved manually", so it must run at most once. It is a top-level
// key because every settings writer merges into a snapshot of the settings
// object, and one whose read predates the migration would drop the mark.
const UNIFIED_GAINS_KEY = 'unifiedGains';

function isContextValid() {
  try { return !!chrome.runtime?.id; } catch (_) { return false; }
}

// Every channel-map write goes through here. The map lives under one storage
// key, so a read-modify-write started before another one's set lands drops its
// entry; Auto stores a gain for every video, which makes that overlap routine.
// Serializing per document keeps the writers in this context in order.
let channelVolumesWrite = Promise.resolve();

function updateChannelVolumes(mutate, extraKeys) {
  const write = channelVolumesWrite.then(async () => {
    if (!isContextValid()) return;
    const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
    const all = data[CHANNEL_VOLUMES_KEY] || {};
    const before = JSON.stringify(all);
    mutate(all);
    // Auto re-applies on every navigation and tab activation. Skipping an
    // identical write keeps other tabs and the options page from redrawing.
    if (JSON.stringify(all) === before && !extraKeys) return;
    await chrome.storage.local.set({ [CHANNEL_VOLUMES_KEY]: all, ...extraKeys });
  });
  channelVolumesWrite = write.catch(() => {});
  return write;
}

// The settings that belong to no channel live in storage.sync, which Chrome
// syncs with every Chrome the user is signed in to where Chrome sync is on, and
// which behaves like local where it is off. A profile whose settings the worker
// has not moved there yet still holds them in local, and they are read from
// there until it has.
async function readSettings() {
  const synced = await chrome.storage.sync.get(SETTINGS_KEY);
  if (synced[SETTINGS_KEY]) return synced[SETTINGS_KEY];
  const local = await chrome.storage.local.get(SETTINGS_KEY);
  if (local[SETTINGS_KEY]) return local[SETTINGS_KEY];
  // The move writes sync before it clears local, so a local read that comes
  // back empty may have been made across the move, and sync then holds what it
  // moved.
  const moved = await chrome.storage.sync.get(SETTINGS_KEY);
  return moved[SETTINGS_KEY] || {};
}

// Every settings write the worker makes goes through here, the move among them.
// The move reads sync before it writes it, so a save landing in between would
// be put back to local's older copy; queued one after the other, a save waits
// for the move and the move for a save, whichever worker start the move is in.
let settingsWrite = Promise.resolve();

function queueSettingsWrite(work) {
  const write = settingsWrite.then(work);
  settingsWrite = write.catch(() => {});
  return write;
}

// The fields the settings page saves, and what each of them may hold.
const SETTING_FIELDS = {
  targetLufs: value => Number.isFinite(value) && value >= -30 && value <= -6,
  displayUnit: value => value === '%' || value === 'dB',
  showGainOverlay: value => typeof value === 'boolean',
  autoApplyLoudnessVideoDefault: value => typeof value === 'boolean',
  autoApplyLoudnessLiveDefault: value => typeof value === 'boolean'
};

// The settings writes the options page asks the worker for. A write naming a
// field the page has not got, or a value that field cannot hold, is refused
// the way a channel write that names no channel is.
const SETTINGS_WRITES = {
  saveSetting(msg) {
    const accepts = Object.prototype.hasOwnProperty.call(SETTING_FIELDS, msg.key)
      ? SETTING_FIELDS[msg.key]
      : null;
    if (!accepts) throw new ChannelWriteRefused('not a setting');
    if (!accepts(msg.value)) throw new ChannelWriteRefused(`not a value ${msg.key} can hold`);
    return queueSettingsWrite(async () => {
      // Read where it is now, so a write made before the move carries the rest
      // of the settings with it.
      const s = await readSettings();
      s[msg.key] = msg.value;
      await chrome.storage.sync.set({ [SETTINGS_KEY]: s });
    });
  }
};

// Moves settings saved before they synced out of local. Settings another
// Chrome the user is signed in to already put in sync, with Chrome sync on, are
// the ones every such Chrome reads, so they stay and the local copy goes. Sync
// is written before local is cleared, so a reader always finds one of the two.
async function moveSettingsToSync() {
  const local = await chrome.storage.local.get(SETTINGS_KEY);
  if (!local[SETTINGS_KEY]) return false;
  const synced = await chrome.storage.sync.get(SETTINGS_KEY);
  if (!synced[SETTINGS_KEY]) {
    await chrome.storage.sync.set({ [SETTINGS_KEY]: local[SETTINGS_KEY] });
  }
  await chrome.storage.local.remove(SETTINGS_KEY);
  return true;
}

function formatAutoGain(gain, displayUnit, autoLabel = 'Auto') {
  // Auto has stored no gain for this type yet. Naming a number here would
  // claim a level that nothing is playing at.
  if (gain === null || gain === undefined) return `${autoLabel} (—)`;
  const formatted = formatGain(gain, displayUnit);
  return `${autoLabel} (${formatted.text}${formatted.unit})`;
}

function normalizeStoredGain(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// A name equal to the channel ID is the placeholder the bridge falls back to
// before the author is known. Auto saves a gain for every video, so such a
// placeholder must never replace a name already stored for the channel.
function applyChannelIdentity(entry, channelId, name, url) {
  if (name && name !== channelId) entry.name = name;
  else if (!entry.name) entry.name = channelId;
  if (url) entry.url = url;
}

function gainKeyFor(videoType) {
  return videoType === 'live' ? 'gainLive' : 'gainVideo';
}

function autoApplyKeyFor(videoType) {
  return videoType === 'live' ? 'autoApplyLoudnessLive' : 'autoApplyLoudnessVideo';
}

// Set beside a type's gain when that gain is held against the plain rendition
// (the audio the player response describes, before stable volume). A gain
// stored without it plays as it is.
function plainMarkKeyFor(videoType) {
  return gainKeyFor(videoType) + 'Plain';
}

function isGainHeldAgainstPlain(entry, videoType) {
  return !!entry && entry[plainMarkKeyFor(videoType)] === true;
}

function getChannelGain(entry, videoType) {
  if (!entry) return null;
  if ('gain' in entry && !('gainLive' in entry) && !('gainVideo' in entry)) {
    return entry.gain;
  }
  return entry[gainKeyFor(videoType)] ?? null;
}

// Expands the legacy single-gain format so both types stay independent.
// `heldAgainstPlain` marks the gain as held against the plain rendition; a
// gain set without it loses any mark the type had.
function setChannelGain(entry, videoType, gain, heldAgainstPlain = false) {
  if ('gain' in entry && !('gainLive' in entry) && !('gainVideo' in entry)) {
    entry.gainLive = entry.gain;
    entry.gainVideo = entry.gain;
    delete entry.gain;
  }
  entry[gainKeyFor(videoType)] = gain;
  if (heldAgainstPlain) entry[plainMarkKeyFor(videoType)] = true;
  else delete entry[plainMarkKeyFor(videoType)];
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

// A channel id in the UC form, the form every channel is saved under.
function isChannelId(value) {
  return typeof value === 'string' && /^UC[A-Za-z0-9_-]+$/.test(value);
}

// A channel write whose message does not describe a channel. It is refused
// before the map is read, and the worker answers it as refused rather than as a
// storage failure.
class ChannelWriteRefused extends Error {}

function checkChannelIdentity(msg) {
  if (!isChannelId(msg.channelId)) {
    throw new ChannelWriteRefused('channel id is not in the UC form');
  }
  for (const key of ['name', 'url']) {
    if (msg[key] !== undefined && typeof msg[key] !== 'string') {
      throw new ChannelWriteRefused(`channel ${key} is not text`);
    }
  }
}

// Every channelVolumes mutation the extension performs. The service worker is
// the only context that runs them, so two tabs cannot read the map and write
// back over each other's channel.
const CHANNEL_WRITES = {
  saveChannelGain(msg) {
    checkChannelIdentity(msg);
    if (!Number.isFinite(msg.gain)) throw new ChannelWriteRefused('gain is not a finite number');
    return updateChannelVolumes(all => {
      const entry = all[msg.channelId] || {};
      applyChannelIdentity(entry, msg.channelId, msg.name, msg.url);
      setChannelGain(entry, msg.videoType, msg.gain, msg.heldAgainstPlain === true);
      if (msg.autoApply !== undefined) {
        setChannelAutoApply(entry, msg.videoType, msg.autoApply);
      }
      all[msg.channelId] = entry;
    });
  },
  saveChannelAutoApply(msg) {
    checkChannelIdentity(msg);
    return updateChannelVolumes(all => {
      const entry = all[msg.channelId] || {};
      applyChannelIdentity(entry, msg.channelId, msg.name, msg.url);
      // Store both true and false so an explicit per-channel choice can
      // override the all-channel default without modifying any saved gain.
      setChannelAutoApply(entry, msg.videoType, msg.enabled);
      all[msg.channelId] = entry;
    });
  },
  deleteChannel(msg) {
    return updateChannelVolumes(all => { delete all[msg.channelId]; });
  },
  clearChannels() {
    return updateChannelVolumes(all => {
      for (const channelId of Object.keys(all)) delete all[channelId];
    });
  },
  // Adopts an entry saved under a bare @handle once the player response names
  // the channel. The name match is what prevents adopting another channel's.
  adoptHandleEntry(msg) {
    checkChannelIdentity(msg);
    if (typeof msg.authorName !== 'string') throw new ChannelWriteRefused('author name is not text');
    return updateChannelVolumes(all => {
      if (all[msg.channelId]) return;
      const match = Object.entries(all).find(([key, value]) =>
        key.startsWith('@') && value.name === msg.authorName
      );
      if (!match) return;
      const [handleKey, entry] = match;
      all[msg.channelId] = { ...entry, url: msg.url };
      delete all[handleKey];
    });
  },
  migrateLegacyGains() {
    return migrateLegacyAutoGains();
  }
};

// `unmigrated` is for a profile whose legacy fold has not run yet: there a
// stored gain still carries its old meaning — the channel opted out of the
// all-channel default — and reading it under the current rule would hand the
// channel to Auto, which overwrites that gain with a calculated one.
function resolveAutoApplySetting(entry, videoType, defaultValue, unmigrated) {
  if (!entry) return !!defaultValue;
  const autoKey = autoApplyKeyFor(videoType);
  if (autoKey in entry) return !!entry[autoKey];
  if ('autoApplyLoudness' in entry) return !!entry.autoApplyLoudness;
  if (unmigrated && getChannelGain(entry, videoType) !== null) return false;
  return !!defaultValue;
}

// One-time upgrade. Auto used to store the gain it learned under its own key,
// so switching Auto off swapped the applied value for a separately kept manual
// gain. Fold the learned values into the single per-channel gain, and record
// the Auto state that a saved gain used to imply, then drop the old keys.
// Channels saved before Auto existed carry a gain and no flag, so this runs
// for them as well — the mark, not the presence of legacy keys, decides.
async function migrateLegacyAutoGains() {
  const stored = await chrome.storage.local.get(null);
  const legacyKeys = Object.keys(stored).filter(
    key => key.startsWith(LEGACY_AUTO_FALLBACK_KEY_PREFIX)
  );
  const hasLegacyAggregate =
    Object.prototype.hasOwnProperty.call(stored, LEGACY_AUTO_FALLBACKS_KEY);
  const removeKeys = hasLegacyAggregate
    ? legacyKeys.concat(LEGACY_AUTO_FALLBACKS_KEY)
    : legacyKeys;
  if (stored[UNIFIED_GAINS_KEY]) {
    // Reached when an earlier run stored the unified gains but did not finish
    // clearing. Nothing reads these keys any more.
    await clearLegacyKeys(removeKeys);
    return false;
  }

  const settings = await readSettings();
  const defaults = {
    video: settings.autoApplyLoudnessVideoDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS,
    live: settings.autoApplyLoudnessLiveDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS
  };
  const legacyAggregate = stored[LEGACY_AUTO_FALLBACKS_KEY] || {};
  const snapshot = stored[CHANNEL_VOLUMES_KEY] || {};

  // Queued like every other channel-map write, and carrying the mark in the
  // same set: a profile can never end up with the gains unified and the mark
  // missing, because the next run would then pin Auto's own gains OFF. The
  // channel map is re-read inside the queue, so a gain saved while the legacy
  // keys were being read survives — every decision below is taken from the
  // snapshot, because a gain that arrived after it is one Auto stored and
  // carries no flag either, which is indistinguishable from a manual save.
  await updateChannelVolumes(all => {
    for (const [channelId, entry] of Object.entries(all)) {
      const saved = snapshot[channelId];
      if (!saved) continue;
      for (const videoType of ['video', 'live']) {
        if (hasExplicitAutoApply(saved, videoType)) continue;
        if (getChannelGain(saved, videoType) === null) continue;
        if (hasExplicitAutoApply(entry, videoType)) continue;
        setChannelAutoApply(entry, videoType, false);
      }
    }

    for (const [channelId, entry] of Object.entries(all)) {
      const saved = snapshot[channelId];
      for (const videoType of ['video', 'live']) {
        if (getChannelGain(entry, videoType) !== getChannelGain(saved, videoType)) continue;
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
  }, { [UNIFIED_GAINS_KEY]: true });
  await clearLegacyKeys(removeKeys);
  return true;
}

// Clearing is housekeeping, not part of the move: the gains are unified and
// marked by the time this runs, and nothing reads these keys any more. Failing
// the caller here would send it back to the pre-unification rule, where a
// saved gain means Auto is off. The next run sweeps whatever is left.
async function clearLegacyKeys(removeKeys) {
  if (!removeKeys.length) return;
  try {
    await chrome.storage.local.remove(removeKeys);
  } catch (err) {
    console.error('[YTCV] legacy Auto keys not cleared', err);
  }
}

function isManualGainLocked(autoApplyEnabled, hasLoudness) {
  return !!autoApplyEnabled && !!hasLoudness;
}

// The keys that move a range input's value. A key held on a slider is a hold
// of these alone; any other key leaves the hold as it is.
const SLIDER_MOVE_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'];

function isSliderMoveKey(key) {
  return SLIDER_MOVE_KEYS.includes(key);
}

// The level YouTube plays a rendition at, after its own normalization.
function effectiveLufs(loudnessDb) {
  return loudnessDb > 0
    ? YT_REFERENCE_LUFS
    : YT_REFERENCE_LUFS + loudnessDb;
}

function calcGain(loudnessDb, targetLufs) {
  const compensationDb = targetLufs - effectiveLufs(loudnessDb);
  const gain = Math.pow(10, compensationDb / 20);
  if (!isFinite(gain)) return 1.0;
  return Math.max(0, Math.min(6, gain));
}

// A live stream's own level, as the player names it, is an absolute one
// YouTube has not normalized, so the gain takes it to the target as it stands.
function calcLiveGain(liveLkfs, targetLufs) {
  const compensationDb = targetLufs - liveLkfs;
  const gain = Math.pow(10, compensationDb / 20);
  if (!isFinite(compensationDb) || !isFinite(gain)) return 1.0;
  return Math.max(0, Math.min(6, gain));
}

// How far apart two gains are, in dB. A gain that is not a positive finite
// number is taken as infinitely far from any other.
function gainChangeDb(gain, baselineGain) {
  const usable = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (!usable(gain) || !usable(baselineGain)) return Infinity;
  return Math.abs(20 * Math.log10(gain / baselineGain));
}

// A gain held against the base rendition (the plain audio the player
// response describes), multiplied by this, is the gain for the rendition
// playing, so that both come out at the same level. Where either level is not
// known the two are taken as one.
function renditionGainRatio(playingDb, baseDb) {
  if (typeof playingDb !== 'number' || typeof baseDb !== 'number') return 1;
  const ratio = Math.pow(10, (effectiveLufs(baseDb) - effectiveLufs(playingDb)) / 20);
  return Number.isFinite(ratio) ? ratio : 1;
}
