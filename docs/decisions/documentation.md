# Documentation decisions

> 日本語版: [documentation.ja.md](documentation.ja.md)

Closed decisions about the language and the names of this repository's documents. The rules in force are in `AGENTS.md`, "Conventions".

## What the move to English left as it is

- **Decision** (2026-10-20): when the documents were made English first, with the Japanese in files of their own, two things were left as they were, and a review of the documents' language does not raise them again.
  - `AGENTS.md`, "Showing an invalidated context", quotes the Japanese wording of `reloadPageNeeded` (`(ja: 「…」)`). The quotation is not replaced with the English wording.
  - `PRIVACY_POLICY_JA.md` is not renamed to the `<name>.ja.md` form the other pairs use.
- A third, that `tools/mutation/equivalents.md` has no Japanese version, is decided for every extension that takes the shared sweep, and is recorded in [channel-volume-core](https://github.com/semnil/channel-volume-core), `docs/decisions/documentation.md`.
- **Reason**: a link to a file on GitHub names its path and does not follow a rename, so a link from outside that names `PRIVACY_POLICY_JA.md` would break. All three look like places the move to English missed, which is why a later review can point at them again.
