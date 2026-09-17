/**
 * ignore 过滤器 —— 搬自 `plugins/anima-rag/ignore_filter.js`（53 行）。
 *
 * 四个基础函数（normalizeCollectionId / normalizeIgnoreIds /
 * shouldApplyIgnoreToCollection / isIgnoredSliceId）**逐行照搬**，签名不变。
 *
 * `buildScopedIgnoreFilter` 按本库接口钉子的两参签名重塑：
 * 原实现是 `buildScopedIgnoreFilter(baseFilter, collectionId, ignoreCollectionId, ignoreIds)`
 * （每次查询时比对 collection），这里改为
 * `buildScopedIgnoreFilter(ignoreIds, currentSessionCollectionId)` ——
 * 返回一个**作用域闭包**：给定目标库名，仅当目标库就是当前会话库（或未指明会话库）
 * 时才给出 `{ index: { $nin: [...] } }` 过滤器，否则给 null。
 * 「把 ignore_ids 限定在当前会话库内生效」的判定逻辑原样保留在
 * `shouldApplyIgnoreToCollection` 里。原四参函数体照搬为
 * `buildLegacyScopedIgnoreFilter`，供需要"一次调用出 filter"的场景使用。
 */

export function normalizeCollectionId(id) {
    if (id === undefined || id === null) return "";
    return String(id).replace(
        /[^a-zA-Z0-9@\-\._\u4e00-\u9fa5]/g,
        "_",
    );
}

export function normalizeIgnoreIds(ids) {
    if (!Array.isArray(ids)) return [];

    return [
        ...new Set(
            ids
                .filter((id) => id !== undefined && id !== null)
                .map((id) => String(id).trim())
                .filter(Boolean),
        ),
    ];
}

export function shouldApplyIgnoreToCollection(collectionId, ignoreCollectionId) {
    if (!ignoreCollectionId) return true;
    return (
        normalizeCollectionId(collectionId) ===
        normalizeCollectionId(ignoreCollectionId)
    );
}

export function isIgnoredSliceId(sliceId, ignoreIds) {
    if (sliceId === undefined || sliceId === null) return false;
    const normalizedId = String(sliceId);
    return normalizeIgnoreIds(ignoreIds).includes(normalizedId);
}

/**
 * 生成"限定在当前会话库内生效"的 ignore 过滤器。
 * @param {Array<string|number>} ignoreIds 要屏蔽的切片 id（如最近 N 楼）
 * @param {string|number|null} currentSessionCollectionId ignore_ids 所属的当前会话库
 * @returns {(targetCollectionId: string|number|null) => {index:{$nin:string[]}}|null}
 *   传入目标库名：目标库匹配（或未指明当前会话库）时返回过滤器，否则返回 null；
 *   ignoreIds 为空时返回的闭包恒为 null。
 */
export function buildScopedIgnoreFilter(ignoreIds, currentSessionCollectionId) {
    const normalizedIds = normalizeIgnoreIds(ignoreIds);
    const ignoreCollectionId = normalizeCollectionId(currentSessionCollectionId);

    return (targetCollectionId) => {
        if (normalizedIds.length === 0) return null;
        if (
            !shouldApplyIgnoreToCollection(
                targetCollectionId,
                ignoreCollectionId,
            )
        ) {
            return null;
        }
        return { index: { $nin: normalizedIds } };
    };
}

/**
 * 原版四参函数体（`ignore_filter.js:36-53`）原样照搬，仅改名以腾出钉死的两参导出名。
 * 供"已有 baseFilter、一次性合成过滤器"的调用方使用。
 */
export function buildLegacyScopedIgnoreFilter(
    baseFilter,
    collectionId,
    ignoreCollectionId,
    ignoreIds,
) {
    const normalizedIds = normalizeIgnoreIds(ignoreIds);
    const filter = baseFilter ? { ...baseFilter } : {};

    if (
        normalizedIds.length > 0 &&
        shouldApplyIgnoreToCollection(collectionId, ignoreCollectionId)
    ) {
        filter.index = { $nin: normalizedIds };
    }

    return Object.keys(filter).length > 0 ? filter : null;
}
