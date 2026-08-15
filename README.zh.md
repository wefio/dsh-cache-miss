# dsh-cache-miss

DSH 网页插件：在一轮的**第一条 assistant 回复**正下方，以一条黄色单行提示该轮首次请求的提示缓存未命中（prompt cache miss）。

## 功能

一轮 Agent 对话是 `assistant -> tool -> assistant -> tool ...`。该轮**第一次**模型调用正是供应商提示缓存可能已过期、需要整段重新 prefill（重建缓存）的时机；同轮后续调用往往命中刚重建的缓存。DSH 自带的 token/缓存统计在输入框下方，产物文件行在轮尾，都无法在 miss 真正发生的位置就地提示。

本插件在轮首第一条 assistant 回复正下方，仅当该请求确为缓存未命中时渲染一条黄色单行：

```
Cache miss after 3m idle: 182k tokens re-billed · ttft 2.1s ↑
```

- `idle` —— 距上一轮结束的空闲时长。
- `re-billed` —— 该请求的输入 token 数（缩写为 k）。
- `ttft` —— 首 token 时延（取自 assistant timing，可用时显示）；上箭头示意重建 prefill 通常更慢。

纯前端展示：不写入 session log，不修改 DSH 源码，也不占用 turn-tail 链，因此不会与产物文件行冲突（例如 `DSH-better-sidebar`）。

## miss 判定

当 `inputTokens > 0` 且 `cacheReadTokens` 不为大于 0 的数时判为 miss。不回缓存字段的 provider 因此也按 miss 处理，因为无法确认任何输入命中缓存。

## 安装

从源码构建后装配进 profile：

```sh
pnpm install
pnpm build
dsh plugin --profile web add link:<本包路径>
```

重启 `dsh web`（或硬刷新正在运行的 GUI）以加载 client bundle。

## 已知限制

- TTFT 目前留空（按缺省处理）：因为尚未接入从轮数据精确读取 assistant timing；此时该行读作 `... tokens re-billed`，无 `· ttft ...` 段。
- 节点对每轮的第一条 assistant 都会发布，但命中时渲染为空，因此命中轮不产生可见行。
