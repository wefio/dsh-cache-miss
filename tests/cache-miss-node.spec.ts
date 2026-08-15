import { describe, expect, it } from 'vitest'
import { cacheMissDefinition } from '../src/client/cache-miss-node'

/** Minimal append-surface assistant/message event shape the Definition reads. */
function assistantMessage(turn: number, step: number, usage: unknown): any {
  return {
    type: 'assistant/message',
    seq: step,
    time: 1000,
    data: { turn, step, message: { content: [], id: 'm' }, usage },
  }
}

function contextState(turn: number, step: number, usage: unknown): any {
  return { turn, step, usage }
}

describe('cacheMissDefinition.match', () => {
  it('claims the first assistant of a turn (step 0) with role start', () => {
    expect(cacheMissDefinition.match(assistantMessage(3, 0, { inputTokens: 100 }))).toEqual({
      id: '3:0',
      role: 'start',
    })
  })

  it('ignores non-first assistant steps of a turn', () => {
    expect(cacheMissDefinition.match(assistantMessage(3, 1, { inputTokens: 50 }))).toBeNull()
    expect(cacheMissDefinition.match(assistantMessage(3, 2, { inputTokens: 20 }))).toBeNull()
  })

  it('ignores non assistant/message events', () => {
    expect(cacheMissDefinition.match({ type: 'tool/result', data: {}, seq: 0 })).toBeNull()
  })
})

describe('cacheMissDefinition.start', () => {
  it('captures usage from the first assistant', () => {
    const state = cacheMissDefinition.start!(
      contextState(1, 0, null),
      { event: assistantMessage(1, 0, { inputTokens: 9000 }) } as any,
    )
    expect(state).toEqual({ turn: 1, step: 0, usage: { inputTokens: 9000 } })
  })
})

describe('cacheMissDefinition.buildViewNode', () => {
  it('publishes a cache-miss node when usage is a miss', () => {
    const event = assistantMessage(1, 0, { inputTokens: 9000 })
    const state = contextState(1, 0, { inputTokens: 9000 })
    const context = {
      state,
      key: 'k',
      id: '1:0',
      target: 'chat',
      matches: [{ event }],
    } as any
    const node = cacheMissDefinition.buildViewNode!(context)
    expect(node).not.toBeNull()
    expect(node!.kind).toBe('cache-miss')
    expect(node!.data.usage).toEqual({ inputTokens: 9000 })
  })

  it('publishes no node without state', () => {
    expect(cacheMissDefinition.buildViewNode!({ state: undefined } as any)).toBeNull()
  })
})
