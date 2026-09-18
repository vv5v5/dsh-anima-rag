#!/usr/bin/env node
/**
 * _selftest-anima-delete-mechanics.mjs —— 孤儿回收的**删除机制**在真沙箱里到底成不成。
 *
 * 用法：node _selftest-anima-delete-mechanics.mjs
 *
 * 为什么单开这一台：`_selftest-orphan-reconcile.mjs` 只证了**判据**（谁是孤儿、白名单是什么），
 * 而真正会毁数据的动作是后半段 —— 用 `bm25.deleteDocuments(col, ids)` 把文档从 BM25 里摘掉。
 * 这里就在 `os.tmpdir()` 里造一个小库，把「删前删后能不能搜到」**真跑一遍**。
 *
 * ★ 最要紧的一条是**反证**（第 4 步）：故意把 `storedFields` 的**内部键**当文档 id 交上去
 *   （真机实测键是 "0"/"2"/"6" 这种编号，不是 id）⇒ 必须**什么都没删**。
 *   `deleteDocuments` 内部是 `miniSearch.has(id)`，键不对就一律 false ⇒ **静默不删**。
 *   这正是 `bm25IdsForIndexes` 不许拿键兜底的原因。
 *
 * ⛔ 只在 tmp 目录里折腾，碰不到任何真实集合。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createBm25 } from './lib/bm25.js'

// ★ 本仓**自己没有 node_modules**（minisearch / jieba-wasm 装在 profile 那边）⇒ 必须显式给
//   `depsBase`（`createRequire` 的基址）。给一个"位于那些包同一层的假文件路径"即可。
const DEPS_CANDIDATES = [
  'C:/Users/w/.dsh/profiles/web/node_modules',
  join(process.env.DSH_HOME || 'C:/Users/w/.dsh', 'profiles', 'web', 'node_modules'),
]
const depsBase = (() => {
  for (const d of DEPS_CANDIDATES) {
    if (existsSync(join(d, 'minisearch')) && existsSync(join(d, 'jieba-wasm'))) return join(d, '__anima_deps_probe__.js')
  }
  return null
})()
if (depsBase === null) {
  console.log('[SKIP] 本机找不到 minisearch / jieba-wasm（换机器就会这样）—— ⛔ 这不算通过，只是**测不了**；')
  console.log('       要真跑它，请把 anima 仓库的 node_modules 装上，或改 DEPS_CANDIDATES。')
  process.exit(0)
}

let pass = 0
const fails = []
async function check(name, fn) {
  try { await fn(); pass++; console.log('[PASS] ' + name) }
  catch (e) { fails.push(name); console.log('[FAIL] ' + name + ' :: ' + String(e?.message ?? e)) }
}

const quiet = { log() {}, warn() {}, error() {} }
const root = mkdtempSync(join(tmpdir(), 'anima-del-'))   // ⛔ 必须在 mk 之前声明（否则撞 TDZ）
const mk = () => createBm25({ bm25Root: root, persist: true, logger: quiet, depsBase })
const COL = 'delme'
const file = join(root, `${COL}.json`)
const readState = () => JSON.parse(readFileSync(file, 'utf8'))

const DOC_A = { id: 'aaaa1111-2222-3333-4444-555566667777', index: 'sum_x.md', text: '独角兽在雪原上奔跑，鬃毛结着冰霜。' }
const DOC_B = { id: 'bbbb8888-9999-0000-1111-222233334444', index: 'sum_x-1.md', text: '地下室里有三只猫，其中一只是黑猫。' }

const search = (bm, q) => bm.searchPipeline(q, [{ dbId: COL, dictionary: [] }], 5)

try {
  const bm = mk()
  await bm.buildIndexBatch(COL, [DOC_A, DOC_B], { dictionary: [] })

  await check('① 基线：两条都建进去了，各自的关键词都搜得到', async () => {
    const st = readState()
    assert.equal(st.documentCount, 2, 'documentCount 应为 2')
    assert.equal(Object.values(st.storedFields).filter((v) => v.id === DOC_A.id).length, 1, 'A 在库里')
    const ra = await search(bm, '独角兽')
    const rb = await search(bm, '地下室')
    assert.ok(ra.length >= 1 && ra.some((x) => x.id === DOC_A.id), 'A 应被搜到')
    assert.ok(rb.length >= 1 && rb.some((x) => x.id === DOC_B.id), 'B 应被搜到')
  })

  await check('② 按**文档 id** 删 ⇒ 内存态就不再返回它（同实例再搜）', async () => {
    await bm.deleteDocuments(COL, [DOC_A.id])
    const st = readState()
    assert.equal(st.documentCount, 1, 'documentCount 应降到 1')
    assert.equal(Object.values(st.storedFields).some((v) => v.id === DOC_A.id), false, 'A 不该还在 storedFields 里')
    const ra = await search(bm, '独角兽')
    assert.equal(ra.some((x) => x.id === DOC_A.id), false, '删完还搜得到 A ⇒ 删除没生效')
    const rb = await search(bm, '地下室')
    assert.ok(rb.some((x) => x.id === DOC_B.id), '⛔ 删 A 不许连坐 B')
  })

  await check('③ 落盘态同样生效（**新实例**从磁盘加载后再搜）', async () => {
    const fresh = mk()
    const ra = await search(fresh, '独角兽')
    assert.equal(ra.some((x) => x.id === DOC_A.id), false, '新实例仍搜到 A ⇒ 落盘没生效')
    const rb = await search(fresh, '地下室')
    assert.ok(rb.some((x) => x.id === DOC_B.id), 'B 必须还在')
  })

  await check('④ ★★反证（最要紧）：拿 storedFields 的**内部键**当 id 交上去 ⇒ 必须「什么都没删」', async () => {
    const fresh = mk()
    const before = readState()
    const keys = Object.keys(before.storedFields)
    assert.ok(keys.length > 0)
    // 内部键就是 "0"/"1" 这类编号（真机实测也是这个形状）——**不是**文档 id
    const anyKey = keys[0]
    await fresh.deleteDocuments(COL, [anyKey])
    const after = readState()
    assert.equal(after.documentCount, before.documentCount, '⛔ 拿键当 id 竟然删掉了东西 —— 那说明键恰好等于 id，本反证的前提要重核')
    assert.equal(after.storedFields[anyKey]?.index, before.storedFields[anyKey]?.index, '被点名的文档必须原样还在')
    const rb = await fresh.searchPipeline('地下室', [{ dbId: COL, dictionary: [] }], 5)
    assert.ok(rb.some((x) => x.id === DOC_B.id), 'B 必须还在 —— 键≠id ⇒ has() 恒 false ⇒ 静默不删')
  })
} finally {
  try { if (existsSync(root)) rmSync(root, { recursive: true, force: true }) } catch { /* tmp 清不掉不碍事 */ }
}

console.log(`\n== 总结：${pass} 通过 / ${fails.length} 失败 ==`)
if (fails.length > 0) { for (const f of fails) console.log('  ✖ ' + f); process.exit(1) }
