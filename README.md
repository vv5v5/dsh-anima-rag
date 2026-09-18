# dsh-anima-rag

把 SillyTavern 侧 Anima 的**检索核心**搬进 DeepSeek Harness，做成一个 DSH 插件：
向量 + BM25 双轨检索、rerank 拦截、echo（本地 FTS5 字面召回），
检索结果经 `system-prompt/assemble` 瀑布注入 RP 会话。

> ⚠️ **本仓库不并入 `dsh-memory-archive` 的代码** —— 两者是各自独立的插件。

## 上游与署名（许可义务，不是客套）

| | |
|---|---|
| 原项目 | **Anima-Memory-System** |
| 原作者 | **Ellina** |
| 原项目地址 | <https://gitee.com/Ellinav/Anima-Memory-System> |
| 原项目版本 | **3.3.6** |
| 原项目许可 | Attribution-NonCommercial 4.0 International (**CC BY-NC 4.0**) |

**本项目与上游的关系**：

> **独立重写**；检索核心与摘要准则移植自 Ellina 的 Anima-Memory-System（CC BY-NC 4.0）；
> **本仓库为 DSH 侧的维护方。**

⚠️ 刻意**不叫**"上游的分支" —— 这里不是 fork 的延续，是照它的算法重写一遍 DSH 插件。

### 移植范围

- **检索核心**：向量 + BM25 双轨检索、策略步、rerank 拦截
- **echo（回响）机制**：本地 FTS5 字面召回
- **摘要准则**：压缩指令模板的措辞（逐字对齐上游）
- ⛔ **不含**上游的任何预置私域数据

逐块搬运映射见 [`docs/ENGINE-NOTES-B.md`](docs/ENGINE-NOTES-B.md)。

## 许可

**CC BY-NC 4.0**（`package.json` 的 `license` 字段同为 `CC-BY-NC-4.0`）——
派生自 NC 作品，⛔ 不能整体挂 MIT。全文与场景限制见 [`LICENSE`](LICENSE)。

场景限制（沿用上游条件）：仅限个人学习与非商业性用途；禁止闭源商用、禁止转为付费插件/服务；不重新分发任何预置私域数据。
