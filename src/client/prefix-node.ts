import type {
  ConversationNodeContext, ConversationNodeDefinition, ConversationPromptSnapshot, RequestPromptInspection,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { diffTools, isEmptyToolChange, type ToolChange } from './prefix'

/**
 * Latest tool-catalog change per Turn:step, keyed `turn:step`.
 *
 * The line renderer cannot read another Definition's Context, so this small
 * registry is the hand-off: the request-header Definition writes, the keyed Chat
 * node reads by its own `turn`/`step`. Entries are bounded because a long page
 * load would otherwise keep one record per request forever.
 */
const prefixChanges = new Map<string, ToolChange>()

/** Upper bound on retained records; the map is a cache, not a log. */
const MAX_RECORDS = 500

/** Read one step's tool change, when the current request rewrote the catalog. */
export function readToolChange(turn: number, step: number): ToolChange | undefined {
  return prefixChanges.get(`${turn}:${step}`)
}

/** Record one step's change, dropping the oldest records past the bound. */
function recordToolChange(key: string, change: ToolChange): void {
  prefixChanges.delete(key)
  prefixChanges.set(key, change)
  while (prefixChanges.size > MAX_RECORDS) {
    const oldest = prefixChanges.keys().next().value
    if (oldest === undefined) break
    prefixChanges.delete(oldest)
  }
}

/** Minimal request-header event shape this Definition reads. */
interface RequestHeaderEvent {
  readonly type?: unknown
  readonly seq?: unknown
}

/** Canonical prompt interpretation supplied by the uiConversation service. */
export type PromptInspector = (
  previous: ConversationPromptSnapshot | undefined,
  event: SessionEvent<'request/header'>,
  system: undefined,
) => RequestPromptInspection

/** One request header's retained prompt state. */
interface PrefixState {
  /** `turn:step` the header belongs to, when the engine resolved one. */
  readonly stepKey: string | undefined
  /** Canonical prompt in force for this request. */
  readonly prompt: ConversationPromptSnapshot
}

/** Turn:step key from one resolved Match location, when it names a step. */
function stepKeyOf(location: unknown): string | undefined {
  const record = location as { kind?: unknown; turn?: { turn?: unknown }; step?: { step?: unknown } }
  if (record === null || typeof record !== 'object' || record.kind !== 'step') return undefined
  const turn = record.turn?.turn
  const step = record.step?.step
  return typeof turn === 'number' && typeof step === 'number' ? `${turn}:${step}` : undefined
}

/**
 * Conversation Definition that records what each request changed in the prompt
 * prefix.
 *
 * DeepSeek bills a cache miss for every token after the first changed byte, and
 * the usual cause is the tool catalog moving (a plugin, skill or agent tool
 * appears or disappears). The engine hands every request header to Definitions
 * and the uiConversation service canonicalizes it against the previous prompt, so
 * the change is read here once and handed to the notice line — no DOM, no diff of
 * the rendered conversation.
 *
 * The Definition publishes no view node: it exists only for this record.
 *
 * @param inspect - `uiConversation.inspectRequestPrompt`, injected as a value seam
 *   because a client bundle cannot value-import another package's module.
 */
export function createPrefixDefinition(inspect: PromptInspector): ConversationNodeDefinition<PrefixState> {
  return {
    kind: 'cache-miss-prefix',
    target: 'chat',
    match: (event) => {
      if ((event as RequestHeaderEvent).type !== 'request/header') return null
      const seq = (event as { seq?: unknown }).seq
      return { id: String(typeof seq === 'number' ? seq : 'header'), role: 'start' }
    },
    start: (_context: ConversationNodeContext<PrefixState>, match, reader) => {
      const event = match.event as SessionEvent<'request/header'>
      const previous = reader.previous<PrefixState>('cache-miss-prefix')?.state?.prompt
      const inspection = inspect(previous, event, undefined)
      const key = stepKeyOf(match.location)
      if (key !== undefined) {
        const change = diffTools(previous?.tools, inspection.prompt.tools)
        if (!isEmptyToolChange(change)) recordToolChange(key, change)
      }
      return { stepKey: key, prompt: inspection.prompt }
    },
    update: (context) => context.state,
    buildViewNode: () => null,
  }
}

