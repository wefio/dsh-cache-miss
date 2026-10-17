import { MODEL_PRICES, type ModelPrice } from './prices.gen'
import { priceCatalog, requestPriceRefresh } from './prices-live'

export { MODEL_PRICES, PRICE_SNAPSHOT, PRICE_SOURCE, type ModelPrice } from './prices.gen'

/** Currency symbol shown in front of every amount. models.dev prices are USD,
 * so the line shows USD too: one less approximation between the catalog and the
 * reader, and nothing to guess about exchange rates. */
export const CURRENCY = '$'

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
 * Resolve a provider-reported model id inside one catalog.
 *
 * Providers report ids in several spellings (`deepseek-flash`,
 * `deepseek/deepseek-v4-flash`, `deepseek-v4-flash-0813`), so the id is matched
 * verbatim first and then by its last path segment with a trailing release date
 * removed. An unknown model yields undefined and the line omits the amounts —
 * a made-up price is worse than no price.
 *
 * @param catalog - price rows to resolve against.
 * @param model - model id from the assistant message source, when reported.
 */
export function resolveIn(
  catalog: Readonly<Record<string, ModelPrice>>,
  model: unknown,
): ModelPrice | undefined {
  if (typeof model !== 'string') return undefined
  const key = model.trim().toLowerCase()
  if (key === '') return undefined
  const direct = catalog[key]
  if (direct !== undefined) return direct
  const tail = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
  const exactTail = catalog[tail]
  if (exactTail !== undefined) return exactTail
  const withoutDate = tail.replace(/-\d{4,8}$/, '')
  return catalog[withoutDate]
}

/**
 * Resolve a provider-reported model id against the prices in force.
 *
 * A catalog refreshed from models.dev in the background wins, so a new model or a
 * reprice reaches existing installs without publishing a release; the bundled
 * snapshot answers when nothing has been refreshed (offline, first run, blocked
 * storage). Both go through the same spelling-tolerant lookup.
 *
 * @param model - model id from the assistant message source, when reported.
 */
export function resolveModelPrice(model: unknown): ModelPrice | undefined {
  return resolveIn(priceCatalog(), model) ?? resolveIn(MODEL_PRICES, model)
}

/**
 * Make sure a model can be priced, fetching the live catalog when it cannot.
 *
 * Called with the model of every rendered line. A model the bundled snapshot
 * knows costs nothing; a model it does not know — a newly released one, or one a
 * relay reports with a new spelling — triggers one background refresh, deduplicated
 * and rate-limited inside {@link requestPriceRefresh}. Line lengths and the offline
 * case behave exactly as before: an unresolvable model simply omits amounts.
 *
 * @param model - model id from the assistant message source, when reported.
 */
export function ensurePriceModel(model: unknown): void {
  if (resolveIn(MODEL_PRICES, model) !== undefined) return
  if (resolveIn(priceCatalog(), model) !== undefined) return
  requestPriceRefresh()
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
 * Usage of one loaded assistant record, looked up by Turn and Step.
 *
 * The notice decides which rebuild it pays for (the Turn's whole context or just
 * this Step) from the Turn's first request, so that request's accounting is read
 * straight out of the loaded window.
 *
 * @param nodes - loaded Conversation nodes, structurally.
 * @param turn - owning Turn.
 * @param step - owning Step.
 * @returns the record's usage, or undefined when it is not loaded.
 */
export function loadedStepUsage(nodes: unknown, turn: number | undefined, step: number): UsageLike | undefined {
  if (turn === undefined || !Array.isArray(nodes)) return undefined
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue
    const record = node as { kind?: unknown; turn?: unknown; step?: unknown; usage?: unknown }
    if (record.kind !== 'assistant' || record.turn !== turn || record.step !== step) continue
    if (record.usage === null || typeof record.usage !== 'object') continue
    return record.usage as UsageLike
  }
  return undefined
}

/**
 * Format one USD amount, without the parentheses or symbol.
 *
 * Three decimals below one dollar keep sub-cent amounts visible (0.003), two
 * decimals above keep the line short.
 *
 * @param usd - amount in USD, as models.dev publishes it.
 * @returns digits only.
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '0.000'
  // Whole dollars need cents; anything smaller needs the third decimal, which is
  // where most single-request amounts live (~.067, ~.134).
  return usd >= 1 ? usd.toFixed(2) : usd.toFixed(3)
}






