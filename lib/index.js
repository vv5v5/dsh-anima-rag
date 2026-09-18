/**
 * dsh-anima-rag —— 每轮注入 Anima 式历史记忆。
 *
 * ## 它是什么
 *
 * 把 SillyTavern 侧 `anima-rag` 的检索核心（向量 + BM25 双轨、回响机制、策略步骤、重排拦截器）
 * 搬进 DSH，**每轮把检索到的历史记忆注入 system prompt**。
 * 检索算法本身由 `lib/engine.js` 提供（服务端 `index.js` 3384 行的搬运版，零 express）；
 * 本文件只负责 DSH 侧的**取词 / 调用 / 装配 / 注入**。
 *
 * ## 挂点与依据（源码级验证，都是本轮实测的）
 *
 * | 机制 | 位置 | 要点 |
 * |---|---|---|
 * | `systemPrompt.section()` | `core/system-prompt/src/index.ts:432`，求值在 `:583` | 每次装配求值 → **不入历史**。但 **provider 是同步的**，只能返回缓存值 |
 * | `'system-prompt/assemble'` waterfall | 同 `:19-31, 601-604` | **async、返回值权威** → 在这里做检索并**自己改写 `assembly.sections`** |
 * | 时序 | `:590-599` 先求值 section provider，`:601-604` 才跑 waterfall | 所以在 waterfall 里 await **不会**让 provider 拿到新值 —— 必须改写 sections |
 *
 * ⚠️ **不使用 `systemPrompt.context()`**：它是 *durable user-role 快照*（`:76`），
 * 由 `agent-loop/src/agent.ts:292` 以 `surfaceOp:'append'` 提交，**文本一变就每轮追加一条进历史**。
 * 检索结果每轮都变 —— 用它 = 每轮往 RP 历史里塞一份重复快照。
 *
 * ⚠️ **不使用 `agent/pre-step`**：它改写的 `messages` 会被 `agent.ts:291-293` 逐条
 * `session.append('user/message', …)` —— 同样是**写历史**。
 *
 * ## 每轮的调用次数
 *
 * `assemble` 在**每一次模型请求**前都会跑（一个 turn 里可能有几十次 step）。
 * 所以检索按 `sessionId :: turn :: hash(检索词)` **按轮缓存**，同一轮内只打一次
 * embedding + query，后续 step 复用。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

import { assembleInjection } from './render.js'
import { extractMessages, buildVectorQuery, buildBm25Text, lastUserText } from './query-build.js'
import { entrySignature, createIngestLedger, findOrphanMetadataFiles, quarantineOrphans, LEDGER_FILENAME } from './ingest-maintenance.js'
import { allowedKeysFromEntries, bm25IdsForIndexes, decideReconcile, findOrphanSlices, metadataFileNamesOf, planVectorPrune } from './orphan-reconcile.js'
import { denyIndexesForPlaythrough, isolationBlockReason, isolationSummary } from './playthrough-isolate.js'

export const name = 'dsh-anima-rag'
export const inject = ['tools', 'systemPrompt']

const VERSION = '0.1.0'
const SECTION_NAME = 'anima:memory'

const ST_DATA = 'D:\\apps\\SillyTavern-Launcher\\SillyTavern\\plugins\\anima-rag'

const DEFAULTS = {
  /** 总开关。关掉后钩子仍注册但不做任何事。 */
  enabled: true,

  /** `lib/engine.js` 的绝对路径。留空 = 用本包自带的 `./lib/engine.js`。 */
  engineModule: '',

  /**
   * 数据根 —— 默认**指向 ST 侧现役 Anima 的数据**，即「继承」而不是「重建」：
   * 12 个 vectra 集合 + 11 个 BM25 库 + session 回响状态。改这里就换了数据源。
   */
  data: {
    vectorRoot: `${ST_DATA}\\vectors`,
    sessionRoot: `${ST_DATA}\\data\\sessions`,
    bm25Root: `${ST_DATA}\\data\\bm25_indexes`,
  },

  /** 聊天记忆集合（对应 ST 的「聊天」向量库名）。可多选。 */
  chatCollections: ['影子_-0906重开'],
  /** 知识库集合。留空 = 关掉 kb 支线（与 ST 侧「受开关严格控制的载荷」一致）。 */
  kbCollections: [],
  /** ★ 用户在 ST 侧 `rag.knowledge_base` 的参数。kb 支线关闭时这些不生效。 */
  kb: { enabled: false, min_score: 0.5, chunk_size: 500, search_top_k: 3 },

  /**
   * embedding 端点。★ 真值取自用户在 ST 侧的现役配置
   * （`settings.json` → `extension_settings.anima_memory_system.api.rag`，注意是**带下划线**的
   *  `extension_settings`，与 ST 常见的 `extensionSettings` 是两个不同的键）。
   *
   * ⚠️⚠️ **模型维度必须与存量向量一致，否则余弦相似度全是垃圾，而且不会报错**。
   * 实测存量 12 个集合的向量维度 = **4096**（`vectors/<coll>/index.json` → `items[0].vector.length`），
   * 而 `Qwen/Qwen3-Embedding-8B` 正是 4096 维。换成 1024 维的 `bge-m3` 会**静默失效**。
   */
  embed: { url: 'https://api.siliconflow.cn/v1', key: '', model: 'Qwen/Qwen3-Embedding-8B', timeout_ms: 15000 },
  /** 重排端点。★ 用户在 ST 侧是**开着的**（`rag.rerank_enabled: true`，`rerank_count: 5`）。 */
  rerank: {
    enabled: true,
    api: { url: 'https://api.siliconflow.cn/v1/rerank', key: '', model: 'Qwen/Qwen3-Reranker-8B', timeout: 15 },
    count: 5,
  },

  /**
   * 检索策略 —— 形状与 ST 侧 `config/default_rag_strategy.js` 一致，
   * 默认值直接抄用户那份（important/period/status/special/diversity + holidays）。
   */
  strategy: {
    strategy_settings: {
      important: { labels: ['Important'], count: 1 },
      period: { labels: ['Period', 'Array'], count: 1 },
      status: { labels: ['Sick', 'Injury', 'Period'], count: 1, rules: [] },
      special: { count: 1 },
      diversity: { count: 2 },
    },
    holidays: [],
    period_config: { enabled: false, events: [] },
    distributed_retrieval: true,
    virtual_time_mode: false,
  },

  /**
   * 检索词构造配置 —— 形状与 ST 侧 `settings.vector_prompt` 一致。
   * ★ 用户真值是 **count: 2**（只拿最后两条消息当检索词），不是库默认的 5/6。
   */
  vectorPrompt: [{ type: 'context', count: 2 }],
  /** 清洗规则（作用在检索词上，不影响注入正文）。`{pattern, flags, replace}`。用户真值：空数组。 */
  regexStrings: [],
  regexSkipUser: true,
  /**
   * ⚠️ 语义差异必须知道：ST 里 `skip_layer_zero` 用于排除「楼 0 = 角色问候语」，用户真值 **true**。
   * **DSH 的历史里没有问候语**（问候语走 import-context，不进 history），
   * 所以在 DSH 打开它 = 「跳过第一条消息」。默认 false（DSH 语义下没东西可跳）；
   * 若发现检索词被历史首条污染，再打开。
   */
  skipLayerZero: false,

  /**
   * 检索调参 —— ★ 全部是用户在 ST 侧的**实际值**（`rag.*`），不是文档默认值。
   * 直接进 `POST /query` 的 payload，服务端照旧消费。
   */
  rag: {
    min_score: 0.2,
    base_count: 5,
    recent_weight: 0,
    candidate_multiplier: 2,
    /**
     * `status` 检索步是否启用。★ 默认 **false** —— 见 `buildChatSteps()` 的「已知偏差」：
     * ST 的 status labels 是每轮动态算的（正则 + 规则评估状态数据），
     * DSH 里那套 `Ellina.*` 变量已不存在（被 L1 state-bridge 取代）。
     * 正式启用前应先把判定接到 L1 状态上，否则只会按静态 labels 硬捞。
     */
    statusEnabled: false,
  },

  /** BM25：词典触发词。扫描与 TF 加权在**服务端**（engine）做，这里只传配置。 */
  bm25: { search_top_k: 3, dictionary: [], contextCount: 3, maxChars: 4000 },

  /**
   * 回响机制参数（原样透传服务端）。
   * ★ 用户真值：`base_life: 1` / `imp_life: 2` / `echo_max_count: 5`
   * —— 比库默认（3 / 10 / 10）**短得多**，即「记忆更容易枯竭、卡槽更少」。
   * 这是他调过的口味，**不要改回默认**。
   */
  echo: { max_count: 5, base_life: 1, imp_life: 2, important_tags: ['Important'] },
  /**
   * ⚠️ 回响机制会**回写 session 文件**（`index.js:2987-2997`）。
   * 生产要 `true`（否则回响永不推进、life 不衰减）；做只读对照测试时设 `false`。
   */
  echoPersist: true,

  /** 注入文本装配。 */
  inject: {
    /** 在 system prompt 里的排序位。DSH Tavern 用 10 和 45，L1 状态卡用 50，我们排其后。 */
    order: 55,
    /**
     * ★ 用户的**真实注入模板**（`rag.injection_settings.template`，逐字照抄）。
     * 里面那段英文硬约束是它防「把历史记忆误当当前事件」的关键，**别删别改**。
     * `{{rag}}` = 检索到的历史；`{{recent_history}}` = 最近 N 条总结。
     */
    chatTemplate:
      '<recalledMemories>[IMPORTANT: The following are retrieved HISTORICAL memories. Use them ONLY to '
      + 'enrich internal monologues, add nostalgia, or reference the past. They are STRICTLY THE PAST. '
      + 'You MUST NOT treat them as current events.]\n{{rag}}\n</recalledMemories>\n'
      + '<immediateHistory>\n{{recent_history}}\n</immediateHistory>',
    /** ★ 用户真值（`rag.knowledge_injection.template`）。 */
    kbTemplate: '<knowledge>\n{{knowledge}}\n</knowledge>',
    /**
     * ★ 填进 `{{recent_history}}` 的「最近 N 条总结」（用户真值 `recent_count: 2`）。
     * 数据源 = 统一记忆目录的 `archive/summaries/`（L2 的「写入者②」），这样
     * 「历史记忆」与「新总结」走同一个入口，逻辑一致。
     * 取不到就渲染成空 —— 模板仍成立，只是那一段为空。
     */
    recentCount: 2,
    /** 单轮注入的字符预算，0 = 不限。 */
    maxChars: 6000,
    /** 注入文本的头（可留空）。默认为空 —— 不加前缀，避免与 L1 状态卡的【】标记混淆。 */
    header: '',
    /**
     * ★★ 是否「只对 RP 会话注入」（**主判据，复用的是 dsh-tavern 自己的判断**）。
     *
     * 默认 `true`：读 `pmp-dsh-tavern/session-selections.json` 里每个会话的
     * `selection.rp.active` —— 与 Tavern 渲染 `rp:policy` 段用的是**同一份状态**
     * （`tavern-loader/src/index.js:455` 的 `rpMode.isActive(context.agent)`）。
     *
     * 这样新周目 / **分支**产生的会话**自动**算数，不需要维护任何 id 名单。
     * 设 `false` 回到「对所有会话注入」的旧行为（**会污染编程会话，别设**）。
     */
    rpOnly: true,
    /**
     * ★ **周目隔离**（T3，2026-09-18）。用户口径：「跨周目不是这么跨的。先做好基础功能，
     * **分周目隔离**，再说跨周目的事情。」
     *
     * 它管的是**读**这一侧：写侧一直在按周目打 `pt:<周目id>` 标签，但检索**从来不看它**
     * ⇒ 实际是一个共享池（真机：62 条里 49 条带当前周目标签、13 条没有，全都会参与召回）。
     * 开了之后：只查本会话绑定的那个集合，且只认带 `pt:<绑定周目>` 的切片；
     * 没有标签的一律当"不是本周目"排除（含 `影子_-0906重开` 那类历史池 —— 跨周目延续是以后的事）。
     * ⛔ 拿不到绑定周目时**本轮不注入**（宁可不出场，也不串味），并打 warn。
     * 设 `false` = 回到"共享池"旧行为。
     */
    isolatePlaythrough: true,
    /** RP 判据文件路径（一般不用改；Tavern 未装时该文件不存在 → 自动回退到 allowSessions）。 */
    rpSelectionsFile: 'C:/Users/w/.dsh/pmp-dsh-tavern/session-selections.json',
    /**
     * 显式会话名单（**兜底/覆盖用**，不是主判据）。
     *
     * 触发条件有两个：
     *   ① 拿不到 RP 判据文件（Tavern 未装）→ 空名单 = 不限制（旧行为），非空 = 只注入名单内
     *   ② 有 RP 判据但本会话不在其中 → 名单里**额外**有的人仍放行（手工豁免用）
     *
     * ⚠️ **不要指望靠它覆盖新周目**：新周目 / 分支会产生新 id，手写必然漏
     *    （2026-09-12 实测：4 个 `rp.active=true` 会话里，手写名单只覆盖 2 个，
     *     另外两个被静默抑制）—— 所以主判据用 Tavern 的 `rp.active`。
     */
    allowSessions: [],
  },

  /**
   * 「最近总结」的落点（L2 写入者②）。留空则不读。
   *
   * ★ 2026-09-16（T4）改成支持 **`'auto'`**：从 `dsh-memory-archive` 的 root（角色 + 周目）
   *   推出 `<workspaceBase>/<characterId>/<playthroughId>/archive/summaries`。
   *   为什么必须这么做：写死的路径**已经错了一次** —— 实测真机配置写着
   *   `playthrough-0f08d055-…`（该周目早被删了，目录都不存在），而 memory-archive 的 root
   *   指向 `playthrough-938a0d26-…`、Tavern 目录里能发现的又是 `playthrough-1e59aed6-…`
   *   —— 三个 id 三个样，写死必然再错。改成跟 root 走，换周目就不用再手改这里。
   */
  summariesDir: 'auto',

  /** `summariesDir:'auto'` 用的 Tavern 工作区根（换机器/换工作区要改）。 */
  workspaceBase: 'D:\\apps\\dsh-tarven',

  /** memory-archive 的配置文件；留空 = `<DSH_HOME>/dsh-memory-archive/config.json`。 */
  memoryArchiveConfig: '',

  /**
   * 「入库」配置 —— 把摘要切片写进向量库 + BM25（2026-09-16 新增，甲方案 T2）。
   *
   * ★ 为什么目标集合要独立：`data.vectorRoot` / `bm25Root` / `sessionRoot` 三个根现在指向
   *   **ST 侧那份数据**（见 `data` 注释），而 `chatCollections[0]` 是 ST 的聊天集合
   *   （`影子_-0906重开`）。写路径**默认不许**碰它 —— 所以这里单开一个集合名；
   *   只有显式把 `collectionId` 传空串时才回退到 `chatCollections[0]`。
   */
  ingest: {
    enabled: true,
    /** 写入目标集合（vectra 目录名与 BM25 文件名都经 `safeCollectionName` 归一）。 */
    collectionId: 'dsh-memory',
    /** `anima_ingest` 不显式给 `dir` 时的默认来源目录；留空 = 用 `summariesDir`。 */
    dir: '',
    /**
     * ★ 自动入库（2026-09-16 追加）：`summariesDir/index.json` 一变，就把**还没入过**的条目
     * 写进记忆库。触发点是装配期（每轮），但**只做一次 statSync**，真变化才干活；
     * 干活**不阻塞本轮**（fire-and-forget）。
     * 选"拉"而不选"让 memory-archive 推"的理由：① 本插件本来就每轮读这个目录；
     * ② 推要插件的服务注册（`ctx.reflect.provide` + 消费者 inject），那条机制**没验过**；
     * ③ 拉是幂等的（引擎按 `index` 覆盖）。
     */
    auto: true,
    /**
     * ★ 入库账本落盘位置（2026-09-17，D12）。留空 = `<DSH_HOME>/dsh-anima-rag/ingest-ledger.json`。
     * 键 = 文件名 + 内容签名（`sourceHash|chars`）⇒ **内容没变就不重入**，重启不再整集重灌。
     */
    ledgerPath: '',
    /** 自动维护：清掉"索引没引用"的孤儿元数据文件（真机实测占 90%）。默认开。 */
    autoClean: true,
    /**
     * 孤儿清理用**移动**（进 `<集合>/_quarantine-<时间戳>/`）而不是直接删 ⇒ 可回退。
     * 设 `false` = **只报告不动手**（想看数字时用）。默认 true。
     */
    quarantine: true,
    /** 自动入库时的 index 前缀 → `<prefix>_<文件名>`（引擎按 index 覆盖，重跑幂等）。 */
    indexPrefix: 'sum',
    /**
     * ★ **孤儿对账**（T2，2026-09-18）。用户口径：「孤儿文件直接删除就好。**在成为孤儿的一瞬间**」。
     *
     * 每次 `index.json` 一变，就拿「当前列出的条目」当白名单，把库里 `sum_` 开头、
     * key 已不在白名单里的切片**当场删掉**（向量 items + per-item 元数据文件 + BM25 文档，
     * 为什么必须有：入库按**文件名**判重、检索按**库里的切片**走，两者之间从来没有对账 ⇒
     * 摘要文件一改名，旧切片既不覆盖也不删除，却**照旧被检索**（真机 62 条里 11 条是这类）。
     * ⛔ 判据与护栏见 `lib/orphan-reconcile.js`（白名单空 / 前缀不认识 ⇒ 一律不动）。删就是**干净删**，不留档。
     * 设 `false` = 只报告不动手。
     */
    reconcileOrphans: true,
    /** 单条切片遇到**超时**时最多试几次（provider 冷启动会命中冷副本；非超时错误不重试）。 */
    retryOnTimeout: 3,
  },

  /**
   * 单轮检索的总超时（毫秒）。超时**放行生成**，绝不阻塞主对话。
   *
   * ⚠️ 必须**明显大于** embedding 自己的超时。实测：Anima 服务端给向量 API 15s 上限
   * （`anima-rag/index.js:358-375`），而一次完整的 A/B 调用实测在 **6.5s ~ 15.2s** 之间波动，
   * 有一次直接以「向量 API 请求超时无响应」500 收场。30s 留够余量；
   * 真超时就那一轮不注入（fail-open），不会卡住对话。
   */
  timeoutMs: 30000,

  /** 引擎/检索的详细日志。 */
  debug: false,
}

const log = (ctx, ...a) => ctx?.logger?.info?.(`[anima-rag]`, ...a)
const warn = (ctx, ...a) => ctx?.logger?.warn?.(`[anima-rag]`, ...a)

function sha1Short(s) {
  return createHash('sha1').update(s).digest('hex').slice(0, 12)
}

function snapshotEvents(agent) {
  const session = agent?.session
  const events = session?.snapshotEvents?.() ?? session?.events
  return Array.isArray(events) ? events : []
}

/** 从事件流里取当前 turn（最后一次 `turn/start` 的 `data.turn`）。 */
function lastTurnOf(events) {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i -= 1) {
    const ev = events[i]
    if (ev?.type !== 'turn/start') continue
    const t = ev?.data?.turn
    if (Number.isSafeInteger(t)) return t
  }
  return 0
}

/**
 * 合并配置。**cordis 的 patch 不做深合并**，所以嵌套对象必须逐层自己合 ——
 * 否则 profile 里只写 `rerank.enabled: false` 会把 `rerank.api` 整个抹掉。
 *
 * ★ 单独导出：A/B 对照工具与单测都走**同一个函数**，
 *   保证「被验证的东西」与「线上真正发出去的东西」不会分叉。
 *
 * @param {{warn?: (msg: string) => void}} [opts]
 *
 * ⛔ **本函数不看环境变量**（2026-09-18 用户拍板：「环境变量肯定不对，我们做的是插件」）。
 *   key 的唯一来源是**记忆库设置 →「向量检索 API」卡**（由 `applyRetrievalConfig` 注入），缺省落 `DEFAULTS`。
 *   以前那对 `ANIMA_RAG_EMBED_KEY` / `ANIMA_RAG_RERANK_KEY` 兜底**已删** —— 它让生产凭据来自环境
 *   （任何进程都能读到、且是静默生效），正是要消除的形态。⛔ 别再加回来；
 *   离线 A/B 工具要 key 就自己从环境读、显式塞进 `payload`（`test/ab-*.mjs` 就是这么干的）。
 */
export function mergeConfig(rawConfig, opts) {
  const raw = rawConfig ?? {}
  const say = opts && typeof opts.warn === 'function' ? opts.warn : null
  const cfg = { ...DEFAULTS, ...raw }
  cfg.data = { ...DEFAULTS.data, ...(raw.data ?? {}) }
  cfg.embed = { ...DEFAULTS.embed, ...(raw.embed ?? {}) }
  cfg.rerank = { ...DEFAULTS.rerank, ...(raw.rerank ?? {}), api: { ...DEFAULTS.rerank.api, ...(raw.rerank?.api ?? {}) } }
  cfg.strategy = { ...DEFAULTS.strategy, ...(raw.strategy ?? {}) }
  cfg.bm25 = { ...DEFAULTS.bm25, ...(raw.bm25 ?? {}) }
  cfg.echo = { ...DEFAULTS.echo, ...(raw.echo ?? {}) }
  cfg.inject = { ...DEFAULTS.inject, ...(raw.inject ?? {}) }
  cfg.ingest = { ...DEFAULTS.ingest, ...(raw.ingest ?? {}) }
  cfg.rag = { ...DEFAULTS.rag, ...(raw.rag ?? {}) }
  cfg.kb = { ...DEFAULTS.kb, ...(raw.kb ?? {}) }
  return cfg
}

/**
 * ★ 2026-09-18：把**记忆库配置**（`<DSH_HOME>/dsh-memory-archive/config.json` 的
 * `retrieval` 段，由面板「向量检索 API」卡管理）套到运行时配置上。
 *
 * 生效顺序**只有两层**：记忆库 `retrieval.*` → 本插件 `DEFAULTS`（mergeConfig 的产物）。
 * ⛔ 不存在第三层：本插件**不从任何其它配置文件**读这四项 —— 面板那张卡就是唯一的管理窗口，
 *    谁填了非空值谁生效；都空 = DEFAULTS（新装机没配过也能跑）。
 * 重排地址不单独存：`retrieval.url` 去尾斜杠 + `/rerank`（⛔ 不写死域名）。
 * `retrieval.key` 非空 ⇒ embed 与 rerank **同一把 key**（面板只收一个密钥框）。
 *
 * 纯函数：`cfg` = mergeConfig 的产物；`mtRetrieval` = 记忆库 config 的 retrieval 对象（可 null）。
 */
export function applyRetrievalConfig(cfg, mtRetrieval) {
  const r = mtRetrieval && typeof mtRetrieval === 'object' && !Array.isArray(mtRetrieval) ? mtRetrieval : null
  if (r === null) return cfg
  const str = (v) => (typeof v === 'string' ? v.trim() : '')
  const url = str(r.url).replace(/\/+$/, '')
  const model = str(r.model)
  const rerankModel = str(r.rerankModel)
  const key = str(r.key)
  if (url === '' && model === '' && rerankModel === '' && key === '') return cfg
  const next = { ...cfg, embed: { ...cfg.embed }, rerank: { ...cfg.rerank, api: { ...cfg.rerank.api } } }
  if (url !== '') {
    next.embed.url = url
    next.rerank.api.url = url + '/rerank'
  }
  if (model !== '') next.embed.model = model
  if (rerankModel !== '') next.rerank.api.model = rerankModel
  if (key !== '') {
    next.embed.key = key
    next.rerank.api.key = key
  }
  return next
}

/**
 * 组装给引擎的 payload（字段与原插件 `POST /query` 一致）。
 *
 * ⚠️ 字段落点**不是猜的**，是查了服务端的读取路径：
 *   · `min_score` / `recent_weight` 由 **`strategy` 对象**读取
 *     （`anima-rag/index.js:679-680` 与 `:2402-2404` 的 `strat?.min_score`），**不是** payload 顶层
 *   · kb 自己那份走 `kbContext.strategy`（`:2459-2461`）
 *   · `candidate_multiplier` / `base_count` 在服务端 **0 命中**（是前端字段）→
 *     把 `candidate_multiplier` 映射到策略的 `global_multiplier`（服务端 `:905-923` 消费它）
 *
 * ★ 单独导出：A/B 对照工具用**这里产出的 payload** 去问 ST 侧原版 Anima，
 *   所以「对照通过」证明的是**线上这条路**，不是一份手抄副本。
 */
export function composePayload(cfg, { searchText, bm25SearchText, sessionKey, isolation = null }) {
  // ★ 周目隔离（T3，2026-09-18；用户口径「先分周目隔离」）：隔离模式下**只查本会话绑定的那个集合**，
  //   并把「不属于本绑定周目」的切片（没有 `pt:<周目>` 标签的那些）加进 `ignore_ids`。
  //   ⛔ 为什么走 `ignore_ids` 而不是给引擎加 filter：`ignore_ids` 是**已经打通、已经在用**的一条路
  //   （payload → query → normalizeIgnoreIds → buildLegacyScopedIgnoreFilter → `{index:{$nin:[...]}}`），
  //   零引擎改动 ⇒ 零回归面。等价性：`{index:{$in:允许集}}` ≡ `{index:{$nin:其余全部}}`。
  const iso = isolation && isolation.enabled === true ? isolation : null
  const chatIds = iso && iso.collectionId ? [iso.collectionId] : cfg.chatCollections
  const primaryChat = chatIds?.[0]
  const chatStrategy = {
    enabled: cfg.strategy?.distributed_retrieval !== false,
    recent_weight: cfg.rag.recent_weight ?? 0,
    // ⚠️ 这个值同时是「ignore 过滤只对哪个集合生效」的判据（engine:1298 → ignoreCollectionId）
    //    ⇒ 隔离时必须指向**我们唯一在查的那个集合**，否则 deny 名单一条都不生效（静默失效）。
    current_session_id: primaryChat ?? sessionKey,
    global_multiplier: cfg.rag.candidate_multiplier ?? 2,
    min_score: cfg.rag.min_score ?? 0.2,
    steps: buildChatSteps(cfg),
  }
  const kbStrategy = {
    enabled: cfg.kb.enabled === true && cfg.kbCollections.length > 0,
    min_score: cfg.kb.min_score,
    search_top_k: cfg.kb.search_top_k,
  }
  return {
    searchText,
    bm25SearchText,
    apiConfig: { key: cfg.embed.key, url: cfg.embed.url, model: cfg.embed.model, timeout_ms: cfg.embed.timeout_ms },
    chatContext: { ids: chatIds, strategy: chatStrategy },
    kbContext: { ids: cfg.kbCollections, strategy: kbStrategy },
    strategy: chatStrategy,
    ignore_ids: iso && Array.isArray(iso.denyIndexes) ? iso.denyIndexes : [],
    sessionId: sessionKey,
    is_swipe: false,
    echoConfig: cfg.echo,
    rerankConfig: cfg.rerank,
    bm25Configs: {
      chat: chatIds.map(collectionId => ({ collectionId, dictionary: cfg.bm25.dictionary })),
      kb: [],
      chat_top_k: cfg.bm25.search_top_k,
    },
  }
}

/**
 * 把「配置形状」的 `strategy_settings` 转成服务端要的**运行时形状** `steps`。
 *
 * ★ 这段映射照抄 ST 侧前端 `rag_logic.js:688-718` 的 `chatStrategyPayload`，**不是猜的**。
 *
 * ⚠️ **踩过的坑（A/B 对照抓出来的）**：服务端读的是 `config.steps`
 * （`anima-rag/index.js:677` `const steps = config.steps || []`、
 *  `:2400` `strat?.steps?.find(s => s.type === 'base')?.count`）。
 * 如果直接把配置形状的 `strategy_settings` 当 strategy 传过去，steps 就是空数组 →
 * **所有分支返回 0 条，而且完全不报错**（HTTP 200、`_debug_logs` 只有 1 条）。
 *
 * ⚠️ 已知偏差（有意为之，phase 2 再补）：
 *   ST 的 `status` / `period` / `special` 三步的 labels 与 count 是**每轮动态算**的
 *   （`status` 走正则 + 规则评估状态数据 `animaData`；`period`/`special` 走模拟时间与节日判定，
 *    不活跃时 count=0）。DSH 这里没有那套 `Ellina.*` 聊天变量（已被 L1 state-bridge 取代），所以：
 *   · `status` 用配置里的静态 labels，并受 `rag.statusEnabled` 开关控制
 *   · `period` / `special` 一律 **count=0**（= ST 在不活跃时的行为，保守且可预期）
 *   待办：把 `status` 判定接到 L1 状态上即可恢复动态行为。
 */
export function buildChatSteps(cfg) {
  const ss = cfg.strategy?.strategy_settings ?? {}
  const steps = [
    { type: 'base', count: Number(cfg.rag?.base_count) > 0 ? Number(cfg.rag.base_count) : 2 },
    {
      type: 'important',
      count: Number(ss.important?.count ?? 1),
      labels: Array.isArray(ss.important?.labels) && ss.important.labels.length ? ss.important.labels : ['Important'],
    },
    {
      type: 'status',
      count: cfg.rag?.statusEnabled === true ? Number(ss.status?.count ?? 1) : 0,
      labels: Array.isArray(ss.status?.labels) ? ss.status.labels : [],
    },
    { type: 'period', count: 0, labels: [] },
    { type: 'special', count: 0, labels: [] },
    { type: 'diversity', count: Number(ss.diversity?.count ?? 2) },
  ]
  // count<=0 的步骤不发（服务端对 count=0 也会跳过，少发更干净）
  return steps.filter(s => s.count > 0)
}

export function apply(ctx, rawConfig) {
  const rawPlugin = rawConfig ?? ctx?.config

  /**
   * ★ 2026-09-18：读**记忆库配置**里的 `retrieval` 段（面板「向量检索 API」卡写的四项）。
   * 真相源与 `resolveSummariesDir` 同一个：`<DSH_HOME>/dsh-memory-archive/config.json`，
   * 读法也复用同一套（按 config.json 的 mtime 缓存 10s，免得每次装配都碰盘）。
   * 读不到 / 形状不对 ⇒ null（调用方按「没有覆盖」处理，回落 DEFAULTS，绝不猜）。
   */
  let autoRetrieval = { key: '', val: null, at: 0 }
  function memoryArchiveRetrieval() {
    const over = rawPlugin && typeof rawPlugin.memoryArchiveConfig === 'string' ? rawPlugin.memoryArchiveConfig : ''
    const p = over.trim() !== '' ? over.trim() : join(process.env.DSH_HOME || homedir(), '.dsh', 'dsh-memory-archive', 'config.json')
    let key = `${p}|?`
    try { key = `${p}|${statSync(p).mtimeMs}` } catch { key = `${p}|missing` }
    if (autoRetrieval.key === key && Date.now() - autoRetrieval.at < 10000) return autoRetrieval.val
    let val = null
    try {
      const r = JSON.parse(readFileSync(p, 'utf8'))?.retrieval
      if (r && typeof r === 'object' && !Array.isArray(r)) {
        val = {
          url: typeof r.url === 'string' ? r.url : '',
          model: typeof r.model === 'string' ? r.model : '',
          rerankModel: typeof r.rerankModel === 'string' ? r.rerankModel : '',
          key: typeof r.key === 'string' ? r.key : '',
        }
      }
    } catch { val = null }
    autoRetrieval = { key, val, at: Date.now() }
    return val
  }
  const mtRetrieval = memoryArchiveRetrieval()
  // 生效顺序只有两层：记忆库 retrieval.* → DEFAULTS。⛔ 不看环境变量（2026-09-18 起）。
  const cfg = applyRetrievalConfig(
    mergeConfig(rawPlugin, { warn: (m) => warn(ctx, m) }),
    mtRetrieval,
  )

  /** key → { text, stats, at } 检索结果缓存（按轮） */
  const cache = new Map()
  /** `session::turn` → 本轮已经等过一次且超时（后续 step 不再等）。 */
  const timedOutTurns = new Set()  /** key → Promise 在途检索（同一轮多个 step 并发时去重） */
  const inflight = new Map()
  /** sessionId → 最近一次注入文本（section provider 必须同步返回，只能读这个） */
  const lastBySession = new Map()
  /** 统计 */
  const stats = { assembles: 0, cacheHits: 0, retrievals: 0, timeouts: 0, errors: 0, lastError: null, lastQuery: null, lastMs: null, inserts: 0, insertErrors: 0, lastInsert: null, autoIngestRuns: 0, insertRetries: 0, orphansQuarantined: 0, lastMaintain: null }

  let enginePromise = null
  let engineError = null

  /**
   * ★★ 会话判别 —— 复用 **dsh-tavern 自己的 RP 判据**（不再自记会话 id 名单）。
   *
   * 判据来源：`C:\Users\w\.dsh\pmp-dsh-tavern\session-selections.json`
   *   `{ sessions: { "<sessionId>": { selection: { …, rp: { active: true|false } } } } }`
   * 这就是 Tavern 自己用的那一份 —— 对照它的实现：
   *   `dsh-tavern/packages/tavern-loader/src/index.js:455`
   *     `text: () => rpMode.isActive(context.agent) ? rpMode.section : ''`
   *   `rp-mode.js:173` `isActive(agent)` → `rp-mode.js:158` `normalizeRpState(this.selections.get(sessionId).rp)`
   *
   * ★ 为什么不自己维护 id 名单（2026-09-12 的教训）：
   *   新周目 / **分支**都会产生**新的会话 id**。自记名单必然漏
   *   —— 实测当时有 4 个 `rp.active=true` 的会话（含两个分支出来的），
   *   而手写名单只覆盖了 2 个 ⇒ **另外两个被静默抑制了**。
   *
   * 读取策略：**按 mtime 缓存**（文件没变就不重新解析），开销可忽略。
   * 任何异常一律 fail-open 到"不算 RP"（宁可不注入，也不污染别处）。
   */
  const SELECTIONS_FILE = cfg.inject?.rpSelectionsFile
    ?? 'C:/Users/w/.dsh/pmp-dsh-tavern/session-selections.json'
  let selCacheMtime = -1
  let selCacheActive = new Set()

  function rpActiveSessions() {
    try {
      const st = statSync(SELECTIONS_FILE)
      const mt = st.mtimeMs
      if (mt === selCacheMtime) return selCacheActive
      const doc = JSON.parse(readFileSync(SELECTIONS_FILE, 'utf8'))
      const next = new Set()
      for (const [id, entry] of Object.entries(doc?.sessions ?? {})) {
        if (entry?.selection?.rp?.active === true) next.add(id)
      }
      selCacheMtime = mt
      selCacheActive = next
      return next
    } catch {
      // 文件暂时不可读（正被写入等）→ 保留上一次结果，避免抖动
      return selCacheActive
    }
  }

  /**
   * 该会话是否允许注入。
   * 顺序：① Tavern 的 rp.active 判据（主）② `inject.allowSessions` 显式名单（兜底/覆盖）
   * `inject.rpOnly: false` 可彻底关掉会话判别（回到"对所有会话注入"的旧行为，慎用）。
   */
  function sessionAllowed(sessionId) {
    const rpOnly = cfg.inject?.rpOnly !== false
    if (rpOnly && rpActiveSessions().has(sessionId)) return true
    if (rpOnly && rpActiveSessions().size > 0) {
      // 有 RP 判据、但本会话不在其中 ⇒ 不是 RP 会话
      const list = cfg.inject?.allowSessions
      if (Array.isArray(list) && list.includes(sessionId)) return true
      return false
    }
    // 拿不到任何 RP 判据（Tavern 未装/文件缺失）⇒ 回退旧行为 + 显式名单
    const list = cfg.inject?.allowSessions
    if (!Array.isArray(list) || list.length === 0) return true
    return list.includes(sessionId)
  }

  /** 被判为「不在名单内」而跳过的次数（可观测，便于确认开关是否生效）。 */
  let skippedSessions = 0

  function enginePath() {
    if (cfg.engineModule) return cfg.engineModule
    return new URL('./engine.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  }

  /** 懒加载引擎。失败不抛到调用方 —— 只需 warn，检索静默降级为空。 */
  function loadEngine() {
    if (enginePromise) return enginePromise
    const p = enginePath()
    enginePromise = import(pathToFileURL(p).href)
      .then((m) => {
        if (typeof m.createEngine !== 'function') throw new Error(`engine 未导出 createEngine: ${p}`)
        return m.createEngine({
          vectorRoot: cfg.data.vectorRoot,
          sessionRoot: cfg.data.sessionRoot,
          bm25Root: cfg.data.bm25Root,
          echoPersist: cfg.echoPersist,
          logger: cfg.debug ? ctx?.logger : undefined,
        })
      })
      .catch((e) => {
        engineError = e?.message ?? String(e)
        enginePromise = null
        throw e
      })
    return enginePromise
  }

  /**
   * 读「最近 N 条总结」填 `{{recent_history}}`。
   * 数据源 = 统一记忆目录的 `summaries/index.json`（L2「写入者②」的落点）——
   * 这样「历史记忆」与「新总结」走**同一个入口**，逻辑一致。
   * 读不到就返回空串：模板仍成立，只是那一段为空。
   */
  /**
   * 解析「最近总结」目录。`'auto'` = 跟 `dsh-memory-archive` 的 root 走（见 DEFAULTS 注释）。
   * 读配置很便宜，但仍按 (路径 + mtime) 缓存 10s —— 免得每次装配都碰盘。
   */
  let autoSummaries = { key: '', dir: '', at: 0 }
  /** T3：绑定周目的解析缓存（与 autoSummaries 同款 10s TTL，按 config.json 的 mtime 失效）。 */
  let autoBound = { key: '', play: '', at: 0 }
  function memoryArchiveConfigPath() {
    const p = String(cfg.memoryArchiveConfig || '').trim()
    if (p !== '') return p
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    return join(home, 'dsh-memory-archive', 'config.json')
  }
  function resolveSummariesDir() {
    const raw = String(cfg.summariesDir || '').trim()
    if (raw !== 'auto') return raw
    const base = String(cfg.workspaceBase || '').trim()
    if (base === '') { return '' }
    const cfgPath = memoryArchiveConfigPath()
    let key = `${cfgPath}|?`
    try { key = `${cfgPath}|${statSync(cfgPath).mtimeMs}` } catch { key = `${cfgPath}|missing` }
    if (autoSummaries.key === key && Date.now() - autoSummaries.at < 10000) return autoSummaries.dir
    let dir = ''
    try {
      const j = JSON.parse(readFileSync(cfgPath, 'utf8'))
      const char = String(j?.root?.characterId ?? '').trim()
      const play = String(j?.root?.playthroughId ?? '').trim()
      if (char !== '' && play !== '') dir = join(base, char, play, 'archive', 'summaries')
    } catch { dir = '' }
    autoSummaries = { key, dir, at: Date.now() }
    return dir
  }

  /**
   * ★ 当前**绑定周目**（T3 隔离闸过闸值）。
   * 真相源与 `resolveSummariesDir` 同一个：`<DSH_HOME>/dsh-memory-archive/config.json` 的
   * `root.playthroughId` —— 也就是用户说的「绑定周目」（归档/收纳都按它走）。
   * 读不到 ⇒ `''`（调用方据此 **fail-closed**，见 isolationPlan）。
   */
  function boundPlaythroughId() {
    const cfgPath = memoryArchiveConfigPath()
    let key = `${cfgPath}|?`
    try { key = `${cfgPath}|${statSync(cfgPath).mtimeMs}` } catch { key = `${cfgPath}|missing` }
    if (autoBound.key === key && Date.now() - autoBound.at < 10000) return autoBound.play
    let play = ''
    try { play = String(JSON.parse(readFileSync(cfgPath, 'utf8'))?.root?.playthroughId ?? '').trim() } catch { play = '' }
    autoBound = { key, play, at: Date.now() }
    return play
  }

  /**
   * ★ 周目隔离计划（T3）。用户口径（2026-09-18）：「跨周目不是这么跨的。先做好基础功能，
   * **分周目隔离**，再说跨周目的事情。」
   *
   * 返回形状：`{ enabled, collectionId, bound, denyIndexes[], total }`，或
   * `{ enabled: true, blocked: '<原因>' }` —— 后者表示**本轮不许注入**。
   *
   * ⛔ 三条 fail-closed（隔离的语义就是"宁可不给，也不串味"）：
   *   ① 解析不到绑定周目 ⇒ blocked（不是"那就不过滤"——那正是串味）
   *   ② 向量索引读得到但**解析不了** ⇒ blocked（读不到文件 = 还没建库 ⇒ deny 空集，是另一回事）
   *   ③ 没有 `pt:<绑定周目>` 标签的切片**一律进 deny**（含 `影子_-0906重开` 那类历史池：
   *      它在隔离模式下整个不查 —— 跨周目延续是以后的事）
   *
   * ★ 为什么是"算 deny 名单"而不是"给引擎加 allow 过滤"：见 `composePayload` 顶部注释。
   */
  function isolationPlan() {
    if (cfg.inject?.isolatePlaythrough === false) return { enabled: false }
    const collectionId = String(cfg.ingest?.collectionId || cfg.chatCollections?.[0] || '').trim()
    if (collectionId === '') return { enabled: false, reason: 'no-collection' }
    const bound = boundPlaythroughId()
    const indexFile = join(cfg.data.vectorRoot, safeCollectionName(collectionId), 'index.json')
    let items = null
    let readable = true
    if (existsSync(indexFile)) {
      try { items = JSON.parse(readFileSync(indexFile, 'utf8'))?.items } catch { readable = false }
    }
    const blocked = isolationBlockReason({ enabled: true, bound, indexReadable: readable })
    if (blocked !== null) return { enabled: true, collectionId, bound, blocked }
    const list = Array.isArray(items) ? items : []
    return { enabled: true, collectionId, bound, denyIndexes: denyIndexesForPlaythrough(list, bound), total: list.length }
  }

  function readRecentSummaries() {
    const dir = resolveSummariesDir()
    const n = Math.max(0, cfg.inject.recentCount ?? 0)
    if (!dir || n === 0) return ''
    try {
      const idxPath = join(dir, 'index.json')
      if (!existsSync(idxPath)) return ''
      const idx = JSON.parse(readFileSync(idxPath, 'utf8'))
      // ⛔ `import-*` 是**导入批次清单**（来源格式/哈希/体积/楼层数），不是内容摘要 ⇒
      //    不许进 `<immediateHistory>`。今天它排在 index 最前面所以碰巧没进，但只要**再导入一次**
      //    它的条目就会被追加到最后、直接顶进提示词（用户 2026-09-16 就是问到这一点）。
      //    同理跳过空文件（覆盖清理留下的空壳）。
      const entries = (Array.isArray(idx?.entries) ? idx.entries : [])
        .filter((e) => typeof e?.file === 'string' && e.file !== '' && !String(e?.id ?? '').startsWith('import-'))
        .slice(-n)
      const parts = []
      for (const e of entries) {
        const f = join(dir, e.file)
        if (!existsSync(f)) continue
        const text = readFileSync(f, 'utf8').trim()
        if (text !== '') parts.push(text)
      }
      return parts.join('\n\n')
    } catch (e) {
      warn(ctx, '读 summaries 失败（忽略该段）:', e?.message ?? String(e))
      return ''
    }
  }

  /**
   * 薄委托：payload 的唯一真相源是模块级 `composePayload(cfg, args)`，
   * 这样 A/B 对照工具、单测、线上三条路走的是同一份装配逻辑。
   */
  const buildPayload = (args) => composePayload(cfg, args)

  /** 一次完整检索：取词 → 引擎 → 装配文本。**绝不抛**，失败返回空文本。 */
  async function retrieve({ searchText, bm25SearchText, sessionKey }) {
    const t0 = Date.now()
    try {
      if (!String(searchText ?? '').trim() && !String(bm25SearchText ?? '').trim()) {
        return { text: '', stats: { reason: 'no-query' } }
      }
      const engine = await loadEngine()
      stats.retrievals += 1
      // ★ T3 周目隔离闸：拿不到过闸值就**本轮不注入**（宁可不出场，也不串味）
      const iso = isolationPlan()
      if (iso.blocked) {
        stats.lastIsolation = { blocked: iso.blocked, ...iso }
        warn(ctx, `周目隔离：${iso.blocked} ⇒ 本轮**不注入**记忆（拿不到绑定周目时宁可不出场，也不串味）`)
        return { text: '', stats: { reason: iso.blocked } }
      }
      if (iso.enabled) {
        const denied = (iso.denyIndexes || []).length
        stats.lastIsolation = { bound: iso.bound, collectionId: iso.collectionId, denied, total: iso.total ?? 0 }
        log(ctx, '周目隔离：' + isolationSummary({ collectionId: iso.collectionId, bound: iso.bound, denyCount: denied, total: iso.total ?? 0 }))
        if (iso.total > 0 && denied >= iso.total) {
          warn(ctx, `周目隔离：这个周目（${iso.bound}）在 ${iso.collectionId} 里**一条切片都没有** ⇒ 本轮检索必然为空。`
            + '若这是刚绑的新周目 ⇒ 正常（还没东西可回忆）；若不该如此 ⇒ 查 config.root.playthroughId 与切片上的 pt: 标签是否同一个周目。')
        }
      }
      const payload = buildPayload({ searchText, bm25SearchText, sessionKey, isolation: iso })
      const res = await engine.query(payload)
      const { text, stats: s } = assembleInjection({
        chatResults: res?.merged_chat_results,
        kbResults: res?.merged_kb_results,
        recentText: readRecentSummaries(),
        cfg: cfg.inject,
      })
      const out = {
        text,
        stats: {
          ...s,
          debugLogs: Array.isArray(res?._debug_logs) ? res._debug_logs.length : 0,
          chatRaw: Array.isArray(res?.merged_chat_results) ? res.merged_chat_results.length : 0,
          kbRaw: Array.isArray(res?.merged_kb_results) ? res.merged_kb_results.length : 0,
          ms: Date.now() - t0,
        },
      }
      stats.lastMs = out.stats.ms
      return out
    } catch (e) {
      stats.errors += 1
      stats.lastError = e?.message ?? String(e)
      warn(ctx, '检索失败（本轮不注入）:', stats.lastError)
      return { text: '', stats: { reason: 'error', error: stats.lastError } }
    }
  }

  // ─────────────────────────── 写入口：摘要 → 向量 + BM25（2026-09-16，甲方案 T2）

  /** 单次最多写多少条（防止一次误喂几千条把 embedding 额度打光）。 */
  const MAX_INGEST_SLICES = 200

  /** 与引擎完全一致的集合名归一：`engine.js:2244`（vectra 目录）与 `bm25.js:332`（索引文件）同一套正则。 */
  function safeCollectionName(id) {
    return String(id).replace(/[^a-zA-Z0-9@\-\._\u4e00-\u9fa5]/g, '_')
  }

  /** 读 JSON，失败返回 null —— 回读核对只用于**报告**，自己吞错，绝不影响写入结论。 */
  function readJsonSafe(p) {
    try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
  }

  // ── 周目标识（2026-09-16）：删周目之后要能按周目清理记忆库里的切片 ──────────────
  /**
   * 保留 tag 前缀：`pt:<playthroughId>`。
   * ★ 为什么放 tags：vectra 里只有 `metadata_config.indexed`（`tags/index/batch_id`）进索引；
   *   `batch_id` 是整数塞不下字符串，`index` 必须与归档文件名对齐（去重覆盖靠它）⇒ 只有 tags 能放。
   */
  const PT_PREFIX = 'pt:'
  const ptTag = (id) => PT_PREFIX + String(id)

  /** 从 `<workspaceBase>/<char>/<play>/archive/summaries` 反推角色/周目；形状不对返回 null。 */
  function scopeOfDir(dir) {
    const base = String(cfg.workspaceBase || '').replace(/[\\/]+$/, '')
    if (base === '' || !dir) return null
    const norm = String(dir).replace(/\\/g, '/')
    const b = base.replace(/\\/g, '/')
    if (!norm.startsWith(b + '/')) return null
    const parts = norm.slice(b.length + 1).split('/')
    if (parts.length !== 4) return null
    const [characterId, playthroughId, arch, sum] = parts
    if (arch !== 'archive' || sum !== 'summaries') return null
    if (characterId === '' || playthroughId === '') return null
    return { characterId, playthroughId }
  }

  /** 工作区里**现存**的周目（有 `archive/summaries/index.json` 的才算有记忆）。 */
  function listArchiveScopes() {
    const base = String(cfg.workspaceBase || '').replace(/[\\/]+$/, '')
    const out = []
    if (base === '' || !existsSync(base)) return out
    let chars = []
    try { chars = readdirSync(base, { withFileTypes: true }) } catch { return out }
    for (const c of chars) {
      if (!c.isDirectory() || c.name.startsWith('.')) continue
      let plays = []
      try { plays = readdirSync(join(base, c.name), { withFileTypes: true }) } catch { continue }
      for (const p of plays) {
        if (!p.isDirectory()) continue
        const dir = join(base, c.name, p.name, 'archive', 'summaries')
        if (existsSync(join(dir, 'index.json'))) out.push({ characterId: c.name, playthroughId: p.name, dir })
      }
    }
    return out
  }

  /** 集合的两份文件（向量目录 + BM25 文件）—— 清理与备份都按这两个走。 */
  function collectionFiles(collectionId) {
    const safe = safeCollectionName(collectionId)
    return {
      vectorDir: join(cfg.data.vectorRoot, safe),
      vectorIndex: join(cfg.data.vectorRoot, safe, 'index.json'),
      bm25File: join(cfg.data.bm25Root, `${safe}.json`),
    }
  }

  /** 备份两份集合文件（清理前必备份）。返回备份目录。 */
  function backupCollection(collectionId) {
    const f = collectionFiles(collectionId)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = join(String(cfg.ingest?.backupDir || '').trim() || join(String(cfg.workspaceBase || ''), '.anima-backups'), `forget-${safeCollectionName(collectionId)}-${stamp}`)
    mkdirSync(dir, { recursive: true })
    const copied = []
    try {
      if (existsSync(f.vectorDir)) {
        mkdirSync(join(dir, 'vectors'), { recursive: true })
        for (const name of readdirSync(f.vectorDir)) copyFileSync(join(f.vectorDir, name), join(dir, 'vectors', name))
        copied.push('vectors/')
      }
    } catch (e) { warn(ctx, '备份向量目录失败：', e?.message ?? String(e)) }
    try {
      if (existsSync(f.bm25File)) { copyFileSync(f.bm25File, join(dir, 'bm25.json')); copied.push('bm25.json') }
    } catch (e) { warn(ctx, '备份 BM25 失败：', e?.message ?? String(e)) }
    return { dir, copied }
  }

  /** 清掉一个集合的两份文件（⛔ 只动这一个集合，别的不碰）。 */
  function wipeCollection(collectionId) {
    const f = collectionFiles(collectionId)
    const removed = []
    try {
      if (existsSync(f.vectorIndex)) { rmSync(f.vectorIndex, { force: true }); removed.push('index.json') }
      if (existsSync(f.vectorDir)) {
        for (const name of readdirSync(f.vectorDir)) { rmSync(join(f.vectorDir, name), { force: true, recursive: true }) }
        removed.push('vectors/')
      }
    } catch (e) { warn(ctx, '清向量目录失败：', e?.message ?? String(e)) }
    try {
      if (existsSync(f.bm25File)) { rmSync(f.bm25File, { force: true }); removed.push('bm25.json') }
    } catch (e) { warn(ctx, '清 BM25 失败：', e?.message ?? String(e)) }
    return removed
  }

  /**
   * 写入后**回读核对**：向量库与 BM25 两条索引里各能查到这个 `index` 几条。
   *
   * ⛔ 为什么必须回读：引擎对 BM25 写入失败**只打日志、不报错**
   *    （`engine.js:2332-2335` 原注释："BM25 写入失败不应该阻塞响应"）⇒
   *    只看 `insert()` 的返回值会把"向量写进去了、BM25 没写"误判成成功。
   */
  function verifySlicesOnDisk(collectionId, slices) {
    const want = new Set(slices.map((s) => String(s.index)))
    const safe = safeCollectionName(collectionId)
    const out = {
      vector: { found: 0, total: want.size, error: null },
      bm25: { found: 0, total: want.size, error: null },
    }
    try {
      const idx = readJsonSafe(join(cfg.data.vectorRoot, safe, 'index.json'))
      if (!Array.isArray(idx?.items)) throw new Error('index.json 读不到或 items 不是数组')
      const got = new Set(idx.items.map((it) => String(it?.metadata?.index)))
      for (const k of want) if (got.has(k)) out.vector.found += 1
    } catch (e) { out.vector.error = e?.message ?? String(e) }
    try {
      const bm = readJsonSafe(join(cfg.data.bm25Root, `${safe}.json`))
      const fields = bm?.storedFields && typeof bm.storedFields === 'object' ? Object.values(bm.storedFields) : null
      if (!fields) throw new Error('bm25 索引读不到或 storedFields 不是对象')
      const got = new Set(fields.map((f) => String(f?.index)))
      for (const k of want) if (got.has(k)) out.bm25.found += 1
    } catch (e) { out.bm25.error = e?.message ?? String(e) }
    return out
  }

  /**
   * 把目录读成切片（每个文件 = 一条）。
   * ★ 优先按同目录的 `index.json` 读：这样能带上**每条自己的 tags**（检索里的 `Important`
   *   分路就靠它），也能跳过 `import-*` 批次清单（那是导入元信息，不是内容摘要）。
   *   `index.json` 不存在/不可用时回落到"列目录"（`.txt/.md/.json` 每个一条）。
   */
  function slicesFromDir(dir, { prefix, tags, batchId }) {
    const slices = []
    const skipped = []
    // ① 先试 index.json
    try {
      const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
      const entries = Array.isArray(idx?.entries) ? idx.entries : null
      if (entries) {
        for (const e of entries) {
          if (!e || typeof e.file !== 'string' || e.file === '') continue
          if (String(e.id ?? '').startsWith('import-')) { skipped.push({ source: e.file, reason: 'import-* 是导入批次清单，不是内容摘要' }); continue }
          let text = ''
          try { text = readFileSync(join(dir, e.file), 'utf8').trim() } catch { skipped.push({ source: e.file, reason: '读不到' }); continue }
          if (text === '') { skipped.push({ source: e.file, reason: '空文本（可能是被覆盖清理过的旧切片）' }); continue }
          slices.push({
            text, tags: Array.isArray(e.tags) && e.tags.length > 0 ? e.tags : tags,
            index: `${prefix}_${e.file.replace(/\.md$/i, '')}`, batch_id: batchId, source: e.file,
          })
        }
        return { slices, skipped, error: null }
      }
    } catch { /* 没有 index.json 或坏了 ⇒ 回落到列目录 */ }
    // ② 列目录
    let names = []
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && /\.(txt|md|json)$/i.test(d.name))
        .map((d) => d.name)
        .sort()
    } catch (e) {
      return { slices, skipped, error: `目录读不到：${dir}（${e?.message ?? String(e)}）` }
    }
    for (const name of names) {
      if (/^index\.json$/i.test(name)) continue
      let text = ''
      try {
        const raw = readFileSync(join(dir, name), 'utf8')
        if (/\.json$/i.test(name)) {
          let obj = null
          try { obj = JSON.parse(raw) } catch { obj = null }
          text = typeof obj?.text === 'string' ? obj.text
            : typeof obj?.content === 'string' ? obj.content
              : typeof obj?.summary === 'string' ? obj.summary : ''
        } else {
          text = raw
        }
      } catch (e) {
        skipped.push({ source: name, reason: `读失败：${e?.message ?? String(e)}` })
        continue
      }
      if (text.trim() === '') { skipped.push({ source: name, reason: '空文本' }); continue }
      slices.push({ text: text.trim(), tags, index: `${prefix}_${name}`, batch_id: batchId, source: name })
    }
    return { slices, skipped, error: null }
  }

  /**
   * 把切片写进记忆库（向量 + BM25），写完**回读核对两条索引**。
   * **绝不抛** —— 失败以返回值 + `stats` 计数 + 日志播报（⛔ 不许静默）。
   *
   * @param {Array<{text:string,tags?:string[],index:string|number,batch_id?:number,timestamp?:number,source?:string}>} slices
   * @param {{collectionId?:string}} [opts] 不给 `collectionId` 时用 `cfg.ingest.collectionId`
   */
  async function insertSlices(slices, opts = {}) {
    const target = String(opts.collectionId || cfg.ingest?.collectionId || cfg.chatCollections?.[0] || '').trim()
    const out = {
      ok: false, collectionId: target, requested: Array.isArray(slices) ? slices.length : 0,
      inserted: 0, failed: 0, skipped: [], reason: null, verify: null, results: [],
    }
    try {
      if (cfg.ingest?.enabled === false) { out.reason = 'ingest-disabled：配置里把写入口关了（ingest.enabled=false）'; return out }
      if (target === '') { out.reason = 'no-collection：没给 collectionId，配置里 ingest.collectionId 也是空'; return out }
      const list = (Array.isArray(slices) ? slices : [])
        .filter((s) => s && typeof s.text === 'string' && s.text.trim() !== '')
        .slice(0, MAX_INGEST_SLICES)
      if (list.length === 0) { out.reason = 'empty：没有可写文本（texts 为空且目录里没读到东西？）'; return out }
      if (!cfg.embed.key) { out.reason = 'no-embed-key：embedding 渠道没 key（cfg.embed.key 为空）'; return out }

      const engine = await loadEngine()
      const apiConfig = { key: cfg.embed.key, url: cfg.embed.url, model: cfg.embed.model, timeout_ms: cfg.embed.timeout_ms }
      const bm25Config = { enabled: true, dictionary: Array.isArray(cfg.bm25?.dictionary) ? cfg.bm25.dictionary : [] }
      // ★ 周目标识：`pt:<play>`（来源目录能反推出周目时加上；`anima_forget` 靠它按周目清理）
      const scope = opts.scope ?? null
      const scopeTags = scope?.playthroughId ? [ptTag(scope.playthroughId)] : []
      // 串行写：引擎内部按 collectionId 排队，但串行能保证 `results` 顺序可读、失败定位准
      // ★ 超时**重试**（2026-09-16 真机实测）：provider 冷启动首次调用 18–50s，而
      //   引擎/我们给的超时可能被 abort ⇒ 同一个切片重试是**安全**的（引擎按 `index` 覆盖），
      //   而且重试往往正好命中已经热起来的副本。只对「超时」重试，别的错误不重试。
      const isTimeoutErr = (r) => /超时|timeout|aborted|abort/i.test(String(r?.message ?? ''))
      for (const s of list) {
        const payload = {
          collectionId: target,
          text: s.text,
          tags: [...new Set([...(Array.isArray(s.tags) ? s.tags : []), ...scopeTags])],
          timestamp: Number(s.timestamp) > 0 ? Number(s.timestamp) : Date.now(),
          apiConfig,
          index: s.index,
          batch_id: Number.isFinite(Number(s.batch_id)) ? Number(s.batch_id) : -1,
          bm25Config,
        }
        let res = null
        let attempts = 0
        const maxAttempts = Math.max(1, Number(cfg.ingest?.retryOnTimeout) || 3)
        while (attempts < maxAttempts) {
          attempts += 1
          try {
            res = await engine.insert(payload)
          } catch (e) {
            res = { success: false, status: 0, message: e?.message ?? String(e) }
          }
          if (res?.success === true) break
          if (!isTimeoutErr(res) || attempts >= maxAttempts) break
          stats.insertRetries += 1
          warn(ctx, `入库超时，重试第 ${attempts} 次（共 ${maxAttempts} 次）：index=${s.index}`)
          await new Promise((r) => setTimeout(r, 500 * attempts))
        }
        const ok = res?.success === true
        if (ok) out.inserted += 1
        else out.failed += 1
        out.results.push({
          index: String(s.index), ok, attempts,
          vectorId: typeof res?.vectorId === 'string' ? res.vectorId : null,
          status: Number.isFinite(Number(res?.status)) ? Number(res.status) : null,
          message: typeof res?.message === 'string' ? res.message : null,
        })
      }

      out.verify = verifySlicesOnDisk(target, list)
      const v = out.verify.vector
      const b = out.verify.bm25
      out.ok = out.failed === 0 && v.found === v.total && b.found === b.total
      if (!out.ok) {
        warn(ctx, `入库核对不一致：inserted=${out.inserted} failed=${out.failed} `
          + `vector=${v.found}/${v.total}${v.error ? `(${v.error})` : ''} bm25=${b.found}/${b.total}${b.error ? `(${b.error})` : ''}`)
      }
      stats.inserts += out.inserted
      stats.insertErrors += out.failed
      stats.lastInsert = {
        at: Date.now(), collectionId: target, inserted: out.inserted, failed: out.failed,
        vectorFound: v.found, bm25Found: b.found,
      }
      log(ctx, `入库 ${target}：写成功 ${out.inserted} / 失败 ${out.failed}；回读 vector=${v.found}/${v.total} bm25=${b.found}/${b.total}`)
      return out
    } catch (e) {
      const msg = e?.message ?? String(e)
      stats.insertErrors += 1
      stats.lastInsert = { at: Date.now(), collectionId: target, inserted: out.inserted, failed: out.failed + 1, error: msg }
      warn(ctx, '入库失败（整批）:', msg)
      out.failed += 1
      out.reason = msg
      return out
    }
  }

  // ─────────────────────────── 自动入库（甲方案 b 的自动化，2026-09-16）

  /**
   * ★ 入库账本**落盘**（2026-09-17，D12）。
   * 为什么：原来只有内存账本 ⇒ 每次重启清零 ⇒ **整集重灌**（真机 49 条 = 每次重启 49 次
   * embedding），embedding 一挂就成持续风暴。现在键 = 文件名 + **内容签名**（`sourceHash|chars`）
   * ⇒ 内容没变就不重入、变了才重入，重启也不重灌。写盘失败自动降级回内存（不抛）。
   */
  const ledgerPath = (() => {
    const p = String(cfg.ingest?.ledgerPath || '').trim()
    if (p !== '') return p
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    return join(home, 'dsh-anima-rag', LEDGER_FILENAME)
  })()
  const ledger = createIngestLedger({ path: ledgerPath, logger: { warn: (m) => warn(ctx, m) } })
  /** 失败重试次数上限：超了就不再重试（否则一个坏条目会每轮烧一次 embedding）。 */
  const ingestTries = new Map()
  let lastIngestMtime = -1
  let autoIngestRunning = false
  let maintainDone = false

  /**
   * ★ 自动维护（D12）：把**索引没引用**的孤儿元数据文件移进 `<集合>/_quarantine-<时间戳>/`。
   * 为什么：引擎的"覆盖同名"清理只删它**当轮认识**的文件（老 item 没有 `metadataFile`
   * ⇒ 文件留下）。真机实测 `vectors/dsh-memory/` 目录 654 个 `.json` 而索引只引用 62 个
   * ⇒ **592 个孤儿（90%）**，纯占盘（检索走索引，看不到它们）。
   * ⛔ 只动集合目录里、且**索引确实没引用**的 `.json`；`index.json` 永不碰；默认是**移动**不是删。
   * `ingest.quarantine: false` ⇒ 只报告不动手。
   */
  function autoMaintain(collectionId) {
    if (cfg.ingest?.autoClean === false) return { skipped: 'off' }
    const target = String(collectionId || cfg.ingest?.collectionId || '').trim()
    if (target === '') return { skipped: 'no-collection' }
    const safe = safeCollectionName(target)
    const vectorDir = join(cfg.data.vectorRoot, safe)
    const indexFile = join(vectorDir, 'index.json')
    if (!existsSync(indexFile)) return { skipped: 'no-index' }
    let items = []
    try { items = JSON.parse(readFileSync(indexFile, 'utf8'))?.items ?? [] } catch { return { skipped: 'bad-index' } }
    const found = findOrphanMetadataFiles({ vectorDir, indexItems: items })
    if (found.orphans.length === 0) return { orphans: 0, kept: found.kept }
    const res = quarantineOrphans({ vectorDir, orphans: found.orphans, dryRun: cfg.ingest?.quarantine === false })
    if (res.moved > 0) stats.orphansQuarantined += res.moved
    log(ctx, `入库维护：${safe} 孤儿 ${found.orphans.length} 个 ⇒ 隔离 ${res.moved}（失败 ${res.failed}）`
      + `${res.dir ? ` 目录=${res.dir}` : '（只报告，未动手）'}`)
    return { orphans: found.orphans.length, moved: res.moved, failed: res.failed, dir: res.dir ?? null }
  }

  /**
   * ★ 孤儿回收（2026-09-18 真机）。用户口径原话：
   *   「孤儿文件直接删除就好。**在成为孤儿的一瞬间**」。
   *
   * ## 为什么必须有它
   * 入库按**文件名**判重（台账），检索按**库里的切片**走 —— 两者之间从来没有对账。
   * 于是摘要文件一改名（实测 `s-0000-0019.md` → `s-0000-0019-1/2/3.md`），旧切片既不覆盖
   * 也不删除地留下来，**照旧参与检索**。真机账（`dsh-memory` 62 条）：
   * **49 好 / 10 孤儿 / 1 import 清单 / 2 测试残留**；其中一条孤儿是总结器的**提示词回声**。
   *
   * ## 挂在哪儿（对应"一瞬间"）
   * 挂在 `autoIngestOnce` 里、**早于** `pending.length === 0` 的早退分支：改名可能一条新条目
   * 都不产生，但旧切片已经成了孤儿 ⇒ 只看 `index.json` 变没变，不看有没有新活干。
   *
   * ## 三处一起删（只删一处 = 留幽灵）
   * ① 向量 `index.json` 的 `items`；② per-item 元数据文件；③ BM25 文档。
   * ★ 用户口径（2026-09-18）：「**向量库和孤儿总结一起删掉**」⇒ **干净删、不留档**。
   *   （孤儿总结的正文只活在 BM25 的 storedFields 里，③ 就是删它。删掉即真没了 —— 这是要的。）
   *
   * ## ⛔ fail-closed（判据与护栏都在 `lib/orphan-reconcile.js`，那里被自检直测）
   *   白名单空 ⇒ 一条不删；非本前缀 ⇒ 不动只报告；引擎关不掉 ⇒ 不删；写索引失败 ⇒ 本轮只删一半，下轮再对账。
   *   「判不出来宁可不删」——这是删用户记忆的代码，默认保守。
   */
  async function reconcileOrphans(collectionId, entries, prefix) {
    if (cfg.ingest?.reconcileOrphans === false) return { skipped: 'off' }
    const target = String(collectionId || cfg.ingest?.collectionId || '').trim()
    if (target === '') return { skipped: 'no-collection' }
    const safe = safeCollectionName(target)
    const vectorDir = join(cfg.data.vectorRoot, safe)
    const indexFile = join(vectorDir, 'index.json')
    if (!existsSync(indexFile)) return { skipped: 'no-vector-index' }
    let indexJson = null
    try { indexJson = JSON.parse(readFileSync(indexFile, 'utf8')) } catch { return { skipped: 'bad-vector-index' } }
    const items = Array.isArray(indexJson?.items) ? indexJson.items : []
    const allowed = allowedKeysFromEntries(entries, { prefix })
    const gate = decideReconcile({ allowedCount: allowed.size, itemCount: items.length })
    if (!gate.ok) { log(ctx, `孤儿回收：跳过（${gate.reason}）`); return { skipped: 'gate', reason: gate.reason } }
    const found = findOrphanSlices(items, allowed, { prefix })
    if (found.skipped.length > 0) {
      warn(ctx, `孤儿回收：${found.skipped.length} 条来源不明（不是 \`${prefix}_\` 前缀）⇒ **一律不动**，只报告：`
        + found.skipped.slice(0, 5).map((s) => s.index).join('、'))
    }
    if (found.orphans.length === 0) return { orphans: 0, kept: found.kept, skipped: found.skipped.length }
    const orphanIdx = found.orphans.map((o) => o.index)
    if (cfg.ingest?.quarantine === false) {
      log(ctx, `孤儿回收：检出 ${found.orphans.length} 条（quarantine:false ⇒ 只报告，未动手）：` + orphanIdx.slice(0, 5).join('、'))
      return { orphans: found.orphans.length, kept: found.kept, skipped: found.skipped.length, dryRun: true }
    }
    // ★ 用户口径（2026-09-18）：「**向量库和孤儿总结一起删掉**」—— 干净删，**不留档**。
    //   ⛔ 曾经写过一版把正文存进 `_quarantine-orphan-slices-*`；用户否了，已撤。
    //   （被删的正文只活在 BM25 的 storedFields 里，删掉就是真没了 —— 这是**要的**。）
    // ① 关引擎缓存：它把整份索引读进内存，不关的话我们的改动会被它写回去
    const bm25File = join(cfg.data.bm25Root, `${safe}.json`)
    const engine = await loadEngine()
    try { if (typeof engine.close === 'function') await engine.close() } catch (e) {
      warn(ctx, '孤儿回收：引擎关缓存失败 ⇒ **本条不删**（下轮再试）：', e?.message ?? String(e))
      return { skipped: 'close-failed', orphans: found.orphans.length }
    }
    // ② 向量侧：摘 items + 删 per-item 元数据文件
    const { next, removed } = planVectorPrune(indexJson, found.orphans.map((o) => o.id))
    try { writeFileSync(indexFile, JSON.stringify(next)) } catch (e) {
      warn(ctx, '孤儿回收：写向量索引失败 ⇒ 本轮只删到一半，下轮会再对账：', e?.message ?? String(e))
      return { skipped: 'write-failed', orphans: found.orphans.length }
    }
    let metaRemoved = 0
    for (const f of metadataFileNamesOf(removed)) {
      const p = join(vectorDir, f)
      try { if (existsSync(p)) { rmSync(p, { force: true }); metaRemoved += 1 } } catch { /* 索引里已无引用，文件留着只是占盘 */ }
    }
    // ③ BM25 侧：删掉那条文档（★ **孤儿总结的正文就在这里，一起删掉**）
    let bm25Removed = 0
    try {
      if (existsSync(bm25File)) {
        const stored = JSON.parse(readFileSync(bm25File, 'utf8'))?.storedFields ?? null
        const ids = bm25IdsForIndexes(stored, orphanIdx)
        if (ids.length > 0) { await engine._internal.bm25.deleteDocuments(target, ids); bm25Removed = ids.length }
      }
    } catch (e) {
      warn(ctx, '孤儿回收：BM25 侧删除失败（向量侧已删 ⇒ 两份索引暂时不一致，下轮会再对账）：', e?.message ?? String(e))
    }
    stats.orphansReconciled = (stats.orphansReconciled ?? 0) + found.orphans.length
    log(ctx, `孤儿回收：${safe} 删 ${found.orphans.length} 条（向量元数据 ${metaRemoved} / BM25 正文 ${bm25Removed}；留 ${found.kept} 条）`
      + `；样例 ${orphanIdx.slice(0, 4).join('、')}`)
    return { orphans: found.orphans.length, kept: found.kept, skipped: found.skipped.length, metaRemoved, bm25Removed }
  }

  /**
   * 拉取式自动入库：`summariesDir/index.json` 一变，就把**还没入过**的条目写进记忆库。
   * ⛔ 绝不抛；失败进 `stats.insertErrors` 并按上限重试。
   */
  async function autoIngestOnce() {
    if (cfg.ingest?.enabled === false || cfg.ingest?.auto === false) return { skipped: 'off' }
    const dir = resolveSummariesDir()
    if (dir === '') return { skipped: 'no-dir' }
    let mtime = 0
    try { mtime = statSync(join(dir, 'index.json')).mtimeMs } catch { return { skipped: 'no-index' } }
    // ★ 维护每进程一次，且**不受 index.json 变没变影响**（它清的是历史遗留的孤儿文件）。
    //   失败不置位 ⇒ 下一轮还会再试。
    if (!maintainDone) {
      try { stats.lastMaintain = autoMaintain(); maintainDone = true } catch (e) { warn(ctx, '入库维护失败（下轮再试）：', e?.message ?? String(e)) }
    }
    if (mtime === lastIngestMtime) return { skipped: 'unchanged' }
    lastIngestMtime = mtime
    let entries = []
    try {
      const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
      entries = Array.isArray(idx?.entries) ? idx.entries : []
    } catch (e) {
      warn(ctx, '自动入库：index.json 解析失败（本轮跳过）:', e?.message ?? String(e))
      return { skipped: 'bad-index' }
    }
    const prefix = String(cfg.ingest?.indexPrefix || 'sum')
    // ★ 孤儿回收（2026-09-18）：**先于** `pending` 的早退分支 —— 摘要文件改名可能一条新条目
    //   都不产生，但旧切片已经成了孤儿。用户口径："在成为孤儿的一瞬间"。
    //   ⛔ 绝不抛（入库链不能因为清理失败而停）。
    try { stats.lastReconcile = await reconcileOrphans(cfg.ingest?.collectionId || cfg.chatCollections?.[0], entries, prefix) }
    catch (e) { warn(ctx, '孤儿回收失败（下轮再试）:', e?.message ?? String(e)) }
    const pending = entries.filter((e) => e && typeof e.file === 'string' && e.file !== ''
      // ⛔ `import-*` 是**导入批次清单**（来源/哈希/体积），不是内容摘要 ⇒ 不许当记忆入进来
      && !String(e.id ?? '').startsWith('import-')
      // ★ 账本按 **文件名 + 内容签名** 判重（D12）：内容没变就不重入，重启也不重灌
      && !ledger.has(String(e.file), entrySignature(e)) && (ingestTries.get(String(e.file)) ?? 0) < 3)
    if (pending.length === 0) { ledger.prune(new Set(entries.map((e) => String(e.file)))); ledger.save(); return { skipped: 'all-done' } }
    const slices = []
    const unreadable = []
    for (const e of pending) {
      try {
        const t = readFileSync(join(dir, e.file), 'utf8').trim()
        if (t === '') { unreadable.push(String(e.file)); continue }
        slices.push({
          text: t, tags: Array.isArray(e.tags) ? e.tags : [],
          index: `${prefix}_${e.file}`, batch_id: -1, source: String(e.file),
        })
      } catch (err) { unreadable.push(`${e.file}（${err?.message ?? String(err)}）`) }
    }
    if (unreadable.length > 0) warn(ctx, `自动入库：这些条目读不到，已跳过 —— ${unreadable.slice(0, 5).join('；')}`)
    if (slices.length === 0) return { skipped: 'no-readable' }
    const out = await insertSlices(slices, { scope: scopeOfDir(dir) })
    const okIdx = new Set(out.results.filter((r) => r.ok).map((r) => r.index))
    const byFile = new Map(entries.map((e) => [String(e.file), e]))
    for (const s of slices) {
      const file = String(s.source)
      if (okIdx.has(String(s.index))) ledger.mark(file, entrySignature(byFile.get(file)))
      else ingestTries.set(file, (ingestTries.get(file) ?? 0) + 1)
    }
    ledger.prune(new Set(entries.map((e) => String(e.file))))
    ledger.save()
    // ★ **每批之后也维护一次**（2026-09-18 真机发现）：引擎在"覆盖同名"时会留下**没被索引引用**的
    //   元数据文件（首次整集入库实测留下 49 个：内容本来就在库里、只是同一个 `index` 名被重写）。
    //   只靠上面"每进程一次"要等到下次重启才清 ⇒ 这里跟着批次再收一次。
    if (out.inserted > 0) {
      try { stats.lastMaintain = autoMaintain(out.collectionId) } catch (e) { warn(ctx, '入库后维护失败（忽略）：', e?.message ?? String(e)) }
    }
    stats.autoIngestRuns += 1
    log(ctx, `自动入库：${out.collectionId} 写成功 ${out.inserted} / 失败 ${out.failed}（待处理 ${pending.length} 条；账本 ${ledger.size} 条）`)
    return { inserted: out.inserted, failed: out.failed, ok: out.ok }
  }

  /** 装配期触发：**不 await**（embedding 慢，绝不阻塞本轮）。 */
  function kickAutoIngest() {
    if (autoIngestRunning) return
    if (cfg.ingest?.enabled === false || cfg.ingest?.auto === false) return
    autoIngestRunning = true
    void autoIngestOnce()
      .catch((e) => { stats.insertErrors += 1; warn(ctx, '自动入库异常:', e?.message ?? String(e)) })
      .finally(() => { autoIngestRunning = false })
  }

  /** 从会话事件算出本轮的检索词与缓存键。 */
  function planFor(agent, sessionId) {
    const events = snapshotEvents(agent)
    const turn = lastTurnOf(events)
    const messages = extractMessages(events, { skipLayerZero: cfg.skipLayerZero })
    const searchText = buildVectorQuery(messages, cfg)
    const bm25SearchText = buildBm25Text(messages, cfg.bm25)
    const key = `${sessionId}::${turn}::${sha1Short(`${searchText}\u0000${bm25SearchText}`)}`
    return { events, turn, messages, searchText, bm25SearchText, key }
  }

  // ─────────────────────────── 钩子 ①：同步 provider（兜底通道）

  const sectionDispose = ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: cfg.inject.order,
    text: (context) => {
      try {
        if (!cfg.enabled) return ''
        const sessionId = context?.agent?.id
        if (!sessionId) return ''
        // ★ 白名单：不在名单内的会话（编程/工具会话）一个字都不注入
        if (!sessionAllowed(sessionId)) return ''
        return lastBySession.get(sessionId) ?? ''
      } catch (e) {
        warn(ctx, 'section provider 异常', e?.message ?? String(e))
        return ''
      }
    },
  })
  ctx.effect?.(() => sectionDispose)

  // ─────────────────────────── 钩子 ②：装配期检索 + 改写 sections

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    // waterfall：先拿上游结果，再改写
    const out = await (typeof next === 'function' ? next() : Promise.resolve(assembly))
    // ★ 自动入库（与"本轮给谁注入"无关，所以在会话白名单之前踢一脚）：
    //   只做一次 statSync；真变了才干活，且**不 await** —— 绝不阻塞本轮生成。
    kickAutoIngest()
    try {
      if (!cfg.enabled) return out
      const agent = context?.agent
      const sessionId = agent?.id
      if (!sessionId) return out
      // ★★ 白名单：这是「跨会话污染」的唯一闸门。
      //    没有它，本插件会对**每一个会话**跑检索并注入 —— 实测曾污染编程会话的 system 段。
      if (!sessionAllowed(sessionId)) {
        skippedSessions += 1
        return out
      }

      stats.assembles += 1
      const { searchText, bm25SearchText, key, turn } = planFor(agent, sessionId)

      // ★ 「同一轮只等一次」（2026-09-16 真机实测后加）：一个 turn 里 assemble 会跑很多次
      //   （每个 step 一次）。原来每次超时都不缓存 ⇒ 后面每个 step 都会**再等一遍**同一个
      //   在途任务（`inflight` 里那个还没完），一轮下来能卡出好几倍 timeoutMs。
      //   现在：本轮等过一次超时，就把 `session::turn` 记下来，后续 step 直接放行、不再等。
      const turnKey = `${sessionId}::${turn}`
      if (timedOutTurns.has(turnKey)) return out

      let entry = cache.get(key)
      if (entry) {
        stats.cacheHits += 1
      } else {
        let task = inflight.get(key)
        if (!task) {
          task = retrieve({ searchText, bm25SearchText, sessionKey: sessionId }).finally(() => inflight.delete(key))
          inflight.set(key, task)
        }
        // 有界等待：超时即放行，绝不阻塞主对话
        entry = await Promise.race([
          task,
          new Promise(r => setTimeout(() => r(null), Math.max(0, cfg.timeoutMs))),
        ])
        if (entry === null) {
          stats.timeouts += 1
          timedOutTurns.add(turnKey)
          if (timedOutTurns.size > 50) timedOutTurns.delete(timedOutTurns.values().next().value)
          warn(ctx, `检索超时（>${cfg.timeoutMs}ms），本轮（turn=${turn}）不再重试等它`)
          return out
        }
        cache.set(key, entry)
        if (cfg.debug) {
          stats.lastQuery = { searchText: searchText.slice(0, 200), bm25SearchText: bm25SearchText.slice(0, 200), key }
          log(ctx, `turn 检索完成 turn=${entry?.stats?.ms ?? '?'}ms chars=${entry?.text?.length ?? 0}`)
        }
      }

      const text = entry?.text ?? ''
      if (!text) return out
      lastBySession.set(sessionId, text)

      const sections = (out.sections ?? []).map(s => (s.name === SECTION_NAME ? { ...s, text } : s))
      if (!sections.some(s => s.name === SECTION_NAME)) {
        sections.push({ name: SECTION_NAME, order: cfg.inject.order, text })
      }
      return { ...out, sections }
    } catch (e) {
      stats.errors += 1
      stats.lastError = e?.message ?? String(e)
      warn(ctx, 'assemble 注入异常（本轮不注入）:', stats.lastError)
      return out
    }
  })

  // ─────────────────────────── 宿主级工具

  ctx.tools.register({
    name: 'anima_status',
    description: '【维护/诊断】查看 dsh-anima-rag（L2 记忆）的状态：开关、数据根、集合、引擎是否加载成功、缓存与统计。'
      + 'RP 里用不到 —— 排查"记忆为什么没进来"时才看。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        required: ['version', 'enabled', 'engineLoaded', 'collections', 'stats'],
        properties: {
          version: { type: 'string' },
          enabled: { type: 'boolean' },
          engineLoaded: { type: 'boolean' },
          enginePath: { type: 'string' },
          engineError: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          data: {
            type: 'object', additionalProperties: false,
            required: ['vectorRoot', 'sessionRoot', 'bm25Root'],
            properties: { vectorRoot: { type: 'string' }, sessionRoot: { type: 'string' }, bm25Root: { type: 'string' } },
          },
          collections: {
            type: 'object', additionalProperties: false,
            required: ['chat', 'kb'],
            properties: {
              chat: { type: 'array', items: { type: 'string' } },
              kb: { type: 'array', items: { type: 'string' } },
            },
          },
          echoPersist: { type: 'boolean' },
          injectionOrder: { type: 'integer' },
          maxInjectChars: { type: 'integer' },
          vectorPromptItems: { type: 'integer' },
          regexRuleCount: { type: 'integer' },
          embedUrl: { type: 'string' },
          embedKeySet: { type: 'boolean' },
          rerankEnabled: { type: 'boolean' },
          cacheEntries: { type: 'integer' },
          inflight: { type: 'integer' },
          sessionsWithText: { type: 'integer' },
          stats: {
            type: 'object', additionalProperties: false,
            required: ['assembles', 'cacheHits', 'retrievals', 'timeouts', 'errors'],
            properties: {
              assembles: { type: 'integer' }, cacheHits: { type: 'integer' }, retrievals: { type: 'integer' },
              timeouts: { type: 'integer' }, errors: { type: 'integer' },
              lastError: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              lastMs: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
              // ★ 写入口（甲方案 T2）的计数：⛔ 新增返回值必须在这里声明，
              //   否则宿主按 additionalProperties:false 直接拒收整个工具（2026-09-12 踩过）。
              inserts: { type: 'integer' },
              insertErrors: { type: 'integer' },
              autoIngestRuns: { type: 'integer' },
              insertRetries: { type: 'integer' },
              lastInsert: {
                oneOf: [
                  { type: 'null' },
                  {
                    type: 'object', additionalProperties: false,
                    required: ['at', 'collectionId', 'inserted', 'failed'],
                    properties: {
                      at: { type: 'integer' }, collectionId: { type: 'string' },
                      inserted: { type: 'integer' }, failed: { type: 'integer' },
                      vectorFound: { type: 'integer' }, bm25Found: { type: 'integer' },
                      error: { type: 'string' },
                    },
                  },
                ],
              },
            },
          },
          lastQuery: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object', additionalProperties: false,
                required: ['searchText', 'bm25SearchText', 'key'],
                properties: { searchText: { type: 'string' }, bm25SearchText: { type: 'string' }, key: { type: 'string' } },
              },
            ],
          },
          // ★ 2026-09-12 修：返回值里本来就有这两项（见下面 `allowSessions` / `skippedSessions`），
          //    但 output.schema 没声明 ⇒ 宿主按 `additionalProperties:false` 校验时**直接拒收**，
          //    `anima_status` 这个工具整个变成不可用（实测报
          //    `"skippedSessions" is not a declared property (additionalProperties: false)`）。
          allowSessions: { type: 'array', items: { type: 'string' } },
          skippedSessions: { type: 'integer' },
          /** ★ 写入口（甲方案 T2）：目标集合 / 来源目录 / 开关。 */
          ingest: {
            type: 'object', additionalProperties: false,
            required: ['enabled', 'collectionId', 'dir', 'auto', 'ingested'],
            properties: {
              enabled: { type: 'boolean' },
              collectionId: { type: 'string' },
              dir: { type: 'string' },
              auto: { type: 'boolean' },
              ingested: { type: 'integer' },
            },
          },
          /** ★ 近场记忆（T4）：`summariesDir` 解析结果与实际是否存在（空目录 = 该段不注入）。 */
          summaries: {
            type: 'object', additionalProperties: false,
            required: ['mode', 'dir', 'exists', 'hasIndex'],
            properties: {
              mode: { type: 'string' },
              dir: { type: 'string' },
              exists: { type: 'boolean' },
              hasIndex: { type: 'boolean' },
            },
          },
        },
      },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute() {
      let engineLoaded = false
      try { await loadEngine(); engineLoaded = true } catch { /* 保留 engineError */ }
      return {
        version: VERSION,
        enabled: cfg.enabled === true,
        engineLoaded,
        enginePath: enginePath(),
        engineError: engineError ?? null,
        data: { ...cfg.data },
        collections: { chat: [...cfg.chatCollections], kb: [...cfg.kbCollections] },
        echoPersist: cfg.echoPersist === true,
        injectionOrder: cfg.inject.order,
        maxInjectChars: cfg.inject.maxChars,
        /** ★ 会话白名单（空 = 对所有会话注入；非空 = 只对名单内注入） */
        allowSessions: Array.isArray(cfg.inject.allowSessions) ? [...cfg.inject.allowSessions] : [],
        /** ★ 因不在白名单里而被跳过的会话次数（>0 说明隔离正在生效） */
        skippedSessions,
        vectorPromptItems: Array.isArray(cfg.vectorPrompt) ? cfg.vectorPrompt.length : 0,
        regexRuleCount: Array.isArray(cfg.regexStrings) ? cfg.regexStrings.length : 0,
        embedUrl: cfg.embed.url,
        embedKeySet: Boolean(cfg.embed.key),
        rerankEnabled: cfg.rerank.enabled === true,
        cacheEntries: cache.size,
        inflight: inflight.size,
        sessionsWithText: lastBySession.size,
        stats: {
          assembles: stats.assembles, cacheHits: stats.cacheHits, retrievals: stats.retrievals,
          timeouts: stats.timeouts, errors: stats.errors,
          lastError: stats.lastError ?? null, lastMs: stats.lastMs ?? null,
          inserts: stats.inserts, insertErrors: stats.insertErrors, autoIngestRuns: stats.autoIngestRuns, insertRetries: stats.insertRetries, lastInsert: stats.lastInsert ?? null,
        },
        ingest: {
          enabled: cfg.ingest?.enabled !== false,
          collectionId: String(cfg.ingest?.collectionId ?? ''),
          dir: String(cfg.ingest?.dir || cfg.summariesDir || ''),
          auto: cfg.ingest?.auto !== false,
          // ★ 账本**落盘**（D12）：`ingested` = 账本条数（重启不再清零）
          ingested: ledger.size,
          ledgerPath: ledgerPath,
          autoClean: cfg.ingest?.autoClean !== false,
          quarantine: cfg.ingest?.quarantine !== false,
          orphansQuarantined: stats.orphansQuarantined ?? 0,
          lastMaintain: stats.lastMaintain ?? null,
        },
        summaries: (() => {
          const dir = resolveSummariesDir()
          return {
            mode: String(cfg.summariesDir || '') === 'auto' ? 'auto' : (String(cfg.summariesDir || '') === '' ? 'off' : 'path'),
            dir: dir,
            exists: dir !== '' && existsSync(dir),
            hasIndex: dir !== '' && existsSync(join(dir, 'index.json')),
          }
        })(),
        lastQuery: stats.lastQuery ?? null,
      }
    },
  })

  ctx.tools.register({
    name: 'anima_ingest',
    description: '把记忆切片写进 Anima 记忆库（向量 + BM25），写完回读核对两条索引。'
      + '【维护/接线用 —— ⛔ 不是角色扮演环节，RP 会话里不要调】'
      + '① 给 texts：直接把这些文本各写成一条切片；'
      + '② 给 dir（或都不给，用配置里的 ingest.dir / summariesDir）：把目录里每个 .txt/.md/.json 当一条切片，'
      + 'index 记为 `<index_prefix>:<文件名>`（重跑同一目录=幂等覆盖，引擎按 index 去重）。'
      + '目标集合 = 参数 collectionId，缺省用配置 ingest.collectionId（默认 dsh-memory）；⛔ 不会写进 ST 那份集合。'
      + '失败一律留在返回值与 stats 里，不静默。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        texts: { type: 'array', items: { type: 'string' } },
        dir: { type: 'string' },
        collectionId: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        batch_id: { type: 'integer' },
        index_prefix: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        required: ['ok', 'collectionId', 'requested', 'inserted', 'failed', 'truncated', 'reason', 'skipped', 'verify', 'results'],
        properties: {
          ok: { type: 'boolean' },
          collectionId: { type: 'string' },
          requested: { type: 'integer' },
          inserted: { type: 'integer' },
          failed: { type: 'integer' },
          truncated: { type: 'boolean' },
          reason: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          skipped: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['source', 'reason'],
              properties: { source: { type: 'string' }, reason: { type: 'string' } },
            },
          },
          verify: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object', additionalProperties: false,
                required: ['vector', 'bm25'],
                properties: {
                  vector: {
                    type: 'object', additionalProperties: false,
                    required: ['found', 'total', 'error'],
                    properties: {
                      found: { type: 'integer' }, total: { type: 'integer' },
                      error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                    },
                  },
                  bm25: {
                    type: 'object', additionalProperties: false,
                    required: ['found', 'total', 'error'],
                    properties: {
                      found: { type: 'integer' }, total: { type: 'integer' },
                      error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                    },
                  },
                },
              },
            ],
          },
          results: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['index', 'ok', 'attempts', 'vectorId', 'status', 'message'],
              properties: {
                index: { type: 'string' },
                ok: { type: 'boolean' },
                attempts: { type: 'integer' },
                vectorId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                status: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                message: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              },
            },
          },
        },
      },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args = {}) {
      const prefix = typeof args.index_prefix === 'string' && args.index_prefix.trim() !== ''
        ? args.index_prefix.trim() : 'dsh'
      const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string' && t !== '') : []
      const batchId = Number.isFinite(Number(args.batch_id)) ? Number(args.batch_id) : -1
      const explicit = typeof args.collectionId === 'string' && args.collectionId.trim() !== ''
        ? args.collectionId.trim() : null
      const texts = Array.isArray(args.texts) ? args.texts.filter((t) => typeof t === 'string' && t.trim() !== '') : []
      // ★ 显式给了 texts 就**不许**再回退到目录模式：调用方说"我喂这些文本"，
      //   结果是空白时应当如实报 empty，而不是悄悄换个数据源（自检里就是这么抓出来的）。
      const textsGiven = Array.isArray(args.texts)
      const empty = {
        ok: false, collectionId: String(explicit ?? cfg.ingest?.collectionId ?? ''), requested: 0,
        inserted: 0, failed: 0, truncated: false, reason: null, skipped: [], verify: null, results: [],
      }
      let slices = []
      let skipped = []
      // ⛔ `dir` 要在分支**外面**声明：里面的 `const dir` 是块级作用域，
      //    在下面 insertSlices 那行引用会 `ReferenceError: dir is not defined`（本轮实测踩过）。
      let sourceDir = ''
      if (texts.length > 0) {
        slices = texts.map((t, i) => ({ text: t, tags, index: `${prefix}_${i + 1}`, batch_id: batchId }))
      } else if (textsGiven) {
        return { ...empty, reason: 'empty：给了 texts 但全是空白/非法项（不会再回退去读目录）' }
      } else {
        // ⛔ 默认目录必须走 `resolveSummariesDir()`：`summariesDir` 现在是 **'auto'**
        //    （从 memory-archive 的 root 推），直接当路径用会得到一个叫 "auto" 的目录
        //    ⇒ 报「目录读不到：auto」。只有显式给 `args.dir` 或用 `ingest.dir` 时才用字面路径。
        const dir = typeof args.dir === 'string' && args.dir.trim() !== ''
          ? args.dir.trim()
          : (String(cfg.ingest?.dir || '').trim() !== '' ? String(cfg.ingest.dir).trim() : resolveSummariesDir())
        if (dir === '') {
          return { ...empty, reason: 'no-source：既没给 texts，也没有可用的来源目录（ingest.dir / summariesDir 都是空）' }
        }
        sourceDir = dir
        const r = slicesFromDir(dir, { prefix, tags, batchId })
        if (r.error) return { ...empty, reason: r.error }
        slices = r.slices
        skipped = r.skipped
      }
      const out = await insertSlices(slices, { ...(explicit ? { collectionId: explicit } : {}), scope: scopeOfDir(sourceDir) })
      return {
        ok: out.ok, collectionId: out.collectionId, requested: out.requested,
        inserted: out.inserted, failed: out.failed,
        truncated: out.requested > MAX_INGEST_SLICES,
        reason: out.reason, skipped, verify: out.verify, results: out.results,
      }
    },
  })

  ctx.tools.register({
    name: 'anima_forget',
    description: '按**周目**清理记忆库切片（删周目后清孤儿记忆用）。'
      + '【维护用 —— ⛔ 不是角色扮演环节，RP 会话里不要调】'
      + '做法是**整集重建**（引擎没有 delete 接口、BM25 是 MiniSearch 序列化态不能手工改）：'
      + '备份两份集合文件 → 清掉进程内缓存 → 清空集合 → 把**工作区里现存的周目**按 index 重灌。'
      + '① 给 playthroughId：只清理它（其它周目重灌保留）；② 给 all:true：整个集合清空、不重灌。'
      + '⛔ dryRun:true 只出计划、零写入（先看数字再决定）。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        playthroughId: { type: 'string' },
        collectionId: { type: 'string' },
        all: { type: 'boolean' },
        dryRun: { type: 'boolean' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        required: ['ok', 'dryRun', 'collectionId', 'forgetting', 'keeping', 'keepSlices', 'backup', 'inserted', 'failed', 'reason', 'results'],
        properties: {
          ok: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          collectionId: { type: 'string' },
          forgetting: { type: 'string' },
          keeping: { type: 'integer' },
          keepSlices: { type: 'integer' },
          backup: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          inserted: { type: 'integer' },
          failed: { type: 'integer' },
          reason: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          results: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['playthroughId', 'slices', 'inserted', 'failed', 'error'],
              properties: {
                playthroughId: { type: 'string' },
                slices: { type: 'integer' },
                inserted: { type: 'integer' },
                failed: { type: 'integer' },
                error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              },
            },
          },
        },
      },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args = {}) {
      const target = String(args.collectionId || cfg.ingest?.collectionId || cfg.chatCollections?.[0] || '').trim()
      const forget = String(args.playthroughId || '').trim()
      const wipeAll = args.all === true
      const dryRun = args.dryRun === true
      const base = {
        ok: false, dryRun, collectionId: target,
        forgetting: wipeAll ? '(全部)' : (forget || '(未指定)'),
        keeping: 0, keepSlices: 0, backup: null, inserted: 0, failed: 0, reason: null, results: [],
      }
      try {
        if (target === '') { base.reason = 'no-collection：没给 collectionId，配置里也没有'; return base }
        if (!wipeAll && forget === '') { base.reason = '需要 playthroughId（或 all:true 清空整集）'; return base }
        const scopes = wipeAll ? [] : listArchiveScopes().filter((s) => s.playthroughId !== forget)
        base.keeping = scopes.length
        // 先把"保留者"的切片读齐（读不到就不动它，并在 results 里报）
        const kept = []
        const prefix = String(cfg.ingest?.indexPrefix || 'sum')
        for (const sc of scopes) {
          try {
            const r = slicesFromDir(sc.dir, { prefix, tags: [], batchId: -1 })
            const slices = r.slices.map((x) => ({ ...x, tags: [...new Set([...(x.tags || []), ptTag(sc.playthroughId)])] }))
            base.results.push({ playthroughId: sc.playthroughId, slices: slices.length, inserted: 0, failed: 0, error: r.error ?? (slices.length === 0 ? '没有可读切片' : null) })
            kept.push({ sc, slices })
          } catch (e) {
            base.results.push({ playthroughId: sc.playthroughId, slices: 0, inserted: 0, failed: 0, error: String(e?.message ?? e) })
          }
        }
        base.keepSlices = kept.reduce((a, x) => a + x.slices.length, 0)
        if (dryRun) { base.ok = true; base.reason = 'dryRun：零写入'; return base }
        if (kept.length > 0 && base.keepSlices === 0) {
          base.reason = '保留下来的周目里一条切片都读不到 ⇒ 拒绝清空（否则会把记忆全删光）'; return base
        }
        if (!cfg.embed.key && base.keepSlices > 0) { base.reason = 'no-embed-key：要重灌但 embedding 没 key'; return base }
        // 备份 → 关缓存 → 清空 → 重灌
        const bk = backupCollection(target)
        base.backup = bk.dir
        const engine = await loadEngine()
        if (typeof engine.close === 'function') { try { await engine.close() } catch { /* 清缓存失败不致命 */ } }
        wipeCollection(target)
        for (const { sc, slices } of kept) {
          if (slices.length === 0) continue
          const out = await insertSlices(slices, { collectionId: target })
          const row = base.results.find((x) => x.playthroughId === sc.playthroughId)
          if (row) { row.inserted = out.inserted; row.failed = out.failed }
          base.inserted += out.inserted
          base.failed += out.failed
        }
        base.ok = base.failed === 0
        base.reason = base.ok
          ? `已重建：${target} 保留 ${kept.length} 个周目 / ${base.keepSlices} 条切片；忘掉 ${base.forgetting}`
          : `重建完成但有失败 ${base.failed} 条（备份在 ${base.backup}）`
        log(ctx, base.reason)
        return base
      } catch (e) {
        base.reason = String(e?.message ?? e)
        warn(ctx, 'anima_forget 失败：', base.reason)
        return base
      }
    },
  })

  ctx.tools.register({
    name: 'anima_query',
    description: '【回忆】去过往记录里查一查 —— 当你**想不起**一个名字、一件物品、一句承诺、一段关系、一个地点，'
      + '或要确认"这事以前发生过没有"时用它。'
      + '返回的是**从历史里检索出来的片段**（向量语义命中 + BM25 字面命中），每条带 tags（vibe / Important 等）。'
      + '★ query 写成**一句自然的话**（例：「叶绛说过什么时候回来」），别只丢一个词。'
      + '★ 返回的都是**已经发生过的事**，不是此刻：只用来支撑角色的记忆与内心活动，'
      + '⛔ 不要当成本轮新发生的情节，也不要照着复述。'
      + '★ 它**只读**：不写库、不改对话历史。没查到就如实说没查到，别编。'
      + '【维护参数，RP 里不要动】bm25_query（只按字面查）/ include_items（多要几条原文）；session_id 缺省即本会话。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', description: '要回忆什么，写一句自然的话（如「阿柠提过的那只闹钟」）' },
        bm25_query: { type: 'string', description: '【维护】只走字面检索的词；一般不要传' },
        session_id: { type: 'string', description: '【维护】缺省即本会话；一般不要传' },
        echo_persist: { type: 'boolean', description: '【维护】是否回写会话的回响状态；一般不要传' },
        include_items: { type: 'integer', description: '【维护】额外返回几条原文；一般不要传' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        required: ['ok', 'chatItems', 'kbItems', 'chars', 'ms'],
        properties: {
          ok: { type: 'boolean' },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          reason: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          searchText: { type: 'string' },
          bm25SearchText: { type: 'string' },
          chatItems: { type: 'integer' },
          kbItems: { type: 'integer' },
          debugLogs: { type: 'integer' },
          chars: { type: 'integer' },
          ms: { type: 'integer' },
          text: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['text', 'score', 'index', 'type'],
              properties: {
                text: { type: 'string' },
                score: { type: 'number' },
                index: { type: 'integer' },
                type: { type: 'string' },
                is_echo: { type: 'boolean' },
                tags: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        const head = `ok=${v.ok} chat=${v.chatItems} kb=${v.kbItems} chars=${v.chars} ${v.ms}ms` + (v.error ? ` error=${v.error}` : '')
        return [{ type: 'text', text: `${head}\n\n${v.text || '(空)'}` }]
      },
    },
    async execute(args) {
      const t0 = Date.now()
      try {
        // ⛔ 真机实测（2026-09-16）：`ctx.agent` 在**没 inject `agent`** 时会**抛**
        //    （`cannot get property "agent" without inject`）—— 离线桩的假 ctx 太宽松，
        //    把这条盖住了 ⇒ 自检里已把假 ctx 改成**严格模式**（未声明属性就抛）。
        //    这里退化成"拿不到 agent"，`anima_query` 照常可用（按会话取词请显式传 `session_id`）。
        let agent = null
        try { agent = ctx.agent ?? null } catch { /* 未注入 agent ⇒ 只靠 args.session_id */ }
        let searchText = typeof args.query === 'string' ? args.query : ''
        let bm25SearchText = typeof args.bm25_query === 'string' ? args.bm25_query : ''
        if (!searchText && !bm25SearchText) {
          const sessionId = typeof args.session_id === 'string' ? args.session_id : agent?.id
          const evts = sessionId && agent?.id === sessionId ? snapshotEvents(agent) : []
          const msgs = extractMessages(evts, { skipLayerZero: cfg.skipLayerZero })
          searchText = buildVectorQuery(msgs, cfg) || lastUserText(msgs)
          bm25SearchText = buildBm25Text(msgs, { ...cfg.bm25, ...cfg })
        }

        const engine = await loadEngine()
        // ★ T3：`anima_query` 是 D13 之后的**主路径**（模型主动查），必须和每轮注入同一条隔离闸
        const iso = isolationPlan()
        if (iso.blocked) return { ok: false, error: null, reason: '周目隔离：' + iso.blocked, text: '', chatItems: 0, kbItems: 0, chars: 0, ms: Date.now() - t0 }
        const payload = buildPayload({ searchText, bm25SearchText, sessionKey: typeof args.session_id === 'string' ? args.session_id : (agent?.id ?? 'manual'), isolation: iso })
        if (args.echo_persist === false) payload.__echoPersistOverride = false
        const res = await engine.query(payload)
        const chat = Array.isArray(res?.merged_chat_results) ? res.merged_chat_results : []
        const kb = Array.isArray(res?.merged_kb_results) ? res.merged_kb_results : []
        const { text } = assembleInjection({ chatResults: chat, kbResults: kb, recentText: '', cfg: cfg.inject })

        const limit = Number.isSafeInteger(args.include_items) ? Math.max(0, Math.min(50, args.include_items)) : 0
        const items = limit > 0
          ? chat.slice(0, limit).map(it => ({
            text: String(it?.text ?? '').slice(0, 500),
            score: typeof it?.score === 'number' ? it.score : 0,
            index: Number.isSafeInteger(it?.index) ? it.index : -1,
            type: typeof it?.type === 'string' ? it.type : '',
            is_echo: it?.is_echo === true,
            tags: Array.isArray(it?.tags) ? it.tags.map(String) : [],
          }))
          : []

        return {
          ok: true, error: null, reason: null,
          searchText: searchText.slice(0, 500), bm25SearchText: bm25SearchText.slice(0, 500),
          chatItems: chat.length, kbItems: kb.length,
          debugLogs: Array.isArray(res?._debug_logs) ? res._debug_logs.length : 0,
          chars: text.length, ms: Date.now() - t0,
          text: text.slice(0, 4000),
          items,
        }
      } catch (e) {
        return {
          ok: false, error: e?.message ?? String(e), reason: 'error',
          searchText: '', bm25SearchText: '',
          chatItems: 0, kbItems: 0, debugLogs: 0, chars: 0, ms: Date.now() - t0,
          text: '', items: [],
        }
      }
    },
  })

  log(ctx, `已挂载 v${VERSION}: section="${SECTION_NAME}"@${cfg.inject.order} · 集合=${JSON.stringify(cfg.chatCollections)} · echoPersist=${cfg.echoPersist}`)
  if (!cfg.embed.key) warn(ctx, 'embed.key 未配置 —— 向量支线会失败（BM25 支线仍可用）。请在**记忆库设置 →「向量检索 API」**里保存密钥（本插件不再读环境变量）。')
}

export const config = { ...DEFAULTS }
export const version = VERSION
