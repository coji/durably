# ADR-0040: local-agent-loop code reviewers score product-behavior findings and make a low likelihood × impact a non-blocker, with the threshold fixed at trigger

## Status

accepted

## Context

In `examples/local-agent-loop`, a `findings-json` reviewer is told only that a blocker must be fixed before the candidate can pass. Nothing says how serious a problem has to be to block. A verdict reviewer has no field for weight at all: any concern is `needsChanges`.

Issue #315 reports what that costs on artifactshare, where the findings that stopped runs were scored again, by an agent from their text, for how often they would happen and how bad they would be. About three in ten were technically possible but would almost never happen, most of them from verdict reviews, and their share grew with each round: a fix was followed by another unlikely case in the next round. About three in ten of the runs that stopped at the review cap had only such findings left in the last round. And close to two in ten findings said that a fix had broken existing behaviour, so handling unlikely cases also made new bugs.

## Decision

- **`review.blockerThreshold` in `factory.json`, fixed at trigger.** An integer from 0 to 100, 5 when left out; anything else, a fraction, an out-of-range or unsafe number and a non-number included, is refused before the run exists. It is stored in the run input's target, kept in setup, inherited by `retrigger` and by a repair run, and read again only by `--reload-config`, like `selfCheck` and `testProbe`. A run stored before it existed has none, and setup records null for it, so it and its repairs keep reviewing as before and never take the default. The threshold enters `configVersion` whenever a run fixed one, 0 included: runs with different review rules are not one population. A run that fixed none keeps its version.
- **The reviewer classifies.** With a threshold of 1 or more, a `findings-json` code review is told to score each finding about how the product behaves for likelihood (how often it would actually happen) and impact (how bad it is when it does), each an integer from 1 to 10, to add both to the finding, which the rule says it must do for a finding it covers although the reply shape marks both optional, and to make it a non-blocker when their product is below the threshold. At or above it, the reviewer decides as before. Findings that are not about the product's behaviour, such as test sufficiency, a change outside the task's scope, steering and secrets, are judged as before whatever their scores. So is a finding that the change does not do something the task, the spec or the owner's confirmed context explicitly asks for, however rare the case: the rule is for cases nobody asked for, and a stated requirement is not weighed away by its frequency.
- **The parser never reclassifies.** Whether a finding is about the product's behaviour cannot be told from the JSON values, so the parser keeps `severity` as returned and decides the review from the blockers alone, as before. It accepts `likelihood` and `impact` each on its own, and only an integer from 1 to 10; an explicit `null`, 0, 11, a fraction or a non-number makes the reply review-incomplete. A finding without them is still accepted. The `findings-json` reply shape, which spec reviews share, shows both as optional fields and tells the reviewer to leave out a field it has no value for rather than write null. An explicit null still makes the whole reply review-incomplete: the instruction removes the cause, and a malformed reply is not silently repaired.
- **One context for every form of review.** The rule is a line of the review context's CHECK section, so the prompt, the input after a `command`, and the `CLAUDE.local.md` of `local-instructions` all carry it. A threshold of 0 and a `verdict` review get no such line and are reviewed as before. Spec reviews get none either: the rule is not in the reply shape they share with code reviews.
- **The repair from findings is told not to design for rare or future cases nobody asked for.**
- **Report.** The JSON report's kept findings carry the scores they were given and nothing for those without; `reviewBlockerThreshold` gives the threshold the run fixed, null when it fixed none. `reviewBlockerRuleLenses` names the code reviewers the rule reached: with a threshold of 1 or more, those whose output is `findings-json` and that have a recorded review or a review call that was sent. A review cancelled after its call was sent counts, since its prompt carried the rule; one superseded before anything was sent does not. The fact is the one the call already records on its attempt (#325): its `invocationStartedAt`, written as the call is handed to the provider, and a result other than `not-sent`; no new record is added. Whether the provider delivered the prompt and the model read it before the call was stopped is not observed. The Markdown report's header names them with the rule and its exclusion of a stated requirement, and says the rule reached no review when none is recorded, a run whose code reviews are all verdict reviews or that stopped before its first review call was sent included. The scores follow each kept finding's title, in the review highlights too.

## Considered and left as they are (#317)

- **A general requirement as the reason to keep a rare case (R2-O-2).** A task line such as "do not change existing behaviour" could be cited to keep a rare product case a blocker. Unchanged until real runs show it happening.
- **The repair run's FINDINGS block (R2-O-3).** Intended: it is untrusted data, not the task, the spec or the owner's confirmed context, so a finding is not kept out of the rule because the parent's findings asked for it.
- **An exempt low-scored blocker and a misclassified one (R2-O-4).** The report cannot tell them apart; telling them apart needs the reviewer's reason in the reply. Deferred until runs show it matters.
- **Non-blockers handed to the repair beside a failed check (O-3).** The reviews that completed before a check failed still go to the repair without their scores, as findings to weigh against the task and the spec. Left as is: that repair is about the check.
- **A new CLI beside an older worker (O-7).** A repair run can inherit a threshold the parent's worker never used. Accepted: the CLI and the worker of this example are meant to run from one checkout, and the report shows the threshold the repair fixed.
- **Defects an attacker can aim at (O-8).** "How often it would actually happen in real use" can underrate them. Unchanged for now; the wording is revisited if a run shows such a defect scored low.

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
