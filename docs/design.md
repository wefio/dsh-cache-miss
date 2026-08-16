# dsh-cache-miss 设计文档

独立 DeepSeek Harness 浏览器插件。
在一轮对话的第一条 assistant 回复正下方,以黄色单行提示该轮首条模型请求发生过的提示缓存未命中(prompt cache miss)。

纯前端渲染,不写入 session log,不修改 DSH 源码。

## 动机

一轮 Agent 对话会反复执行 `assistant -> tool -> assistant -> tool ...`。
该轮**第一次**模型调用正是供应商提示缓存可能已过期、需要整段重新 prefill(重建缓存)的时机;
后续同轮调用往往命中刚重建的缓存。因此"缓存未命中"发生在轮首,而不是轮尾。

DSH 自带的 token/缓存统计条位于输入框下方,轮次繁多时难以对应到具体某轮;
消息最底部的"产物文件"行则是轮尾才出现。二者都无法在轮首就地提示一次 miss。

本插件把 miss 提示放到它真正发生的时刻:轮首第一条 assistant 回复正下方,黄色单行,
不顶替任何已有 UI。它只关心"该轮第一次模型请求是否重建了缓存",不关心后续命中的调用。

## 判定口径

以流中该 step 的 `usage` chunk 为准(`assistant/chunk` 事件携带的 `usage` 型
StreamChunk,adapter 在终止 finish 之前发出,内含 `inputTokens` / `cacheReadTokens` /
`cacheWriteTokens`)。无 `usage` chunk 的 provider 退回到 `assistant/message` 的 `usage`。

`inputTokens` 是"未命中缓存的输入"(disjoint 口径),`cacheReadTokens` 是命中部分,
缓存命中率 `hitRatio = cacheReadTokens / (inputTokens + cacheReadTokens)`。
一次请求判为"缓存未命中"(miss),当且仅当以下三条同时满足:

- `inputTokens > 0`;
- `hitRatio < 80%`(超过 20% 的输入未命中);
- `inputTokens >= 1000`(至少 1k token 真正重算)。

`cacheReadTokens` 缺失按命中率 0 处理。正常续写(命中率 >= 80%)不渲染任何内容。

`re-billed` 只显示 `inputTokens`(未命中部分),即本次 miss 真正重新计费的输入;
旁边再显示 `cached`(`cacheReadTokens`,命中部分),二者相加即本次 prefill 总量。

由于数据取自流中的 usage chunk,判定在 usage 到达时即可完成,无需等待
assistant 消息结束——这正是"在 miss 发生的时刻立即提示"。

## 展示内容

轮首第一条 assistant 回复正下方,渲染一条黄色等宽单行,形如:

```
Cache miss after 3m idle: 182k tokens re-billed · 0.8k cached · ttft 2.1s ↑
```

- `idle`:距上一轮结束的空闲时长,>= 60s 显示为分钟,否则为秒。
- `re-billed`:该请求 `inputTokens`(未命中部分)的千分位缩写(k)。
- `cached`:该请求 `cacheReadTokens`(命中部分)的千分位缩写(k),provider 未回报时不显示。
- `ttft`:该条 assistant 首 token 时延(TTFT)= 首个非空 token delta 事件时间 -
  `step/start` 事件时间,秒、一位小数,末尾加向上箭头示意重建 prefill 通常更慢;
  边界缺失时不显示该段。
- 纯文本,无 emoji,不自动消失,刷新页面后随会话投影自然消失。

## 渲染与落点

使用 DSH 的 conversation-node 机制:

- 注册 `ConversationNodeDefinition`,匹配 `step/start`(start)、`assistant/chunk`
  与 `assistant/message`(update),key 为 `turn:step`。`usage` chunk 到达即判 miss,
  满足判定时立即发布节点——黄线在模型流式输出尚未结束时即可出现。
- 节点经 `conversation.chat.node` 的 keyed seat 渲染(独立 key,不占 `turnTail` 链)。
- 因此与 `DSH-better-sidebar` 在 `turnTail` 的产物文件行互不冲突:
  本插件渲染在 step 内,产物行渲染在轮尾;二者位置不同、各自独立。

依赖注入:`conversationEvents`(注册 Definition)与 `slots`(注册 keyed 渲染器)。

每次 miss 在浏览器控制台输出一行,带浏览器本地时区时间戳;渲染器用 ref 去重,
每 `turn:step` 至多输出一次,不会因重复渲染而堆积。

## 包形态与装配

独立 npm 风格 bundle,不进入 deepseek-harness 仓库:

- `package.json`:`dsh.bundle.patch` 指向 `cordis.patch.yml`,`dsh.client` 声明浏览器半区。
- `cordis.patch.yml`:insert 一行,按包名挂载。
- 类型来源为官方 `@deepseek-ai/*` npm SDK(devDependencies),tsconfig 不指向任何源码 checkout。
- 装配进 `~/.dsh/profiles/web`:`dsh plugin --profile web add link:<本包路径>`。

## 约束

- 界面文案中文,代码注释英文(DSH 插件惯例)。
- 不使用 emoji。
- 不修改 DSH 源码、不逆向侵入 `turnTail` 链。
- 类型仅来自官方 npm SDK。测试使用 vitest。
