# Spec Revision Policy

## Scope Rules

- order.md の修正のみ行う
- 実装コード、テスト、設定ファイルは変更しない
- PLAN.md は変更しない

## Revision Rules

- blocking 指摘には必ず対応する
- suggestion 指摘は取捨選択してよい（理由を明記）
- 仕様の構造（セクション、完了条件の形式）は維持する
- 変更対象ファイルの追加・削除は、既存コードを読んで根拠を確認してから行う

## Prohibited Actions

- 実装コードの変更
- レビュー指摘を無視して変更なしとすること
- order.md のスコープを大幅に拡大すること（分割を検討）
