# ADR-0031: local-agent-loop self checks are prompt-only, and the iteration cap is 5

## Status

accepted

## Context

A repository run of `examples/local-agent-loop` grades each candidate only with its pinned check, and every failed check costs a repair iteration: a new agent call that reads the check output, edits, and waits for the whole check again. In an artifactshare run (issue #282), a repair iteration went to an unused export that a lint run of a few seconds would have caught before the candidate was sealed. The agent could have found it itself if it had been told which quick commands the repository has.

The same issue asked for a higher `--max-iterations` limit. The limit was 1 to 3, with a default of 2. No record gives a reason for 3.

## Decision

- **An optional `selfCheck` in `factory.json`.** It is a list of 1 to 5 commands. Each command is a non-empty argv array of non-empty strings, following `check`'s rules; a flag cannot set it. A malformed list, an empty one or more than 5 commands are refused when the config is loaded, before the run exists.
- **Fixed at trigger like every other setting.** The value is stored in the run input, carried into the setup's target config, and read from there on every replay. A plain `retrigger` keeps it, `--reload-config` reads the file again, and a `demo repair` child inherits its parent's recorded value, absence included, without reading the current config (ADR-0022).
- **A prompt rule, nothing else.** When the setting is present, the repository target adds one rule to the implementation and repair prompts: before finishing, run each listed command in the worktree and fix what it reports. Each command is shown in backticks on its own line, as its argv joined with spaces, the way the grading command is shown. The rule says they are quick checks that the grading command also covers, and that only the grading command judges the run. When the setting is absent, the prompts are unchanged. The factory never runs these commands: there is no new stage, retry loop or iteration, and candidates are graded by the pinned check alone.
- **Part of `configVersion`.** The configured commands change what the agent is told, so they enter the hash. An absent setting leaves the hash input as it was, so existing runs keep their version.
- **`--max-iterations` accepts 1 to 5.** The default stays 2. The trigger flag, the stored-input schema and the documentation use the same range. The former cap of 3 had no recorded rationale; 5 still bounds what one run can spend. A repair child's inherited limit keeps counting its own repairs only.

## Consequences

- An agent can catch a quick lint or type error before its candidate is sealed, without the factory adding any work, stage or measurement.
- Whether the agent runs the commands is up to the agent. The factory does not check that it did, and a candidate that fails those commands but passes the grading command is still approved.
- Two runs that differ only in their `selfCheck` commands are compared as different configurations.
- A run may use up to 5 implementation and repair iterations, with the cost that implies. The default is unchanged.

## Rejected Alternatives

### A factory-run pre-check stage

A stage after each code or repair call would run the `selfCheck` commands itself and, on failure, feed the output back to the same agent session without consuming an iteration. Rejected. It would need session resumption for each provider, including the cases where a repair runs on another profile and starts a new session, a second budget for these inner rounds so a run cannot loop, and its own recovery and replay rules for a stage that sits between a call and the sealing of its candidate. The agent gets most of the same effect by running the commands in the session it already has. This can be revisited if runs show that agents skip the rule.

### Keep the cap at 3

Rejected. Nothing recorded why 3 was chosen, and a run that is close to passing had no way to use a fourth repair short of a new `demo repair` child. The cap stays as a cost guard, at 5.
