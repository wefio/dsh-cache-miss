import { beforeEach, describe, expect, it } from 'vitest'
import {
  adviceVerdict, formatAdviceLine, predictAdvice, priorFromSamples, readHorizon, DEFAULT_PRIOR, SUMMARY_HIT_RATE,
} from '../src/client/compact-advice'
import { adviceDefinition, adviceSamples, recordAdviceSample, resetAdviceWindow, type AdviceState } from '../src/client/advice-node'

/** List price of `deepseek-flash` on models.dev, USD per 1M tokens. */
const FLASH = { input: 0.15, cacheRead: 0.003, output: 0.6 }

/** One settled step: `A` prompt tokens of which `U` were uncached. */
function stepEvent(A: number, U: number, step = 1, model = 'deepseek-flash'): any {
  return {
    type: 'assistant/message',
    seq: 100 + step,
    time: 7000,
    data: {
      turn: 3,
      step,
      message: { source: { provider: 'deepseek-official', model } },
      usage: { inputTokens: U, cacheReadTokens: A - U },
    },
  }
}

/** Context around one advice state, shaped like the registry's. */
function contextWith(state: AdviceState): any {
  return {
    key: 'k',
    id: `${state.turn}:${state.step}`,
    kind: 'compact-advice',
    target: 'chat',
    state,
    start: { event: stepEvent(1, 1), role: 'start', location: { kind: 'turn', turn: {} } },
    matches: [],
  }
}

describe('priorFromSamples', () => {
  it('uses the medians of what it has measured', () => {
    expect(priorFromSamples([
      { A: 600000, B: 22000, S: 3000 },
      { A: 240000, B: 84000, S: 5000 },
      { A: 400000, B: 100000, S: 4000 },
    ])).toEqual({ B: 84000, S: 4000 })
  })

  it('falls back to the medians of the measured compactions for an empty session', () => {
    expect(DEFAULT_PRIOR).toEqual({ B: 79000, S: 4000 })
    expect(priorFromSamples([])).toEqual(DEFAULT_PRIOR)
  })

  it('contributes the half it measured', () => {
    expect(priorFromSamples([{ A: 600000, B: 0, S: 3000 }])).toEqual({ B: DEFAULT_PRIOR.B, S: 3000 })
  })
})

describe('predictAdvice', () => {
  it('predicts the retained size from the prior, not as a fraction of the input', () => {
    expect(predictAdvice({ A: 620000 })).toEqual({
      A: 620000, B: 79000, BHigh: 101000, S: 4000,
    })
  })

  it('never predicts keeping more than the context it replaces', () => {
    // Right after a compaction the prior is larger than the context itself.
    expect(predictAdvice({ A: 70000 })).toMatchObject({ B: 63000, BHigh: 63000 })
  })

  it('says nothing about a context too small for the summary to be worth it', () => {
    expect(predictAdvice({ A: 50000 })).toBeUndefined()
  })
})

describe('adviceVerdict', () => {
  const facts = predictAdvice({ A: 620000 })!

  it('quotes both halves and how often each comes up', () => {
    expect(adviceVerdict(facts, FLASH)).toEqual({ hitSteps: 10, missSteps: 66, hitRate: 0.52 })
    expect(SUMMARY_HIT_RATE).toBe(0.52)
  })

  it('takes its ratios from the price list instead of hard-coding flash', () => {
    const pro = { input: 0.66, cacheRead: 0.022, output: 1.98 }
    expect(adviceVerdict(facts, pro)!.hitSteps).toBeLessThan(adviceVerdict(facts, FLASH)!.hitSteps)
  })

  it('says nothing when even a warm compaction would not pay back in the horizon', () => {
    // A context barely above the size a compaction keeps leaves nothing to save.
    expect(adviceVerdict(predictAdvice({ A: 100000 })!, FLASH)).toBeUndefined()
  })

  it('stays silent where the retention band straddles the horizon', () => {
    const borderline = predictAdvice({ A: 350000 })!
    // Retaining the median 84k pays back in 20 calls; retaining the most ever
    // seen (100k) needs 25, so it waits rather than advertise a moment that may
    // not exist.
    expect(borderline).toMatchObject({ B: 79000, BHigh: 101000 })
    expect(adviceVerdict(borderline, FLASH)).toBeUndefined()
  })
})

describe('readHorizon', () => {
  /** Storage stub with one entry. */
  const storage = (value: string | null) => ({ getItem: () => value })

  it('defaults to the 20 Steps the plugin cannot derive', () => {
    expect(readHorizon(storage(null))).toBe(20)
    expect(readHorizon(null)).toBe(20)
  })

  it('takes an override from storage', () => {
    expect(readHorizon(storage('40'))).toBe(40)
    expect(readHorizon(storage('7.9'))).toBe(7)
  })

  it('ignores nonsense instead of gating on it', () => {
    expect(readHorizon(storage('soon'))).toBe(20)
    expect(readHorizon(storage('0'))).toBe(20)
    expect(readHorizon(storage('-5'))).toBe(20)
  })

  it('moves the gate with it', () => {
    const borderline = predictAdvice({ A: 350000 })!
    expect(adviceVerdict(borderline, FLASH, 20)).toBeUndefined()
    expect(adviceVerdict(borderline, FLASH, 40)).toBeDefined()
  })
})

describe('formatAdviceLine', () => {
  it('never promises one payback, because the summary hit is a coin flip', () => {
    const facts = predictAdvice({ A: 620000 })!
    expect(formatAdviceLine(facts, adviceVerdict(facts, FLASH)!))
      .toBe('Compact window · 620k → ~79k · pays back in ~10 steps if the summary hits, ~66 if it misses (~52%)')
  })
})

describe('adviceDefinition', () => {
  beforeEach(() => {
    resetAdviceWindow()
  })

  it('matches only settled steps', () => {
    expect(adviceDefinition.match!(stepEvent(620000, 1024) as any)).toEqual({ id: '3:1', role: 'start' })
    expect(adviceDefinition.match!({ type: 'step/start', seq: 1, data: { turn: 3, step: 1 } } as any)).toBeNull()
    expect(adviceDefinition.match!({ type: 'compaction/summary', seq: 2, data: {} } as any)).toBeNull()
  })

  it('opens a window on a step past the minimum size', () => {
    const state = adviceDefinition.start!({} as any, { event: stepEvent(620000, 1024) } as any)
    expect(state).toMatchObject({ A: 620000, U: 1024, step: 1 })
    const node = adviceDefinition.buildViewNode!(contextWith(state) as any)!
    expect(node.kind).toBe('compact-advice')
    expect(node.data).toMatchObject({ A: 620000, U: 1024 })
  })

  it('stays quiet until the context has grown by a quarter', () => {
    adviceDefinition.start!({} as any, { event: stepEvent(620000, 1024, 1) } as any)
    const same = adviceDefinition.start!({} as any, { event: stepEvent(700000, 1024, 2) } as any)
    expect(adviceDefinition.buildViewNode!(contextWith(same) as any)).toBeNull()
    const grown = adviceDefinition.start!({} as any, { event: stepEvent(800000, 1024, 3) } as any)
    expect(adviceDefinition.buildViewNode!(contextWith(grown) as any)).not.toBeNull()
  })

  it('does not treat a cold step as a different moment', () => {
    // The summary call's own cache state does not follow the step's, so a miss on
    // the step itself neither opens nor closes a window.
    adviceDefinition.start!({} as any, { event: stepEvent(620000, 1024, 1) } as any)
    const cold = adviceDefinition.start!({} as any, { event: stepEvent(620000, 620000, 2) } as any)
    expect(adviceDefinition.buildViewNode!(contextWith(cold) as any)).toBeNull()
  })

  it('says nothing below the minimum context size', () => {
    const small = adviceDefinition.start!({} as any, { event: stepEvent(50000, 500) } as any)
    expect(adviceDefinition.buildViewNode!(contextWith(small) as any)).toBeNull()
  })

  it('opens a fresh window once a compaction has closed the last one', () => {
    adviceDefinition.start!({} as any, { event: stepEvent(620000, 1024, 1) } as any)
    resetAdviceWindow()
    const state = adviceDefinition.start!({} as any, { event: stepEvent(620000, 1024, 2) } as any)
    expect(adviceDefinition.buildViewNode!(contextWith(state) as any)).not.toBeNull()
  })

  it('feeds the prediction from the compactions it has measured', () => {
    recordAdviceSample({ A: 600000, B: 30000, S: 2000 })
    expect(adviceSamples().at(-1)).toEqual({ A: 600000, B: 30000, S: 2000 })
    expect(predictAdvice({ A: 620000, prior: priorFromSamples(adviceSamples()) })?.B).toBe(30000)
  })
})




