---
layout: home

hero:
  name: Durably
  text: Resumable Batch Execution
  tagline: Step-oriented batch processing for Node.js and browsers using SQLite
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Live Demo
      link: https://durably-demo.vercel.app
    - theme: alt
      text: GitHub
      link: https://github.com/coji/durably

features:
  - icon: 🔄
    title: Resumable Execution
    details: Each step's result is persisted to SQLite. If interrupted, jobs resume from where they left off.
  - icon: 🌐
    title: Cross-Platform
    details: Same API works in Node.js (Turso/libsql, better-sqlite3) and browsers (SQLite WASM with OPFS).
  - icon: 🛡️
    title: Type-Safe
    details: Full TypeScript support with Zod schema validation for inputs and outputs.
  - icon: 📦
    title: Minimal Dependencies
    details: Just Kysely and Zod as peer dependencies. No heavy frameworks required.
---
