/**
 * 冷启动加固自检（2026-09-16 真机实测后加）——
 *   ① 写入侧：**超时**才重试、有上限、计数可见；非超时错误不重试。
 *   ② 检索侧：**同一个 turn 只等一次** —— 一轮里 assemble 会跑很多次（每个 step 一次），
 *      原来每次超时都不缓存 ⇒ 后面每个 step 都会再等一遍同一个在途任务，一轮能卡出好几倍 timeoutMs。
 *
 * ⛔ 不联网、不碰真机：引擎是测试生成的桩；`summariesDir` 指临时目录。
 * ⚠️ 假 ctx 是**严格模式**（读未声明的 `agent` 会抛），与真机 cordis 行为一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

const stubSource = (mode) => `
import { appendFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const CALLS = join(dirname(fileURLToPath(import.meta.url)), 'calls.jsonl')
const MODE = ${JSON.stringify(mode)}
let insertAttempts = 0
export function createEngine({ vectorRoot, bm25Root }) {
  return {
    async insert(p) {
      insertAttempts += 1
      appendFileSync(CALLS, JSON.stringify({ op: 'insert', index: p.index, attempt: insertAttempts, timeoutMs: p.apiConfig?.timeout_ms ?? null }) + '\\n')
      if (MODE === 'flaky2' && insertAttempts <= 2) {
        return { success: false, status: 500, message: '向量 API 请求超时无响应，请检查代理节点或网络稳定性' }
      }
      if (MODE === 'hardfail') return { success: false, status: 400, message: 'Text content is invalid or missing.' }
      // 成功时**真的写两个索引**（否则回读核对会如实报 not-found ⇒ ok=false，那是核对在起作用）
      mkdirSync(join(vectorRoot, p.collectionId), { recursive: true })
      const vf = join(vectorRoot, p.collectionId, 'index.json')
      const cur = existsSync(vf) ? JSON.parse(readFileSync(vf, 'utf8')) : { items: [] }
      cur.items = cur.items.filter((it) => String(it?.metadata?.index) !== String(p.index))
      cur.items.push({ id: 'v' + cur.items.length, metadata: { text: p.text, tags: p.tags, timestamp: p.timestamp, index: p.index, batch_id: p.batch_id } })
      writeFileSync(vf, JSON.stringify(cur))
      mkdirSync(bm25Root, { recursive: true })
      const bf = join(bm25Root, p.collectionId + '.json')
      const bcur = existsSync(bf) ? JSON.parse(readFileSync(bf, 'utf8')) : { storedFields: {} }
      bcur.storedFields['d' + Object.keys(bcur.storedFields).length] = { text: p.text, tags: p.tags, index: p.index, batch_id: p.batch_id }
      writeFileSync(bf, JSON.stringify(bcur))
      return { success: true, vectorId: 'v-' + p.index }
    },
    async query() {
      appendFileSync(CALLS, JSON.stringify({ op: 'query' }) + '\\n')
      if (MODE === 'hangquery') return new Promise(() => {})
      return { merged_chat_results: [], merged_kb_results: [] }
    },
    async listCollections() { return [] }, async listBm25() { return [] }, async close() {},
  }
}
`

function setup({ mode = 'ok', timeoutMs = 300, ingest = { enabled: true, collectionId: 'dsh-memory', auto: false } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'anima-hard-'))
  const stubPath = join(dir, 'stub.mjs')
  writeFileSync(stubPath, stubSource(mode), 'utf8')
  const sumDir = join(dir, 'summaries')
  mkdirSync(sumDir, { recursive: true })
  const tools = new Map()
  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, log() {} },
    tools: { register: (t) => tools.set(t.name, t) },
    systemPrompt: { section: () => () => {} },
    on: (ev, fn) => handlers.set(ev, fn),
    effect: () => {},
    // ★ 严格模式：真机上读未注入的 `agent` 会抛，这里也抛（免得再把这类 bug 盖住）
    get agent() { throw new Error('cannot get property "agent" without inject') },
  }
  apply(ctx, {
    enabled: true,
    engineModule: stubPath,
    data: { vectorRoot: join(dir, 'v'), sessionRoot: join(dir, 's'), bm25Root: join(dir, 'b') },
    embed: { key: 'k', url: 'http://127.0.0.1:1/v1', model: 'stub', timeout_ms: 60000 },
    chatCollections: ['dsh-memory'],
    ingest,
    summariesDir: sumDir,
    timeoutMs,
    // ★ 2026-09-26（本轮实测修）：必须显式关掉**周目隔离**，否则 `retrieve()` 在
    //   `isolationPlan()` 那一脚就 `blocked`（测试用的会话 id 不在 Tavern catalog 里）
    //   ⇒ 立刻返回、**根本走不到引擎那个挂死的 query**，③④ 断言的"等满 timeoutMs"就永远不成立。
    //   （这是 2026-09-20「会话优先 + fail-closed」之后的既有偏差，与 BM25 退役无关；本测关心的是
    //    "同一个 turn 只等一次"这条**超时**行为，隔离是正交的 —— 用配置里给的那个开关关掉它。）
    inject: { allowSessions: [], rpOnly: false, recentCount: 0, isolatePlaythrough: false },
  })
  const calls = () => {
    const p = join(dir, 'calls.jsonl')
    return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  }
  const assemble = async (turn = 1) => {
    const h = handlers.get('system-prompt/assemble')
    const events = [{ type: 'turn/start', seq: 1, data: { turn } }, { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '一句话' }], source: { kind: 'user' } } }]
    const agent = { id: 'strict-session', session: { id: 'strict-session', snapshotEvents: () => events } }
    const t0 = Date.now()
    await h({ sections: [] }, { agent }, () => Promise.resolve({ sections: [] }))
    return Date.now() - t0
  }
  return { dir, tools, calls, assemble, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('① 写入超时 ⇒ 重试（第 3 次成功），attempts / insertRetries 都如实上报', async () => {
  const s = setup({ mode: 'flaky2' })
  try {
    const r = await s.tools.get('anima_ingest').execute({ texts: ['会先超时两次'], index_prefix: 'RT' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.inserted, 1)
    assert.equal(r.results[0].attempts, 3, '应记 3 次尝试')
    const st = await s.tools.get('anima_status').execute()
    assert.equal(st.stats.insertRetries, 2, `insertRetries 应为 2，实际 ${st.stats.insertRetries}`)
    assert.equal(st.stats.inserts, 1)
    const ins = s.calls().filter((c) => c.op === 'insert')
    assert.equal(ins.length, 3)
    assert.ok(ins.every((c) => c.timeoutMs === 60000), 'apiConfig 必须带上 timeout_ms（否则引擎用硬编码 15s）')
  } finally { s.cleanup() }
})

test('② 非超时错误**不重试**（只试 1 次）', async () => {
  const s = setup({ mode: 'hardfail' })
  try {
    const r = await s.tools.get('anima_ingest').execute({ texts: ['400 错误'], index_prefix: 'HF' })
    assert.equal(r.ok, false)
    assert.equal(r.results[0].attempts, 1, '不该对 400 重试')
    assert.equal(s.calls().filter((c) => c.op === 'insert').length, 1)
  } finally { s.cleanup() }
})

test('★ ③ 同一个 turn 只等一次：第一次等满 timeoutMs，后续 step 立刻返回', async () => {
  const s = setup({ mode: 'hangquery', timeoutMs: 300 })
  try {
    const d1 = await s.assemble(1)
    const d2 = await s.assemble(1)
    const d3 = await s.assemble(1)
    assert.ok(d1 >= 280, `第一次应等满 ~300ms，实际 ${d1}ms`)
    assert.ok(d2 < 100, `同一 turn 第二次不该再等，实际 ${d2}ms`)
    assert.ok(d3 < 100, `同一 turn 第三次不该再等，实际 ${d3}ms`)
    assert.equal(s.calls().filter((c) => c.op === 'query').length, 1, '在途任务只该起一次')
    const st = await s.tools.get('anima_status').execute()
    assert.equal(st.stats.timeouts, 1, `timeouts 应为 1，实际 ${st.stats.timeouts}`)
  } finally { s.cleanup() }
})

test('④ 换一个 turn ⇒ 会重新尝试（不是永久放弃）', async () => {
  const s = setup({ mode: 'hangquery', timeoutMs: 200 })
  try {
    const d1 = await s.assemble(1)
    assert.ok(d1 >= 180, `turn=1 应等满，实际 ${d1}ms`)
    const d2 = await s.assemble(2)
    assert.ok(d2 >= 180, `换 turn 应重新尝试（再等一次），实际 ${d2}ms`)
    assert.equal(s.calls().filter((c) => c.op === 'query').length, 2)
  } finally { s.cleanup() }
})
