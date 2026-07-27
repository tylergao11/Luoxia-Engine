# Client Bridge 消息映射（冻结表）

**Schema 真相源（只读）：** 兄弟 `Luoxia-Engine/contracts/client-bridge.v1.schema.json`  
**关联：** `common.v1.schema.json`、`world-runtime.v1.schema.json`、`materialization.v1.schema.json`  
**Server 路由证据：** `apps/server/src/application/client-command-router.ts`  
**协议常量：** `protocol_version = "client-bridge.v1"`

本表字段名以 Schema 为准。任务书昵称若冲突，以 Schema 胜。

---

## 0. Envelope 外壳

### ClientEnvelope（`$defs/ClientEnvelope`）

| 字段 | 必填 | 所有者 | 说明 |
|------|------|--------|------|
| `protocol_version` | 是 | 合同 | const `client-bridge.v1` |
| `envelope_type` | 是 | 合同 | const `client` |
| `message_id` | 是 | **Unity Transport** | 每条出站消息新 UUID；重发同 command 时策略见状态所有权 |
| `session_id` | 是 | **Session**（来自网关注入，非 Host 生成） | |
| `sequence` | 是 | **Unity Transport** | 客户端单调序列；与 Server sequence 独立 |
| `correlation_id` | 否 | **Unity Transport** | 关联请求/响应用于 UI |
| `message` | 是 | 业务模块 | `ClientMessage` oneOf |

### ServerEnvelope（`$defs/ServerEnvelope`）

| 字段 | 必填 | 所有者 | 说明 |
|------|------|--------|------|
| `protocol_version` | 是 | 合同 | const `client-bridge.v1` |
| `envelope_type` | 是 | 合同 | const `server` |
| `message_id` | 是 | **Server** | 可精确重放；Host 不得改写 |
| `session_id` | 是 | **Server** | 必须匹配当前 Session |
| `sequence` | 是 | **Server** | Session 级出站游标；Host 检测 gap |
| `correlation_id` | 否 | **Server** | 常关联 client message / command |
| `message` | 是 | 业务模块 | `ServerMessage` oneOf |

**HTTP 接缝（部署/Server，非 Schema 字段）：**

- `GET {base_url}{health_path}`
- `POST {base_url}{client_envelope_path}`：恰好一个 ClientEnvelope → 有序 ServerEnvelope 数组

`base_url` 必须由配置显式提供；禁止生产默认 localhost。

---

## 1. ClientMessage 全表

Schema：`ClientMessage` oneOf 共 **10** 种。

| `type` | Schema `$defs` | 必填字段 | Unity 模块 | 方向 | Server 编排器（今日） |
|--------|----------------|----------|------------|------|----------------------|
| `client.ready` | `ClientReady` | `type`, `client_build_digest`, `supported_protocols` | Transport + Host | 发送 | **无** → `client_command.router.unsupported` |
| `map.move` | `MapMove` | `type`, `command_id`, `basis_token`, `destination` (EntityRef) | Session / Presentation | 发送 | **无** |
| `stage.input` | `StageInput` | `type`, `basis_token`, `stage_instance_id`, `stage_revision`, `local_sequence`, `input_type`, `payload` | Stage | 发送 | **无** |
| `stage.outcome_proposal` | `StageOutcomeProposal` | `type`, `command_id`, `basis_token`, `stage_instance_id`, `stage_revision`, `outcome_type`, `outcome`, `evidence_digest` | Stage | 发送 | **无** |
| `client.ack` | `ClientAck` | `type`, `acked_message_id`, `view_revision` | Transport / Session | 发送 | **无** |
| `session.resync_request` | `ResyncRequest` | `type`, `current_view_revision`, `reason_code` | Session | 发送 | **无** |
| `dialogue.start` | `DialogueStart` | `type`, `command_id`, `basis_token`, `recipient`, `locale`, `text` | Dialogue | 发送 | **有** `dialogues.execute` |
| `dialogue.continue` | `DialogueContinue` | `type`, `command_id`, `basis_token`, `dialogue_id`, `locale`, `text` | Dialogue | 发送 | **有** `dialogues.execute` |
| `event_card.trigger` | `EventCardTrigger` | `type`, `command_id`, `basis_token`, `event_card_id` | Presentation / Dialogue UI | 发送 | **有** `eventCards.execute` |
| `player_day.end` | `PlayerDayEnd` | `type`, `command_id`, `basis_token` | Session / Presentation | 发送 | **有** `playerDays.execute` |

### 命令类共性

含 `command_id` + `basis_token` 的消息：

- `command_id`：Unity 生成 UUID；**同一玩家动作重发必须保留同一 command_id**。
- `basis_token`：仅使用最新 `SessionView` / `session.delta` 下发值；过期由 Server 拒绝或按 Journal 幂等恢复。
- 玩家 Entity **不得** 由客户端自造；来自 `SessionView.player_entity_id`。
- `dialogue.start.recipient` 必须来自服务端投影的稳定 `DialogueParticipantRef`，不得按显示名猜。

### 非命令类

- `client.ready`：无 `command_id` / `basis_token`。
- `client.ack`：确认已处理的 Server `message_id` + 本地已应用 `view_revision`。
- `session.resync_request`：delta 失败或 sequence 异常时请求全量；**无** `basis_token` 字段（以 Schema 为准）。
- `stage.input`：有 `basis_token` 但无 `command_id`（输入意图，非世界命令身份）。

---

## 2. ServerMessage 全表

Schema：`ServerMessage` oneOf 共 **10** 种。

| `type` | Schema `$defs` | 必填字段 | Unity 模块 | 消费规则 |
|--------|----------------|----------|------------|----------|
| `session.view` | `SessionViewMessage` | `type`, `view` → `world-runtime` `SessionView` | Session + Presentation + Dialogue | **全量替换**本地不可变快照；更新 `basis_token`、`view_revision` |
| `session.delta` | `SessionDeltaMessage` | `type`, `base_view_revision`, `view_revision`, `basis_token`, `changes[]` | Session + Presentation | 仅当本地 revision == `base_view_revision` 时严格应用；否则 resync |
| `command.result` | `CommandResult` | `type`, `command_id`, `status` (`accepted`\|`rejected`\|`pending`), `view_revision`；可选 `code`, `message` | Session / UI | `pending` 不是完成；展示状态，不生成兜底剧情 |
| `presentation.frame` | `PresentationFrame` | `type`, `frame_id`, `view_revision`, `operations[]` | Presentation | 按 `PresentationOp` 闭合 map 执行；未知 op → 协议不兼容 |
| `stage.open` | `StageOpen` | `type`, `stage_instance_id`, `stage_revision`, `module_id`, `scene_id`, `visible_context`, `allowed_input_types`, `bindings` | Stage + Assets | 创建本地 Stage 实例；bindings 交给 Assets |
| `stage.update` | `StageUpdate` | `type`, `stage_instance_id`, `stage_revision`, `visible_state` | Stage | 只更新允许的可见状态 |
| `stage.close` | `StageClose` | `type`, `stage_instance_id`, `stage_revision`, `reason_code` | Stage | 幂等清理本地表现 |
| `asset.binding` | `AssetBindingMessage` | `type`, `binding` (`ClientAssetBinding`) | Assets | 按 `binding_id` + asset digest 拉取；路径不是身份 |
| `protocol.error` | `ProtocolError` | `type`, `code`, `message`, `recoverability` (`retry`\|`resync`\|`reconnect`\|`fatal`)；可选 `details` | Transport + Host UI | 按 recoverability 分支；禁止静默吞掉 |
| `dialogue.reply` | `DialogueReplyMessage` | `type`, `dialogue_id`, `turn` (`DialogueTurnView`) | Dialogue | **低延迟**展示；最终对话集合以同 revision 的 `SessionView.dialogues` 为准 |

### SessionView 关键字段（消费侧）

`world-runtime` `$defs/SessionView` 必填：

`contract_version`, `record_type`, `session_id`, `view_revision`, `basis_token`, `player_entity_id`, `world_time`, `render_nodes`, `goal_plans`, `notices`, `day_cycle`, `event_budget`, `event_cards`, `dialogues`

Host 不得缓存隐藏 world revision 为“真相”；客户端不接收会泄密的全局 world revision（见 architecture）。

### ViewChange（delta 内）

| `change` | 载荷 |
|----------|------|
| `render_node.upsert` | `node` (RenderNode) |
| `render_node.remove` | `node_id` |
| `goal_plans.replace` | `goal_plans[]` |
| `world_time.set` | `world_time` |

### PresentationOp

| `op` | 要点 |
|------|------|
| `render_node.upsert` / `render_node.remove` | 稳定 node id，不按 GameObject 名猜 |
| `transition.play` | `transition_id` + `parameters` |
| `camera.set` | `camera_id` + `parameters` |
| `audio.play` / `audio.stop` | channel + asset ref |
| `particle.play` / `weather.set` | `effect_id` + `parameters` |
| `narrative.show` | `event_card_id` + `EventResultPresentationView`（含 dialogue_quote 投影） |

### ClientAssetBinding

必填：`binding_id`, `render_node_id`, `slot_id`, `asset` (AssetContentRef), `fetch_uri`  
身份以 content digest 为准，不以 URI 路径为准。

---

## 3. 非 Bridge 运行时消息（部署面）

下列 **不在** `ClientMessage` / `ServerMessage` oneOf 中，但 Host 生命周期需要：

| 能力 | 今日所有者 | Host 行为 |
|------|------------|-----------|
| 世界创建 | 部署 / `kernel.worldCreation` | 不通过匿名 Bridge |
| Session 打开 | 部署 / `kernel.sessions.open` | 注入 `session_id` + 首个 `basis_token`（及首包 view 若网关提供） |
| 账号鉴权 | 外部网关 | Host 不实现登录协议为 Engine 第二真相 |

详见 `codex-handoff-gaps.md` Gap-1。

---

## 4. StageModuleManifest

`client-bridge.v1` 顶层 oneOf 第三项：`envelope_type = stage_module.manifest`。  
由 **部署/内容** 提供，Server Registry 校验；Unity 构建解释 `entrypoint`（相对、禁止 `..` 与盘符）。  
Host 运行时不把 manifest 当 WorldState。

---

## 5. 推荐模块依赖（U2 落 asmdef）

```text
Luoxia.Contracts
  ← Luoxia.Transport
  ← Luoxia.Session
  ← Luoxia.Dialogue
  ← Luoxia.Presentation
  ← Luoxia.Stage
  ← Luoxia.Assets
Luoxia.UnityHost → 以上全部（组合根）
```

规则：闭合 discriminator map；无 `BaseManager` 继承树；未知 type 明确失败。

---

## 6. U4 纵向链（首条可玩，仅设计）

```text
网关注入 session_id + basis_token (+ 可选首包 session.view)
  → 玩家从 SessionView 选 NPC recipient
  → dialogue.start ClientEnvelope
  → ServerEnvelope[]: dialogue.reply? / session.view / command.result
  → UI 以 SessionView.dialogues 为权威 turns
  → dialogue.continue（同一 dialogue_id + 最新 basis_token）
```

不预先插入“权威 NPC 回复”；pending/blocked/ambiguous 必须可见。
