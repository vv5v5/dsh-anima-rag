/**
 * engine 自测（零安装、零 API key、对线上数据零写入）。
 *
 * 跑法：node test/selftest-engine.mjs
 *
 * - 被测对象：lib/engine.js（createEngine），echoPersist:false（回响照算、存盘 no-op）；
 * - 真实数据：ST anima-rag 插件的 vectors(12) / data/sessions(14) / data/bm25_indexes(11)，**只读**；
 * - 断言跑完前后 data/bm25_indexes 与 data/sessions 的 文件数 + mtime + SHA256 逐文件未变；
 * - 依赖解析：createRequire('D:/apps/SillyTavern-Launcher/SillyTavern/plugins/anima-rag/node_modules/')，
 *   不装任何包；
 * - 密钥：全程不使用、不打印任何 API key。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { createEngine } from "../lib/engine.js";
import { createBm25 } from "../lib/bm25.js";

const PLUGIN_ROOT =
    "D:/apps/SillyTavern-Launcher/SillyTavern/plugins/anima-rag";
const VECTOR_ROOT = join(PLUGIN_ROOT, "vectors");
const SESSION_ROOT = join(PLUGIN_ROOT, "data", "sessions");
const BM25_ROOT = join(PLUGIN_ROOT, "data", "bm25_indexes");
const DEPS_BASE = `${PLUGIN_ROOT}/node_modules/`; // 任务指定的 createRequire 基址

let failures = 0;
function check(label, cond, detail = "") {
    const tag = cond ? "PASS" : "FAIL";
    console.log(`  [${tag}] ${label}${detail ? ` —— ${detail}` : ""}`);
    if (!cond) failures++;
}

/** 目录快照：文件名 → { size, mtimeMs, sha256 } */
function snapshot(dir) {
    const out = new Map();
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (!st.isFile()) continue;
        out.set(name, {
            size: st.size,
            mtimeMs: st.mtimeMs,
            sha256: createHash("sha256")
                .update(readFileSync(p))
                .digest("hex"),
        });
    }
    return out;
}

function compareSnapshots(before, after, label) {
    let ok = true;
    const names = [...before.keys()].sort();
    if (names.length !== after.size) {
        ok = false;
        console.log(`  !! ${label}: 文件数变化 ${names.length} -> ${after.size}`);
    }
    let unchanged = 0;
    for (const name of names) {
        const b = before.get(name);
        const a = after.get(name);
        if (!a) {
            ok = false;
            console.log(`  !! ${label}/${name}: 文件消失`);
            continue;
        }
        const same =
            b.size === a.size &&
            b.mtimeMs === a.mtimeMs &&
            b.sha256 === a.sha256;
        if (!same) {
            ok = false;
            console.log(`  !! ${label}/${name}: 发生了写入！`);
            console.log(`     before: size=${b.size} mtime=${b.mtimeMs} sha=${b.sha256.slice(0, 12)}…`);
            console.log(`     after : size=${a.size} mtime=${a.mtimeMs} sha=${a.sha256.slice(0, 12)}…`);
        } else {
            unchanged++;
        }
    }
    console.log(`  (${label}: ${unchanged}/${names.length} 个文件逐项未变)`);
    return ok;
}

// ========== [1] 选一个**真实**集合当被测库 + 装桩 fetch + 创建引擎 ==========
console.log("== [1] 快照 + 选真库 + createEngine({ vectorRoot, sessionRoot, echoPersist:false, fetchImpl }) ==");
const before = {
    bm25: snapshot(BM25_ROOT),
    sessions: snapshot(SESSION_ROOT),
};
console.log(
    `  快照完成：bm25_indexes ${before.bm25.size} 个文件，sessions ${before.sessions.size} 个文件`,
);

const vecCollections = readdirSync(VECTOR_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name);
check("真机有集合可测（≥ 12 个）", vecCollections.length >= 12, `实际 ${vecCollections.length}`);

/**
 * 找一台"有切片、且第一条带向量"的真集合，把它的第一条向量当**查询向量**。
 * ★ 为什么这么干：查询向量 = 库里某条真向量 ⇒ 余弦 1.0，必然命中（且命中的是**真数据**）。
 *   桩 fetch 只负责把这条向量按 OpenAI 形状还回去，其余链路全是真代码。
 */
let picked = null;
let gapNote = null;   // 真机数据缺口：如实记一句，⛔ 不当失败
for (const name of vecCollections) {
    let idx = null;
    try { idx = JSON.parse(readFileSync(join(VECTOR_ROOT, name, "index.json"), "utf8")); } catch { continue; }
    const items = Array.isArray(idx?.items) ? idx.items : [];
    if (items.length === 0) continue;
    // ⚠️ 真机实测（2026-09-26）：`dsh-memory` 的 `index.json` 里列着 12 条，但磁盘上只有 6 个
    //    per-item 元数据文件。**vectra 查询时要读那几条元数据** —— 读不到就 ENOENT，
    //    整个 queryMultiIndices 崩掉、返回 0 条（那几条切片**永远召不回**）。
    //    ⇒ 本测只挑**元数据齐全**的集合；不齐的那个如实记一句就跳过（那是数据缺口，
    //      不是引擎/本次退役的问题 —— 退役前也一样）。
    const usable = items.filter((it) =>
        Array.isArray(it?.vector) && it.vector.length > 0 &&
        typeof it?.metadataFile === "string" && it.metadataFile !== "" &&
        existsSync(join(VECTOR_ROOT, name, it.metadataFile)));
    if (usable.length < items.length) {
        gapNote = gapNote ?? { name, items: items.length, ok: usable.length };
        continue;
    }
    picked = {
        collection: name,
        vector: usable[0].vector,
        dim: usable[0].vector.length,
        index: usable[0].metadata?.index ?? "(无 index)",
        items: items.length,
    };
    break;
}
if (picked === null) {
    console.log("\n===== SELFTEST FAIL：真机里找不到「元数据齐全、有向量的集合」，无法真跑向量路径 =====");
    process.exit(1);
}
if (gapNote !== null) {
    console.log(`  [i] 真机数据缺口（如实记，⛔ 不是本次退役引入的）：「${gapNote.name}」索引里 ${gapNote.items} 条，`
        + `只有 ${gapNote.ok} 条的 per-item 元数据文件在盘上 —— vectra 查询要读它，读不到就 ENOENT ⇒ 那几条召不回。`);
}
console.log(`  ★ 被测真库「${picked.collection}」：${picked.items} 条（元数据齐全）· 维度 ${picked.dim}`);
console.log(`     取第一条的向量当查询向量（index=${picked.index}）`);

/** 桩 fetch：只认 `/embeddings`，按 OpenAI 形状返回上面那条真向量；别的一律报错（⛔ 不静默）。 */
let embedCalls = 0;
const stubFetch = async (url, init) => {
    const u = String(url);
    if (!u.endsWith("/embeddings")) {
        return { ok: false, status: 404, text: async () => `stub-fetch: 不认的端点 ${u}`, json: async () => ({ error: { message: "stub 404" } }) };
    }
    embedCalls += 1;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (typeof body?.input !== "string" || body.input === "") {
        return { ok: false, status: 400, text: async () => "stub: input 空", json: async () => ({ error: { message: "input missing" } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: [{ embedding: picked.vector }] }) };
};

const engine = createEngine({
    vectorRoot: VECTOR_ROOT,
    sessionRoot: SESSION_ROOT,
    bm25Root: BM25_ROOT,
    echoPersist: false, // 回响照常计算，落盘变 no-op
    bm25Persist: false, // BM25 同样只读（查询路径本就不写盘，双保险）
    depsBase: DEPS_BASE,
    fetchImpl: stubFetch, // 向量那一路的嵌入用桩（返回真向量，零联网）；BM25 不需要它
    logger: console,
});
console.log("  createEngine 完成（vectra/minisearch/jieba 均经 DEPS_BASE 解析，未装包）");

// ========== [2] listCollections / listBm25 ==========
console.log("\n== [2] listCollections() / listBm25() ==");
const collections = engine.listCollections();
const libs = engine.listBm25();
console.log(`  listCollections(): ${collections.length} 个 → ${JSON.stringify(collections)}`);
console.log(`  listBm25():        ${libs.length} 个 → ${JSON.stringify(libs)}`);
// ★ 2026-09-16 改：根目录里多了我们自己的 `dsh-memory`（T2 写入口的落点）⇒ 不写死个数。
check("listCollections() 至少 12 个集合", collections.length >= 12, `实际 ${collections.length}`);
check("listBm25() 至少 11 个库", libs.length >= 11, `实际 ${libs.length}`);

// ========== [3] 从真实 BM25 库推导「真中文触发词 + 真实 index」 ==========
console.log("\n== [3] 从线上 BM25 库推导词典触发词与真实 index（只读） ==");
const deriver = createBm25({ bm25Root: BM25_ROOT, persist: false, depsBase: DEPS_BASE });
let chosen = null; // { lib, term, sliceIndex }
for (const lib of libs) {
    const inst = deriver.load(lib);
    if (!inst) continue;
    const json = inst.toJSON();
    const terms = (json.index || []).map((e) => e[0]);
    const cjkTerms = terms.filter((t) => /^[\u4e00-\u9fa5]+$/.test(t) && t.length >= 2);
    if (cjkTerms.length === 0) continue;
    const term = cjkTerms.reduce((m, t) => (t.length > m.length ? t : m), "");
    const stored = Object.values(json.storedFields || {});
    // 优先取 text 里真的含该词的切片的 index（形如 1_1），否则取第一个切片的 index
    const hitDoc = stored.find((d) => typeof d.text === "string" && d.text.includes(term));
    const sliceIndex = hitDoc?.index ?? stored[0]?.index;
    if (term && sliceIndex) {
        chosen = { lib, term, sliceIndex: String(sliceIndex) };
        break;
    }
}
check("推导出 触发词/库名/真实index", !!chosen, chosen ? JSON.stringify(chosen) : "无可用库");
if (!chosen) {
    console.log("\n===== SELFTEST FAIL：无法推导检索词，中止 =====");
    process.exitCode = 1;
    process.exit(1);
}
console.log(`  ★ 库「${chosen.lib}」 触发词「${chosen.term}」 真实index「${chosen.sliceIndex}」`);

// 取一个已存在的真实会话名（只读，echoPersist:false 下 save 为 no-op）
const sessionNames = readdirSync(SESSION_ROOT).filter((n) => n.endsWith(".json"));
const sessionId = sessionNames[0].replace(/\.json$/, "");
console.log(`  ★ 会话（仅读取）:「${sessionId}」（共 ${sessionNames.length} 个会话文件）`);

// ========== [4] query()：BM25 支线真跑（无 key，searchText 留空 → 不碰 embedding） ==========
console.log("\n== [4] engine.query() —— BM25 支线真跑（无 key） ==");
const baseline = JSON.parse(
    readFileSync(new URL("./baseline-st-response.json", import.meta.url), "utf8"),
);
// 基线是**ST 原版**的响应（7 键，含 BM25 两键）；本仓引擎另加一个 `_diag`（维度核对）⇒ 期望键 = 基线键 + `_diag`。
const EXPECTED_TOP_KEYS = [...Object.keys(baseline), "_diag"].sort();
const BASELINE_MERGED_KEYS = Object.keys(baseline.merged_chat_results[0]).sort();
console.log(`  基线顶层键: ${Object.keys(baseline).sort().join(", ")}`);
console.log(`  本引擎期望顶层键: ${EXPECTED_TOP_KEYS.join(", ")}`);
console.log(`  基线 merged_chat[0] 键: ${BASELINE_MERGED_KEYS.join(", ")}`);

const payload = {
    searchText: "", // 留空 → 向量支线不用 embedding（vector=null）
    bm25SearchText: `user: 请展开讲讲「${chosen.term}」的来龙去脉`,
    apiConfig: { key: "", url: "http://127.0.0.1:1", model: "x" },
    ignore_ids: [],
    echoConfig: {},
    sessionId,
    is_swipe: false,
    rerankConfig: { enabled: false, api: { key: "", url: "http://127.0.0.1:1", model: "x" } },
    chatContext: { ids: [picked.collection], strategy: null },
    kbContext: { ids: [], strategy: null },
    bm25Configs: {
        chat_top_k: 3,
        chat: [
            {
                dbId: chosen.lib,
                dictionary: [{ trigger: chosen.term, index: chosen.sliceIndex }],
            },
        ],
    },
};

const result = await engine.query(payload);

// --- 4a. 顶层键集合与基线完全一致 ---
const resultTopKeys = Object.keys(result).sort();
check(
    "query() 顶层键 = 基线 7 键 + `_diag`（两边的键一个不多一个不少）",
    JSON.stringify(resultTopKeys) === JSON.stringify(EXPECTED_TOP_KEYS),
    `实际 [${resultTopKeys.join(", ")}]`,
);

// --- 4b. merged_chat_results 条目键集合对照 ---
// 说明：无 key 环境下 merged_chat_results 只可能含 BM25 条目（type:"bm25"）。
// 基线 merged_chat[0] 是向量条目形状（10 键）；BM25 条目按原版语义平铺
// MiniSearch stored 字段 + type/source/_source_collection，与原版服务端完全一致。
// match/queryTerms/terms 是 MiniSearch 检索结果的原生字段，原版 bm25Engine.searchPipeline
// 原样返回、bm25ChatTask `...r` 原样平铺 —— 原版 HTTP 响应同样携带，非搬运偏差。
const BM25_CANON = new Set([
    "_source_collection", "_source_db", "batch_id", "chunk_index", "doc_name",
    "id", "index", "match", "queryTerms", "score", "source", "tags", "terms",
    "text", "timestamp", "type",
]);
let mergedShapeOk = true;
result.merged_chat_results.forEach((item, i) => {
    // JSON 序列化一遍再取键（与基线的固化方式对齐：undefined 值键会被丢弃）
    const keys = Object.keys(JSON.parse(JSON.stringify(item ?? null))).sort();
    if (item.type === "bm25") {
        const inCanon = keys.every((k) => BM25_CANON.has(k));
        const hasCore = ["id", "index", "text", "tags", "score", "timestamp", "type", "source", "_source_collection", "_source_db"]
            .every((k) => keys.includes(k));
        if (!inCanon || !hasCore) {
            mergedShapeOk = false;
            console.log(`  !! merged_chat[${i}] (bm25) 键集异常: [${keys.join(", ")}]`);
        } else if (i === 0) {
            console.log(`  merged_chat[0] (bm25) 键集: [${keys.join(", ")}]`);
        }
    } else {
        // 向量/回响条目：必须与基线 merged_chat[0] 键集合一致
        if (JSON.stringify(keys) !== JSON.stringify(BASELINE_MERGED_KEYS)) {
            mergedShapeOk = false;
            console.log(`  !! merged_chat[${i}] (type=${item.type}) 键集与基线不一致: [${keys.join(", ")}]`);
        }
    }
});
check(
    "merged_chat_results 条目键集合与基线形状一致（向量条目=基线10键；BM25条目=原版平铺形状）",
    mergedShapeOk,
    `共 ${result.merged_chat_results.length} 条`,
);

// --- 4c. BM25 支线真实命中报告 ---
const bm25Chat = result.bm25_chat_results || [];
console.log(`  bm25_chat_results 条数: ${bm25Chat.length}`);
bm25Chat.slice(0, 3).forEach((r, i) => {
    console.log(`  #${i} index=${r.index} score=${typeof r.score === "number" ? r.score.toFixed(4) : r.score} source=${r.source}`);
    console.log(`    text[:80] = ${(r.text || "").slice(0, 80)}`);
});
check("BM25 支线真实命中 ≥ 1 条", bm25Chat.length > 0);
check("merged_chat_results = BM25 条目(向量空) 数量一致", result.merged_chat_results.length === bm25Chat.length);
const echoLogsCount = (result._debug_logs || []).filter((l) => l.step === "Echo").length;
console.log(`  _debug_logs 共 ${(result._debug_logs || []).length} 条，其中 Echo 步骤 ${echoLogsCount} 条（回响已照常计算）`);
check("回响状态机照常运行（Echo 日志存在）", echoLogsCount > 0);

// --- 4c. `_diag` 如实回填：这一轮 searchText 留空 ⇒ 没跑向量 ⇒ query 如实是 null
check("`_diag` 存在且如实（本轮没跑向量 ⇒ query=null）", !!result._diag && result._diag.query === null, JSON.stringify(result._diag));

// ========== [4b] 向量支线真跑（桩 fetch 返回真向量；T1 `_diag` 的维度核对） ==========
console.log("\n== [4b] engine.query() —— 向量支线真跑（真库真向量，零联网） ==");
const result2 = await engine.query({
    ...payload,
    searchText: "user: 随便问一句（桩只负责把真向量还回去）",   // 非空 ⇒ 走 embedding（桩）
    bm25SearchText: "",                                        // ⛔ 隔离向量路：这轮不给 BM25 检索词
    bm25Configs: { chat: [], kb: [] },                         //   也不给词典 ⇒ 两条 BM25 任务直接早退
    apiConfig: { key: "stub-key", url: "http://127.0.0.1:1", model: "stub-model" },
});
check("`_diag` 带上查询向量维度（= 真库那条的维度）", result2._diag?.query === picked.dim, JSON.stringify(result2._diag?.query));
check("向量支线真命中（merged ≥ 1 条）", result2.merged_chat_results.length > 0, `实得 ${result2.merged_chat_results.length}`);
check("BM25 两键仍在返回里（这轮没给词典 ⇒ 空数组）", Array.isArray(result2.bm25_chat_results) && result2.bm25_chat_results.length === 0,
    `实得 ${JSON.stringify(result2.bm25_chat_results)}`);

// ========== [4] 无 key 时向量支线的行为 ==========
console.log("\n== [4] 无 key + searchText 非空 → 抛错（不静默） ==");
try {
    await engine.query({
        ...payload,
        searchText: "你好",
        bm25SearchText: "",
        sessionId: undefined, // 不走回响，聚焦向量支线报错路径
    });
    console.log("  [FAIL] 未抛错（不该发生：getEmbedding 应因缺 key 失败）");
    failures++;
} catch (e) {
    console.log(`  实测：抛错 code=${e.code} | message=${e.message}`);
    check("抛出带 .code 的错误（未静默吞掉）", e?.code === "ANIMA_QUERY_FAILED", `code=${e?.code}`);
    check("错误信息与原版一致（API Key missing）", e?.message === "API Key missing", e?.message);
    check("附带 httpStatus=500（对应原版 500 响应）", e?.httpStatus === 500);
}

// ========== [5] 零写入断言 ==========
console.log("\n== [5] 零写入断言（文件数 + mtime + SHA256 逐文件比对） ==");
const after = {
    bm25: snapshot(BM25_ROOT),
    sessions: snapshot(SESSION_ROOT),
};
const bm25Unchanged =
    compareSnapshots(before.bm25, after.bm25, "bm25_indexes") &&
    after.bm25.size === before.bm25.size;
const sessionsUnchanged =
    compareSnapshots(before.sessions, after.sessions, "sessions") &&
    after.sessions.size === before.sessions.size;
check(`data/bm25_indexes 零写入（${before.bm25.size} 文件全部未变）`, bm25Unchanged);
check(`data/sessions 零写入（${before.sessions.size} 文件全部未变）`, sessionsUnchanged);

engine.close();

// ========== 结果 ==========
console.log(
    failures === 0
        ? "\n===== SELFTEST PASS：全部断言通过，线上数据一个字节没动 ====="
        : `\n===== SELFTEST FAIL：${failures} 项断言未过 =====`,
);
process.exitCode = failures === 0 ? 0 : 1;
