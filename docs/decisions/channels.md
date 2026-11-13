# Channel decisions

> 日本語版: [channels.ja.md](channels.ja.md)

Closed decisions about what a saved channel is, how a channel is identified and how a video's type is decided. The rules in force are in `AGENTS.md`, "Key design decisions".

## A deleted channel is an unconfigured channel

- **Decision** (2026-08-22): deleting a channel from Saved Channels removes its gains and its own Auto flags, so the channel is from then on one with nothing configured. Where "Auto-apply LUFS for all channels" is on for the type, the next video of that channel follows the default, Auto applies and stores its gain, and the row comes back to the list. This is how it is meant to work and is not treated as a defect. What a tab on the deleted channel plays is in [gain-change-and-save.md](../gain-change-and-save.md), "Options page: deleting a row and clearing all".
- **Reason**: the level played is the same as before the gains of Auto and of the manual controls were made one value: Auto applied the same gain to the next video of a deleted channel then as well, and stored it under a key the list did not draw. The row comes back because the gain in force is now stored in one place ([#4](https://github.com/semnil/yt-channel-volume/pull/4), "Impact"). A row that returns after being deleted looks like a defect, so a review or an audit can raise it again; this record is what answers it.
- **Rejected**: leaving `autoApplyLoudnessLive: false` / `autoApplyLoudnessVideo: false` behind for a deleted channel, so that Auto stays off for it. A change of this behaviour would take that shape, and it is the one that was not chosen.

## The channel is identified by its UC id alone

- **Decision** (2026-04-19): `detectChannel()` returns an id in the UC form or nothing, and a `/@handle` link on the page is not taken as an identifier. The migration that moved an `@handle` entry to a UC entry on the shape of the ids alone was taken out; what is left is the adoption of an orphan `@handle` entry whose name matches the bridge's `author` ([`e439b5b`](https://github.com/semnil/yt-channel-volume/commit/e439b5b)). The rules in force are in `AGENTS.md`, "One channel ID form", "Channel ID formats" and "Storage migration".
- **Harm record** (2026-04-19): after an SPA navigation from a video of channel A to a video of channel B, the page's `/@handle` link still named channel A. The code of that time read that handle as the channel, and when the bridge then answered with channel B's UC id, it took the pair for one channel whose `@handle` entry was to be moved to its UC id, and ran the migration: the gain stored for channel A was written into channel B's entry.

## The video type comes from isLiveContent alone

- **Decision** (2026-04-19): the type is `isLiveContent ? 'live' : 'video'`, and whether the response carries a `loudnessDb` takes no part in it ([`6fe4e55`](https://github.com/semnil/yt-channel-volume/commit/6fe4e55)). The rule in force is in `AGENTS.md`, "Saved per channel × type".
- **History**: the day before, [`2fdf75f`](https://github.com/semnil/yt-channel-volume/commit/2fdf75f) had made a video live only where `isLiveContent` was true and no `loudnessDb` was there, to keep a premiere a video. A live archive carries a `loudnessDb` as well, so an archive that carries one was taken as a video. A premiere is `isLiveContent=false`, so `isLiveContent` alone tells the two apart, and `6fe4e55` took the `loudnessDb` condition out again.
