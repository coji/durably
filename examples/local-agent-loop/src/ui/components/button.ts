/**
 * The two button looks. Neither carries a color: the primary one is set in
 * ink, the secondary one in the page's own surface with a line around it.
 */
const BASE =
  'inline-flex min-h-8 items-center gap-2 rounded-md border px-3 text-xs transition-colors duration-(--duration-fast) ease-out disabled:cursor-not-allowed disabled:opacity-50'

export const BUTTON = `${BASE} border-line-strong bg-raised text-fg-2 enabled:hover:text-fg`

export const BUTTON_PRIMARY = `${BASE} border-transparent bg-fg text-inverse font-medium enabled:hover:bg-fg/85`
