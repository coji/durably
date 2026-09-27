# ADR-0024: Continue the local-agent-loop implementation session when a Claude repair changes only effort

## Status

accepted

## Context

A repair profile that differs from the code profile starts a new session for every repair (ADR-0018 proposes this, and #245 built it). The new session has to read the task, the spec and the code again, and on Claude Code it writes the whole prompt to the cache again. When the repair profile differs from code in effort alone, that cost buys nothing: the provider, the model, the working directory and the instructions are the same.

Claude Code documents that changing the effort level of a resumed session keeps the prompt cache ([prompt caching: changing effort level](https://code.claude.com/docs/en/prompt-caching#changing-effort-level)). A measurement on Claude Code 2.1.280 with Opus agreed: a new session read 0 cache tokens and wrote 45,021; a session resumed with effort changed from medium to high read 43,628, the same as a session resumed at the same effort.

The documentation names Claude Code 2.1.260 as the first build with this behaviour. The orchestrator's measurement ran on 2.1.280; builds from 2.1.260 to 2.1.279 were not measured and are accepted on the documentation's word. `claude-opus-5-5` itself needs 2.1.280 or later.

The documentation does not cover every environment. Bedrock and Vertex route requests elsewhere, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` turns off features the behaviour may depend on, and only Opus 5.5 and Fable 5.1 were checked.

Claude Code resolves a model alias such as `opus` itself. The provider passes the requested name through, so the effective model a profile records is `opus`, not the model that runs. Only the CLI knows that: on 2.1.280, its `init` message reports `claude-opus-5-5` for `opus`, while the AI SDK's `response.modelId` echoes `opus` and the result's `modelUsage` also lists the Haiku model the CLI uses internally.

## Decision

- In `--context reuse`, a repair on its own profile continues the implementation session only when all of these hold: the same provider (Claude), a different effective effort, one concrete model reported by Claude Code for both profiles, that model being Opus 5.5 or Fable 5.1, a Claude Code CLI of 2.1.260 or later, and none of `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` set. Anything that cannot be confirmed, such as a CLI version that cannot be read or a model the CLI did not report, starts a new session, as before.
- The decision has two pure steps, both over recorded step outputs, so a worker restarted with another environment does not change a run's behaviour:
  - Setup decides everything but the model from the context mode, the two profiles, the CLI version already recorded for the config version, and the environment, and records it on the run. Two full model ids (`claude-*`) are judged here, since Claude Code runs a full id as written. A decision to continue carries no model yet.
  - After preflight, the job confirms it with the model each profile's minimal call reported (the `init` message's `model`). Preflight always makes that call for Claude, since Claude Code has no free check. Both must report one model, and it must be Opus 5.5 or Fable 5.1; otherwise the repair starts new. `opus` and `opus`, or `opus` and `claude-opus-5-5`, continue when both report `claude-opus-5-5`.
- Only a run whose setup decision is to continue adds the policy to its `configVersion`. Every other run keeps the version it had. A setting with an alias cannot be judged at setup, so it carries the policy even when preflight then finds the model unlisted.
- A continued repair passes the recorded native session ID as `resume` and the repair profile's effort as `effort`. The implementation and repair sessions record the confirmed model, and the provenance check compares provider, that model, working directory and instruction version instead of the profile. A session recorded without a model, missing or null, is never continued across an effort change: it starts new. The session the repair returns becomes the one on record.
- Every repair call records `continued`, `continued-effort-change` or `fresh` before it is sent, and the report shows that and the call's cache-read ratio (`cacheReadTokens / inputTokens`, null when either is missing or the input is 0) per call.
- Same-profile continuation, Codex, another provider or model, `--context fresh`, and the first repair of a repair run from outside findings are unchanged. Checkpoints, refusals and uncertain calls follow the existing rules; a call that started without a recorded completion is never resent.

## Consequences

- A repair that only raises or lowers effort reads the implementation's context back from the cache instead of rebuilding it, and it keeps the conversation that produced the code.
- The environment check reads environment variables only. When Claude Code is routed by other means, such as settings files or a gateway, the check cannot see it, and the run may continue a session where the cache is not kept. The cost is a cache miss on that repair, not a wrong result, and the per-call cache-read ratio in the report shows it.
- The list of models and the minimum CLI version are code, in the Claude provider module. A newly verified model or build needs a code change. There is no alias table: what an alias runs is always read from the CLI.
- Every Claude run already pays for one minimal preflight call per distinct setting, so reading the reported model costs nothing more.

## Rejected Alternatives

### Continue across any effort change, for every provider and model

Rejected. Only Claude Code is documented and measured to keep the cache, and only on the models and builds listed. Codex does not change effort within a session here.

### Probe the cache at setup with a paid call

Rejected. It spends tokens on every run to learn what the settings already say, and a probe that finds no cache hit cannot tell a cold cache from an unsupported environment.

### Resolve aliases with a table in the code

Rejected. Which model `opus` runs changes with Claude Code builds and accounts, so a table would go stale without notice. The CLI reports the model it runs, and preflight already asks it.

### Decide at each repair call instead of at setup

Rejected. The environment of the worker that happens to run a repair would then decide how a run behaves, and two repairs of one run could be treated differently.

### Keep starting a new session for every separate repair profile

Rejected. It pays for a full cache write and a re-read of the code on every repair that differs only in effort, with no gain in isolation.
