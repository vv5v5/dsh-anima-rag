/**
 * BM25 基础层自测（零安装、零 API key、对线上数据零写入）。
 *
 * 跑法：node test/selftest-bm25.mjs
 *
 * - 被测对象：lib/bm25.js（createBm25），persist:false 只读模式；
 * - 真实数据：SillyTavern anima-rag 插件的 data/bm25_indexes（11 库）与 data/sessions（14 会话），
 *   **只读**；断言跑完前后 文件数 + mtime + SHA256 完全一致；
 * - 依赖解析：目标库目录没有 node_modules，用
 *   createRequire('D:/apps/SillyTavern-Launcher/SillyTavern/plugins/anima-rag/node_modules/')
 *   解析 minisearch / jieba-wasm（lib/bm25.js 的 options.depsBase 通道），不装任何包。
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { createBm25 } from "../lib/bm25.js";

const PLUGIN_ROOT =
    "D:/apps/SillyTavern-Launcher/SillyTavern/plugins/anima-rag";
const BM25_ROOT = join(PLUGIN_ROOT, "data", "bm25_indexes");
const SESSION_ROOT = join(PLUGIN_ROOT, "data", "sessions");
const DEPS_BASE = `${PLUGIN_ROOT}/node_modules/`; // 任务指定的 createRequire 基址

const TARGET_LIB = "影子_-0906重开";
const TOP_K = 3;

let failures = 0;
function check(label, cond, detail = "") {
    const tag = cond ? "PASS" : "FAIL";
    console.log(`  [${tag}] ${label}${detail ? ` —— ${detail}` : ""}`);
    if (!cond) failures++;
}

/** 目录快照：文件名 → { size, mtimeMs, sha256 }（跑前/跑后各一次，用于零写入断言） */
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
        console.log(
            `  !! ${label}: 文件数变化 ${names.length} -> ${after.size}`,
        );
    }
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
            console.log(
                `  [未变] ${label}/${name}  size=${b.size}  mtime=${b.mtimeMs}  sha256=${b.sha256.slice(0, 12)}…`,
            );
        }
    }
    return ok;
}

// ========== [1] 创建只读引擎（真实数据目录，persist:false） ==========
console.log("== [1] createBm25({ bm25Root: <bm25_indexes>, persist: false }) ==");
const before = {
    bm25: snapshot(BM25_ROOT),
    sessions: snapshot(SESSION_ROOT),
};
console.log(
    `  快照完成：bm25_indexes ${before.bm25.size} 个文件，sessions ${before.sessions.size} 个文件`,
);
const engine = createBm25({
    bm25Root: BM25_ROOT,
    persist: false,
    depsBase: DEPS_BASE,
});
console.log(
    `  依赖解析（createRequire 基址 ${DEPS_BASE}）：` +
        `minisearch -> ${typeof engine.MiniSearch === "function" ? engine.MiniSearch.name : "!!"}，` +
        `jieba-wasm -> cut_for_search=${typeof engine._cutForSearch}, add_word=${typeof engine._addWord}`,
);

// ========== [2] list() ==========
console.log("\n== [2] list() ==");
const libs = engine.list();
console.log(`  共 ${libs.length} 个库：${JSON.stringify(libs)}`);
// ★ 2026-09-16 改：**不许再写死个数** —— 同一个根目录里现在还有我们自己的 `dsh-memory`
//   （甲方案 T2 的写入口就写这儿），个数会随写入变化；写死个数会把「我们自己写了一片记忆」
//   误报成「引擎坏了」。这里改判「ST 侧那 11 个都在」+ 我们那个库也在。
check("list() 至少返回 ST 侧 11 个库", libs.length >= 11, `实际 ${libs.length}`);
check("包含我们自己的库 dsh-memory", libs.includes("dsh-memory"), libs.slice(0, 3).join(","));
check("包含目标库", libs.includes(TARGET_LIB));

// ========== [3] 从目标库自己的词元里选一个中文检索词 ==========
console.log(`\n== [3] 从「${TARGET_LIB}」自身词元选检索词 ==`);
const inst = engine.load(TARGET_LIB);
check("load() 拿到 MiniSearch 实例", !!inst);
// 该库没配词典（storedFields.tags 全为空），按任务口径改从索引词元（term 表）里挑：
// 取「纯中文、最长、文件序最先」的词元，保证确定性
const terms = inst.toJSON().index.map((entry) => entry[0]);
const cjkTerms = terms.filter((t) => /^[\u4e00-\u9fa5]+$/.test(t));
const maxLen = cjkTerms.reduce((m, t) => Math.max(m, t.length), 0);
const topCandidates = cjkTerms.filter((t) => t.length === maxLen).slice(0, 10);
const queryTerm = cjkTerms.find((t) => t.length === maxLen);
console.log(
    `  词元总数 ${terms.length}，纯中文词元 ${cjkTerms.length} 个；最长 ${maxLen} 字，候选(前10)：${JSON.stringify(topCandidates)}`,
);
console.log(`  ★ 选中的中文检索词：「${queryTerm}」`);
check("选到了中文检索词", !!queryTerm);

// ========== [4] searchPipeline ==========
console.log(`\n== [4] searchPipeline(「${queryTerm}」, [{dbId:"${TARGET_LIB}"}], topK=${TOP_K}, "chat") ==`);
const results = await engine.searchPipeline(
    queryTerm,
    [{ dbId: TARGET_LIB }],
    TOP_K,
    "chat",
);
console.log(`  命中条数: ${results.length}`);
for (const r of results) {
    console.log(
        `  - id=${r.id} index=${r.index} score=${r.score.toFixed(6)} timestamp=${r.timestamp} tags=${JSON.stringify(r.tags)}`,
    );
    console.log(`    text[:80] = ${(r.text || "").slice(0, 80)}`);
}
if (results[0]) {
    console.log(`  单条返回结构 keys: ${JSON.stringify(Object.keys(results[0]))}`);
    console.log(
        `  说明：storeFields 由 MiniSearch 平铺在结果对象顶层（id/text/tags/timestamp/index/batch_id/_source_db），不是嵌套的 storedFields；磁盘文件里的 storedFields 才是 {内部id: 文档字段} 的映射。`,
    );
}
check("searchPipeline 返回了结果", results.length > 0);

// ========== [5] 零写入断言 ==========
console.log("\n== [5] 零写入断言（文件数 + mtime + SHA256 逐文件比对） ==");
const after = {
    bm25: snapshot(BM25_ROOT),
    sessions: snapshot(SESSION_ROOT),
};
const bm25Unchanged = compareSnapshots(before.bm25, after.bm25, "bm25_indexes");
const sessionsUnchanged = compareSnapshots(
    before.sessions,
    after.sessions,
    "sessions",
);
check(
    "data/bm25_indexes 零写入（11 文件全部未变）",
    bm25Unchanged && after.bm25.size === before.bm25.size,
);
check(
    "data/sessions 零写入（14 文件全部未变）",
    sessionsUnchanged && after.sessions.size === before.sessions.size,
);

// ========== 结果 ==========
console.log(
    failures === 0
        ? "\n===== SELFTEST PASS：全部断言通过，线上数据一个字节没动 ====="
        : `\n===== SELFTEST FAIL：${failures} 项断言未过 =====`,
);
process.exitCode = failures === 0 ? 0 : 1;
