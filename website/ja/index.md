---
layout: home

hero:
  name: Durably
  text: 再開可能なバッチ実行
  tagline: SQLiteを使用したNode.jsとブラウザ向けのステップ指向バッチ処理
  actions:
    - theme: brand
      text: はじめる
      link: /ja/guide/getting-started
    - theme: alt
      text: ライブデモ
      link: https://durably-demo.vercel.app
    - theme: alt
      text: GitHub
      link: https://github.com/coji/durably

features:
  - icon: 🔄
    title: 再開可能な実行
    details: 各ステップの結果はSQLiteに永続化されます。中断されても、ジョブは中断した箇所から再開します。
  - icon: 🌐
    title: クロスプラットフォーム
    details: Node.js（Turso/libsql、better-sqlite3）とブラウザ（OPFS付きSQLite WASM）で同じAPIが動作します。
  - icon: 🛡️
    title: 型安全
    details: 入出力にZodスキーマ検証を備えた完全なTypeScriptサポート。
  - icon: 📦
    title: 最小限の依存関係
    details: ピア依存関係はKyselyとZodのみ。重いフレームワークは不要です。
---
