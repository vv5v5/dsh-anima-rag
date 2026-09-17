/**
 * 近场记忆目录解析自检（T4）—— `summariesDir` 的三态 + `'auto'` 的推导。
 *
 * 背景（实测）：写死路径**已经错过一次** —— 真机配置写着 `playthrough-0f08d055-…`（目录不存在），
 * memory-archive 的 root 却指向 `playthrough-938a0d26-…`，Tavern 目录里能发现的又是
 * `playthrough-1e59aed6-…`。所以 `'auto'` 必须**从 memory-archive 的 root 推**，不是猜。
 *
 * ⛔ 不碰真机配置：这里给的是临时目录里的假 config.json。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, mergeConfig } from '../lib/index.js'

function makeCtx() {
  const tools = new Map()
  return {
    tools,
    ctx: {
      logger: { info() {}, warn() {}, error() {}, log() {} },
      tools: { register: (t) => tools.set(t.name, t) },
      systemPrompt: { section: () => () => {} },
      on: () => {},
      effect: () => {},
  // ★ 严格模式（2026-09-16 加）：未声明的属性一律**抛**，模拟 cordis 的 ctx 代理。
  //   起因：真机上 `anima_query` 读 `ctx.agent` 直接抛（未 inject），而宽松的假 ctx 把它盖住了。
  //   用 getter 而不是 Proxy：这里只需要 `agent` 这一个已知会抛的成员。
  get agent() { throw new Error('cannot get property "agent" without inject') },    },
  }
}

/** 最小桩引擎：本测只关心「目录解析」，不该为了一个路径去碰 vectra。 */
function makeStub(dir) {
  const p = join(dir, 'stub.mjs')
  writeFileSync(p, `export function createEngine() {
  return { async insert() { return { success: true, vectorId: 'x' } },
    async query() { return { merged_chat_results: [], merged_kb_results: [] } },
    async listCollections() { return [] }, async listBm25() { return [] }, async close() {} }
}`, 'utf8')
  return p
}

function boot(raw) {
  const dir = mkdtempSync(join(tmpdir(), 'anima-sum-'))
  const { ctx, tools } = makeCtx()
  apply(ctx, {
    enabled: true,
    engineModule: makeStub(dir),
    data: { vectorRoot: join(dir, 'v'), sessionRoot: join(dir, 's'), bm25Root: join(dir, 'b') },
    embed: { key: 'k', url: 'http://127.0.0.1:1/v1', model: 'stub' },
    ...raw,
  })
  return { dir, status: tools.get('anima_status'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const CHAR = '70a0502d-b4e9-472f-8d5a-1c7b32b2e7ac'
const PLAY = 'playthrough-938a0d26-05be-43aa-8962-4077ec4bc727'

test("summariesDir:'auto' ⇒ 从 memory-archive 的 root 推出 <base>/<char>/<play>/archive/summaries", async () => {
  const s = boot({})
  try {
    // 假 memory-archive 配置：root 里有角色与周目
    const mac = join(s.dir, 'ma-config.json')
    writeFileSync(mac, JSON.stringify({ rootMode: 'workspace', root: { sessionId: null, characterId: CHAR, playthroughId: PLAY } }), 'utf8')
    const s2 = boot({ summariesDir: 'auto', workspaceBase: 'D:\\base', memoryArchiveConfig: mac })
    try {
      const st = await s2.status.execute()
      assert.equal(st.summaries.mode, 'auto')
      assert.equal(st.summaries.dir, join('D:\\base', CHAR, PLAY, 'archive', 'summaries'))
      assert.equal(st.summaries.exists, false)   // 目录还没建 ⇒ 如实报 false，不是报错
      assert.equal(st.summaries.hasIndex, false)
    } finally { s2.cleanup() }
  } finally { s.cleanup() }
})

test("默认就是 'auto'（且默认 workspaceBase 指向 Tavern 工作区根）", async () => {
  const c = mergeConfig({})
  assert.equal(c.summariesDir, 'auto')
  assert.equal(c.workspaceBase, 'D:\\apps\\dsh-tarven')
  assert.equal(c.memoryArchiveConfig, '')
})

test("'auto' 但 memory-archive 配置读不到 ⇒ dir 为空（该段不注入，不抛）", async () => {
  const s = boot({ summariesDir: 'auto', workspaceBase: 'D:\\base', memoryArchiveConfig: 'D:\\不存在的\\config.json' })
  try {
    const st = await s.status.execute()
    assert.equal(st.summaries.mode, 'auto')
    assert.equal(st.summaries.dir, '')
    assert.equal(st.summaries.exists, false)
  } finally { s.cleanup() }
})

test("'auto' 但 root 缺角色/周目 ⇒ dir 为空（半截 id 不硬拼路径）", async () => {
  const s = boot({})
  try {
    const mac = join(s.dir, 'ma-half.json')
    writeFileSync(mac, JSON.stringify({ root: { characterId: CHAR, playthroughId: '' } }), 'utf8')
    const s2 = boot({ summariesDir: 'auto', workspaceBase: 'D:\\base', memoryArchiveConfig: mac })
    try {
      const st = await s2.status.execute()
      assert.equal(st.summaries.dir, '')
    } finally { s2.cleanup() }
  } finally { s.cleanup() }
})

test('写死路径仍然可用（mode=path），且 exists/hasIndex 如实反映', async () => {
  const s = boot({})
  try {
    const d = join(s.dir, 'explicit', 'summaries')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'index.json'), JSON.stringify({ entries: [{ file: 'a.md' }] }), 'utf8')
    const s2 = boot({ summariesDir: d })
    try {
      const st = await s2.status.execute()
      assert.equal(st.summaries.mode, 'path')
      assert.equal(st.summaries.dir, d)
      assert.equal(st.summaries.exists, true)
      assert.equal(st.summaries.hasIndex, true)
    } finally { s2.cleanup() }
  } finally { s.cleanup() }
})

test("summariesDir:'' ⇒ mode=off、dir 空（明确关掉，而不是悄悄读别处）", async () => {
  const s = boot({ summariesDir: '' })
  try {
    const st = await s.status.execute()
    assert.equal(st.summaries.mode, 'off')
    assert.equal(st.summaries.dir, '')
  } finally { s.cleanup() }
})
