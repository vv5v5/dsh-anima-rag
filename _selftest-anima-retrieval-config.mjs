/**
 * anima × 记忆库配置（retrieval.*）自检（2026-09-18）。
 *
 * 覆盖（对应任务书验收 3 / 6 与 T3）：
 *   ① ★反证（验收 3 三相，喂给读配置函数）：
 *       相① 记忆库 retrieval.* 有值 ⇒ 用它（embed.url/model、rerank.url=去尾斜杠+'/rerank'、两边同 key）；
 *       相② 记忆库无值 ⇒ 回落 DEFAULTS（新装机没配过也能跑）；
 *       相③ ⛔ **不再读环境变量**（2026-09-18 改口径）：env 里有 key 也一点不读。
 *     ⛔ 不存在也不断言任何"预设兜底"层 —— 生效顺序只有两层。
 *   ② ★反证（验收 6）：lib/ 下 `agent.cordis.yml` / `.agent-presets` / `preset` 零命中
 *     （anima 不依赖、不读、不解析任何外部预设文件）。
 *   ③ **环境变量兜底已删**（2026-09-18 用户拍板：插件不许吃环境凭据）⇒ key 只能来自记忆库配置。
 *   ④ apply() 接线静态锚：先读记忆库 retrieval 段、再 mergeConfig、再 applyRetrievalConfig。
 *
 * 纯函数台：零网络、零宿主。env 一律**注入假值**（不读真实环境变量、不碰真密钥）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeConfig, applyRetrievalConfig, memoryArchiveConfigFile, config as DEFAULTS } from './lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : '  ← ' + String(extra)}`)
}

// 自造假 key（字面量自造；⛔ 不读环境变量、不碰真密钥）
const FAKE = 'sk-TESTKEY-DO-NOT-USE'

// ───────── ⓪ 记忆库配置**路径**（2026-09-19 真机装配期崩的回归位）─────────
// 真机症状：`DSH_HOME` 一设（launcher 就是 `<home>/.dsh`），旧写法拼成 `<…>\.dsh\.dsh\…`
// ⇒ 读不到 retrieval ⇒ key 为空 ⇒ 装配期 `getEmbedding` 抛 `API Key missing` ⇒ **模型没有回复**。
{
  const win = { DSH_HOME: 'C:\\Users\\w\\.dsh' }
  const p1 = memoryArchiveConfigFile({ env: win })
  check('⓪ DSH_HOME 本身就是 .dsh ⇒ 只拼一层（不再出现 \\.dsh\\.dsh\\）',
    p1 === join('C:\\Users\\w\\.dsh', 'dsh-memory-archive', 'config.json') && !p1.includes('\\.dsh\\.dsh\\'), p1)
  // ★ 反证：把旧写法算一遍，它**必须**是错的 —— 否则这条回归位没意义
  const oldWay = join(win.DSH_HOME || 'x', '.dsh', 'dsh-memory-archive', 'config.json')
  check('⓪ ★反证：旧写法确实会多一层 .dsh（这就是真机上读到空配置的原因）',
    oldWay.includes('\\.dsh\\.dsh\\') && oldWay !== p1, oldWay)
  // 没设 DSH_HOME ⇒ 退到 <home>/.dsh
  const p2 = memoryArchiveConfigFile({ env: {} })
  check('⓪ 没设 DSH_HOME ⇒ 退到 <home>/.dsh/…', p2.endsWith(join('.dsh', 'dsh-memory-archive', 'config.json')), p2)
  // 空白 / 非字符串 ⇒ 当没设（不拼出空段）
  const p3 = memoryArchiveConfigFile({ env: { DSH_HOME: '   ' } })
  check('⓪ 空白 DSH_HOME ⇒ 当没设，也不拼出 ` .dsh` 这种怪路径',
    p3 === p2 && !p3.includes(' .dsh'), p3)
  // 显式 override 优先，且原样返回（允许前后空白）
  check('⓪ 显式 override 优先且原样使用',
    memoryArchiveConfigFile({ env: win, override: '  D:\\x\\config.json  ' }) === 'D:\\x\\config.json')
  check('⓪ override 为空串 ⇒ 回落环境推导', memoryArchiveConfigFile({ env: win, override: '' }) === p1)
}

// ───────── ① 验收 3 三相 ─────────

// 相②（先立基准）：无记忆库值、无 env ⇒ DEFAULTS
{
  const cfg = applyRetrievalConfig(mergeConfig({}, { env: {} }), null)
  check('② 相②：记忆库无值 ⇒ 回落 DEFAULTS（embed/rerank 原样）',
    cfg.embed.url === DEFAULTS.embed.url && cfg.embed.model === DEFAULTS.embed.model
    && cfg.rerank.api.url === DEFAULTS.rerank.api.url && cfg.rerank.api.model === DEFAULTS.rerank.api.model
    && cfg.embed.key === '' && cfg.rerank.api.key === '',
    JSON.stringify({ embed: cfg.embed, rerankApi: cfg.rerank.api }))
}

// 相①：记忆库 retrieval.* 有值 ⇒ 四项全覆盖（重排地址由接口地址推，⛔ 不写死域名）
{
  const base = mergeConfig({}, { env: {} })
  const cfg = applyRetrievalConfig(base, {
    url: 'https://mem-config.example.invalid/v1/',
    model: 'mt-embed-model',
    rerankModel: 'mt-rerank-model',
    key: FAKE,
  })
  check('① 相①：embed.url/model 用记忆库值（尾斜杠去掉）',
    cfg.embed.url === 'https://mem-config.example.invalid/v1' && cfg.embed.model === 'mt-embed-model',
    JSON.stringify({ url: cfg.embed.url, model: cfg.embed.model }))
  check('① 相①：重排地址 = 记忆库 url 去尾斜杠 + /rerank（不写死域名）',
    cfg.rerank.api.url === 'https://mem-config.example.invalid/v1/rerank', cfg.rerank.api.url)
  check('① 相①：重排模型用记忆库值', cfg.rerank.api.model === 'mt-rerank-model', cfg.rerank.api.model)
  check('① 相①：key 覆盖 embed 与 rerank 两边（面板只收一个密钥框）',
    cfg.embed.key === FAKE && cfg.rerank.api.key === FAKE, 'embed/rerank key 是否都等于注入的假 key')
  // 覆盖语义：记忆库有值 ⇒ 压过插件自身配置里的旧值（两层顺序：记忆库 → DEFAULTS）
  const cfg2 = applyRetrievalConfig(mergeConfig({ embed: { url: 'https://stale.example.invalid', model: 'stale-model', key: 'stale' } }, { env: {} }), {
    url: 'https://fresh.example.invalid/v1', model: 'fresh-model', rerankModel: '', key: FAKE,
  })
  check('① 相①：记忆库值压过插件自身配置里的旧值；空字段（rerankModel=""）不覆盖',
    cfg2.embed.url === 'https://fresh.example.invalid/v1' && cfg2.embed.model === 'fresh-model'
    && cfg2.rerank.api.url === 'https://fresh.example.invalid/v1/rerank'
    && cfg2.rerank.api.model === DEFAULTS.rerank.api.model,
    JSON.stringify({ embedUrl: cfg2.embed.url, rerankUrl: cfg2.rerank.api.url, rerankModel: cfg2.rerank.api.model }))
}

// 相③（2026-09-18 改口径）：⛔ **不再读环境变量** —— 键的唯一来源是记忆库配置。
{
  const warns = []
  // ★ 反证：环境变量里有 key，但本函数**完全不看**它（user 口径：我们做的是插件，不许吃环境凭据）
  const cfg = mergeConfig({}, { env: { ANIMA_RAG_EMBED_KEY: FAKE, ANIMA_RAG_RERANK_KEY: FAKE + '-R' }, warn: (m) => warns.push(String(m)) })
  check('③ ★反证：环境变量里有 key 也**一点不读**（embed/rerank 都还是空）',
    cfg.embed.key === '' && cfg.rerank.api.key === '',
    JSON.stringify({ embedKey: cfg.embed.key === '' ? '(空)' : '(有值！)', rerankKey: cfg.rerank.api.key === '' ? '(空)' : '(有值！)' }))
  check('③ ★反证：不再产生"过渡态"那类告警（那条口径已作废）',
    warns.length === 0 && warns.every((w) => !w.includes('环境变量')), JSON.stringify(warns))
  // 正相：只有记忆库配置能给 key
  const mtRetrieval = { url: '', model: '', rerankModel: '', key: 'mt-key-value' }
  const cfg2 = applyRetrievalConfig(mergeConfig({}, { env: { ANIMA_RAG_EMBED_KEY: FAKE }, warn: () => {} }), mtRetrieval)
  check('③ 记忆库有 key ⇒ embed 与 rerank 都拿到它（同 key 口径）',
    cfg2.embed.key === 'mt-key-value' && cfg2.rerank.api.key === 'mt-key-value', 'embed/rerank key 应等于记忆库假值')
  // 缺省 opts（老调用方 mergeConfig(raw) 一参调用）照常工作、env 默认 process.env、不抛
  const cfg3 = mergeConfig({})
  check('③ 兼容：一参调用 mergeConfig 不抛且形状完整', !!cfg3 && typeof cfg3.embed.url === 'string' && Array.isArray(cfg3.chatCollections))
}

// ───────── ② 验收 6：anima lib/ 不出现任何预设字样 ─────────

{
  const libDir = join(here, 'lib')
  const sources = readdirSync(libDir).filter((n) => n.endsWith('.js')).map((n) => ({ name: n, text: readFileSync(join(libDir, n), 'utf8') }))
  for (const needle of ['agent.cordis.yml', '.agent-presets', 'preset']) {
    const hits = sources.filter((s) => s.text.toLowerCase().includes(needle.toLowerCase())).map((s) => s.name)
    check(`② ★反证：lib/ 不出现 "${needle}"（anima 不读任何预设文件，grep 零命中）`, hits.length === 0, hits.join('、'))
  }
}

// ───────── ③ T5 保守要求：env 兜底没有被删 ─────────

{
  const idxSrc = readFileSync(join(libDir0(), 'index.js'), 'utf8')
  // ★ 反证（2026-09-18 改口径）：环境变量兜底**已被删** —— 代码里不许再有"读 env 取 key"的活代码。
  //   ⚠️ 断言要看**可执行代码**，不是整个文件：注释里为了说明"已删"仍会提到这两个名字。
  check('③ ★反证：`process.env.ANIMA_RAG_*` 在源码里**零命中**（注释不算，先剥注释再查）',
    !/process\.env\.ANIMA_RAG_/.test(stripComments(idxSrc)),
    '⛔ 出现即说明环境变量兜底被加回来了')
}
/** 剥掉 // 行注释与 /* *\/ 块注释 —— 静态断言要看**活代码**，别被"已删"的说明文字骗过。 */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}
function libDir0() {
  return join(here, 'lib')
}

// ───────── ④ apply() 接线静态锚：读记忆库 → merge → 套覆盖 ─────────

{
  const idxSrc = readFileSync(join(here, 'lib', 'index.js'), 'utf8')
  check('④ 静态：apply() 里 mergeConfig → applyRetrievalConfig 的次序在位',
    /applyRetrievalConfig\(\s*mergeConfig\(/.test(idxSrc), '缺 applyRetrievalConfig(mergeConfig(...)) 组合')
  check('④ 静态：记忆库 retrieval 段读取器在位（按 config.json 的 mtime 缓存）',
    idxSrc.includes('function memoryArchiveRetrieval()') && idxSrc.includes('mtimeMs'))
  check('④ 静态：**不再**给 mergeConfig 传 env（没有 mtHasKey 那种"配置有 key 才不看 env"的分支）',
    !idxSrc.includes('mtHasKey') && !/mergeConfig\([^)]*env/.test(stripComments(idxSrc)), '应当彻底不看环境变量')
}

console.log(fail === 0 ? `\n★ anima × 记忆库配置：全过（${pass} 条）` : `\n✖ ${fail} 条没过（通过 ${pass}）`)
process.exit(fail === 0 ? 0 : 3)
