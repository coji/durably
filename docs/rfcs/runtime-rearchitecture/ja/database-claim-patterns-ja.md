# データベースごとの Claim 実装パターン

## 目的

このドキュメントでは、各データベース adapter におけるリース claim と関連する mutation の具体的な実装パターンを整理します。

PostgreSQL と SQLite のより具体的な SQL スケッチは `database-adapter-sketches-ja.md` を参照してください。

Durably を各バックエンドごとに1つの固定 SQL 文に縛ることが目的ではありません。明確にしたいのは以下の3点です。

- どのような query 形状が必要か
- adapter が守るべき性質は何か
- どのようなパターンが弱すぎる、あるいは競合に脆いか

## 対象

主な対象は以下の4つの操作です。

- `claimNext()`
- `renewLease()`
- `completeRun()` / `failRun()`
- 冪等な `enqueue()`

チェックポイントやイベントの永続化も重要ですが、adapter 実装で最もリスクが高いのは claim とリース所有権まわりです。

このドキュメントは adapter 実装者向けです。アプリケーションコードに公開されるランタイム契約ではなく、内部の構成要素を扱います。ランタイムレベルでのポータビリティ対象は `processOne()` とそれを取り巻くリースセマンティクスです。`claimNext()` はそれを実装するための adapter 内部の構成要素であり、バックエンドごとに形状が異なることがあります。

## 共通ルール

adapter は以下の不変条件を守らなければなりません。

**同じ時点で、ある run に対する実行権限を取得または延長できるワーカーは高々1つだけである。**

これは以下を意味します。

- claim は排他的でなければならない
- renew は現在の所有権を条件としなければならない
- complete と fail も現在の所有権を条件としなければならない
- reclaim は通常の claim 動作の一部として組み込む

## 避けるべきパターン

以下のパターンは、それ単体では不十分です。

- pending な行を select し、その後で別のガードなし write で update する
- 所有権をアプリケーションメモリに読み込んで、後で再確認せずに complete する
- ワーカー間のインメモリロックに依存する
- キューからの配信を所有権の証拠として扱う
- 競合が少ないから競合状態を無視してよいと考える

adapter は、実際の競合が発生しても正しさを守れなければなりません。

## PostgreSQL のパターン

PostgreSQL は最も明快な基準モデルです。

### `claimNext()`

望ましい形は以下の通りです。

1. トランザクション内で claim 可能な run を1件見つける
2. 候補の行をロックする
3. 同じ行を `leased` に更新する
4. claim した行を返す

実際には、単一トランザクション内で以下の3ステップ構成を取ります。

1. `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` で候補を1件ロック
2. 候補が `concurrency_key` を持つ場合、`pg_advisory_xact_lock(hashtext(concurrency_key))` を取得し、同じキーの有効なリースが存在しないことを再検証する（advisory lock がキー単位で直列化し、再検証は READ COMMITTED の新しいスナップショットで行われる）
3. ロック済みの行を `leased` に `UPDATE` する

ステップ2で競合が見つかった場合は、そのキーを除外して次の候補を探すループを回します。候補がなくなるまで繰り返すことで、無関係な pending ワークを見逃しません。

これがうまく機能する理由:

- `FOR UPDATE SKIP LOCKED` が単一行の排他をノンブロッキングに実現する
- advisory lock が concurrency key グループを直列化しつつ、無関係な claim はブロックしない
- ステップ2の READ COMMITTED スナップショット更新により、他トランザクションの commit 済み状態を正しく参照できる

#### なぜ concurrency key に advisory lock が必要なのか

`FOR UPDATE SKIP LOCKED` 単体では concurrency key の安全性を保証できません。

2つのワーカーが同じ `concurrency_key` を持つ別々の行を同時に select した場合、各自が自分の行をロックします。有効なリースの `NOT EXISTS` ガードはトランザクションの元のスナップショットに対して走ります（READ COMMITTED は各ステートメント開始時にスナップショットを取りますが、`FOR UPDATE` の再チェック後に別の行へのスキャンでは更新されません）。そのため、両方のワーカーがガードを通過し、同じキーの run を claim してしまいます。

`pg_advisory_xact_lock` をキーのハッシュに対してかけることで、2番目のワーカーは1番目が commit するまで待たされます。後続の `SELECT 1 ... WHERE status = 'leased'` は新しいステートメントとして新鮮なスナップショットで実行され、1番目のワーカーが commit したリースを正しく検出できます。

#### Phase 1 の知見

これは単なるスタイルの好みではありません。

Phase 1 の adapter 探索中に、PostgreSQL を SQLite 向けの汎用的な conditional update パスで動かしたところ、二重 claim が再現しました。

これが意味すること:

- PostgreSQL には専用の claim 戦略が必要
- 「汎用 SQL claim」をファーストクラスのポータビリティ目標として扱うべきではない
- PostgreSQL の正しさは、非公式なタイミング仮定ではなく、行ロックのセマンティクスから論証すべき

Phase 1 ではもう1つの境界も明らかになりました:

- ランタイムレベルの `processOne()` セマンティクスが健全であっても、生の `QueueStore.claimNext()` プリミティブがポータビリティ対象としては弱すぎる場合がある

これは意図されたレイヤリングを補強します:

- `processOne()` がコアのランタイム契約
- `claimNext()` はそれを実装するための adapter 内部機構

Phase 1 ではさらに、`claimNext()` レベルでの concurrency key 競合も解消しました:

- 別々の PostgreSQL クライアントからの直接 claim テストが、advisory lock による直列化で通るようになった
- concurrency key の競合が検出された場合、同一トランザクション内で除外リトライを行い、無関係な pending ワークを取りこぼさない

### `renewLease()`

以下の形式の guarded update を使います。

- `WHERE id = ?`
- `AND status = 'leased'`
- `AND lease_owner = ?`
- 必要に応じて `AND lease_expires_at >= now`

更新件数がちょうど1件の場合だけ成功とみなします。

### `completeRun()` / `failRun()`

同じ guarded update の形式を使います。

- `id` で一致
- `status = 'leased'` を要求
- `lease_owner = workerId` を要求

更新件数が0なら、そのワーカーは実行権限を失っています。完了は拒否されたものとして扱います。

### 冪等な `enqueue()`

`idempotency_key` がある場合は `(job_name, idempotency_key)` に unique 制約を置き、conflict-aware insert を使います。

### なぜ PostgreSQL が基準なのか

セマンティクスが十分に明示的で、adapter の正しさを非公式なタイミング仮定ではなく、トランザクションと行ロックの観点から論証できるからです。

## SQLite のパターン

SQLite でも必要なセマンティクスは保てますが、同時実行モデルが異なるため形状は変わります。

### `claimNext()`

望ましい形は以下の通りです。

1. write transaction を開始する
2. claim 可能な run を1件 select する
3. 同じトランザクション内でその行を `leased` に update する
4. commit する

SQLite ではライターの直列化がデータベースレベルで強制されるため、正しさは行ロックよりもトランザクションによる書き込み排他から得られます。

シングルノードまたは書き込み環境を強く制御できるデプロイであれば、この方式で十分に機能します。

### `renewLease()`

以下を条件とした guarded update を使います。

- `id`
- `status = 'leased'`
- `lease_owner = workerId`

成功判定は「更新件数が1であること」です。

### `completeRun()` / `failRun()`

同じ所有権チェック付きの guarded update パターンを使います。

### 冪等な `enqueue()`

read-then-insert の競合ではなく、unique index と conflict-aware insert を組み合わせます。

### 注意点

SQLite はスケーラビリティよりも正しさの説明がしやすいデータベースです。

adapter として成立しますが、シングルマシンまたは書き込み環境を強く制御できるデプロイで最も力を発揮すると位置づけるのが適切です。

#### Phase 1 の知見

ローカル SQLite は、PostgreSQL や libSQL と同じセマンティクスおよびストレステストに通りました。

これは現在の立場を支持しています:

- SQLite は強いセマンティクス対象になりうる
- ただし、普遍的な同時実行モデルではなく、シングルノードのセマンティクスアンカーとして提示すべき

## libSQL のパターン

libSQL は SQLite の query 形状を起点にすべきですが、実運用上は同一視してはなりません。

### `claimNext()`

意図するパターンは同じです。

1. トランザクションを開始する
2. claim 可能な run を1件 select する
3. 同じトランザクション内でその run を update する
4. commit する

### 検証すべきこと

adapter は以下を検証する必要があります。

- リモートワーカー間でのトランザクション可視性
- 書き込み直列化の挙動
- 選択したトランスポートとデプロイモードが、adapter の前提とする claim 保証を維持できるか

### `renewLease()` と完了

SQLite / PostgreSQL と同じ guarded update です。

- run id で一致
- leased status を要求
- 現在の所有者を要求

### 注意点

表面的な互換性だけでは不十分です。

同時実行の挙動がローカル SQLite の前提から大きくずれる場合、adapter はその差異を文書化し、サポート境界をより厳格に設定すべきです。

#### Phase 1 の知見

libSQL は Phase 1 のノード側セマンティクスおよびストレステストに通りました。

これは心強いシグナルですが、解釈としては:

- 「現在の adapter テストで障害が再現しなかった」

であり:

- 「すべての claim・reclaim 条件下で PostgreSQL と同等であることが証明された」

ではありません。

## Cloudflare D1 のパターン

D1 は「クラウド上の SQLite」ではなく、プラットフォーム固有の adapter として扱います。

### `claimNext()`

望ましい論理形は同じです。

1. トランザクション的に claim 可能な run を1件特定する
2. 条件付きでそれを leased に変更する
3. 勝者だけが成功を返す

### 検証すべきこと

adapter は、競合状態のテストを通じて以下を示す必要があります。

- 2つのワーカーが同じ run を claim できたと誤認しないこと
- 期限切れ後の reclaim が予測可能に動作すること
- conditional completion が失効したワーカーを確実に拒否すること

### `renewLease()` と完了

以下に基づく厳密な conditional write を使います。

- run id
- leased status
- lease owner

### 注意点

バックエンドのトランザクション挙動を論理的に説明しにくい場合、adapter の信頼性はローカル SQLite からの類推ではなく、狙いを絞った同時実行テストで裏付けるべきです。

## 代替的な Claim 形状

バックエンドによっては、明示的な select-then-update トランザクションよりも、単一の conditional `UPDATE ... WHERE id = (subquery)` 形式のほうが自然な場合があります。

同じセマンティクスを保てるのであれば、その形式でも問題ありません。

- 競合下で勝者が1つだけであること
- 失効した所有権の延長が起きないこと
- 期限切れ後の reclaim が予測可能であること

SQL の正確な形状はバックエンドごとに異なってよいですが、セマンティクスの契約は変えてはなりません。

ただし、Phase 1 の探索で以下の限界も明らかになっています。

- この汎用形式が PostgreSQL 上で安全だとは仮定してはならない
- concurrency key の直列化にはバックエンド固有の機構（例: advisory lock）が必要になる場合がある

競合状態で排他性を守れないバックエンドは、専用の claim パスを必要とします。

## Reclaim のセマンティクス

データベースに関わらず、`claimNext()` は以下の run を claim 可能として扱います。

- `pending`
- `leased` かつ `leaseExpiresAt < now`

つまり reclaim は修復パスではなく、通常の claim ロジックの一部です。

query 形状が「まず回復し、その後で別途 claim する」というワークフローを前提としてはなりません。

## started_at のルール

claim 実装は `started_at` を正しく保持する必要があります。

- 初回 claim で設定する
- 後続の reclaim では既存の値を維持する

細部ですが、run の履歴と運用上の可視性にとって重要な点です。

## 推奨される adapter テストケース

すべてのデータベース adapter は、少なくとも以下のケースをテストすべきです。

- 2つのワーカーが同じ run を claim しようとしても勝者は1つだけになる
- あるワーカーが別のワーカーのリースを更新できない
- 失効したワーカーが reclaim 済みの run を complete できない
- 期限切れの leased run を reclaim できる
- 冪等 enqueue で run がちょうど1件だけ作られる
- reclaim しても元の `started_at` が保たれる

2つの adapter が似た SQL 構文を使うかどうかよりも、これらのテストを通過することのほうがはるかに重要です。

## 実践的な指針

Durably は PostgreSQL をセマンティクスの基準点として扱います。

そのうえで:

- SQLite は、異なるロックモデルを使いつつ同じ振る舞い契約に写像する
- libSQL は同等と仮定せず、振る舞い契約に対して個別に検証する
- D1 はプラットフォーム固有の adapter として、競合状態のテストで検証する

こうすることで、ポータビリティに関する説明が誠実なものになります。
