/**
 * useDurably hook
 *
 * Manages durably lifecycle in React applications.
 * In the future, this hook will be provided by @coji/durably-react.
 */

import { useEffect, useRef, useState } from 'react'
import { durably } from '../lib/durably'

export type DurablyStatus =
  | 'init'
  | 'ready'
  | 'running'
  | 'resuming'
  | 'done'
  | 'error'

export function useDurably() {
  const [status, setStatus] = useState<DurablyStatus>('init')
  const [currentStep, setCurrentStep] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const userTriggered = useRef(false)
  const refreshDashboardRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let cancelled = false

    const unsubscribes = [
      durably.on('run:start', () => {
        if (!cancelled) {
          setStatus(userTriggered.current ? 'running' : 'resuming')
        }
      }),
      durably.on('step:complete', (e) => {
        if (!cancelled) {
          setCurrentStep(e.stepName)
        }
      }),
      durably.on('run:complete', (e) => {
        if (!cancelled) {
          setResult(JSON.stringify(e.output, null, 2))
          setCurrentStep(null)
          setStatus('done')
          userTriggered.current = false
          refreshDashboardRef.current?.()
        }
      }),
      durably.on('run:fail', (e) => {
        if (!cancelled) {
          setResult(e.error)
          setCurrentStep(null)
          setStatus('error')
          userTriggered.current = false
          refreshDashboardRef.current?.()
        }
      }),
    ]

    durably
      .migrate()
      .then(() => {
        if (!cancelled) {
          durably.start()
          setStatus('ready')
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Durably migration failed:', err)
          setStatus('error')
        }
      })

    return () => {
      cancelled = true
      for (const fn of unsubscribes) fn()
      durably.stop()
    }
  }, [])

  const markUserTriggered = () => {
    userTriggered.current = true
    setStatus('running')
    setCurrentStep(null)
    setResult(null)
  }

  const setRefreshDashboard = (fn: () => void) => {
    refreshDashboardRef.current = fn
  }

  const refreshDashboard = () => {
    refreshDashboardRef.current?.()
  }

  return {
    status,
    currentStep,
    result,
    markUserTriggered,
    setRefreshDashboard,
    refreshDashboard,
    durably,
  }
}
