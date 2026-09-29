import { describe, expect, it } from 'vitest'
import {
  firstTokenTimeFromStream,
  formatLine,
  formatLocalTime,
  formatUnconfirmedLine,
  getLineStatus,
  isCacheAccountingUnavailable,
  isCacheMiss,
  resolveTurnTimings,
  ttftMs,
  UNCONFIRMED_LINE,
  type CacheUsage,
} from '../src/client/logic'

describe('isCacheMiss', () => {
  it('is false when a large cached read dominates a small uncached input', () => {
    const usage: CacheUsage = { inputTokens: 182, cacheReadTokens: 120000 }
    expect(isCacheMiss(usage)).toBe(false)
  })

  it('is true when uncached input dominates with a low hit ratio (rebuild)', () => {
    const usage: CacheUsage = { inputTokens: 102056, cacheReadTokens: 37120 }
    // hitRatio = 37120 / (102056 + 37120) ≈ 26.7% < 80%
    expect(isCacheMiss(usage)).toBe(true)
  })

  it('is true when cacheReadTokens is 0 and inputTokens >= 1000', () => {
    const usage: CacheUsage = { inputTokens: 182000, cacheReadTokens: 0 }
    expect(isCacheMiss(usage)).toBe(true)
  })

  it('is false when cache fields are absent and there is no per-provider evidence', () => {
    const usage: CacheUsage = { inputTokens: 182000 }
    expect(isCacheMiss(usage, false)).toBe(false)
  })

  it('is true when cache fields are absent but the provider has proven cache accounting', () => {
    const usage: CacheUsage = { inputTokens: 182000 }
    expect(isCacheMiss(usage, true)).toBe(true)
  })

  it('is false when uncached input is below the 1k floor even at 0% hit ratio', () => {
    const usage: CacheUsage = { inputTokens: 999 }
    expect(isCacheMiss(usage)).toBe(false)
  })

  it('is false when hit ratio is >= 80% despite a large uncached input', () => {
    const usage: CacheUsage = { inputTokens: 20000, cacheReadTokens: 180000 }
    // hitRatio = 90% >= 80%
    expect(isCacheMiss(usage)).toBe(false)
  })

  it('is false when inputTokens is 0', () => {
    const usage: CacheUsage = { inputTokens: 0, cacheReadTokens: 0 }
    expect(isCacheMiss(usage)).toBe(false)
  })

  it('handles missing usage object as not a miss (no basis)', () => {
    expect(isCacheMiss(undefined)).toBe(false)
  })
})

describe('isCacheAccountingUnavailable', () => {
  it('is true when usage exists but neither cache field is a number', () => {
    expect(isCacheAccountingUnavailable({ inputTokens: 100 })).toBe(true)
  })

  it('is false when cacheReadTokens is a number (including zero)', () => {
    expect(isCacheAccountingUnavailable({ inputTokens: 100, cacheReadTokens: 0 })).toBe(false)
    expect(isCacheAccountingUnavailable({ inputTokens: 100, cacheReadTokens: 50 })).toBe(false)
  })

  it('is false when cacheWriteTokens is a number', () => {
    expect(isCacheAccountingUnavailable({ inputTokens: 100, cacheWriteTokens: 20 })).toBe(false)
  })

  it('is false when usage is undefined (no basis, handled separately)', () => {
    expect(isCacheAccountingUnavailable(undefined)).toBe(false)
  })
})

describe('formatUnconfirmedLine', () => {
  it('returns the fixed unconfirmed-provider notice', () => {
    expect(formatUnconfirmedLine()).toBe(UNCONFIRMED_LINE)
  })
})

describe('formatLine', () => {
  it('formats the canonical line', () => {
    const line = formatLine({ idleMs: 3 * 60_000, rebilledTokens: 182_000, cacheReadTokens: undefined, ttftMs: 2_100 })
    expect(line).toBe('Cache miss after 3m idle: 182k tokens re-billed · ttft 2.1s ↑')
  })

  it('shows seconds below one minute', () => {
    expect(formatLine({ idleMs: 45_000, rebilledTokens: 20_000, cacheReadTokens: undefined, ttftMs: 900 }))
      .toBe('Cache miss after 45s idle: 20k tokens re-billed · ttft 0.9s ↑')
  })

  it('rounds minutes upward when >= 60s', () => {
    expect(formatLine({ idleMs: 60_000, rebilledTokens: 100_000, cacheReadTokens: undefined, ttftMs: 500 }))
      .toBe('Cache miss after 1m idle: 100k tokens re-billed · ttft 0.5s ↑')
  })

  it('omits ttft arrow when ttft is absent', () => {
    expect(formatLine({ idleMs: 0, rebilledTokens: 1000, cacheReadTokens: undefined, ttftMs: 0 }))
      .toBe('Cache miss after 0s idle: 1k tokens re-billed')
  })

  it('appends the cached-read portion when reported', () => {
    expect(formatLine({ idleMs: 0, rebilledTokens: 180_655, cacheReadTokens: 768, ttftMs: 0 }))
      .toBe('Cache miss after 0s idle: 181k tokens re-billed · 1k cached')
  })

  it('formats small token counts without decimal drift', () => {
    expect(formatLine({ idleMs: 0, rebilledTokens: 999, cacheReadTokens: undefined, ttftMs: 0 }))
      .toBe('Cache miss after 0s idle: 1k tokens re-billed')
  })
})

describe('getLineStatus', () => {
  it('returns a line status for a miss', () => {
    const s = getLineStatus({ usage: { inputTokens: 10_000, cacheReadTokens: 0 }, idleMs: 90_000, ttftMs: 1200, hasPriorTurn: true, hasCacheEvidence: true })
    expect(s.kind).toBe('show')
    expect(s.line).toBe('Cache miss after 1m idle: 10k tokens re-billed · 0k cached · ttft 1.2s ↑')
  })

  it('returns an unconfirmed status when usage lacks cache fields and the provider has no evidence', () => {
    const s = getLineStatus({ usage: { inputTokens: 10_000 }, idleMs: 90_000, ttftMs: 1200, hasPriorTurn: true, hasCacheEvidence: false })
    expect(s.kind).toBe('unconfirmed')
    expect(s.kind === 'unconfirmed' && s.line).toBe(UNCONFIRMED_LINE)
  })

  it('returns an unconfirmed status even on a cold-start first turn (provider limitation, not miss)', () => {
    const s = getLineStatus({ usage: { inputTokens: 10_000 }, idleMs: 0, ttftMs: 0, hasPriorTurn: false, hasCacheEvidence: false })
    expect(s.kind).toBe('unconfirmed')
  })

  it('returns a miss when usage lacks cache fields but the provider has proven cache accounting', () => {
    const s = getLineStatus({ usage: { inputTokens: 10_000 }, idleMs: 0, ttftMs: 0, hasPriorTurn: true, hasCacheEvidence: true })
    expect(s.kind).toBe('show')
    expect(s.line).toBe('Cache miss after 0s idle: 10k tokens re-billed')
  })

  it('returns hidden for a hit', () => {
    const s = getLineStatus({ usage: { inputTokens: 79, cacheReadTokens: 152064 }, idleMs: 0, ttftMs: 0, hasPriorTurn: true, hasCacheEvidence: true })
    expect(s.kind).toBe('hidden')
  })

  it('returns hidden when there is no usage', () => {
    const s = getLineStatus({ usage: undefined, idleMs: 0, ttftMs: 0, hasPriorTurn: true, hasCacheEvidence: true })
    expect(s.kind).toBe('hidden')
  })

  it('counts only uncached input in the re-billed total', () => {
    const s = getLineStatus({
      usage: { inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 5_000 },
      idleMs: 0,
      ttftMs: 0,
      hasPriorTurn: true,
      hasCacheEvidence: true,
    })
    expect(s.kind).toBe('show')
    expect(s.line).toBe('Cache miss after 0s idle: 10k tokens re-billed · 0k cached')
  })

  it('shows the cached-read portion beside the re-billed total', () => {
    const s = getLineStatus({
      usage: { inputTokens: 180_655, cacheReadTokens: 768 },
      idleMs: 60_000,
      ttftMs: 0,
      hasPriorTurn: true,
      hasCacheEvidence: true,
    })
    expect(s.kind).toBe('show')
    expect(s.line).toBe('Cache miss after 1m idle: 181k tokens re-billed · 1k cached')
  })

  it('returns hidden for a cold-start first turn (no prior turn)', () => {
    const s = getLineStatus({ usage: { inputTokens: 10_000, cacheReadTokens: 0 }, idleMs: 0, ttftMs: 0, hasPriorTurn: false, hasCacheEvidence: true })
    expect(s.kind).toBe('hidden')
  })
})

describe('ttftMs', () => {
  it('computes first-token latency from step boundaries', () => {
    expect(ttftMs(1000, 3100)).toBe(2100)
  })

  it('returns 0 when either boundary is missing', () => {
    expect(ttftMs(null, 3100)).toBe(0)
    expect(ttftMs(1000, null)).toBe(0)
    expect(ttftMs(undefined, undefined)).toBe(0)
  })

  it('returns 0 for a non-positive interval', () => {
    expect(ttftMs(3100, 1000)).toBe(0)
  })
})

describe('formatLocalTime', () => {
  it('formats in the local time zone', () => {
    const date = new Date(2026, 7, 15, 18, 30, 5) // Aug 15 2026 18:30:05 local
    const formatted = formatLocalTime(date.getTime())
    expect(formatted).toBe(date.toLocaleString())
  })
})

describe('firstTokenTimeFromStream', () => {
  it('takes the earliest token-bearing record instant', () => {
    const stream = [
      { type: 'chunk', time: 1000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
      { type: 'reasoning-chunks', time0: 1400, index: 0, dt: [], texts: ['Let'] },
      { type: 'text-chunks', time0: 1600, index: 1, dt: [], texts: ['hi'] },
    ]
    expect(firstTokenTimeFromStream(stream)).toBe(1400)
  })

  it('ignores structural chunk markers that carry no tokens', () => {
    const stream = [{ type: 'chunk', time: 1000, chunk: { type: 'block-start', index: 0 } }]
    expect(firstTokenTimeFromStream(stream)).toBeNull()
  })

  it('accepts a single-instant record through its time field', () => {
    expect(firstTokenTimeFromStream([{ type: 'tool-call-chunks', time: 2200, index: 1 }])).toBe(2200)
  })

  it('is null for payloads with no usable record', () => {
    expect(firstTokenTimeFromStream(undefined)).toBeNull()
    expect(firstTokenTimeFromStream(null)).toBeNull()
    expect(firstTokenTimeFromStream([])).toBeNull()
    expect(firstTokenTimeFromStream({})).toBeNull()
    expect(firstTokenTimeFromStream([null, 'x', { type: 'reasoning-chunks' }])).toBeNull()
  })
})

describe('resolveTurnTimings', () => {
  const timings = new Map([[1, { startTime: 1000, endTime: 2000 }]])

  it('reads the older top-level snapshot field', () => {
    expect(resolveTurnTimings({ turnTimings: timings })).toBe(timings)
  })

  it('falls back to the legacy projection newer cores use', () => {
    expect(resolveTurnTimings({ nodes: {}, legacy: { turnTimings: timings } })).toBe(timings)
  })

  it('prefers the top-level field when both exist', () => {
    const other = new Map([[2, { startTime: 5000 }]])
    expect(resolveTurnTimings({ turnTimings: timings, legacy: { turnTimings: other } })).toBe(timings)
  })

  it('is undefined when no map is exposed, without guessing', () => {
    expect(resolveTurnTimings(undefined)).toBeUndefined()
    expect(resolveTurnTimings(null)).toBeUndefined()
    expect(resolveTurnTimings({})).toBeUndefined()
    expect(resolveTurnTimings({ turnTimings: [], legacy: {} })).toBeUndefined()
    expect(resolveTurnTimings({ legacy: null })).toBeUndefined()
  })
})
