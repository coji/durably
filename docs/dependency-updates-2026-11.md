# Dependency updates — November 2026

## Runtime and actions

Node.js 24.22.2 is the latest Node 24 release checked against the official distribution index on November 9. The managed runtime, engine requirement, lockfile, and audit Docker image now match. pnpm is updated from 12.4.2 to 12.18.0.

GitHub Actions retain full commit pins: pnpm/setup 3.1.2, upload-artifact 7.0.2, and download-artifact 8.0.2. Checkout, cache, and Pages actions were already current. Setup still reads the manifest runtime and package manager, caches the store, and leaves installation to the explicit frozen-lockfile step. The native updater stalled in git ls-remote; release tags and their commit objects were resolved through the GitHub API instead.

## Dependencies and compatibility

All updatable workspace direct dependencies use their latest stable releases, with these intentional constraints:

- Node.js and @types/node stay on 24 (types 24.19.2).
- The Vercel adapter still requires React Router 7; that example uses matching 7.18.5 packages. Other Router examples use 8.5.1.
- VitePress 1.6.4 remains the latest stable release. Its optional DocSearch React renderer requires React below 19, so the website explicitly supplies React 18.3.1. Application examples and library tests use React 19.3.1.
- The official TypeScript 7/native and TypeScript 6 compatibility aliases remain intact, as do published peer compatibility ranges.

Notable tool updates include Vitest 5.1.0, Playwright 1.65.0, tsup 9.0.0, oxfmt 0.77.0, oxlint 1.92.0, and Satori 0.63.2. tsup now requests esbuild 0.28 directly; its override is removed. Satori requires explicit border-box sizing and directional gaps to preserve the OG image layout; the image was regenerated and visually compared. Markdown examples were reformatted by the updated formatter and llms.txt regenerated.

Compatible transitive refreshes include gRPC, source-map-js, proxy-addr, Vue, body-parser, fast-uri, Zod, and Vite 7. Express 4 and body-parser 1 still pin older qs patches; scoped overrides select the compatible 6.16.1 fix.

## Validation and remaining advisories

- pnpm build and pnpm validate pass, including PostgreSQL containers and Chromium tests: 1,407 package tests pass, 8 existing tests are skipped, and 19 audit-workflow tests pass.
- React Doctor reports 100/100 for all five configured projects.
- Frozen installation, peer dependency checking, and actionlint pass. OG image generation succeeds and its layout is verified visually.
- No public API or architecture changes; ADR-0002 continues to apply.

The final pnpm audit reports **0 critical, 1 high, 9 moderate, 1 low**. VitePress still uses Vite 5/esbuild 0.21 development-server dependencies. Testcontainers' archiver chain remains on glob 10/minimatch 9, and React Doctor's ESLint chain remains on minimatch 10; the advertised fixes require incompatible major upgrades. These are recorded limitations, rather than forcing unsupported transitive majors. The pinned Shannon source snapshot is deliberately unchanged.
