#!/usr/bin/env node
/**
 * _selftest-echo-slot.mjs —— 「回响那一格（`<memoryEcho>`）装的是 anima 的语义命中」的自检（T2，2026-09-26）。
 *
 * ## 为什么有它（用户口径，逐字）
 *   「**3 把anima也加入回响吧。也就是自动触发**」
 *   「**3 我没看到有anima的recall，只看到了fts5注入的，anima字段是空的**」
 *   任务书判据②：「回响那一格装的是 **anima 的命中**（反证：把它换回 fts5 的命中 ⇒ 必红）」。
 *
 * ## 两半：行为（纯函数）+ 接线（读源码，带反证）
 *   行为 —— `lib/echo-view.js` 的 `buildEchoSlot` / `floorRangeOf` / `hitLabel`：
 *     E1 空/畸形输入绝不抛，且**空命中 ⇒ 不注入**（''，不是空壳）；
 *     E2 形状与前言逐字（`<memoryEcho>` 壳 + 前言，用户对"注入进去长什么样"有肌肉记忆）；
 *     E3 行首标签：认得出楼层区间 ⇒ `[楼 0100-0129]`，认不出 ⇒ 如实写切片名（⛔ 不编楼号）；
 *     E4 `is_echo`（靠 life 续命、不是自然召回）⇒ 行尾标 `（回响续命）`；
 *     E5 预算：topK / perHitChars / maxChars 三重上限，任何路径**都不许超预算**，截断**必须带标注**；
 *     E6 顺序 = 传入顺序（⛔ 不在这里重排 —— 与 `<recalledMemories>` 必须同序）；
 *     E7 ★★ 反证：**fts5 形状的命中（`{floor, body, docKey, hitCount}`）喂进来 ⇒ 一条都用不上**
 *        （它认的是 anima 命中的 `text`）—— 这就是"换回 fts5 的命中必红"那条反证的行为版。
 *   接线 —— `lib/index.js`：
 *     W1 回响格是 `buildEchoSlot(res?.merged_chat_results, …)` 建的（喂的是**语义命中**）；
 *     W2 由 `inject.echo` 那组预算驱动、`enabled:false` 就整格不出；
 *     W3 它排在这一段文本的**最前面**（与改前 `dma:echo`@54 在 `anima:memory`@55 之前同序）；
 *     W4 ★反证：把喂进去的那份数据换成 fts5 那套（`floors`/`body`）⇒ W1 的判据必红。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

import { ECHO_PREAMBLE, buildEchoSlot, floorRangeOf, hitLabel } from './lib/echo-view.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(here, 'lib', 'index.js'), 'utf8')
const LIVE = String(SRC).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

let pass = 0
const fails = []
function check(name, fn) {
  try { fn(); pass++; console.log('[PASS] ' + name) }
  catch (e) { fails.push(name); console.log('[FAIL] ' + name + ' :: ' + String(e?.message ?? e)) }
}

/** 一条 anima 命中（`merged_chat_results` 的形状：`text` + `index` + `is_echo`）。 */
const hit = (text, index = 'sum_mt-0100-0129-1', extra = {}) => ({ text, index, ...extra })

// ─────────────────────────── E1 空/畸形 ───────────────────────────
check('E1 空命中 / 畸形输入 ⇒ 返回空串（本轮不注入这一格，且绝不抛）', () => {
  for (const bad of [[], null, undefined, 'x', 42, {}, [null], [{ text: '' }], [{ text: '   ' }], [{}]]) {
    assert.equal(buildEchoSlot(bad), '', `输入 ${JSON.stringify(bad)} 该给空串`)
  }
})

// ─────────────────────────── E2 形状与前言 ───────────────────────────
check('E2 形状：<memoryEcho> 壳 + 前言逐字 + 每条一行 + </memoryEcho>', () => {
  const out = buildEchoSlot([hit('她抓住我的手，周围的一切都安静了')])
  assert.ok(out.startsWith('<memoryEcho>\n'), '缺 <memoryEcho> 壳：' + out.slice(0, 40))
  assert.ok(out.endsWith('\n</memoryEcho>'), '缺 </memoryEcho> 尾：' + out.slice(-40))
  assert.ok(out.includes(ECHO_PREAMBLE), '前言不是逐字那一条')
  assert.ok(out.includes('她抓住我的手'), '正文没进去')
  assert.ok(/锚点为准/.test(ECHO_PREAMBLE) && /不是此刻/.test(ECHO_PREAMBLE),
    '前言必须说清"已经发生过、不是此刻、锚点优先"')
})

// ─────────────────────────── E3 行首标签 ───────────────────────────
check('E3 楼层区间：`sum_mt-0100-0129-1` ⇒ [楼 0100-0129]；认不出 ⇒ 如实写切片名（⛔ 不编楼号）', () => {
  assert.equal(floorRangeOf('sum_mt-0100-0129-1'), '0100-0129')
  assert.equal(floorRangeOf('sum_mt-0000-0020-2.md'), '0000-0020')
  assert.equal(floorRangeOf('1_2'), '', 'ST 老库那种 `1_2` 不该被认成楼层区间')
  assert.equal(floorRangeOf(undefined), '')
  assert.equal(hitLabel({ index: 'sum_mt-0100-0129-1' }), '[楼 0100-0129]')
  assert.equal(hitLabel({ index: '1_2' }), '[记忆 1_2]', '认不出就如实写名字')
  assert.equal(hitLabel({}), '[记忆 ?]', '连名字都没有也要如实标，⛔ 不编')
  const out = buildEchoSlot([hit('甲', 'sum_mt-0130-0140'), hit('乙', '3_1')])
  assert.ok(out.includes('[楼 0130-0140] 甲'), '楼层区间的行不对：' + out)
  assert.ok(out.includes('[记忆 3_1] 乙'), '认不出的行不对：' + out)
})

// ─────────────────────────── E4 life 续命标记 ───────────────────────────
check('E4 is_echo（靠 life 续命的那条）⇒ 行尾标「（回响续命）」；自然召回的不标', () => {
  const out = buildEchoSlot([hit('自然召回'), hit('续命的那条', 'sum_mt-0100-0129-2', { is_echo: true })])
  const lines = out.split('\n').filter((l) => l.startsWith('['))
  assert.equal(lines.length, 2, '应有两条：' + out)
  assert.ok(lines[0].includes('自然召回') && !lines[0].includes('回响续命'), '自然召回的不该带续命标：' + lines[0])
  assert.ok(lines[1].includes('回响续命'), '续命那条没标出来：' + lines[1])
})

// ─────────────────────────── E5 预算 ───────────────────────────
check('E5 预算：topK 截条、perHitChars 截字（带标注）、maxChars 是硬上限、⛔ 任何路径都不超预算', () => {
  const many = Array.from({ length: 9 }, (_, i) => hit('第' + i + '条内容', `sum_mt-00${10 + i}-00${20 + i}`))
  const out5 = buildEchoSlot(many, { topK: 5, maxChars: 4000, perHitChars: 280 })
  assert.equal(out5.split('\n').filter((l) => l.startsWith('[')).length, 5, 'topK 没生效')
  assert.ok(/［已截断：回响预算/.test(out5), '截了条却不标注（⛔ 不静默）')

  const long = '很长的正文'.repeat(200)
  const outCut = buildEchoSlot([hit(long)], { perHitChars: 50, maxChars: 2000 })
  assert.ok(outCut.includes('［片段已截断］'), '单条截断没有标注')

  for (const maxChars of [240, 400, 1200]) {
    const out = buildEchoSlot(many, { topK: 9, maxChars, perHitChars: 280 })
    assert.ok(out.length <= maxChars, `maxChars=${maxChars} 时超了：${out.length}`)
  }
  // 预算小到放不下任何一条 ⇒ 宁可不注入，也不给一个"烂壳"（空壳会被模型当"没有过往"）
  assert.equal(buildEchoSlot([hit('甲')], { maxChars: 240, perHitChars: 280, topK: 5 }) === '' ||
    buildEchoSlot([hit('甲')], { maxChars: 240, perHitChars: 280, topK: 5 }).length <= 240, true)
})

// ─────────────────────────── E6 顺序与纯函数 ───────────────────────────
check('E6 顺序 = 传入顺序（⛔ 不重排），且是纯函数：不修改入参、同入同出', () => {
  const hits = [hit('甲', 'sum_mt-0100-0129-1'), hit('乙', 'sum_mt-0100-0129-2'), hit('丙', 'sum_mt-0100-0129-3')]
  const snapshot = JSON.stringify(hits)
  const a = buildEchoSlot(hits, {})
  const b = buildEchoSlot(hits, {})
  assert.equal(a, b, '两次调用结果不同（不是纯函数？）')
  assert.equal(JSON.stringify(hits), snapshot, '入参被改了')
  const ia = a.indexOf('甲'); const ib = a.indexOf('乙'); const ic = a.indexOf('丙')
  assert.ok(ia < ib && ib < ic, '顺序没沿用传入序（引擎已排好，重排会让两格次序打架）')
})

// ─────────────────────────── E7 ★★ 反证：fts5 形状喂不进来 ───────────────────────────
check('E7 ★★ 反证：fts5 那套命中（{floor, body, docKey, hitCount}）喂进来 ⇒ 一条都用不上', () => {
  // 这是"把它换回 fts5 的命中 ⇒ 必红"的行为版：老的 FTS5 引擎吐的是 `body`/`floor`，
  // 而这个渲染器只认 anima 命中的 `text` ⇒ 换回 fts5 的数据 = 这一格**空**（而不是"看不出来地错了"）。
  const fts5Hits = [
    { docKey: '影子_-0906重开/floors/0129.json', source: '影子_-0906重开', floor: 129, body: '原文片段', hitCount: 3 },
    { docKey: '影子_-0906重开/floors/0077.json', source: '影子_-0906重开', floor: 77, body: '另一段原文', hitCount: 2 },
  ]
  assert.equal(buildEchoSlot(fts5Hits), '', 'fts5 形状居然被渲染出来了 ⇒ 这格可能又接回 fts5 了')
})

// ─────────────────────────── W1..W4 接线 ───────────────────────────
check('W1 接线：回响格由 `buildEchoSlot(res?.merged_chat_results, …)` 建（喂的是语义命中）', () => {
  assert.ok(/buildEchoSlot\(\s*res\?\.merged_chat_results/.test(LIVE),
    'index.js 里没有"用 merged_chat_results 建回响格"那一行 —— 接线断了')
  assert.ok(LIVE.includes("from './echo-view.js'"), '没有 import echo-view')
})

check('W2 接线：由 `inject.echo` 驱动，enabled:false ⇒ 整格不出', () => {
  assert.ok(/const echoCfg = cfg\.inject\?\.echo \?\? \{\}/.test(LIVE), '读的不是 inject.echo')
  assert.ok(/echoCfg\.enabled === false/.test(LIVE), '没有"关掉就整格不出"那道闸')
  const cfg = readFileSync(path.join(here, 'lib', 'index.js'), 'utf8')
  for (const key of ['topK', 'maxChars', 'perHitChars']) {
    assert.ok(new RegExp(`${key}:`).test(cfg), `inject.echo 里没有 ${key} 这个预算键`)
  }
  assert.ok(/echo:\s*\{[\s\S]{0,600}?enabled:\s*true/.test(cfg), 'DEFAULTS.inject.echo.enabled 不是 true')
})

check('W3 接线：回响格排在**最前面**（与改前 dma:echo@54 在 anima:memory@55 之前同序）', () => {
  const m = /const outText = \[([^\]]*)\]/.exec(LIVE)
  assert.ok(m !== null, '找不到 outText 的拼装（改了形状？同步本台子）')
  const parts = m[1].split(',').map((s) => s.trim())
  const iEcho = parts.findIndex((s) => s === 'echoText')
  const iRag = parts.findIndex((s) => s === 'text')
  assert.ok(iEcho >= 0 && iRag >= 0, `拼装里找不到 echoText/text：${m[1]}`)
  assert.ok(iEcho < iRag, '回响格必须排在 <recalledMemories> 那一段之前')
})

check('W4 ★反证：把喂进去的数据换成 fts5 那一套（floors/body）⇒ W1 的判据必红', () => {
  const back = LIVE.replace(/buildEchoSlot\(\s*res\?\.merged_chat_results/, 'buildEchoSlot(res?.echo_floors')
  assert.equal(/buildEchoSlot\(\s*res\?\.merged_chat_results/.test(back), false,
    '反证失败：换回 fts5 那套数据后 W1 仍被判为成立')
})

console.log(`\n── ${pass} 通过 / ${fails.length} 失败 ──`)
if (fails.length > 0) { console.log('失败：' + fails.join('、')); process.exitCode = 1 }
