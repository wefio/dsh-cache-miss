import type {
  ChatConversationViewNode, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { isCacheMiss, type CacheUsage } from './logic'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Yellow cache-miss line published for a turn's rebuilt first request. */
    'cache-miss': CacheMissNodeData
  }
}

/** The raw Session event type the Definition's match receives. */
type CacheMissEvent = Parameters<ConversationNodeDefinition['match']>[0]

/** Stable business identity for one turn's first assistant step. */
export function conversationIdFor(turn: number, step: number): string {
  return `${turn}:${step}`
}

/** Whether an event is the appended first assistant message of a turn. */
function isFirstAssistantMessage(event: CacheMissEvent): boolean {
  if (event.type !== 'assistant/message') return false
  // The first model call of a turn is step 0 (steps reset per turn). The
  // cache-miss notice targets exactly that call: the moment the prompt cache
  // is rebuilt if it had expired.
  return (event.data as { step: number }).step === 0
}

/** State captured for the turn's first assistant message. */
export interface CacheMissState {
  readonly turn: number
  readonly step: number
  readonly usage: CacheUsage | undefined
}

/** Published view data for the cache-miss node. */
export interface CacheMissNodeData {
  /** The first-assistant step coordinates backing this notice. */
  readonly turn: number
  readonly step: number
  readonly usage: CacheUsage | undefined
}

/**
 * Conversation node that emits a prompt-cache-miss notice under a turn's FIRST
 * assistant reply. It keys on `turn:0` (the turn's first model call) so the
 * line lands exactly where the cache is rebuilt, never in the turn-tail footer,
 * and therefore never collides with better-sidebar's produced-files row.
 */
export const cacheMissDefinition: ConversationNodeDefinition<CacheMissState> = {
  kind: 'cache-miss',
  target: 'chat',
  match: (event) => {
    if (!isFirstAssistantMessage(event)) return null
    const { turn, step } = event.data as { turn: number; step: number }
    return { id: conversationIdFor(turn, step), role: 'start' }
  },
  start: (_context, match) => {
    const event = match.event
    if (event.type !== 'assistant/message') throw new Error('cache-miss start requires assistant/message')
    const { turn, step } = event.data as { turn: number; step: number }
    const usage = (event.data as { usage?: CacheUsage }).usage
    return { turn, step, usage }
  },
  update: (context, match) => {
    // A re-published first assistant (e.g. after retry) refreshes usage.
    if (match.event.type !== 'assistant/message') return context.state
    const usage = (match.event.data as { usage?: CacheUsage }).usage
    return { ...context.state, usage }
  },
  publication: () => 'immediate',
  buildLocationData: () => null,
  buildViewNode: (context): ChatConversationViewNode | null => {
    const state = context.state
    if (state === undefined || !isCacheMiss(state.usage)) return null
    return {
      key: context.key,
      kind: 'cache-miss',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
      location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: {
        turn: state.turn,
        step: state.step,
        usage: state.usage,
      } satisfies CacheMissNodeData,
    }
  },
}

export type { ConversationNodeContext }
