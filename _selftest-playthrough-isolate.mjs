#!/usr/bin/env node
/**
 * _selftest-playthrough-isolate.mjs —— 周目隔离判据（`lib/playthrough-isolate.js`）的自检。
 *
 * 用法：node _selftest-playthrough-isolate.mjs
 *
 * 最后一组是**真机锚**：拿磁盘上真实的 `vectors/dsh-memory/index.json`（2026-09-19 为 51 条）算出 deny 名单，
 * 断言 **正好 2 条被排除、且那 2 条就是「没有 pt: 标签」的那批**（原先 62/13，少掉的 11 条是孤儿回收真删的）。
 * 这是"隔离到底装对了没有"的硬证据 —— ⛔ 别删。
 */
import { existsSync, readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import {
  PT_PREFIX, denyIndexesForPlaythrough, isolationBlockReason, isolationSummary, ptTagOf, sliceIndexOf, tagsOf,
} from './lib/playthrough-isolate.js'

let pass = 0
const fails = []
function check(name, fn) {
  try { fn(); pass++; console.log('[PASS] ' + name) }
  catch (e) { fails.push(name); console.log('[FAIL] ' + name + ' :: ' + String(e?.message ?? e)) }
}

const BOUND = 'playthrough-adacc634-2f2e-4c09-b21a-7ad48d703f2d'
const OTHER = 'playthrough-other-0000'
const item = (index, tags) => ({ id: 'i-' + index, metadata: { index, tags } })

check('① ptTagOf / tagsOf / sliceIndexOf：形状与畸形输入都不抛', () => {
  assert.equal(ptTagOf('abc'), 'pt:abc')
  assert.equal(PT_PREFIX, 'pt:')
  assert.deepEqual(tagsOf(item('a', ['x', 'pt:y'])), ['x', 'pt:y'])
  assert.deepEqual(tagsOf({ metadata: { tags: 'not-an-array' } }), [], '畸形 tags ⇒ 空数组')
  assert.deepEqual(tagsOf(null), [])
  assert.equal(sliceIndexOf({ metadata: { index: 'sum_a.md' } }), 'sum_a.md')
  assert.equal(sliceIndexOf({ index: 'sum_b.md' }), 'sum_b.md', '裸字段也要认')
  assert.equal(sliceIndexOf(null), '')
})

check('② ★核心判据：只放行带 pt:<绑定周目> 的切片，其余全部进 deny', () => {
  const items = [
    item('sum_mine1.md', [ptTagOf(BOUND)]),
    item('sum_mine2.md', [ptTagOf(BOUND), 'Important']),
    item('sum_other.md', [ptTagOf(OTHER)]),
    item('sum_untagged.md', []),
    item('probe_1', undefined),
  ]
  assert.deepEqual(denyIndexesForPlaythrough(items, BOUND), ['sum_other.md', 'sum_untagged.md', 'probe_1'])
  assert.deepEqual(denyIndexesForPlaythrough(items, OTHER), ['sum_mine1.md', 'sum_mine2.md', 'sum_untagged.md', 'probe_1'])
  assert.deepEqual(denyIndexesForPlaythrough([], BOUND), [], '空库 ⇒ 空名单')
  assert.deepEqual(denyIndexesForPlaythrough(null, BOUND), [], '畸形输入不抛')
})

check('③ ★反证：没标签的切片**必须**被排除 —— 「跨周目延续」不是默认，是以后单说的事', () => {
  const items = [item('sum_untagged1.md', []), item('sum_untagged2.md', ['Important'])]
  const deny = denyIndexesForPlaythrough(items, BOUND)
  assert.equal(deny.length, 2, '⛔ 没 pt: 标签却放行 = 共享池照旧 = 这单没做')
  assert.equal(deny.includes('sum_untagged2.md'), true, '「有别的标签」不算数，只认 pt:')
})

check('④ fail-closed：拿不到绑定周目 / 索引解析不了 ⇒ 一律 blocked（不是"那就不过滤"）', () => {
  assert.equal(isolationBlockReason({ enabled: true, bound: '', indexReadable: true }), 'no-bound-playthrough')
  assert.equal(isolationBlockReason({ enabled: true, bound: BOUND, indexReadable: false }), 'bad-vector-index')
  assert.equal(isolationBlockReason({ enabled: true, bound: BOUND, indexReadable: true }), null, '正常相放行')
  assert.equal(isolationBlockReason({ enabled: false, bound: '', indexReadable: false }), null, '开关关掉 ⇒ 不过闸')
  assert.equal(isolationBlockReason({ enabled: true, bound: null, indexReadable: true }), 'no-bound-playthrough')
})

check('⑤ 摘要一行：口径统一（日志与状态端点共用）', () => {
  const s = isolationSummary({ collectionId: 'dsh-memory', bound: BOUND, denyCount: 2, total: 51 })
  assert.ok(s.includes('dsh-memory') && s.includes('2/51'), s)
})

const REAL = 'D:/apps/SillyTavern-Launcher/SillyTavern/plugins/anima-rag/vectors/dsh-memory/index.json'
if (existsSync(REAL)) {
  check('⑥ ★真机锚：真库 51 条 ⇒ deny 正好 2 条，且与「没有 pt: 标签」的集合逐条相等', () => {
    const items = JSON.parse(readFileSync(REAL, 'utf8')).items
    // ★ 2026-09-19 重核：62 → 51。少掉的 11 条正是**孤儿回收真删掉的那批**
    //   （10 改名孤儿 + 1 import 清单；三层一致：index/metadata 各 62→51、BM25 81→70）。
    //   ⇒ 它们本来就在 deny 名单里，所以 deny 13 → 2（只剩 probe_1/2 两条测试残留）。
    assert.equal(items.length, 51, '真库条数变了 ⇒ 请重核本锚的期望值')
    const deny = denyIndexesForPlaythrough(items, BOUND)
    const untagged = items.filter((it) => !tagsOf(it).includes(ptTagOf(BOUND))).map(sliceIndexOf)
    assert.equal(deny.length, 2, 'deny 应正好 2 条（只剩 probe_1/2 两条测试残留；那批改名孤儿已被回收删除）')
    assert.deepEqual([...deny].sort(), [...untagged].sort(), 'deny 名单必须与"没本周目标签"的集合逐条相等')
    assert.equal(deny.some((x) => x.endsWith('.json')), false, '切片 index 不该带 .json')
  })
} else {
  console.log('[SKIP] ⑥ 真机锚：本机没有那个文件 —— ⛔ 不算通过，只是测不了')
}

// ───────── ⑦ 2026-09-20 口径：隔离**会话优先、认不出当新会话**（⛔ 不给面板绑定兜底） ─────────
//   用户原话：「认不出来的会话默认为新会话。会话优先」。
//   ④ 守的是**纯函数**那一半（bound 为空 ⇒ blocked）；这一组守**接线**：兜底那个参数到底传了什么。
//   ⚠️ 传面板绑定值 = 一条新会话照样去查**上一轮**的集合（串味，不是兜底）—— 真机就是这么坏的。
check('⑦★ 隔离与入库目标都**会话优先、无兜底**（认不出 ⇒ 当新会话），且兜底参数就是空串', () => {
  const src = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
  /** 抠某个顶层函数的函数体（大括号配对；先跨过参数表）。 */
  const bodyOf = (name) => {
    const at = src.indexOf(`function ${name}(`)
    if (at < 0) return null
    const po = src.indexOf('(', at)
    let d = 0
    let pc = -1
    for (let i = po; i < src.length; i += 1) {
      if (src[i] === '(') d += 1
      else if (src[i] === ')') { d -= 1; if (d === 0) { pc = i; break } }
    }
    if (pc < 0) return null
    const open = src.indexOf('{', pc)
    if (open < 0) return null
    let depth = 0
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1
      else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(open, i + 1) }
    }
    return null
  }
  // ⚠️ 两个调用点：隔离闸（读侧）与 sessionSummariesDir（读+写侧共用）。⛔ 两处都必须无兜底。
  const pat = /resolvePlaythroughForSession\([^;]*?,\s*''\s*\)/
  for (const name of ['isolationPlan', 'sessionSummariesDir']) {
    const body = bodyOf(name)
    assert.ok(body !== null, `${name} 不在了（改名了？同步本台子）`)
    assert.ok(pat.test(body), `${name} 的兜底不是空串：` + (body.match(/resolvePlaythroughForSession\([^;]*?\)/) || [''])[0])
    // ★ 反证：把兜底换回面板绑定 ⇒ 同一句判据必红
    assert.equal(pat.test(body.replace(/,\s*''\s*\)/, ', boundPlaythroughId()')), false, `${name} 反证失败：换回旧兜底后仍能命中`)
  }
  // 那个"读面板绑定"的解析器已**整体删除**（剥注释后零命中）—— ⛔ 别加回来当兜底
  assert.equal(/boundPlaythroughId/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')), false,
    'boundPlaythroughId 又出现了（那是"新会话冒充上一轮"的入口）')
})

console.log(`\n== 总结：${pass} 通过 / ${fails.length} 失败 ==`)
if (fails.length > 0) { for (const f of fails) console.log('  ✖ ' + f); process.exit(1) }
