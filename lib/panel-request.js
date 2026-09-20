/**
 * panel-request —— 面板动作的**请求单 / 回执 / 状态快照**三张文件（形状与常量在这里唯一定义）。
 *
 * ## 为什么是文件而不是 HTTP
 * 面板在**宿主平面**（`dsh-memory-archive`，挂在 profile 上、有 webServer），而真正干活的引擎
 * 在**会话平面**（`dsh-anima-rag`，被 roleplay 预设按会话挂载；`insertSlices` / 账本 / 引擎实例
 * 全在 `apply()` 的闭包里，外面拿不到）。而"入库"这件事**只能有一份实现**（否则就是我们反复
 * 消灭的"两份真相"）⇒ 面板只写一张**请求单**，anima 在它的下一脚（每轮装配都会跑一次
 * `kickAutoIngest`）取走执行，再把**回执**写回来。三张文件都在 `<DSH_HOME>/dsh-anima-rag/`。
 *
 * ## 三张文件
 *   · `panel-request.json` —— 面板 → anima：`{id, action, at, note}`（一次一张，后写覆盖前一张）
 *   · `panel-result.json`  —— anima → 面板：`{id, action, ok, message, at, counts?}`
 *   · `vector-info.json`   —— anima → 面板：状态快照（数据根、集合、隔离统计、库/BM25 计数、
 *                             账本与入库状态、最近一次动作）。面板只读它，⛔ 不自己解析 anima 的配置。
 *
 * ## ⚠️ 常量会被**两份**代码读（本模块 + `dsh-memory-archive/lib/vector-panel.js`）
 * 跨包没法共享模块（两个 package 各自部署）⇒ 复制一份常量，并靠自检台盯漂移
 * （`_selftest-panel-contract.mjs`：逐字比对两边的动作名与文件名）。
 */

/** 面板能请求的动作（⛔ 白名单：不认识的 action 一律拒绝，不猜）。 */
export const PANEL_ACTIONS = ['ingest-now', 'rebuild', 'delete-vector', 'delete-bm25']

/** 动作的中文短名（面板与日志共用同一份措辞）。 */
export const PANEL_ACTION_LABELS = {
  'ingest-now': '立即入库',
  'rebuild': '重建（向量 + BM25）',
  'delete-vector': '删除向量库',
  'delete-bm25': '删除 BM25 库',
}

export const PANEL_REQUEST_FILE = 'panel-request.json'
export const PANEL_RESULT_FILE = 'panel-result.json'
export const VECTOR_INFO_FILE = 'vector-info.json'
/** 删库不是"销毁"：一律改名成这个前缀 + 时间戳留档（与全仓"改名归档，不直接删"同口径）。 */
export const PANEL_REMOVED_PREFIX = 'removed-'

/** 动作名是否认识。 */
export function isKnownAction(action) {
  return typeof action === 'string' && PANEL_ACTIONS.includes(action)
}

/** 动作的中文短名（不认识的动作如实回显它自己，⛔ 不编）。 */
export function actionLabel(action) {
  return PANEL_ACTION_LABELS[action] ?? String(action ?? '')
}

/**
 * 面板那张请求单的形状校验：认识的 action + 有 id。
 * @param {unknown} doc - 读进来的 JSON（可能是任何形状）。
 * @returns {{ok: true, id: string, action: string, note: string} | {ok: false, reason: string}}
 */
export function parsePanelRequest(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'not-an-object' }
  const action = typeof doc.action === 'string' ? doc.action : ''
  if (!isKnownAction(action)) return { ok: false, reason: `unknown-action:${action}` }
  const id = typeof doc.id === 'string' && doc.id !== '' ? doc.id : ''
  if (id === '') return { ok: false, reason: 'missing-id' }
  return { ok: true, id, action, note: typeof doc.note === 'string' ? doc.note : '' }
}

/** 一张请求单（面板侧用的构造函数；形状与 `parsePanelRequest` 对得上）。 */
export function makePanelRequest({ id, action, note = '', at = Date.now() }) {
  return { version: 1, id: String(id), action: String(action), note: String(note), at }
}

/** 一张回执。 */

export function makePanelResult({ id, action, ok, message, counts = null, at = Date.now() }) {
  return {
    version: 1, id: String(id), action: String(action), ok: ok === true,
    message: String(message ?? ''), counts, at,
  }
}

/**
 * 「为什么召不回来」——把空结果**说清楚**（用户口径：「至少它是静默失败」，要反馈给 agent 与用户）。
 *
 * 判据全部来自事实（调用方给）：隔离计划的 total/bound/denied、向量库与 BM25 库在不在、
 * 检索回来的条数。⛔ 不猜、不编；没有话说就返回空数组（面板/工具结果里就不加噪音）。
 *
 * @param {{iso?: object|null, vectorExists?: boolean, bm25Exists?: boolean, chatItems?: number, kbItems?: number, boundLabel?: string}} p
 * @returns {string[]} 给人和模型看的短句（最多 3 条，最重要的在前）。
 */
export function explainRetrieval(p = {}) {
  const out = []
  const iso = p.iso && typeof p.iso === 'object' ? p.iso : null
  const total = iso && Number.isFinite(iso.total) ? iso.total : null
  const denied = iso && Array.isArray(iso.denyIndexes) ? iso.denyIndexes.length : null
  const bound = iso && typeof iso.bound === 'string' ? iso.bound : ''
  const who = typeof p.boundLabel === 'string' && p.boundLabel !== '' ? p.boundLabel : '绑定'
  if (iso && iso.blocked) {
    out.push(`周目隔离拦下了本轮检索：${iso.blocked}（拿不到周目时宁可不出场，也不串味）`)
  } else if (total !== null && denied !== null && total > 0 && denied >= total) {
    out.push(`隔离把候选池清空了：库里 ${total} 条**全部**不属于${who}的周目（${bound || '未知'}）`
      + '⇒ 检索必然 0 命中。要么切回那个周目，要么把库重建到当前周目。')
  } else if (total !== null && denied !== null && denied > 0) {
    out.push(`隔离排除了 ${denied}/${total} 条非本周目切片（${who}的周目 ${bound || '未知'}）—— 剩下的才是可召回的。`)
  }
  if (p.vectorExists === false) {
    out.push('向量库不存在（还没建 / 被删了）⇒ 向量支线没有东西可查；它会在入库时建立。')
  }
  if (p.bm25Exists === false) {
    out.push('BM25 库不存在 ⇒ 模糊支线没有东西可查；它和向量库在**同一次入库**里一起写。')
  }
  const chat = Number.isFinite(p.chatItems) ? p.chatItems : null
  const kb = Number.isFinite(p.kbItems) ? p.kbItems : null
  if (chat === 0 && kb === 0 && out.length === 0) {
    out.push('库在、隔离也没拦，但确实没有命中 ⇒ 这个周目还没有可回忆的切片（或检索词太偏）。')
  }
  return out.slice(0, 3)
}

/**
 * 状态快照的骨架（anima 侧填；缺字段一律如实留空，⛔ 不编造）。
 * @param {object} p - 各字段。
 * @returns {object} 可直接 `JSON.stringify` 的快照。
 */
export function makeVectorInfo({
  dataRoots = {}, collectionId = '', isolation = null, vector = null, bm25 = null,
  ingest = null, ledger = null, lastAction = null, pendingRequest = null, at = Date.now(),
} = {}) {
  return {
    version: 1,
    at,
    dataRoots: { vectorRoot: '', bm25Root: '', sessionRoot: '', ...dataRoots },
    collectionId: String(collectionId ?? ''),
    isolation,
    vector,
    bm25,
    ingest,
    ledger,
    lastAction,
    pendingRequest,
  }
}
