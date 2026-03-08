# データベース adapter の SQL スケッチ

## 目的

このドキュメントでは、最も重要な2つのデータベースターゲットについて具体的な adapter スケッチを示します。

- PostgreSQL
- SQLite

これらは最終的なマイグレーションや本番用クエリビルダではありません。意図するセマンティクスを十分に具体化し、実装時の未知数を減らすことが目的です。

## 対象

主に扱う操作は以下です。

- `enqueue()`
- `claimNext()`
- `renewLease()`
- `completeRun()` / `failRun()`

例では概念的に以下のような `runs` テーブルを前提とします。

```sql
id
job_name
status
idempotency_key
concurrency_key
lease_owner
lease_expires_at
started_at
completed_at
created_at
updated_at
input
output
error
```

正確なスキーマは実装によって異なっても構いません。重要なのは guarded mutation の形状を共有することです。

## 共通前提

adapter スケッチでは以下を前提としています。

- `status` は `pending`, `leased`, `completed`, `failed`, `cancelled` のいずれか
- reclaim 可能な run は `pending`、または期限切れの `leased`
- `started_at` は最初の claim 成功時にのみ設定する
- `completed_at` は完了または失敗の際に設定する
- `updated_at` はすべての mutation で更新する

## PostgreSQL のスケッチ

PostgreSQL がセマンティクスの基準モデルです。

### 冪等な `enqueue()`

`idempotency_key` が存在する場合にのみ適用される unique index を使います。

```sql
CREATE UNIQUE INDEX runs_job_idempotency_key_unique
ON runs (job_name, idempotency_key)
WHERE idempotency_key IS NOT NULL;
```

insert は conflict handling 付きで行います。

```sql
INSERT INTO runs (
  id,
  job_name,
  input,
  status,
  idempotency_key,
  concurrency_key,
  created_at,
  updated_at
)
VALUES (
  $1, $2, $3, 'pending', $4, $5, $6, $6
)
ON CONFLICT (job_name, idempotency_key)
WHERE idempotency_key IS NOT NULL
DO NOTHING;
```

その後の処理は以下の通りです。

- insert が成功した場合は新しい行を返す
- insert がスキップされた場合は既存行を fetch して返す

### `claimNext()`

トランザクションと `FOR UPDATE SKIP LOCKED` を組み合わせた形が望ましいです。

```sql
BEGIN;

WITH candidate AS (
  SELECT id
  FROM runs
  WHERE
    (
      status = 'pending'
      OR (status = 'leased' AND lease_expires_at < $1)
    )
    AND (
      concurrency_key IS NULL
      OR concurrency_key <> ALL($2)
    )
  ORDER BY created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE runs
SET
  status = 'leased',
  lease_owner = $3,
  lease_expires_at = $4,
  started_at = COALESCE(started_at, $1),
  updated_at = $1
WHERE id = (SELECT id FROM candidate)
RETURNING *;

COMMIT;
```

この形がもたらす性質は以下の通りです。

- 高々1つのワーカーだけが候補行をロック・更新できる
- 期限切れの leased run も同じパスで reclaim される
- reclaim 時でも `started_at` は保持される

### `renewLease()`

guarded update を使います。

```sql
UPDATE runs
SET
  lease_expires_at = $3,
  updated_at = $2
WHERE
  id = $1
  AND status = 'leased'
  AND lease_owner = $4
  AND lease_expires_at >= $2;
```

結果の解釈は以下の通りです。

- 更新件数 = 1 なら成功
- 更新件数 = 0 なら、そのワーカーはすでにリース所有者ではない

### `completeRun()`

```sql
UPDATE runs
SET
  status = 'completed',
  output = $3,
  error = NULL,
  completed_at = $4,
  lease_owner = NULL,
  lease_expires_at = NULL,
  updated_at = $4
WHERE
  id = $1
  AND status = 'leased'
  AND lease_owner = $2;
```

### `failRun()`

```sql
UPDATE runs
SET
  status = 'failed',
  output = NULL,
  error = $3,
  completed_at = $4,
  lease_owner = NULL,
  lease_expires_at = NULL,
  updated_at = $4
WHERE
  id = $1
  AND status = 'leased'
  AND lease_owner = $2;
```

### 有用なインデックス

典型的なサポートインデックスは以下です。

```sql
CREATE INDEX runs_claim_idx
ON runs (status, lease_expires_at, created_at);

CREATE INDEX runs_concurrency_key_idx
ON runs (concurrency_key)
WHERE concurrency_key IS NOT NULL;
```

## SQLite のスケッチ

SQLite では同時実行の形状が異なりますが、同じ振る舞い契約を維持する必要があります。

### 冪等な `enqueue()`

unique index を使います。

```sql
CREATE UNIQUE INDEX runs_job_idempotency_key_unique
ON runs (job_name, idempotency_key)
WHERE idempotency_key IS NOT NULL;
```

insert は conflict handling 付きで行います。

```sql
INSERT INTO runs (
  id,
  job_name,
  input,
  status,
  idempotency_key,
  concurrency_key,
  created_at,
  updated_at
)
VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
ON CONFLICT(job_name, idempotency_key) DO NOTHING;
```

その後の処理は以下の通りです。

- changes count が 1 なら新しい行を返す
- それ以外なら既存行を fetch する

### `claimNext()`

SQLite では write トランザクションを使います。

```sql
BEGIN IMMEDIATE;

SELECT id
FROM runs
WHERE
  (
    status = 'pending'
    OR (status = 'leased' AND lease_expires_at < ?)
  )
  AND (
    concurrency_key IS NULL
    OR concurrency_key NOT IN (?, ?, ?)
  )
ORDER BY created_at ASC
LIMIT 1;
```

続けて、同じトランザクション内で以下を実行します。

```sql
UPDATE runs
SET
  status = 'leased',
  lease_owner = ?,
  lease_expires_at = ?,
  started_at = COALESCE(started_at, ?),
  updated_at = ?
WHERE id = ?;

COMMIT;
```

この形の意味は以下の通りです。

- `BEGIN IMMEDIATE` により、早い段階で write-intent を確保する
- 書き込み直列化が、2つのライターが同じ mutation パスを同時に通ることを防ぐ
- 正しさは行ロックではなくトランザクションに依存する

### 候補 UPDATE への追加ガード

adapter がさらに防御的にしたい場合は、UPDATE 側にも適格条件を繰り返せます。

```sql
UPDATE runs
SET
  status = 'leased',
  lease_owner = ?,
  lease_expires_at = ?,
  started_at = COALESCE(started_at, ?),
  updated_at = ?
WHERE
  id = ?
  AND (
    status = 'pending'
    OR (status = 'leased' AND lease_expires_at < ?)
  );
```

これはトランザクションの代替にはなりませんが、mutation 自体をより自己防衛的にする効果があります。

### `renewLease()`

```sql
UPDATE runs
SET
  lease_expires_at = ?,
  updated_at = ?
WHERE
  id = ?
  AND status = 'leased'
  AND lease_owner = ?
  AND lease_expires_at >= ?;
```

成功は `changes() = 1` で判定します。

### `completeRun()`

```sql
UPDATE runs
SET
  status = 'completed',
  output = ?,
  error = NULL,
  completed_at = ?,
  lease_owner = NULL,
  lease_expires_at = NULL,
  updated_at = ?
WHERE
  id = ?
  AND status = 'leased'
  AND lease_owner = ?;
```

### `failRun()`

```sql
UPDATE runs
SET
  status = 'failed',
  output = NULL,
  error = ?,
  completed_at = ?,
  lease_owner = NULL,
  lease_expires_at = NULL,
  updated_at = ?
WHERE
  id = ?
  AND status = 'leased'
  AND lease_owner = ?;
```

### 実践上のメモ

SQLite adapter では、巧妙さよりも正しさを優先したいです。複雑で推論しにくいパターンを採るより、トランザクションによる直列化でシンプルに claim パスを構成する方が望ましいです。

## concurrency key に関する注記

上記のスケッチでは `excludeConcurrencyKeys` を概念的に示していますが、実装の詳細は変わりえます。

重要なセマンティクスルールはひとつだけです。ランタイムが除外したい有効な run の `concurrency_key` と衝突する run は claim してはなりません。

そのロジックをインラインで表現しにくい場合は、以下の2段階に分けても構いません。

- 有効な concurrency key を取得するクエリ
- それらを除外する guarded claim クエリ

ただし、最終的な claim が正しさを保つことが前提です。

## ステップ / イベント書き込み

このスケッチは claim とリース処理に焦点を当てていますが、チェックポイントとイベントの永続化にも同じ規律が求められます。

- 追記書き込みは永続的でなければならない
- read-after-write の可視性は予測可能でなければならない
- ステップの完了はクラッシュ・reclaim 後も安全に再読できなければならない

## 次のステップ

次に作成する実装寄りのドキュメントでは、おそらく以下を定義することになります。

- 新しいランタイムにおける `runs` テーブルの正確なスキーマ
- 必須インデックス
- すべてのバックエンドが通過すべき adapter テストフィクスチャ

ここまで進めば、このスケッチはより直接的な実装計画へと変わります。
