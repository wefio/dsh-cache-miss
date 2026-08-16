import { createElement } from 'react'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Context } from '@deepseek-ai/cordis'
import { cacheMissDefinition, type CacheMissNodeData } from './cache-miss-node'
import { deriveTurnTimingFacts, formatLocalTime, getLineStatus, ttftMs } from './logic'

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

/**
 * Module-scoped dedup: one console line per `turn:step` miss, surviving React
 * remounts (model switch, reply re-render, flush-generated new node references).
 * Keyed on the full rendered line so a genuinely changed miss (a retry with a
 * different usage) still logs once for its new content; only a changed line's
 * signature is retained, so the map stays tiny.
 */
const logged = new Set<string>()

/**
 * Keyed renderer for the cache-miss chat node. Computes idle from the
 * conversation's turn timings and TTFT from the step's own recorded
 * boundaries, then renders the yellow line only when the request actually
 * rebuilt the cache (a cold-start first turn is not a miss). Logs each miss to
 * the console exactly once per step, stamped in the browser's local time.
 */
function CacheMissLine(props: CacheMissLineProps): React.ReactElement | null {
  const data = props.node?.data
  if (data === undefined) return null
  const turnTimings = props.useSession?.((state) => state?.turnTimings)
  const timing = deriveTurnTimingFacts(data.turn, turnTimings)
  const status = getLineStatus({
    usage: data.usage,
    idleMs: timing.idleMs,
    ttftMs: ttftMs(data.stepStartTime, data.firstTokenTime),
    hasPriorTurn: timing.hasPriorTurn,
  })
  if (status.kind !== 'show') return null
  const lineKey = `${data.turn}:${data.step}:${status.line}`
  if (!logged.has(lineKey)) {
    logged.add(lineKey)
    const missTime = typeof data.missTime === 'number' ? data.missTime : Date.now()
    console.info(`[dsh-cache-miss] ${formatLocalTime(missTime)} turn ${data.turn} step ${data.step}: ${status.line}`)
  }
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
