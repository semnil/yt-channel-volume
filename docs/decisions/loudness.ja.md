# Loudness の決定

> English: [loudness.md](loudness.md)

ライブ配信とそのアーカイブで拡張機能が表示する loudness (音の大きさの値) と、配信中の配信への Auto の追従について閉じた判断。今有効な規則は `CLAUDE.md` の「The level of the rendition the player plays」と「A live stream's own level」にある。どの音声 (rendition) の値を取るかと、保存したゲインの基準の決定は、[rendition-loudness.ja.md](rendition-loudness.ja.md) にある。

## ライブのアーカイブに出る loudness は、YouTube が計算した値

- **決定** (2026-10-24): 「処理が終わっていないように見えるライブ配信やアーカイブで、loudness の値が出るようになった」という報告があった。何も変えずに閉じた。そこで拡張機能が表示する値は、YouTube がその音声について計算した値で、暫定の値でも紛れ込んだ値でもない。表示することは不具合ではない。
- **理由**: 拡張機能がプレーヤーの音量の行から値を取るのは、その行に `cont.` があるときだけ。配信中の配信の行には `cont.` が無いので、保存済みのゲインで再生する。この決定は、プレーヤーが `cont.` を出すのは YouTube が loudness を計算し終えた音声だけで、そのとき応答に `loudnessDb` か、その代わりになる `perceptualLoudnessDb` と `loudnessTargetLkfs` (`CLAUDE.md` の「Key design decisions」) がある、という前提に頼っている。
- **却下した案**: `isLiveContent` が true のときは一律に、`playing` の答えや popup の Loudness を止める案。処理が済んだアーカイブも `isLiveContent=true` なので、正しい Loudness と、それに基づく Auto のゲインと保存まで止めてしまう。
- **覆す条件**: 音量の行に `cont.` があるのに、応答に `loudnessDb` も、その代わりになる `perceptualLoudnessDb` と `loudnessTargetLkfs` も無い状態が見つかったとき。動きを変えるなら、条件にするのは `isLiveContent` ではなくその状態になる。ライブ配信やアーカイブの loudness を不具合として扱う前に、まずその状態を探す。popup を開いたときの診断 (`CLAUDE.md` の「Development notes」) に、音量の行 (`playerVolume`) と各応答の `loudnessDb` が出る。`perceptualLoudnessDb` と `loudnessTargetLkfs` は、同じ項目にあるとおり、ページのコンソールで読む。

## ライブの追従が今の形になるまで

- **決定** (2026-11-01): Auto が ON のとき、配信中の配信には 1 秒ごとに値を問い合わせ、その値が求めるゲインを、上げるときも下げるときもすぐに再生する ([#128](https://github.com/semnil/yt-channel-volume/pull/128))。Auto の追従を遅らせる仕組みを置かないことは、共有ファイルを取る拡張機能の全体の決定で、[channel-volume-core](https://github.com/semnil/channel-volume-core) の `docs/decisions/auto.md` に記録している。
- **経緯**: 追従はこの前に 3 つの形を経ていて、それぞれの説明は、その形を入れた PR にある。[#71](https://github.com/semnil/yt-channel-volume/pull/71) は、ライブの値を 30 秒ごとに読んで追従した。[#73](https://github.com/semnil/yt-channel-volume/pull/73) は開始時の gate を足し、最初の値のゲインが保存済みのゲインより 10 dB 以上高いときは適用を止めた。[#78](https://github.com/semnil/yt-channel-volume/pull/78) は、読み取りを 10 秒ごとにし、高いゲインへはゆっくり上げ、gate を開始時の頭打ちと上がり際の下げ足しに置き換え、それらがゲインを抑えている間は保存しないようにした。#128 は、ゆっくり上げる制限・開始時の頭打ち・上がり際の下げ足しを外した。途中で出た 2 つの決定は、#128 で置き換わった。2026-10-27 に、配信の開始の直後にプレーヤーがライブの値を出して追従がそれを拾うまで保存済みのゲインで再生される区間を、仕様どおりとして受け入れ、bridge が値を見続ける案は採らなかった。#128 からは 1 秒ごとに値を問い合わせる。2026-10-30 に、開始時の頭打ち・上がり際の下げ足し・それらが抑えている間は保存しないことの 3 点を、配信中の配信で確かめずに閉じた。#128 がこの 3 つを外した。
