# Luoxia Engine

Luoxia Engine 是一个始终联网、服务端权威、内容包驱动的 AI 世界平台。

平台固定包含：

- **World Core**：世界图、规则、模型编排、存档，以及唯一权威入口 `apply_packet`；
- **System**：Director 的玩家专属常驻模式，负责目标解析、可行路径导航与世界缺口补全；
- **Client Runtime**：可替换的客户端运行时适配层（场景、动画、状态机、音效与舞台表现）；首版适配器骨架为 GDJS Host，未来可替换为 Unity / UE5 Host，而不改变 World Core 权威合同；
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
apps/gdjs-host/               首个 Client Runtime 适配器（Client Bridge + Stage 生命周期调度）
```

当前尚无真实 GDJS、Unity 或 UE5 Runtime 接入；StageModule 制品加载 ABI 仍未决定。`apps/gdjs-host` 已能校验 ServerEnvelope，并将 `stage.open` / `stage.update` / `stage.close` 路由到组合根显式注册的 `StageModuleRuntime`；非 Stage 消息交给必填的 non-stage consumer。

- 七份 Draft 2020-12 Schema 在服务启动时统一加载并解析引用；未知合同、非法输入与关联字段不一致都会明确失败。
- ContentBundle Loader 只接受纯 JSON，核对 `release.bundle_digest` 后再进入语义门禁；`createContentBundleSemanticGate` 提供本包 ID 唯一性、本地引用解析、RuleRef 锁定、Prompt purpose 与 FieldValues 校验。没有 Excel、编译器字段或兼容入口。
- **`createContentRuntimeCatalog`**（`@luoxia/world-core/composition`）对已 load 且 digest 锁定的 ContentBundle 建立进程内只读索引：实现 `StaticComponentDigestLookup`（按 `(bundle_id, bundle_digest, local_id)` 解析静态组件并对 `fields` 做 RFC 8785 SHA-256）；并解析 `RuleRef → WorldLaw.evaluator + rule_plugin DependencyLock`（`resolveRuleEvaluationBinding`）。禁止跨 digest 回退或按显示名猜测。
- World Core 对普通调用方只暴露 `applyPacket`；语义校验器、纯状态变换与原子事务存储只能从组合入口注入，门禁和提交在同一锁定快照内顺序执行，不存在直接写 WorldState 的公共服务。`createPacketSemanticGate` 穷举全部 precondition/source；`createPacketStateTransition` 穷举全部 `EffectOp.op`，产出候选 WorldState、领域事件和物化请求（Store 不重新解释 EffectOp）。
- `createSessionViewProjector` 从锁定快照与 Server 提供的会话/表现候选生成并 Schema 校验玩家可见 View；它不生成或验证 basis token，也不读取客户端未授权的世界字段。
- ModelGateway 先把 WorldSnapshot 与 ModelRequest 校验并封成 prepared invocation；Provider 调用只接受 PostgreSQL Journal 在持久化并标记 dispatched 后签发的一次性 authorization。响应通过同一套 Schema、digest、correlation 与语义门禁后才形成 verified receipt；数据库恢复也只能经 `verifyRecorded` 重跑同一路径，`failed` 输出不会产生 proof。每个生产 Gateway 都拥有实例私有的来源集合，Journal、RulePluginGateway 与提案存储只注入其配对实例的只读 verifier；其他 Gateway 生成的对象一律无效。RulePluginGateway 每次调用都显式接收本次作用域 receipts，并在进入不可信 adapter 前核对 proof、world 与原输出精确成员；成功结果返回不可伪造的 verified RulePlugin receipt。
- **RulePlugin ABI Host**（`RulePluginModuleV1` + `createRulePluginAbiRegistry`）只接受组合根显式注册的进程内模块：manifest 经 `rule-plugin.v1` 校验，`PluginLock`/`operation_id` 精确命中；禁止扫描目录、下载、默认或兜底插件。Kernel 由此构造唯一 `RulePluginAdapter`，并在内部组装生产 `RuleHoldEvaluator`：`rule.holds → rule.evaluate → Gateway → ValidationOutput.valid`；`deterministic_context` 取自当前 ContentPacket 原值，只读、不提案、不写世界。
- 首个 Client Runtime 适配器（`apps/gdjs-host`）收发通过 `client-bridge.v1` 校验的 Envelope；`GdjsStageModuleHost` 对显式传入的 `StageModuleRuntime[]` 建本地 module/scene 索引，校验并调度 Stage 生命周期（open 失败不留实例，close 仅成功后删除）；`createStageRoutingServerEnvelopeConsumer` 把 stage 消息交给 Host、其余交给必填 non-stage consumer。不解释 visible 状态、不写 WorldState、不加载制品、不接真实 GDJS。
- `apps/server/migrations/0001_atomic_packet_store.sql` 是 PostgreSQL 18.x 的单一初始 DDL：WorldState、CommittedEvent 与 Materialization outbox 原子提交，同时保存 verified model invocation、RulePlugin PacketProposal 授权回执及每日唯一 Director 调用记录。`createPostgresAtomicPacketStore` 与持久化 adapter 都只接受 composition root 注入的 node-postgres `Pool` 和正式校验器，不读取连接串、不运行 migration、不重试事务。
- `createPostgresRuntimeReaders` 提供严格的当前 WorldSnapshot 与按修订范围读取的有序 CommittedEvent；`createPostgresRulePluginProposalReceiptStore` 只接受 RulePluginGateway 的 verified receipt；`createPostgresRuntimeInvocationJournal` 为所有模型调用统一执行 prepared → dispatched/ambiguous → verified，并额外锁定每个 world/day 唯一的 Director 日结调用。dispatched 后没有持久化 verified receipt 时明确阻塞且不能再次签发 Provider 调用权；Director 返回只代表可继续日结，不代表 NPC 反应和世界提交已经完成。
- **ExactDecimal + 零和账本**：Kernel 内建唯一 `ExactDecimal`（`BigInt` coefficient + scale）实现 `DecimalAmountComparer` 与 `LedgerPostArithmetic`；`fromValidatedDecimalString` 只消费已通过 WorldRuntime Schema 的金额串，不复制合同正则；禁止浮点与舍入；`ledger.post` 精确零和、同账户合并、保留原序并追加新账户，零余额不删、无铸币旁路。
- **`createRuntimeContentActivation`**：部署组合根显式传入 `Pool`、Provider、不可信 ContentBundle JSON、`RulePluginModuleV1[]`、不可信 StageModule manifest candidates、**必填** DeterministicContext HMAC keyring 与合同校验器；经 Loader 后注册**唯一** Catalog；StageModule manifests 经 `client-bridge.v1` 校验后进入**唯一** Registry（`module_id` / scene / `depends_on` DAG 门禁），精确满足 required `stage_module` DependencyLock，并对指向 required stage_module 的 StageRef 校验 `scene_id`；再将 required roots 展开为依赖优先的传递依赖激活计划 `requiredStageModules`（只验证与排序，不加载/执行制品；optional 与未被 required 引用的 manifest 不进入计划）；required `asset_provider` 仍 unsupported；**只收集** required rule_plugin 身份，Kernel 内**唯一** ABI 校验并接线。组合根用 keyring 创建唯一 HMAC TokenCodec 与 World Core `DeterministicContextAuthority`，同时注入 Packet Semantic Gate 与 RulePlugin Gateway；Kernel 暴露只读 `deterministicContexts.issue`（尚无日循环/对话编排调用它）。EventCard 点击复用封存上下文、不重新签发。返回 Kernel、Bundle 身份、只读 StageModule Registry 与 required 激活计划。尚无真实 StageModule 执行、Client Bridge 网络接入或具体客户端运行时。
- **Model Invocation Assembly**：`ModelProvider.invoke(ResolvedModelInvocation)` 接收已验证 request + 有序 Prompt 文本；Catalog 锁定查询 PromptFragment / DirectorProfile / CharacterMind；`kernel.models.*` 五种闭合构造（日结/对话事件/System 对话/角色对话/角色反应），View 仅从锁定快照投影。ModelProtocol 缓存身份改为 digest/内容地址（已删除人工 revision 与随机 context id）。
- **`createRuntimeExecutionKernel`**：注入 `Pool`、contracts、digest、Provider、modules、`requiredRulePluginDependencies`、catalog。无公开 `executeModel(candidate)` 旁路。`executeRulePlugin` / `mutations` 仍可用。
- health-only `main` 不接激活。无真实 Provider、无日结编排、无引擎内示例内容/插件。

## 启动骨架服务

运行时锁定 Node.js 24 LTS。

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

本机没有可用的 `psql`，Docker daemon 也未运行，因此本次仅完成编译、Schema 加载与静态验证，未宣称 PostgreSQL live 验证。
