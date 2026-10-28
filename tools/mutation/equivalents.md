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

The text check on the source a bridge message names. That text goes nowhere
but the `source` field of the result `evaluateLiveSave` hands back, and the
message handler starts the evaluation without reading what it hands back, so
which text it carries changes nothing the handler does: the gain applied, the
write sent and the follow set are the same either way.

- `content.js:320` === becomes !== ×1 — ===

`ensureAudioChain`'s check before the teardown. The disconnect it guards is
inside a `try`, so a null source is caught, and the assignment below runs either
way.

- `content.js:677` a guard is always taken ×1 — if (sourceNode) {


The dropped await before `notifyPopup` in the retry's callback. Measured by
tracing what runs and in what order: `applyAutomaticLoudnessGain` commits the
gain from the level and the target, needing no storage read, so it has already
run by the time the callback is reached — every notification carries the level
beside the gain that goes with it whether the await is there or not. With Auto
off the gain does not move at all.

- `content.js:806` an await is dropped ×1 — await

The navigation observer's watch-page check. `triggerApply` opens with the same
one.

- `content.js:941` a guard is dropped ×1 — if (!isWatchPage()) return;

`respondOnce`'s guard against a second answer, and `return true` after a
synchronous `sendResponse`. Both were measured against Chrome rather than
reasoned about: a response sent inside the listener is delivered whatever the
listener returns, and a second one is dropped rather than delivered or thrown.

- `content.js:1056` a guard is dropped ×1 — if (answered) return;
- `content.js:1070` true becomes false ×1 — return true;
- `content.js:1077` true becomes false ×1 — return true;
- `content.js:1083` true becomes false ×1 — return true;
- `content.js:1089` true becomes false ×1 — return true;
- `content.js:1093` true becomes false ×1 — return true;
- `content.js:1097` true becomes false ×1 — return true;
- `content.js:1126` true becomes false ×1 — return true;
- `content.js:1130` true becomes false ×1 — return true;
- `content.js:1134` true becomes false ×1 — return true;
- `content.js:1147` true becomes false ×1 — return true;
- `content.js:1166` true becomes false ×1 — return true;

## popup.js

`setCardValue`'s unit check. Every one of the five calls passes a unit
(`' LUFS'`, `' dB'`, `'%'`), so there is no call it refuses.

- `popup.js:74` a guard is always taken ×1 — if (unitText) {

`resyncFromContent`'s answer check. The `.catch` beside it runs the same four
lines the false branch does, and reading a field of `undefined` is what sends it
there.

- `popup.js:245` a guard is always taken ×1 — if (state) {

The retry loop. `hasLoudness` is set from the same response the check reads, the
timer body opens with its own `hasLoudness` check, the recursion is bounded by
`remaining > 1`, and the `catch (_) {}` takes what reading a field of
`undefined` throws.

- `popup.js:390` === becomes !== ×1 — ===
- `popup.js:390` a guard is always taken ×1 — if (resp.contentLufs === null || resp.contentLufs === undefined) {
- `popup.js:408` a guard is dropped ×1 — if (remaining <= 0 || hasLoudness) return;
- `popup.js:408` || becomes && ×1 — ||
- `popup.js:413` a guard is always taken ×1 — if (resp) {
- `popup.js:415` && becomes || ×1 — &&
- `popup.js:415` a guard is always taken ×1 — if (!hasLoudness && remaining > 1) {

## page-bridge.js

The player-response captures. Without the first check the capture holds
`undefined`, which its reader treats as the null it holds now; and the call the
second guards is inside a `try { } catch (_) {}`, which takes what a missing
player or a missing method throws.

- `page-bridge.js:178` a guard is always taken ×1 — if (window.ytInitialPlayerResponse) {
- `page-bridge.js:244` && becomes || ×1 — &&
- `page-bridge.js:244` a guard is always taken ×1 — if (player && typeof player.getPlayerResponse === 'function') {

The player's stable volume setting and its stats line are read the same way:
each call is inside a `try { } catch (_) {}`, and what a missing player or a
missing method throws lands where the guard would have sent it — on to the
stored setting, or a level or volume line of `null`.

- `page-bridge.js:56` && becomes || ×1 — &&
- `page-bridge.js:56` a guard is always taken ×1 — if (player && typeof player.getDrcUserPreference === 'function') {
- `page-bridge.js:94` || becomes && ×1 — ||
- `page-bridge.js:94` a guard is dropped ×1 — if (!player || typeof player.getStatsForNerds !== 'function') return nul
- `page-bridge.js:419` && becomes || ×1 — &&
- `page-bridge.js:419` a guard is always taken ×1 — if (moviePlayer && typeof moviePlayer.getStatsForNerds === 'function') {
