import { describe, expect, it } from 'vitest'
import {
  configSignature, formatPrefixChange, formatToolMove, prefixChangeKind, prefixChangeLabel,
  toolCatalogChange, toolMoveDetail, type ToolMove,
} from '../src/client/prefix'
import { formatLine } from '../src/client/logic'

const tool = (name: string, description = name, parameters: unknown = { type: 'object' }) => ({
  name, description, parameters,
})

const move = (patch: Partial<ToolMove>): ToolMove => ({ added: [], removed: [], changed: [], ...patch })

describe('prefixChangeKind', () => {
  it('keeps the three kinds the core classifies', () => {
    expect(prefixChangeKind('system')).toBe('system')
    expect(prefixChangeKind('tools')).toBe('tools')
    expect(prefixChangeKind('system-and-tools')).toBe('system-and-tools')
  })

  it('ignores the first loaded header and unavailable classifications', () => {
    expect(prefixChangeKind('initial')).toBeUndefined()
    expect(prefixChangeKind(undefined)).toBeUndefined()
    expect(prefixChangeKind(42)).toBeUndefined()
    expect(prefixChangeKind('something-new')).toBeUndefined()
  })
})

describe('configSignature', () => {
  it('compares configs by value, not by key order', () => {
    expect(configSignature({ provider: 'a', reasoningEffort: 'high' }))
      .toBe(configSignature({ reasoningEffort: 'high', provider: 'a' }))
  })

  it('keeps array order significant', () => {
    expect(configSignature({ tools: ['a', 'b'] })).not.toBe(configSignature({ tools: ['b', 'a'] }))
  })

  it('distinguishes values and missing keys', () => {
    expect(configSignature({ reasoningEffort: 'high' })).not.toBe(configSignature({ reasoningEffort: 'low' }))
    expect(configSignature({ provider: 'a' })).not.toBe(configSignature({}))
  })
})

describe('prefixChangeLabel', () => {
  it('spells the classifier out in words a reader can act on', () => {
    expect(prefixChangeLabel('tools', false)).toEqual({ words: 'tools' })
    expect(prefixChangeLabel('system', false)).toEqual({ words: 'system prompt' })
    expect(prefixChangeLabel('system-and-tools', false)).toEqual({ words: 'system prompt + tools' })
  })

  it('reports a config change even when the classifier names nothing', () => {
    expect(prefixChangeLabel(undefined, true)).toEqual({ words: 'config' })
    expect(prefixChangeLabel('system', true)).toEqual({ words: 'system prompt + config' })
  })

  it('reports nothing when neither moved', () => {
    expect(prefixChangeLabel(undefined, false)).toBeUndefined()
  })
})

describe('toolCatalogChange', () => {
  it('names the tools that entered and left', () => {
    const change = toolCatalogChange([tool('a'), tool('b')], [tool('b'), tool('c')], true)
    expect(change).toEqual({ added: ['c'], removed: ['a'], changed: [] })
  })

  it('names a tool whose schema moved under an unchanged name', () => {
    const change = toolCatalogChange([tool('edit', 'old')], [tool('edit', 'new')], true)
    expect(change).toEqual({ added: [], removed: [], changed: ['edit'] })
  })

  it('reports nothing when the catalog is identical', () => {
    expect(toolCatalogChange([tool('a'), tool('b')], [tool('a'), tool('b')], true)).toBeUndefined()
  })

  it('skips the schema comparison when the core saw no catalog change', () => {
    expect(toolCatalogChange([tool('a')], [{ ...tool('a'), description: 'rewritten' }], false)).toBeUndefined()
    expect(toolCatalogChange([tool('a')], [{ ...tool('a'), description: 'rewritten' }], true))
      .toEqual({ added: [], removed: [], changed: ['a'] })
  })

  it('reports the membership change alone when names and schemas both moved', () => {
    const change = toolCatalogChange([tool('a', 'old')], [tool('a', 'new'), tool('b')], true)
    expect(change).toEqual({ added: ['b'], removed: [], changed: [] })
  })

  it('reads a catalog the core passed without tools as empty', () => {
    expect(toolCatalogChange([], [tool('a')], true)).toEqual({ added: ['a'], removed: [], changed: [] })
    expect(toolCatalogChange([tool('a')], [], true)).toEqual({ added: [], removed: ['a'], changed: [] })
    expect(toolCatalogChange([], [], true)).toBeUndefined()
  })
})

describe('toolMoveDetail', () => {
  it('stays quiet about a catalog the chat already reported', () => {
    expect(toolMoveDetail(move({ added: ['preset_ops'] }), { turnMisses: 1, announced: true })).toBeUndefined()
  })

  it('names it once the Turn has missed again', () => {
    expect(toolMoveDetail(move({ added: ['preset_ops'] }), { turnMisses: 2, announced: true }))
      .toBe('+preset_ops')
  })

  it('names a catalog no other surface announced', () => {
    expect(toolMoveDetail(move({ removed: ['context_drop'] }), { turnMisses: 1, announced: false }))
      .toBe('-context_drop')
  })

  it('always names a schema rewritten under an unchanged name', () => {
    expect(toolMoveDetail(move({ changed: ['edit'] }), { turnMisses: 1, announced: true })).toBe('~edit')
  })

  it('lists at most two entries, then counts', () => {
    const two = move({ added: ['a', 'b'] })
    expect(toolMoveDetail(two, { turnMisses: 1, announced: false })).toBe('+a, +b')
    const three = move({ added: ['a', 'b', 'c'], removed: ['d'] })
    expect(toolMoveDetail(three, { turnMisses: 1, announced: false })).toBe('+3 -1')
  })

  it('counts an empty side away', () => {
    expect(toolMoveDetail(move({ removed: ['a', 'b', 'c'] }), { turnMisses: 1, announced: false })).toBe('-3')
    expect(toolMoveDetail(move({ changed: ['a', 'b', 'c'] }), { turnMisses: 1, announced: false })).toBe('~3')
  })

  it('reports nothing when the catalog did not move', () => {
    expect(toolMoveDetail(undefined, { turnMisses: 9, announced: false })).toBeUndefined()
  })
})

describe('formatToolMove', () => {
  it('lists every name, past the line’s own cap', () => {
    const wide = move({ added: ['a', 'b', 'c'], removed: ['d'], changed: ['e'] })
    expect(formatToolMove(wide)).toBe('+a, +b, +c, -d, ~e')
  })

  it('reports nothing for an absent or empty move', () => {
    expect(formatToolMove(undefined)).toBeUndefined()
    expect(formatToolMove(move({}))).toBeUndefined()
  })
})

describe('formatPrefixChange', () => {
  it('states what changed, without the estimate marker', () => {
    expect(formatPrefixChange({ words: 'tools' })).toBe('(tools changed)')
    expect(formatPrefixChange({ words: 'system prompt + tools + config' }))
      .toBe('(system prompt + tools + config changed)')
  })

  it('appends the tool names to the change they belong to', () => {
    expect(formatPrefixChange({ words: 'tools', tools: '+preset_ops' }))
      .toBe('(tools changed: +preset_ops)')
    expect(formatPrefixChange({ words: 'system prompt + tools', tools: '+3 -1' }))
      .toBe('(system prompt + tools changed: +3 -1)')
  })
})

describe('formatLine with a prefix change', () => {
  it('places the change after TTFT and before the session usage', () => {
    const line = formatLine({
      idleMs: 60_000,
      rebilledTokens: 22_000,
      cacheReadTokens: 0,
      ttftMs: 8_100,
      prefixChange: { words: 'tools + config' },
      cost: { scope: 'turn', amount: 0.003, session: 2.9 },
    })
    expect(line).toBe(
      'Cache miss after 1m idle · 22k tokens re-billed (turn ~$0.003) · 0k cached · ttft 8.1s ↑ · (tools + config changed) · session used (~$2.90)',
    )
  })

  it('carries the tool names inside the same segment', () => {
    const line = formatLine({
      idleMs: 0,
      rebilledTokens: 705_000,
      cacheReadTokens: 4_352,
      ttftMs: 600,
      step: 12,
      prefixChange: { words: 'tools', tools: '+preset_ops' },
    })
    expect(line).toBe(
      'Cache miss at step 12 · 705k tokens re-billed · 4k cached · ttft 0.6s ↑ · (tools changed: +preset_ops)',
    )
  })

  it('omits the segment when the core reported no change', () => {
    const line = formatLine({ idleMs: 0, rebilledTokens: 22_000, cacheReadTokens: 0, ttftMs: 1_200 })
    expect(line).toBe('Cache miss after 0s idle · 22k tokens re-billed · 0k cached · ttft 1.2s ↑')
  })
})
