# dsh-cache-miss 设计文档

独立 DeepSeek Harness 浏览器插件。
在一轮对话的第一条 assistant 回复正下方,以黄色单行提示该轮首条模型请求发生过的提示缓存未命中(prompt cache miss)。

纯前端渲染,不写入 session log,不修改 DSH 源码。

## 动机

一轮 Agent 对话会反复执行 `assistant -> tool -> assistant -> tool ...`。
该轮**第一次**模型调用正是供应商提示缓存可能已过期、需要整段重新 prefill(重建缓存)的时机;
后续同轮调用通常命中刚重建的缓存,但并非总是如此——上下文在轮内被改写时(工具结果、重试、
压缩等),后面的调用同样可能整段失效。因此轮首是主要落点,轮中命中失效的 step 也要能看到。

DSH 自带的 token/缓存统计条位于输入框下方,轮次繁多时难以对应到具体某轮;
消息最底部的"产物文件"行则是轮尾才出现。二者都无法在 miss 发生的位置就地提示。

本插件把 miss 提示放到它真正发生的时刻:该 step 的 assistant 内容上方,黄色单行,
不顶替任何已有 UI。轮首那条带"距上轮结束的空闲时长",轮中那条带 step 号。

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
Cache miss after 3m idle · 182k tokens re-billed (turn ~$0.027) · 0.8k cached · ttft 2.1s ↑ · (tools changed) · session used (~$2.90)
```

- `idle`:距上一轮结束的空闲时长,>= 60s 显示为分钟,否则为秒。
- `re-billed`:该请求 `inputTokens`(未命中部分)的千分位缩写(k)。
- `(turn ~$…)` / `(step ~$…)`:被重建的那部分的近似金额,沿用官方术语。miss 发生在轮首
  请求 → 整段上下文被重建,标 `turn`;发生在轮中某步 → 只有该步改动的前缀被重建,标 `step`;
  同一轮两者都重建过 → 直接给合计 `(~$…)`,不并列两个词让读者自己加。金额只算
  **prompt 部分**(未命中输入 + 命中的缓存读),不含 output——本插件关心的是缓存成本,
  各层级同口径才可比。`~` 明示估算,`$` 即 models.dev 的美元单价。
- `cached`:该请求 `cacheReadTokens`(命中部分)的千分位缩写(k),provider 未回报时不显示。
- `(system prompt changed)` / `(tools changed)`:核心对本次请求的**前缀变更分类**,写成人话而不是
  照抄枚举名——行的目的是说"为什么重算",只写 `system` / `tools` 会读成一个 token 桶。系统提示和
  工具目录都属于前缀,任一处变了就从变化点往后全部失效,所以这是 miss 最常见的原因。
  分类来自核心,插件不做二次推断(理由见「前缀变更检测」)。
- `(config changed)`:同一份 inspector 结果里的 `config` 变了(provider 切换、reasoningEffort 等)。
  配置不同就是不同的缓存命名空间,整段 prompt 都会重算;核心的分类只覆盖 system/tools,
  所以这一段由插件在**同一份规范化 config** 上做等值比较补上,可与分类叠加:
  `(system prompt + config changed)`。
- `session used (~$…)`:会话已用量(已载入窗口口径的近似金额);`used` 指明这是累计花费而不是本次。
- `ttft`:该条 assistant 首 token 时延(TTFT)= 首个 token 事件时间 - `step/start`
  事件时间,秒、一位小数,末尾加向上箭头示意重建 prefill 通常更慢;边界缺失时不显示该段。
  流式方言下取首个非空 delta 的事件时间;结算方言下取 `assistant/message.stream` 中
  最早一条带 token 的记录(`reasoning-chunks` / `text-chunks` / `tool-call-chunks` 的
  `time0`;结构性的 `chunk` 块标记不含 token,不算边界)。
- **轮中后续 step 的 miss**:轮首不是唯一可能失效的位置——上下文在轮内被改写(工具结果、
  重试、压缩等)时,后面的 step 同样会判为 miss。它们也各出一条,文案为
  `Cache miss at step N: …`:轮级 `idle`(距上一轮结束)对轮中事件没有意义,改用 step 号
  定位。同一轮的多条提示按 step 升序紧贴该轮的过程摘要行排列。
- **step / turn / session 三级就是段**:不做表格。重建金额紧跟在 re-billed 后面,
  `session` 追加为末尾一段,取自已载入的 assistant 记录(`legacy.nodes`)按当前模型单价
  求和——"已载入窗口"口径,不是逐笔账单。
- 纯文本,无 emoji,不自动消失,刷新页面后随会话投影自然消失。

当 provider 回 usage 但不回 `cacheReadTokens`/`cacheWriteTokens`,且从未出现过任何
cache 字段时,插件无法区分「完全 miss」与「命中但不报明细」,渲染一条灰色提示,文案为
`Provider reports no cache fields — cannot confirm cache status`。每个这样的 provider
首次出现时提示一次;切换到另一个无证据的 provider 会再次提示。控制台同步输出每个
provider 一次的更详细 warning(含 turn/step、provider、`inputTokens` 与缺失字段说明)。
一旦该 provider 出现过任一 cache 字段,后续无字段的请求按完全 miss 正常显示黄线。
不做 TTFT 启发式兜底:用户间隔可能远超 TTFT 阈值,无法可靠区分 cache miss 与网络/负载慢。

## 前缀变更检测

DeepSeek 按前缀命中缓存:系统提示或**工具目录**任一处变了,变化点之后的 token 全部按 miss 计费。
0.2 起的核心已经把这件事算好了(只是目前只喂给"轨迹"视图):每个请求的 `request/header` 事件经
`uiConversation.inspectRequestPrompt(previous, event, system)` 规范化成 `{ config, system, tools }`,
并直接给出 `change.kind`(`system` / `tools` / `system-and-tools`)。

插件只**转述这个结论**,不自己再算一遍:

- Definition `cache-miss-system`(`target: chat`,不发布节点):`match` 系统消息与 surface 替换事件,
  用 `uiConversation.inspectSystemPrompt` 保留"当前生效的系统提示"——header inspector 需要它才
  分得清 system 与 tools;
- Definition `cache-miss-prefix`:只 `match` `request/header`,用 `reader.previous(...)` 取上一个
  请求快照与上一步的系统提示,调上面的 inspector;`change.kind` 直接写进模块级 map
  (键 `turn:step`,上限 500 条),渲染层按自己的 `turn`/`step` 取用,拼成 `(~tools)` 这类段。
  同时用 inspector 返回的规范化 `config` 与上一份做等值比较(递归排序键后再比 JSON),
  变了就在标签里补 `config`——核心的分类不覆盖这一项,而 provider 切换(实测
  `deepseek-official` ↔ `deepseek-account`)会直接换掉缓存命名空间,整段 prompt 重算。
  比较的仍然是同一份 inspector 结果,没有引入新的核心结构。

为什么不做工具级 diff:那需要自己按 name + `description`/`parameters` 比较两份工具 schema,
等于把插件绑死在核心的 `ToolSchema` 形状和 inspector 的返回结构上。核心一改,插件就炸;
而"到底是 tools 变了还是 system 变了"这个信息核心本来就已经算好、稳定、且足够解释一次 miss。
少借一点核心内部结构,就少一个会崩的地方。

已知边界:map 以 `turn:step` 为键,同页打开两个**不同会话**且轮号撞车时,这段文字可能张冠李戴
(极低概率,只影响这一个词);旧核心上若没有这两个 inspector,插件自动不注册对应 Definition,
行里没有这一段——其余功能不受影响。
## 计价口径

价格取自 [models.dev](https://models.dev/api.json) 的 `deepseek` provider。随包提交的
`src/client/prices.gen.ts`(由 `pnpm run prices` 生成)是**离线兜底**:没有实时价目时它兜住每一行。

实时价目按需取,三个触发点:

- **过期**:存储的价目按 **24 小时** 有效期算,过期后下一次页面加载(插件 apply)刷一次。
  这条专门对付"调价了但快照里明明有旧价"——没有它,旧价会一直赢;
- **切模型**:某行模型 id 与上一行不同(换模型 = 换了计价),刷一次;
- **查不到**:某行的模型 id 在现有价目里查不到(新模型、relay 换了拼写),刷一次。

其他细节:

- 去重 + 限流:同一次页面会话内最多每 1 小时真正发一次请求,未定价模型重复渲染不会反复触发;
- 结果只留 DeepSeek 子集,写进 `localStorage`(`dsh-cache-miss:prices`),体积几 KB,跨会话复用;
- 拿到后立即生效:刷新事件通知已渲染的行重算,金额当场出现,不用刷新页面;
- 全是 best-effort:`fetch` 失败、离线(`navigator.onLine === false`)、存储被禁,都继续用手上的
  价目(实时缓存 → 快照),只警告一次,行照常显示其余字段。

models.dev 返回 `Access-Control-Allow-Origin: *`,浏览器可直接取;`api.json` 约 5.7 MB
(压缩后 ~590 KB),一天最多付一次,或换模型时付一次。

- 金额 = 未命中输入 × `input` + 命中的缓存读 × `cache_read` + 缓存写入 × `input`,
  单价为 models.dev 的 USD / 1M token;
- 直接显示美元(models.dev 的计价口径),`~` 明示是本地估算,实际扣费以账单为准;不做汇率换算,少一层猜测;
- 不做峰谷/节假日分时计价:那是单一供应商的定价策略,插件不为任何供应商写死时段规则;
- 输出 token 不计入金额——提示行回答的是"这次 prompt 花了多少";
- 模型名匹配不到快照时不显示金额(宁可没有,不编一个),其余字段照常;
- 不做"换窗口建议":对会继续使用同一会话的人,会话记录本身通常比省下的缓存费更重要。

## 渲染与落点

使用 DSH 的 conversation-node 机制:

- 注册 `ConversationNodeDefinition`,匹配 `step/start`(start)、`assistant/chunk` 与
  `assistant/message`(update),key 为 `turn:step`。满足判定时立即发布节点;
  发布的时刻取决于该核心的事件方言(见"判定口径")。
- 节点经 `conversation.chat.node` 的 keyed seat 渲染(独立 key,不占 `turnTail` 链)。
- 因此与 `DSH-better-sidebar` 在 `turnTail` 的产物文件行互不冲突:
  本插件渲染在 step 内,产物行渲染在轮尾;二者位置不同、各自独立。

落点在 0.2 上的调整(轮首的"特征位置"):0.2 把已关闭轮次的过程内容折进一个
disclosure,而 chat 视图只豁免它自己那份写死的 kind 集合
(`TURN_PROCESS_INDEPENDENT_KINDS`),插件无法加入;被折叠内容里的节点会被加上
`hidden`,于是黄线虽然在 DOM 里(样式、文本、ttft 全部正确),画面上却看不到。
因此渲染分两段:

- **摘要行存在时**(已完成轮):把同一行插到该轮的**过程摘要行**(`已完成、用时 …` 那一行,
  即折叠开关本身,带 `data-turn-process="<轮号>"`)**之后**,故折叠状态下仍然可见;
- **摘要行不存在时**(进行中的轮):渲染在 step 流内,此时折叠区被强制展开,当场可见,
  即"miss 那一刻"的位置。

放置**不跟随折叠开关**:实测两者在 0.2 的布局里落在同一处(摘要行就是该轮的第一个元素),
跟随切换只会带来无收益的 DOM 抖动;而"跟随折叠"一旦做错(判成"已展开"却仍插到摘要行,
或反之)反而会出问题。

插入用平台 DOM(本插件是普通页面模块,不是受限沙箱),节点带
`data-dsh-cache-miss` 便于自识别,`MutationObserver` 在 flow item 被重建时重新插入。
查找锚点**必须限定在"本节点所属的那个 Conversation 实例"内**(取渲染节点自身的
`closest('[class*="_centerCol"]')`,即 ui-layout 的中央内容列;该类名的模块哈希前缀随
构建变化,故匹配稳定的 `_centerCol` 后缀,并以本节点 flow item 的父级兜底)——一个会话
可以同时挂载多个 Conversation(主体 + 侧栏聊天页签),它们各自渲染一份同样的 flow 与
同名属性;实测 0.2.0-rc.2 上就有 2 个实例,若按整个 document 取"最后一个"摘要行,会把线
插到别的实例、甚至应用框架层(`BynINW_frame`)。

`data-turn-process` 是 chat 视图的内部属性而非公开插槽契约:摘要行找不到时退回 step
内联渲染(锚点只是可见性优化,绝不是必需条件);而"**被折叠藏住、又找不到摘要行**"是
唯一会让提示静默消失的状态,此时额外打一条 console.warn(每 step 一次,并带上各容器里
的轮号,便于一次定位),让核心改版可被发现。已实测(0.2.0-rc.2,用位置自检开关强制出线):
turn 32–38 各生成一条,稳定落在该实例的消息流内、摘要行正下方,折叠与展开两种状态下
位置一致且均可见。

### 位置自检开关(默认关闭)

因为落点依赖的是 chat 视图的**内部**标记而非公开插槽契约,核心更新后必须能**不依赖
真实 miss** 就确认落点。因此在浏览器控制台执行:

```js
localStorage.setItem('dsh-cache-miss:debug', '1'); location.reload()
```

之后**每一轮**都会显示一条带 `[debug]` 前缀的强制行(命中轮也显示),因此可以直接
看到它究竟落在哪。调试行还带上本轮测得的时间事实,例如
`[debug] 强制显示(本轮无 miss)· turn 43 step 1 · idle 25455m · ttft 1.6s`;
快照里找不到计时表时写 `idle unavailable (no turn timings)`——这样核心再次改动快照来源时,
一眼就能看出是"拿不到"而不是真的空闲了 0 秒。关闭:

```js
localStorage.removeItem('dsh-cache-miss:debug'); location.reload()
```

调试行永远带 `[debug] 强制显示(本轮无 miss)` 字样,不会伪装成真实提示,也不会写入
控制台的 miss 日志;默认(未设置该键)对使用者完全不可见。

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
- `0.2.1-rc.1`(desktop app):上述契约不变(`uiConversation.events`、`data-turn-process`
  摘要行、`_centerCol`、结算方言均实测仍在,黄线实测渲染成功)。唯一差异在快照来源:
  chat 快照由座位以 `useChat` 注入,`useSession` 拿到的是另一份 session 快照(无
  `turnTimings`),所以两个 hook 都读、按快照形状取—只读 `useSession` 会让每行都显示
  `0s idle`。

客户端入口声明:核心 `0.1.5` 起宿主内置的是 `@deepseek-ai/dsh-client-modules`
(`dsh-client-runtime` 在 npm 上止于 `0.1.1-rc.2`,已不再随宿主发布),因此
`dsh.client.inject` 与 peer 都指向 `dsh-client-modules`。

类型取自官方 `@deepseek-ai/*` 0.2.1 系列 SDK(devDependencies):Definition 契约来自
`dsh-client-ui-conversation`,`ChatConversationViewNode` / `ChatNodeDataMap` / 座位
props 来自 `dsh-client-ui-chat`,`ctx.slots` 来自 `dsh-client-ui-renderer`。0.1 时代的
`dsh-client-runtime` devDependency 已移除——它只提供类型、早已不随宿主发布,且会把
`dsh-client-connection@0.0.1-rc.x`(GHSA-8m2g-8cgm-3vcp,本地控制面认证绕过)拖进
lockfile。0.2 收窄了事件联合类型,不再包含本项目仍支持的 `assistant/chunk` 流式方言,
因此该方言在 `asStreamEvent` 一处按结构读取,而不是让类型去限制它。

idle 时长按快照形状取:先读 chat 快照的 `turnTimings`(顶层),没有再读它的
`legacy.turnTimings`,仍未命中再退回 session 快照(0.2 之前的核心把 timings 放在这里);
都拿不到时不猜一个空闲时长(显示 0s),但黄线照常出现——判定本身不依赖 idle。


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







