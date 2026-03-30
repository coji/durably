/**
 * Durably Client Configuration
 *
 * Creates a type-safe Durably client for React components.
 * Uses type-only import from the server — no server code is bundled.
 */

import { createDurably } from '@coji/durably-react'
import type { durably as serverDurably } from './durably.server'

export const durably = createDurably<typeof serverDurably>({
  api: '/api/durably',
})
