# Codex 交接：Unity Host 合同 / 接缝缺口

**报告方：** Grok（Unity Host）  
**规则：** 只报告，不修改 `Luoxia-Engine/contracts`、World Core、Server、PostgreSQL。  
**Schema 根：** 兄弟仓库 `Luoxia-Engine/contracts/`（下文路径均相对该目录）。

每条格式：缺口 → Schema 锚点 → 现有字段 → 缺失语义 → Unity 场景 → 建议所有者。

---

## Gap-1 — Session 引导不在 Client Bridge

| 项 | 内容 |
|----|------|
| Schema 锚点 | `client-bridge.v1.schema.json` → `$defs/ClientMessage` oneOf（仅 10 种，无 session open）；`$defs/ClientEnvelope.required` 含 `session_id`；`world-runtime.v1.schema.json` → `$defs/SessionView.required` 含 `session_id` + `basis_token` |
| 现有字段 | 任意 ClientEnvelope 必填 `session_id`；SessionView 含 `basis_token` / `view_revision` |
| 服务端现状 | architecture §10：`kernel.sessions.open` / 部署管理面签发；HTTP 仅 `POST /api/client-envelope` |
| 缺失语义 | 首包 `session_id` + `basis_token` + 可选首包 `session.view` 的 **正式机器合同** 路径 |
| Unity 场景 | 冷启动无法构造合法 ClientEnvelope → 无法 `dialogue.start` |
| 建议所有者 | **Codex + 部署网关**；未扩展 Bridge 前给出部署面最小交接 JSON Schema |
| Host 纪律 | `session.session_id` / `session.basis_token` 仅显式注入；缺失 fatal |

---

## Gap-2 — `client.ready` 无编排器

| 项 | 内容 |
|----|------|
| Schema 锚点 | `$defs/ClientReady`；`type` const `client.ready`；必填 `client_build_digest`, `supported_protocols` |
| Server 锚点 | `apps/server/src/application/client-command-router.ts` → default `client_command.router.unsupported` |
| 缺失语义 | 是否返回协议协商结果；是否占 Journal |
| Unity 场景 | 启动握手、build digest 上报 |
| 建议所有者 | Codex：实现编排 **或** 标明 v1 Host 不得发送 |

---

## Gap-3 — `client.ack` 语义未闭合

| 项 | 内容 |
|----|------|
| Schema 锚点 | `$defs/ClientAck`；`type` const `client.ack`；必填 `acked_message_id`, `view_revision` |
| Server 锚点 | router 无 case → unsupported |
| 缺失语义 | ACK 是否持久化、是否影响 outbox 重发、是否允许纯本地 |
| Unity 场景 | 可靠投递、去重 UI、重连避免重复 turn |
| 建议所有者 | Codex |

---

## Gap-4 — `session.resync_request` 无编排器

| 项 | 内容 |
|----|------|
| Schema 锚点 | `$defs/ResyncRequest`；`type` const `session.resync_request`；必填 `current_view_revision`, `reason_code`；**无** `basis_token` |
| Server 锚点 | router 无 case → unsupported |
| 缺失语义 | 成功是否保证全量 `session.view`；失败 `protocol.error.recoverability` 约定 |
| Unity 场景 | delta `base_view_revision` 不匹配、sequence gap |
| 建议所有者 | Codex |

---

## Gap-5 — `map.move` 无编排器

| 项 | 内容 |
|----|------|
| Schema 锚点 | `$defs/MapMove`；`type` const `map.move`；必填 `command_id`, `basis_token`, `destination` → `common` `$defs/EntityRef` |
| 文档 | architecture：成功 SessionView，失败 CommandResult |
| Server 锚点 | router 无 case |
| Unity 场景 | 地图移动（U5+）；U4 不依赖 |
| 建议所有者 | Codex |

---

## Gap-6 — Stage 上下行未端到端

| 项 | 内容 |
|----|------|
| Schema 锚点 | 上行 `$defs/StageInput` (`stage.input`)、`$defs/StageOutcomeProposal` (`stage.outcome_proposal`)；下行 `$defs/StageOpen` / `StageUpdate` / `StageClose` |
| Server | 上行无编排器；README：Stage outcome 命令阶段编排尚未实现 |
| 缺失语义 | 可玩 Stage 闭环 |
| Unity 场景 | U6；此前只预留模块 |
| 建议所有者 | Codex |

---

## Gap-7 — `dialogue.close` 无触发所有者

| 项 | 内容 |
|----|------|
| Schema 锚点 | `ClientMessage` oneOf **无** dialogue.close |
| 文档 | architecture：`dialogue.close` 仍无触发所有者 |
| Unity 场景 | UI 结束对话 |
| 建议所有者 | Codex 定所有者与消息前，Host **不得** 发明 close |

---

## Gap-8 — Transport：HTTP 批 vs 推送

| 项 | 内容 |
|----|------|
| 接缝 | `POST /api/client-envelope` → `ServerEnvelope[]`；合同传输无关 |
| 缺失语义 | v1 Unity 是否仅 HTTP 即可验收 U4 |
| Unity 场景 | U3 Transport 选型 |
| 建议所有者 | Codex 里程碑声明；Host 默认按 HTTP 命令批设计 U3/U4 |

---

## Gap-9 — JSON Schema 2020-12 在 Unity 的校验

| 项 | 内容 |
|----|------|
| Schema 锚点 | 各文件 `$schema` Draft 2020-12；跨文件 `$ref` |
| 缺失 | Engine 无 C# SchemaRegistry 交付物 |
| Unity 场景 | 入站先校验再路由；禁止 JsonUtility DTO 第二真相 |
| 建议所有者 | **Grok Host** U2/U3 选型；库不够再请 Codex 评估合同（优先换库） |

---

## Gap-10 — AssetProvider / Materialization 服务端未完

| 项 | 内容 |
|----|------|
| Schema 锚点 | `$defs/AssetBindingMessage` (`asset.binding`)；`$defs/ClientAssetBinding`；`common` `$defs/AssetContentRef` |
| README | AssetProvider adapter registry 尚未实现 |
| Unity 场景 | U7 |
| 建议所有者 | Codex Server 资产管线；Host 不伪造世界事实 |

---

## Gap-11 — 部署兄弟根可用性

| 项 | 内容 |
|----|------|
| 约定 | `{workspace_parent}/Luoxia-Deployment`（名称可配置，无盘符） |
| 现状 | 多机可能不存在该兄弟目录 |
| Unity 场景 | U3 真联调依赖部署模块 |
| 建议所有者 | 部署 / Codex；Host 只文档化 sibling 名 |

---

## 非缺口（已闭合）

| 主题 | 结论 |
|------|------|
| dialogue HTTP | `dialogue.start` / `dialogue.continue` → `dialogues.execute` |
| EventCard / player_day | 已有编排器 |
| basis_token | HMAC 并发令牌；Host 只存最新不透明串 |
| DialogueReply vs SessionView | Reply 低延迟；权威 turns 在 `SessionView.dialogues` |
| 未知命令 | `client_command.router.unsupported` |

## 请 Codex 优先回复（阻塞 U3/U4 冻结）

1. Session 引导的正式机器合同路径与字段列表？  
2. v1 Unity 是否允许仅 HTTP 完成 U4？  
3. `client.ack` / `session.resync_request` 是否 v1 必做服务端？  
4. 仅有 session_id+basis_token、无首包 view 时 Host 应如何取得首包 SessionView？