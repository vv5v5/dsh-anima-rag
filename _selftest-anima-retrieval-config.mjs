/**
 * anima × 记忆库配置（retrieval.*）自检（2026-09-18）。
 *
 * 覆盖（对应任务书验收 3 / 6 与 T3）：
 *   ① ★反证（验收 3 三相，喂给读配置函数）：
 *       相① 记忆库 retrieval.* 有值 ⇒ 用它（embed.url/model、rerank.url=去尾斜杠+'/rerank'、两边同 key）；
 *       相② 记忆库无值 ⇒ 回落 DEFAULTS（新装机没配过也能跑）；
 *       相③ 配置无值且 env 有 ⇒ 用 env **并且** warn 被调到（过渡态提醒）。
 *     ⛔ 不存在也不断言任何"预设兜底"层 —— 生效顺序只有两层。
 *   ② ★反证（验收 6）：lib/ 下 `agent.cordis.yml` / `.agent-presets` / `preset` 零命中
 *     （anima 不依赖、不读、不解析任何外部预设文件）。
 *   ③ env 兜底**没有被删**（T5 的保守要求：现在它仍是 key 的合法来源之一）。
 *   ④ apply() 接线静态锚：先读记忆库 retrieval 段、再 mergeConfig、再 applyRetrievalConfig。
 *
 * 纯函数台：零网络、零宿主。env 一律**注入假值**（不读真实环境变量、不碰真密钥）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeConfig, applyRetrievalConfig, config as DEFAULTS } from './lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : '  ← ' + String(extra)}`)
}

// 自造假 key（字面量自造；⛔ 不读环境变量、不碰真密钥）
const FAKE = 'sk-TESTKEY-DO-NOT-USE'

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

// 相③：配置无值且 env 有 ⇒ 用 env 并且 warn 被调到（⛔ 不删兜底；命中要大声提醒过渡态）
{
  const warns = []
  const cfg = mergeConfig({}, { env: { ANIMA_RAG_EMBED_KEY: FAKE, ANIMA_RAG_RERANK_KEY: FAKE + '-R' }, warn: (m) => warns.push(String(m)) })
  check('③ 相③：env 兜底生效（embed 与 rerank 都拿到注入的假 key）',
    cfg.embed.key === FAKE && cfg.rerank.api.key === FAKE + '-R')
  check('③ 相③：warn 被调到且点名「过渡态/记忆库设置」',
    warns.length >= 2 && warns.every((w) => w.includes('过渡态') && w.includes('记忆库设置')),
    JSON.stringify(warns))
  // 反证：记忆库已有 key 时 env 不该再插手（两层顺序的记忆库层优先；warn 也不许误报）。
  // 组合照 apply() 的真实接线：记忆库有 key ⇒ 给 mergeConfig 注入空 env。
  const warns2 = []
  const mtRetrieval = { url: '', model: '', rerankModel: '', key: 'mt-key-value' }
  const mtHasKey = typeof mtRetrieval.key === 'string' && mtRetrieval.key.trim() !== ''
  const base = mergeConfig({}, { env: mtHasKey ? {} : { ANIMA_RAG_EMBED_KEY: FAKE }, warn: (m) => warns2.push(m) })
  const cfg2 = applyRetrievalConfig(base, mtRetrieval)
  check('③ 反证：记忆库 key 优先，env 的值被覆盖、不再保留',
    cfg2.embed.key === 'mt-key-value' && cfg2.rerank.api.key === 'mt-key-value', 'embed/rerank key 应等于记忆库假值')
  check('③ 反证：记忆库有 key ⇒ 不产生"过渡态"误报',
    warns2.length === 0, JSON.stringify(warns2))
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
  check('③ lib/index.js 仍有 ANIMA_RAG_EMBED_KEY / ANIMA_RAG_RERANK_KEY 兜底（本单不删）',
    idxSrc.includes('ANIMA_RAG_EMBED_KEY') && idxSrc.includes('ANIMA_RAG_RERANK_KEY'))
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
  check('④ 静态：记忆库已配 key ⇒ env 不参与（不误报过渡态）',
    idxSrc.includes('mtHasKey ? {} : process.env'))
}

console.log(fail === 0 ? `\n★ anima × 记忆库配置：全过（${pass} 条）` : `\n✖ ${fail} 条没过（通过 ${pass}）`)
process.exit(fail === 0 ? 0 : 3)
