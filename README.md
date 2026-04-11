# YT Channel Volume

YouTube チャンネルごとに音量を記憶し、動画を開いた時に自動で適用する Chrome 拡張機能 (Manifest V3)。

## 特徴

- **チャンネル単位の音量記憶**: 一度設定すれば、同じチャンネルの動画を開くたびに保存済みの音量が自動適用
- **Content Loudness からの最適音量算出**: YouTube が動画ごとに測定した Content Loudness を読み取り、ターゲット LUFS に基づいて最適なボリュームを算出。ワンクリックでチャンネルに保存
- **ライブ / 動画で別音量**: 同じチャンネルでもライブ配信 (アーカイブ含む) と通常の動画で異なる音量を設定可能
- **手動ボリューム調整**: 0〜600% の範囲でスライダーまたはプリセットボタンから設定
- **ゲイン表示**: プレイヤーの音量バーの横に現在のゲイン値を表示 (設定で ON/OFF)
- **日本語/英語**: ブラウザ言語設定で自動切替
- **外部依存ゼロ**: npm パッケージ・CDN なし。全コード自作

## セットアップ

### 1. 拡張をインストール

[Chrome Web Store](https://chromewebstore.google.com/detail/yt-channel-volume/hoagpdjnapnpdbmnemhcdfpdehgokaab) からインストール

> **開発版を使う場合**: `chrome://extensions` → デベロッパーモード ON → 「パッケージ化されていない拡張機能を読み込む」でこのリポジトリのフォルダを指定

### 2. 使う

1. チャンネルのアーカイブ動画を開く
2. ポップアップに表示される Content Loudness と Suggested (推奨ボリューム) を確認
3. 「チャンネルに適用」ボタンをクリック
4. 同じチャンネルの他の動画やライブ配信を開くと、保存した音量が自動適用

### 3. 設定

ポップアップの歯車アイコンから設定画面を開く:

- **Target LUFS**: Loudness から算出するゲインの基準値 (デフォルト: -18 LUFS)
- **表示単位**: % または dB
- **ゲイン表示**: プレイヤー上にゲイン値をオーバーレイ表示 (デフォルト: OFF)
- **Saved Channels**: 保存済みチャンネルの一覧管理

## 仕組み

```
page-bridge.js (MAIN world, document_start)
  → ytInitialPlayerResponse / fetch hook / YouTube player DOM
  → loudnessDb + isLiveContent + channelId を取得
  → postMessage で content.js に中継

content.js (ISOLATED world, document_idle)
  → postMessage で loudnessDb を受信 (情報表示のみ)
  → ユーザーが「チャンネルに適用」→ ゲイン算出・チャンネルに保存
  → 保存済みチャンネルの動画を開く → Web Audio API GainNode でゲイン適用
```

- YouTube のボリュームスライダーには一切触れない
- ゲインが 1.0 (パススルー) の場合はオーディオチェーンを接続しない → Live Caption のちらつきを回避
- YouTube の CSP が inline script を禁止するため、loudnessDb 抽出は MAIN world の `page-bridge.js` で実行

## ビルド

```bash
# テスト実行
node test.js              # utils 37件
node test-navigation.js   # navigation + data integrity 65件

# アイコン再生成
python gen_icons.py

# Chrome Web Store 用 zip
python pack.py
# → yt-channel-volume-1.0.0.zip
```

## ファイル構成

```
yt-channel-volume/
├── manifest.json         # Manifest V3 設定
├── page-bridge.js        # MAIN world — loudnessDb 抽出
├── content.js            # ISOLATED world — ゲイン管理・チャンネル検出
├── utils.js              # 共通定数・ユーティリティ (popup/options 共有)
├── popup.html/js         # ツールバーポップアップ
├── options.html/js       # 設定画面
├── _locales/             # i18n (ja, en)
├── icons/                # 拡張アイコン (16/48/128 px)
├── test.js               # utils ユニットテスト
├── test-navigation.js    # ナビゲーション・データ整合性テスト
├── gen_icons.py          # アイコン生成 (Python pillow)
├── pack.py               # zip パッケージング
├── PRIVACY_POLICY.md     # プライバシーポリシー (EN)
├── PRIVACY_POLICY_JA.md  # プライバシーポリシー (JA)
└── README.md
```

## セキュリティ

- 外部へのネットワークリクエストは一切なし
- すべてのデータは `chrome.storage.local` にローカル保存
- 通信先は YouTube のみ (コンテンツスクリプトとして動作)
- ソースコードは全ファイル公開。第三者依存なし
- 詳細は [PRIVACY_POLICY.md](PRIVACY_POLICY.md) を参照

## 既知の制限

- **createMediaElementSource**: `<video>` 要素あたり 1 回のみ呼び出し可能。Volume Master 等の他の音量拡張と競合する場合がある
- **Shorts**: `/shorts/` パスの動画は対象外
- **ライブ配信の Content Loudness**: 配信中のライブには Content Loudness データがないため、「チャンネルに適用」は使用できない (アーカイブの Loudness から設定するか、手動ボリュームで設定)

## ライセンス

MIT
