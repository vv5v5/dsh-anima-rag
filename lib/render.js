/**
 * dsh-anima-rag —— 结果 → 注入文本（纯函数，无宿主依赖，可单测）
 *
 * 这两段**照抄** ST 侧前端 `Anima-Memory-System/scripts/interceptor.js:22-49`，
 * 一个字符都没改语义 —— 因为用户对「注入进去长什么样」有肌肉记忆，这里不能自作主张。
 *
 * | 原函数 | 位置 | 本文件 |
 * |---|---|---|
 * | `formatMergedChat(mergedList)` | `interceptor.js:22-25` | {@link formatMergedChat} |
 * | `formatMergedKb(mergedList)` | `interceptor.js:30-49` | {@link formatMergedKb} |
 * | 模板替换逻辑 | `interceptor.js:399-440` | {@link assembleInjection} |
 *
 * 模板语义（保持原样）：
 *   chat 模板默认 `{{chatHistory}}`，同时接受 `{{rag}}` 与 `{{recent_history}}`
 *   kb   模板默认 `以下是相关设定：\n{{knowledge}}`，接受 `{{knowledge}}`
 * 两个模板各自替换后**再拼在一起**（原代码是分别写进两个世界书条目，
 * 在 DSH 里合并成**一段 section**，所以按 chat → kb 的顺序拼接）。
 */

/** 后端已排好序的 chat 结果 → 文本。原样：`item.text` 之间空一行。 */
export function formatMergedChat(mergedList) {
  if (!Array.isArray(mergedList) || mergedList.length === 0) return ''
  return mergedList.map(item => item?.text ?? '').join('\n\n')
}

/** 后端已排好序的 kb 结果 → 文本。同名文档合并、切片间用 `...` 隔开。 */
export function formatMergedKb(mergedList) {
  if (!Array.isArray(mergedList) || mergedList.length === 0) return ''

  let finalString = ''
  let currentDoc = ''

  for (const item of mergedList) {
    const docName = item?.doc_name || 'Unknown Document'
    if (docName !== currentDoc) {
      if (finalString !== '') finalString += '\n\n'
      finalString += `[Source: ${docName}]\n`
      currentDoc = docName
    } else {
      finalString += '\n...\n'
    }
    finalString += item?.text ?? ''
  }

  return finalString
}

/**
 * 应用 chat 模板。原代码只做一次 replace，但模板里 `{{chatHistory}}` 可能多次出现，
 * 这里用全局替换（`gi`）—— 这是唯一一处刻意的行为改进，避免模板里写两次只换掉一处。
 */
export function applyChatTemplate(template, chatText, recentText = '') {
  const tpl = template || '{{chatHistory}}'
  return tpl
    .replace(/\{\{chatHistory\}\}/gi, chatText ?? '')
    .replace(/\{\{rag\}\}/gi, chatText ?? '')
    .replace(/\{\{recent_history\}\}/gi, recentText ?? '')
}

export function applyKbTemplate(template, kbText) {
  const tpl = template || '以下是相关设定：\n{{knowledge}}'
  return tpl.replace(/\{\{knowledge\}\}/gi, kbText ?? '')
}

/**
 * 把一次检索的产物装配成**一段**注入文本。
 *
 * @param {object} input
 * @param {Array}  input.chatResults   `merged_chat_results`
 * @param {Array}  input.kbResults     `merged_kb_results`
 * @param {string} [input.recentText]  「最近 N 条总结」（Anima 的 recent_count 支线）
 * @param {object} [input.cfg]         `{ chatTemplate, kbTemplate, maxChars, header }`
 * @returns {{ text: string, stats: object }}
 */
export function assembleInjection({ chatResults, kbResults, recentText = '', cfg = {} } = {}) {
  const chatText = formatMergedChat(chatResults)
  const kbText = formatMergedKb(kbResults)

  const parts = []
  const hasRag = chatText.trim().length > 0
  const hasRecent = String(recentText ?? '').trim().length > 0

  if (hasRag || hasRecent) {
    const block = applyChatTemplate(cfg.chatTemplate, chatText, recentText).trim()
    if (block) parts.push(block)
  }
  if (kbText.trim().length > 0) {
    const block = applyKbTemplate(cfg.kbTemplate, kbText).trim()
    if (block) parts.push(block)
  }

  let text = parts.join('\n\n').trim()
  const header = typeof cfg.header === 'string' ? cfg.header.trim() : ''
  if (text && header) text = `${header}\n${text}`

  const stats = {
    chatItems: Array.isArray(chatResults) ? chatResults.length : 0,
    kbItems: Array.isArray(kbResults) ? kbResults.length : 0,
    hasRecent,
    rawChars: text.length,
    truncated: false,
  }

  const max = Number.isFinite(cfg.maxChars) && cfg.maxChars > 0 ? cfg.maxChars : 0
  if (max > 0 && text.length > max) {
    // 预算截断：保留**尾部**。理由：Anima 的 merged 结果按时间升序，
    // 越靠后越接近当前进度；截头保尾比截尾保头更符合「记得住最近发生的事」。
    text = `（记忆较长，已按预算截断前段）\n${text.slice(text.length - max)}`
    stats.truncated = true
  }
  stats.finalChars = text.length

  return { text, stats }
}
