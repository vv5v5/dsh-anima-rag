#!/usr/bin/env node
/**
 * _selftest-orphan-reconcile.mjs —— 孤儿对账（`lib/orphan-reconcile.js`）的自检。
 *
 * 用法：node _selftest-orphan-reconcile.mjs
 *
 * 为什么单开一台（而不是塞进 test/）：本仓的 `test/*.test.mjs` 是 `node --test` 风格，
 * 而 `产物/memory-tools/_run-all-selftests.mjs` 那道**全量门**只认 `_selftest-*.mjs`。
 * 这条判据会**删用户记忆**，必须进全量门。
 *
 * ★ 最后一组是**真机数据重放**（文件在就跑、不在就明确标"跳过"）：拿磁盘上真实的
 *   `summaries/index.json` 与 `vectors/dsh-memory/index.json` 对一遍，断言
 *   **49 留 / 0 孤儿 / 2 不动**（2026-09-19 重核：那 11 条孤儿已被回收真删掉，见 ⑥ 的注释）。
 *   这一条是"改成什么样才算对"的锚，⛔ 别删。
 */
import { existsSync, readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import {
  DEFAULT_INDEX_PREFIX, allowedKeysFromEntries, bm25IdsForIndexes, decideReconcile,
  defaultExcludeEntry, entryKeyOf, findOrphanSlices, metadataFileNamesOf, planVectorPrune, sliceKeyOf,
} from './lib/orphan-reconcile.js'

let pass = 0
const fails = []
function check(name, fn) {
  try { fn(); pass++; console.log('[PASS] ' + name) }
  catch (e) { fails.push(name); console.log('[FAIL] ' + name + ' :: ' + String(e?.message ?? e)) }
}

// ── ① key 归一：两种历史格式必须落到同一个 key ───────────────────────────────

check('① sliceKeyOf 归一：带 .md / 不带 .md / .txt / .json 都落到同一个 key；非前缀与空 ⇒ null', () => {
  assert.equal(sliceKeyOf('sum_s-0000-0019.md'), 's-0000-0019', '带 .md 的旧格式')
  assert.equal(sliceKeyOf('sum_s-0000-0019'), 's-0000-0019', '不带 .md 的新格式')
  assert.equal(sliceKeyOf('sum_s-0000-0019.txt'), 's-0000-0019')
  assert.equal(sliceKeyOf('sum_s-0000-0019.json'), 's-0000-0019')
  assert.equal(sliceKeyOf('probe_1'), null, '不是本前缀 ⇒ null（调用方据此不动它）')
  assert.equal(sliceKeyOf('sum_'), null, '只剩前缀 ⇒ null')
  assert.equal(sliceKeyOf(''), null)
  assert.equal(sliceKeyOf(null), null)
  assert.equal(sliceKeyOf('x_sum_a.md'), null, '前缀必须在最前')
})

check('①b entryKeyOf：归档条目文件名 ⇒ key（扩展名不参与比较）', () => {
  assert.equal(entryKeyOf('s-0000-0019-1.md'), 's-0000-0019-1')
  assert.equal(entryKeyOf('import-d6bac75c.md'), 'import-d6bac75c')
  assert.equal(entryKeyOf(''), '')
})

// ── ② 白名单：列着 ≠ 有资格 ────────────────────────────────────────────────

check('② allowedKeysFromEntries：正常条目进白名单；import-* 必须被剔掉（列着但不该入）', () => {
  const entries = [
    { id: 's-0000-0019-1', file: 's-0000-0019-1.md' },
    { id: 's-0000-0019-2', file: 's-0000-0019-2.md' },
    { id: 'import-d6bac75c', file: 'import-d6bac75c.md' },
    { id: 'empty-file', file: '' },
    null,
  ]
  const keys = allowedKeysFromEntries(entries)
  assert.deepEqual([...keys].sort(), ['s-0000-0019-1', 's-0000-0019-2'], 'import-* 与空文件名都不许进白名单')
  assert.equal(defaultExcludeEntry({ id: 'import-x' }), true)
  assert.equal(defaultExcludeEntry({ id: 's-1' }), false)
  assert.equal(allowedKeysFromEntries(null).size, 0, 'entries 不是数组 ⇒ 空集合（什么都不放行）')
  assert.equal(allowedKeysFromEntries([{ id: 'x', file: 'x.md' }], { isExcluded: () => true }).size, 0, '自定义剔除判据要生效')
})

// ── ③ 对账本体 ─────────────────────────────────────────────────────────────

check('③ ★反证：同源但格式不同（带/不带 .md）的切片都要判"非孤儿" —— 这就是改名的对照面', () => {
  const allowed = new Set(['s-0000-0019-1'])
  const { orphans, kept } = findOrphanSlices([
    { id: 'a', metadata: { index: 'sum_s-0000-0019-1.md' } },   // 旧格式
    { id: 'b', metadata: { index: 'sum_s-0000-0019-1' } },      // 新格式
  ], allowed)
  assert.equal(kept, 2, '两种格式都要认成活切片')
  assert.equal(orphans.length, 0, '⛔ 把格式差异当成孤儿 = 会误删真记忆')
})

check('③b 改名孤儿要判出来（旧名在新 index.json 里已不存在）', () => {
  const allowed = new Set(['s-0000-0019-1', 's-0000-0019-2', 's-0000-0019-3'])
  const { orphans, kept } = findOrphanSlices([
    { id: 'x', metadata: { index: 'sum_s-0000-0019.md' } },      // ← 改名前的旧名字
    { id: 'y', metadata: { index: 'sum_s-0000-0019-1.md' } },
  ], allowed)
  assert.equal(kept, 1)
  assert.deepEqual(orphans.map((o) => o.index), ['sum_s-0000-0019.md'])
  assert.equal(orphans[0].key, 's-0000-0019')
})

check('③c import 清单：文件还在、白名单里也没它 ⇒ 判孤儿（与 ingest 侧同一判据）', () => {
  const entries = [{ id: 'import-d6bac75c', file: 'import-d6bac75c.md' }, { id: 's-1', file: 's-1.md' }]
  const allowed = allowedKeysFromEntries(entries)
  const { orphans } = findOrphanSlices([
    { id: 'm', metadata: { index: 'sum_import-d6bac75c.md' } },
    { id: 'k', metadata: { index: 'sum_s-1.md' } },
  ], allowed)
  assert.deepEqual(orphans.map((o) => o.index), ['sum_import-d6bac75c.md'])
})

check('③d ★反证：不是 sum_ 前缀的切片一律"不动"并计入 skipped（来源不明，绝不猜着删）', () => {
  const allowed = new Set(['s-1'])
  const { orphans, kept, skipped } = findOrphanSlices([
    { id: 'p1', metadata: { index: 'probe_1' } },
    { id: 'p2', metadata: { index: 'collect_something' } },
    { id: 'ok', metadata: { index: 'sum_s-1.md' } },
  ], allowed)
  assert.equal(kept, 1)
  assert.equal(orphans.length, 0, '⛔ 前缀不认识就删 = 会误删别处正经灌进来的内容')
  assert.equal(skipped.length, 2)
  assert.ok(skipped[0].why.includes('来源不明'))
})

// ── ④ 护栏：白名单空 ⇒ 一条都不删 ──────────────────────────────────────────

check('④ ★反证（最要紧的一条）：白名单为空 ⇒ decideReconcile 必须拒绝，⛔ 绝不许"把库清光"', () => {
  const empty = decideReconcile({ allowedCount: 0, itemCount: 62 })
  assert.equal(empty.ok, false, 'index.json 读不到/被清空时必须拒绝动手')
  assert.ok(empty.reason.includes('一条都不删'))
  assert.equal(decideReconcile({ allowedCount: 49, itemCount: 0 }).ok, false, '库里没切片 ⇒ 无事可做')
  assert.equal(decideReconcile({ allowedCount: 49, itemCount: 62 }).ok, true, '正常相要放行')
  assert.equal(decideReconcile({ allowedCount: NaN, itemCount: 62 }).ok, false, 'NaN 当空处理（fail-closed）')
})

// ── ⑤ 落盘计划 ─────────────────────────────────────────────────────────────

check('⑤ planVectorPrune：只摘指定 id，vectra 的 version / metadata_config 等字段原样保留', () => {
  const src = {
    version: 1, metadata_config: { indexed: ['tags', 'index', 'batch_id'] },
    items: [{ id: 'a', metadata: { index: 'sum_x.md' } }, { id: 'b', metadata: { index: 'sum_y.md' } }],
  }
  const { next, removed } = planVectorPrune(src, ['a'])
  assert.deepEqual(removed.map((x) => x.id), ['a'])
  assert.deepEqual(next.items.map((x) => x.id), ['b'])
  assert.equal(next.version, 1, '⛔ version 不许动（vectra 靠它认格式）')
  assert.deepEqual(next.metadata_config, src.metadata_config, '⛔ metadata_config 不许动')
  assert.equal(src.items.length, 2, '⛔ 不许就地改原对象（纯函数）')
  assert.deepEqual(planVectorPrune(null, []).next.items, [], '畸形输入不抛')
})

check('⑤b ★★ bm25IdsForIndexes：要交的是**文档 id**（`.id`，真机是 UUID），⛔ 绝不许拿 storedFields 的键兜底', () => {
  // ★ 键是 MiniSearch 的内部编号（真机实测 "0"/"2"/"6"/"58"/"154"），**不是**文档 id。
  //   拿键当 id 交上去的后果不是报错，是 `miniSearch.has()` 一律 false ⇒ **静默什么都没删**。
  const sf = {
    0: { id: '643dfa09-1ee5-47cd-87ff-18cd7f416b54', index: 'sum_s-0000-0019.md' },
    2: { id: 'bbe5f1a-5b5d-4654', index: 'sum_s-0020-0039-1.md' },
    6: { id: 'fff', index: 'probe_1' },
  }
  assert.deepEqual(bm25IdsForIndexes(sf, ['sum_s-0000-0019.md']), ['643dfa09-1ee5-47cd-87ff-18cd7f416b54'])
  assert.deepEqual(
    bm25IdsForIndexes(sf, ['sum_s-0000-0019.md', 'sum_s-0020-0039-1.md']).sort(),
    ['643dfa09-1ee5-47cd-87ff-18cd7f416b54', 'bbe5f1a-5b5d-4654'],
  )
  assert.deepEqual(bm25IdsForIndexes(sf, ['nope']), [], '查不到就不给 id（别乱删）')
  assert.deepEqual(bm25IdsForIndexes({ 7: { index: 'sum_x.md' } }, ['sum_x.md']), [], '⛔ 没有 .id 宁可返回空 —— 不许退回键')
  assert.deepEqual(bm25IdsForIndexes(null, ['x']), [], '畸形输入不抛')
})

check('⑤c metadataFileNamesOf：优先用 metadataFile，缺了退回 `<id>.json`', () => {
  assert.deepEqual(metadataFileNamesOf([{ id: 'a', metadataFile: 'a.meta.json' }, { id: 'b' }]), ['a.meta.json', 'b.json'])
  assert.deepEqual(metadataFileNamesOf(null), [])
})

// ── ⑥ 真机数据重放（文件在就跑） ────────────────────────────────────────────

const REAL_VECTORS = 'D:/apps/SillyTavern-Launcher/SillyTavern/plugins/anima-rag/vectors/dsh-memory/index.json'
const REAL_SUMS = 'D:/apps/dsh-tarven/70a0502d-b4e9-472f-8d5a-1c7b32b2e7ac/playthrough-adacc634-2f2e-4c09-b21a-7ad48d703f2d/archive/summaries/index.json'

if (existsSync(REAL_VECTORS)) {
  check('⑥ ★真机锚：真 `vectors/dsh-memory/index.json` ⇒ 每条都有归宿、白名单内的不误判、非前缀不动、空白名单拒删', () => {
    const items = JSON.parse(readFileSync(REAL_VECTORS, 'utf8')).items
    assert.ok(Array.isArray(items) && items.length > 0, '真库该有切片')
    // ① 拿库里**自己的** sum_ 切片当白名单 ⇒ 一条孤儿都不该有（这条钉的是 `.md` 归一对得上真文件）
    const ownKeys = new Set(items.map((it) => sliceKeyOf(it?.metadata?.index)).filter((k) => k !== null))
    assert.ok(ownKeys.size > 0, '真库里总该有本前缀的切片')
    const r1 = findOrphanSlices(items, ownKeys, { prefix: DEFAULT_INDEX_PREFIX })
    assert.equal(r1.orphans.length, 0, '⛔ 白名单就是它们自己，判成孤儿 = 归一化对不上真文件（会误删真记忆）')
    // ② 非本前缀的一条不动（真机上是 `probe_1` / `probe_2`，但**按现测**数，不写死）
    const foreign = items.filter((it) => sliceKeyOf(it?.metadata?.index) === null)
    assert.equal(r1.skipped.length, foreign.length, '非本前缀的一律进 skipped')
    // ③ 每条都要有归宿（留 / 删 / 不动）
    assert.equal(r1.kept + r1.orphans.length + r1.skipped.length, items.length)
    // ④ 在真库上再钉一次最要紧的那条护栏：白名单为空 ⇒ 一条都不删
    assert.equal(decideReconcile({ allowedCount: 0, itemCount: items.length }).ok, false)
    console.log(`  (真机：items=${items.length} · 白名单内留 ${r1.kept} · 不动 ${r1.skipped.length}`
      + `${r1.skipped.length > 0 ? ` ⇒ ${r1.skipped.map((s) => s.index).join('、')}` : ''})`)
  })
} else {
  console.log('[SKIP] ⑥ 真机锚：本机没有 `vectors/dsh-memory/index.json`（换机器就会这样）—— ⛔ 不算通过，只是测不了')
}

const REAL_BM25 = 'D:/apps/SillyTavern-Launcher/SillyTavern/plugins/anima-rag/data/bm25_indexes/dsh-memory.json'
if (existsSync(REAL_BM25)) {
  check('⑥b ★真机锚：真 bm25 文件里查一条**真存在**的切片 ⇒ 必须给出 **UUID 文档 id**（拿内部键兜底是静默失效）', () => {
    const sf = JSON.parse(readFileSync(REAL_BM25, 'utf8')).storedFields
    const keys = Object.keys(sf)
    assert.ok(keys.length > 0)
    assert.equal(/^\d+$/.test(keys[0]), true, 'storedFields 的键确实是内部编号（这条结论本身要钉住）')
    // ★ 2026-09-19：原来查的是那两条孤儿，孤儿已被回收删除 ⇒ 改成查一条**库里还在**的切片。
    //   锚的本意一字不变：交出去的必须是 **文档 id（UUID）**，绝不是 storedFields 的内部编号。
    const items = JSON.parse(readFileSync(REAL_VECTORS, 'utf8')).items
    const present = new Set(Object.values(sf).map((v) => v && v.index).filter((x) => typeof x === 'string'))
    const aReal = items.map((it) => it && it.metadata && it.metadata.index).find((x) => typeof x === 'string' && present.has(x))
    assert.ok(typeof aReal === 'string' && aReal !== '', '真库↔真 bm25 之间总该有至少一条对得上的切片')
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i
    const ids = bm25IdsForIndexes(sf, [aReal])
    assert.ok(ids.length >= 1, '真文件里查得到这条的文档 id（' + ids.length + '）')
    for (const id of ids) assert.ok(UUID_RE.test(id), '⛔ 交出去的必须是文档 id（UUID），不是内部编号：' + id)
    for (const k of keys) assert.equal(ids.includes(k), false, '⛔ 内部编号 ' + k + ' 绝不能出现在删除名单里')
  })
} else {
  console.log('[SKIP] ⑥b 真机 bm25 锚：本机没有那个文件')
}

console.log(`\n== 总结：${pass} 通过 / ${fails.length} 失败 ==`)
if (fails.length > 0) { for (const f of fails) console.log('  ✖ ' + f); process.exit(1) }
