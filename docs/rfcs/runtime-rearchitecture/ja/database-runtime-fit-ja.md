# 設計: データベースごとのランタイム適合性

## 目標

本ドキュメントでは、各データベースが Durably のランタイムモデルにどの程度適合するかを評価する。

データベースごとの具体的な claim および lease mutation の実装パターンについては `database-claim-patterns-ja.md` を参照のこと。

中心となる問いはひとつ:

そのデータベースは、Durably が求める execution semantics を維持できるか。

ここで問われているのは主に correctness であり、単純な性能比較ではない。

## なぜ重要なのか

Durably は、database を中心に据えた lease ベースの checkpoint 付きランタイムだ。

したがって database は単なる永続化レイヤーではなく、execution authority（実行権限）と resumability（再開可能性）を保持する役割を持つ。

脆いアプリケーション層での場当たり的な回避策に頼らずに必要な semantics を支えられるデータベースだけが、良い適合先となる。

## 必要なストレージセマンティクス

first-class な対応先であるためには、以下の semantics を明確かつ防御可能な形で満たす必要がある。

### 1. ランをアトミックに取得できること

store は次の操作を1つの atomic operation として行えなければならない:

- 取得可能な run を1つ選ぶ
- それを `leased`（実行中）に遷移させる
- `leaseOwner` と `leaseExpiresAt` を設定する
- 複数の worker が競合しても、勝者は1つだけであること

### 2. 現在の所有者だけが run を変更できること

store が run を renew・complete・fail できるのは、次の条件を満たす場合に限られる:

- run がまだ leased 状態にある
- リクエストしている worker がその lease を引き続き所有している

リースが切れた worker が、別の worker に引き継がれた run を renew したり complete したりできてはならない。

### 3. 放棄されたランを安全に回収できること

store は lease expiry 後の回収を通常の取得フローの一部として扱える必要がある。

つまり、以下のような状況の後でも後続 worker が安全に処理を継続できなくてはならない:

- crash
- restart
- timeout
- network loss

### 4. ステップの結果を永続的に保存できること

store は completed step を十分に durable な形で保存し、再実行時に次のことを可能にする必要がある:

- 完了済みの step を検出する
- 以前の output を返す
- 完了済み work の再実行を回避する

### 5. 重複ランをストレージレベルで防止できること

idempotency key をサポートするなら、storage constraint か conflict-aware write によって強制しなければならない。

read-then-insert の race に頼るだけでは不十分だ。

### 6. ログとイベントを効率よく追記できること

store は以下を手軽に append できることが望ましい:

- log
- progress update
- durable な event stream entry

これらすべてに global order が求められるわけではないが、信頼性と query 可能性は確保する必要がある。

### 7. トランザクションの挙動が予測可能であること

store は、取得の競合や条件付き書き込みについて推論できるだけの明確な transaction / isolation behavior を提供しなければならない。

semantics が不透明だったり予想外に弱かったりすると、adapter の正しさを裏付けるのが困難になる。

## 評価軸

設計上、各 database は次の観点で判断するのが適切だ:

- claim correctness
- multi-worker safety
- serverless からの接続適性
- checkpoint / event の write-path cost
- 運用の単純さ
- environment をまたいだ semantics の移植性

## PostgreSQL

PostgreSQL は最も明快な first-class fit と言える。

### 適合する理由

- atomic claim のパターンが広く理解されている
- conditional update や ownership-sensitive completion を素直に書ける
- transaction と row-level locking の semantics が成熟している
- idempotency constraint を自然に表現できる
- イベントやチェックポイントの大量追記に向いている
- multi-worker / multi-process coordination がごく普通の用途として成り立つ

### 最も向いている形

- multi-worker deployment
- 外部 database を使う serverless platform
- より高い write concurrency が求められるシステム
- semantic ambiguity を最小化したいケース

### 主なトレードオフ

embedded SQLite と比べると運用負荷が大きい。

### 結論

PostgreSQL は primary target として位置づけるべきであり、storage semantics の reference model としても最有力候補となる。

### DX に関する注記

PostgreSQL は semantics の基準として最も堅いが、`Vercel + Turso` を最初の体験として想定する場合、個人開発者にとって最良のオンボーディング体験になるとは限らない。

一方、`Vercel + PostgreSQL` や `Fly.io + PostgreSQL` といった本番向けの構成では極めて重要な target だ。

## SQLite

SQLite は single-node もしくは閉じた deployment に強く適合するが、その境界は明示しておくべきだ。

### 適合する理由

- transaction が堅牢で理解しやすい
- atomic claim を実装可能
- checkpoint persistence がシンプル
- embedded / single-machine 用途での local durability に優れる
- operational overhead が小さい

### 特に向いている場面

- local development
- single-tenant deployment
- desktop や edge 近傍のアプリケーション
- single-machine worker

### 主な制約

- write concurrency は PostgreSQL に比べて限定的
- multi-writer scaling は自然な形とは言いがたい
- machine をまたぐ distributed ownership は想定されていない
- file を replication や proxy 層の背後に配置する deployment では、実質的な semantics が変わるおそれがある

### 結論

SQLite は local および single-node execution の first-class target であり続けるべきだが、あらゆる deployment のメンタルモデルとして用いるべきではない。

## libSQL

libSQL は、SQLite の開発体験を保ちつつ remote deployment を可能にする点で有望だ。

### 適合しうる理由

- 馴染みのある SQLite 互換モデル
- file-based SQLite より serverless からの接続が容易
- hosted access を伴う SQLite ergonomics を求めるプロダクトに向いている

### 注意が必要な理由

- Durably が依存するのは SQL syntax compatibility よりも lease claim semantics のほう
- 表面的な互換性より、remote / replicated 環境での execution characteristics が重要になる
- write serialization、visibility、failure recovery に関する正確な保証は adapter-level test で検証しなければならない

### 最も向いている形

- SQLite 風の開発体験を求めるプロダクト
- serverless 環境で外部 DB を必要とする deployment
- semantic validation が完了している中程度の workload
- `Vercel + Turso` や `Cloudflare Workers + Turso` のような摩擦の少ない導入経路

### 結論

libSQL は plausible target ではあるものの、local SQLite と同等と見なすべきではない。adapter test と運用実績で裏付けが取れるまでは「注意付きで support する」カテゴリに位置づけるのが妥当だ。

### DX に関する注記

セマンティクス上の注意点はあるものの、libSQL は SQLite に近いメンタルモデルを維持できるため、個人開発者向けの serverless-friendly な入口としてはかなり有力な選択肢となる。

## Cloudflare D1

D1 は platform-specific target として有用な可能性があるが、慎重なアプローチが求められる。

### 魅力がある理由

- Cloudflare hosted application と自然に噛み合う
- Worker ベースのシステムでは deployment story がシンプル
- SQLite 風のモデルを備えている

### リスクがある理由

- Durably は claim exclusivity と ownership-sensitive update に高い確信を必要とする
- platform-specific な database behavior は、一般的な PostgreSQL semantics より論じにくい場合がある
- runtime model が contention、retry、reclaim 下での予測可能な振る舞いに依存している

### 最も向いている形

- Cloudflare 固有のアプリケーション
- 低〜中程度の contention workload
- D1 固有の制約を許容でき、十分なテストが行えるケース

### 結論

D1 は universal reference model というよりも platform adapter target として扱うのが適切だ。成立しうる可能性はあるが、primary ではなく caveated category からのスタートが望ましい。

## 何が Syntax Compatibility より重要か

2つの database が似た SQL syntax を備えていても、Durably にとっては意味のある違いが生じうる。

重要なのは以下ではない:

- SQLite syntax を話せるかどうか
- JSON column を扱えるかどうか
- `returning` に対応しているかどうか

重要なのはこちらだ:

- ランの取得を真に exclusive にできるか
- 期限切れの worker を確実に reject できるか
- リース期限と回収を明快に推論できるか
- checkpoint と event を fragile な coordination なしに頻繁に書き込めるか

Durably が最適化すべきは superficial な API similarity ではなく、セマンティクスのポータビリティのほうだ。

## 推奨される Support Tier

出発点としては、以下の tiering が妥当と考えられる。

### Primary Targets

- PostgreSQL
- SQLite

この2つが最も明快なセマンティクスの基準となる:

- PostgreSQL — distributed / serverless-connected deployment の基準
- SQLite — embedded / single-node deployment の基準

### Caveat 付きの Plausible Targets

- libSQL
- Cloudflare D1

adapter test によって claim・renew・complete・reclaim の semantics が防御可能だと示された場合にのみ support すべきだ。

### First-Class Promise にすべきでないもの

transaction や conditional write の振る舞いを Durably の lease semantics に明確に写像できない database は、基本的な persistence が動作するとしても first-class として提示すべきではない。

## Adapter 設計への含意

Durably は database support を「SQL が使えればどこでも動く」という形で提示すべきではない。

各 adapter は、以下を守れるかどうかで評価する:

- atomic claim
- lease owner に依存した mutation
- durable checkpoint
- reliable な idempotency
- predictable な reclaim

これこそが本当の compatibility contract だ。
