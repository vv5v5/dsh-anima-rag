/**
 * 入库维护 —— 让"向量库自己维护"真的成立（2026-09-17，D12）。
 *
 * ## 为什么需要这个文件
 * 原来的自动入库有两个**只在真机上才看得出来**的缺陷：
 *
 * 1. **账本只存在内存**（`lib/index.js` 的 `ingestedFiles` / `lastIngestMtime`）⇒
 *    每次重启宿主账本清零 ⇒ **整集重灌**（真机 49 条 = 重启一次 49 次 embedding）；
 *    embedding 一挂就变成持续风暴。⇒ 本文件把账本**落盘**（键 = 文件名 + 内容签名）。
 * 2. **孤儿元数据文件**：引擎的"覆盖同名"清理只删它**当轮认识**的那些文件
 *    （老 item 没有 `metadataFile` ⇒ 文件留下）。真机实测：`vectors/dsh-memory/`
 *    目录里 654 个 `.json`，而 `index.json` 只引用 62 个 ⇒ **592 个孤儿（占 90%）**，
 *    纯占盘（检索走索引，看不到它们）。⇒ 本文件提供**可干跑**的孤儿清理，
 *    默认**移进 `_quarantine/` 而不是直接删**（可回退）。
 *
 * ## 纪律
 * · 账本写盘 = 临时文件 + rename（原子）；坏文件当空账本，绝不抛。
 * · 孤儿判定**只认索引**：`index.json` 的 `items[].metadataFile`（文件名）与
 *   `items[].id`（uuid）都算"被引用"；`index.json` 自己永不删。
 * · ⛔ 不碰 `index.json`、不碰任何集合外的文件。
 *
 * @module dsh-anima-rag/ingest-maintenance
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const INGEST_MAINTENANCE_VERSION = 1

/** 账本文件名（放在 `<DSH_HOME>/dsh-anima-rag/` 下）。 */
export const LEDGER_FILENAME = 'ingest-ledger.json'

/** 一条摘要切片的"内容签名"：文件变了就得重入，没变就不重入。 */
export function entrySignature(entry) {
  if (!entry || typeof entry !== 'object') return ''
  const hash = String(entry.sourceHash ?? '')
  const chars = String(entry.chars ?? '')
  return `${hash}|${chars}`
}

/**
 * 落盘账本：`{version, updatedAt, entries:{[file]: {sig, at}}}`。
 * 任何 I/O 失败都降级为"内存账本"（退回旧行为），⛔ 绝不抛。
 */
export function createIngestLedger({ path, logger = null, maxEntries = 5000 } = {}) {
  let entries = new Map()
  let loaded = false
  let dirty = false
  const warn = (m) => { try { logger?.warn?.(m) } catch {} }

  function load() {
    if (loaded) return
    loaded = true
    if (!path || !existsSync(path)) return
    try {
      const j = JSON.parse(readFileSync(path, 'utf8'))
      const raw = j && typeof j.entries === 'object' && j.entries !== null ? j.entries : {}
      for (const [k, v] of Object.entries(raw)) {
        if (typeof k === 'string' && k !== '' && v && typeof v === 'object') {
          entries.set(k, { sig: String(v.sig ?? ''), at: Number(v.at) || 0 })
        }
      }
    } catch (e) {
      warn(`[Anima] 入库账本读取失败（当空账本继续）：${e?.message ?? e}`)
      entries = new Map()
    }
  }

  return {
    load,
    get size() { load(); return entries.size },
    /** 该文件、该内容签名是否已入过。 */
    has(file, sig) {
      load()
      const hit = entries.get(String(file))
      return hit !== undefined && hit.sig === String(sig)
    },
    /** 记一笔（不落盘；落盘走 save）。 */
    mark(file, sig) {
      load()
      const k = String(file)
      const prev = entries.get(k)
      const at = Date.now()
      if (prev !== undefined && prev.sig === String(sig)) return
      entries.set(k, { sig: String(sig), at })
      dirty = true
    },
    /** 删掉**不在** keep 集合里的条目（有界；防止账本无限长）。 */
    prune(keep) {
      load()
      if (!(keep instanceof Set)) return 0
      let n = 0
      for (const k of [...entries.keys()]) if (!keep.has(k)) { entries.delete(k); n += 1 }
      if (n > 0) dirty = true
      return n
    },
    /**
     * 忘掉若干文件名的"已入过"记号（**面板重建/删除 用的那条路**）。
     *
     * 为什么必须有：账本是"文件名 + 内容签名"的门。面板要把某个集合**重建**（向量/BM25 一起）
     * 或者**删掉**再让它重长，第一件事就是让这些条目重新变成"没入过"——
     * 否则下次入库会以 `all-done` 直接跳过，删掉的东西永远回不来。
     * @param {Iterable<string>} files - 要忘掉的文件名；非数组/空 ⇒ 什么都不做。
     * @returns {number} 真忘掉了几条。
     */
    forget(files) {
      load()
      if (files === null || files === undefined || typeof files === 'string') return 0
      let n = 0
      for (const f of files) {
        const k = String(f)
        if (entries.delete(k)) n += 1
      }
      if (n > 0) dirty = true
      return n
    },
    /** 清空整本账本（面板"全部重建"用）。返回清掉几条。 */
    clear() {
      load()
      const n = entries.size
      entries = new Map()
      if (n > 0) dirty = true
      return n
    },
    /** 账本里的文件名快照（只读；面板/诊断用）。 */
    files() {
      load()
      return [...entries.keys()]
    },

    /** 原子落盘。没变化时不写。返回是否写了。 */
    save({ force = false } = {}) {
      load()
      if (path === '' || path == null) return false
      if (!dirty && !force) return false
      try {
        if (entries.size > maxEntries) {
          const sorted = [...entries.entries()].sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, maxEntries)
          entries = new Map(sorted)
        }
        const dir = path.replace(/[\\/][^\\/]*$/, '')
        if (dir !== '' && !existsSync(dir)) mkdirSync(dir, { recursive: true })
        const body = JSON.stringify({
          version: INGEST_MAINTENANCE_VERSION,
          updatedAt: new Date().toISOString(),
          entries: Object.fromEntries(entries),
        })
        const tmp = `${path}.tmp-${process.pid}`
        writeFileSync(tmp, body, 'utf8')
        renameSync(tmp, path)
        dirty = false
        return true
      } catch (e) {
        warn(`[Anima] 入库账本落盘失败（下次再说，不影响入库）：${e?.message ?? e}`)
        return false
      }
    },
  }
}

/**
 * 找出**索引没引用**的元数据文件（孤儿）。
 * "被引用" = `items[].metadataFile`（文件名）或 `items[].id`（uuid）命中；
 * `index.json` 自己不算孤儿。⛔ 只读，不删。
 *
 * @returns {{orphans:string[], kept:number, total:number, referenced:number}}
 */
export function findOrphanMetadataFiles({ vectorDir, indexItems } = {}) {
  const items = Array.isArray(indexItems) ? indexItems : []
  const referenced = new Set()
  for (const it of items) {
    const mf = it?.metadataFile
    if (typeof mf === 'string' && mf !== '') referenced.add(mf)
    const id = it?.id
    if (typeof id === 'string' && id !== '') referenced.add(`${id}.json`)
  }
  let names = []
  try { names = readdirSync(vectorDir) } catch { return { orphans: [], kept: 0, total: 0, referenced: referenced.size } }
  const files = names.filter((n) => n.endsWith('.json') && n !== 'index.json')
  const orphans = files.filter((n) => !referenced.has(n))
  return { orphans, kept: files.length - orphans.length, total: files.length, referenced: referenced.size }
}

/**
 * 把孤儿**移进** `<vectorDir>/_quarantine-<stamp>/`（移动而不是删除 ⇒ 可回退）。
 * 返回 `{moved, failed, dir}`。⛔ 任何失败只记账不抛。
 */
export function quarantineOrphans({ vectorDir, orphans, stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19), dryRun = false } = {}) {
  const list = Array.isArray(orphans) ? orphans : []
  if (list.length === 0) return { moved: 0, failed: 0, dir: null }
  const dir = join(vectorDir, `_quarantine-${stamp}`)
  if (dryRun) return { moved: 0, failed: 0, dir, planned: list.length }
  let moved = 0, failed = 0
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch { return { moved: 0, failed: list.length, dir } }
  for (const name of list) {
    try {
      const from = join(vectorDir, name)
      if (!existsSync(from) || !statSync(from).isFile()) { failed += 1; continue }
      renameSync(from, join(dir, name))
      moved += 1
    } catch { failed += 1 }
  }
  return { moved, failed, dir }
}

export default {
  INGEST_MAINTENANCE_VERSION, LEDGER_FILENAME,
  entrySignature, createIngestLedger, findOrphanMetadataFiles, quarantineOrphans,
}
