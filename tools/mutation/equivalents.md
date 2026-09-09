# Mutants this suite lets through, and why each one is equivalent

`sweep.mjs` turns each source into mutants and runs a suite against every one.
A mutant the suite still passes is either a gap in the tests or a change the
code cannot be told apart from — this file names the second kind, one entry per
mutant, with what was measured about it.

Entries are read back by `node tools/mutation/sweep.mjs --verify`, which
`test-navigation.js` runs: an entry naming a site the code no longer has is a
reason nobody can check, which is what a list like this turns into if it is only
prose. The format is `- ``file:line`` label ×N — <the text the rule matched>`, where N is
how many of that group are equivalent — fewer than the line carries where one
of a line's two `===` is equivalent and the other is killed. The text is part
of what is matched because a line number on its own moves onto whatever takes
that line, and a reason measured for one guard would go on standing for a
different guard nobody has measured. Every list item in this file is read as
an entry, so a bullet that is not one — or one that has lost a backtick, a
`×N`, or the `-` at the margin — is refused by name rather than passed over as
prose. What `--verify` cannot see is an entry whose mutant the suite has come
to kill: the site is still there, so only a sweep of that file finds it, by what
it does not find standing.

`test.js` reads `content.js`, `popup.js` and `page-bridge.js` as text rather
than executing them, so the sweeps of those three are judged by
`test-navigation.js` alone.

## content.js

`ensureAudioChain`'s check before the teardown. The disconnect it guards is
inside a `try`, so a null source is caught, and the assignment below runs either
way.

- `content.js:408` a guard is always taken ×1 — if (sourceNode) {


The dropped await before `notifyPopup` in the retry's callback. Measured by
tracing what runs and in what order: `applyAutomaticLoudnessGain` commits the
gain from the level and the target, needing no storage read, so it has already
run by the time the callback is reached — every notification carries the level
beside the gain that goes with it whether the await is there or not. With Auto
off the gain does not move at all.

- `content.js:533` an await is dropped ×1 — await

The navigation observer's watch-page check. `triggerApply` opens with the same
one.

- `content.js:645` a guard is dropped ×1 — if (!isWatchPage()) return;

`respondOnce`'s guard against a second answer, and `return true` after a
synchronous `sendResponse`. Both were measured against Chrome rather than
reasoned about: a response sent inside the listener is delivered whatever the
listener returns, and a second one is dropped rather than delivered or thrown.

- `content.js:751` a guard is dropped ×1 — if (answered) return;
- `content.js:765` true becomes false ×1 — return true;
- `content.js:772` true becomes false ×1 — return true;
- `content.js:778` true becomes false ×1 — return true;
- `content.js:782` true becomes false ×1 — return true;
- `content.js:786` true becomes false ×1 — return true;
- `content.js:809` true becomes false ×1 — return true;
- `content.js:813` true becomes false ×1 — return true;
- `content.js:817` true becomes false ×1 — return true;
- `content.js:830` true becomes false ×1 — return true;
- `content.js:849` true becomes false ×1 — return true;

## popup.js

`setCardValue`'s unit check. Every one of the five calls passes a unit
(`' LUFS'`, `' dB'`, `'%'`), so there is no call it refuses.

- `popup.js:64` a guard is always taken ×1 — if (unitText) {

`resyncFromContent`'s answer check. The `.catch` beside it runs the same four
lines the false branch does, and reading a field of `undefined` is what sends it
there.

- `popup.js:215` a guard is always taken ×1 — if (state) {

The retry loop. `hasLoudness` is set from the same response the check reads, the
timer body opens with its own `hasLoudness` check, the recursion is bounded by
`remaining > 1`, and the `catch (_) {}` takes what reading a field of
`undefined` throws.

- `popup.js:361` === becomes !== ×1 — ===
- `popup.js:361` a guard is always taken ×1 — if (resp.contentLufs === null || resp.contentLufs === undefined) {
- `popup.js:379` a guard is dropped ×1 — if (remaining <= 0 || hasLoudness) return;
- `popup.js:379` || becomes && ×1 — ||
- `popup.js:384` a guard is always taken ×1 — if (resp) {
- `popup.js:386` && becomes || ×1 — &&
- `popup.js:386` a guard is always taken ×1 — if (!hasLoudness && remaining > 1) {

## page-bridge.js

The player-response captures. Without the first check the capture holds
`undefined`, which its reader treats as the null it holds now; and the call the
second guards is inside a `try { } catch (_) {}`, which takes what a missing
player or a missing method throws.

- `page-bridge.js:75` a guard is always taken ×1 — if (window.ytInitialPlayerResponse) {
- `page-bridge.js:125` && becomes || ×1 — &&
- `page-bridge.js:125` a guard is always taken ×1 — if (player && typeof player.getPlayerResponse === 'function') {
