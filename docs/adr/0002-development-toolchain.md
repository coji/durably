# ADR-0002: Managed Node.js runtime and TypeScript compiler compatibility

## Status

accepted

## Context

The workspace is moving to Node.js 24 and pnpm 12. Keeping separate runtime declarations in CI and local development makes it easy for them to diverge. TypeScript 7 provides a native compiler but does not provide the compiler API used by tsup's declaration bundler, React Router's development tools, and prettier-plugin-organize-imports.

## Decision

Declare the development runtime in the root `package.json` using `devEngines.runtime` and let pnpm resolve and lock it. Use `pnpm/setup@v2` in GitHub Actions to install the package manager and runtime and cache the store. Keep an explicit `pnpm install --frozen-lockfile` step so CI rejects manifest/lockfile drift.

Use TypeScript 7's `tsc` for type checking, installed as `@typescript/native` (an alias of `typescript`) in each workspace that needs it. Keep the `typescript` import available to API consumers through the official `@typescript/typescript6` compatibility package. Both packages are declared in examples so they also have a working compiler when copied outside the monorepo. Explicitly declare ambient Node.js and Vite types. Suppress the deprecated `baseUrl` setting injected by tsup only in its TypeScript 6 declaration compiler configuration.

Keep the Vercel example on the latest React Router 7 release because `@vercel/react-router` declares React Router 7 peers. Other framework examples can use React Router 8. Do not override the adapter's peer requirements to force an unsupported combination.

The current libSQL Kysely dialect pins `@libsql/client@^0.8.0`. Use a targeted workspace override for that dependency to run the dialect on client 0.18, keeping client ownership and shutdown behavior in the dialect. Its consumed API is covered by the existing libSQL transaction, write contention, recovery, and cross-runtime stress tests. Remove this override when the dialect updates its dependency.

Security fixes blocked by pinned transitive ranges use narrowly scoped overrides after reviewing the upstream changes and testing the consuming tools. These cover Ajv 8 config validation, Express 4 query parsing, the font parser's fflate 0.7 backport, and tsup's esbuild 0.28 installation-integrity update. Keep VitePress on its stable supported dependency set and document its remaining development-server advisories rather than silently forcing an unsupported Vite major.

## Consequences

- Local pnpm scripts and CI use the same locked Node.js 24 runtime.
- Native type checking and compiler API consumers can coexist.
- The two compiler packages need separate updates until API consumers support the native compiler.
- React Router packages must stay at matching versions within each example.
- The libSQL override needs review whenever the client or dialect changes. It applies to development and examples in this repository, rather than to consumers' dependency resolution.
- Injected workspace dependencies are synchronized after `build` to expose newly built declarations and JavaScript to examples.

## Rejected Alternatives

- Keeping `actions/setup-node` and `pnpm/action-setup`: duplicates the runtime declaration and misses pnpm's integrated runtime setup.
- Replacing every TypeScript dependency with version 7: removes the compiler API and breaks declaration generation and import organization.
- Keeping only TypeScript 6: preserves tools but gives up native type checking.
- Forcing React Router 8 into the Vercel adapter: ignores an explicit compatibility constraint.
- Passing a new libSQL client directly to the old dialect: its old `Client` type is incompatible with the new `sync()` return type, and the dialect does not close externally supplied clients.
