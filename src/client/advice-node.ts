/**
 * Conversation node that quotes a `/compact` before it is run.
 *
 * The payback node prices a compaction after the fact; this one reads the same
 * facts off a settled step and predicts forward, so the quote arrives while the
 * decision can still be made. It speaks rarely on purpose: a window opens when the
 * context has grown by a quarter since the last notice, and closes at the next
 * compaction. What it prints is a quote, not a verdict — whether the summary call
 * hits its cache decides the price and cannot be known in advance.
 */

import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  ADVICE_MIN_CONTEXT,
  type CompactionSample,
} from './compact-advice'
import type { CacheUsage } from './logic'

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Green line advising whether to run `/compact` at this point. */
    'compact-advice': AdviceNodeData
  }
}

/** Compactions this session has measured, newest last. */
const samples: CompactionSample[] = []

/**
 * Context size when the last notice opened, so growth rather than the clock
 * decides when to speak again. Undefined outside a window.
 */
let windowA: number | undefined

/**
 * Speak again only after the context has grown by a quarter.
 *
 * The cache state of the step itself is deliberately not part of the gate: the
 * summarization call's prefix is its own, and whether it hits does not follow the
 * previous step's cache state (measured, see `SUMMARY_HIT_RATE`), so a cold step
 * is not a worse moment to compact and a warm one is not a better one.
 */
const GROWTH_TO_REPEAT = 1.25

/**
 * Record one compaction for the prediction that follows it.
 *
 * @param sample - retained and summary sizes of a compaction just measured.
 */
export function recordAdviceSample(sample: CompactionSample): void {
  samples.push(sample)
  // A handful is enough to move a median; keeping every one would let an early
  // outlier session outvote the recent behaviour it no longer shows.
  if (samples.length > 20) samples.shift()
}

/** Compactions measured so far, for the renderer's prediction prior. */
export function adviceSamples(): readonly CompactionSample[] {
  return samples
}

/**
 * Close the current window, so the next growing context opens a fresh one.
 *
 * Called when a compaction lands: the line it published is answered, and the
 * context that follows is too small for the same advice to mean anything.
 */
export function resetAdviceWindow(): void {
  windowA = undefined
}

/** Event fields this node reads, structurally. */
interface AdviceEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: {
    readonly turn?: unknown
    readonly step?: unknown
    readonly usage?: CacheUsage
    readonly message?: { readonly source?: { readonly provider?: string; readonly model?: string } }
  }
}

/** Read one accepted event through the structural view above. */
function asAdviceEvent(event: unknown): AdviceEvent {
  return event as AdviceEvent
}

/** Prompt tokens a settled step billed, cached and uncached together. */
function promptOf(usage: CacheUsage | undefined): number | undefined {
  if (usage === undefined) return undefined
  const total = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
  return total > 0 ? total : undefined
}

/** State captured for one settled step. */
export interface AdviceState {
  readonly turn: number
  readonly step: number
  /** The decision, or undefined when this step says nothing worth a line. */
  readonly A: number | undefined
  readonly U: number | undefined
  readonly model: string | undefined
  readonly time: number | null
}

/** Published view data for the advice node. */
export interface AdviceNodeData {
  readonly turn: number
  readonly step: number
  readonly A: number
  readonly U: number
  readonly model: string | undefined
  readonly time: number | null
}

/**
 * Conversation node that recommends whether to compact, and when.
 *
 * The published node carries only what the step showed; the prediction and its
 * price are resolved in the renderer, so a late catalog refresh can still turn
 * an unpriced decision into a priced one, exactly as the payback line does.
 */
export const adviceDefinition: ConversationNodeDefinition<AdviceState> = {
  kind: 'compact-advice',
  target: 'chat',
  match: (raw) => {
    const event = asAdviceEvent(raw)
    if (event.type !== 'assistant/message') return null
    const { turn, step } = event.data as { turn: number; step: number }
    if (typeof turn !== 'number' || typeof step !== 'number') return null
    return { id: `${turn}:${step}`, role: 'start' }
  },
  start: (_context, match) => {
    const event = asAdviceEvent(match.event)
    const data = event.data
    const { turn, step } = data as { turn: number; step: number }
    const usage = data?.usage
    const A = promptOf(usage)
    const base = { turn, step, model: data?.message?.source?.model, time: event.time ?? null }
    if (A === undefined) {
      resetAdviceWindow()
      return { ...base, A: undefined, U: undefined }
    }
    const U = usage?.inputTokens ?? 0
    if (A < ADVICE_MIN_CONTEXT) {
      // The context is below the size where a compaction can pay back; the next
      // one to grow past it opens its own window.
      resetAdviceWindow()
      return { ...base, A: undefined, U: undefined }
    }
    // Speak once per window, and again only after the context has grown by a
    // quarter — the advice is about size, and the size is what changed.
    if (windowA !== undefined && A < windowA * GROWTH_TO_REPEAT) {
      return { ...base, A: undefined, U: undefined }
    }
    windowA = A
    return { ...base, A, U }
  },
  update: (context) => context.state,
  publication: (match) => (asAdviceEvent(match.event).type === 'assistant/message' ? 'immediate' : 'none'),
  buildLocationData: () => null,
  buildViewNode: (context): ChatConversationViewNode | null => {
    const state = context.state
    if (state === undefined || state.A === undefined || state.U === undefined) return null
    return {
      key: context.key,
      kind: 'compact-advice',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? 0,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: {
        turn: state.turn,
        step: state.step,
        A: state.A,
        U: state.U,
        model: state.model,
        time: state.time,
      } satisfies AdviceNodeData,
    }
  },
}

export type { ConversationNodeContext }
