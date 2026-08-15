# dsh-cache-miss

DSH web plugin: a yellow one-line prompt-cache-miss notice under the **first
assistant reply of each turn**, when that turn's first request rebuilt the
prompt cache.

## What it does

An agent turn runs `assistant -> tool -> assistant -> tool ...`. The turn's
**first** model call is the moment the provider's prompt cache may have
expired and needs a full re-prefill (cache rebuild); later calls in the same
turn usually hit the just-rebuilt cache. DSH's own token/cache stats sit under
the composer and the produced-files row sits at the turn tail, neither of which
indicates a miss where it actually happens.

This plugin renders, under the turn's first assistant reply, a single yellow
line only when that request was a cache miss:

```
Cache miss after 3m idle: 182k tokens re-billed · ttft 2.1s ↑
```

- `idle` — gap from the previous turn's end to this one's start.
- `re-billed` — the request's input tokens (abbreviated to k).
- `ttft` — first-token latency (abbreviation of the assistant timing), when
  available; the up arrow hints a rebuild prefill usually ran slower.

It is pure presentation: nothing is written to the session log, no DSH source
is modified, and it does not take the turn-tail chain, so it does not collide
with the produced-files row (e.g. `DSH-better-sidebar`).

## Miss definition

A request is a miss when `inputTokens > 0` and `cacheReadTokens` is not a
positive number. A provider that reports no cache fields is therefore treated
as a miss, because no input hit the cache.

## Install

From a source checkout build the package, then mount it into a profile:

```sh
pnpm install
pnpm build
dsh plugin --profile web add link:<this-package-path>
```

Restart `dsh web` (or hard-refresh the running GUI) to load the client bundle.

## Known limitations

- TTFT is currently omitted (rendered as if absent) because reading the exact
  assistant timing from the turn data is not yet wired; the line then reads
  `... tokens re-billed` without the `· ttft ...` segment.
- The node publishes for the first assistant of every turn, but renders nothing
  for cache hits, so a hit turn contributes no visible row.
