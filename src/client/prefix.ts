/**
 * Request-prefix change detection.
 *
 * DeepSeek reuses a cached prefix: once the system prompt or the tool catalog
 * differs from the previous request, everything after the change is re-billed.
 * Cores from 0.2 expose both sides of that comparison — the current request
 * header's canonical prompt and the previous prompt it replaced — so this module
 * only has to read the two tool catalogs and name what moved.
 */

/** One tool's name plus its stable content, read structurally. */
interface ToolLike {
  readonly name?: unknown
  readonly description?: unknown
  readonly parameters?: unknown
}

/** Named differences between two tool catalogs. */
export interface ToolChange {
  /** Tools the current request added. */
  readonly added: readonly string[]
  /** Tools the previous request had and the current one dropped. */
  readonly removed: readonly string[]
  /** Tools present in both, with different description or parameters. */
  readonly changed: readonly string[]
}

/** Whether a change record carries anything worth showing. */
export function isEmptyToolChange(change: ToolChange): boolean {
  return change.added.length === 0 && change.removed.length === 0 && change.changed.length === 0
}

/** Stable per-tool content signature: name is the key, so only the payload is hashed. */
function toolSignature(tool: ToolLike): string {
  return JSON.stringify([tool.description ?? null, tool.parameters ?? null])
}

/** Index one catalog by tool name, keeping the first occurrence of a duplicate. */
function indexTools(tools: readonly ToolLike[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object') continue
    const name = tool.name
    if (typeof name !== 'string' || name === '') continue
    if (!index.has(name)) index.set(name, toolSignature(tool))
  }
  return index
}

/**
 * Name what changed between the previous and the current tool catalog.
 *
 * A tool added or removed shifts every following tool's position in the prompt,
 * so both matter equally; a tool whose description or parameter schema changed
 * keeps its name but still rewrites the catalog.
 *
 * @param previous - tools of the prompt this request replaced, when available.
 * @param current - tools the current request sent.
 * @returns added, removed and changed tool names.
 */
export function diffTools(previous: readonly unknown[] | undefined, current: readonly unknown[]): ToolChange {
  const currentTools = indexTools(current as readonly ToolLike[])
  if (previous === undefined) {
    return { added: [...currentTools.keys()], removed: [], changed: [] }
  }
  const previousTools = indexTools(previous as readonly ToolLike[])
  const added: string[] = []
  const changed: string[] = []
  for (const [name, signature] of currentTools) {
    const before = previousTools.get(name)
    if (before === undefined) added.push(name)
    else if (before !== signature) changed.push(name)
  }
  const removed: string[] = []
  for (const name of previousTools.keys()) if (!currentTools.has(name)) removed.push(name)
  return { added, removed, changed }
}

/** How many names one segment may list before it summarizes the rest. */
const MAX_NAMES = 3

/** One `~+name` / `~-name` / `~±name` marker, with the remainder summarized. */
function listNames(added: readonly string[], removed: readonly string[], changed: readonly string[]): string[] {
  const markers = [
    ...added.map((name) => `~+${name}`),
    ...removed.map((name) => `~-${name}`),
    ...changed.map((name) => `~±${name}`),
  ]
  if (markers.length <= MAX_NAMES) return markers
  const rest = markers.length - MAX_NAMES
  return [...markers.slice(0, MAX_NAMES), `~+${rest} more`]
}

/**
 * Render one tool change as a bracketed segment, or undefined when nothing moved.
 *
 * @param change - named differences from {@link diffTools}.
 * @returns the segment text, e.g. `(~+agent_team · ~-dsh_job)`.
 */
export function formatToolChange(change: ToolChange): string | undefined {
  if (isEmptyToolChange(change)) return undefined
  return `(${listNames(change.added, change.removed, change.changed).join(' · ')})`
}
