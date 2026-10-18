# Repeating the fullstack Shannon audit

This workflow scans the committed examples/fullstack app and its Durably dependencies. It follows the isolated audit completed on 2026-10-18. The example deliberately exposes its job API without login; a finding about missing authentication in this shared demo does not, by itself, establish a library vulnerability.

## Prerequisites

- Node.js 24.21.0 and pnpm 12.4.2, as declared by this repository.
- Docker running locally.
- Pi 1.2.0 or later, installed as pi, with an existing ChatGPT OAuth login. Check it with the command below; the result must be ready.
- Access to gpt-6-sol for cyber security work through that account.
- A clean, committed checkout. The workflow rejects staged, unstaged, and untracked files.
- A trusted local network while validation runs. Its temporary HTTP response endpoint listens on the host only during preflight.

```bash
pi auth check --provider openai-codex
```

The scanner build is pinned to Keygraph Shannon commit 2468b67d9e40d70d0b189462c5041c24e1dc886c (Shannon 3.4.0). A checked-in patch pins its three Pi worker packages to 1.2.0 and fixes Shannon's pnpm lockfile. Setup applies the patch, installs with a frozen lockfile, and builds under ~/.cache/durably-shannon/. Each run checks the source patch and installed worker versions before starting. The host Pi CLI may be 1.2.0 or later; its actual version and the worker version are recorded separately. Setup does not change this repository.

## Commands

From the repository root:

    pnpm security:scan:setup
    pnpm security:scan:validate
    pnpm security:scan:fullstack --output "$HOME/.shannon/assessments/fullstack-$(date +%Y%m%d-%H%M%S)"

Use a new absolute output directory for every run. It must be outside this checkout, including through symlinks. To inspect or clean up a run, pass that same directory:

    pnpm security:scan:status --output /absolute/path/to/assessment
    pnpm security:scan:down --output /absolute/path/to/assessment

The down command is idempotent and can recover resources left by a killed terminal or host interruption. The state.json file records the exact resource names. It never removes resources outside that run's names. A failed install or build can be retried at the same Shannon directory when its source still matches the pinned patch. If using an already built checkout of the pinned Shannon revision and patch, pass --shannon-dir /absolute/path to setup, validate, and run.

## What the run does

1. Checks Pi and the pinned Shannon build, then runs Shannon's model and cyber access validation against a temporary benign HTTP endpoint. It stops before creating the audit target or database if validation fails.
2. Records the repository HEAD, requires a clean checkout, and makes a detached local Git clone at that exact commit. The clone supplies Git HEAD to Shannon's agentic SAST. Working-tree files, local .env files, and ignored databases are not included.
3. Builds the app from the clone. The target runs as a non-root user in a read-only container with a fresh SQLite database on a disposable volume. The app initializes its schema there; no production data is copied in. An internal Docker network has no outbound route. A TCP proxy on Shannon's shannon-net is the only scanner entry point to the target.
4. Runs the five-class Shannon scan with exploit enabled, openai:gpt-6-sol, and the rules in scripts/shannon-fullstack/shannon-config.yaml. The target URL is filled from a generated resource name; the command accepts no alternate target URL.
5. Stops the app before the final SQLite copy, checks database integrity, records per-table counts and created run IDs, copies the main and static-analysis reports, and removes the run's containers, network, volume, image, and temporary source clone.

The rules ask for fewer than three requests per second, minimal benign proofs, and no brute force, denial of service, persistence, external callbacks, or exfiltration. Those text rules do not enforce a technical traffic limit. The Docker network and synthetic database provide the hard isolation. The scanner itself retains model-provider access.

## Results and failure handling

The output directory contains metadata.json, state.json, the rendered scanner config, shannon-status.json, before.sqlite, after.sqlite, JSON integrity/schema/count summaries and a diff, workflow.log for operator stage transitions, shannon-workflow.log with scanner payload details omitted, and reports/. The report directory must contain:

- Security-Assessment-Report.md and .pdf
- report.sarif for exploit-confirmed findings
- Static-Analysis-Report.md and static-analysis.sarif for source-level leads

Source-level leads are not exploit-confirmed findings. A scan with no exploit candidates may skip its exploitation phase. The workflow fails when Shannon reports partial, failed, cancelled, or any unknown terminal state, or when a required phase or artifact is missing. It also fails on an invalid SQLite copy, while still attempting cleanup. A failed run keeps any reports and database copies obtained before the failure; inspect state.json and workflow.log, then use security:scan:down if needed.

The completed 2026-10-18 baseline and its synthetic before/after databases are stored outside this repository at ~/.shannon/assessments/durably-fullstack-2026-10-18/. That scan finished with zero exploit-confirmed findings and nine separate static-analysis leads. This workflow does not change application routes, jobs, or Durably's public API.
