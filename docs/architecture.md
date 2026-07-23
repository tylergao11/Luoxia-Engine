# Luoxia Engine 架构真相源

## 1. 产品定义

Luoxia Engine 是一个始终联网、服务端权威、外置内容包驱动的 AI 世界平台。主角永久携带 System；所有内容包都接受这一产品前提，但可以配置 System 的称呼、语气与视觉皮肤。

System 的正式职责是：

> 当玩家提出符合世界基本规则的目标，而当前世界没有预设入口时，寻找或工程化生成一条由玩家亲自执行的可行路径。

System 是目标解析器、可行路径导航器与世界缺口补全器。它可以修路，不能替玩家走路；可以创造机会和过程，不能免费创造结果。

## 2. 不可漂移的设计真理

1. **玩家行动不可代理**：System 不替玩家移动、交谈、战斗、交易、表白或作出其他世界行为。
2. **他人拥有主体性**：涉及其他角色意愿的目标只能形成互动路径，不能直接写成成功关系。
3. **世界规则优先**：资源、地理、制度、身份、因果与内容包硬规则约束所有 GoalPlan 和 ContentPacket。
4. **没有入口不等于不能尝试**：先复用既有 Capability 与合法流程；不足时才生成最小 WorldExtension。
5. **世界扩展保持中立**：可以增加角色职责、地点、制度、机会与流程；不得直接增加玩家收益、关系成功或目标完成状态。
6. **世界真相唯一**：只有 `apply_packet` 能提交权威状态。模型、插件、System、GDJS、客户端与资产引擎只提交 Proposal/Candidate。
7. **玩家知识受限**：服务端可以读取完整事实来避免矛盾；对玩家只投影其已知事实或 System 能力明确允许探查的事实。
8. **内容包不可变**：运行时新增人物、地点、组织、功法、物品、制度与任务进入 SessionDefinitions / WorldGraph，不反写 ContentBundle。
9. **表现不阻塞事实**：新对象先在世界中成立，专属资产异步生成；失败不回滚已提交世界事件。
10. **内容不进入核心**：World Core 不认识具体人物、世界、货币、功法、剧情、地点或内容包 ID。

## 3. 真相所有权

| 事实 | 唯一所有者 | 其他层能做什么 |
|---|---|---|
| 世界、人物、剧情、规则语义与美术内容 | 外部内容包直接维护的 ContentBundle JSON | Engine 按 Schema 校验并加载；内容包位于引擎仓库之外 |
| 运行时 JSON 字段、消息形状、枚举 | `contracts/*.schema.json` | 文档只解释职责与语义 |
| 架构边界与数据流 | 本文档 | README 只提供入口 |
| 初始世界、规则、原型、提示片段、美术基因 | 已发布的不可变 ContentBundle JSON | 内容作者直接维护，发布后按 digest 锁定 |
| 当前世界状态与动态定义 | WorldState / SessionDefinitions | 只经 `apply_packet` 修改 |
| 已发生事件 | CommittedEvent Log | 叙事与表现只能引用 |
| 玩家可见世界 | SessionView | 客户端只消费，不反推隐藏事实 |
| 舞台权威进度 | WorldState 中的 StageInstance | GDJS 只持有可丢弃的表现状态 |
| 视觉资产字节与审核收据 | Asset Store / Materialization Ledger | WorldState 只持稳定绑定引用 |
| 存档依赖锁 | SaveEnvelope | 固定 bundle、plugin 与 engine contract 精确版本 |

禁止把模型输出、客户端缓存、资产路径、插件内存、迁移默认值或编译产物变成第二真相。

## 4. 平台组成与依赖方向

```text
Luoxia Platform（整体发布、版本固定）
├─ Contracts
├─ World Core
├─ System Orchestrator
├─ Model Orchestrator
├─ apply_packet + Event Log
├─ ContentBundle Loader
├─ RulePlugin Host
├─ Materialization / Asset Engine
├─ GDJS Host + StageModule Host
└─ Online API / JSON Bridge

External Content Pack
├─ ContentBundle JSON（当前唯一内容源与发布输入）
├─ trusted RulePlugins
├─ GDJS StageModules
└─ assets / art profiles
```

依赖规则：

```text
Content Pack ──> Contracts
World Core   ──> Contracts
RulePlugin   ──> Contracts
GDJS Host    ──> Contracts + pinned official GDJS
App Host     ──> World Core + Content Pack + GDJS Host

World Core -X-> concrete Content Pack
World Core -X-> GDJS internals
RulePlugin -X-> database / model provider / GDJS / filesystem / network
StageModule -X-> WorldState / model provider / persistence
```

GDJS 是平台内部固定引用的大型运行库。公开合同不暴露 GDJS 对象、场景变量或事件表；内容包的 StageModule 可以在模块内部使用固定 GDJS 能力，但只通过版本化 JSON Bridge 与 World Core 通信。

## 5. 权威世界模型

World Core 使用内容无关的 Entity–Component–Relation Graph：

- **Definition**：可以实例化、学习、制作、传播或引用的定义；
- **Entity**：世界中实际存在的角色、地点、组织、物品、建筑或其他对象；
- **Component**：由锁定 ContentBundle 声明结构的完整属性值；
- **Relation**：实体之间有类型、数据和生命周期的边；
- **Ledger**：需要守恒、审计或明确铸造权限的数量资源；
- **CommittedEvent**：`apply_packet` 成功后形成的不可变事实记录。

引擎不预设世界专有字段。StateApplier 只接受整组件替换、类型化关系/账本操作和显式并发版本，不接受任意 JSON path patch、脚本或 `eval`。

### 5.1 静态、动态与解析视图

```text
ContentBundle Definitions   发布后不可变
SessionDefinitions          本次存档运行时创建
WorldGraph Instances        当前存在的实体、关系与组件
DefinitionCatalog           前两者合成的只读解析视图
```

静态引用必须锁定 `(bundleId, bundleDigest, localId)`；动态引用必须锁定 `(worldId, definitionId, revision)`。两类命名空间隔离，禁止 shadow、override、按显示名猜测或缺失时回退。DefinitionCatalog 只是派生读模型，不拥有定义真相。

一次性目标变化不自动产生 Definition。只有可再次学习、制作、传播、实例化或引用的概念才注册 DynamicDefinition。例如：离开组织是关系变化；创建新组织会产生组织 Entity 与必要制度；普通建筑可实例化既有 Definition；具备独特能力的新建筑或自创功法先注册 DynamicDefinition，再创建或学习。

## 5.2 Entity 控制、日循环与事件

### 5.2.1 Entity 不区分玩家与 NPC

World Core 只有一种角色实体。所谓玩家与 NPC，只是同一 `Entity` 在当前 Session 中绑定了不同控制器：玩家实体接受 human control；其他角色实体由各自的行动状态机与 Character Mind 驱动。内容规则、组件、关系、位置与事件目标不得按玩家/NPC 复制两套模型。

ContentBundle 直接初始化角色行动状态机、世界状态机、角色私有 MindProfile 与必要的初始日程。自动事件结构上携带 `ZeroEventCost`，不进入任何角色预算；给玩家发布的 EventCard 必须携带正数 `EventCost`，并从 human ControlBinding 对应的每日 EventBudget 扣除。因此 NPC 没有 AP 状态，Engine 也不硬编码“6 AP”等玩法数字。

### 5.2.2 一日的固定因果顺序

`Director.daily_settlement` 每日只调用一次，但整个日终结算是异步扇出—汇总过程：

```text
角色行动状态机与世界状态机推进当日意图，形成客观轨迹
  → Runtime 以最新已提交 world revision 投影 Director 动态上下文
  → Director 一次性返回 AutomaticEventProposal[]
      ├─ WorldEvent → RulePlugin 裁决并落地
      └─ CharacterEvent 按目标 Entity 聚合
           → 同一角色的多件事合并为一次 CharacterMind.react
           → 不同角色的小 LLM 异步并行、上下文彼此隔离
           → 各自返回 CharacterReactionProposal[]
  → Runtime 等待全部必要反应完成并经规则落地
  → 日终结算完成，进入玩家阶段并开启当日 EventBudget
  → 玩家点击地图移动：map.move → navigation.resolve → ContentPacket
  → 玩家与 NPC 对话：CharacterMind 免费回复并可提出主体性承诺；Runtime 只追加新 turn，Director.dialogue_events 观察 transcript
  → 玩家与 System 对话：Director.system_dialogue 同次返回回复及可选提案
  → EventCard 发布前完成裁决与结果封存；发布与 AP 扣除原子提交
  → 玩家点击卡片：只验证必要前置条件并应用封存结果
  → 玩家结束当日；仍 available 的当日卡过期且不退款
```

等待模型、并行任务与重试属于 Runtime 的编排工作状态，不写入 WorldState。NPC 反应落地后不在当天重新唤醒 Director；后续 Director 调用自然读取最新世界投影与客观轨迹。任何必要模型响应缺失都会使当前编排保持未完成，不生成无影响、跳过或替代结果。

### 5.2.3 事件权力、移动与派发模式

只有 Director 拥有事件调用上下文，也只有 Director 模型输出可以包含 EventProposal。System 不是第三个模型或第三份事件权力，它只是 Director 的玩家专属对话模式。玩家、角色状态机、世界状态机和 Character Mind 只能产生输入、意图、回答、反应、状态或客观轨迹；RulePlugin 只裁决；Runtime 才能验证、发布并提交。

事件只有两种派发模式：

1. **AutomaticEvent**：由 `Director.daily_settlement` 派发并自动处理。WorldEvent 直接交规则；CharacterEvent 交给受影响角色的小 LLM 决定主观影响、主体选择与自身状态机变化。NPC 在日结中的移动属于此模式，不占用玩家 EventBudget。
2. **EventCard**：由 `Director.dialogue_events` 或 `Director.system_dialogue` 根据自然语言交互提出，RulePlugin 在发卡前裁决，Runtime 封存精确结果并原子扣 AP。余额不足则不发布。卡片仅当日有效，无论玩家是否点击都不退款。

玩家地图移动是独立的导航命令：点击目标地点后，Runtime 通过内容包绑定的 `navigation_resolver` 校验并提交 `EntityRelocateOp`。它不调用模型、不生成 EventCard、不扣 AP，但提交后的位移与客观轨迹会被后续 Director 看见。砍人、做饭等结果性事件没有结构化按钮，也不存在全局动作文本或自然语言命令行。玩家只能在有接收者的 NPC/System 对话中表达；Director 根据接收者、位置、关系、世界状态与完整 transcript 判断是否提出 EventCard。对 System 表达遥远的物理行动目标只会得到指引，不会被视为行动已经发生。

事件表达一次结果性因果，不是任务、日程或“去找某人说话”的待办。EventCard 也绝不调用 Character Mind。NPC 对话回复可以附带 AgencyCommitmentDraft；Runtime 只能把经过验证的 Character Mind 输出封装成 AgencyCommitment 并追加到该 NPC 的 DialogueTurn。AgencyGate 必须声明受保护的 outcome ID、精确 semantic_intent、subjects 与 terms；Director 只能引用这份证据，不能替 NPC 编造或挪用同意。受保护的 EventCard 缺少逐字段匹配且仍有效的承诺时必须拒绝发布；Automatic CharacterEvent 的 Gate 不接受既有承诺，只使用目标 Character Mind 针对同一 requirement 返回的 AgencyDecision。

### 5.2.4 EventCard 的裁决、封存与点击

发卡时，RulePlugin 只能从 Director 给出的 `result_options` 中接受一个语义一致的结果，并把精确 `EventOutcomeOp[]`、额外必要前置条件、确定性上下文和结果叙事组成 `SealedEventResult`。涉及主体性的结果必须逐一解析所选 outcome 对应 AgencyGate 的 AgencyCommitmentRef，核对说话者、semantic_intent、subjects、terms 与有效日，并把每份 `agency.commitment_valid` 写入封存前置条件。自由叙事不能伪装成 NPC 台词；NPC 原话只能存为 `dialogue_quote`，引用已经提交的 DialogueTurn。Core 复算 `result_digest` 后，`EventCardPublishOp`、卡片状态和 AP charge 在同一个 ContentPacket 中提交。证据、规则或余额不成立时提案不成卡，也不扣费。

点击时不再调用 LLM 或 RulePlugin，不重新裁决、不改写结果、不预留资源：

```text
加载 available 卡片与 SealedEventResult
  → Core 固定校验 card.day = current day、player phase、卡片控制权、sealed digest，再校验封存的额外必要前置条件
      ├─ 成立：封存 ops + event_card.trigger 原子提交，再展示封存叙事
      └─ 不成立：event_card.invalidate 原子提交，明确显示失效原因码
```

`expired` 只表示跨日未处理；`invalidated` 表示点击时必要条件已不成立。两者均不退款。`event_card.trigger` 的 StateApplier 语义固定要求 available、同一 control、card.day 与当前 day 相等且 digest 一致，不能由插件或空 preconditions 放宽；从 player phase 离开时，同一个 `day_cycle.advance` Packet 必须穷举并 expire 当日全部未处理卡，进入下一次 player phase 时在同一 Packet 打开该日唯一 EventBudget。若卡片结果是发起决斗，封存的结果只能是打开权威 StageInstance，胜负仍由后续 `stage_outcome.resolve` 决定，不能提前封存胜者。

### 5.2.5 Character Mind 对自身状态机负责

CharacterEvent 只描述角色遭遇了什么，不替角色规定反应。目标 Character Mind 可以提出无影响、主观状态变化、中断当前行动循环、切换状态、持续若干天，以及到期后的恢复方式。

状态切换既可以引用内容包预定义状态，也可以提出运行时语义状态，例如“在某地点躲藏三天”或“闭关直到某规则成立”。运行时语义状态由 `semantic_intent + parameters + tenure + continuation` 表达，必须经过能力、参数、持续期与世界规则校验；它不要求内容包提前枚举 `state_id`，也不会自动注册为可复用 Definition。

Character Mind 只能返回结构化 ReactionProposal，不能直接写 WorldState、输出 EffectOp 或生成新事件。角色身份只由请求绑定，Reaction 内没有可伪造的 actor/character 字段；AgencyDecision 隐式属于该角色，`self_outcomes` 也只能落到该角色自身的主观组件、记忆或状态机。AutomaticEvent 的客观结果只能来自 Director 原提案，Core 必须拒绝 Character Mind 借 parameters 或插件输出改写其他实体。持续期一经提交，之后由 Runtime 按日确定性推进，不需要小 LLM 每天重复确认。

## 6. System：Director 的玩家专属模式

### 6.1 身份与单次调用

System 是常驻角色包装，但不是独立 LLM。`Director.system_dialogue` 复用同一 Director、同一事件调用上下文和同一世界投影，只增加 System 人设与模式 Prompt；它有独立对话历史与缓存键，不能形成第二份世界真相。

一次 System 调用必须同时返回：玩家可见回复，以及零个或多个 EventCardProposal、GoalPlanProposal、DynamicDefinitionProposal。三类共享草案只在 `world-runtime.v1.schema.json` 定义，ModelProtocol 与 RulePlugin 都只能引用同一类型。Runtime 不为了“先理解、再规划、再叙事”重复调用同一个模型。模型失败会阻塞本次交互，不生成兜底回复或兜底结果。

### 6.2 Goal 到可行路径

```text
玩家向 System 描述目标
  → Director.system_dialogue 解析目标与主体性边界
  → 检索事件上下文中的 Capability、制度、角色职责与合法流程
      ├─ 已存在：回复指引，或提出可验证 GoalPlan / EventCard
      └─ 不存在：提出最小 Definition / WorldExtension 所需草案
  → RulePlugin / World Law 校验
  → 玩家亲自完成所需世界行为
  → 仅由 CommittedEvent / WorldState 判定完成
```

System 模式拥有 Director 的“提出事件”资格，但没有直接写世界或 `act_as_player` 路径。它不能绕过 EventCard 的发卡、封存、扣费和点击规则，也不能替玩家移动、交谈、战斗、交易或免费获得结果。

### 6.3 GoalPlan 与 WorldExtension

GoalPlan 是持久、结构化、可验证的目标工程，不是一组客户端按钮或任务文案。它描述目标、期望终态、事实依据、语义步骤依赖、完成规则、替代路径、知识作用域与必要的延迟扩展；具体世界行为仍由玩家表达。

GoalPlan 不得包含自动执行命令、EventProposal、EffectOp 或隐藏事实的玩家文案。完成只引用 RuleRef 与已提交事实，禁止关键词念咒完成任务。

Director 只规划一次：输出 GoalPlanProposal 后，RulePlugin 的 `goal_plan.validate` 必须验证同一份 GoalPlanDraft，并且只能返回 Reject 或恰好包含一个 `goal_plan.upsert` 的 PacketProposal。GoalPlan 固定保存 `source_proposal_id + source_draft_digest`；Core 复算 digest，并从原草案规范化复制 goal、expected_state、facts、constraints、nodes 与 knowledge_scope，插件只可补引擎拥有的 ID、revision、状态和 demand request。任一语义字段不同即拒绝，规则层不得从原始目标重新规划，也不存在 GoalPlanDraft 直写 WorldState 的接口。

每个 GoalNode 使用 CapabilityRequirement：`bound` 只能使用 `catalog_kind=capability` 的已存在引用；`demand` 用 CapabilityDemand 描述当前世界尚无入口的语义需要，其 allowed_archetypes 只能使用 `catalog_kind=generation_archetype`。所有引用必须在锁定 Bundle 中存在并通过适用规则，否则只能 Reject，不能伪造 CatalogRef 或猜测替代项。验证后的 demand 节点必为 blocked，并携带只引用该 demand ID 的 WorldExtensionRequest。

合理入口缺失时，`world_extension.resolve` 只从 WorldState 中按 plan/node/request ID 读取这份已验证请求，依次复用能力、职责、角色、地点与制度，最后才通过允许的 GenerationArchetype 提出创建结果。它只能绑定既有通用 resolver 并返回 PacketProposal，不能创造新 EffectOp、直接完成目标、返回第二份扩展草案或启用兜底路径。

## 7. 权威写入：ContentPacket 与 `apply_packet`

常规裁决路径：

```text
Director EventProposal / CharacterReactionProposal / StageOutcomeProposal / validated System proposal
  → RulePlugin.resolve（只读上下文，返回 PacketProposal 或 Reject）
  → Core 在同一快照上封装 ContentPacket
  → Schema + Semantic + Preconditions + DeterministicContext 校验
  → apply_packet 原子提交或完整拒绝
```

EventCard 点击路径只复用已经裁决的封存结果：

```text
event_card.trigger command
  → Core 校验卡片生命周期与 SealedEventResult.preconditions
  → ContentPacket(source_kind = sealed_event_result)
  → apply_packet(封存 EventOutcomeOp[] + event_card.trigger)
```

`ContentPacket.source` 明确区分 `rule_plugin` 与 `sealed_event_result`。后者必须引用 WorldState 中同一 card/result/digest，Core 不能借此拼装新结果。相同 packet 重试必须幂等；前置条件不匹配时完整拒绝，不做“尽量应用”。

`EffectOp` 是闭合、版本化的引擎语法。对话只能由 human 首轮打开，之后只允许 `dialogue.turn.append` 与 `dialogue.close`；每次追加携带 expected revision，既有 turn、来源摘要与 AgencyCommitment 永远不可覆盖、删除或重排。动态 NPC 只可通过 `state_machine.create` 建立一个引用既有 StateMachine 的实例，不得生成新状态机 executor。`EventOutcomeOp` 是 EffectOp 的严格子集，允许结果改变定义、实体、组件、关系、账本、位置、知识、记忆、日程、时间、目标、状态机，或打开 Stage；它禁止嵌套发布/触发卡片、打开预算、写对话、改变控制权和直接推进日循环。

普通 Packet 不包含模型草稿、资产 URI 或 GDJS 指令。唯一例外是 `EventCardPublishOp` 内已封存的卡片标题、摘要与结果叙事：这些字段是惰性的表现数据，不参与规则求值，只有结果成功提交后才经 `narrative.show` 展示。模型与客户端仍不能提交 ContentPacket 或 EffectOp；RulePlugin 只能返回 PacketProposal，由 Core 重新校验并封装。

## 8. RulePlugin

首版内容包由项目方与 Agent 制作，RulePlugin 可视为受信代码，但仍遵守最小权限：

- 无状态、无 I/O，只接收只读快照、已验证命令、内容配置与 DeterministicContext；
- `operation_kind` 是请求的唯一 discriminator；响应必须回显同一 kind，并命中该 operation 的闭合输出合同。不存在通用 RulePluginOutput 或“任意 PacketProposal”入口；
- 可以评估 RuleRef、解析 Capability、验证同一份 DynamicDefinitionProposal / GoalPlanProposal、解析已提交的 WorldExtensionRequest、提出该 operation 白名单内的 PacketProposal，以及执行显式内容升级映射；
- 不能访问数据库、模型 Provider、文件系统、网络、GDJS 或 WorldState 写句柄；
- 不能调用 `apply_packet`，不能发明新的 EffectOp executor；Core 还必须逐项验证 `proposed_by` 与 request/plugin/operation 相同，并验证每个 op 属于该 operation 的 allowed-op 子集；
- 随机只返回 ChoiceSpec；DeterministicContext 由 Core 签发 context ID、digest 与 token，插件响应必须原样回显，Core 比对后才可封装 Packet；
- 插件 API 版本与实现 digest 被存档锁定，缺少依赖时拒绝加载，不启用通用兜底规则；
- 内容包只声明通用 capability/plugin ID 与配置，组合根解析实现，World Core 不按世界 import 代码。

未来开放第三方包时保留同一协议，把 Host 替换为签名与沙箱执行，不改变 World Core。

## 9. StageModule 与 GDJS

StageModule 只拥有可丢弃的表现临时状态，例如动画、碰撞采样、镜头、粒子、音效和实时输入。权威 StageInstance、计时、进度、已触发标记与完成条件属于 WorldState。

```text
World Core → StageOpen（可见上下文、允许输入、资产绑定）
GDJS       → StageInput
GDJS       → StageOutcomeProposal（语义结果与证据，不含 EffectOp）
World Core → stage_outcome.resolve（只允许 EventOutcomeOp / stage.update / stage.close）→ PacketProposal → ContentPacket → apply_packet
World Core → StageClose + SessionView
```

StageModule 只消费已提交 Signal 并提出后续 Proposal，不得在回调中重入提交。多个模块的顺序由显式依赖 DAG 决定，冲突直接报告。阶段完成条件必须是可求值谓词，不能藏在文案、模型判断或 GDJS 分支里。

首版纯原画表现同样运行在 GDJS Host：场景原画、人物立绘、表情、转场、镜头、微动、天气、粒子与音效。未来新增可行走角色或复杂舞台只需新增 StageModule，不修改 World Core 权威合同。

## 10. World Core ↔ GDJS JSON Bridge

Bridge 是传输无关的版本化 JSON Envelope。首版在线实现可使用 WebSocket 推送和 HTTPS 命令入口，但合同不绑定传输库。

GDJS 只认识固定渲染原语、通用交互消息和不透明内容 ID，不接收完整 WorldState，不按 `world_id` 分剧情。客户端可以提交：自然语言对话、`map.move`、EventCard 触发、结束玩家日、StageInput、StageOutcomeProposal 与 ACK/readiness。客户端没有砍人、做饭等结构化行动按钮，也没有事件派发或 AP 写入接口。

`map.move` 只携带目标地点；actor 从鉴权 Session 的 human ControlBinding 推导，内容包的 `navigation_resolver` 决定可达性并产生位置提案。成功位移通过 SessionView 返回，失败通过 CommandResult 明确拒绝，不转交 Director。

服务端只能推送 SessionView、对话回复、CommandResult、PresentationFrame、Stage open/update/close、AssetBinding 与协议错误。SessionView 与 DialogueReply 只携带 DialogueView/DialogueTurnView；模型请求 ID、输出摘要、AgencyCommitment 与内部 dialogue revision 永不下发客户端。卡片结果叙事只在封存结果成功提交后，通过 `narrative.show` 发送；其中 `dialogue_quote` 由服务端从不可变 DialogueTurn 投影为 DialogueTurnQuoteView，Director 不能提供 speaker 或 text。

每条命令携带 command/message ID、session ID 与会话级 `basisToken`，用于幂等、并发拒绝和因果追踪。客户端不接收会因隐藏事实变化而泄密的全局 world revision。SessionView delta 只能应用到匹配的 view revision，否则全量重同步；不支持的新渲染原语明确报协议不兼容，不按内容包补客户端分支。

## 11. Materialization / Asset Engine

运行时新 Definition、Entity、NPC、地点、组织或建筑可以产生 MaterializationRequest：

```text
CommittedEvent / new subject revision
  → derive required visual slots
  → search session / pack / reviewed library
  → reuse or deterministic derivation
  → generate on miss
  → style / technical / semantic review
  → immutable bytes + provenance + content digest
  → AssetAcceptance
  → PresentationBinding
  → asset.ready through JSON Bridge
```

该设计吸收 GameCastle 的资产引擎思想，但不复制其代码：

- 世界提交先完成；专属资产异步产生，失败不回滚世界；
- 资产按内容 hash 寻址，文件路径不是身份；
- 请求锁定主体 definition revision、视觉槽位、风格 digest 与生成规格 digest；VisualBinding 提案不含提交事件 ID，由 apply_packet 在提交时注入；
- 候选结果必须匹配 request ID 和主体 revision，过期候选不得绑定；
- fallback 由内容包的 VisualSlot 显式声明；没有 fallback 时显示通用 pending 状态，不伪造内容资产；
- 接受决定、绑定 hash 与来源写入独立 Ledger；重载直接复用，blob 缺失显式报损坏，不静默重生成；
- WorldState 中的 VisualBinding 永远是 session scope；不可变 Pack 资产来自 ContentBundle，Shared Library 只由独立审核晋升服务写入，世界 ContentPacket 无权晋升；私人创造不自动跨世界传播。

## 12. 模型角色、上下文分区与调用协议

模型协议只使用严格、版本化 JSON Schema，不使用语义 DSL，不向模型暴露 GDJS 字典、WorldState 写句柄或 EffectOp。运行时只有两个模型层级：

- **Director 大模型**：唯一拥有事件调用上下文。System 是它的玩家专属模式，不是第三个模型。
- **Character Mind 小模型**：每个自主角色逻辑上各有隔离的 MindProfile、主观视图、对话历史与缓存，只负责该角色回答和自身反应。

固定入口只有五个：

```text
Director.daily_settlement  → AutomaticEventProposal[]
Director.dialogue_events   → EventCardProposal[]
Director.system_dialogue   → reply + EventCard/GoalPlan/Definition proposals
CharacterMind.dialogue     → reply + AgencyCommitmentDraft[]
CharacterMind.react        → CharacterReactionProposal[]
```

不存在独立 `System.*`、`Narrator.render` 或 `materialization.spec` 文本模型入口。`request_kind` 是 ModelRequest 的唯一入口 discriminator；ModelResponse 必须回显 request_kind、resident_context_digest、dynamic_input_digest 与 output_digest，Core 与 pending request 全量比对后才生成 VerifiedModelOutputRef，任何角色或缓存摘要不匹配都直接拒绝且无兜底。Character Mind 的 commitment 只是未落地证据草案：Core 必须验证响应角色与证明，再经 append-only 对话 Packet 写入；Director、System、客户端和内容包均无 commitment 写入口。EventCard 结果叙事由 Director 与语义结果一同提出并在发卡时封存，但 NPC 原话只能引用既有 turn；资产引擎直接根据 Definition、ArtProfile、MaterializationProfile 与视觉槽生成规格。

### 12.1 常驻区与动态区

每次 ModelRequest 明确拆成 `resident_context` 与动态 `input`。Provider Adapter 必须按下列顺序组装 Prompt：

```text
常驻前缀：common_blocks
  → Director event_context 或 Character persona_blocks
  → mode_block
动态尾部：最新 basis_revision 对应的 world/subjective view
  → objective traces / dialogue / event batch
```

Director 的 common_blocks 固定放 Engine 契约、Director 核心 Prompt 与内容包静态上下文；event_context 固定放事件合同、Capability Catalog 与 World Law Catalog；三个模式只替换最后的 mode_block。因此同一 Director 的三个模式可命中共同前缀，模式内可命中完整常驻前缀。

Character Mind 的 common_blocks 固定放角色协议，persona_blocks 固定放不可变身份、背景与性格，mode_block 区分 dialogue/react。动态主观知识、记忆窗口、行动状态机与本次对话/事件数组永远在尾部。不同角色不得共享 persona cache key。

`request_id`、时间戳、`basis_revision`、world revision、游标和本次输入摘要不得插入常驻前缀。每个块按规范化字节计算 digest；任一常驻源变化必须产生新 revision/digest，不得原地覆盖。缓存未命中只允许增加延迟与 Token，绝不能改变语义、缩减输入或启用另一套 Prompt。

### 12.2 隔离与失败

Director 不读取角色完整私有 Prompt、私有缓存或未表达的内心。角色之间也不共享私有上下文。ResidentContextRef、缓存与投影都只是可丢弃派生物；WorldState、ContentBundle lock、允许可见的 transcript 和 CommittedEvent 才是真相。

同一日终结算中，Runtime 先按目标 Entity 聚合 CharacterEvent；同一 Character Mind 一次接收事件数组，不同 Character Mind 异步并行。全部必要反应经过规则处理后结算才完成。模型失败、等待与重试只属于编排状态，不写入 WorldState，也不产生默认 `no_effect`、跳过或兜底回答。

## 13. ContentBundle JSON

当前设计阶段不建立 Excel、CSV、ContentDesignIR 或内容编辑器编译链。每个外部内容包直接维护符合 `contracts/content-bundle.v1.schema.json` 的 ContentBundle JSON；这份 JSON 同时是内容作者的唯一内容源和 Engine 的发布输入。

所有引擎 JSON 摘要统一为：先按 RFC 8785（JCS）规范化目标 JSON 值，编码为 UTF-8，再计算 SHA-256，输出小写十六进制。`ContentBundle.release.bundle_digest` 只计算根对象的 `bundle` 值，不包含 `release` 包装，避免摘要自引用。`release` 不保存工作簿版本、编译器版本或另一份源摘要；ContentBundle JSON 本身就是源。

- ContentBundle JSON 面向项目方、内容 Agent 与技术内容作者，不承诺是最终策划体验；
- Engine 只做 Schema、引用、主体性、资源与世界规则校验，不从缺失字段猜默认规则，也不在运行时调用模型解释内容文件；
- 内容 JSON 可以声明内容定义并引用公开合同，但不能携带 EffectOp、WorldState 写入、模型供应商配置、GDJS 内部对象或迁移命令；
- 已发布 Bundle 不得原地修改；任何内容变更都产生新的版本与 digest；
- 引擎仓库不保存具体内容包，不按 `pack_id`、`world_id` 或具体剧情写分支；
- 未来若增加 Excel 或可视化编辑器，它只能是同一 ContentBundle JSON 的作者界面，单向生成相同合同，不能建立第二套内容数据库或第二种运行时输入。

ContentBundle 不是预制任务全集。它提供初始世界、角色行动状态机、世界状态机、事件种子、规则语义与可行路径；运行时自由度仍由通用规则、角色独立反应、Director 事件和 System 的世界缺口工程共同产生；只有 Director 拥有事件调用上下文。

## 14. 内容版本、存档与迁移

1. SaveEnvelope 使用唯一 `root_bundle_lock` 永久绑定 base `pack_id + pack_version + bundle_digest`；依赖包另列，加载时不自动选择最新版。
2. 同一存档不切换到另一个 base pack。
3. 已发布 ContentBundle 不得原地修改；存档同时锁定 RulePlugin 与 StageModule 精确实现 digest，服务器保留所有活跃存档仍引用的 bundle、实现与资产 blob。
4. Save Schema Migration 与 Content Upgrade 是两条独立流程：前者只改变存档结构，禁止改变 bundle lock 或重新解释世界事实；后者必须由用户/运营显式发起。
5. Content Upgrade 必须提供精确 source/target digest、声明式 ID 映射、所需实现锁，以及 Core 签发的玩家升级命令与同意凭证；禁止自动升级或按显示名猜测重绑。
6. 两类迁移都只能在服务端安全点逐版本、确定性执行，完整验证后原子写入新存档；成功前保留旧 bundle 和旧存档。
7. 无法从旧真相推导的新字段只能标记 unresolved 或停止迁移，禁止发明默认世界事实。
8. DynamicDefinition、GoalPlan、WorldExtension、StageInstance 与 MaterializationBinding 属于存档，迁移必须显式保留、转换或拒绝。
9. 每次迁移记录 source/target、engine/plugin/compiler 版本、确定性输入、执行时间与结果，支持运营回溯。

## 15. 首版非目标

- 离线权威模式或离线存档；
- 第三方不可信插件市场与沙箱；
- Q 版可行走世界；
- 模型生成代码、GDJS 事件或 StageModule；
- 自动为每个自由行动生成图片；
- 跨 base pack 存档迁移；
- 搬迁旧项目代码或兼容旧存档；
- 测试工程、测试夹具与冒烟脚本。

## 16. 合同文件所有权

| 合同 | 精确字段所有者 |
|---|---|
| 通用 ID、静态/动态引用、来源与可见性 | `contracts/common.v1.schema.json` |
| ContentBundle JSON 与表现配置 | `contracts/content-bundle.v1.schema.json` |
| GoalPlan、ContentPacket、EffectOp、SessionView、SaveEnvelope | `contracts/world-runtime.v1.schema.json` |
| RulePlugin manifest、request、response | `contracts/rule-plugin.v1.schema.json` |
| 客户端、GDJS Host 与 StageModule 消息 | `contracts/gdjs-bridge.v1.schema.json` |
| MaterializationRequest、资产收据与绑定 | `contracts/materialization.v1.schema.json` |
| 模型各阶段 request/response | `contracts/model-protocol.v1.schema.json` |

本文档不得复制这些 Schema 的完整字段表。字段变更只改对应 Schema；内容数据只改外部 ContentBundle JSON；架构责任变化才改本文档。
