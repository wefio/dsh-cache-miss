/**
 * Cache-miss decision and display logic. Pure functions, no DSH runtime
 * dependency: the Definition maps a session `usage` payload into {@link CacheUsage}
 * and calls these; the renderer formats via {@link formatLine}.
 */

/** The token-accounting subset this plugin reads, aligned with the official
 * `TokenUsage` contract (@deepseek-ai/dsh-llm). Counts are DISJOINT;
 * cache fields are optional because some providers report none. */
export interface CacheUsage {
  inputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Fixed token abbreviation divisor (k = thousands). */
const K = 1000

/** Miss requires at least this many uncached input tokens (1k) to avoid shouting
 *  about negligible small-session rebuilds. */
const MIN_MISS_TOKENS = 1000

/** Cache-hit ratio below which a request counts as a miss (i.e. more than 20% of
 *  the prefill was uncached — significant because context accumulates). */
const MISS_HIT_RATIO = 0.8

/**
 * Whether one request is a cache miss.
 *
 * The input counts are DISJOINT: `inputTokens` is the uncached (re-billed) part
 * and `cacheReadTokens` is the cached part of the same prefill, so
 * `hitRatio = cacheRead / (input + cacheRead)` is this request's cache-hit rate.
 * A miss requires billed uncached input, a hit ratio below {@link MISS_HIT_RATIO}
 * (over 20% uncached), and an absolute uncached amount of at least
 * {@link MIN_MISS_TOKENS} (1k). A provider that reports no cache fields is
 * treated as a 0% hit ratio.
 *
 * @param usage - the request's token accounting, or undefined when the adapter reported none.
 */
export function isCacheMiss(usage: CacheUsage | undefined): boolean {
  if (usage === undefined) return false
  const input = usage.inputTokens
  if (input <= 0 || input < MIN_MISS_TOKENS) return false
  const cacheRead = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0
  const hitRatio = input + Math.max(0, cacheRead) > 0 ? Math.max(0, cacheRead) / (input + Math.max(0, cacheRead)) : 0
  return hitRatio < MISS_HIT_RATIO
}

/** Presentable facts for one miss line. */
export interface LineFacts {
  idleMs: number
  /** Uncached input re-billed by the rebuild (disjoint `inputTokens`). */
  rebilledTokens: number
  /** Cached-read portion of the same prefill, or undefined when the provider reported none. */
  cacheReadTokens: number | undefined
  ttftMs: number
}

function formatIdle(ms: number): string {
  // At or past the minute boundary, show whole minutes by floor so 90s reads
  // "1m" rather than rounding up to a not-yet-elapsed 2m.
  if (ms >= 60_000) return `${Math.max(1, Math.floor(ms / 60_000))}m`
  return `${Math.round(ms / 1000)}s`
}

function formatTokens(n: number): string {
  return `${Math.max(1, Math.round(n / K))}k`
}

/** Cached-read count, keeping an explicit zero (unlike re-billed, 0 is meaningful here). */
function formatCached(n: number): string {
  return `${Math.round(n / K)}k`
}

function formatTtft(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * First-token latency from the recorded step boundaries, or 0 when absent.
 * Both boundary timestamps come from session event times (Unix epoch ms), so
 * the difference is wall-clock TTFT regardless of when the reader observed it.
 * @param stepStartTime - the step/start event time, or null when outside the window.
 * @param firstTokenTime - the first non-empty token delta event time, or null when none recorded.
 */
export function ttftMs(
  stepStartTime: number | null | undefined,
  firstTokenTime: number | null | undefined,
): number {
  if (typeof stepStartTime !== 'number' || typeof firstTokenTime !== 'number') return 0
  const ms = firstTokenTime - stepStartTime
  return ms > 0 ? ms : 0
}

/**
 * Format a Unix-epoch-ms instant in the browser's own locale and time zone.
 * @param epochMs - session event time (Unix epoch milliseconds).
 */
export function formatLocalTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString()
}

/**
 * Render one cache-miss line.
 * @param facts - idle, re-billed (uncached) token count, optional cached-read
 *   count, and TTFT (ms; 0 = absent).
 * @returns the single-line message, without leading/trailing punctuation.
 */
export function formatLine(facts: LineFacts): string {
  const idle = formatIdle(facts.idleMs)
  const rebilled = formatTokens(facts.rebilledTokens)
  const body = `Cache miss after ${idle} idle: ${rebilled} tokens re-billed`
  const tail: string[] = []
  if (typeof facts.cacheReadTokens === 'number' && facts.cacheReadTokens >= 0) {
    tail.push(`${formatCached(facts.cacheReadTokens)} cached`)
  }
  if ((facts.ttftMs ?? 0) > 0) tail.push(`ttft ${formatTtft(facts.ttftMs)} ↑`)
  return tail.length > 0 ? `${body} · ${tail.join(' · ')}` : body
}

/** Facts about the turn's timing, resolved from the conversation snapshot. */
export interface TurnTimingFacts {
  /** Whether any prior turn exists. Turn numbers are global and monotonic
   * (1, 2, 3, ...), so any turn > 1 has a prior turn regardless of the loaded
   * window — window cropping must not turn a real miss into a cold start. */
  hasPriorTurn: boolean
  /** Idle gap (previous turn end -> this turn start) in ms, or 0 when the
   * previous turn's end time is outside the window or unrecorded. */
  idleMs: number
}

/**
 * Derive prior-turn presence and the idle gap from a turn's timing map.
 * @param turn - the turn number (global, monotonic from 1).
 * @param turnTimings - the conversation's in-window turn timings, or undefined
 *   when the snapshot did not expose them.
 * @returns prior-turn presence (turn > 1) plus the best-effort idle gap.
 */
export function deriveTurnTimingFacts(
  turn: number,
  turnTimings: ReadonlyMap<number, { readonly startTime?: number; readonly endTime?: number }> | undefined,
): TurnTimingFacts {
  const hasPriorTurn = turn > 1
  if (!(turnTimings instanceof Map)) return { hasPriorTurn, idleMs: 0 }
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
    return { hasPriorTurn, idleMs: Math.max(0, current.startTime - previousEnd) }
  }
  return { hasPriorTurn, idleMs: 0 }
}

/** Inputs the renderer resolves from session data before formatting. */
export interface LineInput {
  usage: CacheUsage | undefined
  idleMs: number
  ttftMs: number
  /** True when any prior turn exists (turn > 1; turn numbers are global and
   * monotonic, so window cropping or a missing turn/end must not turn a real
   * miss into a cold start). False means the first turn of a fresh cache,
   * which must not be shown as a cache miss. */
  hasPriorTurn: boolean
}

/** Union of render states: either show a line or hide. */
export type LineStatus = { kind: 'show'; line: string } | { kind: 'hidden' }

/**
 * Decide whether and what to render for one turn.
 * @param input - usage plus timing facts for the turn's first assistant.
 * @returns a show status with the formatted line, or hidden for a hit/absent
 *   or a cold-start first turn (no prior turn to have lost its cache).
 */
export function getLineStatus(input: LineInput): LineStatus {
  const usage = input.usage
  if (usage === undefined) return { kind: 'hidden' }
  // A cold start (first turn, empty cache) looks token-identical to a real miss
  // (inputTokens > 0, no cache read), so require a prior turn before declaring a miss.
  if (!input.hasPriorTurn) return { kind: 'hidden' }
  if (!isCacheMiss(usage)) return { kind: 'hidden' }
  return {
    kind: 'show',
    line: formatLine({
      idleMs: input.idleMs,
      // `inputTokens` is the uncached (re-billed) portion of the prefill; the
      // cached-read portion is shown alongside so the split stays unambiguous.
      rebilledTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      ttftMs: input.ttftMs,
    }),
  }
}
