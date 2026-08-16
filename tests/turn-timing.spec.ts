import { describe, expect, it } from 'vitest'
import { deriveTurnTimingFacts } from '../src/client/logic'

type TurnTimings = Map<number, { startTime: number; endTime?: number }>

describe('deriveTurnTimingFacts — prior-turn presence', () => {
  it('reports hasPriorTurn=false for the first turn (cold start)', () => {
    const turnTimings: TurnTimings = new Map([[1, { startTime: 1000 }]])
    expect(deriveTurnTimingFacts(1, turnTimings).hasPriorTurn).toBe(false)
  })

  it('reports hasPriorTurn=true for a normal second turn (prior turn has end time)', () => {
    const turnTimings: TurnTimings = new Map([
      [1, { startTime: 1000, endTime: 2000 }],
      [2, { startTime: 3000 }],
    ])
    expect(deriveTurnTimingFacts(2, turnTimings).hasPriorTurn).toBe(true)
  })

  it('reports hasPriorTurn=true when the window starts mid-conversation (prior turn outside the loaded window)', () => {
    // Window crop: turnTimings only covers turns 5+, so turn 4 is not in the
    // snapshot even though turn 5 is a real cache-miss candidate.
    const turnTimings: TurnTimings = new Map([
      [5, { startTime: 1000, endTime: 2000 }],
      [6, { startTime: 3000 }],
    ])
    expect(deriveTurnTimingFacts(5, turnTimings).hasPriorTurn).toBe(true)
  })

  it('reports hasPriorTurn=true when the prior turn lacks an end time (interrupted turn)', () => {
    // Turn 1 exists but was interrupted before turn/end, so no endTime is
    // recorded; turn 2 is still not a cold start.
    const turnTimings: TurnTimings = new Map([
      [1, { startTime: 1000 }],
      [2, { startTime: 3000 }],
    ])
    expect(deriveTurnTimingFacts(2, turnTimings).hasPriorTurn).toBe(true)
  })

  it('reports hasPriorTurn=true when turn timings are unavailable but the turn is not the first', () => {
    // Missing timing data must not swallow a real miss of a later turn.
    expect(deriveTurnTimingFacts(3, undefined).hasPriorTurn).toBe(true)
  })
})

describe('deriveTurnTimingFacts — idle computation', () => {
  it('computes the idle gap from the closest prior turn end', () => {
    const turnTimings: TurnTimings = new Map([
      [1, { startTime: 1000, endTime: 2000 }],
      [2, { startTime: 2000, endTime: 4000 }],
      [3, { startTime: 5000 }],
    ])
    const facts = deriveTurnTimingFacts(3, turnTimings)
    expect(facts.hasPriorTurn).toBe(true)
    expect(facts.idleMs).toBe(1000)
  })

  it('returns idle 0 when no prior turn end is recorded', () => {
    const turnTimings: TurnTimings = new Map([
      [1, { startTime: 1000 }],
      [2, { startTime: 3000 }],
    ])
    expect(deriveTurnTimingFacts(2, turnTimings).idleMs).toBe(0)
  })
})
