# ADR-0024: Continue the local-agent-loop implementation session when a Claude repair changes only effort

## Status

accepted

## Context

A repair profile that differs from the code profile starts a new session for every repair (ADR-0018 proposes this, and #245 built it). The new session has to read the task, the spec and the code again, and on Claude Code it writes the whole prompt to the cache again. When the repair profile differs from code in effort alone, that cost buys nothing: the provider, the model, the working directory and the instructions are the same.

Claude Code documents that changing the effort level of a resumed session keeps the prompt cache ([prompt caching: changing effort level](https://code.claude.com/docs/en/prompt-caching#changing-effort-level)). A measurement on Claude Code 2.1.280 with Opus agreed: a new session read 0 cache tokens and wrote 45,021; a session resumed with effort changed from medium to high read 43,628, the same as a session resumed at the same effort.

The documentation does not cover every environment. Bedrock and Vertex route requests elsewhere, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` turns off features the behaviour may depend on, older Claude Code builds were not measured, and only Opus 5.5 and Fable 5.1 were checked.

## Decision

- In `--context reuse`, a repair on its own profile continues the implementation session only when all of these hold: the same provider (Claude), the same effective model, a different effective effort, a model that is Opus 5.5 or Fable 5.1, a Claude Code CLI of 2.1.260 or later, and none of `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` set. Anything that cannot be confirmed, such as a CLI version that cannot be read, starts a new session, as before.
- The decision is one pure function of the context mode, the two profiles, the CLI version already recorded for the config version, and the environment. Setup makes it once and records it on the run, so a worker restarted with another environment does not change a run's behaviour.
- Only a run where the decision is to continue adds the policy to its `configVersion`. Every other run keeps the version it had.
- A continued repair passes the recorded native session ID as `resume` and the repair profile's effort as `effort`. The session reference records the model, and the provenance check compares provider, model, working directory and instruction version instead of the profile. A session recorded before the model was stored is never continued across an effort change. The session the repair returns becomes the one on record.
- Every repair call records `continued`, `continued-effort-change` or `fresh` before it is sent, and the report shows that and the call's cache-read ratio (`cacheReadTokens / inputTokens`, null when either is missing or the input is 0) per call.
- Same-profile continuation, Codex, another provider or model, `--context fresh`, and the first repair of a repair run from outside findings are unchanged. Checkpoints, refusals and uncertain calls follow the existing rules; a call that started without a recorded completion is never resent.

## Consequences

- A repair that only raises or lowers effort reads the implementation's context back from the cache instead of rebuilding it, and it keeps the conversation that produced the code.
- The environment check reads environment variables only. When Claude Code is routed by other means, such as settings files or a gateway, the check cannot see it, and the run may continue a session where the cache is not kept. The cost is a cache miss on that repair, not a wrong result, and the per-call cache-read ratio in the report shows it.
- The list of models and the minimum CLI version are code. A newly verified model or build needs a code change.

## Rejected Alternatives

### Continue across any effort change, for every provider and model

Rejected. Only Claude Code is documented and measured to keep the cache, and only on the models and builds listed. Codex does not change effort within a session here.

### Probe the cache at setup with a paid call

Rejected. It spends tokens on every run to learn what the settings already say, and a probe that finds no cache hit cannot tell a cold cache from an unsupported environment.

### Decide at each repair call instead of at setup

Rejected. The environment of the worker that happens to run a repair would then decide how a run behaves, and two repairs of one run could be treated differently.

### Keep starting a new session for every separate repair profile

Rejected. It pays for a full cache write and a re-read of the code on every repair that differs only in effort, with no gain in isolation.
