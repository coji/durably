# RFC: ランタイム再設計

## 目的

この RFC は、Durably のランタイムを再設計するための提案をまとめたものです。

Durably は Node.js とブラウザで動くジョブランタイムです。ジョブをステップの連続として定義し、各ステップの結果はデータベースに永続化されます。ワーカーが途中でダウンしても、別のワーカーが続きから再開できます。プロセスではなくデータベースが唯一の信頼源です。

## 推奨する導入パス

個人開発者が最小限のコストとセットアップで Durably を試すなら、最も入りやすいのは以下の組み合わせです。

- `Vercel + Turso`

理由:

- どちらも無料枠が手厚く、気軽に始められる
- Vercel は Web 系の個人プロジェクトのデプロイ先として馴染みがある
- Turso はサーバ上にファイルを常駐させる必要がなく、SQLite に近い感覚で使える
- ランタイムモデルのポータビリティを保ちやすく、重いインフラ構成に引きずられにくい

次に有力なのは:

- `Cloudflare Workers + Turso`

Edge 配置やイベント駆動の実行を重視するなら、Vercel 型のホスティングよりもこちらが向いています。

本番運用を見据えた構成としては、以下も選択肢に入ります。

- `Vercel + PostgreSQL`
- `Fly.io + PostgreSQL`

最初の一歩としてはやや重いですが、小規模を超えて実運用に進む際の現実的なデプロイ構成として押さえておく価値があります。

## Cloudflare に関する補足

Cloudflare Workflows は、Durably が解決しようとしている課題の一部と重なっています。

そのため、Durably の位置づけは明確にしておく必要があります。

- Cloudflare に完全にコミットしていて、プラットフォームネイティブな durable execution で十分なら、Workflows のほうがシンプルな選択肢になりうる
- Vercel、Cloudflare、AWS、ローカル開発をまたいで同じ実行モデルを維持したいなら、Durably には明確な役割がある

Durably は Cloudflare Workflows の存在を無視すべきではありません。この RFC では、Workflows を Cloudflare 専用アプリケーションにとっての有力なプラットフォームネイティブ選択肢として扱います。

## 読む順番

> **どこまで読めばいい？**
>
> - **Durably を使いたい・評価したい** → 1 と 2 を読めば十分。ランタイムモデルとデプロイ構成がわかる。
> - **データベース adapter を実装したい** → 3（データベース系 3 文書）も読む。
> - **将来の方向性に興味がある** → 4 は任意。読み飛ばしても問題ない。

### 1. コア

- [core-runtime.md](./core-runtime.md)
  メインの RFC。コアランタイムモデル、queue store、checkpoint store、フェーズ分割を定義する。

### 2. デプロイ

- [deployment-models-ja.md](./deployment-models-ja.md)
  常駐ワーカーとサーバーレスプラットフォームをまたぐランタイム構成。
  `Vercel + Turso` や `Cloudflare Workers + Turso` の具体的な構成を知りたいならここから。

### 3. データベース（adapter 実装者向け）

- [database-runtime-fit-ja.md](./database-runtime-fit-ja.md)
  各データベースがランタイムの要件をどの程度満たすかの評価。
- [database-claim-patterns-ja.md](./database-claim-patterns-ja.md)
  claim、renew、complete のデータベースごとの具体的な実装パターン。
- [database-adapter-sketches-ja.md](./database-adapter-sketches-ja.md)
  PostgreSQL と SQLite の具体的な SQL スケッチ。

### 4. 将来の方向性（任意）

- [ambient-agent-concepts-ja.md](./ambient-agent-concepts-ja.md)
  Phase 2 で検討しているアンビエントエージェントの設計構想。Durably を使いたいだけなら読み飛ばしてよい。
