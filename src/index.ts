import type {} from '@deepseek-ai/cordis'

/** Node-half entry. The cache-miss surface is browser-only; this half exists
 * so the package loads as a valid plugin and ships the client bundle. */
export const name = 'dsh-cache-miss'

export function apply(): void {
  // No host-side behavior: the conversation node and renderer run in the browser half.
}
