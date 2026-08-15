import { describe, expect, it } from 'vitest'
import { formatLine, getLineStatus, isCacheMiss, type CacheUsage } from '../src/client/logic'

describe('isCacheMiss', () => {
  it('is false when cacheReadTokens > 0', () => {
    const usage: CacheUsage = { inputTokens: 182000, cacheReadTokens: 120000 }
    expect(isCacheMiss(usage)).toBe(false)
  })

  it('is true when cacheReadTokens is 0 and inputTokens > 0', () => {
    const usage: CacheUsage = { inputTokens: 182000, cacheReadTokens: 0 }
    expect(isCacheMiss(usage)).toBe(true)
  })

  it('is true when cacheReadTokens is missing and inputTokens > 0', () => {
    const usage: CacheUsage = { inputTokens: 182000 }
    expect(isCacheMiss(usage)).toBe(true)
  })

  it('is false when inputTokens is 0', () => {
    const usage: CacheUsage = { inputTokens: 0, cacheReadTokens: 0 }
    expect(isCacheMiss(usage)).toBe(false)
  })

  it('handles missing usage object as not a miss (no basis)', () => {
    expect(isCacheMiss(undefined)).toBe(false)
  })
})

describe('formatLine', () => {
  it('formats the canonical line', () => {
    const line = formatLine({ idleMs: 3 * 60_000, rebilledTokens: 182_000, ttftMs: 2_100 })
    expect(line).toBe('Cache miss after 3m idle: 182k tokens re-billed · ttft 2.1s ↑')
  })

  it('shows seconds below one minute', () => {
    expect(formatLine({ idleMs: 45_000, rebilledTokens: 20_000, ttftMs: 900 }))
      .toBe('Cache miss after 45s idle: 20k tokens re-billed · ttft 0.9s ↑')
  })

  it('rounds minutes upward when >= 60s', () => {
    expect(formatLine({ idleMs: 60_000, rebilledTokens: 100_000, ttftMs: 500 }))
      .toBe('Cache miss after 1m idle: 100k tokens re-billed · ttft 0.5s ↑')
  })

  it('omits ttft arrow when ttft is absent', () => {
    expect(formatLine({ idleMs: 0, rebilledTokens: 1000, ttftMs: 0 }))
      .toBe('Cache miss after 0s idle: 1k tokens re-billed')
  })

  it('formats small token counts without decimal drift', () => {
    expect(formatLine({ idleMs: 0, rebilledTokens: 999, ttftMs: 0 }))
      .toBe('Cache miss after 0s idle: 1k tokens re-billed')
  })
})

describe('getLineStatus', () => {
  it('returns a line status for a miss', () => {
    const s = getLineStatus({ usage: { inputTokens: 10_000 }, idleMs: 90_000, ttftMs: 1200 })
    expect(s.kind).toBe('show')
    expect(s.line).toBe('Cache miss after 1m idle: 10k tokens re-billed · ttft 1.2s ↑')
  })

  it('returns hidden for a hit', () => {
    const s = getLineStatus({ usage: { inputTokens: 10_000, cacheReadTokens: 5000 }, idleMs: 0, ttftMs: 0 })
    expect(s.kind).toBe('hidden')
  })

  it('returns hidden when there is no usage', () => {
    const s = getLineStatus({ usage: undefined, idleMs: 0, ttftMs: 0 })
    expect(s.kind).toBe('hidden')
  })
})
