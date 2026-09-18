/**
 * orphan-reconcile —— 「这条切片还有没有资格留在库里」的对账（**纯逻辑、零 IO、可自检**）。
 *
 * ## 它堵的是哪个洞（2026-09-18 真机查实）
 * 入库是**按文件名**判重的（台账 `ledger.has(file, signature)`），而检索是**按库里的切片**走的
 * —— 两者之间**从来没有对账**。于是一旦
 *   · 某个摘要文件**改名**（实测发生过：`s-0000-0019.md` → `s-0000-0019-1/2/3.md`），或
 *   · 两条写入路径的 id 格式不一致（`autoIngestOnce` 生成 `sum_<文件>.md`、
 *     `slicesFromDir` 生成 `sum_<文件>`，`.md` 去留不同），
 * 旧切片就**既不覆盖也不删除**地留下来，**照旧参与检索**。
 *
 * 真机账（`dsh-memory` 集合 62 条）：**49 条好的 / 10 条孤儿 / 1 条 import 清单 / 2 条测试残留**。
 * 其中一条孤儿是总结器的**提示词回声**（`Do NOT use time/location change…`）——
 * 它每轮都可能被检索进 system，是「垃圾占检索位」里最坏的一种。
 *
 * ## 判据（一句话）
 * **以 `summaries/index.json` 当前列出的条目为白名单**：库里 `sum_` 开头、key 不在白名单里的 ⇒ 孤儿。
 * 判据**与格式无关**（带不带 `.md` 都按同一个 key 比）⇒ 上面那两种历史格式都能对上账。
 *
 * ## 两条 fail-closed 护栏（⛔ 少一条都可能把用户的记忆清光）
 *   1. **白名单为空 ⇒ 一条都不删**（index.json 读不到/被清空/还没生成）。判据与
 *      `anima_forget` 的「保留者一条切片都读不到 ⇒ 拒绝清空」同一哲学。
 *   2. **不是我们前缀的切片一律不动**（来源不明：可能是别处正经灌进来的内容）—— 计入 `skipped` 并打日志。
 *
 * ⛔ 本模块**只出计划、不碰盘**；真的删由调用方做。
 * ★ 删是**干净删**：用户口径（2026-09-18）「向量库和孤儿总结一起删掉」⇒ **不留档、不备份**。
 */

/** 切片 index 的默认前缀（与 `ingest.indexPrefix` 同源，默认 `sum`）。 */
export const DEFAULT_INDEX_PREFIX = 'sum'

/** 归档侧的摘要文件扩展名（对账时按 key 比，扩展名不参与比较）。 */
const FILE_EXT_RE = /\.(md|txt|json)$/i

/**
 * 把一条**切片 index** 归一成对账用的 key。
 *   `sum_s-0000-0019.md` → `'s-0000-0019'`
 *   `sum_s-0000-0019`    → `'s-0000-0019'`（两种历史格式必须落到同一个 key）
 *   不是本前缀（如 `probe_1`）→ `null`（调用方据此「不动」）
 */
export function sliceKeyOf(index, prefix = DEFAULT_INDEX_PREFIX) {
  const s = String(index ?? '')
  const head = String(prefix) + '_'
  if (s === '' || !s.startsWith(head)) return null
  const rest = s.slice(head.length).replace(FILE_EXT_RE, '')
  return rest === '' ? null : rest
}

/** 归档条目文件名 → key（`s-0000-0019-1.md` → `s-0000-0019-1`）。 */
export function entryKeyOf(file) {
  return String(file ?? '').replace(FILE_EXT_RE, '')
}

/**
 * 默认「这条目不该入」的判据：`import-*` 是**导入批次清单**（来源格式/哈希/体积/楼层数），
 * 不是内容摘要 —— 与 ingest 侧（`index.js` 三处）用的是同一条判据。
 * ⛔ 列在 index.json 里 ≠ 有资格当记忆；白名单必须把这类剔掉，否则那条清单**永远不会**被判成孤儿。
 */
export function defaultExcludeEntry(e) {
  return String(e?.id ?? '').startsWith('import-')
}

/**
 * 当前 `index.json` 的条目 → 白名单 key 集合。
 * @param {Array} entries `index.json` 的 `entries`
 * @param {{prefix?: string, isExcluded?: (e:any)=>boolean}} [opts]
 */
export function allowedKeysFromEntries(entries, opts = {}) {
  const out = new Set()
  if (!Array.isArray(entries)) return out
  const isExcluded = typeof opts.isExcluded === 'function' ? opts.isExcluded : defaultExcludeEntry
  for (const e of entries) {
    if (!e || typeof e.file !== 'string' || e.file === '') continue
    if (isExcluded(e)) continue
    const k = entryKeyOf(e.file)
    if (k !== '') out.add(k)
  }
  return out
}

/**
 * 对账：库里的 items ↔ 白名单。
 * @param {Array} items `vectors/<col>/index.json` 的 `items`
 * @param {Set<string>|Array<string>} allowedKeys
 * @param {{prefix?: string}} [opts]
 * @returns {{orphans: Array<{id:any,index:string,key:string,why:string}>, kept: number, skipped: Array<{id:any,index:string,why:string}>}}
 */
export function findOrphanSlices(items, allowedKeys, opts = {}) {
  const prefix = opts.prefix ?? DEFAULT_INDEX_PREFIX
  const allowed = allowedKeys instanceof Set ? allowedKeys : new Set(allowedKeys ?? [])
  const orphans = []
  const skipped = []
  let kept = 0
  for (const it of (Array.isArray(items) ? items : [])) {
    const idx = String(it?.metadata?.index ?? it?.index ?? '')
    const key = sliceKeyOf(idx, prefix)
    if (key === null) {
      skipped.push({ id: it?.id ?? null, index: idx, why: '不是本前缀的切片（来源不明 ⇒ 不动）' })
      continue
    }
    if (allowed.has(key)) { kept += 1; continue }
    orphans.push({ id: it?.id ?? null, index: idx, key, why: '源条目已不在 summaries/index.json 里（改名 / 已删 / 本就不该入）' })
  }
  return { orphans, kept, skipped }
}

/**
 * 护栏 1：白名单为空 ⇒ 拒绝动手。单独抽成函数是为了让它**必被自检**。
 * @returns {{ok: boolean, reason: string|null}}
 */
export function decideReconcile({ allowedCount, itemCount }) {
  if (!Number.isFinite(allowedCount) || allowedCount <= 0) {
    return { ok: false, reason: '白名单是空的（index.json 读不到/被清空/尚未生成）⇒ 一条都不删' }
  }
  if (!Number.isFinite(itemCount) || itemCount <= 0) {
    return { ok: false, reason: '库里没有切片 ⇒ 无事可做' }
  }
  return { ok: true, reason: null }
}

/**
 * 去掉指定 id 的 items，**其余字段原样保留**（vectra 的 `version` / `metadata_config` 不许动）。
 * @returns {{next: object, removed: Array<any>}}
 */
export function planVectorPrune(indexJson, orphanIds) {
  const ids = new Set((Array.isArray(orphanIds) ? orphanIds : []).map((x) => String(x)))
  const src = indexJson && typeof indexJson === 'object' ? indexJson : {}
  const items = Array.isArray(src.items) ? src.items : []
  const removed = []
  const kept = []
  for (const it of items) {
    if (it && ids.has(String(it.id))) removed.push(it)
    else kept.push(it)
  }
  return { next: { ...src, items: kept }, removed }
}

/**
 * BM25 侧：按切片 `index` 反查要交给 `bm25.deleteDocuments(col, ids)` 的**文档 id**。
 *
 * ★★ 这里有个**静默失效**的坑，2026-09-18 拿真文件核出来的：
 *   `data/bm25_indexes/<col>.json` 的 `storedFields` **键**是 MiniSearch 的内部编号
 *   （真机实测 `"0" / "2" / "6" / "58" / "154"`），**不是**文档 id；
 *   文档 id 在 `storedFields[k].id` 里，真机实测是 **UUID 字符串**
 *   （`"643dfa09-1ee5-47cd-87ff-18cd7f416b54"`，= vectra 那条 item 的 id）。
 *   `deleteDocuments` 内部走的是 `miniSearch.has(id)` ⇒ **必须给文档 id**。
 *   给错键的后果不是报错，是 `has()` 一律 false ⇒ **什么都没删、却看着像删了**。
 *   ⇒ 所以这里只认 `v.id`；拿不到 id 的**宁可不返回**（调用方据此少删，不会误删）。
 */
export function bm25IdsForIndexes(storedFields, indexes) {
  const want = new Set((Array.isArray(indexes) ? indexes : []).map((x) => String(x)))
  const out = []
  if (!storedFields || typeof storedFields !== 'object') return out
  for (const v of Object.values(storedFields)) {
    const idx = String(v?.index ?? '')
    if (idx === '' || !want.has(idx)) continue
    const id = v?.id
    if (id === undefined || id === null || String(id) === '') continue   // ⛔ 不拿键兜底
    out.push(String(id))
  }
  return out
}

/** 被删切片的 per-item 元数据文件名（vectra 把每条元数据单独落盘；`metadataFile` 有就用它）。 */
export function metadataFileNamesOf(removedItems) {
  const out = []
  for (const it of (Array.isArray(removedItems) ? removedItems : [])) {
    const f = it?.metadataFile
    if (typeof f === 'string' && f !== '') out.push(f)
    else if (typeof it?.id === 'string' && it.id !== '') out.push(`${it.id}.json`)
  }
  return out
}

