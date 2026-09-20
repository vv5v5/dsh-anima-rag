# NOTICE · 来源、许可与维护方

> 这份文件回答一件事：**本仓库里的东西是从哪来的、谁在维护、按什么条件用。**

## 上游（本仓库的移植来源）

| | |
|---|---|
| 原项目 | **Anima-Memory-System** |
| 原作者 | **Ellina** |
| 原项目地址 | <https://gitee.com/Ellinav/Anima-Memory-System> |
| 移植时的上游版本 | **3.3.6** |
| 原项目许可 | Attribution-NonCommercial 4.0 International（**CC BY-NC 4.0**） |

## 本仓库的定位

- ★ **本仓库是这次搬运的「DSH 侧维护方」**：把上游的**检索核心**移植进 DeepSeek Harness，
  并按 DSH 的扩展点（`system-prompt/assemble` 瀑布、`ctx.tools.register`、preset 行的 `isolate` realm…）**重写适配**。
- ⚠️ 因此刻意**不叫**"上游的分支 / fork"：这里不是 fork 的延续，是**照它的算法重写一遍 DSH 插件**。
  上游的更新不会自动流进来，需要人来对；对上游行为的**忠实度**以 `docs/ENGINE-NOTES-B.md` 的逐块映射为准。
- 维护者是 **DSH 侧**（本仓库的提交者）：issue / 行为差异都在本仓库处理，⛔ 不要拿去打扰上游作者。

## 许可与场景限制

**CC BY-NC 4.0**（`package.json` 的 `license` 字段同为 `CC-BY-NC-4.0`；全文见 [`LICENSE`](LICENSE)）——
派生自 NC 作品，⛔ **不能整体挂 MIT**。场景限制（沿用上游条件）：

- 仅限个人学习与非商业性用途；
- 禁止闭源商用，禁止转为付费插件 / 服务；
- **不重新分发任何预置私域数据**。

## 移植范围（含 ⛔ 明确不含的东西）

| 内容 | 状态 |
|---|---|
| 检索核心（向量 + BM25 双轨、策略步、rerank 拦截） | ✅ 移植并按 DSH 重写 |
| echo（回响）机制（本地字面召回） | ✅ 移植 |
| 摘要准则（压缩指令模板的措辞） | ✅ 逐字对齐上游 |
| 上游的任何**预置私域数据**（预置卡/世界书/词表…） | ⛔ **不含** |

逐块搬运映射见 [`docs/ENGINE-NOTES-B.md`](docs/ENGINE-NOTES-B.md)。

## 第三方

- **依赖**：`vectra` / `minisearch` / `adm-zip` / `js-yaml` / `zod` / `jieba-wasm` / `patch-package`
  —— 均为各自作者的作品（多为 MIT），按各自许可使用；本仓库不重新分发它们的源码（由 npm 安装）。
- **`patches/vectra+0.12.3.patch`**：对 `vectra` 的一处本地修补（`$in` / `$nin` 对**数组字段**
  要按元素判断，不许字符串子串误匹配 —— 本仓库的标签级检索依赖它）。`vectra` 本体为 MIT，
  该补丁随之以 MIT 提供。
- ⛔ 本仓库**不包含** `dsh-memory-archive` / `pmp-dsh-tavern` 的任何代码 —— 只与它们配合工作（互操作，非派生）。
