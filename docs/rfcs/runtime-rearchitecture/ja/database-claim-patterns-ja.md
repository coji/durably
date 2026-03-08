# 設計: データベースごとの Claim 実装パターン

## 目標

本ドキュメントは、異なる database adapter における lease claim と、その周辺 mutation の具体的な実装パターンをまとめたものである。

PostgreSQL と SQLite のより具体的な query sketch については `database-adapter-sketches-ja.md` を参照されたい。

Durably を各 backend ごとに1つの固定 SQL 文へ縛ることが目的ではない。

明確にしたいのは以下の3点である:

- どのような query shape が必要か
- adapter が守るべき性質は何か
- どのようなパターンが弱すぎる、あるいは race に脆いか

## スコープ

主な対象は次の4つの storage operation に絞る:

- `claimNext()`
- `renewLease()`
- `completeRun()` / `failRun()`
- idempotent な `enqueue()`

checkpoint や event の persistence も重要ではあるが、adapter 実装で最もリスクが高いのは通常 claim と lease ownership まわりになる。

## 共通ルール

adapter は次の invariant を守らなければならない:

同じ時点で、ある run に対する active execution authority を獲得または延長できる worker は高々1つだけとする。

これが意味するところは次の通りである:

- claim は exclusive でなければならない
- renew は current ownership を条件としなければならない
- complete と fail も current ownership を条件としなければならない
- reclaim は通常の claim behavior の一部として組み込む

## 避けるべきパターン

次のようなパターンは、それ単体では不十分となる:

- pending row を select し、その後で別の無防備な write で update する
- ownership を application memory に読み込んで、後で再確認せずに complete する
- worker 間の in-memory lock に依存する
- queue delivery を ownership の証拠として扱う
- contention が低いから race condition を無視してよいと考える

adapter は、実際の race が起きても correctness を守れなければならない。

## PostgreSQL のパターン

PostgreSQL は最も明快な reference model となる。

### `claimNext()`

望ましい形は次の通りである:

1. transaction 内で claim 可能な run を1つ見つける
2. candidate row を lock する
3. 同じ row を `leased` に update する
4. claim した row を返す

実際には、単一 transaction 内で次の3ステップ構成を取る:

1. `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` で candidate を1件ロック
2. candidate が `concurrency_key` を持つ場合、`pg_advisory_xact_lock(hashtext(concurrency_key))` を取得し、同キーの active lease が存在しないことを再検証する（advisory lock がキー単位で直列化し、再検証は READ COMMITTED の新しいスナップショットで行われる）
3. ロック済みの row を `leased` に `UPDATE` する

これがうまく機能する理由:

- `FOR UPDATE SKIP LOCKED` が単一 row の排他をノンブロッキングに実現する
- advisory lock が concurrency key グループを直列化しつつ、無関係な claim はブロックしない
- ステップ 2 の READ COMMITTED スナップショット更新により、他トランザクションの commit 済み状態を正しく参照できる

#### なぜ concurrency key に advisory lock が必要なのか

`FOR UPDATE SKIP LOCKED` 単体では concurrency key の安全性を保証できない。

2つの worker が同じ `concurrency_key` を持つ別々の row を同時に select した場合、各自が自分の row をロックする。active lease の `NOT EXISTS` ガードはトランザクションの元のスナップショットに対して走る（READ COMMITTED は各ステートメント開始時にスナップショットを取るが、`FOR UPDATE` の再チェック後に別の行へのスキャンでは更新されない）。そのため、両方の worker がガードを通過し、同じキーの run を claim してしまう。

`pg_advisory_xact_lock` をキーのハッシュに対してかけることで、2番目の worker は1番目が commit するまで待たされる。後続の `SELECT 1 ... WHERE status = 'leased'` は新しいステートメントとして新鮮なスナップショットで実行され、1番目の worker が commit した lease を正しく検出できる。

### `renewLease()`

次のような guarded update を用いる:

- `WHERE id = ?`
- `AND status = 'leased'`
- `AND lease_owner = ?`
- 必要に応じて `AND lease_expires_at >= now`

renew が成功とみなされるのは、ちょうど1 row が更新された場合に限る。

### `completeRun()` / `failRun()`

同じ guarded-update shape を用いる:

- `id` で match
- `status = 'leased'` を要求
- `lease_owner = workerId` を要求

更新件数が 0 であれば、その worker は authority を失っている。completion は reject されたものとして扱う必要がある。

### Idempotent な `enqueue()`

`idempotency_key` がある場合は `(job_name, idempotency_key)` に unique constraint を置き、conflict-aware insert を使う。

### なぜ PostgreSQL が Reference なのか

semantics が十分に明示的であり、adapter の correctness を非公式な timing assumption ではなく、transaction と row lock の観点から論証できるためである。

## SQLite のパターン

SQLite でも必要な semantics は保てるが、concurrency model が異なるため形は変わってくる。

### `claimNext()`

望ましい形は次の通りである:

1. write transaction を開始する
2. claim 可能な run を1つ select する
3. 同じ transaction 内でその row を `leased` に update する
4. commit する

SQLite では writer の直列化がより強力なため、correctness は row-level lock よりも transaction による write exclusion から得られる部分が大きい。

single-node かつ限定的な deployment であれば、この方式で十分に機能する。

### `renewLease()`

次を条件とした guarded update を用いる:

- `id`
- `status = 'leased'`
- `lease_owner = workerId`

成功判定は「更新件数が 1 であること」とする。

### `completeRun()` / `failRun()`

同じ ownership-sensitive な guarded update pattern を用いる。

### Idempotent な `enqueue()`

read-then-insert race ではなく、unique index と conflict-aware insert を組み合わせて使う。

### 主な注意点

SQLite は scale より correctness の方が説明しやすい。

adapter として成立はするが、single-machine あるいは write 環境を強く制御できる deployment において最も力を発揮すると位置付けるのが適切である。

## libSQL のパターン

libSQL は SQLite の query shape を起点とすべきだが、実運用上は同一視してはならない。

### `claimNext()`

意図するパターンは変わらない:

1. transaction を開始する
2. claim 可能な run を1つ select する
3. 同じ transaction 内でその run を update する
4. commit する

### 検証すべきこと

adapter は次の点を検証する必要がある:

- remote worker 間での transactional visibility
- write serialization behavior
- 選択した transport と deployment mode が、adapter の想定する claim guarantee を維持できるかどうか

### `renewLease()` と Completion

SQLite / PostgreSQL と同様、guarded update のままでよい:

- run id に一致させる
- leased status を要求する
- current owner を要求する

### 主な注意点

表面的な互換性だけでは不十分である。

concurrency behavior が local SQLite の前提から意味のある形でずれる場合、adapter はその差異を文書化し、support 境界もより厳格に設定すべきである。

## Cloudflare D1 のパターン

D1 は「クラウド上の SQLite」ではなく、platform-shaped adapter として扱う。

### `claimNext()`

望ましい論理形は変わらない:

1. transaction 的に claim 可能な run を1つ特定する
2. 条件付きでそれを leased に mutate する
3. 勝者だけが成功を返す

### 検証すべきこと

adapter は、contention 下のテストを通じて次を示さなければならない:

- 2つの worker が同じ run を claim できたと誤認しないこと
- expiry 後の reclaim が予測可能に動作すること
- conditional completion が stale worker を確実に reject すること

### `renewLease()` と Completion

次に基づく厳密な conditional write を用いる:

- run id
- leased status
- lease owner

### 主な注意点

backend の transaction behavior を理詰めで説明しにくい場合、adapter の信頼性は local SQLite からの類推ではなく、狙いを絞った concurrency test によって裏付けるべきである。

## 代替的な Claim Shape

backend によっては、明示的な select-then-update transaction よりも、単一の conditional `UPDATE ... WHERE id = (subquery)` 形式の方が自然な場合がある。

同じ semantics を保てるのであれば、その形式でも問題ない:

- race 下で勝者が1つだけであること
- stale ownership extension が起きないこと
- expiry 後の reclaim が予測可能であること

SQL の正確な shape は backend ごとに異なってよい。ただし semantic contract は変えてはならない。

ただし、Phase 1 の探索で次の限界も明らかになっている:

- この汎用形式が PostgreSQL 上で安全だとは仮定してはならない
- concurrency key の直列化には backend 固有の機構（例: advisory lock）が必要になる場合がある

contention 下で排他性を守れない backend は、backend 固有の claim path を必要とする。

## Reclaim Semantics

database に関わらず、`claimNext()` は次の run を claim 可能として扱うべきである:

- `pending`
- `leased` かつ `leaseExpiresAt < now`

つまり reclaim は repair path ではなく、通常の claim logic の一部として位置付けられる。

query shape が「まず recover し、その後で別途 claim する」という workflow を前提としてはならない。

## Started Time のルール

claim 実装は `startedAt` を正しく保存する必要がある:

- 初回 claim で設定する
- 後続の reclaim では既存の値を維持する

細部ではあるが、run history と運用上の可視性にとって重要な点である。

## 推奨される Adapter Test Case

すべての database adapter は、少なくとも以下のケースをテストすべきである:

- 2 worker が同じ run を claim しようとしても勝者は1つだけになる
- ある worker が別 worker の lease を renew できない
- stale worker が reclaim 済み run を complete できない
- 期限切れの leased run を reclaim できる
- idempotent enqueue で run がちょうど1つだけ作られる
- reclaim しても元の `startedAt` が保たれる

2つの adapter が似た SQL syntax を使うかどうかより、これらのテストを通過することの方がはるかに重要である。

## 実践的な指針

Durably は PostgreSQL を semantic reference point として扱う。

そのうえで:

- SQLite は、異なる locking model を用いつつ同じ振る舞いの contract に写像する
- libSQL は同等と仮定せず、その振る舞いの contract に対して個別に検証する
- D1 は platform-specific adapter として contention 下で検証する

こうすることで、portability に関する説明が誠実なものになる。
