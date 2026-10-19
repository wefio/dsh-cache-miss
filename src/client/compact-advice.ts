/**
 * Whether to run `/compact` now, before it has been run.
 *
 * The payback line prices a compaction after the fact. This one answers the same
 * question in advance, from what a settled step actually shows: the context it
 * billed, whether its prefix was cached, and what past compactions retained.
 *
 * Two of the five facts a compaction is decided by cannot be read from the
 * current step — how much it will retain and how much its summary will say —
 * so they come from a prior: the medians of the compactions already measured in
 * this session, or the medians of the ones measured while building this plugin.
 * Both are stated as such, and every number the line shows is marked an estimate.
 */

import { compactSteps, formatTokens, type CompactFacts, type CompactPrice } from './compact-cost'

/**
 * Model calls a compaction has to be useful for.
 *
 * Payback is a division: a compaction is a loan against the steps that follow
 * it, so it is only worth taking when enough of them are still coming. Twenty
 * is the span a working session usually still has left when the context has
 * grown to where compaction is even possible.
 */
export const ADVICE_HORIZON = 20

/** Storage key overriding {@link ADVICE_HORIZON}, for a reader who knows their own pace. */
export const HORIZON_FLAG = 'dsh-cache-miss:advice-horizon'

/**
 * Read the payback horizon, falling back to {@link ADVICE_HORIZON}.
 *
 * Twenty Steps is the one number in the advice the plugin cannot derive: it knows
 * the price but not how much work is left. Anyone who does know can say so —
 * `localStorage.setItem('dsh-cache-miss:advice-horizon', '40')` — the same opt-in
 * gesture as the debug switch, and equally silent when unset.
 *
 * @param storage - Storage-like reader, defaulting to the page's `localStorage`.
 */
export function readHorizon(storage?: { getItem(key: string): string | null } | null): number {
  let reader = storage
  if (reader === undefined) {
    try {
      reader = typeof localStorage === 'undefined' ? null : localStorage
    } catch {
      reader = null
    }
  }
  if (reader === null || reader === undefined) return ADVICE_HORIZON
  try {
    const raw = reader.getItem(HORIZON_FLAG)
    if (raw === null) return ADVICE_HORIZON
    const value = Number(raw)
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : ADVICE_HORIZON
  } catch {
    return ADVICE_HORIZON
  }
}

/**
 * Prompt tokens below which compaction is not worth discussing.
 *
 * A summary has to read the prefix to summarise it, so the fixed part of its
 * price does not shrink with the context. Under this size that fixed part
 * dominates whatever the compaction could save.
 */
export const ADVICE_MIN_CONTEXT = 60_000

/** One measured compaction, reduced to what predicts the next one. */
export interface CompactionSample {
  /** Prompt tokens before the compaction. */
  readonly A: number
  /** Prompt tokens after it. */
  readonly B: number
  /** Summary output tokens it paid for. */
  readonly S: number
}

/** What past compactions retained and how much they wrote. */
export interface CompactionPrior {
  /** Prompt tokens a compaction keeps, as an absolute size. */
  readonly B: number
  /** Summary output tokens. */
  readonly S: number
}

/**
 * Fallback prior: the median retention of the compactions in
 * `docs/data/compactions.json` (27 usable), rounded to the nearest thousand.
 * Retained context ranged 21.8k–100.3k across a 115k–732k spread of inputs, so the
 * retained size is predicted as an absolute number rather than as a fraction of the
 * input — and `tests/dataset.spec.ts` keeps this constant tied to that file.
 */
export const DEFAULT_PRIOR: CompactionPrior = { B: 79_000, S: 4_000 }

/**
 * How often the summarization call hits the prompt cache.
 *
 * Derived rather than chosen: `docs/data/compactions.json` counts 14 of 27 usable
 * compactions whose summary call re-billed less than half its prefix, and
 * `tests/dataset.spec.ts` fails if this constant and that file disagree. The 95%
 * interval is 34–69%, which is why the notice quotes it as a coin flip and not as a
 * rate to plan around.
 *
 * Nothing in the log separates the two groups: the gap since the last step, the size
 * of the shadowed range, the model and the previous step's own cache state all
 * overlap. The summary request is built from the shadowed range with its own
 * instruction, and the request body is not persisted (`llmStreamCall` is only a
 * boolean), so its prefix cannot be inspected after the fact.
 */
export const SUMMARY_HIT_RATE = 0.52

/**
 * The band a compaction actually retains inside.
 *
 * From `docs/data/compactions.json`: retained context ran 21.8k–100.3k across a
 * 115k–732k spread of inputs, so it is an absolute size rather than a fraction of
 * the input. Nothing visible in a session predicts where in the band the next
 * compaction lands — the sum of the last few steps' growth predicts it at a
 * correlation of 0.06, worse than a constant. So the prediction is the median and
 * this band is what the decision is gated on: the notice speaks only when compacting
 * still pays back with the compaction retaining the most it has ever been seen to
 * keep.
 */
export const RETENTION_BAND = { low: 21_000, high: 101_000 } as const

/** Middle value, or undefined for an empty list. */
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle]
  if (upper === undefined) return undefined
  if (sorted.length % 2 === 1) return upper
  const lower = sorted[middle - 1]
  return lower === undefined ? undefined : (lower + upper) / 2
}

/**
 * Prior learned from the compactions this session has measured.
 *
 * Each field falls back independently, so a session with one usable sample
 * still contributes the half it measured.
 *
 * @param samples - compactions measured so far in this session.
 * @returns retained size and summary size to predict with.
 */
export function priorFromSamples(samples: readonly CompactionSample[]): CompactionPrior {
  const retained = median(samples.filter((sample) => sample.B > 0).map((sample) => sample.B))
  const written = median(samples.filter((sample) => sample.S > 0).map((sample) => sample.S))
  return {
    B: retained ?? DEFAULT_PRIOR.B,
    S: written ?? DEFAULT_PRIOR.S,
  }
}

/** What a settled step shows about the decision. */
export interface AdviceInput {
  /** Prompt tokens the step billed, cached and uncached together. */
  readonly A: number
  /** Prior to predict with; defaults to {@link DEFAULT_PRIOR}. */
  readonly prior?: CompactionPrior
}

/** The decision, with the prediction folded in. */
export interface AdviceFacts {
  /** Prompt tokens now, i.e. the size a compaction would replace. */
  readonly A: number
  /** Prompt tokens the compaction is predicted to keep. */
  readonly B: number
  /** Prompt tokens it would keep if it retains as much as it ever has. */
  readonly BHigh: number
  /** Summary output tokens it is predicted to write. */
  readonly S: number
}

/**
 * Predict what compacting at this context size would do.
 *
 * @param input - what the settled step shows.
 * @returns the prediction, or undefined when the context is too small to discuss.
 */
export function predictAdvice(input: AdviceInput): AdviceFacts | undefined {
  const prior = input.prior ?? DEFAULT_PRIOR
  if (!(input.A >= ADVICE_MIN_CONTEXT)) return undefined
  // A compaction cannot be predicted to keep more than it replaces; capping just
  // under the input is what makes the prediction decline as the context grows.
  const cap = Math.round(input.A * 0.9)
  const B = Math.max(2_000, Math.min(Math.round(prior.B), cap))
  const BHigh = Math.max(B, Math.min(RETENTION_BAND.high, cap))
  return {
    A: input.A,
    B,
    BHigh,
    S: Math.max(1, Math.round(prior.S)),
  }
}

/** Both halves of a decision that cannot be made for you. */
export interface AdviceVerdict {
  /** Model calls to pay back when the summarization call hits the cache. */
  readonly hitSteps: number
  /** Model calls to pay back when it re-bills the prefix instead. */
  readonly missSteps: number | undefined
  /** How often the summarization call hits, measured. */
  readonly hitRate: number
}

/**
 * Price both halves of the decision.
 *
 * The two branches are not a choice: whether the summarization call hits its cache
 * is not visible before the fact (see {@link SUMMARY_HIT_RATE}). What the plugin
 * can decide is whether compacting here is worth it *at all* when it goes well, so
 * the gate uses the least favourable retention seen — otherwise the line would
 * advertise a moment that may never exist.
 *
 * @param facts - prediction from {@link predictAdvice}.
 * @param price - list price of the model that would summarise.
 * @param horizon - model calls the compaction has to be useful for.
 * @returns the verdict, or undefined when even the good half misses the horizon.
 */
export function adviceVerdict(
  facts: AdviceFacts,
  price: CompactPrice,
  horizon = ADVICE_HORIZON,
): AdviceVerdict | undefined {
  // The summary re-reads the prefix it summarises, then that same prefix is rebuilt
  // once by the first request after it; both are folded in as `U`.
  const stepsFor = (B: number, hits: boolean): number | undefined => compactSteps({
    A: facts.A, B, U: B, S: facts.S, Mc: hits ? 0 : facts.A,
  } satisfies CompactFacts, price)
  const worstHit = stepsFor(facts.BHigh, true)
  const hitSteps = stepsFor(facts.B, true)
  if (hitSteps === undefined || worstHit === undefined || worstHit > horizon) return undefined
  return { hitSteps, missSteps: stepsFor(facts.B, false), hitRate: SUMMARY_HIT_RATE }
}

/**
 * One decision as its own line, shaped like the payback line it anticipates.
 *
 * The line never asserts a single payback: it quotes the cheap half, the expensive
 * half and how often each comes up, because the summary's cache hit is the coin
 * flip that decides which one you get.
 *
 * @param facts - prediction from {@link predictAdvice}.
 * @param verdict - decision from {@link adviceVerdict}.
 * @returns e.g. `Compact window · 620k → ~84k · pays back in ~11 steps if the summary hits, ~68 if it misses (~54%)`.
 */
export function formatAdviceLine(facts: AdviceFacts, verdict: AdviceVerdict): string {
  const size = `${formatTokens(facts.A)} → ~${formatTokens(facts.B)}`
  const miss = verdict.missSteps === undefined
    ? ''
    : `, ~${verdict.missSteps} if it misses`
  const rate = `(~${Math.round(verdict.hitRate * 100)}%)`
  return `Compact window · ${size} · pays back in ~${verdict.hitSteps} steps if the summary hits${miss} ${rate}`
}

