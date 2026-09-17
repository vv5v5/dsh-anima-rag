/**
 * 写入口（甲方案 T2）自检 —— `anima_ingest` 的守卫、真写入、**回读核对**与计数播报。
 *
 * ⛔ 不联网、不碰真机数据：引擎用 `engineModule` 指向**测试自己生成的桩**，
 *    `vectorRoot` / `bm25Root` 指向临时目录；桩只写"索引文件"，够 `verifySlicesOnDisk` 回读。
 *
 * 本测的**反证**是重点：桩只写向量不写 BM25 时，`ok` 必须为 false、`verify.bm25.found` 必须为 0
 * —— 因为引擎对 BM25 失败是"只打日志不报错"（`engine.js:2332-2335`），只信返回值就会误判成功。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, mergeConfig } from '../lib/index.js'

// ─────────────────────────── 测试脚手架

function makeCtx() {
  const tools = new Map()
  const sections = []
  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, log() {} },
    tools: { register: (t) => tools.set(t.name, t) },
    systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
    on: (ev, fn) => handlers.set(ev, fn),
    effect: () => {},
  // ★ 严格模式（2026-09-16 加）：未声明的属性一律**抛**，模拟 cordis 的 ctx 代理。
  //   起因：真机上 `anima_query` 读 `ctx.agent` 直接抛（未 inject），而宽松的假 ctx 把它盖住了。
  //   用 getter 而不是 Proxy：这里只需要 `agent` 这一个已知会抛的成员。
  get agent() { throw new Error('cannot get property "agent" without inject') },  }
  return { ctx, tools, sections, handlers }
}

/** 生成一个桩引擎文件，返回它的绝对路径。mode: good | vectoronly | failing */
function makeStub(dir, mode) {
  const p = join(dir, `stub-${mode}.mjs`)
  const body = mode === 'failing'
    ? `export function createEngine() {
  return {
    async insert() { return { success: false, status: 500, message: 'boom' } },
    async query() { return { merged_chat_results: [], merged_kb_results: [] } },
    async listCollections() { return [] },
    async listBm25() { return [] },
    async close() {},
  }
}`
    : `import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const WRITE_BM25 = ${mode === 'good'}
export function createEngine({ vectorRoot, bm25Root }) {
  return {
    async insert(p) {
      mkdirSync(join(vectorRoot, p.collectionId), { recursive: true })
      const vf = join(vectorRoot, p.collectionId, 'index.json')
      const cur = existsSync(vf) ? JSON.parse(readFileSync(vf, 'utf8')) : { items: [] }
      cur.items = cur.items.filter((it) => String(it?.metadata?.index) !== String(p.index))
      cur.items.push({ id: 'v' + cur.items.length, metadata: { text: p.text, tags: p.tags, timestamp: p.timestamp, index: p.index, batch_id: p.batch_id } })
      writeFileSync(vf, JSON.stringify(cur))
      if (WRITE_BM25) {
        mkdirSync(bm25Root, { recursive: true })
        const bf = join(bm25Root, p.collectionId + '.json')
        const bcur = existsSync(bf) ? JSON.parse(readFileSync(bf, 'utf8')) : { storedFields: {} }
        bcur.storedFields['d' + Object.keys(bcur.storedFields).length] = { text: p.text, tags: p.tags, index: p.index, batch_id: p.batch_id }
        writeFileSync(bf, JSON.stringify(bcur))
      }
      return { success: true, vectorId: 'v-' + p.index }
    },
    async query() { return { merged_chat_results: [], merged_kb_results: [] } },
    async listCollections() { return [] },
    async listBm25() { return [] },
    async close() {},
  }
}`
  writeFileSync(p, body, 'utf8')
  return p
}

function setup(rawOverrides = {}, mode = 'good') {
  const dir = mkdtempSync(join(tmpdir(), 'anima-ingest-'))
  const stub = makeStub(dir, mode)
  const { ctx, tools } = makeCtx()
  const raw = {
    enabled: true,
    engineModule: stub,
    data: { vectorRoot: join(dir, 'vectors'), sessionRoot: join(dir, 'sessions'), bm25Root: join(dir, 'bm25') },
    embed: { key: 'test-key', url: 'http://127.0.0.1:1/v1', model: 'stub' },
    ...rawOverrides,
  }
  apply(ctx, raw)
  const ingest = tools.get('anima_ingest')
  const status = tools.get('anima_status')
  assert.ok(ingest, 'anima_ingest 没注册')
  assert.ok(status, 'anima_status 没注册')
  return { dir, tools, ingest, status, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ─────────────────────────── 1) 配置默认值与合并语义

test('ingest 默认值：独立集合、默认可写、dir 留空', () => {
  const cfg = mergeConfig({})
  assert.equal(cfg.ingest.enabled, true)
  assert.equal(cfg.ingest.collectionId, 'dsh-memory')
  assert.equal(cfg.ingest.dir, '')
  // ★ 默认目标**不是** ST 那份集合 —— 写路径默认不许碰它（甲方案 T2 的硬约束）
  assert.notEqual(cfg.ingest.collectionId, cfg.chatCollections[0])
})

test('ingest 是内层合并：只给 collectionId 不会把 enabled/dir 丢掉', () => {
  const cfg = mergeConfig({ ingest: { collectionId: '我的库' } })
  assert.equal(cfg.ingest.collectionId, '我的库')
  assert.equal(cfg.ingest.enabled, true)
  assert.equal(cfg.ingest.dir, '')
})

// ─────────────────────────── 2) 守卫路径（都在 loadEngine 之前返回，不联网）

test('守卫：ingest.enabled=false 时拒写，且理由是"关了写入口"', async () => {
  const s = setup({ ingest: { enabled: false, collectionId: 'dsh-memory' } })
  try {
    const r = await s.ingest.execute({ texts: ['甲'] })
    assert.equal(r.ok, false)
    assert.equal(r.inserted, 0)
    assert.match(String(r.reason), /ingest-disabled/)
    assert.equal(r.verify, null)
  } finally { s.cleanup() }
})

test('守卫：没给集合且配置也为空 ⇒ no-collection（不许悄悄写进 chatCollections[0]）', async () => {
  const s = setup({ ingest: { collectionId: '' }, chatCollections: [] })
  try {
    const r = await s.ingest.execute({ texts: ['甲'] })
    assert.equal(r.ok, false)
    assert.match(String(r.reason), /no-collection/)
  } finally { s.cleanup() }
})

test('守卫：embedding 没 key ⇒ no-embed-key（不静默、不假装成功）', async () => {
  const s = setup({ embed: { key: '', url: 'http://127.0.0.1:1/v1', model: 'stub' } })
  try {
    const r = await s.ingest.execute({ texts: ['甲'] })
    assert.equal(r.ok, false)
    assert.match(String(r.reason), /no-embed-key/)
  } finally { s.cleanup() }
})

test('★ 回归：summariesDir 为 auto 时，anima_ingest 不传 dir 必须走解析（不能把 auto 当目录）', async () => {
  // 真机踩过：默认 dir 写成 `cfg.ingest?.dir || cfg.summariesDir` ⇒ 'auto' 被当字面路径，
  // 报「目录读不到：auto」。修法是走 resolveSummariesDir()。
  const s = setup({ summariesDir: 'auto' })
  try {
    const ws = join(s.dir, 'ws')
    const sumDir = join(ws, 'c1', 'p1', 'archive', 'summaries')
    mkdirSync(sumDir, { recursive: true })
    writeFileSync(join(sumDir, 'a.md'), '归档里的一条摘要', 'utf8')
    const mac = join(s.dir, 'ma.json')
    writeFileSync(mac, JSON.stringify({ root: { characterId: 'c1', playthroughId: 'p1' } }), 'utf8')
    // 重新 apply 一份带 auto 配置的（setup 里已经 apply 过，这里再建一个实例）
    const tools2 = new Map()
    const ctx2 = {
      logger: { info() {}, warn() {}, error() {}, log() {} },
      tools: { register: (t) => tools2.set(t.name, t) },
      systemPrompt: { section: () => () => {} },
      on: () => {}, effect: () => {},
      get agent() { throw new Error('cannot get property "agent" without inject') },
    }
    apply(ctx2, {
      enabled: true, engineModule: join(s.dir, 'stub-good.mjs'),   // setup() 生成的就是这个名字
      data: { vectorRoot: join(s.dir, 'v9'), sessionRoot: join(s.dir, 's9'), bm25Root: join(s.dir, 'b9') },
      embed: { key: 'k', url: 'http://127.0.0.1:1/v1', model: 'stub' },
      chatCollections: ['dsh-memory'],
      ingest: { enabled: true, collectionId: 'dsh-memory' },
      summariesDir: 'auto', workspaceBase: ws, memoryArchiveConfig: mac,
    })
    const r = await tools2.get('anima_ingest').execute({})
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.inserted, 1, JSON.stringify(r.results))
    assert.ok(String(r.results[0].index).startsWith('dsh_a.md'), r.results[0].index)   // 默认前缀 dsh
  } finally { s.cleanup() }
})

test('★ 目录模式优先读 index.json：tags 带上、import-* 批次清单跳过、空文件跳过', async () => {
  const s = setup()
  try {
    const d = join(s.dir, 'summaries2')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'a.md'), '真摘要正文', 'utf8')
    writeFileSync(join(d, 'imp.md'), '导入批次清单（不是摘要）', 'utf8')
    writeFileSync(join(d, 'empty.md'), '', 'utf8')          // 覆盖清理留下的空文件
    writeFileSync(join(d, 'index.json'), JSON.stringify({
      schemaVersion: 1, kind: 'dsh-tavern-l2-summaries', updatedAt: 'x',
      entries: [
        { id: 's-0000-0019-1', file: 'a.md', fromFloor: 0, toFloor: 19, tags: ['Important', 'Angst'] },
        { id: 'import-abc12345', file: 'imp.md', fromFloor: 0, toFloor: 253 },
        { id: 's-0000-0019-9', file: 'empty.md', fromFloor: 0, toFloor: 19 },
      ],
    }, null, 2) + '\n', 'utf8')
    const r = await s.ingest.execute({ dir: d, index_prefix: 'S' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.inserted, 1, JSON.stringify(r.results))
    assert.equal(r.results[0].index, 'S_a')                 // 去掉 .md 后缀
    assert.ok(r.skipped.some((x) => x.source === 'imp.md' && /import-/.test(x.reason)))
    assert.ok(r.skipped.some((x) => x.source === 'empty.md' && /空文本/.test(x.reason)))
    const vIdx = JSON.parse(readFileSync(join(s.dir, 'vectors', 'dsh-memory', 'index.json'), 'utf8'))
    assert.deepEqual(vIdx.items[0].metadata.tags, ['Important', 'Angst'])   // ★ tags 真的进向量库了
  } finally { s.cleanup() }
})

test('守卫：既没 texts 也没有来源目录 ⇒ no-source', async () => {
  const s = setup({ ingest: { dir: '' }, summariesDir: '' })
  try {
    const r = await s.ingest.execute({})
    assert.equal(r.ok, false)
    assert.match(String(r.reason), /no-source/)
  } finally { s.cleanup() }
})

test('守卫：texts 全是空白 ⇒ empty', async () => {
  const s = setup()
  try {
    const r = await s.ingest.execute({ texts: ['  ', ''] })
    assert.equal(r.ok, false)
    assert.match(String(r.reason), /empty/)
  } finally { s.cleanup() }
})

// ─────────────────────────── 3) 真写入 + 回读核对

test('真写入：两条索引都真增、verify 逐条查到、文件里真有这些 index', async () => {
  const s = setup()
  try {
    const r = await s.ingest.execute({ texts: ['第一段记忆', '第二段记忆'], tags: ['Important'], batch_id: 7, index_prefix: 'T' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.collectionId, 'dsh-memory')
    assert.equal(r.requested, 2)
    assert.equal(r.inserted, 2)
    assert.equal(r.failed, 0)
    assert.equal(r.verify.vector.found, 2)
    assert.equal(r.verify.vector.total, 2)
    assert.equal(r.verify.bm25.found, 2)
    assert.equal(r.verify.bm25.total, 2)
    assert.equal(r.truncated, false)
    assert.deepEqual(r.results.map((x) => x.index), ['T_1', 'T_2'])
    assert.ok(r.results.every((x) => x.ok === true && x.vectorId === 'v-' + x.index))

    // 落盘实证（不是只看返回值）
    const vf = join(s.dir, 'vectors', 'dsh-memory', 'index.json')
    const bf = join(s.dir, 'bm25', 'dsh-memory.json')
    assert.ok(existsSync(vf) && existsSync(bf), '两条索引文件都该在盘上')
    const vIdx = JSON.parse(readFileSync(vf, 'utf8'))
    assert.deepEqual(vIdx.items.map((i) => i.metadata.index), ['T_1', 'T_2'])
    assert.deepEqual(vIdx.items[0].metadata.tags, ['Important'])
    const bIdx = JSON.parse(readFileSync(bf, 'utf8'))
    assert.deepEqual(Object.values(bIdx.storedFields).map((x) => x.index), ['T_1', 'T_2'])
  } finally { s.cleanup() }
})

test('★ 反证：桩只写向量不写 BM25 ⇒ ok=false、verify.bm25.found=0（不许误报成功）', async () => {
  const s = setup({}, 'vectoronly')
  try {
    const r = await s.ingest.execute({ texts: ['只有向量'] })
    assert.equal(r.inserted, 1, '引擎自己报的是成功')
    assert.equal(r.verify.vector.found, 1)
    assert.equal(r.verify.bm25.found, 0, 'BM25 一条都没有')
    assert.equal(r.ok, false, '回读对不上就必须 false')
  } finally { s.cleanup() }
})

test('★ 反证：引擎返回 success:false ⇒ 计数与 message 如实上报', async () => {
  const s = setup({}, 'failing')
  try {
    const r = await s.ingest.execute({ texts: ['会失败'] })
    assert.equal(r.ok, false)
    assert.equal(r.inserted, 0)
    assert.equal(r.failed, 1)
    assert.equal(r.results[0].message, 'boom')
    assert.equal(r.results[0].status, 500)
    assert.equal(r.verify.vector.found, 0)
  } finally { s.cleanup() }
})

test('幂等：同一 index 重跑是覆盖，不是堆两条', async () => {
  const s = setup()
  try {
    await s.ingest.execute({ texts: ['第一版'], index_prefix: 'T' })
    const r2 = await s.ingest.execute({ texts: ['第二版'], index_prefix: 'T' })
    assert.equal(r2.ok, true)
    assert.equal(r2.inserted, 1)
    const vIdx = JSON.parse(readFileSync(join(s.dir, 'vectors', 'dsh-memory', 'index.json'), 'utf8'))
    assert.equal(vIdx.items.length, 1, '同名 index 该被覆盖掉')
    assert.equal(vIdx.items[0].metadata.text, '第二版')
  } finally { s.cleanup() }
})

// ─────────────────────────── 4) 目录模式

test('目录模式：每个 .txt/.md/.json 一条，index = <前缀>:<文件名>，空文件与坏 JSON 进 skipped', async () => {
  const s = setup()
  try {
    const d = join(s.dir, 'summaries')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'b.md'), 'B 的内容\n', 'utf8')
    writeFileSync(join(d, 'a.txt'), 'A 的内容\n', 'utf8')
    writeFileSync(join(d, 'c.json'), JSON.stringify({ text: 'C 的内容' }), 'utf8')
    writeFileSync(join(d, 'd.txt'), '   \n', 'utf8')
    writeFileSync(join(d, 'e.json'), '{坏 JSON', 'utf8')
    const r = await s.ingest.execute({ dir: d, index_prefix: 'S' })
    assert.equal(r.inserted, 3, JSON.stringify(r))
    assert.deepEqual(r.results.map((x) => x.index), ['S_a.txt', 'S_b.md', 'S_c.json'])
    assert.equal(r.skipped.length, 2)
    assert.ok(r.skipped.some((x) => x.source === 'd.txt' && /空文本/.test(x.reason)))
    assert.ok(r.skipped.some((x) => x.source === 'e.json'))
  } finally { s.cleanup() }
})

test('目录读不到 ⇒ reason 说明目录读不到（不抛）', async () => {
  const s = setup()
  try {
    const r = await s.ingest.execute({ dir: join(s.dir, '不存在') })
    assert.equal(r.ok, false)
    assert.match(String(r.reason), /目录读不到/)
  } finally { s.cleanup() }
})

// ─────────────────────────── 5) 计数与观测面（T6）

test('anima_status：写入口信息与计数如实反映（含 lastInsert 两条索引的回读数）', async () => {
  const s = setup()
  try {
    const before = await s.status.execute()
    assert.equal(before.ingest.enabled, true)
    assert.equal(before.ingest.collectionId, 'dsh-memory')
    assert.equal(before.stats.inserts, 0)
    assert.equal(before.stats.insertErrors, 0)
    assert.equal(before.stats.lastInsert, null)

    await s.ingest.execute({ texts: ['一', '二'], index_prefix: 'N' })
    const after = await s.status.execute()
    assert.equal(after.stats.inserts, 2)
    assert.equal(after.stats.insertErrors, 0)
    assert.equal(after.stats.lastInsert.collectionId, 'dsh-memory')
    assert.equal(after.stats.lastInsert.inserted, 2)
    assert.equal(after.stats.lastInsert.vectorFound, 2)
    assert.equal(after.stats.lastInsert.bm25Found, 2)

    // 失败也要进计数（不许静默）
    const s2 = setup({}, 'failing')
    try {
      await s2.ingest.execute({ texts: ['失败'] })
      const st = await s2.status.execute()
      assert.equal(st.stats.inserts, 0)
      assert.equal(st.stats.insertErrors, 1)
    } finally { s2.cleanup() }
  } finally { s.cleanup() }
})

test('★ 反证：anima_status 的 output.schema 必须声明新键（否则宿主整工具拒收）', () => {
  const s = setup()
  try {
    const props = s.status.output.schema.properties
    for (const k of ['inserts', 'insertErrors', 'lastInsert']) {
      assert.ok(Object.hasOwn(props.stats.properties, k), `stats.${k} 没在 schema 里声明`)
    }
    assert.ok(Object.hasOwn(props, 'ingest'), 'ingest 没在 schema 里声明')
    assert.equal(props.ingest.additionalProperties, false)
    const ing = s.ingest.output.schema
    assert.equal(ing.additionalProperties, false)
    for (const k of ['ok', 'collectionId', 'requested', 'inserted', 'failed', 'truncated', 'reason', 'skipped', 'verify', 'results']) {
      assert.ok(ing.required.includes(k), `anima_ingest 的 ${k} 没进 required`)
      assert.ok(Object.hasOwn(ing.properties, k), `anima_ingest 的 ${k} 没进 properties`)
    }
  } finally { s.cleanup() }
})
