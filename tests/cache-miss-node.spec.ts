import { describe, expect, it } from 'vitest'
import { cacheMissDefinition } from '../src/client/cache-miss-node'

/** Minimal step/start event opening one turn:step. */
function stepStart(turn: number, step: number): any {
  return { type: 'step/start', seq: 1, time: 1000, data: { turn, step } }
}

/** Minimal assistant/chunk event for one turn:step. */
function chunk(turn: number, step: number, seq: number, time: number, chunkType: string, payload: unknown): any {
  return { type: 'assistant/chunk', seq, time, data: { turn, step, chunk: { type: chunkType, ...payload } } }
}

/** Minimal finalized assistant message for one turn:step. */
function assistantMessage(turn: number, step: number, seq: number, time: number, usage: unknown): any {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: { turn, step, message: { content: [], id: 'm' }, usage },
  }
}

describe('cacheMissDefinition.match', () => {
  it('starts a context on step/start, keyed by turn:step', () => {
    expect(cacheMissDefinition.match(stepStart(3, 1))).toEqual({ id: '3:1', role: 'start' })
  })

  it('updates on helper chunks and the finalized message', () => {
    expect(cacheMissDefinition.match(chunk(3, 1, 2, 1200, 'text-delta', { text: 'x' }))).toEqual({ id: '3:1', role: 'update' })
    expect(cacheMissDefinition.match(chunk(3, 1, 3, 1300, 'usage', { usage: { inputTokens: 100 } }))).toEqual({ id: '3:1', role: 'update' })
    expect(cacheMissDefinition.match(assistantMessage(3, 1, 4, 1400, { inputTokens: 100 }))).toEqual({ id: '3:1', role: 'update' })
  })

  it('uses distinct ids for distinct steps of the same turn', () => {
    expect(cacheMissDefinition.match(stepStart(3, 1))).toEqual({ id: '3:1', role: 'start' })
    expect(cacheMissDefinition.match(stepStart(3, 2))).toEqual({ id: '3:2', role: 'start' })
  })

  it('ignores unrelated events', () => {
    expect(cacheMissDefinition.match({ type: 'tool/result', data: {}, seq: 0 })).toBeNull()
    expect(cacheMissDefinition.match({ type: 'turn/start', data: { turn: 1 }, seq: 0 })).toBeNull()
  })
})

describe('cacheMissDefinition.start / update', () => {
  function contextWith(turn: number, step: number): any {
    return { state: cacheMissDefinition.start!({} as any, { event: stepStart(turn, step) } as any) }
  }

  it('opens with no usage but records the step start time', () => {
    expect(cacheMissDefinition.start!({} as any, { event: stepStart(4, 2) } as any)).toEqual({
      turn: 4, step: 2, usage: undefined, missingCacheFields: false, provider: undefined, stepStartTime: 1000, firstTokenTime: null, missTime: null,
    })
  })

  it('captures the first non-empty delta as first-token time', () => {
    const ctx = contextWith(4, 2)
    const after = cacheMissDefinition.update!(ctx as any, { event: chunk(4, 2, 2, 1500, 'text-delta', { text: 'hi' }) } as any)
    expect(after.firstTokenTime).toBe(1500)
  })

  it('ignores empty deltas for the first-token boundary', () => {
    const ctx = contextWith(4, 2)
    const after = cacheMissDefinition.update!(ctx as any, { event: chunk(4, 2, 2, 1500, 'text-delta', { text: '' }) } as any)
    expect(after.firstTokenTime).toBeNull()
  })

  it('captures usage and its event time from the usage chunk', () => {
    const ctx = contextWith(4, 2)
    const after = cacheMissDefinition.update!(ctx as any, { event: chunk(4, 2, 3, 2000, 'usage', { usage: { inputTokens: 9000 } }) } as any)
    expect(after.usage).toEqual({ inputTokens: 9000 })
    expect(after.missTime).toBe(2000)
  })

  it('fills a missing usage from the finalized message without losing timing', () => {
    const ctx: any = { state: { turn: 4, step: 2, usage: undefined, missingCacheFields: false, provider: undefined, stepStartTime: 1000, firstTokenTime: 1200, missTime: null } }
    const after = cacheMissDefinition.update!(ctx, { event: assistantMessage(4, 2, 9, 3000, { inputTokens: 42 }) } as any)
    expect(after.usage).toEqual({ inputTokens: 42 })
    expect(after.missTime).toBe(3000)
    expect(after.firstTokenTime).toBe(1200)
    expect(after.provider).toBeUndefined()
  })

  it('captures provider from the finalized assistant message', () => {
    const ctx = contextWith(4, 2)
    const event = {
      type: 'assistant/message',
      seq: 9,
      time: 3000,
      data: {
        turn: 4,
        step: 2,
        message: { source: { provider: 'deepseek-official' }, content: [], id: 'm' },
        usage: { inputTokens: 42 },
      },
    }
    const after = cacheMissDefinition.update!(ctx as any, { event } as any)
    expect(after.provider).toBe('deepseek-official')
  })
})

describe('cacheMissDefinition.buildViewNode', () => {
  it('publishes a node as soon as the usage chunk reports a miss', () => {
    const node = cacheMissDefinition.buildViewNode!({
      key: 'k', id: '1:1', kind: 'cache-miss', target: 'chat',
      state: { turn: 1, step: 1, usage: { inputTokens: 9000, cacheReadTokens: 0 }, missingCacheFields: false, provider: undefined, stepStartTime: 1000, firstTokenTime: 1200, missTime: 2000 },
      start: { event: stepStart(1, 1), role: 'start', location: { kind: 'turn', turn: {} } },
      matches: [{ event: chunk(1, 1, 2, 2000, 'usage', { usage: { inputTokens: 9000, cacheReadTokens: 0 } }) }],
    } as any)
    expect(node).not.toBeNull()
    expect(node!.kind).toBe('cache-miss')
    expect(node!.data).toEqual({
      turn: 1, step: 1, usage: { inputTokens: 9000, cacheReadTokens: 0 }, missingCacheFields: false, provider: undefined, stepStartTime: 1000, firstTokenTime: 1200, missTime: 2000,
    })
  })

  it('publishes an unsupported node when usage lacks both cache fields', () => {
    const node = cacheMissDefinition.buildViewNode!({
      key: 'k', id: '1:1', kind: 'cache-miss', target: 'chat',
      state: { turn: 1, step: 1, usage: { inputTokens: 9000 }, missingCacheFields: true, provider: 'deepseek-official', stepStartTime: 1000, firstTokenTime: 1200, missTime: 2000 },
      start: { event: stepStart(1, 1), role: 'start', location: { kind: 'turn', turn: {} } },
      matches: [{ event: chunk(1, 1, 2, 2000, 'usage', { usage: { inputTokens: 9000 } }) }],
    } as any)
    expect(node).not.toBeNull()
    expect(node!.data).toEqual({
      turn: 1, step: 1, usage: { inputTokens: 9000 }, missingCacheFields: true, provider: 'deepseek-official', stepStartTime: 1000, firstTokenTime: 1200, missTime: 2000,
    })
  })

  it('publishes no node on a cache hit', () => {
    expect(cacheMissDefinition.buildViewNode!({
      state: { turn: 1, step: 1, usage: { inputTokens: 9000, cacheReadTokens: 121000 }, missingCacheFields: false, provider: undefined, stepStartTime: 1000, firstTokenTime: 1200, missTime: 2000 },
      key: 'k', id: '1:1', target: 'chat', matches: [],
    } as any)).toBeNull()
  })

  it('publishes no node without usage', () => {
    expect(cacheMissDefinition.buildViewNode!({
      state: { turn: 1, step: 1, usage: undefined, missingCacheFields: false, provider: undefined, stepStartTime: null, firstTokenTime: null, missTime: null },
      key: 'k', id: '1:1', target: 'chat', matches: [],
    } as any)).toBeNull()
  })

  it('publishes no node without state', () => {
    expect(cacheMissDefinition.buildViewNode!({ state: undefined } as any)).toBeNull()
  })
})
