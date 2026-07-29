# Agent 约束

## 禁止

- **禁止测试工程**：不得创建 `tests/`、`test_*`、pytest、jest、vitest、测试夹具或冒烟脚本。验证只运行现有构建、一次性只读 JSON/Schema 校验、静态检查与人工试用；验证代码不得提交进仓库。
- **禁止硬编码内容**：World Core、协议、Unity Host 不得出现具体世界名、人物名、剧情、功法、地点、货币或内容包分支。协议版本、闭合的通用 `EffectOp`、错误码与安全上限属于引擎合同，不属于内容硬编码。
- **禁止第二真相**：每类事实只能有一个正式所有者。外部内容包直接维护的 ContentBundle JSON 是当前唯一内容源；缓存、索引、转换结果与文档不得反向成为源文件。
- **禁止内容越权**：ContentBundle JSON 可以引用公开内容合同，但不得携带 EffectOp、WorldState 写入、模型供应商配置、Unity 内部对象或存档迁移命令。
- **禁止旧项目迁移**：不得依赖或复制 QingYun、LuoXia、GameCastle 的业务代码、对象模型、兼容层或存档格式；旧仓库只可作为设计经验来源。
- **禁止重复门禁**：同一份未变化的产物不得反复全量验证；不得把每次措辞或局部调整升级成完整交付审计。
- **禁止临时代码**：禁止 TODO、FIXME、NotImplemented、占位数据、空 Handler、假 Provider、假插件、内存数据库、固定返回值、「先跑起来以后再改」的旁路，以及兼容旧接口。
- **禁止第二套协议模型**：不得再建立 Zod、Pydantic、class-validator、手写 DTO 等第二套字段真相；外部输入、模型输出、插件输出、Unity Bridge 消息一律是不可信 JSON，必须先经 SchemaRegistry。
- **禁止默认与兜底**：禁止默认插件、默认内容、默认 `no_effect`、自动降级、旧字段别名、按显示名猜测、缺失引用回退。
- **禁止任意写世界**：禁止 JSON Patch、eval、脚本执行和任意路径修改 WorldState。
- **禁止 LangGraph 拥有世界**：未来若引入 LangGraph，只能作为 Server 编排端口的可替换适配器，不能拥有 WorldState。

## 真相源

| 路径 | 唯一职责 |
|---|---|
| `AGENTS.md` | Agent 工作约束 |
| `README.md` | 项目入口与当前交付状态 |
| `docs/architecture.md` | 架构边界、权威流与合同所有权 |
| 外部 ContentBundle JSON | 各内容包自己的世界、角色、剧情、规则语义与美术内容；不存放在引擎仓库 |
| `contracts/*.schema.json` | 运行时 JSON 字段、枚举与消息形状的唯一机器真相 |

新增说明必须更新上述现有真相源，不创建临时计划、会话备忘、重复架构文档或测试报告文件。字段变更只改对应 Schema；架构责任变化才改 `docs/architecture.md`；启动方式与真实能力变化才改 `README.md`。

## 包依赖边界

依赖方向只能是：

```text
contracts-runtime → contracts
world-core        → contracts-runtime/portable
server            → world-core + contracts-runtime
unity-host        → contracts-runtime/portable
```

额外要求：

- World Core 禁止 import 数据库、HTTP 框架、模型 Provider、Unity、插件实现或具体内容。
- Unity Host 禁止 import World Core。
- 浏览器侧只能引用 `@luoxia/contracts-runtime/portable`，禁止加载 Node 的 `fs` / `crypto` 实现。
- 普通业务只能 import `@luoxia/world-core`。
- 只有组合根可以 import `@luoxia/world-core/composition`。

## 接口纪律

- Content Pack 只依赖公开合同；World Core 不反向 import 具体内容包。
- 引擎只按 `contracts/content-bundle.v1.schema.json` 校验并加载外部 ContentBundle JSON；当前不维护 Excel、CSV、ContentDesignIR 或内容编辑器转换链。
- 模型、RulePlugin、StageModule、Unity、客户端与资产流水线都不能直接写 World State。
- 只有 World Core 的 `applyPacket` 可以改变世界；`apply_packet` 是唯一权威写入口，只接收验证后的 `ContentPacket`，整包原子提交或完整拒绝。
- `ContentPacket` 只含前置条件、确定性输入与闭合 `EffectOp`；唯一例外是 `EventCardPublishOp` 内经裁决封存的惰性 `EventResultPresentation`，且 NPC 原话只能引用既有 `DialogueTurn`。它不参与规则求值；资产路径与 Unity 指令不得混入。
- RulePlugin 的 `operation_kind` 是唯一入口真相；每个 kind 都有闭合输入、输出与 allowed-op 子集，禁止通用 PacketProposal 旁路；RulePlugin 只能返回专属提案，不能调用 `applyPacket`。
- System 是 Director 的一种模式，不是第三个模型、子类或独立事件权限。
- 玩家与 NPC 是同一种 Entity，仅通过 ControlBinding 区分；禁止 `Player extends Character`、`Npc extends Character`。
- NPC 没有 AP。玩家 EventCard 发卡即扣 AP；地图导航移动不扣 AP。
- EventCard 发卡时已经裁决并封存结果；点击时不能再调用模型或 RulePlugin。
- 客户端只消费 SessionView 与表现消息，不读取隐藏世界真相，不按 `pack_id` 写内容分支。
- 外部输入与模型输出一律视为不可信 JSON，先做 Schema 与语义校验。

## 编码纪律

- 使用 TypeScript `interface` 和组合；不建立 `BaseService`、`BaseRepository`、`BaseWorld`、`BaseEntity` 等继承树。
- `EffectOp` 使用 `op` 判别和穷举 Handler Map，不建立几十个 EffectOp 子类。
- RulePlugin 使用 `operation_kind` 的穷举注册表，不提供通用 `resolve → 任意 PacketProposal` 旁路。
- 未知 operation、EffectOp、协议版本或引用必须明确失败。
- JSON 摘要统一使用 RFC 8785 JCS UTF-8 字节的 SHA-256 小写十六进制。
- `ValidatedJson` 只能由 SchemaRegistry 产生；禁止暴露或复制内部 seal 工厂。
- 校验后的 JSON 必须保持不可变，不得重新包装成可修改 DTO。
- 先找到接口所有者与 Schema，不得从调用方反推并发明字段；现有接口不足时停止并报告准确缺口。

## apply_packet 固定顺序

不得调整以下顺序：

1. Schema 校验 ContentPacket
2. 持锁查 `packet_id` 幂等记录
3. 读取同一事务内的 WorldState 快照
4. 校验 `basis_revision`、source、deterministic context、preconditions 和语义不变量
5. prepare 候选新 WorldState、CommittedEvent、ApplyPacketResult
6. 三者全部经过 Schema 和关联关系校验
7. 确认 event 内嵌 packet 与原 packet 完全一致
8. 确认 `world_id`、`revision`、`event_id`、`packet_id` 相互一致
9. 最后才允许 `transaction.commit`
10. 整包提交或完整拒绝

禁止先改变数据库，再校验返回结果。

## 实现工作流

1. 先运行 `git status`，保护现有修改。
2. 每次围绕一个明确问题工作；先找到根因与接口所有者。若问题来自模块边界、职责划分或数据流，允许在既有真相源和依赖边界内做必要重构；不得局部缝补，也不得借机进行与当前问题无关的重设计。
3. 实现必须是永久代码。
4. 完成后只运行：
   - `npm run build`
   - 若修改 Server，再人工启动并请求 `GET /api/health`
   - `git diff --check`
   - 针对本次改动的静态扫描
5. 不重复全量验证未变化部分。
6. 最后报告修改文件、已证明的结果、仍未实现的下游接口，然后停止。
7. 不得自动提交或推送 Git，除非用户明确要求。

## 推荐实现顺序

1. ContentBundle 本地语义门禁与引用解析
2. RulePlugin operation 专属语义门禁
3. Packet precondition / source / deterministic-context 门禁
4. 闭合 EffectOp 的纯状态变换与穷举 Handler Map
5. SessionView 投影
6. 真实 AtomicPacketStore
7. 日循环、对话、EventCard 编排
8. 具体模型 Provider、RulePlugin ABI、Unity / StageModule 适配器

## v1 已定架构决策

- ContentBundle 的本地 `Identifier` 与运行时 UUID 只能由唯一 Content Runtime Identity Mapper 转换。固定算法为 RFC 9562 UUIDv5：namespace 使用运行时 `world_id`，name 使用 UTF-8 `pack_id + "\0" + kind + "\0" + local_id`；`kind` 必须是引擎闭合集合，初始实体、关系与状态机绑定分别使用 `entity`、`relation`、`state_machine_binding`。禁止随机映射、映射表第二真相或直接比较本地 Identifier 与运行时 UUID；Content Upgrade 改 local ID 时必须显式声明映射。
- `WorldDefinition` 必须通过必填 `director_profile_id` 精确选择同包、同 `world_id` 的唯一 DirectorProfile。模型调用方不得再传 `directorId`，禁止第一个、唯一一个或跨世界兜底选择。
- 新世界只能由显式 `WorldContentLock` 选定的 ContentBundle + WorldDefinition 初始数据创建；运行时 `world_id` 由 Server 生成。SaveEnvelope 是导入/导出合同，不作为与数据库并行的整份持久化文档。PostgreSQL 分字段保存唯一事实，导出时重建并整体验证，导入时整体验证后原子分解；v1 固定 `event_cursor === world_revision`。
- 登录与账号鉴权属于外部网关。Engine Session 只拥有 session、world、human ControlBinding、player entity、view/world revision 与随机 nonce。`basis_token` 使用独立于 DeterministicContext 的 HMAC-SHA-256 keyring，对上述状态的 JCS 摘要签名；它是不可解码的并发令牌，不是登录凭证，不使用时间 TTL，并在 View、World revision、Session 或 ControlBinding 改变时失效。
- Server 使用 PostgreSQL Command Journal，以 `(session_id, command_id)` 为唯一幂等身份；相同请求摘要恢复或返回已有结果，不同摘要明确冲突。RulePlugin 请求必须在执行前持久化，因其 deterministic + no_io 可用完全相同请求重放；已 dispatched 但无结果的模型调用保持 ambiguous/blocked，禁止自动重调；`apply_packet` 只用同一 packet ID 幂等重试；编排从最后持久阶段继续且不得写入 WorldState。
- Content Upgrade 的选择与提交合同已批准：Client 必须提交目标 PackLock、`migration_id` 与同意文本摘要；World Core 用第三套独立部署 HMAC keyring 签发绑定 command/world/player/source revision/源 SaveEnvelope 摘要/source-target digest/有效期的 `UpgradeAuthorization`。授权先写 PostgreSQL，再执行唯一 `content_upgrade.transform`；只有授权账本 `commit_ready` 且 RulePlugin 原始 request/response 精确命中时，source_kind 为 `content_upgrade`、唯一 op 为 `content_upgrade.apply` 的 packet 才能在同一个 `apply_packet` 事务中原子更新完整 SaveEnvelope 分字段事实与迁移历史。普通 RulePlugin、客户端、导入服务和其他 EffectOp 无权修改既有 world 的内容锁。
- ContentBundle 中全部 `catalog.entities` / `catalog.relations` 是同包所有 WorldDefinition 共享的初始世界图；需要不同初始图时必须发布不同 ContentBundle，不再为初始实体增加第二套 world 分组。每条 InitialRelation 必须拥有内容侧 `InitialVisibility`；`known_to` 只能引用符号玩家或本包本地 Entity，创建时才映射为 runtime UUID。新世界创建请求必须显式提供已验证的 `WorldContentLock` 与玩家名；WorldDefinition 必须拥有 `player_initial_components`、`player_location_relation_type_id`、`player_location_fields` 与 `player_location_visibility`。Server 创建 runtime world、player、human/CharacterMind ControlBinding、玩家起点关系及初始 frame；内容实体/关系/InitialMachineBinding 使用 UUIDv5，其余 Server 新建记录使用随机 UUID。初始 machine frame 固定 `indefinite + remain`；完整 revision-0 WorldSnapshot 与 ContentLock 必须先校验，再原子写 PostgreSQL。
- ContentBundle 的 RulePlugin operation 所有权固定为：WorldLaw evaluator → `rule.evaluate`；Capability resolver → `capability.resolve`；definition 类型 validator → `definition.validate`；WorldDefinition navigation/calendar → `navigation.resolve` / `day_cycle.advance`；GenerationArchetype generator → `world_extension.resolve`；ContentUpgrade transformer → `content_upgrade.transform`；StateMachine advance resolver → `state_machine.advance`；EventBudget card cost resolver → `event_card.publish`。其余世界级编排操作必须由 WorldDefinition 的必填 operation refs 精确选择 `goal_plan.validate`、两类 `automatic_event.*.resolve`、`stage_outcome.resolve` 与三类 `dialogue.*`，禁止按 kind 猜唯一插件。
- MaterializationProfile 不再把资产生成或审核策略伪装成 RulePlugin operation。`on_demand` profile 必须通过 `asset_provider_dependency_id` 精确引用一个 required `asset_provider` DependencyLock；生成、存储 I/O 属于 Server AssetProvider adapter，返回值按 Materialization Schema 视为不可信 JSON；review / promotion 只使用 profile 的闭合声明。required asset provider 必须命中组合根显式注册的 adapter，不得默认或降级。
- Server Materialization Ledger 是 Request、Candidate、ReviewReceipt 与 AssetAcceptance 的唯一事实所有者。AssetAcceptance packet 固定使用 `asset_acceptance { acceptance_id }` source，`packet_id === acceptance_id`、`cause_id === request_id`，并且只能包含一个带 `source_request_id + acceptance_id` 的 `visual_binding.upsert`；普通 RulePlugin 与 EventOutcome 无权写 VisualBinding。Review 与 Acceptance 原子入账，World Core 必须在持锁快照内重验全链、确定性上下文、主体 revision 与唯一 op，旧 revision 只转为 `superseded`，不得回退、重生成或直接写 WorldState。
- RulePlugin v1 制品 ABI 固定为进程内 `RulePluginModuleV1`。Unity 是唯一目标 Client / Stage Runtime；公开 Client Bridge 保持引擎中立以维护正确依赖边界，但不建设其他引擎 Host 或跨引擎制品兼容。Unity Host 只接受部署组合根显式注册的 Stage Runtime 实现，manifest `entrypoint` 只由 Unity 构建与部署流程解释，Engine 不扫描或动态加载目录。
- ModelProvider 是组合根唯一显式注入的 Server adapter；具体供应商、模型、密钥与超时是必填部署配置，不进入 ContentBundle、WorldState 或公共协议。v1 不做 Engine 级模型响应缓存，也不在 dispatched 后自动重试；超时或结果未知保持 ambiguous/blocked。
- `DecimalString` 是最长 128 字符的规范十进制定点串，只做精确运算，不使用浮点或舍入；禁止负零、无效前导零与小数尾零。首个严格零和的 `ledger.post` 可以原子创建不存在的 ledger，之后所有过账仍必须严格零和；v1 没有 mint/burn 特权，发行与库存账户由内容定义并通过普通平衡分录表达，Engine 不内置财政账户。

## 变更授权边界

下列内容已经有 v1 所有者；实现 Agent 不得改成其他方案。确需改变时只报告理由并等待用户批准：

- PostgreSQL 18.x + node-postgres 是 v1 唯一的 `AtomicPacketStore`；禁止 ORM、内存库、默认连接串、自动重试、运行时建表或 migration runner
- Unity Runtime、SDK 与包版本只能在正式 Unity Host 工程及其部署配置中显式锁定；当前尚无 Unity Host 工程，不得预选、默认或硬编码版本
- 模型供应商、模型名、密钥和超时只能由部署配置显式提供；禁止默认供应商、默认模型、Engine 级响应缓存与 dispatched 后自动重试
- 除本节已批准的 WorldDefinition 内容绑定/初始化/operation 所有者、InitialRelation/玩家起点 `InitialVisibility` 与 fields、MaterializationProfile asset provider 引用，以及上述 Content Upgrade 选择/授权/source/`content_upgrade.apply` 合同外，新增协议字段或 EffectOp 类型仍需用户批准

## 轻量开发

轻量指减少测试包装、审计仪式和无效流程，不代表最小改动、局部缝补、回避架构问题或降低实现质量。

### 架构与实现

- 时间优先投入真实实现、根因分析和架构清晰度，保持职责明确、依赖方向正确、真相源唯一。
- 工作中发现与当前目标相关的真实问题，必须明确指出；不得因为问题跨文件或跨模块而隐瞒。
- 若根因位于架构、模块边界、接口所有权或数据流，允许并应当进行必要重构，形成连贯的永久解决方案。
- 不做与当前问题无关的顺手重构，不提前建设没有现实需求的框架、兼容层或扩展点。
- 健壮性优先来自闭合合同、Schema 校验、明确失败、原子提交和正确的依赖边界，不来自大量测试包装、兜底分支或第二套模型。
- 不得以“轻量”为理由引入硬编码、默认值、假实现、临时代码、兼容旧接口或第二真相源。

### 轻量验证

- 禁止创建测试工程、测试目录、测试文件、测试夹具或专用冒烟脚本。
- 除非用户明确要求，不启用专门的测试 Agent、审计 Agent、多 Agent 双审或 writer/test/audit 接力；架构分析、源码检查和必要重构不属于应被压缩的测试成本。
- 一个稳定里程碑只做一次与风险相称的验证；后续改动只检查受影响部分。
- 验证只使用现有构建、`git diff --check`、针对改动范围的静态扫描、一次性只读 JSON/Schema 校验，以及修改 Server 时人工请求一次 `GET /api/health`。
- 验证失败后只复查失败项及其直接影响面，不重复全量验证未变化产物。
- 已有充分证据即可停止，不为了覆盖率、流程完整感或“证明健壮”继续扩大验证。
- 验证证据只留在任务输出，不写入仓库。
