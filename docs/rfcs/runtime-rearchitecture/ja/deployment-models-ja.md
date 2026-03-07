# 設計: デプロイ先ごとのランタイム構成

## 目標

本ドキュメントでは、Durably のランタイムを異なるデプロイ先でどのように構成するかを整理する。

主に扱うのは次の点となる:

- 各プラットフォームに存在するコンポーネント
- ジョブをどのように trigger するか
- 短命な invocation をまたいで、どのように execution を継続するか

ストレージ契約やコアランタイムの意味論はここでは扱わない。それらは `core-runtime.md` に委ねる。

## 推奨される入口

DX と低摩擦な導入を重視するなら、推奨される入口は次の2つになる:

1. `Vercel + Turso`
2. `Cloudflare Workers + Turso`

これらだけが成立する構成というわけではない。個人開発者が無料または低コストで始めやすく、自前の worker infrastructure を持たずに試せる入口として、この2つを優先している。

同時に、実運用寄りの構成として次の2つも強く意識しておきたい:

- `Vercel + PostgreSQL`
- `Fly.io + PostgreSQL`

これらは本番向けの構成として重要であり、Durably の位置づけを考えるうえでも見落とすべきではない。

### なぜ `Vercel + Turso` が先か

- Web 中心のホスティングとして馴染みやすい
- HTTP 中心のデプロイの流れが分かりやすい
- side project や solo-built SaaS と相性がよい
- Turso によって、常駐する file-based SQLite を要求せずに SQLite 風のデータモデルを保てる

### なぜ `Cloudflare Workers + Turso` が次点か

- edge と event-driven execution に強い
- ingress と short-lived execution の分離がきれいに保てる
- database を platform runtime の外に置くことで portability を確保しやすい

### 実運用寄りの構成として意識すべきもの

`Vercel + PostgreSQL`

- Web 中心のホスティングモデルを維持できる
- セマンティクスがもっとも明快な DB を採用できる
- `Vercel + Turso` が小さすぎる、あるいは caveat が気になってきた段階で自然な移行先となる

`Fly.io + PostgreSQL`

- resident worker との相性がよい
- 長時間稼働プロセスを受け入れられるなら実行の流れが単純になる
- PostgreSQL を軸にした明快なセマンティクスを維持できる

### Cloudflare に関する重要な注意

Cloudflare Workflows は durable execution の platform-native な代替としてかなり強力な存在だ。

したがって、推奨の仕方は次のように整理するのがよい:

- portability や database-centered runtime model が重要なら Durably を使う
- Cloudflare 専用でよく、最も単純な platform-native durable execution が欲しいなら Cloudflare Workflows をまず評価する

Durably としては、この重なりを隠さず正直に位置づけるべきだろう。

## コア原則

Durably は、1回のプロセス invocation を execution の単位として扱わない。

代わりに次のように考える:

- `Run` が永続的な実行単位となる
- invocation は一時的な計算スライスに過ぎない
- database が source of truth になる
- 意味のある境界はすべて checkpoint 可能にする必要がある
- correctness が常駐プロセスに依存しないこと

この原則によって、常駐 worker 型と serverless 型のどちらも実現可能になる。

## Trigger の種類

プラットフォームをまたいで考えると、trigger は次の4つの役割に分けると扱いやすい:

1. `Ingress`: `enqueue()` を呼んで run を作る
2. `Kick`: enqueue の直後にできるだけ早く処理を始める
3. `Sweep`: backlog や期限切れ lease を定期的に回収する
4. `Resume`: 後続の invocation で処理を再開する

多くのデプロイ構成では、これらは別々のプラットフォーム機能によって実装される。

## 共通するランタイムの形

デプロイ先に関わらず、目指す形は共通している:

- API や webhook handler が `enqueue()` を呼ぶ
- 短命な worker が `processOne()` または `processUntilIdle()` を呼ぶ
- step 境界で checkpoint を保存する
- event stream は、出力を届ける前または届けるのと同時に保存する
- 後続の invocation が期限切れの work を reclaim して継続できる

## モデル1: 常駐 Worker / 常時稼働サーバ

最も単純なデプロイモデルとなる。

### 構成

- application server
- 常駐 worker loop
- database

### Trigger Flow

- HTTP または webhook handler が `enqueue()` を呼ぶ
- worker loop が claim 可能な run を poll する、または待ち受ける
- worker が execution 中に lease を renew する
- worker が run を complete または fail する

### 運用イメージ

- VM、container、ECS、Fly.io machine、Kubernetes worker に適している
- lease renew を素直に実装できる
- scheduling overhead が小さい
- 長い外部呼び出しや高スループットの drain に向いている

### メンタルモデル

worker は runtime の便利なラッパーであり、runtime そのものではない。

## モデル2: Vercel

Vercel は ingress と short worker の環境として扱うのが自然だ。

### 構成

- API / webhook ingress 用の Vercel HTTP Functions
- 定期回収用の Vercel Cron
- 外部 database
- 負荷時に wake-up を速めるための任意の外部 queue

### Trigger Flow

1. ユーザー操作または webhook が Vercel Function を呼ぶ
2. handler が `enqueue()` を呼ぶ
3. handler は best-effort で `processOne()` を試してもよい
4. Vercel Cron が定期的に worker endpoint を叩く
5. その endpoint が `processUntilIdle({ maxRuns })` を呼ぶ
6. 未完了の work は後続 invocation が再開する

### 向いている用途

- 小規模から中規模の workload
- HTTP ingress が中心のプロダクト
- durability を保ったうえで eventual progress を許容できるケース
- 個人開発者が最初に試す low-cost な入口

### 重要な制約

function 内の background continuation に correctness を依存させないこと。

安全な設計は次のようになる:

- 状態を頻繁に保存する
- step を短く保つ
- step 間で function が停止しうる前提で設計する

### 実践的な変種

より高い即時性や大きな backlog が必要な場合:

- ingress は Vercel のままにする
- 外部 queue を追加する
- queue message は wake-up signal として使う

queue を source of truth にすべきではない。source of truth は常にデータベース上の run record にある。

## モデル3: Netlify

Netlify は同期 ingress と background processing を素直に分離しやすい構成だ。

### 構成

- ingress 用の Netlify Functions
- より長い処理用の Netlify Background Functions
- sweep 用の Scheduled Functions
- 外部 database

### Trigger Flow

1. ユーザー操作または webhook が通常 Function に入る
2. handler が `enqueue()` を呼ぶ
3. handler が background function を起動する
4. background function が `processUntilIdle({ maxRuns })` を呼ぶ
5. Scheduled Functions が backlog と期限切れ lease を回収する

### 向いている用途

- 多数の外部コンポーネントを足さずに hosted serverless を使いたいプロダクト
- 同期処理と非同期処理の handoff を明示したい workload

### 重要な制約

background execution も一時的な compute に過ぎず、durable な ownership ではない。

実行権限は常にデータベース上の lease にある。

## モデル4: Cloudflare Workers

Cloudflare は Queues と Cron Triggers を組み合わせることで、最もきれいに serverless 適合する。

### 構成

- ingress 用の Workers HTTP handlers
- wake-up と deferred processing 用の Cloudflare Queues
- processing 用の Queue consumers
- sweep 用の Cron Triggers
- 外部 durable database

### Trigger Flow

1. HTTP ingress が `enqueue()` を呼ぶ
2. handler が wake-up message を queue に push する
3. queue consumer が `processOne()` または `processUntilIdle({ maxRuns })` を呼ぶ
4. Cron Triggers が stale または missed な work を回収する
5. 後続 consumer が未完了 run を reclaim して継続する

### 向いている用途

- event-driven system
- queue ベースの wake-up に自然に乗る workload
- ingress と execution を強く分離したいアプリケーション
- Vercel とは別の edge-first な入口を求める開発者

### 重要な制約

queue message は wake-up signal として扱うものであり、durable な job state ではない。

連続性の境界は常に database に置く必要がある。

## モデル5: AWS Lambda

AWS Lambda は最も明示的な queue-driven serverless モデルだ。

### 構成

- ingress 用の API Gateway または webhook endpoint
- handler と worker のための Lambda functions
- wake-up と retry 用の SQS
- sweep 用の EventBridge Scheduler
- 外部 durable database
- 任意の DLQ と alarm

### Trigger Flow

1. HTTP または webhook ingress が Lambda に到達する
2. handler が `enqueue()` を呼ぶ
3. handler が wake-up message を SQS に送る
4. SQS trigger の Lambda が `processOne()` または `processUntilIdle({ maxRuns })` を呼ぶ
5. EventBridge が定期的に sweep job を実行する
6. 後続 Lambda invocation が未完了 run を reclaim して継続する

### 向いている用途

- 運用上の責務分離を明確にしたいシステム
- retry、queueing、alarm、DLQ の成熟したパターンを活用したい workload
- より高い規模の background execution

### 重要な制約

execution ownership の source of truth は SQS delivery ではない。

lease ownership は常に database 上の run record に帰属する。

## どのモデルを選ぶか

大まかなヒューリスティックは次の通り:

- 個人開発者や小さな新規プロジェクトのデフォルト推奨は `Vercel + Turso`
- Web 中心でより本番寄りの DB 構成を求めるなら `Vercel + PostgreSQL` を強く意識する
- resident worker を許容でき、runtime の単純さを優先するなら `Fly.io + PostgreSQL` を強く意識する
- 長時間稼働プロセスを持てて、最も単純な execution model を望むなら常駐 worker を選ぶ
- ingress-first なプロダクト開発を優先するなら Vercel が向いている
- hosted な同期/非同期分離をシンプルに得たいなら Netlify が候補になる
- queue-driven で edge 寄りの event handling が自然で、platform lock-in を許容できるなら Cloudflare を選ぶ
- queueing と scheduling を含む最も明示的な serverless 運用モデルを望むなら AWS Lambda が適している

別のヒューリスティックとして:

- すでに Cloudflare に強く寄っていて runtime portability が重要でないなら、Durably を選ぶ前に Cloudflare Workflows を評価すべきだろう

## どのプラットフォームでも守るべき設計ルール

次のルールはプラットフォームに関係なく維持する:

- `enqueue()` は durable であり、idempotency を意識する
- `claimNext()` は atomic に動作する
- completion と failure は lease owner に依存する
- 長いタスクはすべて checkpoint 可能な step に分割する
- streaming output は保存済み event から recover できる
- correctness が polling loop、単一マシン、in-memory state に依存しないこと

## Durably が first-class に支えるべき物語

Durably は次の2つのランタイム物語を明示的に first-class support する:

1. 常駐 worker デプロイ
2. `processOne()` を中心とする短命 invocation デプロイ

それ以外は、この2つの形を土台とした platform adapter として文書化するのがよい。
