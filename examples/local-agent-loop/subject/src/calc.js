/** Tiny subject for the local agent loop demo.
 * Intentional bug: add() drops the fractional part via Math.trunc.
 * The agent task is to fix add() so decimal inputs work.
 */
export function add(a, b) {
  return Math.trunc(a) + Math.trunc(b)
}

export function mul(a, b) {
  return a * b
}
