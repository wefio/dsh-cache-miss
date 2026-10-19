// Price a `/compact` decision from the usage records a DSH session log already stores.
//
// The plugin prices one request; this script prices the decision around it. A
// compaction costs two things — the summarization call itself and the rebuild of
// the first request after it — and from then on saves the cache price of the
// context it dropped, on every model call. Whether that pays back is a division,
// not an estimate.
//
//   pnpm run compact                      scan $DSH_HOME/sessions
//   pnpm run compact -- <dir|file> ...    scan specific session logs
//   pnpm run compact -- --md              emit a markdown table
//
// Compactions are identified by their own id: a session writes more than one log
// file (`session.v1`, `session.v2`), so counting events instead of compactions
// inflates every number below — which is exactly how an earlier version of these
// docs came to quote a 57-compaction sample that was really 28 compactions read
// twice.
import { breakEven, collectLogs, compactionsIn, loadPrices, resolvePrice, SESSIONS } from './lib/session-log.mjs'

const asMoney = (usd) => `$${usd.toFixed(usd < 0.001 ? 5 : 4)}`
const asTokens = (tokens) => `${(tokens / 1000).toFixed(0)}k`

const args = process.argv.slice(2)
const markdown = args.includes('--md')
const targets = args.filter((arg) => arg !== '--' && !arg.startsWith('--'))
const roots = targets.length > 0 ? targets : [SESSIONS]

const prices = loadPrices()
const seen = new Set()
const usable = []
for (const root of roots) {
  for (const file of collectLogs(root)) {
    for (const row of compactionsIn(file)) {
      if (row.compactionId !== undefined) {
        if (seen.has(row.compactionId)) continue
        seen.add(row.compactionId)
      }
      if (row.A <= row.B) continue
      usable.push({ ...row, price: resolvePrice(prices, row.model) })
    }
  }
}

const rows = usable
  .filter((row) => row.price !== undefined)
  .map((row) => ({
    ...row,
    compactCost: (row.Mc * row.price.input + row.S * row.price.output) / 1e6,
    rebuildCost: (row.U * row.price.input) / 1e6,
    perCall: ((row.A - row.B) * row.price.cacheRead) / 1e6,
    N: breakEven(row.A, row.B, row.S, row.U, row.Mc, row.price),
  }))

rows.sort((left, right) => right.A - left.A || left.B - right.B)
if (rows.length === 0) {
  console.log('no compaction with a usable usage window found')
  process.exit(0)
}

if (markdown) {
  console.log('| A before | B after | summary call | rebuild after | saved per Step | N |')
  console.log('| --- | --- | --- | --- | --- | --- |')
  for (const row of rows) {
    console.log(
      `| ${asTokens(row.A)} | ${asTokens(row.B)} | ${asMoney(row.compactCost)} `
      + `| ${asMoney(row.rebuildCost)} | $${row.perCall.toFixed(5)} | **${row.N}** |`,
    )
  }
} else {
  console.log('A       B       S      U       Mc      summary$  rebuild$  perStep$   N')
  for (const row of rows) {
    console.log(
      [
        asTokens(row.A).padStart(6),
        asTokens(row.B).padStart(6),
        String(row.S).padStart(6),
        String(row.U).padStart(7),
        String(row.Mc).padStart(7),
        asMoney(row.compactCost).padStart(9),
        asMoney(row.rebuildCost).padStart(9),
        row.perCall.toFixed(6).padStart(10),
        String(row.N).padStart(3),
      ].join(' '),
    )
  }
}

const fullMiss = rows.filter((row) => row.Mc * 2 > row.A).length
console.log(
  `\n${rows.length} priced compactions (${seen.size} unique, ${usable.length} usable)`
  + ` · ${fullMiss} had the summarization call itself mostly miss`
  + ` · payback ${Math.min(...rows.map((row) => row.N))}–${Math.max(...rows.map((row) => row.N))} model calls`,
)

