# Rendition loudness decisions

> 日本語版: [rendition-loudness.ja.md](rendition-loudness.ja.md)

Closed decisions about which audio rendition's level the extension takes as the Loudness, and what a stored gain is held against. The rules in force are in [design.md](../design.md), "The level of the rendition the player plays" and "A stored gain is held against the base rendition". What each step changed is in [#52](https://github.com/semnil/yt-channel-volume/pull/52).

## The level comes from the rendition playing

- **Decision** (2026-09-27, [#52](https://github.com/semnil/yt-channel-volume/pull/52)): six points, settled in that pull request's review.
  1. The Loudness is the `cont.` level of the player's stats-for-nerds volume line. Where the line cannot be read, the answer falls back to the response, with Stable Volume (DRC) taken from the player's setting, then from the player's entry in localStorage, and as on where neither answers.
  2. A stream on air is handled at the level before Stable Volume: a stored gain plays there as it is.
  3. A channel and type has one stored gain, held against the plain rendition and carried to the rendition playing by a ratio. It does not have one gain for each rendition.
  4. A gain stored without the mark is not carried over. It plays as it was stored.
  5. A manual gain saved on a stream on air, where the plain rendition's level is not known, is stored without the mark. A gain chosen on air therefore plays as it is on the archive as well, with Stable Volume on or off.
  6. The player names its level rounded to 0.1 dB. Where the renditions whose level rounds to the one named all carry one `loudnessDb`, that `loudnessDb` is taken in place of the rounded level; where they differ, the level the player names stands.
- **Reason**: (1) the one line carries every axis that picks a rendition — the audio track, Stable Volume, Voice Boost and the quality — so they are read in one place. (2) A stream on air has neither a `loudnessDb` nor a stable rendition. (3) How much the stable rendition is raised differs from video to video, so a gain held against it would not fit another video of the channel. (4) A manual gain from an earlier version was chosen by ear on whatever rendition was playing then, so what it was held against is not known.
- **Rejected**: putting the playing rendition together from each setting in turn, in place of reading `cont.` (1). Keeping two gains, one for each rendition (3). Reading every gain stored before the mark as held against the plain rendition, which was the first plan and was changed in review (4). Marking a manual gain saved on a stream on air, which was changed in the second review (5).
- **History**: #52 left the stored value unclamped, so that a gain chosen on a louder rendition read back at the level it was chosen at. That was withdrawn on 2026-10-31, when the gain rules were made the same across the extensions that take the shared files: a gain is held to 0–6 before it is sent to be stored, and the worker takes 0–6 only.

## A gain saved on air keeps playing as it is on the archive

- **Decision** (2026-11-14): point 5 above stands — a manual gain saved on a stream on air plays as it is on the archive. The premise under it, that a stream's level on air is about the level of its archive's rendition before Stable Volume, is closed without a measurement that settles it.
- **Reason**: the operator compared the two on several streams. The `live.` level moves more than the archive's `cont.` level, and the movement gathers in the stretch after a stream starts and where the level drops sharply mid-stream. A stream's level also changes from one broadcast to the next with the streamer's settings, the distance to the microphone and what is streamed, so an accurate measurement of the premise is close to impossible, and playing the gain as it was saved is the conclusion that can be held.
- **Reopen when**: a new way to measure it appears, YouTube changes how it names or normalizes these levels, or an observer proposes a new yardstick. Otherwise this is not reopened.
