import { describe, expect, it } from 'vitest'
import { formatPrefixChange, prefixChangeKind } from '../src/client/prefix'
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

describe('formatPrefixChange', () => {
  it('renders the core kind verbatim behind the estimate marker', () => {
    expect(formatPrefixChange('tools')).toBe('(~tools)')
    expect(formatPrefixChange('system')).toBe('(~system)')
    expect(formatPrefixChange('system-and-tools')).toBe('(~system-and-tools)')
  })
})

describe('formatLine with a prefix change', () => {
  it('places the change after TTFT and before the session amount', () => {
    const line = formatLine({
      idleMs: 60_000,
      rebilledTokens: 22_000,
      cacheReadTokens: 0,
      ttftMs: 8_100,
      prefixChange: 'tools',
      cost: { scope: 'turn', amount: 0.003, session: 2.9 },
    })
    expect(line).toBe(
      'Cache miss after 1m idle · 22k tokens re-billed (turn ~$0.003) · 0k cached · ttft 8.1s ↑ · (~tools) · session (~$2.90)',
    )
  })

  it('omits the segment when the core reported no change', () => {
    const line = formatLine({ idleMs: 0, rebilledTokens: 22_000, cacheReadTokens: 0, ttftMs: 1_200 })
    expect(line).toBe('Cache miss after 0s idle · 22k tokens re-billed · 0k cached · ttft 1.2s ↑')
  })
})
