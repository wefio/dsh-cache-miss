import { describe, expect, it } from 'vitest'
import {
  formatCost,
  loadedPrefillTotals,
  prefillCost,
  resolveModelPrice,
  type ModelPrice,
} from '../src/client/prices'
import { formatLine } from '../src/client/logic'

describe('resolveModelPrice', () => {
  it('matches a provider-reported id verbatim', () => {
    expect(resolveModelPrice('deepseek-flash')).toEqual({ input: 0.15, cacheRead: 0.003, output: 0.6 })
  })

  it('matches through a provider prefix and a release-date suffix', () => {
    expect(resolveModelPrice('deepseek/deepseek-v4-pro')?.input).toBe(0.66)
    expect(resolveModelPrice('deepseek-v4-flash-0813')?.input).toBe(0.15)
  })

  it('is case-insensitive', () => {
    expect(resolveModelPrice('DeepSeek-V4-Pro')?.output).toBe(1.98)
  })

  it('returns undefined for an unknown or absent model instead of guessing a price', () => {
    expect(resolveModelPrice('some-relay-model')).toBeUndefined()
    expect(resolveModelPrice(undefined)).toBeUndefined()
    expect(resolveModelPrice(42)).toBeUndefined()
    expect(resolveModelPrice('')).toBeUndefined()
  })
})

describe('prefillCost', () => {
  const flash: ModelPrice = { input: 0.15, cacheRead: 0.003, output: 0.6 }

  it('prices uncached input and cache reads on their own rates', () => {
    const cost = prefillCost(flash, { inputTokens: 1_000_000, cacheReadTokens: 1_000_000 })
    expect(cost.rebilled).toBeCloseTo(0.15, 10)
    expect(cost.cached).toBeCloseTo(0.003, 10)
  })

  it('bills cache writes at the miss rate and keeps an unreported hit count undefined', () => {
    const cost = prefillCost(flash, { inputTokens: 0, cacheWriteTokens: 2_000_000 })
    expect(cost.rebilled).toBeCloseTo(0.3, 10)
    expect(cost.cached).toBeUndefined()
  })

  it('keeps an explicit zero hit count', () => {
    expect(prefillCost(flash, { inputTokens: 1000, cacheReadTokens: 0 }).cached).toBe(0)
  })
})

describe('loadedPrefillTotals', () => {
  const flash: ModelPrice = { input: 0.15, cacheRead: 0.003, output: 0.6 }
  const assistant = (turn: number, inputTokens: number) => ({ kind: 'assistant', turn, usage: { inputTokens } })

  it('sums the loaded window into a Turn total and a session total', () => {
    const nodes = [assistant(7, 1_000_000), assistant(8, 2_000_000), { kind: 'user', turn: 8 }]
    const totals = loadedPrefillTotals(nodes, flash, 8)
    expect(totals.turn).toBeCloseTo(0.3, 10)
    expect(totals.session).toBeCloseTo(0.45, 10)
  })

  it('ignores records without usage and non-array input', () => {
    expect(loadedPrefillTotals([{ kind: 'assistant', turn: 1 }], flash, 1)).toEqual({ turn: 0, session: 0 })
    expect(loadedPrefillTotals(undefined, flash, 1)).toBeUndefined()
  })
})

describe('formatCost', () => {
  it('shows three decimals below one dollar so sub-cent amounts stay visible', () => {
    expect(formatCost(0.001)).toBe('0.001')
    expect(formatCost(0.0523)).toBe('0.052')
  })

  it('shows two decimals from one tenth up', () => {
    expect(formatCost(0.48)).toBe('0.480')
    expect(formatCost(1)).toBe('1.00')
  })

  it('never renders a negative or non-finite amount', () => {
    expect(formatCost(-1)).toBe('0.000')
    expect(formatCost(Number.NaN)).toBe('0.000')
  })
})

describe('formatLine with amounts', () => {
  it('labels a Turn-level rebuild with the official turn word', () => {
    const line = formatLine({
      idleMs: 3 * 60_000,
      rebilledTokens: 182_000,
      cacheReadTokens: 800,
      ttftMs: 2_100,
      cost: { scope: 'turn', amount: 0.0273 },
    })
    expect(line).toBe(
      'Cache miss after 3m idle · 182k tokens re-billed (turn ~$0.027) · 1k cached · ttft 2.1s ↑',
    )
  })

  it('labels a mid-Turn rebuild as step, and a Turn+Step rebuild as one unlabelled total', () => {
    const midTurn = formatLine({
      idleMs: 0,
      rebilledTokens: 26_000,
      cacheReadTokens: 0,
      ttftMs: 1_600,
      step: 17,
      cost: { scope: 'step', amount: 0.004 },
    })
    expect(midTurn).toBe('Cache miss at step 17 · 26k tokens re-billed (step ~$0.004) · 0k cached · ttft 1.6s ↑')

    const both = formatLine({
      idleMs: 60_000,
      rebilledTokens: 22_000,
      cacheReadTokens: 0,
      ttftMs: 8_100,
      cost: { scope: 'both', amount: 0.134, session: 2.9 },
    })
    expect(both).toBe(
      'Cache miss after 1m idle · 22k tokens re-billed (~$0.134) · 0k cached · ttft 8.1s ↑ · session used (~$2.90)',
    )
  })

  it('shows no amounts at all when the model has no list price', () => {
    const line = formatLine({ idleMs: 0, rebilledTokens: 22_000, cacheReadTokens: 0, ttftMs: 1_200 })
    expect(line).toBe('Cache miss after 0s idle · 22k tokens re-billed · 0k cached · ttft 1.2s ↑')
  })

})







