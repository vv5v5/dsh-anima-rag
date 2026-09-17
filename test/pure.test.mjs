/**
 * 纯函数单测 —— `render.js` / `query-build.js`
 *
 * 这两个模块是**照抄** ST 侧 Anima 前端的（结果格式化 + 检索词构造），
 * 所以它们的测试就是「移植保真度」的回归网：改动这两个文件必须让本测全绿。
 *
 * 不需要引擎、不需要网络、不需要 API key —— `node --test test/` 即可。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  formatMergedChat, formatMergedKb,
  applyChatTemplate, applyKbTemplate, assembleInjection,
} from '../lib/render.js'
import {
  extractMessages, messageText, applyRegexRules,
  buildVectorQuery, buildBm25Text, lastUserText,
} from '../lib/query-build.js'

// ─────────────────────────── render.js

test('formatMergedChat: 空/非数组 → 空串；否则 item.text 之间空一行', () => {
  assert.equal(formatMergedChat(null), '')
  assert.equal(formatMergedChat([]), '')
  assert.equal(formatMergedChat([{ text: 'A' }, { text: 'B' }]), 'A\n\nB')
  // 原实现不跳过空 text，保真
  assert.equal(formatMergedChat([{ text: 'A' }, { text: '' }]), 'A\n\n')
})

test('formatMergedKb: 同名文档加 [Source:] 头、切片间用 ... 隔开、不同文档空行隔开', () => {
  const out = formatMergedKb([
    { doc_name: 'doc1', text: 'd1c1' },
    { doc_name: 'doc1', text: 'd1c2' },
    { doc_name: 'doc2', text: 'd2c1' },
  ])
  assert.equal(out, '[Source: doc1]\nd1c1\n...\nd1c2\n\n[Source: doc2]\nd2c1')
})

test('formatMergedKb: 缺 doc_name → Unknown Document', () => {
  assert.equal(formatMergedKb([{ text: 'x' }]), '[Source: Unknown Document]\nx')
})

test('applyChatTemplate: {{chatHistory}} / {{rag}} / {{recent_history}} 都替换且全局', () => {
  assert.equal(applyChatTemplate('{{chatHistory}}', 'C', 'R'), 'C')
  assert.equal(applyChatTemplate('{{rag}}', 'C', 'R'), 'C')
  assert.equal(applyChatTemplate('[H]{{chatHistory}}[H]', 'C', 'R'), '[H]C[H]')
  assert.equal(applyChatTemplate('{{chatHistory}}\n{{recent_history}}', 'C', 'R'), 'C\nR')
  // 模板为空 → 回落到默认
  assert.equal(applyChatTemplate('', 'C'), 'C')
})

test('applyKbTemplate: {{knowledge}} 替换 + 默认模板', () => {
  assert.equal(applyKbTemplate('设定：{{knowledge}}', 'K'), '设定：K')
  assert.equal(applyKbTemplate('', 'K'), '以下是相关设定：\nK')
})

test('assembleInjection: 只有 chat → 只出 chat 块', () => {
  const r = assembleInjection({ chatResults: [{ text: 'M1' }], kbResults: [] })
  assert.equal(r.text, 'M1')
  assert.equal(r.stats.chatItems, 1)
  assert.equal(r.stats.kbItems, 0)
})

test('assembleInjection: recent-only + 默认模板 → 空串（与 Anima 原行为一致，非 bug）', () => {
  const r = assembleInjection({ chatResults: [], kbResults: [], recentText: 'R1' })
  // 默认模板只有 {{chatHistory}}，recent 无处落 → 空。Anima 前端 `interceptor.js:406-413` 同样如此。
  assert.equal(r.text, '')
  assert.equal(r.stats.hasRecent, true)

  // 模板里写了 {{recent_history}} 才真的注入
  const r2 = assembleInjection({
    chatResults: [], kbResults: [], recentText: 'R1',
    cfg: { chatTemplate: '{{chatHistory}}\n{{recent_history}}' },
  })
  assert.equal(r2.text, 'R1')
})

test('assembleInjection: chat + kb 按 chat→kb 顺序拼接', () => {
  const r = assembleInjection({ chatResults: [{ text: 'M1' }], kbResults: [{ doc_name: 'D', text: 'K1' }] })
  assert.equal(r.text, 'M1\n\n以下是相关设定：\n[Source: D]\nK1')
})

test('assembleInjection: header 前缀 + 统计', () => {
  const r = assembleInjection({ chatResults: [{ text: 'M1' }], kbResults: [], cfg: { header: '【记忆】' } })
  assert.equal(r.text, '【记忆】\nM1')
  assert.equal(r.stats.finalChars, r.text.length)
})

test('assembleInjection: maxChars 截断保留**尾部**并加标记', () => {
  const r = assembleInjection({ chatResults: [{ text: 'A'.repeat(50) + 'TAIL' }], kbResults: [], cfg: { maxChars: 20 } })
  assert.equal(r.stats.truncated, true)
  assert.ok(r.text.endsWith('TAIL'), '应保留尾部')
  assert.match(r.text, /已按预算截断前段/)
})

test('assembleInjection: 全空 → 空串且不截断', () => {
  const r = assembleInjection({ chatResults: [], kbResults: [] })
  assert.equal(r.text, '')
  assert.equal(r.stats.truncated, false)
})

// ─────────────────────────── query-build.js

const ev = (type, text, kind) => ({
  type, seq: 1,
  data: { content: [{ type: 'text', text }], ...(kind ? { source: { kind } } : {}) },
})

test('messageText: 字符串 content / 内容块数组 / 非文本块被过滤', () => {
  assert.equal(messageText({ content: '  hi  ' }), 'hi')
  assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(messageText({ content: 123 }), '')
  assert.equal(messageText(undefined), '')
})

test('extractMessages: 只取 user/assistant，且**排除插件注入**（防自反馈）', () => {
  const msgs = extractMessages([
    ev('user/message', 'U1'),
    ev('assistant/message', 'A1'),
    ev('user/message', 'PLUGIN', 'plugin'),   // ← 必须被丢
    ev('turn/start', 'X'),
    ev('user/message', '   '),                // ← 空文本必须被丢
  ])
  assert.deepEqual(msgs.map(m => [m.role, m.text]), [['user', 'U1'], ['assistant', 'A1']])
})

test('extractMessages: skipLayerZero 跳过第一条；includeAssistant:false 只留 user', () => {
  const raw = [ev('user/message', 'U1'), ev('assistant/message', 'A1'), ev('user/message', 'U2')]
  assert.deepEqual(extractMessages(raw, { skipLayerZero: true }).map(m => m.text), ['A1', 'U2'])
  assert.deepEqual(extractMessages(raw, { includeAssistant: false }).map(m => m.text), ['U1', 'U2'])
})

test('applyRegexRules: 正常替换；非法正则被跳过而不抛', () => {
  assert.equal(applyRegexRules('【状态】正文', [{ pattern: '^【.*?】', replace: '' }]), '正文')
  assert.equal(applyRegexRules('abc', [{ pattern: '([', replace: '' }]), 'abc')
  assert.equal(applyRegexRules('abc', null), 'abc')
})

test('buildVectorQuery: context 项取最后 N 条并加 user:/assistant: 前缀', () => {
  const msgs = extractMessages([
    ev('user/message', 'U1'), ev('assistant/message', 'A1'),
    ev('user/message', 'U2'), ev('assistant/message', 'A2'),
  ])
  const q = buildVectorQuery(msgs, { vectorPrompt: [{ type: 'context', count: 2 }] })
  assert.equal(q, 'user: U2\nassistant: A2')
})

test('buildVectorQuery: 静态 content 项 + 与 context 块空行连接；不做宏求值', () => {
  const msgs = extractMessages([ev('user/message', 'U1')])
  const q = buildVectorQuery(msgs, {
    vectorPrompt: [{ type: 'context', count: 1 }, { content: '设定：{{char}} 是谁' }],
  })
  assert.equal(q, 'user: U1\n\n设定：{{char}} 是谁')
})

test('buildVectorQuery: regexSkipUser=true 时不动 user 文本', () => {
  const msgs = extractMessages([ev('user/message', '【X】U1')])
  const on = buildVectorQuery(msgs, { vectorPrompt: [{ type: 'context', count: 1 }], regexStrings: [{ pattern: '^【.*?】' }] })
  const off = buildVectorQuery(msgs, { vectorPrompt: [{ type: 'context', count: 1 }], regexStrings: [{ pattern: '^【.*?】' }], regexSkipUser: true })
  assert.equal(on, 'user: U1')
  assert.equal(off, 'user: 【X】U1')
})

test('buildVectorQuery: 空配置 → 空串', () => {
  assert.equal(buildVectorQuery(extractMessages([ev('user/message', 'U1')]), {}), '')
})

test('buildBm25Text: 取最后 N 条且按 maxChars 截尾', () => {
  const msgs = extractMessages([ev('user/message', 'U1'), ev('assistant/message', 'A1'), ev('user/message', 'U2')])
  assert.equal(buildBm25Text(msgs, { contextCount: 2 }), 'A1\nU2')
  assert.equal(buildBm25Text(msgs, { contextCount: 3, maxChars: 3 }), '1\nU2'.slice(-3))
})

test('lastUserText: 取最后一条 user', () => {
  const msgs = extractMessages([ev('user/message', 'U1'), ev('assistant/message', 'A1'), ev('user/message', 'U2')])
  assert.equal(lastUserText(msgs), 'U2')
  assert.equal(lastUserText([]), '')
})
