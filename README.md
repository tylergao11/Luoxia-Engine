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
- `apps/server/migrations/0001_atomic_packet_store.sql` 是 PostgreSQL 18.x 的单一初始 DDL：`worlds` 含 `state_document` 与不可变 `world_content_lock_document`；CommittedEvent 与 Materialization outbox 原子提交；`engine_sessions` 只保存 session/world/human binding/player/view-world revision/nonce；`command_journal` 以 `(session_id, command_id)` 锁定请求摘要和最终结果；另保存模型与 RulePlugin 调用阶段及每日唯一 Director 调用记录。SaveEnvelope 顶层使用 `world_content_lock`。全部 adapter 只接受组合根显式注入的 node-postgres `Pool` 和正式校验器，不读取连接串、不运行 migration、不重试事务。
- `kernel.worldCreation.create` 是唯一可调用的新世界入口，只接受待验证的 WorldContentLock 与玩家名。它从精确 Content binding 构造完整 revision-0 WorldState：内容 Entity/Relation/InitialMachineBinding 使用 UUIDv5，玩家、human/CharacterMind ControlBinding、玩家起点关系与初始 frame 使用 Server 随机 UUID；内容侧 `known_to` actor 映射为 runtime entity UUID，初始 machine frame 固定 `indefinite + remain`。完整 Snapshot 与 ContentLock 先经 Schema，再由 `createPostgresRuntimeWorldCreator` 在一次事务中插入并回读逐项复核；不存在先写库后校验。`createPostgresRuntimeReaders` 同一次 SELECT 返回 Snapshot + ContentLock；模型与 RulePlugin Journal 分别持久化其正式恢复阶段。
- **Engine Session / Command Journal**：Session 打开时从当前 WorldState 精确解析 active human ControlBinding 与 player entity，Server 生成随机 session ID/nonce；`basis_token` 用独立 HMAC-SHA-256 keyring 签名 session/world/binding/player/view-world revision/nonce 的 JCS SHA-256 摘要，不携带登录信息或 TTL。命令入口只接受 Schema 验证且同时含 `command_id`/`basis_token` 的 ClientMessage；重复同正文直接恢复已有阶段或结果，不同正文明确冲突，新命令才锁 Session/World 并验当前 token。Session view advance 使用 revision CAS。
- **ExactDecimal + 零和账本**：WorldRuntime Schema 将 `DecimalString` 闭合为最长 128 字符的规范十进制定点串；Kernel 内建唯一 `ExactDecimal`（`BigInt` coefficient + scale）实现比较与过账，禁止浮点与舍入。`ledger.post` 精确零和、同账户合并、保留原序并追加新账户；首笔严格零和过账可原子创建 ledger，之后仍无 mint / burn 旁路。
- **`createRuntimeContentActivation`**：部署组合根显式传入世界事务 Pool、指向同一数据库但对象独立的 RulePlugin Journal Pool、Provider、不可信 ContentBundle JSON、`RulePluginModuleV1[]`、不可信 StageModule manifest candidates、**分别必填且禁止复用密钥材料**的 DeterministicContext / Session basis HMAC keyring 与合同校验器。独立 Journal Pool 防止 `rule.holds` 持有 world 行锁时发生连接池等待环。Loader 后注册唯一 Catalog并收集全部 16 类 content-owned RulePlugin operation bindings；Kernel 内唯一 ABI Registry 做 module + operation ID + operation kind 精确命中。`MaterializationProfile.on_demand` 已精确引用 required `asset_provider` DependencyLock；显式 AssetProvider adapter registry 尚未实现。
- **Model Invocation Assembly**：每次模型内容装配经唯一 `RuntimeWorldBindingResolver` 调用一次 `RuntimeWorldReader`，同时取得 `snapshot` 与 `WorldContentLock`；内容包身份只来自该锁，调用方不得再传 `bundle_id` / `bundle_digest` / `mind_id` / `directorId`。DirectorProfile 只由锁定 WorldDefinition 的 `director_profile_id` 精确选择；CharacterMind 通过同一 Content Runtime Identity Mapper 将 runtime entity UUID 解析到当前绑定包的本地实体。`kernel.models.*` 已有五种闭合构造，View 只从该 snapshot 投影，Journal 仍在持久化事务内锁定并复核同一 snapshot。
- **`createRuntimeExecutionKernel`**：除闭合的 model / RulePlugin / packet / mutation 端口外，已暴露 `worldCreation`、`sessions` 与 `commands` 三个 Server 权威端口；无公开 `executeModel(candidate)`、任意 Session 状态或未验 token 的命令旁路。
- health-only `main` 不接激活。无真实 Provider、无日结编排、无引擎内示例内容/插件。

## 已封板、尚未实现

- 世界生命周期：SaveEnvelope 导入/导出；当前 PostgreSQL 以分字段状态为唯一持久化事实，尚无整体验证后原子拆分导入或重建导出服务。
- 运行时业务：完整日循环、对话、Character Reaction、Director、EventCard、GoalPlan / WorldExtension 的命令阶段编排，以及显式 AssetProvider adapter registry。底层 Session、命令幂等、模型 ambiguous、RulePlugin replay 与 packet ID 幂等边界已具备，尚未伪造这些上层流程。
- 外部接入：真实 ModelProvider、Unity 网络/运行时与部署侧 StageModule 实例；不建设其他引擎 Host 或跨引擎制品兼容。

## 启动骨架服务

运行时要求 Node.js `^24.18.0`（24 LTS）。

```powershell
npm install
npm run build
npm start -- --contracts=contracts --host=127.0.0.1 --port=8000
```

启动后可访问 `GET /api/health`。`--contracts`、`--host`、`--port` 均为必填配置，进程不会猜测默认值。

## PostgreSQL Store migration

先由部署流程显式执行 migration；应用启动不会自动建表。`DATABASE_URL` 必须由部署环境提供：

```powershell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/server/migrations/0001_atomic_packet_store.sql
```
