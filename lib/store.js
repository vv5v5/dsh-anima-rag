/**
 * 会话存储 —— 搬自 `plugins/anima-rag/index.js:126-173` 的 `loadSession` / `saveSession`。
 *
 * 语义原样照搬：
 * - `load()`：sessionId 为空 / 文件不存在 / 解析失败 / JSON 为假值 → 返回空骨架 `{ memories: [] }`；
 * - `save()`：sessionId 为空 → 静默 no-op；目录不存在则递归创建；写 `JSON.stringify(data, null, 2)`；
 * - 两个函数保持 async（原实现用 fs.promises），返回 Promise；
 * - 错误只打日志不抛出（原实现的 try/catch 吞错语义）。
 *
 * 与原实现的差异：
 * - `SESSION_ROOT`（`__dirname/data/sessions`）→ 参数 `sessionRoot`；
 * - `console` → `options.logger`；
 * - `options.persist: false` 时 `save()` 为**彻底 no-op**（连目录创建都不做，一个字节不落盘）；
 * - 新增 `path(sessionId)`：返回该会话的落盘路径（清洗规则与原实现一致），纯计算不碰磁盘。
 *
 * 清洗规则（原样）：`sessionId.replace(/[^a-zA-Z0-9@\-\._\u4e00-\u9fa5]/g, "_")`。
 */

import fs from "node:fs";
import path from "node:path";

function emptySession() {
    return { memories: [] };
}

export function createSessionStore(sessionRoot, options = {}) {
    const { persist = true, logger = console } = options;

    function sessionPath(sessionId) {
        const safeId = String(sessionId).replace(
            /[^a-zA-Z0-9@\-\._\u4e00-\u9fa5]/g,
            "_",
        );
        return path.join(sessionRoot, `${safeId}.json`);
    }

    return {
        /**
         * 会话文件的落盘路径（只做字符串计算，不触碰磁盘）。
         * @param {string} sessionId
         * @returns {string}
         */
        path(sessionId) {
            return sessionPath(sessionId);
        },

        /**
         * 读会话状态；任何失败都降级为空骨架（原实现语义）。
         * @param {string} sessionId
         * @returns {Promise<object>}
         */
        async load(sessionId) {
            if (!sessionId) return emptySession();
            try {
                const filePath = sessionPath(sessionId);

                if (!fs.existsSync(filePath)) return emptySession();

                const data = await fs.promises.readFile(filePath, "utf-8");
                return JSON.parse(data) || emptySession();
            } catch (e) {
                logger.warn(
                    `[Anima Session] Load failed for ${sessionId}: ${e.message}`,
                );
                return emptySession();
            }
        },

        /**
         * 写会话状态。persist:false 时是彻底 no-op。
         * @param {string} sessionId
         * @param {object} state
         * @returns {Promise<void>}
         */
        async save(sessionId, state) {
            if (!sessionId) return;
            if (!persist) return; // 只读模式：一个字节都不写
            try {
                if (!fs.existsSync(sessionRoot)) {
                    fs.mkdirSync(sessionRoot, { recursive: true });
                }

                const filePath = sessionPath(sessionId);
                await fs.promises.writeFile(
                    filePath,
                    JSON.stringify(state, null, 2),
                    "utf-8",
                );
            } catch (e) {
                logger.error(
                    `[Anima Session] Save failed for ${sessionId}: ${e.message}`,
                );
            }
        },
    };
}
