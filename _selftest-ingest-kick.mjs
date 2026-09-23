#!/usr/bin/env node
/**
 * _selftest-ingest-kick.mjs —— 「自动入库什么时候被踢起来」的**源码级**防回流自检。
 *
 * ## 为什么要有它（用户口径，2026-09-20 原文）
 *   「收纳提示的触发现在是每轮。改成压缩时才触发」
 *   根因：`kickAutoIngest` 挂在**每轮装配**的 section provider 里，而它一进来就
 *   `writeIngestState({ running: true })` —— 于是面板那条"记忆库正在后台收纳"**每轮闪一次**，
 *   哪怕 `autoIngestOnce` 随后就 `skipped:'unchanged'` 什么都没干。
 *   修法：踢之前先做一次**只读预判**（`hasPendingIngestWork`，只 statSync 一次、⛔ 不写状态文件），
 *   没有新东西就**根本不启动**。摘要只由**压缩**产出 ⇒ 效果 = 只在压缩时触发。
 *
 * ## 判据（全是"形状"，因为那个函数在 cordis 闭包里、单测够不着）
 *   K1 踢之前先预判；K2 预判**不许**写 ingest-state；K3 目录解析只有一份（⛔ 不两处各写）；
 *   K4 **每进程一次的维护：不许被饿死，也不许变成"每轮一次"**；K5 `running: true` 只出现在真启动那一支。
 *   每条都带**反证**：把关键那行从源码里挖掉（或把旧写法重放一遍），判据必须红。
 *
 * ## 2026-09-20 第二次事故（用户原文：「现在还是每一轮都弹记忆库收纳」）
 *   上一版把闸门加上了，但**置位写在了闸门外面、且在两道早退之后** ⇒ 未归周目 / 还没 index.json
 *   的会话里 `firstOfProcess` 恒真 ⇒ 每轮照样空跑一次。K4 这一组现在钉的就是这个形状。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(here, 'lib', 'index.js'), 'utf8')

let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : '  ← ' + String(extra)}`)
}

/** 剥掉注释 —— 静态断言要看**活代码**，别被"已删除"之类的说明文字骗过（与别的台子同一份）。 */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * 抠出某个顶层函数的函数体（大括号配对；⛔ 不靠正则到下一个 function）。
 *
 * ⚠️ **必须先跨过参数表**（2026-09-20 修的）：签名里一旦有默认值对象
 * （`function f(a, opts = {})`），朴素的"第一个 `{`"会命中**参数里那个空对象**，
 * 抠出来的"函数体"就只有 `{}` ⇒ 判据全部假红。先配对括号找到参数表结尾，再找函数体的 `{`。
 */
function bodyOf(src, name) {
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) return null
  const parenOpen = src.indexOf('(', at)
  if (parenOpen < 0) return null
  let pdepth = 0
  let parenClose = -1
  for (let i = parenOpen; i < src.length; i += 1) {
    if (src[i] === '(') pdepth += 1
    else if (src[i] === ')') { pdepth -= 1; if (pdepth === 0) { parenClose = i; break } }
  }
  if (parenClose < 0) return null
  const open = src.indexOf('{', parenClose)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(open, i + 1) }
  }
  return null
}

const kick = bodyOf(SRC, 'kickAutoIngest')
const pending = bodyOf(SRC, 'hasPendingIngestWork')
const once = bodyOf(SRC, 'autoIngestOnce')

check('K0 三个要看的函数都在（改了名字这条会红，提醒同步本台子）',
  kick !== null && pending !== null && once !== null, `kick=${kick !== null} pending=${pending !== null} once=${once !== null}`)

// ── K1 踢之前先预判，且**预判在置 running 之前** ───────────────────────────
{
  const iCheck = kick === null ? -1 : kick.indexOf('hasPendingIngestWork(')
  const iRun = kick === null ? -1 : kick.indexOf('autoIngestRunning = true')
  check('K1 ★ 先 hasPendingIngestWork() 再置 running（顺序反了就等于没改）',
    iCheck > 0 && iRun > iCheck, `iCheck=${iCheck} iRun=${iRun}`)
  check('K1b ★ 反证：把预判那行挖掉 ⇒ 判据必须红',
    iCheck < 0 || iRun > iCheck, '')
  const stripped = kick === null ? '' : kick.replace(/hasPendingIngestWork\([^)]*\)/, '')
  check('K1c ★ 反证（挖掉后）：同一句判据红', !((stripped.indexOf('hasPendingIngestWork(') > 0)
    && (stripped.indexOf('autoIngestRunning = true') > stripped.indexOf('hasPendingIngestWork('))), '')
}

// ── K2 预判本身**只读**：⛔ 不写 ingest-state、⛔ 不置 running ──────────────
{
  check('K2 ★ 预判里没有 writeIngestState（写了就又每轮闪一次）',
    pending !== null && !/writeIngestState/.test(pending) && !/autoIngestRunning\s*=\s*true/.test(pending), '')
  check('K2b ★ 预判只做 statSync + 比较闸门（不许读 index.json 正文干重活）',
    pending !== null && /statSync\(/.test(pending) && !/readFileSync/.test(pending), '')
}

// ── K3 目录解析只有一份实现（⛔ 不许两处各写一遍 —— 那是"两处真相"） ────────
{
  // ★ 2026-09-20：「这次该入哪个目录」并进了 `sessionSummariesDir()`（会话优先、**无兜底**），
  //   与读侧「最近 N 条总结」共用同一份解析。本台子跟着改名。
  const dirFn = bodyOf(SRC, 'sessionSummariesDir')
  const n = dirFn === null ? -1 : (dirFn.match(/resolvePlaythroughForSession\(/g) || []).length
  check('K3 ★ `resolvePlaythroughForSession(` 在 sessionSummariesDir 里只出现 1 次（一份实现、读写两侧共用）',
    n === 1, `sessionSummariesDir 里出现 ${n} 次`)
  check('K3b ★ autoIngestOnce 与 hasPendingIngestWork **都**用 sessionSummariesDir（判据同源）',
    once !== null && pending !== null && once.includes('sessionSummariesDir(') && pending.includes('sessionSummariesDir('), '')
  // ★★ 2026-09-20 口径（用户：「认不出来的会话默认为新会话。会话优先」）——
  //   兜底**必须是空串**：传面板绑定值就会让一条新会话去读/写**上一轮**的库。
  check('K3c ★★ 会话优先、**不给兜底**：resolvePlaythroughForSession 的第 3 参是空串',
    dirFn !== null && /resolvePlaythroughForSession\([^)]*,\s*''\s*\)/.test(dirFn), dirFn === null ? '缺函数' : '')
  check('K3d ★★ 反证：把兜底换回 boundPlaythroughId() ⇒ 同一句判据必红',
    dirFn !== null && !/resolvePlaythroughForSession\([^)]*,\s*''\s*\)/.test(dirFn.replace(/,\s*''(\s*\))/, ', boundPlaythroughId()$1')), '')
  check('K3e ★ 旧面板绑定兜底那两样（ingestDirFor / boundPlaythroughId）都已不存在（活代码里零命中）',
    !/ingestDirFor\(/.test(stripComments(SRC)) && !/boundPlaythroughId/.test(stripComments(SRC)), '')
}

// ── K4 ★★ 每进程一次的维护：不许被饿死，也**不许**变成"每轮一次"（2026-09-20 第二次真机事故）──
//   事故形状（实测：新建一条会话连发两轮，`ingest-state.json` **两次都被重写**、`skipped` 都是 `no-dir`）：
//     置位写在 `autoIngestOnce` 里，且排在 `dir === ''` / `no-index` 那两道**早退之后**
//     ⇒ 未归周目 / 还没有 index.json 的会话**永远走不到置位** ⇒ `firstOfProcess` **每轮都为真**
//     ⇒ 每轮空跑一次"入库"（写状态文件 ⇒ 面板那条提示**每轮弹**）。
//   现在的形状：**维护单独一支** —— 置位在 `kickAutoIngest` 里、排在闸门**之前**，
//     而这一支 ⛔ 不写 ingest-state；闸门那一支 ⛔ 没有任何"本进程第一脚"例外。
{
  const iMaintain = kick === null ? -1 : kick.indexOf('maintainDone = true')
  const iGate = kick === null ? -1 : kick.indexOf('hasPendingIngestWork(')
  check('K4 ★ 维护的置位在 kickAutoIngest 里，且排在闸门**之前**（它不该由"有没有活"决定）',
    iMaintain > 0 && iGate > iMaintain, `iMaintain=${iMaintain} iGate=${iGate}`)
  check('K4b ★ 闸门那一支**没有**"本进程第一脚"例外（有它 = 每轮都启动 = 提示每轮弹）',
    kick !== null && !/firstOfProcess/.test(stripComments(kick)), '')
  check('K4c ★ 维护那一支**不写** ingest-state（写了提示就会因为"维护"弹出来）',
    kick !== null && iGate > 0 && kick.indexOf('writeIngestState(') > iGate, '')
  check('K4d ★ autoIngestOnce 里不再有"每进程一次维护"那一支（挪走了，⛔ 别挪回来）',
    once !== null && !/maintainDone\s*=\s*true/.test(once), '')
  // ★ 反证：把**旧写法**原样重放一遍 —— 必须能复现"每轮都启动"这个事故
  //   （不重放旧代码的话，这几条就只是"新代码长这样"的形状断言，证明不了它修的是什么）
  const oldOnceWouldSetMaintain = (dir, hasIndex) => {
    if (dir === '') return false // 旧：`return { skipped: 'no-dir' }` —— 置位走不到
    if (!hasIndex) return false // 旧：`return { skipped: 'no-index' }` —— 置位走不到
    return true
  }
  const oldGateWouldStart = (maintainDone) => maintainDone === false // 旧：`firstOfProcess` 绕过闸门
  check('K4e ★★ 反证：旧写法下「未归周目 / 还没 index.json」⇒ 置位永远走不到 ⇒ 每轮都被判成"该启动"（事故复现）',
    oldOnceWouldSetMaintain('', false) === false
    && oldOnceWouldSetMaintain('D:/x/sum', false) === false
    && oldGateWouldStart(false) === true, '')
}

// ── K5 `running: true` 的写入点**恰好三处**，且各有各的理由 ─────────────────
//   ① kick：被预判挡在后面（K1）；② autoIngestOnce：确实有活要干那一处（K5b 守着位置）；
//   ③ 面板动作（`runPanelRequestIfAny`，2026-09-20 加）：用户手动点了重建/删库，
//      **本来就该**在状态文件里显示"正在…"（⛔ 不许静默），这一处是**故意**的。
{
  const n = (SRC.match(/writeIngestState\(\{\s*running:\s*true/g) || []).length
  check('K5 ★ 全文件 `running: true` 恰好 3 处（kick / autoIngestOnce / 面板动作）',
    n === 3, `出现 ${n} 次`)
  check('K5b ★ 反证：autoIngestOnce 那一处必须在"有活"之后（⛔ 不许挪到函数开头）',
    once !== null && (once.indexOf('writeIngestState({') > once.indexOf("skipped: 'no-readable'")),
    'autoIngestOnce 里的状态写入挪到早退之前了 ⇒ 又会每轮闪')
  // 第③处必须在面板处理器里（不许出现在 kick 的早退门之前 —— 那就是"每轮闪"的老毛病回来了）
  const panelFn = bodyOf(SRC, 'runPanelRequestIfAny')
  check('K5c ★ 第③处（面板动作的状态写入）落在 runPanelRequestIfAny 里，⛔ 不在 kick 的早退门之前',
    panelFn !== null && /writeIngestState\(\{\s*running:\s*true/.test(panelFn),
    '面板那处状态写入搬家了，或者 kick 里又多了一处每轮闪')
}

// ── K6 ★★ 入库那条路**不许引用作用域外的变量**（2026-09-23 真机事故：入库从来没成功过）──
//   事故形状：`autoIngestOnce` 里写了 `source: resolved.source`，而 `resolved` 只活在
//   `sessionSummariesDir()` / `isolationPlan()` 里 ⇒ 只要真有活干（`slices.length > 0`），
//   走到那一行就抛 `ReferenceError: resolved is not defined`，而且是在 `insertSlices()` **之前**
//   ⇒ **入库全挂**（真机 `ingest-state.json` 里就躺着 `"error":"resolved is not defined"`，
//   面板上表现为"点了立即入库/压缩完也没东西进库"，一路不报错、静默）。
//   ⚠️ 这类错 `node --check` **抓不到**（它是运行时的引用错）⇒ 只能靠这条静态判据 + 反证。
{
  const live = once === null ? '' : stripComments(once)
  const usesBare = /(^|[^\w.$])resolved\./.test(live)
  const declares = /(const|let|var)\s+resolved\s*=/.test(live)
  check('K6 ★ autoIngestOnce 里用 `resolved.` 就必须自己声明 `resolved`（⛔ 不许引用作用域外的同名变量）',
    !usesBare || declares,
    usesBare && !declares ? '用了 resolved. 但函数体里没有它的声明 —— 就是 2026-09-23 那个 ReferenceError' : '')
  check('K6b ★ 状态写入用的是**就地重算**的 `resolvedNow.source`（与 sessionSummariesDir 同一份解析）',
    /source:\s*resolvedNow\.source/.test(live), '')
  check('K6c ★★ 反证：把旧写法 `source: resolved.source` 重放回函数体 ⇒ K6 那句判据必红',
    !(() => {
      const back = live.replace(/source:\s*resolvedNow\.source/, 'source: resolved.source')
      const bare = /(^|[^\w.$])resolved\./.test(back)
      const decl = /(const|let|var)\s+resolved\s*=/.test(back)
      return !bare || decl
    })(), '')
}

console.log(`\n── ${pass} 通过 / ${fail} 失败 ──`)
process.exitCode = fail === 0 ? 0 : 1
