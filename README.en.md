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
Cache miss after 3m idle · 182k tokens re-billed (turn ~$0.027) · 0.8k cached · ttft 2.1s ↑ · (tools changed) · session used (~$2.90)
```
![cache-miss notice](cache-miss.png)

- `idle` — gap from the previous turn's end to this one's start.
- `re-billed` — the request's uncached input tokens (abbreviated to k).
- `cached` — the cached-read portion of the same prefill (when the provider
  reports it), so the rebilled-vs-cached split stays unambiguous.
- `(turn ~$…)` / `(step ~$…)` — the approximate amount of the rebuilt part: a miss on the
  Turn's first request rebuilt the whole context (`turn`), a mid-Turn miss only the prefix it
  changed (`step`); when both happened in the same Turn the line gives their sum `(~$…)` with
  no scope word. `~` marks an estimate.
- `ttft` — first-token latency, when available; the up arrow hints a rebuild
  prefill usually ran slower.
- `(system prompt changed)` / `(tools changed)` — the core's **prefix change classification** for this
  request, in words rather than the classifier's enum (both the system prompt and the tool catalog
  are part of the cache prefix, so a change re-bills everything after it — the most common cause of a
  miss). The classification comes from the core; the plugin only reports it.
- `(~config)` — the request header's config moved (provider switch, reasoningEffort, …). A different
  config is a different cache namespace, so the whole prompt is re-billed; the core's classification
  does not cover it, so the plugin adds it by comparing the same canonical config. It stacks, e.g.
  `(~system+config)`.
- `session used (~$…)` — the session's consumed amount so far, over the loaded window.

Prices come from the [models.dev](https://models.dev/api.json) DeepSeek catalog and
are shown in its own USD units — no exchange-rate conversion, with `~` marking an
estimate. The bundled snapshot is only an offline fallback; the live catalog is fetched
on demand and trusted for **24 hours**: a page load after that refreshes it, switching
models refreshes it, and a model the catalog cannot price (a new release, a relay
reporting a new spelling) refreshes it too — so neither a reprice nor a new model waits
for a plugin release. If a fetch fails or the page is offline the current catalog stays
in charge, and an unmatched model shows no amount rather than a made-up price.
Peak/off-peak pricing is a single-vendor policy and is deliberately not hard-coded.
Amounts cover the prompt only (uncached input plus cache reads), never output tokens.

It is pure presentation: nothing is written to the session log, no DSH source
is modified, and it does not take the turn-tail chain, so it does not collide
with the produced-files row (e.g. `DSH-better-sidebar`).

## Cache and money

**A cached input token and an uncached one differ by 30–50×** (models.dev 2026-10
prices, USD per 1M tokens):

| Model | Uncached input (`input`) | Cache hit (`cache_read`) | Ratio |
| --- | --- | --- | --- |
| `deepseek-v4-flash` | 0.15 | 0.003 | **50×** |
| `deepseek-v4-pro` | 0.66 | 0.022 | **30×** |

Re-billing 448k tokens costs ~$0.067 on flash; the same prompt read from cache costs
~$0.0013. **Prompt cost is decided by the hit rate**, and the hit rate is decided by
the prefix.

### Why one prefix change makes everything expensive

DeepSeek's prefix cache requires a byte-for-byte match from the very first token. The
system prompt, the tool catalog and the request config (provider, reasoningEffort, …)
all belong to that prefix — change any of them and every token after the change is
billed as uncached. In practice a real miss almost always comes from a prefix change
rather than from cache expiry — a Turn after 27 idle minutes still hit in practice (the TTL is longer than it feels, and the server decides it).

### What the line tells you

- `22k tokens re-billed` — the part of this request that was recomputed, i.e. the
  money that would otherwise have been saved;
- `(turn ~$…)` / `(step ~$…)` — whether that money rebuilt the whole Turn context or
  only the prefix one Step changed; when both happened the line gives their sum, and
  `session used (~$…)` is the running total;
- `(system prompt changed)` / `(tools changed)` / `(config changed)` — which of them
  broke the prefix.

### What saves money

1. **Do not change the tool set or load plugins mid-session.** Installing or removing
   a plugin rewrites the tool catalog and the system prompt, so the next request
   re-bills everything. Try new plugins in a fresh session instead of churning them
   inside a long one.
2. **After switching provider, model or reasoningEffort, do not expect a hit.** That
   is a different cache namespace, so the whole prompt is billed at full price.
3. **A long session is cheaper to continue than to restart.** The cache is still
   there, so the next Turn mostly pays for its increment; a new session starts cold
   and bills the first Turn in full.
4. **Change prefix-bearing content rarely** (project instructions, system-prompt-like
   material): one edit makes everything after it recompute.

### New session or `/compact`?

Both cost one rebuild; the question is what you get for it:

- **Same task, context just too long** → use `/compact`. Compaction rewrites history,
  so the next Turn re-bills the whole prompt (the line will show it), but the prefix is
  then stable again and each Turn pays only its increment, with the thread intact.
- **New task, a direction that went wrong, or a plugin/tool-set change coming** → start
  a new session. Its first Turn is a cold start (the plugin does not count it as a
  miss), so you do not pay for rewriting history you are about to abandon, and later
  prefix changes cannot keep dragging the old context along.
- **Same task, short context** → neither. Continuing is cheapest; the cache is warm.

In one line: `/compact` buys continuity, a new session buys a clean slate — both pay a
rebuild, so do not do either often.

### What the numbers mean

Amounts cover the **prompt only** (uncached input plus cache reads), never output
tokens. Unit prices come from the models.dev catalog in USD, `~` marks an estimate,
and the official bill is authoritative.

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









