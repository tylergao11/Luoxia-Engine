# Plan: Unity Owner Task — U0 环境预检 + U1 接缝蓝图

## Task Card

```text
Goal: 完成任务书 U0（Unity 环境精确证据）与 U1（合同→Unity 责任蓝图），按 §9 交接格式交付；U2 仅在路径/版本显式确认后进入
Probe Flow: S（本机 Unity/部署路径）+ B（contracts 与 Codex/Grok 边界）+ U（可观察报告证据）+ D（任务书候选路径 vs 本机真实路径）
Success Criteria: U0 有精确路径/版本或明确“不存在”证据；U1 覆盖全部 Client/Server 消息映射、basis/revision/Dialogue/Stage/Asset 规则、asmdef 图、合同缺口清单；不改 Engine 合同/Server；不在 Engine 仓库写测试报告
Verification: 只读探针命令输出 + Schema/架构交叉核对；无假 Server、无建工程
Audit: .agents/grok-unity-owner-task.md, AGENTS.md, docs/architecture.md, contracts/{common,client-bridge,world-runtime,materialization}.v1.schema.json
Blockers: 预探针已显示 C:\Ai 整树不存在、候选 Unity.exe 不存在、部署目录不存在；U2 仍需用户/Codex 显式确认项目路径与 Editor 版本锁
```

## 背景与边界

来源：`.agents/grok-unity-owner-task.md`（2026-07-26 Headless Dialogue Gate 已通过）。

| 角色 | 范围 |
|------|------|
| **Grok** | Unity 全栈：环境、工程、Bridge、Transport、Session、UI、表现、Stage、资产、构建 |
| **Codex** | `contracts/`、World Core、PG、Session/Command、HTTP 生产者、里程碑验收 |
| **唯一接缝** | `contracts/*.schema.json` → ClientEnvelope / ServerEnvelope |

**硬禁止（执行期仍遵守）**

- 不改 Engine Server / World Core / PostgreSQL / 公开合同
- 不在 Engine 仓库创建测试报告、假实现、第二套 Schema/DTO 真相
- 不导入 GDJS / Cocos / 旧 LuoXia / QingYun / GameCastle 代码
- 不把任务书候选路径当作默认版本或默认项目根
- 不 git commit/push（除非用户明确要求）
- U2 前不创建 Unity 工程

**交付物落点**

- U0/U1 结果以**会话交接报告**交付（任务书 §5：不在 Engine 仓库写测试报告）
- 若需持久化交接副本，仅允许写在会话目录或用户显式批准的 Engine 外路径；**不**新增 `docs/` 架构副本

## 预探针已发现的 Drift（执行 U0 时复核并写进报告）

在本会话只读探针中（需 U0 再全量确认）：

| 任务书假设 | 本机现状（预探针） |
|------------|-------------------|
| `C:\Ai\Unity\2022.3.62f3c1\Editor\Unity.exe` | **不存在**；`C:\Ai` 整树不存在 |
| `C:\Ai\Luoxia-Unity` 候选项目根 | **不存在** |
| `C:\Ai\Luoxia-Deployment` 正式部署 | **不存在** |
| 常见 Unity Hub / Editor 路径 | Program Files / LocalAppData 等 **均未找到** |
| Engine 仓库 | `D:\Luoxia-Engine`（任务书写 `C:\Ai\Luoxia-Engine`，路径命名漂移） |
| 已有 Luoxia Unity 项目 | 预期无；预探针无 |

**含义**：U0 的核心产出很可能是「环境缺口清单 + 安装/路径决策请求」，而不是“版本可用证明”。U1 不依赖本机 Editor，可与 U0 并行完成。

## 范围

### 本 plan 执行范围（批准后立即做）

1. **Phase U0** — Unity 环境预检（只读）
2. **Phase U1** — 接缝与实现蓝图（只读分析 + 交接报告）
3. **U2 门禁包** — 向用户提出必须显式确认的路径/版本问题；**不**在未确认时建工程

### 明确不在本 plan

- U2 创建 Unity 项目
- U3–U8 实现（Bridge / 对话 UI / Stage / 资产 / Player）
- 修改 `contracts/*` 或 Server 代码
- 安装/卸载 Unity 模块
- 启动真实 Server 联调（U3 才需要；本阶段可记录 Server 接缝路径）

---

## Phase U0：环境预检（只读）

### 步骤

1. **Editor 二进制身份**
   - 全盘/常见路径搜索 `Unity.exe`、`Unity Hub.exe`、Tuanjie 相关路径
   - 对每个命中：`FileVersion` / `ProductVersion` / `ProductName` / 完整路径 / 文件大小 / 修改时间
   - 区分 Hub 目录名 vs 实际产品身份（防 Tuanjie 误判）

2. **安装完整性与模块**
   - 若找到 Editor 根：列出 `Editor/Data`、PlaybackEngines、已装模块目录
   - 至少报告：Windows Editor、WebGL、文档、实际可用 build target
   - 未找到则明确写「无已安装 Editor」

3. **工具链路径**
   - 随附 Mono / .NET / MSBuild / Package Manager / batchmode 可执行路径（存在则列绝对路径）
   - 验证 `Unity.exe -batchmode -quit -version` 类只读命令（若有 Editor）

4. **既有项目扫描**
   - 搜索含 `ProjectSettings/ProjectVersion.txt` 且名称/路径像 Luoxia 的工程
   - 预期：无；若有则报告精确路径与 `m_EditorVersion`，**不覆盖**

5. **部署与 Engine 路径对齐**
   - 核实 `D:\Luoxia-Engine` vs 任务书 `C:\Ai\Luoxia-Engine`
   - 核实部署目录是否在其他盘（`D:\`、`E:\` 等）存在等价物
   - 记录 Server 接缝：`GET /api/health`、`POST /api/client-envelope`（文档级，不要求本阶段联通）

6. **项目根目录建议（仅建议，不创建）**
   - 不得：Editor 安装目录、`Luoxia-Engine` 仓库内
   - 推荐候选（待用户确认）：例如 `D:\Luoxia-Unity`（因 `C:\Ai` 不存在，**不得**默认写 `C:\Ai\Luoxia-Unity`）
   - 若目标路径已非空：报告冲突，不覆盖

### U0 成功标准

- 每条结论带**绝对路径**或**明确不存在**证据
- 列出影响后续构建的真实缺口（缺 Editor / 缺模块 / 缺部署）
- **不**自行安装或删除任何东西

---

## Phase U1：接缝与实现蓝图（只读）

### 真相源（必须逐份读）

| 文件 | 用途 |
|------|------|
| `AGENTS.md` | Agent 禁令、依赖方向、Unity 版本锁规则 |
| `README.md` | 当前交付状态、无 Unity 接入、Server 入口 |
| `docs/architecture.md` | SessionView / basis_token / Bridge 语义 |
| `contracts/common.v1.schema.json` | Uuid、Identifier、共享原语 |
| `contracts/client-bridge.v1.schema.json` | Envelope 与全部 Client/Server 消息 |
| `contracts/world-runtime.v1.schema.json` | SessionView、Dialogue 视图等 |
| `contracts/materialization.v1.schema.json` | AssetBinding 相关 |

### 已从 Schema 预读的消息全集（U1 须逐条映射）

**ClientMessage**

- `client.ready`
- `map.move`
- `stage.input`
- `stage.outcome_proposal`
- `client.ack`
- `session.resync_request`
- `dialogue.start`
- `dialogue.continue`
- `event_card.trigger`
- `player_day.end`

**ServerMessage**

- `session.view`
- `session.delta`（及 revision 应用规则）
- `command.result`
- `presentation.frame`
- `stage.open` / `stage.update` / `stage.close`
- `asset.binding`（以 Schema 实际 type 名为准）
- `protocol.error`
- `dialogue.reply`

### U1 分析清单（任务书 §6 的 12 项）

1. 每种 Client/Server 消息的 **Unity 责任模块**（发送/消费/忽略/明确失败）
2. Envelope 字段所有权：`message_id`、`session_id`、`sequence`、`correlation_id`（谁生成、谁校验、谁持久）
3. `basis_token`：保存、替换、失效、过期命令重放边界
4. SessionView **全量替换** vs SessionDelta **严格 revision** 规则
5. DialogueReply vs `SessionView.dialogues`：低延迟 vs 权威集合，禁止双真相
6. PresentationFrame / StageOpen/Update/Close 生命周期
7. RenderNode / AssetBinding / Stage visible state 消费边界
8. JSON Schema **2020-12** 在 Unity 侧的库能力要求（验证入口，非第二真相）
9. C# JSON 边界：避免手写 DTO 成为第二真相（只读文档/JsonNode + Schema 校验策略）
10. 推荐 asmdef 依赖图（任务书建议模块，对照合同校验后定稿）
11. **仅属 Unity 的状态** vs **Server 拥有、Unity 不得当真相缓存** 的状态表
12. **合同缺口清单**（只报告，交给 Codex；不改 Schema）

### 推荐模块边界（U1 验证后可微调命名，不提前建工程）

```text
Luoxia.Contracts     ← Schema 资源 + 验证入口 + 只读 JSON 边界
Luoxia.Transport     ← HTTP/WebSocket、sequence、correlation、重连
Luoxia.Session       ← session_id、basis_token、view revision、resync
Luoxia.Dialogue      ← dialogue.start/continue + Reply/View 消费
Luoxia.Presentation  ← SessionView、RenderNode、PresentationFrame、Notice
Luoxia.Stage         ← Stage 生命周期、本地表现 SM、input/outcome proposal
Luoxia.Assets        ← AssetBinding、digest、缓存、实例生命周期
Luoxia.UnityHost     ← 组合根 MonoBehaviour、输入/UI/动画/音频接线
```

依赖方向：`UnityHost → {Session,Dialogue,Presentation,Stage,Assets,Transport}` → `Contracts`；禁止反向、禁止 import World Core。

### U1 成功标准

- 消息映射表完整（无遗漏 oneOf 成员）
- basis / revision / dialogue 双通道规则写清
- asmdef 图与状态所有权表可直接指导 U2/U3
- 合同缺口可独立交给 Codex（含：Schema 名、字段、缺失语义、Unity 使用场景）

---

## U2 门禁（本 plan 只准备问题，不执行创建）

批准 U0/U1 并交付报告后，**在进入 U2 前**必须得到用户/Codex 显式确认：

1. **正式 Unity 项目绝对路径**（建议默认讨论 `D:\Luoxia-Unity`，因 `C:\Ai` 不存在）
2. **选用的已安装 Editor 完整路径 + 版本**（U0 若无 Editor，则先安装再确认）
3. 版本锁写入位置约定：`ProjectVersion.txt`、`Packages/manifest.json`、`packages-lock.json`、部署配置
4. 确认目标路径为空或不冲突

未确认前：**零** `Unity.exe -createProject`、零 asmdef 文件写入。

---

## 执行顺序（批准后）

```text
并行：
  A. U0 全量环境探针与证据收集
  B. U1 Schema/架构精读与消息映射草稿
串行收束：
  C. 合并 U0+U1 为 §9 交接报告
  D. 列出 U2 待确认项 + Codex 合同缺口
  E. 停止（不建工程、不改合同）
```

## 交接报告模板（§9）

每个阶段输出固定块：

```text
当前阶段:
检查或修改的真实路径:
已证明的结果:
发现的合同缺口:
需要 Codex 处理的 Server 接缝:
下一步:
是否被 Headless Dialogue Gate 阻挡: 否（已通过）
```

总报告额外包含：

- U0 环境证据表
- U1 消息责任矩阵
- 状态所有权表
- asmdef 依赖图
- U2 确认问卷（路径/版本）

## 风险与残留

| 风险 | 处理 |
|------|------|
| 本机无 Unity | U0 如实报告；U1 仍可完成；U2 阻塞至安装+确认 |
| 任务书路径 `C:\Ai\...` 与本机 `D:\...` 不一致 | 报告 drift；项目根建议改用本机真实盘符 |
| 部署目录缺失 | 记录；U3 联调前需 Codex/部署侧恢复 |
| 合同对 Unity 验证库未指定 | U1 列为能力要求/缺口，不擅自选定并写进 Engine |
| Engine 内 `apps/gdjs-host`、`UI/` 资产 | 仅作参考边界；**禁止**迁入 Unity 作为兼容层 |

## 非目标重申

- 不做 U2–U8 实现
- 不安装 Unity
- 不修改 Engine 仓库业务代码/合同
- 不在 Engine 内提交测试工程或测试报告文件
