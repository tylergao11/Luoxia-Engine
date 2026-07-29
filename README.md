# Luoxia Engine

Luoxia Engine 是一个始终联网、服务端权威、内容包驱动的 AI 世界平台。

平台固定包含：

- **World Core**：世界图、规则、模型编排、存档，以及唯一权威入口 `apply_packet`；
- **System**：Director 的玩家专属常驻模式，负责目标解析、可行路径导航与世界缺口补全；
- **Client Runtime**：Unity 是唯一目标客户端与 Stage Runtime（场景、动画、状态机、音效与舞台表现）；公开 Bridge 保持引擎中立，以维持 World Core 的正确依赖边界；
- **ContentBundle Loader**：校验并加载外部、版本化、不可变的 ContentBundle JSON；
- **Materialization Pipeline**：把运行时新实体与新定义绑定为持久视觉资产。

核心承诺：玩家在已打开的 System 对话中提出符合世界基本规则的目标，而世界没有预设入口时，Director 的 System 模式会依据现有规则回复、规划或补全最小世界入口。System 可以修路，但不替玩家走路，也不免费创造结果。

玩法不是命令行或 AI 代理操控。玩家在 Unity 的 2D GUI 中直接选择地图目的地、交谈对象、GoalPlan、EventCard 与结束当天；自由文本只表示玩家对当前已选 NPC/System 说的话，绝不解析成移动、战斗、修炼、做饭等通用行动。协议和代码中的 `Command` 仅指可幂等恢复的服务端交互事务，不是玩家侧的命令玩法。

事件权限固定为：只有 Director 拥有事件调用上下文并能提出事件；System 只是 Director 的一个模式。RulePlugin 只裁决，只有 World Core 可以通过 `apply_packet` 把结果变成世界事实。EventCard 在发出时完成裁决、结果封存与 AP 扣除，点击时只校验前置条件并应用封存结果。

当前设计阶段直接使用外部 ContentBundle JSON：内容作者与内容 Agent 按 [`contracts/content-bundle.v1.schema.json`](contracts/content-bundle.v1.schema.json) 编写，Engine 校验后加载并按 digest 锁定。暂不建立 Excel、CSV 或内容编辑器编译链；未来若增加策划工具，它也只能生成同一份 ContentBundle JSON，不能成为第二真相。

当前仓库的 Engine 已实现无头底层闭环：revision-0 世界创建、首日日结、Session/Command Journal、基础 NPC/System 对话、玩家主动 `dialogue.close`、System GoalPlan、带明确 GenerationArchetype 的 WorldExtensionRequest、次日自主阶段扩展解析、Director 对话事件发卡、EventCard 点击表现、跨日推进，以及玩家显式授权的 Content Upgrade 均走 PostgreSQL 唯一事实和 `apply_packet`。当前外部部署已使用真实 PostgreSQL 18、发布态 ContentBundle、确定性 RulePlugin 与 DeepSeek V4 Flash 跑通首日日结、System 规划、次日世界扩展、主动关闭对话及相同 ClientEnvelope 精确重放；Provider 输出始终先经过正式 Schema、摘要、关联与语义门禁，失败调用不自动重试。架构边界见 [`docs/architecture.md`](docs/architecture.md)，运行时精确 JSON 形状仍以 [`contracts/`](contracts/) 中的 Schema 为唯一真相。

## 当前骨架

```text
contracts/
packages/contracts-runtime/   Schema Registry、RFC 8785 摘要、ContentBundle 边界
packages/world-core/          唯一 apply_packet 门面与组合入口
apps/server/                  Model/RulePlugin 网关、在线服务入口
```

当前尚无真实 Unity Runtime 接入。Unity 已成为唯一目标 Client / Stage Runtime；v1 不建设通用或跨引擎 StageModule 制品加载器。公开 Client Bridge 继续保持引擎中立，但只服务正确的 Server / World Core 依赖边界，不承诺其他引擎 Host 或跨引擎制品兼容。

正式 Unity 2D Host 的首版模块与重连状态机已经收敛在 [`docs/architecture.md`](docs/architecture.md)：只包含合同适配、认证入场、Bridge Transport、SessionReplica、表现路由、2D RenderNode renderer 与功能 View；不在无 Editor 阶段预选版本或制造不可验证工程，Stage/3D 也不进入首个里程碑。

- 七份 Draft 2020-12 Schema 在服务启动时统一加载并解析引用；未知合同、非法输入与关联字段不一致都会明确失败。
- ContentBundle Loader 只接受纯 JSON，核对 `release.bundle_digest` 后再进入语义门禁；`createContentBundleSemanticGate` 提供本包 ID 唯一性、本地引用解析、RuleRef 锁定、Prompt purpose、FieldValues 与 `InitialVisibility` 校验。`known_to` 只能引用符号玩家或本包本地 Entity；玩家起点 fields 按其 relation type 校验。没有 Excel、编译器字段或兼容入口。
- **`createContentRuntimeCatalog`**（`@luoxia/world-core/composition`）对已 load 且 digest 锁定的 ContentBundle 建立进程内只读索引：实现 `StaticComponentDigestLookup`，并解析 `RuleRef → WorldLaw.evaluator + required rule_plugin DependencyLock`。`resolveWorldContentBinding(WorldContentLock)` 按 `pack_id + bundle_digest + pack_version + world_definition_id` 精确命中，返回同包同世界的 DirectorProfile、玩家初始化声明及该世界全部 operation bindings；`listRulePluginOperationBindings` 穷举 v1 的 16 类字段 owner，不按 kind、顺序或数量猜插件。Catalog 与世界创建共用唯一 `ContentRuntimeIdentityMapper`，Server adapter 按 RFC 9562 UUIDv5 将本地 Identifier 映射为 runtime UUID：namespace 是 runtime `world_id`，name 是 UTF-8 `pack_id + "\0" + kind + "\0" + local_id`，当前闭合 kind 为 `entity`、`relation`、`state_machine_binding`。
- World Core 对普通调用方只暴露 `applyPacket`；语义校验器、纯状态变换与原子事务存储只能从组合入口注入，门禁和提交在同一锁定快照内顺序执行，不存在直接写 WorldState 的公共服务。`createPacketSemanticGate` 穷举全部 precondition/source；`createPacketStateTransition` 穷举全部 `EffectOp.op`，产出候选 WorldState、领域事件和物化请求（Store 不重新解释 EffectOp）。
- `createSessionViewProjector` 从锁定快照与 Server 提供的会话/表现候选生成并 Schema 校验玩家可见 View；Server 的唯一 2D 投影器同时从同一事务取得 WorldContentLock 与 WorldState，只把锁定 PackBinding 和玩家可见的当前位置、关系及 active Dialogue 实例化为稳定 RenderNode。直接 PackAsset 与 MaterializationProfile 精确二选一，后者只命中同主体 revision/slot 的 active VisualBinding，否则使用 profile 明示 fallback；不存在调用方空数组、默认素材或按内容猜节点。
- ModelGateway 先把 WorldSnapshot 与 ModelRequest 校验并封成 prepared invocation；Provider 调用只接受 PostgreSQL Journal 在持久化并标记 dispatched 后签发的一次性 authorization。响应通过同一套 Schema、digest、correlation 与语义门禁后才形成 verified receipt；数据库恢复也只能经 `verifyRecorded` 重跑同一路径，`failed` 输出不会产生 proof。每个生产 Gateway 都拥有实例私有的来源集合，Journal 与 Gateway 只注入其配对实例的只读 verifier；其他 Gateway 生成的对象一律无效。RulePluginGateway 每次调用都显式接收本次作用域 receipts，并在进入 adapter 前核对 proof、world 与原输出精确成员；唯一 RulePlugin Executor 先把完整请求写入 `rule_plugin_invocations`，再调用 deterministic + no_io adapter。遗留 `prepared` 可用同一请求重放，`resolved` 必须经同一 Gateway 重验后恢复；同一 request ID 返回不同响应会明确报告插件非确定性。
- **RulePlugin ABI Host**（`RulePluginModuleV1` + `createRulePluginAbiRegistry`）只接受组合根显式注册的进程内模块：manifest 经 `rule-plugin.v1` 校验，`PluginLock`/`operation_id` 精确命中；禁止扫描目录、下载、默认或兜底插件。Kernel 由此构造唯一 `RulePluginAdapter`，并在内部组装生产 `RuleHoldEvaluator`：`rule.holds → rule.evaluate → Gateway → ValidationOutput.valid`；`deterministic_context` 取自当前 ContentPacket 原值，只读、不提案、不写世界。
- `apps/server/migrations/0001_atomic_packet_store.sql` 是 PostgreSQL 18.x 的单一初始 DDL：`worlds` 分字段保存 WorldState、WorldContentLock、Save/Engine 版本、内容依赖锁、RulePlugin/StageModule 锁、event cursor、资产摘要与迁移历史，不保存整份 SaveEnvelope 副本；`event_cursor` 与 revision 由 `apply_packet` 同步推进，导入世界另存不可后退的 event history floor。CommittedEvent 与 Materialization outbox 原子提交；`asset_candidates`、`asset_reviews`、`asset_acceptances` 以一对一外键和文档身份约束组成独立 Materialization Ledger，审核接受与 Acceptance 原子入账。`content_upgrade_authorizations` 在插件执行前保存 Core 授权，并只以 `authorized → commit_ready` 单向推进；commit-ready 查询与已解析的 RulePlugin Journal 原始 request/response 联接，不复制第二份迁移候选。`engine_sessions` 保存 session/world/human binding/player/view-world revision/nonce 及下一条 ServerEnvelope sequence；`command_journal` 以 `(session_id, command_id)` 锁定请求摘要和最终结果，并为 Content Upgrade 分别持有全局 packet/upgrade ID 与 RulePlugin request ID。阶段进度仍从正式 Journal 与 CommittedEvent 推导，不复制 workflow 状态。`command_server_envelopes` 与 Session 推进、命令完成在同一事务中保存可精确重放的出站结果。全部 adapter 只接受组合根显式注入的 node-postgres `Pool` 和正式校验器，不读取连接串、不运行 migration、不重试事务。
- `kernel.worldCreation.create` 是唯一可调用的新世界入口，只接受待验证的 WorldContentLock 与玩家名。它从精确 Content binding 构造完整 revision-0 WorldState：内容 Entity/Relation/InitialMachineBinding 使用 UUIDv5，玩家、human/CharacterMind ControlBinding、玩家起点关系与初始 frame 使用 Server 随机 UUID；世界固定从 day 1 `autonomous` 且无预开 EventBudget 开始。`kernel.dayCycle.advanceToPlayer` 先按 WorldState 中已提交的 selected archetype 串行消费 active GoalPlan 的 WorldExtensionRequest，再推进状态机、进入 Director settlement、恢复或执行每日唯一 Director 模型、处理 Character Reaction 与 AutomaticEvent，最后由 `day_cycle.advance` 同包进入 `player` 并打开该日唯一预算。内容侧 `known_to` actor 映射为 runtime entity UUID，初始 machine frame 固定 `indefinite + remain`。完整 Snapshot 先与激活图派生的精确内容、RulePlugin、StageModule 锁组成并验证 revision-0 SaveEnvelope，再由 `kernel.saves` 在一次事务中原子拆分、插入和重建复核；不存在先写库后校验。
- **SaveEnvelope / Save Schema Migration 生命周期**：`kernel.saves.exportSave(worldId)` 在 PostgreSQL repeatable-read 快照内从分字段唯一事实重建完整 SaveEnvelope，再经正式 Schema 与 `event_cursor === world_revision` 等关联门禁。`kernel.saves.importSave(request)` 只接受正式 `SaveSchemaImportRequest`：`current` 模式要求候选精确等于当前 Save Schema 版本；`migrate` 模式还必须显式给出 `plan_id`，按注册计划逐步验证源 Schema、执行同步 `pure + no_io` module、验证目标 Schema，并由 Server 追加迁移历史与 JCS 摘要，之后才校验当前内容/插件/Stage 精确锁并以 create-only 事务写入。`kernel.saves.migrateStored(request)` 在目标 world 行锁内执行同一计划，只更新 Save 表示版本、迁移历史和更新时间，不改变世界、内容锁、实现锁、revision 或 event cursor，也不调用 `apply_packet`。导入不伪造历史 CommittedEvent；内部 event history floor 固定为导入 cursor，后续事件从该 revision 继续。
- **Content Upgrade 生命周期**：`kernel.contentUpgrades.execute` 只接收带当前 basis token 的 `content_upgrade.accept`。目标 PackLock、`migration_id` 与同意文本摘要必须精确命中目标 ContentBundle 的 `ContentUpgrade`；Command Journal 预分配全局 upgrade/packet ID 与 RulePlugin request ID，World Core 用独立 HMAC keyring 签发绑定源 SaveEnvelope 摘要、source/target digest、玩家、world/revision 和有效期的 `UpgradeAuthorization`。授权先持久化，再调用唯一 `content_upgrade.transform`；候选必须把 revision/event cursor 精确推进一步、使用目标锁、追加一条完整迁移历史且 unresolved 为空。授权账本进入 `commit_ready` 后，World Core 才允许唯一的 `content_upgrade.apply`，并在一个 `apply_packet` 事务中原子提交完整 SaveEnvelope 分字段事实与 CommittedEvent。普通 RulePlugin、客户端和导入接口均无该写权限；进程在 packet 提交后、Session Finalizer 前退出时，从相同授权和插件 Journal 恢复 duplicate 并完成原命令。
- **Engine Session / Command Journal**：Session 打开时从同一 PostgreSQL 事务锁定的当前 WorldState 精确解析 active human ControlBinding 与 player entity，Server 生成随机 session ID/nonce，并在提交事务前经唯一 Server SessionView 组装入口返回 Schema 验证的首个完整 View；该 View 与 Session 使用同一 world revision，网关无需二次读取或补字段。`client.ready` 与 `session.resync_request` 已通过同一同步端口和同一 View 入口从锁定的当前 Session/WorldState 返回完整权威 View，并原子推进 ServerEnvelope sequence；二者是已认证 Session 的同步控制消息，不进入 Command Journal 或 WorldState，不支持当前协议的 ready 明确返回 fatal `protocol.error`。`basis_token` 用独立 HMAC-SHA-256 keyring 签名 session/world/binding/player/view-world revision/nonce 的 JCS SHA-256 摘要，不携带登录信息或 TTL。命令入口只接受 Schema 验证且同时含 `command_id`/`basis_token` 的 ClientMessage；Command Journal 对完整 ClientEnvelope 做 JCS 摘要并逐值比对，重试必须复用首次提交的 message ID、client sequence、token 与正文，任一不同都明确冲突，新命令才锁 Session/World 并验当前 token。这样完成命令能稳定重放原 correlation、ServerEnvelope ID、sequence 与正文；若先经 resync 越过旧 outbox，Unity Host 只按原命令 correlation 处理整个历史批次，绝不回退 View 或 sequence。同一 world 同时只允许一条 `received` 命令持有执行槽，模型 ambiguous 时保留该槽且禁止重调；System proposal 的稳定 WorldState ID、RulePlugin request ID 与 provenance 时间先由 PostgreSQL 原子持久化，Definition → GoalPlan → EventCard 再按固定顺序从各自 Journal 与 CommittedEvent 恢复，不复制第二套 workflow 状态。
- **ExactDecimal + 零和账本**：WorldRuntime Schema 将 `DecimalString` 闭合为最长 128 字符的规范十进制定点串；Kernel 内建唯一 `ExactDecimal`（`BigInt` coefficient + scale）实现比较与过账，禁止浮点与舍入。`ledger.post` 精确零和、同账户合并、保留原序并追加新账户；首笔严格零和过账可原子创建 ledger，之后仍无 mint / burn 旁路。
- **`createRuntimeContentActivation`**：部署组合根显式传入世界事务 Pool、指向同一数据库且对象彼此独立的 RulePlugin Journal Pool 与 Materialization Ledger Pool、Provider、不可信 ContentBundle JSON、`RulePluginModuleV1[]`、`AssetProviderAdapterV1[]`、不可信 StageModule manifest candidates、受信 `SaveSchemaMigrationModuleV1[]`、不可信 migration plan candidates、Save Schema / Engine Contract 精确版本、五种闭合模型入口各自的必填 ModelProfile，以及**分别必填且两两禁止复用密钥材料**的 DeterministicContext、Session basis、Content Upgrade 三套 HMAC keyring；Content Upgrade 授权有效期秒数同样必须由部署显式提供。没有历史迁移制品时也必须显式传两个空数组，禁止默认计划、按版本猜链或借用 Content Upgrade transformer。两个独立辅助 Pool 防止 `rule.holds`、Content Upgrade 授权查询或 AssetAcceptance 授权查询在持有 world 行锁时发生连接池等待环。Loader 后注册唯一 Catalog并收集全部 16 类 content-owned RulePlugin operation bindings；世界 binding 包含 bundle 共享 owner、所选 WorldDefinition 与该世界 StateMachine 的精确子集。Kernel 内唯一 ABI Registry 做 module + operation ID + operation kind 精确命中。Save 锁只从同一激活依赖图和唯一 ABI/Stage Registry 派生，不接受调用方拼装。AssetProvider Registry 同样只接收部署显式注册的 adapter，并按 required `asset_provider` DependencyLock 的 package/version/integrity 精确命中；Kernel 将同一 Registry 注入唯一 Materialization 编排器，无依赖时部署也必须显式传空数组，不存在默认 Provider。
- **Model Invocation Assembly**：每次模型内容装配经唯一 `RuntimeWorldBindingResolver` 调用一次 `RuntimeWorldReader`，同时取得 `snapshot` 与 `WorldContentLock`；内容包身份只来自该锁，调用方不得再传 `bundle_id` / `bundle_digest` / `mind_id` / `directorId`。DirectorProfile 只由锁定 WorldDefinition 的 `director_profile_id` 精确选择；CharacterMind 通过同一 Content Runtime Identity Mapper 将 runtime entity UUID 解析到当前绑定包的本地实体。`kernel.models.*` 已有五种闭合构造；每日 Director 从连续 CommittedEvent 重建当前 settlement 窗口的客观轨迹，且 `(world, day)` 只拥有一个可恢复模型请求。基础对话与 Character Reaction 的 request ID 分别由 Command Journal / 日循环身份账本预先持久化；`prepared` 可用原请求继续，`verified` 可恢复正式 receipt，`dispatched_ambiguous` 明确阻断且不自动重调。
- **NPC/System 对话、关闭与规划闭环**：`kernel.dialogues.execute` 只接收 `dialogue.start` / `dialogue.continue` 的已验证 ClientEnvelope。玩家只能来自当前 active human ControlBinding；Entity recipient 走 CharacterMind，System participant 走同一个 Director 的 `director.system_dialogue` 模式。两者都先提交 human packet `R→R+1`，再提交唯一 responder turn。System verified 输出的 Definition、GoalPlan、EventCard ID 集合随后一次性写入 PostgreSQL proposal Journal；Runtime 先用锁定 Catalog 校验引用，再按 Definition → GoalPlan → EventCard 固定顺序串行调用 operation 专属 RulePlugin。GoalPlan 只能首次 `goal_plan.upsert`；demand 节点必须是 blocked，WorldExtensionRequest 必须保存由内容 RulePlugin 从 `allowed_archetypes` 精确选择的一项，Server 不按数组或注册顺序猜 resolver。System 对话命令到此结束，所选扩展只在下一自主阶段由 `kernel.worldExtensions` 消费。`kernel.dialogueCloses` 接收显式 `dialogue.close`，只允许 Session 玩家关闭自己参与的 active Dialogue，Server 固定拥有通用原因 `player_requested`；日末不自动关闭。所有有效 Packet 仍只经 `apply_packet` 原子进入世界。Finalizer 将 committed proposal 精确关联回对应 Journal 后才推进 Session 并完成 Command。
- **EventCard 点击与表现**：`kernel.eventCards.execute` 从已验证 Session 推导 world/control，以 Command Journal 持久化的 Server packet ID 构造 trigger 或 invalidate packet；客户端 command ID 不能充当全局 packet 身份。Trigger 只应用封存 `EventOutcomeOp[]` 并追加唯一 `event_card.trigger`，不再调用模型或插件；invalidation 只在正式 sealed precondition 失败时成立。最终分支从 CommittedEvent 推导，`dialogue_quote` 只从玩家可见的既有 DialogueTurn 投影，成功触发输出 `session.view + presentation.frame(narrative.show) + command.result`。两种分支及所有 ServerEnvelope ID、sequence、正文都可按原命令精确重放。
- **地图移动闭环**：`kernel.mapMoves.execute` 只接收 `map.move`，actor 与 control 只从已验 basis token 的 Session 推导；目标地点来自正式消息，内容绑定的唯一 `navigation.resolve` 决定接受或以原始 Reject code 拒绝。接受分支只提交一个 `entity.relocate` packet，不调用模型、不扣 AP；Finalizer 将持久化 request、resolved proposal、CommittedEvent、actor 与 destination 逐项关联后才推进 Session，并输出可精确重放的 `session.view + command.result`。
- **Stage / Client Bridge 服务端闭环**：每个 `stage.open` 在 `apply_packet` 的同一 world 行锁内，使用同一次重建并验证的 SaveEnvelope 权威上下文核对 required StageModule dependency、完整 `StageModuleLock`、scene、slot 和内容 StageRef；Server 再把 open StageInstance 投影为携带完整 lock 与 `binding_id + slot_id + AssetContentRef` 的 `stage.open`，不下发路径或猜 URI。EventCard 新打开的玩家 Stage 与命令结果同批发出；`client.ready` / resync 返回当前玩家全部 open Stage，客户端以该集合为权威重建本地实例。`kernel.stageOutcomes.execute` 只接收 `stage.outcome_proposal`，精确证明玩家、participant、revision、module、scene 与 outcome type 后调用 `stage_outcome.resolve`；接受提案必须以恰好一个 `stage.update` 或 `stage.close` 结束并逐值匹配客户端证据，Finalizer 沿唯一 Choice continuation 链定位终态，再复核 Journal、CommittedEvent 与最终 StageInstance，输出 `session.view + stage.update|stage.close + command.result` 并支持精确重放。`stage.input` 只属于未来 Unity Stage Runtime 的本地帧域；加权 `ChoiceSpec` 由 Server 权威裁决，不增加客户端选择消息。
- **`createRuntimeExecutionKernel`**：除闭合的 model / RulePlugin / packet / mutation 端口外，已暴露 `worldCreation`、`saves`、`sessions`、`commands`、`dialogues`、`dialogueCloses`、`eventCards`、`mapMoves`、`stageOutcomes`、`worldExtensions`、`dayCycle`、`playerDays`、`materializations` 与统一 `clientCommands` 权威端口；无公开 `executeModel(candidate)`、任意 Session 状态、直接视觉绑定或未验 token 的命令旁路。
- **运行入口与真实 Provider**：`main` 要求显式 `health` 或 `runtime` 模式。`runtime` 只加载指定绝对路径的受信 deployment module，不扫描目录；该模块负责提供 Pool、外部内容、RulePlugin/Save migration modules、显式 migration plans、三套独立 keyring 与部署配置。每个 ModelProvider 必须在 activation 时同步确认可处理所选 ModelProfile 与 request kind，配置错配不能等到 durable dispatch 后才暴露。Server 内已有三个无默认模型、无重试的正式 adapter：远程 OpenAI Responses、官方 DeepSeek Chat Completions，以及只允许 loopback `/api/chat` 的本地 Ollama；`createRoutedModelProvider` 只按显式 `(model_profile_id, request_kind)` 唯一注册表派发，不存在默认路由。DeepSeek 与 Ollama 均要求显式 request kind、temperature 和部署方从正式 ModelOutput 合同派生的输出 Schema；Provider 结构化输出只缩小生成空间，ModelGateway 仍以完整正式合同作唯一接收门禁。HTTP `POST /api/client-envelope` 穷举当前 ClientMessage 集合：Client ready、Session 重同步、基础对话、主动关闭对话、地图移动、Stage outcome、EventCard 点击、`player_day.end` 与 Content Upgrade；未知类型先在 Schema 门禁失败。`stage.input` 只属于未来 Unity Stage Runtime 的本地帧域，不是 ClientMessage。仓库不内置内容、假插件或部署密钥。

## 已封板、仍需外部实现

- ChoiceSpec：`capability.resolve`、两类 automatic event 与 `stage_outcome.resolve` 可以返回加权候选；`rule.evaluate` 只允许 Reject 或 ValidationOutput。World Core 使用 256-bit OS CSPRNG 熵、RFC 8785 JCS SHA-256 与 rejection sampling 做无偏加权选择，签发只追加一个 `random_choices` 项的新 DeterministicContext。PostgreSQL RulePlugin Journal 在继续调用插件前原子保存父请求、唯一子请求、熵揭示与承诺；恢复只沿已保存子请求继续，不重新抽取。插件从新 context 读取 option，直到返回终态 proposal/reject；客户端不拥有此选择，也没有对应 Bridge 消息。
- Save Schema Migration 的合同、ABI、显式计划链、导入迁移与存量 world 行锁迁移已经实现；仓库不伪造历史 Save Schema、module 或 plan。部署只有在确有历史格式时才显式注册对应制品，无制品时显式传空数组。
- Unity 网络/Stage Runtime 与部署侧 Stage 实例仍由 `C:\Ai\Luoxia-Unity` 实现；不建设其他引擎 Host 或跨引擎制品兼容。Materialization 的实际生成与审核执行者仍由部署注入，PostgreSQL、ContentBundle、RulePlugin module、模型配置与密钥始终是仓库外部署责任，不以内置示例或默认值伪装成 Engine 能力。

## 当前停点与继续入口

真实外部部署验收已经完成：PostgreSQL 18 中的新世界从首日日结进入 `player`，DeepSeek System 对话提交一份带 demand 的 GoalPlan，内容 RulePlugin 将 `goal_discovery` 精确封入 WorldExtensionRequest；`player_day.end` 在下一自主阶段先生成动态 Definition、把节点改为 bound 并消费请求，随后完成日循环进入第 2 天 `player`。主动 `dialogue.close` 也已提交为单个权威 packet；两类命令的相同 ClientEnvelope 重放均返回相同 ServerEnvelope 摘要。Stage outcome 已通过 Engine 构建、外部 Deployment 构建及 Server health 验证；本轮新增的 Stage open/resync、Save Schema Migration 与服务端 ChoiceSpec continuation 已通过 Engine 构建和静态合同门禁，Choice authority 另经一次真实 Schema/HMAC/CSPRNG 调用验证，但外部部署尚无真实历史 Save 制品、StageModule 制品、返回 ChoiceSpec 的内容插件或 Unity StageInstance，因而不伪造对应端到端结果。AssetAcceptance packet source、持久化 Materialization Ledger 与 Content Upgrade 服务端链均已实现；Content Upgrade 当前只有构建与静态门禁证据，尚未伪造外部内容包迁移制品或端到端运行结果。除 Unity Host/Runtime/UI 和部署方真实制品外，当前没有已知未决的 Engine 合同所有权缺口。

## 启动骨架服务

运行时要求 Node.js `^24.18.0`（24 LTS）。

```powershell
npm install
npm run build
npm start -- --contracts=contracts --host=127.0.0.1 --port=8000 --mode=health
```

启动后可访问 `GET /api/health`。`--contracts`、`--host`、`--port`、`--mode` 均为必填配置，进程不会猜测默认值。

真实无 Unity 运行模式必须显式指定一个绝对 deployment module；它导出异步 `createLuoxiaRuntimeDeployment({ contracts, digest })`，返回 `{ activation, close }`。正式模块可从 `@luoxia/server/deployment-api` 导入公开组合类型与明确选择的 Provider adapter，不得把连接串、密钥、内容或插件写回 Engine：

```powershell
npm start -- --contracts=contracts --host=127.0.0.1 --port=8000 --mode=runtime --deployment-module=C:\absolute\luoxia-deployment.mjs
```

该模式提供 `GET /api/health` 与 `POST /api/client-envelope`，并假定命令引用的 world / Session 已由可信管理面建立；它不暴露匿名世界创建、存档导入或 Session 打开接口。需要把账号网关与这些生命周期放在同一进程时，部署应用从 `@luoxia/server/deployment-api` 调用 `createRuntimeContentActivation`，显式提供 `saveSchemaVersion` 与 `engineContractVersion`，再按管理权限接入 `kernel.worldCreation`、`kernel.saves` 与 `kernel.sessions`；Engine 不提供默认版本、默认世界或绕过鉴权的公共旁路。

## PostgreSQL Store migration

先由部署流程显式执行 migration；应用启动不会自动建表。`DATABASE_URL` 必须由部署环境提供：

```powershell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/server/migrations/0001_atomic_packet_store.sql
```

该文件是空数据库的完整初始 DDL，不是可重复执行的升级脚本。启动当前 Server 前，部署侧应先检查：

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'luoxia_engine'
  AND table_name LIKE 'dialogue_director%'
ORDER BY table_name;
```

若结果仍包含 `dialogue_director_event_card_runs` 而不包含 `dialogue_director_proposal_runs`，说明数据库停在本轮之前的 schema。此时必须停止启动新 Server，由部署侧编写并审核一次显式数据迁移，或在确认无需保留数据后重建空库；禁止让应用自动改表、同时读取新旧表或把旧表保留为兼容真相。
