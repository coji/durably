// Vitest globals are off, so Testing Library cannot register its automatic
// cleanup. Without it every rendered hook stays mounted into later tests,
// where it keeps subscribing to runs and mock event sources.
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})
