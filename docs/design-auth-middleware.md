# Design: Auth Middleware for createDurablyHandler

Issue: #65

## Problem

`createDurablyHandler` exposes all endpoints without authentication/authorization. Multi-tenant apps must hand-write per-path auth logic covering 9 endpoints, resulting in ~130 lines of boilerplate that is error-prone and fragile when new endpoints are added.

### Real-world example (upflow)

```ts
// api.durably.$.ts — 137 lines of per-path auth
export async function loader({ request }) {
  const orgIds = await resolveOrgIds(request)
  const url = new URL(request.url)
  const path = url.pathname.replace('/api/durably', '')

  if (path === '/run' || path === '/steps' || path === '/subscribe') {
    const runId = getRequiredRunId(url)
    await requireRunAccess(orgIds, runId)
    return durablyHandler.handle(request, '/api/durably')
  }

  if (path === '/runs') {
    const scopedRequest = scopeRunsRequest(orgIds, request)
    return durablyHandler.handle(scopedRequest, '/api/durably')
  }
  // ... 8 more path branches for action() ...
}
```

## Proposed API

```ts
const handler = createDurablyHandler(durably, {
  auth: {
    // 1. Authenticate every request. Return context. Throw Response to reject.
    authenticate: async (request) => {
      const session = await requireUser(request)
      const orgs = await getUserOrganizations(session.user.id)
      return { orgIds: new Set(orgs.map((o) => o.id)) }
    },

    // 2. Guard before trigger. Called AFTER body validation and job resolution.
    onTrigger: async (ctx, { jobName, input, labels }) => {
      if (!ctx.orgIds.has(labels?.organizationId)) {
        throw new Response('Forbidden', { status: 403 })
      }
    },

    // 3. Guard before run-level operations (6 endpoints).
    //    Run is pre-fetched. Operation type is provided for fine-grained control.
    onRunAccess: async (ctx, run, { operation }) => {
      if (!ctx.orgIds.has(run.labels.organizationId)) {
        throw new Response('Not Found', { status: 404 })
      }
      if (operation === 'delete' && !ctx.isAdmin) {
        throw new Response('Forbidden', { status: 403 })
      }
    },

    // 4. Scope runs list queries by tenant.
    scopeRuns: (ctx, filter) => {
      const orgIds = [...ctx.orgIds]
      if (filter.labels?.organizationId) {
        if (!ctx.orgIds.has(filter.labels.organizationId)) {
          throw new Response('Forbidden', { status: 403 })
        }
        return filter
      }
      if (orgIds.length === 1) {
        return {
          ...filter,
          labels: { ...filter.labels, organizationId: orgIds[0] },
        }
      }
      throw new Response('label.organizationId is required', { status: 400 })
    },

    // 5. Scope runs/subscribe SSE stream by tenant.
    //    Separate from scopeRuns because subscriptions only support jobName + labels.
    scopeRunsSubscribe: (ctx, filter) => {
      // Same logic — RunsSubscribeFilter has only jobName + labels
      const orgIds = [...ctx.orgIds]
      if (filter.labels?.organizationId) {
        if (!ctx.orgIds.has(filter.labels.organizationId)) {
          throw new Response('Forbidden', { status: 403 })
        }
        return filter
      }
      if (orgIds.length === 1) {
        return {
          ...filter,
          labels: { ...filter.labels, organizationId: orgIds[0] },
        }
      }
      throw new Response('label.organizationId is required', { status: 400 })
    },
  },
})

// Route handler becomes a one-liner:
export async function loader({ request }) {
  return handler.handle(request, '/api/durably')
}
export async function action({ request }) {
  return handler.handle(request, '/api/durably')
}
```

## Type Definitions

```ts
/**
 * Run operation types for onRunAccess
 */
type RunOperation =
  | 'read'
  | 'subscribe'
  | 'steps'
  | 'retry'
  | 'cancel'
  | 'delete'

/**
 * Subscription filter — only fields that SSE subscriptions actually support.
 */
interface RunsSubscribeFilter<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  jobName?: string | string[]
  labels?: { [K in keyof TLabels]?: TLabels[K] }
}

/**
 * Auth middleware configuration.
 * Nested under `auth` — if present, `authenticate` is required.
 * TContext is inferred from authenticate's return type.
 * TLabels is inferred from the Durably instance.
 */
interface AuthConfig<TContext, TLabels extends Record<string, string>> {
  /** Authenticate every request. Return context or throw Response to reject. */
  authenticate: (request: Request) => Promise<TContext> | TContext

  /** Guard before trigger. Called after body validation and job resolution. */
  onTrigger?: (
    ctx: TContext,
    trigger: TriggerRequest<TLabels>,
  ) => Promise<void> | void

  /** Guard before run-level operations. Run is pre-fetched. */
  onRunAccess?: (
    ctx: TContext,
    run: Run<TLabels>,
    info: { operation: RunOperation },
  ) => Promise<void> | void

  /** Scope runs list queries (GET /runs). */
  scopeRuns?: (
    ctx: TContext,
    filter: RunFilter<TLabels>,
  ) => RunFilter<TLabels> | Promise<RunFilter<TLabels>>

  /** Scope runs subscribe stream (GET /runs/subscribe). Separate because subscriptions only support jobName + labels. */
  scopeRunsSubscribe?: (
    ctx: TContext,
    filter: RunsSubscribeFilter<TLabels>,
  ) => RunsSubscribeFilter<TLabels> | Promise<RunsSubscribeFilter<TLabels>>
}

/**
 * Handler options. TLabels flows from the Durably instance.
 */
interface CreateDurablyHandlerOptions<
  TContext = undefined,
  TLabels extends Record<string, string> = Record<string, string>,
> {
  /** Called before handling each request (lazy init: migrate, start worker). */
  onRequest?: () => Promise<void> | void

  /** SSE throttle interval in ms. @default 100 */
  sseThrottleMs?: number

  /** Auth middleware. When set, authenticate is required and auth applies to ALL methods. */
  auth?: AuthConfig<TContext, TLabels>
}

/**
 * Trigger request body — labels use the instance's TLabels.
 * input is `unknown` because per-job schemas are not known at the handler level.
 */
interface TriggerRequest<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  jobName: string
  input: unknown
  idempotencyKey?: string
  concurrencyKey?: string
  labels?: TLabels
}
```

### Key type decisions

**`TriggerRequest.input` is `unknown`** — the HTTP handler receives arbitrary JSON. Job input schemas validate at the job level, not the handler level.

**`RunFilter<TLabels>` reused for list, separate `RunsSubscribeFilter` for subscribe** — the subscription endpoint only supports `jobName` and `labels` (no `status`/`limit`/`offset`). Using the same filter type would create a contract that lies about what the endpoint accepts. The separate `RunsSubscribeFilter` type is honest about the subscription's actual capabilities.

**If `scopeRunsSubscribe` is not set but `scopeRuns` is**, the handler falls back to `scopeRuns` for subscriptions (extracting only `jobName` and `labels` from the returned filter). This means most users only need to define `scopeRuns` — the subscribe variant is only needed when the scoping logic differs.

**`onRunAccess` receives operation metadata** — `{ operation: RunOperation }` enables fine-grained policies.

### Design recommendation: tenant identity belongs in labels

Labels are the framework's mechanism for categorizing and filtering runs. Putting tenant identity in labels (not input) enables `scopeRuns`, `onRunAccess`, and `onTrigger` to work with typed labels consistently.

**Migration required for upflow**: The current upflow app does NOT use a labels schema and authorizes triggers from `input.organizationId`. To adopt this middleware, upflow must:

1. Add `labels: z.object({ organizationId: z.string() })` to `createDurably()`
2. Move `organizationId` from job input to trigger labels in all trigger call sites
3. Move trigger auth logic from `input.organizationId` to `labels.organizationId`

This is a one-time migration. Once complete, all auth hooks work with typed labels.

## Public API Surface

**Breaking change: `DurablyHandler` only exposes `handle()`.**

```ts
interface DurablyHandler {
  /** Handle all HTTP requests with routing + auth. */
  handle(request: Request, basePath: string): Promise<Response>
}
```

The old individual methods (`handler.trigger()`, `handler.runs()`, etc.) are removed **both from the TypeScript interface and from the runtime object**. The implementation uses closure-scoped helper functions, not object methods. This ensures auth cannot be bypassed even in plain JavaScript or via TypeScript escape hatches (`as any`).

```ts
// Implementation sketch:
export function createDurablyHandler(durably, options) {
  // Private helpers — NOT exposed on the returned object
  async function handleTrigger(request, ctx) { ... }
  async function handleRun(request, ctx) { ... }
  // ...

  return {
    // Only public method
    async handle(request, basePath) {
      const ctx = await options.auth?.authenticate(request)
      await options.onRequest?.()
      // Route to private helpers
      if (path === '/trigger') return handleTrigger(request, ctx)
      // ...
    }
  }
}
```

For users who need raw access without auth (e.g., internal tooling), they create a separate handler without `auth`.

## Execution Flow

```text
handle(request, basePath)
  |
  +-- auth.authenticate(request)   // authenticate FIRST -> TContext (fail fast)
  +-- onRequest()                  // lazy init (migrations, worker start)
  +-- route by path + method
  |     |
  |     +-- /trigger
  |     |     +-- parse body
  |     |     +-- validate: jobName required, job exists   // validation BEFORE auth hook
  |     |     +-- auth.onTrigger(ctx, validatedBody)       // auth hook receives valid data
  |     |     +-- job.trigger(input, options)
  |     |
  |     +-- /run               -> fetch run -> auth.onRunAccess(ctx, run, { operation: 'read' })
  |     +-- /subscribe         -> fetch run -> auth.onRunAccess(ctx, run, { operation: 'subscribe' })
  |     +-- /steps             -> fetch run -> auth.onRunAccess(ctx, run, { operation: 'steps' })
  |     +-- /retry             -> fetch run -> auth.onRunAccess(ctx, run, { operation: 'retry' })
  |     +-- /cancel            -> fetch run -> auth.onRunAccess(ctx, run, { operation: 'cancel' })
  |     +-- DELETE /run        -> fetch run -> auth.onRunAccess(ctx, run, { operation: 'delete' })
  |     |
  |     +-- /runs              -> parse + validate filter -> auth.scopeRuns(ctx, filter) -> query(filter)
  |     +-- /runs/subscribe    -> parse + validate filter -> auth.scopeRunsSubscribe(ctx, filter) -> stream(filter)
  |     |                         (falls back to scopeRuns if scopeRunsSubscribe not set)
  |     |
  |     +-- 404
  |
  +-- catch
        +-- Response -> return as-is (hooks throw Response to reject)
        +-- Error    -> errorResponse(message, 500)
```

### Query parameter validation

Before passing filter objects to auth hooks, the handler validates and normalizes query parameters:

- `status` — validated against allowed values, invalid → `400`
- `limit`/`offset` — parsed as integers, `NaN` → `400`
- `label.*` — parsed into a typed `labels` object. When `TLabels` is defined via a labels schema, unknown label keys are rejected (validated against the schema). When no labels schema is configured, any `label.*` keys are accepted as `Record<string, string>`.

This ensures `scopeRuns` and `scopeRunsSubscribe` always receive correctly typed, validated filter objects.

## Design Decisions

### 1. `authenticate` + `TContext` generic

`authenticate` returns `TContext`, which is passed as the first argument to all authorization hooks. The name `authenticate` (not `authorize`) is intentional — this hook performs authentication (who is the user?). The subsequent hooks perform authorization (can this user do this action?).

### 2. `auth` as a nested object — `authenticate` required at type level

Auth hooks are grouped under `auth: { authenticate, onTrigger?, onRunAccess?, scopeRuns?, scopeRunsSubscribe? }`. This design:

- Makes `authenticate` structurally required when any auth is configured
- Clearly separates auth config from infrastructure config
- No runtime validation needed — the type system enforces the constraint

### 3. `TLabels` flows from the Durably instance

`createDurablyHandler` infers `TLabels` from the `Durably` instance. All hooks receive correctly typed labels. No casting needed.

### 4. `authenticate` runs before `onRequest`

Unauthenticated requests are rejected immediately without triggering expensive initialization.

### 5. `onTrigger` runs after validation

The handler validates the trigger body (`jobName` required, job exists) **before** calling `onTrigger`. This means:

- `onTrigger` always receives a valid `TriggerRequest` with a real `jobName`
- Invalid requests get proper `400`/`404` errors, not misleading auth errors
- The hook can trust the data it receives

### 6. Response throwing for rejection

Auth rejections are raw `Response` objects (framework-level: redirects, 401, 403). Handler errors use `errorResponse()` (JSON `{ error: string }`). This distinction is intentional.

### 7. `onRunAccess` receives pre-fetched `Run<TLabels>` + operation type

| Operation   | Endpoint         | Semantics            |
| ----------- | ---------------- | -------------------- |
| `read`      | `GET /run`       | Read run details     |
| `subscribe` | `GET /subscribe` | SSE stream for a run |
| `steps`     | `GET /steps`     | List steps           |
| `retry`     | `POST /retry`    | Retry failed run     |
| `cancel`    | `POST /cancel`   | Cancel running run   |
| `delete`    | `DELETE /run`    | Delete run           |

### 8. `scopeRuns` vs `scopeRunsSubscribe` — honest type contracts

List and subscribe have different filter capabilities:

|                  | `GET /runs`          | `GET /runs/subscribe`          |
| ---------------- | -------------------- | ------------------------------ |
| Filter type      | `RunFilter<TLabels>` | `RunsSubscribeFilter<TLabels>` |
| `jobName`        | ✅                   | ✅                             |
| `labels`         | ✅                   | ✅                             |
| `status`         | ✅                   | ❌                             |
| `limit`/`offset` | ✅                   | ❌                             |

`scopeRunsSubscribe` is optional — when not set, `scopeRuns` is used as a fallback (only `jobName` and `labels` are extracted from the result). Most users only need `scopeRuns`.

### 9. Runtime method privacy

Individual handler methods are closure-scoped functions, not properties on the returned object. This ensures auth cannot be bypassed in JavaScript or via TypeScript escape hatches.

### 10. `onTrigger` reads body via clone

Since `onTrigger` needs to inspect the request body before `trigger()` reads it, we use `request.clone().json()`.

## Endpoint Classification

| Category       | Endpoints                                                                                | Hook                                                   |
| -------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Trigger        | `POST /trigger`                                                                          | `auth.onTrigger` (after validation)                    |
| Run-level      | `GET /run`, `GET /subscribe`, `GET /steps`, `POST /retry`, `POST /cancel`, `DELETE /run` | `auth.onRunAccess` (with operation type)               |
| Runs list      | `GET /runs`                                                                              | `auth.scopeRuns`                                       |
| Runs subscribe | `GET /runs/subscribe`                                                                    | `auth.scopeRunsSubscribe` (fallback: `auth.scopeRuns`) |

## Implementation Plan

1. **Restructure handler to use closure-scoped helpers** — `handle()` only public method, runtime privacy
2. **Add query parameter validation/normalization** — status enum check, integer parsing, label schema validation
3. **Add `RunsSubscribeFilter` type** — honest contract for subscription endpoints
4. **Make `TriggerRequest` generic** with `input: unknown`
5. **Refactor `runs()` to accept parsed `RunFilter`** — no URL reconstruction
6. **Add `AuthConfig` type and `auth` option** with `TContext` and `TLabels` generics
7. **Wire hooks into `handle()`** — authenticate → onRequest → validate → auth hook → handler
8. **Tests** — auth rejection, context propagation, filter scoping, operation-based access control, validation-before-auth ordering, runtime bypass prevention

## Impact

- Eliminates ~130 lines of per-path auth boilerplate per app
- New endpoints automatically get auth (no missed paths)
- Type-safe context from authentication to authorization
- Type-safe labels throughout the middleware chain
- Fine-grained access control via operation type
- Honest type contracts (list vs subscribe filters)
- Auth hooks only receive validated, well-typed data
- Impossible to bypass auth — runtime method privacy via closures
- **Breaking change**: individual handler methods removed

## Before / After (upflow)

**Before**: 137 lines in `api.durably.$.ts` + helper functions
**After**: Route handler is 2 lines. ~35 lines of auth config in `durably.server.ts`.

**Migration steps for upflow**:

1. Add labels schema: `createDurably({ dialect, labels: z.object({ organizationId: z.string() }) })`
2. Move `organizationId` from job input to trigger labels at all call sites
3. Replace 137-line route handler with auth config + 2-line handler
