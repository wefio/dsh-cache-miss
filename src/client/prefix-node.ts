import type {
  ConversationNodeContext, ConversationNodeDefinition, ConversationPromptSnapshot, RequestPromptInspection,
  SystemPromptState,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  configSignature, prefixChangeKind, prefixChangeLabel, toolCatalogChange,
  type PrefixChange, type ToolMove,
} from './prefix'

/** What the notice line knows about one Step's request before it renders. */
export interface StepPrefix {
  /** Reader-facing words for what the prefix moved, when it moved at all. */
  readonly change: PrefixChange | undefined
  /** Catalog transition behind a tool-caused change, when this core exposes one. */
  readonly move: ToolMove | undefined
  /** Whether the core logged its own tool-registry message for this Step. */
  readonly announced: boolean
}

/**
 * Latest prefix facts per Turn:step, keyed `turn:step`.
 *
 * The notice renderer cannot read another Definition's Context, so this small
 * registry is the hand-off: the header and tool-registry Definitions write, the
 * keyed Chat node reads by its own `turn`/`step`. Entries are bounded because a
 * long page load would otherwise keep one record per request forever.
 */
const steps = new Map<string, StepPrefix>()

/** Upper bound on retained records; the map is a cache, not a log. */
const MAX_RECORDS = 500

/**
 * Read one Step's prefix facts, when any Definition recorded them.
 *
 * @param turn - Turn the Step belongs to.
 * @param step - Step inside that Turn.
 */
export function readStepPrefix(turn: number, step: number): StepPrefix | undefined {
  return steps.get(`${turn}:${step}`)
}

/** Merge a patch into one Step's facts, dropping the oldest records past the bound. */
function writeStepPrefix(key: string, patch: Partial<StepPrefix>): void {
  const prior = steps.get(key)
  steps.delete(key)
  steps.set(key, { change: undefined, move: undefined, announced: false, ...prior, ...patch })
  while (steps.size > MAX_RECORDS) {
    const oldest = steps.keys().next().value
    if (oldest === undefined) break
    steps.delete(oldest)
  }
}

/** Canonical prompt interpretation supplied by the uiConversation service. */
export type PromptInspector = (
  previous: ConversationPromptSnapshot | undefined,
  event: SessionEvent<'request/header'>,
  system: unknown,
) => RequestPromptInspection

/** System-prompt interpretation supplied by the uiConversation service. */
export type SystemInspector = (previous: SystemPromptState | undefined, event: SessionEvent) => SystemPromptState

/** Turn:step key from one resolved Match location, when it names a step. */
function stepKeyOf(location: unknown): string | undefined {
  const record = location as { kind?: unknown; turn?: { turn?: unknown }; step?: { step?: unknown } }
  if (record === null || typeof record !== 'object' || record.kind !== 'step') return undefined
  const turn = record.turn?.turn
  const step = record.step?.step
  return typeof turn === 'number' && typeof step === 'number' ? `${turn}:${step}` : undefined
}

/** Retained request-header state: the canonical prompt this request sent. */
interface HeaderState {
  /** Canonical prompt in force for this request. */
  readonly prompt: ConversationPromptSnapshot
}

/**
 * Definition retaining the effective system prompt.
 *
 * The header inspector needs the system prompt in force to tell a system change
 * from a tool change, and the core hands out `inspectSystemPrompt` for exactly
 * that interpretation — so this Definition stores the core's own answer rather
 * than rebuilding prompt semantics from raw messages.
 *
 * @param inspect - `uiConversation.inspectSystemPrompt`.
 */
export function createSystemPromptDefinition(inspect: SystemInspector): ConversationNodeDefinition<SystemPromptState> {
  return {
    kind: 'cache-miss-system',
    target: 'chat',
    match: (event) => {
      const record = event as { type?: unknown; surfaceOp?: unknown }
      const isSystemMessage = record.type === 'system/message'
      const isReplacement = 'surfaceOp' in record && record.surfaceOp !== 'append'
      if (!isSystemMessage && !isReplacement) return null
      const seq = (event as { seq?: unknown }).seq
      return { id: String(typeof seq === 'number' ? seq : 'system'), role: 'start' }
    },
    start: (_context: ConversationNodeContext<SystemPromptState>, match, reader) => {
      const previous = reader.previous<SystemPromptState>('cache-miss-system')?.state
      return inspect(previous, match.event as SessionEvent)
    },
    update: (context) => context.state,
    buildViewNode: () => null,
  }
}

/**
 * Definition that records how each request changed the prompt prefix.
 *
 * Only the core's classification is kept as words, plus its own catalog diff by
 * name. Naming individual tools is deliberately limited to what no other surface
 * shows: see {@link toolMoveDetail} for the display rule.
 *
 * @param inspect - `uiConversation.inspectRequestPrompt`.
 */
export function createPrefixDefinition(inspect: PromptInspector): ConversationNodeDefinition<HeaderState> {
  return {
    kind: 'cache-miss-prefix',
    target: 'chat',
    match: (event) => {
      if ((event as { type?: unknown }).type !== 'request/header') return null
      const seq = (event as { seq?: unknown }).seq
      return { id: String(typeof seq === 'number' ? seq : 'header'), role: 'start' }
    },
    start: (_context: ConversationNodeContext<HeaderState>, match, reader) => {
      const event = match.event as SessionEvent<'request/header'>
      const previous = reader.previous<HeaderState>('cache-miss-prefix')?.state?.prompt
      const system = reader.previous<SystemPromptState>('cache-miss-system')?.state?.effective
      const inspection = inspect(previous, event, system)
      // The classifier names system/tool changes; a provider or sampling switch
      // re-bills the same prompt under a different cache namespace, so the config
      // comparison supplies that cause instead of leaving the line mute.
      const previousConfig = previous?.config
      const configChanged = previousConfig !== undefined
        && configSignature(previousConfig) !== configSignature(inspection.prompt.config)
      const kind = prefixChangeKind(inspection.change?.kind)
      const change = prefixChangeLabel(kind, configChanged)
      // A schema comparison is only worth its serialization when the core already
      // said the catalog moved; otherwise equal names mean an unchanged catalog.
      const catalogsDiffer = kind === 'tools' || kind === 'system-and-tools'
      const move = previous === undefined
        ? undefined
        : toolCatalogChange(previous.tools, inspection.prompt.tools, catalogsDiffer)
      const key = stepKeyOf(match.location)
      if (key !== undefined && (change !== undefined || move !== undefined)) {
        writeStepPrefix(key, {
          ...(change === undefined ? {} : { change }),
          ...(move === undefined ? {} : { move }),
        })
      }
      return { prompt: inspection.prompt }
    },
    update: (context) => context.state,
    buildViewNode: () => null,
  }
}

/** One Step a tool-registry message belongs to. */
interface ToolRegistryState {
  readonly turn: number
  readonly step: number
}

/** Whether one developer-message block reports a catalog tool entering or leaving. */
function isToolRegistryBlock(block: unknown): boolean {
  if (block === null || typeof block !== 'object') return false
  const type = (block as { type?: unknown }).type
  return type === 'tool-addition' || type === 'tool-removal'
}

/**
 * Definition that marks the Steps whose tool catalog change the chat already
 * shows on its own.
 *
 * Cores log a `developer/message` with `source.kind === 'tool-registry'`
 * whenever the catalog's membership changes, and the chat renders it as a
 * "Tool added: …" row. The notice line reads this mark to avoid repeating names
 * that are already one row above — a schema change under an unchanged name emits
 * no such message, which is exactly why it stays the line's own job.
 *
 * The match is keyed by the event's own `turn`/`step` fields rather than by a
 * resolved location: a developer message that arrived outside the loaded window
 * still identifies its Step, and the mark must survive that.
 */
export function createToolRegistryDefinition(): ConversationNodeDefinition<ToolRegistryState> {
  return {
    kind: 'cache-miss-tools',
    target: 'chat',
    match: (event) => {
      const record = event as {
        type?: unknown
        seq?: unknown
        data?: { turn?: unknown; step?: unknown; message?: { source?: { kind?: unknown }; content?: unknown } }
      }
      if (record.type !== 'developer/message') return null
      if (record.data?.message?.source?.kind !== 'tool-registry') return null
      const content = record.data.message.content
      if (!Array.isArray(content) || !content.some((block) => isToolRegistryBlock(block))) return null
      return { id: String(typeof record.seq === 'number' ? record.seq : 'tool-registry'), role: 'start' }
    },
    start: (_context, match) => {
      const data = (match.event as { data: { turn: number; step: number } }).data
      writeStepPrefix(`${data.turn}:${data.step}`, { announced: true })
      return { turn: data.turn, step: data.step }
    },
    update: (context) => context.state,
    buildViewNode: () => null,
  }
}
