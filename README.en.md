# dsh-cache-miss

[中文](README.md)

DSH web plugin: a yellow one-line prompt-cache-miss notice under an assistant
reply whose request rebuilt the prompt cache — shown the moment the miss is
detected from the stream's usage, usually the turn's first request.

## What it does

An agent turn runs `assistant -> tool -> assistant -> tool ...`. The turn's
**first** model call is the moment the provider's prompt cache may have
expired and needs a full re-prefill (cache rebuild); later calls in the same
turn usually hit the just-rebuilt cache. DSH's own token/cache stats sit under
the composer and the produced-files row sits at the turn tail, neither of which
indicates a miss where it actually happens.

This plugin renders, under each assistant reply whose request missed, a single
yellow line, live, as soon as that step's `usage` chunk arrives:

```
Cache miss after 3m idle: 182k tokens re-billed · 0.8k cached · ttft 2.1s ↑
```
![cache-miss notice](cache-miss.png)

- `idle` — gap from the previous turn's end to this one's start.
- `re-billed` — the request's uncached input tokens (abbreviated to k).
- `cached` — the cached-read portion of the same prefill (when the provider
  reports it), so the rebilled-vs-cached split stays unambiguous.
- `ttft` — first-token latency, when available; the up arrow hints a rebuild
  prefill usually ran slower.

It is pure presentation: nothing is written to the session log, no DSH source
is modified, and it does not take the turn-tail chain, so it does not collide
with the produced-files row (e.g. `DSH-better-sidebar`).

## Miss definition

`inputTokens` is the disjoint "uncached input only" count and `cacheReadTokens`
the cached part of the same prefill, so the cache-hit ratio is
`hitRatio = cacheReadTokens / (inputTokens + cacheReadTokens)`. A request is a
miss when, all together:

- `inputTokens > 0`,
- `hitRatio < 80%` (over 20% of the prefill was uncached — significant because
  context accumulates), and
- `inputTokens >= 1000` (at least 1k tokens actually re-billed).

A provider that reports usage but no cache fields cannot be classified until it
has ever shown a cache field. Before that evidence exists, the plugin does not
misreport the request as a miss; it shows a grey notice
`Provider reports no cache fields — cannot confirm cache status`. Each such
provider is noticed once; switching to another no-evidence provider surfaces a
fresh notice, with a more detailed per-provider warning in the console. Once a
provider has shown any cache field, later requests without fields are treated as
full misses and show the yellow miss line normally. A provider that reports no
usage at all stays silent. A normal continuation reusing the just-built cache
therefore stays quiet (hit ratio ≥ 80%), and `re-billed` shows only the
uncached `inputTokens`.

The miss is read from the stream's own `usage` chunk — adapters emit it before
the terminal finish — so the notice appears as soon as the usage lands (while
the reply is still streaming), not only once the assistant message settles.
The line is logged to the browser console once per step, stamped in the
browser's local time zone.

## Install

```sh
dsh plugin --profile web add dsh-cache-miss
```

Restart `dsh web` (or hard-refresh the running GUI) to load the client bundle.

## Known limitations

- TTFT is the wall-clock gap between the step's `step/start` event and its
  first non-empty token delta, computed from session event times. It is absent
  (rendered as if no timing) when a boundary fell outside the loaded window.
- The node publishes for every assistant step, but renders nothing for cache
  hits, so a hit turn contributes no visible row. Each step logs at most one
  console line regardless of how many renders follow.
- Providers that have never reported cache fields get one grey notice per
  provider and no heuristic guess: TTFT is too sensitive to network/load to
  reliably separate "slow because of a cache miss" from "just slow".
