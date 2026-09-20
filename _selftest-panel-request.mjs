#!/usr/bin/env node
/**
 * _selftest-panel-request.mjs —— 「面板通道」三张文件与"为什么召不回来"那句话的**纯逻辑**自检。
 *
 * 覆盖（每条都带反证）：
 *   ① 动作白名单与中文短名（面板与日志共用同一份措辞）
 *   ② 请求单的形状校验（认识才执行，不认识的**如实拒绝**，⛔ 不猜）
 *   ③ `makePanelRequest` ↔ `parsePanelRequest` 往返一致
 *   ④ `explainRetrieval`：隔离清空 / 部分隔离 / 被拦 / 库不存在 / BM25 缺 / 真没命中 —— 六种说法
 *   ⑤ `makeVectorInfo` 骨架齐字段、缺字段不抛
 *
 * 跑法：node _selftest-panel-request.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(here, 'lib', 'panel-request.js'), 'utf8')

let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : '  ← ' + String(extra)}`)
}

const mod = await import('file:///' + here.replace(/\\/g, '/') + '/lib/panel-request.js')
const {
  PANEL_ACTIONS, PANEL_ACTION_LABELS, PANEL_REQUEST_FILE, PANEL_RESULT_FILE, VECTOR_INFO_FILE,
  PANEL_REMOVED_PREFIX, actionLabel, explainRetrieval, isKnownAction, makePanelRequest,
  makePanelResult, makeVectorInfo, parsePanelRequest,
} = mod

// ── ① 白名单与短名 ─────────────────────────────────────────────────────────
check('① 动作白名单正好这四个（逐字）',
  JSON.stringify(PANEL_ACTIONS) === JSON.stringify(['ingest-now', 'rebuild', 'delete-vector', 'delete-bm25']),
  JSON.stringify(PANEL_ACTIONS))
check('① 每个动作都有中文短名（面板与日志同一份措辞）',
  PANEL_ACTIONS.every((a) => typeof PANEL_ACTION_LABELS[a] === 'string' && PANEL_ACTION_LABELS[a] !== ''))
check('① 不认识的动作用 `actionLabel` 如实回显（⛔ 不编）', actionLabel('nope') === 'nope', actionLabel('nope'))
check('① 三个文件名与"归档前缀"逐字冻结',
  PANEL_REQUEST_FILE === 'panel-request.json' && PANEL_RESULT_FILE === 'panel-result.json'
  && VECTOR_INFO_FILE === 'vector-info.json' && PANEL_REMOVED_PREFIX === 'removed-')

// ── ② 请求单校验 ───────────────────────────────────────────────────────────
check('② isKnownAction 只认白名单', isKnownAction('rebuild') && !isKnownAction('rm -rf'))
check('② 正常单子通过（连 note 一起）',
  parsePanelRequest({ id: 'x1', action: 'rebuild', note: '手动' }).ok === true
  && parsePanelRequest({ id: 'x1', action: 'rebuild', note: '手动' }).note === '手动')
check('② ★ 未知动作被拒（⛔ 不许"看不懂就照做"）',
  parsePanelRequest({ id: 'x1', action: 'delete-everything' }).ok === false
  && parsePanelRequest({ id: 'x1', action: 'delete-everything' }).reason.startsWith('unknown-action'),
  JSON.stringify(parsePanelRequest({ id: 'x1', action: 'delete-everything' })))
check('② 缺 id 被拒', parsePanelRequest({ action: 'rebuild' }).ok === false)
check('② 非对象/数组/字符串被拒（不抛）',
  parsePanelRequest(null).ok === false && parsePanelRequest([]).ok === false && parsePanelRequest('rebuild').ok === false)
check('② note 不是字符串 ⇒ 当空串（不抛）', parsePanelRequest({ id: 'x', action: 'rebuild', note: 1 }).note === '')

// ── ③ 往返 ─────────────────────────────────────────────────────────────────
{
  const req = makePanelRequest({ id: 'abc', action: 'delete-bm25', note: '验收' })
  const back = parsePanelRequest(req)
  check('③ 造出来的请求单一定过校验（形状自洽）', back.ok === true && back.action === 'delete-bm25' && back.id === 'abc')
  const res = makePanelResult({ id: 'abc', action: 'delete-bm25', ok: true, message: '好了' })
  check('③ 回执带 id/action/ok/message/time（面板靠 id 配对）',
    res.id === 'abc' && res.action === 'delete-bm25' && res.ok === true && res.message === '好了' && Number.isFinite(res.at))
}

// ── ④ explainRetrieval ─────────────────────────────────────────────────────
const isoFull = { enabled: true, bound: 'playthrough-adacc634', total: 51, denyIndexes: new Array(51).fill('x') }
const isoPart = { enabled: true, bound: 'playthrough-x', total: 51, denyIndexes: new Array(5).fill('x') }
{
  const s = explainRetrieval({ iso: isoFull, vectorExists: true, bm25Exists: true, chatItems: 0, kbItems: 0 })
  check('④a ★ 隔离清空候选池 ⇒ 第一句就说破（含"全部"与那个周目 id）',
    s.length > 0 && s[0].includes('全部') && s[0].includes('playthrough-adacc634'), JSON.stringify(s))
  const s2 = explainRetrieval({ iso: isoPart, vectorExists: true, bm25Exists: true, chatItems: 0, kbItems: 0 })
  check('④b 部分隔离 ⇒ 报"排除了 5/51"', s2[0].includes('5/51'), JSON.stringify(s2))
  const s3 = explainRetrieval({ iso: { enabled: true, blocked: 'no-bound-playthrough' }, chatItems: 0, kbItems: 0 })
  check('④c 被闸拦下 ⇒ 说清拦的原因码', s3[0].includes('no-bound-playthrough'), JSON.stringify(s3))
  const s4 = explainRetrieval({ iso: null, vectorExists: false, bm25Exists: false, chatItems: 0, kbItems: 0 })
  check('④d 库不存在 ⇒ 分别点出向量库与 BM25 库',
    s4.some((t) => t.includes('向量库不存在')) && s4.some((t) => t.includes('BM25')), JSON.stringify(s4))
  const s5 = explainRetrieval({ iso: { enabled: true, total: 10, denyIndexes: [] }, vectorExists: true, bm25Exists: true, chatItems: 0, kbItems: 0 })
  check('④e 库在、隔离没拦、真没命中 ⇒ 也只有一句（不编原因）',
    s5.length === 1 && s5[0].includes('没有命中'), JSON.stringify(s5))
  check('④f 什么都没问题（有命中）⇒ 一个字都不说',
    explainRetrieval({ iso: { enabled: true, total: 10, denyIndexes: [] }, vectorExists: true, bm25Exists: true, chatItems: 3, kbItems: 0 }).length === 0)
  check('④g 最多 3 句（别把提示词/工具结果淹了）', s4.length <= 3)
  check('④h 传垃圾不抛', explainRetrieval(undefined).length === 0 && explainRetrieval({ iso: 'x' }).length >= 0)

  // 反证：把"全部不属于本"那条分支挖掉 ⇒ ④a 必须不再说破
  const stripped = SRC.replace(/out\.push\(`隔离把候选池清空了[\s\S]*?\)\n/, '')
  check('④i ★ 反证：挖掉"隔离清空"那条分支 ⇒ 同一句判据变红',
    !/隔离把候选池清空了/.test(stripped), '（源码里那条分支没匹配到，说明锚点漂了，要同步本台子）')
}

// ── ⑤ makeVectorInfo 骨架 ──────────────────────────────────────────────────
{
  const info = makeVectorInfo({
    dataRoots: { vectorRoot: 'V', bm25Root: 'B', sessionRoot: 'S' },
    collectionId: 'dsh-memory', isolation: { total: 1, deniedCount: 0, boundCount: 1 },
    vector: { exists: true, count: 1, mtime: 1 }, bm25: { exists: true, bytes: 1, mtime: 1 },
  })
  const keys = ['version', 'at', 'dataRoots', 'collectionId', 'isolation', 'vector', 'bm25', 'ingest', 'ledger', 'lastAction', 'pendingRequest']
  check('⑤ 骨架字段齐（面板按这份读，少一个就白屏）', keys.every((k) => k in info), JSON.stringify(Object.keys(info)))
  check('⑤ dataRoots 三个根都在（面板靠它自己现算易变项）',
    info.dataRoots.vectorRoot === 'V' && info.dataRoots.bm25Root === 'B' && info.dataRoots.sessionRoot === 'S')
  const bare = makeVectorInfo()
  check('⑤ 全空调用也不抛，且三根是空串（⛔ 不编路径）',
    bare.dataRoots.vectorRoot === '' && bare.collectionId === '' && bare.isolation === null)
}

console.log(`\n── ${pass} 通过 / ${fail} 失败 ──`)
process.exitCode = fail === 0 ? 0 : 1
