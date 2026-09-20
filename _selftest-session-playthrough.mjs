// _selftest-session-playthrough.mjs —— lib/session-playthrough.js 的行为级自检（纯函数，不碰宿主）。
//
// 口径照项目惯例：每组断言都带**反证**（不能只看"该命中时命中了"，还要看"解析不出时**回落**、
// 而不是变成不过滤"）。最后一组是**真机锚**：拿真实 catalog.json + 两个 timeline.json 断言
// 「两个周目的根会话各自映射到自己那个周目」—— 这是"会话→周目"这条路到底通不通的硬证据。
//
// 退出码：全绿 0 / 有红 1（用 process.exitCode）。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SESSION_PLAYTHROUGH_VERSION,
  playthroughIdOf, rootSessionIdOf, sessionIdsOfTimeline,
  characterIdOf, playthroughDirOf,
  buildSessionIndex, resolvePlaythroughForSession,
} from './lib/session-playthrough.js'

let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : '  ← ' + String(extra)}`)
}
const PT_A = 'playthrough-aaaa-1111'
const PT_B = 'playthrough-bbbb-2222'
const S_ROOT_A = 'session-root-a'
const S_BRANCH_A = 'session-branch-a'
const S_ROOT_B = 'session-root-b'

// ───────── ① 形状解析（含反证：畸形输入一律不抛、不猜）─────────
check('① 版本是正整数', Number.isInteger(SESSION_PLAYTHROUGH_VERSION) && SESSION_PLAYTHROUGH_VERSION > 0)

{
  check('① playthroughIdOf：优先 id 字段',
    playthroughIdOf({ id: PT_A, path: 'C/x/timeline.json' }) === PT_A)
  check('① playthroughIdOf：没有 id ⇒ 从 path 倒数第二段取（`<角色>/<周目>/timeline.json`）',
    playthroughIdOf({ path: 'Char1/' + PT_B + '/timeline.json' }) === PT_B,
    playthroughIdOf({ path: 'Char1/' + PT_B + '/timeline.json' }))
  check('① playthroughIdOf：Windows 反斜杠也认',
    playthroughIdOf({ path: 'Char1\\' + PT_B + '\\timeline.json' }) === PT_B)
  check('① ★反证：路径段不够/空/非字符串 ⇒ 空串（不猜）', (() => {
    for (const v of [null, undefined, 1, {}, { path: 'timeline.json' }, { path: '' }, { id: '   ' }]) {
      if (playthroughIdOf(v) !== '') return false
    }
    return true
  })())
}

check('① rootSessionIdOf：取 ext.pmpDshTavern.rootSessionId；缺了 ⇒ 空串', (() => {
  if (rootSessionIdOf({ ext: { pmpDshTavern: { rootSessionId: S_ROOT_A } } }) !== S_ROOT_A) return false
  for (const v of [null, {}, { ext: {} }, { ext: { pmpDshTavern: {} } }, { ext: { pmpDshTavern: { rootSessionId: 42 } } }]) {
    if (rootSessionIdOf(v) !== '') return false
  }
  return true
})())

{
  const tl = {
    head: { sessionId: S_BRANCH_A },
    nodes: [{ variants: [{ sessionId: S_ROOT_A }, { sessionId: '' }, {}, null] }, { variants: [] }, null],
  }
  const ids = [...sessionIdsOfTimeline(tl)]
  check('① sessionIdsOfTimeline：head ∪ 各 variants（坏条目跳过、空串不进来）',
    ids.length === 2 && ids.includes(S_ROOT_A) && ids.includes(S_BRANCH_A), JSON.stringify(ids))
  check('① ★反证：timeline 畸形（null/数组/无字段）⇒ 空集且不抛', (() => {
    for (const v of [null, undefined, [], 'x', {}, { nodes: 'no' }, { head: {} }]) {
      if (sessionIdsOfTimeline(v).size !== 0) return false
    }
    return true
  })())
}

// ───────── ② 索引：一条会话一条周目 + 冲突如实计数 ─────────
{
  const rows = [
    { entry: { id: PT_A, ext: { pmpDshTavern: { rootSessionId: S_ROOT_A } } }, timeline: { head: { sessionId: S_BRANCH_A }, nodes: [] } },
    { entry: { id: PT_B, path: 'Char/' + PT_B + '/timeline.json' }, timeline: { head: { sessionId: S_ROOT_B }, nodes: [] } },
  ]
  const idx = buildSessionIndex(rows)
  check('② 索引：两个周目各自的会话都进来了',
    idx.playthroughs === 2 && idx.sessions === 3 && idx.map.get(S_ROOT_A) === PT_A
    && idx.map.get(S_BRANCH_A) === PT_A && idx.map.get(S_ROOT_B) === PT_B,
    JSON.stringify({ playthroughs: idx.playthroughs, sessions: idx.sessions, conflicts: idx.conflicts }))
  check('② 根会话即使不在 timeline 里也要进索引（靠 rootSessionId 兜）',
    idx.map.get(S_ROOT_A) === PT_A)

  // ★ 冲突：同一个会话出现在两个周目 ⇒ 先到者胜 **且如实记账**
  const conflict = buildSessionIndex([
    { entry: { id: PT_A }, timeline: { head: { sessionId: S_ROOT_B }, nodes: [] } },
    { entry: { id: PT_B }, timeline: { head: { sessionId: S_ROOT_B }, nodes: [] } },
  ])
  check('② ★冲突：同会话属两周目 ⇒ catalog 先到者胜 + conflicts 里如实列出',
    conflict.map.get(S_ROOT_B) === PT_A && conflict.conflicts.length === 1 && conflict.conflicts[0] === S_ROOT_B,
    JSON.stringify({ bound: conflict.map.get(S_ROOT_B), conflicts: conflict.conflicts }))

  check('② ★反证：行缺失/畸形 ⇒ 不抛、只少收（不编造映射）', (() => {
    const bad = buildSessionIndex([null, {}, { entry: { id: '' } }, { entry: { id: PT_A } }])
    return bad.playthroughs === 1 && bad.sessions === 0 && bad.conflicts.length === 0
  })())
}

// ───────── ②c 2026-09-20：**rootSessionId 归属优先**（判定与行序无关） ─────────
//   真机事故：一条会话同时是**影子·12周目**的 rootSessionId、又在 **Rika·1周目** 的 timeline 里
//   当 variant 切片 ⇒ 旧的"catalog 顺序先到者胜"把它判给了更靠前的 Rika·1周目 ⇒ 检索目标/归档楼层
//   全指到一个**空周目**（用户看到的就是"怎么还是没用 roleplay-memory"）。
{
  const rika = { entry: { id: PT_A }, timeline: { nodes: [{ variants: [{ sessionId: S_ROOT_B }] }] } }
  const shadow = {
    entry: { id: PT_B, ext: { pmpDshTavern: { rootSessionId: S_ROOT_B } } },
    timeline: { nodes: [{ variants: [{ sessionId: S_ROOT_B }] }] },
  }
  for (const [name, rows] of [['variant 行在前', [rika, shadow]], ['root 行在前', [shadow, rika]]]) {
    const idx = buildSessionIndex(rows)
    check(`②c ★ ${name} ⇒ 判给**它是根**的那个周目（与行序无关）`,
      idx.map.get(S_ROOT_B) === PT_B, `bound=${idx.map.get(S_ROOT_B)}`)
  }
  check('②c ★ conflicts 仍如实列出（⛔ 不静默丢）', buildSessionIndex([rika, shadow]).conflicts.includes(S_ROOT_B))
  // ★ 反证：旧的"先到者胜"在这份形状上**确实判错**（证明这条判据不是白加的）
  const oldWay = (list) => {
    const map = new Map()
    for (const row of list) {
      const ids = new Set()
      for (const n of row.timeline.nodes) for (const v of n.variants) ids.add(v.sessionId)
      const root = row.entry.ext?.pmpDshTavern?.rootSessionId
      if (root) ids.add(root)
      for (const id of ids) if (!map.has(id)) map.set(id, row.entry.id)
    }
    return map
  }
  check('②c ★ 反证：旧规则在这份形状上判给了"只引用它"的那个（错的）', oldWay([rika, shadow]).get(S_ROOT_B) === PT_A, '')
}

// ───────── ②b 角色与目录：写侧要靠它拼 `<base>/<角色>/<周目>/archive/summaries` ─────────
{
  check('②b characterIdOf / playthroughDirOf：优先 catalog 的显式字段与 path 前两段',
    characterIdOf({ ext: { pmpDshTavern: { characterId: 'CHAR-A' } }, path: 'x/' + PT_A + '/timeline.json' }) === 'CHAR-A'
    && playthroughDirOf({ path: 'CHAR-A/' + PT_A + '/timeline.json' }) === 'CHAR-A/' + PT_A,
    playthroughDirOf({ path: 'CHAR-A/' + PT_A + '/timeline.json' }))
  check('②b ★反证：path 缺 ⇒ 用字段兜出 `<角色>/<周目>`；两者都给不出 ⇒ 空串（不猜）', (() => {
    const byFields = playthroughDirOf({ id: PT_A, ext: { pmpDshTavern: { characterId: 'CHAR-A' } } })
    const none = playthroughDirOf({ id: PT_A })
    return byFields === 'CHAR-A/' + PT_A && none === '' && playthroughDirOf(null) === ''
  })())
  const idx = buildSessionIndex([{
    entry: { id: PT_A, path: 'CHAR-A/' + PT_A + '/timeline.json' },
    timeline: { head: { sessionId: S_ROOT_A } },
  }])
  check('②b byId：周目 ⇒ { characterId, dir }（写侧拿它拼目录）',
    idx.byId.get(PT_A)?.characterId === 'CHAR-A' && idx.byId.get(PT_A)?.dir === 'CHAR-A/' + PT_A,
    JSON.stringify(idx.byId.get(PT_A)))
}

// ───────── ③ 决策：会话优先，解析不出**回落**（⛔ 不是"不过滤"）─────────
{
  const idx = buildSessionIndex([
    { entry: { id: PT_A, ext: { pmpDshTavern: { rootSessionId: S_ROOT_A } } }, timeline: { head: { sessionId: S_BRANCH_A }, nodes: [] } },
  ])
  check('③ 会话命中 ⇒ 用它，source=session',
    JSON.stringify(resolvePlaythroughForSession(idx, S_ROOT_A, PT_B)) === JSON.stringify({ bound: PT_A, source: 'session' }),
    JSON.stringify(resolvePlaythroughForSession(idx, S_ROOT_A, PT_B)))
  check('③ ★反证（关键）：会话**不在**索引里 ⇒ 回落面板绑定值，source=config（⛔ 不许变成"那就不过滤"）',
    JSON.stringify(resolvePlaythroughForSession(idx, 'session-nobody', PT_B)) === JSON.stringify({ bound: PT_B, source: 'config' }),
    JSON.stringify(resolvePlaythroughForSession(idx, 'session-nobody', PT_B)))
  check('③ ★反证：会话为空 / 索引为空 / 绑定值也空 ⇒ source=none（调用方据此 fail-closed）', (() => {
    const a = resolvePlaythroughForSession(idx, '', PT_B)   // 没会话 ⇒ 回落
    const b = resolvePlaythroughForSession(null, S_ROOT_A, PT_B)
    const c = resolvePlaythroughForSession(null, S_ROOT_A, '')
    return a.source === 'config' && a.bound === PT_B
      && b.source === 'config' && b.bound === PT_B
      && c.source === 'none' && c.bound === ''
  })())
}

// ───────── ④ 真机锚：真实 catalog + 两个 timeline ─────────
{
  const REAL_ROOT = 'D:/apps/dsh-tarven'
  const REAL_CATALOG = join(REAL_ROOT, 'catalog.json')
  if (existsSync(REAL_CATALOG)) {
    let cat = null
    try { cat = JSON.parse(readFileSync(REAL_CATALOG, 'utf8')) } catch { cat = null }
    const entries = Array.isArray(cat?.playthroughs) ? cat.playthroughs : []
    const rows = entries.map((entry) => {
      let timeline = null
      try { timeline = JSON.parse(readFileSync(join(REAL_ROOT, String(entry.path ?? '')), 'utf8')) } catch { timeline = null }
      return { entry, timeline }
    })
    const idx = buildSessionIndex(rows)
    check('④ ★真机锚：catalog 里每条周目都能解析出 id（id 字段或 path 段）',
      idx.playthroughs === entries.length && entries.length > 0,
      JSON.stringify({ catalog: entries.length, playthroughs: idx.playthroughs }))

    // 每个周目的根会话必须映射回**它自己**那个周目（不是别的周目、也不是空）
    const wrong = entries
      .map((e) => ({ id: playthroughIdOf(e), root: rootSessionIdOf(e) }))
      .filter((x) => x.id !== '' && x.root !== '' && idx.map.get(x.root) !== x.id)
    check('④ ★真机锚：每个周目的 rootSessionId 映射回**它自己**（不是别人、也不是空）',
      wrong.length === 0, JSON.stringify(wrong))

    const first = entries.map((e) => ({ id: playthroughIdOf(e), root: rootSessionIdOf(e) })).find((x) => x.root !== '')
    check('④ ★真机锚：拿真根会话解析 ⇒ source=session，且不是面板那个兜底值',
      first !== undefined
      && JSON.stringify(resolvePlaythroughForSession(idx, first.root, 'playthrough-should-not-win'))
        === JSON.stringify({ bound: first.id, source: 'session' }),
      first === undefined ? '(catalog 里没有 rootSessionId)' : JSON.stringify(resolvePlaythroughForSession(idx, first.root, 'x')))
    console.log(`  · 真机索引：${idx.playthroughs} 个周目 / ${idx.sessions} 条会话 / 冲突 ${idx.conflicts.length}`)
  } else {
    console.log(`[SKIP] ④ 真机锚：这台机器上没有 ${REAL_CATALOG}（换机/无 Tavern 时正常）`)
  }
}

console.log(`\n── ${pass} 通过 / ${fail} 失败 ──`)
process.exitCode = fail === 0 ? 0 : 1
