# Changelog

本文件记录 dsh-anima-rag 的所有显著变更。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

> ⚠️ 版本号这一栏：本仓**不起版本号**（`package.json` 仍是 `0.1.0`）—— 与
> `dsh-memory-archive` 的既有做法一致（服务的是本机这条流水线，不对外发布）。

## [Unreleased]

### 2026-09-27 凌晨二（**会话白名单认性质**：绑定了周目的会话 = RP 会话，不再只认 UI 标记）

> 真机现象（用户报）：12 周目推轮后 **anima 检索整个没触发**（`<recalledMemories>`/`<memoryEcho>`
> 全缺、零日志、零故障说明）。根因：`sessionAllowed` 的 rpOnly 白名单——只要名单里有**任何一个**
> 会话带 `character-follow` 标记（本机 9 个），不带标的新会话就被**静默滤掉**；而「与 X 新开周目」
> /继续/回档**不打**那个标记。用户口径（逐字）：「**修逻辑。让anima能认出活跃会话的性质**」。

- **Changed｜白名单判定抽成纯函数并新增「性质」识别路径**：`lib/session-playthrough.js` 新增
  `decideSessionInject({ rpOnly, rpMarked, rpMarkedCount, allowSessions, playthroughBound, sessionId })`
  ——判定顺序与旧行为逐字一致，唯一新增：名单激活 + 无 UI 标记时，**经 catalog/timeline 绑定了
  周目的会话放行**（`resolvePlaythroughForSession(...).source === 'session'`，与周目隔离闸同一条
  机器、同款 10s TTL 缓存）。编程/工具会话**从不**绑定周目 ⇒ 「不污染编程会话」的初衷不变。
  `lib/index.js` 的 `sessionAllowed` 改走纯函数（hook 计数 `skippedSessions` 不变）。
- **自检**：`_selftest-session-playthrough.mjs` 新增 ⑤ 组 **9 条**（rpOnly 关/带标记/新路径/
  反证：同输入只差 `playthroughBound` 一位判定必须翻红/allow-list 兜底/no-criteria 回退/
  畸形输入不抛）——**34/0**；全套门 **73 passed / 0 failed**；已部署重启（激活失败 0）。

### 2026-09-26 深夜二（`anima_query` 两个真 bug 修复：schema 漏声明 ＋ 隔离闸无参调用 ＋ 12 周目 retag）

> 真机现象（用户推轮后报）：`tool "anima_query" returned invalid output: "value.diagnostics" is not
> a declared property`。顺藤摸出**两个独立的真 bug**，都已修复并上机。

- **Fixed｜① output schema 漏声明两个字段**（`lib/index.js` `anima_query` 注册处）：execute 的返回里
  带着合法的诊断字段 `diagnostics`（0 命中说清为什么，2026-09-20 加的）和 `ensured`（向量库补建记录），
  但 output schema **没声明它们** ＋ `additionalProperties: false` ⇒ 宿主严格校验**每次都拒收整份返回**
  ⇒ 模型拿到的是校验错误而不是查询结果。修复：schema 补声明 `diagnostics: {type:'object'}` 与
  `ensured: {oneOf: [string, null]}`。
- **Fixed｜② 隔离闸无参调用**（同一工具）：`const iso = isolationPlan()` **不传 sessionId** ⇒
  `resolvePlaythroughForSession(idx, undefined, '')` ⇒ `bound = ''` ⇒ fail-closed 永远 blocked
  （`no-bound-playthrough`）⇒ **该工具自隔离上线起就没成功查过**（每次都走"周目隔离"拒绝分支）。
  修复：传入会话 id（`args.session_id ?? agent?.id`）。⚠️ 同文件另两处调用（1036/1537）本来就传了，
  仅此一处漏。
- **迁移配套**：12 周目（`playthrough-ceda5fb5…`）建好后，dsh-memory 库 13 条切片 retag 为
  `pt:playthrough-ceda5fb5…`（index.json + 各切片元数据文件；备份 `产物\backup-sessions\retag-migration-20260926`）。
  其余 2 条为 verify 探针（无 pt）。锚重核：`_selftest-playthrough-isolate` 真机锚 **14 → 15**
  （撕裂索引修复后，此前失败的 mt-0141-0196-1 补入库）。
- **自检与上机**：retrieval-config 30/0、read-failure 14/0、echo-slot 11/0、playthrough-isolate 7/0；
  整套门 **73 passed / 0 failed**。部署同步（复检逐字节一致）＋ 宿主重启激活失败 0。

### 2026-09-26 下午（**BM25 撤销退役**：上面那节的 T3 被用户收回，整条接回 —— 辅助会话做了大半、收尾单补完并上机）

> 用户口径（逐字）：「**我开了个辅助会话修bm25被错误摘除的问题。但现在辅助会话没了。你继续**」
> —— 即 §当天上午那节里的 T3「摘掉 fts5/BM25」**方向收回**：BM25 不是没用，是当时接错了线
> （`dbId` 键名那次没修完就被当"没用"摘了）⇒ 整条装回，与向量并轨。

- **Changed｜BM25 支线整条接回**（辅助会话完成大半，本单收尾）：`lib/bm25.js` / `lib/dictionary-reindex.js`
  复活；`bm25Root` / `cfg.bm25` / `bm25SearchText` / `bm25Configs` / 检索并轨（`merged_chat_results`
  向量 + BM25 双路）；入库/孤儿回收/面板动作（`rebuild:bm25` / `delete-bm25`）同步接回。
  T1（嵌入超时当一等故障）与 T2（anima 接管 `<memoryEcho>`）**原样保留**，没有被这次回退波及。
- **本收尾单补的三处**（辅助会话没跑完的尾巴）：① `_selftest-vector-panel.mjs` 的 C6/E22/I7
  三条判据与代码对齐 —— 其中 **C6 是真代码病**：`lib/vector-panel.js` 里 `bm25` 的取值被塞进了
  `vectorRoot !== ''` 的分支 ⇒ vectorRoot 一空 BM25 行就整个消失（null），而不是如实亮 ⚠缺失；
  已改成 **bm25 与 vectorRoot 两把独立的钥匙**（缺哪把哪把 exists:false，⛔ 不编 0）。
  ② ③ 见那台子的 E22/I7 注释（判据换方向 + 文案对齐真实归档名）。
- **④（真机抓的第四处，当天傍晚）｜`anima_ingest` 的 output schema 里 `bm25` 被嵌进了
  `vector.properties`**（恢复时合并错位，缩进都乱了）⇒ 宿主激活期 schema 校验
  （`required` 名必须在同层 `properties`）**拒激活整个插件**：`JsonSchemaError: …oneOf[1].required
  names "bm25" which is not in properties` ⇒ `anima_query` 工具消失、**API 一直不回复**。
  修复 = 把 `bm25` 挪回 verify 顶层与 `vector` 并列（与运行时 `out.verify = { vector: {…}, bm25: {…} }`
  一一对应）。复检：全仓 **4 个工具注册**的 parameters/output schema 用宿主同款规则
  （required ⊆ properties，全层递归含 oneOf/items）**全部通过**；`test/` 65/65、
  `_selftest-ingest-kick` 22/0。重启后启动日志 `did not activate` 0 次、`anima_query` 回到
  rp-tool-scope 的保留名单、插件页组件状态「运行中」。
- **自检**：本仓 9 个台子全绿（辅助会话已改齐）；整套门 **73 passed / 0 failed**。
- **上机**（2026-09-26 傍晚）：`_sync-plugin-deploy.mjs --apply` + 宿主重启，面板「向量」档实测：
  BM25 行（重建/删除 + ⚠缺失如实亮）与「重建（向量 + BM25）」回执都在；参与检索开关文案回到
  "同时管向量与 BM25 两个库"。

### 2026-09-26（读侧故障当一等故障 · `<memoryEcho>` 改由语义命中装 · BM25 / minisearch 整条退役）

> 用户口径（逐字）：
> 「**3 把anima也加入回响吧。也就是自动触发。fts5目前看用处不大，摘除吧。都派给glm**」
> 追问现状时补的（逐字）：「**3 我没看到有anima的recall，只看到了fts5注入的，anima字段是空的**」
> 任务书三条硬要求：① 读侧嵌入失败 ⇒ **注入那一格有那句如实说明**（⛔ 不许静默）＋ 超时/重试/降级口径写死；
> ② 回响那一格（`<memoryEcho>`）**以后装 anima 的语义命中**，仍每轮装配时算（⛔ 不加定时器/轮询）；
> ③ **摘掉 fts5/BM25**（索引构建、读侧打分、`bm25Root`、面板那一行、配置段），且**摘除要如实体检**。
> ⛔ 全程不动隔离闸与 `pt:` 口径、⛔ 不动 `vector` 那一路的入库口径、⛔ 不同步、⛔ 不重启、⛔ 不提交。

#### T1 · 读侧故障当一等故障（★ 先做的一件）

- **Fixed｜★★ 真凶：每一次成功检索都在最后一行崩掉，一声不响**（`lib/index.js` 的 `retrieve()`）——
  `recentText: readRecentSummaries(sessionId)` 里的 `sessionId` **在本函数作用域里不存在**
  （参数叫 `sessionKey`；`09aab50` 那次改调用点时漏改）⇒ 每轮检索都抛
  `ReferenceError: sessionId is not defined`，被 `retrieve` 自己的 catch 吞成"空文本 ⇒ 本轮不注入"
  ⇒ **`<recalledMemories>`/`<immediateHistory>` 每轮都是空的，而界面上一个字都看不出**。
  这正是用户看到的那一幕（「anima字段是空的」）。改成传 `sessionKey`（= 会话 id），
  并新增判据 `_selftest-read-failure.mjs:③d`（把这个事故**原样重放**一遍：把 `sessionKey` 换回
  `sessionId` ⇒ 判据必红）。
- **Added｜嵌入调用有了"单次上限 / 尝试次数 / 整段预算"三个旋钮**（`lib/engine.js` 的 `getEmbedding`
  ＋ `lib/index.js` 的 `DEFAULTS.embed`）：
  · `embed.timeout_ms` = **5000**（**单次尝试**上限；此前写的是 60000）；
  · `embed.attempts` = **2**（总尝试次数；**只对超时/网络错重试**，4xx/shape 错一次就抛）；
  · 读侧另传 `apiConfig.deadlineMs` = 本轮装配的绝对截止时刻（`timeoutMs - 2000` 的装配余量）。
  **理由（真机实测 2026-09-26）**：端点**是通的** —— `Qwen/Qwen3-Embedding-8B` 热调用实测
  0.14–0.27s（4B 0.11–0.12s），但**偶发单次 7.6s+**，宿主的只读自检
  `POST /dsh-memory-archive/api/retrieval/test` 抓到过一次 `code:'TIMEOUT', elapsedMs:15004`；
  而每轮检索预算只有 `timeoutMs: 12000` ⇒ **一次慢调用就够让整轮放弃等待**。
  改前那一支是裸的 `return out`：放弃之后**什么都不注入、界面上谁也看不出**，而且那个 fetch
  还在后台跑（结果算完没人要，白烧一次调用）。现在 5000×2 = 10s < 12s ⇒ 嵌入阶段必定在轮预算内
  收场：要么给向量，要么给一句**可分类的如实说明**。三个数全部在**装配那一脚**里用完
  （⛔ 无轮询、⛔ 无定时器、⛔ 阻塞主对话不超过 `timeoutMs`）。
- **Added｜失败的如实说明进"注入那一格"**（`lib/index.js` 的 `failureNote` / `EMBED_FAIL_LABEL`）——
  措辞刻意**不像记忆**（用〔〕包起来、明说"这是故障说明，不是记忆内容"、⛔ 不放进
  `<recalledMemories>`/`<memoryEcho>` 里面）：`〔检索没跑成（HH:MM:SS）：嵌入端点超时
  （已试 2 次，单次上限 5000ms，共 10.1s，端点 …/embeddings，模型 …）：<底层原因>
  —— 这一段本来该放语义检索到的历史记忆，现在它没有内容。这是故障说明，不是记忆内容。〕`
  故障码 → 人话：`NO_KEY` 没配 key / `TIMEOUT` 超时 / `NETWORK` 连不上 / `HTTP` 返回了错误 /
  `SHAPE` 返回的数据不认 / `UNKNOWN` 别的错（含内部错）。
  装配钩子的**超时那一支**（`Promise.race` 到点）也走同一套措辞（改前也是裸 `return out`），
  并把它缓存进本轮 ⇒ 一轮里后续 step 复用同一句，⛔ 不重复等、⛔ 不重复说。
- **Fixed｜引擎外层那圈包装会把失败分类抹平**（`lib/engine.js` 的 `query()` catch）——
  它照旧抛 `code:'ANIMA_QUERY_FAILED'`（对外契约，**没动**），但现在把底层的真码与诊断
  一并带出来：`originCode`（TIMEOUT/NETWORK/HTTP/SHAPE/NO_KEY）＋ `attempts`/`elapsedMs`/
  `endpoint`/`model`＋`cause`。没有这一步，读侧只能写一句无用的"未知错误"。
  （★ 这条是**新判据抓出来的**：`_selftest-read-failure.mjs:②` 用真 HTTP 端点逼出超时，
  断言 `originCode`，先红后修。）
- **Fixed｜拿不到内容时不再留旧文本**（`lib/index.js` 装配钩子）—— 空结果时
  `lastBySession.delete(sessionId)`：同步兜底 provider 读的就是它，留着 = 把**上一轮的记忆**
  当这一轮注入（改前正是这个形状）。
- **Added｜维度核对（把 NaN 那类静默说出来）**（`lib/engine.js` 的 `dimensionDiagnostics` →
  查询结果 `_diag`；`lib/index.js` 的 `dimMismatchNote`）—— 查询向量与库里存量的**维度对不上**时，
  余弦相似度会算成 `NaN`/垃圾而**不报错**（`DEFAULTS.embed` 那条老警告讲的就是这件事）。
  真机实测：`dsh-memory` 是 **4096 维**（8B 写的）、其余 12 个库是 **2560 维**（4B 写的）
  ⇒ 那 12 个库的每条命中 `score` 都是 `NaN`。现在逐轮如实说一句
  `〔检索有个**配置**问题：查询向量的维度与库里的切片对不上 —— … 要么把模型换回写这些库时用的那个，
  要么按当前模型**整库重算**〕`。⛔ **不过滤** NaN 结果（过滤会让"库还在但排不出序"变成
  "看起来库里没东西"，更难查）；⛔ 不替用户换 key/模型（那是用户的配置面，见下"待办"）。
- **Added｜面板与工具都看得见"读侧最近一次到底跑成没有"**：`vector-info.json` 新增
  `retrieval: { ok, failure, note, lastOkAt, ms, dimMismatch }`；`anima_status` 新增同名 `retrieval`
  字段（schema 同步声明 —— 宿主按 `additionalProperties:false` 校验，漏声明会整工具拒收）；
  `explainRetrieval` 把读侧故障**排第一**。

#### T2 · anima 接管「回响」（`<memoryEcho>`）

- **Added｜新模块 `lib/echo-view.js`**（纯函数，无 IO/无全局状态）：`buildEchoSlot(hits, opts)` ——
  把本轮语义命中（`merged_chat_results`）渲染成 `<memoryEcho>` 块，形状与改前**同一套**（外层壳、
  前言、每条一行、超预算/截断**一律带标注**）：前言逐字为
  `（历史回响：下面是语义检索命中的过往记忆摘要——都是已经发生过的事，不是此刻；与 <storyAnchor>
  当前坐标冲突时，一律以锚点为准。）`；行首标签认得出楼层区间就写 `[楼 0100-0129]`
  （切片身份 `sum_mt-0100-0129-1` 里的 `mt-<起>-<止>` ⇒ 归档楼层区间，与改前 `[楼 0129]` 同一套读法），
  认不出就**如实写切片名**（`[记忆 1_2]`，⛔ 不编楼号）；靠 life 续命（`is_echo:true`）的那条
  行尾标 `（回响续命）`。
- **Changed｜接线**（`lib/index.js` 的 `retrieve`）：回响格 = 同一份 `merged_chat_results`，
  由新配置 `inject.echo` 驱动（`enabled` / `topK:5` / `maxChars:1200` / `perHitChars:280`；
  `mergeConfig` 为它单独做了一层深合并 —— cordis 的 patch 不深合并，⛔ 别依赖两层默认值）。
  拼进 section 的顺序是 `[补建说明, 维度说明, <memoryEcho>, <recalledMemories>…]` ——
  与改前 `dma:echo`@54 在 `anima:memory`@55 之前**同序**。⛔ 不改时机、⛔ 不加定时器/轮询：
  仍然每轮装配算一次（"自动触发"= 每轮都算）。
- **★ life 衰减的取舍（任务书要求"你自己定并写清理由"）：这一格**不另做一套衰减**。**
  anima 自己的回响机制（`engine.js` 的 `processEchoLogic`，参数就是配置里的
  `echo.max_count / base_life / imp_life / important_tags`）**已经在算**"存活几轮"——
  自然命中的满血复活、`life > 0` 的续一次、枯竭的删除 —— 而且它是命中的**上游**
  （靠 life 撑住的那条本来就在 `merged_chat_results` 里）。在这一格再衰减一次 =
  同一个语义做两遍、两份真相必然漂 ⇒ **life 只留在 `processEchoLogic` 一个地方**，
  这一格是它的**视图**；`is_echo` 那几条在行尾标出来，让模型与面板看得出
  "哪几条是寿命把它们留在场上的"。
- **⛔ 没动的**：周目隔离闸与 `pt:` 口径；`<recalledMemories>`/`<immediateHistory>` 的模板
  （用户的肌肉记忆，逐字未改）；入库口径；`echo`（life）那组参数本身。

#### T3 · 摘掉 fts5 / BM25（检索只剩向量一条路）

- **Deleted｜BM25（minisearch）整条支线**：`lib/bm25.js`（1250 行）、`lib/dictionary-reindex.js`
  （唯一 importer 就是它）**两个文件删除**；`test/selftest-bm25.mjs` 删除。
- **Removed｜引擎**（`lib/engine.js`）：`createBm25` 与其 `bm25Root`/`bm25Persist` 选项（含"缺少
  `options.bm25Root`"那道 throw）；`query()` 的 `bm25SearchText`/`bm25Configs` 入参、
  任务 C/D（聊天/KB 的 BM25 检索：触发词分层扫描、时间意图雷达、TF 加权、多库融合）、
  `bm25ChatResults`/`bm25KbResults` 与返回对象里的两键；`insert()` 的 BM25 写入与"幽灵切片"清理；
  `listBm25()`；`close()` 的 BM25 缓存清空；`_internal.bm25`。
  `mergeAndSortChat/Kb` 去掉第二路入参，**去重与时间线/文档排序行为一字未改**。
- **Removed｜插件面**（`lib/index.js`）：`DEFAULTS.bm25` 与 `DEFAULTS.data.bm25Root`（含
  `mergeConfig` 那行）；`composePayload` 的 `bm25Configs` 整块与 `bm25SearchText`；
  `planFor()` 的 BM25 取词（缓存键改为只由 `searchText` 算）；`verifySlicesOnDisk` 的 BM25 半
  （**回读核对只剩向量**，`out.ok` 也不再要求 BM25 齐）；`insertSlices` 的 `bm25Config`；
  `collectionFiles`/`backupCollection`/`wipeCollection` 的 `bm25File`；孤儿回收里对 BM25 的删除；
  `vectorInfoSnapshot` 的 BM25 统计与 `dataRoots.bm25Root`；`executePanelAction` 的 `delete-bm25`；
  `storeFacts().bm25Exists`；`anima_status` / `anima_ingest` / `anima_query` 三个工具的
  schema 与返回值里的 BM25 字段（含 `bm25_query` 参数、`lastInsert.bm25Found`、
  `lastQuery.bm25SearchText`）；启动告警文案（"BM25 支线仍可用" → "检索这条路整个不通"）。
- **Removed｜其余**：`lib/query-build.js` 的 `buildBm25Text`；`lib/orphan-reconcile.js` 的
  `bm25IdsForIndexes`；`lib/panel-request.js` 的 `delete-bm25`（白名单三动作）、`rebuild` 短名改
  「重建（向量）」、`explainRetrieval` 的 BM25 那句、`makeVectorInfo` 的 `bm25` 字段。
- **Config｜配置里的 `bm25` 段**：`cordis.patch.yml` 删掉 `data.bm25Root`（并留下退役注释）；
  `package.json` 删 `minisearch` + `jieba-wasm` 两个依赖与 `bm25` 关键词；
  `preset/agent.cordis.yml`（在 `dsh-memory-archive` 仓）与 `~/.dsh/profiles/web/cordis.patch.yml`
  里**本来就没有** `bm25` 段（只有一句提到 `bm25Root` 的说明注释）—— 前者的注释已随该仓改动更新，
  后者在守卫的写禁区里（见报告"没做/做不了的事"）。
- **Docs**：`README.md` / `NOTICE.md`（双轨 → 向量单轨 + 退役说明；独立重写与署名原样保留）；
  `docs/ENGINE-NOTES-B.md`（搬运映射表里的 BM25 行标注退役，历史数字标注"历史快照"）。
- **Tests｜跟着改**（全部跑绿）：`test/selftest-engine.mjs` 重写为**向量单轨**（并改为注入桩
  `fetchImpl` 回放真库里的一条真向量 ⇒ 命中它自己；"零写入"断言照旧）；
  `test/ingest.test.mjs`（反证改为"桩声称成功却零写入 ⇒ `ok:false` / `verify.vector.found:0`"）；
  `test/forget.test.mjs`、`test/timeout-hardening.test.mjs`、`test/auto-ingest.test.mjs`、
  `test/summaries.test.mjs`、`test/pure.test.mjs`、`test/ab-compare.mjs`、`test/ab-local.mjs`
  （A/B 工具里"本仓独有的两键"改为**预期退役差**）；`_selftest-anima-delete-mechanics.mjs`
  重写为**向量删除机制**（`deleteItem(id)` + 删元数据文件；反证：认不出的 id ⇒ 静默 no-op，
  必须靠回读）；`_selftest-orphan-reconcile.mjs`（删 BM25 那组与真机 BM25 锚，真机锚改为按现测的
  **不变量**：items=12 / 白名单内 10 / `probe_1`·`probe_2` 不动）；`_selftest-panel-request.mjs`
  （三个动作 + 反证"旧面板发 `delete-bm25` ⇒ 当未知动作拒绝" + 去注释后源码零 BM25）。

#### 自检

- **新增两条台子**（都进全量门）：
  · `_selftest-read-failure.mjs`（**14 通过 / 0 失败**）—— ① **端到端**：用假引擎把读侧逼进
    超时/普通错误/正常有命中三种状态，断言注入那一格**分别**是"那句如实说明"（含码、次数、端点、
    模型、"不是记忆"）/ 说明 / `<memoryEcho>`+`<recalledMemories>` 真内容（且无说明、维度问题被说出、
    两格顺序正确），每条带 ★反证；② **真打本地端点**验嵌入口径（永不响应 ⇒ `originCode:TIMEOUT`、
    `attempts:2`、总耗时 ≤ 预算；预算紧 ⇒ 只试一次；正常 ⇒ 不抛；没 key ⇒ `NO_KEY`）；
    ③ 接线级（catch 返回 `failureNote`、超时那一支不再裸 `return out`、`readRecentSummaries(sessionKey)`、
    清了旧文本、引擎五种失败码齐）—— 各带 ★反证，其中 ③d 把真机那个 ReferenceError 原样重放。
  · `_selftest-echo-slot.mjs`（**11 通过 / 0 失败**）—— E1 空/畸形不注入；E2 壳与前言逐字；
    E3 楼层区间 vs 如实写切片名；E4 `（回响续命）` 标记；E5 三重预算且任何路径不超预算；
    E6 顺序沿用传入序 + 纯函数；**E7 ★★ 反证：fts5 形状的命中（`{floor, body, docKey}`）喂进来
    一条都用不上**；W1–W4 接线（喂的是 `merged_chat_results`、由 `inject.echo` 驱动、
    排在 `<recalledMemories>` 之前、换回 fts5 那套数据 ⇒ 必红）。
- 本仓 9 个 `_selftest-*.mjs` 全绿（5/0 · 30/0 · 11/0 · 22/0 · 11/0 · 29/0 · 7/0 · 14/0 · 25/0）；
  `test/` 下 `pure`/`ingest`/`forget`/`summaries`/`timeout-hardening`/`auto-ingest`/
  `selftest-engine`/`selftest-ingest-maintenance` 全绿。

#### ⚠️ 真机现状（如实记账，⛔ 不是本单引入、也⛔ 不在本单修）

1. **`dsh-memory` 有一半切片读不回来**：`vectors/dsh-memory/index.json` 列 12 条，盘上只有 6 个
   per-item 元数据文件；另外那几条的 `.json` 被 `_quarantine-*` 目录吃掉了（自动维护把**索引还引用着**
   的文件也移走了）⇒ 读侧 ENOENT、那几条**永远召不回**，且只在引擎日志里"检索函数崩溃"。
   本单把"读侧读不到"这件事在 `_diag` 与说明里**说了出来**，但**没有动**那条维护口径
   （任务书明确"⛔ 不动 vector 那一路的入库口径"）⇒ 留给下一单。
2. **模型/维度混用**：`dsh-memory` 4096 维（8B）vs 其余 12 个库 2560 维（4B）。
   按本仓自己的纪律"换维度/换模型必须整库重算"，**要么**把 `retrieval.model` 换回 4B
   （`Qwen/Qwen3-Embedding-4B`，2600 维那批库就能用，但 `dsh-memory` 要重算），
   **要么**把 12 个历史库按 8B 整库重算（embedding 额度要够）。⛔ 本单不改用户的 key/模型/数据。
3. 嵌入端点**本身是通的**（这次实测：8B 热调用 0.14–0.27s、偶发 7.6s+；4B 稳定 0.11–0.12s；
   rerank 0.12s）—— 所以上面两条才是"检索像空的"的主因，超时只是**加重**了它。

#### 收尾补记（2026-09-26 第二单：上一轮 45 分钟超时被掐之后）

- **★ 上一轮怎么收的场，如实记**：跑满 45 分钟预算被 taskkill（`timedOut:true`、**没有报告**、
  `response` 为空）—— 但**盘上状态自洽**（复核者验过：整套门 **73 passed / 0 failed**）。
  上面这一节就是那一轮留下的（T1/T2/T3 的实现与台子都已落盘），缺的只是**逐条自证 ＋ 报告**。
- **本单补的事（本仓代码零改动，只补证）**：
  · **T-A 五条逐条自证全过**：① `dma:echo` 无任何注册（本仓只注册 `anima:memory`@55，
    `lib/index.js:200/2052`；memory-archive 的 54 位是**带名空位**、全仓无第二处）；
    ② fts5/sqlite 零活路（本仓 `package.json` 无 sqlite/bm25 依赖，`lib/bm25.js`、
    `lib/dictionary-reindex.js` 确已删，活代码里 BM25 字样全是"已退役"历史注释）；
    ③④ 见 memory-archive 仓那节的面板/配置证据；⑤ **`preset-modules/` 九份模块里
    echo/bm25/fts5/sqlite 零命中** —— 铺盘不会把 `dma:echo` 带回来。
  · **T-C 端到端**：`_selftest-read-failure.mjs` **14/0**（① 组端到端带反证 ①b：把那句说明挖掉 ⇒ 必红）、
    `_selftest-echo-slot.mjs` **11/0**；面板「最近检索」行 ← 宿主 `/vector/state` ← 本仓落盘
    `vector-info.json` 的 `retrieval{ok,failure,note}` —— 注入格那句说明与面板行**是同一份**。
  · **T-E 真机自检（本单实测）**：`POST /dsh-memory-archive/api/retrieval/test` ⇒
    embedding **ok, 210ms** / rerank **ok, 233ms**（HTTP 200，总 0.54s，响应无 key 字段）。
    **结论：5000ms 单次上限的依据仍成立** —— 热调用 0.2s 量级、余量 ~20×，偶发慢毛刺由
    `attempts: 2`（共 10s < 每轮 12s 预算）兜底，⛔ 不必收紧也不必放宽。
  · **T-D 取舍（只记结论，⛔ 没改码）**：现状 = 54 位**带名空位**、`<memoryEcho>` 由本仓的
    语义命中装在**55 段里**（与 `<recalledMemories>` 同段两块，用户要的"anima 加入回响"已成立）；
    若以后要"独立 54 格"，要动：本仓注册面（第二个 `systemPrompt.section`）＋ `DEFAULTS.inject.echo`
    加 order 旋钮 ＋ memory-archive 的 `card-sections.js` 空位注记与版本号 ＋ 三个台子 ＋ persona 一行
    —— **要用户点头才做**。

