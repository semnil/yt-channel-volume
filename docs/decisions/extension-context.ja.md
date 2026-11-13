# Extension context decisions

> English: [extension-context.md](extension-context.md)

拡張機能の再読み込みで `chrome.runtime` から切り離された content script (ページに差し込まれて動くスクリプト) について閉じた判断。今有効な規則は `AGENTS.md` の「Showing an invalidated context」にある。

## An invalidated context is shown, not detected

- **決定** (2026-05-06): popup からタブへのメッセージが拒否されたとき、popup は「チャンネル未検出」の代わりに `reloadPageNeeded` (「拡張機能と接続できません。ページを再読み込みしてください (F5)」) を表示する。`content.js` は、`chrome.*` を使う直前にコンテキストを確かめる (`isContextValid()`) だけで、自分が切り離されたことをタイマーで調べにいかない ([`2c913be`](https://github.com/semnil/yt-channel-volume/commit/2c913be))。
- **却下した案**: `content.js` が `setInterval` で定期的に調べて、切り離されたことに自分で気付く案。Chrome は content script にそのためのイベントを渡さないので、気付くには定期的に調べるしかなく、その負荷は負わないことにした。
- **実害の記録** (2026-05-06): 視聴者から「チャンネル未検出」と報告があった。そのときのタブの状態は次のとおり。プレーヤーの音量バーの横のゲインのオーバーレイは表示されたまま。popup は「チャンネル未検出」と表示。ページの DevTools のコンソールで読んだ `chrome.runtime?.id` は `undefined`。popup を開いても `[YTCV][popup-open]` の行が出ない。`content.js` は拡張機能の再読み込みで `chrome.runtime` から切り離されていて、`chrome.runtime.onMessage` のリスナーは登録されたまま呼ばれなくなっていた。音声の経路とオーバーレイは `chrome.*` に頼らないので、再読み込みの前に適用したゲインはそのまま鳴り、表示も残った。これが「チャンネルは未検出なのにゲインは効いている」と読めた。当時の popup の catch 節は、`chrome.tabs.sendMessage` が拒否されると常に `channelNotDetected` を表示していて、原因 (接続が切れていること) を隠していた。コンソールがどのコンテキストを読んでいたかは、記録に無い。ページ自身のコンテキストでは、content script が切り離されているかどうかに関係なく `chrome.runtime?.id` は `undefined` になる。この値で 2 つを見分けられるのは content script のコンテキストで読んだときだけで、`AGENTS.md` の確かめ方は今その形で書いてある。
- **どの再読み込みか** (2026-11-13): `content.js` を切り離すのは、この拡張機能自身の再読み込み。別の拡張機能を再読み込みしても、切り離されない。`chrome://extensions` のボタンで別の拡張機能を再読み込みし、YouTube のタブで、この拡張機能の content script のコンテキストで読んだ `chrome.runtime?.id` は、前後で同じ id だった。規則は 2026-05-06 から「この拡張機能か、別の拡張機能」と書いていたが、別の拡張機能の再読み込みで起きたという記録は無い。
