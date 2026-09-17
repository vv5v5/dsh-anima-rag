/**
 * Anima 检索核心 —— 搬自 `SillyTavern/plugins/anima-rag/index.js`（3384 行，express 插件）。
 * 零 express 依赖：原 /query、/insert 两个 HTTP handler 的函数体被原样抽成
 * `query(payload)` / `insert(payload)`，请求体 → `payload`，响应 JSON → `return 值`。
 *
 * 逐块映射（源文件行号 → 本文件位置）：
 * | 源 index.js            | 本文件                          | 说明 |
 * |------------------------|---------------------------------|------|
 * | 43-44 VECTOR_ROOT/SESSION_ROOT | createEngine options.vectorRoot/sessionRoot | 参数化 |
 * | 45-47 activeIndexes/writeQueues/loadingPromises | 工厂内 Map ×2 + createQueue() | 并发原语保留 |
 * | 70-124 chunkText       | 模块级 chunkText                | 逐字照搬（钉死 API 不用，供 KB 入库复用） |
 * | 126-173 loadSession/saveSession | A 部分 lib/store.js    | createSessionStore(echoPersist) |
 * | 176-346 processEchoLogic | 工厂内 processEchoLogic       | 逐字照搬，console→logger |
 * | 349-439 getEmbedding   | 工厂内 getEmbedding             | fetch→fetchImpl（默认全局 fetch），无 ST 代理 |
 * | 442-488 fetchRerank    | 工厂内 fetchRerank              | 同上 |
 * | 490-501 runInQueue     | A 部分 lib/concurrency.js       | createQueue |
 * | 505-572 getIndex       | 工厂内 getIndex                 | VECTOR_ROOT→vectorRoot；activeIndexes/loadingPromises 改工厂私有 Map |
 * | 575-605 queryIndexSafe | 工厂内 queryIndexSafe           | 保留 4 参元数适配（vectra patched） |
 * | 607-669 queryMultiIndices | 工厂内 queryMultiIndices     | ignore 过滤用 lib/ignore-filter.js 的 buildLegacyScopedIgnoreFilter（原 4 参函数体） |
 * | 672-1242 performDynamicStrategy | 工厂内 performDynamicStrategy | 阈值/系数/`min_score-0.2` 全部不动 |
 * | 1282-1461 POST /insert 路由体 | insert(payload)      | 400/500 响应 → 返回 {success,status,message} |
 * | 1631-1645 GET /list 路由体 | listCollections()      | 逐字照搬（去 express 壳） |
 * | 1647-1667 GET /bm25/list 路由体 | listBm25()        | 已收敛进 lib/bm25.js 的 list() |
 * | 2256-3167 POST /query 路由体 | query(payload)       | 主流程逐字照搬；7 键响应 → return 7 键对象 |
 *
 * 未搬（有意省略，均与检索核心无关）：
 * - init() 里读 ST `../../config.yaml` 的代理配置块与 `/proxy/forward`（index.js:16-41, 1244-1280 及其余路由）；
 * - `global.File` polyfill 与 `global.fetch` 检查（Node 24 原生有）；
 * - `SPECIAL_TAGS`（index.js:48-58，全文件只声明未使用）。
 *
 * 语义边界改动（传输层，均已征得任务口径允许，算法零改动）：
 * 1. `/query` 的 500 响应（index.js:3160-3166）→ `throw` 带 `.code="ANIMA_QUERY_FAILED"`
 *    与 `.httpStatus=500` 的 Error（message 仍取 `err.message || "Unknown Query Error"`）；
 *    前置早退分支 `if (!searchText && !bm25SearchText)`（index.js:2285-2286）**逐字保留**
 *    其旧版 2 键返回 `{ chat_results: [], kb_results: [] }`。
 * 2. `/insert` 的 400/500 响应 → 返回 `{ success, status, message }`，message 文案逐字一致。
 * 3. `echoPersist:false` 时会话保存为彻底 no-op（lib/store.js persist:false），回响照常计算。
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { createBm25 } from "./bm25.js";
import { createSessionStore } from "./store.js";
import { createQueue } from "./concurrency.js";
import {
    normalizeIgnoreIds,
    buildLegacyScopedIgnoreFilter,
} from "./ignore-filter.js";

/**
 * 解析 vectra（CJS）。必须用**裸包名** require，createRequire 基址向上找 node_modules。
 * ⚠️ 运行时依赖打过 `patches/vectra+0.12.3.patch` 的 vectra：新版 queryItems 是
 * 4 参签名 queryItems(vector, queryString, topK, filter)。换用未打补丁的 vectra
 * 时 queryIndexSafe 会走旧版 3 参分支，文本匹配/过滤行为静默改变（原版同风险）。
 * @param {string|undefined} depsBase createRequire 基址（目录或文件均可）
 */
function resolveVectra(depsBase) {
    const base = depsBase || import.meta.url;
    const require = createRequire(base);
    const mod = require("vectra");
    const LocalIndex = mod.LocalIndex || mod.default?.LocalIndex || mod.default;
    if (typeof LocalIndex !== "function") {
        throw new Error(
            `[dsh-anima-rag] require('vectra') 未返回 LocalIndex 构造函数（base=${base}）。` +
                `请通过 createEngine({ depsBase: '<包含 vectra 的 node_modules 目录>' }) 指定。`,
        );
    }
    return { LocalIndex };
}

// 🟢 [搬] index.js:69-124 智能文本切片工具（逐字照搬；钉死 API 未使用，供 KB 入库等复用）
export function chunkText(text, strategy) {
    const { delimiter, chunkSize } = strategy;

    // 模式 A: 自定义分隔符 (优先)
    if (delimiter && delimiter.trim() !== "") {
        // 使用 split 分割，并过滤掉空行
        return text
            .split(delimiter)
            .map((t) => t.trim())
            .filter((t) => t.length > 0);
    }

    // 模式 B: 字符数 + 智能截断
    // 逻辑：每隔 chunkSize 切一刀，然后向后找最近的 \n 或 。
    const chunks = [];
    let startIndex = 0;
    const limit = parseInt(chunkSize) || 500;
    const totalLen = text.length;

    while (startIndex < totalLen) {
        let endIndex = startIndex + limit;

        if (endIndex >= totalLen) {
            endIndex = totalLen;
        } else {
            // 智能寻找断点：优先找换行，其次找句号/问号/感叹号
            // 在 limit 之后的 100 个字符内寻找，避免无限延长
            const searchWindow = text.substring(endIndex, endIndex + 100);

            // 1. 尝试找换行符
            let offset = searchWindow.indexOf("\n");

            // 2. 如果没换行，找句子结束符
            if (offset === -1) {
                const punctuationMatch = searchWindow.match(/[。.?!？！]/);
                if (punctuationMatch) {
                    offset = punctuationMatch.index;
                }
            }

            // 3. 如果找到了合适的断点，就延伸过去；否则硬切
            if (offset !== -1) {
                endIndex += offset + 1; // 包含标点
            }
        }

        const chunk = text.substring(startIndex, endIndex).trim();
        if (chunk) chunks.push(chunk);

        // 下一段从当前结束点开始
        startIndex = endIndex;
    }

    return chunks;
}

/**
 * 检索引擎工厂（接口钉子）。
 * @param {object} options
 * @param {string} options.vectorRoot 向量库根目录（原 :43 脚本目录下的 vectors）
 * @param {string} options.sessionRoot 会话目录（原 :44 脚本目录下 data/sessions）
 * @param {string} options.bm25Root BM25 索引根目录（原 :1650 脚本目录下 data/bm25_indexes）
 * @param {boolean} [options.echoPersist=true] false = 回响照常计算，但会话持久化为彻底 no-op
 * @param {Function} [options.fetchImpl] 替代全局 fetch（embedding/rerank 原生请求）
 * @param {object} [options.logger=console] 需要 log/warn/error
 * @param {string} [options.depsBase] createRequire 基址，解析 vectra / minisearch / jieba-wasm
 * @param {boolean} [options.bm25Persist=true] 透传 createBm25 的 persist（查询路径本就不写盘）
 * @returns {{ query, insert, listCollections, listBm25, close }}
 */
export function createEngine(options = {}) {
    const {
        vectorRoot,
        sessionRoot,
        bm25Root,
        echoPersist = true,
        fetchImpl = null,
        logger = console,
        depsBase = null,
        bm25Persist = true,
    } = options;

    if (!vectorRoot) {
        throw new Error(
            "[dsh-anima-rag] createEngine(options) 缺少 options.vectorRoot（原 :43 脚本目录下的 vectors）",
        );
    }
    if (!sessionRoot) {
        throw new Error(
            "[dsh-anima-rag] createEngine(options) 缺少 options.sessionRoot（原 :44 脚本目录下 data/sessions）",
        );
    }
    if (!bm25Root) {
        throw new Error(
            "[dsh-anima-rag] createEngine(options) 缺少 options.bm25Root（原脚本目录下 data/bm25_indexes）",
        );
    }

    const fetchFn = fetchImpl || globalThis.fetch.bind(globalThis);
    const { LocalIndex } = resolveVectra(depsBase);

    // [搬] index.js:45-47 模块级并发原语 → 工厂私有（语义不变）
    const activeIndexes = new Map(); // safeName -> LocalIndex 实例
    const loadingPromises = new Map(); // safeName -> 加载中 Promise
    const writeQueues = createQueue(); // 原 runInQueue/writeQueues

    // [搬] index.js:126-173 loadSession/saveSession → lib/store.js
    const sessions = createSessionStore(sessionRoot, {
        persist: echoPersist,
        logger,
    });
    // [搬] ./bm25_engine 单例 → lib/bm25.js 工厂
    const bm25 = createBm25({ bm25Root, persist: bm25Persist, logger, depsBase });

    // 🆕 [搬] index.js:505-572 动态获取/创建 Index 实例
    async function getIndex(collectionId, allowCreate = true) {
        if (!collectionId) throw new Error("Collection ID is required");

        const safeName = collectionId.replace(
            /[^a-zA-Z0-9@\-\._\u4e00-\u9fa5]/g,
            "_",
        );

        if (activeIndexes.has(safeName)) return activeIndexes.get(safeName);
        if (loadingPromises.has(safeName)) return loadingPromises.get(safeName);

        const loadTask = (async () => {
            const collectionPath = path.join(vectorRoot, safeName);
            logger.log(
                `[Anima Debug] 📂 Loading Index: ${safeName} (Create: ${allowCreate})`,
            );

            // ✨ 核心拦截逻辑：如果不允许创建，且文件夹不存在，直接返回 null
            if (!allowCreate && !fs.existsSync(collectionPath)) {
                logger.log(`[Anima RAG] 🛑 查询跳过不存在的库: ${safeName}`);
                return null;
            }

            // 下面是原有的创建/加载逻辑
            if (!fs.existsSync(collectionPath))
                fs.mkdirSync(collectionPath, { recursive: true });

            const indexInstance = new LocalIndex(collectionPath);

            // 注意：isIndexCreated 会检查 index.json
            if (!(await indexInstance.isIndexCreated())) {
                await indexInstance.createIndex({
                    version: 1,
                    metadata_config: { indexed: ["tags", "index", "batch_id"] },
                });
            }

            try {
                const stats = await indexInstance.listItems();
                logger.log(
                    `[Anima Debug] ✅ Index ${safeName} loaded with ${stats.length} items.`,
                );
            } catch (e) {}

            return indexInstance;
        })();

        loadingPromises.set(safeName, loadTask);
        try {
            const instance = await loadTask;

            // 如果 loadTask 返回 null (因为不允许创建)，这里也返回 null
            if (!instance) {
                return null;
            }

            instance["_debug_id"] = collectionId;
            activeIndexes.set(safeName, instance);
            return instance;
        } finally {
            loadingPromises.delete(safeName);
        }
    }

    // 🕵️‍♂️ [搬] index.js:574-605 调试增强版：安全查询（保留函数元数适配）
    async function queryIndexSafe(indexInstance, vector, k, filter) {
        try {
            const safeFilter = filter || undefined;
            const arity = indexInstance.queryItems.length;

            let results;

            // ⚡ 核心修复：只要参数个数 >= 4，都视为新版逻辑
            // 新版签名：queryItems(vector, queryString, topK, filter, minScore?)
            if (arity >= 4) {
                // 必须传第二个参数为 "" (空字符串) 来跳过文本匹配
                results = await indexInstance.queryItems(
                    vector,
                    "",
                    k,
                    safeFilter,
                );
            }
            // 旧版逻辑 (v0.x)
            else {
                if (safeFilter) {
                    results = await indexInstance.queryItems(
                        vector,
                        k,
                        safeFilter,
                    );
                } else {
                    results = await indexInstance.queryItems(vector, k);
                }
            }

            return results || [];
        } catch (e) {
            logger.error(`[Anima CRITICAL] ❌ 检索函数崩溃:`, e);
            return [];
        }
    }

    // [搬] index.js:607-669 多库并行检索
    async function queryMultiIndices(
        indices,
        vector,
        k,
        filter = null,
        taskTag = "RAG",
        recentWeight = 0,
        currentSessionId = null,
        ignoreIds = [],
    ) {
        logger.log(
            `[Anima Debug] [${taskTag}] 🚀 并行检索 ${indices.length} 个库...`,
        );

        const promises = indices.map(async (idx) => {
            const sourceCollection = idx._debug_id || null;
            // 原 index.js:623-628 调的是 4 参 buildScopedIgnoreFilter(filter, collectionId,
            // ignoreCollectionId, ignoreIds)，其函数体即 lib/ignore-filter.js 的
            // buildLegacyScopedIgnoreFilter（逐字照搬）
            const scopedFilter = buildLegacyScopedIgnoreFilter(
                filter,
                sourceCollection,
                currentSessionId,
                ignoreIds,
            );
            const results = await queryIndexSafe(idx, vector, k, scopedFilter);

            // 为每个结果附带来源库的 ID
            return results.map((entry) => {
                entry._source_collection = sourceCollection || "unknown_lib";

                // 🟢 近因加权：只对当前数据库的分数进行提升
                if (
                    recentWeight > 0 &&
                    currentSessionId &&
                    entry._source_collection === currentSessionId
                ) {
                    const oldScore = entry.score; // 记录原始分数
                    entry.score += Number(recentWeight);
                    entry._is_weighted = true; // 打上标记，供前端日志读取

                    const indexStr = entry.item.metadata?.index || "unknown";
                    logger.log(
                        `[Anima 加权] [${taskTag}] 📦 ${entry._source_collection} | ⬆️ Index ${indexStr} | 分数: ${oldScore.toFixed(4)} -> ${entry.score.toFixed(4)} (+${recentWeight})`,
                    );
                }

                return entry;
            });
        });

        const resultsArrays = await Promise.all(promises);

        // 拍平结果
        let allResults = resultsArrays.flat();
        logger.log(
            `[Anima Debug] [${taskTag}] 📊 聚合所有库结果，共 ${allResults.length} 条 (排序前)`,
        );

        // 排序
        allResults.sort((a, b) => b.score - a.score);

        // 截取
        return allResults.slice(0, 50);
    }

    // 🟢 [搬] index.js:442-488 辅助：请求重排模型 (带超时控制)
    async function fetchRerank(query, documents, config) {
        if (!config || !config.key || !config.url)
            throw new Error("Rerank API 配置缺失");
        if (!documents || documents.length === 0) return [];

        const controller = new AbortController();
        const timeoutSeconds = config.timeout || 30;
        const timeoutId = setTimeout(
            () => controller.abort(),
            timeoutSeconds * 1000,
        );

        try {
            logger.log(
                `[Anima Rerank] 📡 发起重排请求 | 文档数: ${documents.length} | 模型: ${config.model}`,
            );
            const response = await fetchFn(config.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${config.key}`,
                },
                body: JSON.stringify({
                    model: config.model,
                    query: query,
                    documents: documents.map((d) => d.text), // 提取文本发送
                }),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP Error ${response.status}`);
            }

            const data = await response.json();
            // 确保返回的是按相关度从高到低排序的结果
            return data.results || [];
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === "AbortError") {
                throw new Error(`Rerank 请求超时 (${timeoutSeconds}s)`);
            }
            throw error;
        }
    }

    // 辅助：获取向量 [搬] index.js:349-439
    async function getEmbedding(text, config) {
        if (!config || !config.key) throw new Error("API Key missing");
        try {
            const fetchUrl = `${config.url.replace(/\/+$/, "")}/embeddings`;

            logger.log(
                `[Anima Debug] Embedding Request -> URL: ${fetchUrl}, Model: ${config.model}`,
            );

            // 超时控制 (防止 Node.js 原生 fetch 无限挂起)
            //
            // ⛔ 2026-09-16 实测（**有意偏离原版**，理由如下）：原来是硬编码 `15000`，
            //    而 provider（SiliconFlow）**冷启动首次调用**实测要 18–50s（热了之后 0.16–0.33s）
            //    ⇒ 真机上第一次写入/检索**必然**撞这个 15s 被 abort（实测报
            //    「向量 API 请求超时无响应」）。所以改成**可配**：`apiConfig.timeout_ms`（毫秒），
            //    缺省仍回落到 15000（不配就跟原版行为一致）。
            const embedTimeoutMs = Number(config.timeout_ms) > 0 ? Number(config.timeout_ms) : 15000;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), embedTimeoutMs);

            const response = await fetchFn(fetchUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${config.key}`,
                },
                body: JSON.stringify({
                    input: text,
                    model: config.model,
                }),
                signal: controller.signal, // 绑定超时中断信号
            });

            clearTimeout(timeoutId); // 拿到响应后，立刻清除定时器

            if (!response.ok) {
                const errText = await response.text();
                let cleanMessage = "Unknown API Error";
                try {
                    // 尝试解析 JSON
                    const errJson = JSON.parse(errText);
                    cleanMessage =
                        errJson.error?.message ||
                        errJson.message ||
                        JSON.stringify(errJson);
                } catch (e) {
                    let stripped = errText.replace(/<[^>]*>?/gm, "").trim();
                    cleanMessage = stripped
                        .replace(/\s+/g, " ")
                        .substring(0, 100);
                    if (!cleanMessage)
                        cleanMessage = `HTTP Error ${response.status}`;
                }
                throw new Error(cleanMessage);
            }

            const data = await response.json();

            // 🛡️ 防御性校验：确保 data.data 是一个数组，且至少有一条数据
            if (
                !data ||
                !data.data ||
                !Array.isArray(data.data) ||
                data.data.length === 0
            ) {
                // 提取可能的实际错误信息返回给用户
                const actualResponse = JSON.stringify(data).substring(0, 150);
                logger.error(
                    `[Anima RAG] ❌ 向量 API 返回了异常的数据结构:`,
                    actualResponse,
                );
                throw new Error(
                    `向量 API 数据解析失败。请检查 API 厂商格式或模型是否正确。API 返回: ${actualResponse}...`,
                );
            }

            // 🛡️ 校验内部是否真的有 embedding 字段
            if (!data.data[0].embedding) {
                throw new Error("向量 API 返回了数据，但未找到 embedding 字段。");
            }

            return data.data[0].embedding;
        } catch (error) {
            // 精准拦截超时错误，转化为明确的文字报错
            if (error.name === "AbortError") {
                logger.error(
                    "[Anima RAG] ❌ 向量 API 请求超时无响应 (已主动掐断)",
                );
                throw new Error(
                    "向量 API 请求超时无响应，请检查代理节点或网络稳定性",
                );
            }

            logger.error(
                "[Anima RAG] Embedding Failed (Network/Code):",
                error.cause || error,
            );
            throw error;
        }
    }

    // ✅ [搬] index.js:176-346 核心回响逻辑 (含日志增强 + 存储瘦身 + 前端日志返回)
    function processEchoLogic(
        currentResults,
        globalTop50,
        lastMemories,
        config = {},
    ) {
        const echoLogs = [];

        const maxTotalLimit = config.max_count ?? 10;
        const baseLife = config.base_life || 1;
        const impLife = config.imp_life || 2;
        const impTags = config.important_tags || ["important"];

        /**
         * @param {string} msg
         * @param {any} [meta] - 允许传入对象
         */
        const log = (msg, meta = null) => {
            logger.log(msg);
            echoLogs.push({
                step: "Echo System",
                info: msg,
                meta: meta,
            });
        };

        // 头部日志没有 meta，保持原样
        log(
            `[Anima Echo] 🔍 开始回响判定 | 上轮记忆: ${Object.keys(lastMemories).length} | 本轮命中: ${currentResults.length} | 全局校验池: ${globalTop50.length}`,
        );

        const echoItems = [];
        const nextMemories = {};
        let remainingSlots = Math.max(0, maxTotalLimit - currentResults.length);
        const currentIds = new Set(currentResults.map((r) => r.item.id));
        const globalIds = new Set(globalTop50.map((r) => r.item.id));

        const freshScoreMap = new Map();
        currentResults.forEach((r) => freshScoreMap.set(r.item.id, r.score));
        globalTop50.forEach((r) => {
            if (!freshScoreMap.has(r.item.id))
                freshScoreMap.set(r.item.id, r.score);
        });

        // --- 1. 处理旧记忆 ---
        Object.values(lastMemories).forEach((memory) => {
            const memId = memory.item.id;
            const indexStr = memory.item.metadata?.index || "unknown";

            // 🟢 优先从地图里拿最新分数，没有才用上一轮的旧分数
            const currentScore = freshScoreMap.has(memId)
                ? freshScoreMap.get(memId)
                : memory.score || 0;

            const metaData = {
                score: currentScore, // ✅ 使用最新分数展示
                tags: memory.item.metadata?.tags || [],
                index: indexStr,
            };

            // A. 自然命中 (Refreshed) - 满血复活
            if (currentIds.has(memId)) {
                const leanItem = { ...memory.item };
                delete leanItem.vector;
                nextMemories[memId] = {
                    ...memory,
                    life: memory.maxLife,
                    item: leanItem,
                    score: currentScore, // ✅ 同步更新保存的最新分数，防止存入旧数据
                };
                log(
                    `[Anima Echo] ♻️ [刷新] [📦 ${memory.source}] Index ${indexStr} (自然命中) | Life: ${memory.maxLife}`,
                    metaData,
                );
                return;
            }

            // B & C & D. 尝试回响
            if (globalIds.has(memId)) {
                // 只要 Life > 0 或者是刚刚被复活的 (Life 1)，就有资格尝试回响
                if (memory.life > 0) {
                    if (remainingSlots > 0) {
                        // [C. 回响成功]
                        const leanItem = { ...memory.item };
                        delete leanItem.vector;
                        echoItems.push({
                            item: leanItem,
                            score: currentScore,
                            _source_collection: memory.source || "memory",
                            _is_echo: true,
                        });
                        remainingSlots--;
                        const newLife = memory.life - 1;
                        nextMemories[memId] = {
                            ...memory,
                            life: newLife,
                            item: leanItem,
                            score: currentScore,
                        };
                        log(
                            `[Anima Echo] 🔗 [回响成功] [📦 ${memory.source}] Index ${indexStr} | 剩余Life: ${newLife}`,
                            metaData,
                        );
                    } else {
                        // [D. 惜败 (排队)]
                        const newLife = memory.life - 1;
                        nextMemories[memId] = {
                            ...memory,
                            life: newLife,
                            item: { ...memory.item },
                            score: currentScore,
                        };

                        log(
                            `[Anima Echo] ⏳ [排队等待] [📦 ${memory.source}] Index ${indexStr} (无卡槽) | 剩余Life: ${newLife}`,
                            metaData,
                        );
                    }
                } else {
                    // Life 本来就是 0 (且没被复活)，那就真的死了
                    log(
                        `[Anima Echo] 💀 [记忆枯竭] [📦 ${memory.source}] Index ${indexStr} (Life耗尽 -> 删除)`,
                        metaData,
                    );
                }
            } else {
                // [B. 离题] - 直接移除，不进入 nextMemories
                log(
                    `[Anima Echo] 💨 [遗忘] [📦 ${memory.source}] Index ${indexStr} (脱离相关性范围)`,
                    metaData,
                );
            }
        });

        // --- 2. 注册新记忆 ---
        currentResults.forEach((entry) => {
            const resId = entry.item.id;
            const indexStr = entry.item.metadata?.index || "unknown";

            if (!nextMemories[resId]) {
                const tags = entry.item.metadata.tags || [];
                const isImportant = tags.some((t) =>
                    impTags.includes(t.toLowerCase()),
                );
                const initialLife = isImportant ? impLife : baseLife;
                const leanItem = { ...entry.item };
                delete leanItem.vector;

                nextMemories[resId] = {
                    life: initialLife,
                    maxLife: initialLife,
                    item: leanItem,
                    score: entry.score,
                    source: entry._source_collection,
                };

                log(
                    `[Anima Echo] 🆕 [新增记忆] Index ${indexStr} | 初始Life: ${initialLife}`,
                    {
                        score: entry.score,
                        tags: tags,
                        index: indexStr,
                    },
                );
            }
        });

        return { echoItems, nextMemories, echoLogs };
    }

    // 🔥 [搬] index.js:672-1242 动态策略执行器（拦截器模式重排；阈值/系数全部不动）
    async function performDynamicStrategy(
        indices,
        vector,
        config,
        ignoreIds = [],
    ) {
        let finalResults = [];
        let usedIds = new Set();
        let debugLogs = [];
        let echoCandidatePool = [];
        const steps = config.steps || [];
        const multiplier = config.global_multiplier || 2;
        const globalMinScore = config.min_score || 0;
        const recentWeight = config.recent_weight || 0;
        const currentSessionId = config.current_session_id || null;

        // 🟢 提取附加在 config 上的重排参数
        const searchText = config.searchText;
        const rerankConfig = config.rerankConfig || {};

        logger.log(
            `[Anima RAG] 🚀 执行策略 | 步骤数: ${steps.length} | 排除ID: ${ignoreIds.length} 个 [${ignoreIds.join(", ")}]`,
        );

        // =========================================================
        // 原生：动态构建“功能性标签池”
        // =========================================================
        let functionalTagsSet = new Set();
        steps.forEach((s) => {
            if (["important", "status", "period", "special"].includes(s.type)) {
                if (s.labels && Array.isArray(s.labels)) {
                    s.labels.forEach((l) =>
                        functionalTagsSet.add(l.toLowerCase()),
                    );
                }
                if (s.target_tag) {
                    functionalTagsSet.add(s.target_tag.toLowerCase());
                }
            }
        });

        const buildFilter = (stepFilter = {}) => {
            return stepFilter;
        };

        let detectedVibeTag = null;
        let detectedImportantLabels = [];

        // =========================================================
        // 🧠 重排专用缓存池
        // =========================================================
        let basePool = [];
        let importantPool = [];
        let baseStepConfig = null;
        let importantStepConfig = null;

        // 🧠 重排结算函数 (在进入 Status/Diversity 前执行，确保 usedIds 同步)
        const executeRerankFlush = async () => {
            if (!baseStepConfig && !importantStepConfig) return; // 没有需要重排的数据

            // 降级与兜底逻辑 (如果没开重排或重排失败，按原生分数录入)
            const fallback = () => {
                if (baseStepConfig) {
                    let added = 0;
                    for (const entry of basePool) {
                        if (added >= baseStepConfig.count) break;
                        if (usedIds.has(entry.item.id)) continue;
                        if (entry.score < globalMinScore) continue;
                        finalResults.push(entry);
                        usedIds.add(entry.item.id);
                        added++;
                        debugLogs.push({
                            step: "Step 1: BASE",
                            library: entry._source_collection,
                            uniqueID: entry.item.metadata.index,
                            tags: (entry.item.metadata.tags || []).join(", "),
                            score: entry._is_weighted
                                ? `${entry.score.toFixed(4)} (⬆️+${recentWeight})`
                                : entry.score.toFixed(4),
                        });
                    }
                }
                if (importantStepConfig && importantStepConfig.labels) {
                    const stepThreshold = Math.max(0, globalMinScore - 0.2);
                    importantStepConfig.labels.forEach((label) => {
                        let countForThisLabel = 0;
                        for (const entry of importantPool) {
                            if (countForThisLabel >= importantStepConfig.count)
                                break;
                            if (usedIds.has(entry.item.id)) continue;

                            // 🔒 仅在未重排时，Important 遵守降分门槛
                            if (entry.score < stepThreshold) continue;

                            const tags = (entry.item.metadata.tags || []).map(
                                (t) => t.toLowerCase(),
                            );
                            if (tags.includes(label.toLowerCase())) {
                                finalResults.push(entry);
                                usedIds.add(entry.item.id);
                                countForThisLabel++;
                                debugLogs.push({
                                    step: "Step 2: IMPORTANT",
                                    library: entry._source_collection,
                                    uniqueID: entry.item.metadata.index,
                                    tags: (entry.item.metadata.tags || []).join(
                                        ", ",
                                    ),
                                    score: entry._is_weighted
                                        ? `${entry.score.toFixed(4)} (⬆️+${recentWeight})`
                                        : entry.score.toFixed(4),
                                });
                            }
                        }
                    });
                }
            };

            if (rerankConfig.enabled && rerankConfig.api && searchText) {
                try {
                    const rCount = parseInt(rerankConfig.count) || 30;
                    const halfCount = Math.floor(rCount / 2);

                    const toRerankBase = basePool.slice(0, halfCount);
                    const toRerankImp = importantPool.slice(
                        0,
                        rCount - toRerankBase.length,
                    );

                    const rerankMap = new Map();
                    [...toRerankBase, ...toRerankImp].forEach((item) => {
                        if (!rerankMap.has(item.item.id)) {
                            rerankMap.set(item.item.id, {
                                id: item.item.id,
                                text: item.item.metadata.text,
                                originalData: item,
                            });
                        }
                    });

                    const documentsToSend = Array.from(rerankMap.values());
                    const rerankResults = await fetchRerank(
                        searchText,
                        documentsToSend,
                        rerankConfig.api,
                    );

                    if (rerankResults && rerankResults.length > 0) {
                        logger.log(`[Anima Rerank] 🎯 重排成功！处理分配...`);
                        const rankedItems = rerankResults.map((r) => {
                            const originalObj =
                                documentsToSend[r.index].originalData;
                            originalObj._rerank_score = r.relevance_score;
                            return originalObj;
                        });

                        // 1. 分配给 Base
                        if (baseStepConfig) {
                            let added = 0;
                            for (const entry of rankedItems) {
                                if (added >= baseStepConfig.count) break;
                                if (usedIds.has(entry.item.id)) continue;
                                finalResults.push(entry);
                                usedIds.add(entry.item.id);
                                added++;
                                debugLogs.push({
                                    step: "Rerank: BASE",
                                    library: entry._source_collection,
                                    uniqueID: entry.item.metadata.index,
                                    tags: (entry.item.metadata.tags || []).join(
                                        ", ",
                                    ),
                                    score: `${entry._is_weighted ? `${entry.score.toFixed(4)} (⬆️+${recentWeight})` : entry.score.toFixed(4)} ➡️ 精排: ${entry._rerank_score.toFixed(4)}`,
                                });
                            }
                        }

                        // 2. 分配给 Important (按标签)
                        if (importantStepConfig && importantStepConfig.labels) {
                            importantStepConfig.labels.forEach((label) => {
                                let countForThisLabel = 0;
                                for (const entry of rankedItems) {
                                    if (
                                        countForThisLabel >=
                                        importantStepConfig.count
                                    )
                                        break;
                                    if (usedIds.has(entry.item.id)) continue;

                                    const tags = (
                                        entry.item.metadata.tags || []
                                    ).map((t) => t.toLowerCase());
                                    if (tags.includes(label.toLowerCase())) {
                                        finalResults.push(entry);
                                        usedIds.add(entry.item.id);
                                        countForThisLabel++;
                                        debugLogs.push({
                                            step: "Rerank: IMPORTANT",
                                            library: entry._source_collection,
                                            uniqueID: entry.item.metadata.index,
                                            tags: (
                                                entry.item.metadata.tags || []
                                            ).join(", "),
                                            score: `精排: ${entry._rerank_score.toFixed(4)}`,
                                        });
                                    }
                                }
                            });
                        }
                    } else {
                        fallback();
                    }
                } catch (e) {
                    logger.error(
                        `[Anima Rerank] ❌ 重排失败，回退粗排逻辑:`,
                        e.message,
                    );
                    fallback();
                }
            } else {
                fallback();
            }

            // 结算完毕，清空拦截缓存
            baseStepConfig = null;
            importantStepConfig = null;
        };

        // =========================================================
        // 循环执行步骤
        // =========================================================
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            if (step.count <= 0) continue;

            // 🟢 当遇到非 Base 和 Important 时，说明粗筛完毕，立即结算重排
            if (step.type !== "base" && step.type !== "important") {
                await executeRerankFlush();
            }

            let stepCoeff = 1.0;
            let useGlobalMultiplier = true;

            switch (step.type) {
                case "base":
                    stepCoeff = 5;
                    break;
                case "important":
                    stepCoeff = 2;
                    break;
                case "diversity":
                    stepCoeff = 1.5;
                    break;
                default:
                    stepCoeff = 1.5;
                    break;
            }

            const finalMultiplier = useGlobalMultiplier
                ? multiplier * stepCoeff
                : stepCoeff;
            let candidateK = Math.max(
                Math.ceil(step.count * finalMultiplier),
                2,
            );
            if (
                rerankConfig.enabled &&
                (step.type === "base" || step.type === "important")
            ) {
                const rCount = parseInt(rerankConfig.count) || 30;
                const halfQuota = Math.ceil(rCount / 2);
                candidateK = Math.max(candidateK, halfQuota);
            }
            logger.log(
                `[Step ${i + 1} - ${step.type}] Count: ${step.count} | Multiplier: ${finalMultiplier.toFixed(1)}x | Candidates Per DB: ${candidateK}`,
            );

            let candidates = [];

            switch (step.type) {
                case "base":
                    baseStepConfig = step; // 拦截交给重排
                    candidates = await queryMultiIndices(
                        indices,
                        vector,
                        candidateK,
                        buildFilter({}),
                        "Step: BASE",
                        recentWeight,
                        currentSessionId,
                        ignoreIds,
                    );

                    // 🌟 原生 Vibe Tag 捕获逻辑 (完全没改)
                    if (!detectedVibeTag && candidates.length > 0) {
                        const topItem = candidates[0].item.metadata;
                        const topTags = topItem.tags || [];
                        detectedVibeTag = topTags.find(
                            (t) => !functionalTagsSet.has(t.toLowerCase()),
                        );
                        if (detectedVibeTag) {
                            logger.log(
                                `   [Base] 捕获 Vibe: ${detectedVibeTag} (已排除功能词)`,
                            );
                        }
                    }
                    candidates.sort((a, b) => b.score - a.score);

                    if (echoCandidatePool.length === 0) {
                        echoCandidatePool = candidates.slice(0, 50);
                        logger.log(
                            `[Anima Strategy] 🌊 已捕获 Base 全局池用于回响 (Top ${echoCandidatePool.length})`,
                        );
                    }
                    basePool = candidates.slice(0, 50); // 存入重排池
                    continue; // 🚨 跳过原生聚合循环

                case "important":
                    importantStepConfig = step; // 拦截交给重排
                    if (step.labels && step.labels.length > 0) {
                        detectedImportantLabels = step.labels; // 记录用于后续排除
                        const impPromises = step.labels.map((label) =>
                            queryMultiIndices(
                                indices,
                                vector,
                                candidateK,
                                buildFilter({ tags: { $in: [label] } }),
                                "Step: IMPORTANT",
                                recentWeight,
                                currentSessionId,
                                ignoreIds,
                            ),
                        );
                        const impResults = await Promise.all(impPromises);

                        // 分路均衡逻辑，确保每个标签都能公平地进入重排池
                        let tempCandidates = [];
                        const tempUsedIds = new Set(usedIds);
                        const isRerankActive =
                            rerankConfig.enabled &&
                            rerankConfig.api &&
                            searchText;
                        const stepThreshold = isRerankActive
                            ? -999
                            : Math.max(0, globalMinScore - 0.2);

                        impResults.forEach((list) => {
                            list.sort((a, b) => b.score - a.score);
                            let countForThisLabel = 0;

                            const poolLimitForLabel = Math.max(
                                step.count * 3,
                                5,
                            );

                            for (const entry of list) {
                                if (countForThisLabel >= poolLimitForLabel)
                                    break;
                                if (tempUsedIds.has(entry.item.id)) continue;

                                // 这里会自动根据 isRerankActive 决定是否卡分数
                                if (entry.score < stepThreshold) continue;

                                tempCandidates.push(entry);
                                tempUsedIds.add(entry.item.id);
                                countForThisLabel++;
                            }
                        });

                        importantPool = tempCandidates; // 将均衡提取的候选人放入重排池
                        logger.log(
                            `   [Important] 分路检索放入重排池: 触发 ${step.labels.join(", ")}`,
                        );
                    }
                    continue; // 🚨 跳过原生聚合循环，去下一步

                case "status":
                    if (step.labels && step.labels.length > 0) {
                        const statusPromises = step.labels.map((label) =>
                            queryMultiIndices(
                                indices,
                                vector,
                                candidateK,
                                buildFilter({ tags: { $in: [label] } }),
                                "Step: STATUS",
                                recentWeight,
                                currentSessionId,
                                ignoreIds,
                            ),
                        );
                        const statusResults = await Promise.all(statusPromises);

                        candidates = [];
                        const tempUsedIds = new Set(usedIds);
                        const stepThreshold = Math.max(0, globalMinScore - 0.2);

                        statusResults.forEach((list) => {
                            list.sort((a, b) => b.score - a.score);
                            let countForThisLabel = 0;
                            for (const entry of list) {
                                if (countForThisLabel >= step.count) break;
                                if (tempUsedIds.has(entry.item.id)) continue;
                                candidates.push(entry);
                                tempUsedIds.add(entry.item.id);
                                countForThisLabel++;
                            }
                        });
                    }
                    break;

                case "period":
                    if (step.labels && step.labels.length > 0) {
                        const periodPromises = step.labels.map((label) =>
                            queryMultiIndices(
                                indices,
                                vector,
                                candidateK,
                                buildFilter({ tags: { $in: [label] } }),
                                "Step: PERIOD",
                                recentWeight,
                                currentSessionId,
                                ignoreIds,
                            ),
                        );
                        const periodResults = await Promise.all(periodPromises);

                        candidates = [];
                        const tempUsedIds = new Set(usedIds);
                        const stepThreshold = Math.max(0, globalMinScore - 0.2);

                        periodResults.forEach((list) => {
                            list.sort((a, b) => b.score - a.score);
                            let countForThisLabel = 0;
                            for (const entry of list) {
                                if (countForThisLabel >= step.count) break;
                                if (tempUsedIds.has(entry.item.id)) continue;
                                candidates.push(entry);
                                tempUsedIds.add(entry.item.id);
                                countForThisLabel++;
                            }
                        });
                        logger.log(
                            `   [Period] 生理分支检索: 触发 ${step.labels.join(", ")}`,
                        );
                    }
                    break;

                case "special":
                    if (step.labels && step.labels.length > 0) {
                        const specialPromises = step.labels.map((label) =>
                            queryMultiIndices(
                                indices,
                                vector,
                                candidateK,
                                buildFilter({ tags: { $in: [label] } }),
                                "Step: SPECIAL",
                                recentWeight,
                                currentSessionId,
                                ignoreIds,
                            ),
                        );
                        const specialResults =
                            await Promise.all(specialPromises);

                        candidates = [];
                        const tempUsedIds = new Set(usedIds);
                        const stepThreshold =
                            Math.max(0, globalMinScore - 0.2);

                        specialResults.forEach((list) => {
                            list.sort((a, b) => b.score - a.score);
                            let countForThisLabel = 0;
                            for (const entry of list) {
                                if (countForThisLabel >= step.count) break;
                                if (tempUsedIds.has(entry.item.id)) continue;
                                candidates.push(entry);
                                tempUsedIds.add(entry.item.id);
                                countForThisLabel++;
                            }
                        });
                    } else if (step.target_tag) {
                        candidates = await queryMultiIndices(
                            indices,
                            vector,
                            candidateK,
                            buildFilter({ tags: { $in: [step.target_tag] } }),
                            "Chat",
                            recentWeight,
                            currentSessionId,
                            ignoreIds,
                        );
                    }
                    break;

                case "diversity": {
                    // 🌟 原生丰富度逻辑 (完全没改)
                    const excludeTags = [...detectedImportantLabels];
                    if (
                        detectedVibeTag &&
                        !excludeTags.includes(detectedVibeTag)
                    ) {
                        excludeTags.push(detectedVibeTag);
                    }

                    if (excludeTags.length > 0) {
                        candidates = await queryMultiIndices(
                            indices,
                            vector,
                            candidateK,
                            buildFilter({ tags: { $nin: excludeTags } }),
                            "Step: DIVERSITY",
                            recentWeight,
                            currentSessionId,
                            ignoreIds,
                        );
                    } else {
                        candidates = await queryMultiIndices(
                            indices,
                            vector,
                            candidateK,
                            buildFilter({}),
                            "Step: DIVERSITY",
                            recentWeight,
                            currentSessionId,
                            ignoreIds,
                        );
                    }
                    break;
                }
            }

            // === 原生聚合结果 (仅限 Status/Period/Special/Diversity) ===
            let addedInStep = 0;
            candidates.sort((a, b) => b.score - a.score);
            const limit =
                ["status", "important", "special", "period"].includes(
                    step.type,
                ) && step.labels
                    ? step.count * step.labels.length
                    : step.count;

            for (const entry of candidates) {
                if (addedInStep >= limit) break;
                if (usedIds.has(entry.item.id)) continue;
                finalResults.push(entry);
                usedIds.add(entry.item.id);
                addedInStep++;
                debugLogs.push({
                    step: `Step ${i + 1}: ${step.type.toUpperCase()}`,
                    library: entry._source_collection,
                    uniqueID: entry.item.metadata.index,
                    tags: (entry.item.metadata.tags || []).join(", "),
                    score: entry._is_weighted
                        ? `${entry.score.toFixed(4)} (⬆️+${recentWeight})`
                        : entry.score.toFixed(4),
                });
            }
        }

        // 防御性调用：万一 base/important 是最后一步
        await executeRerankFlush();

        // =========================================================
        // 原生：时间序列最终排序
        // =========================================================
        finalResults.sort((a, b) => {
            const itemA = a.item.metadata;
            const itemB = b.item.metadata;

            const timeA = new Date(itemA.timestamp || 0).getTime();
            const timeB = new Date(itemB.timestamp || 0).getTime();
            if (timeA > 0 && timeB > 0 && timeA !== timeB) {
                return timeA - timeB;
            }

            const parseId = (str) => {
                const parts = (str || "0_0").split("_");
                return {
                    batch: parseInt(parts[0] || 0),
                    slice: parseInt(parts[1] || 0),
                };
            };

            const idA = parseId(itemA.index);
            const idB = parseId(itemB.index);

            if (idA.batch !== idB.batch) {
                return idA.batch - idB.batch;
            }
            return idA.slice - idB.slice;
        });

        finalResults["_debug_logs"] = debugLogs;
        finalResults["_echo_pool"] = echoCandidatePool;

        return finalResults;
    }

    // ==========================================
    // 🔍 [搬] index.js:2256-3167 查询主流程 (支持并行双轨检索)
    // ==========================================
    async function query(payload = {}) {
        try {
            const {
                searchText,
                bm25SearchText,
                apiConfig,
                ignore_ids,
                echoConfig,
                sessionId,
                is_swipe,
                rerankConfig,
                bm25Configs = {},
            } = payload;

            // --- 兼容旧版参数 ---
            const legacyCollectionIds = payload.collectionIds;
            const legacyStrategy = payload.strategy;

            // --- 新版参数 ---
            const chatContext = payload.chatContext || {
                ids: legacyCollectionIds,
                strategy: legacyStrategy,
            };
            const kbContext = payload.kbContext || { ids: [], strategy: null };
            const safeIgnoreIds = normalizeIgnoreIds(ignore_ids);
            const ignoreCollectionId =
                chatContext.strategy?.current_session_id || null;

            // 2. 向量化
            // [搬] 原版早退分支（index.js:2285-2286）逐字保留：旧版 2 键返回形状
            if (!searchText && !bm25SearchText)
                return { chat_results: [], kb_results: [] };

            // 兜底：如果向量检索词为空，则 vector 为 null，防止 getEmbedding 报错
            let vector = null;
            if (searchText) {
                vector = await getEmbedding(searchText, apiConfig);
            }

            // ============================================================
            // 🧠 会话状态预处理 (GC vs Resurrection)
            // ============================================================
            let sessionData = { memories: {} };
            let lastMemories = {};

            if (sessionId) {
                // 读取 Session
                const loaded = await sessions.load(sessionId);
                // 确保 memories 存在，且如果是数组(旧数据)要转为对象，如果是对象则直接用
                if (Array.isArray(loaded.memories)) {
                    // 兼容旧数据的兜底逻辑：把数组转为 ID Map
                    loaded.memories.forEach((m) => {
                        if (m && m.item && m.item.id)
                            lastMemories[m.item.id] = m;
                    });
                } else {
                    lastMemories = loaded.memories || {};
                }

                // --- 核心逻辑开始 ---
                if (is_swipe) {
                    // 🅰️ 【Swipe 模式】：亡者复苏
                    let resurrectionCount = 0;
                    for (const [key, mem] of Object.entries(lastMemories)) {
                        if (mem.life <= 0) {
                            mem.life = 1; // 临时复活
                            resurrectionCount++;
                        }
                    }
                    if (resurrectionCount > 0) {
                        logger.log(
                            `[Anima Echo] 🔄 检测到 Swipe: 临时复活了 ${resurrectionCount} 条僵尸记忆`,
                        );
                    }
                } else {
                    // 🅱️ 【Normal 模式】：垃圾回收 (GC)
                    const livingMemories = {};
                    let gcCount = 0;
                    for (const [key, mem] of Object.entries(lastMemories)) {
                        if (mem.life > 0) {
                            livingMemories[key] = mem;
                        } else {
                            gcCount++;
                        }
                    }
                    if (gcCount > 0) {
                        logger.log(
                            `[Anima Echo] 🧹 新对话开始: 清理了 ${gcCount} 条已枯竭的记忆`,
                        );
                        lastMemories = livingMemories;
                    }
                }

                // 🛠️ 赋值回 sessionData，此时类型匹配了 (都是对象)
                sessionData.memories = lastMemories;
            }

            // 3. 定义并行任务
            const tasks = [];

            let bm25ChatResults = [];
            let bm25KbResults = [];

            // --- 任务 A: 聊天记录检索 ---
            const chatTask = async () => {
                if (!vector) return [];
                const targetIds = Array.isArray(chatContext.ids)
                    ? chatContext.ids.filter((id) => id)
                    : [];
                if (targetIds.length === 0) return [];

                const rawIndices = (
                    await Promise.all(
                        targetIds.map((id) =>
                            getIndex(id, false).catch((e) => {
                                // 🚨 抓捕幽灵报错：把底层的崩溃原因打印出来
                                logger.error(
                                    `[Anima 致命抓捕] 加载库 ${id} 时底层崩溃:`,
                                    e,
                                );
                                return null;
                            }),
                        ),
                    )
                ).filter((i) => i !== null);

                const uniqueIndices = [...new Set(rawIndices)];
                if (uniqueIndices.length === 0) return [];

                const strat = chatContext.strategy;

                if (strat && strat.enabled) {
                    strat.searchText = searchText;
                    strat.rerankConfig = rerankConfig;

                    return await performDynamicStrategy(
                        uniqueIndices,
                        vector,
                        strat, // strat 里现在包含了 searchText 和 rerankConfig
                        safeIgnoreIds,
                    );
                } else {
                    // 简单模式
                    const simpleCount =
                        strat?.steps?.find((s) => s.type === "base")?.count ||
                        5;
                    const minScore = strat?.min_score || 0;
                    const recentWeight = strat?.recent_weight || 0;
                    const currentSessionId =
                        strat?.current_session_id || null;

                    let raw = await queryMultiIndices(
                        uniqueIndices,
                        vector,
                        simpleCount * 1.5,
                        null,
                        "SimpleChat",
                        recentWeight,
                        currentSessionId,
                        safeIgnoreIds,
                    );
                    raw["_debug_logs"] = raw["_debug_logs"] || [];
                    raw["_debug_logs"].push({
                        step: "Base",
                        library: "Simple",
                        score: 0,
                        tags: "No Strategy",
                    });
                    raw = raw
                        .filter((r) => r.score >= minScore)
                        .slice(0, simpleCount);
                    raw.sort((a, b) => {
                        const timeA = new Date(
                            a.item.metadata.timestamp || 0,
                        ).getTime();
                        const timeB = new Date(
                            b.item.metadata.timestamp || 0,
                        ).getTime();
                        return timeA - timeB;
                    });
                    return raw;
                }
            };
            tasks.push(chatTask());

            // --- 任务 B: 知识库检索 ---
            const kbTask = async () => {
                const targetIds = Array.isArray(kbContext.ids)
                    ? kbContext.ids.filter((id) => id)
                    : [];
                if (targetIds.length === 0) return [];

                const rawIndices = (
                    await Promise.all(
                        targetIds.map((id) =>
                            getIndex(id, false).catch(() => null),
                        ),
                    )
                ).filter((i) => i !== null);

                const uniqueIndices = [...new Set(rawIndices)];
                if (uniqueIndices.length === 0) return [];

                const strat = kbContext.strategy || { min_score: 0.5 };
                const simpleCount = strat.search_top_k || 3;
                const minScore = strat.min_score || 0.5;

                // 执行检索（N -> N：每个库取 simpleCount 条，聚合后截前 simpleCount 条）
                let raw = await queryMultiIndices(
                    uniqueIndices,
                    vector,
                    simpleCount,
                    null,
                    "KB",
                );

                raw = raw
                    .filter((r) => r.score >= minScore)
                    .slice(0, simpleCount);

                return raw;
            };
            tasks.push(kbTask());

            // 🟢 任务 C: BM25 聊天库检索
            const bm25ChatTask = async () => {
                if (!bm25Configs.chat || bm25Configs.chat.length === 0) return;

                const validBm25Text =
                    bm25SearchText && bm25SearchText.trim().length > 0
                        ? bm25SearchText
                        : null;
                const targetText = validBm25Text || searchText;
                if (!targetText || targetText.trim() === "") return;

                // =========================================================
                // ✨ 精准剥离“最新 User 意图”与“历史上下文” (强力抗干扰版)
                // =========================================================
                let userTextPool = "";
                let contextTextPool = "";

                // 统一使用物理截断，防止没有换行符的合并文本干扰
                const lowerTargetText = targetText.toLowerCase();
                const lastUserIdx = lowerTargetText.lastIndexOf("user:");

                if (lastUserIdx !== -1) {
                    contextTextPool = targetText.substring(0, lastUserIdx);
                    userTextPool = targetText.substring(lastUserIdx);
                } else {
                    userTextPool = targetText;
                }

                // =========================================================
                // ✨ 意图雷达 (探测时间极值)
                // =========================================================
                const intentFirstWords = [
                    "第一次",
                    "第一回",
                    "第一眼",
                    "第一面",
                    "首次",
                    "首回",
                    "初回",
                    "初次",
                    "最早",
                    "最初",
                ];
                const intentLastWords = [
                    "最后",
                    "最近",
                    "上次",
                    "上一次",
                    "上一回",
                    "上回",
                ];

                let temporalIntent = null;
                const lowerUserTextOnly = userTextPool.toLowerCase();

                if (
                    intentFirstWords.some((w) => lowerUserTextOnly.includes(w))
                ) {
                    temporalIntent = "first";
                } else if (
                    intentLastWords.some((w) => lowerUserTextOnly.includes(w))
                ) {
                    temporalIntent = "last";
                }

                // =========================================================
                // ✨ 分层扫描与收集
                // =========================================================
                let userTriggeredIndexes = [];
                let contextTriggeredIndexes = [];
                let hasTrigger = false;
                let totalRules = 0;

                const lowerUserText = userTextPool.toLowerCase();
                const lowerContextText = contextTextPool.toLowerCase();

                bm25Configs.chat.forEach((config) => {
                    const dict =
                        config.dictionary || config.dict || config.words || [];
                    totalRules += dict.length;

                    dict.forEach((rule) => {
                        const rawTrigger = rule.trigger || "";
                        const triggers = rawTrigger
                            .split(/[,，]/)
                            .map((t) => t.trim())
                            .filter(Boolean);
                        const indexWord = (rule.index || "").trim();

                        const actualTriggers = [...triggers];
                        if (indexWord && !actualTriggers.includes(indexWord))
                            actualTriggers.push(indexWord);

                        if (actualTriggers.length > 0) {
                            const hitUser = actualTriggers.some((t) =>
                                lowerUserText.includes(t.toLowerCase()),
                            );
                            if (hitUser) {
                                hasTrigger = true;
                                if (indexWord)
                                    userTriggeredIndexes.push(indexWord);
                            }
                            if (!hitUser) {
                                const hitContext = actualTriggers.some((t) =>
                                    lowerContextText.includes(t.toLowerCase()),
                                );
                                if (hitContext) {
                                    hasTrigger = true;
                                    if (indexWord)
                                        contextTriggeredIndexes.push(indexWord);
                                }
                            }
                        }
                    });
                });

                if (totalRules > 0 && !hasTrigger) {
                    logger.log(
                        `[Anima BM25] 🛑 未命中任何触发词，跳过 Chat 检索。`,
                    );
                    return;
                }

                // =========================================================
                // ✨ 阶梯式词频加权 (TF Boosting) & Debug 日志
                // =========================================================
                const chatTopK = bm25Configs.chat_top_k || 3;
                let intentResults = [];

                // 🌟 线路 A：如果探测到时间极值意图，交由特种部队处理
                if (temporalIntent && userTriggeredIndexes.length > 0) {
                    const uniqueUserEntities = [
                        ...new Set(userTriggeredIndexes),
                    ];

                    logger.log(
                        `[Anima BM25 Debug] ⏱️ 探测到时间极值意图: [${temporalIntent}] | 关联核心实体(仅User): [${uniqueUserEntities.join(", ")}]`,
                    );

                    intentResults = await bm25.temporalIntentSearch(
                        uniqueUserEntities,
                        bm25Configs.chat,
                        temporalIntent,
                        safeIgnoreIds,
                        ignoreCollectionId,
                    );

                    intentResults = intentResults.map((r) => {
                        r.score = 999.0;
                        r._is_intent = true;
                        return r;
                    });

                    logger.log(
                        `[Anima BM25 Debug] ⚡ 意图拦截执行完毕，提取了 ${intentResults.length} 条绝对时间切片。`,
                    );
                }

                // 计算剩余的 Top K 坑位
                const remainingK = Math.max(0, chatTopK - intentResults.length);
                let standardResults = [];

                // 🌟 线路 B：剩余坑位交由传统的 TF-IDF 模糊联想填充
                if (remainingK > 0) {
                    const cleanText = targetText
                        .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, " ")
                        .replace(/\s+/g, " ")
                        .trim();
                    let boostStrArr = [];

                    if (contextTriggeredIndexes.length > 0) {
                        const uniqueContexts = [
                            ...new Set(contextTriggeredIndexes),
                        ];
                        boostStrArr.push(uniqueContexts.join(" "));
                    }

                    if (userTriggeredIndexes.length > 0) {
                        const uniqueUsers = [...new Set(userTriggeredIndexes)];
                        boostStrArr.push(
                            uniqueUsers.map((t) => `${t} ${t} ${t}`).join(" "),
                        );
                    }

                    const finalBoostStr = boostStrArr.join(" ");
                    const boostedQuery = finalBoostStr
                        ? `${cleanText} ${finalBoostStr}`
                        : cleanText;

                    logger.log(
                        `[Anima BM25 Debug] 🚀 发往引擎的最终加权检索词 (Boosted Query):\n=> "${boostedQuery}"`,
                    );

                    standardResults = await bm25.searchPipeline(
                        boostedQuery,
                        bm25Configs.chat,
                        remainingK,
                        "chat",
                        safeIgnoreIds,
                        ignoreCollectionId,
                    );
                    logger.log(
                        `[Anima BM25 Debug] 📊 常规模糊检索执行完毕，返回了 ${standardResults.length} 条结果。`,
                    );
                }

                // 🌟 合并并去重
                const mergedMap = new Map();
                [...intentResults, ...standardResults].forEach((item) => {
                    const uniqueKey = item.index || item.id;
                    if (!mergedMap.has(uniqueKey)) {
                        mergedMap.set(uniqueKey, item);
                    }
                });

                const combinedResults = Array.from(mergedMap.values());

                // 解决前端显示 Unknown 数据库的问题
                bm25ChatResults = combinedResults.map((r) => {
                    const src =
                        r._source_db ||
                        r.dbId ||
                        r.collectionId ||
                        r._source_collection ||
                        r.source ||
                        "Unknown";
                    return {
                        ...r,
                        type: "bm25",
                        source: src,
                        _source_collection: src,
                    };
                });
            };
            tasks.push(bm25ChatTask());

            // 🟢 任务 D: BM25 知识库检索
            const bm25KbTask = async () => {
                if (!bm25Configs.kb || bm25Configs.kb.length === 0) return;

                const validBm25Text =
                    bm25SearchText && bm25SearchText.trim().length > 0
                        ? bm25SearchText
                        : null;
                const targetText = validBm25Text || searchText;
                if (!targetText || targetText.trim() === "") return;

                // =========================================================
                // ✨ 精准剥离“最新 User 意图”与“历史上下文”
                // =========================================================
                let userTextPool = "";
                let contextTextPool = "";

                const lines = targetText.split("\n");
                let lastUserIdx = -1;

                // 1. 倒序查找，精准定位“最后一楼 User”所在的行索引
                for (let i = lines.length - 1; i >= 0; i--) {
                    if (lines[i].trim().toLowerCase().startsWith("user:")) {
                        lastUserIdx = i;
                        break;
                    }
                }

                if (lastUserIdx !== -1) {
                    // 2. 将最后一楼 User 之前的所有行，全部归入辅助上下文
                    contextTextPool = lines.slice(0, lastUserIdx).join(" ");
                    // 3. 将最后一楼 User 及其之后的多行，归入强意图池
                    userTextPool = lines.slice(lastUserIdx).join(" ");
                } else {
                    // 兜底：如果没有 user: 前缀，统统算作强意图
                    userTextPool = targetText;
                }

                // =========================================================
                // ✨ 分层扫描与收集
                // =========================================================
                let userTriggeredIndexes = [];
                let contextTriggeredIndexes = [];
                let hasTrigger = false;
                let totalRules = 0;

                const lowerUserText = userTextPool.toLowerCase();
                const lowerContextText = contextTextPool.toLowerCase();

                bm25Configs.kb.forEach((config) => {
                    const dict =
                        config.dictionary || config.dict || config.words || [];
                    totalRules += dict.length;

                    dict.forEach((rule) => {
                        const rawTrigger = rule.trigger || "";
                        const triggers = rawTrigger
                            .split(/[,，]/)
                            .map((t) => t.trim())
                            .filter(Boolean);
                        const indexWord = (rule.index || "").trim();

                        const actualTriggers = [...triggers];
                        if (indexWord && !actualTriggers.includes(indexWord)) {
                            actualTriggers.push(indexWord);
                        }

                        if (actualTriggers.length > 0) {
                            // 先扫描 User 强意图池
                            const hitUser = actualTriggers.some((t) =>
                                lowerUserText.includes(t.toLowerCase()),
                            );

                            if (hitUser) {
                                hasTrigger = true;
                                if (indexWord)
                                    userTriggeredIndexes.push(indexWord);
                            }

                            // 如果 User 没命中，再看历史上下文有没有命中
                            if (!hitUser) {
                                const hitContext = actualTriggers.some((t) =>
                                    lowerContextText.includes(t.toLowerCase()),
                                );
                                if (hitContext) {
                                    hasTrigger = true;
                                    if (indexWord)
                                        contextTriggeredIndexes.push(indexWord);
                                }
                            }
                        }
                    });
                });

                // 如果配置了知识库词典但全都没命中，跳过检索
                if (totalRules > 0 && !hasTrigger) {
                    logger.log(
                        `[Anima BM25] 🛑 未命中任何触发词，跳过 KB 检索。`,
                    );
                    return;
                }

                // =========================================================
                // ✨ 阶梯式词频加权 (TF Boosting)
                // =========================================================
                const cleanText = targetText
                    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, " ")
                    .replace(/\s+/g, " ")
                    .trim();

                let boostStrArr = [];

                // 👉 辅助内容 (历史楼层)：重复 1 次
                if (contextTriggeredIndexes.length > 0) {
                    const uniqueContexts = [
                        ...new Set(contextTriggeredIndexes),
                    ];
                    boostStrArr.push(uniqueContexts.join(" "));
                }

                // 👉 核心意图 (最新 User)：重复 3 次
                if (userTriggeredIndexes.length > 0) {
                    const uniqueUsers = [...new Set(userTriggeredIndexes)];
                    const userBoost = uniqueUsers
                        .map((t) => `${t} ${t} ${t}`)
                        .join(" ");
                    boostStrArr.push(userBoost);
                    logger.log(
                        `[Anima KB BM25] 🎯 强意图命中(User)! 加权: [${uniqueUsers.join(", ")}]`,
                    );
                }

                const finalBoostStr = boostStrArr.join(" ");
                const boostedQuery = finalBoostStr
                    ? `${cleanText} ${finalBoostStr}`
                    : cleanText;

                const strat = kbContext.strategy || {};
                const bm25Count = strat.bm25_top_k || 3;

                const results = await bm25.searchPipeline(
                    boostedQuery,
                    bm25Configs.kb,
                    bm25Count,
                    "kb",
                );

                bm25KbResults = results.map((r) => {
                    const src =
                        r._source_db ||
                        r.dbId ||
                        r.collectionId ||
                        r._source_collection ||
                        r.source ||
                        "Unknown";
                    return {
                        ...r,
                        type: "bm25",
                        source: src,
                        _source_collection: src,
                    };
                });
            };
            tasks.push(bm25KbTask());

            // 4. 并行等待结果
            const [chatRaw, kbRaw] = await Promise.all(tasks);
            const collectedLogs =
                chatRaw && chatRaw["_debug_logs"]
                    ? chatRaw["_debug_logs"]
                    : [];
            // ============================================================
            // 🧠 回响机制集成 (Echo Mechanism Integration)
            // ============================================================
            let finalChatResults = chatRaw || [];

            if (sessionId && chatContext.ids && chatContext.ids.length > 0) {
                try {
                    logger.log(
                        `[Anima Echo] 🧠 启动回响处理... Session: ${sessionId}`,
                    );

                    // 🛠️ 直接使用预处理好的 lastMemories (含复活/GC后的状态)

                    // 获取全局校验池：复用 Base 检索池（原实现已注释掉二次检索）
                    const globalTop50 = chatRaw["_echo_pool"] || [];

                    logger.log(
                        `[Anima Echo] ♻️ 复用 Base 检索池: ${globalTop50.length} 条候选`,
                    );

                    // 3. 执行回响逻辑
                    let dynamicImpTags = ["important"]; // 默认兜底

                    if (
                        chatContext.strategy &&
                        chatContext.strategy.important &&
                        Array.isArray(chatContext.strategy.important.labels)
                    ) {
                        dynamicImpTags =
                            chatContext.strategy.important.labels.map((t) =>
                                t.toLowerCase(),
                            );
                        logger.log(
                            `[Anima Echo] 🎯 动态重要标签: ${dynamicImpTags.join(", ")}`,
                        );
                    }

                    // 合并配置
                    const finalEchoConfig = {
                        ...(echoConfig || {}),
                        important_tags: dynamicImpTags,
                    };

                    const { echoItems, nextMemories, echoLogs } =
                        processEchoLogic(
                            finalChatResults,
                            globalTop50,
                            lastMemories, // ✅ 传入
                            finalEchoConfig,
                        );

                    // 🟢 将回响日志注入到 finalChatResults 的调试日志中
                    if (echoLogs && echoLogs.length > 0) {
                        const formattedEchoLogs = echoLogs.map((l) => {
                            const hasMeta =
                                l.meta && typeof l.meta === "object";
                            let displayTags = l.info;
                            if (
                                hasMeta &&
                                Array.isArray(l.meta.tags) &&
                                l.meta.tags.length > 0
                            ) {
                                displayTags = `${l.info} 🏷️[${l.meta.tags.join(", ")}]`;
                            }
                            return {
                                step: "Echo",
                                library: "Memory",
                                uniqueID: hasMeta ? l.meta.index : "-",
                                tags: displayTags,
                                score: hasMeta ? l.meta.score : 0,
                            };
                        });
                        collectedLogs.push(...formattedEchoLogs);
                    }

                    // 4. 合并结果
                    if (echoItems.length > 0) {
                        logger.log(
                            `[Anima Echo] 🔗 成功回响插入 ${echoItems.length} 个旧记忆`,
                        );
                        finalChatResults = [...finalChatResults, ...echoItems];
                    }

                    // echoPersist:false 时这里是一个字节都不写的 no-op
                    await sessions.save(sessionId, {
                        lastUpdated: Date.now(),
                        memories: nextMemories,
                    });
                } catch (echoErr) {
                    logger.error(
                        `[Anima Echo] ❌ 回响处理失败 (不影响主流程):`,
                        echoErr,
                    );
                }
            } else {
                logger.log(
                    `[Anima Echo] ⚠️ 跳过回响 (无 SessionID 或 结果为空)`,
                );
            }

            if (finalChatResults.length > 0) {
                finalChatResults.sort((a, b) => {
                    const itemA = a.item.metadata;
                    const itemB = b.item.metadata;

                    // 1. Timestamp
                    const timeA = new Date(itemA.timestamp || 0).getTime();
                    const timeB = new Date(itemB.timestamp || 0).getTime();
                    if (timeA > 0 && timeB > 0 && timeA !== timeB) {
                        return timeA - timeB;
                    }

                    // 2. Index (Batch_Slice)
                    const parseId = (str) => {
                        const parts = (str || "0_0").split("_");
                        return {
                            batch: parseInt(parts[0] || 0),
                            slice: parseInt(parts[1] || 0),
                        };
                    };

                    const idA = parseId(itemA.index);
                    const idB = parseId(itemB.index);

                    if (idA.batch !== idB.batch) {
                        return idA.batch - idB.batch;
                    }
                    return idA.slice - idB.slice;
                });
            }

            // 6. 格式化输出函数
            const formatResults = (rawList) => {
                if (!rawList) return [];
                return rawList.map((r) => ({
                    text: r.item.metadata.text,
                    tags: r.item.metadata.tags,
                    score: r.score,
                    rerank_score: r._rerank_score,
                    timestamp: r.item.metadata.timestamp,
                    index: r.item.metadata.index,
                    chunk_index: r.item.metadata.chunk_index,
                    batch_id: r.item.metadata.batch_id,
                    source: r["_source_collection"] || "unknown",
                    doc_name: r.item.metadata.doc_name,
                    is_echo: r._is_echo || r.is_echo || false,
                    type: "vector",
                }));
            };
            const formattedVectorChat = formatResults(finalChatResults);
            const formattedVectorKb = formatResults(kbRaw);

            // ============================================================
            // 🧠 后端核心：双轨去重与排序逻辑
            // ============================================================

            // 1. Chat 结果去重合并 (Vector + BM25)
            const mergeAndSortChat = (vecList, bm25List) => {
                const uniqueMap = new Map();
                const all = [...(vecList || []), ...(bm25List || [])];

                all.forEach((item) => {
                    // 使用 index (如 "1_2") 或 id 作为唯一键
                    const uniqueKey = item.index || item.id;
                    if (!uniqueMap.has(uniqueKey)) {
                        uniqueMap.set(uniqueKey, item);
                    }
                });

                const merged = Array.from(uniqueMap.values());

                // 严格按时间线排序
                merged.sort((a, b) => {
                    const timeA = new Date(a.timestamp || 0).getTime();
                    const timeB = new Date(b.timestamp || 0).getTime();
                    if (timeA !== timeB) return timeA - timeB;

                    const idxA = String(a.index || "0_0");
                    const idxB = String(b.index || "0_0");

                    const [batchA, sliceA] = idxA.split("_").map(Number);
                    const [batchB, sliceB] = idxB.split("_").map(Number);

                    if (isNaN(batchA) || isNaN(batchB)) {
                        return idxA.localeCompare(idxB, undefined, {
                            numeric: true,
                        });
                    }
                    if (batchA !== batchB) return batchA - batchB;
                    return (sliceA || 0) - (sliceB || 0);
                });
                return merged;
            };

            // 2. KB 结果去重合并 (Vector + BM25)
            const mergeAndSortKb = (vecList, bm25List) => {
                const uniqueMap = new Map();
                const all = [...(vecList || []), ...(bm25List || [])];

                all.forEach((item) => {
                    // 使用文档名+切片序号作为复合唯一键
                    const fallbackId =
                        (item.doc_name || "unknown") +
                        "_" +
                        (item.chunk_index || 0);
                    const uniqueKey = item.id || fallbackId;

                    if (!uniqueMap.has(uniqueKey)) {
                        uniqueMap.set(uniqueKey, item);
                    }
                });

                const merged = Array.from(uniqueMap.values());

                // 先按文档名称，再按切片序号排序
                merged.sort((a, b) => {
                    const docA = a.doc_name || "";
                    const docB = b.doc_name || "";
                    if (docA !== docB) return docA.localeCompare(docB);
                    return (a.chunk_index || 0) - (b.chunk_index || 0);
                });
                return merged;
            };

            const finalMergedChat = mergeAndSortChat(
                formattedVectorChat,
                bm25ChatResults,
            );
            const finalMergedKb = mergeAndSortKb(
                formattedVectorKb,
                bm25KbResults,
            );

            // 7. 返回扩充后的全量对象，满足前端所有 UI 模块的日志需求
            // [搬] 原 /query 的 7 键 JSON 响应（index.js:3144-3159）→ return，逐字一致
            return {
                // [给 RAG / BM25 模块做独立日志用]
                vector_chat_results: formattedVectorChat,
                bm25_chat_results: bm25ChatResults,

                // [给 KB 模块做独立日志用]
                vector_kb_results: formattedVectorKb,
                bm25_kb_results: bm25KbResults,

                // [给底层步骤分析用]
                _debug_logs: collectedLogs,

                // [给拦截器直接注入 Prompt，以及主控台看最终结果用]
                merged_chat_results: finalMergedChat,
                merged_kb_results: finalMergedKb,
            };
        } catch (err) {
            logger.error(err);
            // [搬] 原 /query 的 500 JSON 响应 {success,message}（index.js:3160-3166）
            // → 进程内改为抛带 .code 的错（任务口径：优雅失败并留痕，不许静默吞掉）
            const wrapped = new Error(err?.message || "Unknown Query Error");
            wrapped.code = "ANIMA_QUERY_FAILED";
            wrapped.httpStatus = 500;
            wrapped.success = false;
            throw wrapped;
        }
    }

    // ==========================================
    // 📥 [搬] index.js:1282-1461 API: 存入
    // ==========================================
    async function insert(payload = {}) {
        // 1. 解构请求数据
        const {
            collectionId,
            text,
            tags,
            timestamp,
            apiConfig,
            index,
            batch_id,
            bm25Config,
        } = payload;

        if (
            !text ||
            typeof text !== "string" ||
            text.trim().length === 0 ||
            text === "(条目已丢失)" // 🟢 拦截特定错误文本
        ) {
            logger.warn(
                `[Anima RAG] ⚠️ 拒绝写入无效文本 (Index: ${index}) Content: ${text}`,
            );
            // [搬] 原 /insert 的 400 JSON 响应 {success,message}
            return {
                success: false,
                status: 400,
                message: "Text content is invalid or missing.",
            };
        }

        // 🛡️ 安全处理 batch_id (这是修复的核心)
        let safeBatchId = parseInt(batch_id);
        if (isNaN(safeBatchId)) {
            safeBatchId = -1;
        }

        let safeTimestamp = Number(timestamp);
        if (isNaN(safeTimestamp) || safeTimestamp <= 0) {
            // 如果传来的是 ISO 字符串，转为数字
            if (typeof timestamp === "string") {
                safeTimestamp = new Date(timestamp).getTime();
            }
            // 如果还是无效（比如 null/undefined），使用当前时间兜底
            if (isNaN(safeTimestamp) || safeTimestamp <= 0) {
                safeTimestamp = Date.now();
            }
        }

        try {
            return await writeQueues.run(collectionId, async () => {
                const vector = await getEmbedding(text, apiConfig);
                const targetIndex = await getIndex(collectionId);

                // =========================================================
                // 🧹 步骤 0: 写入前自检，清理旧的同名 Index (防重复核心)
                // =========================================================
                if (index !== undefined && index !== null) {
                    const allItems = await targetIndex.listItems();

                    // 1. 找出旧的同名切片
                    const duplicates = allItems.filter(
                        (item) =>
                            item.metadata &&
                            String(item.metadata.index) === String(index),
                    );

                    if (duplicates.length > 0) {
                        logger.log(
                            `[Anima RAG] 🔄 更新检测: 发现 Index ${index} 的旧版本 ${duplicates.length} 个，正在覆盖...`,
                        );

                        // 2. 构建删除计划
                        const safeName = collectionId.replace(
                            /[^a-zA-Z0-9@\-\._\u4e00-\u9fa5]/g,
                            "_",
                        );
                        const collectionPath = path.join(vectorRoot, safeName);

                        const deletionPlan = duplicates.map((item) => ({
                            id: item.id,
                            filePath: item.metadataFile
                                ? path.join(collectionPath, item.metadataFile)
                                : null,
                        }));

                        // 3. 执行物理 + 逻辑删除
                        const idsToDeleteFromBm25 = [];
                        for (const plan of deletionPlan) {
                            try {
                                await targetIndex.deleteItem(plan.id); // 删向量索引
                                idsToDeleteFromBm25.push(plan.id); // 🟢 记录旧 ID

                                if (
                                    plan.filePath &&
                                    fs.existsSync(plan.filePath)
                                ) {
                                    fs.unlinkSync(plan.filePath); // 删文件
                                }
                            } catch (e) {
                                logger.warn(
                                    `[Anima] 覆盖清理旧文件失败: ${e.message}`,
                                );
                            }
                        }

                        // 🟢 把旧数据的幽灵从 BM25 引擎中彻底抹除
                        if (
                            idsToDeleteFromBm25.length > 0 &&
                            bm25Config &&
                            bm25Config.enabled
                        ) {
                            try {
                                await bm25.deleteDocuments(
                                    collectionId,
                                    idsToDeleteFromBm25,
                                );
                            } catch (bm25DelErr) {
                                logger.error(
                                    `[Anima BM25] 清理旧幽灵数据失败:`,
                                    bm25DelErr,
                                );
                            }
                        }
                    }
                }

                // =========================================================
                // 📝 步骤 1: 插入新版本
                // =========================================================
                const newItem = await targetIndex.insertItem({
                    vector: vector,
                    metadata: {
                        text,
                        tags,
                        timestamp: safeTimestamp,
                        index,
                        batch_id: safeBatchId,
                    },
                });

                logger.log(
                    `[Anima RAG] ✅ 写入成功 | Batch: ${safeBatchId} | Index: ${index}`,
                );
                if (bm25Config && bm25Config.enabled) {
                    try {
                        const dict = bm25Config.dictionary || [];

                        await bm25.upsertDocument(
                            collectionId,
                            {
                                id: newItem.id, // 使用和向量库相同的 ID，方便以后对照
                                text,
                                tags,
                                timestamp: safeTimestamp,
                                index,
                                batch_id: safeBatchId,
                            },
                            dict,
                            "chat",
                        );
                    } catch (bm25Err) {
                        logger.error(`[Anima BM25] ❌ 同步写入失败:`, bm25Err);
                        // 注意：BM25 写入失败不应该阻塞响应，仅打印日志
                    }
                }

                // [搬] 原 /insert 成功响应 { success: true, vectorId: newItem.id }
                return { success: true, vectorId: newItem.id };
            });
        } catch (err) {
            logger.error("[Anima RAG Insert Error]", err);
            // [搬] 原 /insert 的 500 JSON 响应 {success,message}
            return {
                success: false,
                status: 500,
                message: err?.message || "未知后端错误",
            };
        }
    }

    // [搬] index.js:1631-1645 GET /list（去 express 壳）
    function listCollections() {
        if (!fs.existsSync(vectorRoot)) {
            return [];
        }
        // 读取 vectors 文件夹下的所有文件夹名称
        const files = fs.readdirSync(vectorRoot, { withFileTypes: true });
        const dirs = files
            .filter((dirent) => dirent.isDirectory())
            .map((dirent) => dirent.name);
        return dirs;
    }

    // [搬] index.js:1647-1667 GET /bm25/list → lib/bm25.js list()
    function listBm25() {
        return bm25.list();
    }

    // 释放进程内缓存（无定时器/句柄持有；进行中的队列任务不受影响也未被等待）
    function close() {
        activeIndexes.clear();
        loadingPromises.clear();
        bm25.activeIndexes.clear();
    }

    return {
        query,
        insert,
        listCollections,
        listBm25,
        close,
        // 自测/上层排障用只读口（不属于钉死 API，不影响 7 键契约）
        _internal: {
            getIndex,
            queryIndexSafe,
            queryMultiIndices,
            performDynamicStrategy,
            processEchoLogic,
            chunkText,
            bm25,
            sessions,
        },
    };
}

export { createEngine as default };
