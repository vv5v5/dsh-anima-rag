# dsh-anima-rag

把 SillyTavern 侧 Anima 的**检索核心**搬进 DeepSeek Harness，做成一个 DSH 插件：
**向量 + BM25 双轨检索**、策略步与 rerank 拦截、echo（本地回响），检索结果经 `system-prompt/assemble`
瀑布注入 RP 会话；既是**独立的检索工具**，也是这套酒馆 agent 的**记忆库检索端**。

> ⚠️ **本仓库不并入 [`dsh-memory-archive`](https://github.com/vv5v5/dsh-memory-archive) 的代码** ——
> 两者是各自独立的插件：记忆库管**读用与面板**，本插件管**检索与入库**。它们只通过**文件**和**官方扩展点**配合。

---

## 它做什么

| | |
|---|---|
| **检索** | 每轮装配时按会话取词 → 向量 + BM25 双轨 → 策略步（base / important / diversity）→ rerank 拦截 → 注入 system 段 `anima:memory` |
| **检索工具** | `anima_query`：模型可**主动**查历史（返回命中条数、正文、以及**为什么是 0 命中**的一行诊断） |
| **入库** | 把**摘要目录**里的摘要写进记忆库（向量 + BM25 **同一次调用**）：压缩后自动入库，也可手动触发 |
| **周目隔离** | 只召回**属于当前周目**的切片（切片带 `pt:<周目id>` 标签）；拿不到周目 ⇒ **本轮不注入**（宁可不出场，也不串味） |
| **回响** | echo：把**已经在上下文里**的历史与本轮命中对齐，避免重复注入；共享回响索引 |
| **入库维护** | 账本（文件名 + 内容签名，内容没变不重入）、孤儿元数据回收与隔离、被改名切片的对账 |
| **向量面板的那半边** | 读 `dsh-memory-archive` 写来的**请求单**执行动作（立即入库 / 重建 / 删向量库 / 删 BM25），并把**状态快照**与**回执**写回去给它显示 |

**向量生成的时机**（明确只有两处）：① **自动压缩入库时**（摘要进库 ⇒ 向量 + BM25 一起写）；
② **工具/检索调用时**（发现目标集合的向量库不存在 ⇒ 当场排队补建）。两处都有**反馈**：
给 agent 的（`anima_query` 的返回里带 `diagnostics`）与给人的（状态快照 + 面板回执）。

## 配置从哪来

**密钥与端点不读环境变量**，只来自记忆库的设置（`<DSH_HOME>/dsh-memory-archive/config.json` 的 `retrieval` 段）。
**两个模型各一套接口**（2026-09-20 起）—— 可以落在不同服务商上：

| | 向量模型 | 重排模型 |
|---|---|---|
| 接口地址（baseURL） | `url` | `rerankUrl`（**空 ⇒ 沿用 `url`**） |
| 模型名 | `model` | `rerankModel` |
| 密钥 | `key` | `rerankKey`（**空 ⇒ 沿用 `key`**） |

端点由 baseURL 推导：向量 = `url` + `/embeddings`；重排 = `rerankUrl` + `/rerank`
（已经以 `/rerank` 结尾就不再拼）。另有 `chatEnabled` = 是否参与检索。
⚠️ 重排那两项留空 ⇒ **逐条退回**改版前的行为（同一把 key、`url` + `/rerank`），老配置一字不用改。
读不到就回落本插件的默认值（**不吞环境凭据**）。

★ **「哪个周目」是会话优先，认不出来的会话当新会话**（2026-09-20）：检索的隔离闸与自动入库的目标，
按**这个会话**在 Tavern `catalog.json`/`timeline.json` 里归入的那个周目算；**认不出 ⇒ 不检索、不入库、
不注「最近 N 条总结」**（fail-closed，⛔ 不拿面板绑定值兜底 —— 那会让一条新会话去读/写**上一轮**的库）。
★ 会话若**同时**被两个周目引用（一个是它的 `rootSessionId`、另一个只是 timeline 里的 variant/继续）
⇒ 判给**它是根**的那个（顺序无关）—— 否则会把一条会话判到别的角色/周目去（真机踩过）。

数据根默认**指向 ST 侧现役 Anima 的数据**（`vectors/` + `data/bm25_indexes/` + `data/sessions/`）——
即「继承现有库」而不是新建一套；本插件自己的落点只有三个文件：
`ingest-ledger.json`（账本）· `ingest-state.json`（入库状态）· `panel-request/result.json` + `vector-info.json`（面板通道），
全在 `<DSH_HOME>/dsh-anima-rag/`。

## 安装

```sh
dsh plugin --profile <你的 profile 名> add github:vv5v5/dsh-anima-rag
```

装完**重启一次宿主**。本包**没有构建步骤**（`lib/` 里就是可直接运行的 JS）。

配套：记忆库面板在 [`dsh-memory-archive`](https://github.com/vv5v5/dsh-memory-archive)，
角色卡 / 世界书 / 周目在 [`pmp-dsh-tavern`](https://github.com/Player-MINEPIG/dsh-tavern)。两者都**可选**。

## 已知限制（如实）

| # | 限制 | 说明 |
|---|---|---|
| 1 | 拿不到当前周目 ⇒ **本轮不注入** | 这是**故意的**：宁可漏，也不跨周目串味 |
| 2 | 向量库里的切片**属于哪个周目看标签** | 绑定换了周目而库里切片没重打标 ⇒ 会一条都召不回（面板的体检行会**明说这一点**） |
| 3 | 面板动作**要等一轮** | 面板写请求单，本插件在**下一次装配**取走执行（进度与回执都在面板上） |
| 4 | 单测覆盖的是**纯逻辑与源码级判据** | 真机行为靠自检台 + 真机验收两步，⛔ 不靠"自述" |

## 开发

```sh
node _selftest-panel-request.mjs      # 面板通道的纯逻辑
node _selftest-ingest-kick.mjs        # 入库触发时机（含反证）
node _selftest-playthrough-isolate.mjs
```

改完记得：同步到部署副本 → 换进程重启 → 全量自检门跑一遍。

---

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
- **echo（回响）机制**：本地字面召回
- **摘要准则**：压缩指令模板的措辞（逐字对齐上游）
- ⛔ **不含**上游的任何预置私域数据

逐块搬运映射见 [`docs/ENGINE-NOTES-B.md`](docs/ENGINE-NOTES-B.md)。

## 许可

**CC BY-NC 4.0**（`package.json` 的 `license` 字段同为 `CC-BY-NC-4.0`）——
派生自 NC 作品，⛔ 不能整体挂 MIT。全文与场景限制见 [`LICENSE`](LICENSE)。

场景限制（沿用上游条件）：仅限个人学习与非商业性用途；禁止闭源商用、禁止转为付费插件/服务；不重新分发任何预置私域数据。
