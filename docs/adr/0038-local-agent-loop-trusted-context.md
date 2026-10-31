# ADR-0038: local-agent-loop hands confirmed decisions and the factory's own results to every role as trusted context

## Status

accepted

## Context

In `examples/local-agent-loop`, a reviewer's TRUSTED CONTEXT held only what the factory itself produced: the base commit, the candidate and its changed paths. Everything a person supplied (task, spec, `--dispositions-file`, a repair run's findings) went into the prompts as untrusted data, fenced off so that nothing inside it could steer a reviewer. The implementer and the repairer never saw dispositions at all.

That left no way to tell the roles what the owner had already settled. Issue #306 reports a round trip from the artifactshare project: the owner ruled that a certain wiring was allowed, the repairer did not know, reverted it to make the pinned check pass, and a reviewer then stopped the run for undoing the ruling. Writing the ruling into the dispositions did not help: the repairer never received them, and a reviewer may treat a disposition that argues for a verdict as steering.

A planned stage will also run new tests on the base and on the candidate. Its results are produced by the factory, not by the implementer, and reviewers should read them as trusted, both in the prompt and as a file.

## Decision

- **`--context-file <path>` on `trigger` and `repair`, repository runs only.** The file is read once, before the run exists, through the same reader as the other input files: UTF-8, not blank, and at most 32 KiB (32,768 bytes), checked both from the file's size before reading and from the bytes read. A file over the limit, empty, or not UTF-8 is refused and no run is created. The limit is lower than the other inputs' 256 KiB because the context goes into every code, repair and review prompt. The run input stores the content as `target.context` and the file's path as `target.inputFiles.context`; the job schema applies the same byte limit to a stored input. The worker, `retrigger` (with or without `--reload-config`) and the report use the stored content and never read the file again.
- **Repair inherits or replaces it.** `repair --context-file` replaces the parent's context and its path; without it, the child inherits the parent's stored context and path. The child's idempotency key names the SHA-256 of the context the child really gets, so the same parent, findings, dispositions, max iterations and context content return the same child, and different context content makes another child. The key names the context only when there is one, so a child without a context keeps the key it had before this change.
- **A trusted section of its own in every prompt.** The code and repair prompts get an `OWNER CONTEXT (trusted)` section, apart from the untrusted TASK, SPEC, FINDINGS and other data blocks, telling the agent to make no change that goes against the owner's confirmed decisions and, when it judges one would, to leave it and say why under NOTES in its reply. Each reviewer gets the same content inside the TRUSTED CONTEXT, with the instruction that a change keeping to it is not a finding and one going against it is. The block is fenced by a hash of its content, like the untrusted blocks, so it cannot end early. Because every review form, a plain Codex or Claude prompt, a configured command and local instructions, is built from the same `reviewContext`, all of them get the same block.
- **Dispositions are unchanged.** `--dispositions-file` is still read, stored, inherited and replaced by repair as before, and still goes to the reviewers only, as untrusted data. It is never promoted into the trusted context.
- **An internal hook for the factory's own results.** A stage reads a file it produced with `readStageContextFile`, inside its own step, so the content is the step's settled output; a file inside the candidate worktree, which the implementer can change, is refused, links included, as is one over 32 KiB, empty or not UTF-8. `withStageContext(setup, settled)` adds that content to `target.stageContext` with a path for the factory's own copy under the run directory (`stage-context/<name>.txt`), outside the worktree, and returns the setup to rebuild the target from, as the spec stages' advice and the check's notes already are. Before each review round the target writes every copy again from the stored content, so a copy changed or removed since is put back; the copies' paths are added to every reviewer's `readableFiles`, and their directory to a command-mode reviewer's readable directories. The review's TRUSTED CONTEXT shows each result in its own block with the copy's path. Only reviewers get stage results; nothing calls the hook yet.
- **The report shows what the prompts were given.** The JSON report's `inputs.context` holds the path, the SHA-256 computed from the stored content, and the content. The Markdown report lists it with the other inputs and prints the content in its own section, in a code fence longer than any run of backticks in it, so the owner's Markdown cannot read as a heading of the report. The web UI shows the content under the inputs. A run without a context, or stored before it existed, reports `null` and runs as before.

## Consequences

- The owner can tell the implementer, the repairer and the reviewers what is settled, and the repairer is told not to undo it rather than discovering it in a review.
- The context is trusted by construction, so what goes into it is the owner's responsibility. The size limit keeps it to decisions and results rather than documents.
- A future stage that runs tests on the base and the candidate needs only to read its result inside its step and pass the settled output to `withStageContext`; replays and worker restarts give the reviewers the same content and the same readable copy.
- Every report, JSON and Markdown, carries one more input entry and section; fixtures that build a report by hand name `context`.

## Rejected Alternatives

### Promote dispositions to trusted context

Rejected. Dispositions record how earlier findings were settled, often in the implementer's or the orchestrator's words, and reviewers already read them as expected but untrusted input. Making them trusted would change how every existing run's dispositions are read, and would let any argument written into them steer a reviewer.

### Read the context file again at each call

Rejected. A file edited during the run would change what later calls see, and a report could not say what any call was given. Fixing the content at trigger, as the other input files are, keeps the run reproducible from its stored input.

### Register a stage's file by path

Rejected. A path can name a file the implementer can change, or one that changes or disappears between the stage and a review retried after a worker restart. Registering only the settled content, and having the factory write its own copy, makes the reviewers' trusted input depend on the stored record alone.

### Give stage results to the implementer and the repairer too

Rejected for now. The issue asks for them in the reviewers' TRUSTED CONTEXT and readable files, and the results a stage produces judge the candidate, which is the reviewers' task. The hook can be extended once a stage needs the implementer to see one.
