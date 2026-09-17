/**
 * dsh-anima-rag —— 从 DSH 会话事件构造检索词（移植 ST 侧前端逻辑）
 *
 * 移植来源：`Anima-Memory-System/scripts/interceptor.js`
 * | 原逻辑 | 位置 | 本文件 |
 * |---|---|---|
 * | 取原始聊天记录（`getChatMessages("0-{{lastMessageId}}", {include_swipes:false})`） | `:56-69` | {@link extractMessages} |
 * | 过滤「纯净聊天记录」（去 system、可选跳楼 0、去空） | `:72-81` | {@link extractMessages} |
 * | `vector_prompt` 配置驱动的检索词拼接 | `:83-127` | {@link buildVectorQuery} |
 * | `applyRegexRules` | `utils.js` | {@link applyRegexRules}（简化实现，见下） |
 *
 * ⚠️ **与 ST 的模型差异（必须知道）**：
 * 1. ST 的「楼 0」是角色问候语，`skip_layer_zero` 用来把它排除。**DSH 的会话历史里没有问候语**
 *    （问候语走 `import-context`，不进 history）。所以 `skipLayerZero` 在 DSH 默认 **false**，
 *    打开时的语义退化为「跳过第一条消息」。
 * 2. ST 的 `include_swipes:false` 对应 DSH 的「每个事件只取当前正文」——DSH 本来就只有一份正文
 *    （swipe 在 Tavern 的显示层，不在 DSH 事件流里），所以无需特殊处理。
 * 3. **必须排除插件注入的 user 消息**（`source.kind === 'plugin'`）。DSH 里插件的
 *    `systemPrompt.context()` 会落成 durable user-role 快照进历史；不排除的话，检索词会被
 *    自己的注入污染，形成自反馈。
 * 4. `processMacros`（ST 宏）在 DSH 无对应物 → **不做宏求值**，静态文本原样使用。
 *    理由：DSH Tavern 的宏只在它自己渲染 prompt 时求值，我们这里求值只会引入不一致。
 */

/**
 * 从 DSH 会话事件里抽出「纯净的聊天消息」。
 * @param {Array} events `session.snapshotEvents()` 或 `session.events`
 * @param {object} [cfg] `{ skipLayerZero, includeAssistant }`
 * @returns {Array<{seq:number, role:'user'|'assistant', text:string}>}
 */
export function extractMessages(events, cfg = {}) {
  const out = []
  for (const ev of events ?? []) {
    const t = ev?.type
    if (t !== 'user/message' && t !== 'assistant/message') continue

    const data = ev?.data
    const kind = data?.source?.kind
    // ★ 排除插件注入（runtime context 快照等），防自反馈
    if (kind === 'plugin') continue

    const text = messageText(data)
    if (!text) continue

    const role = t === 'user/message' ? 'user' : 'assistant'
    out.push({ seq: typeof ev.seq === 'number' ? ev.seq : out.length, role, text })
  }

  const sliced = cfg.skipLayerZero === true ? out.slice(1) : out
  return cfg.includeAssistant === false ? sliced.filter(m => m.role === 'user') : sliced
}

/** 从一条消息事件里取纯文本（内容块数组 → 拼接 text 块）。同 state-bridge `branch.js:103-112`。 */
export function messageText(data) {
  const content = data?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim()
}

/**
 * 简化版 `applyRegexRules`。
 *
 * ⚠️ **与 ST 版不完全等价**：ST 的规则结构由它的 UI 生成，字段名多样。
 * 这里只支持明确的三字段形式，并**在 `anima_status` 里报告实际生效的规则数**——
 * 不做「猜字段名」的兼容层，避免静默不生效。
 *
 * 规则形如：`{ pattern: '^【.*?】', flags: 'gm', replace: '' }`
 */
export function applyRegexRules(text, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return text
  let out = text
  for (const r of rules) {
    if (!r || typeof r.pattern !== 'string') continue
    try {
      const re = new RegExp(r.pattern, typeof r.flags === 'string' ? r.flags : 'g')
      out = out.replace(re, typeof r.replace === 'string' ? r.replace : '')
    } catch {
      // 非法正则：跳过该条，不抛（一条写错的规则不该让整轮检索失败）
    }
  }
  return out
}

/**
 * 移植 `constructRagQuery`（`interceptor.js:52-128`）。
 *
 * `cfg.vectorPrompt` 是配置数组，逐项：
 *   · `{ type:'context', count:N }` → 取**最后 N 条**消息，格式化成 `user: …` / `assistant: …` 行
 *   · 其它类型且带 `content` → 静态文本块
 * 各块用空行连接（原文 `join("\n\n")`）。
 */
export function buildVectorQuery(messages, cfg = {}) {
  const promptConfig = Array.isArray(cfg.vectorPrompt) ? cfg.vectorPrompt : []
  const rules = cfg.regexStrings
  const skipUserRegex = cfg.regexSkipUser === true

  const filtered = (messages ?? []).filter(m => m && typeof m.text === 'string' && m.text.trim())

  const parts = []
  for (const item of promptConfig) {
    if (item && item.type === 'context') {
      const count = parseInt(item.count, 10) || 5
      const sliced = filtered.slice(-count)

      const block = sliced
        .map(m => {
          let content = m.text
          const isUser = m.role === 'user'
          if (!(isUser && skipUserRegex)) content = applyRegexRules(content, rules)
          content = content?.trim()
          if (!content) return null
          return `${isUser ? 'user' : 'assistant'}: ${content}`
        })
        .filter(t => t !== null)
        .join('\n')

      if (block) parts.push(block)
    } else if (item && typeof item.content === 'string' && item.content.trim()) {
      // 不做宏求值（见文件头第 4 条）
      parts.push(item.content.trim())
    }
  }

  return parts.join('\n\n').trim()
}

/**
 * BM25 检索词的文本部分。
 *
 * ⚠️ **分工说明**：ST 侧「触发词分层扫描（user 命中优先于 context，全部未命中则整条跳过）」
 * 与「user 触发词 TF×3 / context ×1」发生在**服务端** `index.js:2559-2671`。
 * 本次搬运把服务端原样保留，所以**这里只负责给出干净文本**，
 * 触发词由 `bm25Configs[].dictionary` 传给服务端，扫描与加权仍由服务端做 —— 不重复实现。
 */
export function buildBm25Text(messages, cfg = {}) {
  // 键名与 `cfg.bm25.contextCount` 对齐（调用方直接传 cfg.bm25）。
  // 兼容 `bm25ContextCount` 只是防止两种写法混用后**静默失效**。
  const count = parseInt(cfg.contextCount ?? cfg.bm25ContextCount, 10) || 3
  const filtered = (messages ?? []).filter(m => m && typeof m.text === 'string' && m.text.trim())
  const sliced = filtered.slice(-Math.max(1, count))
  const text = sliced.map(m => m.text.trim()).join('\n')
  const max = Number.isFinite(cfg.maxChars) && cfg.maxChars > 0 ? cfg.maxChars : 4000
  return text.slice(-max)
}

/** 只取最后一条 user 消息的正文（最常用的检索词来源，也是 A/B 对照的基准）。 */
export function lastUserText(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return messages[i].text
  }
  return ''
}
