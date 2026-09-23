# Subject

Small buggy ES module used as the agent's working material.

- `src/calc.js` — `add()` intentionally truncates decimals via `Math.trunc`.
- `test/calc.test.js` — `node:test` suite; the decimal case fails until fixed.
- Run locally: `npm test` (which runs `node --test test/*.test.js`).

The demo copies this directory into
`~/.local/state/local-agent-loop/runs/<runId>/work/` (execution-only
directory, outside the checkout). The agent edits only that copy; this template stays pristine.
