import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MODEL_PRICES } from '../src/client/prices.gen'

/**
 * The README quotes unit prices, and a catalog refresh can change them.
 *
 * `pnpm run prices` rewrites `prices.gen.ts` from models.dev, but the tables in
 * both READMEs are written by hand — so a refresh would silently leave the docs
 * claiming yesterday's prices. This test reads the tables back and fails when they
 * disagree with the catalog the plugin actually bills from.
 */
const ROW = /^\| `([^`]+)` \| ([\d.]+) \| ([\d.]+) \| \*\*(\d+)×\*\* \|$/gm

function pricedRows(file: string): Array<{ model: string; input: number; cacheRead: number; ratio: number }> {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  return [...text.matchAll(ROW)].map((match) => ({
    model: match[1]!,
    input: Number(match[2]),
    cacheRead: Number(match[3]),
    ratio: Number(match[4]),
  }))
}

describe.each(['README.md', 'README.en.md'])('%s price table', (file) => {
  it('quotes at least one model', () => {
    expect(pricedRows(file).length).toBeGreaterThan(0)
  })

  it('matches the bundled catalog, amount for amount', () => {
    for (const row of pricedRows(file)) {
      const price = MODEL_PRICES[row.model]
      expect(price, `${row.model} is not in prices.gen.ts`).toBeDefined()
      expect(row.input).toBe(price!.input)
      expect(row.cacheRead).toBe(price!.cacheRead)
    }
  })

  it('states the ratio the two prices actually have', () => {
    for (const row of pricedRows(file)) {
      expect(row.ratio, `${row.model} ratio`).toBe(Math.round(row.input / row.cacheRead))
    }
  })
})
