import { describe, expect, it } from 'vitest'
import { lineCost } from '../src/client/line-cost'
import { prefillCost } from '../src/client/prices'

const PRICE = { input: 0.15, cacheRead: 0.003, output: 0.6 }

/** A miss at the given step: nothing cached, so every input token is re-billed. */
const miss = (inputTokens: number) => ({ inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 })
/** A hit: the whole prompt comes from cache. */
const hit = (inputTokens: number) => ({ inputTokens: 0, cacheReadTokens: inputTokens, cacheWriteTokens: 0 })

function node(turn: number, step: number, usage: unknown): unknown {
  return { kind: 'assistant', turn, step, usage }
}

describe('lineCost', () => {
  it('labels the Turn’s first request as a turn rebuild', () => {
    const stepCost = prefillCost(PRICE, miss(448_000))
    const cost = lineCost(1, 1, PRICE, stepCost, { turn: 0.0672, session: 2.9 }, [])
    expect(cost?.scope).toBe('turn')
    expect(cost?.amount).toBeCloseTo(0.0672, 6)
    expect(cost?.session).toBeCloseTo(2.9, 6)
  })

  it('labels a mid-Turn rebuild as a step rebuild when the Turn itself hit', () => {
    const nodes = [node(56, 1, hit(500_000))]
    const stepCost = prefillCost(PRICE, miss(30_000))
    const cost = lineCost(56, 7, PRICE, stepCost, { turn: 0.075, session: 2.9 }, nodes)
    expect(cost?.scope).toBe('step')
    expect(cost?.amount).toBeCloseTo(0.0045, 6)
  })

  it('sums both rebuilds into one unlabelled total when the Turn also missed', () => {
    const nodes = [node(56, 1, miss(448_000))]
    const stepCost = prefillCost(PRICE, miss(448_000))
    const cost = lineCost(56, 7, PRICE, stepCost, { turn: 0.1344, session: 2.9 }, nodes)
    expect(cost?.scope).toBe('both')
    expect(cost?.amount).toBeCloseTo(0.1344, 6)
  })

  it('reports nothing when the model has no list price', () => {
    const stepCost = prefillCost(PRICE, miss(22_000))
    expect(lineCost(1, 1, undefined, stepCost, undefined, [])).toBeUndefined()
    expect(lineCost(1, 1, PRICE, undefined, undefined, [])).toBeUndefined()
  })
})
