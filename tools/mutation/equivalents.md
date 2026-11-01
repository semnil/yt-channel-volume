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

- `content.js:305` === becomes !== ×1 — ===

`ensureAudioChain`'s check before the teardown. The disconnect it guards is
inside a `try`, so a null source is caught, and the assignment below runs either
way.

- `content.js:663` a guard is always taken ×1 — if (sourceNode) {


The navigation observer's watch-page check. `triggerApply` opens with the same
one.

- `content.js:1000` a guard is dropped ×1 — if (!isWatchPage()) return;

`respondOnce`'s guard against a second answer, and `return true` after a
synchronous `sendResponse`. Both were measured against Chrome rather than
reasoned about: a response sent inside the listener is delivered whatever the
listener returns, and a second one is dropped rather than delivered or thrown.

- `content.js:1120` a guard is dropped ×1 — if (answered) return;
- `content.js:1134` true becomes false ×1 — return true;
- `content.js:1141` true becomes false ×1 — return true;
- `content.js:1147` true becomes false ×1 — return true;
- `content.js:1153` true becomes false ×1 — return true;
- `content.js:1159` true becomes false ×1 — return true;
- `content.js:1163` true becomes false ×1 — return true;
- `content.js:1167` true becomes false ×1 — return true;
- `content.js:1171` true becomes false ×1 — return true;
- `content.js:1199` true becomes false ×1 — return true;
- `content.js:1203` true becomes false ×1 — return true;
- `content.js:1207` true becomes false ×1 — return true;
- `content.js:1212` true becomes false ×1 — return true;
- `content.js:1231` true becomes false ×1 — return true;
- `content.js:1255` true becomes false ×1 — return true;
- `content.js:1259` true becomes false ×1 — return true;

The level in hand taken as Auto's when Auto is turned on with a level known.
Where no live level is in hand (`readLiveLkfs` null) the level known is the
response's, and Auto's live level is null already: a bridge message sets the
two together, the popup's read sets the one in hand only to a level, a
navigation clears both, and turning Auto on sets Auto's from the one in hand.
`liveLevelRise` is read only by `liveGainToPlay`, which runs only with Auto's
level set, and every way that level is set also sets the rise. Taking the
branch then writes values nothing reads differently.

- `content.js:1273` a guard is always taken ×1 — if (live) {

## popup.js

`resyncFromContent`'s answer check. The `.catch` beside it runs the same four
lines the false branch does, and reading a field of `undefined` is what sends it
there.

- `popup.js:277` a guard is always taken ×1 — if (state) {

A preset's save without a channel id. The presets are disabled in every draw
that holds no channel id, and the page stays hidden (`body.initializing`, or
the status line in place of the screen) until a draw: sampled every 20 ms in
Chrome 156 from the popup's opening on a watch page, opened at once and after
2 s, and on a page that is not one, no sample showed a preset that could be
clicked with no channel shown (2225 of them showed one with the channel).

- `popup.js:356` a guard is always taken ×1 — if (currentChannel.id) {

## page-bridge.js

The player-response captures. Without the first check the capture holds
`undefined`, which its reader treats as the null it holds now; and the call the
second guards is inside a `try { } catch (_) {}`, which takes what a missing
player or a missing method throws.

- `page-bridge.js:178` a guard is always taken ×1 — if (window.ytInitialPlayerResponse) {
- `page-bridge.js:246` && becomes || ×1 — &&
- `page-bridge.js:246` a guard is always taken ×1 — if (player && typeof player.getPlayerResponse === 'function') {

The player's stable volume setting and its stats line are read the same way:
each call is inside a `try { } catch (_) {}`, and what a missing player or a
missing method throws lands where the guard would have sent it — on to the
stored setting, or a level or volume line of `null`.

- `page-bridge.js:56` && becomes || ×1 — &&
- `page-bridge.js:56` a guard is always taken ×1 — if (player && typeof player.getDrcUserPreference === 'function') {
- `page-bridge.js:94` || becomes && ×1 — ||
- `page-bridge.js:94` a guard is dropped ×1 — if (!player || typeof player.getStatsForNerds !== 'function') return nul
- `page-bridge.js:423` && becomes || ×1 — &&
- `page-bridge.js:423` a guard is always taken ×1 — if (moviePlayer && typeof moviePlayer.getStatsForNerds === 'function') {
