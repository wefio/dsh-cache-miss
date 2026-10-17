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
 *
 * The classifier names system and tool changes only, yet the same canonical
 * config is compared too: a provider or sampling switch starts a different cache
 * namespace and re-bills the whole prompt, so a miss whose only difference is
 * config would otherwise be reported without a cause.
 */

/** Classification cores publish for one request header. */
export type PrefixChangeKind = 'system' | 'tools' | 'system-and-tools'

/**
 * Reportable change label: the kind's own words joined with `+`, plus `config`
 * when the request header's config moved as well, e.g. `tools+config`.
 */
export type PrefixChangeLabel = string

/**
 * Read the core's change classification, keeping only the three kinds the line
 * reports. Anything else (the first loaded header, an absent change) means the
 * prefix the reader cares about did not move.
 *
 * @param kind - `change.kind` from the core's request-header inspection.
 */
export function prefixChangeKind(kind: unknown): PrefixChangeKind | undefined {
  return kind === 'system' || kind === 'tools' || kind === 'system-and-tools' ? kind : undefined
}

/**
 * Build the label from the core's classification and the config comparison.
 *
 * @param kind - classification from {@link prefixChangeKind}.
 * @param configChanged - whether the canonical request config differs.
 * @returns a label such as `tools`, `config`, or `system+tools+config`.
 */
export function prefixChangeLabel(
  kind: PrefixChangeKind | undefined,
  configChanged: boolean,
): PrefixChangeLabel | undefined {
  const parts = kind === undefined ? [] : kind.split('-and-')
  if (configChanged) parts.push('config')
  return parts.length === 0 ? undefined : parts.join('+')
}

/**
 * Order-insensitive JSON text for one config object, so two headers are compared
 * by value rather than by serialization order.
 *
 * @param config - canonical request config, structurally.
 */
export function configSignature(config: unknown): string {
  return JSON.stringify(sortValue(config))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, sortValue(record[key])]),
    )
  }
  return value
}

/**
 * Render one prefix change as its line segment.
 *
 * @param label - label from {@link prefixChangeLabel}.
 * @returns `(~tools)`, `(~system+tools+config)` and the like.
 */
export function formatPrefixChange(label: PrefixChangeLabel): string {
  return `(~${label})`
}
