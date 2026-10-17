import type {
  ConversationNodeContext, ConversationNodeDefinition, ConversationPromptSnapshot, RequestPromptInspection,
  SystemPromptState,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { configSignature, prefixChangeKind, prefixChangeLabel, type PrefixChangeLabel } from './prefix'

/**
 * Latest prompt-prefix change per Turn:step, keyed `turn:step`.
 *
 * The notice renderer cannot read another Definition's Context, so this small
 * registry is the hand-off: the header Definitions write, the keyed Chat node
 * reads by its own `turn`/`step`. Entries are bounded because a long page load
 * would otherwise keep one record per request forever.
 */
const prefixChanges = new Map<string, PrefixChangeLabel>()

/** Upper bound on retained records; the map is a cache, not a log. */
const MAX_RECORDS = 500

/** Read one step's prefix change, when the request rewrote the prompt prefix. */
export function readPrefixChange(turn: number, step: number): PrefixChangeLabel | undefined {
  return prefixChanges.get(`${turn}:${step}`)
}

/** Record one step's change, dropping the oldest records past the bound. */
function recordPrefixChange(key: string, label: PrefixChangeLabel): void {
  prefixChanges.delete(key)
  prefixChanges.set(key, label)
  while (prefixChanges.size > MAX_RECORDS) {
    const oldest = prefixChanges.keys().next().value
    if (oldest === undefined) break
    prefixChanges.delete(oldest)
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
 * Only the core's classification is kept: `system` / `tools` /
 * `system-and-tools`. Naming individual tools would mean diffing catalog
 * snapshots ourselves, which ties the plugin to more core internals than the
 * notice is worth.
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
      const configChanged = previous !== undefined
        && configSignature(previous.config) !== configSignature(inspection.prompt.config)
      const label = prefixChangeLabel(prefixChangeKind(inspection.change?.kind), configChanged)
      const key = stepKeyOf(match.location)
      if (label !== undefined && key !== undefined) recordPrefixChange(key, label)
      return { prompt: inspection.prompt }
    },
    update: (context) => context.state,
    buildViewNode: () => null,
  }
}

