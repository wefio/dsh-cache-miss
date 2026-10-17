import { describe, expect, it } from 'vitest'
import { diffTools, formatToolChange, isEmptyToolChange } from '../src/client/prefix'
import { formatLine } from '../src/client/logic'

/** One structurally complete tool schema for the diff. */
function tool(name: string, description = 'does a thing'): Record<string, unknown> {
  return { name, description, parameters: { type: 'object', properties: {} } }
}

describe('diffTools', () => {
  it('names added, removed and rewritten tools', () => {
    const change = diffTools(
      [tool('ask_user_question'), tool('bash'), tool('obsolete')],
      [tool('ask_user_question'), tool('bash', 'now does more'), tool('agent_team')],
    )
    expect(change).toEqual({ added: ['agent_team'], removed: ['obsolete'], changed: ['bash'] })
  })

  it('treats every tool as added when there is no previous catalog', () => {
    expect(diffTools(undefined, [tool('a'), tool('b')])).toEqual({ added: ['a', 'b'], removed: [], changed: [] })
  })

  it('reports nothing when the catalog is identical', () => {
    const tools = [tool('a'), tool('b')]
    expect(isEmptyToolChange(diffTools(tools, tools))).toBe(true)
  })

  it('ignores malformed entries instead of inventing a name', () => {
    expect(diffTools(undefined, [null, { description: 'nameless' }, tool('ok')])).toEqual({
      added: ['ok'], removed: [], changed: [],
    })
  })
})

describe('formatToolChange', () => {
  it('marks each moved tool with its own sign', () => {
    expect(formatToolChange({ added: ['agent_team'], removed: ['dsh_job'], changed: ['bash'] }))
      .toBe('(~+agent_team · ~-dsh_job · ~±bash)')
  })

  it('summarizes past three names so the line stays short', () => {
    expect(formatToolChange({ added: ['a', 'b', 'c', 'd', 'e'], removed: [], changed: [] }))
      .toBe('(~+a · ~+b · ~+c · ~+2 more)')
  })

  it('is undefined when nothing moved', () => {
    expect(formatToolChange({ added: [], removed: [], changed: [] })).toBeUndefined()
  })
})

describe('formatLine with a tool change', () => {
  it('places the change between TTFT and (nothing else) when no cost is known', () => {
    const line = formatLine({
      idleMs: 60_000,
      rebilledTokens: 22_000,
      cacheReadTokens: 0,
      ttftMs: 8_100,
      toolChange: { added: ['agent_team'], removed: [], changed: [] },
    })
    expect(line).toBe('Cache miss after 1m idle · 22k tokens re-billed · 0k cached · ttft 8.1s ↑ · (~+agent_team)')
  })
})
