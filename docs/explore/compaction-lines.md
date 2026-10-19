# 压缩线探索（已放弃）

> 状态：**放弃**。代码与数据留在这个分支，不进主线。
> 日期：2026-10-19

## 想解决的问题

`/compact` 是唯一一种"主动花钱换上下文空间"的操作。如果插件能在**压缩之前**告诉用户"现在压值得吗、几步回本"，它就从"事后罚单"变成"事前顾问"。

## 做了两样东西

1. **蓝线**（已可用）：压缩后第一次请求的 usage 一落地，按真实 `A/B/U/S/M_c` 算出换入成本与回本步数。
   `Compacted 607k → 69k · cost ~$0.083 · saves ~$0.0016/step · pays back in 52 steps`
2. **绿线**（放弃了）：压缩前给"两种走向的报价"。
   `Compact window · 620k → ~79k · pays back in ~10 steps if the summary hits, ~66 if it misses (~52%)`

配套：`scripts/compaction-stats.mjs` 从 session log 生成 `docs/data/compactions.json`（27 次唯一压缩的原始 token 数），`scripts/compact-breakeven.mjs` 出表格，`tests/compact.spec.ts` 与 `tests/advice.spec.ts` 覆盖公式与节点行为。

## 查到的结论（这部分是资产，别丢）

- **自动压缩线是配置决定的**：核心在窗口 80% 触发，实测 8 次精确落在 80.0%。压缩后保留量约为窗口的 30%（均值 29.5%，标准差 6.8%）。
- **摘要调用能否命中是硬币**：14/27 命中、13 次大段重算，且两组在日志里分不开（距上一步多久、折叠条数、模型、上一步是否命中全部重叠）。摘要请求不是"把对话再读一遍"——它的输入通常是 `A` 的 0.63–1.01 倍，由被折叠的历史加摘要指令构成，请求体不落盘（`llmStreamCall` 只是布尔）。
- **回本窗口不需要预测剩余工作量**：`(A − B) / g`，`g` 是每步涨的 token（中位几百到一千几）。27 次里命中 26 次、冷跑 25 次都落在窗口内——所以"钱能不能赚回来"几乎从不成为约束。
- **保留量按窗口分层**：留一交叉验证 MAE，按 `contextWindow` 分层 9.7k，全局中位数 27k。用"最近几步增量"预测（相关性 0.06）比常数更差。
- **`A − shadowedTokenCount ≈ B` 不成立**（MAE 56k）：那是 token-meter 的估算器，不是计费口径。

## 为什么放弃绿线

1. **它的核心数值是预测，而且改四次口径仍不可辩护**。84k → 79k → `0.16 × window` → 按窗口分层，每次都说"这次准了"，每次下一个错。真正的问题不是精度，是格式：把 5 倍量级的不确定性（摘要命中 vs 冷跑）印成一个单值，读者只会记住小的那个。
2. **公开文档不能引用真实会话数据**。所有数字来自使用者的日志，既涉及隐私，别人也无法复现。而一份不可复现的实测表，正是这个项目最不该有的东西。
3. **与定位冲突**。这个插件的价值是"只说发生过的事"。绿线天生要说没发生的事。

蓝线不受影响：它的每个数都是压缩完成后从 usage 里读出来的真值。

## 如果重启，正解在哪

不要在客户端猜，**去读配置**。核心是这么算的：

```
messageBudget  = contextWindow − reservedCompletionTokens
retainTokens   = retainTokens ?? floor(messageBudget × retainRatio)   // 默认 0.16
thresholdTokens = floor(min(contextWindow × thresholdRatio, …))        // 默认 0.8
```

`contextWindow` 客户端可读（`contextPressure` projection）；`retainRatio` 在 loader 组合里，`compaction-basic` 不注册 settings namespace，浏览器侧拿不到。所以要么：

- 让 core 在 `compaction/start` 里带上 resolved budget（核心改动，插件做不到）；
- 或者写一个 host 侧 companion，把配置暴露成设置命名空间。

在这条路打通之前，绿线只能在"报价区间 + 明写硬币"的形态下存在——那种形态下它已经接近一条**已知上下文的提示文案**，价值不足以支撑两条新代码路径与一份数据集。

## 这个分支里有什么

| 文件 | 说明 |
| --- | --- |
| `src/client/compact-cost.ts` | 回本公式与格式化（蓝线在用） |
| `src/client/compaction-node.ts` | 压缩节点，压缩后发布蓝线 |
| `src/client/compact-advice.ts` | 绿线的预测与判定（放弃） |
| `src/client/advice-node.ts` | 绿线节点与节流（放弃） |
| `scripts/compaction-stats.mjs` | 生成 `docs/data/compactions.json` |
| `scripts/compact-breakeven.mjs` | 打印/输出实测表 |
| `docs/data/compactions.json` | 27 次唯一压缩的原始 token 数 |
| `tests/compact.spec.ts` / `tests/advice.spec.ts` | 公式、节点、判定 |

`docs/design.md` 的「压缩回本」「压缩建议」两节也在这个分支上。

## 结论

蓝线可以做，但它是 0.3 级功能，不是补丁；绿线不该发布。主线（0.2.0）保持"一条黄线"的形态。
