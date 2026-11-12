# チャンネルの決定

> English: [channels.md](channels.md)

保存済みのチャンネルの意味、チャンネルの見分け方、動画の種別の決め方について閉じた判断。今有効な規則は `CLAUDE.md` の「Key design decisions」にある。

## 削除したチャンネルは、未設定のチャンネルになる

- **決定** (2026-08-22): Saved Channels からチャンネルを削除すると、そのチャンネルのゲインと個別の Auto のフラグが消える。それ以降、そのチャンネルは何も設定していないチャンネルと同じになる。その種別で「全チャンネルのLUFS自動適用」が ON なら、そのチャンネルの次の動画は既定値に従い、Auto がゲインを適用して保存し、行が一覧に戻る。これは仕様どおりの動きで、不具合として扱わない。削除したチャンネルを開いているタブが何を再生するかは、[gain-change-and-save.ja.md](../gain-change-and-save.ja.md) の「設定画面: 行の削除と全削除」にある。
- **理由**: 再生される音の大きさは、Auto のゲインと手動のゲインを 1 つの値にまとめる前と同じ。まとめる前も、Auto は削除したチャンネルの次の動画に同じゲインを当てていて、その値を一覧に出ないキーに保存していた。行が戻るのは、適用しているゲインの保存先が 1 か所になったため ([#4](https://github.com/semnil/yt-channel-volume/pull/4) の「Impact」)。削除した行が戻る動きは不具合に見えるので、レビューや監査でもう一度挙がりうる。この記録は、そのときの答えになる。
- **却下した案**: 削除したチャンネルに `autoApplyLoudnessLive: false` / `autoApplyLoudnessVideo: false` だけを残して、Auto を OFF のままにする案。この動きを変えるならこの形になるが、選ばなかった。

## チャンネルは UC の ID だけで見分ける

- **決定** (2026-04-19): `detectChannel()` は UC の形の ID だけを返し、無ければ何も返さない。ページの `/@handle` のリンクは、チャンネルを見分ける値として使わない。ID の形だけを見て `@handle` のエントリを UC のエントリへ移す移行は外した。残したのは、名前が bridge の `author` と一致する、行き先の無い `@handle` のエントリの取り込みだけ ([`e439b5b`](https://github.com/semnil/yt-channel-volume/commit/e439b5b))。今有効な規則は `CLAUDE.md` の「One channel ID form」「Channel ID formats」「Storage migration」にある。
- **実害の記録** (2026-04-19): チャンネル A の動画からチャンネル B の動画へ SPA 遷移 (ページを読み込み直さずに URL と中身だけが変わる移動) した直後、ページの `/@handle` のリンクはまだチャンネル A を指していた。当時のコードはその handle をチャンネルとして読んだ。その後に bridge がチャンネル B の UC の ID を返すと、この 2 つを「`@handle` のエントリを UC の ID へ移すべき 1 つのチャンネル」と取り違えて移行を走らせ、チャンネル A に保存していたゲインをチャンネル B のエントリに書き込んだ。

## 動画の種別は isLiveContent だけで決める

- **決定** (2026-04-19): 種別は `isLiveContent ? 'live' : 'video'` で決め、応答に `loudnessDb` があるかどうかは使わない ([`6fe4e55`](https://github.com/semnil/yt-channel-volume/commit/6fe4e55))。今有効な規則は `CLAUDE.md` の「Saved per channel × type」にある。
- **経緯**: 前の日の [`2fdf75f`](https://github.com/semnil/yt-channel-volume/commit/2fdf75f) は、プレミア公開を動画として扱うために、`isLiveContent` が true で `loudnessDb` が無いときだけを live にした。配信のアーカイブも `loudnessDb` を持つので、`loudnessDb` を持つアーカイブが動画として扱われた。プレミア公開は `isLiveContent=false` なので、`isLiveContent` だけで 2 つを分けられる。`6fe4e55` で `loudnessDb` の条件を外した。
