# RFC: ランタイム再アーキテクチャ

## 目的

この RFC は、Durably のランタイムを再設計するための提案をまとめたものである。

Durably は Node.js とブラウザで動くジョブランタイムである。ジョブをステップの連続として定義し、各ステップの結果はデータベースに保存される。ワーカーが途中で落ちても、別のワーカーが続きから再開できる。プロセスではなくデータベースが source of truth となる。

## 推奨する導入パス

個人開発者が最小限のコストとセットアップで Durably を試すにあたって、もっとも入りやすいのは以下の組み合わせである:

- `Vercel + Turso`

理由:

- どちらも無料枠が手厚く、気軽に始められる
- Vercel は web-first な個人プロジェクトのデプロイ先として馴染みがある
- Turso はサーバ上にファイルを常駐させる必要がなく、SQLite に近い感覚で使える
- runtime model のポータビリティを保ちやすく、重いインフラ構成に引きずられにくい

次に有力なのは:

- `Cloudflare Workers + Turso`

edge 配置や event-driven な実行を重視する場合、Vercel 型のホスティングよりもこちらが向いている。

本番運用を見据えた構成としては、以下も視野に入れておきたい:

- `Vercel + PostgreSQL`
- `Fly.io + PostgreSQL`

最初の一歩としてはやや重いが、小規模を超えて実運用に進むときの現実的なデプロイ構成として押さえておく価値がある。

## Cloudflare に関する補足

Cloudflare Workflows は、Durably が解決しようとしている課題の一部と重なっている。

そのため、Durably の位置づけは明確にしておく必要がある:

- Cloudflare に完全にコミットしていて、platform-native な durable execution で十分なら、Workflows のほうがシンプルな選択肢になりうる
- Vercel、Cloudflare、AWS、ローカル開発をまたいで同じ実行モデルを維持したいなら、Durably には明確な役割がある

Durably は Cloudflare Workflows の存在を無視すべきではない。この RFC では、Workflows を Cloudflare 専用アプリケーションにとっての有力なプラットフォームネイティブな選択肢として扱う。

## 読む順番

> **どこまで読めばいい？**
>
> - **Durably を使いたい・評価したい** → 1 と 2 を読めば十分。ランタイムモデルとデプロイ構成がわかる。
> - **データベース adapter を実装したい** → 3（データベース系 3 文書）も読む。
> - **将来の方向性に興味がある** → 4 は任意。読み飛ばしても問題ない。

### 1. コア

- [core-runtime.md](/Users/coji/progs/oss/durably/docs/rfcs/runtime-rearchitecture/ja/core-runtime.md)
  メインの RFC。コアランタイムモデル、queue store、checkpoint store、フェーズ分割を定義する。

### 2. デプロイ

- [deployment-models-ja.md](/Users/coji/progs/oss/durably/docs/rfcs/runtime-rearchitecture/ja/deployment-models-ja.md)
  常駐ワーカーとサーバーレスプラットフォームをまたぐランタイム構成。
  `Vercel + Turso` や `Cloudflare Workers + Turso` の具体的な構成を知りたいならここから。

### 3. データベース（adapter 実装者向け）

- [database-runtime-fit-ja.md](/Users/coji/progs/oss/durably/docs/rfcs/runtime-rearchitecture/ja/database-runtime-fit-ja.md)
  データベースの選定 — どのデータベースがランタイムに適合するか。
- [database-claim-patterns-ja.md](/Users/coji/progs/oss/durably/docs/rfcs/runtime-rearchitecture/ja/database-claim-patterns-ja.md)
  adapter の実装 — 各バックエンドがランの取得と実行権を管理する方法。
- [database-adapter-sketches-ja.md](/Users/coji/progs/oss/durably/docs/rfcs/runtime-rearchitecture/ja/database-adapter-sketches-ja.md)
  PostgreSQL と SQLite の具体的なクエリスケッチ。

### 4. 将来の方向性（任意 — Durably を使いたいだけなら読み飛ばしてよい）

- [ambient-agent-concepts-ja.md](/Users/coji/progs/oss/durably/docs/rfcs/runtime-rearchitecture/ja/ambient-agent-concepts-ja.md)
  アンビエントエージェントをランタイムの拡張として解釈するプロダクトレベルの構想。Phase 2 の話であり、コアランタイムの理解には不要。
