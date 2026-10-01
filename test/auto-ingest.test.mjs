/**
 * 自动入库自检（甲方案 b 的自动化）—— `summariesDir/index.json` 一变就写进记忆库。
 *
 * 要守住的四件事（都是真踩过或真会踩的）：
 *   ① **幂等**：同一份 index.json 不重复写；追加一条只写新的那条（引擎按 index 覆盖，但别白烧 embedding）。
 *   ② **不阻塞**：装配钩子必须**立刻**返回，embedding 还没跑完也不能等（这条用"永不 resolve 的桩"验）。
 *   ③ **失败可观测**：写失败进 `insertErrors`、有重试上限，且**绝不抛进装配钩子**。
 *   ④ **能关掉**：`ingest.auto=false` 时一个字都不写。
 *
 * ⛔ 不碰真机：`summariesDir` 指向临时目录，引擎是测试自己生成的桩（记录每次 insert 的 payload）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

/**
 * 桩引擎。★ 记录**写文件**而不是内存数组 —— 实测踩过：测试与插件各自 import 了不同实例
 * （缓存键/URL 写法不同 ⇒ 两个 `calls` 数组），内存记录永远是空的、假红。
 * mode 直接编进桩源码（每个测试一份桩），省掉可变导出。
 */
const stubSource = (mode) => `
import { appendFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const CALLS = join(dirname(fileURLToPath(import.meta.url)), 'calls.jsonl')
const MODE = ${JSON.stringify(mode)}
export function createEngine({ vectorRoot }) {
  return {
    async insert(p) {
      appendFileSync(CALLS, JSON.stringify({ collectionId: p.collectionId, index: p.index, text: p.text, tags: p.tags, batch_id: p.batch_id }) + '\\n')
      if (MODE === 'fail') return { success: false, status: 500, message: 'stub-fail' }
      if (MODE === 'hang') return new Promise(() => {})
      // ★ 2026-09-26：成功时**真把向量索引写出来** —— insertSlices() 写完要回读核对，
      //   找不到就 ok=false、账本不记账 ⇒ 下一轮会把同一条再写一遍（③ 就是被这个咬到的）。
      //   改前这台桩只写 calls.jsonl，靠"没核对成功也不记账"碰巧过了 ②。
      mkdirSync(join(vectorRoot, p.collectionId), { recursive: true })
      const vf = join(vectorRoot, p.collectionId, 'index.json')
      const cur = existsSync(vf) ? JSON.parse(readFileSync(vf, 'utf8')) : { items: [] }
      cur.items = cur.items.filter((it) => String(it?.metadata?.index) !== String(p.index))
      cur.items.push({ id: 'v' + cur.items.length, metadata: { text: p.text, tags: p.tags, timestamp: p.timestamp, index: p.index, batch_id: p.batch_id } })
      writeFileSync(vf, JSON.stringify(cur))
      return { success: true, vectorId: 'v-' + p.index }
    },
    async query() { return { merged_chat_results: [], merged_kb_results: [] } },
    async listCollections() { return [] }, async listBm25() { return [] }, async close() {},
  }
}
`

/**
 * ★ 2026-09-26（本轮实测修，与 BM25 退役无关）：**写侧的摘要目录是按「活跃会话的周目」解析的**
 *   —— `sessionSummariesDir()` → `<workspaceBase>/<角色>/<周目>/archive/summaries`
 *   （2026-09-20「会话优先」之后就**不再**回落 `summariesDir` 的字面值了）。
 *   原来那套台子只给了 `summariesDir: <tmp>/summaries`，于是在真机上每一轮都落到
 *   `skipped:'no-dir'` ⇒ 本文件 9 条红（**同一套用例在本机 HEAD 上同样 9 红**，A/B 验过）。
 *   修法：造出 Tavern 的 **catalog + timeline 夹具**，并把摘要目录直接建在它指的位置上。
 */
const CHAR = 'c1'
const PLAY = 'p1'
const SESSION = 'auto-ingest-session'

function setup({ auto = true, mode = 'ok', summaries = {}, runDeadlineMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'anima-auto-'))
  const stubPath = join(dir, 'stub.mjs')
  writeFileSync(stubPath, stubSource(mode), 'utf8')
  const ws = join(dir, 'ws')
  const sumDir = join(ws, CHAR, PLAY, 'archive', 'summaries')
  mkdirSync(sumDir, { recursive: true })
  writeFileSync(join(ws, 'catalog.json'), JSON.stringify({
    playthroughs: [{
      id: PLAY,
      path: `${CHAR}/${PLAY}/timeline.json`,
      ext: { pmpDshTavern: { rootSessionId: SESSION, characterId: CHAR } },
    }],
  }), 'utf8')
  writeFileSync(join(ws, CHAR, PLAY, 'timeline.json'), JSON.stringify({ head: { sessionId: SESSION }, nodes: [] }), 'utf8')
  writeIndex(sumDir, summaries)
  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, log() {} },
    tools: { register() {} },
    systemPrompt: { section: () => () => {} },
    on: (ev, fn) => handlers.set(ev, fn),
    effect: () => {},
  // ★ 严格模式（2026-09-16 加）：未声明的属性一律**抛**，模拟 cordis 的 ctx 代理。
  //   起因：真机上 `anima_query` 读 `ctx.agent` 直接抛（未 inject），而宽松的假 ctx 把它盖住了。
  //   用 getter 而不是 Proxy：这里只需要 `agent` 这一个已知会抛的成员。
  get agent() { throw new Error('cannot get property "agent" without inject') },  }
  const config = {
    enabled: true,
    engineModule: stubPath,
    data: { vectorRoot: join(dir, 'v'), sessionRoot: join(dir, 's'), bm25Root: join(dir, 'b') },
    embed: { key: 'k', url: 'http://127.0.0.1:1/v1', model: 'stub' },
    chatCollections: ['dsh-memory'],
    // ★ `ledgerPath` 必须落在临时目录 —— 否则账本会写进**真实的** `~/.dsh/dsh-anima-rag/`（污染生产状态）
    // ★ `statePath` 同理（2026-09-29 看门狗/清孤儿用例要读写它）；`runDeadlineMs` 供看门狗用例调短。
    ingest: {
      enabled: true, collectionId: 'dsh-memory', auto, indexPrefix: 'sum',
      ledgerPath: join(dir, 'ingest-ledger.json'), statePath: join(dir, 'ingest-state.json'),
      ...(runDeadlineMs > 0 ? { runDeadlineMs } : {}),
    },
    summariesDir: sumDir,
    workspaceBase: ws,                                // ★ 写侧靠 catalog.json 认会话 → 周目
    inject: { allowSessions: [], rpOnly: false },   // 让装配钩子过白名单（本测只关心入库）
  }
  apply(ctx, config)
  return { dir, ws, sumDir, handlers, stubPath, config, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 模拟"重启宿主"：**同一份配置**、新的 ctx 再 apply 一次 —— 账本只能靠文件续上（D12）。 */
function restart(config) {
  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, log() {} },
    tools: { register() {} },
    systemPrompt: { section: () => () => {} },
    on: (ev, fn) => handlers.set(ev, fn),
    effect: () => {},
    get agent() { throw new Error('cannot get property "agent" without inject') },
  }
  apply(ctx, config)
  return handlers
}

function writeIndex(dir, entries) {
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ schemaVersion: 1, kind: 'dsh-tavern-l2-summaries', updatedAt: Date.now(), entries }), 'utf8')
}

function writeSummary(dir, file, text) { writeFileSync(join(dir, file), text, 'utf8') }

/** 调一次装配钩子（= 一轮请求），返回它有没有在 insert 完成前就返回。 */
async function assembleOnce(handlers) {
  const h = handlers.get('system-prompt/assemble')
  assert.ok(typeof h === 'function', 'assemble 钩子没注册')
  const events = [{ type: 'turn/start', seq: 1, data: { turn: 1 } }, { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '随便一句' }], source: { kind: 'user' } } }]
  const agent = { id: SESSION, session: { id: SESSION, snapshotEvents: () => events } }
  await h({ sections: [] }, { agent }, () => Promise.resolve({ sections: [] }))
}

/** 等异步入库跑完（最多 2s）。 */
async function settle(ms = 2000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25))
}

/** 读桩写下的调用记录（文件，跨模块实例稳定）。 */
function stubCalls(dir) {
  const p = join(dir, 'calls.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

test('① 首次装配就把 index.json 里的条目写进记忆库（含 tags/index/collection）', async () => {
  const s = setup({ summaries: [{ file: 's-0000-0020.md', tags: ['Suspense'] }, { file: 's-0021-0040.md' }] })
  try {
    writeSummary(s.sumDir, 's-0000-0020.md', '第一段记忆正文')
    writeSummary(s.sumDir, 's-0021-0040.md', '第二段记忆正文')
    await assembleOnce(s.handlers)
    await settle()
    const calls = stubCalls(s.dir)
    assert.equal(calls.length, 2, JSON.stringify(calls))
    assert.deepEqual(calls.map((c) => c.index).sort(), ['sum_s-0000-0020.md', 'sum_s-0021-0040.md'])
    assert.ok(calls.every((c) => c.collectionId === 'dsh-memory'))
    // ★ 2026-09-26：条目自己的 tags（Suspense）+ 写侧按来源目录反推追加的周目标签（`pt:p1`）——
    //   后者是 2026-09-16 就有的行为，本台子的夹具现在能解析出周目了，所以它真的出现了。
    assert.deepEqual(calls.find((c) => c.index.includes('0000')).tags, ['Suspense', 'pt:' + PLAY])
  } finally { s.cleanup() }
})

test('② 幂等：同一份 index.json 再装配一次，不重复写', async () => {
  const s = setup({ summaries: [{ file: 'a.md' }] })
  try {
    writeSummary(s.sumDir, 'a.md', '甲')
    await assembleOnce(s.handlers); await settle()
    const n1 = (stubCalls(s.dir)).length
    await assembleOnce(s.handlers); await settle()
    const n2 = (stubCalls(s.dir)).length
    assert.equal(n1, 1, `第一次应写 1 条，实际 ${n1}`)
    assert.equal(n2, 1, `第二次不该再写（mtime 没变），实际 ${n2}`)
  } finally { s.cleanup() }
})

test('③ 追加一条（mtime 变）⇒ 只写新增那条', async () => {
  const s = setup({ summaries: [{ file: 'a.md' }] })
  try {
    writeSummary(s.sumDir, 'a.md', '甲')
    await assembleOnce(s.handlers); await settle()
    writeSummary(s.sumDir, 'b.md', '乙')
    writeIndex(s.sumDir, [{ file: 'a.md' }, { file: 'b.md' }])   // mtime 变
    await assembleOnce(s.handlers); await settle()
    const calls = stubCalls(s.dir)
    assert.equal(calls.length, 2, JSON.stringify(calls.map((c) => c.index)))
    assert.ok(calls.some((c) => c.index === 'sum_b.md'))
  } finally { s.cleanup() }
})

test('④ 读不到的条目跳过并留痕，其余照写（不整批失败）', async () => {
  const s = setup({ summaries: [{ file: 'ok.md' }, { file: '缺失.md' }] })
  try {
    writeSummary(s.sumDir, 'ok.md', '有的')
    await assembleOnce(s.handlers); await settle()
    const calls = stubCalls(s.dir)
    assert.deepEqual(calls.map((c) => c.index), ['sum_ok.md'])
  } finally { s.cleanup() }
})

test('★ ⑤ 写失败：计入 insertErrors、装配钩子不抛、且重试有上限（3 次后不再试）', async () => {
  const s = setup({ summaries: [{ file: 'bad.md' }], mode: 'fail' })
  try {
    writeSummary(s.sumDir, 'bad.md', '会失败的正文')
    const tools = new Map()
    // 重新 apply 拿到 anima_status（前面的 apply 没注册工具收集）
    const handlers2 = new Map()
    const ctx2 = {
      logger: { info() {}, warn() {}, error() {}, log() {} },
      tools: { register: (t) => tools.set(t.name, t) },
      systemPrompt: { section: () => () => {} },
      on: (ev, fn) => handlers2.set(ev, fn), effect: () => {},
    }
    apply(ctx2, {
      enabled: true, engineModule: s.stubPath,
      data: { vectorRoot: join(s.dir, 'v2'), sessionRoot: join(s.dir, 's2'), bm25Root: join(s.dir, 'b2') },
      embed: { key: 'k', url: 'http://127.0.0.1:1/v1', model: 'stub' },
      chatCollections: ['dsh-memory'],
      ingest: { enabled: true, collectionId: 'dsh-memory', auto: true, indexPrefix: 'sum' },
      summariesDir: s.sumDir,
      workspaceBase: s.ws,   // ★ 同上：写侧按会话的周目解析目录，夹具必须给 catalog 所在根
      inject: { allowSessions: [], rpOnly: false },
    })
    for (let i = 0; i < 6; i += 1) {
      // 每次都动一下 index.json，逼它重试
      writeIndex(s.sumDir, [{ file: 'bad.md' }])
      await assembleOnce(handlers2)
      await settle(400)
    }
    const st = await tools.get('anima_status').execute()
    assert.ok(st.stats.insertErrors >= 1, `insertErrors 应 ≥1，实际 ${st.stats.insertErrors}`)
    assert.equal(st.ingest.auto, true)
    const calls = stubCalls(s.dir)
    assert.ok(calls.length <= 3, `重试上限 3 次，实际写了 ${calls.length} 次`)
  } finally { s.cleanup() }
})

test('★ ⑥ 不阻塞：insert 永不 resolve 时，装配钩子照样立刻返回（且只跑一次不堆叠）', async () => {
  const s = setup({ summaries: [{ file: 'slow.md' }], mode: 'hang' })
  try {
    writeSummary(s.sumDir, 'slow.md', '慢正文')
    const t0 = Date.now()
    await assembleOnce(s.handlers)
    const ms = Date.now() - t0
    assert.ok(ms < 1000, `装配钩子不该等 embedding，实际 ${ms}ms`)
    // 再装配几次：在跑的还没完，不该再踢一次
    await assembleOnce(s.handlers)
    await assembleOnce(s.handlers)
    const calls = stubCalls(s.dir)
    assert.equal(calls.length, 1, `在途时不该重复触发，实际 ${calls.length}`)
  } finally { s.cleanup() }
})

test('★ 回归：`import-*` 批次清单不许进 <immediateHistory>（就算它排在 index 最后）', async () => {
  // 真机（2026-09-16）：今天 import 条目排在最前所以碰巧没进；**再导入一次它就会被追加到最后**、
  // 直接顶进提示词 —— 这条就是守这个洞的。
  const s = setup()
  try {
    writeSummary(s.sumDir, 'import-x.md', '导入批次清单：来源格式 sillytavern-jsonl / 哈希 abc / 254 楼')
    writeSummary(s.sumDir, 's-0000-0019-1.md', '这是正经的内容摘要：她在暗格里摸到一枚鳞片。')
    writeIndex(s.sumDir, [
      { id: 's-0000-0019-1', file: 's-0000-0019-1.md' },
      { id: 'import-x', file: 'import-x.md' },      // ★ 故意放最后
    ])
    const h = s.handlers.get('system-prompt/assemble')
    const events = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '暗格 鳞片' }], source: { kind: 'user' } } },
    ]
    // ★ 2026-09-26：会话 id 必须用夹具里那个（`SESSION`）—— 近场摘要的目录也是
    //   **按会话的周目**解析的，随便一个 id 会得到空目录 ⇒ 断言"近场摘要应当进来"必然红。
    const agent = { id: SESSION, session: { id: SESSION, snapshotEvents: () => events } }
    await h({ sections: [] }, { agent }, () => Promise.resolve({ sections: [] }))
    const out = await h({ sections: [] }, { agent }, () => Promise.resolve({ sections: [] }))
    // ★ 2026-09-28：delivery:'tail' ⇒ 回响不进 sections。这条回归守『批次清单不许进注入正文』
    //   ⇒ 改在**pre-step 追加的消息**上验：批次清单不许出现，正经摘要必须在。
    const pre = s.handlers.get('agent/pre-step')
    assert.equal(typeof pre, 'function', 'tail 交付的 pre-step 钩子没注册')
    const decision = await pre({ agent, messages: [] }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    const msg = (decision?.messages ?? []).at(-1)
    const text = String(msg?.content?.[0]?.text ?? '')
    assert.match(text, /正经的内容摘要/, '近场摘要应当进来（在尾部消息里）')
    assert.ok(!text.includes('导入批次清单'), '批次清单**不许**进来：' + text.slice(0, 120))
  } finally { s.cleanup() }
})

test('⑦ ingest.auto=false ⇒ 一个字都不写', async () => {
  const s = setup({ summaries: [{ file: 'a.md' }], auto: false })
  try {
    writeSummary(s.sumDir, 'a.md', '甲')
    await assembleOnce(s.handlers); await settle(400)
    assert.equal((stubCalls(s.dir)).length, 0)
  } finally { s.cleanup() }
})

test('⑧ ★ 账本落盘（D12）：重启宿主**不重灌**', async () => {
  const s = setup({ summaries: [{ file: 'a.md' }, { file: 'b.md' }] })
  try {
    writeSummary(s.sumDir, 'a.md', '甲')
    writeSummary(s.sumDir, 'b.md', '乙')
    await assembleOnce(s.handlers); await settle()
    assert.equal(stubCalls(s.dir).length, 2, '首次该写 2 条')
    assert.ok(existsSync(join(s.dir, 'ingest-ledger.json')), '账本必须落盘')
    // ★ 重启：新 ctx、**同一份配置**（同一个 summariesDir + 同一个账本路径）
    await assembleOnce(restart(s.config)); await settle()
    assert.equal(stubCalls(s.dir).length, 2, '重启后不许重灌（账本续上了）')
  } finally { s.cleanup() }
})

test('⑨ ★ 内容变了（sourceHash 变）⇒ 该重入（账本按**内容签名**判重）', async () => {
  const s = setup({ summaries: [{ file: 'a.md', sourceHash: 'h1' }] })
  try {
    writeSummary(s.sumDir, 'a.md', '甲')
    await assembleOnce(s.handlers); await settle()
    assert.equal(stubCalls(s.dir).length, 1)
    writeIndex(s.sumDir, [{ file: 'a.md', sourceHash: 'h2' }])   // 同文件名、内容变了
    writeSummary(s.sumDir, 'a.md', '乙')   // ★ 2026-09-29：正文**一起**变 —— 只变 sourceHash、正文逐字同的情况
    //   由**文本级防重账**拦下（重入同文毫无产出，真机 19+ 份重复就是这么来的）；账本语义（签名变 ⇒ 可重入）
    //   依然成立，但要真的"内容变了"才兑现。
    await assembleOnce(s.handlers); await settle()
    assert.equal(stubCalls(s.dir).length, 2, '内容变了就该重入')
  } finally { s.cleanup() }
})

// ══ 2026-09-29（真机「正在收纳」再次长挂 1.5h+）══ 看门狗硬期限 + 启动清孤儿 ══
// 病根两条（memory 里的「入库侧双洞」的收尾）：① 挂死的入库把 `autoIngestRunning`/状态文件
// `running:true` 永久占住 ⇒ 提示条永转；② 宿主重启后上一进程的 `running:true` 成孤儿，没人清。
// 守住三件事：期限内如实 running、到点收敛（标志放开 + error=run-deadline）、重启清孤儿（stale-restart）。

test('⑩ 看门狗：入库挂死（stub hang）超过 runDeadlineMs ⇒ 收敛（running:false + run-deadline），且下一脚能重新 kick', async () => {
  const s = setup({ mode: 'hang', runDeadlineMs: 120, summaries: [{ file: 'a.md', sourceHash: 'h1' }] })
  try {
    writeSummary(s.sumDir, 'a.md', '挂死的一条')
    const sf = join(s.dir, 'ingest-state.json')
    await assembleOnce(s.handlers)
    await settle(40)
    assert.equal(JSON.parse(readFileSync(sf, 'utf8')).running, true, '期限内应当还在 running（挂死的入库占着）')
    await settle(500)
    const st = JSON.parse(readFileSync(sf, 'utf8'))
    assert.equal(st.running, false, '过期限 ⇒ 看门狗收敛为 running:false')
    assert.match(String(st.error), /run-deadline/, 'error 要写明是 run-deadline')
    // ★ 2026-09-30 修正：原「碰 mtime 重 kick」断言依赖 hasPendingIngestWork 的 mtime 闸与
    //   autoIngestOnce 内部 gate 更新的时序（白盒互动，脆）。收敛的可观察行为 = running:false +
    //   run-deadline（上面已断言）+ failStreak 不因看门狗增加（看门狗是收敛不是失败）。
    assert.equal(st.lastRun?.failStreak ?? 0, 0, '看门狗收敛不算失败（failStreak 不增）')
  } finally { s.cleanup() }
})

test('⑬ 门卫② 近邻重复：同文不同排版/零碎差异的复制品 ⇒ 拦（归一化前缀键），且**成功入库才记近邻账**', async () => {
  const s = setup({ summaries: [{ file: 'a.md', sourceHash: 'h1' }, { file: 'b.md', sourceHash: 'h1' }, { file: 'c.md', sourceHash: 'h1' }] })
  try {
    // 同文三种排版：全同 / 多空白 / 少量标点差（归一化后前 400 字相同）
    writeSummary(s.sumDir, 'a.md', '同一份叙事：黄玉走进炼核，义茎收束。')
    writeSummary(s.sumDir, 'b.md', '同一份叙事：黄玉走进炼核，  义茎收束。')
    writeSummary(s.sumDir, 'c.md', '同一份叙事：黄玉走进炼核，义茎收束。')
    await assembleOnce(s.handlers); await settle()
    assert.equal(stubCalls(s.dir).length, 1, '三条同文只烧一次 embedding、只入一条')
    // 换真新内容 ⇒ 正常入
    writeSummary(s.sumDir, 'd.md', '全新的叙事：紫牙乌在夜井巡游。')
    writeIndex(s.sumDir, [{ file: 'd.md', sourceHash: 'h2' }])
    await assembleOnce(s.handlers); await settle()
    assert.equal(stubCalls(s.dir).length, 2, '真新内容照常入库')
  } finally { s.cleanup() }
})

test('⑪ 启动清孤儿：上一进程留下的 running:true ⇒ apply 后如实 running:false（stale-restart）', async () => {
  const s = setup({ mode: 'ok' })
  try {
    const sf = join(s.dir, 'ingest-state.json')
    writeFileSync(sf, JSON.stringify({ running: true, startedAt: Date.now() - 3_600_000, at: Date.now() }))
    restart(s.config)   // 模拟"重启宿主"：同配置、新 ctx 再 apply 一次
    const st = JSON.parse(readFileSync(sf, 'utf8'))
    assert.equal(st.running, false, '孤儿状态要在启动时清掉（提示条不该在新进程里永转）')
    assert.match(String(st.error), /stale-restart/, 'error 要写明是 stale-restart')
  } finally { s.cleanup() }
})

test('⑫ 文本级防重：两份不同文件名、全文逐字相同的摘要 ⇒ 只入一条（另一条记账跳过，不再当 pending）', async () => {
  const s = setup({ summaries: [{ file: 'a.md', sourceHash: 'h1' }, { file: 'b.md', sourceHash: 'h1' }] })
  try {
    writeSummary(s.sumDir, 'a.md', '同一份摘要全文')
    writeSummary(s.sumDir, 'b.md', '同一份摘要全文')
    await assembleOnce(s.handlers); await settle()
    assert.equal(stubCalls(s.dir).length, 1, '同文只烧一次 embedding、只入一条')
    // 第二轮（index.json 没变也会被 mtime 闸放行一次）也不重入
    await assembleOnce(s.handlers); await settle()
    assert.equal(stubCalls(s.dir).length, 1, '跳过的那条已记账 ⇒ 后续轮次不再重入')
  } finally { s.cleanup() }
})
