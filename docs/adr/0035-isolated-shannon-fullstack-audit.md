# ADR-0035: Run Shannon against a committed, isolated fullstack example

## Status

accepted

## Context

The first Shannon audit of `examples/fullstack` required manual setup: a source snapshot, an isolated app and SQLite database, a network bridge for the scanner, model validation, and cleanup. That setup is difficult to repeat and easy to run against the wrong source or a live service. Shannon's agentic SAST also needs Git HEAD; an archive-only snapshot caused that phase to fail in a later analysis attempt. Attack validation can write to the target, so a production database is unsuitable.

## Decision

Provide a repository command for the fullstack example. It validates Pi OAuth and model/cyber access first, requires a clean committed checkout, and uses a shallow local Git clone at that commit as the scanner and image-build source. The target runs in a read-only container with a disposable SQLite volume on an internal Docker network. A TCP proxy attached to Shannon's network exposes only the target. A fixed, exploit-enabled rules file defines the permitted host and test limits. The command saves structured status, reports, sanitized logs, and before/after database evidence outside the repository. It fails on partial or failed phases and removes its own Docker resources on completion, failure, or interruption.

## Consequences

The audit is repeatable without changing the public library API or example behavior. It requires Docker, a pinned Shannon source build, Pi OAuth, and cyber access. The scanner can still choose requests that do not obey its natural-language rules; the isolated target and synthetic database contain the resulting effects. A full run may take tens of minutes and consume model allocation. The command does not make a security claim about deployments with authentication or tenant boundaries.

## Rejected Alternatives

- Scan a production or deployed example: this could affect real runs and data during exploit validation.
- Use an archive without Git metadata: Shannon's agentic SAST fails its repository-HEAD check.
- Use a full local clone: it exposes unnecessary history to the scanner and increases the source footprint.
- Depend only on rules-of-engagement text for containment: those instructions do not enforce network or data isolation.
- Put generated reports in the feature branch: they contain run-specific evidence and would make the code diff noisy.
