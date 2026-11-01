// utils.js — Shared constants and utilities for content / popup / options / service worker

const CHANNEL_VOLUMES_KEY = 'channelVolumes';
// Legacy Auto-learned gain storage, folded into CHANNEL_VOLUMES_KEY on load.
const LEGACY_AUTO_FALLBACKS_KEY = 'autoLoudnessFallbacks';
const LEGACY_AUTO_FALLBACK_KEY_PREFIX = 'autoLoudnessFallback:';
const YT_REFERENCE_LUFS = -14;
// Marks a profile whose gains already went through the unification below. Auto
// stores gains without an Auto flag, which is the same shape the migration
// reads as "saved manually", so it must run at most once. It is a top-level
// key because every settings writer merges into a snapshot of the settings
// object, and one whose read predates the migration would drop the mark.
const UNIFIED_GAINS_KEY = 'unifiedGains';

// Every channel-map write goes through here. The map lives under one storage
// key, so a read-modify-write started before another one's set lands drops its
// entry; Auto stores a gain for every video, which makes that overlap routine.
// Serializing per document keeps the writers in this context in order. Auto
// re-applies on every navigation and tab activation, and a write that leaves
// the map as it was is not made, which keeps other tabs and the options page
// from redrawing.
const updateChannelVolumes = createStoredMapWriter(CHANNEL_VOLUMES_KEY);

// Every settings write the worker makes goes through here, the move among them.
// The move reads sync before it writes it, so a save landing in between would
// be put back to local's older copy; queued one after the other, a save waits
// for the move and the move for a save, whichever worker start the move is in.
const queueSettingsWrite = createSerialQueue();

// The fields the settings page saves, and what each of them may hold.
const SETTING_FIELDS = {
  targetLufs: value => Number.isFinite(value) && value >= MIN_TARGET_LUFS && value <= MAX_TARGET_LUFS,
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
    const accepts = settingCheck(SETTING_FIELDS, msg.key);
    if (!accepts) throw new WriteRefused('not a setting');
    if (!accepts(msg.value)) throw new WriteRefused(`not a value ${msg.key} can hold`);
    return queueSettingsWrite(() => writeSettingsChange((settings) => ({ ...settings, [msg.key]: msg.value })));
  }
};

function normalizeStoredGain(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// A name equal to the channel ID is the placeholder the bridge falls back to
// before the author is known. Auto saves a gain for every video, so such a
// placeholder must never replace a name already stored for the channel.
function applyChannelIdentity(entry, channelId, name, url) {
  applyEntryName(entry, channelId, name);
  if (url) entry.url = url;
}

function gainKeyFor(videoType) {
  return videoType === 'live' ? 'gainLive' : 'gainVideo';
}

// The keys of an entry's gains per type.
const GAIN_SLOTS = ['gainLive', 'gainVideo'];

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
  return storedGain(entry, gainKeyFor(videoType), GAIN_SLOTS);
}

// Expands the legacy single-gain format so both types stay independent.
// `heldAgainstPlain` marks the gain as held against the plain rendition; a
// gain set without it loses any mark the type had.
function setChannelGain(entry, videoType, gain, heldAgainstPlain = false) {
  expandLegacyGain(entry, GAIN_SLOTS);
  entry[gainKeyFor(videoType)] = gain;
  if (heldAgainstPlain) entry[plainMarkKeyFor(videoType)] = true;
  else delete entry[plainMarkKeyFor(videoType)];
}

// The keys of an entry's Auto flags per type.
const AUTO_SLOTS = ['autoApplyLoudnessLive', 'autoApplyLoudnessVideo'];

// Expands the legacy all-types flag so one type can be set on its own.
function setChannelAutoApply(entry, videoType, enabled) {
  setAutoFlag(entry, autoApplyKeyFor(videoType), AUTO_SLOTS, enabled);
}

function hasExplicitAutoApply(entry, videoType) {
  return hasAutoFlag(entry, autoApplyKeyFor(videoType));
}

// A channel id in the UC form, the form every channel is saved under.
function isChannelId(value) {
  return typeof value === 'string' && /^UC[A-Za-z0-9_-]+$/.test(value);
}

function checkChannelIdentity(msg) {
  if (!isChannelId(msg.channelId)) {
    throw new WriteRefused('channel id is not in the UC form');
  }
  // A name that is no text is not taken (applyEntryName); a url that is no
  // text refuses the write.
  if (msg.url !== undefined && typeof msg.url !== 'string') {
    throw new WriteRefused('channel url is not text');
  }
}

// Every channelVolumes mutation the extension performs. The service worker is
// the only context that runs them, so two tabs cannot read the map and write
// back over each other's channel.
const CHANNEL_WRITES = {
  saveChannelGain(msg) {
    checkChannelIdentity(msg);
    if (!isStorableGain(msg.gain)) throw new WriteRefused('gain is not a finite number within 0 to 6');
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
    if (!isRowKey(msg.channelId)) throw new WriteRefused('channel id is empty or not text');
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
    if (typeof msg.authorName !== 'string') throw new WriteRefused('author name is not text');
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
  return autoFlagFor(entry, autoApplyKeyFor(videoType), defaultValue,
    !!unmigrated && getChannelGain(entry, videoType) !== null);
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

// The level YouTube plays a rendition at, after its own normalization.
function effectiveLufs(loudnessDb) {
  return loudnessDb > 0
    ? YT_REFERENCE_LUFS
    : YT_REFERENCE_LUFS + loudnessDb;
}

function calcGain(loudnessDb, targetLufs) {
  return gainForLevel(effectiveLufs(loudnessDb), targetLufs);
}

// A live stream's own level, as the player names it, is an absolute one
// YouTube has not normalized, so the gain takes it to the target as it stands.
function calcLiveGain(liveLkfs, targetLufs) {
  if (!isFinite(targetLufs - liveLkfs)) return 1.0;
  return gainForLevel(liveLkfs, targetLufs);
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
