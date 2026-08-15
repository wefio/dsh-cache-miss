import { createElement } from 'react'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Context } from '@deepseek-ai/cordis'
import { cacheMissDefinition, type CacheMissNodeData } from './cache-miss-node'
import { getLineStatus } from './logic'

/** Yellow cache-miss single line rendered under the turn's first assistant. */
const LINE_STYLE = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '12px',
  lineHeight: '18px',
  color: '#eab308',
} as const

/** The conversation-snapshot selector hook the keyed seat injects. */
type UseConversation<T> = (selector: (snapshot: any) => T) => T

/** Minimal props this renderer actually reads (node data + session hook). */
interface CacheMissLineProps {
  node?: { data?: CacheMissNodeData }
  useSession?: UseConversation<Map<number, { startTime?: number; endTime?: number }> | undefined>
}

/** Resolve the idle gap (previous turn end -> this turn start) in ms, or 0. */
function idleMsFor(turn: number, useSession: CacheMissLineProps['useSession']): number {
  if (useSession === undefined) return 0
  const turnTimings = useSession((state) => state?.turnTimings)
  if (!(turnTimings instanceof Map)) return 0
  const current = turnTimings.get(turn)
  let previousEnd = 0
  let best = -1
  for (const [t, timing] of turnTimings) {
    if (t < turn && timing?.endTime !== undefined && t > best) {
      best = t
      previousEnd = timing.endTime
    }
  }
  if (current?.startTime !== undefined && previousEnd > 0) {
    return Math.max(0, current.startTime - previousEnd)
  }
  return 0
}

/**
 * Keyed renderer for the cache-miss chat node. Computes idle from the
 * conversation's turn timings and renders the yellow line only when the turn's
 * first assistant actually rebuilt the cache.
 */
function CacheMissLine(props: CacheMissLineProps): React.ReactElement | null {
  const data = props.node?.data
  if (data === undefined) return null
  const status = getLineStatus({
    usage: data.usage,
    idleMs: idleMsFor(data.turn, props.useSession),
    ttftMs: 0,
  })
  if (status.kind !== 'show') return null
  return createElement('div', { style: LINE_STYLE }, status.line)
}

/** Services required by the cache-miss browser half. */
export const inject = ['conversationEvents', 'slots']

/** Register the cache-miss Definition and its keyed chat-node renderer. */
export function apply(ctx: Context): void {
  ctx.conversationEvents.register(cacheMissDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'cache-miss',
  }, CacheMissLine))
}
