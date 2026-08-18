import { createElement, useEffect, useRef } from 'react'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Context } from '@deepseek-ai/cordis'
import { cacheMissDefinition, type CacheMissNodeData } from './cache-miss-node'
import { deriveTurnTimingFacts, formatLocalTime, getLineStatus, hasCacheFields, ttftMs } from './logic'

/** Yellow cache-miss single line rendered under the turn's first assistant. */
const LINE_STYLE = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '12px',
  lineHeight: '18px',
  color: '#eab308',
} as const

/** Neutral one-time notice for providers that have never reported cache fields. */
const UNCONFIRMED_STYLE = {
  ...LINE_STYLE,
  color: '#9ca3af',
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
 * Providers that have ever reported a cache-accounting field. Once a provider
 * is in this set, later requests without cache fields are treated as full
 * misses (the omitted field is a genuine 0) instead of being left unconfirmed.
 */
const providersWithCacheEvidence = new Set<string>()

/**
 * Module-scoped one-time gate per provider for the unconfirmed-provider notice
 * (both the grey page line and the detailed console warning). A provider with
 * no cache evidence gets exactly one notice per page load, so switching to
 * another no-evidence provider surfaces a fresh notice without spamming.
 */
const unconfirmedNotified = new Set<string>()

/**
 * Keyed renderer for the cache-miss chat node. Computes idle from the
 * conversation's turn timings and TTFT from the step's own recorded
 * boundaries, then renders the yellow line only when the request actually
 * rebuilt the cache (a cold-start first turn is not a miss). Logs each miss to
 * the console exactly once per step, stamped in the browser's local time.
 */
function CacheMissLine(props: CacheMissLineProps): React.ReactElement | null {
  // Persist the provider this component instance has already surfaced, so the
  // grey notice does not disappear on later re-renders after the module gate is set.
  const shownProviderRef = useRef<string | null>(null)

  // Choose how to interpret this step's usage before rendering, because the
  // decision depends on per-provider evidence gathered from earlier steps.
  const data = props.node?.data
  const currentHasCacheFields = hasCacheFields(data?.usage)
  const hasCacheEvidence = currentHasCacheFields
    || (data?.provider !== undefined && providersWithCacheEvidence.has(data.provider))

  // Side effects run after commit: record cache-field evidence and emit the
  // per-provider unconfirmed warning exactly once. A discarded React render
  // must not consume the once-gate or drop the log line.
  useEffect(() => {
    const d = props.node?.data
    if (d?.provider === undefined) return
    if (hasCacheFields(d.usage)) {
      providersWithCacheEvidence.add(d.provider)
    }
    if (d.missingCacheFields !== true || hasCacheFields(d.usage)) return
    if (providersWithCacheEvidence.has(d.provider)) return
    if (unconfirmedNotified.has(d.provider)) return
    unconfirmedNotified.add(d.provider)
    const noticeTime = typeof d.missTime === 'number' ? d.missTime : Date.now()
    console.warn(
      `[dsh-cache-miss] ${formatLocalTime(noticeTime)} turn ${d.turn} step ${d.step}: `
      + `provider "${d.provider}" returned usage without cacheReadTokens/cacheWriteTokens `
      + `(inputTokens=${d.usage?.inputTokens}). No cache field has been seen for this provider, `
      + `so a cache miss cannot be confirmed; no cache-miss line is shown.`,
    )
  }, [props.node?.data?.turn, props.node?.data?.step, props.node?.data?.missTime, props.node?.data?.usage?.inputTokens, props.node?.data?.usage?.cacheReadTokens, props.node?.data?.usage?.cacheWriteTokens, props.node?.data?.missingCacheFields, props.node?.data?.provider])

  if (data === undefined) return null
  const turnTimings = props.useSession?.((state) => state?.turnTimings)
  const timing = deriveTurnTimingFacts(data.turn, turnTimings)
  const status = getLineStatus({
    usage: data.usage,
    idleMs: timing.idleMs,
    ttftMs: ttftMs(data.stepStartTime, data.firstTokenTime),
    hasPriorTurn: timing.hasPriorTurn,
    hasCacheEvidence,
  })
  if (status.kind === 'show') {
    const lineKey = `${data.turn}:${data.step}:${status.line}`
    if (!logged.has(lineKey)) {
      logged.add(lineKey)
      const missTime = typeof data.missTime === 'number' ? data.missTime : Date.now()
      console.info(`[dsh-cache-miss] ${formatLocalTime(missTime)} turn ${data.turn} step ${data.step}: ${status.line}`)
    }
    return createElement('div', { style: LINE_STYLE }, status.line)
  }
  if (status.kind === 'unconfirmed') {
    // Wait for provider identity before surfacing, so the per-provider once-gate
    // is accurate across provider switches.
    if (data.provider === undefined) return null
    const providerKey = data.provider
    if (shownProviderRef.current !== providerKey) {
      if (unconfirmedNotified.has(providerKey)) return null
      shownProviderRef.current = providerKey
    }
    return createElement('div', { style: UNCONFIRMED_STYLE }, status.line)
  }
  return null
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
