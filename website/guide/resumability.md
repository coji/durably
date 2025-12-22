# Resumability

Durably's core feature is automatic job resumption. This page explains how it works.

## How It Works

### Step Persistence

Every `step.run()` call creates a checkpoint:

```ts
// Step 1: Result persisted to SQLite
const users = await step.run('fetch-users', async () => {
  return await api.fetchUsers()  // Takes 5 seconds
})

// Step 2: If crash happens here...
await step.run('process-users', async () => {
  await processAll(users)  // Crash!
})

// Step 3: Never reached
await step.run('notify', async () => {
  await sendNotification()
})
```

### On Resume

When the job restarts:

```ts
// Step 1: Returns cached result instantly (no API call)
const users = await step.run('fetch-users', async () => {
  return await api.fetchUsers()  // Skipped!
})

// Step 2: Re-executes from the beginning
await step.run('process-users', async () => {
  await processAll(users)  // Runs again
})

// Step 3: Runs normally
await step.run('notify', async () => {
  await sendNotification()
})
```

## Heartbeat Mechanism

Durably uses heartbeats to detect abandoned jobs:

```ts
const durably = createDurably({
  dialect,
  heartbeatInterval: 5000,   // Update heartbeat every 5 seconds
  staleThreshold: 30000,     // Consider stale after 30 seconds
})
```

### How It Works

1. Running jobs update their `heartbeat_at` timestamp periodically
2. Worker checks for stale jobs (no heartbeat update for `staleThreshold` ms)
3. Stale jobs are reset to `pending` and picked up again

### Browser Tab Handling

In browsers, tabs can be suspended. When the tab becomes active:

1. The heartbeat resumes
2. If the job was marked stale, it restarts from the last checkpoint

## Idempotency

Steps should be designed to be safely re-runnable:

### Good: Idempotent Operations

```ts
// Using upsert instead of insert
await step.run('save-user', async () => {
  await db.upsertUser(user)  // Safe to retry
})

// Checking before action
await step.run('send-email', async () => {
  const sent = await db.wasEmailSent(userId)
  if (!sent) {
    await sendEmail(user)
    await db.markEmailSent(userId)
  }
})
```

### Caution: Non-Idempotent Operations

```ts
// Be careful with operations that can't be safely repeated
await step.run('charge-card', async () => {
  // Use idempotency keys with payment providers
  await stripe.charges.create({
    amount: 1000,
    idempotency_key: `charge_${orderId}`,
  })
})
```

## Partial Step Completion

If a step crashes mid-execution, the entire step is re-run:

```ts
await step.run('process-items', async () => {
  for (const item of items) {
    await processItem(item)  // Crash after 50 items
  }
  // On resume: ALL items are processed again
})
```

For large operations, consider breaking into smaller steps:

```ts
// Better: Process in batches
for (let i = 0; i < items.length; i += 100) {
  await step.run(`batch-${i}`, async () => {
    const batch = items.slice(i, i + 100)
    for (const item of batch) {
      await processItem(item)
    }
  })
}
```
