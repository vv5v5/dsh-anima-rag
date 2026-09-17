#!/usr/bin/env node
/**
 * ab-compare.mjs — Anima 检索 A/B 对照测试工具
 *
 * 验证「搬进 DSH 的 Anima 检索引擎 (B 侧)」与「SillyTavern 线上原版 anima-rag 插件 (A 侧)」
 * 在同一 payload 下返回结构逐字段一致。只依赖 HTTP 端点契约,Node 22+ 内置能力,零第三方依赖。
 * ST 对 POST 有 CSRF 防护:工具自动 GET /csrf-token 预取 token + Cookie 后再发 /query。
 *
 * 用法:
 *   node test/ab-compare.mjs --probe                                  # 只探 list / bm25/list 两个端点
 *   node test/ab-compare.mjs --payload <payload.json>                 # 只打 A 侧(ST),报告结构
 *   node test/ab-compare.mjs --payload <payload.json> --b <query-url> # A/B 两侧对照 + 逐字段 diff
 *
 * 常用参数:
 *   --payload <file>        payload JSON 文件(不含密钥,密钥走环境变量)
 *   --a <query-url>         A 侧 /query 端点,默认 http://127.0.0.1:9000/api/plugins/anima-rag/query
 *   --b <query-url>         B 侧 /query 端点(提供即进入 A/B 模式)
 *   --session-suffix <s>    B 侧 sessionId 后缀,默认 "-b"(避免两侧回响状态互相污染)
 *   --json <out.json>       把脱敏后的完整响应写文件(单侧 1 个;A/B 模式写出 <out>.a.json / <out>.b.json)
 *   --timeout <ms>          请求超时,默认 60000
 *   --sessions-dir <dir>    零残留守护目录 1(默认 ST 的 data/sessions)
 *   --bm25-dir <dir>        零残留守护目录 2(默认 ST 的 data/bm25_indexes)
 *   --probe                 探测 list / bm25/list,打印条数与名字(预期 12 集合 / 11 BM25 库)
 *
 * 密钥:ANIMA_RAG_EMBED_KEY → payload.apiConfig.key(为空时注入);
 *      ANIMA_RAG_RERANK_KEY → payload.rerankConfig.api.key(为空时注入)。
 *      密钥绝不打印、绝不写盘,报告只给 keySet / keyLen。
 *
 * 退出码:0 正常完成(含「有差异」与 HTTP 4xx/5xx,以报告为准);
 *        1 网络失败(连不上 / 超时);2 用法或 payload 文件错误;
 *        3 零残留还原后仍不一致(数据残留报警)。
 */

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

// ---------- 常量 ----------

const DEFAULT_A_URL = "http://127.0.0.1:9000/api/plugins/anima-rag/query";
const DEFAULT_DATA_ROOT =
    "D:/apps/SillyTavern-Launcher/SillyTavern/plugins/anima-rag/data";
const DEFAULT_SESSIONS_DIR = `${DEFAULT_DATA_ROOT}/sessions`;
const DEFAULT_BM25_DIR = `${DEFAULT_DATA_ROOT}/bm25_indexes`;

// 原版插件 /query 成功响应的顶层键(源码 index.js:3144-3159,实际 7 个)
const EXPECTED_TOP_KEYS = [
    "vector_chat_results",
    "bm25_chat_results",
    "vector_kb_results",
    "bm25_kb_results",
    "_debug_logs",
    "merged_chat_results",
    "merged_kb_results",
];
// 需要报条数的分支(= 全部顶层键)
const COUNT_KEYS = EXPECTED_TOP_KEYS;
// 命中这些字段名的字符串值在 --json 落盘时一律脱敏
const SECRET_FIELD_RE = /^(api_?key|key|token|secret|authorization)$/i;
const PROBE_EXPECT = { list: 12, bm25: 11 };

class CliError extends Error {
    constructor(code, message) {
        super(message);
        this.cliCode = code;
    }
}

// ---------- 小工具 ----------

const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");
const short = (hex) => (hex ? hex.slice(0, 12) : hex);
const textSha116 = (t) =>
    createHash("sha1").update(String(t ?? ""), "utf8").digest("hex").slice(0, 8);
const ts = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

async function pathExists(p) {
    try {
        await fsp.stat(p);
        return true;
    } catch {
        return false;
    }
}

function scoreStr(s) {
    return typeof s === "number" ? s.toFixed(4) : String(s ?? "null");
}

// ---------- 参数解析 ----------

function parseArgs(argv) {
    const args = { a: DEFAULT_A_URL, timeout: 60000, sessionSuffix: "-b" };
    const withValue = new Set([
        "--payload", "--a", "--b", "--json", "--timeout",
        "--session-suffix", "--sessions-dir", "--bm25-dir",
    ]);
    const flags = new Set(["--probe", "--help"]);
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (flags.has(k)) {
            args[k.slice(2)] = true;
        } else if (withValue.has(k)) {
            const v = argv[++i];
            if (v === undefined) throw new CliError(2, `参数 ${k} 缺少值`);
            args[k.slice(2)] = v;
        } else {
            throw new CliError(2, `未知参数: ${k}(--help 查看用法)`);
        }
    }
    const t = Number(args.timeout);
    if (!Number.isFinite(t) || t <= 0)
        throw new CliError(2, `--timeout 需为正整数毫秒,收到: ${args.timeout}`);
    args.timeout = t;
    return args;
}

function usage() {
    console.log(`Anima 检索 A/B 对照测试工具

用法:
  node test/ab-compare.mjs --probe
  node test/ab-compare.mjs --payload <payload.json> [--json <out.json>] [--timeout <ms>]
  node test/ab-compare.mjs --payload <payload.json> --b <query-url> [--session-suffix <suf>]

参数:
  --payload <file>       payload JSON 文件(不含密钥)
  --a <query-url>        A 侧 /query 端点(默认 ${DEFAULT_A_URL})
  --b <query-url>        B 侧 /query 端点,提供即进入 A/B 模式
  --session-suffix <s>   B 侧 sessionId 后缀(默认 -b)
  --json <out.json>      脱敏后的完整响应写文件(A/B 模式写出 .a.json / .b.json)
  --timeout <ms>         单请求超时(默认 60000)
  --sessions-dir <dir>   零残留守护目录 1(默认 ${DEFAULT_SESSIONS_DIR})
  --bm25-dir <dir>       零残留守护目录 2(默认 ${DEFAULT_BM25_DIR})
  --probe                探测 GET /list 与 GET /bm25/list
  --help                 本帮助

环境变量:
  ANIMA_RAG_EMBED_KEY    注入 payload.apiConfig.key(仅当其为空)
  ANIMA_RAG_RERANK_KEY   注入 payload.rerankConfig.api.key(仅当其为空)

退出码: 0 正常(含「有差异」/ HTTP 4xx 5xx,看报告); 1 网络失败; 2 用法/payload 错误; 3 零残留还原失败`);
}

// ---------- 密钥注入与脱敏 ----------

function injectKeys(payload) {
    payload.apiConfig ??= {};
    payload.rerankConfig ??= {};
    payload.rerankConfig.api ??= {};

    const info = {};
    const hadEmbed = !!payload.apiConfig.key;
    if (!hadEmbed && process.env.ANIMA_RAG_EMBED_KEY)
        payload.apiConfig.key = process.env.ANIMA_RAG_EMBED_KEY;
    info.embed = {
        keySet: !!payload.apiConfig.key,
        keyLen: String(payload.apiConfig.key ?? "").length,
        source: hadEmbed ? "payload" : process.env.ANIMA_RAG_EMBED_KEY ? "env" : "无",
    };

    const hadRerank = !!payload.rerankConfig.api.key;
    if (!hadRerank && process.env.ANIMA_RAG_RERANK_KEY)
        payload.rerankConfig.api.key = process.env.ANIMA_RAG_RERANK_KEY;
    info.rerank = {
        keySet: !!payload.rerankConfig.api.key,
        keyLen: String(payload.rerankConfig.api.key ?? "").length,
        source: hadRerank ? "payload" : process.env.ANIMA_RAG_RERANK_KEY ? "env" : "无",
    };
    return info;
}

function printKeyInfo(info) {
    const fmt = (n, x) =>
        `keySet=${x.keySet} keyLen=${x.keyLen} 来源=${x.source}`;
    console.log(
        `[i] 密钥注入: embed(apiConfig.key) ${fmt("embed", info.embed)} | rerank(rerankConfig.api.key) ${fmt("rerank", info.rerank)}(密钥值绝不打印)`,
    );
}

function collectSecrets(payload) {
    const set = new Set();
    for (const v of [
        payload?.apiConfig?.key,
        payload?.rerankConfig?.api?.key,
        process.env.ANIMA_RAG_EMBED_KEY,
        process.env.ANIMA_RAG_RERANK_KEY,
    ])
        if (typeof v === "string" && v) set.add(v);
    return set;
}

/** 深拷贝并对密钥类字段与已知密钥值脱敏(用于 --json 落盘) */
function redact(value, secrets) {
    if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
    if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (
                SECRET_FIELD_RE.test(k) &&
                typeof v === "string" &&
                v
            )
                out[k] = `[REDACTED len=${v.length}]`;
            else out[k] = redact(v, secrets);
        }
        return out;
    }
    if (typeof value === "string" && secrets.has(value))
        return `[REDACTED len=${value.length}]`;
    return value;
}

// ---------- 零残留:快照 / 还原 / 复验 ----------

/** 递归快照目录:相对路径 → {dir:true} 或 {bytes, sha256} */
async function snapshotDir(root) {
    const map = new Map();
    async function walk(rel) {
        const entries = await fsp.readdir(path.join(root, rel), {
            withFileTypes: true,
        });
        for (const e of entries) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
                map.set(r, { dir: true });
                await walk(r);
            } else if (e.isFile()) {
                const bytes = await fsp.readFile(path.join(root, r));
                map.set(r, { bytes, sha256: sha256hex(bytes) });
            }
        }
    }
    await walk("");
    return map;
}

/**
 * 对照调用前后快照;凡变动/新增/消失,一律恢复到调用前状态,然后整体复验 SHA256。
 * 返回 { ok, table } — table 为逐行打印数据。
 */
async function restoreAndVerify(root, before) {
    const observed = await snapshotDir(root);

    const changed = [], addedFiles = [], addedDirs = [], removedFiles = [], removedDirs = [];
    for (const [rel, b] of before) {
        const o = observed.get(rel);
        if (b.dir) {
            if (!o) removedDirs.push(rel);
        } else if (!o) removedFiles.push(rel);
        else if (!o.dir && o.sha256 !== b.sha256) changed.push(rel);
    }
    for (const [rel, o] of observed) {
        if (!before.has(rel)) (o.dir ? addedDirs : addedFiles).push(rel);
    }

    // 还原到调用前字节
    for (const rel of changed) await fsp.writeFile(path.join(root, rel), before.get(rel).bytes);
    for (const rel of removedFiles) await fsp.writeFile(path.join(root, rel), before.get(rel).bytes);
    for (const rel of removedDirs) await fsp.mkdir(path.join(root, rel), { recursive: true });
    for (const rel of addedFiles) await fsp.rm(path.join(root, rel), { force: true });
    for (const rel of addedDirs) await fsp.rm(path.join(root, rel), { recursive: true, force: true });

    // 复验:再拍一次,必须与调用前逐文件一致
    const after = await snapshotDir(root);
    let ok = after.size === before.size;
    const rows = [];
    for (const [rel, b] of before) {
        const o = observed.get(rel);
        const a = after.get(rel);
        const fileOk = !!a && !a.dir && !b.dir && a.sha256 === b.sha256;
        if (!fileOk) ok = false;
        rows.push({
            rel,
            pre: b.dir ? "(目录)" : short(b.sha256),
            observed: b.dir ? (o ? "(目录)" : "(调用后消失)") : o ? short(o.sha256) : "(调用后消失)",
            status: b.dir
                ? fileOk ? "目录未变动" : "⚠️ 目录异常"
                : fileOk
                    ? (o.sha256 === b.sha256 ? "未变动" : "已还原✓")
                    : `⚠️ 还原后仍不一致(现为 ${a && !a.dir ? short(a.sha256) : "缺失"})`,
        });
    }
    for (const rel of addedFiles) {
        const still = after.has(rel);
        if (still) ok = false;
        rows.push({
            rel,
            pre: "(不存在)",
            observed: short(observed.get(rel)?.sha256),
            status: still ? "⚠️ 新增文件删除失败" : "新增→已删除✓",
        });
    }
    for (const rel of addedDirs) {
        const still = after.has(rel);
        if (still) ok = false;
        rows.push({ rel, pre: "(不存在)", observed: "(目录)", status: still ? "⚠️ 新增目录删除失败" : "新增目录→已删除✓" });
    }
    return { ok, rows };
}

async function runZeroResidue(guards, snapshots) {
    let allOk = true;
    console.log("\n========== 零残留检查 ==========");
    for (let i = 0; i < guards.length; i++) {
        const g = guards[i];
        const snap = snapshots[i];
        console.log(`\n--- 守护目录 [${g.label}] ${g.dir} ---`);
        if (!snap) {
            console.log("[!] 调用前目录不存在,未守护(不参与零残留结论)");
            continue;
        }
        const { ok, rows } = await restoreAndVerify(g.dir, snap.map);
        const dirty = rows.filter((r) => r.status !== "未变动" && r.status !== "目录未变动");
        console.log(
            `快照 ${snap.map.size} 项;调用后观测: 变动/新增/消失 ${dirty.length} 项;已全部按调用前字节还原并复验。`,
        );
        console.log("文件 | 调用前SHA256 | 调用后SHA256(观测) | 处置");
        for (const r of rows) console.log(`${r.rel} | ${r.pre} | ${r.observed} | ${r.status}`);
        if (ok) console.log("结论: ✓ 该目录零残留确认通过(SHA256 复验一致)");
        else console.log("结论: ⚠️⚠️ 该目录还原后仍与调用前不一致!");
        allOk &&= ok;
    }
    if (!allOk) {
        console.log("\n🚨🚨 零残留复验失败:线上数据目录与调用前不一致,请立即人工检查上述文件!🚨🚨");
        process.exitCode = 3;
    } else {
        console.log("\n✅ 零残留总结论: 所有守护目录已还原并与调用前逐字节一致。");
    }
}

// ---------- HTTP ----------

/**
 * SillyTavern 对 POST 有 CSRF 防护:需先 GET <origin>/csrf-token 拿 token,
 * 并带上其下发的 session Cookie 与 X-CSRF-Token 头。
 * B 侧(DSH)若没有 /csrf-token,预取失败即退回无 CSRF 直连。
 */
async function primeCsrf(queryUrl, timeoutMs) {
    try {
        const { origin } = new URL(queryUrl);
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), timeoutMs);
        let res;
        try {
            res = await fetch(`${origin}/csrf-token`, { signal: ctrl.signal });
        } finally {
            clearTimeout(tid);
        }
        if (!res.ok) return { headers: {}, note: `GET /csrf-token → HTTP ${res.status},按无 CSRF 直连` };
        const token = JSON.parse(await res.text())?.token;
        const cookie = (res.headers.getSetCookie?.() ?? [])
            .map((c) => c.split(";")[0])
            .join("; ");
        if (!token) return { headers: {}, note: "GET /csrf-token 未返回 token,按无 CSRF 直连" };
        return {
            headers: { ...(cookie ? { Cookie: cookie } : {}), "X-CSRF-Token": token },
            note: "已自动获取 CSRF token(附带 Cookie / X-CSRF-Token)",
        };
    } catch {
        return { headers: {}, note: "无 /csrf-token 端点,按无 CSRF 直连" };
    }
}

async function callQuery(url, payload, timeoutMs) {
    const csrf = await primeCsrf(url, timeoutMs);
    console.log(`[i] CSRF: ${csrf.note}`);
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = performance.now();
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...csrf.headers },
            body: JSON.stringify(payload),
            signal: ctrl.signal,
        });
        const ms = Math.round(performance.now() - t0);
        const text = await res.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch { /* 非 JSON,保留 text */ }
        return { url, status: res.status, ok: res.ok, ms, text, json };
    } catch (e) {
        const ms = Math.round(performance.now() - t0);
        const reason =
            e?.name === "AbortError"
                ? `请求超时(${timeoutMs}ms)`
                : `${e?.message ?? e}${e?.cause?.code ? ` (${e.cause.code})` : ""}`;
        return { url, status: 0, ok: false, ms, text: "", json: null, error: reason };
    } finally {
        clearTimeout(tid);
    }
}

async function getJson(url, timeoutMs) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = performance.now();
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        const ms = Math.round(performance.now() - t0);
        return { status: res.status, ok: res.ok, ms, text: await res.text() };
    } catch (e) {
        return {
            status: 0,
            ok: false,
            ms: Math.round(performance.now() - t0),
            text: "",
            error: e?.name === "AbortError" ? `请求超时(${timeoutMs}ms)` : `${e?.message ?? e}${e?.cause?.code ? ` (${e.cause.code})` : ""}`,
        };
    } finally {
        clearTimeout(tid);
    }
}

// ---------- 单侧报告 ----------

function fingerprintLine(i, e) {
    const t = typeof e?.text === "string" ? e.text : "";
    return `#${i} | index=${e?.index ?? "null"} | type=${e?.type ?? "null"} | score=${scoreStr(e?.score)} | is_echo=${!!e?.is_echo} | text长度=${t.length} | text_sha1前8=${textSha116(t)}`;
}

function printSide(label, r) {
    console.log(`\n===== ${label} 侧: POST ${r.url} =====`);
    console.log(`HTTP 状态: ${r.status || "(未建立连接)"} | 耗时: ${r.ms}ms`);
    if (r.error) {
        console.log(`请求失败: ${r.error}`);
        return;
    }
    if (!r.ok) console.log(`[!] 非 2xx。响应正文前 500 字:\n${r.text.slice(0, 500)}`);
    if (!r.json) {
        console.log("[!] 响应不是合法 JSON,无结构可报。");
        return;
    }
    const keys = Object.keys(r.json);
    console.log(`顶层键(${keys.length}): ${keys.join(", ")}`);
    const missing = EXPECTED_TOP_KEYS.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !EXPECTED_TOP_KEYS.includes(k));
    if (missing.length) console.log(`  [!] 与预期键集差异 → 缺少: ${missing.join(", ")}`);
    if (extra.length) console.log(`  [!] 与预期键集差异 → 多出: ${extra.join(", ")}`);
    console.log("分支条数:");
    for (const k of COUNT_KEYS) {
        const v = r.json[k];
        const n = Array.isArray(v) ? `${v.length} 条` : Array.isArray(v) ? "0 条" : String(v === undefined ? "(无此键)" : typeof v);
        console.log(`  ${k}: ${n}`);
    }
    for (const name of ["merged_chat_results", "merged_kb_results"]) {
        const list = r.json[name];
        if (!Array.isArray(list)) continue;
        console.log(`${name} 逐条指纹:`);
        if (list.length === 0) console.log("  (空)");
        list.forEach((e, i) => console.log(`  ${fingerprintLine(i, e)}`));
    }
}

// ---------- A/B diff ----------

function groupByIndex(list) {
    const m = new Map();
    for (const e of list) {
        const k = String(e?.index ?? "null");
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(e);
    }
    return m;
}

/** 按 index 对齐比较一个 merged 分支;返回 diff 行数 */
function compareMerged(name, jsonA, jsonB, emit) {
    const listA = Array.isArray(jsonA?.[name]) ? jsonA[name] : null;
    const listB = Array.isArray(jsonB?.[name]) ? jsonB[name] : null;
    console.log(`\n[${name}] 按 index 对齐:`);
    if (!listA || !listB) {
        console.log(`  ✗ 至少一侧无此分支数组(A=${listA ? "有" : "无"}, B=${listB ? "有" : "无"}),无法比对`);
        return 1;
    }
    let diffs = 0;
    const ga = groupByIndex(listA), gb = groupByIndex(listB);
    const pairs = [], onlyA = [], onlyB = [];
    for (const [k, la] of ga) {
        const lb = gb.get(k) ?? [];
        const n = Math.min(la.length, lb.length);
        for (let i = 0; i < n; i++) pairs.push([la[i], lb[i]]);
        for (let i = n; i < la.length; i++) onlyA.push(la[i]);
    }
    for (const [k, lb] of gb) {
        const la = ga.get(k) ?? [];
        for (let i = la.length; i < lb.length; i++) onlyB.push(lb[i]);
    }
    if (onlyA.length) {
        diffs += onlyA.length;
        console.log(`  ✗ 仅 A 侧 ${onlyA.length} 条: ${onlyA.map((e) => `index=${e?.index}(${(e?.text ?? "").slice(0, 20)}…sha1=${textSha116(e?.text)})`).join("; ")}`);
    }
    if (onlyB.length) {
        diffs += onlyB.length;
        console.log(`  ✗ 仅 B 侧 ${onlyB.length} 条: ${onlyB.map((e) => `index=${e?.index}(${(e?.text ?? "").slice(0, 20)}…sha1=${textSha116(e?.text)})`).join("; ")}`);
    }
    for (const [a, b] of pairs) {
        const problems = [];
        if (typeof a?.score === "number" && typeof b?.score === "number") {
            const d = a.score - b.score;
            if (d !== 0)
                problems.push(`score 不同: A=${a.score.toFixed(4)} B=${b.score.toFixed(4)} (A-B=${(d >= 0 ? "+" : "") + (Math.abs(d) < 5e-5 ? d.toFixed(8) : d.toFixed(4))})`);
        } else if (scoreStr(a?.score) !== scoreStr(b?.score)) {
            problems.push(`score 不同: A=${scoreStr(a?.score)} B=${scoreStr(b?.score)}`);
        }
        if ((a?.type ?? null) !== (b?.type ?? null))
            problems.push(`type 不同: A=${a?.type ?? "null"} B=${b?.type ?? "null"}`);
        if (!!a?.is_echo !== !!b?.is_echo)
            problems.push(`is_echo 不同: A=${!!a?.is_echo} B=${!!b?.is_echo}`);
        if (textSha116(a?.text) !== textSha116(b?.text))
            problems.push(`text 内容不同: sha1 A=${textSha116(a?.text)} B=${textSha116(b?.text)}`);
        if (problems.length) {
            diffs += problems.length;
            console.log(`  ✗ index=${a?.index}: ${problems.join("; ")}`);
        }
    }
    if (diffs === 0)
        console.log(`  ✓ ${pairs.length} 对(index 对齐)逐项一致: score / type / is_echo / text 均相同`);
    return diffs;
}

function printDiff(ra, rb) {
    console.log("\n========== A/B 逐字段 diff ==========");
    let total = 0;
    if (!ra.json || !rb.json) {
        console.log(`✗ 无法逐字段 diff: ${!ra.json ? "A" : ""}${!ra.json && !rb.json ? " 与 " : ""}${!rb.json ? "B" : ""} 侧无 JSON 响应(见上方报告)。`);
        console.log("总结: 有差异(两侧响应结构不可比)");
        return;
    }
    const keysA = new Set(Object.keys(ra.json));
    const keysB = new Set(Object.keys(rb.json));
    const onlyA = [...keysA].filter((k) => !keysB.has(k));
    const onlyB = [...keysB].filter((k) => !keysA.has(k));
    if (onlyA.length || onlyB.length) {
        total += onlyA.length + onlyB.length;
        if (onlyA.length) console.log(`[顶层键] ✗ 仅 A 侧有: ${onlyA.join(", ")}`);
        if (onlyB.length) console.log(`[顶层键] ✗ 仅 B 侧有: ${onlyB.join(", ")}`);
    } else {
        console.log(`[顶层键] ✓ 一致(${keysA.size} 个): ${[...keysA].join(", ")}`);
    }
    console.log("[分支条数]");
    for (const k of COUNT_KEYS) {
        const va = ra.json[k], vb = rb.json[k];
        const na = Array.isArray(va) ? va.length : "(非数组)";
        const nb = Array.isArray(vb) ? vb.length : "(非数组)";
        if (na === nb) console.log(`  ${k}: A=${na} B=${nb} ✓`);
        else {
            total++;
            console.log(`  ${k}: A=${na} B=${nb} ✗`);
        }
    }
    total += compareMerged("merged_chat_results", ra.json, rb.json, console.log);
    total += compareMerged("merged_kb_results", ra.json, rb.json, console.log);
    console.log(`\n总结: ${total === 0 ? "一致 ✓" : `有差异(${total} 处) ✗`}`);
}

// ---------- --json 落盘 ----------

async function writeJsonOut(outPath, ra, rb, secrets, isAB) {
    const wrap = (r) =>
        r.json !== null
            ? redact(r.json, secrets)
            : { _ab_compare_note: "非 JSON 响应", http_status: r.status, body_head_500: r.text.slice(0, 500) };
    const files = [];
    if (isAB) {
        const stem = outPath.replace(/\.json$/i, "");
        const fa = `${stem}.a.json`, fb = `${stem}.b.json`;
        await fsp.writeFile(fa, JSON.stringify(wrap(ra), null, 2));
        await fsp.writeFile(fb, JSON.stringify(wrap(rb), null, 2));
        files.push(fa, fb);
    } else {
        await fsp.writeFile(outPath, JSON.stringify(wrap(ra), null, 2));
        files.push(outPath);
    }
    console.log(`[i] --json 已写出(密钥已脱敏): ${files.join(" , ")}`);
}

// ---------- --probe ----------

async function runProbe(args) {
    const base = args.a.replace(/\/+$/, "").replace(/\/query$/, "");
    let fail = false;
    const targets = [
        ["集合列表 GET /list", "/list", PROBE_EXPECT.list],
        ["BM25 库列表 GET /bm25/list", "/bm25/list", PROBE_EXPECT.bm25],
    ];
    for (const [label, suffix, expect] of targets) {
        const url = base + suffix;
        console.log(`\n--- ${label} ---`);
        console.log(`GET ${url}`);
        const r = await getJson(url, args.timeout);
        console.log(`HTTP ${r.status || "(未建立连接)"} | ${r.ms}ms`);
        if (r.error) {
            console.log(`请求失败: ${r.error}`);
            fail = true;
            continue;
        }
        let j = null;
        try {
            j = JSON.parse(r.text);
        } catch { /* fallthrough */ }
        if (!Array.isArray(j)) {
            console.log(`[!] 响应不是 JSON 数组: ${r.text.slice(0, 300)}`);
            fail = true;
            continue;
        }
        console.log(`共 ${j.length} 项(预期 ${expect}): ${j.length === expect ? "✓ 符合" : "✗ 不符合"}`);
        j.forEach((n, i) => console.log(`  ${String(i + 1).padStart(2)}. ${n}`));
    }
    if (fail) process.exitCode = 1;
}

// ---------- 主流程 ----------

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        usage();
        return;
    }
    if (args.probe) {
        if (args.payload) console.log("[i] 同时给了 --probe 与 --payload,本次只执行 --probe。");
        await runProbe(args);
        return;
    }
    if (!args.payload) {
        usage();
        throw new CliError(2, "缺少 --payload(或 --probe)");
    }

    // 1) 载入 payload
    let raw;
    try {
        raw = await fsp.readFile(args.payload, "utf8");
    } catch (e) {
        throw new CliError(2, `payload 文件不存在或不可读: ${args.payload}(${e.message})`);
    }
    let payload;
    try {
        payload = JSON.parse(raw);
    } catch (e) {
        throw new CliError(2, `payload JSON 解析失败: ${e.message}`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new CliError(2, "payload 顶层必须是 JSON 对象");

    // 2) 密钥注入(绝不打印值)
    const keyInfo = injectKeys(payload);
    printKeyInfo(keyInfo);

    // 3) sessionId:同一 payload 打两侧,但 sessionId 必须区分,否则回响状态互相污染
    if (!payload.sessionId) {
        payload.sessionId = `ab-compare-${ts()}`;
        console.log(`[i] payload 未带 sessionId,临时设为 "${payload.sessionId}"(仅作用于本次请求)。`);
    }
    const payloadB = args.b ? structuredClone(payload) : null;
    if (payloadB) payloadB.sessionId = payload.sessionId + args.sessionSuffix;
    console.log(`[i] sessionId: A="${payload.sessionId}"${payloadB ? ` B="${payloadB.sessionId}"` : ""}`);

    // 4) 零残留快照(调用前)
    const guards = [
        { label: "sessions", dir: args["sessions-dir"] || DEFAULT_SESSIONS_DIR },
        { label: "bm25_indexes", dir: args["bm25-dir"] || DEFAULT_BM25_DIR },
    ];
    const snapshots = [];
    console.log("\n========== 调用前快照 ==========");
    for (const g of guards) {
        if (!(await pathExists(g.dir))) {
            console.log(`[!] 零残留: 目录不存在,跳过守护 [${g.label}] ${g.dir}`);
            snapshots.push(null);
            continue;
        }
        const map = await snapshotDir(g.dir);
        snapshots.push({ map });
        console.log(`[${g.label}] ${g.dir} → ${map.size} 项已读入内存(含 SHA256)`);
    }

    // 5) 发请求 + 报告(无论成败,退出前必走还原)
    let ra, rb;
    try {
        console.log("\n========== 请求与报告 ==========");
        ra = await callQuery(args.a, payload, args.timeout);
        printSide("A(默认原版 ST)", ra);
        if (args.b) {
            rb = await callQuery(args.b, payloadB, args.timeout);
            printSide(`B(sessionId 后缀 "${args.sessionSuffix}")`, rb);
            printDiff(ra, rb);
        }
        if (args.json)
            await writeJsonOut(args.json, ra, rb, collectSecrets(payload), !!args.b);
    } finally {
        await runZeroResidue(guards, snapshots);
    }

    // 6) 退出码:还原失败已在上面置 3;网络失败置 1;HTTP 4xx/5xx 属于"测到了",保持 0
    const networkFail = ra?.error || (args.b && rb?.error);
    if (networkFail && process.exitCode !== 3) {
        process.exitCode = 1;
        console.log("\n[!] 存在网络层失败(连不上/超时),exit code = 1。");
    }
}

main().catch((e) => {
    if (e instanceof CliError) {
        console.error(`错误: ${e.message}`);
        process.exitCode = e.cliCode;
    } else {
        console.error(`未预期错误: ${e?.stack ?? e}`);
        process.exitCode = 1;
    }
});
