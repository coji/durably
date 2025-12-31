import type { Durably } from '@coji/durably'
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

export interface DurablyProviderProps {
  /**
   * Pre-created Durably instance.
   * The instance should already be migrated and have jobs registered if needed.
   */
  durably: Durably
  /**
   * Whether to automatically call start() after mounting.
   * @default true
   */
  autoStart?: boolean
  /**
   * Callback when Durably instance is ready.
   */
  onReady?: (durably: Durably) => void
  children: ReactNode
}

export function DurablyProvider({
  durably: externalDurably,
  autoStart = true,
  onReady,
  children,
}: DurablyProviderProps) {
  const [durably, setDurably] = useState<Durably | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const instanceRef = useRef<Durably | null>(null)

  useEffect(() => {
    try {
      instanceRef.current = externalDurably

      if (autoStart) {
        externalDurably.start()
      }

      setDurably(externalDurably)
      setIsReady(true)
      onReady?.(externalDurably)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    }
  }, [externalDurably, autoStart, onReady])

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
