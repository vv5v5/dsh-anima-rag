/**
 * 「按周目清理」（`anima_forget`）自检（2026-09-16）。
 *
 * 背景：删掉一个周目后，它的归档进了 Tavern 回收站，但**记忆库里的切片不会跟着删**
 * （engine 只暴露 `{query,insert,listCollections,listBm25,close}`，**没有 delete**；
 * BM25 又是 MiniSearch 的序列化态、不能手工改）⇒ 清理只能**整集重建**：
 * 备份 → 清缓存 → 清空 → 把**现存周目**按 index 重灌。
 *
 * 这里守的就四件事：① 入库时真的打上 `pt:<周目>` 标；② dryRun 零写入；
 * ③ 真清理只留下"保留者"、被忘掉的那条不在了、备份在；④ 两条安全闸。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

const CHAR = 'c1'
const A = 'playthrough-A'
const B = 'playthrough-B'

/** 桩引擎：与 ingest 那台同款（写向量 index.json + BM25 json，支持 close()）。 */
const stub = `
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
export function createEngine({ vectorRoot, bm25Root }) {
  return {
    async insert(p) {
      mkdirSync(join(vectorRoot, p.collectionId), { recursive: true })
      const vf = join(vectorRoot, p.collectionId, 'index.json')
      const cur = existsSync(vf) ? JSON.parse(readFileSync(vf, 'utf8')) : { items: [] }
      cur.items = cur.items.filter((it) => String(it?.metadata?.index) !== String(p.index))
      cur.items.push({ id: 'v' + cur.items.length, metadata: { text: p.text, tags: p.tags, timestamp: p.timestamp, index: p.index, batch_id: p.batch_id } })
      writeFileSync(vf, JSON.stringify(cur))
      mkdirSync(bm25Root, { recursive: true })
      const bf = join(bm25Root, p.collectionId + '.json')
      const bcur = existsSync(bf) ? JSON.parse(readFileSync(bf, 'utf8')) : { storedFields: {} }
      bcur.storedFields['d' + Object.keys(bcur.storedFields).length] = { text: p.text, tags: p.tags, index: p.index }
      writeFileSync(bf, JSON.stringify(bcur))
      return { success: true, vectorId: 'v-' + p.index }
    },
    async query() { return { merged_chat_results: [], merged_kb_results: [] } },
    async listCollections() { return [] }, async listBm25() { return [] },
    async close() { globalThis.__closed = (globalThis.__closed ?? 0) + 1 },
  }
}
`

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'anima-forget-'))
  const stubPath = join(dir, 'stub.mjs')
  writeFileSync(stubPath, stub, 'utf8')
  const ws = join(dir, 'ws')
  const mkSum = (play, entries) => {
    const d = join(ws, CHAR, play, 'archive', 'summaries')
    mkdirSync(d, { recursive: true })
    for (const [file, text] of entries) writeFileSync(join(d, file), text, 'utf8')
    writeFileSync(join(d, 'index.json'), JSON.stringify({
      schemaVersion: 1, kind: 'dsh-tavern-l2-summaries', updatedAt: 'x',
      entries: entries.map(([file], i) => ({ id: file.replace(/\.md$/, ''), file, fromFloor: i * 20, toFloor: i * 20 + 19, tags: i === 0 ? ['Important'] : [] })),
    }, null, 2) + '\n', 'utf8')
    return d
  }
  const sumA = mkSum(A, [['a1.md', 'A 周目的第一条记忆正文'], ['a2.md', 'A 周目的第二条记忆正文']])
  const sumB = mkSum(B, [['b1.md', 'B 周目的唯一一条记忆正文']])
  // memory-archive 的假配置：root 指 B（自动入库会读它）
  const mac = join(dir, 'ma.json')
  writeFileSync(mac, JSON.stringify({ root: { characterId: CHAR, playthroughId: B }, rootMode: 'workspace' }), 'utf8')
  const tools = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, log() {} },
    tools: { register: (t) => tools.set(t.name, t) },
    systemPrompt: { section: () => () => {} },
    on: () => {}, effect: () => {},
    get agent() { throw new Error('cannot get property "agent" without inject') },
  }
  apply(ctx, {
    enabled: true, engineModule: stubPath,
    data: { vectorRoot: join(dir, 'v'), sessionRoot: join(dir, 's'), bm25Root: join(dir, 'b') },
    embed: { key: 'k', url: 'http://127.0.0.1:1/v1', model: 'stub' },
    chatCollections: ['dsh-memory'],
    ingest: { enabled: true, collectionId: 'dsh-memory' },
    summariesDir: 'auto', workspaceBase: ws, memoryArchiveConfig: mac,
  })
  const readColl = () => {
    const p = join(dir, 'v', 'dsh-memory', 'index.json')
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).items : []
  }
  return {
    dir, ws, sumA, sumB, tools, readColl,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('① 入库时打上 `pt:<周目>` 标（从来源目录反推）', async () => {
  const s = setup()
  try {
    const r = await s.tools.get('anima_ingest').execute({ dir: s.sumA })
    assert.equal(r.ok, true, JSON.stringify(r))
    const tags = s.readColl().map((i) => i.metadata.tags).flat()
    assert.ok(tags.includes('pt:' + A), '缺 pt 标：' + JSON.stringify(tags))
    assert.ok(tags.includes('Important'), '原有 tags 不该被吃掉')
    assert.ok(!tags.includes('pt:' + B), 'A 的切片不该带 B 的标')
  } finally { s.cleanup() }
})

test('② dryRun：只出计划、零写入、无备份', async () => {
  const s = setup()
  try {
    const ing = await s.tools.get('anima_ingest').execute({ dir: s.sumA })
    assert.equal(ing.inserted, 2)
    const before = JSON.stringify(s.readColl())
    const r = await s.tools.get('anima_forget').execute({ playthroughId: A, dryRun: true })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.dryRun, true)
    assert.equal(r.keeping, 1, '应保留 1 个周目（B）')
    assert.equal(r.keepSlices, 1, 'B 有 1 条切片')
    assert.equal(r.backup, null)
    assert.equal(JSON.stringify(s.readColl()), before, 'dryRun 不许动集合')
  } finally { s.cleanup() }
})

test('★ ③ 真清理：只留保留者、被忘掉的不在了、备份在、标记住了周目', async () => {
  const s = setup()
  try {
    await s.tools.get('anima_ingest').execute({ dir: s.sumA })   // A 两条进库
    const r = await s.tools.get('anima_forget').execute({ playthroughId: A })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.inserted, 1, '应把 B 的 1 条重灌回来')
    const items = s.readColl()
    assert.equal(items.length, 1, JSON.stringify(items.map((i) => i.metadata.index)))
    assert.equal(items[0].metadata.text, 'B 周目的唯一一条记忆正文')
    assert.ok(items[0].metadata.tags.includes('pt:' + B))
    assert.ok(!JSON.stringify(items).includes('A 周目的'), 'A 的正文不该还在')
    // 备份两份文件都在
    assert.ok(r.backup && existsSync(join(r.backup, 'vectors', 'index.json')), '备份缺向量索引：' + r.backup)
    assert.ok(existsSync(join(r.backup, 'bm25.json')), '备份缺 BM25：' + r.backup)
    assert.ok(existsSync(join(s.dir, 'b', 'dsh-memory.json')), 'BM25 应被重灌出来')
  } finally { s.cleanup() }
})

test('④ all:true ⇒ 整集清空、不重灌', async () => {
  const s = setup()
  try {
    await s.tools.get('anima_ingest').execute({ dir: s.sumA })
    assert.equal(s.readColl().length, 2)
    const r = await s.tools.get('anima_forget').execute({ all: true })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.inserted, 0)
    assert.equal(s.readColl().length, 0)
    assert.ok(!existsSync(join(s.dir, 'b', 'dsh-memory.json')), 'BM25 也该被清掉')
  } finally { s.cleanup() }
})

test('★ ⑤ 安全闸：保留者一条都读不到 ⇒ 拒绝清空（不许把记忆全删光）', async () => {
  const s = setup()
  try {
    // 把 B 的正文清空（模拟"保留者的切片读不出来"）
    writeFileSync(join(s.sumB, 'b1.md'), '', 'utf8')
    const r = await s.tools.get('anima_forget').execute({ playthroughId: A })
    assert.equal(r.ok, false)
    assert.match(String(r.reason), /拒绝清空/)
  } finally { s.cleanup() }
})

test('⑤ 安全闸：既没 playthroughId 也没 all ⇒ 拒', async () => {
  const s = setup()
  try {
    const r = await s.tools.get('anima_forget').execute({})
    assert.equal(r.ok, false)
    assert.match(String(r.reason), /需要 playthroughId/)
  } finally { s.cleanup() }
})

test('⑥ 从非周目目录入库 ⇒ 不打 pt 标（不猜）', async () => {
  const s = setup()
  try {
    const d = join(s.dir, 'loose')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'x.md'), '随手放的一条', 'utf8')
    const r = await s.tools.get('anima_ingest').execute({ dir: d })
    assert.equal(r.ok, true, JSON.stringify(r))
    const tags = s.readColl().map((i) => i.metadata.tags).flat()
    assert.ok(!tags.some((t) => String(t).startsWith('pt:')), '不该凭空造周目标：' + JSON.stringify(tags))
  } finally { s.cleanup() }
})
