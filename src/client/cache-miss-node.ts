import type {
  ChatConversationViewNode, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { firstTokenTimeFromStream, isCacheAccountingUnavailable, isCacheMiss, isDebugEnabled, type CacheUsage } from './logic'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Yellow cache-miss line published under an assistant reply whose request rebuilt the cache. */
    'cache-miss': CacheMissNodeData
  }
}

/** Stable business identity for one assistant step (one model call). */
function stepIdFor(turn: number, step: number): string {
  return `${turn}:${step}`
}

/** State captured for one assistant step. */
export interface CacheMissState {
  readonly turn: number
  readonly step: number
  /** Token accounting from the stream's usage chunk (or assistant/message fallback). */
  readonly usage: CacheUsage | undefined
  /** True when the step's usage omitted both cache-accounting fields. */
  readonly missingCacheFields: boolean
  /** Provider id from the finalized assistant message, when available. */
  readonly provider: string | undefined
  /** step/start event time, or null when outside the loaded window. */
  readonly stepStartTime: number | null
  /** First non-empty token delta event time, or null when none recorded. */
  readonly firstTokenTime: number | null
  /** Event time of the deciding usage record, or null while unknown. */
  readonly missTime: number | null
}

/** Published view data for the cache-miss node. */
export interface CacheMissNodeData {
  /** The assistant step backing this notice. */
  readonly turn: number
  readonly step: number
  readonly usage: CacheUsage | undefined
  /** True when the step's usage omitted both cache-accounting fields. */
  readonly missingCacheFields: boolean
  /** Provider id from the finalized assistant message, when available. */
  readonly provider: string | undefined
  /** step/start event time, or null when outside the loaded window. */
  readonly stepStartTime: number | null
  /** First non-empty token delta event time, or null when none recorded. */
  readonly firstTokenTime: number | null
  /** Event time of the deciding usage record, or null while unknown. */
  readonly missTime: number | null
}

/** The event fields this node reads, structurally (avoids a runtime type import). */
interface StreamEvent {
  readonly type: 'step/start' | 'assistant/chunk' | 'assistant/message' | (string & {})
  readonly time: number
  readonly data: {
    readonly turn: number
    readonly step: number
    readonly chunk?: { readonly type: string; readonly text?: string; readonly name?: string; readonly argumentsDelta?: string; readonly usage?: CacheUsage }
    readonly usage?: CacheUsage
    /** Rolled-up streaming timeline carried by the settled message on cores
     * that no longer emit separate `assistant/chunk` events. */
    readonly stream?: unknown
    readonly message?: {
      readonly source?: { readonly provider?: string }
      readonly provenance?: { readonly provider?: string }
    }
  }
}

/** Empty per-step boundaries before any event of the step is observed. */
function emptyState(turn: number, step: number): CacheMissState {
  return {
    turn,
    step,
    usage: undefined,
    missingCacheFields: false,
    provider: undefined,
    stepStartTime: null,
    firstTokenTime: null,
    missTime: null,
  }
}

/** Whether a chunk carries a non-empty delta — the first-token boundary. */
function isTokenDeltaEvent(event: StreamEvent): boolean {
  const chunk = event.data.chunk
  if (chunk === undefined) return false
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta': return chunk.text !== ''
    case 'tool-call-delta': return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default: return false
  }
}

/**
 * Conversation node that emits one prompt-cache-miss notice per assistant
 * reply whose model request rebuilt the prompt cache.
 *
 * Two event dialects are accepted, because cores differ: cores that stream
 * `assistant/chunk` events carry the usage before the terminal finish (so a miss
 * publishes while tokens are still streaming) and expose the first token as a
 * delta chunk; cores that emit only `step/start` + `assistant/message` settle
 * everything on the message, including the rolled-up stream timeline the
 * first-token boundary is read from. Both are read explicitly — neither is
 * assumed to exist — and a core offering only the latter still publishes the
 * line, just when the reply settles.
 *
 * Each `turn:step` owns an independent Context: a request that missed renders a
 * line under that reply; one that hit renders nothing. It is additive: the node
 * uses its own kind and never takes the turn-tail chain, so it does not collide
 * with better-sidebar's produced-files row.
 */
export const cacheMissDefinition: ConversationNodeDefinition<CacheMissState> = {
  kind: 'cache-miss',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'step/start' && event.type !== 'assistant/chunk' && event.type !== 'assistant/message') return null
    const { turn, step } = event.data as { turn: number; step: number }
    return { id: stepIdFor(turn, step), role: event.type === 'step/start' ? 'start' : 'update' }
  },
  start: (_context, match) => {
    if (match.event.type !== 'step/start') throw new Error('cache-miss start requires step/start')
    const { turn, step } = match.event.data as { turn: number; step: number }
    return { ...emptyState(turn, step), stepStartTime: match.event.time }
  },
  update: (context, match) => {
    const event = match.event
    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk
      if (chunk.type === 'usage') {
        const usage = chunk.usage as CacheUsage
        return {
          ...context.state,
          usage,
          missingCacheFields: isCacheAccountingUnavailable(usage),
          missTime: event.time,
        }
      }
      if (isTokenDeltaEvent(event) && context.state.firstTokenTime === null) {
        return { ...context.state, firstTokenTime: event.time }
      }
      return context.state
    }
    if (event.type === 'assistant/message') {
      const usage = event.data.usage as CacheUsage | undefined
      // Real AssistantMessage carries `source.provider`; keep `provenance` as a
      // structural fallback for adapters/versions that use the older field.
      const message = event.data.message as { source?: { provider?: string }; provenance?: { provider?: string } } | undefined
      const provider = context.state.provider
        ?? message?.source?.provider
        ?? message?.provenance?.provider
      // Providers that report no separate usage chunk still settle usage on the
      // finalized message; keep whichever accounting is present. The settled
      // message also carries the rolled-up stream timeline on cores that emit
      // no `assistant/chunk` events, so the first-token boundary is recovered
      // from there when the step saw no chunk of its own.
      return {
        ...context.state,
        usage: context.state.usage ?? usage,
        missingCacheFields: context.state.missingCacheFields
          || (usage !== undefined && isCacheAccountingUnavailable(usage)),
        provider,
        firstTokenTime: context.state.firstTokenTime
          ?? firstTokenTimeFromStream((event.data as { stream?: unknown }).stream),
        missTime: context.state.missTime ?? event.time,
      }
    }
    return context.state
  },
  publication: (match) => {
    // The miss becomes knowable the moment the usage chunk lands; publish then.
    // step/start opens state only, and non-usage chunks do not change the line.
    if (match.event.type === 'assistant/chunk' && match.event.data.chunk.type === 'usage') return 'immediate'
    if (match.event.type === 'assistant/message') return 'immediate'
    return 'none'
  },
  buildLocationData: () => null,
  buildViewNode: (context): ChatConversationViewNode | null => {
    const state = context.state
    if (state === undefined) return null
    const isMiss = isCacheMiss(state.usage)
    // Debug mode publishes on every Turn's first step so the placement of the
    // line can be checked without waiting for a real miss; the renderer labels it
    // as forced. One line per Turn keeps a placement check readable.
    const forced = isDebugEnabled() && state.step === 1
    if (!isMiss && !state.missingCacheFields && !forced) return null
    return {
      key: context.key,
      kind: 'cache-miss',
      id: context.id,
      target: 'chat',
      // `anchorSeq` / `location` / `visibility` belong to the 0.1.x view-node
      // shape. Cores from 0.2 narrowed the contract to key/kind/id/target/data
      // and ignore extra fields, so they are emitted only for the older shape
      // that still places a node by its anchor.
      anchorSeq: context.matches.at(-1)?.event.seq ?? context.start?.event.seq ?? 0,
      location: context.matches.at(-1)?.location ?? context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: {
        turn: state.turn,
        step: state.step,
        usage: state.usage,
        missingCacheFields: state.missingCacheFields,
        provider: state.provider,
        stepStartTime: state.stepStartTime,
        firstTokenTime: state.firstTokenTime,
        missTime: state.missTime,
      } satisfies CacheMissNodeData,
    }
  },
}

export type { ConversationNodeContext }
