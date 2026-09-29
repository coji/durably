# ADR-0027: Let the local-agent-loop web UI act on runs through the CLI's functions

## Status

accepted

## Context

The local-agent-loop web UI (`demo ui`) has been read-only since it was added. It serves `127.0.0.1` only, answers `GET` and `HEAD`, refuses every other method with 405, and opens the state database read-only. Every action a run needs, approving or rejecting a candidate, deciding on a blocked spec, starting a run again, is shown as a command to copy and run in a terminal.

Issue #262 found that this keeps the page from doing its main job. Its top section, runs that need a person, fills up with runs nobody will act on: runs abandoned days ago, and repair runs already replaced by a sibling. They stay because the page cannot clear them, and the person who could clear them has to switch to a terminal for each one. The owner of the factory checks the page a few times a day; the page should let them finish what it shows them.

Writing from a browser changes two things the read-only design settled by construction. A page on another site can send requests to `127.0.0.1`, so a write endpoint needs a defense against cross-site requests, which a read-only one did not. And a second write path beside the CLI could drift from it: a run approved from the page must end up exactly as one approved from the terminal.

Clearing a run from the top section also needs a place to record it. The obvious place, a Durably run label, is not available: Durably fixes a run's labels when the run is triggered and offers no way to change them afterwards.

The work landed in three pull requests. #263 split the UI into components and a design system, #264 redesigned the screens, and #265 added the writes and completed the decision.

## Decision

- **Stop being read-only.** The web UI may approve and reject a candidate, decide on a blocked spec (`approve`, `spec-revise` with notes typed on the page, `reject`), start a stopped run again, and archive or unarchive a stopped run. Nothing else is written: no editing of `factory.json`, inputs or stored steps, no triggering of new tasks, and no cancelling.
- **One write path, shared with the CLI.** Each action calls the same function in `src/actions.ts` as its `demo` subcommand (`decideRun`, `reviseSpec`, `retriggerRun`, `archiveRun`, `unarchiveRun`); the CLI and the server are two callers of it. The UI adds no write of its own and no shortcut around the checks the CLI makes: a decision must answer the pending wait the run is suspended on, bound to the candidate or spec version its metadata names, and a retrigger must be safe to repeat. Where the CLI reads a file, the shared function takes the content, and reading the file stays in the CLI: `spec-revise` takes the notes, not a path. Every action on the page shows the equivalent CLI command beside it. Rejecting and archiving ask for confirmation first, and approving asks too, with the review highlights in the question. The result of each action is shown as a notice, with the CLI's own message when it is refused; the next refresh shows the run where it now belongs.
- **A token and the Origin on every write.** The server keeps listening on `127.0.0.1` only and keeps its Host check. It makes a random token when it starts and embeds it in the page it serves; it never logs it and sets no cookie. A write is `POST /api/runs/<id>/<action>` carrying the token in the `x-loop-ui-token` header and an `Origin` header naming the server's own loopback origin, as the Host header names it; a wrong Host, token or Origin is refused with 403, and any other method with 405, before any function runs. Reads stay `GET` and `HEAD` only.
- **Writes without a worker.** The server opens the database with the same writable instance the CLI uses, once the database exists, and migrates it before its first write as the CLI does. It never calls `init()` and never takes the worker lock, so a decision or a retrigger waits for the worker the person runs, as it does from the terminal. Before the database exists, every view is empty and nothing is created.
- **Archive state is files under the state root.** Archiving a run writes a small file for it under `archived/` in the state root, and unarchiving removes it. Only a run that has stopped for good, completed, failed or cancelled, can be archived; a run waiting on a decision is decided instead. Archiving never changes the run's status, steps or waits, so it keeps its diagnosis and unarchiving restores it without loss. `groupTasks` counts an archived stopped run as finished, so its task leaves the top section unless another of its runs still needs a person, and the finished list shows it with a quiet mark and a way back. `demo archive` and `demo unarchive` do the same from the terminal, and `demo status` and the page both read these files through the same grouping, so a run archived in one place is cleared in both.
- **Re-running from the page uses the stored input only.** The page's re-run is `retrigger` without `--reload-config`: a new run with the input the stopped run stored, refused when the stop is not safe to repeat. Reading `factory.json` again stays a CLI action, because it depends on a file the person has just edited, and a page cannot show what changed in it.

## Consequences

- The top section of the run list can be kept to runs that need a decision, and a person can act on them without leaving the page.
- The UI server gains a write surface. Its defense is the loopback listener, the Host check, the per-process token and the Origin check together; a page on another site can neither read the token nor set the Origin. A process on the same machine that can read the page can still write, as it could already run the CLI. The tests send real HTTP requests for each refusal: no token, a wrong token, no Origin, a foreign Origin, a wrong Host, and a read method on a write path.
- Every write the page makes is one the CLI can make with the same result, so tests of the shared functions cover both callers, and the page's own tests only need to cover the token, the Origin and the wiring.
- Archive state lives outside the database, so it is not copied with the database and is not visible to other Durably readers. Deleting the state root's archive files un-archives every run, and nothing else is lost.

## Rejected Alternatives

### Stay read-only and keep copying commands

Rejected. It is what #262 set out to change: the page shows runs it cannot clear, and every decision costs a switch to a terminal.

### A write path of the UI's own

Rejected. A second implementation of approving or re-running would have to repeat every check the CLI makes and would drift from it. One function with two callers keeps the result the same by construction.

### Store the archive state as a run label

Rejected. Durably sets a run's labels at trigger and cannot change them afterwards, so a label cannot record a decision made later.

### Store the archive state in a new database table

Rejected. The factory's database schema belongs to Durably; a table of the example's own would need its own migration beside Durably's, for a piece of state that a directory of small files holds without one.

### Cookies or `SameSite` alone against cross-site writes

Rejected. The server has no session to put in a cookie, and loopback origins on different ports are same-site to each other, so `SameSite` would not keep out another local page. An explicit token with an Origin check does not depend on either.

### Re-run with the configuration read again from the page

Rejected. It depends on a file the person has just edited outside the page, and the page cannot show that change or its version before it acts. The CLI keeps it.
