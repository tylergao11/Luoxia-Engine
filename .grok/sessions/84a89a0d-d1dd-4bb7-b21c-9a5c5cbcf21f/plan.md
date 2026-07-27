# Plan: 无 Unity 前置 — 合同接缝与路径无关准备工作

## Goal

在 **没有 Unity Editor / 不建正式 Unity 工程** 的前提下，把 Client Bridge 接口边界、合同缺口（交 Codex）、Host 模块蓝图、以及 **路径无关的兄弟目录约定** 固化成可交接产物，为日后 U2+ 扫清接口层障碍。

## 约束（硬）

- **不写死绝对路径**（禁止 `C:\Ai\...`、`D:\...` 作为默认配置或代码常量）。
- 布局只认 **工作区父目录下的兄弟根**，名称约定如下（盘符/父路径由本机决定）：

```text
{workspace_parent}/
  Luoxia-Engine/          # 本仓库（contracts / server）
  Luoxia-Unity/           # 未来 Host（本阶段可只放设计产物，不建 Unity Project）
  Luoxia-Deployment/      # 部署组合根（本阶段不创建，只预留名称）
```

- 解析规则：`workspace_parent = parent(Luoxia-Engine 根)`；兄弟路径 = `join(workspace_parent, "Luoxia-Unity")` 等。配置里只存 **相对名或相对片段**，运行时再解析。
- **Grok 不改** `contracts/*`、World Core、Server、PostgreSQL（Codex 所有）。缺口只报告。
- **不** 假 Server / 假 Provider / 手写 DTO 第二真相 / 把 Schema 复制改造成私有真相。
- **不** 创建完整 Unity 工程、不锁 Editor 版本（U2 另开）。
- **不** git commit/push，除非用户另说。

## 非目标

- 安装 Unity、创建 `ProjectSettings`、写 MonoBehaviour。
- 修改 Engine 合同字段或新增 Server 编排器实现。
- 在 Engine 仓库内塞 Unity 代码或第二套协议文档污染 `README`/`architecture`（AGENTS 真相源纪律）。

---

## 可做工作包（本 plan 执行范围）

### P0 — 路径与布局约定（无盘符）

产出（写入 **兄弟** `Luoxia-Unity/`，不进 Engine 业务树）：

| 产物 | 内容 |
|------|------|
| `Luoxia-Unity/HOST_LAYOUT.md` | 兄弟根命名、解析算法、禁止项 |
| `Luoxia-Unity/config/host.example.json` | 仅示例键；**无**默认 localhost 生产 URL、**无**绝对路径 |

配置键设计（示例形状，执行时按合同对齐）：

```json
{
  "server": {
    "base_url": null,
    "health_path": "/api/health",
    "client_envelope_path": "/api/client-envelope"
  },
  "workspace": {
    "engine_sibling_name": "Luoxia-Engine",
    "deployment_sibling_name": "Luoxia-Deployment",
    "contracts_relative": "contracts"
  },
  "session": {
    "session_id": null,
    "basis_token": null,
    "note": "由外部网关/部署管理面注入，不由 Host 猜"
  }
}
```

`base_url` / session 凭证：**必填由部署或本地显式配置注入**；缺失则明确失败，不默认。

### P1 — 合同消息冻结表（接口真相映射）

只读 `contracts/client-bridge.v1.schema.json` + `world-runtime` / `materialization` / `common`，产出：

| 产物 | 内容 |
|------|------|
| `Luoxia-Unity/docs/bridge-message-map.md` | 全部 ClientMessage / ServerMessage：`type`、必填字段、Unity 模块所有者、发送/消费、Server 今日是否有编排器 |

模块边界（与任务书一致，仅职责，不建 asmdef 文件除非后续 U2）：

```text
Luoxia.Contracts → Luoxia.Transport → Luoxia.Session
                 ↘ Luoxia.Dialogue / Presentation / Stage / Assets
Luoxia.UnityHost 组合根
```

### P2 — Codex 合同/接缝缺口交接包（Grok 只报告）

产出：`Luoxia-Unity/docs/codex-handoff-gaps.md`

已识别的真实缺口（执行时再逐条用 Schema 行级证据钉死）：

1. **Session 引导不在 Client Bridge**  
   - `sessions.open` 是 kernel/部署管理面；Bridge 无 session open ClientMessage。  
   - Unity 如何安全获得首包 `session_id` + `basis_token` + 首份 `session.view`？需 Codex 明确：**部署网关合同** 还是 **未来 Bridge 扩展**（Grok 不发明字段）。

2. **`client.ready` / `client.ack` / `session.resync_request`**  
   - Schema 有；router 今日 unsupported 或行为需钉死（ACK 是否入 Journal、resync 响应形状）。

3. **`map.move` / `stage.*` 命令**  
   - Schema 有；无编排器 → 明确失败。Unity 实现顺序：U4 对话优先，Stage/Map 等 Server 就绪。

4. **`dialogue.close`**  
   - architecture 写明无触发所有者；客户端不得猜关闭。

5. **入站校验库能力**  
   - 合同为 JSON Schema **2020-12** + 跨文件 `$ref`。Unity 侧库选型（如 JsonSchema.Net）与 **禁止手写 DTO 第二真相** 的边界写进 Host 设计；不在 Engine 装 C# 包。

6. **Transport 形态**  
   - 今日仅 HTTP 一请求一响应 `ServerEnvelope[]`。推送/WebSocket 属 Host/部署层；合同不绑传输。需 Codex 确认 v1 Unity 是否 **只做 HTTP 轮询式命令** 即可验收 U4。

7. **AssetBinding / Materialization**  
   - 消费边界已有；AssetProvider registry 服务端未完。U7 前只设计不实现。

每条缺口格式：`Schema 路径` + `现有字段` + `缺失语义` + `Unity 使用场景` + `建议所有者（Codex）`。

### P3 — Host 运行时状态所有权（防第二真相）

产出：`Luoxia-Unity/docs/state-ownership.md`

| 只属 Unity（可丢弃） | 只属 Server（禁止当本地真相） |
|----------------------|--------------------------------|
| 本地 sequence 游标、UI 播放进度、对象池 | WorldState、规则结果、NPC 台词权威 |
| 未 ACK 缓冲、连接状态 | basis_token 语义内容（只存最新下发值） |
| Stage 本地表现 SM | SessionView 对话集合（以 view revision 为准） |
| 资产缓存字节（digest 校验后） | command 结果权威、envelope sequence 分配 |

规则摘要（写入文档，供 U3/U4 实现）：

- `DialogueReply` = 低延迟；最终 turns 以同 revision `SessionView` 为准。  
- `SessionDelta` 必须 `base_view_revision` 匹配，否则 resync。  
- 断线重发 **保留原 command_id**，不换新 ID 重放玩家动作。  
- 未知 `type` / protocol / sequence gap → 明确失败，不降级。

### P4 — Contracts 消费策略（无第二真相）

产出：`Luoxia-Unity/docs/contracts-consumption.md`

- 开发期：从兄弟 `Luoxia-Engine/contracts/*.schema.json` **只读引用**（路径运行时解析，不写死盘符）。  
- 发布期：由部署流程把 **同一 digest 锁定** 的 schema 打进 Host 包；Host 不手改字段。  
- 校验：所有入站 `ServerEnvelope` 先 Schema 再路由；出站 `ClientEnvelope` 发送前校验。  
- 禁止：`JsonUtility` 镜像字段当真相；禁止私有 `Luoxia.Contracts.Dto.*` 复制 schema。

### P5 — 可选：纯设计级模块目录骨架（无 Unity、无编译）

若批准创建兄弟 `Luoxia-Unity` 目录，可放 **空目录 + README 职责说明**（无 `.csproj` / 无假运行时），例如：

```text
Luoxia-Unity/
  HOST_LAYOUT.md
  config/host.example.json
  docs/
    bridge-message-map.md
    codex-handoff-gaps.md
    state-ownership.md
    contracts-consumption.md
  src/   # 仅占位说明，U2 再落 asmdef
    Luoxia.Contracts/
    Luoxia.Transport/
    ...
```

**不** 在本阶段写入可编译 C#（避免无 Editor 时锁错 TFM/包版本）。

---

## 明确不做

| 项 | 原因 |
|----|------|
| 改 `contracts/*.schema.json` | Codex 独占 |
| 在 Engine 内加 Unity/C# | 污染 Server 包边界 |
| 默认 `http://127.0.0.1` 生产配置 | 任务书禁止 |
| 创建正式 Unity Project | 无 Editor；U2 另门禁 |
| 实现假 dialogue 回复 | 纪律禁止 |

---

## 执行步骤（批准后）

1. 解析 `workspace_parent = parent(当前 Engine 根)`（不假设盘符）。  
2. 若 `Luoxia-Unity` 不存在 → **创建** 兄弟目录（仅设计产物；若已存在非空且非本结构 → **先报告冲突，不覆盖**）。  
3. 写入 P0–P4 文档与 example config。  
4. 再扫一遍 schema，把 Codex 缺口表钉到具体 `$defs` / `const`。  
5. 交付：路径解析证明（打印相对关系，不写死绝对路径进文档正文）、文件清单、Codex 待办摘要。  
6. **停止**；不进入 U2。

## Success Criteria

- [x] 任意机器只要 Engine 与未来 Unity 为兄弟目录，文档中的解析规则可复现（无盘符常量）。  
- [x] Client/Server 消息映射表覆盖 schema 中全部 `type` const。  
- [x] Codex 缺口每条含 Schema 锚点 + Unity 场景 + 不发明字段。  
- [x] 状态所有权表可直接指导 U3/U4 实现。  
- [x] Engine 仓库 **无** 业务代码 diff（仅允许 `.agents` / `.grok` 会话 plan 类元数据）；**无** contracts 变更。  
- [x] 未创建 Unity `ProjectVersion.txt` / 未装包。

## Verification

- 列出 `join(parent(engine), "Luoxia-Unity")` 下文件树。  
- `git -C Luoxia-Engine status`：contracts/apps/packages 应 clean。  
- 抽查文档：无 `C:\` / `D:\` 作为推荐默认路径（允许在「本机探针附录」中出现一次性证据，且标明非默认）。  
- 对照 `client-bridge.v1.schema.json` 的 ClientMessage/ServerMessage oneOf 条目数 = 映射表行数。

## Blockers / 默认假设

- **兄弟目录名**默认固定为 `Luoxia-Unity` / `Luoxia-Deployment` / `Luoxia-Engine`（与任务书语义一致，仅去掉盘符）。  
- 若某台机器 Engine 文件夹名不同，靠配置项 `engine_sibling_name` 覆盖，文档/代码仍不写死盘符。  
- 产物落在 **Engine 外的兄弟 `Luoxia-Unity/`**，避免违反 AGENTS「不在 Engine 真相源堆临时文档」。

## 与任务书阶段关系

| 任务书 | 本 plan |
|--------|---------|
| U0 | 不重做装机；路径策略改为兄弟相对 |
| U1 | **深化并落盘**到兄弟 Host 设计树 |
| U2+ | **不做** |
| Codex | 只交缺口，不改合同 |

## 风险

- 在兄弟目录写设计文档 ≠ 合同变更；Codex 未响应前 Unity 仍不能发明 session 引导字段。  
- 无 Editor 时任何 C# 包版本选择都可能作废 → 故本阶段不写可编译代码。
