/**
 * Prompt-prefix change reporting.
 *
 * DeepSeek bills every token after the first byte that differs from the cached
 * prefix, and a request header states exactly what the model-visible prompt is:
 * the system prompt, the tool catalog, and the sampling config. Cores from 0.2
 * already compare consecutive headers and classify the change, so this plugin
 * reports that classification instead of re-implementing the comparison — the
 * smaller the surface we borrow from the core, the less a future core change can
 * break a notice line.
 */

/** Classification cores publish for one request header. */
export type PrefixChangeKind = 'system' | 'tools' | 'system-and-tools'

/** Changes that describe nothing a reader can act on. */
const UNREPORTED: ReadonlySet<string> = new Set(['initial', 'none', ''])

/**
 * Read the core's change classification, keeping only the three kinds the line
 * reports. Anything else (the first loaded header, an absent change) means the
 * prefix the reader cares about did not move.
 *
 * @param kind - `change.kind` from the core's request-header inspection.
 */
export function prefixChangeKind(kind: unknown): PrefixChangeKind | undefined {
  if (typeof kind !== 'string') return undefined
  if (kind === 'system' || kind === 'tools' || kind === 'system-and-tools') return kind
  return UNREPORTED.has(kind) ? undefined : undefined
}

/**
 * Render one prefix change as its line segment.
 *
 * @param kind - classification from {@link prefixChangeKind}.
 * @returns `(~tools)`, `(~system)` or `(~system+tools)`.
 */
export function formatPrefixChange(kind: PrefixChangeKind): string {
  return `(~${kind})`
}
