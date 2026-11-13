# Test and tool decisions

> 日本語版: [tests-and-tools.ja.md](tests-and-tools.ja.md)

Where the decisions about this repository's test tooling are written down. Both subjects below are recorded in the pull requests that made them, and this page points at those.

## bail.mjs's signal path

- [#79](https://github.com/semnil/yt-channel-volume/pull/79): what `tools/mutation/bail.mjs` does when a signal reaches it, including one that arrives while it still waits for its own output to drain ("A signal while the run still waits on output").
- [#80](https://github.com/semnil/yt-channel-volume/pull/80): the long-running suites its test starts end when the suite that started them is gone.
- `bail.mjs` has since become a shared file. It is changed, with its tests, in [channel-volume-core](https://github.com/semnil/channel-volume-core) (`AGENTS.md`, "Shared files").

## The screenshot check

- [#9](https://github.com/semnil/yt-channel-volume/pull/9): the screenshots are tracked under `docs/screenshots/`, drawn with a font the repository carries, and held to the generator by `test.js` and by a pixel comparison in CI.
- [#13](https://github.com/semnil/yt-channel-volume/pull/13): what the check refuses.
- [#14](https://github.com/semnil/yt-channel-volume/pull/14): what counts as an image is one rule in `gen_screenshots.py --check`, `test.js` and `test-screenshots.py` ("A suffix alone does not make it an image"), and what the guard against Python's bytecode cache measures.
