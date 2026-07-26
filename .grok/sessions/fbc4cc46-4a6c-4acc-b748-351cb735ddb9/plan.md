# Plan：Luoxia Unity 全栈负责人（Gate 已通过 · 对齐后执行）

## Goal

承接 `.agents/grok-unity-owner-task.md`（2026-07-26 交接）：**Headless Dialogue Gate 已通过**，Unity 全部事项归 Grok。在**不发明协议、不污染 Engine、不假 Server** 的前提下，按 U0→U1→（显式确认路径/版本后）U2→U3→U4 推进，最终交付可连真实 Server 的 NPC 多轮对话纵向链；U5–U8 另开阶段。

**本 plan 批准后立即做的范围：**

1. **U0 复检**（只读证据，写进任务输出 / 本会话，不写 Engine 仓报告 md）
2. **U1 复检**（对照当前 `contracts/*` + architecture，刷新 12 项蓝图与合同缺口；不改 contracts）
3. **U2 前置决策清单**（路径 + Editor/Package 版本锁）——**仅在你/Codex 显式确认后**才创建工程
4. 确认后执行 **U2 建正式工程** → **U3 Client Bridge/Transport** → **U4 对话可玩闭环**

**明确不做（除非另授权）：**

- 改 `contracts/`、World Core、Server、PostgreSQL
- 把工程建在 `C:\Ai\Luoxia-Engine` 或 Editor 安装目录
- 假 Server / 硬编码剧情 / 第二套 Schema DTO 真相
- 测试工程、审计 Agent、无关重构
- 未确认路径时创建 `Luoxia-Unity` 或任意 Unity 项目
- 擅自 git commit / push

---

## 已核实的现状（plan 撰写时只读快照）

| 项 | 证据 |
|---|---|
| 任务门禁 | 任务 §0：**Gate 已通过**；Grok 可执行 U0/U1；U2+ 需显式确认路径与版本锁 |
| Server 接缝 | `GET /api/health`、`POST /api/client-envelope`；部署在 `C:\Ai\Luoxia-Deployment` |
| README | 基础 NPC `dialogue.start/continue` 已闭合；**尚无真实 Unity Runtime**（正确，工程未建） |
| 正式 Unity 根 | `C:\Ai\Luoxia-Unity` **不存在**（候选，非默认） |
| Engine 污染 | 先前 `ProjectSettings`/`Library`/`packages/manifest.json` **当前已不存在**；`packages/` 仅 `contracts-runtime`、`world-core` |
| Editor 候选 | `C:\Ai\Unity\2022.3.62f3c1\Editor\Unity.exe` 存在；FV=`2022.3.62.1451004` PV=`2022.3.62f3c1_1623fc0bbb97` ProductName=`Unity`（**候选证据，不自动当版本锁**） |
| 历史会话 | 旧会话在 Gate **未过**时完成过 U0+U1；本会话须按**当前磁盘与当前合同**复检，不得凭记忆当真相 |

---

## Execution Steps

### Step 0 — 真相源对齐（只读）

1. 通读任务 md 全文（身份、禁止项、U0–U8、交接格式、完成定义）。
2. 必读：`AGENTS.md`、`README.md`、`docs/architecture.md`。
3. 必读 Schema：`common.v1`、`client-bridge.v1`、`world-runtime.v1`、`materialization.v1`（字段以 Schema 为准，不凭记忆补）。
4. 结论只出现在任务输出 / 本会话 plan；**不**在 Engine 仓新增架构/测试报告 md。

### Step 1 — Phase U0：环境预检（只读，精确路径+版本）

1. `Unity.exe` FileVersion / ProductVersion / 安装完整性。
2. 已装模块与构建目标（PlaybackEngines、modules.json、文档路径）。
3. Mono / .NET / MSBuild / UPM / batchmode 路径与可用性。
4. Hub vs Editor vs Tuanjie 产品身份（不误判）。
5. 是否已有正式 Luoxia Unity 项目；Engine 根是否再出现污染。
6. 真实缺口清单（只列，不装不删）。
7. 项目根目录**建议**（默认倾向 `C:\Ai\Luoxia-Unity`）；禁止 Editor 安装目录与 Engine 仓内嵌。

### Step 2 — Phase U1：接缝蓝图（只读 12 项）

每条结论必须能指回 Schema `$defs` 或 architecture 章节：

1. 每种 ClientMessage / ServerMessage 的 Unity 责任映射  
2. message_id / session_id / sequence / correlation_id 所有者  
3. basis_token 保存 / 替换 / 失效  
4. SessionView 全量 vs SessionDelta 严格 revision  
5. DialogueReply vs SessionView.dialogues（禁止双真相）  
6. PresentationFrame / StageOpen / Update / Close 生命周期  
7. RenderNode / AssetBinding / Stage visible state 边界  
8. JSON Schema 2020-12 在 Unity 的校验库能力要求  
9. C# JSON 边界（防手写 DTO 第二真相；不用 `JsonUtility` 镜像 Schema）  
10. asmdef 依赖图（Contracts → Transport → Session → Dialogue/Presentation/Stage/Assets → UnityHost）  
11. 仅 Unity 可丢弃态 vs Server 独占态  
12. 合同缺口清单 → 只报告 Codex，不改 contracts  

### Step 3 — U2 门禁：显式确认（阻塞创建工程）

在创建任何 Unity 项目前，必须得到你的明确答复：

| 决策 | 默认建议 | 规则 |
|---|---|---|
| 项目根路径 | `C:\Ai\Luoxia-Unity` | 不得进 Editor 安装目录；不得进 `C:\Ai\Luoxia-Engine`；若目标非空先报告冲突，不覆盖 |
| Editor 版本锁 | 以 U0 实测候选 `2022.3.62f3c1` 为**可选** | **不得**从任务文档/Hub 当前选择推导默认；须你/Codex 显式选定后写入工程 `ProjectVersion.txt` + Packages lock + 部署配置 |
| 首切片范围 | U2→U3→U4 对话链 | 不提前铺 Stage/Asset 全量实现 |

未确认 → **停止在 U0+U1 交付**，不创建工程。

### Step 4 — Phase U2：创建正式 Unity 项目（仅确认后）

1. 用确认的 Editor 在确认路径创建空 Host 工程。  
2. 锁定 `ProjectVersion.txt`、`Packages/manifest.json`、`packages-lock.json`（及部署侧记录）。  
3. 建立 asmdef 骨架（无 BaseManager 继承树；无 GDJS/Cocos/旧项目代码）。  
4. 无默认 Server URL / 世界 / token / 内容。  
5. 验收：Editor 可开；batchmode 可编译。

### Step 5 — Phase U3：Client Bridge + 真实 Transport

1. 入站 ServerEnvelope 先经正式 Schema 资源验证，未验证不进业务路由。  
2. 未知 protocol version / message type / sequence gap / 字段 → 明确失败。  
3. Server 地址显式配置（不硬编码 localhost 作生产默认）。  
4. message ID、correlation、sequence、ACK、resync；断线不重放新 command_id 的同一动作。  
5. basis_token 只采用最新 SessionView/Delta 下发值。  
6. 联调对象：Codex/部署提供的真实 Server（`C:\Ai\Luoxia-Deployment` + 真实 PG/模型），禁止假响应。

### Step 6 — Phase U4：基础 NPC 对话可玩闭环

固定纵向链：

```text
选 NPC → 输入 → dialogue.start → CommandResult/DialogueReply/SessionView
→ UI 显示权威 NPC turn → dialogue.continue（同 dialogue_id + 最新 basis_token）→ 新 turn
```

硬规则：玩家/NPC 只来自 SessionView；UI 不预插权威回复；pending/blocked/ambiguous 可见；同 command 重发不重复 turn；DialogueReply 仅低延迟，权威集合以同 revision SessionView 为准；不展示 model request ID / digest / 隐藏 revision。

### Step 7 — 阶段交接输出（每阶段固定格式）

- 当前阶段  
- 检查或修改的真实路径  
- 已证明的结果  
- 发现的合同缺口  
- 需要 Codex 处理的 Server 接缝  
- 下一步  
- 是否被 Headless Dialogue Gate 阻挡 → **当前应为 false（任务已宣布通过）**；若 Server 实际不可用则单独报告运行时阻塞，不重新发明 Gate  

---

## Impact Scope

| 区域 | 影响 |
|---|---|
| `C:\Ai\Luoxia-Engine` | **默认只读**；不改 contracts/server/world-core；不写报告 md；不在仓内建 Unity |
| `C:\Ai\Luoxia-Unity`（确认后） | 新建完整 Host 工程与 asmdef/C# 模块 |
| `C:\Ai\Luoxia-Deployment` | 只读消费部署接缝与联调配置；不把密钥/内容写回 Engine |
| `C:\Ai\Unity\...` | 只读使用已装 Editor；不改安装树 |
| Git | 不 commit/push，除非你明确要求 |

---

## Risks / Irreversible Actions

| 风险 | 缓解 |
|---|---|
| 再次在 Engine 根跑 Unity 污染 monorepo | U2 强制独立路径；batchmode 的 `-projectPath` 必须是确认根 |
| 未确认就建工程 / 覆盖非空目录 | Step 3 硬阻塞；非空先报告 |
| 手写 DTO / 第二 Schema | U1/U3 强制 Schema 资源校验 + 闭合 discriminator；禁 `JsonUtility` 镜像字段 |
| 假 Server 换演示 | U3/U4 只连真实部署；缺环境则停并报告 |
| 把候选 Editor 当默认版本锁 | U2 前显式确认；锁写入工程自身文件 |
| 改 Engine 合同“方便客户端” | 缺口只上报 Codex |

**需你确认才执行的破坏性/共享动作：** 删除任何路径、覆盖非空目录、git commit/push、安装/卸载 Unity 模块。

---

## Verification

- **U0**：每条结论带绝对路径与实测版本/目录列表。  
- **U1**：12 项均可回溯 Schema/`architecture.md`；缺口可独立交 Codex。  
- **U2**：确认路径下工程可 Editor 打开 + batchmode 编译；版本锁在工程内自描述。  
- **U3/U4**：真实 `POST /api/client-envelope` 多轮对话；无重复 turn；无假回复；未知消息明确失败。  
- **纪律**：`contracts/` 无本任务改动；无测试工程；无 Engine 内 Unity 污染复现。  
- **轻量验证**：不做测试工程/审计 Agent；实现后只做与风险相称的一次验证（打开/编译/真实联调路径）。

---

## 需要你对齐的决策（批准 plan 时可一并答复）

1. **角色**：Unity 全栈归 Grok；contracts/Server 归 Codex —— 按任务执行。  
2. **项目路径**：是否确认 `C:\Ai\Luoxia-Unity` 为正式根？（或给出绝对路径）  
3. **Editor 版本**：是否锁定本机候选 `2022.3.62f3c1`，或指定其他已装版本？  
4. **批准后节奏**：  
   - **A（推荐）**：先做完 U0+U1 复检并交付 → 你确认路径/版本 → 再 U2–U4  
   - **B**：你现在就确认路径+版本，批准后连续 U0→U4  
5. **Engine 污染**：当前已干净；若复检再出现，先报告再清（需授权）。  

**一句话：** Gate 已开，正式工程未建；先复检 U0/U1 把接缝钉死，路径与版本你一点头，再纵向打穿 U2→U4 真实对话，全程不碰假 Server、不发明协议、不污染 Engine。
