/** Run statuses that never change again. No imports, so the page can use it. */
export const TERMINAL_STATUSES: readonly string[] = [
  'completed',
  'failed',
  'cancelled',
]
