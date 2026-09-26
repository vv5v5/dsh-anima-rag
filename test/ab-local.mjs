#!/usr/bin/env node
/**
 * 本地 A/B：**我们搬运的引擎（进程内）** vs **原版 Anima 的真实响应（已固化基线）**。
 *
 * 为什么不打两次网络：基线 `test/baseline-st-response.json` 就是原版在**同一 payload** 下的真实响应，
 * 再打一次 ST 只会多一次会话文件扰动。这份脚本用 `echoPersist:false` 跑引擎 → **零写入**。
 *
 * 为什么 sessionId 要加后缀：回响状态（life/卡槽）是**按 sessionId** 持久化的。
 * 基线那次用的 sessionId 建的文件已被 ab-compare 的零残留逻辑删掉，
 * 这里再加 `-local` 后缀，确保两侧都从**空回响状态**起跑，否则不可比。
 *
 * 用法：node test/ab-local.mjs
 *   key 从 ANIMA_RAG_EMBED_KEY / ANIMA_RAG_RERANK_KEY 读（绝不打印）。
 */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const BASE = 'D:\\apps\\deepseek\\dsh-anima-rag'
const ST = 'D:\\apps\\SillyTavern-Launcher\\SillyTavern\\plugins\\anima-rag'
const ST_NM = 'D:/apps/SillyTavern-Launcher/SillyTavern/plugins/anima-rag/node_modules/'
const SCORE_TOL = 0.02

const BRANCHES = [
  'vector_chat_results', 'bm25_chat_results', 'vector_kb_results', 'bm25_kb_results',
  'merged_chat_results', 'merged_kb_results', '_debug_logs',
]

const log = (...a) => process.stdout.write(a.join(' ') + '\n')
const dirFiles = (dir) => {
  const out = {}
  for (const f of fs.readdirSync(dir)) {
    const p = `${dir}\\${f}`
    const b = fs.readFileSync(p)
    out[f] = { size: b.length, sha: createHash('sha256').update(b).digest('hex').slice(0, 12), mtime: fs.statSync(p).mtimeMs }
  }
  return out
}
const diffSnapshot = (before, after) => {
  const changed = []
  for (const k of Object.keys(after)) {
    if (!(k in before)) changed.push(`新增:${k}`)
    else if (before[k].sha !== after[k].sha || before[k].size !== after[k].size) changed.push(`改动:${k}`)
  }
  for (const k of Object.keys(before)) if (!(k in after)) changed.push(`消失:${k}`)
  return changed
}
const fp = (x) => `${x.index}|${String(x.text ?? '').length}`

async function main() {
  const payload = JSON.parse(fs.readFileSync(`${BASE}\\test\\ab-payload.json`, 'utf8'))
  const baseline = JSON.parse(fs.readFileSync(`${BASE}\\test\\baseline-st-response.json`, 'utf8'))

  const key = process.env.ANIMA_RAG_EMBED_KEY || ''
  payload.apiConfig.key = key
  payload.rerankConfig.api.key = process.env.ANIMA_RAG_RERANK_KEY || key
  payload.sessionId = `${payload.sessionId || 'ab'}-local`
  log(`[i] embed keySet=${Boolean(payload.apiConfig.key)} len=${payload.apiConfig.key.length}（值不打印）`)
  log(`[i] rerank enabled=${payload.rerankConfig.enabled} keySet=${Boolean(payload.rerankConfig.api.key)}`)
  log(`[i] sessionId(B侧)=${payload.sessionId}  集合=${JSON.stringify(payload.chatContext.ids)}`)
  log(`[i] strategy.steps=${JSON.stringify(payload.strategy.steps.map(s => s.type + ':' + s.count))}`)

  const sessionsDir = `${ST}\\data\\sessions`
  const bm25Dir = `${ST}\\data\\bm25_indexes`
  const before = { sessions: dirFiles(sessionsDir), bm25: dirFiles(bm25Dir) }

  const mod = await import(pathToFileURL(`${BASE}\\lib\\engine.js`).href)
  const engine = mod.createEngine({
    vectorRoot: `${ST}\\vectors`,
    sessionRoot: sessionsDir,
    bm25Root: bm25Dir,
    echoPersist: false,
    depsBase: ST_NM,
  })

  log('\n===== 调 B 侧（我们搬运的引擎，进程内）=====')
  const t0 = Date.now()
  let res
  try {
    res = await engine.query(payload)
  } catch (e) {
    log(`  ★ 抛错: code=${e?.code ?? '(无)'} httpStatus=${e?.httpStatus ?? '(无)'} message=${e?.message ?? e}`)
    process.exitCode = 1
    return
  }
  const ms = Date.now() - t0
  log(`  OK  ${ms}ms`)

  // ── 零写入断言
  const after = { sessions: dirFiles(sessionsDir), bm25: dirFiles(bm25Dir) }
  const chS = diffSnapshot(before.sessions, after.sessions)
  const chB = diffSnapshot(before.bm25, after.bm25)
  log(`\n===== 零写入断言（echoPersist:false）=====`)
  log(`  sessions   : ${Object.keys(before.sessions).length} 个 → 变动 ${chS.length} 项 ${chS.length ? JSON.stringify(chS) : '✓'}`)
  log(`  bm25_indexes: ${Object.keys(before.bm25).length} 个 → 变动 ${chB.length} 项 ${chB.length ? JSON.stringify(chB) : '✓'}`)

  // ── 结构对照
  log('\n===== 结构对照 =====')
  const bKeys = Object.keys(baseline).sort()
  const rKeys = Object.keys(res ?? {}).sort()
  const keysEqual = JSON.stringify(bKeys) === JSON.stringify(rKeys)
  log(`  顶层键: 基线 ${bKeys.length} 个 | B 侧 ${rKeys.length} 个 → ${keysEqual ? '✓ 完全一致' : '★ 不一致'}`)
  if (!keysEqual) log(`    基线=${JSON.stringify(bKeys)}\n    B侧 =${JSON.stringify(rKeys)}`)

  log(`\n  ${'分支'.padEnd(24)} 基线  B侧`)
  for (const b of BRANCHES) {
    const bn = Array.isArray(baseline[b]) ? baseline[b].length : '(非数组)'
    const rn = Array.isArray(res?.[b]) ? res[b].length : '(非数组)'
    const mark = String(bn) === String(rn) ? ' ' : '★'
    log(`  ${mark} ${b.padEnd(22)} ${String(bn).padStart(4)}  ${String(rn).padStart(4)}`)
  }

  // ── 逐条指纹对照
  const bM = baseline.merged_chat_results ?? []
  const rM = res?.merged_chat_results ?? []
  log(`\n===== merged_chat_results 逐条对照（按 index 对齐）=====`)
  const rBy = new Map(rM.map(x => [String(x.index), x]))
  const bBy = new Map(bM.map(x => [String(x.index), x]))
  let match = 0, lenBad = 0, scoreBad = 0
  log(`  index   | 基线 score | B侧 score | Δ       | 基线len | B侧len | type        | is_echo`)
  for (const [idx, bx] of bBy) {
    const rx = rBy.get(idx)
    if (!rx) { log(`  ${idx.padEnd(7)} | ★ B 侧缺失`); continue }
    const ds = Number(rx.score) - Number(bx.score)
    const sameLen = String(bx.text ?? '').length === String(rx.text ?? '').length
    const okScore = Math.abs(ds) <= SCORE_TOL
    if (sameLen && okScore) match += 1
    if (!sameLen) lenBad += 1
    if (!okScore) scoreBad += 1
    log(`  ${idx.padEnd(7)} | ${Number(bx.score).toFixed(4).padStart(10)} | ${Number(rx.score).toFixed(4).padStart(9)} | ${(ds >= 0 ? '+' : '') + ds.toFixed(4)} | ${String(String(bx.text ?? '').length).padStart(7)} | ${String(String(rx.text ?? '').length).padStart(6)} | ${String(rx.type).padEnd(11)} | ${rx.is_echo}`)
  }
  for (const idx of rBy.keys()) if (!bBy.has(idx)) log(`  ${idx.padEnd(7)} | ★ B 侧多出`)

  const onlyB = rM.filter(x => !bBy.has(String(x.index))).length
  const onlyA = bM.filter(x => !rBy.has(String(x.index))).length
  log(`\n===== 结论 =====`)
  log(`  条目数: 基线 ${bM.length} | B侧 ${rM.length}`)
  log(`  完全匹配(index+长度+分数±${SCORE_TOL}): ${match}`)
  log(`  长度不符: ${lenBad} | 分数超容差: ${scoreBad} | 仅B侧: ${onlyB} | 仅基线: ${onlyA}`)
  const pass = keysEqual && onlyA === 0 && onlyB === 0 && lenBad === 0 && scoreBad === 0 && chS.length === 0
  log(`  ${pass ? '✅ A/B 通过：与 ST 原版逐条一致，且零写入' : '★ 有差异，见上'}`)

  const sample = rM[0]
  if (sample) log(`\n  B侧首条 text 前 100 字: ${String(sample.text).slice(0, 100)}`)
  engine.close?.()
  process.exitCode = pass ? 0 : 1
}

main().catch(e => { log('★ 异常:', e?.stack ?? e); process.exitCode = 1 })
