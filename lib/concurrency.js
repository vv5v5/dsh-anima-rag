/**
 * 串行队列 —— 搬自 `plugins/anima-rag/index.js:490-501` 的 `runInQueue`。
 *
 * 语义原样照搬：**按 key 串行、不同 key 并行**。内部是 `Map<key, Promise>`，
 * 同一个 key 的任务按提交顺序链在前一个任务的 Promise 之后；某个任务抛错只被
 * `catch(() => {})` 吞进链尾占位（不让后续任务饿死），但 `run()` 返回的
 * taskPromise 本身照常 reject —— 调用方拿到的错误语义不变。
 *
 * 与原实现的差异：
 * - 从闭包 + 全局 `writeQueues` Map 改为工厂函数自持 Map（index.js 是模块级单例，
 *   这里每个 `createQueue()` 一个实例）；
 * - 新增 `size()`（当前追踪的 key 数。注意：原实现从不清除已完成的 key，
 *   这里保持一致，size 含已完成的 key —— 不做语义"修复"）。
 */

export function createQueue() {
    const queues = new Map();

    return {
        /**
         * 把 `task()` 追加到 `key` 的 Promise 链末尾并返回其 Promise。
         * @param {string|number} key
         * @param {() => Promise<any>|any} task
         * @returns {Promise<any>} task 本身的 Promise（失败照常 reject）
         */
        run(key, task) {
            if (!queues.has(key)) {
                queues.set(key, Promise.resolve());
            }
            // 将任务追加到该 key 的 Promise 链末尾
            const taskPromise = queues.get(key).then(() => task());
            queues.set(
                key,
                taskPromise.catch(() => {}),
            ); // 忽略错误防止阻塞队列
            return taskPromise;
        },

        /**
         * 当前追踪的 key 数（含已完成任务遗留的 key，与原实现"从不清理"的行为一致）。
         * @returns {number}
         */
        size() {
            return queues.size;
        },
    };
}
