import { describe, expect, it } from 'vitest'
import { compactSteps, compactTotals, formatCompactLine, type CompactFacts } from '../src/client/compact-cost'
import { compactionDefinition, recordStepPrompt, type CompactionState } from '../src/client/compaction-node'

/** List price of `deepseek-flash` on models.dev, USD per 1M tokens. */
const FLASH = { input: 0.15, cacheRead: 0.003, output: 0.6 }

/** One measured compaction: 607k → 69k, summary fully missed, rebuild mostly missed. */
const MEASURED: CompactFacts = { A: 606507, B: 68789, U: 67765, S: 5569, Mc: 464146 }

describe('compactSteps', () => {
  it('reproduces the break-even measured on a real compaction', () => {
    expect(compactSteps(MEASURED, FLASH)).toBe(52)
  })

  it('reproduces a compaction whose summarization call hit the cache', () => {
    expect(compactSteps({ A: 628960, B: 21807, U: 21807, S: 4282, Mc: 474 }, FLASH)).toBe(5)
  })

  it('takes its ratios from the price list instead of hard-coding flash', () => {
    // pro is 30×/90×, so the same token counts need fewer calls to pay back.
    const pro = { input: 0.66, cacheRead: 0.022, output: 1.98 }
    expect(compactSteps(MEASURED, pro)).toBeLessThan(compactSteps(MEASURED, FLASH) ?? 0)
  })

  it('has no payback when the compaction kept as much as it dropped', () => {
    expect(compactSteps({ ...MEASURED, B: MEASURED.A }, FLASH)).toBeUndefined()
    expect(compactSteps({ ...MEASURED, B: MEASURED.A + 1000 }, FLASH)).toBeUndefined()
  })
})

describe('compactTotals / formatCompactLine', () => {
  it('splits the buy-in into the summary call and the rebuild', () => {
    const totals = compactTotals(MEASURED, FLASH)!
    expect(totals.compactCost).toBeCloseTo(0.072963, 6)
    expect(totals.rebuildCost).toBeCloseTo(0.010165, 6)
    expect(totals.perStepSaved).toBeCloseTo(0.001613, 6)
    expect(totals.steps).toBe(52)
  })

  it('renders one line with the payback in model calls', () => {
    expect(formatCompactLine(MEASURED, compactTotals(MEASURED, FLASH)!))
      .toBe('Compacted 607k → 69k · cost ~$0.083 · saves ~$0.0016/step · pays back in 52 steps')
  })

  it('renders no totals when nothing was dropped', () => {
    expect(compactTotals({ ...MEASURED, B: MEASURED.A }, FLASH)).toBeUndefined()
  })
})

/** The two payload shapes this Definition reads, minimally. */
function summaryEvent(id: string, usage: unknown, shadowed = 0): any {
  return {
    type: 'compaction/summary',
    seq: 90,
    time: 5000,
    data: { compactionId: id, model: 'deepseek-flash', shadowedTokenCount: shadowed, usage },
  }
}

/** One settled step, as the compaction's first request after it reports itself. */
function stepMessage(seq: number, usage: unknown, model = 'deepseek-flash'): any {
  return {
    type: 'assistant/message',
    seq,
    time: 6000,
    data: { turn: 8, step: 1, message: { source: { provider: 'deepseek-official', model } }, usage },
  }
}

/** Context around one compaction state, shaped like the registry's. */
function contextWith(state: CompactionState): any {
  return {
    key: 'k',
    id: state.compactionId,
    kind: 'compaction-cost',
    target: 'chat',
    state,
    start: { event: summaryEvent(state.compactionId, undefined), role: 'start', location: { kind: 'turn', turn: {} } },
    matches: [],
  }
}

describe('compactionDefinition.match', () => {
  it('opens a context on the compaction summary', () => {
    expect(compactionDefinition.match!(summaryEvent('c1', { inputTokens: 100 }) as any))
      .toEqual({ id: 'c1', role: 'start' })
  })

  it('routes the next settled step into the compaction it rebuilds for', () => {
    compactionDefinition.match!(summaryEvent('c2', { inputTokens: 100 }) as any)
    expect(compactionDefinition.match!(stepMessage(91, { inputTokens: 10 }) as any))
      .toEqual({ id: 'c2', role: 'update' })
  })

  it('stops consuming steps after the rebuild it measured', () => {
    compactionDefinition.match!(summaryEvent('c3', { inputTokens: 100 }) as any)
    const state: CompactionState = {
      compactionId: 'c3', A: 600000, Mc: 100, S: 10, shadowed: 0, model: 'deepseek-flash',
      B: 20000, U: 20000, done: true, time: 5000,
    }
    compactionDefinition.update!(contextWith(state) as any, { event: stepMessage(91, { inputTokens: 10 }) } as any)
    expect(compactionDefinition.match!(stepMessage(92, { inputTokens: 10 }) as any)).toBeNull()
  })

  it('ignores everything else', () => {
    expect(compactionDefinition.match!({ type: 'compaction/prune', seq: 1, data: {} } as any)).toBeNull()
    expect(compactionDefinition.match!({ type: 'step/start', seq: 2, data: { turn: 1, step: 1 } } as any)).toBeNull()
  })

  it('ignores a summary without an id', () => {
    expect(compactionDefinition.match!({ type: 'compaction/summary', seq: 3, data: {} } as any)).toBeNull()
  })
})

describe('compactionDefinition.start / update / buildViewNode', () => {
  it('reads the context size before compaction from the last settled step', () => {
    recordStepPrompt({ inputTokens: 600000, cacheReadTokens: 6507 })
    const state = compactionDefinition.start!({} as any, {
      event: summaryEvent('c4', { inputTokens: 464146, outputTokens: 5569 }, 409962),
    } as any)
    expect(state).toMatchObject({ A: 606507, Mc: 464146, S: 5569, shadowed: 409962, done: false })
    expect(compactionDefinition.buildViewNode!(contextWith(state) as any)).toBeNull()
  })

  it('measures B and the rebuild U from the first step after it', () => {
    recordStepPrompt({ inputTokens: 600000, cacheReadTokens: 6507 })
    const opened = compactionDefinition.start!({} as any, {
      event: summaryEvent('c5', { inputTokens: 464146, outputTokens: 5569 }) as any,
    } as any)
    const state = compactionDefinition.update!(contextWith(opened) as any, {
      event: stepMessage(91, { inputTokens: 67765, cacheReadTokens: 1024 }),
    } as any)
    expect(state).toMatchObject({ B: 68789, U: 67765, done: true })
    const node = compactionDefinition.buildViewNode!(contextWith(state) as any)!
    expect(node.kind).toBe('compaction-cost')
    expect(node.data).toMatchObject({ A: 606507, B: 68789, U: 67765, S: 5569, Mc: 464146 })
  })

  it('publishes nothing when the rebuild reported no usage', () => {
    const opened = compactionDefinition.start!({} as any, {
      event: summaryEvent('c6', { inputTokens: 100, outputTokens: 10 }) as any,
    } as any)
    const state = compactionDefinition.update!(contextWith(opened) as any, {
      event: { type: 'assistant/message', seq: 91, time: 6000, data: {} } as any,
    } as any)
    expect(compactionDefinition.buildViewNode!(contextWith(state) as any)).toBeNull()
  })

  it('publishes nothing when the compaction dropped no context', () => {
    const state: CompactionState = {
      compactionId: 'c7', A: 50000, Mc: 100, S: 10, shadowed: 0, model: 'deepseek-flash',
      B: 50000, U: 40000, done: true, time: 5000,
    }
    expect(compactionDefinition.buildViewNode!(contextWith(state) as any)).toBeNull()
  })
})
