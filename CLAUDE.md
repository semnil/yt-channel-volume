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

content.js (ISOLATED world content script, document_idle)
├── postMessage listener: page-bridge.js から loudnessDb 受信 (情報表示のみ)
├── requestLoudnessWithRetry: on-demand で page-bridge.js にリトライ要求
├── Gain calculation (ユーザー操作トリガー)
│   ├── contentLUFS = -14 + loudnessDb (YouTube reference = -14 LUFS)
│   ├── compensationDb = targetLUFS - contentLUFS
│   └── gain = 10^(compensationDb / 20), clamped [0, 6], NaN/Inf → 1.0
├── Web Audio API: <video> → MediaElementSource → GainNode → destination (遅延接続)
├── Gain overlay: .ytp-volume-area にゲイン値を表示 (設定で ON/OFF)
├── Channel detection: canonical / #owner a[href] / ytd-video-owner-renderer / meta tag → page-bridge channelId (UC 形式)
│   └── 表示名: DOM (#owner #channel-name a) → page-bridge author (videoDetails.author, SPA ナビ中の stale DOM フォールバック)
├── Navigation: triggerApply (async mutex) で applyVideoVolume を直接実行 (デバウンスなし)
│   ├── Triggers: yt-navigate-finish, popstate, visibilitychange, MutationObserver, 初回ロード
│   ├── Observer: video 要素変更 + URL video ID 変更のみ検知 (null guard で初回発火を抑制)
│   └── _applyRunning mutex で同時実行防止。forceDetect も triggerApply 経由
├── videoType: 'live' (配信/アーカイブ) or 'video' (動画/ショート) で別ゲイン管理
├── Cross-tab sync: chrome.storage.onChanged で channelVolumes 変更を受信し、現在チャンネル × videoType のゲインを即適用 (ポーリングなし、自タブ dedup は currentGain 比較)
└── Storage
    ├── autoLoudnessSettings: { targetLufs, displayUnit, showGainOverlay }
    └── channelVolumes: { [channelId]: { name, gainLive, gainVideo, url } }

utils.js (shared, popup/options で読み込み + test.js)
├── Constants: SETTINGS_KEY, CHANNEL_VOLUMES_KEY, YT_REFERENCE_LUFS, DEFAULT_TARGET_LUFS
├── Gain utilities: gainToPercent, percentToGain, gainToDb, formatGain, calcGain
├── i18n: msg()
└── HTML escape: esc()

popup.html / popup.js
├── Loudness / Suggested / Current 表示 (読み取り専用)
├── Video Type バッジ (LIVE / VIDEO)
├── 「チャンネルに適用」ボタン (loudnessDb からゲイン算出・種別ごとに保存)
├── Manual Volume: スライダー (0–600%) + プリセット
├── 非 watch ページでは UI 非表示
└── retryGetState: loudness 未取得時のポーリングフォールバック

options.html / options.js (設定画面、別タブで表示)
├── Target LUFS スライダー (-30 ~ -6 LUFS, default -18)
├── 表示単位トグル (% / dB)
├── ゲイン表示トグル (プレイヤーのボリュームバー横に表示、default OFF)
├── Saved Channels テーブル (Video / Live 2列、チャンネルリンク付き、削除可)
└── storage.onChanged でリアルタイム同期
```

## i18n

- `_locales/ja/messages.json` — デフォルト日本語
- `_locales/en/messages.json` — 英語
- manifest の name/description は `__MSG_` 参照
- popup/options の UI 文字列は `data-i18n` 属性 + `chrome.i18n.getMessage`

## User workflow

1. チャンネルのアーカイブ動画を開く → Content Loudness が表示される
2. 「チャンネルに適用」ボタンを押す → ターゲット LUFS との差分からゲインを算出・チャンネルに保存
3. 同チャンネルのライブ配信や他の動画を開く → 保存済みゲインが自動適用
4. Manual Volume スライダーで任意のゲインに変更・保存も可能

## File overview

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest. permissions: storage, activeTab. host: youtube.com |
| `page-bridge.js` | MAIN world. loudnessDb 抽出 (define/fetch/ytplayer) → postMessage |
| `content.js` | ISOLATED world. ゲイン管理、Audio chain、チャンネル検出、Storage |
| `utils.js` | 共通定数・ユーティリティ (popup/options で共有) |
| `popup.html` | Popup UI |
| `popup.js` | Popup logic. 情報表示、適用操作、手動ボリューム |
| `options.html` | 設定画面 UI |
| `options.js` | 設定 logic. Target LUFS、表示単位、チャンネル管理 |
| `_locales/` | i18n (ja, en) |
| `icons/` | Extension icons (16/48/128 px) — 3-bar loudness meter |
| `gen_icons.py` | アイコン生成スクリプト (Python pillow) |
| `pack.py` | Chrome Web Store 用 zip 生成 |
| `test.js` | ユニットテスト (node test.js) |

## Key design decisions

- **GainNode, not HTMLMediaElement.volume**: volume property caps at 1.0. GainNode allows 0.0–6.0 (0–600%)
- **loudnessDb は情報表示のみ**: 自動適用しない。ユーザーが動画を選んで「チャンネルに適用」で保存
- **MAIN world + ISOLATED world 分離**: YouTube の CSP が inline script を禁止するため、loudnessDb 抽出は `page-bridge.js` (MAIN world, `document_start`) で実行
- **3経路の loudnessDb 取得**: (1) `Object.defineProperty` で変数セット検知、(2) fetch hook (`/youtubei/v1/player`)、(3) YouTube player DOM 内部データ (`ytd-watch-flexy.__data` / `movie_player.getPlayerResponse`)
- **videoId フィルタ**: fetch hook で他動画のプリフェッチ応答を除外
- **watch ページ限定**: MutationObserver / scheduleApply / AudioContext 生成は `/watch` のみ
- **チャンネル × 種別保存**: `gainLive` (配信/アーカイブ) と `gainVideo` (動画/ショート) を別管理。`isLiveContent` フラグで判定
- **YouTube loudness normalization 考慮**: loudnessDb > 0 の場合、YouTube が -14 LUFS に減衰済み → effectiveLufs = -14。loudnessDb <= 0 の場合はそのまま
- **Storage migration**: 旧形式 `{ gain }` → `{ gainLive, gainVideo }` への自動マイグレーション。`@handle` → `UC...` への ID マイグレーションも自動
- **Channel ID 統一**: page-bridge.js が `videoDetails.channelId` (UC 形式) を返す。DOM 検出で `@handle` が得られた場合も UC 形式に自動修正
- **チャンネル表示名の選択**: SPA ナビで UC→UC 遷移時は旧チャンネルの名前が stale になるため、`videoDetails.author` (現在の動画の player response 由来) を優先。`@handle`→UC マイグレーションでは同一チャンネルのため DOM 優先、取得失敗時は既存名を維持
- **YouTube reference = -14 LUFS**: `contentLUFS = -14 + loudnessDb`
- **Default target = -18 LUFS**: ユーザー設定可能 (-30 ~ -6 LUFS)
- **createMediaElementSource**: called once per `<video>`. Cannot be called again — conflicts with other extensions
- **Channel ID formats**: `UC...` (canonical) が正規 ID。DOM 検出で `@handle` が得られても player response の `channelId` で UC に修正
- **notifyPopup 重複抑制**: state key 比較で no-op 送信を防止
- **クロスタブ同期**: `chrome.storage.onChanged` で `channelVolumes` 変更を受信。`extractGainForType` で旧 `{gain}` 形式含めて解決し、`currentGain` 比較で自タブ書き込みの reentry を抑止。リモート削除時は 1.0 にリセット
- **NaN/Infinity ガード**: ゲイン計算結果が非有限値なら 1.0 にフォールバック
- **遅延オーディオチェーン**: ゲインが 1.0 (パススルー) の場合は `createMediaElementSource` を呼ばない → Live Caption のちらつきを回避。`connectedVideo` (audio chain) と `_lastProcessedVideo` (検出済み video) を分離管理
- **triggerApply 設計**: `setTimeout` デバウンスを廃止し、async mutex (`_applyRunning`) で同時実行を防止。`yt-navigate-finish` / `popstate` / `visibilitychange` / observer / 初回ロード の全トリガーから直接呼び出し。バックグラウンドタブの throttle やライブチャットの高頻度 DOM 更新の影響を受けない
- **ゲインオーバーレイ**: `.ytp-volume-area` にゲイン値を表示。SPA ナビでの DOM 再構築にも対応 (`document.contains` で detach 検知)

## Commands

```sh
# Load as unpacked extension
# chrome://extensions → Developer mode → Load unpacked → select this folder

# Regenerate icons
python gen_icons.py

# Run tests
node test.js
node test-navigation.js

# Package for Chrome Web Store
python pack.py

# No build step required. Plain JS, no bundler.
```

## Development notes

- Gain value 1.0 = 100% (passthrough). Range 0.0–6.0
- `popup.js` sends `forceDetect` on open. `forceDetect` は video ID 変更を検出し、`triggerApply` 経由で `applyVideoVolume` を再実行 (`_applyRunning` を尊重)
- `content.js` sends `stateChanged` broadcast (sender tab ID フィルタで popup が他タブの更新を無視)
- AudioContext may be `suspended` until first user interaction (Chrome autoplay policy)
- Channel detection order: `link[rel="canonical"]` → `#owner a[href]` → `ytd-video-owner-renderer a[href]` → `meta[itemprop="channelId"]` → page-bridge `videoDetails.channelId` (UC 形式で上書き)。watch-metadata-refresh レイアウトでは `ytd-video-owner-renderer` が直接見えないため `#owner` 経由を優先
- Display name: `#owner #channel-name a` DOM 要素から取得。ID は UC 形式で統一 (日本語ハンドル対応: `/@` 以降を `[^/?#]+` でマッチ)
- SPA ナビ検知: `yt-navigate-finish` + `popstate` + `visibilitychange` + MutationObserver (video 要素変更 + URL video ID 変更)
- テスト: `node test.js` (utils) + `node test-navigation.js` (navigation P01-P18 + bridge + guard + detectChannel + data integrity + cross-tab sync)
- テスト用 export: `__TEST_YTCV__` フラグで content.js 内部を `globalThis.__YTCV__` に露出。本番では無効
- Storage keys: `autoLoudnessSettings` (target LUFS, display unit), `channelVolumes` (saved channel gains with URL)
- Storage format: `channelVolumes.{id}` = `{ name, gainLive, gainVideo, url }` (旧: `{ name, gain, url }` — 自動マイグレーション)
- slider `input` event = リアルタイムゲイン変更 (storage 書き込みなし)、`change` event = storage 保存
- videoType 判定: page-bridge.js が `videoDetails.isLiveContent` を返す。初回ロード時はデフォルト 'video' で、loudness 取得後に正しい種別のゲインに切替
