/**
 * playthrough-isolate —— 「这次检索允许召回哪些切片」的**周目隔离**判据（纯逻辑、零 IO、可自检）。
 *
 * ## 它堵的是哪个洞（2026-09-18 真机查实）
 * **写侧一直按周目打标**（归档按 `archive/<角色>/<周目>/` 分目录，切片带 `pt:<周目id>` 标签
 * —— 真机 `dsh-memory` 62 条里 49 条带当前周目标签），
 * **但读侧从来不看这个标签**：`composePayload` 只按固定的 `chatCollections` 列表查、
 * `session-selections.json` 里 102 个会话也没有一个带 per-session collectionId。
 * ⇒ 实际效果是**一个共享记忆池**：跨周目会互相召回。
 *
 * 用户口径（2026-09-18）：「跨周目不是这么跨的。先做好基础功能，**分周目隔离**，
 * 再说跨周目的事情。」⇒ 隔离是默认，跨周目延续是以后单说的事。
 *
 * ## 判据
 * 只认带 `pt:<绑定周目>` 标签的切片；**没有这个标签的一律当"不是本周目"排除**
 * （包括 `影子_-0906重开` 那类历史池 —— 它们在隔离模式下整个不参与）。
 *
 * ## ⛔ fail-closed 的语义（隔离就是"宁可不给，也不串味"）
 *   拿不到绑定周目 ⇒ **本轮不注入**（不是"那就不过滤"——那正是串味）。
 *   索引文件**读得到但解析不了** ⇒ 同样不注入。
 *   文件**不存在** ⇒ 不算错（还没建库 ⇒ 本来就没有可召回的），deny 空集。
 */

/** 切片标签里的周目前缀（与 `index.js` 的 `PT_PREFIX` 同一套）。 */
export const PT_PREFIX = 'pt:'

export function ptTagOf(playthroughId) {
  return PT_PREFIX + String(playthroughId ?? '')
}

/** 取一条 vectra item 的 tags（畸形一律当空数组，不抛）。 */
export function tagsOf(item) {
  const t = item?.metadata?.tags
  return Array.isArray(t) ? t.map(String) : []
}

/** 取一条 vectra item 的切片 index（两种落法都认，畸形给空串）。 */
export function sliceIndexOf(item) {
  return String(item?.metadata?.index ?? item?.index ?? '')
}

/**
 * 算出「必须排除」的切片 index 名单 = 库里所有**不带** `pt:<bound>` 标签的切片。
 * ★ 为什么算 deny 而不是 allow：`ignore_ids → {index:{$nin:[...]}}` 是**已经打通并已在用**
 *   的一条路（引擎、BM25、回声全走它），而 allow 得给引擎加新参数 ⇒ 零引擎改动 = 零回归面。
 *   等价性：`{index:{$in:允许集}}` ≡ `{index:{$nin:其余全部}}`。
 */
export function denyIndexesForPlaythrough(items, bound) {
  const want = ptTagOf(bound)
  const deny = []
  for (const it of (Array.isArray(items) ? items : [])) {
    if (tagsOf(it).includes(want)) continue
    const idx = sliceIndexOf(it)
    if (idx !== '') deny.push(idx)
  }
  return deny
}

/**
 * 过闸判定：返回 `null`（放行）或一个**原因码**（本轮不注入）。
 * @param {{enabled: boolean, bound: string, indexReadable: boolean}} p
 *   `indexReadable`：索引文件**存在且解析成功** ⇒ true；不存在 ⇒ 也传 true（不算错）；
 *   存在但解析失败 ⇒ false。
 */
export function isolationBlockReason({ enabled, bound, indexReadable }) {
  if (enabled !== true) return null
  if (String(bound ?? '') === '') return 'no-bound-playthrough'
  if (indexReadable === false) return 'bad-vector-index'
  return null
}

/** 汇总一行给人看的隔离状态（日志/状态端点共用同一个口径）。 */
export function isolationSummary({ collectionId, bound, denyCount, total }) {
  return `${collectionId} 绑定 ${bound} ⇒ 排除 ${denyCount}/${total} 条非本周目切片`
}
