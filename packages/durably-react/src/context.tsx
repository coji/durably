import type { Durably } from '@coji/durably'
import {
  Suspense,
  createContext,
  use,
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
   * Durably instance or Promise that resolves to one.
   * The instance should already be migrated and have jobs registered if needed.
   *
   * When passing a Promise, wrap the provider with Suspense or use the fallback prop.
   *
   * @example
   * // With Suspense (recommended)
   * <Suspense fallback={<Loading />}>
   *   <DurablyProvider durably={durablyPromise}>
   *     <App />
   *   </DurablyProvider>
   * </Suspense>
   *
   * @example
   * // With fallback prop
   * <DurablyProvider durably={durablyPromise} fallback={<Loading />}>
   *   <App />
   * </DurablyProvider>
   */
  durably: Durably | Promise<Durably>
  /**
   * Whether to automatically call start() after mounting.
   * @default true
   */
  autoStart?: boolean
  /**
   * Callback when Durably instance is ready.
   */
  onReady?: (durably: Durably) => void
  /**
   * Fallback to show while waiting for the Durably Promise to resolve.
   * This wraps the provider content in a Suspense boundary automatically.
   */
  fallback?: ReactNode
  children: ReactNode
}

/**
 * Internal component that uses the `use()` hook to resolve the Promise
 */
function DurablyProviderInner({
  durably: durablyOrPromise,
  autoStart = true,
  onReady,
  children,
}: Omit<DurablyProviderProps, 'fallback'>) {
  // Resolve Promise using React 19's use() hook
  const resolvedDurably =
    durablyOrPromise instanceof Promise
      ? use(durablyOrPromise)
      : durablyOrPromise

  const [durably, setDurably] = useState<Durably | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const instanceRef = useRef<Durably | null>(null)

  useEffect(() => {
    try {
      instanceRef.current = resolvedDurably

      if (autoStart) {
        resolvedDurably.start()
      }

      setDurably(resolvedDurably)
      setIsReady(true)
      onReady?.(resolvedDurably)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    }
  }, [resolvedDurably, autoStart, onReady])

  return (
    <DurablyContext.Provider value={{ durably, isReady, error }}>
      {children}
    </DurablyContext.Provider>
  )
}

export function DurablyProvider({
  durably,
  autoStart = true,
  onReady,
  fallback,
  children,
}: DurablyProviderProps) {
  const inner = (
    <DurablyProviderInner
      durably={durably}
      autoStart={autoStart}
      onReady={onReady}
    >
      {children}
    </DurablyProviderInner>
  )

  // If fallback is provided, wrap in Suspense
  if (fallback !== undefined) {
    return <Suspense fallback={fallback}>{inner}</Suspense>
  }

  return inner
}

export function useDurably(): DurablyContextValue {
  const context = useContext(DurablyContext)
  if (!context) {
    throw new Error('useDurably must be used within a DurablyProvider')
  }
  return context
}
