/**
 * Cache-miss decision and display logic. Pure functions, no DSH runtime
 * dependency: the Definition maps a session `usage` payload into {@link CacheUsage}
 * and calls these; the renderer formats via {@link formatLine}.
 */

/** The token-accounting subset this plugin reads. `cacheReadTokens` is
 * optional because some providers report no cache fields. */
export interface CacheUsage {
  inputTokens: number
  cacheReadTokens?: number
}

/** Fixed token abbreviation divisor (k = thousands). */
const K = 1000

/**
 * Whether one request is a cache miss.
 * @param usage - the request's token accounting, or undefined when the
 *   adapter reported none.
 * @returns true when the request had billed input but no positive cache read.
 */
export function isCacheMiss(usage: CacheUsage | undefined): boolean {
  if (usage === undefined) return false
  if (usage.inputTokens <= 0) return false
  return !(typeof usage.cacheReadTokens === 'number' && usage.cacheReadTokens > 0)
}

/** Presentable facts for one miss line. */
export interface LineFacts {
  idleMs: number
  rebilledTokens: number
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

function formatTtft(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Render one cache-miss line.
 * @param facts - idle, re-billed token total, and TTFT (ms; 0 = absent).
 * @returns the single-line message, without leading/trailing punctuation.
 */
export function formatLine(facts: LineFacts): string {
  const idle = formatIdle(facts.idleMs)
  const rebilled = formatTokens(facts.rebilledTokens)
  const body = `Cache miss after ${idle} idle: ${rebilled} tokens re-billed`
  if ((facts.ttftMs ?? 0) > 0) return `${body} · ttft ${formatTtft(facts.ttftMs)} ↑`
  return body
}

/** Inputs the renderer resolves from session data before formatting. */
export interface LineInput {
  usage: CacheUsage | undefined
  idleMs: number
  ttftMs: number
}

/** Union of render states: either show a line or hide. */
export type LineStatus = { kind: 'show'; line: string } | { kind: 'hidden' }

/**
 * Decide whether and what to render for one turn.
 * @param input - usage plus timing facts for the turn's first assistant.
 * @returns a show status with the formatted line, or hidden for a hit/absent.
 */
export function getLineStatus(input: LineInput): LineStatus {
  const usage = input.usage
  if (usage === undefined) return { kind: 'hidden' }
  if (!isCacheMiss(usage)) return { kind: 'hidden' }
  return {
    kind: 'show',
    line: formatLine({
      idleMs: input.idleMs,
      rebilledTokens: usage.inputTokens,
      ttftMs: input.ttftMs,
    }),
  }
}
