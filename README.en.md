# dsh-cache-miss

![npm](https://img.shields.io/npm/dm/dsh-cache-miss)
[![dsh.so risk](https://www.dsh.so/badge/dsh-cache-miss.svg)](https://www.dsh.so/artifact/dsh-cache-miss/)
[![dshbase 实测可装](https://dshbase.com/badges/dsh-cache-miss.svg)](https://dshbase.com/zh/plugins/dsh-cache-miss/)

[中文](README.md)

A DSH web plugin: when the prompt cache breaks and a request has to recompute the whole context, it hands you a yellow ticket under that Turn's first assistant reply — how much was re-billed, what it cost, and what broke the prefix.

No configuration, no change of habits. It speaks only when the hit was broken, and stays quiet the rest of the time.

![cache-miss notice](cache-miss.png)

## Install

```sh
dsh plugin --profile web add dsh-cache-miss
```

Restart `dsh web` (or hard-refresh the running GUI) to load the client bundle. Like any plugin, installing or removing it moves the prefix, so avoid doing it inside a long-running session.

## The yellow line

An agent Turn runs `assistant -> tool -> assistant -> tool ...`. The Turn's **first** model call is the moment the provider's prompt cache may have expired and needs a full re-prefill (cache rebuild); later calls in the same Turn usually hit the cache it just rebuilt. DSH's own token stats sit under the composer and the produced-files row sits at the Turn tail — neither can tell you what happened at the place the miss actually occurred.

```
Cache miss after 3m idle · 182k tokens re-billed (turn ~$0.027) · 0.8k cached · ttft 2.1s ↑ · (tools changed) · session used (~$2.90)
```

- `idle` — gap from the previous Turn's end to this one's start.
- `re-billed` — the uncached input tokens this request had to recompute.
- `cached` — the cached-read portion of the same prefill, so the rebilled-vs-cached split stays unambiguous.
- `(turn ~$…)` / `(step ~$…)` — roughly what the rebuilt part cost: a miss on the Turn's first request rebuilt the whole context (`turn`), a mid-Turn miss only the prefix it changed (`step`); when both happened the line gives their sum.
- `ttft` — first-token latency, with an arrow hinting that a rebuild usually ran slower.
- `(system prompt changed)` / `(tools changed)` / `(config changed)` — the core's **prefix change classification**, in words. The system prompt, the tool catalog and the request config are all part of the prefix; change any one and everything after it is re-billed. The classification comes from the core; `config changed` is the plugin's own addition, compared over the same canonical config.
- `session used (~$…)` — the session's running total; `used` marks it as cumulative rather than this request.

The same line goes to the browser console with a local timestamp, once per Step. `~` marks an estimate; amounts are in USD as the catalog publishes them, with no exchange-rate conversion.

## It does one thing

- **It only appears in the conversation**: no new page, sidebar or button — the content sits where it belongs.
- **It prices prompt spend only**: the amounts are uncached input plus cache reads; output tokens are outside its scope.
- **It uses only the counters in `usage`**: tokens, cache hits, latency. Never your message text, and nothing is uploaded.
- **It uses public interfaces**: conversation-node and slot, browser-side only, leaving nothing behind when removed.

## Cache and money

**A cached input token and an uncached one differ by 30–50×** (models.dev 2026-10 prices, USD per 1M tokens):

| Model | Uncached input (`input`) | Cache hit (`cache_read`) | Ratio |
| --- | --- | --- | --- |
| `deepseek-v4-flash` | 0.15 | 0.003 | **50×** |
| `deepseek-v4-pro` | 0.66 | 0.022 | **30×** |

Re-billing 448k tokens costs ~$0.067 on flash; the same prompt read from cache costs ~$0.0013. **Prompt cost is decided by the hit rate**, and the hit rate is decided by the prefix: DeepSeek's prefix cache requires a byte-for-byte match from the very first token, so a change to the system prompt, the tool catalog or the request config re-bills everything after the change.

In practice a real miss almost always comes from a prefix change rather than from cache expiry — a Turn after 27 idle minutes still hit.

So there are only four places to save money:

1. **Do not install or remove plugins mid-session**: the tool catalog and system prompt are prefix, so the next request re-bills everything.
2. **After switching provider, model or reasoningEffort, do not expect a hit**: that is a different cache namespace.
3. **A session you are already working in is cheaper to continue than to restart** — and not mainly because of the cache (though it is still there): **a new session means restating the task, the constraints, the conclusions you reached by trial, and the corrections you made**, and then the model has to find its feet again — explaining why, resolving fresh ambiguities. All of that costs tokens, and time. The cache is only the part of the bill that comes for free.
4. **Change prefix-bearing content rarely** (project instructions, system-prompt-like material).

## `/compact`: when it is worth it

`/compact` is not free. It carries two charges — **the summarization call itself** (read the history, write a summary) and **the rebuild of the first request after it** — and only then does each Step start saving the cache price of the context that was dropped.

Let `A` = context tokens before compaction, `B` = context tokens after, `S` = summary output tokens, `U` = uncached tokens on the first request after compaction, `M_c` = uncached tokens of the summarization call itself. Break-even in model calls **after** the compaction:

```
N = ⌊ (A + 49·M_c + 49·U + 200·S) / (A − B) ⌋ + 1
```

`49` and `200` are price ratios, not magic constants: `49 = uncached/hit − 1`, `200 = output/hit`. Flash is 0.15/0.003/0.6 → 50/200; for pro's 0.66/0.022/1.98 substitute 30/90.

Three things decide whether it pays off:

**1. Will you be around long enough — this one is computable, not a guess.** The context returns to its old size in `(A − B) / g` Steps, where `g` is how many tokens it grows per Step (a few hundred to a thousand-plus). One compaction typically drops hundreds of thousands of tokens, so the payback window is usually well over a hundred Steps. Unless you compact away what you were just working on and then barely move, this condition rarely binds.

**2. How hard it compresses decides the whole cost.** Rewriting the formula in terms of `r = B/A` gives `N ≈ (1 + 49r + 200·S/A) / (1 − r)`. The smaller r, the faster the payback — `r = 0.1` is a dozen Steps, `r = 0.4` is forty-odd. So:

- **Compact at the end of a phase** (after reading a batch of files or finishing an investigation, when the next phase makes that material obsolete) → r is small and the payback is quick;
- **Wait for the context to fill and let it trigger automatically** (the core fires at 80% of the window) → most of that content is still in use, so it retains a lot and r is at its worst.

**3. Whether the summarization call itself hits the cache — this one cannot be computed, only accepted.** It is not "re-read what you just read": the request is built from the shadowed history plus a summarisation instruction, so its prefix is not the conversation's, and the request body is not persisted. Even if this conversation has been hitting all along, the summary call may still re-bill everything — and vice versa. A hit costs about $0.002; a full re-bill $0.02–0.09, an order of magnitude apart. **This term's uncertainty is larger than the other two combined.**

The conclusion: **in money terms compaction nearly always pays back; in experience terms it buys context space.** Compact when you need the space, pick a moment when a lot of the content is becoming obsolete, and do not treat it as a money-saving move.

## What the numbers mean

Amounts cover the **prompt only** (uncached input plus cache reads), never output tokens. Unit prices come from [models.dev](https://models.dev/api.json) in USD, `~` marks an estimate, and the official bill is authoritative.

The bundled snapshot is only an offline fallback; the live catalog is fetched on demand and trusted for **24 hours**: a page load after that refreshes it, switching models refreshes it, and a model the catalog cannot price refreshes it too — so neither a reprice nor a new model waits for a plugin release. If a fetch fails the current catalog stays in charge, and an unmatched model shows no amount rather than a made-up price. Peak/off-peak pricing is a single-vendor policy and is deliberately not hard-coded.

The `/compact` summarization call is not an assistant Step and is outside the plugin's accounting (the core records it separately), so `session used` excludes it — and it is frequently the single most expensive call in the whole session.

## Known limitations

- TTFT is the wall-clock gap between `step/start` and the first non-empty token delta; it is absent when either boundary fell outside the loaded window.
- The node runs for every assistant Step but renders nothing on a hit, so a hit Turn contributes no visible row.
- A provider that has never reported cache fields gets one grey notice, `Provider reports no cache fields`, and no heuristic guess; once it has shown a cache field, later requests without one are treated as full misses.
- The plugin accounts for prompt spend only, never output tokens, and it reads the counters in `usage` rather than your message content.

## Finally

No dashboard, no ads. It only hands you a ticket when the cache hit was broken. If it saved you some muddled money, a Star ⭐️ is welcome — or not; it keeps working quietly either way.

```sh
dsh plugin --profile web add dsh-cache-miss
```
