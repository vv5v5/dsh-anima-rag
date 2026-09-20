// ---------------------------------------------------------------------------
// session-playthrough —— 「**活跃会话**属于哪个周目」的**纯函数核心**。
//
// ## 它解决什么
// 检索侧原来的「当前周目」是**面板配置里的一个全局值**（`dsh-memory-archive/config.json`
// 的 `root.playthroughId`）——跟**你此刻在玩哪一场**无关。于是在 Tavern 里切了周目：
//   · 读：检索仍按面板那个周目过滤 ⇒ 要么读到别的周目的记忆，要么全空；
//   · 写：自动入库也只收面板那个周目的 summaries ⇒ 库里的东西跟活跃会话不是一套。
// 本模块把「活跃会话」翻译成「周目」，让读/写两侧都能按它走（解析不出来时回落面板绑定值，
// 与改前的语义完全一致 ⇒ 不会因为解析失败而"不过滤"）。
//
// ## 数据从哪来（都是普通文件，⛔ 不连 Tavern、不连宿主）
//   · `catalog.json`：`playthroughs[].{ id, path, ext.pmpDshTavern.rootSessionId }`
//     （`path` 形如 `<角色>/<周目>/timeline.json`）
//   · `<角色>/<周目>/timeline.json`：`{ nodes[].variants[].sessionId, head.sessionId }`
//     —— 一个周目会有**多条**会话（继续/分支都在里面），所以映射不能只看 rootSessionId。
//
// ## 为什么是纯函数文件
// 解析 / 索引 / 决策全部零宿主依赖 ⇒ 自检台不碰宿主就能跑满行为级断言
// （`_selftest-session-playthrough.mjs`，含反证与**真机锚**）。
// 宿主侧的读盘与缓存（按 mtime 失效）在 lib/index.js。
//
// @license CC-BY-NC-4.0 (Attribution-NonCommercial 4.0 International)
// ---------------------------------------------------------------------------

/** 计划版本：行为变了就 +1（自检台钉住它）。 */
export const SESSION_PLAYTHROUGH_VERSION = 1

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v.trim() : '')

/**
 * 从 catalog 条目取**周目 id**：优先 `id`；退而求其次从 `path` 的倒数第二段取
 * （`<角色>/<周目>/timeline.json` ⇒ 取 `<周目>`）。都拿不到 ⇒ `''`。
 */
export function playthroughIdOf(entry) {
  if (!isRecord(entry)) return ''
  const id = str(entry.id)
  if (id !== '') return id
  const path = str(entry.path)
  if (path === '') return ''
  const parts = path.split(/[\\/]+/).filter((p) => p !== '')
  // `…/<周目>/timeline.json` ⇒ 倒数第二个
  return parts.length >= 2 ? parts[parts.length - 2] : ''
}

/** 从 catalog 条目取**根会话 id**（`ext.pmpDshTavern.rootSessionId`）；拿不到 ⇒ `''`。 */
export function rootSessionIdOf(entry) {
  if (!isRecord(entry)) return ''
  return str(entry.ext?.pmpDshTavern?.rootSessionId)
}

/** 从 catalog 条目取**角色 id**：优先 `ext.pmpDshTavern.characterId`，退而从 `path` 的首段取。 */
export function characterIdOf(entry) {
  if (!isRecord(entry)) return ''
  const id = str(entry.ext?.pmpDshTavern?.characterId)
  if (id !== '') return id
  const path = str(entry.path)
  if (path === '') return ''
  const parts = path.split(/[\\/]+/).filter((p) => p !== '')
  return parts.length >= 2 ? parts[0] : ''
}

/**
 * 周目的**目录**（相对 `workspaceBase`）：`<角色>/<周目>`。
 * 优先从 `path` 的前两段取（`<角色>/<周目>/timeline.json`）—— 那是真机上唯一权威的写法；
 * `path` 不可用才用 `characterId/playthroughId` 兜（两者都缺 ⇒ `''`）。
 */
export function playthroughDirOf(entry) {
  if (!isRecord(entry)) return ''
  const path = str(entry.path)
  if (path !== '') {
    const parts = path.split(/[\\/]+/).filter((p) => p !== '')
    if (parts.length >= 3) return parts.slice(0, parts.length - 1).join('/')
  }
  const char = characterIdOf(entry)
  const pt = playthroughIdOf(entry)
  return char !== '' && pt !== '' ? `${char}/${pt}` : ''
}

/**
 * `timeline.json` 里出现过的**所有会话 id**：`head.sessionId` ∪ 各 `nodes[].variants[].sessionId`。
 * 形状不对的条目一律跳过（⛔ 不抛、不猜）。
 */
export function sessionIdsOfTimeline(timeline) {
  const out = new Set()
  if (!isRecord(timeline)) return out
  const head = str(timeline.head?.sessionId)
  if (head !== '') out.add(head)
  const nodes = Array.isArray(timeline.nodes) ? timeline.nodes : []
  for (const node of nodes) {
    if (!isRecord(node)) continue
    const variants = Array.isArray(node.variants) ? node.variants : []
    for (const variant of variants) {
      if (!isRecord(variant)) continue
      const id = str(variant.sessionId)
      if (id !== '') out.add(id)
    }
  }
  return out
}

/**
 * 造「会话 → 周目」索引（纯函数）。
 *
 * @param {Array<{ entry?: object, timeline?: object }>} rows
 *   一个周目一行：`entry` = catalog 条目、`timeline` = 它的 timeline.json（读不到给 null）。
 *   行序 = catalog 顺序 ⇒ **先到者胜**（同一个会话出现在两个周目里时，取先出现的那条）。
 * @returns {{ map: Map<string,string>, byId: Map<string,{characterId:string,dir:string}>, playthroughs: number, sessions: number, conflicts: string[] }}
 *   `conflicts` = 命中过多个周目的会话 id（如实回报，⛔ 不静默丢）；
 *   `byId` = 周目 id → `{ characterId, dir }`（写侧要拿 `dir` 拼 `<base>/<dir>/archive/summaries`）。
 */
export function buildSessionIndex(rows) {
  const map = new Map()
  const byId = new Map()
  const conflicts = []
  let playthroughs = 0
  const list = Array.isArray(rows) ? rows : []
  for (const row of list) {
    if (!isRecord(row)) continue
    const playthroughId = playthroughIdOf(row.entry)
    if (playthroughId === '') continue
    playthroughs += 1
    if (!byId.has(playthroughId)) {
      byId.set(playthroughId, { characterId: characterIdOf(row.entry), dir: playthroughDirOf(row.entry) })
    }
    const ids = new Set(sessionIdsOfTimeline(row.timeline))
    const root = rootSessionIdOf(row.entry)
    if (root !== '') ids.add(root)
    for (const id of ids) {
      const existing = map.get(id)
      if (existing === undefined) { map.set(id, playthroughId); continue }
      if (existing !== playthroughId && !conflicts.includes(id)) conflicts.push(id)
    }
  }
  return { map, byId, playthroughs, sessions: map.size, conflicts }
}

/**
 * 解析「这个会话属于哪个周目」（纯函数）。★ **会话优先**，解析不出才用 `fallback`
 * （`fallback` = 面板绑定值 ⇒ 与改前的语义一致）。
 *
 * @param {{ map?: Map<string,string> }|null} index - `buildSessionIndex` 的产物（或 null）。
 * @param {string} sessionId
 * @param {string} fallback - 面板配置里的绑定周目（可空）。
 * @returns {{ bound: string, source: 'session'|'config'|'none' }}
 *   `source` 如实标注判词是谁给的 ⇒ 排障时一眼看出"到底跟了谁"。
 */
export function resolvePlaythroughForSession(index, sessionId, fallback) {
  const fb = str(fallback)
  const sid = str(sessionId)
  const map = index && index.map instanceof Map ? index.map : null
  if (sid !== '' && map !== null) {
    const hit = str(map.get(sid))
    if (hit !== '') return { bound: hit, source: 'session' }
  }
  if (fb !== '') return { bound: fb, source: 'config' }
  return { bound: '', source: 'none' }
}
