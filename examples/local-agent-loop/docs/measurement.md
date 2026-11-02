# 計測とレポート

[README](../README.md) に戻る。

## 計測

LLM の呼び出しはすべて `src/engine/runner.ts` を通り、試行のメタデータへ次の値を
保存します。

- 要求した（requested）、実際に使った（effective）、プロバイダーが報告した
  （provider-reported）モデルと推論量（指定がない値と報告がない値は `null`）
- `sessionId`、`operationKey`、`invocationId`、回収した結果かどうか
- 修正の呼び出しでは、呼び出す前に決めたセッションの扱い（`sessionHandling`：
  `continued`、`continued-effort-change`、`fresh`）とその理由（`sessionReason`）
- 通常の入力、キャッシュの読み込み、キャッシュの書き込み、出力、合計のトークン
- 使用量の単位（このサンプルでは、プロバイダーへの 1 回の呼び出し）と、取得元
- 経過時間、結果、エラー、中断の理由、API 換算の参考価格と、料金の項目（meter）
  ごとの内訳
- `configVersion`（3 つの役割それぞれのプロバイダー、モデル、推論量、会話の文脈の
  扱い、指示の版、反復の上限、対象、時間の上限のハッシュ。見立てのプロファイル、
  `code` と違う修正のプロファイル、`selfCheck` のコマンドがあれば、それも含む。
  推論量だけ違う修正でセッションを続けると事前確認で確定した実行では、その方針も
  含む。事前確認の最小の呼び出しには、確定する前の版が入る）

プロバイダーが返す使用量は、1 回の呼び出しの中の**すべてのモデルの応答の合計**で
なければいけません。エージェントの CLI は、1 回の呼び出しの中で何十回もモデルを
呼ぶので、最後の応答だけでは桁が変わります。

- **Claude**: Agent SDK の `result` メッセージの累計を、そのまま使います。
  Claude Code の記録（transcript）にある各応答の合計と一致することを確かめて
  あります。
- **Codex**: `ai-sdk-provider-codex-cli@2.3.0` は、応答ごとの `thread/tokenUsage/updated`
  を、ターンの中で合計します（2.2.1 は上書きしていたため、最後の応答の分しか
  返しませんでした。
  [ben-vargas/ai-sdk-provider-codex-cli#49](https://github.com/ben-vargas/ai-sdk-provider-codex-cli/issues/49)
  で報告し、`patches/` のパッチで直していました。2.3.0 で上流に入ったので、パッチは
  外しています）。増えた分は、ターンを始める前のスレッドの累計からの差で求めるので、
  `--context reuse` でも前回の呼び出しの分は含みません。キャッシュの書き込みも、
  上流で `0` 固定をやめ、
  app-server が返す値を読むようにしています。ただし ChatGPT のログイン（サブスク）
  では、実際に書き込んだかどうかに関係なく、サーバーが常に 0 を返します
  （[openai/codex#32479](https://github.com/openai/codex/issues/32479)）。この環境の
  33 万の応答のうち、確実に書き込みが起きた 2,334 件も、すべて 0 でした。そのため、
  ChatGPT のログインでの 0 は不明として扱い、正の値だけを使います。API キーでは
  値が実際の数なので、0 もそのまま使います。ログインの方式は `codex login status`
  で判定します。キャッシュの書き込みが分からない呼び出しがあると、レポートには
  「書き込みの割増を含まない下限」と注記します。
  この修正の前は、実際には 25 回応答していた実装の工程が 1 回分として記録され、
  実行全体の費用が約 16 分の 1 に見えていました。

集計では、`invocationId` ごとに 1 回だけ数えます。同じ完了のチェックポイントを
別の試行が読み直しても、トークンを二重に数えません。ローカルのテストや、次の
工程を決める判断（policy）などは、使用量の対象外です。LLM を呼んだのに使用量がない
場合は、欠測として件数を残し、完全な合計にはしません。

レポートは、SQLite にある実行、試行、待ちの記録から作り直す、副作用のない処理です。

```bash
pnpm --filter example-local-agent-loop demo report --run <runId> --format json
pnpm --filter example-local-agent-loop demo report --run <runId> --format md \
  --out reports/<runId>.md
```

レポートは、次の三層に分けて出します。

- **Summary**: 実行 1 本を 1 行にまとめた値。成功したか（success）、所要時間
  （lead time。登録から終わるまで）、作業時間（work。工程の実作業の合計）、人の
  待ち時間（human wait）と、その所要時間に対する比、LLM の呼び出し数、合計の
  トークン（total tokens）、費用（cost）、成功 1 回あたりの費用（cost per success。
  成功した実行だけ）、修正回数（repairs）、レビューの回数（review rounds）
- **Inputs / Candidate / Delivery**: タスク、仕様、指摘の扱い（dispositions）、
  文脈の各ファイルの SHA-256（文脈は読み込み元と本文も）、最後に封印した候補の
  ブランチとコミット、成果物の場所、ブランチ名、コミット SHA、1 コミットにまとめた
  （squash した）ブランチの名前とコミット SHA
- **Candidates**: 封印したすべての候補（JSON の `candidates`）。候補ごとに、
  何回目の実装か、ブランチ、コミット、変更したファイルの数、追加した行数、削除した
  行数、差分のファイルと変更の一覧のパス（`changes`）を持ちます。名前の変更は
  1 ファイルと数えます。バイナリファイルは変更したファイルの数にだけ数え、行数には
  git が報告するテキストの行だけを足します。変更のない候補は、すべて 0 です。
  同梱の題材の候補は規模を記録しないので、`changes` は `null` です。`candidate` は、
  これまでどおり最後の候補です
- **Review rounds**: レビューのすべての回（JSON の `reviewRounds`）。回ごとに、
  レビューした候補と、2 人のレビュアーの判定とメモを、回の順に持ちます。保存した
  レビューの `step` の出力から組み立てるので、走っている途中、承認待ち、修正の後に
  止まった実行でも、終わった回が出ます。途中で止まった回には、終わったレビュアーの
  分だけが入ります。`reviews` は、これまでどおり最後の回です。`findings-json` の
  レビューは、`reviewRounds[].reviews[]` と `reviews[]` の両方に `findings` を
  持ちます。`findings.blocker` と `findings.nonBlocker` は、保存した指摘
  （`severity`、`title`、`body`、あれば `file`、`line`、`likelihood`、`impact`、
  `thresholdException`）の配列で、それぞれ先頭の 20 件までです。`findings.counts`
  は、省いた分も含めた `severity` ごとの総件数です。件数は、配列の長さではなく、
  こちらで読みます。
  指摘は、完了したチェックポイントの返答をレビューの `step` が読んだときに保存した
  ものです。レポートを作るときに、レビュアーを呼び直したり、チェックポイントを
  読み直したりはしません。`verdict` のレビューと、指摘を保存するようになる前の
  実行のレビューは、`findings: null` です。実行の出力（`output.reviews`）には、
  指摘を入れません。Markdown と画面には、総件数と、保存した指摘の題名、省いた件数
  だけを出し、本文、ファイル、行番号は出しません。
  Markdown では、各レビューの指摘の一覧で、採点値か `thresholdException` のある
  指摘の題名の後ろに、`(likelihood 2, impact 3)` や
  `(likelihood 2, impact 3, exception not-product)` の形で付けます。レビューの
  要点（`reviewHighlights` の各群の `kept`）の題名には、採点値だけを同じ形で
  付けます。画面では、レビューの要点と、各レビューの指摘の一覧の題名の横に、
  頻度と深刻さを添えます。
  メモの表示は変わらないので、`blocker` の場所と本文は、これまでどおりメモに出ます
- **Verification logs**: 検証の試行ごとの終了コードと、`stdout.log` / `stderr.log`
  のパス。JSON では `attempts[].measurement.verificationLog` で、`exitCode`、
  `stdoutPath`、`stderrPath` に加えて、中断した試行には `interrupted: true`、
  書き込みに失敗したログには `writeError` が入ります。Markdown では、中断した試行の
  行に `interrupted, not part of the verdict` を付け、書き込みのエラーを
  `log write error:` の行に出します。検証の失敗で止まった実行では、最後の検証の
  すべての試行の終了コードとログのパスを、`failure.details` にも載せます
  （`check attempt: `、`check exit code: `、`check stdout log: `、
  `check stderr log: `、`check log write error: `）
- **Repair session**: `repair` が `code` と違う実行で、推論量が変わっても実装の
  セッションを続けるかどうか（JSON の `repairSession`、Markdown の
  `repair session` の行）。準備のときの判定（`eligible` と理由）と、事前確認の
  あとに確定した判定（`continues`、モデル、理由）を持ちます。レポートの
  `configVersion` は、この確定のあとの版です
- **Repair calls**: 修正の呼び出しごとの行（JSON の `repairCalls`）。セッションの
  扱い（`continued` は同じプロファイルで続けた、`continued-effort-change` は推論量
  だけ違うプロファイルで続けた、`fresh` は新しいセッション）とその理由
  （`sessionReason`）、入力、キャッシュの読み込み、その呼び出しの
  キャッシュの読み込みの比率（`cacheReadTokens / inputTokens`）を持ちます。使用量が
  ないときや、入力が 0 のとき、比率は `null` です。回収した呼び出しも 1 行で、
  `(recovered)` を付けます。続けた修正の比率が高く、新しいセッションの修正の比率が
  0 に近ければ、キャッシュが効いています
- **Triage**: 見立て（`routine` / `probe` / `unknown`）とその理由、4 つの
  較正の材料（分からなければ `unknown`）。判定のない実行は `none`
- **Stage usage**: 工程ごとの visits / reworked（同じ工程にもう一度入った回数、
  つまり手戻り）、呼び出しの数、in / cache-read / cache-write / out / total、
  費用（cost）。どれかの呼び出しの使用量が数えられていなければ PARTIAL、価格が
  分からなければ unknown
- **Role usage**: `code`、`correctness`、`edge-cases`（修正を呼んだか、修正の
  プロファイルがあれば `repair`、見立てのプロファイルがあれば `triage` も）ごとの、
  要求したプロバイダー / モデル / 推論量、呼び出しの数、トークン、費用、使用量と
  費用のそれぞれがそろっているかどうか。2 つのレビューを別の行に分けるので、役割
  ごとに違うモデルを使った実行でも、内訳が混ざりません
- **Timing / Attempts / Waits**: これまでどおりの、工程ごとの work / wall の時間、
  呼び出しごとの生のデータ、承認待ちの inputWait / executionSlotWait
- **Versions**: `ai` とプロバイダーのパッケージの版に加えて、プロバイダーが実際に
  起動した CLI の版とパス。Codex は `codexCli` / `codexCliPath`、Claude は
  `claudeCli` / `claudeCliPath` です。Codex は、`codexPath` がなければ PATH 上の
  `codex` を起動し、それもないときだけ、プロバイダーが解決できる `@openai/codex` を
  `node <パッケージ>/bin/codex.js` として起動します。Claude Agent SDK は同梱の
  ネイティブバイナリを起動し、PATH 上の `claude` は使いません。factory は同じ
  解決を行い、その実行ファイルをプロバイダーに明示して渡すので、記録した版と
  起動した CLI は同じファイルです。見つからない値は `null` にし、別のインストール
  から推測しません

価格は、サブスクの請求額ではなく、各呼び出しのときに保存した
`api-equivalent-estimate` の参考値です。AI SDK v7 の使用量の取り決めに合わせて、
`inputTokens` 全体のうち、キャッシュの読み込みと書き込みはそれぞれの料金の項目
（meter）の単価で、残りは入力の単価で計算します。キャッシュの書き込みは、どちらも
入力の 1.25 倍です。キャッシュの読み込みはモデルごとに違い、多くは 0.1 倍、
Claude Opus 5.5 は 0.05 倍、Claude Fable 5.1 は 0.025 倍です。価格表は
`src/engine/pricing.ts` にあり、確かめた日と出典を `PRICE_BASIS` に記録して
います。キャッシュの内訳（cache legs）が報告されなかった呼び出しは、入力全体を
定価で扱い、`costCacheAware: false` として区別します。レポートは保存した値を
合計し、今の価格表で計算し直したとは表示しません。知らないモデルや、欠けた
使用量を、0 円としては扱いません。

## 止めた呼び出しの使用量

最後まで終わらなかった呼び出しも、止めるまでに使った分を残します
（[ADR-0034](../../../docs/adr/0034-local-agent-loop-stopped-call-usage.md)）。
Claude と Codex は、呼び出しの途中でも、その時点までの累計を報告します。

- **Claude**: API の応答ごとの使用量を、message ID ごとに 1 回だけ足し、
  モデル別にも分けます。assistant メッセージの使用量は応答を始めたときの値で、
  出力はほとんど入っていません。そのため、途中の使用量を記録する呼び出しでは、
  Agent SDK のストリームのイベント（`includePartialMessages`）も受け取り、
  `message_start` で応答を、`message_delta` でその応答のその時点までの
  出力を読みます。各項目（leg）は応答の中で増えるだけなので、見えた最大の値を
  使います。Claude Code が自分で作る
  `<synthetic>` のメッセージと、トークンのないメッセージは数えません。最終の
  使用量と同じ範囲で数えるので、サブエージェントは `command` モードのレビューでだけ
  数えます。セッション ID は、結果を待たずに、各メッセージから読みます。
- **Codex**: app-server の `thread/tokenUsage/updated` を、プロバイダーの最終の
  集計と同じく、スレッドの累計の増えた分で足します。最初の通知は直前の応答の分
  だけを足すので、`--context reuse` で再開したスレッドの前回の分は入りません。
  この通知を読むために、加工していない通知（raw 通知）を有効にします。ただし、
  raw 通知は活動として数えず、エージェントのログにも書きません。無通信の時間を
  数え直すのは、トークンのある使用量の通知だけです（ほかの途中の使用量と同じ）。
  それ以外の raw 通知と、トークンのない使用量の通知では、数え直しません。
  スレッド ID は、ターンを始める前に `onSessionCreated` で受け取ります。

検証の失敗でレビューを止めたとき（`superseded-by-verify`）と、factory の時間の
上限で止めたとき（`timeout`）は、止めた時点までの使用量、モデル別の内訳、
セッション ID、報告の回数と最後の報告の時刻を、完了のチェックポイントにも保存
します。ワーカーが再開してチェックポイントを読み直した試行にも、送り直さずに同じ
値が入ります。実行の取り消しや、リースを失ったことで止まった呼び出しは、結果が
分からないので、これまでどおり `uncertain` のままにし、完了のチェックポイントは
作りません。それまでに受け取った値は、試行の計測にだけ残します。

止めた呼び出しの結果は、これまでどおり使いません。採点、承認、レビューの回数には
入らず、残るのは使用量だけです。最終の使用量を受け取った呼び出しでは、途中の
累計を最終の値で置き換えます。最終の値にモデル別の内訳がなければ、途中の内訳も
消します。最終の結果に使用量やセッション ID がないまま終わった呼び出しは、途中で
受け取った値を計測に残し、完了のチェックポイントにも保存します。そのため、
読み直した試行にも同じ値が入ります。

計測の `usageUntilStop` は、使用量が途中までであることを示します（止めた理由、
報告の回数、最後の報告の時刻と、呼び出しを始めてからの時間）。報告が一度もなかった
呼び出しは、`usage` が `null` で、報告の回数が 0 です。0 トークンとは扱いません。
レポートの JSON は `stoppedCalls` に、Markdown は「Usage of stopped calls」に、
呼び出しごとの止めた理由、報告の回数、最後の報告の時点、使用量とモデル別の内訳、
セッション ID を出します。止めた呼び出しを含む合計は、トークンがそろっていても
`complete` と `costComplete` を false にし、下限として扱います。途中の報告
（`provider-partial`）のままの使用量も同じです。最終の使用量がないまま終わった
呼び出しや、呼び出しの途中でワーカーが異常終了して `started` のまま残った試行が、これに
当たります。同じ呼び出しの試行が複数あるときは、完了した試行、止めた呼び出しとして
確定した試行（`cancelled`、`timed-out`）、それ以外の順に 1 つを選んで集計します。
Markdown の集計の行も、工程や役割の合計と同じ試行から数えます。試行の表では、途中の
報告のままの使用量とその費用に `(partial)` と付けます。Summary の total tokens も、
数えた合計のどれかが不完全なら `tokensComplete: false` にし、Markdown では
`(PARTIAL)` と付けます。`demo compare` は、不完全なトークンの合計と、不完全な
工程のトークン・キャッシュの読み込みの合計を、不明として扱います。

## モデルの選び方とサブスクでの制約

ログイン済みの CLI（サブスク）で使う前提なので、価格表に載っていても呼べない
モデルがあります。2026-09-23 に実際に呼んで確かめた結果です。

| モデル                                                        | サブスクで使えるか                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | 使える                                                                   |
| `gpt-6-sol`, `gpt-6-luna`                                     | 使えない。ChatGPT アカウントの Codex では 400 が返る。API キーでは使える |
| `claude-opus-5-5`, `claude-sonnet-5`                          | 使える                                                                   |

`claude-opus-5-5` には Claude Code 2.1.280 以上が必要です。
`ai-sdk-provider-claude-code` は Agent SDK を版を固定して同梱しており、最新の 4.3.2
でも 2.1.278 までしか入りません。そのため、ルートの `pnpm-workspace.yaml` の
override で、`@anthropic-ai/claude-agent-sdk` を 0.3.280 に上げています。

`codex debug models` の一覧には、サブスクで呼べないモデルも出ます。一覧ではなく、
実際に呼べるかどうかで判断してください。

## 複数の実行の比較

1 本の実行は、キャッシュが使われるかどうかや修正回数でぶれるので、同じ条件で何回か
動かして、`compare` で見ます。`configVersion` が同じ実行を 1 つのグループにまとめ、
中央値 / 最小 / 最大と、欠測の数を出します。

```bash
pnpm --filter example-local-agent-loop demo compare \
  --runs <runA>,<runB>,<runC>,<runD> --format md
```

グループごとに、success の率、結論ごとの実行の数（`conclusions`。結論を記録する
前に失敗や取り消しで終わった実行は、`failed` / `cancelled` として数える）、
lead time、work、human wait、total tokens、cost、cost per success、repairs、
工程ごとの work / tokens / cache-read / cost / reworked を並べます。見立ての
ある実行を含むグループには、判定（`routine`、`probe`、`unknown`）ごとの表が
付きます。列は、実行の数、approved、verification-failed、review-cap-reached、
repairs と cost の統計、そして、`routine` と判定されたのに修正が要った、または
上限（review cap か、検証の失敗で終わった反復の上限）に達した実行の数と、
止まった理由（`rejected-invocation`、`uncertain-invocation` など）ごとの実行の
数です。`routine` の列が判定の見逃しで、判定だけを記録するモード（shadow mode）で
測りたい値です。続く表は、同じ判定ごとに、4 つの較正の材料（タスクと仕様の文字数、
受け入れ基準の項目数、変更する予定のファイルの数）の統計を並べます。費用や較正の
材料が分からない実行は、統計から外して unknown の件数に数えます。見立ての
呼び出しのトークンと費用は、`triage` の工程と `triage` の役割に 1 回ずつ数えます。

外部の指摘から作った修正の実行（`demo repair`）は、通常の実行とは別のグループに
まとめます。子の実行の数字はその実行自身のもので、親の時間、費用、工程は足しません。

週ごとの移り変わりは `--trend` で見ます。`--runs` は取らず、実行ではなくタスクを
数えます。タスクは、一覧と同じく、最初の実行と、その下の修正の実行（`demo repair`）
をまとめたものです。最後に作った実行が終わり、その完了時刻が直近の `--days` 日
（既定は 30）に入るタスクだけを読みます。最後の実行が動いているタスク、完了時刻の
ないタスク、期間の外で終わったタスクは数えません。

```bash
pnpm --filter example-local-agent-loop demo compare --trend
pnpm --filter example-local-agent-loop demo compare --trend --days 14 --include-fake --format json
```

- 最初の実行の実装に使ったモデルと推論量（`code` のプロファイルの
  `effectiveModel` と `effectiveEffort`）の組でまとめ、最後の実行が終わった週
  （月曜始まり、この PC の時刻）で分けます。CLI の版はまとまりに含めません。
- 週ごとと期間全体について、タスクの数、初回承認の数と率、最終承認の数と率、
  タスクの所要時間と費用の中央値 / 最小 / 最大と欠測の数、修正の実行の数の中央値を
  出します。
- 初回承認は、修正の実行なしに、最初の実行で承認されたタスクです。最終承認は、
  最後の実行が承認されて納品されたタスクです。レビューの上限で止まった実行を、
  修正の実行で直して承認されたタスクは、最終承認に数え、初回承認には数えません。
- タスクの所要時間と費用は、期間の外で終わった実行も含めた、すべての実行の合計
  です。修正の実行の数は、最初の実行の下にある実行の本数で、実行の中で修正した
  回数とは別のものです。
- 最初の実行が fake プロバイダーのタスクは除き、除いたタスクの数を `fakeExcluded`
  に出します。含めるときは `--include-fake` を付けます。
- `--days` は、1 から `Number.MAX_SAFE_INTEGER` までの整数だけを受け付けます。
  0、負の数、`NaN`、`Infinity`、小数、それより大きい数は、DB を開く前に拒否します。
- 費用や時間が分からない実行を 1 つでも含むタスクは、その中央値から外して欠測の
  数に数え、0 として混ぜません。タスクのない週は件数を 0 とし、率や中央値は出し
  ません。

`reuse` と `fresh` を比べるときは、`code` の工程のキャッシュの読み込みの比率と、
repairs の中央値を見ます。unknown は統計から外して件数だけを残し、0 として
平均に混ぜません。

## 使用量の責任範囲

factory が責任を持つのは、factory の DB と `report --format json` までです。利用する
側で使用量の台帳をつけている場合は、実行が終わったあとに、利用する側がレポートを
読んで取り込みます。factory から台帳へ書き込むことはしません。

```bash
pnpm --filter example-local-agent-loop demo report --run <runId> --format json \
  | jq '{runId, configVersion, inputs, delivery, roleUsage, summary}'
```

`roleUsage` は `code`、`correctness`、`edge-cases` の 3 行で、それぞれ、指定した
プロバイダー、モデル、推論量、呼び出しの回数、トークンの内訳、合計のトークン、
費用、`complete`、`costComplete` を持ちます。fake のプロバイダーのように使用量を
返さない呼び出しは、0 にせず、トークンと費用を `null`、`complete` を `false` に
します。トークンがそろっていても、価格表にないモデルなら、費用は `null`、
`costComplete` は `false` です。

## `reuse` と `fresh` の比較

同じ題材、プロバイダー、モデル、推論量、最大反復数で、2 つの実行を作ります。

```bash
pnpm --filter example-local-agent-loop demo trigger \
  --provider codex --context reuse --model gpt-5.6-sol --effort medium

pnpm --filter example-local-agent-loop demo trigger \
  --provider codex --context fresh --model gpt-5.6-sol --effort medium
```

両方を承認まで進め、`compare` で、修正回数、キャッシュの読み込みと書き込み、
実作業時間、レビューを並べて動かした区間、人の待ち時間、実行全体の時間の中央値を
比べます。セッションを続けても、キャッシュが使われるとは限りません。効果は、
プロバイダーが報告したキャッシュの使用量で判断します。

モデルと推論量は、コマンドラインとプリセットの表だけで決まります。環境変数は
一切使いません。実行の構成を、それを起動したコマンドを読めば分かるように
しておくためです。とくに `CLAUDE_EFFORT` は Claude Code がシェルへ export する
ので、これに従うと、「どのエージェントのセッションからコマンドを打ったか」で
推論量が変わります。同じつもりの実行が、別の `configVersion` に分かれてしまいます。
