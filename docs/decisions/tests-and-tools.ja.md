# Test and tool decisions

> English: [tests-and-tools.md](tests-and-tools.md)

このリポジトリのテストの道具についての決定が、どこに書いてあるかを示す。下の 2 つの主題は、決定を入れた PR に記録があり、このページはその PR を指す。

## bail.mjs's signal path

- [#79](https://github.com/semnil/yt-channel-volume/pull/79): `tools/mutation/bail.mjs` がシグナルを受けたときの動き。自分の出力を出し切るのを待っている間に届いたシグナルの扱いを含む (「A signal while the run still waits on output」)。
- [#80](https://github.com/semnil/yt-channel-volume/pull/80): そのテストが起動する、止められるまで走り続ける suite は、起動した suite が消えたら自分で終わる。
- `bail.mjs` は、その後に共有ファイルになった。変更は、テストと一緒に [channel-volume-core](https://github.com/semnil/channel-volume-core) で行う (`AGENTS.md` の「Shared files」)。

## The screenshot check

- [#9](https://github.com/semnil/yt-channel-volume/pull/9): スクリーンショットを `docs/screenshots/` で追跡し、リポジトリに入れた書体で描く。`test.js` と、CI での画素の比較が、画像を生成器に合わせて保つ。
- [#13](https://github.com/semnil/yt-channel-volume/pull/13): 検査が断るもの。
- [#14](https://github.com/semnil/yt-channel-volume/pull/14): 何を画像に数えるかは、`gen_screenshots.py --check`・`test.js`・`test-screenshots.py` で 1 つの規則にする (「A suffix alone does not make it an image」)。Python のバイトコードのキャッシュを防ぐガードが何を測るかも、この PR にある。
