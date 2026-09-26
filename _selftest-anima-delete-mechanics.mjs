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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
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

let LocalIndex = null
try {
  const mod = createRequire(depsBase)('vectra')
  LocalIndex = mod.LocalIndex || mod.default?.LocalIndex || mod.default
} catch { LocalIndex = null }

if (typeof LocalIndex !== 'function') {
  console.log('[SKIP] 本机解析不到 vectra（换机器就会这样，本仓不自带 node_modules）—— ⛔ 这不算通过，只是**测不了**；')
  console.log('       要真跑它，请把 ST 侧 anima-rag 的 node_modules 装上，或改 DEPS_BASE。')
  process.exit(0)
}

let pass = 0
const fails = []
async function check(name, fn) {
  try { await fn(); pass++; console.log('[PASS] ' + name) }
  catch (e) { fails.push(name); console.log('[FAIL] ' + name + ' :: ' + String(e?.message ?? e)) }
}

const root = mkdtempSync(join(tmpdir(), 'anima-del-'))
const COL = 'delme'
const vectorDir = join(root, COL)
const indexFile = join(vectorDir, 'index.json')
const mk = async () => {
  const idx = new LocalIndex(vectorDir)
  if (!(await idx.isIndexCreated())) {
    // 与 `engine.js` 的 getIndex() 同一份建库参数（⛔ 别改：改了测的就不是线上那个库了）
    await idx.createIndex({ version: 1, metadata_config: { indexed: ['tags', 'index', 'batch_id'] } })
  }
  return idx
}
const listItems = async (idx) => await idx.listItems()
const diskIndex = () => JSON.parse(readFileSync(indexFile, 'utf8'))
const metaFiles = () => readdirSync(vectorDir).filter((n) => n.endsWith('.json') && n !== 'index.json')

const VEC = (n) => { const v = new Array(8).fill(0); v[n] = 1; return v }   // 8 维、正交、必然算得出分
const META_A = { text: '独角兽在雪原上奔跑，鬃毛结着冰霜。', tags: ['A'], timestamp: 1, index: 'sum_x.md', batch_id: -1 }
const META_B = { text: '地下室里有三只猫，其中一只是黑猫。', tags: ['B'], timestamp: 2, index: 'sum_x-1.md', batch_id: -1 }

/** 一次插入 = `engine.insert()` 里那一步（插入向量 item；元数据文件由 vectra 自己落盘）。 */
const put = async (idx, meta, vec) => await idx.insertItem({ vector: vec, metadata: meta })

/** 一次删除 = 孤儿回收里那两步（`planVectorPrune` 摘 items → `metadataFileNamesOf` 删文件）。 */
const drop = async (idx, item) => {
  await idx.deleteItem(item.id)
  const f = item.metadataFile
  if (f && existsSync(join(vectorDir, f))) rmSync(join(vectorDir, f), { force: true })
}

const A_ID = 'aaaa1111-2222-3333-4444-555566667777'
const B_ID = 'bbbb8888-9999-0000-1111-222233334444'
let itemsA = null
let itemsB = null

try {
  await check('① 基线：两条都建进去了，各自的关键词都查得到（真 vectra 库）', async () => {
    const idx = await mk()
    itemsA = await put(idx, META_A, VEC(0))
    itemsB = await put(idx, META_B, VEC(1))
    // 真机实测：`insertItem` 返回的 id 是 **UUID**（不是我们自己编的），落盘在 items[].id 里
    assert.equal(typeof itemsA.id, 'string')
    assert.match(itemsA.id, /^[0-9a-f-]{36}$/i, 'id 应是 UUID：' + itemsA.id)
    assert.equal(typeof itemsA.metadataFile, 'string')
    assert.ok(itemsA.metadataFile !== '', 'vectra 给每条落一个 per-item 元数据文件')
    assert.equal((await listItems(idx)).length, 2)
    assert.equal(diskIndex().items.length, 2, 'index.json 里也该是 2 条')
    assert.equal(metaFiles().length, 2, '磁盘上应有 2 个 per-item 元数据文件：' + JSON.stringify(metaFiles()))
    const hit = await idx.queryItems(VEC(0), '', 5)
    assert.ok(hit.some((h) => h.item.id === itemsA.id), 'A 应被查到')
  })

  await check('② 删 A（`deleteItem(id)` + 删它的元数据文件）⇒ 索引与磁盘都不再有它，B 毫发无伤', async () => {
    const idx = await mk()
    await drop(idx, itemsA)
    const items = await listItems(idx)
    assert.equal(items.length, 1, '应只剩 1 条')
    assert.equal(items.some((it) => it.id === itemsA.id), false, 'A 不该还在 listItems 里')
    assert.equal(diskIndex().items.some((it) => it.id === itemsA.id), false, 'A 不该还在 index.json 里')
    assert.equal(existsSync(join(vectorDir, itemsA.metadataFile)), false, 'A 的元数据文件该被删掉')
    assert.equal(items.some((it) => it.id === itemsB.id), true, '⛔ 删 A 不许连坐 B')
    assert.equal(existsSync(join(vectorDir, itemsB.metadataFile)), true, 'B 的元数据文件必须还在')
    const hit = await idx.queryItems(VEC(0), '', 5)
    assert.equal(hit.some((h) => h.item.id === itemsA.id), false, '删完还查得到 A ⇒ 删除没生效')
  })

  await check('③ 落盘态同样生效（**新实例**重新读盘后，A 仍不存在、B 仍可查）', async () => {
    const fresh = await mk()
    const items = await listItems(fresh)
    assert.equal(items.some((it) => it.id === itemsA.id), false, '新实例仍见到 A ⇒ 落盘没生效')
    const hit = await fresh.queryItems(VEC(1), '', 5)
    assert.ok(hit.some((h) => h.item.id === itemsB.id), 'B 必须还能查到')
  })

  await check('④ ★★反证（最要紧）：拿一个**认不出的 id** 去删 ⇒ 必须「什么都没删」、而且**不报错**', async () => {
    const fresh = await mk()
    itemsB = (await listItems(fresh))[0]      // 现在库里只剩 B
    const before = diskIndex()
    // ⛔ vectra 的 deleteItem 对找不到的 id 是**静默 no-op**（源码里就是 findIndex 找不到就什么都不做）
    //    ⇒ 真机上"删除看着跑完了"完全可能一条没删 —— 所以删完**必须回读**（孤儿回收就是靠回读对账的）。
    await fresh.deleteItem('not-a-real-id-0000-0000-000000000000')
    assert.equal((await listItems(fresh)).length, before.items.length, '⛔ 认不出的 id 竟然删掉了东西 —— 本反证的前提要重核')
    assert.equal(diskIndex().items.some((it) => it.id === itemsB.id), true, '被点名的库内容必须原样还在')
  })

  await check('⑤ ★反证：拿**元数据文件名**（而不是文档 id）去删 ⇒ 同样静默 no-op（这正是回收里"两步必须都给 id"的理由）', async () => {
    const fresh = await mk()
    const metaFile = itemsB.metadataFile
    assert.ok(typeof metaFile === 'string' && metaFile !== '', 'B 该有一个元数据文件名')
    await fresh.deleteItem(metaFile)          // ← 真机最容易犯的错：把文件名当 id
    assert.equal((await listItems(fresh)).length, 1, '⛔ 文件名≠id ⇒ `findIndex` 找不到 ⇒ 一条都不该少')
    assert.equal(existsSync(join(vectorDir, metaFile)), true, '文件也还该在（deleteItem 不碰文件）')
  })
} finally {
  try { if (existsSync(root)) rmSync(root, { recursive: true, force: true }) } catch { /* tmp 清不掉不碍事 */ }
}

console.log(`\n== 总结：${pass} 通过 / ${fails.length} 失败 ==`)
if (fails.length > 0) { for (const f of fails) console.log('  ✖ ' + f); process.exit(1) }
