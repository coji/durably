import type { Durably } from '@coji/durably'
import {
  Suspense,
  createContext,
  use,
  useContext,
  type ReactNode,
} from 'react'

interface DurablyContextValue {
  durably: Durably
}

const DurablyContext = createContext<DurablyContextValue | null>(null)

export interface DurablyProviderProps {
  /**
   * Durably instance or Promise that resolves to one.
   * The instance should already be initialized via `await durably.init()`.
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
  children,
}: Omit<DurablyProviderProps, 'fallback'>) {
  const durably =
    durablyOrPromise instanceof Promise
      ? use(durablyOrPromise)
      : durablyOrPromise

  return (
    <DurablyContext.Provider value={{ durably }}>
      {children}
    </DurablyContext.Provider>
  )
}

export function DurablyProvider({
  durably,
  fallback,
  children,
}: DurablyProviderProps) {
  const inner = (
    <DurablyProviderInner durably={durably}>{children}</DurablyProviderInner>
  )

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
