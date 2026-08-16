import type {
  ChatConversationViewNode, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { isCacheMiss, type CacheUsage } from './logic'

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
  }
}

/** Empty per-step boundaries before any event of the step is observed. */
function emptyState(turn: number, step: number): CacheMissState {
  return { turn, step, usage: undefined, stepStartTime: null, firstTokenTime: null, missTime: null }
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
 * reply whose model request rebuilt the prompt cache. It answers the stream's
 * own `usage` chunk — which adapters emit before the terminal finish — so a
 * miss is published as soon as the usage arrives (while tokens are still
 * streaming), not only once the assistant message settles. Each `turn:step`
 * owns an independent Context: a request that missed renders a line under that
 * reply; one that hit renders nothing. It is additive: the node uses its own
 * kind and never takes the turn-tail chain, so it does not collide with
 * better-sidebar's produced-files row.
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
    return emptyState(turn, step)
  },
  update: (context, match) => {
    const event = match.event
    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk
      if (chunk.type === 'usage') {
        return { ...context.state, usage: chunk.usage as CacheUsage, missTime: event.time }
      }
      if (isTokenDeltaEvent(event) && context.state.firstTokenTime === null) {
        return { ...context.state, firstTokenTime: event.time }
      }
      return context.state
    }
    if (event.type === 'assistant/message') {
      const usage = event.data.usage as CacheUsage | undefined
      // Providers that report no separate usage chunk still settle usage on the
      // finalized message; keep whichever accounting is present.
      return {
        ...context.state,
        usage: context.state.usage ?? usage,
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
    if (state === undefined || !isCacheMiss(state.usage)) return null
    return {
      key: context.key,
      kind: 'cache-miss',
      id: context.id,
      target: 'chat',
      anchorSeq: context.matches.at(-1)?.event.seq ?? context.start?.event.seq ?? 0,
      location: context.matches.at(-1)?.location ?? context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: {
        turn: state.turn,
        step: state.step,
        usage: state.usage,
        stepStartTime: state.stepStartTime,
        firstTokenTime: state.firstTokenTime,
        missTime: state.missTime,
      } satisfies CacheMissNodeData,
    }
  },
}

export type { ConversationNodeContext }
