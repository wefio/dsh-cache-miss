import { describe, expect, it } from 'vitest'
import { configSignature, formatPrefixChange, prefixChangeKind, prefixChangeLabel } from '../src/client/prefix'
import { formatLine } from '../src/client/logic'

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
  it('joins the classifier words with a plus', () => {
    expect(prefixChangeLabel('tools', false)).toBe('tools')
    expect(prefixChangeLabel('system-and-tools', false)).toBe('system+tools')
  })

  it('reports a config change even when the classifier names nothing', () => {
    expect(prefixChangeLabel(undefined, true)).toBe('config')
    expect(prefixChangeLabel('system', true)).toBe('system+config')
  })

  it('reports nothing when neither moved', () => {
    expect(prefixChangeLabel(undefined, false)).toBeUndefined()
  })
})

describe('formatPrefixChange', () => {
  it('renders the label behind the estimate marker', () => {
    expect(formatPrefixChange('tools')).toBe('(~tools)')
    expect(formatPrefixChange('system+tools+config')).toBe('(~system+tools+config)')
  })
})

describe('formatLine with a prefix change', () => {
  it('places the change after TTFT and before the session amount', () => {
    const line = formatLine({
      idleMs: 60_000,
      rebilledTokens: 22_000,
      cacheReadTokens: 0,
      ttftMs: 8_100,
      prefixChange: 'tools+config',
      cost: { scope: 'turn', amount: 0.003, session: 2.9 },
    })
    expect(line).toBe(
      'Cache miss after 1m idle · 22k tokens re-billed (turn ~$0.003) · 0k cached · ttft 8.1s ↑ · (~tools+config) · session (~$2.90)',
    )
  })

  it('omits the segment when the core reported no change', () => {
    const line = formatLine({ idleMs: 0, rebilledTokens: 22_000, cacheReadTokens: 0, ttftMs: 1_200 })
    expect(line).toBe('Cache miss after 0s idle · 22k tokens re-billed · 0k cached · ttft 1.2s ↑')
  })
})
