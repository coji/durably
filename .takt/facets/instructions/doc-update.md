# ドキュメント更新手順

実装変更に伴うドキュメント・website・examples の更新を行う。

## 手順

1. `git diff --name-only` で変更ファイルを確認し、API 変更の有無を判断

2. API 変更がある場合、以下を順番に更新:

   **a. LLM向けドキュメント:**
   - `packages/durably/docs/llms.md`
   - `packages/durably-react/docs/llms.md`

   **b. Website API リファレンス:**
   - `website/api/` 以下の該当ファイル

   **c. Website ガイド:**
   - `website/guide/` 以下の該当ファイル

   **d. Example アプリ:**
   - `examples/` 以下の該当ファイル

3. API 変更がない場合（内部リファクタ等）:
   - ドキュメント更新は不要
   - 変更なしを報告して完了

4. llms.md を更新した場合、llms.txt を再生成:

   ```bash
   pnpm --filter durably-website generate:llms
   ```

5. バリデーション実行:

   ```bash
   pnpm validate
   ```

## ルール

- 変更した API のシグネチャ・型・オプションを正確に反映する
- 実装コードは変更しない（ドキュメントファイルのみ）
- 既存のドキュメントスタイルに合わせる
- 更新不要な場合は何もしない（空振りOK）
