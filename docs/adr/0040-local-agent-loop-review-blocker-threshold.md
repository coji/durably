# ADR-0040: local-agent-loop code reviewers score product-behavior findings and make a low likelihood × impact a non-blocker, with the threshold fixed at trigger

## Status

accepted

## Context

In `examples/local-agent-loop`, a `findings-json` reviewer is told only that a blocker must be fixed before the candidate can pass. Nothing says how serious a problem has to be to block. A verdict reviewer has no field for weight at all: any concern is `needsChanges`.

Issue #315 reports what that costs on artifactshare, where the findings that stopped runs were scored again, by an agent from their text, for how often they would happen and how bad they would be. About three in ten were technically possible but would almost never happen, most of them from verdict reviews, and their share grew with each round: a fix was followed by another unlikely case in the next round. About three in ten of the runs that stopped at the review cap had only such findings left in the last round. And close to two in ten findings said that a fix had broken existing behaviour, so handling unlikely cases also made new bugs.

## Decision

- **`review.blockerThreshold` in `factory.json`, fixed at trigger.** An integer from 0 to 100, 5 when left out; anything else, a fraction, an out-of-range or unsafe number and a non-number included, is refused before the run exists. It is stored in the run input's target, kept in setup, inherited by `retrigger` and by a repair run, and read again only by `--reload-config`, like `selfCheck` and `testProbe`. A run stored before it existed has none, and setup records null for it, so it and its repairs keep reviewing as before and never take the default. The threshold enters `configVersion` whenever a run fixed one, 0 included: runs with different review rules are not one population. A run that fixed none keeps its version.
- **The reviewer classifies.** With a threshold of 1 or more, a `findings-json` code review is told to score each finding about how the product behaves for likelihood (how often it would actually happen) and impact (how bad it is when it does), each an integer from 1 to 10, to add both to the finding, and to make it a non-blocker when their product is below the threshold. At or above it, the reviewer decides as before. Findings that are not about the product's behaviour, such as test sufficiency, a change outside the task's scope, steering and secrets, are judged as before whatever their scores. So is a finding that the change does not do something the task, the spec or the owner's confirmed context explicitly asks for, however rare the case: the rule is for cases nobody asked for, and a stated requirement is not weighed away by its frequency.
- **The parser never reclassifies.** Whether a finding is about the product's behaviour cannot be told from the JSON values, so the parser keeps `severity` as returned and decides the review from the blockers alone, as before. It accepts `likelihood` and `impact` each on its own, and only an integer from 1 to 10; an explicit `null`, 0, 11, a fraction or a non-number makes the reply review-incomplete. A finding without them is still accepted.
- **One context for every form of review.** The rule is a line of the review context's CHECK section, so the prompt, the input after a `command`, and the `CLAUDE.local.md` of `local-instructions` all carry it. A threshold of 0 and a `verdict` review get no such line and are reviewed as before. Spec reviews get none either: the rule is not in the reply shape they share with code reviews.
- **The repair from findings is told not to design for rare or future cases nobody asked for.**
- **Report.** The JSON report's kept findings carry the scores they were given and nothing for those without; `reviewBlockerThreshold` gives the threshold the run fixed, null when it fixed none. The Markdown report shows the threshold in its header and the scores beside each kept finding's title.

## Consequences

- An unlikely product finding no longer starts a repair round by itself, and runs stop less often at the review cap on findings of that kind.
- Reviews that are not about the product's behaviour keep the weight they had: an unscored missing test still blocks.
- The scores are the reviewer's judgement. The report keeps them, so a threshold can be tuned from what the runs actually show.
- A run that wants weighted findings uses `findings-json`; a verdict review is unchanged.

## Rejected Alternatives

### Let the parser turn a low-scored blocker into a non-blocker

Rejected. The parser cannot tell a product-behaviour finding from a finding about tests, scope, steering or secrets, so it would demote findings the rule does not cover. A reviewer that says blocker means blocker.

### Apply the rule to verdict reviews

Rejected. A verdict has no field for the scores, and changing its output is a different decision. A review that wants the rule switches to `findings-json` in `factory.json`.

### Read the threshold from `factory.json` in the worker

Rejected. A run's review rules would change under it with the file. Fixing it at trigger keeps every round, retry and repair on the rules the run started with.
