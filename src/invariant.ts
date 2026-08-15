/**
 * Package invariant companion. Registered with the DSH invariant registry by
 * the host composition; this plugin adds no runtime-side invariant because it
 * has no host-side behavior — all state lives in the browser conversation
 * projection.
 */
export const name = 'dsh-cache-miss/invariant'

export function apply(): void {
  // Intentionally empty: no host runtime invariant for a browser-only node.
}
