import { describe, expect, it } from 'vitest'
import { isStale, parseCatalog, shouldAttempt } from '../src/client/prices-live'

const DAY = 24 * 60 * 60 * 1000

/** A models.dev-shaped catalog with two providers and one costless model. */
const CATALOG = JSON.stringify({
  deepseek: {
    models: {
      'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
      'deepseek-v4-pro': { cost: { input: 0.66, output: 1.98, cache_read: 0.022 } },
      'no-cache-field': { cost: { input: 1, output: 2 } },
      'priceless': { name: 'no cost object' },
    },
  },
  anthropic: {
    models: {
      'claude-x': { cost: { input: 3, output: 15, cache_read: 0.3 } },
    },
  },
})

describe('parseCatalog', () => {
  it('keeps only the DeepSeek rows, in the plugin price shape', () => {
    expect(parseCatalog(CATALOG)).toEqual({
      'deepseek-v4-flash': { input: 0.15, output: 0.6, cacheRead: 0.003 },
      'deepseek-v4-pro': { input: 0.66, output: 1.98, cacheRead: 0.022 },
      // models.dev omits cache_read for some models; the miss price then applies
      // to cache reads too, which is what the bundled generator assumes as well.
      'no-cache-field': { input: 1, output: 2, cacheRead: 0 },
    })
  })

  it('rejects bodies that are not a usable catalog', () => {
    expect(parseCatalog('not json')).toBeUndefined()
    expect(parseCatalog('null')).toBeUndefined()
    expect(parseCatalog('[]')).toBeUndefined()
    expect(parseCatalog(JSON.stringify({ anthropic: { models: {} } }))).toBeUndefined()
    expect(parseCatalog(JSON.stringify({ deepseek: { models: {} } }))).toBeUndefined()
  })
})

describe('isStale', () => {
  it('treats missing prices as stale', () => {
    expect(isStale(undefined, 1_000)).toBe(true)
  })

  it('trusts prices for one day', () => {
    const now = 30 * 60 * 60 * 1000
    expect(isStale(now - 60 * 60 * 1000, now)).toBe(false)
    expect(isStale(now - 23 * 60 * 60 * 1000, now)).toBe(false)
  })

  it('asks for fresh prices once the day is up, so a reprice cannot hide behind an old snapshot', () => {
    const now = 30 * 60 * 60 * 1000
    expect(isStale(now - 25 * 60 * 60 * 1000, now)).toBe(true)
  })
})

describe('shouldAttempt', () => {
  it('allows the first attempt of a page session', () => {
    expect(shouldAttempt(undefined, 1_000)).toBe(true)
  })

  it('does not hammer the endpoint for one unpriceable model', () => {
    const now = 10 * 60 * 1000
    expect(shouldAttempt(now - 1000, now)).toBe(false)
    expect(shouldAttempt(now - 59 * 60 * 1000, now)).toBe(false)
  })

  it('allows another attempt an hour later', () => {
    const now = 10 * 60 * 60 * 1000
    expect(shouldAttempt(now - 61 * 60 * 1000, now)).toBe(true)
  })
})


