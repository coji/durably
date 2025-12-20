/**
 * React StrictMode Tests
 *
 * These tests verify that Durably handles React StrictMode's double mount/unmount
 * behavior safely. StrictMode causes:
 * 1. useEffect to run twice (mount → unmount → mount)
 * 2. Potential race conditions with async initialization
 * 3. Cleanup running before initialization completes
 *
 * TODO: Enable after Phase 1 implementation is complete
 */

import { describe, it } from 'vitest'

describe.skip('React StrictMode', () => {
  it.todo('handles double mount/unmount in StrictMode safely')

  it.todo('singleton pattern prevents duplicate initialization')

  it.todo('migrate() is safe when called concurrently')

  it.todo('stop() during migrate() does not cause errors')
})
