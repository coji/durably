/**
 * Mock EventSource for testing SSE connections
 */

import type { DurablyEvent } from '@coji/durably'

export interface MockEventSourceInstance {
  url: string
  readyState: number
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: Event) => void) | null
  close: () => void
}

export interface MockEventSourceController {
  instances: MockEventSourceInstance[]
  emit: (event: Partial<DurablyEvent>) => void
  triggerError: (error: Error) => void
  triggerOpen: () => void
}

export type MockEventSourceConstructor = (new (
  url: string,
) => MockEventSourceInstance) &
  MockEventSourceController

export function createMockEventSource(opts?: {
  onClose?: () => void
}): MockEventSourceConstructor {
  const instances: MockEventSourceInstance[] = []

  function MockEventSource(
    this: MockEventSourceInstance,
    url: string,
  ): MockEventSourceInstance {
    this.url = url
    this.readyState = 0 // CONNECTING
    this.onopen = null
    this.onmessage = null
    this.onerror = null

    this.close = () => {
      this.readyState = 2 // CLOSED
      opts?.onClose?.()
    }

    instances.push(this)

    // Simulate async open
    queueMicrotask(() => {
      this.readyState = 1 // OPEN
      if (this.onopen) {
        this.onopen(new Event('open'))
      }
    })

    return this
  }

  // Static properties for controller
  Object.defineProperty(MockEventSource, 'instances', {
    get: () => instances,
  })

  Object.defineProperty(MockEventSource, 'emit', {
    value: (event: Partial<DurablyEvent>) => {
      const latestInstance = instances[instances.length - 1]
      if (latestInstance?.onmessage) {
        const messageEvent = new MessageEvent('message', {
          data: JSON.stringify(event),
        })
        latestInstance.onmessage(messageEvent)
      }
    },
  })

  Object.defineProperty(MockEventSource, 'triggerError', {
    value: (error: Error) => {
      const latestInstance = instances[instances.length - 1]
      if (latestInstance?.onerror) {
        const errorEvent = new Event('error')
        Object.defineProperty(errorEvent, 'message', { value: error.message })
        latestInstance.onerror(errorEvent)
      }
    },
  })

  Object.defineProperty(MockEventSource, 'triggerOpen', {
    value: () => {
      const latestInstance = instances[instances.length - 1]
      if (latestInstance?.onopen) {
        latestInstance.onopen(new Event('open'))
      }
    },
  })

  // Add CONNECTING, OPEN, CLOSED constants
  Object.defineProperty(MockEventSource, 'CONNECTING', { value: 0 })
  Object.defineProperty(MockEventSource, 'OPEN', { value: 1 })
  Object.defineProperty(MockEventSource, 'CLOSED', { value: 2 })

  return MockEventSource as unknown as MockEventSourceConstructor
}
