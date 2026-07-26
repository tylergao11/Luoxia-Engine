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

当前仓库的 Engine 内部已实现无头底层闭环：revision-0 世界创建、首日日结、Session/Command Journal、基础 NPC/System 对话、System GoalPlan 与 WorldExtensionRequest 落地、Director 对话事件发卡、EventCard 点击表现及跨日推进均走 PostgreSQL 唯一事实和 `apply_packet`。其中 System 规划链已经通过全仓构建、干净 PostgreSQL 18 初始 DDL 与 health 验证，但尚未使用当前外部部署包完成真实 ModelProvider + ContentBundle + RulePlugin 端到端验收；不能把“Engine 已实现”写成“部署已贯通”。架构边界见 [`docs/architecture.md`](docs/architecture.md)，运行时精确 JSON 形状仍以 [`contracts/`](contracts/) 中的 Schema 为唯一真相。

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
- `apps/server/migrations/0001_atomic_packet_store.sql` 是 PostgreSQL 18.x 的单一初始 DDL：`worlds` 分字段保存 WorldState、WorldContentLock、Save/Engine 版本、内容依赖锁、RulePlugin/StageModule 锁、event cursor、资产摘要与迁移历史，不保存整份 SaveEnvelope 副本；`event_cursor` 与 revision 由 `apply_packet` 同步推进，导入世界另存不可后退的 event history floor。CommittedEvent 与 Materialization outbox 原子提交；`engine_sessions` 保存 session/world/human binding/player/view-world revision/nonce 及下一条 ServerEnvelope sequence；`command_journal` 以 `(session_id, command_id)` 锁定请求摘要和最终结果，为基础对话持有六个 Server 随机子身份，并为 EventCard 命令持有与客户端 command ID 分离的全局 packet ID。`dialogue_director_runs` 保存每条对话命令唯一的 Director request；`dialogue_director_proposal_runs` 再原子绑定 verified 输出中 Definition、GoalPlan、EventCard 三类提案的精确有序 ID、RulePlugin request ID，以及 Definition/GoalPlan 的 Server WorldState ID。日循环另以 `(world, day, kind, subject)` 保存稳定执行 UUID，`player_day_end_runs` 只保存命令的源日。阶段进度仍从模型/RulePlugin Journal 与 CommittedEvent 推导，不复制 workflow 状态。`command_server_envelopes` 与 Session 推进、命令完成在同一事务中保存可精确重放的出站结果。全部 adapter 只接受组合根显式注入的 node-postgres `Pool` 和正式校验器，不读取连接串、不运行 migration、不重试事务。
- `kernel.worldCreation.create` 是唯一可调用的新世界入口，只接受待验证的 WorldContentLock 与玩家名。它从精确 Content binding 构造完整 revision-0 WorldState：内容 Entity/Relation/InitialMachineBinding 使用 UUIDv5，玩家、human/CharacterMind ControlBinding、玩家起点关系与初始 frame 使用 Server 随机 UUID；世界固定从 day 1 `autonomous` 且无预开 EventBudget 开始。`kernel.dayCycle.advanceToPlayer` 依次推进状态机、进入 Director settlement、恢复或执行每日唯一 Director 模型、处理 Character Reaction 与 AutomaticEvent，最后由 `day_cycle.advance` 同包进入 `player` 并打开该日唯一预算。内容侧 `known_to` actor 映射为 runtime entity UUID，初始 machine frame 固定 `indefinite + remain`。完整 Snapshot 先与激活图派生的精确内容、RulePlugin、StageModule 锁组成并验证 revision-0 SaveEnvelope，再由 `kernel.saves` 在一次事务中原子拆分、插入和重建复核；不存在先写库后校验。
- **SaveEnvelope 生命周期**：`kernel.saves.exportSave(worldId)` 在 PostgreSQL repeatable-read 快照内从分字段唯一事实重建完整 SaveEnvelope，再经正式 Schema 与 `event_cursor === world_revision` 等关联门禁；`kernel.saves.importSave(candidate)` 先验证完整不可信 JSON、版本及当前激活内容/插件/Stage 精确锁，最后才以 create-only 事务拆分写入，已有 `world_id` 明确冲突且绝不覆盖 Session 或 Journal。导入不伪造历史 CommittedEvent；内部 event history floor 固定为导入 cursor，后续事件从该 revision 继续。可用 EventCard 的 `SealedEventResult` 自带完整 DeterministicContext，因此存档恢复后点击不依赖导入前的事件日志。
- **Engine Session / Command Journal**：Session 打开时从当前 WorldState 精确解析 active human ControlBinding 与 player entity，Server 生成随机 session ID/nonce；`basis_token` 用独立 HMAC-SHA-256 keyring 签名 session/world/binding/player/view-world revision/nonce 的 JCS SHA-256 摘要，不携带登录信息或 TTL。命令入口只接受 Schema 验证且同时含 `command_id`/`basis_token` 的 ClientMessage；重复同正文直接恢复已有阶段或结果，不同正文明确冲突，新命令才锁 Session/World 并验当前 token。同一 world 同时只允许一条 `received` 命令持有执行槽，模型 ambiguous 时保留该槽且禁止重调；System proposal 的稳定 WorldState ID、RulePlugin request ID 与 provenance 时间先由 PostgreSQL 原子持久化，Definition → GoalPlan → EventCard 再按固定顺序从各自 Journal 与 CommittedEvent 恢复，不复制第二套 workflow 状态。
- **ExactDecimal + 零和账本**：WorldRuntime Schema 将 `DecimalString` 闭合为最长 128 字符的规范十进制定点串；Kernel 内建唯一 `ExactDecimal`（`BigInt` coefficient + scale）实现比较与过账，禁止浮点与舍入。`ledger.post` 精确零和、同账户合并、保留原序并追加新账户；首笔严格零和过账可原子创建 ledger，之后仍无 mint / burn 旁路。
- **`createRuntimeContentActivation`**：部署组合根显式传入世界事务 Pool、指向同一数据库但对象独立的 RulePlugin Journal Pool、Provider、不可信 ContentBundle JSON、`RulePluginModuleV1[]`、不可信 StageModule manifest candidates、Save Schema / Engine Contract 精确版本、五种闭合模型入口各自的必填 ModelProfile，以及**分别必填且禁止复用密钥材料**的 DeterministicContext / Session basis HMAC keyring。独立 Journal Pool 防止 `rule.holds` 持有 world 行锁时发生连接池等待环。Loader 后注册唯一 Catalog并收集全部 16 类 content-owned RulePlugin operation bindings；世界 binding 包含 bundle 共享 owner、所选 WorldDefinition 与该世界 StateMachine 的精确子集。Kernel 内唯一 ABI Registry 做 module + operation ID + operation kind 精确命中。Save 锁只从同一激活依赖图和唯一 ABI/Stage Registry 派生，不接受调用方拼装。`MaterializationProfile.on_demand` 已精确引用 required `asset_provider` DependencyLock；显式 AssetProvider adapter registry 尚未实现。
- **Model Invocation Assembly**：每次模型内容装配经唯一 `RuntimeWorldBindingResolver` 调用一次 `RuntimeWorldReader`，同时取得 `snapshot` 与 `WorldContentLock`；内容包身份只来自该锁，调用方不得再传 `bundle_id` / `bundle_digest` / `mind_id` / `directorId`。DirectorProfile 只由锁定 WorldDefinition 的 `director_profile_id` 精确选择；CharacterMind 通过同一 Content Runtime Identity Mapper 将 runtime entity UUID 解析到当前绑定包的本地实体。`kernel.models.*` 已有五种闭合构造；每日 Director 从连续 CommittedEvent 重建当前 settlement 窗口的客观轨迹，且 `(world, day)` 只拥有一个可恢复模型请求。基础对话与 Character Reaction 的 request ID 分别由 Command Journal / 日循环身份账本预先持久化；`prepared` 可用原请求继续，`verified` 可恢复正式 receipt，`dispatched_ambiguous` 明确阻断且不自动重调。
- **NPC/System 对话与规划闭环**：`kernel.dialogues.execute` 只接收 `dialogue.start` / `dialogue.continue` 的已验证 ClientEnvelope。玩家只能来自当前 active human ControlBinding；Entity recipient 走 CharacterMind，System participant 走同一个 Director 的 `director.system_dialogue` 模式。两者都先提交 human packet `R→R+1`，再提交唯一 responder turn。System verified 输出的 Definition、GoalPlan、EventCard ID 集合随后一次性写入 PostgreSQL proposal Journal；Runtime 先用锁定 Catalog 校验引用，再按 Definition → GoalPlan → EventCard 固定顺序串行调用 operation 专属 RulePlugin。GoalPlan 只能首次 `goal_plan.upsert`，demand 节点必须是 blocked 且携带同 demand ID 的 WorldExtensionRequest；有效 Packet 仍只经 `apply_packet` 原子进入世界，Reject 不改变世界。Finalizer 将每个 committed proposal 精确关联回 proposal Journal 与 RulePlugin Journal，才从权威 SessionView 提取 `DialogueReply`、推进 Session 并完成 Command。
- **EventCard 点击与表现**：`kernel.eventCards.execute` 从已验证 Session 推导 world/control，以 Command Journal 持久化的 Server packet ID 构造 trigger 或 invalidate packet；客户端 command ID 不能充当全局 packet 身份。Trigger 只应用封存 `EventOutcomeOp[]` 并追加唯一 `event_card.trigger`，不再调用模型或插件；invalidation 只在正式 sealed precondition 失败时成立。最终分支从 CommittedEvent 推导，`dialogue_quote` 只从玩家可见的既有 DialogueTurn 投影，成功触发输出 `session.view + presentation.frame(narrative.show) + command.result`。两种分支及所有 ServerEnvelope ID、sequence、正文都可按原命令精确重放。
- **`createRuntimeExecutionKernel`**：除闭合的 model / RulePlugin / packet / mutation 端口外，已暴露 `worldCreation`、`saves`、`sessions`、`commands`、`dialogues`、`eventCards`、`dayCycle`、`playerDays` 与统一 `clientCommands` 权威端口；无公开 `executeModel(candidate)`、任意 Session 状态或未验 token 的命令旁路。
- **运行入口与真实 Provider**：`main` 要求显式 `health` 或 `runtime` 模式。`runtime` 只加载指定绝对路径的受信 deployment module，不扫描目录；该模块负责提供 Pool、外部内容、RulePlugin modules、两套独立 keyring 与部署配置。每个 ModelProvider 必须在 activation 时同步确认可处理所选 ModelProfile 与 request kind，配置错配不能等到 durable dispatch 后才暴露。Server 内已有两个无默认模型、无重试的正式 adapter：远程 OpenAI Responses，以及只允许 loopback `/api/chat` 的本地 Ollama；`createRoutedModelProvider` 只按显式 `(model_profile_id, request_kind)` 唯一注册表派发，不存在默认路由。Ollama 还要求显式 temperature 与部署方从正式 ModelOutput 合同派生的 generation Schema；deployment 保留 Provider 支持的判别联合与对象交集，原生 grammar 只缩小生成空间，ModelGateway 仍以完整正式合同作唯一接收门禁。HTTP `POST /api/client-envelope` 当前开放基础对话、EventCard 点击与 `player_day.end`，其他已声明但尚无编排器的命令明确失败；仓库不内置内容、假插件或部署密钥。

## 已封板、尚未实现

- 世界生命周期下游：Save Schema Migration 与 Content Upgrade 的执行编排尚未实现；当前只接受部署显式声明且与激活图精确兼容的 Save/Engine 版本，不自动迁移或升级。
- 运行时业务：对话关闭触发所有权、已提交 WorldExtensionRequest 的后续 `world_extension.resolve` 调度、Stage outcome 的命令阶段编排，以及显式 AssetProvider adapter registry。基础 NPC/System `start/continue`、System GoalPlan 与 WorldExtensionRequest 初次落地、Director 对话事件发卡、EventCard 点击表现、首日进入与 `player_day.end` 的完整日循环已经闭合；其他上层流程仍不伪造。
- Unity 网络/运行时与部署侧 Stage 实例；不建设其他引擎 Host 或跨引擎制品兼容。PostgreSQL、ContentBundle、RulePlugin module、模型配置与密钥始终是仓库外部署责任，不以内置示例或默认值伪装成 Engine 能力。

## 当前停点与继续入口

本轮停在“Engine 合同与持久化实现完成、外部部署验收尚未完成”的边界，不能把下面两层混为同一状态。

Engine 已完成并证明：

- `director.system_dialogue` 的回复先经 `dialogue.turn.append` 提交，verified 输出中的 Definition、GoalPlan、EventCard 三类 proposal ID 再一次性绑定 PostgreSQL 身份。
- Definition → GoalPlan → EventCard 按固定顺序恢复；Reject 不改变 WorldState，accepted proposal 只能经 `apply_packet` 提交。
- 新 GoalPlan 固定为首次 upsert、revision 1、active；demand 节点固定 blocked，WorldExtensionRequest 与同一 node/demand 绑定并随完整 GoalPlan 进入 WorldState。
- proposal ID、RulePlugin request ID、Definition/GoalPlan WorldState ID 与 provenance 时间由 Journal 持久化；Finalizer 将 committed packet 逐项关联回 proposal Journal 与 RulePlugin Journal。
- 本轮验证证据为 `npm run build` 通过、完整初始 DDL 在临时干净 PostgreSQL 18 数据库执行通过，以及 `GET /api/health` 返回正常。

当前中断点：

- 当前外部基线部署虽然已注册 `director.system_dialogue` ModelProvider 路由和 `goal_plan.validate` operation，但基线 RulePlugin 仍对 `goal_plan.validate` 返回 `baseline.operation_disabled`，ContentBundle 的 capabilities、world laws 与 generation archetypes 仍为空。因此真实 System 回复可以进入模型入口，但尚不能用该基线内容验收“产生并接受带 demand 的 GoalPlan”。
- 本轮只验证了干净初始 DDL。已有开发数据库仍使用旧 `dialogue_director_event_card_runs`，尚未切换到通用 `dialogue_director_proposal_runs`；应用不会自动建表或迁移，部署侧必须在启动新代码前显式迁移或重建该数据库，且不得丢失已有 Journal 事实。
- 尚未执行真实 System 命令、进程中断恢复及同 command ID 精确重放，所以当前交付状态是 Engine 实现完成、部署级验收待办，不是生产闭环已证明。

下次只从部署验收继续，不重新设计 Engine 合同：

1. 先由部署侧显式处理现有 PostgreSQL schema，使其与当前初始 DDL 一致。
2. 再发布一个真实支持 `goal_plan.validate` 的外部 ContentBundle / RulePlugin：引用必须来自同一锁定 Bundle，并至少包含可形成 demand 的 WorldLaw 与 GenerationArchetype。
3. 执行一次 System `dialogue.start` 或 `dialogue.continue`，证明 human turn、System turn、`goal_plan.upsert` 连续提交，最终 WorldState 中存在 blocked GoalNode 与 WorldExtensionRequest。
4. 用完全相同的 command ID 和正文重放，证明不重复调用模型、不生成新 proposal/plan/request 身份，并返回相同 ServerEnvelope。
5. 到此停止；已提交 WorldExtensionRequest 的 `world_extension.resolve` 调度属于下一个独立里程碑。

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

该文件是空数据库的完整初始 DDL，不是可重复执行的升级脚本。启动当前 Server 前，部署侧应先检查：

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'luoxia_engine'
  AND table_name LIKE 'dialogue_director%'
ORDER BY table_name;
```

若结果仍包含 `dialogue_director_event_card_runs` 而不包含 `dialogue_director_proposal_runs`，说明数据库停在本轮之前的 schema。此时必须停止启动新 Server，由部署侧编写并审核一次显式数据迁移，或在确认无需保留数据后重建空库；禁止让应用自动改表、同时读取新旧表或把旧表保留为兼容真相。
