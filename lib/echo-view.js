/**
 * echo-view —— 「回响」那一格（`<memoryEcho>`）的装配件。
 *
 * ## 它取代了什么（2026-09-26，T2「让 anima 接管回响」）
 * 改前 `<memoryEcho>` 由 `dsh-memory-archive` 自己算：**fts5（SQLite trigram）关键词命中**
 * —— 拿最近一轮消息切 3 字窗口、按 df 筛、短语 MATCH 归档楼层原文。用户口径（逐字）：
 * 「3 把anima也加入回响吧。**也就是自动触发**」「我没看到有anima的recall，只看到了fts5注入的，
 * **anima字段是空的**」。
 *
 * 现在这一格装的**就是本轮语义检索的命中**（与 `<recalledMemories>` 同一份
 * `merged_chat_results`），仍然是**每轮装配那一脚**里算的
 * （⛔ 无定时器、⛔ 无轮询、⛔ 不改时机）。
 *
 * ## 与 memory-archive 那一版的**保留**与**不保留**
 * 保留（用户对"注入进去长什么样"有肌肉记忆，形状不动）：
 *   · 外层 `<memoryEcho>` … `</memoryEcho>`；前言一句「都是已经发生过的事、锚点优先」；
 *   · 每条一行、行首带来源标签（原为 `[楼 0129]`，见下）；
 *   · 超预算/被截断**一律带标注**（`…［片段已截断］` / `［已截断：…］`），⛔ 绝不静默。
 * 不保留：库、候选抽取、df 筛选、`[来源]`列 —— 那些都是 fts5 那条路的东西，随 T3 一起摘掉。
 *
 * ## 行首标签怎么来的
 * anima 的切片身份是 `metadata.index`，我们自己的记忆库长这样：`sum_mt-0100-0129-1`
 * （`<前缀>_<切片文件名>`，切片名里的 `mt-<起>-<止>` 就是**归档楼层区间**）
 * ⇒ 渲染成 `[楼 0100-0129]`，与改前的 `[楼 0129]` 同一套读法。
 * 认不出楼层区间的（例如 ST 侧那些 `影子_*` 历史库，索引是 `1_2` 这种）如实渲染成
 * `[记忆 1_2]` —— ⛔ 不编一个楼层号出来。
 *
 * ## 顺序与 life
 * · 顺序**沿用引擎给的顺序**（`merged_chat_results` 已按时间排好），⛔ 不在这里重排 ——
 *   否则同一批记忆在 `<memoryEcho>` 与 `<recalledMemories>` 里会是两种次序，模型更容易读岔。
 * · `is_echo`（被 anima 的 life 机制续命、不是自然召回）的条目行尾加 `（回响续命）`。
 *   **life 衰减不在本模块做**：它只由 `engine.js` 的 `processEchoLogic` 一处负责，
 *   本模块是它的**视图**（理由写在 `lib/index.js` 的 `DEFAULTS.inject.echo` 注释里）。
 */

/** 注入文本的前言（逐字固定，自检台钉住）。 */
export const ECHO_PREAMBLE =
  '（历史回响：下面是语义检索命中的过往记忆摘要——都是已经发生过的事，不是此刻；与 <storyAnchor> 当前坐标冲突时，一律以锚点为准。）'

/** 单条片段被截断时的行尾标注（不静默）。 */
const CUT_MARK = '…［片段已截断］'

/** 超出预算/条数时的总结标注（不静默）。 */
const overflowNotice = (maxChars, topK, kept, total) =>
  `［已截断：回响预算 ${maxChars} 字 / 最多 ${topK} 条，本轮保留 ${kept}/${total} 条］`

/** 预留给总结标注的空间（标注自身也要算进预算）。 */
const NOTICE_RESERVE = 80

/**
 * 从切片的 `index` 里认出归档楼层区间。
 * `sum_mt-0100-0129-1` ⇒ `'0100-0129'`；认不出 ⇒ `''`（调用方如实退回切片名）。
 */
export function floorRangeOf(index) {
  const m = /(?:^|[^0-9])mt-(\d{1,5})-(\d{1,5})/i.exec(String(index ?? ''))
  if (!m) return ''
  const pad = (s) => String(Number(s)).padStart(4, '0')
  return `${pad(m[1])}-${pad(m[2])}`
}

/** 一行的行首标签：认得出楼层区间用 `[楼 0100-0129]`，认不出用 `[记忆 <切片名>]`。 */
export function hitLabel(hit) {
  const range = floorRangeOf(hit?.index)
  if (range !== '') return `[楼 ${range}]`
  const name = String(hit?.index ?? '').trim()
  return name === '' ? '[记忆 ?]' : `[记忆 ${name}]`
}

/**
 * 把本轮语义命中渲染成 `<memoryEcho>` 块。**纯函数**（无 IO、无时间、无全局状态）。
 *
 * @param {Array<{text?:string,index?:string|number,is_echo?:boolean}>} hits
 *        anima 的 `merged_chat_results`（原样喂进来即可）。
 * @param {{topK?:number,maxChars?:number,perHitChars?:number}} [opts]
 * @returns {string} 空命中 / 关闭 / 预算小到放不下 ⇒ 返回 `''`（本轮**不注入这一格**）。
 */
export function buildEchoSlot(hits, opts = {}) {
  const maxChars = Math.max(240, Math.trunc(Number(opts.maxChars ?? 1200)))
  const perHitChars = Math.max(20, Math.trunc(Number(opts.perHitChars ?? 280)))
  const topK = Math.max(1, Math.trunc(Number(opts.topK ?? 5)))

  const clean = (Array.isArray(hits) ? hits : []).filter(
    (h) => h != null && typeof h.text === 'string' && h.text.trim() !== '',
  )
  if (clean.length === 0) return ''

  const picked = clean.slice(0, topK)
  const header = '<memoryEcho>\n' + ECHO_PREAMBLE
  const footer = '\n</memoryEcho>'
  const bodyBudget = maxChars - header.length - footer.length - NOTICE_RESERVE
  if (bodyBudget < 40) return '' // 预算小到放不下任何一条 ⇒ 宁可不注入也不给烂壳

  const lines = []
  let used = 0
  let kept = 0
  let cutAny = false
  let overflow = false
  for (const h of picked) {
    const mark = h.is_echo === true ? '（回响续命）' : ''
    let snippet = String(h.text).replace(/\s+/g, ' ').trim()
    let cut = false
    if (snippet.length > perHitChars) { snippet = snippet.slice(0, perHitChars); cut = true }
    const line = `${hitLabel(h)} ${snippet}${cut ? CUT_MARK : ''}${mark}`
    const remain = bodyBudget - used
    if (line.length <= remain) {
      lines.push(line)
      used += line.length + 1
      kept++
      if (cut) cutAny = true
    } else {
      const room = remain - CUT_MARK.length - mark.length
      if (room >= 40) {
        lines.push(`${hitLabel(h)} ${snippet.slice(0, room)}${CUT_MARK}${mark}`)
        kept++
      }
      cutAny = true
      overflow = true
      break // 预算见底，后面的条一律放不下
    }
  }

  const dropped = clean.length - kept
  let out = header
  for (const line of lines) out += '\n' + line
  if (cutAny || dropped > 0) out += '\n' + overflowNotice(maxChars, topK, kept, clean.length)
  out += footer
  // 防御性兜底：任何路径下都不许超预算（真超了就硬切并补标注 —— 仍然不静默）
  if (out.length > maxChars) out = out.slice(0, maxChars - 1) + '…'
  return out
}
