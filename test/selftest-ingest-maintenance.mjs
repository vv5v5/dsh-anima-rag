/**
 * `lib/ingest-maintenance.js` 的行为自检（D12：账本落盘 + 孤儿清理）。
 *
 * 钉住三件真机上出过事的事：
 *   ① 账本**跨进程**有效（否则每次重启整集重灌 —— 真机 49 条/重启）；
 *   ② 判重按**内容签名**（同名但内容变了要重入，没变不许重入）；
 *   ③ 孤儿判定**只认索引**、且清理是**移动不是删除**（可回退）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  entrySignature, createIngestLedger, findOrphanMetadataFiles, quarantineOrphans, LEDGER_FILENAME,
} from '../lib/ingest-maintenance.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'anima-maint-'))

test('① entrySignature：按 sourceHash|chars，缺失也不炸', () => {
  assert.equal(entrySignature({ sourceHash: 'h1', chars: 10 }), 'h1|10')
  assert.equal(entrySignature({ file: 'a.md' }), '|')
  assert.equal(entrySignature(null), '')
  // ★ 内容变了 ⇒ 签名必须变（否则"同名改写"永远不会重入）
  assert.notEqual(entrySignature({ sourceHash: 'h2', chars: 10 }), entrySignature({ sourceHash: 'h1', chars: 10 }))
})

test('② 账本落盘 + 重新加载：文件名 + 签名 才算"入过"', () => {
  const dir = tmp()
  try {
    const p = join(dir, LEDGER_FILENAME)
    const a = createIngestLedger({ path: p })
    assert.equal(a.has('a.md', '|'), false)
    a.mark('a.md', 'h1|10')
    a.mark('b.md', '|')
    assert.ok(a.save(), '有新条目 ⇒ 应落盘')
    assert.ok(existsSync(p))
    // ★ 新实例 = 模拟重启：只能靠文件续上
    const b = createIngestLedger({ path: p })
    assert.equal(b.size, 2)
    assert.equal(b.has('a.md', 'h1|10'), true)
    assert.equal(b.has('a.md', 'h2|10'), false, '★ 内容签名变了就不算入过')
    assert.equal(b.has('c.md', '|'), false)
    // 没变化时不写盘
    assert.equal(b.save(), false, '无变化不该写盘')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('③ prune：不在 keep 里的条目被清掉（账本有界）', () => {
  const dir = tmp()
  try {
    const p = join(dir, LEDGER_FILENAME)
    const a = createIngestLedger({ path: p })
    a.mark('keep.md', '|'); a.mark('gone.md', '|')
    a.save()
    const n = a.prune(new Set(['keep.md']))
    assert.equal(n, 1)
    a.save()
    const b = createIngestLedger({ path: p })
    assert.equal(b.size, 1)
    assert.equal(b.has('keep.md', '|'), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('④ 反证：坏账本/无路径/目录不存在 都不抛（退回内存账本）', () => {
  const dir = tmp()
  try {
    const bad = join(dir, LEDGER_FILENAME)
    writeFileSync(bad, '{这不是 JSON', 'utf8')
    const a = createIngestLedger({ path: bad })
    assert.equal(a.size, 0, '坏文件当空账本')
    a.mark('x.md', '|')
    assert.ok(a.save(), '仍能重建并落盘')
    // 路径的目录还不存在 ⇒ 自动创建（不抛）
    const deep = join(dir, 'no', 'such', 'dir', LEDGER_FILENAME)
    const b = createIngestLedger({ path: deep })
    b.mark('y.md', '|')
    assert.ok(b.save())
    assert.ok(existsSync(deep))
    // 没给路径 ⇒ 全部 no-op，不抛
    const c = createIngestLedger({})
    c.mark('z.md', '|')
    assert.equal(c.save(), false)
    // 落盘不留临时文件
    assert.ok(!readdirSync(dir).some((f) => f.includes('.tmp-')), '不许留 .tmp- 临时文件')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑤ 孤儿判定：只认索引的 metadataFile / id；index.json 永不算孤儿', () => {
  const dir = tmp()
  try {
    const vec = join(dir, 'dsh-memory')
    mkdirSync(vec, { recursive: true })
    const doc = (n) => writeFileSync(join(vec, `${n}.json`), JSON.stringify({ text: 'x', index: n }), 'utf8')
    for (const n of ['aaa', 'bbb', 'ccc', 'ddd']) doc(n)
    writeFileSync(join(vec, 'index.json'), '{}', 'utf8')
    const items = [
      { id: 'aaa', metadataFile: 'aaa.json' },     // 按 metadataFile 引用
      { id: 'bbb' },                                // 只按 id 引用（老 item 没有 metadataFile）
    ]
    const r = findOrphanMetadataFiles({ vectorDir: vec, indexItems: items })
    assert.equal(r.total, 4)
    assert.deepEqual(r.orphans.sort(), ['ccc.json', 'ddd.json'])
    assert.equal(r.kept, 2)
    assert.ok(!r.orphans.includes('index.json'), '⛔ index.json 不许被当孤儿')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑥ 孤儿清理是**移动**不是删除；dryRun 只报不动手', () => {
  const dir = tmp()
  try {
    const vec = join(dir, 'c')
    mkdirSync(vec, { recursive: true })
    writeFileSync(join(vec, 'orphan.json'), '{}', 'utf8')
    // dryRun：一个字节都不动
    const dry = quarantineOrphans({ vectorDir: vec, orphans: ['orphan.json'], dryRun: true })
    assert.equal(dry.moved, 0)
    assert.equal(dry.planned, 1)
    assert.ok(existsSync(join(vec, 'orphan.json')), 'dryRun 不许动文件')
    // 真跑：移进隔离目录（原件不在原地，但**还在**隔离目录里 ⇒ 可回退）
    const res = quarantineOrphans({ vectorDir: vec, orphans: ['orphan.json', '不存在.json'] })
    assert.equal(res.moved, 1)
    assert.equal(res.failed, 1, '不存在的文件计入 failed，但不抛')
    assert.ok(!existsSync(join(vec, 'orphan.json')))
    assert.ok(existsSync(join(res.dir, 'orphan.json')), '★ 移动而非删除 ⇒ 可回退')
    assert.match(readFileSync(join(res.dir, 'orphan.json'), 'utf8'), /^\{\}$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
