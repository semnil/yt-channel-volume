# 文書の決定

> English: [documentation.md](documentation.md)

このリポジトリの文書の言語と名前について閉じた判断。今有効な規則は `CLAUDE.md` の「Conventions」にある。

## 英語を基本にしたときに、そのまま残したもの

- **決定** (2026-10-20): 文書を英語基本にして日本語を別のファイルに分けたとき、次の 2 つはそのまま残した。文書の言語を見直すレビューで、もう一度挙げない。
  - `CLAUDE.md` の「Showing an invalidated context」は、`reloadPageNeeded` の日本語の文言を引用している (`(ja: 「…」)`)。この引用を英語の文言に置き換えない。
  - `PRIVACY_POLICY_JA.md` を、ほかの対が使う `<name>.ja.md` の形に改名しない。
- 3 つ目の「`tools/mutation/equivalents.md` の日本語版は作らない」は、共有の掃引 (ソースの 1 か所を壊した版を作り、テストが落ちるかを見る道具) を取る拡張機能の全体の決定で、[channel-volume-core](https://github.com/semnil/channel-volume-core) の `docs/decisions/documentation.md` に記録している。
- **理由**: GitHub の上のファイルへのリンクはパスを名指ししていて、改名を追わない。そのため、外から `PRIVACY_POLICY_JA.md` を名指ししているリンクは切れる。3 つとも、英語への移行が取りこぼした所に見えるので、後のレビューでもう一度指摘されうる。
