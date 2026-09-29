import { createElement, useEffect, useRef, useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Context } from '@deepseek-ai/cordis'
import { cacheMissDefinition, type CacheMissNodeData } from './cache-miss-node'
import {
  deriveTurnTimingFacts, formatLocalTime, getLineStatus, hasCacheFields, isDebugEnabled, resolveTurnTimings,
  turnProcessSelector, ttftMs,
  type LineStatus,
  type TurnTiming,
} from './logic'

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

/** Marks the line this plugin inserts beside a Turn's process summary row, so a
 * later render can recognise its own node instead of stacking another one. */
const ANCHORED_LINE_ATTR = 'data-dsh-cache-miss'

/** Camel-cased style object to an inline `cssText`. */
function toCssText(style: Readonly<Record<string, string>>): string {
  return Object.entries(style)
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`)}:${value}`)
    .join(';')
}

/** The message-flow container holding this renderer's own node.
 *
 * A session can mount more than one Conversation at a time (the main body and a
 * sidebar chat tab — two instances were measured on 0.2.0-rc.2), and each renders
 * its own copy of the flow with the same attributes; some of that markup sits
 * outside the centre column that hosts the message flow. Searching the whole
 * document would then anchor the line to whichever instance comes last in DOM
 * order, which is how one landed beside the window frame instead of in the flow.
 *
 * The scope is therefore this node's own centre column — the ui-layout column the
 * chat view renders its Turn rows into. Its module hash (`BynINW_`) changes per
 * build, so it is matched by the stable `_centerCol` suffix, and the node's own
 * flow-item parent is the fallback.
 *
 * @param ownNode - Node this renderer produced.
 */
function ownFlowContainer(ownNode: Element | null): ParentNode | null {
  const column = ownNode?.closest('[class*="_centerCol"]')
  if (column !== null && column !== undefined) return column
  return ownFlowItem(ownNode)?.parentElement ?? null
}

/** The flow item this renderer's node lives in. */
function ownFlowItem(ownNode: Element | null): Element | null {
  return ownNode?.closest('[data-chat-flow-kind]') ?? null
}

/**
 * Whether this line's own flow item is currently hidden by a collapsed Turn.
 *
 * Anchoring is decided by this, not by whether a summary row exists: while the
 * Turn is running — or while the reader has expanded a completed Turn's process
 * — the inline line is visible and belongs at the miss itself. Only a fold that
 * actually hides it justifies moving the line beside the summary row.
 *
 * @param ownNode - Node this renderer produced.
 */
function ownLineIsFolded(ownNode: Element | null): boolean {
  const item = ownFlowItem(ownNode)
  return item !== null && item.closest('[hidden]') !== null
}

/** Turns whose hidden notice already reported a missing fold anchor. */
const foldAnchorWarned = new Set<string>()

/**
 * Report, once per step, that a collapsed Turn hides the inline notice and no
 * process summary row could be found to move it beside. This is the one state in
 * which the notice can silently disappear, so it is worth a console line: the row
 * is located by `data-turn-process`, an attribute of the shipped chat view that a
 * core update may rename. The line carries the search facts, so a report of it is
 * enough to see which container the lookup should have used.
 *
 * @param key - `turn:step` identity of the affected step.
 * @param ownNode - Node this renderer produced.
 */
function warnFoldAnchorMissing(key: string, ownNode: Element | null): void {
  if (foldAnchorWarned.has(key)) return
  foldAnchorWarned.add(key)
  const item = ownFlowItem(ownNode)
  const column = ownNode?.closest('[class*="_centerCol"]') ?? null
  const turnsIn = (root: ParentNode | null): string =>
    root === null ? 'n/a' : [...root.querySelectorAll('[data-turn-process]')].map((e) => e.getAttribute('data-turn-process')).join('/')
  console.warn(
    '[dsh-cache-miss] a collapsed Turn hides the notice and no matching [data-turn-process] '
    + `summary row was found for ${key}; the line stays inline and is currently folded away. `
    + `facts: ownItemKind=${item?.getAttribute('data-chat-flow-kind') ?? 'none'} `
    + `inOwnItem=${turnsIn(item)} inOwnColumn=${turnsIn(column)} inDocument=${turnsIn(document)}`,
  )
}

/**
 * Place one notice line beside the Turn's process summary row.
 *
 * The summary row is the fold toggle of a closed Turn: it stays visible while
 * the Turn's process content is collapsed, which is what keeps the line on
 * screen in cores that fold completed Turns. A running Turn has no summary row
 * yet, and a future core may rename the attribute, so a missing anchor reports
 * `anchored: false` and the caller renders inline exactly as before — the
 * anchor is an optimisation for visibility, never a requirement.
 *
 * @param turn - Turn whose summary row to anchor to.
 * @param step - Step identity, recorded on the inserted node.
 * @param line - Text to show.
 * @param style - Style to apply to the inserted line.
 * @param previous - Node inserted by an earlier call, reused when still attached.
 * @param flow - Message-flow container to search within.
 * @returns whether the line is anchored, plus the node now representing it.
 */
function anchorLineBesideTurnProcess(
  turn: number,
  step: number,
  line: string,
  style: Readonly<Record<string, string>>,
  previous: HTMLDivElement | undefined,
  flow: ParentNode | null,
): { anchored: boolean; host: HTMLDivElement | undefined } {
  if (typeof document === 'undefined' || flow === null) {
    previous?.remove()
    return { anchored: false, host: undefined }
  }
  const anchor = flow.querySelector(turnProcessSelector(turn))
  if (anchor === null) {
    previous?.remove()
    return { anchored: false, host: undefined }
  }
  let host = previous
  if (host === undefined || !host.isConnected) {
    host = document.createElement('div')
    host.setAttribute(ANCHORED_LINE_ATTR, `${turn}:${step}`)
    host.style.cssText = toCssText(style)
    anchor.insertAdjacentElement('afterend', host)
  }
  if (host.textContent !== line) host.textContent = line
  return { anchored: true, host }
}

/**
 * Keep the notice on screen for its Turn: beside the Turn's process summary row
 * whenever that row exists, and inline in the step flow otherwise.
 *
 * A running Turn has no summary row yet and its fold is force-opened, so the
 * inline line is already visible there. A completed Turn gets the summary row, and
 * anchoring to it is what survives the fold. The two positions sit in the same
 * place in the shipped layout (the row is the Turn's first element), so placement
 * does not follow fold toggles — that would only churn the DOM.
 *
 * @param turn - Turn this node belongs to.
 * @param step - Step this node belongs to (identity of the inserted node).
 * @param line - Text to show, or undefined when nothing should be shown.
 * @param style - Style to apply to the line.
 * @param ownNode - Node this renderer produced, which locates its own
 *   Conversation instance.
 */
function useTurnProcessAnchor(
  turn: number | undefined,
  step: number | undefined,
  line: string | undefined,
  style: Readonly<Record<string, string>>,
  ownNode: { readonly current: HTMLElement | null },
): boolean {
  const [anchored, setAnchored] = useState(false)

  useEffect(() => {
    if (turn === undefined || line === undefined) {
      setAnchored(false)
      return undefined
    }
    let host: HTMLDivElement | undefined
    const sync = (): void => {
      const next = anchorLineBesideTurnProcess(
        turn, step ?? 0, line, style, host, ownFlowContainer(ownNode.current),
      )
      host = next.host
      setAnchored(next.anchored)
      // A running Turn has no summary row by design (the line stays inline where
      // the fold is force-opened). Report only the state that actually loses the
      // notice: no row to anchor to *and* a collapsed Turn hiding the inline line.
      if (!next.anchored && ownLineIsFolded(ownNode.current)) {
        warnFoldAnchorMissing(`${turn}:${step ?? 0}`, ownNode.current)
      }
    }
    sync()
    // The chat view rebuilds flow items as Turns materialize or virtualize, which
    // can drop an inserted sibling. The tree mutates constantly while a reply
    // streams, so the callback only looks for work once this line is gone.
    const observer = new MutationObserver(() => {
      if (host !== undefined && host.isConnected) return
      sync()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      host?.remove()
    }
  }, [turn, step, line, style, ownNode])

  return anchored
}

/** The conversation-snapshot selector hook the keyed seat injects. */
type UseConversation<T> = (selector: (snapshot: any) => T) => T

/** Minimal props this renderer actually reads (node data + session hook). */
interface CacheMissLineProps {
  node?: { data?: CacheMissNodeData }
  useSession?: UseConversation<ReadonlyMap<number, TurnTiming> | undefined>
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
  // The inline node doubles as this renderer's handle on its own Conversation
  // instance, so the anchor search below stays inside that instance.
  const lineRef = useRef<HTMLDivElement | null>(null)

  // Choose how to interpret this step's usage before rendering, because the
  // decision depends on per-provider evidence gathered from earlier steps.
  const data = props.node?.data
  const currentHasCacheFields = hasCacheFields(data?.usage)
  const hasCacheEvidence = currentHasCacheFields
    || (data?.provider !== undefined && providersWithCacheEvidence.has(data.provider))

  // Every hook runs before the first early return: `data` is normally present for
  // a mounted node, but a transient undefined must not change the hook count.
  const turnTimings = props.useSession?.((state) => resolveTurnTimings(state))
  const timing = data === undefined
    ? { hasPriorTurn: false, idleMs: 0 }
    : deriveTurnTimingFacts(data.turn, turnTimings)
  const decided: LineStatus = data === undefined ? { kind: 'hidden' } : getLineStatus({
    usage: data.usage,
    idleMs: timing.idleMs,
    ttftMs: ttftMs(data.stepStartTime, data.firstTokenTime),
    hasPriorTurn: timing.hasPriorTurn,
    hasCacheEvidence,
  })
  // Debug mode forces a labelled line on hits too, so the placement can be checked
  // without waiting for a real miss (see DEBUG_FLAG). It always says so, never
  // masquerading as a genuine notice.
  const status: LineStatus = decided.kind === 'hidden' && data !== undefined && isDebugEnabled()
    ? { kind: 'show', line: `[debug] 强制显示（本轮无 miss）· turn ${data.turn} step ${data.step}` }
    : decided
  // A closed Turn keeps this line beside its process summary row, which survives
  // the fold; a running Turn has no such row and renders in the step flow, where
  // the fold is force-opened anyway.
  const anchored = useTurnProcessAnchor(
    data?.turn,
    data?.step,
    status.kind === 'hidden' ? undefined : status.line,
    status.kind === 'unconfirmed' ? UNCONFIRMED_STYLE : LINE_STYLE,
    lineRef,
  )

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

  if (status.kind === 'show') {
    // Only genuine misses are logged; a forced debug line is not a finding.
    if (decided.kind === 'show') {
      const lineKey = `${data.turn}:${data.step}:${status.line}`
      if (!logged.has(lineKey)) {
        logged.add(lineKey)
        const missTime = typeof data.missTime === 'number' ? data.missTime : Date.now()
        console.info(`[dsh-cache-miss] ${formatLocalTime(missTime)} turn ${data.turn} step ${data.step}: ${status.line}`)
      }
    }
    return createElement('div', {
      ref: lineRef,
      style: anchored ? { ...LINE_STYLE, display: 'none' } : LINE_STYLE,
    }, status.line)
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
    return createElement('div', {
      ref: lineRef,
      style: anchored ? { ...UNCONFIRMED_STYLE, display: 'none' } : UNCONFIRMED_STYLE,
    }, status.line)
  }
  return null
}

/**
 * Services required by the cache-miss browser half.
 *
 * Only `slots` is a hard dependency (always present on the web surface). The
 * conversation-node registry — where a node Definition is registered — is
 * core-owned and its service key has changed across core versions (this core
 * exposes `ctx.uiConversation.events`; legacy `ctx.conversationEvents` still
 * exists on other cores). It is resolved structurally with `ctx.get` instead
 * of being injected or read as a property: a loader entry is a sibling of the
 * core entry that provides the service, so property access without `inject`
 * throws `cannot get property "<name>" without inject` and would fail apply —
 * not degrade. `ctx.get` reads the global service store and returns
 * `undefined` when absent, so a missing or renamed registry disables only the
 * cache-miss lines, never pending or boot failure.
 */
export const inject = ['slots']

/** The register-capable Definition registry surface the cache-miss Definition needs. */
interface CacheMissRegistry {
  register(definition: unknown): () => void
}

/** Structural registry read across the two core service names. */
function registerCacheMissDefinition(
  ctx: Context,
  registerAt: (registry: CacheMissRegistry) => void,
): void {
  const readService = (name: string): unknown => {
    try {
      return (ctx as unknown as { get(name: string): unknown }).get(name)
    } catch {
      return undefined
    }
  }
  const asRegistry = (value: unknown): CacheMissRegistry | undefined => {
    if (value === null || typeof value !== 'object') return undefined
    const node = value as { register?: (definition: unknown) => () => void; events?: unknown }
    if (typeof node.register === 'function') return node as CacheMissRegistry
    const events = node.events
    if (events !== null && typeof events === 'object') {
      const eventsNode = events as { register?: (definition: unknown) => () => void }
      if (typeof eventsNode.register === 'function') return eventsNode as CacheMissRegistry
    }
    return undefined
  }
  const registry = asRegistry(readService('uiConversation'))
    ?? asRegistry(readService('conversationEvents'))
  if (registry === undefined) {
    console.warn(
      '[dsh-cache-miss] conversation-node registry unavailable; cache-miss lines are disabled. '
      + 'Expected the registry on browser service uiConversation.events (or legacy conversationEvents).',
    )
    return
  }
  registerAt(registry)
}

/** Build marker written to `<html>` while debug mode is on, so a page can prove
 * which bundle it is running: the client bundle loads only on page load, and a
 * stale one otherwise looks identical to the current one. */
const DEBUG_BUILD_TAG = 'release-1'

/** Register the cache-miss Definition (best-effort) and its keyed chat-node renderer. */
export function apply(ctx: Context): void {
  if (isDebugEnabled() && typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-dsh-cache-miss-debug', DEBUG_BUILD_TAG)
  }
  // Defer Definition registration until the chat-node seat is declared: that
  // declaration lives under ui-chat, which injects `uiConversation`, so by the
  // time this callback fires the registry is guaranteed ACTIVE and `ctx.get`
  // resolves it. The seat still mounts even when registration degrades.
  let definitionRegistered = false
  ctx.slots.inject('conversation.chat.node', () => {
    if (!definitionRegistered) {
      registerCacheMissDefinition(ctx, (registry) => {
        try {
          const dispose = registry.register(cacheMissDefinition)
          // The Definition is owned by the registry's core context; tie the
          // disposer to this fiber so an unload/reload does not leave a stale
          // `cache-miss` Definition that makes the next run throw "already registered".
          ctx.effect(() => dispose)
          definitionRegistered = true
        } catch (error) {
          console.warn('[dsh-cache-miss] failed to register the cache-miss node; cache-miss lines are disabled.', error)
        }
      })
    }
    return ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'cache-miss',
    }, CacheMissLine)
  })
}
