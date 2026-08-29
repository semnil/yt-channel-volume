# yt-channel-volume

Chrome extension (MV3) that shows a YouTube video's Content Loudness and saves and applies a per-channel gain on a user gesture.
A saved gain is applied automatically to live streams that carry no Content Loudness.
It leaves the YouTube player's volume slider alone and controls the level with a Web Audio API GainNode.

## Architecture

```
page-bridge.js (MAIN world content script, document_start)
├── Object.defineProperty: hooks the assignment of ytInitialPlayerResponse
├── Fetch hook: intercepts /youtubei/v1/player responses (covers SPA navigation)
├── extractFromYtPlayer: reads from ytd-watch-flexy / movie_player (covers SPA navigation)
├── isLiveContent: extracts videoDetails.isLiveContent
└── postMessage → relays loudnessDb + isLiveContent + channelId + author to content.js

background.js (service worker)
├── importScripts('utils.js')
└── the only context that writes channelVolumes, on a `store:<op>` message
    (saveChannelGain / saveChannelAutoApply / deleteChannel / clearChannels /
     adoptHandleEntry / migrateLegacyGains)

utils.js → content.js (ISOLATED world content scripts, document_idle)
├── postMessage listener: receives loudnessDb from page-bridge.js
├── requestLoudnessWithRetry: asks page-bridge.js again on demand
├── Gain calculation (manual apply / per-channel automatic LUFS apply. Both store into the same per-type gain)
│   ├── contentLUFS = -14 + loudnessDb (YouTube reference = -14 LUFS)
│   ├── compensationDb = targetLUFS - contentLUFS
│   └── gain = 10^(compensationDb / 20), clamped [0, 6], NaN/Inf → 1.0
├── Web Audio API: <video> → MediaElementSource → GainNode → destination (connected lazily)
├── Gain overlay: shows the gain value in .ytp-volume-area (switched on and off in the options)
├── Channel detection (UC only): canonical / #owner a[href*="/channel/"] / meta tag → page-bridge channelId (UC form)
│   ├── @handle links go stale during SPA navigation and are rejected outright. Waits for the bridge when the DOM carries no UC
│   └── Display name: page-bridge author (videoDetails.author, authoritative source) → DOM (#owner #channel-name a, fallback)
├── Navigation: triggerApply (async mutex) runs applyVideoVolume directly (no debounce)
│   ├── Triggers: yt-navigate-finish, popstate, visibilitychange, MutationObserver, first load
│   ├── Observer: watches video element changes + URL video ID changes alone (a null guard suppresses the first fire)
│   ├── _applyRunning mutex prevents concurrent runs. forceDetect also goes through triggerApply
│   └── Clears currentChannel when the videoId changes, so stale channel information does not leak
├── videoType: 'live' (stream/archive) or 'video' (video/Shorts) hold separate gains
├── Cross-tab sync: chrome.storage.onChanged delivers channelVolumes changes and the gain for the current channel × videoType is applied at once (no polling, self-tab dedup by currentGain comparison)
└── Storage
    ├── autoLoudnessSettings: { targetLufs, displayUnit, showGainOverlay, autoApplyLoudnessVideoDefault, autoApplyLoudnessLiveDefault }
    ├── channelVolumes: { [channelId]: { name, gainLive, gainVideo, autoApplyLoudnessLive, autoApplyLoudnessVideo, url } }
    └── unifiedGains: the migration-done marker (top-level key)

utils.js (shared, loaded by content / popup / options / background + tests)
├── Constants: storage keys, YT_REFERENCE_LUFS, DEFAULT_TARGET_LUFS
├── Gain utilities: gainToPercent, percentToGain, gainToDb, formatGain, formatAutoGain, calcGain
├── Storage utilities: isContextValid, updateChannelVolumes, CHANNEL_WRITES, getChannelGain, setChannelGain, applyChannelIdentity, normalizeStoredGain, migrateLegacyAutoGains
├── Auto state: resolveAutoApplySetting, setChannelAutoApply, hasExplicitAutoApply, isManualGainLocked
├── i18n: msg()
└── HTML escape: esc()

popup.html / popup.js
├── Loudness / Suggested / Current display (read-only)
├── Fallback badge on Current while Auto is on and no LUFS was detected (the value is the saved gain itself)
├── LIVE badge, shown only while a live stream is playing
├── "Apply to channel" button (computes the gain from loudnessDb and saves it per type)
├── Per-channel × Video/Live "Auto-apply LUFS" toggle, showing only the type being watched
├── Manual Volume: slider (0–600%) + presets. Disabled while Auto is on and LUFS was detected; used for fallback adjustment when no LUFS was detected
├── UI hidden on pages other than watch
└── retryGetState: polling fallback while the loudness has not arrived

options.html / options.js (settings screen, opened in its own tab)
├── Target LUFS slider (-30 to -6 LUFS, default -18)
├── Auto-apply LUFS for all channels (Video / Live separately, default OFF, inherited by a type with no individual Auto flag)
├── Display unit toggle (% / dB)
├── Gain overlay toggle (shown next to the player's volume bar, default OFF)
├── Saved Channels table (Video / Live in two columns. Under Auto it reads `Auto (saved gain)`, with a channel link, deletable)
├── Ships with the screen hidden until the load finishes and with the settings controls and the deletions (clear all, the × on a row) disabled
├── The first read takes 2 keys in one get and loses to a newer change notification through a per-type revision
└── Real-time sync through storage.onChanged (renders the list the notification carried, as it is)
```

## i18n

- `_locales/ja/messages.json` — default Japanese
- `_locales/en/messages.json` — English
- The manifest's name/description use `__MSG_` references
- popup/options UI strings use a `data-i18n` attribute + `chrome.i18n.getMessage`

## User workflow

1. Open a video from the channel → the Content Loudness is shown
2. Turn on "Auto-apply LUFS" for the current type in the popup → videos of that type where the loudness can be detected get the gain that corresponds to Target LUFS
3. Where no LUFS is detected, a live stream for instance, it falls back to the saved per-type gain (the last gain Auto computed also lives there)
4. Where Auto is not applying the currently detected LUFS, "Apply to channel" and Manual Volume can save a per-type gain

## File overview

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest. permissions: storage, activeTab. host: youtube.com |
| `background.js` | Service worker. Takes sole charge of writing channelVolumes (`store:<op>`) |
| `page-bridge.js` | MAIN world. loudnessDb extraction (define/fetch/ytplayer) → postMessage |
| `content.js` | ISOLATED world. Gain management, audio chain, channel detection, storage |
| `utils.js` | Shared constants and utilities (shared by content / popup / options / service worker) |
| `popup.html` | Popup UI |
| `popup.js` | Popup logic. Information display, apply gestures, manual volume |
| `options.html` | Settings screen UI |
| `options.js` | Settings logic. Target LUFS, display unit, channel management |
| `_locales/` | i18n (ja, en) |
| `icons/` | Extension icons (16/48/128 px) — 3-bar loudness meter |
| `docs/screenshots/` | Screenshots embedded in the README and used in the store listing (ja, en). Output of `gen_screenshots.py`. The six images are written one at a time beside their name and then moved onto it, and because the replacement is split into six, whatever is about to be overwritten is copied aside first and a run that stops partway restores the names it already replaced from those copies (a name that had nothing before it is removed). A stop is not only a failed save (a progress line that cannot be printed, an interrupt), so taking the first copy through finishing the last replacement is treated as one transaction (with no image replaced there is nothing to restore and no copy is left behind). When the restore itself is refused, the run states that name and what stood there before, and keeps the copy — naming where it is — while its contents are still needed. A run that could not clear its copies does not exit 0 (exit 0 says no more than "this run left none of the copies it made", says nothing about the non-PNG files that were already there and leaves them alone — `--check` counts nothing but .png either) |
| `gen_icons.py` | Icon generation script (Python pillow) |
| `pack.py` | Builds the zip for the Chrome Web Store |
| `gen_screenshots.py` | Screenshot generation (writes into `docs/screenshots/`. The drawing font is fixed to M PLUS 1p from `tools/fonts/`. `--check` writes nothing and looks, in this order, at each component of the path to the tracked location and at whether the image is a regular file → PNG structure (signature, chunks, the IDAT zlib stream) → chunk order → the IHDR dimensions → the bytes outside IDAT → RGBA pixels (the decoder comes last). A difference is exit 1, an environment that cannot draw is exit 3. `--out <dir>` replaces the write destination. An unknown argument, `--check` and `--out` given together (in either order), a repeated `--out`, a value shaped like a flag, and a destination that cannot become a directory are refused with exit 2 (so that `--chek` is not an overwrite). An argument mistake is answered ahead of a pillow or font load failure (the import and the font resolution themselves happen at module load, and the failure is carried and turned into exit 3 after argument parsing). If a component of the path to the tracked location is not a real directory, both drawing and `--check` do nothing and exit 1. A refusal from the filesystem is not a traceback either — a destination named by `--out` is exit 2 (even where it is the same as the tracked location), the tracked location with no argument is exit 1. Each refused location is reported in its own words (cannot read it for the copy, cannot write to the destination)) |
| `tools/fonts/` | The drawing font M PLUS 1p (Regular / Bold) and OFL.txt. Taken from `ofl/mplus1p` in google/fonts (commit `66a36c8`). Committed to the repository so that CI and each machine produce the same pixels |
| `test.js` | Unit tests (node test.js) |
| `test-navigation.js` | Navigation and state-transition tests (node test-navigation.js) |
| `test-screenshots.py` | Tests for `gen_screenshots.py`'s arguments, output destination, and the shapes `--check` turns down (python3 test-screenshots.py. Also run from `node test.js`. Where symlinks cannot be created and where `resource` is absent, the affected cases are reported as skipped) |

## Key design decisions

- **GainNode, not HTMLMediaElement.volume**: volume property caps at 1.0. GainNode allows 0.0–6.0 (0–600%)
- **Per-channel, per-type automatic LUFS apply**: where the `autoApplyLoudnessVideo` / `autoApplyLoudnessLive` that matches the current type is true and a loudnessDb was obtained, the video-specific gain computed from Target LUFS is applied and saved as that type's gain in `channelVolumes`. Where the loudness cannot be detected and where Auto is OFF, that saved gain is used. The legacy `autoApplyLoudness` is read as true for both types
- **Auto and manual do not get separate gains**: both save into the single value at `channelVolumes.{id}.gainVideo` / `gainLive`. Toggling Auto on or off does not change the gain applied to a video whose LUFS cannot be detected
- **All-channel defaults and individual settings**: `autoApplyLoudnessVideoDefault` / `autoApplyLoudnessLiveDefault` apply where the type has no individual Auto flag. A manual save ("Apply to channel" / Manual Volume) writes the Auto state at that moment as an individual flag, so the channel stops following the all-channel default from then on. Auto's own gain save writes no flag and keeps the channel following the default. Changing a default does not rewrite `channelVolumes`
- **MAIN world / ISOLATED world split**: YouTube's CSP forbids inline script, so the loudnessDb extraction runs in `page-bridge.js` (MAIN world, `document_start`)
- **Three routes to loudnessDb**: (1) `Object.defineProperty` detects the variable being set, (2) a fetch hook (`/youtubei/v1/player`), (3) the YouTube player's internal DOM data (`ytd-watch-flexy.__data` / `movie_player.getPlayerResponse`)
- **Filling in isLiveNow**: `_capturedResp`'s `isLiveNow` is fixed as of page load, so the request handler fills in the current `isLiveNow` from `movie_player.getPlayerResponse()` (this covers the waiting → stream start transition). content.js's `forceDetect` (on popup open) asks the bridge again, and where the response updates `currentIsLiveNow` the popup is notified through `stateChanged`
- **videoId filter**: the fetch hook drops prefetch responses for other videos
- **watch pages only**: the MutationObserver, scheduleApply and the AudioContext creation happen on `/watch` alone
- **Saved per channel × type**: `gainLive` (stream/archive) and `gainVideo` (video/Shorts/premiere) are managed separately. videoType is decided from `videoDetails.isLiveContent` alone (`isLiveContent ? 'live' : 'video'`), and loudnessDb takes no part in the decision. A live stream and its archive are `isLiveContent=true` and count as live; a premiere is `isLiveContent=false` and so counts as video
- **Accounting for YouTube's loudness normalization**: where loudnessDb > 0, YouTube has already attenuated to -14 LUFS → effectiveLufs = -14. Where loudnessDb <= 0, it is used as it stands
- **Do not resolve channel state until the migration finishes**: content.js holds the startup fold as `storageReady`, and `applyPreferredGain()` waits on it before anything else. `applyAutomaticLoudnessGain()` also returns false while `storageSettled` is false, dropping to the waiting side. A map from before the migration is in the old form, "has a gain, has no Auto flag = Auto OFF", and resolving it under the current rule (no flag means the all-channel default) lets Auto take it over and overwrite a manual gain with a computed one (which happens when the popup's `forceDetect` arrives ahead of the fold)
- **Resolve under the old rule while the fold has failed**: success is held in `storageMigrated`, and while it is false `resolveAutoApplySetting(..., unmigrated)` uses the old rule that a saved gain means Auto OFF (the listing in options.js does the same). Treating a failure as a success lets Auto overwrite a manual gain with neither the marker nor a flag saved. `triggerApply()` retries the fold while `storageMigrated` is false (`foldInFlight` collapses the retries into one), and a one-off write failure recovers on the next apply
- **Do not save Auto's gain before the fold**: writing a flagless gain while unfolded produces the same shape as an old manual gain, and the next fold would pin it to Auto OFF. The computed gain is applied to playback, and the save waits until `storageMigrated` is true (a manual save writes the Auto state at that moment as an explicit flag, so it stays distinguishable before the fold and may be saved)
- **The migration marker is taken in across tabs**: `storageMigrated` is set to true by `unifiedGains` arriving through `chrome.storage.onChanged` as well as by this tab's own fold response. The canonical state is the marker on the storage side: where this tab's fold fails but another tab has completed it, resolution has to follow the current rule from then on (left on the old rule, it misreads a flagless Auto gain saved by another tab as a manual gain, and a manual save in that tab then pins Auto OFF). content.js re-resolves within the same event and options.js re-renders the list
- **Deleting the legacy keys is not part of the migration**: `clearLegacyKeys()` failing does not fail `migrateLegacyAutoGains()`. The marker and the gains are saved already, and nobody reads the keys that remain. Returning a failure here sends the caller back to the old rule. The leftovers are swept by the next call
- **Storage migration**: automatic migration from the old `{ gain }` form to `{ gainLive, gainVideo }`. `migrateLegacyAutoGains()` runs once per profile at startup and records an explicit OFF on a saved gain that has no flag, saving the old judgement (a saved gain means an implicit OFF). Where `autoLoudnessFallback:<channelId>:<type>` / `autoLoudnessFallbacks` exist, the learned value of a type with Auto on is folded into the gain and the key deleted. The marker for having run is the top-level `unifiedGains` key (Auto writes a gain without a flag too, so a second run would pin Auto's learned value to an explicit OFF; put inside the settings object, a settings write issued from a read taken before the migration erases the marker). An orphan `@handle` entry is merged into UC by a backfill that matches on the author name (a migration based on the id shape was dropped because it causes cross-channel corruption on SPA navigation)
- **One channel ID form**: `detectChannel()` returns the UC form alone. A DOM `@handle` link goes stale during SPA navigation (pointing at the previous channel) and is rejected as an identifier. `videoDetails.channelId` from page-bridge.js (UC form) is the fallback
- **Choosing the channel display name**: the bridge's `videoDetails.author` is the authoritative source (it comes from the current video's player response and stays correct after an SPA navigation). The DOM `getChannelDisplayName()` is a fallback only (it can be stale)
- **YouTube reference = -14 LUFS**: `contentLUFS = -14 + loudnessDb`
- **Default target = -18 LUFS**: user-configurable (-30 to -6 LUFS)
- **createMediaElementSource**: called once per `<video>`. Cannot be called again — conflicts with other extensions
- **Channel ID formats**: `UC...` (canonical) is the canonical ID. `detectChannel()` rejects `@handle` and returns UC alone. Where the DOM carries no UC, it waits for the bridge's `videoDetails.channelId`
- **notifyPopup dedup**: a state key comparison prevents no-op sends. The key includes `isLiveNow`, so the popup is notified on the waiting → stream start transition too
- **Cross-tab sync**: `chrome.storage.onChanged` delivers `channelVolumes` changes. The per-channel, per-type auto-apply flag and the per-type gain are reflected at once, and a remote deletion resets to 1.0
- **The service worker is the sole writer of channelVolumes**: content.js and options.js ask background.js through `chrome.runtime.sendMessage({ type: 'store:<op>' })` instead of doing the read-modify-write themselves. `channelVolumes` holds the whole map under one key, so several tabs reading and writing it back at the same time drop other channels' entries — last write wins (Auto saves per video, so that overlap is an everyday event). The worker serializes on `updateChannelVolumes()`'s promise chain, and the migration re-reads the map inside the queue so it does not roll back a gain saved while it was running
- **NaN/Infinity guard**: a non-finite gain result falls back to 1.0
- **Lazy audio chain**: where the gain is 1.0 (passthrough), `createMediaElementSource` is not called → this avoids the Live Caption flicker. `connectedVideo` (the audio chain) and `_lastProcessedVideo` (the detected video) are managed separately
- **triggerApply design**: the `setTimeout` debounce was dropped and an async mutex (`_applyRunning`) prevents concurrent runs. Called directly from each trigger — `yt-navigate-finish` / `popstate` / `visibilitychange` / the observer / first load. It is unaffected by background-tab throttling and by the high-frequency DOM updates of live chat
- **Gain overlay**: shows the gain value in `.ytp-volume-area`. It handles the DOM rebuild of an SPA navigation as well (detach is caught with `document.contains`)
- **Do not swallow failures**: message handling wraps `handleMessage()` in try/catch and answers exactly once through `respondOnce()`. `commitGain()` runs synchronously ahead of the promise chain, and `createMediaElementSource` throws while another extension owns the `<video>`, so a catch that watches the promise alone lets the reply go missing. The asynchronous side (`forceDetect`'s `sendDetectedState`, `setTargetLufs`) connects both success and failure to that same `respondOnce` (with no reply the popup stays stuck initializing). Failures go to the console through `reportFailure()`. A failure to save Auto's gain leaves the gain that is playing unchanged, so it is caught inside `applyPreferredGain` and kept away from the caller (`forceDetect`'s reply path)
- **A manual gain is a gain only once it is saved**: on a save failure, `setGain` / `applyLoudness` have `restoreGainAfterFailedSave()` read the saved value again through `applyPreferredGain()` and apply it, and return `{ ok: false }` once that completes. The slider has already previewed through `setGainLive` on `input`, so "the previous value" is the unsaved new one and an in-memory copy cannot restore it. Without the restore, the volume being played and the saved value disagree, the popup shows the value it read again after the failure and so looks saved, and the next navigation puts it back
- **Reflect the saved values before showing the screen**: popup and options hide the loading screen with `body.initializing` and remove it once the saved settings are rendered (options removes it even when the load fails — a screen that stays hidden cannot be operated either). While initializing, `transition: none !important` on `body.initializing *` (and `::before` / `::after`) stops the transitions — enumerating selectors misses the control someone forgot to write down, and without `!important` an individual selector wins on specificity. A transition starts running the moment the value is written, so the rest moves on screen and reads as "shown, then updated". `revealOptions` / `revealPopup` read `document.body.offsetWidth` and drop the class on the next frame — dropping it in the same style pass makes the value from before the write the transition's starting point
- **Claim nothing about what was not read**: the first read in options takes `autoLoudnessSettings` and `channelVolumes` in one `get`, so that no state arises in which one of the two succeeded and the other did not, and the `settingsLoadFailed` line shown on failure refers to that one read. Its wording states the read and the next action (reload) alone and says nothing about the values on screen — a change notification that arrives during the read is rendered before the failure is known, so wording that states a value can be false. A change notification after the failure is settled is not taken (a write from another tab would land on a screen that is asking for a reload). A notification that arrived before it was settled is on screen already and stays there
- **Do not let anything be operated that was not read**: the settings controls (Target LUFS / the two Auto defaults / display unit / gain overlay) and the destructive operations (clear all, the × on a row) ship disabled in the markup, and a load that finished reading is what enables them. `saveSetting` also refuses a write made while `settingsLoaded` is false — the markup is the first refusal, the handler the one behind it. The × on a row is written by the render with the state at that moment, so it becomes enabled in the render that follows a successful load
- **The first read loses to a change that arrives after it**: the read is issued ahead of the change notification and returns the value as of when it was issued. `loadAll` records `settingsRevision` / `channelRevision` before the get and applies what it read only to the side that has not moved. A change notification advances that type's revision by one, and the channel side renders and holds the `newValue` the notification carried (reading again would be a second read racing the first read). The settings side applies the whole object rather than a diff — applying part of it leaves the untouched fields at the markup defaults under the revision guard
- **`renderChannels` is render-only**: it draws the list it is handed and does not read storage. Holding nothing, it draws nothing. It does not re-read after its own writes either (a row deletion, a clear all) — the service worker's write comes back as a change notification, and that notification carries the list and drives the re-render
- **Showing an invalidated context**: when reloading an extension (this one or another) invalidates content.js's `chrome.runtime`, `chrome.tabs.sendMessage` from the popup rejects with `Receiving end does not exist`. The Web Audio API and the DOM overlay do not depend on `chrome.*`, so the gain display applied earlier stays on screen and misleads. The popup's catch clause shows `#reloadNeeded` (ja: 「拡張機能と接続できません。ページを再読み込みしてください (F5)」) rather than "Channel not detected", prompting the user to press F5

## Commands

```sh
# Load as unpacked extension
# chrome://extensions → Developer mode → Load unpacked → select this folder

# Regenerate icons
python3 gen_icons.py

# Regenerate screenshots (README + store) into docs/screenshots/
python3 gen_screenshots.py

# Compare the committed screenshots with what the code draws (no writes)
python3 gen_screenshots.py --check

# Run tests
node test.js
node test-navigation.js
python3 test-screenshots.py

# Package for Chrome Web Store
python3 pack.py

# No build step required. Plain JS, no bundler.
```

## Conventions

- Documentation is maintained in English and Japanese, English first: `README.md` / `README.ja.md`. Both members of a pair carry the same headings in the same order
- `PRIVACY_POLICY.md` and `PRIVACY_POLICY_JA.md` keep those names. The Chrome Web Store listing links to `PRIVACY_POLICY.md` by path
- `CLAUDE.md` is English only and has no Japanese counterpart
- Commits: **subject and body entirely in English** (Conventional Commits). **PR title and body entirely in English as well**, matching the repository's default language. The global CLAUDE.md rule about Japanese bodies does not apply to this project
- Issue templates are one English set, with a note at the top saying Japanese is welcome

## Development notes

- Gain value 1.0 = 100% (passthrough). Range 0.0–6.0
- `popup.js` sends `forceDetect` on open. `forceDetect` detects a video ID change and re-runs `applyVideoVolume` through `triggerApply` (honouring `_applyRunning`)
- `content.js` sends a `stateChanged` broadcast (a sender tab ID filter makes the popup ignore updates from other tabs)
- AudioContext may be `suspended` until first user interaction (Chrome autoplay policy)
- Channel detection order (UC only): `link[rel="canonical"][href*="/channel/"]` → `#owner a[href*="/channel/"]` / `ytd-video-owner-renderer a[href*="/channel/"]` → `meta[itemprop="channelId"]` → page-bridge `videoDetails.channelId`. An `@handle` link goes stale during SPA navigation and is rejected as an identifier
- Display name: the bridge's `videoDetails.author` is the authoritative source. The DOM `#owner #channel-name a` is the fallback
- SPA navigation detection: `yt-navigate-finish` + `popstate` + `visibilitychange` + MutationObserver (video element change + URL video ID change)
- Tests: `node test.js` (utils + packaging + the single-writer contract) + `node test-navigation.js` (navigation P01-P18 + bridge + guard + detectChannel + data integrity + cross-tab sync + per-channel auto LUFS + storage failure paths). The navigation side loads background.js into the same VM and wires `chrome.runtime.sendMessage` to the worker's listener, so the run goes through the real write path
- After editing `background.js`, reload the extension at chrome://extensions. Reloading the page does not re-evaluate the service worker (for a content script change, reloading the tab is enough)
- Test export: the `__TEST_YTCV__` flag exposes content.js internals on `globalThis.__YTCV__`. Disabled in production
- Storage keys: `autoLoudnessSettings` (target LUFS, display unit, Video/Live auto defaults), `channelVolumes` (saved channel gains, per-channel auto overrides, URL), `unifiedGains` (the migration-done marker). The legacy `autoLoudnessFallback:<channelId>:<type>` / `autoLoudnessFallbacks` are folded in at startup and deleted
- Storage format: `channelVolumes.{id}` = `{ name, gainLive, gainVideo, autoApplyLoudnessLive, autoApplyLoudnessVideo, url }` (a type with no individual auto-apply flag inherits the all-channel default. The legacy `autoApplyLoudness` counts as the same value for both types, and the legacy `{ name, gain, url }` is read as both gains)
- slider `input` event = real-time gain change (no storage write), `change` event = storage save. Both gestures are refused while Auto is on and LUFS was detected
- videoType decision: page-bridge.js returns `videoDetails.isLiveContent`. In content.js, `isLiveContent` true means 'live' and false means 'video' (loudnessDb takes no part in the decision). A premiere is `isLiveContent=false` and so counts as 'video'. On first load the default is 'video', and the gain switches to the correct type once `isLiveContent` arrives from the bridge
