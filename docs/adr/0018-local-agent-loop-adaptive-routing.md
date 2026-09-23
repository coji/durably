# ADR-0018: Route local-agent-loop runs by difficulty, with LLM judgement only at fixed decision points

## Status

proposed

## Context

`examples/local-agent-loop` runs every task through one stage graph with one set of role profiles. Real tasks differ. A routine bug fix needs a mid-tier model for implementation and review and nothing more; a risky change may need a trial implementation, a rethink with a stronger model, or a discussion with a person before any more tokens are spent. Running every task on the path a risky task needs wastes money; running a risky task on the routine path wastes iterations and review rounds before it fails.

The goal is cost efficiency and throughput: lower cost per approved change, fewer runs that loop until a cap, and a shorter time to approval, without making runs harder to compare.

Two external data points shape the choice. A difficulty estimate made before any work is often wrong. And the factory already records, per stage, the signals that show a task is harder than it looked: repeated check failures, repeated `needsChanges`, iteration counts, and cost.

## Decision

- **The orchestrator stays code.** The durable job decides which stage runs next. An LLM is consulted only at fixed decision points, and each consultation returns one value from a small, closed set together with a short rationale that is recorded on the run.
- **Few routes, defined as data.** A run follows one of three routes:
  - `routine`: implement, verify and review with mid-tier profiles, as today.
  - `probe`: a trial implementation first, then a judge chooses `continue` (finish on a cheaper implementation profile), `rethink` (redesign with a stronger model before implementing again), or `discuss` (stop on a durable wait until a person has discussed the approach and resumes the run).
  - `escalate`: stop on a durable wait for a person, using the same mechanism as approval.
    Route definitions and the profiles each route uses, including a separate repair profile, live in `factory.json` and are part of `configVersion`, so `demo compare` can compare routes.
- **Start cheap, escalate on evidence.** Triage at intake picks `routine` or `probe`. A run moves to a higher route only on recorded evidence (the verification or review signals above), never by re-asking the triage model.
- **Judge with a cheap model.** Triage and the probe judge use a low-cost profile. Mistakes are caught by escalation rather than by paying for a stronger judge.
- **Measure before routing.** Triage first runs in shadow mode: it records its route and rationale but does not change the path. It starts steering runs only after its misroute rate, measured against run outcomes, is acceptable.
- **Changing models inside a role needs a new session.** A repair profile that differs from the implementation profile starts a fresh session with the task and repair notes, instead of continuing the implementation session.

## Consequences

- Runs gain a recorded route, triage rationale, and escalation history. Reports and `compare` can show cost per approved change, escalation rate, approval rate and time to approval per route.
- Decision points are LLM calls like any other: checkpointed, measured, and subject to the uncertain-call rule.
- `discuss` and `escalate` reuse durable waits, so a run parked for a person costs nothing while it waits and resumes from its checkpoint.
- Adding a route is a data change, but each new route splits the sample that comparisons rely on. New routes wait until the data shows the existing ones are insufficient.
- Work lands in steps: shadow triage first, then routing, then the probe judge and its waits, then repair profiles.

## Rejected Alternatives

### An LLM orchestrator that chooses workflow and models freely

Rejected. It pays a strong model to coordinate even trivial tasks, its choices are not reproducible, and runs stop being comparable because every run may follow a different path.

### Route once at intake with no escalation

Rejected. Up-front difficulty estimates are unreliable, and a misrouted run would loop to its iteration or review cap before anyone noticed.

### A strong model as the triage and probe judge

Rejected for now. The judge runs on every task, so its cost is paid on routine work too. Escalation on evidence covers its mistakes more cheaply. Revisit if shadow-mode data shows a cheap judge misroutes too often.

### Many fine-grained routes from the start

Rejected. Each route needs enough runs to be compared; three routes are what current volume can support.
