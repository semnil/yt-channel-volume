# yt-channel-volume

Chrome extension (MV3) that shows a YouTube video's Content Loudness and saves and applies a per-channel gain on a user gesture.
With Auto-apply LUFS on, a live stream on air is played at the level the player's stats for nerds name for it (`live.`), asked for again every 1 s; the gain the level asks for plays at once, up or down. Where no level is named, a saved gain is applied.
It leaves the YouTube player's volume slider alone and controls the level with a Web Audio API GainNode.
The settings that belong to no channel live in `chrome.storage.sync`, which Chrome syncs with every Chrome the user is signed in to where the user has turned on Chrome sync, and which behaves like `chrome.storage.local` where it is off; the channels stay in `chrome.storage.local`.

## Design documents

The design is written down under `docs/`, not here. Each document there has a Japanese counterpart, `<name>.ja.md`, which keeps the English headings and item names, and a change to one of the two is made to the other in the same change.

- Before changing what a script does, how the scripts talk to each other, or what is stored under which key, read `docs/architecture.md`, "Architecture": the diagram, and one list for each of `page-bridge.js`, `background.js`, `content.js`, `core/common.js`, `utils.js`, the popup and the settings screen
- Before changing a catalog under `_locales/`, or how a page takes its strings and its `lang`, read `docs/architecture.md`, "i18n"
- Before changing what the viewer does with Auto, "Apply to channel" or Manual Volume, read `docs/architecture.md`, "User workflow"
- Before adding, renaming or removing a file, and before changing `gen_screenshots.py`, the VM harness of `test-navigation.js`, `tools/mutation/` or `tools/coverage/`, read the file's row in `docs/architecture.md`, "File overview"
- Before changing how the gain changes or when a channel's settings are saved, read `docs/gain-change-and-save.md`, which follows every such path through the code
- Before changing behaviour, read the items of `docs/design.md`, "Key design decisions", that name what the change touches; a change that makes one of them untrue rewrites it in the same change. The items, by subject:
  - The gain and the audio chain: "GainNode, not HTMLMediaElement.volume", "YouTube reference = -14 LUFS", "Default target = -18 LUFS", "Accounting for YouTube's loudness normalization", "NaN/Infinity guard", "createMediaElementSource", "Lazy audio chain", "Gain overlay"
  - Auto and what it stores: "Per-channel, per-type automatic LUFS apply", "Auto and manual do not get separate gains", "Turning Auto on stores the gain it plays, with the flag", "All-channel defaults and individual settings", "A bridge message stores nothing before the first apply for a URL", "A settings change stores Auto's gain only where what Auto works out moved", "Auto's own save is made by a tab that is playing"
  - The level read from the page: "MAIN world / ISOLATED world split", "The level of the rendition the player plays", "A stored gain is held against the base rendition", "A live stream's own level", "`perceptualLoudnessDb` is read as an absolute level", "Three routes to loudnessDb", "Filling in isLiveNow", "videoId filter", "A page fetch nothing handles", "watch pages only", "A channel's live URL"
  - Channels and video types: "Saved per channel × type", "One channel ID form", "Channel ID formats", "Choosing the channel display name"
  - The migration of stored gains: "Storage migration", "Do not resolve channel state until the migration finishes", "Resolve under the old rule while the fold has failed", "Do not save Auto's gain before the fold", "The migration marker is taken in across tabs", "Deleting the legacy keys is not part of the migration"
  - Storage, writes and messages between the scripts: "The service worker is the sole writer of channelVolumes (and of the settings)", "The worker refuses a write that does not describe a channel", "A bridge message is taken field by field", "Channel-independent settings sync", "Cross-tab sync", "The popup asks; the page tells it nothing", "Do not swallow failures"
  - Navigation: "triggerApply design"
  - The popup's gestures: "A gesture is made against a state, and applies to that state alone", "A slider preview holds the gain until its gesture ends", "A manual gain is a gain only once it is saved"
  - The popup and the settings screen as pages: "Reflect the saved values before showing the screen", "Claim nothing about what was not read", "Do not let anything be operated that was not read", "The first read loses to a change that arrives after it", "`renderChannels` is render-only", "A row is shown and sorted under one label", "Showing an invalidated context"

## Shared files

`core/common.js`, `pack.py`, `gen_icons.py`, `tools/mutation/sweep.mjs`, `tools/mutation/bail.mjs`, `tools/mutation/sweep-all.sh`, `tools/coverage/v8-to-lcov.mjs`, `tools/check-shared.sh`, the release scripts (`tools/check-tag.sh`, `tools/tag-plan.sh`, `tools/verify-version.sh`), every workflow under `.github/workflows`, `.github/tests/`, `.github/CODEOWNERS`, `.github/FUNDING.yml`, the issue templates and `.gitattributes` (which checks every one of them out with LF line endings) are copies of the files under `shared/` in [semnil/channel-volume-core](https://github.com/semnil/channel-volume-core), at the commit `core.json` locks. What each of them does is in that repository's [docs/shared-files.md](https://github.com/semnil/channel-volume-core/blob/main/docs/shared-files.md). They are changed there, with their tests, and copied here with that repository's `sync.mjs`. The Test check fails a copy that differs from the locked commit. Dependabot runs there as well, so this repository has no `dependabot.yml`. Once a day, and when run by hand, the Sync Core workflow (`.github/workflows/sync-core.yaml`) opens or updates the pull request from `sync/channel-volume-core` that takes channel-volume-core's `main` where it has moved past the locked commit, with a GitHub App's token; its job is skipped while the repository has no `SYNC_APP_CLIENT_ID` variable (channel-volume-core's README, "Setting up the sync").

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

# Sweep one source for mutants the suite lets through, in a worktree rather than
# the checkout being worked in (the MUTATE_* settings: channel-volume-core's
# docs/shared-files.md, "The mutation sweep")
node tools/mutation/sweep.mjs <worktree> content.js \
  node tools/mutation/bail.mjs '^  FAIL:' node test-navigation.js

# The same sweep in two worktrees at once, half of the mutants each
MUTATE_SHARD=0/2 node tools/mutation/sweep.mjs <worktree-a> content.js \
  node tools/mutation/bail.mjs '^  FAIL:' node test-navigation.js
MUTATE_SHARD=1/2 node tools/mutation/sweep.mjs <worktree-b> content.js \
  node tools/mutation/bail.mjs '^  FAIL:' node test-navigation.js

# Every source, one at a time, into one report (MUTATE_SHARD passes through to
# each sweep, so two of these in two worktrees split every file between them)
MUTATE_CONFIRM="node test.js" sh tools/mutation/sweep-all.sh <worktree> <report> \
  "node tools/mutation/bail.mjs '^  FAIL:' node test-navigation.js" utils.js options.js background.js

# Ask whether equivalents.md still names sites the code has (no suite is run)
node tools/mutation/sweep.mjs --verify

# The coverage report CI uploads, made locally (<dir> is any empty directory)
NODE_V8_COVERAGE=<dir> node test.js
NODE_V8_COVERAGE=<dir> node test-navigation.js
# (core/ is left out: channel-volume-core's own suite covers the shared code)
node tools/coverage/v8-to-lcov.mjs <dir> coverage.lcov $(python3 -B pack.py --list | grep '\.js$' | grep -v '^core/')

# Compare the shared files with the commit core.json locks (fetches it from GitHub)
bash tools/check-shared.sh

# Package for Chrome Web Store
python3 pack.py

# No build step required. Plain JS, no bundler.
```

## Conventions

- **Override of the global CLAUDE.md's 「ドキュメント」 language rule**: documentation is maintained in English and Japanese, English first: `README.md` / `README.ja.md`
- `PRIVACY_POLICY.md` keeps its name because the Chrome Web Store listing links to it by path. `PRIVACY_POLICY_JA.md` keeps its name because the README pair and the English policy point at it
- `AGENTS.md` is English only and has no Japanese counterpart
- Commit messages follow Conventional Commits
- Closed decisions, with their reasons and what would reopen them, are in `docs/decisions/<subject>.md`, each with a `<subject>.ja.md` that keeps the English headings. What is decided for every extension that takes the shared files is recorded in [channel-volume-core](https://github.com/semnil/channel-volume-core) (its `AGENTS.md` and `docs/decisions/`) and not repeated here

## Development notes

- Gain value 1.0 = 100% (passthrough). Range 0.0–6.0
- `popup.js` sends `forceDetect` on open. `forceDetect` detects a video ID change and re-runs `applyVideoVolume` through `triggerApply` (honouring `_applyRunning`)
- `popup.js` asks `getState` of its own tab alone, on `pollTabState` ([channel-volume-core](https://github.com/semnil/channel-volume-core/blob/main/docs/shared-files.md#popup))
- AudioContext may be `suspended` until first user interaction (Chrome autoplay policy)
- Channel detection order (UC only): `link[rel="canonical"][href*="/channel/"]` → `#owner a[href*="/channel/"]` / `ytd-video-owner-renderer a[href*="/channel/"]` → `meta[itemprop="channelId"]` → page-bridge `videoDetails.channelId`, the page's three for the document's first video only. An `@handle` link goes stale during SPA navigation and is rejected as an identifier
- Display name: the bridge's `videoDetails.author` is the authoritative source. The DOM `#owner #channel-name a` is the fallback
- SPA navigation detection: `yt-navigate-finish` + `popstate` + `visibilitychange` + MutationObserver (video element change + URL video ID change)
- Tests: `node test.js` (utils + packaging + the single-writer contract) + `node test-navigation.js` (navigation P01-P18 + bridge + guard + detectChannel + data integrity + cross-tab sync + per-channel auto LUFS + live follow + storage failure paths). The navigation side loads background.js into the same VM and wires `chrome.runtime.sendMessage` to the worker's listener, so the run goes through the real write path
- After editing `background.js`, reload the extension at chrome://extensions. Reloading the page does not re-evaluate the service worker (for a content script change, reloading the tab is enough)
- A change to which scripts share a scope, to the order they are injected in, or to what the manifest loads for them is checked in a real Chrome as well as by the Node suites. The rule is in the `AGENTS.md` of [channel-volume-core](https://github.com/semnil/channel-volume-core), "Conventions"
- Diagnostics on popup open: content.js logs `[YTCV][popup-open]` (with `currentLiveLkfs`, the live level Auto holds, `readLiveLkfs`, the live level in hand, and `audioChain`: whether the chain is built, whether its element is the `<video>` the page holds now, the AudioContext state, the GainNode value) and the bridge logs `[YTCV][bridge-diag]` (with `drcPreference` and where it was read, each response's `drcLoudnessDb`, `playerVolume` — the player's own stats-for-nerds volume line, which names ` DRC` and the `cont.` level of what it plays, or `live.` on a stream on air — `playingLkfs`, the `cont.` level taken from that line, and `liveLkfs`, the `live.` level taken from it, each `null` where it is not taken). Neither dump carries the response's `perceptualLoudnessDb` or `loudnessTargetLkfs`; read them in the page's console from `movie_player.getPlayerResponse().playerConfig.audioConfig`
- Test export: the `__TEST_YTCV__` flag exposes content.js internals on `globalThis.__YTCV__`. Disabled in production
- Storage keys: `autoLoudnessSettings` (in `chrome.storage.sync`: target LUFS, display unit, gain overlay, Video/Live auto defaults; a copy left in local by an earlier version is read until the worker moves it), `channelVolumes` (saved channel gains, per-channel auto overrides, URL), `unifiedGains` (the migration-done marker). The legacy `autoLoudnessFallback:<channelId>:<type>` / `autoLoudnessFallbacks` are folded in at startup and deleted
- Storage format: `channelVolumes.{id}` = `{ name, gainLive, gainVideo, gainLivePlain, gainVideoPlain, autoApplyLoudnessLive, autoApplyLoudnessVideo, url }` (`gain*Plain: true` marks that type's gain as held against the plain rendition, and its absence means the gain plays as it is. A type with no individual auto-apply flag inherits the all-channel default. The legacy `autoApplyLoudness` counts as the same value for both types, and the legacy `{ name, gain, url }` is read as both gains)
- slider `input` event = real-time gain change (no storage write), `change` event = storage save. Both gestures are refused while Auto is on and LUFS was detected (a live level counts as detected). The gesture is `holdPopupSlider` ([channel-volume-core](https://github.com/semnil/channel-volume-core/blob/main/docs/shared-files.md#sliders)): each `input` previews, and a key hold or a drag saves once. After a drag the browser cancels, the tab puts back the stored gain once the previews stop, and the popup draws it
- videoType decision: page-bridge.js returns `videoDetails.isLiveContent`, and `isLiveContent: null` in an answer no response named the video for, which content.js does not take. In content.js, `isLiveContent` true means 'live' and false means 'video' (loudnessDb takes no part in the decision). A premiere is `isLiveContent=false` and so counts as 'video'. On first load the default is 'video', and the gain switches to the correct type once `isLiveContent` arrives from the bridge
