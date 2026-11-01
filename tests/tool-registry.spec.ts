import { describe, expect, it } from 'vitest'
import { createPrefixDefinition, createToolRegistryDefinition, readStepPrefix } from '../src/client/prefix-node'
import { toolMoveDetail } from '../src/client/prefix'

const CONFIG = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

const tool = (name: string) => ({ name, description: name, parameters: { type: 'object' } })

/** One `developer/message` the core logs when the catalog's membership changed. */
function toolRegistryMessage(turn: number, step: number, seq: number, names: string[]): any {
  return {
    type: 'developer/message',
    seq,
    time: 1_000,
    data: {
      turn,
      step,
      message: {
        id: `dev-${seq}`,
        role: 'developer',
        source: { kind: 'tool-registry' },
        content: names.map((name) => ({ type: 'tool-addition', toolName: name })),
      },
    },
  }
}

/** Reader the Definitions see: previous header state, and no system state. */
function reader(previousTools: readonly unknown[] | undefined) {
  return {
    previous: (kind: string) =>
      kind === 'cache-miss-prefix' && previousTools !== undefined
        ? { state: { prompt: { config: CONFIG, system: '', tools: previousTools } } }
        : undefined,
  }
}

/** Drive one request header through the prefix Definition for `turn:step`. */
function header(
  definition: ReturnType<typeof createPrefixDefinition>,
  turn: number,
  step: number,
  tools: readonly unknown[],
  previousTools: readonly unknown[] | undefined,
): void {
  const match = {
    event: { type: 'request/header', seq: 7, time: 1_000, data: { header: { config: CONFIG, tools }, reason: 'change' } },
    location: { kind: 'step', turn: { turn }, step: { step } },
  }
  definition.start(undefined as never, match as never, reader(previousTools) as never)
}

describe('createToolRegistryDefinition.match', () => {
  const definition = createToolRegistryDefinition()

  it('opens a context on a tool-registry message that names tools', () => {
    expect(definition.match(toolRegistryMessage(3, 2, 9, ['preset_ops']))).toEqual({ id: '9', role: 'start' })
  })

  it('ignores developer messages the tool registry did not write', () => {
    const recall = toolRegistryMessage(3, 2, 9, ['preset_ops'])
    recall.data.message.source = { kind: 'recall' }
    expect(definition.match(recall)).toBeNull()
  })

  it('ignores a tool-registry message that names no tool', () => {
    expect(definition.match(toolRegistryMessage(3, 2, 9, []))).toBeNull()
  })

  it('ignores every other event', () => {
    expect(definition.match({ type: 'request/header', seq: 1, data: {} })).toBeNull()
    expect(definition.match({ type: 'tool/call', seq: 1, data: {} })).toBeNull()
  })
})

describe('the announced mark and the header record share one entry', () => {
  it('keeps the catalog move when the core reports the same Step afterwards', () => {
    const prefix = createPrefixDefinition(
      () => ({ prompt: { config: CONFIG, system: '', tools: [tool('a'), tool('b')] }, change: { seq: 7, time: 1_000, kind: 'tools' } }),
    )
    header(prefix, 41, 2, [tool('a'), tool('b')], [tool('a')])

    const before = readStepPrefix(41, 2)
    expect(before?.move).toEqual({ added: ['b'], removed: [], changed: [] })
    expect(before?.announced).toBe(false)
    // Nothing has announced the move yet, so the line still names it — this is
    // exactly what a core without tool-registry messages gets.
    expect(toolMoveDetail(before?.move, { turnMisses: 1, announced: before?.announced === true })).toBe('+b')

    createToolRegistryDefinition().start(undefined as never, { event: toolRegistryMessage(41, 2, 12, ['b']) } as never)

    const after = readStepPrefix(41, 2)
    expect(after?.announced).toBe(true)
    expect(after?.change).toEqual({ words: 'tools' })
    expect(after?.move).toEqual({ added: ['b'], removed: [], changed: [] })
    // The chat now shows its own "Tool added: b" row, so a Turn that missed once
    // states the cause without repeating the name.
    expect(toolMoveDetail(after?.move, { turnMisses: 1, announced: after?.announced === true })).toBeUndefined()
  })

  it('names the tool once the Turn has missed again', () => {
    const prefix = createPrefixDefinition(
      () => ({ prompt: { config: CONFIG, system: '', tools: [tool('a'), tool('b')] }, change: { seq: 7, time: 1_000, kind: 'tools' } }),
    )
    header(prefix, 42, 4, [tool('a'), tool('b')], [tool('a')])
    createToolRegistryDefinition().start(undefined as never, { event: toolRegistryMessage(42, 4, 12, ['b']) } as never)

    const facts = readStepPrefix(42, 4)
    expect(toolMoveDetail(facts?.move, { turnMisses: 2, announced: facts?.announced === true })).toBe('+b')
  })

  it('names a schema change even though the core announced nothing', () => {
    const prefix = createPrefixDefinition(
      () => ({ prompt: { config: CONFIG, system: '', tools: [{ ...tool('a'), description: 'new' }] }, change: { seq: 7, time: 1_000, kind: 'tools' } }),
    )
    header(prefix, 43, 1, [{ ...tool('a'), description: 'new' }], [tool('a')])

    const facts = readStepPrefix(43, 1)
    expect(facts?.move).toEqual({ added: [], removed: [], changed: ['a'] })
    expect(toolMoveDetail(facts?.move, { turnMisses: 1, announced: facts?.announced === true })).toBe('~a')
  })

  it('records nothing for a request that kept its catalog and config', () => {
    const prefix = createPrefixDefinition(
      () => ({ prompt: { config: CONFIG, system: '', tools: [tool('a')] } }),
    )
    header(prefix, 44, 1, [tool('a')], [tool('a')])
    expect(readStepPrefix(44, 1)).toBeUndefined()
  })
})
