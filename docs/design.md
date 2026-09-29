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

以该 step 的 `usage` 为准,字段为 `inputTokens` / `cacheReadTokens` / `cacheWriteTokens`。
两个事件方言都显式读取,不假设哪一个存在:

- **流式方言**(0.1.x 核心):`assistant/chunk` 事件携带 `usage` 型 StreamChunk,
  adapter 在终止 finish 之前发出,因此判 miss 无需等消息结束;
- **结算方言**(0.2 起):核心不再发 `assistant/chunk`,usage 落在 `assistant/message`
  上,同时把整段流式时间线折进该事件的 `stream` 字段。

provider 在两种方言下都不回 cache 字段时的处理见下。

`inputTokens` 是"未命中缓存的输入"(disjoint 口径),`cacheReadTokens` 是命中部分,
缓存命中率 `hitRatio = cacheReadTokens / (inputTokens + cacheReadTokens)`。
一次请求判为"缓存未命中"(miss),当且仅当以下三条同时满足:

- `inputTokens > 0`;
- `hitRatio < 80%`(超过 20% 的输入未命中);
- `inputTokens >= 1000`(至少 1k token 真正重算)。

`cacheReadTokens` 缺失且 `cacheWriteTokens` 也缺失时,若该 provider 从未出现过任意
cache 字段,插件无法区分「完全 miss」与「命中但不报明细」,不判 miss,渲染灰色提示
`Provider reports no cache fields — cannot confirm cache status`(每个无证据 provider
一次)。若该 provider 此前出现过 cache 字段,缺失按 `cacheRead = 0` 处理,即完全 miss。
正常续写(命中率 >= 80%)不渲染任何内容。

`re-billed` 只显示 `inputTokens`(未命中部分),即本次 miss 真正重新计费的输入;
旁边再显示 `cached`(`cacheReadTokens`,命中部分),二者相加即本次 prefill 总量。

在流式方言下,判定在 usage chunk 到达时即可完成,黄线可在模型仍在流式输出时出现;
在结算方言下,usage 随 `assistant/message` 到达,黄线在该条回复结算时出现。

## 展示内容

轮首第一条 assistant 回复正下方,渲染一条黄色等宽单行,形如:

```
Cache miss after 3m idle: 182k tokens re-billed · 0.8k cached · ttft 2.1s ↑
```

- `idle`:距上一轮结束的空闲时长,>= 60s 显示为分钟,否则为秒。
- `re-billed`:该请求 `inputTokens`(未命中部分)的千分位缩写(k)。
- `cached`:该请求 `cacheReadTokens`(命中部分)的千分位缩写(k),provider 未回报时不显示。
- `ttft`:该条 assistant 首 token 时延(TTFT)= 首个 token 事件时间 - `step/start`
  事件时间,秒、一位小数,末尾加向上箭头示意重建 prefill 通常更慢;边界缺失时不显示该段。
  流式方言下取首个非空 delta 的事件时间;结算方言下取 `assistant/message.stream` 中
  最早一条带 token 的记录(`reasoning-chunks` / `text-chunks` / `tool-call-chunks` 的
  `time0`;结构性的 `chunk` 块标记不含 token,不算边界)。
- 纯文本,无 emoji,不自动消失,刷新页面后随会话投影自然消失。

当 provider 回 usage 但不回 `cacheReadTokens`/`cacheWriteTokens`,且从未出现过任何
cache 字段时,插件无法区分「完全 miss」与「命中但不报明细」,渲染一条灰色提示,文案为
`Provider reports no cache fields — cannot confirm cache status`。每个这样的 provider
首次出现时提示一次;切换到另一个无证据的 provider 会再次提示。控制台同步输出每个
provider 一次的更详细 warning(含 turn/step、provider、`inputTokens` 与缺失字段说明)。
一旦该 provider 出现过任一 cache 字段,后续无字段的请求按完全 miss 正常显示黄线。
不做 TTFT 启发式兜底:用户间隔可能远超 TTFT 阈值,无法可靠区分 cache miss 与网络/负载慢。

## 渲染与落点

使用 DSH 的 conversation-node 机制:

- 注册 `ConversationNodeDefinition`,匹配 `step/start`(start)、`assistant/chunk` 与
  `assistant/message`(update),key 为 `turn:step`。满足判定时立即发布节点;
  发布的时刻取决于该核心的事件方言(见"判定口径")。
- 节点经 `conversation.chat.node` 的 keyed seat 渲染(独立 key,不占 `turnTail` 链)。
- 因此与 `DSH-better-sidebar` 在 `turnTail` 的产物文件行互不冲突:
  本插件渲染在 step 内,产物行渲染在轮尾;二者位置不同、各自独立。

依赖注入:只硬依赖 web 端必然存在的 `slots`(注册 keyed 渲染器)。Definition 的注册是 best-effort,并推迟到 `conversation.chat.node` 座位被声明时进行——该座位由 `ui-chat` 声明,而 `ui-chat` inject 了 `uiConversation`,因此此刻注册表必定 ACTIVE。探测用 `ctx.get('uiConversation')?.events ?? ctx.get('conversationEvents')`(0.1.2-rc.1 起为 `uiConversation.events`;旧核心为 `conversationEvents`)。之所以必须走 `ctx.get` 而非属性读取:loader 条目之间是兄弟节点,属性读取未 inject 的服务会抛 `cannot get property "<name>" without inject`,那会在 apply 期直接抛错(而非降级);`ctx.get` 读全局服务存储,找不到返回 undefined。找不到注册表时降级为 no-op 并打一条 console.warn,绝不 pending、绝不影响 dsh 启动。注册返回的 disposer 挂到本 fiber,卸载/热重载时移除,避免残留 Definition 导致下次 "already registered"。

## 核心版本兼容

浏览器半区只声明两件真实存在的东西:宿主提供的 `slots` 服务,以及请求码 `turn:step`
的 session 事件。除此之外的一切(注册表服务名、Definition 契约细节、事件方言、
快照字段位置)都按"存在则用、缺失则退"处理,不臆测、不静默改写。

已实测的核心版本:

- `0.1.2-rc.1`(web profile):流式方言,`uiConversation.events` 注册,顶层 `turnTimings`;
- `0.2.0-rc.2`(desktop app):结算方言,`ConversationViewNode` 收敛为
  `{key, kind, id, target, data}`(仍返回的 `anchorSeq` / `location` / `visibility`
  供 0.1.x 使用,新核心忽略),`turnTimings` 移入快照的 `legacy` 投影,
  且 `conversation.chat.node` 的 `cache-miss` seat 实测 active。

客户端入口声明:核心 `0.1.5` 起宿主内置的是 `@deepseek-ai/dsh-client-modules`
(`dsh-client-runtime` 在 npm 上止于 `0.1.1-rc.2`,已不再随宿主发布),因此
`dsh.client.inject` 与 peer 都指向 `dsh-client-modules`;类型仍取自官方
`@deepseek-ai/*` npm SDK 的 devDependencies。

idle 时长读取 chat 快照的 `turnTimings`,顶层没有时退回 `legacy.turnTimings`;
两者都拿不到时不猜一个空闲时长(显示 0s),但黄线照常出现——判定本身不依赖 idle。


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
