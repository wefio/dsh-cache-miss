// Build the checked-in dataset every number in the docs and the UI is derived from.
//
// The point of this file is that no human retypes a number: the README table, the
// retention band, the summary hit rate and the payback range are all functions of
// `docs/data/compactions.json`. If a figure in the docs disagrees with the dataset,
// `tests/dataset.spec.ts` fails.
//
//   pnpm run stats            rewrite docs/data/compactions.json
//   pnpm run stats -- --check verify the checked-in copy is current (no write)
//
// Two counts matter and both are printed with every result: `usable` compactions
// have usage on both sides of them, `priced` ones additionally resolve to a unit
// price. Neither is a guess about the population — they are what the logs contain.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  REPO, SESSIONS, breakEven, collectLogs, compactionsIn, loadPrices, median, resolvePrice, wilson95,
} from './lib/session-log.mjs'

const DATASET = `${REPO}/docs/data/compactions.json`

const args = process.argv.slice(2)
const check = args.includes('--check')
const targets = args.filter((arg) => arg !== '--' && !arg.startsWith('--'))
const roots = targets.length > 0 ? targets : [SESSIONS]

const prices = loadPrices()
const seenIds = new Set()
const all = []
let events = 0

for (const root of roots) {
  for (const file of collectLogs(root)) {
    for (const row of compactionsIn(file)) {
      events += 1
      if (row.compactionId !== undefined) {
        if (seenIds.has(row.compactionId)) continue
        seenIds.add(row.compactionId)
      }
      all.push(row)
    }
  }
}

const usable = all.filter((row) => row.A > row.B)
const priced = usable
  .map((row) => ({ ...row, price: resolvePrice(prices, row.model) }))
  .filter((row) => row.price !== undefined)
  .map((row) => ({
    A: row.A,
    B: row.B,
    S: row.S,
    U: row.U,
    Mc: row.Mc,
    model: row.model,
    provider: row.provider,
    N: breakEven(row.A, row.B, row.S, row.U, row.Mc, row.price),
  }))

priced.sort((left, right) => right.A - left.A || left.B - right.B)

/** A summarization call that re-billed most of the prefix it read. */
const hit = (row) => row.Mc * 2 <= row.A
const hits = usable.filter(hit).length
const ci = wilson95(hits, usable.length)

const dataset = {
  schema: 1,
  what: 'Every /compact found in DSH session logs, reduced to the token counts the payback formula needs.',
  source: 'DSH session logs (~/.dsh/sessions), all sessions containing a compaction',
  filters: {
    count: 'compaction/summary events deduped by compactionId (a session writes more than one log file)',
    usable: 'a settled assistant step on both sides of it, with A > B',
    priced: 'the summarization model resolves to a unit price in src/client/prices.gen.ts',
  },
  counts: { events, unique: seenIds.size, usable: usable.length, priced: priced.length },
  stats: {
    retention: {
      note: 'prompt tokens a compaction kept (B) — an absolute size, not a fraction of A',
      n: usable.length,
      median: Math.round(median(usable.map((row) => row.B))),
      low: Math.min(...usable.map((row) => row.B)),
      high: Math.max(...usable.map((row) => row.B)),
    },
    summaryInput: {
      note: 'total prompt tokens the summarization call billed, over A — below 1 means it read less than the conversation held',
      n: usable.length,
      median: Number(median(usable.map((row) => (row.Mc + row.summaryCacheRead) / row.A)).toFixed(3)),
    },
    summaryHit: {
      note: 'share of summarization calls that re-billed less than half of A',
      hits,
      n: usable.length,
      rate: Number((hits / usable.length).toFixed(4)),
      ci95: ci === undefined ? undefined : ci.map((v) => Number(v.toFixed(3))),
    },
    payback: {
      note: 'break-even model calls after the compaction, priced compactions only',
      n: priced.length,
      min: Math.min(...priced.map((row) => row.N)),
      max: Math.max(...priced.map((row) => row.N)),
    },
  },
  rows: priced,
}

const text = `${JSON.stringify(dataset, null, 2)}\n`

if (check) {
  let current
  try {
    current = readFileSync(DATASET, 'utf8')
  } catch {
    console.error(`${DATASET} is missing; run \`pnpm run stats\``)
    process.exit(1)
  }
  if (current !== text) {
    console.error('docs/data/compactions.json is out of date; run `pnpm run stats`')
    process.exit(1)
  }
  console.log(`dataset is current: ${priced.length} priced / ${usable.length} usable / ${seenIds.size} unique compactions`)
  process.exit(0)
}

mkdirSync(dirname(DATASET), { recursive: true })
writeFileSync(DATASET, text)
console.log(`wrote ${DATASET}`)
console.log(`  events ${events} · unique ${seenIds.size} · usable ${usable.length} · priced ${priced.length}`)
console.log(`  retention median ${dataset.stats.retention.median} (${dataset.stats.retention.low}–${dataset.stats.retention.high})`)
console.log(`  summary hit ${hits}/${usable.length} = ${(dataset.stats.summaryHit.rate * 100).toFixed(1)}% (95% CI ${(ci ?? [0, 0]).map((v) => (v * 100).toFixed(0)).join('–')}%)`)
console.log(`  payback ${dataset.stats.payback.min}–${dataset.stats.payback.max} steps`)


