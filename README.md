# Luoxia Engine

Luoxia Engine 是一个始终联网、服务端权威、内容包驱动的 AI 世界平台。

平台固定包含：

- **World Core**：世界图、规则、模型编排、存档，以及唯一权威入口 `apply_packet`；
- **System**：Director 的玩家专属常驻模式，负责目标解析、可行路径导航与世界缺口补全；
- **Client Runtime**：Unity 是唯一目标客户端与 Stage Runtime（场景、动画、状态机、音效与舞台表现）；公开 Bridge 保持引擎中立，以维持 World Core 的正确依赖边界；
- **ContentBundle Loader**：校验并加载外部、版本化、不可变的 ContentBundle JSON；
- **Materialization Pipeline**：把运行时新实体与新定义绑定为持久视觉资产。

核心承诺：玩家提出符合世界基本规则的目标，而世界没有预设入口时，Director 的 System 模式会依据现有规则回复、规划或补全最小世界入口。System 可以修路，但不替玩家走路，也不免费创造结果。

事件权限固定为：只有 Director 拥有事件调用上下文并能提出事件；System 只是 Director 的一个模式。RulePlugin 只裁决，只有 World Core 可以通过 `apply_packet` 把结果变成世界事实。EventCard 在发出时完成裁决、结果封存与 AP 扣除，点击时只校验前置条件并应用封存结果。

当前设计阶段直接使用外部 ContentBundle JSON：内容作者与内容 Agent 按 [`contracts/content-bundle.v1.schema.json`](contracts/content-bundle.v1.schema.json) 编写，Engine 校验后加载并按 digest 锁定。暂不建立 Excel、CSV 或内容编辑器编译链；未来若增加策划工具，它也只能生成同一份 ContentBundle JSON，不能成为第二真相。

当前仓库已进入可编译骨架阶段。架构边界见 [`docs/architecture.md`](docs/architecture.md)，运行时精确 JSON 形状仍以 [`contracts/`](contracts/) 中的 Schema 为唯一真相。

## 当前骨架

```text
contracts/
packages/contracts-runtime/   Schema Registry、RFC 8785 摘要、ContentBundle 边界
packages/world-core/          唯一 apply_packet 门面与组合入口
apps/server/                  Model/RulePlugin 网关、在线服务入口
```

当前尚无真实 Unity Runtime 接入。Unity 已成为唯一目标 Client / Stage Runtime；v1 不建设通用或跨引擎 StageModule 制品加载器。公开 Client Bridge 继续保持引擎中立，但只服务正确的 Server / World Core 依赖边界，不承诺其他引擎 Host 或跨引擎制品兼容。

- 七份 Draft 2020-12 Schema 在服务启动时统一加载并解析引用；未知合同、非法输入与关联字段不一致都会明确失败。
- ContentBundle Loader 只接受纯 JSON，核对 `release.bundle_digest` 后再进入语义门禁；`createContentBundleSemanticGate` 提供本包 ID 唯一性、本地引用解析、RuleRef 锁定、Prompt purpose、FieldValues 与 `InitialVisibility` 校验。`known_to` 只能引用符号玩家或本包本地 Entity；玩家起点 fields 按其 relation type 校验。没有 Excel、编译器字段或兼容入口。
- **`createContentRuntimeCatalog`**（`@luoxia/world-core/composition`）对已 load 且 digest 锁定的 ContentBundle 建立进程内只读索引：实现 `StaticComponentDigestLookup`，并解析 `RuleRef → WorldLaw.evaluator + required rule_plugin DependencyLock`。`resolveWorldContentBinding(WorldContentLock)` 按 `pack_id + bundle_digest + pack_version + world_definition_id` 精确命中，返回同包同世界的 DirectorProfile、玩家初始化声明及该世界全部 operation bindings；`listRulePluginOperationBindings` 穷举 v1 的 16 类字段 owner，不按 kind、顺序或数量猜插件。Catalog 与世界创建共用唯一 `ContentRuntimeIdentityMapper`，Server adapter 按 RFC 9562 UUIDv5 将本地 Identifier 映射为 runtime UUID：namespace 是 runtime `world_id`，name 是 UTF-8 `pack_id + "\0" + kind + "\0" + local_id`，当前闭合 kind 为 `entity`、`relation`、`state_machine_binding`。
- World Core 对普通调用方只暴露 `applyPacket`；语义校验器、纯状态变换与原子事务存储只能从组合入口注入，门禁和提交在同一锁定快照内顺序执行，不存在直接写 WorldState 的公共服务。`createPacketSemanticGate` 穷举全部 precondition/source；`createPacketStateTransition` 穷举全部 `EffectOp.op`，产出候选 WorldState、领域事件和物化请求（Store 不重新解释 EffectOp）。
- `createSessionViewProjector` 从锁定快照与 Server 提供的会话/表现候选生成并 Schema 校验玩家可见 View；它不生成或验证 basis token，也不读取客户端未授权的世界字段。
- ModelGateway 先把 WorldSnapshot 与 ModelRequest 校验并封成 prepared invocation；Provider 调用只接受 PostgreSQL Journal 在持久化并标记 dispatched 后签发的一次性 authorization。响应通过同一套 Schema、digest、correlation 与语义门禁后才形成 verified receipt；数据库恢复也只能经 `verifyRecorded` 重跑同一路径，`failed` 输出不会产生 proof。每个生产 Gateway 都拥有实例私有的来源集合，Journal 与 Gateway 只注入其配对实例的只读 verifier；其他 Gateway 生成的对象一律无效。RulePluginGateway 每次调用都显式接收本次作用域 receipts，并在进入 adapter 前核对 proof、world 与原输出精确成员；唯一 RulePlugin Executor 先把完整请求写入 `rule_plugin_invocations`，再调用 deterministic + no_io adapter。遗留 `prepared` 可用同一请求重放，`resolved` 必须经同一 Gateway 重验后恢复；同一 request ID 返回不同响应会明确报告插件非确定性。
- **RulePlugin ABI Host**（`RulePluginModuleV1` + `createRulePluginAbiRegistry`）只接受组合根显式注册的进程内模块：manifest 经 `rule-plugin.v1` 校验，`PluginLock`/`operation_id` 精确命中；禁止扫描目录、下载、默认或兜底插件。Kernel 由此构造唯一 `RulePluginAdapter`，并在内部组装生产 `RuleHoldEvaluator`：`rule.holds → rule.evaluate → Gateway → ValidationOutput.valid`；`deterministic_context` 取自当前 ContentPacket 原值，只读、不提案、不写世界。
- `apps/server/migrations/0001_atomic_packet_store.sql` 是 PostgreSQL 18.x 的单一初始 DDL：`worlds` 分字段保存 WorldState、WorldContentLock、Save/Engine 版本、内容依赖锁、RulePlugin/StageModule 锁、event cursor、资产摘要与迁移历史，不保存整份 SaveEnvelope 副本；`event_cursor` 与 revision 由 `apply_packet` 同步推进，导入世界另存不可后退的 event history floor。CommittedEvent 与 Materialization outbox 原子提交；`engine_sessions` 保存 session/world/human binding/player/view-world revision/nonce 及下一条 ServerEnvelope sequence；`command_journal` 以 `(session_id, command_id)` 锁定请求摘要和最终结果，并为基础对话持有六个 Server 随机子身份；`command_server_envelopes` 与 Session 推进、命令完成在同一事务中保存可精确重放的出站结果。另保存模型与 RulePlugin 调用阶段及每日唯一 Director 调用记录。全部 adapter 只接受组合根显式注入的 node-postgres `Pool` 和正式校验器，不读取连接串、不运行 migration、不重试事务。
- `kernel.worldCreation.create` 是唯一可调用的新世界入口，只接受待验证的 WorldContentLock 与玩家名。它从精确 Content binding 构造完整 revision-0 WorldState：内容 Entity/Relation/InitialMachineBinding 使用 UUIDv5，玩家、human/CharacterMind ControlBinding、玩家起点关系、初始 frame 与玩家 day-1 EventBudget 使用 Server 随机 UUID；首日预算精确绑定 human ControlBinding，capacity 只取自所选 WorldDefinition 的 `event_budget.daily_capacity`。内容侧 `known_to` actor 映射为 runtime entity UUID，初始 machine frame 固定 `indefinite + remain`。完整 Snapshot 先与激活图派生的精确内容、RulePlugin、StageModule 锁组成并验证 revision-0 SaveEnvelope，再由 `kernel.saves` 在一次事务中原子拆分、插入和重建复核；不存在先写库后校验。`createPostgresRuntimeReaders` 同一次 SELECT 返回 Snapshot + ContentLock，并验证 event cursor/floor；模型与 RulePlugin Journal 分别持久化其正式恢复阶段。
- **SaveEnvelope 生命周期**：`kernel.saves.exportSave(worldId)` 在 PostgreSQL repeatable-read 快照内从分字段唯一事实重建完整 SaveEnvelope，再经正式 Schema 与 `event_cursor === world_revision` 等关联门禁；`kernel.saves.importSave(candidate)` 先验证完整不可信 JSON、版本及当前激活内容/插件/Stage 精确锁，最后才以 create-only 事务拆分写入，已有 `world_id` 明确冲突且绝不覆盖 Session 或 Journal。导入不伪造历史 CommittedEvent；内部 event history floor 固定为导入 cursor，后续事件从该 revision 继续。可用 EventCard 的 `SealedEventResult` 自带完整 DeterministicContext，因此存档恢复后点击不依赖导入前的事件日志。
- **Engine Session / Command Journal**：Session 打开时从当前 WorldState 精确解析 active human ControlBinding 与 player entity，Server 生成随机 session ID/nonce；`basis_token` 用独立 HMAC-SHA-256 keyring 签名 session/world/binding/player/view-world revision/nonce 的 JCS SHA-256 摘要，不携带登录信息或 TTL。命令入口只接受 Schema 验证且同时含 `command_id`/`basis_token` 的 ClientMessage；重复同正文直接恢复已有阶段或结果，不同正文明确冲突，新命令才锁 Session/World 并验当前 token。同一 world 同时只允许一条 `received` 命令持有执行槽，模型 ambiguous 时保留该槽且禁止重调；对话阶段由 Command Journal 的稳定子身份、两个调用 Journal 与 CommittedEvent 共同推导，不复制第二套 workflow 状态。
- **ExactDecimal + 零和账本**：WorldRuntime Schema 将 `DecimalString` 闭合为最长 128 字符的规范十进制定点串；Kernel 内建唯一 `ExactDecimal`（`BigInt` coefficient + scale）实现比较与过账，禁止浮点与舍入。`ledger.post` 精确零和、同账户合并、保留原序并追加新账户；首笔严格零和过账可原子创建 ledger，之后仍无 mint / burn 旁路。
- **`createRuntimeContentActivation`**：部署组合根显式传入世界事务 Pool、指向同一数据库但对象独立的 RulePlugin Journal Pool、Provider、不可信 ContentBundle JSON、`RulePluginModuleV1[]`、不可信 StageModule manifest candidates、Save Schema / Engine Contract 精确版本、**分别必填且禁止复用密钥材料**的 DeterministicContext / Session basis HMAC keyring 与合同校验器。独立 Journal Pool 防止 `rule.holds` 持有 world 行锁时发生连接池等待环。Loader 后注册唯一 Catalog并收集全部 16 类 content-owned RulePlugin operation bindings；Kernel 内唯一 ABI Registry 做 module + operation ID + operation kind 精确命中。Save 锁只从同一激活依赖图和唯一 ABI/Stage Registry 派生，不接受调用方拼装。`MaterializationProfile.on_demand` 已精确引用 required `asset_provider` DependencyLock；显式 AssetProvider adapter registry 尚未实现。
- **Model Invocation Assembly**：每次模型内容装配经唯一 `RuntimeWorldBindingResolver` 调用一次 `RuntimeWorldReader`，同时取得 `snapshot` 与 `WorldContentLock`；内容包身份只来自该锁，调用方不得再传 `bundle_id` / `bundle_digest` / `mind_id` / `directorId`。DirectorProfile 只由锁定 WorldDefinition 的 `director_profile_id` 精确选择；CharacterMind 通过同一 Content Runtime Identity Mapper 将 runtime entity UUID 解析到当前绑定包的本地实体。`kernel.models.*` 已有五种闭合构造；基础对话的 CharacterMind request ID 由 Command Journal 预先持久化，`prepared` 可用原请求继续，`verified` 可恢复正式 receipt，`dispatched_ambiguous` 明确阻断且不自动重调。
- **基础 NPC 对话闭环**：`kernel.dialogues.execute` 只接收 `dialogue.start` / `dialogue.continue` 的已验证 ClientEnvelope。玩家只能来自当前 active human ControlBinding；基础 NPC 必须是同世界 active Entity、恰有一个 active CharacterMind binding，并且继续对话只能从恰好两名 Entity 参与者中精确确定唯一 NPC。每条命令固定提交 human packet `R→R+1`，再用显式部署 ModelProfile 调用真实模型并提交 CharacterMind packet `R+1→R+2`。最终事务从权威 SessionView 提取 `DialogueReply`，推进 Session、签发新 basis token、写入固定顺序的 ServerEnvelope outbox 并完成 Command；重复命令重放完全相同的 Envelope。Human 阶段拒绝可原子结束；模型响应未知或 human 提交后的 NPC 阶段拒绝保持 blocked，不生成兜底回复。
- **`createRuntimeExecutionKernel`**：除闭合的 model / RulePlugin / packet / mutation 端口外，已暴露 `worldCreation`、`saves`、`sessions`、`commands` 与 `dialogues` 五个 Server 权威端口；无公开 `executeModel(candidate)`、任意 Session 状态或未验 token 的命令旁路。
- **运行入口与真实 Provider**：`main` 要求显式 `health` 或 `runtime` 模式。`runtime` 只加载指定绝对路径的受信 deployment module，不扫描目录；该模块负责提供 Pool、外部内容、RulePlugin modules、两套独立 keyring 与部署配置。每个 ModelProvider 必须在 activation 时同步确认可处理所选 ModelProfile 与 request kind，配置错配不能等到 durable dispatch 后才暴露。Server 内已有两个无默认模型、无重试的正式 adapter：远程 OpenAI Responses，以及只允许 loopback `/api/chat` 的本地 Ollama。Ollama 还要求显式 temperature 与部署方从正式 ModelOutput 合同派生的 generation Schema；该 Schema 只约束 Provider 生成，ModelGateway 仍以完整正式合同作唯一接收门禁。两者都对响应体流式限长并让显式 timeout 覆盖完整读取；原始输出仍是不可信 JSON，必须经过 ModelGateway 的合同、摘要、关联与语义门禁。HTTP `POST /api/client-envelope` 当前只开放基础对话命令；仓库不内置示例内容、假插件或部署密钥。

## 已封板、尚未实现

- 世界生命周期下游：Save Schema Migration 与 Content Upgrade 的执行编排尚未实现；当前只接受部署显式声明且与激活图精确兼容的 Save/Engine 版本，不自动迁移或升级。
- 运行时业务：对话关闭触发所有权、完整日循环、Character Reaction、Director、EventCard、GoalPlan / WorldExtension 的命令阶段编排，以及显式 AssetProvider adapter registry。基础 NPC `start/continue` 已有闭合实现；其他上层流程仍不伪造。
- Unity 网络/运行时与部署侧 Stage 实例；不建设其他引擎 Host 或跨引擎制品兼容。PostgreSQL、ContentBundle、RulePlugin module、模型配置与密钥始终是仓库外部署责任，不以内置示例或默认值伪装成 Engine 能力。

## 启动骨架服务

运行时要求 Node.js `^24.18.0`（24 LTS）。

```powershell
npm install
npm run build
npm start -- --contracts=contracts --host=127.0.0.1 --port=8000 --mode=health
```

启动后可访问 `GET /api/health`。`--contracts`、`--host`、`--port`、`--mode` 均为必填配置，进程不会猜测默认值。

真实无 Unity 运行模式必须显式指定一个绝对 deployment module；它导出异步 `createLuoxiaRuntimeDeployment({ contracts, digest })`，返回 `{ activation, close }`。正式模块可从 `@luoxia/server/deployment-api` 导入公开组合类型与 OpenAI adapter，不得把连接串、密钥、内容或插件写回 Engine：

```powershell
npm start -- --contracts=contracts --host=127.0.0.1 --port=8000 --mode=runtime --deployment-module=C:\absolute\luoxia-deployment.mjs
```

该模式提供 `GET /api/health` 与 `POST /api/client-envelope`，并假定命令引用的 world / Session 已由可信管理面建立；它不暴露匿名世界创建、存档导入或 Session 打开接口。需要把账号网关与这些生命周期放在同一进程时，部署应用从 `@luoxia/server/deployment-api` 调用 `createRuntimeContentActivation`，显式提供 `saveSchemaVersion` 与 `engineContractVersion`，再按管理权限接入 `kernel.worldCreation`、`kernel.saves` 与 `kernel.sessions`；Engine 不提供默认版本、默认世界或绕过鉴权的公共旁路。

## PostgreSQL Store migration

先由部署流程显式执行 migration；应用启动不会自动建表。`DATABASE_URL` 必须由部署环境提供：

```powershell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/server/migrations/0001_atomic_packet_store.sql
```
