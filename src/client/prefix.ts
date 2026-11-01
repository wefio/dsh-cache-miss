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
 *
 * A tool catalog change is the one cause a reader can act on, so this module also
 * names the tools that moved — but only where the name is news. The chat already
 * renders the core's own tool-registry message ("Tool added: …") for a catalog
 * whose membership changed, so repeating those names on the notice line would
 * duplicate a row that is already on screen; only a tool whose *schema* changed
 * under an unchanged name has no other notice anywhere.
 */

/** Classification cores publish for one request header. */
export type PrefixChangeKind = 'system' | 'tools' | 'system-and-tools'

/** Reader-facing words for one change, plus the tools that moved when naming them is news. */
export interface PrefixChange {
  /** What moved, in words: `tools`, `system prompt + tools`, plus `config`. */
  readonly words: string
  /** Which tools moved, e.g. `+preset_ops`; absent when the chat already shows the move. */
  readonly tools?: string
}

/** One tool catalog transition between two consecutive requests. */
export interface ToolMove {
  /** Tool names that entered the catalog. */
  readonly added: readonly string[]
  /** Tool names that left it. */
  readonly removed: readonly string[]
  /** Tools that stayed but whose own schema changed. */
  readonly changed: readonly string[]
}

/**
 * One tool schema, as much of it as this module reads: the core's `ToolSchema`
 * satisfies this structurally, and the whole object is what a schema change is
 * compared over.
 */
export interface ToolSchemaLike {
  readonly name: string
  readonly description?: string
  readonly parameters?: unknown
  readonly deferLoading?: true
}

/** Most tool names one notice line spells out; past this, the line reports counts. */
const MAX_NAMED_TOOLS = 2

/**
 * Misses a Turn must reach before a catalog the chat already reported is named
 * again on the notice line.
 *
 * A Turn that misses once is the ordinary case: the catalog change has its own
 * row, and the line stays short. A Turn that misses twice is not — something is
 * churning, and repeating the names where the money is becomes worth it. At 1 the
 * latch never suppresses; it is a display threshold, not a switch for the diff.
 */
export const TOOL_MOVE_LATCH = 2

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
 * The words are reader-facing ("system prompt", not the classifier's `system`):
 * a bare enum in the line reads like a token bucket instead of a cause. The tool
 * names are attached separately, by {@link toolMoveDetail}, because whether they
 * are news depends on what else the chat already shows for that Step.
 *
 * @param kind - classification from {@link prefixChangeKind}.
 * @param configChanged - whether the canonical request config differs.
 * @returns a change such as `tools`, `config`, or `system prompt + tools + config`.
 */
export function prefixChangeLabel(
  kind: PrefixChangeKind | undefined,
  configChanged: boolean,
): PrefixChange | undefined {
  const parts: string[] = []
  if (kind === 'system' || kind === 'system-and-tools') parts.push('system prompt')
  if (kind === 'tools' || kind === 'system-and-tools') parts.push('tools')
  if (configChanged) parts.push('config')
  return parts.length === 0 ? undefined : { words: parts.join(' + ') }
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
 * Identify what moved between two tool catalogs.
 *
 * Names are compared first, so the common case — a plugin or MCP server
 * registering or dropping tools — costs one map of names and never reads a
 * schema body. A schema comparison only runs when the core has already said the
 * catalog moved and the name sets match, which is the sole way to see a tool
 * whose definition was rewritten under the same name (a plugin upgrade
 * mid-session) and costs one serialization of the catalog.
 *
 * A transition that both renames and rewrites is reported as the membership
 * change it is: the catalog already moved, and a name that arrived is news
 * enough without also serializing every tool that survived it.
 *
 * @param before - catalog the previous request carried.
 * @param after - catalog this request carries.
 * @param compareSchemas - whether the core classified this request's catalog as
 *   changed; without that, equal name sets mean the catalog is unchanged.
 * @returns the move, or undefined when the catalog is unchanged.
 */
export function toolCatalogChange(
  before: readonly ToolSchemaLike[],
  after: readonly ToolSchemaLike[],
  compareSchemas: boolean,
): ToolMove | undefined {
  const was = new Map(before.map((tool) => [tool.name, tool]))
  const now = new Set(after.map((tool) => tool.name))
  const added = [...now].filter((name) => !was.has(name))
  const removed = [...was.keys()].filter((name) => !now.has(name))
  if (added.length > 0 || removed.length > 0) return { added, removed, changed: [] }
  if (!compareSchemas) return undefined
  const changed = after
    .filter((tool) => JSON.stringify(was.get(tool.name)) !== JSON.stringify(tool))
    .map((tool) => tool.name)
  return changed.length === 0 ? undefined : { added: [], removed: [], changed }
}

/** What the notice line already knows about this Step when it decides to name tools. */
export interface ToolMoveDisplay {
  /** Misses this Turn has recorded up to and including the one being rendered. */
  readonly turnMisses: number
  /** Whether the core logged its own tool-registry message for this Step. */
  readonly announced: boolean
}

/**
 * Render one catalog move for the notice line, or nothing when naming it would
 * only repeat what the chat already shows.
 *
 * The suppression covers membership changes only: the core logs those as a
 * tool-registry message that the chat renders as its own row, so the names are
 * already on screen and the notice line states the cause without repeating them.
 * A schema change under an unchanged name has no such row, so it is always named.
 * The Turn's miss count decides the rest — see {@link TOOL_MOVE_LATCH}.
 *
 * @param move - catalog transition from {@link toolCatalogChange}, when known.
 * @param display - the Step's Turn miss count and whether the core announced it.
 * @returns names or counts such as `+preset_ops`, `+8 -1`, or undefined to say
 *   only that tools changed.
 */
export function toolMoveDetail(
  move: ToolMove | undefined,
  display: ToolMoveDisplay,
): string | undefined {
  if (move === undefined) return undefined
  const schemaOnly = move.added.length + move.removed.length === 0
  if (!schemaOnly && display.announced && display.turnMisses < TOOL_MOVE_LATCH) return undefined
  const entries = labelEntries(move)
  if (entries.length <= MAX_NAMED_TOOLS) return entries.join(', ')
  const counts: string[] = []
  if (move.added.length > 0) counts.push(`+${move.added.length}`)
  if (move.removed.length > 0) counts.push(`-${move.removed.length}`)
  if (move.changed.length > 0) counts.push(`~${move.changed.length}`)
  return counts.join(' ')
}

/**
 * Every name in one move, for the console record of a miss.
 *
 * The line caps itself at {@link MAX_NAMED_TOOLS} entries because a catalog flip
 * can move dozens of tools; the console is where the complete list belongs.
 *
 * @param move - catalog transition, when known.
 * @returns `+a, -b, ~c`, or undefined when nothing moved.
 */
export function formatToolMove(move: ToolMove | undefined): string | undefined {
  if (move === undefined) return undefined
  const entries = labelEntries(move)
  return entries.length === 0 ? undefined : entries.join(', ')
}

function labelEntries(move: ToolMove): string[] {
  return [
    ...move.added.map((name) => `+${name}`),
    ...move.removed.map((name) => `-${name}`),
    ...move.changed.map((name) => `~${name}`),
  ]
}

/**
 * Render one prefix change as its line segment.
 *
 * The segment says what moved instead of echoing the classifier's enum. No `~`
 * here: nothing about a change is an estimate.
 *
 * @param change - change from {@link prefixChangeLabel}, with any tool names attached.
 * @returns `(tools changed)`, `(tools changed: +preset_ops)`, and the like.
 */
export function formatPrefixChange(change: PrefixChange): string {
  const detail = change.tools === undefined ? '' : `: ${change.tools}`
  return `(${change.words} changed${detail})`
}
