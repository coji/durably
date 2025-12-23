# Events

Durably provides an event system to monitor job execution.

## Available Events

| Event | Description | Payload |
|-------|-------------|---------|
| `run:start` | Job execution started | `{ runId, jobName, input }` |
| `run:complete` | Job completed successfully | `{ runId, jobName, output }` |
| `run:fail` | Job failed with error | `{ runId, jobName, error }` |
| `step:start` | Step execution started | `{ runId, stepName, stepIndex }` |
| `step:complete` | Step completed | `{ runId, stepName, stepIndex, output }` |
| `step:skip` | Step skipped (cached) | `{ runId, stepName, stepIndex, output }` |
| `log:write` | Log message written | `{ runId, level, message }` |

## Subscribing to Events

Use `durably.on()` to subscribe:

```ts
// Single event
const unsubscribe = durably.on('run:complete', (event) => {
  console.log(`Job ${event.jobName} completed:`, event.output)
})

// Multiple events
durably.on('run:start', (e) => console.log('Started:', e.jobName))
durably.on('run:fail', (e) => console.error('Failed:', e.error))
durably.on('step:complete', (e) => console.log('Step done:', e.stepName))
```

## Unsubscribing

The `on()` method returns an unsubscribe function:

```ts
const unsubscribe = durably.on('run:complete', handler)

// Later...
unsubscribe()
```

## React Integration

Events are useful for updating UI state:

```tsx
function useDurably() {
  const [status, setStatus] = useState<'idle' | 'running' | 'done'>('idle')
  const [currentStep, setCurrentStep] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribes = [
      durably.on('run:start', () => setStatus('running')),
      durably.on('run:complete', () => {
        setStatus('done')
        setCurrentStep(null)
      }),
      durably.on('step:complete', (e) => setCurrentStep(e.stepName)),
    ]

    return () => unsubscribes.forEach((fn) => fn())
  }, [])

  return { status, currentStep }
}
```

## Logging

Use `step.log` within jobs to emit log events:

```ts
import { defineJob } from '@coji/durably'

const myJob = durably.register(
  defineJob({
    name: 'my-job',
    input: z.object({}),
    run: async (step) => {
      step.log.info('Starting processing')

      await step.run('step1', async () => {
        step.log.info('Step 1 details', { someData: 123 })
        return result
      })

      step.log.info('Completed')
    },
  }),
)

// Subscribe to logs
durably.on('log:write', (event) => {
  console.log(`[${event.level}] ${event.message}`)
})
```

## Event-Driven Patterns

### Progress Tracking

```ts
let totalSteps = 5
let completedSteps = 0

durably.on('step:complete', () => {
  completedSteps++
  updateProgressBar(completedSteps / totalSteps * 100)
})
```

### Metrics Collection

```ts
const metrics = {
  jobsCompleted: 0,
  jobsFailed: 0,
  avgDuration: 0,
}

const startTimes = new Map()

durably.on('run:start', (e) => {
  startTimes.set(e.runId, Date.now())
})

durably.on('run:complete', (e) => {
  metrics.jobsCompleted++
  const duration = Date.now() - startTimes.get(e.runId)
  // Update average...
})

durably.on('run:fail', () => {
  metrics.jobsFailed++
})
```
