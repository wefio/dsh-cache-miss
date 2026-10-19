/**
 * What one `/compact` cost and how long it takes to pay back.
 *
 * A compaction is two charges — the summarization call and the rebuild of the
 * first request after it — bought to stop paying for the context that was
 * dropped. The payback is the number of model calls after the compaction whose
 * saved cache-read price covers those two charges, from the same usage records
 * the notice line already prices.
 */

/** Token counts one compaction is decided by. */
export interface CompactFacts {
  /** Prompt tokens before compaction: the last step's prompt. */
  readonly A: number
  /** Prompt tokens after compaction: the first step's prompt. */
  readonly B: number
  /** Uncached tokens of the first request after compaction (the rebuild). */
  readonly U: number
  /** Summary output tokens, from the summarization call's own usage. */
  readonly S: number
  /** Uncached tokens of the summarization call itself. */
  readonly Mc: number
}

/** One model's list prices, USD per 1M tokens. */
export interface CompactPrice {
  readonly input: number
  readonly cacheRead: number
  readonly output: number
}

/** What the compaction costs and what it buys. */
export interface CompactTotals {
  /** Summarization call: its own re-billed input plus its output. */
  readonly compactCost: number
  /** First request after compaction, billed at the uncached price. */
  readonly rebuildCost: number
  /** Prompt money saved per later model call. */
  readonly perStepSaved: number
  /** Model calls after the compaction needed to cover both charges. */
  readonly steps: number
}

/**
 * Break-even model calls after one compaction.
 *
 * The compacted path pays `A` cached tokens to summarise, rebuilds `B` at the
 * uncached price, and then saves `(A − B)` cached tokens per call. Solving
 * `N·(A − B)·P_hit > A·P_hit + (P_miss − P_hit)·(M_c + U) + S·P_out` for the
 * smallest integer `N` gives the closed form below, with both ratios taken from
 * the caller's price list rather than hard-coded.
 *
 * @param facts - token counts of the decision.
 * @param price - list price of the model that priced it.
 * @returns break-even step count, or undefined when compaction saved nothing.
 */
export function compactSteps(facts: CompactFacts, price: CompactPrice): number | undefined {
  if (facts.A <= facts.B) return undefined
  const missOverHit = price.input / price.cacheRead - 1
  const outOverHit = price.output / price.cacheRead
  const quotient = (facts.A + missOverHit * (facts.U + facts.Mc) + outOverHit * facts.S) / (facts.A - facts.B)
  return Math.floor(quotient) + 1
}

/**
 * Price one compaction and its rebuild.
 *
 * @param facts - token counts of the decision.
 * @param price - list price of the model that priced it.
 * @returns the two charges and the payback, or undefined when nothing was saved.
 */
export function compactTotals(facts: CompactFacts, price: CompactPrice): CompactTotals | undefined {
  const steps = compactSteps(facts, price)
  if (steps === undefined) return undefined
  return {
    compactCost: (facts.Mc * price.input + facts.S * price.output) / 1e6,
    rebuildCost: (facts.U * price.input) / 1e6,
    perStepSaved: ((facts.A - facts.B) * price.cacheRead) / 1e6,
    steps,
  }
}

/** Tokens as the notice line abbreviates them, so the two rows read alike. */
export function formatTokens(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${Math.max(1, Math.round(tokens / 1000))}k`
}

/** USD with enough digits to stay readable at these magnitudes. */
function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '0.000'
  if (usd >= 0.1) return usd.toFixed(2)
  if (usd >= 0.01) return usd.toFixed(3)
  return usd.toFixed(4)
}

/**
 * One compaction as its own line.
 *
 * The two charges are summed into a single cost because a reader deciding
 * whether the compaction was worth it cares about the total buy-in, not about
 * which half of it was the summary. `~` marks both amounts as estimates.
 *
 * @param facts - token counts of the decision.
 * @param totals - priced totals from {@link compactTotals}.
 * @returns e.g. `Compacted 607k → 69k · cost ~$0.083 · saves ~$0.0016/step · pays back in 52 steps`.
 */
export function formatCompactLine(facts: CompactFacts, totals: CompactTotals): string {
  return [
    `Compacted ${formatTokens(facts.A)} → ${formatTokens(facts.B)}`,
    `cost ~$${formatUsd(totals.compactCost + totals.rebuildCost)}`,
    `saves ~$${formatUsd(totals.perStepSaved)}/step`,
    `pays back in ${totals.steps} steps`,
  ].join(' · ')
}
