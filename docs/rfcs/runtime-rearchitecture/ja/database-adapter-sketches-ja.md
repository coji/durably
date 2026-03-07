# 設計: データベースアダプタのスケッチ

## 目標

本ドキュメントでは、最も重要な 2 つの database target について具体的な adapter sketch を示す。

- PostgreSQL
- SQLite

これらは最終的な migration や本番用 query builder ではない。意図する semantics を十分に具体化し、実装作業における未知数を減らすことが目的となる。

## スコープ

主に扱う操作は以下のとおり。

- `enqueue()`
- `claimNext()`
- `renewLease()`
- `completeRun()` / `failRun()`

例では、概念的に次のような `runs` table を前提とする。

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

正確な schema は実装によって異なってよい。重要なのは guarded mutation の形状を共有することにある。

## 共通前提

adapter sketch では以下を前提としている。

- `status` は `pending`, `leased`, `completed`, `failed`, `cancelled` のいずれか
- reclaim 可能な run は `pending`、または期限切れの `leased`
- `started_at` は最初の claim 成功時にのみ設定する
- `completed_at` は completion または failure の際に設定する
- `updated_at` はすべての mutation で更新する

## PostgreSQL のスケッチ

PostgreSQL がセマンティクスの reference model となる。

### Idempotent な `enqueue()`

`idempotency_key` が存在する場合にのみ適用される unique index を使う。

```sql
CREATE UNIQUE INDEX runs_job_idempotency_key_unique
ON runs (job_name, idempotency_key)
WHERE idempotency_key IS NOT NULL;
```

insert は conflict handling 付きで行う。

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

その後の処理は次のとおり。

- insert が成功した場合は、新しい row を返す
- insert が skip された場合は、既存 row を fetch して返す

### `claimNext()`

望ましい形は、transaction と `FOR UPDATE SKIP LOCKED` を組み合わせたものになる。

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

この形がもたらす性質は以下のとおり。

- 高々 1 つの worker だけが candidate row を lock・update できる
- 期限切れの leased run も同じ path で reclaim される
- reclaim 時でも `started_at` は保持される

### `renewLease()`

guarded update を使う。

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

結果の解釈は次のとおり。

- 更新件数が `= 1` なら成功
- 更新件数が `= 0` なら、その worker はすでに lease owner ではない

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

### 任意だが有用な Index

典型的な supporting index を以下に示す。

```sql
CREATE INDEX runs_claim_idx
ON runs (status, lease_expires_at, created_at);

CREATE INDEX runs_concurrency_key_idx
ON runs (concurrency_key)
WHERE concurrency_key IS NOT NULL;
```

## SQLite のスケッチ

SQLite では concurrency shape が異なるが、同じ振る舞いの contract を維持する必要がある。

### Idempotent な `enqueue()`

unique index を使う。

```sql
CREATE UNIQUE INDEX runs_job_idempotency_key_unique
ON runs (job_name, idempotency_key)
WHERE idempotency_key IS NOT NULL;
```

insert は conflict handling 付きで行う。

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

その後の処理は次のとおり。

- changes count が `1` なら新しい row を返す
- それ以外なら既存 row を fetch する

### `claimNext()`

SQLite では write transaction を使う。

有力な形のひとつを以下に示す。

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

続けて、同じ transaction 内で次を実行する。

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

この形の意味合いは以下のとおり。

- `BEGIN IMMEDIATE` により、早い段階で write-intent を確保する
- write serialization が、2 つの writer が同じ mutation path を同時に通ることを防ぐ
- correctness は row-level lock ではなく transaction に依存する

### Candidate Update への追加 Guard

adapter がさらに防御的にしたい場合は、update 側にも eligibility condition を繰り返すことができる。

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

これは transaction の代替にはならないが、mutation 自体をより self-defending にする効果がある。

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

成功は `changes() = 1` で判定する。

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

SQLite adapter では、cleverness よりも correctness を優先したい。

複雑で推論しにくい pattern を採るよりも、transaction による直列化で単純に claim path を構成するほうが望ましい。

## Concurrency Key に関する注記

上記の sketch では `excludeConcurrencyKeys` を概念的に示しているが、実装の詳細は変わりうる。

重要な semantic rule はひとつだけ。runtime が除外したい active run の `concurrency_key` と衝突する run は claim してはならない、ということだ。

その logic を inline で表現しにくい場合は、次の 2 段階に分けてもよい。

- active な concurrency key を取得する query
- それらを除外する guarded claim query

ただし、最終的な claim が correctness を保つことが前提となる。

## Step / Event 書き込み

この sketch は claim と lease handling に焦点を当てているが、checkpoint と event persistence にも同じ規律が求められる。

- append write は durable でなければならない
- read-after-write visibility は予測可能でなければならない
- step completion は crash・reclaim 後も安全に再読できなければならない

## 次の一歩

次に作成する implementation-oriented なドキュメントでは、おそらく以下を定義することになる。

- 新しい runtime における `runs` table の正確な schema
- 必須 index
- すべての backend が通過すべき adapter test fixture

ここまで進めば、この sketch はより直接的な実装計画へと変わる。
