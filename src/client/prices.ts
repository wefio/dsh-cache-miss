import { MODEL_PRICES, type ModelPrice } from './prices.gen'

export { MODEL_PRICES, PRICE_SNAPSHOT, PRICE_SOURCE, type ModelPrice } from './prices.gen'

/**
 * USD → CNY conversion used for the displayed amounts.
 *
 * models.dev publishes list prices in USD, while the line shows approximate RMB.
 * A fixed conversion keeps the display free of a network call; the `~` prefix on
 * every amount marks it as an estimate (the provider's own invoice is authoritative).
 */
export const CNY_PER_USD = 7.2

/** Currency symbol shown in front of every amount. */
export const CURRENCY = '¥'

/** Token accounting read structurally, so this module needs no contract import. */
export interface UsageLike {
  readonly inputTokens?: unknown
  readonly cacheReadTokens?: unknown
  readonly cacheWriteTokens?: unknown
}

/** One request's prompt cost split the same way the notice line splits tokens. */
export interface PrefillCost {
  /** Uncached prompt input (plus cache writes, billed at the miss price). */
  readonly rebilled: number
  /** Cache-hit prompt input; undefined when the provider reported no hit count. */
  readonly cached: number | undefined
}

/**
 * Resolve a provider-reported model id against the models.dev snapshot.
 *
 * Providers report ids in several spellings (`deepseek-flash`,
 * `deepseek/deepseek-v4-flash`, `deepseek-v4-flash-0813`), so the id is matched
 * verbatim first and then by its last path segment with a trailing release date
 * removed. An unknown model yields undefined and the line omits the amounts —
 * a made-up price is worse than no price.
 *
 * @param model - model id from the assistant message source, when reported.
 */
export function resolveModelPrice(model: unknown): ModelPrice | undefined {
  if (typeof model !== 'string') return undefined
  const key = model.trim().toLowerCase()
  if (key === '') return undefined
  const direct = MODEL_PRICES[key]
  if (direct !== undefined) return direct
  const tail = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
  const exactTail = MODEL_PRICES[tail]
  if (exactTail !== undefined) return exactTail
  const withoutDate = tail.replace(/-\d{4,8}$/, '')
  return MODEL_PRICES[withoutDate]
}

/**
 * Prompt cost of one request, in USD.
 *
 * Output tokens are deliberately excluded: the notice is about what the prompt
 * cost, and the totals compare the same basis across steps.
 *
 * @param price - resolved list price.
 * @param usage - the request's token accounting.
 */
export function prefillCost(price: ModelPrice, usage: UsageLike): PrefillCost {
  const input = typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0
  const writes = typeof usage.cacheWriteTokens === 'number' && Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0
  const reads = typeof usage.cacheReadTokens === 'number' && Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : undefined
  return {
    rebilled: ((input + writes) * price.input) / 1_000_000,
    cached: reads === undefined ? undefined : (reads * price.cacheRead) / 1_000_000,
  }
}

/** Prefill cost of a cost record, in USD. */
export function totalOf(cost: PrefillCost): number {
  return cost.rebilled + (cost.cached ?? 0)
}

/**
 * Prefill cost of the loaded conversation window, per Turn and in total, in USD.
 *
 * Nodes are read structurally: the renderer hands over the chat snapshot's
 * legacy slice, whose assistant records carry `turn` and `usage`. The session
 * figure therefore covers the loaded window — older Turns that the chat view has
 * not loaded are not counted, which is why the line labels it as an estimate.
 *
 * @param nodes - loaded Conversation nodes, structurally.
 * @param price - resolved list price for the current model.
 * @param turn - Turn the notice belongs to, when known.
 * @returns the two totals, or undefined when the snapshot exposes no node list.
 */
export function loadedPrefillTotals(
  nodes: unknown,
  price: ModelPrice,
  turn: number | undefined,
): { turn: number; session: number } | undefined {
  let turnTotal = 0
  let sessionTotal = 0
  if (!Array.isArray(nodes)) return undefined
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue
    const record = node as { kind?: unknown; turn?: unknown; usage?: unknown }
    if (record.kind !== 'assistant') continue
    if (record.usage === null || typeof record.usage !== 'object') continue
    const total = totalOf(prefillCost(price, record.usage as UsageLike))
    sessionTotal += total
    if (typeof record.turn === 'number' && record.turn === turn) turnTotal += total
  }
  return { turn: turnTotal, session: sessionTotal }
}

/**
 * Format one USD amount as approximate RMB, without the parentheses or symbol.
 *
 * Three decimals below one yuan keep sub-cent amounts visible (0.003), two
 * decimals above keep the line short.
 *
 * @param usd - amount in USD, as models.dev publishes it.
 * @returns the amount in CNY, as digits only.
 */
export function formatCost(usd: number): string {
  const cny = usd * CNY_PER_USD
  if (!Number.isFinite(cny) || cny <= 0) return '0.000'
  return cny >= 1 ? cny.toFixed(2) : cny >= 0.1 ? cny.toFixed(2) : cny.toFixed(3)
}

