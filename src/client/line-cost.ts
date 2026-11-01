import { isCacheMiss, type CacheUsage, type LineCost } from './logic'
import { loadedStepUsage, prefillCost, totalOf, type ModelPrice, type PrefillCost, type UsageLike } from './prices'

/** Narrow a structurally read usage record into the plugin's accounting type. */
export function asCacheUsage(usage: UsageLike | undefined): CacheUsage | undefined {
  if (usage === undefined || typeof usage.inputTokens !== 'number') return undefined
  const { cacheReadTokens, cacheWriteTokens } = usage
  return {
    inputTokens: usage.inputTokens,
    ...(typeof cacheReadTokens === 'number' ? { cacheReadTokens } : {}),
    ...(typeof cacheWriteTokens === 'number' ? { cacheWriteTokens } : {}),
  }
}

/**
 * Misses one Turn recorded before `step`, read from the loaded window.
 *
 * The notice names a tool catalog change again only once its Turn has missed more
 * than once, so that count has to be derived from the conversation rather than
 * remembered across renders: a node that re-renders after a reload must reach the
 * same decision. Steps that lie outside the loaded window cannot be counted, so a
 * cropped window under-counts — and under-counting keeps the names on the line,
 * which is the informative direction.
 *
 * @param nodes - loaded Conversation nodes, structurally.
 * @param turn - Turn whose earlier misses to count.
 * @param step - Step being rendered; its own miss is not counted here.
 */
export function turnMissesBefore(nodes: unknown, turn: number, step: number): number {
  if (!Array.isArray(nodes)) return 0
  let misses = 0
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue
    const record = node as { kind?: unknown; turn?: unknown; step?: unknown; usage?: unknown }
    if (record.kind !== 'assistant' || record.turn !== turn) continue
    if (typeof record.step !== 'number' || record.step >= step) continue
    if (record.usage === null || typeof record.usage !== 'object') continue
    if (isCacheMiss(asCacheUsage(record.usage as UsageLike))) misses += 1
  }
  return misses
}

/** Loaded-window totals the line reports after its own amount. */
export interface LineTotals {
  /** Prompt cost of the whole Turn, over the loaded window. */
  turn: number
  /** Prompt cost of the session, over the loaded window. */
  session: number
}

/**
 * Decide which rebuild a miss pays for, and how much it cost.
 *
 * A miss on the Turn's first request rebuilt the whole conversation context, so
 * its amount is labelled `turn`. A later request only rewrote the prefix it
 * changed, so its amount is labelled `step`. When the same Turn had both, the
 * line reports their sum without a scope label — two amounts a reader would have
 * to add up make the notice worse, not clearer.
 *
 * @param turn - Turn the notice belongs to.
 * @param step - Step the request ran as.
 * @param price - resolved list price for the request's model, or undefined.
 * @param stepCost - this request's prompt cost.
 * @param totals - loaded-window totals, or undefined when the model is unpriced.
 * @param nodes - loaded assistant records, for the Turn's first request.
 */
export function lineCost(
  turn: number,
  step: number,
  price: ModelPrice | undefined,
  stepCost: PrefillCost | undefined,
  totals: LineTotals | undefined,
  nodes: unknown,
): LineCost | undefined {
  if (price === undefined || stepCost === undefined) return undefined
  const stepAmount = totalOf(stepCost)
  const session = totals?.session
  const withSession = session === undefined ? {} : { session }
  if (step <= 1) return { scope: 'turn', amount: stepAmount, ...withSession }
  const firstUsage = asCacheUsage(loadedStepUsage(nodes, turn, 1))
  if (firstUsage === undefined || !isCacheMiss(firstUsage)) {
    return { scope: 'step', amount: stepAmount, ...withSession }
  }
  return { scope: 'both', amount: totalOf(prefillCost(price, firstUsage)) + stepAmount, ...withSession }
}
