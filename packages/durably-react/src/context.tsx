import { createDurably, type Durably, type DurablyOptions } from '@coji/durably'
import type { Dialect } from 'kysely'
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

interface DurablyContextValue {
  durably: Durably | null
  isReady: boolean
  error: Error | null
}

const DurablyContext = createContext<DurablyContextValue | null>(null)

/**
 * Options for DurablyProvider (dialect is provided separately via dialectFactory)
 */
export type DurablyProviderOptions = Omit<DurablyOptions, 'dialect'>

export interface DurablyProviderProps {
  /**
   * Factory function to create a Kysely dialect.
   * Called only once during initialization.
   */
  dialectFactory: () => Dialect
  /**
   * Durably options (pollingInterval, heartbeatInterval, etc.)
   */
  options?: DurablyProviderOptions
  /**
   * Whether to automatically call start() after initialization.
   * @default true
   */
  autoStart?: boolean
  /**
   * Whether to automatically call migrate() during initialization.
   * @default true
   */
  autoMigrate?: boolean
  /**
   * Callback when Durably instance is ready.
   * Useful for testing to track instances.
   */
  onReady?: (durably: Durably) => void
  children: ReactNode
}

export function DurablyProvider({
  dialectFactory,
  options,
  autoStart = true,
  autoMigrate = true,
  onReady,
  children,
}: DurablyProviderProps) {
  const [durably, setDurably] = useState<Durably | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // Use ref to track initialization state for StrictMode safety
  const initializedRef = useRef(false)
  const instanceRef = useRef<Durably | null>(null)

  useEffect(() => {
    // Prevent double initialization in StrictMode
    if (initializedRef.current) {
      // If already initialized, just use the existing instance
      if (instanceRef.current) {
        setDurably(instanceRef.current)
        setIsReady(true)
      }
      return
    }

    initializedRef.current = true
    let cleanedUp = false

    async function init() {
      try {
        const dialect = dialectFactory()
        const instance = createDurably({ dialect, ...options })
        instanceRef.current = instance

        if (cleanedUp) return

        if (autoMigrate) {
          await instance.migrate()
          if (cleanedUp) return
        }

        if (autoStart) {
          instance.start()
        }

        if (cleanedUp) return

        setDurably(instance)
        setIsReady(true)
        onReady?.(instance)
      } catch (err) {
        if (cleanedUp) return
        setError(err instanceof Error ? err : new Error(String(err)))
      }
    }

    init()

    return () => {
      cleanedUp = true
      if (instanceRef.current) {
        instanceRef.current.stop()
      }
    }
  }, [dialectFactory, options, autoStart, autoMigrate, onReady])

  return (
    <DurablyContext.Provider value={{ durably, isReady, error }}>
      {children}
    </DurablyContext.Provider>
  )
}

export function useDurably(): DurablyContextValue {
  const context = useContext(DurablyContext)
  if (!context) {
    throw new Error('useDurably must be used within a DurablyProvider')
  }
  return context
}
