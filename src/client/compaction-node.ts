import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CacheUsage } from './logic'
import { recordAdviceSample, resetAdviceWindow } from './advice-node'

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Payback ticket for a `/compact`, published once its rebuild is measured. */
    'compaction-cost': CompactionNodeData
  }
}

/**
 * Prompt tokens the last settled step billed, cached and uncached together.
 *
 * A compaction is reported by its summary event, which does not carry the size
 * of the context it replaced — that is the preceding step's prompt, so the step
 * node records it here as steps settle and the compaction node reads it once.
 */
let lastStepPrompt: number | undefined

/** Remember one settled step's prompt size for the next compaction to read. */
export function recordStepPrompt(usage: CacheUsage | undefined): void {
  if (usage === undefined) return
  const total = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
  if (total > 0) lastStepPrompt = total
}

/**
 * Compaction whose rebuild has not been measured yet.
 *
 * The payback needs the first request *after* the compaction, which arrives as
 * an ordinary assistant message. That message is matched to this id so it lands
 * in the compaction's own Context rather than the step that follows it.
 */
let pendingCompactionId: string | null = null

/** State captured for one compaction. */
export interface CompactionState {
  readonly compactionId: string
  /** Prompt tokens before compaction, from the step that preceded it. */
  readonly A: number | undefined
  /** Uncached tokens of the summarization call itself. */
  readonly Mc: number
  /** Summary output tokens. */
  readonly S: number
  /** Tokens the compaction dropped from the context. */
  readonly shadowed: number
  /** Provider/model of the summarization call, when reported. */
  readonly model: string | undefined
  /** Prompt tokens after compaction, from the first step that followed it. */
  readonly B: number | undefined
  /** Uncached tokens of that first step (the rebuild). */
  readonly U: number | undefined
  /** True once the first step after the compaction has been measured. */
  readonly done: boolean
  /** Event time of the summarization, for the console line. */
  readonly time: number | null
}

/** Published view data for the compaction-cost node. */
export interface CompactionNodeData {
  readonly compactionId: string
  readonly A: number
  readonly B: number
  readonly U: number
  readonly S: number
  readonly Mc: number
  /** Tokens the compaction dropped, for the console line. */
  readonly shadowed: number
  readonly model: string | undefined
  /** Event time of the summarization, for the console line. */
  readonly time: number | null
}

/** Usage as the compaction summary carries it: completion tokens included. */
interface CompactionUsage extends CacheUsage {
  readonly outputTokens?: number
}

/** Structural view of the two event payloads this Definition reads. */
interface CompactionEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: {
    readonly compactionId?: unknown
    readonly shadowedTokenCount?: unknown
    readonly model?: unknown
    readonly usage?: CompactionUsage
  }
}

/** Event as the compaction payload above. */
function asCompactionEvent(event: unknown): CompactionEvent {
  return event as CompactionEvent
}

/**
 * Conversation node that prices one `/compact` after the fact.
 *
 * Cores publish `compaction/summary` with the summarization call's own usage and
 * how many tokens it dropped, but not with the two numbers that decide whether
 * the compaction was worth it: the context before it and the rebuild after it.
 * The node therefore opens on the summary and closes on the next assistant
 * message, so the line appears where the compaction marker is once the rebuild
 * is measurable, and never guesses at a number it has not seen.
 */
export const compactionDefinition: ConversationNodeDefinition<CompactionState> = {
  kind: 'compaction-cost',
  target: 'chat',
  match: (raw) => {
    const event = asCompactionEvent(raw)
    if (event.type === 'compaction/summary') {
      const id = event.data?.compactionId
      if (typeof id !== 'string' || id === '') return null
      // The rebuild belongs to this compaction until one message consumes it.
      pendingCompactionId = id
      return { id, role: 'start' }
    }
    if (event.type === 'assistant/message' && pendingCompactionId !== null) {
      return { id: pendingCompactionId, role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    const event = asCompactionEvent(match.event)
    const data = event.data
    const usage = data?.usage
    const shadowed = typeof data?.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0
    return {
      compactionId: pendingCompactionId ?? String(data?.compactionId ?? ''),
      A: lastStepPrompt,
      Mc: usage?.inputTokens ?? 0,
      S: usage?.outputTokens ?? 0,
      shadowed,
      model: typeof data?.model === 'string' ? data.model : undefined,
      B: undefined,
      U: undefined,
      done: false,
      time: event.time ?? null,
    }
  },
  update: (context, match) => {
    const event = asCompactionEvent(match.event)
    const usage = event.data?.usage
    pendingCompactionId = null
    // A measured compaction becomes the prior the next recommendation predicts
    // with, and closes the window the recommendation was speaking in.
    resetAdviceWindow()
    if (usage === undefined) return { ...context.state, done: true }
    const next: CompactionState = {
      ...context.state,
      B: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0),
      U: usage.inputTokens ?? 0,
      done: true,
    }
    const { A, B, S } = next
    if (A !== undefined && B !== undefined && A > B) recordAdviceSample({ A, B, S })
    return next
  },
  publication: (match) => (asCompactionEvent(match.event).type === 'assistant/message' ? 'immediate' : 'none'),
  buildLocationData: () => null,
  buildViewNode: (context): ChatConversationViewNode | null => {
    const state = context.state
    if (state === undefined || !state.done) return null
    const { A, B, U } = state
    if (A === undefined || B === undefined || U === undefined) return null
    // A compaction that kept as much as it dropped saved nothing per step.
    if (A <= B) return null
    return {
      key: context.key,
      kind: 'compaction-cost',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? 0,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: {
        compactionId: state.compactionId,
        A,
        B,
        U,
        S: state.S,
        Mc: state.Mc,
        shadowed: state.shadowed,
        model: state.model,
        time: state.time,
      } satisfies CompactionNodeData,
    }
  },
}

export type { ConversationNodeContext }
