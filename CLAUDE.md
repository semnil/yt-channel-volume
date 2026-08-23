# yt-channel-volume

YouTube 動画の Content Loudness を表示し、ユーザー操作でチャンネル単位のゲインを保存・適用する Chrome 拡張機能 (MV3)。
保存済みゲインは Content Loudness のないライブ配信にも自動適用される。
YouTube プレイヤーのボリュームスライダーには触れず、Web Audio API の GainNode で制御する。

## Architecture

```
page-bridge.js (MAIN world content script, document_start)
├── Object.defineProperty: ytInitialPlayerResponse セット時フック
├── Fetch hook: /youtubei/v1/player レスポンスインターセプト (SPA ナビ対応)
├── extractFromYtPlayer: ytd-watch-flexy / movie_player から取得 (SPA ナビ対応)
├── isLiveContent: videoDetails.isLiveContent を抽出
└── postMessage → content.js へ loudnessDb + isLiveContent + channelId + author を中継

background.js (service worker)
├── importScripts('utils.js')
└── `store:<op>` メッセージを受けて channelVolumes を書く唯一のコンテキスト
    (saveChannelGain / saveChannelAutoApply / deleteChannel / clearChannels /
     adoptHandleEntry / migrateLegacyGains)

utils.js → content.js (ISOLATED world content scripts, document_idle)
├── postMessage listener: page-bridge.js から loudnessDb 受信
├── requestLoudnessWithRetry: on-demand で page-bridge.js にリトライ要求
├── Gain calculation (手動適用 / チャンネル別 LUFS 自動適用。保存先はどちらも同じ種別別ゲイン)
│   ├── contentLUFS = -14 + loudnessDb (YouTube reference = -14 LUFS)
│   ├── compensationDb = targetLUFS - contentLUFS
│   └── gain = 10^(compensationDb / 20), clamped [0, 6], NaN/Inf → 1.0
├── Web Audio API: <video> → MediaElementSource → GainNode → destination (遅延接続)
├── Gain overlay: .ytp-volume-area にゲイン値を表示 (設定で ON/OFF)
├── Channel detection (UC 限定): canonical / #owner a[href*="/channel/"] / meta tag → page-bridge channelId (UC 形式)
│   ├── @handle リンクは SPA 遷移中に stale になるため一切拒否。UC が DOM にない場合は bridge 待ち
│   └── 表示名: page-bridge author (videoDetails.author, 権威ソース) → DOM (#owner #channel-name a, フォールバック)
├── Navigation: triggerApply (async mutex) で applyVideoVolume を直接実行 (デバウンスなし)
│   ├── Triggers: yt-navigate-finish, popstate, visibilitychange, MutationObserver, 初回ロード
│   ├── Observer: video 要素変更 + URL video ID 変更のみ検知 (null guard で初回発火を抑制)
│   ├── _applyRunning mutex で同時実行防止。forceDetect も triggerApply 経由
│   └── videoId 変更時に currentChannel をクリアし、stale チャンネル情報の漏洩を防止
├── videoType: 'live' (配信/アーカイブ) or 'video' (動画/ショート) で別ゲイン管理
├── Cross-tab sync: chrome.storage.onChanged で channelVolumes 変更を受信し、現在チャンネル × videoType のゲインを即適用 (ポーリングなし、自タブ dedup は currentGain 比較)
└── Storage
    ├── autoLoudnessSettings: { targetLufs, displayUnit, showGainOverlay, autoApplyLoudnessVideoDefault, autoApplyLoudnessLiveDefault }
    ├── channelVolumes: { [channelId]: { name, gainLive, gainVideo, autoApplyLoudnessLive, autoApplyLoudnessVideo, url } }
    └── unifiedGains: マイグレーション済みの印 (top-level key)

utils.js (shared, content / popup / options / background で読み込み + tests)
├── Constants: storage keys, YT_REFERENCE_LUFS, DEFAULT_TARGET_LUFS
├── Gain utilities: gainToPercent, percentToGain, gainToDb, formatGain, formatAutoGain, calcGain
├── Storage utilities: isContextValid, updateChannelVolumes, CHANNEL_WRITES, getChannelGain, setChannelGain, applyChannelIdentity, normalizeStoredGain, migrateLegacyAutoGains
├── Auto state: resolveAutoApplySetting, setChannelAutoApply, hasExplicitAutoApply, isManualGainLocked
├── i18n: msg()
└── HTML escape: esc()

popup.html / popup.js
├── Loudness / Suggested / Current 表示 (読み取り専用)
├── Auto有効・LUFS未検出時はCurrentにFallbackバッジを表示 (値は保存済みゲインそのもの)
├── ライブ配信中のみ表示する LIVE バッジ
├── 「チャンネルに適用」ボタン (loudnessDb からゲイン算出・種別ごとに保存)
├── 現在視聴中の種別だけ表示する、チャンネル × Video/Live 別「LUFS 自動適用」トグル
├── Manual Volume: スライダー (0–600%) + プリセット。Auto有効・LUFS検出済みでは無効、LUFS未検出時はフォールバック調整に使用
├── 非 watch ページでは UI 非表示
└── retryGetState: loudness 未取得時のポーリングフォールバック

options.html / options.js (設定画面、別タブで表示)
├── Target LUFS スライダー (-30 ~ -6 LUFS, default -18)
├── 全チャンネルのLUFS自動適用 (Video / Live別、default OFF、個別Autoフラグのない種別が継承)
├── 表示単位トグル (% / dB)
├── ゲイン表示トグル (プレイヤーのボリュームバー横に表示、default OFF)
├── Saved Channels テーブル (Video / Live 2列。Auto時は `Auto (保存済みゲイン)`、チャンネルリンク付き、削除可)
└── storage.onChanged でリアルタイム同期
```

## i18n

- `_locales/ja/messages.json` — デフォルト日本語
- `_locales/en/messages.json` — 英語
- manifest の name/description は `__MSG_` 参照
- popup/options の UI 文字列は `data-i18n` 属性 + `chrome.i18n.getMessage`

## User workflow

1. チャンネルの動画を開く → Content Loudness が表示される
2. ポップアップに表示された現在種別の「LUFS 自動適用」をONにする → 対象種別の検出可能な動画へTarget LUFSに対応するゲインを適用
3. LUFS 未検出のライブ配信などでは保存済みの種別別ゲインへフォールバック (Auto が最後に算出したゲインもここに入る)
4. Autoが現在の検出済みLUFSを適用していない場合は、「チャンネルに適用」や Manual Volume で種別別ゲインを保存可能

## File overview

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest. permissions: storage, activeTab. host: youtube.com |
| `background.js` | Service worker. channelVolumes への書き込みを一手に引き受ける (`store:<op>`) |
| `page-bridge.js` | MAIN world. loudnessDb 抽出 (define/fetch/ytplayer) → postMessage |
| `content.js` | ISOLATED world. ゲイン管理、Audio chain、チャンネル検出、Storage |
| `utils.js` | 共通定数・ユーティリティ (content / popup / options / service worker で共有) |
| `popup.html` | Popup UI |
| `popup.js` | Popup logic. 情報表示、適用操作、手動ボリューム |
| `options.html` | 設定画面 UI |
| `options.js` | 設定 logic. Target LUFS、表示単位、チャンネル管理 |
| `_locales/` | i18n (ja, en) |
| `icons/` | Extension icons (16/48/128 px) — 3-bar loudness meter |
| `docs/screenshots/` | README 埋め込み・ストア掲載用スクリーンショット (ja, en)。`gen_screenshots.py` の出力 |
| `gen_icons.py` | アイコン生成スクリプト (Python pillow) |
| `pack.py` | Chrome Web Store 用 zip 生成 |
| `gen_screenshots.py` | スクリーンショット生成 (`docs/screenshots/` へ出力。描画フォントは `tools/fonts/` の M PLUS 1p 固定。`--check` は書き込まずコミット済み画像と画素比較し、pillow が無い環境では exit 3) |
| `tools/fonts/` | 描画フォント M PLUS 1p (Regular / Bold) と OFL.txt。google/fonts の `ofl/mplus1p` から取得 (commit `66a36c8`)。CI と各マシンで同じ画素を得るためにリポジトリへ入れている |
| `test.js` | ユニットテスト (node test.js) |
| `test-navigation.js` | ナビゲーション・状態遷移テスト (node test-navigation.js) |
| `test-screenshots.py` | `gen_screenshots.py` の出力先パス処理テスト (python3 test-screenshots.py。`node test.js` からも実行) |

## Key design decisions

- **GainNode, not HTMLMediaElement.volume**: volume property caps at 1.0. GainNode allows 0.0–6.0 (0–600%)
- **チャンネル・種別別 LUFS 自動適用**: 現在の種別に対応する `autoApplyLoudnessVideo` / `autoApplyLoudnessLive` が true で loudnessDb を取得できた場合は、Target LUFS から算出した動画固有ゲインを適用し、それを `channelVolumes` の種別別ゲインとして保存する。検出できない場合とAuto OFFの場合はその保存済みゲインを使う。旧 `autoApplyLoudness` は両種別 true として読み替える
- **Auto と手動でゲインを分けない**: 保存先はどちらも `channelVolumes.{id}.gainVideo` / `gainLive` の1値。Auto の ON/OFF を切り替えても、LUFS を検出できない動画で適用されるゲインは変わらない
- **全チャンネル既定値と個別設定**: `autoApplyLoudnessVideoDefault` / `autoApplyLoudnessLiveDefault` は、種別ごとの個別Autoフラグが存在しない場合に適用。手動保存 (「チャンネルに適用」/ Manual Volume) はその時点のAuto状態を個別フラグとして書き込むため、以後は全チャンネル既定値に追従しない。Auto自身のゲイン保存はフラグを書かず既定値への追従を保つ。既定値変更時に`channelVolumes`は書き換えない
- **MAIN world + ISOLATED world 分離**: YouTube の CSP が inline script を禁止するため、loudnessDb 抽出は `page-bridge.js` (MAIN world, `document_start`) で実行
- **3経路の loudnessDb 取得**: (1) `Object.defineProperty` で変数セット検知、(2) fetch hook (`/youtubei/v1/player`)、(3) YouTube player DOM 内部データ (`ytd-watch-flexy.__data` / `movie_player.getPlayerResponse`)
- **isLiveNow の補完**: `_capturedResp` の `isLiveNow` がページロード時点で固定されるため、request ハンドラで `movie_player.getPlayerResponse()` から最新の `isLiveNow` を補完する (待機→配信開始遷移に対応)。content.js の `forceDetect` (popup 開封時) で bridge に再問い合わせし、応答で `currentIsLiveNow` が更新された場合に `stateChanged` 経由で popup へ通知
- **videoId フィルタ**: fetch hook で他動画のプリフェッチ応答を除外
- **watch ページ限定**: MutationObserver / scheduleApply / AudioContext 生成は `/watch` のみ
- **チャンネル × 種別保存**: `gainLive` (配信/アーカイブ) と `gainVideo` (動画/ショート/プレミア公開) を別管理。videoType は `videoDetails.isLiveContent` のみで判定し (`isLiveContent ? 'live' : 'video'`)、loudnessDb は判定に使わない。ライブ配信とそのアーカイブは `isLiveContent=true` で live、プレミア公開は `isLiveContent=false` のため video 扱い
- **YouTube loudness normalization 考慮**: loudnessDb > 0 の場合、YouTube が -14 LUFS に減衰済み → effectiveLufs = -14。loudnessDb <= 0 の場合はそのまま
- **移行完了までチャンネル状態を解決しない**: content.js は起動時の fold を `storageReady` として保持し、`applyPreferredGain()` は先頭でこれを待つ。`applyAutomaticLoudnessGain()` も `storageSettled` が false の間は false を返して待つ側へ落とす。移行前のマップは「ゲインあり・Autoフラグなし = Auto OFF」の旧形式で、現在の規則 (フラグが無ければ全チャンネル既定値) で解決すると Auto が引き取って手動ゲインを算出値で上書きしてしまう (popup の `forceDetect` が fold より先に届くと起きる)
- **fold が失敗した間は旧規則で解決する**: 成功を `storageMigrated` で持ち、false の間は `resolveAutoApplySetting(..., unmigrated)` が「保存済みゲイン = Auto OFF」の旧規則を使う (options.js の一覧表示も同じ)。失敗を成功扱いにすると、印もフラグも保存されないまま Auto が手動ゲインを上書きする。`triggerApply()` は `storageMigrated` が false の間 fold を再試行し (`foldInFlight` で 1 本に束ねる)、一時的な書き込み失敗は次の apply で回復する
- **fold 前は Auto のゲインを保存しない**: 未 fold の間フラグなしゲインを書くと、旧手動ゲインと同じ形になり次の fold が Auto OFF に固定してしまう。算出したゲインは再生には当て、保存は `storageMigrated` が true になってからにする (手動保存はその時点の Auto 状態を明示フラグとして書くので、fold 前でも区別がつき保存してよい)
- **移行済みの印はクロスタブで取り込む**: `storageMigrated` は自分の fold 応答だけでなく `chrome.storage.onChanged` の `unifiedGains` からも true にする。正準状態は storage 側の印で、自タブの fold が失敗しても別タブが完了させていれば以後は現行規則で解決する必要がある (旧規則のまま残ると、別タブが保存したフラグなし Auto ゲインを手動ゲインと誤読し、そのタブで手動保存すると Auto OFF が固定される)。content.js は同じイベント内で再解決し、options.js は一覧を再描画する
- **旧キー削除は移行の一部ではない**: `clearLegacyKeys()` は失敗しても `migrateLegacyAutoGains()` を失敗させない。印とゲインは既に保存済みで、残ったキーは誰も読まない。ここで失敗を返すと呼び出し側が旧規則へ戻る。残骸は次回の呼び出しが掃く
- **Storage migration**: 旧形式 `{ gain }` → `{ gainLive, gainVideo }` への自動マイグレーション。`migrateLegacyAutoGains()` が起動時に 1 プロファイル 1 回だけ走り、フラグのない保存済みゲインに明示OFFを記録して旧判定 (保存済みゲイン=暗黙OFF) を保存する。旧 `autoLoudnessFallback:<channelId>:<type>` / `autoLoudnessFallbacks` があればAuto有効な種別の学習値をゲインへ畳み込んで削除する。実行済みの印は top-level の `unifiedGains` キー (Autoもフラグなしでゲインを書くため、2回目が走るとAutoの学習値を明示OFFに固定してしまう。設定オブジェクト内に置くと、マイグレーション前に読んだ設定書き込みが印を消す)。orphan `@handle` エントリは author 名一致による backfill で UC に統合 (id 形状ベースのマイグレーションは SPA 遷移で cross-channel corruption を引き起こすため廃止)
- **Channel ID 統一**: `detectChannel()` は UC 形式のみ返す。DOM の `@handle` リンクは SPA 遷移中に stale (前チャンネルを指す) になるため identifier として拒否。page-bridge.js の `videoDetails.channelId` (UC 形式) がフォールバック
- **チャンネル表示名の選択**: bridge の `videoDetails.author` を権威ソースとする (現在の動画の player response 由来で SPA 遷移後も正確)。DOM `getChannelDisplayName()` はフォールバックのみ (stale 可能性あり)
- **YouTube reference = -14 LUFS**: `contentLUFS = -14 + loudnessDb`
- **Default target = -18 LUFS**: ユーザー設定可能 (-30 ~ -6 LUFS)
- **createMediaElementSource**: called once per `<video>`. Cannot be called again — conflicts with other extensions
- **Channel ID formats**: `UC...` (canonical) が正規 ID。`detectChannel()` は `@handle` を拒否し UC のみ返す。DOM に UC がない場合は bridge の `videoDetails.channelId` を待つ
- **notifyPopup 重複抑制**: state key 比較で no-op 送信を防止。key には `isLiveNow` を含み、待機→配信開始の遷移でも popup へ通知が発火する
- **クロスタブ同期**: `chrome.storage.onChanged` で `channelVolumes` 変更を受信。チャンネル・種別別の自動適用フラグと種別別ゲインを即時反映し、リモート削除時は 1.0 にリセット
- **channelVolumes の書き手は service worker だけ**: content.js / options.js は `chrome.runtime.sendMessage({ type: 'store:<op>' })` で background.js に依頼し、自分では read-modify-write しない。`channelVolumes` は 1 キーにマップ全体が入るため、複数タブが同時に読んで書き戻すと後勝ちで他チャンネルのエントリが消える (Autoが動画ごとに保存するので重なりは日常的に起きる)。worker 側は `updateChannelVolumes()` の Promise チェーンで直列化し、マイグレーションもキュー内でマップを読み直すため実行中に保存されたゲインを巻き戻さない
- **NaN/Infinity ガード**: ゲイン計算結果が非有限値なら 1.0 にフォールバック
- **遅延オーディオチェーン**: ゲインが 1.0 (パススルー) の場合は `createMediaElementSource` を呼ばない → Live Caption のちらつきを回避。`connectedVideo` (audio chain) と `_lastProcessedVideo` (検出済み video) を分離管理
- **triggerApply 設計**: `setTimeout` デバウンスを廃止し、async mutex (`_applyRunning`) で同時実行を防止。`yt-navigate-finish` / `popstate` / `visibilitychange` / observer / 初回ロード の全トリガーから直接呼び出し。バックグラウンドタブの throttle やライブチャットの高頻度 DOM 更新の影響を受けない
- **ゲインオーバーレイ**: `.ytp-volume-area` にゲイン値を表示。SPA ナビでの DOM 再構築にも対応 (`document.contains` で detach 検知)
- **失敗を握り潰さない**: メッセージ処理は `handleMessage()` を try/catch で包み、`respondOnce()` で必ず 1 回だけ応答する。`commitGain()` は Promise チェーンより前に同期実行され、他拡張が `<video>` を専有していると `createMediaElementSource` が throw するため、catch が Promise だけを見ていると応答が届かない。非同期側 (`forceDetect` の `sendDetectedState`、`setTargetLufs`) も同じ `respondOnce` へ成功・失敗の両方を接続する (無応答だと popup が初期化中のまま止まる)。失敗は `reportFailure()` で console へ出す。Autoのゲイン保存失敗は再生中のゲインを変えないため、`applyPreferredGain` の中で捕らえて呼び出し元 (`forceDetect` の応答経路) を巻き込まない
- **手動ゲインは保存できて初めてゲイン**: `setGain` / `applyLoudness` は保存失敗時に `restoreGainAfterFailedSave()` が `applyPreferredGain()` を通して保存済みの値を読み直して適用し、その完了後に `{ ok: false }` を返す。スライダーは `input` の `setGainLive` で先にプレビューを当てているため「直前の値」は既に未保存の新値であり、in-memory の退避では戻せない。戻さないと再生中の音量と保存値が食い違い、popup は失敗後に読み直した値を表示して保存済みに見せ、次のナビゲーションで元へ戻る
- **コンテキスト無効化の表示**: 拡張機能 (本体または別拡張) のリロードで content.js の `chrome.runtime` が無効化されると、popup からの `chrome.tabs.sendMessage` は `Receiving end does not exist` で reject される。Web Audio API と DOM オーバーレイは chrome.* に依存しないため、過去に適用したゲイン表示だけが残り続けて誤解を招く。popup の catch 節は「チャンネル未検出」ではなく `#reloadNeeded` (ja: 「拡張機能と接続できません。ページを再読み込みしてください (F5)」) を表示し、ユーザーに F5 を促す

## Commands

```sh
# Load as unpacked extension
# chrome://extensions → Developer mode → Load unpacked → select this folder

# Regenerate icons
python3 gen_icons.py

# Regenerate screenshots (README + store) into docs/screenshots/
python3 gen_screenshots.py

# Compare the committed screenshots with what the code draws (no writes)
python3 gen_screenshots.py --check

# Run tests
node test.js
node test-navigation.js
python3 test-screenshots.py

# Package for Chrome Web Store
python3 pack.py

# No build step required. Plain JS, no bundler.
```

## Development notes

- Gain value 1.0 = 100% (passthrough). Range 0.0–6.0
- `popup.js` sends `forceDetect` on open. `forceDetect` は video ID 変更を検出し、`triggerApply` 経由で `applyVideoVolume` を再実行 (`_applyRunning` を尊重)
- `content.js` sends `stateChanged` broadcast (sender tab ID フィルタで popup が他タブの更新を無視)
- AudioContext may be `suspended` until first user interaction (Chrome autoplay policy)
- Channel detection order (UC 限定): `link[rel="canonical"][href*="/channel/"]` → `#owner a[href*="/channel/"]` / `ytd-video-owner-renderer a[href*="/channel/"]` → `meta[itemprop="channelId"]` → page-bridge `videoDetails.channelId`。`@handle` リンクは SPA 遷移中に stale になるため identifier として拒否
- Display name: bridge `videoDetails.author` が権威ソース。DOM `#owner #channel-name a` はフォールバック
- SPA ナビ検知: `yt-navigate-finish` + `popstate` + `visibilitychange` + MutationObserver (video 要素変更 + URL video ID 変更)
- テスト: `node test.js` (utils + packaging + single-writer 契約) + `node test-navigation.js` (navigation P01-P18 + bridge + guard + detectChannel + data integrity + cross-tab sync + per-channel auto LUFS + storage 失敗経路)。navigation 側は background.js を同じ VM に読み込み、`chrome.runtime.sendMessage` を worker のリスナーへ配線して実際の書き込み経路を通す
- `background.js` を編集したら chrome://extensions で拡張をリロードする。ページの再読み込みでは service worker は再評価されない (content script の変更はタブの再読み込みで足りる)
- テスト用 export: `__TEST_YTCV__` フラグで content.js 内部を `globalThis.__YTCV__` に露出。本番では無効
- Storage keys: `autoLoudnessSettings` (target LUFS, display unit, Video/Live auto defaults), `channelVolumes` (saved channel gains, per-channel auto overrides, URL), `unifiedGains` (マイグレーション済みの印)。legacy `autoLoudnessFallback:<channelId>:<type>` / `autoLoudnessFallbacks` は起動時に畳み込んで削除
- Storage format: `channelVolumes.{id}` = `{ name, gainLive, gainVideo, autoApplyLoudnessLive, autoApplyLoudnessVideo, url }` (種別ごとの個別自動適用フラグがない場合に全チャンネル既定値を継承。旧 `autoApplyLoudness` は両種別同値、旧 `{ name, gain, url }` は両ゲインとして読み替え)
- slider `input` event = リアルタイムゲイン変更 (storage 書き込みなし)、`change` event = storage 保存。Auto有効・LUFS検出済みでは両操作を拒否する
- videoType 判定: page-bridge.js が `videoDetails.isLiveContent` を返す。content.js で `isLiveContent` が `true` なら 'live'、`false` なら 'video' (loudnessDb は判定に使わない)。プレミア公開は `isLiveContent=false` のため 'video' 扱い。初回ロード時はデフォルト 'video' で、bridge から isLiveContent を受信後に正しい種別のゲインに切替
