---
layout: home

hero:
  name: Durably
  text: Resumable Batch Execution
  tagline: Steps that survive crashes. SQLite to PostgreSQL.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/quick-start
    - theme: alt
      text: Live Demo
      link: https://durably-demo.vercel.app
    - theme: alt
      text: GitHub
      link: https://github.com/coji/durably

features:
  - icon: 🔄
    title: Resumable Steps
    details: Each step auto-saves to the database. Interrupted jobs resume exactly where they left off — server restarts, crashes, browser tab closes.
  - icon: 🗄️
    title: Flexible Storage
    details: SQLite, libSQL/Turso, PostgreSQL, or browser OPFS. Pick what fits your deployment — from zero-config local to multi-worker production.
  - icon: 🌐
    title: Browser + Server
    details: Same API for Node.js and browsers. Use OPFS for offline-capable browser apps, or connect to a server via SSE.
  - icon: ⚡
    title: React Ready
    details: Built-in hooks with real-time progress updates via SSE. Fullstack and SPA modes with type-safe APIs.
  - icon: 🔒
    title: Lease-Based Recovery
    details: Workers claim jobs via leases with fencing tokens. Stale leases are automatically reclaimed — no stuck jobs.
  - icon: 🧹
    title: Auto Cleanup
    details: Set retainRuns to automatically purge old completed runs. Or call purgeRuns() for manual batch cleanup.
---
