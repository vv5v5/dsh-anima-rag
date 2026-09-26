#!/usr/bin/env node
/**
 * _selftest-read-failure.mjs —— 「读侧嵌入失败 ⇒ 注入那一格有那句如实说明」的自检（T1，2026-09-26）。
 *
 * ## 为什么有它（用户口径与真机实测）
 *   用户口径（逐字）：「**我没看到有anima的recall，只看到了fts5注入的，anima字段是空的**」。
 *   真机实测（2026-09-26）抓到两条**静默**：
 *     ① `retrieve()` 里 `readRecentSummaries(sessionId)` 传的是**作用域里不存在的变量**
 *        （参数叫 `sessionKey`）⇒ 每次成功的检索最后都抛 `ReferenceError` ⇒ 被自己的 catch
 *        吞成 `text:''` ⇒ **整轮不注入，界面上一个字都看不出**；
 *     ② 嵌入端点偶发单次 >15s，而每轮预算只有 12s ⇒ 那一轮**放弃等待**，同样一声不响。
 *   任务书判据①：「读侧嵌入失败 ⇒ 注入那一格**有那句如实说明**（反证：把那句删掉 ⇒ 必红）」。
 *
 * ## 三组判据
 *   ① **端到端（真的走 apply() 的装配钩子）**：用一个假引擎模块把读侧逼进三种状态 ——
 *      超时 / 普通错误 / 正常有命中 —— 断言注入那一格**分别**是：
 *      · 有那句如实说明（含故障码人话、试了几次、端点、模型、"这是故障说明不是记忆"）；
 *      · 同样有说明（普通错误也不能静默）；
 *      · 有命中时**没有**说明，而是 `<memoryEcho>` + `<recalledMemories>` 的真内容。
 *      反证：把说明那一段从返回文本里挖掉 ⇒ 同一条判据必红。
 *   ② **引擎的嵌入口径（真的打本地端点）**：单次上限 × 次数 × 绝对截止时刻 ——
 *      · 端点永不响应 ⇒ 抛的错带 `code:'TIMEOUT'`、`attempts` = 配置的次数、总耗时 ≤ 预算；
 *      · 端点正常 ⇒ 不抛（`NO_KEY` / `HTTP` / `SHAPE` 也各有自己的码）。
 *   ③ **接线（读源码，带反证）**：`retrieve` 的 catch 返回 `failureNote(...)`（不是 `''`）；
 *      装配钩子的**超时那一支**也写说明（不是裸 `return out`）；`readRecentSummaries(sessionKey)`
 *      不再引用作用域外的 `sessionId`。三条各配一条"挖掉即红"的反证，其中 `sessionId` 那条是
 *      **把这个真机事故原样重放一遍**（旧写法在函数体里用 `sessionId.` 且没有声明 ⇒ 判据红）。
 */
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(here, 'lib', 'index.js'), 'utf8')
const LIVE = String(SRC).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const ENGINE_SRC = readFileSync(path.join(here, 'lib', 'engine.js'), 'utf8')

let pass = 0
const fails = []
let skipped = 0
async function check(name, fn, needEngine = false) {
  if (needEngine && !CAN_RUN_ENGINE) { skipped++; console.log('[SKIP] ' + name + '（缺 vectra 基址）'); return }
  try { await fn(); pass++; console.log('[PASS] ' + name) }
  catch (e) { fails.push(name); console.log('[FAIL] ' + name + ' :: ' + String(e?.message ?? e)) }
}

const TMP = mkdtempSync(path.join(here, '_selftest-tmp-readfail-'))

/**
 * `createEngine` 在构造时就要 resolve 到 `vectra`（本仓没有 node_modules —— 生产靠 profile 的依赖树）。
 * 本机那份在 ST 插件目录下（与 `test/selftest-engine.mjs` 同一个基址）。拿不到 ⇒ ②组**大声跳过**
 * （⛔ 不假装通过、⛔ 不静默）。
 */
const ST_DEPS = 'D:/apps/SillyTavern-Launcher/SillyTavern/plugins/anima-rag/node_modules/'

/** 一条最小的事件流：一次 turn/start + 一条 user 消息（够 `buildVectorQuery` 取到检索词）。 */
const EVENTS = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '她抓住我的手，说出那句话的瞬间' }] } },
]

/** 装配钩子的三件套：`assembly` / `context` / `next`。 */
function hookArgs(sessionId = 'session-readfail') {
  const session = { id: sessionId, events: EVENTS, snapshotEvents: () => EVENTS }
  const agent = { id: sessionId, session }
  const sections = [{ name: 'harness:identity', order: 0, text: 'x' }]
  return {
    args: [
      { sections },
      { agent, sessions: { current: session } },
      () => Promise.resolve({ sections }),
    ],
    sections,
  }
}

/** 起一个 stub ctx：apply() 只用到这四五样（见 lib/index.js 的 `ctx.*` 调用点）。 */
function stubCtx() {
  const hooks = new Map()
  const sections = []
  return {
    ctx: {
      logger: { info() {}, warn() {}, error() {} },
      systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
      effect: () => {},
      on: (name, fn) => { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn) },
      tools: { register: () => {} },
    },
    hooks,
    sections,
  }
}

/** 装配一次，返回写进 `anima:memory` 那一段的文本（拿不到就空串）。 */
async function injectOnce(cfg) {
  const { ctx, hooks } = stubCtx()
  const { apply } = await import('./lib/index.js')
  apply(ctx, cfg)
  const hook = (hooks.get('system-prompt/assemble') ?? [])[0]
  assert.ok(typeof hook === 'function', '装配钩子没注册')
  const { args } = hookArgs()
  const out = await hook(args[0], args[1], args[2])
  const sec = (out?.sections ?? []).find((s) => s.name === 'anima:memory')
  return sec === undefined ? '' : String(sec.text ?? '')
}

/** 写一个「假引擎」模块，用 `cfg.engineModule` 挂上去（⛔ 不依赖 vectra，跑得动就行）。 */
function writeFakeEngine() {
  const dir = path.join(TMP, 'fake-engine')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'engine.mjs')
  writeFileSync(file, `
// 假引擎：只回放读侧会遇到的三种状态（超时 / 普通错误 / 正常有命中）。
export function createEngine() {
  return {
    async query(payload) {
      const mode = globalThis.__READFAIL_MODE
      if (mode === 'timeout') {
        const e = new Error('向量 API 请求超时无响应（单次上限 5000ms）')
        e.code = 'TIMEOUT'; e.attempts = 2; e.elapsedMs = 10123
        e.endpoint = 'https://api.siliconflow.cn/v1/embeddings'; e.model = 'Qwen/Qwen3-Embedding-8B'
        throw e
      }
      if (mode === 'ok') {
        return {
          merged_chat_results: [
            { text: '1966年9月1日 上午：楼下，老崔提供了热粥。', index: 'sum_mt-0100-0129-1', tags: ['Serious'], is_echo: false },
            { text: '1966年9月1日 深夜：囚室里的那位女囚说出了开炉的细节。', index: 'sum_mt-0100-0129-2', tags: ['Suspense'], is_echo: true },
          ],
          merged_kb_results: [],
          _debug_logs: [],
          _diag: { query: 4, collections: [], mismatched: ['影子_-0906重开（库 2560 维 / 查询 4096 维）'] },
        }
      }
      throw new Error('boom')
    },
  }
}
`, 'utf8')
  return file
}

const baseCfg = (engineModule) => ({
  enabled: true,
  engineModule,
  data: { vectorRoot: path.join(TMP, 'vectors'), sessionRoot: path.join(TMP, 'sessions') },
  chatCollections: ['probe'],
  embed: { url: 'https://api.siliconflow.cn/v1', key: 'test-key', model: 'Qwen/Qwen3-Embedding-8B', timeout_ms: 5000, attempts: 2 },
  inject: { rpOnly: false, isolatePlaythrough: false, recentCount: 0, maxChars: 6000, echo: { enabled: true, topK: 5, maxChars: 1200, perHitChars: 280 } },
  summariesDir: '',
  ingest: { enabled: false, auto: false, autoClean: false, quarantine: false, statePath: path.join(TMP, 'ingest-state.json') },
  timeoutMs: 12000,
  debug: false,
})

// ─────────────────────── ① 端到端：注入那一格说没说真话 ───────────────────────
const FAKE = writeFakeEngine()

await check('① a. 嵌入超时 ⇒ 注入那一格**有那句如实说明**（带故障码人话/次数/端点/模型/"不是记忆"）', async () => {
  globalThis.__READFAIL_MODE = 'timeout'
  const text = await injectOnce(baseCfg(FAKE))
  assert.notEqual(text, '', '注入那一格是**空**的 —— 这正是改前那个静默')
  assert.ok(text.includes('嵌入端点超时'), '没有"嵌入端点超时"这句人话：' + text)
  assert.ok(/已试 2 次/.test(text), '没说试了几次：' + text)
  assert.ok(text.includes('/embeddings'), '没写端点：' + text)
  assert.ok(text.includes('Qwen/Qwen3-Embedding-8B'), '没写模型：' + text)
  assert.ok(text.includes('这是故障说明，不是记忆内容'), '没讲清"这句不是记忆"（模型可能把它当记忆读）')
  assert.ok(text.startsWith('〔') && text.includes('检索没跑成'), '没按约定的形状写（〔〕+「检索没跑成」）：' + text.slice(0, 80))
})

await check('① b. ★反证：把那句说明从返回文本里挖掉 ⇒ ①a 必须红', async () => {
  globalThis.__READFAIL_MODE = 'timeout'
  const text = await injectOnce(baseCfg(FAKE))
  const stripped = text.replace(/嵌入端点超时[^\n]*/g, '')
  assert.ok(!stripped.includes('嵌入端点超时'), '反证构造失败')
  assert.throws(() => assert.ok(stripped.includes('嵌入端点超时'), '没有那句'), /没有那句/)
})

await check('① c. 普通错误（不是超时）同样不静默：说明里带得出错原因', async () => {
  globalThis.__READFAIL_MODE = 'boom'
  const text = await injectOnce(baseCfg(FAKE))
  assert.ok(text.includes('检索没跑成'), '普通错误也必须是那句说明：' + text)
  assert.ok(text.includes('boom'), '没带上真正的原因（用户没法查）：' + text)
})

await check('① d. 有命中时**没有**故障说明：注入的是 <memoryEcho> + <recalledMemories> 真内容', async () => {
  globalThis.__READFAIL_MODE = 'ok'
  const text = await injectOnce(baseCfg(FAKE))
  assert.ok(text.includes('<memoryEcho>'), '没有回响那一格：' + text.slice(0, 120))
  assert.ok(text.includes('老崔提供了热粥'), '回响格没装语义命中')
  assert.ok(text.includes('<recalledMemories>'), '没有 recalledMemories：' + text.slice(0, 200))
  assert.ok(text.includes('（回响续命）'), 'is_echo 那条没标出来')
  assert.equal(text.includes('检索没跑成'), false, '这一轮明明成功了，却带了故障说明')
  assert.ok(text.includes('查询向量的维度与库里的切片对不上'), '维度对不上（真机现状）没被说出来：' + text.slice(0, 400))
  // 顺序：回响格在最前，recalledMemories 在后（与改前 dma:echo@54 → anima:memory@55 同序）
  assert.ok(text.indexOf('<memoryEcho>') < text.indexOf('<recalledMemories>'), '两格的先后反了')
})

// ─────────────────────── ② 引擎的嵌入口径（真打端点） ───────────────────────
// ⚠️ 这一组要真造一个引擎 ⇒ 必须先 resolve 到 `vectra`。拿不到就**大声跳过**（下面每条自己判）。
const CAN_RUN_ENGINE = existsSync(ST_DEPS)
if (!CAN_RUN_ENGINE) {
  console.log(`[SKIP] ② 组整组跳过：拿不到 vectra 的解析基址（${ST_DEPS}）—— `
    + '这一组的判据**这次没有跑**，⛔ 不要当它通过了')
}
/** 起一个本地端点：`mode='hang'` 永不响应；`mode='ok'` 立刻回一个 4 维向量。 */
function startEndpoint(mode) {
  const srv = createServer((req, res) => {
    if (mode === 'hang') return // 永不回 ⇒ 只能靠 abort 收场
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }))
    })
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
}

await check('② a. 端点永不响应 ⇒ code=TIMEOUT、试满配置的次数、总耗时**不超预算**（不再有"跑完没人要"）', async () => {
  const { srv, port } = await startEndpoint('hang')
  try {
    const { createEngine } = await import('./lib/engine.js')
    const engine = createEngine({
      vectorRoot: path.join(TMP, 'v2'),
      sessionRoot: path.join(TMP, 's2'),
      bm25Root: path.join(TMP, 'b2'),
      depsBase: ST_DEPS,
    })
    const t0 = Date.now()
    let err = null
    try {
      await engine.query({
        searchText: '测试',
        apiConfig: {
          key: 'k', url: `http://127.0.0.1:${port}/v1`, model: 'fake',
          timeout_ms: 300, attempts: 2, deadlineMs: t0 + 5000,
        },
        chatContext: { ids: ['probe'], strategy: null },
        kbContext: { ids: [], strategy: null },
      })
    } catch (e) { err = e }
    const dt = Date.now() - t0
    assert.ok(err !== null, '端点永不响应，却没抛错')
    assert.equal(err.code, 'ANIMA_QUERY_FAILED', '外层契约码被改动了（那是对外契约，⛔ 别动）：' + err.code)
    assert.equal(err.originCode, 'TIMEOUT', '底层的真码没被带出来：' + err.originCode + ' / ' + err.message)
    assert.equal(err.attempts, 2, '没有试满 2 次：' + err.attempts)
    assert.ok(dt >= 550 && dt < 3000, `两次 300ms 上限应落在 0.6–3s，实际 ${dt}ms`)
    assert.ok(err.endpoint.includes('/embeddings'), '错误里没带端点：' + err.endpoint)
  } finally { srv.close() }
}, true)

await check('② b. 截止时刻比单次上限更紧时 ⇒ 只试一次就收场（预算说了算）', async () => {
  const { srv, port } = await startEndpoint('hang')
  try {
    const { createEngine } = await import('./lib/engine.js')
    const engine = createEngine({ vectorRoot: path.join(TMP, 'v3'), sessionRoot: path.join(TMP, 's3'), bm25Root: path.join(TMP, 'b3'), depsBase: ST_DEPS })
    const t0 = Date.now()
    let err = null
    try {
      await engine.query({
        searchText: '测试',
        apiConfig: {
          key: 'k', url: `http://127.0.0.1:${port}/v1`, model: 'fake',
          timeout_ms: 5000, attempts: 2, deadlineMs: t0 + 400,
        },
        chatContext: { ids: ['probe'], strategy: null },
        kbContext: { ids: [], strategy: null },
      })
    } catch (e) { err = e }
    assert.ok(err !== null && err.originCode === 'TIMEOUT', '该超时：' + (err && err.originCode) + ' / ' + (err && err.message))
    assert.equal(err.attempts, 1, '预算只剩 400ms 时不该再起第二次：' + err.attempts)
    assert.ok(Date.now() - t0 < 2500, '收场太慢（预算没生效）')
  } finally { srv.close() }
}, true)

await check('② c. 端点正常 ⇒ 不抛错（这条是"嵌入党到底通不通"的机器化版本）', async () => {
  const { srv, port } = await startEndpoint('ok')
  try {
    const { createEngine } = await import('./lib/engine.js')
    const engine = createEngine({ vectorRoot: path.join(TMP, 'v4'), sessionRoot: path.join(TMP, 's4'), bm25Root: path.join(TMP, 'b4'), depsBase: ST_DEPS })
    const t0 = Date.now()
    const res = await engine.query({
      searchText: '测试',
      apiConfig: {
        key: 'k', url: `http://127.0.0.1:${port}/v1`, model: 'fake',
        timeout_ms: 3000, attempts: 2, deadlineMs: t0 + 5000,
      },
      chatContext: { ids: ['probe'], strategy: null },
      kbContext: { ids: [], strategy: null },
    })
    assert.ok(res !== null && typeof res === 'object', '返回形状不对')
    assert.ok(Array.isArray(res.merged_chat_results), '没有 merged_chat_results')
    assert.ok(res._diag !== undefined, '没有 _diag（维度核对那一路）')
  } finally { srv.close() }
}, true)

await check('② d. 没配 key ⇒ code=NO_KEY（一次网络都不打，也不该说成"超时"）', async () => {
  const { createEngine } = await import('./lib/engine.js')
  const engine = createEngine({ vectorRoot: path.join(TMP, 'v5'), sessionRoot: path.join(TMP, 's5'), bm25Root: path.join(TMP, 'b5'), depsBase: ST_DEPS })
  let err = null
  try {
    await engine.query({
      searchText: '测试',
      apiConfig: { key: '', url: 'http://127.0.0.1:1/v1', model: 'fake', timeout_ms: 300, attempts: 2 },
      chatContext: { ids: ['probe'], strategy: null },
      kbContext: { ids: [], strategy: null },
    })
  } catch (e) { err = e }
  assert.ok(err !== null && err.originCode === 'NO_KEY', '该是 NO_KEY：' + (err && err.originCode) + ' / ' + (err && err.message))
}, true)

// ─────────────────────── ③ 接线（读源码）+ 反证 ───────────────────────
await check('③ a. retrieve 的 catch 返回的是 `failureNote(...)`（不是改前那个空串文本）', () => {
  assert.ok(/return \{ text: failureNote\(failure\)/.test(LIVE), 'catch 里没有把说明当正文返回')
  assert.equal(/return \{ text: '', stats: \{ reason: 'error'/.test(LIVE), false,
    'catch 里还留着「空串文本」—— 那正是"静默"的老写法')
})

await check('③ b. 装配钩子的**超时那一支**也写说明（⛔ 不是裸 `return out`）', () => {
  const i = LIVE.indexOf('检索超时（>${cfg.timeoutMs}ms）')
  assert.ok(i > 0, '找不到超时那一支（改了措辞？同步本台子）')
  const tail = LIVE.slice(i, i + 900)
  assert.ok(tail.includes('failureNote('), '超时那一支没有写那句说明')
  assert.ok(tail.includes('stats.lastFailure = failure'), '超时没进 lastFailure（面板上看不到）')
  assert.ok(!/warn\(ctx, `检索超时[^\n]*\n\s*return out/.test(LIVE), '超时那一支还是裸 return out')
})

await check('③ c. ★反证：把超时那一支改回裸 `return out` ⇒ ③b 必须红', () => {
  const i = LIVE.indexOf('检索超时（>${cfg.timeoutMs}ms）')
  const back = LIVE.slice(0, i) + LIVE.slice(i).replace(/failureNote\(/, 'NO_NOTE(').replace('stats.lastFailure = failure', '')
  const tail = back.slice(i, i + 900)
  assert.equal(tail.includes('failureNote('), false, '反证失败')
  assert.equal(tail.includes('stats.lastFailure = failure'), false, '反证失败')
})

await check('③ d. ★★ 真机事故反证：`retrieve` 体内不许引用作用域外的 `sessionId`（2026-09-26 那个 ReferenceError）', () => {
  const at = LIVE.indexOf('async function retrieve(')
  assert.ok(at > 0, '找不到 retrieve')
  // 抠出函数体（大括号配对）
  const open = LIVE.indexOf('{', LIVE.indexOf(')', at))
  let depth = 0; let body = null
  for (let i = open; i < LIVE.length; i += 1) {
    if (LIVE[i] === '{') depth += 1
    else if (LIVE[i] === '}') { depth -= 1; if (depth === 0) { body = LIVE.slice(open, i + 1); break } }
  }
  assert.ok(body !== null, '抠不出函数体')
  const usesSessionId = /(^|[^\w.$])sessionId\b/.test(body)
  const declares = /(const|let|var)\s+sessionId\b/.test(body) || /\(\s*\{[^}]*sessionId[^}]*\}\s*\)/.test(LIVE.slice(at, open))
  assert.equal(usesSessionId && !declares, false,
    'retrieve 里用了 `sessionId` 却没有声明 —— 这正是 2026-09-26 那个"整轮静默"的 ReferenceError')
  assert.ok(/readRecentSummaries\(sessionKey\)/.test(body), 'readRecentSummaries 收的不是 sessionKey')
  // 把这个事故原样重放：把 `sessionKey` 换回 `sessionId` ⇒ 同一条判据必红
  const back = body.replace(/readRecentSummaries\(sessionKey\)/, 'readRecentSummaries(sessionId)')
  const bUses = /(^|[^\w.$])sessionId\b/.test(back)
  const bDecl = /(const|let|var)\s+sessionId\b/.test(back)
  assert.equal(bUses && !bDecl, true, '反证失败：把 sessionId 放回去也没被判成"引用作用域外变量"')
})

await check('③ e. 拿不到内容时清掉本会话旧文本（⛔ 不许把上一轮的记忆当这一轮注入）', () => {
  assert.ok(/lastBySession\.delete\(sessionId\)/.test(LIVE), '没有清缓存那一脚（旧文本会继续被 provider 吐出来）')
})

await check('③ f. 引擎的失败分类：底层有自己的码，外层那圈包装**原样带出来**（originCode）', () => {
  assert.ok(/wrapped\.originCode/.test(ENGINE_SRC), '外层包装没有带 originCode —— 读侧只能写"未知错误"')
  assert.ok(/ANIMA_QUERY_FAILED/.test(ENGINE_SRC), '外层契约码不该被改掉')
  for (const code of ['NO_KEY', 'TIMEOUT', 'NETWORK', 'HTTP', 'SHAPE']) {
    assert.ok(new RegExp(`"${code}"`).test(ENGINE_SRC), `引擎里没有 ${code} 这个码`)
  }
  assert.ok(/config\.attempts/.test(ENGINE_SRC) && /config\.deadlineMs/.test(ENGINE_SRC),
    '引擎没读 attempts / deadlineMs（那就没有"次数与预算"这回事）')
  assert.ok(/dimensionDiagnostics/.test(ENGINE_SRC) && /_diag/.test(ENGINE_SRC),
    '引擎没有维度核对那一路（NaN 分数会静默）')
})

// ─────────────────────── 收尾 ───────────────────────
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log(`\n── ${pass} 通过 / ${fails.length} 失败 ──`)
if (fails.length > 0) { console.log('失败：' + fails.join('、')); process.exitCode = 1 }
