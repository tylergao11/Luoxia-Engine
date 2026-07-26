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

---

# RESULTS（批准后执行 · 2026-07-26）

## PLAN STATUS

**U0 + U1 EXECUTED · U2 BLOCKED ON EXPLICIT PATH/VERSION CONFIRMATION · NO UNITY PROJECT CREATED · NO CONTRACTS MODIFIED**

---

## Step 0 — 真相源 — DONE

已读：

| 路径 | 用途 |
|---|---|
| `.agents/grok-unity-owner-task.md` | 身份、Gate 通过、U0–U8、纪律 |
| `AGENTS.md` | 禁止第二真相、依赖方向、验证纪律 |
| `README.md` | 基础对话已闭合；尚无 Unity Runtime；HTTP 接缝 |
| `docs/architecture.md` | SessionView/basis/对话编排/客户端边界 |
| `contracts/common.v1.schema.json` | EntityRef、AssetContentRef、Uuid… |
| `contracts/client-bridge.v1.schema.json` | Envelope + 10 Client + 10 Server 消息 |
| `contracts/world-runtime.v1.schema.json` | SessionView、DialogueView、RenderNode… |
| `contracts/materialization.v1.schema.json` | VisualBinding 等（资产服务端侧） |

Schema 摘要（SHA256 前 16）：

- `A050DC99555BEAC1` client-bridge.v1
- `9B2B11951B030773` common.v1
- `A6B32B4DB4BD83D0` world-runtime.v1
- `FBC42E2A87A3922A` materialization.v1

未在 Engine 仓写入报告 md。

---

## Step 1 — Phase U0 环境预检 — DONE

### U0.1 Unity.exe

| 字段 | 值 |
|---|---|
| 路径 | `C:\Ai\Unity\2022.3.62f3c1\Editor\Unity.exe` |
| FileVersion | `2022.3.62.1451004` |
| ProductVersion | `2022.3.62f3c1_1623fc0bbb97` |
| ProductName | `Unity` |
| Company | Unity Technologies |
| Size | 89411408 |
| PE | MZ 有效 |
| LastWriteTime | 2025-11-27 |

**说明：** 此为 U0 候选证据，**不是**已锁定的正式 Runtime 版本；U2 须你/Codex 显式选定后写入工程。

### U0.2 模块与构建目标

| 项 | 证据 |
|---|---|
| PlaybackEngines | `windowsstandalonesupport`、`WebGLSupport` |
| modules.json selected | `webgl`、`documentation` |
| Docs | `...\Editor\Data\Documentation\en` = True |
| Windows Player 变体 | mono only：`win64_player_*_mono`、`win32_player_*_mono`（Variations 下无 il2cpp 变体） |
| windows-il2cpp 模块 | **未安装**（modules.json not selected） |
| Android/iOS/Mac/Linux | 未安装 |

### U0.3 工具链

| 组件 | 路径 / 结果 |
|---|---|
| mono | `...\MonoBleedingEdge\bin\mono.exe` 存在 |
| NetCoreRuntime | `...\NetCoreRuntime\dotnet.exe` 存在 |
| Roslyn | `...\DotNetSdkRoslyn` 存在 |
| UPM | `...\PackageManager\Server\UnityPackageManager.exe` 存在 |
| UnityEngine.dll | `...\Managed\UnityEngine.dll` 存在 |
| MSBuild.exe | Editor 树内 **0**（正常；编译走 Unity 自身） |
| batchmode | 调用形态：`Unity.exe -batchmode -quit -nographics -projectPath <CONFIRMED> -logFile <path>`；**禁止**对 Engine 根使用 |

### U0.4 Hub / 产品身份

| 产品 | 路径 | ProductName | FileVersion |
|---|---|---|---|
| Unity Hub | `C:\Program Files\Unity Hub\Unity Hub.exe` | Unity Hub | 3.3.3-c7 |
| Tuanjie Hub | `C:\Ai\Unity\Tuanjie Hub\Tuanjie Hub.exe` | Tuanjie Hub | 1.4.4 |
| 本 Editor | 上表 | **Unity**（非 Tuanjie 运行时） | 2022.3.62f3c1 |

### U0.5 是否已有 Luoxia Unity 项目

| 检查 | 结果 |
|---|---|
| `C:\Ai\Luoxia-Unity` | **不存在** |
| `C:\Ai` depth4 `ProjectVersion.txt` | **0** |
| Engine 根 ProjectSettings/Library/Assets/UserSettings/Temp/Logs | **均不存在** |
| `packages/manifest.json` UPM 污染 | **不存在** |
| `packages/` 内容 | 仅 `contracts-runtime`、`world-core` |
| `C:\Ai\Luoxia-Deployment` | **存在**（assets/content/operations/src…） |

### U0.6 真实缺口（只列不装不删）

1. 无正式 Unity Host 工程  
2. 无 Windows IL2CPP 模块（U8 Player 若要 IL2CPP 需另装；当前仅 Mono Player）  
3. 无 Android/iOS 等（U8 仅 Windows 时足够）  
4. Editor 树无 MSBuild.exe（不阻塞 Unity 编译）  
5. Session 打开 / 世界创建不在公开 `POST /api/client-envelope`（管理面/部署责任）  
6. U2 路径与版本锁尚未由人确认  

### U0.7 项目根目录建议

- **建议：** `C:\Ai\Luoxia-Unity`（与 Engine / Deployment 并列）  
- **禁止：** `C:\Ai\Unity\...` 安装树内；`C:\Ai\Luoxia-Engine` 内嵌  
- **状态：** 候选，**未创建**；非空冲突规则：先报告不覆盖  

---

## Step 2 — Phase U1 接缝蓝图 12 项 — DONE

### 1) ClientMessage / ServerMessage → Unity 责任

**ClientMessage（10）→ 发送方模块**

| type | 模块 | 责任 |
|---|---|---|
| `client.ready` | Transport/Host | 能力宣告（build digest + supported_protocols） |
| `client.ack` | Transport/Session | 确认已消费的 server message_id + view_revision |
| `session.resync_request` | Session | 请求全量 SessionView |
| `dialogue.start` | Dialogue | command_id + basis_token + recipient + locale + text |
| `dialogue.continue` | Dialogue | command_id + basis_token + dialogue_id + locale + text |
| `map.move` | Presentation/Host | 地图位移意图（U4 后） |
| `stage.input` | Stage | 本地输入意图（非世界提交） |
| `stage.outcome_proposal` | Stage | 提案 only |
| `event_card.trigger` | Presentation | 触发已发卡卡片 |
| `player_day.end` | Session/Host | 日终 |

**ServerMessage（10）→ 消费方模块**

| type | 模块 | 责任 |
|---|---|---|
| `session.view` | Session | **全量替换**权威 SessionView（含 basis_token、dialogues） |
| `session.delta` | Session | 严格 base_view_revision 匹配后应用 ViewChange |
| `command.result` | Session/Dialogue | accepted/rejected/**pending**；绑定 command_id |
| `dialogue.reply` | Dialogue | 低延迟 turn；权威集合仍以同 revision SessionView 为准 |
| `presentation.frame` | Presentation | 表现 ops（非世界真相） |
| `stage.open/update/close` | Stage | 本地 Stage 生命周期 |
| `asset.binding` | Assets | ClientAssetBinding 下载与 digest |
| `protocol.error` | Transport/Host | retry/resync/reconnect/fatal |

### 2) Envelope 字段所有者

来源：`client-bridge` `ClientEnvelope` / `ServerEnvelope` required：`protocol_version`、`envelope_type`、`message_id`、`session_id`、`sequence`、`message`；`correlation_id` 可选。

| 字段 | 生成 | 校验/消费 |
|---|---|---|
| `protocol_version` | 双方固定 `client-bridge.v1` | 未知 → 明确失败 |
| `envelope_type` | client / server | 方向校验 |
| `message_id` | 发送方 UUID | 幂等、ACK、去重 |
| `session_id` | **Server** 打开 Session 时 | 客户端全程回显；不得自造 |
| `sequence` | 发送方会话序；Server 侧 `engine_sessions.next_server_sequence` 为权威游标（architecture） | gap → 失败/resync |
| `correlation_id` | 可选；关联请求-响应 | 路由辅助，非世界真相 |
| 内层 `command_id` | **Client** 生成并保持身份 | 断线重发必须同 ID；Server journal 幂等 |
| 内层 `basis_token` | **Server** 经 SessionView/Delta 下发 | Client 只保存最新；命令携带 |

### 3) basis_token

- **保存：** 仅内存/会话运行时；来自最新 `SessionView.basis_token` 或 `session.delta.basis_token`  
- **替换：** 每次新 view_revision 的 View/Delta 覆盖  
- **失效：** architecture：View/World revision/Session/ControlBinding 变化即失效；旧 token 仅对**同 command_id 同正文重放**仍可恢复 journal 结果  
- **禁止：** PlayerPrefs 当权威；本地发明；TTL 猜测  

### 4) SessionView vs SessionDelta

- **session.view：** 整份 `SessionView` 替换（`world-runtime` `$defs/SessionView`）  
- **session.delta：** 要求 `base_view_revision` 精确等于本地当前 revision，再升到 `view_revision`，应用 `changes[]`  
- **ViewChange 闭合集合（仅 4 种）：**  
  - `render_node.upsert` / `render_node.remove`  
  - `goal_plans.replace`  
  - `world_time.set`  
- **不匹配 base → resync**（发 `session.resync_request`），禁止猜补  

### 5) dialogue.reply vs SessionView.dialogues

- `dialogue.reply`：`dialogue_id` + `DialogueTurnView`（**无** view_revision / basis_token 字段）  
- `SessionView.dialogues[]`：`DialogueView`（dialogue_id、day、participants、turns、status active|closed）为**权威集合**  
- UI 规则：reply 可作低延迟提示；同 revision 的 SessionView 到达后以 View 为准合并；禁止两份冲突真相；不展示 model request id / digest / 内部 dialogue revision  

### 6) Presentation / Stage 生命周期

```text
StageOpen  → 创建本地 Stage（module_id/scene_id/visible_context/allowed_input_types/bindings）
StageUpdate → 仅更新 visible_state（JsonObject）；升 stage_revision
StageInput / StageOutcomeProposal → 意图/提案，非 WorldState
StageClose → 幂等清理本地对象
PresentationFrame → 与 view_revision 对齐的表现 ops（可丢弃播放进度）
```

重连：本地 Stage 可丢弃，由后续 Server 消息重建。

### 7) RenderNode / AssetBinding / visible state

- **RenderNode**（SessionView / Presentation / Delta）：`node_id` 稳定身份；`node_kind` ∈ scene|portrait|cg|overlay|text|interaction_anchor；可选 subject/asset/text + parameters  
- **ClientAssetBinding**：binding_id、render_node_id、slot_id、`AssetContentRef{content_hash,media_type}`、fetch_uri  
- **身份：** content_hash 是资产身份，路径/URI 不是  
- **visible_state：** 自由 JsonObject；不得反向写 WorldState；未知原语 → 协议不兼容  

### 8) JSON Schema 2020-12 库能力

Unity 侧必须：

- Draft 2020-12  
- `$ref` 跨文件（common / world-runtime / client-bridge）  
- `oneOf` + `const` discriminator  
- `additionalProperties: false`  
- `format: uri`、pattern、enum  

原则：验证**正式 Schema 资源副本**（从 Engine contracts 同步为只读资源），不手写字段表当真相。

### 9) C# JSON 边界（防第二真相）

- 入站：原始 JSON → Schema 验证 → 只读 Validated 文档 API  
- 路由：`type` 闭合 map，未知 type 失败  
- **禁止：** `JsonUtility` 镜像 Schema；可写 DTO 复制字段真相；Zod/第二套模型  
- 出站：按 Schema 形状构造 JSON 对象后发送（字段集合以 Schema required 为准）  

### 10) 未来 asmdef 依赖图

```text
Luoxia.Contracts          （Schema 资源 + 验证入口；无 UnityEngine 业务）
    ↑
Luoxia.Transport          （HTTP、sequence、correlation、ACK、重连）
    ↑
Luoxia.Session            （session_id、basis_token、view revision、resync）
    ↑
Luoxia.Dialogue | Luoxia.Presentation | Luoxia.Stage | Luoxia.Assets
    ↑
Luoxia.UnityHost          （MonoBehaviour 组合根、UI/输入/场景）
```

- 无 BaseManager 继承树  
- UnityHost 不 import World Core  
- 与任务推荐一致；合同未要求改图  

### 11) 状态所有权

| 仅 Unity 可丢弃 | Server 独占（Unity 不得当真相缓存） |
|---|---|
| 动画/镜头/音频播放进度 | WorldState / apply_packet 结果 |
| 对象池、临时 GO | SessionView 权威字段（dialogues、player_entity_id…） |
| UI 滚动位置、输入草稿 | basis_token 语义、command 最终结果 |
| 本地 Stage 表现状态机 | Command Journal 阶段、model ambiguous |
| 资产下载缓存（须 digest 校验） | Entity 身份与关系、隐藏真相 |

### 12) 合同 / 接缝缺口（只报告，不改 contracts）

| ID | 缺口 | Unity 影响 | 建议所有者 |
|---|---|---|---|
| G1 | `session.delta` 的 ViewChange **不含** dialogues / event_cards / notices / event_budget / player 等 | 对话与卡片变化必须靠全量 `session.view` 或扩 delta；客户端不得本地补字段 | Codex：是否扩展 ViewChange 或保证对话必带 full view |
| G2 | `dialogue.reply` **无** view_revision / basis_token | 只能靠 envelope 序 + 后续 SessionView 对齐；UI 须容忍乱序窗口 | Codex 确认投递顺序保证；或补关联字段 |
| G3 | 公开 HTTP 仅 `POST /api/client-envelope`；**无** session.open / world.create 客户端消息 | U3 前须部署管理面提供 session_id + 初始 SessionView/token | 部署/Codex 管理 API |
| G4 | Envelope **强制** session_id，但 session 由 Server 创建 | 首包 chicken-egg：client.ready 也需已有 session | 部署约定：先管理面开 Session，再连 Unity |
| G5 | `correlation_id` 可选，无强制请求-响应对 | 客户端应用 command_id + sequence 为主关联 | 可接受；文档化即可 |
| G6 | `CommandResult.status=pending` 非完成 | UI 必须展示 pending/blocked，禁止兜底 NPC 文本 | 已有合同；Unity 实现纪律 |
| G7 | Stage `visible_state` / `visible_context` 为自由 JsonObject | 无通用字段表；依赖 StageModule 版本化约定 | 内容/StageModule + 不发明世界字段 |
| G8 | 传输层：当前 Server 为 HTTP JSON；Schema 未定义 WebSocket 帧 | U3 先实现 HTTP；WS 若需要由 Codex 扩合同 | Codex |
| G9 | `EntityRef.expected_revision` 可选；architecture 称对话投影不带越权 revision | 客户端发送 recipient 时只用 SessionView 给出的稳定 ref | 已对齐任务 §0 |
| G10 | materialization 服务端 VisualBinding vs 客户端 ClientAssetBinding | Unity 只消费 bridge 的 ClientAssetBinding | 清晰；无改合同 |

---

## Step 3 — U2 门禁 — BLOCKED（按 plan）

| 决策 | 状态 |
|---|---|
| 项目路径 | **未确认**（建议 `C:\Ai\Luoxia-Unity`） |
| Editor 版本锁 | **未确认**（候选 `2022.3.62f3c1`） |
| 工程创建 | **未执行** |

收到你明确确认路径 + 版本后，另开/续执行 Step 4–6（U2→U4）。

---

## Step 7 — 固定交接格式

| 项 | 内容 |
|---|---|
| **当前阶段** | U0 + U1 **完成**；U2 **阻塞于路径/版本确认** |
| **检查路径** | 见 U0 绝对路径；Schema 四文件；`C:\Ai\Luoxia-Deployment` 存在 |
| **已证明** | Editor 候选版本与模块；无正式工程；Engine 无 Unity 污染；ClientMsg=10/ServerMsg=10；12 项蓝图；缺口 G1–G10 |
| **合同缺口** | G1–G10（上表） |
| **需 Codex/你** | ① 确认 `C:\Ai\Luoxia-Unity` 或其它路径 ② 确认 Editor 版本锁 ③ G1/G3/G4 Session 发放方式 ④ 联调 Server 基址（非硬编码默认） |
| **下一步** | 你确认路径+版本 → U2 建工程 → U3 Transport → U4 对话链 |
| **Headless Dialogue Gate 阻挡** | **false**（任务 §0 已宣布通过） |
| **运行时阻塞** | 无 Unity 工程；Session 管理面未在本任务接通 |

---

## Verification — DONE

1. [x] U0 绝对路径 + 版本/模块列表  
2. [x] U1 12 项可回溯 Schema / architecture  
3. [x] `git status contracts/` 干净；未建测试工程；未创建 `Luoxia-Unity`；未污染 Engine  
4. [x] 未改 Server/contracts；未假 Server  

**EXECUTION CHECKLIST**

- [x] Step 0 真相源  
- [x] Step 1 U0 七项  
- [x] Step 2 U1 十二项  
- [x] Step 3 U2 门禁停止（待确认）  
- [x] Verification  
- [ ] Step 4–6 U2–U4（需路径/版本确认后）

