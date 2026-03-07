# Design: Ambient Agent Concepts

## Goal

This document describes a concrete product image for ambient agents as an extension on top of Durably's core runtime.

It is not a runtime specification. Its purpose is to clarify:

- what an ambient agent is in general
- which responsibilities belong to the agent layer
- which kinds of applications are a natural fit

## Working Definition

An ambient agent is a durable, event-driven worker that stays attached to an ongoing human task or business object over time.

It is not primarily a chat interface.

Its defining property is continuity:

- it observes changes in its environment
- it wakes up when needed
- it produces drafts, recommendations, alerts, or actions
- it can pause, resume, and hand work back to humans safely

From the user's perspective, it behaves less like "an AI you ask questions" and more like "an invisible operator that keeps carrying the task forward."

## What Makes It "Ambient"

An ambient agent is usually ambient in five senses:

1. It is event-driven rather than prompt-driven.
2. It is attached to a long-lived session rather than a single request.
3. It can execute multiple runs over time for the same task.
4. It appears only when useful, instead of requiring constant user interaction.
5. It must preserve continuity across reloads, restarts, retries, and failover.

This means ambient agents are typically built around:

- durable sessions
- resumable execution
- append-only event streams
- approval or interruption points
- explicit auditability

## Core Model

For product design purposes, the useful abstraction is:

- `Session`: the continuity boundary for an ongoing task
- `Run`: one triggered execution slice for that session
- `Step`: one resumable unit of work inside a run
- `Event`: the durable record of user-visible or operational state changes
- `Artifact`: a durable output the user or system can consume
- `Approval`: a human decision point before irreversible action

In this model:

- a session is usually tied to a business object or work thread
- a run is created by a trigger such as a webhook, schedule, threshold, or user action
- an artifact is something concrete such as a draft, score, summary, recommendation, or update

## What Ambient Agents Are Not

Not every agent or workflow is ambient.

These are usually not ambient agents:

- a single synchronous chat completion
- a one-shot batch job with no ongoing state
- a request-response assistant that disappears after answering
- a workflow that does not need continuity, replay, or human handoff

Those use cases may still fit the Durably core runtime, but they do not require an ambient agent layer.

## Why Durably Fits

Durably is a plausible substrate for ambient agents because the hard part is not just model invocation.

The hard part is runtime continuity:

- waking on events
- claiming execution safely
- surviving worker failure
- resuming from checkpoints
- preserving user-visible progress
- recovering state after reconnect or refresh

That makes the ambient layer a natural extension on top of:

- leased runs
- resumable step execution
- durable checkpoints
- durable event streams

## Application Pattern

The most natural applications are object-centered rather than chat-centered.

The UI primary key is not "conversation." It is usually a business object:

- CRM segment, campaign, or account
- candidate, requisition, or hiring pipeline
- pull request, repository, or engineering team

The agent follows that object over time and contributes work products around it.

## Example 1: CRM / Customer Lifecycle Agent

### Session Shape

The session is attached to a customer account, segment, campaign cycle, or analysis thread.

### Typical Triggers

- new purchase or engagement data arrives
- a segment changes materially
- campaign results are updated
- a monthly planning cycle begins
- a human requests a deeper recommendation

### Typical Artifacts

- updated segment hypotheses
- anomaly alerts
- recommended customer cohorts to focus on
- draft campaign ideas
- draft reports for account managers

### Why It Is Ambient

This agent does not need to chat constantly.

Its value is that it keeps following customer behavior and quietly updates the next-best actions. A human reviews and acts when needed.

## Example 2: HR / ATS Companion Agent

### Session Shape

The session is attached to a candidate, requisition, interview loop, or hiring case.

### Typical Triggers

- a candidate advances or stalls
- interview notes or transcripts are added
- a recruiter opens a candidate page
- a deadline is approaching with no next action
- offer preparation begins

### Typical Artifacts

- interview summaries
- screening rule suggestions
- missing-information alerts
- draft recruiter comments
- draft offer or candidate communication

### Why It Is Ambient

Hiring is long-lived, approval-heavy, and operationally sensitive.

The useful agent is one that quietly tracks the case, prepares the next artifacts, and surfaces only the moments that need recruiter or hiring-manager judgment.

## Example 3: Development Productivity Agent

### Session Shape

The session is attached to a pull request, repository, team, or engineering initiative.

### Typical Triggers

- pull request events arrive from webhooks
- review latency crosses a threshold
- a scheduled weekly analysis starts
- release or deployment state changes
- a human asks for an explanation of a trend

### Typical Artifacts

- cycle-time explanations
- stuck-review alerts
- weekly summaries
- suspected bottleneck analysis
- draft retrospectives

### Why It Is Ambient

Developers usually do not want to talk to an assistant about process all day.

They want the right signals and drafts to appear at the right time, backed by durable analysis that survives retries and backfills.

## Shared Product Traits Across These Domains

These examples share the same structure:

- the main object already exists in the product
- the object changes over time
- those changes create triggers
- the agent produces artifacts around the object
- a human remains the final authority for important actions

This is why "invisible AI" is a better mental model than "chatbot."

The agent should usually be embedded into the existing product flow rather than introduced as a separate conversational destination.

## Boundary of the Ambient Layer

The ambient layer should own:

- session lifecycle
- run-to-session association
- durable event persistence and replay
- snapshot policy for fast recovery
- approval and interruption hooks

The ambient layer should not define all higher-level intelligence concerns.

Those may remain pluggable:

- planner strategy
- model choice
- retrieval and memory policy
- domain-specific tools
- UI presentation details

## Design Heuristic

A use case is likely a good fit for an ambient agent layer if most of the following are true:

- the task spans hours, days, or weeks
- the task can be re-entered multiple times
- multiple triggers can wake the same task
- users need durable progress or audit history
- the system should prepare work before the user explicitly asks
- the final action still benefits from human review

If these properties are absent, the simpler job runtime is usually enough.
