/**
 * _selftest-query-build.mjs —— 检索词取词的形状判据（2026-09-27 新增，进全量门）。
 *
 * 为什么有这个台子：`test/pure.test.mjs` 的 `ev()` 助手把**助手事件也造成 user 形状**
 * （`data.content`），而真机 `assistant/message` 的正文在 **`data.message.content`**
 * （12 周目转录逐帧解开实证的形状）⇒ 旧台子全绿、真机上助手楼却永远取成空，
 * 检索词只剩玩家楼——用户口径「改成最后两轮，也就是助手和玩家」追出来的根因。
 *
 * 本台子的事件形状**逐字照抄真机转录**（user：`data.content` + `data.source`；
 * assistant：`data.message.content`，reasoning 块在前）。
 * 反证锚：`data?.content !== undefined ? data.content : data?.message?.content` 这一行
 * 挖掉 `: data?.message?.content` ⇒ 本台子必红。
 */
import { extractMessages, messageText, buildVectorQuery, lastUserText } from './lib/query-build.js'

let pass = 0, fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log('PASS', name) }
  else { fail += 1; console.log('FAIL', name, detail ? '—— ' + String(detail).slice(0, 300) : '') }
}

/** 真机形状（2026-09-27 12 周目转录照抄，字段只留取词用得到的）。 */
const userEvent = (text, seq) => ({
  type: 'user/message', seq,
  data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' },
})
const assistantEvent = (reasoning, text, seq) => ({
  type: 'assistant/message', seq,
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [
    { type: 'reasoning', text: reasoning },
    { type: 'text', text },
  ] }, usage: {} },
})

// ── ① messageText 双形状 ──────────────────────────────────────────────────
{
  check('① user 形状（data.content）照旧取到',
    messageText(userEvent('玩家楼', 1).data) === '玩家楼')
  const a = assistantEvent('私有思考', '可见正文', 2).data
  check('① assistant 形状（data.message.content）取到可见正文',
    messageText(a) === '可见正文', JSON.stringify(messageText(a)))
  check('① reasoning ⛔ 不进正文（不给检索词喂思维链）',
    !messageText(a).includes('私有思考'))
  check('① 两种形状都缺 ⇒ 空串（⛔ 不抛）',
    messageText({}) === '' && messageText(undefined) === '')
}

// ── ② extractMessages：助手楼从此真的在列 ────────────────────────────────
{
  const msgs = extractMessages([
    userEvent('U1', 1), assistantEvent('想1', 'A1', 2), userEvent('U2', 3),
    // 真机旧bug现场：assistant 事件没有 message.content（取不到正文）⇒ 如实丢掉，⛔ 不进列
    { type: 'assistant/message', seq: 4, data: { turn: 1, step: 1, usage: {} } },
  ])
  check('② 真·事件流里 user/assistant 都进列；取不到正文的助手事件被如实丢掉',
    JSON.stringify(msgs.map(m => [m.role, m.text])) === JSON.stringify([['user', 'U1'], ['assistant', 'A1'], ['user', 'U2']]),
    JSON.stringify(msgs))
}

// ── ③ 检索词 = 最后两轮（助手 + 玩家）—— 用户口径的落点 ─────────────────
{
  const msgs = extractMessages([
    userEvent('更早的玩家楼', 1), assistantEvent('想', '更早的助手楼', 2),
    assistantEvent('想', '助手的上一楼回复', 3), userEvent('玩家这一楼的输入', 4),
  ])
  const q = buildVectorQuery(msgs, { vectorPrompt: [{ type: 'context', count: 2 }] })
  check('③ count:2 取到 [助手上一楼, 玩家这一楼]（最后一楼必是玩家）',
    q.includes('assistant: 助手的上一楼回复') && q.includes('user: 玩家这一楼的输入')
      && !q.includes('更早的助手楼') && !q.includes('更早的玩家楼'), q)
  check('③ 取词里 reasoning 一个字都不出现',
    !q.includes('想'), q)
  check('③ lastUserText 兜底仍是纯玩家楼（A/B 对照基准不动）',
    lastUserText(msgs) === '玩家这一楼的输入')
}

console.log(`\n── ${pass} 通过 / ${fail} 失败 ──`)
process.exitCode = fail === 0 ? 0 : 1
