# Agent Factory

Run a long-lived coding-agent workflow locally while keeping its progress, measurements, and approval state recoverable. The example drives a logged-in Codex or Claude Code CLI through implementation, verification, two independent reviews, and delivery.

**Example code:** [local-agent-loop](https://github.com/coji/durably/tree/main/examples/local-agent-loop)

## Why Make an Agent Run Durable?

A coding-agent run can outlive the process that started it. The worker might be restarted after implementation, during a review, or while waiting for a person to approve the result. Repeating completed work wastes time, and blindly resending an LLM request can pay twice for a call that already completed outside the process.

The example records each workflow boundary in SQLite. It also wraps every LLM invocation with its own start and completion checkpoints. After recovery, a saved completion is reused. If only the start checkpoint exists, the factory reports an uncertain external invocation and stops instead of automatically sending the request again. This avoids assuming that Durably can prove whether an external CLI finished in the crash window.

## Durably Features Used

| Feature                                                    | Role in the factory                                                                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`step.run()`](/api/step#run)                              | Persists policy decisions, implementation, verification, delivery, and other named stage results so completed work replays.                                      |
| [`step.all()`](/api/step#all)                              | Runs the correctness and edge-case reviews concurrently in independent agent sessions, then joins their persisted results.                                       |
| [Durable external waits](/api/step#durable-external-waits) | `prepareWait()` creates the approval address, `waitFor()` suspends without occupying a worker slot, and `signal()` resumes the same run with the human decision. |
| [Step attempts](/api/create-durably#getstepattempts)       | Records per-attempt timing, model settings, token usage, cost estimates, invocation identity, and interruption state.                                            |
| [Leases](/api/create-durably#options)                      | An expired worker lease lets another worker reclaim the run and replay its saved steps after a process dies.                                                     |

The candidate under review is sealed before verification. A repair creates a new candidate, invalidating earlier tests, reviews, and approval, so every stage refers to the same version of the work.

## Choose a Target

The factory can work on two kinds of target:

- The bundled, deliberately broken `subject/` project provides a repeatable task for comparing model placements and run configurations. Each run keeps one resolved provider, model, and effort profile fixed, so repeat the same subject under each configuration you want to compare.
- A real repository issue or task runs in a new Git worktree and delivers either a patch or, with `--publish`, a draft pull request.

## Run the Bundled Subject

Install the repository dependencies, check the example, and make sure the provider CLI you plan to use is logged in:

```bash
pnpm install
pnpm --filter example-local-agent-loop typecheck
pnpm --filter example-local-agent-loop test:unit

codex --version
codex login

# Or use Claude Code
claude --version
claude auth login
```

Start the worker in one terminal:

```bash
pnpm --filter example-local-agent-loop demo worker
```

Trigger the bundled subject in another terminal, then inspect and approve its durable wait:

```bash
pnpm --filter example-local-agent-loop demo trigger \
  --provider codex --context reuse --max-iterations 2

pnpm --filter example-local-agent-loop demo status   # every run that needs attention, with the next command
pnpm --filter example-local-agent-loop demo status --run <runId>
pnpm --filter example-local-agent-loop demo waits --run <runId>
pnpm --filter example-local-agent-loop demo approve --run <runId> --wait <waitId>
pnpm --filter example-local-agent-loop demo report --run <runId> --format md
```

Use `--provider claude` to run the same workflow through Claude Code. Use `reject` instead of `approve` to reject a candidate.

To compare context placement while keeping the subject and model fixed, run both configurations and compare their reports:

```bash
pnpm --filter example-local-agent-loop demo trigger \
  --provider codex --context reuse --model gpt-5.6-sol --effort medium

pnpm --filter example-local-agent-loop demo trigger \
  --provider codex --context fresh --model gpt-5.6-sol --effort medium

pnpm --filter example-local-agent-loop demo compare \
  --runs <runA>,<runB>,<runC>,<runD> --format md
```

## Run a Real Repository Issue

Keep the worker running, then trigger a repository target. The check is fixed before the agent starts and runs without a shell:

```bash
pnpm --filter example-local-agent-loop demo trigger \
  --provider codex --repo ~/progs/myapp --issue 234 \
  --check "pnpm validate" --setup "pnpm install --frozen-lockfile"
```

To avoid repeating the check, setup command, base ref, and per-role models on every trigger, put them in a `factory.json` at the repository root and pass only the task, for example `--repo ~/progs/myapp --task-file ~/work/task.md`. Flags such as `--check` still override the file.

By default, the result is written to `~/.local/state/local-agent-loop/runs/<runId>/delivery/<candidate>.patch`, and the status and report show the branch and commit it was cut from. Add `--publish` to push the generated branch and create a draft pull request. A repository target does not pause for approval by default because the draft pull request is the human review boundary; add `--approve manual` when a durable approval wait is required. You can also replace `--issue 234` with `--task "..."`.

## Layout and Porting

| Layer          | Responsibility                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/engine/`  | Repository-independent invocation recovery, measurement, candidate handling, child processes, and reporting. |
| `src/factory/` | The code, verify, review, approve, finish, and stop workflow.                                                |
| `src/targets/` | Target-specific worktree or directory setup, grading, sealing, review context, and delivery.                 |

When moving the factory, keep the engine and factory layers intact and adapt the target layer and local wiring. See the example's [porting guide](https://github.com/coji/durably/blob/main/examples/local-agent-loop/docs/porting.md) for the complete checklist.
