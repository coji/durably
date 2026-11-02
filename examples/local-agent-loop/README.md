# local-agent-loop — Durably local factory demo

Durably、ローカルの SQLite、AI SDK v7、ログイン済みの CLI 1 つ（Codex か
Claude Code）を使い、実装、固定したテスト、独立したレビュー、人の承認までを
ローカルで実行するサンプルです。新しいワークフローのフレームワーク、Docker、
GitHub の認証、CI は使いません。

設計の中心は、工程の区切りと会話の区切りを別にすることです。

- 工程は `code → verify → review → approve → finish/stop` に分け、それぞれの
  判断と実行を Durably の `step` として保存します。
- `code` は最初の実装と修正で同じものを使います。`--context reuse` では、
  プロバイダーが持つ同じセッションを ID を指定して再開し、`--context fresh` では
  毎回新しい会話を使います。
- `verify` と 2 つの `review` は、編集できる作業ディレクトリではなく、固定した
  同じ候補を見ます。レビューの会話は、実装の会話とは別の新しいセッションです。
- 修正すると新しい候補になり、古いテスト結果、レビュー、承認は reducer
  （状態を更新する関数）が無効にします。
- 承認待ちとその `signal` には同じ候補の ID が必要で、最終的な成果物として
  承認された候補を返します。

## 構造

`src/factory/job.ts` がするのは、保存した状態から次の工程を決める判断を記録し、
実際の関数を登録した表から呼び、返ったイベントで状態を更新することだけです。
作業場所の用意、固定したテスト、並列のレビュー、待ちは、`src/factory/stages.ts`
の各工程が組み立てます。工程全体をまとめて `step.run()` で包まないので、
承認待ちは Durably の正しい区切りにあります。

```text
setup
triage (profiles.triage があるときだけ一度。判定を記録するだけ)
decision:N
  └─ stages[decision.stage](...)
       ├─ code: agent call → fixed Candidate
       ├─ verify: fixed acceptance command against Candidate
       ├─ review: correctness + edge-cases (step.all, new sessions)
       ├─ approve: prepareWait → waitFor(Candidate ID)
       └─ finish/stop: approved Candidate or terminal failure
```

候補とテストの固定の詳しい仕組みは [仕組みと制約](docs/architecture.md) にあります。

## セットアップ

```bash
pnpm install
pnpm --filter example-local-agent-loop typecheck
pnpm --filter example-local-agent-loop test:unit
```

使うプロバイダーだけをインストールし、ログインしておきます。

```bash
codex --version
codex login

# または
claude --version
claude auth login
```

Codex では `ai-sdk-provider-codex-cli@2.3.0` の app-server モードを使います。
最初の呼び出しで続けて使えるスレッド（persistent thread）を作り、修正のときは
保存した `threadId` を指定します。Claude では `ai-sdk-provider-claude-code@4.3.1`
が返す `sessionId` を保存し、修正のときは `resume` で再開するセッションを指定
します。「作業ディレクトリでいちばん新しい会話を選ぶ」動きは使いません。

## 実行

ターミナル 1 でワーカーを動かし続ける手順です。動かし続けなくても、ターミナル 2
の `trigger` などがワーカーを自動で起動します（[「ワーカーの自動起動とアイドル終了」](docs/operations.md)の節）。

ターミナル 1:

```bash
pnpm --filter example-local-agent-loop demo worker
```

ワーカーは状態のルートごとに 1 つだけ動きます（[日々の操作](docs/operations.md)）。

ターミナル 2:

```bash
pnpm --filter example-local-agent-loop demo trigger \
  --provider codex --context reuse --max-iterations 2

pnpm --filter example-local-agent-loop demo status --run <runId>
pnpm --filter example-local-agent-loop demo waits --run <runId>
pnpm --filter example-local-agent-loop demo approve --run <runId> --wait <waitId>
pnpm --filter example-local-agent-loop demo report --run <runId> --format md
```

`--max-iterations` は、1 つの実行で実装と修正を合わせて何回までするかで、1 から 5
まで指定できます。省略すると 2 です。

Claude では `--provider claude` に替えるだけです。承認の CLI は承認待ちの
メタデータから候補の ID を読み、`signal` のペイロードにも同じ ID を入れます。
却下するときは、`approve` の代わりに `reject` を使います。

## fake モード

```bash
pnpm --filter example-local-agent-loop demo trigger \
  --provider fake --context reuse --max-iterations 3
```

ワーカーは `trigger` が自動で起動し、実行が終わってしばらく仕事がなければ、自分で
終了します（[「ワーカーの自動起動とアイドル終了」](docs/operations.md)の節）。

`FAKE_FAIL_FIRST=0` で、最初の実装を成功させられます。
`FAKE_REVIEW_SEQUENCE="needsChanges,pass"` で、レビューと修正の繰り返しを再現
できます。`FAKE_TRIAGE` は、見立ての応答を、呼び出しごとに順に選びます
（`routine`、`probe`、`empty`、`invalid`、`contradictory`、`unsupported`、
`error`。既定は `routine`）。fake の見立ては、同梱の題材では `trigger` の
フラグから指定できないので、ジョブの入力の `profiles.triage` で渡します。

fake の事前確認、待ち時間、使用量、`fakeScenario` は [仕組みと制約](docs/architecture.md) にあります。

## コマンドの一覧

すべてのフラグは `pnpm demo --help` で見られます。

| コマンド                            | すること                                       | 詳しい説明                                          |
| ----------------------------------- | ---------------------------------------------- | --------------------------------------------------- |
| `demo worker`                       | ワーカーを起動する                             | [日々の操作](docs/operations.md)                    |
| `demo trigger`                      | 実行を登録する                                 | [実際のリポジトリで動かす](docs/configuration.md)   |
| `demo status`                       | 人を待つ実行、止まった実行、実行中の実行を見る | [日々の操作](docs/operations.md)                    |
| `demo wait`                         | 実行が終わるか、人を待つまで待つ               | [日々の操作](docs/operations.md)                    |
| `demo waits` / `approve` / `reject` | 承認待ちを見る、承認する、却下する             | このページの「実行」                                |
| `demo spec-revise`                  | レビューで止まった仕様を、メモを付けて直させる | [見立て、レビュー、修正](docs/review-and-repair.md) |
| `demo retrigger`                    | 保存した入力で、新しい実行を作る               | [日々の操作](docs/operations.md)                    |
| `demo repair`                       | 外部の指摘から、修正の実行を作る               | [見立て、レビュー、修正](docs/review-and-repair.md) |
| `demo archive` / `unarchive`        | 止まった実行をアーカイブする、戻す             | [日々の操作](docs/operations.md)                    |
| `demo prune`                        | 終わった実行の作業ツリーを片付ける             | [日々の操作](docs/operations.md)                    |
| `demo report` / `compare`           | レポートを作る、実行を比べる                   | [計測とレポート](docs/measurement.md)               |
| `demo ui` / `seed`                  | web UI を開く、デモデータを入れる              | [ブラウザで見る（web UI）](docs/ui.md)              |

## ドキュメント

詳しい説明は `docs/` にあります。

- [日々の操作](docs/operations.md)：ワーカーの起動と終了、止まった実行と次の手順、
  `wait`、アーカイブ、作業ツリーの片付け、DB と作業物の置き場所
- [ブラウザで見る（web UI）](docs/ui.md)：一覧、実行の詳細、デモデータ
- [実際のリポジトリで動かす](docs/configuration.md)：`factory.json` と設定の項目
  （`baselineCheck`、`parallelReview`、`testProbe`、`review.blockerThreshold`、
  `profiles.repair` など）
- [見立て、レビュー、修正](docs/review-and-repair.md)：見立て、レビュー役の呼び出しと
  出力、仕様（spec）、外部の指摘から修正する `demo repair`
- [計測とレポート](docs/measurement.md)：レポートの形、使用量、複数の実行の比較
- [仕組みと制約](docs/architecture.md)：候補と固定したテスト、呼び出しの識別と復旧、
  権限と制約、fake モードの詳細、ファイルの構成
- [別のリポジトリへ移す](docs/porting.md)

## 以前の版から移行する（Upgrading）

以前の版は、DB を `examples/local-agent-loop/local-agent-loop.db`（または
`DURABLY_DB` の指す場所）に、作業物を `examples/local-agent-loop/runs/` に置いて
いました。この版はそれらを読まず、移行もしません。チェックアウトに古い DB が
残っていると、ワーカーと CLI は、起動したときに、その場所と新しい場所を標準エラー
出力に一度だけ警告します。承認待ちの実行や、走っている途中の実行が残っているなら、上げる前に、
以前の版で終わらせるか、破棄してください。そのあと、古い DB と `runs/` は消して
かまいません。作業ツリーを消したときは、対象のリポジトリで `git worktree prune` を
実行します。
