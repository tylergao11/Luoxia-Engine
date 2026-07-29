# Luoxia Engine 架构真相源

## 1. 产品定义

Luoxia Engine 是一个始终联网、服务端权威、外置内容包驱动的 AI 世界平台。主角永久携带 System；所有内容包都接受这一产品前提，但可以配置 System 的称呼、语气与视觉皮肤。

System 的正式职责是：

> 当玩家在已选择的 System 对话中提出符合世界基本规则的目标，而当前世界没有预设入口时，寻找或工程化生成一条由玩家亲自执行的可行路径。

System 是目标解析器、可行路径导航器与世界缺口补全器。它可以修路，不能替玩家走路；可以创造机会和过程，不能免费创造结果。

产品表现形态固定为 **2D 世界生活主体 + 可选的有限 3D Stage**。首版由 Unity 以场景原画、人物立绘、对话、地图、GoalPlan、EventCard 与日循环承载长期世界体验；后续 3D 不是无缝开放世界，而是从同一权威世界打开、在有限上下文中运行并回交语义结果的秘境式 StageInstance。3D Stage 的首要职责是隔离局部实时交互，不改变服务端按事件提交、按天推进世界演化的时间模型。

产品交互不是命令行，也不是把自然语言交给 AI 代理代替玩家行动。首版玩家通过 2D GUI 直接选择地图目的地、交谈对象、GoalPlan、EventCard 与结束当天；自由文本只存在于已选择的 NPC/System 对话内，语义只能是玩家对该对象说的话。对话可以产生信息、关系变化、计划与机会，但不得把文本解析成移动、战斗、修炼、做饭等通用行动；具体行动由地图与功能 UI 触发，未来秘境行动由玩家在 3D Stage 中直接操作。

## 2. 不可漂移的设计真理

1. **交互不是代理命令**：玩家没有全局自然语言行动入口；自由文本只属于当前已选择的 NPC/System 对话。协议和代码中的 `Command`、`command_id`、Command Journal 与 CommandResult 仅表示可幂等恢复的服务端交互事务，不代表玩家侧命令行。
2. **玩家行动不可代理**：System 不替玩家移动、交谈、战斗、交易、表白或作出其他世界行为。
3. **他人拥有主体性**：涉及其他角色意愿的目标只能形成互动路径，不能直接写成成功关系。
4. **世界规则优先**：资源、地理、制度、身份、因果与内容包硬规则约束所有 GoalPlan 和 ContentPacket。
5. **没有入口不等于不能尝试**：先复用既有 Capability 与合法流程；不足时才生成最小 WorldExtension。
6. **世界扩展保持中立**：可以增加角色职责、地点、制度、机会与流程；不得直接增加玩家收益、关系成功或目标完成状态。
7. **世界真相唯一**：只有 `apply_packet` 能提交权威状态。模型、插件、System、Client Runtime、StageModule、客户端与资产引擎只提交 Proposal/Candidate。
8. **玩家知识受限**：服务端可以读取完整事实来避免矛盾；对玩家只投影其已知事实或 System 能力明确允许探查的事实。
9. **内容包不可变**：运行时新增人物、地点、组织、功法、物品、制度与任务进入 SessionDefinitions / WorldGraph，不反写 ContentBundle。
10. **表现不阻塞事实**：新对象先在世界中成立，专属资产异步生成；失败不回滚已提交世界事件。
11. **内容不进入核心**：World Core 不认识具体人物、世界、货币、功法、剧情、地点或内容包 ID。

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
| 舞台权威进度 | WorldState 中的 StageInstance | Client Runtime 只持有可丢弃的表现状态 |
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
├─ Client Runtime Host + StageModule Host
└─ Online API / Client Bridge

External Content Pack
├─ ContentBundle JSON（当前唯一内容源与发布输入）
├─ trusted RulePlugins
├─ StageModules（由具体 Client Runtime 适配器加载）
└─ assets / art profiles
```

依赖规则：

```text
Content Pack        ──> Contracts
World Core          ──> Contracts
RulePlugin          ──> Contracts
Client Runtime Host ──> portable Contracts + 具体客户端运行时
App Host            ──> World Core + Content Pack + Client Runtime Host

World Core -X-> concrete Content Pack
World Core -X-> Unity 运行时内部对象
Server     -X-> Unity 运行时内部对象
RulePlugin -X-> database / model provider / 客户端运行时内部对象 / filesystem / network
StageModule -X-> WorldState / model provider / persistence
```

Unity 是唯一目标 Client Runtime Host，但它仍是 World Core、存档与通用协议之外的适配层。公开合同使用引擎中立的 Client / Stage Bridge，以维持依赖方向和服务端权威，而不是为了支持多引擎。Unity 版本与包属于 Host 部署配置，不进入 WorldState、SaveEnvelope、StageModuleLock、通用客户端握手或通用 StageModule manifest。公开合同不暴露 Unity 对象、Scene、MonoBehaviour 或内部状态；StageModule 可在 Unity Host 内使用具体运行时能力，但只通过版本化 JSON Bridge 与 Server 通信。

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

“按天推进”不是把玩家行为延迟到日结才生效。对话、EventCard、关系、物品、伤势及其他确定结果仍在发生时经 `apply_packet` 立即提交；日边界只负责 NPC 与世界状态机、自主事件、延迟后果和下一日机会的集中推进。世界不会按现实时间在玩家未提交命令时自行流逝，玩家阶段只由显式 `player_day.end` 结束。

等待模型与并行任务属于 Runtime 的编排工作状态，不写入 WorldState。Server 使用 PostgreSQL Command Journal，以 `(session_id, command_id)` 锁定请求摘要和命令所有的稳定子身份：同一摘要恢复或返回已有结果，不同摘要明确冲突。阶段只从 Command Journal 身份、模型/RulePlugin Journal 和 CommittedEvent 等各自真相组合推导，不复制第二份 workflow 状态。基础对话首次接收时原子保存 dialogue、human/character turn、两次 RulePlugin request 与一次 model request 共六个 UUID；专属 Dialogue Director run 再持久化 `director.dialogue_events` 或 `director.system_dialogue` model request ID。verified Director 输出中的 Definition、GoalPlan、EventCard 三类提案必须一次性按精确顺序绑定 proposal ID 与 RulePlugin request ID；Definition/GoalPlan 同时绑定 Server 生成的 WorldState ID 及稳定 provenance 时间。后续按 Definition → GoalPlan → EventCard 固定顺序执行，阶段仍只由各 Journal 与 CommittedEvent 推导。三类动态提案的唯一当前持久化所有者是 `dialogue_director_proposal_runs`；旧的 EventCard 专用子表不再属于当前 schema，也不得形成兼容读取或第二真相。已有部署数据库必须由部署流程显式迁移或重建，Engine 不在运行时改表。`event_card.trigger` 在 Command Journal 持有与客户端 command ID 分离的 Server packet ID；`map.move`、`dialogue.close` 与 `stage.outcome_proposal` 各自持有 Server 生成、全局唯一的 RulePlugin request ID；`content_upgrade.accept` 同时持有全局 upgrade/packet ID 与独立 RulePlugin request ID；`player_day.end` 只额外保存不可变的源日。日循环的状态机、Character Reaction、AutomaticEvent 与三种 phase transition 使用 PostgreSQL `(world_id, day, execution_kind, subject_id)` 唯一身份表取得稳定 request ID；WorldExtension resolver request ID 则由 runtime world、plan、node 与已提交 extension request 通过 UUIDv5 唯一派生，不建立映射表。同一 world 同时只允许一条 `received` 命令。RulePlugin 请求在执行前持久化，因其 deterministic + no_io 可以用完全相同请求重放；Content Upgrade 还必须先持久化 Core 授权，并在 resolved 输出核验后把授权账本单向推进到 `commit_ready`。`apply_packet` 只用同一 packet ID 幂等重试。已 dispatched 但没有持久化结果的模型调用保持 ambiguous/blocked，禁止自动重调并继续持有 world 执行槽。命令完成时 Session 推进、CommandResult 与精确 ServerEnvelope outbox 在同一 PostgreSQL 事务提交，重复命令重放相同 message ID、sequence 与正文。NPC 反应落地后不在当天重新唤醒 Director；后续 Director 调用自然读取最新世界投影与客观轨迹。任何必要模型响应缺失都会使当前编排保持未完成，不生成无影响、跳过或替代结果。

新世界 revision 0 固定处于 day 1 `autonomous`，不预开 EventBudget。可信管理面必须先调用 `kernel.dayCycle.advanceToPlayer`：Runtime 先按 GoalPlan/GoalNode 原序串行解析 active 计划中已提交的 WorldExtensionRequest，再按实例顺序推进全部状态机，提交 `autonomous → director_settlement`，从连续 CommittedEvent 重建上个 settlement 边界以来的客观轨迹并执行每日唯一 Director 请求；CharacterEvent 按目标 Entity 聚合并行调用 Character Mind，AutomaticEvent 再按 Director 顺序经专属 RulePlugin resolver 串行提交；最后 `director_settlement → player` 与该日唯一 `event_budget.open` 同包提交。`player_day.end` 固定提交 `player d → autonomous d+1`（同包穷举过期卡），随后恢复同一流程直到下一日 player；命令持久化的 `from_day` 防止崩溃重进时多推进一天。

### 5.2.3 事件权力、移动与派发模式

只有 Director 拥有事件调用上下文，也只有 Director 模型输出可以包含 EventProposal。System 不是第三个模型或第三份事件权力，它只是 Director 的玩家专属对话模式。玩家、角色状态机、世界状态机和 Character Mind 只能产生输入、意图、回答、反应、状态或客观轨迹；RulePlugin 只裁决；Runtime 才能验证、发布并提交。

事件只有两种派发模式：

1. **AutomaticEvent**：由 `Director.daily_settlement` 派发并自动处理。WorldEvent 直接交规则；CharacterEvent 交给受影响角色的小 LLM 决定主观影响、主体选择与自身状态机变化。NPC 在日结中的移动属于此模式，不占用玩家 EventBudget。
2. **EventCard**：由 `Director.dialogue_events` 或 `Director.system_dialogue` 根据玩家与已选 NPC/System 的对话内容提出，RulePlugin 在发卡前裁决，Runtime 封存精确结果并原子扣 AP。余额不足则不发布。卡片仅当日有效，无论玩家是否点击都不退款。

玩家地图移动是独立的导航命令：点击目标地点后，Runtime 通过内容包绑定的 `navigation_resolver` 校验并提交 `EntityRelocateOp`。它不调用模型、不生成 EventCard、不扣 AP，但提交后的位移与客观轨迹会被后续 Director 看见。砍人、做饭等结果性事件没有结构化按钮，也不存在全局动作文本或自然语言命令行。玩家只能在有接收者的 NPC/System 对话中表达；Director 根据接收者、位置、关系、世界状态与完整 transcript 判断是否提出 EventCard。对 System 表达遥远的物理行动目标只会得到指引，不会被视为行动已经发生。

事件表达一次结果性因果，不是任务、日程或“去找某人说话”的待办。EventCard 也绝不调用 Character Mind。NPC 对话回复可以附带 AgencyCommitmentDraft；Runtime 只能把经过验证的 Character Mind 输出封装成 AgencyCommitment 并追加到该 NPC 的 DialogueTurn。AgencyGate 必须声明受保护的 outcome ID、精确 semantic_intent、subjects 与 terms；Director 只能引用这份证据，不能替 NPC 编造或挪用同意。受保护的 EventCard 缺少逐字段匹配且仍有效的承诺时必须拒绝发布；Automatic CharacterEvent 的 Gate 不接受既有承诺，只使用目标 Character Mind 针对同一 requirement 返回的 AgencyDecision。

### 5.2.4 EventCard 的裁决、封存与点击

发卡时，RulePlugin 只能从 Director 给出的 `result_options` 中接受一个语义一致的结果，并把精确 `EventOutcomeOp[]`、额外必要前置条件、完整 `DeterministicContext` 和结果叙事组成 `SealedEventResult`。封存结果不得只保留 context ID/digest 而把可执行证据留在 CommittedEvent；完整上下文本身已经拥有 ID、摘要与 issuer token，是卡片跨重启、存档导入后继续执行的唯一事实。涉及主体性的结果必须逐一解析所选 outcome 对应 AgencyGate 的 AgencyCommitmentRef，核对说话者、semantic_intent、subjects、terms 与有效日，并把每份 `agency.commitment_valid` 写入封存前置条件。自由叙事不能伪装成 NPC 台词；NPC 原话只能存为 `dialogue_quote`，引用已经提交的 DialogueTurn。Core 复算 `result_digest` 后，`EventCardPublishOp`、卡片状态和 AP charge 在同一个 ContentPacket 中提交。证据、规则或余额不成立时提案不成卡，也不扣费。

点击时不再调用 LLM 或 RulePlugin，不重新裁决、不改写结果、不预留资源：

```text
加载 available 卡片与 SealedEventResult
  → Core 固定校验 card.day = current day、player phase、卡片控制权、sealed digest 与确定性上下文
      ├─ trigger：Packet.preconditions 精确等于 sealed.preconditions；全部成立后只允许封存 ops + 匹配的 event_card.trigger
      └─ invalidate：Packet.preconditions 必须为空；同一锁定快照中至少一条 sealed precondition 真实不成立后，只允许一个匹配的 event_card.invalidate，reason_code 固定为 event_card.precondition_failed
```

`expired` 只表示跨日未处理；`invalidated` 表示点击时必要条件已不成立。两者均不退款。未知 precondition、协议形状错误或规则/摘要依赖故障不能伪装成卡片失效，必须作为原错误拒绝整包。`event_card.trigger` 的 StateApplier 语义固定要求 available、同一 control、card.day 与当前 day 相等且 digest 一致，不能由插件或空 preconditions 放宽；从 player phase 离开时，同一个 `day_cycle.advance` Packet 必须穷举并 expire 当日全部未处理卡，进入下一次 player phase 时在同一 Packet 打开该日唯一 EventBudget。若卡片结果是发起决斗，封存的结果只能是打开权威 StageInstance，胜负仍由后续 `stage_outcome.resolve` 决定，不能提前封存胜者。

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

每个 GoalNode 使用 CapabilityRequirement：`bound` 只能使用 `catalog_kind=capability` 的已存在引用；`demand` 用 CapabilityDemand 描述当前世界尚无入口的语义需要，其 allowed_archetypes 只能使用 `catalog_kind=generation_archetype`。所有引用必须在锁定 Bundle 中存在并通过适用规则，否则只能 Reject，不能伪造 CatalogRef 或猜测替代项。验证后的 demand 节点必为 blocked，并携带只引用该 demand ID 的 WorldExtensionRequest；该请求的 `selected_archetype` 必须由 `goal_plan.validate` RulePlugin 精确选择并等于 `allowed_archetypes` 中恰好一项，Server 不得选择首项、唯一注册项或同 kind 的任意插件。

合理入口缺失时，`world_extension.resolve` 只从 WorldState 中按 plan/node/request ID 读取这份已验证请求，并用其中 `selected_archetype` 的 bundle/digest/local ID 精确命中 GenerationArchetype.generator。它依次复用能力、职责、角色、地点与制度，最后才提出允许的创建结果；只能返回该 operation 白名单内的 PacketProposal，不能创造新 EffectOp、直接完成目标、返回第二份扩展草案或启用兜底路径。有效结果必须用一次 `goal_plan.upsert` 消费原请求、把目标节点改成 bound 并推进计划 revision，否则语义门禁拒绝。

首次规划与后续扩展解析是两个明确分离的权威阶段。System 对话命令只负责把 verified GoalPlan 经 `goal_plan.validate → goal_plan.upsert → apply_packet` 写入 WorldState，并在 Session/Command finalization 后结束；它不得在同一命令中自动调用 `world_extension.resolve`。后续由 `kernel.worldExtensions` 在下一 autonomous phase 从已提交请求重新读取 plan/node/request/selected-archetype，先持久化完整 RulePlugin request，再提交唯一 packet；每次提交后必须证明该请求已被消费，随后才处理下一项。resolver 的 provenance 时间作为 DeterministicContext 外部结果随请求一起先入 RulePlugin Journal，恢复时不重新生成。

## 7. 权威写入：ContentPacket 与 `apply_packet`

常规裁决路径：

```text
Director EventProposal / CharacterReactionProposal / StageOutcomeProposal / validated System proposal
  → RulePlugin.resolve（只读上下文，返回 PacketProposal 或 Reject）
  → Core 在同一快照上封装 ContentPacket
  → Schema + Semantic + Preconditions + DeterministicContext 校验
  → apply_packet 原子提交或完整拒绝
```

#### DeterministicContext 权威签发与验真

`DeterministicContext` 由 World Core 的唯一 `DeterministicContextAuthority` 签发与验真；Packet Semantic Gate 与 RulePlugin Gateway 只调用该 Authority，不得各自实现 digest 或 MAC。

- **context_digest**：RFC 8785 JCS UTF-8 SHA-256。对已通过正式 Schema 的完整 `DeterministicContext` 排除自引用的 `context_digest` 与 `issuer_token` 后求摘要；因此当前签名范围是 `context_id`、`issuer`、`logical_time`、`random_choices`、`external_results`，未来新增合同字段也会自动进入摘要，代码不得维护第二份允许字段表。
- **external_results**：每一项的 `content_digest` 必须等于其 `payload` 的 JCS SHA-256。
- **issuer_token**：Server 侧 HMAC-SHA256 TokenCodec；MAC 输入为固定 envelope 的 JCS 文本 `{ v: 1, world_id, context_digest }`，绑定 **world_id + context_digest**。不绑定 `basis_revision`，不设 TTL，以便 EventCard 在后续 revision 复用封存上下文。
- **密钥**：仅由部署组合根显式注入 keyring（`activeKeyId` + `keys`）；无环境变量读取、默认密钥或自动生成。active key 签发；仍配置的全部 key 可验旧 token（rotation）。删除 key 后旧 token 明确失败。HMAC 密钥至少 32 字节；验真使用 `timingSafeEqual`；错误不得泄漏密钥或 MAC。
- **接线顺序**：ContentPacket 在 packet identity 之后、source/preconditions 之前验真；RulePluginRequest 在进入不可信 adapter 之前按 `readonly_world.world_id` 验真。`context_id` 仅由 Authority 经注入的 ID factory 生成。

EventCard 点击路径只复用已经裁决的封存结果：

```text
event_card.trigger command
  → Core 校验卡片生命周期、SealedEventResult 身份与 trigger / invalidate 互斥分支
  → ContentPacket(source_kind = sealed_event_result)  // 携带原 deterministic_context，不重新签发
  → apply_packet(封存 EventOutcomeOp[] + event_card.trigger，或单一 event_card.invalidate)
```

`ContentPacket.source` 明确区分 `rule_plugin` 与 `sealed_event_result`。后者必须引用 WorldState 中同一 card/result/digest，Core 不能借此拼装新结果。trigger 分支必须携带并通过全部封存前置条件；invalidate 分支不得执行任何封存 op，只能在封存条件真实失败时提交固定失效码。相同 packet 重试必须幂等；不做“尽量应用”。

`EffectOp` 是闭合、版本化的引擎语法。对话只能由 human 首轮打开，之后只允许 `dialogue.turn.append` 与 `dialogue.close`；每次追加携带 expected revision，既有 turn、来源摘要与 AgencyCommitment 永远不可覆盖、删除或重排。动态 NPC 只可通过 `state_machine.create` 建立一个引用既有 StateMachine 的实例，不得生成新状态机 executor。`EventOutcomeOp` 是 EffectOp 的严格子集，允许结果改变定义、实体、组件、关系、账本、位置、知识、记忆、日程、时间、目标、状态机，或打开 Stage；它禁止嵌套发布/触发卡片、打开预算、写对话、改变控制权和直接推进日循环。

### 7.1 Exact Decimal 与零和账本

`DecimalString` 的合法形状**只**由 `world-runtime` Schema 定义：最长 128 字符，必须是规范十进制定点表示，禁止负零、无效前导零和小数尾零。ExactDecimal 通过 `fromValidatedDecimalString` 只消费已校验串，不复制合同正则、不声明第二套合法格式。解析异常视为内部不变量破坏。求值使用 `BigInt coefficient + scale`，比较器与过账算术共用同一路径。禁止 `Number`、浮点、舍入与固定小数位。

`ledger.post` 的全部 entries 合并同账户后必须精确零和。首个严格零和的 `ledger.post` 可以在同一候选状态内创建尚不存在的 ledger；此后仍只有普通零和过账，不提供 mint / burn 特权。发行、库存或财政账户由内容定义，Engine 不内置账户；增发与销毁只能通过对手账户完成，是否允许由世界规则与前置条件裁决。算术层不拦截负余额。原 `LedgerState.balances` 账户必须唯一；过账保留原账户顺序，新账户按 entries 中首次出现顺序追加，零余额不删除。`ledger.balance_at_least` 使用同一 ExactDecimal 比较。

`apply_packet` 在世界锁内依次完成幂等查询、同事务快照、从该锁定行分字段重建并整体验证同一 SaveEnvelope 权威上下文、语义门禁，并为本次提交生成一个尚未持久化、经 Schema 校验的 `PacketCommitIdentity` 候选；生成候选不得预留记录或修改存储。普通语义只消费锁定 WorldSnapshot；`stage.open` 还必须从同一权威上下文精确取得 WorldContentLock 与 StageModule locks，禁止事务外二次读取、调用方拼锁或按 module/scene 猜测。该身份作为调用参数传给唯一的 EffectOp Handler Map，不能成为 StateTransition 单例的构造依赖。Handler Map 一次产出候选 WorldState、按 op 顺序投影的 DomainEvent 与 MaterializationRequest；三类结果分别通过正式 Schema 后才交给事务 prepare。`MaterializationRequestOp` 只携带不含提交身份和生命周期的 Draft，Handler Map 必须注入本次 event ID 并创建 `pending` 正式请求。`domain_event.emit` 的唯一落点是 `CommittedEvent.domain_events`，`materialization.request` 的当前记录进入与世界提交原子的 Materialization Ledger / outbox，二者都不进入 WorldState；AtomicPacketStore 只能持久化这些已验证结果，禁止重新扫描 Packet 实现第二套 EffectOp 语义。

v1 的唯一权威 Store 是 PostgreSQL 18.x，由 Server composition root 以 node-postgres `Pool` 显式注入。正式 SQL migration 创建 `worlds`、`committed_events`、`materialization_requests`、`engine_sessions`、`command_journal`、`command_server_envelopes`、模型调用记录、`rule_plugin_invocations`、`content_upgrade_authorizations`、日循环身份与 Dialogue Director run：WorldState 是 `worlds.state_document` 的唯一当前真相，CommittedEvent 是不可变事件真相，物化请求以同一事务 outbox 记录；授权表只保存 Core 签发的正式授权、命令/插件身份和 commit-ready 结果摘要，候选 SaveEnvelope 仍只存在于 RulePlugin Journal 原始响应及最终 `worlds` 分字段事实中。`engine_sessions.next_server_sequence` 是该 Session 下一条 ServerEnvelope sequence 的唯一分配游标。JSONB 只能保存已经过对应 Schema 的完整合同，列、revision 与 JSON 关键身份字段必须由数据库约束相互校验。所有 Store 都不读取环境变量、不创建 Pool、不自动执行 migration，也不重试事务。

每次 `apply_packet` 使用同一 PoolClient 执行 `BEGIN ISOLATION LEVEL READ COMMITTED`，先锁定目标 world，再在锁内查询全局 packet_id 幂等记录、读取快照、生成未持久化 event ID、prepare 全部候选并逐项核验，最后依次写入 CommittedEvent、Materialization outbox，使用 revision CAS 更新权威世界事实；只有完整 authorized commit 或精确 duplicate 才由外层物理 COMMIT，其余情况一律 ROLLBACK。普通 packet 只更新 WorldState 与 revision/event cursor；唯一例外是 `content_upgrade` source 下的单一 `content_upgrade.apply`，它必须携带 commit-ready 授权链，并在同一 CAS 中把已验证候选 SaveEnvelope 的 WorldState、WorldContentLock、依赖/实现锁、资产摘要和迁移历史一起原子拆列提交。Save Schema migration、Content Upgrade 与数据库 DDL migration 是三条独立流程：前两者不得借数据库 schema 变更重解释世界，DDL migration 也不得改写已提交世界或内容锁。

Runtime 读侧按 `world_id` 重新校验当前 WorldSnapshot，或按明确的排他起点与包含终点读取连续、有序的 CommittedEvent 区间；数据库列与每份合同文档的身份不一致都视为存储损坏。RulePlugin 唯一执行顺序固定为 Gateway prepare（Schema、模型证据、DeterministicContext）→ Journal 提交完整 RulePluginRequest → deterministic/no_io adapter → Gateway 校验响应 → Journal resolved。`prepared` 崩溃残留可用完全相同请求重放；`resolved` 必须经同一 Gateway 重验；同一 request ID 的不同请求或不同响应明确冲突。PacketProposal 仅作为 resolved response 的精确成员保存，World Core 仍只通过 `RulePluginProposalReceiptLookup` 取得重新校验后的正式 Proposal。

`rule.holds` 在 `apply_packet` 持有 world 行锁时也走同一 Journal。为避免世界事务占满连接后等待自己的 Journal 连接，组合根必须提供指向同一数据库但对象独立的 RulePlugin Journal Pool；`rule_plugin_invocations` 不建立会反向申请 world key lock 的外键，而以已验证 `readonly_world`、请求摘要和列/JSON 身份约束闭合来源。rule.holds 的 request ID 固定由 packet UUID namespace 与前置条件稳定路径做 RFC 9562 UUIDv5，崩溃重试不会产生另一请求身份。

普通 Packet 不包含模型草稿、资产 URI 或客户端运行时指令。唯一例外是 `EventCardPublishOp` 内已封存的卡片标题、摘要与结果叙事：这些字段是惰性的表现数据，不参与规则求值，只有结果成功提交后才经 `narrative.show` 展示。模型与客户端仍不能提交 ContentPacket 或 EffectOp；RulePlugin 只能返回 PacketProposal，由 Core 重新校验并封装。

### 7.2 Runtime Content Activation

部署组合根通过 `createRuntimeContentActivation` 显式提供世界事务 Pool、同库且彼此独立的 RulePlugin Journal Pool 与 Materialization Ledger Pool、`ContractValidator`、`JsonDigest`、`ModelProvider`、五种闭合模型入口各自的 ModelProfile ID、不可信 ContentBundle JSON 列表、受信 `RulePluginModuleV1[]`、不可信 `stageModuleManifestCandidates`、受信 `SaveSchemaMigrationModuleV1[]` 与不可信 migration plan candidates。两个辅助 Pool 都不得与 world transaction Pool 或彼此复用；RulePlugin Journal Pool 同时服务持锁期间只读的 Content Upgrade 授权联接，避免查询耗尽 world transaction Pool。五个 ModelProfile 选择都属于部署事实，不进入内容、世界或客户端消息；activation 在任何 durable dispatch 前分别验证 Provider 的精确 `(profile, request kind)` 能力。DeterministicContext、Session basis 与 Content Upgrade authorization 分别使用必填 HMAC keyring，组合根拒绝三者两两复用任何密钥材料；升级授权 lifetime 秒数也必须显式提供。无默认 key、默认 migration plan 或兼容入口；没有历史迁移制品时，部署仍显式提供两个空数组。Server `runtime` 模式只按显式绝对路径加载一个受信 deployment module，不扫描目录；module 返回完整 activation input 和关闭全部部署资源的 `close`。

激活路径固定为：

```text
ContentBundle Loader（Schema + digest + 语义门禁）
  → 单一 ContentRuntimeCatalog.register
  → 从 Catalog 已解析对象收集 RulePlugin operation requirements
       · 各叶子字段按下文固定映射到 operation_kind
       · WorldDefinition 精确拥有剩余世界级编排 operation refs
         （WorldContentLock 经 Schema 校验后 resolveWorldContentBinding）
  → 不可信 StageModule manifests → client-bridge.v1 Schema
  → 唯一 StageModule Registry
  → 校验 required content_pack / stage_module；StageRef scene 门禁
  → planRequiredModules；收集 required rule_plugin 模块身份
  → 显式 AssetProvider Registry
       · 部署必须传入 AssetProviderAdapterV1[]，无依赖时也显式传空数组
       · required asset_provider 按 package/version/integrity 精确命中
  → 构造 RuntimeExecutionKernel
       · 唯一 createRulePluginAbiRegistry
       · 先校验 required 模块身份
       · 再对每条 operation requirement 做 module + operation_id + operation_kind 精确命中
       · 然后才构造 Gateway 与其他运行时服务
```

全部 ContentBundle RulePlugin 引用都必须由字段所有者映射到固定 kind：`WorldLaw.evaluator → rule.evaluate`、`Capability.resolver → capability.resolve`、definition 类型的 `TypeDefinition.validator → definition.validate`、`WorldDefinition.navigation_resolver → navigation.resolve`、`WorldDefinition.calendar_resolver → day_cycle.advance`、`GenerationArchetype.generator → world_extension.resolve`、`ContentUpgrade.transformer → content_upgrade.transform`、`StateMachineDefinition.advance_resolver → state_machine.advance`、`EventBudgetPolicy.card_cost_resolver → event_card.publish`。component / relation 类型不使用 `definition.validate` validator。

没有自然叶子所有者的世界级操作由 WorldDefinition 的必填 operation refs 精确选择：`goal_plan.validate`、`automatic_event.world.resolve`、`automatic_event.character.resolve`、`stage_outcome.resolve`、`dialogue.open`、`dialogue.turn.append`、`dialogue.close`。激活时从 Catalog 已解析对象收集全部 requirements，再由 Kernel 内唯一 ABI Registry 做 module + operation ID + operation kind 精确命中；禁止按 kind、注册顺序或“唯一一个插件”猜测。MaterializationProfile 的资产 provider 与审核策略不再占用 RulePlugin operation：`on_demand` profile 精确引用 required `asset_provider` DependencyLock，review / promotion 使用 profile 已有闭合声明。

Stage Registry 只证明依赖与场景合同可用；`requiredStageModules` 只验证与排序，不加载制品。AssetProvider Registry 只证明 required dependency 有精确部署 adapter，不执行请求，也不读取供应商配置。Kernel 与 World Core 不依赖 Unity Host。禁止默认插件、Provider 或 operation 猜测。

## 8. RulePlugin

首版内容包由项目方与 Agent 制作，RulePlugin 可视为受信代码，但仍遵守最小权限：

- 无状态、无 I/O，只接收只读快照、已验证命令、内容配置与 DeterministicContext；
- `operation_kind` 是请求的唯一 discriminator；响应必须回显同一 kind，并命中该 operation 的闭合输出合同。不存在通用 RulePluginOutput 或“任意 PacketProposal”入口；
- 可以评估 RuleRef、解析 Capability、验证同一份 DynamicDefinitionProposal / GoalPlanProposal、解析已提交的 WorldExtensionRequest、提出该 operation 白名单内的 PacketProposal，以及执行显式内容升级映射；
- 不能访问数据库、模型 Provider、文件系统、网络、客户端运行时内部对象或 WorldState 写句柄；
- 不能调用 `apply_packet`，不能发明新的 EffectOp executor；Core 还必须逐项验证 `proposed_by` 与 request/plugin/operation 相同，并验证每个 op 属于该 operation 的 allowed-op 子集；
- 插件不得自行取随机数；需要选择时只能返回 ChoiceSpec。选择所有权固定属于 Server：World Core 校验唯一 `choice_id` / `option_id` 与正整数权重，使用 Server OS CSPRNG 产生 256-bit 熵，再以绑定父子 request、ChoiceSpec JCS digest 与计数器的 SHA-256 rejection sampling 做无偏加权选择。Core 将 `choice_id + option_id + entropy_commitment` 作为唯一新增项签入新的 DeterministicContext；原 logical time 与 external results 必须逐值保持。熵揭示、承诺、ChoiceSpec digest、新 context 与父子 request ID 在继续调用插件前写入 PostgreSQL RulePlugin Journal；一个父请求只允许一个子请求，恢复只能复用该边，不重新抽取。插件从新 context 读取选项并返回终态，或以新的 choice_id 请求下一层；唯一层数上限来自正式 `DeterministicContext.random_choices.maxItems` Schema，World Core、Executor 与 Finalizer 不复制第二个数字。该流程不下发客户端、不使用 `Math.random`、不按首项或权重顺序代选；
- 插件 API 版本与实现 digest 被存档锁定，缺少依赖时拒绝加载，不启用通用兜底规则；
- 内容包只声明通用 capability/plugin ID 与配置，组合根解析实现，World Core 不按世界 import 代码。

### 8.1 进程内 ABI Host 与 rule.holds

Runtime Kernel 不接受任意 `RulePluginAdapter` 旁路注入。组合根必须显式提供 `RulePluginModuleV1[]`（`manifest` + `resolve`）；ABI Host 在构造期用 `rule-plugin.v1` Schema 校验每个 manifest，按 `PluginLock` 与 `implementation_digest` 去重，并要求每个 `operation_id` 唯一且声明 `operation_kind`。激活由 Content Runtime Catalog 穷举全部 16 类已封板字段 owner，解析原始 `PluginOperationRef` 与 required `rule_plugin` DependencyLock，并在 Gateway 构造前送入同一 ABI Registry 做 module + operation ID + operation kind 精确命中。每个 runtime world binding 只保留 bundle 共享 owner、所选 WorldDefinition 及属于该世界的 StateMachine owner；多 owner kind 必须再以正式 source owner 精确选择，禁止按 kind 猜唯一插件。请求到达时，`plugin_lock` 与 `operation_id`/`operation_kind` 必须精确命中已注册模块，否则失败。禁止目录扫描、动态下载、默认插件、兜底插件与内容硬编码。

`ContentPacket` 前置条件 `rule.holds` 的生产求值路径固定为：

```text
RuleRef
  → Content Runtime Catalog（WorldLaw.evaluator + rule_plugin DependencyLock）
  → ABI 以 package_id + integrity_sha256 命中已注册 manifest，取出完整 PluginLock
  → 组装 operation_kind=rule.evaluate 的 RulePluginRequest
       readonly_world = 当前门禁锁定 WorldSnapshot
       deterministic_context = 当前 ContentPacket 原值
       request_id 仅作关联，不进入规则语义或存档
  → RulePluginGateway（Schema + 语义门禁 + 同一 ABI Adapter）
  → 仅 ValidationOutput.valid 映射为 holds 布尔；reject 明确失败，合同不允许 ChoiceSpec
```

ContentBundle 的 `DependencyLock` 不含 `api_version`；`PluginLock.api_version` 只来自已注册 manifest，不用 `DependencyLock.version` 猜测。`DependencyLock.version` 必须等于 `manifest.implementation_version`。Catalog 无法解析绑定或 ABI 未注册实现时立即失败，不猜测映射。`rule.holds` 求值只读，不生成 PacketProposal，不调用 `apply_packet`。

未来开放第三方包时保留同一协议，把 Host 替换为签名与沙箱执行，不改变 World Core。

## 9. StageModule 与 Client Runtime

StageModule 只拥有可丢弃的表现临时状态，例如动画、碰撞采样、镜头、粒子、音效和实时输入。权威 StageInstance、计时、进度、已触发标记与完成条件属于 WorldState。

世界层与 Stage 层使用两个明确分离的时间域：世界层只按已提交事件与日边界推进；Stage 层可以在 Unity 内按帧运行移动、物理、战斗、解谜和表现。Stage 打开后，秘境外部世界不因本地帧、坐标或临时拾取持续演化，模型与 World Core 也不参与逐帧交互。

StageInstance 是有开始、检查点和结束边界的局部行动事务。检查点前的本地进度不是世界事实；只有经过正式 StageOutcomeProposal、operation 专属 RulePlugin 裁决并由 `apply_packet` 提交的语义结果才进入 WorldState。断线恢复以最后一个权威 open StageInstance revision 重建，不保存或猜测最后一帧 GameObject、刚体、动画和临时掉落状态。`stage.close` 的 outcome 历史只属于其不可变 CommittedEvent；同一原子状态变换把 WorldState 中的完整实例替换为仅含 `stage_instance_id + revision + closed` 的最小墓碑，既阻止跨 Save 导入后的 ID 重用，也不让 module-owned opaque state、参与者与实现锁永久膨胀。

Stage 参与者在打开当刻必须是 active Entity；若 EntityRef 显式携带 `expected_revision`，`stage.open` 必须在同一锁定状态变换中精确命中该 revision。SaveEnvelope 的通用关联门禁拥有 Stage 实例 ID 唯一、单实例参与者运行时身份唯一、参与者同 world 且恰好命中一个 EntityState 的机器真相；部署侧 Stage 权威不重复这些关系，只校验锁、scene、内容引用与 completion RuleRef。打开之后，某个 NPC 因已提交世界效果变为 `retired` 不会自动关闭 Stage，也不会成为结束当天或其他交互的门禁。EntityState 仍是该参与者的权威记录，Stage 投影可以继续使用其稳定身份与内容 archetype；只有参与者记录根本不存在才属于损坏的 Stage/Save 关系。Session 玩家仍必须由 active human ControlBinding 指向 active Entity 才能提交 outcome。

未关闭的权威 StageInstance 不阻止 `player_day.end`，也不阻止其他本来就合法的世界交互。玩家显式结束当天时，世界仍按正式日循环推进；StageInstance 保持 `open`，不会被默认暂停、自动关闭、自动结算或丢弃。新的 SessionView / ready / resync 以最新世界 revision 为基线，继续投影同一个权威 Stage revision；后续 StageOutcomeProposal 仍须命中当时最新的 Session basis 与 Stage revision。只有内容合同明确声明并由其唯一规则所有者裁决的具体条件才能拒绝具体操作，Engine 不得仅因存在 open Stage 增加全局门禁。

服务端 Content Activation 已建立引擎中立的 StageModule manifest Registry：组合根显式传入不可信 manifests，经 `client-bridge.v1` 校验后锁定 `module_id`、`StageModuleLock`、scene 索引与 `depends_on` DAG。该 Registry 只服务依赖与场景合同门禁，不是完整 Stage Runtime；不读取目录、不动态 import、不执行制品。正式 Unity Host 的本地运行 ABI 必须由组合根显式注册；manifest `entrypoint` 只交给 Unity 构建与部署流程解释，不由 Engine 动态加载。

```text
World Core     → stage.open EffectOp → 已提交 StageInstance
Server         → StageOpen（完整 StageModuleLock、可见上下文、允许输入、hash 资产绑定）
Client Runtime → StageInput
Client Runtime → StageOutcomeProposal（语义结果与证据，不含 EffectOp）
World Core     → stage_outcome.resolve（只允许 EventOutcomeOp / stage.update / stage.close）→ PacketProposal → ContentPacket → apply_packet
Server         → StageUpdate / StageClose + SessionView
```

StageModule 只消费已提交 Signal 并提出后续 Proposal，不得在回调中重入提交。多个模块的顺序由显式依赖 DAG 决定，冲突直接报告。`StageModuleManifest.scenes[].outcomes` 是 outcome transition 分类的唯一机器所有者：每个 namespaced outcome type 精确映射到 `stage.update`、`stage.close.completion` 或 `stage.close.non_completion`，Schema 强制每个固定 scene 至少存在一个完成关闭出口；禁止平行分类列表、默认分类或按名称猜测。`StageInstance.completion_rules` 是该实例完成关闭资格条件的唯一运行时列表，按数组顺序作 AND；每个 RuleRef 必须精确锁定并解析到当前 WorldContentLock 的根 ContentBundle，不能借用进程里其他已注册包或依赖包的 WorldLaw。OR 或复杂表达由该根包中的单个 WorldLaw RuleRef 封装，不建立第二套规则 DSL。精确选定的 `stage_outcome.resolve` 必须服从 manifest 映射：完成关闭把完整列表逐项且恰好一次放入 packet 的 `rule.holds` preconditions，由 `apply_packet` 在锁定快照上原子求值；非完成关闭不得携带其中任何一项；update 可拥有自己的合法 preconditions，不增加 completion 禁令。该列表不是关闭、结束当天或其他无关交互的全局门禁。

首版 2D 世界主体经 Unity Host 呈现：场景原画、人物立绘、表情、转场、镜头、微动、天气、粒子与音效。未来新增秘境式 3D 可行走空间或复杂舞台只需新增 StageModule，不修改 World Core 权威合同，也不把 3D 场景变成第二套世界状态。Unity Host 可以拥有自己的制品和工程结构；项目不投入其他引擎 Host、无缝开放世界同步或跨引擎 StageModule 制品兼容。

### 9.1 Unity 2D Host 首版蓝图

Unity Editor 尚未安装时只封板责任，不预选 Editor、SDK、JSON 库或包版本，也不创建无法验证的假工程。正式工程建立后，首版 Host 只包含以下闭合模块：

| 模块 | 唯一职责 | 禁止 |
|---|---|---|
| Contract Adapter | 加载部署流水线从同一 Engine release 固定并校验 digest 的合同制品；入站 ServerEnvelope 与出站 ClientEnvelope 均先过正式 Schema | 手写 DTO 成为字段真相、未知字段静默丢弃、私有协议别名 |
| Authenticated Bootstrap | 接收外部网关已认证的 `session_id + initial SessionView`，建立本地 SessionReplica | 在 Unity 内创建世界、选择 ControlBinding、拼装首个 View |
| Bridge Transport | 发送完整 ClientEnvelope，维护 client sequence/correlation；每个未完成的权威交互事务持久保留首次 envelope，重试不得重建身份 | 默认 URL、换 command/message ID 重试、绕过 Schema 直发 |
| SessionReplica | 只保存最后一个完整权威 SessionView、下一预期 Server sequence 与待恢复交互事务；全 View 原子替换，delta 仅在 base revision 精确命中时应用 | 缓存 WorldState、猜 hidden revision、局部合并不一致 View |
| Presentation Router | 穷举路由 `session.view`、`dialogue.reply`、`presentation.frame`、`command.result` 与协议错误 | 按世界名、人物名、`pack_id` 或剧情写分支 |
| 2D Renderer | 按 RenderNode 的闭合 `node_kind` 与稳定 node/slot ID 驱动场景、立绘、CG、覆盖层、文本与交互锚点；资产只按合同引用与 digest 绑定 | 把 GameObject、动画进度、资源路径写回世界 |
| Feature Views | 对话、GoalPlan、EventCard、日状态/预算与地图交互全部只读 SessionView；仅在玩家已选择 NPC/System 后显示对话自由文本，其他点击产生对应的正式交互请求 | 全局自由文本行动框、把对话文字解析为通用行动、假回复、客户端扣 AP、本地结算卡片或位移 |

SessionReplica 的闭合状态为 `bootstrapped → synchronizing → synchronized → resynchronizing`，任一合同错误进入 `fatal`；不设置自动降级状态。Bootstrap 后发送 `client.ready`，只有关联的完整 SessionView 才进入 `synchronized`。正常批次要求 Server sequence 连续；gap、delta basis 不符或未知消息立即暂停新的世界交互并发送 resync。resync 成功后以完整 View 和其 sequence 建立新基线，再按上一节的历史事务恢复规则处理仍未完成交互。首版同一 Session 只允许一个会改变权威世界的交互处于本地未完成状态，以匹配 Server 的单 world 执行槽；表现动画可以并行，但不能阻塞或重排权威消息应用。

`dialogue.reply` 只用于低延迟呈现；同 revision 的 `SessionView.dialogues` 是最终集合，turn 按稳定 `turn_id` 去重。任一普通接受命令完成时，Server 逐 revision 校验从 accepted world revision 到 final world revision 的连续 CommittedEvent，收集该区间内新打开、未在同区间关闭且包含 Session 玩家的 Stage，并按稳定 Stage ID 在权威 SessionView 后发送 `stage.open`；因此 Stage 打开不再依赖 EventCard 这一条调用路径。Content Upgrade 是批量替换世界的闭合例外：Finalizer 严格识别唯一 `content_upgrade.apply`，验证其 `candidate_save` 的内在关联及 command/source/world/revision 身份，再从候选最终 WorldState 投影玩家全部 open Stage；该命令在 SessionView 与 CommandResult 之间的 `stage.open*` 是升级后的权威 Stage 全集，客户端必须移除缺席的旧实例。EventCard 成功响应随后播放同批 `presentation.frame`，最后以 CommandResult 结束 pending command；其他命令同样在结果前收到其应投影的 Stage。精确重放从持久化业务身份恢复原 final revision，再以同一不可变事件区间或 Content Upgrade candidate 核对已保存的 `stage.open` 类型、数量、顺序与 Stage ID，不能把 outbox 自己当作 Stage 真相，也不能读取后来已经变化的当前世界。`player_day.end` 返回的新 View 是次日唯一客户端基线，旧日卡片、预算与表现缓存整体失效，但仍 open 的 Stage 继续保留。Server 已闭合 `stage.open` 的锁定合同门禁、消息投影、ready/resync 重建，以及 `stage.outcome_proposal` 的权威裁决、提交和重放；尚未实现的是 Unity 对这些消息的本地 Stage/3D 实例化。`stage.input` 只留在 Unity Runtime 本地帧域。每条 `StageOpen.bindings[]` 都携带 `binding_id + subject + slot_id + AssetContentRef`；subject 是 Stage 局部闭合集合中的 `{kind: world, world_id}` 或 `{kind: entity, entity: EntityRef}`，entity 分支强制携带投影时的当前 `expected_revision`。选择身份是 runtime subject + slot；priority 只在同一身份内比较，并列明确失败，不同主体共用同一 slot 时全部保留，输出稳定按 `slot_id → world before entity → world_id → entity_id` 排序，`binding_id` 可在不同实体实例上重复。Engine 协议不拥有下载 URI，Unity/部署资产层按内容 hash 取得 blob，Server 不从 ContentBundle 相对路径或文件系统位置猜网络地址。

## 10. World Core ↔ Client Bridge

Client Bridge 是传输无关、引擎中立的版本化 JSON Envelope（`client-bridge.v1`）。当前无 Unity 的基础闭环由 Server `POST /api/client-envelope` 接收恰好一个 ClientEnvelope，并按权威序列返回 ServerEnvelope 数组；统一 router 穷举正式 ClientMessage 集合中的 `client.ready`、`session.resync_request`、`dialogue.start`、`dialogue.continue`、`dialogue.close`、`map.move`、`stage.outcome_proposal`、`event_card.trigger`、`player_day.end` 与 `content_upgrade.accept`，未知类型先在 Schema 门禁失败且不会占用 Command Journal。`StageInput` 只保留为 Unity 本地 Stage ABI 定义，不进入 ClientMessage Envelope。该 HTTP framing 不是新的协议模型，只接受可信管理面已经建立的 Session。账号鉴权、世界创建与 Session 打开不作为匿名 endpoint 暴露；同进程部署应用必须从公开 deployment composition API 创建 activation，按 `worldCreation → dayCycle.advanceToPlayer → sessions.open` 顺序接到自己的鉴权管理面。后续 Unity Host 仍只消费同一 Bridge，推送或连接管理属于 Host/部署传输层；合同不绑定 Unity 内部类型。

Session 入场的所有权固定为：外部网关认证账号并显式选择 runtime world 与 human ControlBinding；Server `kernel.sessions.open` 从同一事务锁定的 WorldState 创建 Engine Session、签发 basis token，并返回经过正式 Schema 验证的首个完整 SessionView。网关只能把该 SessionView 作为自己认证响应中的正式合同值交给客户端，不得重新组装字段、补造可见事实或另建一套 bootstrap View 模型。Session 打开不是匿名 ClientMessage，也不向 Client Bridge 增加登录语义。

Server 必须只有一个完整 SessionView 组装入口：Session 打开使用创建 Session 时锁定的同一 WorldSnapshot，命令 finalizer 使用其事务内锁定的 Session/WorldState，resync 使用同一次一致性读取取得的当前 Session/WorldState；三者随后共用同一 basis-token、表现候选与 World Core `SessionViewProjector` 路径。禁止由 `sessions.open` 只返回裸 `session_id + basis_token` 后再二次读取拼首包，也禁止在 command finalizer、resync 或部署网关中分别复制 View 组装逻辑。

`session.resync_request` 是已认证 Session 内的同步控制消息，不是世界命令，不携带 `basis_token`，不进入 Command Journal，也不写 WorldState。Server 在同一 PostgreSQL 事务中锁定 Session 与当前 WorldState，拒绝高于权威值的客户端 view revision；仅当 world revision 已变化时把 Session view revision 推进一步，再经唯一组装入口生成完整 `session.view`，并从同次读取的 WorldState、WorldContentLock 与 StageModule locks 投影当前玩家全部 open Stage，同时原子分配并推进整批 `next_server_sequence`。该即时响应不写命令 outbox；若响应丢失，重新发起 resync 会取得更后的权威 sequence。客户端收到 `correlation_id` 命中本次 resync 请求的完整 View 与随后的 `stage.open` 列表时，必须原子替换本地 View，以这批 Stage ID 作为权威 open 集合并移除不在其中的本地 Stage，再把下一预期 ServerEnvelope sequence 重置为批次末尾 `sequence + 1`；此前的序列空洞由完整快照截断。

命令响应丢失后，客户端必须重发首次提交时保存的**完整同一份 ClientEnvelope**，包括 `message_id`、client `sequence`、`command_id`、`basis_token` 与消息正文；不能只保留 command ID 后重建外壳。Command Journal 对完整已验证 ClientEnvelope 做 JCS 摘要并逐值比对，因此同一 command ID 的不同 envelope 明确冲突，完成命令才能稳定返回原 `correlation_id` 及原 ServerEnvelope outbox。若客户端已先用较新 resync 完整 View 截断序列空洞，再收到该命令较早 sequence 的精确历史 outbox，Host 只能在整个批次均早于当前预期 sequence、且 `correlation_id` 命中这份正在恢复的原 ClientEnvelope 时按“历史命令恢复”处理：不得回退 View 或下一预期 sequence；同 revision 的 SessionView 只核对后忽略，稳定 message/frame 身份负责去重，未见过且 `view_revision` 等于当前 View 的 PresentationFrame 可以补播，最终 CommandResult 只解除该 pending command。批次交叠、revision 不一致或相关身份不一致都必须再次 resync 或 fatal，禁止猜测合并。

`client.ready` 是同一同步端口的连接入场消息：客户端必须在 `supported_protocols` 中显式包含 `client-bridge.v1`；命中后 Server 从锁定的当前 Session/WorldState 返回关联到该请求的完整 `session.view`，随后按稳定 Stage ID 顺序返回当前玩家全部 `stage.open`，这份 Stage 列表与 resync 一样是本地实例的权威全集。未命中时只返回 `client.protocol.unsupported` 的 fatal `protocol.error`，原子消耗一个 ServerEnvelope sequence，但不推进 View/world revision。`client_build_digest` 是经过 Schema 校验的客户端制品身份，不在 Engine 内形成默认或隐式 allowlist；需要限制具体客户端制品时，由已认证部署网关在调用 Engine 前用自己的显式部署配置门禁。

客户端适配器只认识固定渲染原语、通用交互消息和不透明内容 ID，不接收完整 WorldState，不按 `world_id` 分剧情。Bridge 客户端只能提交正式 `client.ready`、`session.resync_request`、在已选择 NPC/System 的对话中对该对象说的话、显式关闭自己参与的 active Dialogue、`map.move`、EventCard 触发、结束玩家日与 `stage.outcome_proposal`；协议没有独立 ACK。首版不存在全局自由文本行动框或命令行，不把对话文本解释为选目标、移动、战斗、修炼、做饭等通用行动；也没有砍人、做饭等结构化行动按钮、事件派发或 AP 写入接口。未来 StageInput 来自玩家对 3D 秘境的直接操作，只在 Unity 本地帧域消费，不是自然语言行动，也不是当前 ClientMessage。

`map.move` 只携带目标地点；actor 从鉴权 Session 的 human ControlBinding 推导，内容包的 `navigation_resolver` 决定可达性并产生位置提案。它不调用模型，RulePlugin Reject code 原样成为 CommandResult code；接受分支只允许一个 `entity.relocate`。Finalizer 必须把命令持有的 request ID、resolved proposal、CommittedEvent、actor 与 destination 全部关联一致后，才推进 Session 并返回新 SessionView；重复命令重放同一出站结果。失败不改变世界，也不转交 Director。

`stage.outcome_proposal` 是 Stage 帧域回交世界的唯一客户端世界命令；`stage.input` 留在未来 Unity Stage Runtime 的本地帧域，不进入 Command Journal。首次接收时 Command Journal 保存独立 RulePlugin 根 request ID；执行前必须证明 Session 玩家拥有 active human ControlBinding、是目标 open StageInstance 的 participant，并且 stage revision、StageModuleLock、scene 与 outcome type 全部精确命中注册合同。目标 Stage 不存在、Stage basis 过期、玩家不是 participant 或 outcome type 未声明属于闭合的四类调用前客户端拒绝；只有 Finalizer 在同一事务中锁定并证明 accepted Session/World/view revision 未变、RulePlugin root 完全不存在且 accepted revision 后没有 CommittedEvent 时，才可不调用插件完成 rejected。Root 一旦存在就必须沿正式 RulePlugin terminal history 完成；部署、module/scene/lock、completion rule、control/entity 或 accepted-basis 错误不得借该分支释放为普通拒绝。每个 scene 的必填 `outcomes` object 以 namespaced outcome type 为键、闭合 transition kind 为值，Schema 强制至少一个 `stage.close.completion`；Manifest Index 是该映射的唯一只读索引，内部 Map 只是派生查询缓存。Orchestrator 只把 `requireOutcome` 的精确未声明错误翻译成既有客户端拒绝码，不把 transition kind 复制进 RulePluginRequest。`stage_outcome.resolve` 可以先返回由 Server 权威裁决的 ChoiceSpec；reject 与 `choice.required` 不是世界 transition，只有终态 `packet.proposal` 才由语义门禁从 Stage 内嵌的精确 lock + scene + 客户端 outcome type 重新解析映射。proposal 必须以恰好一个映射指定的 `stage.update` 或 `stage.close` 结束；完成关闭的全部 completion `rule.holds` 必须各出现一次且保持声明顺序，无关 precondition 可穿插，非完成关闭不得携带任何匹配项，update 不受 completion rules 的额外禁令。每次 Choice 子调用除 request ID 与已签名 DeterministicContext 外必须逐值保持根请求，Finalizer 沿 Journal 的唯一父子链定位 proposal/reject 终态，再把终态 proposal、CommittedEvent 与最终 StageInstance 精确关联，按 `session.view + 本命令新开的 stage.open* + stage.update|stage.close + command.result` 原子写出并支持精确重放。

服务端只能推送 SessionView、对话回复、CommandResult、PresentationFrame、Stage open/update/close 与协议错误。资产引用内嵌在 RenderNode、PresentationOp 或 `StageOpen.bindings[]` 的正式 `subject + AssetContentRef` 中；没有独立 AssetBinding 消息或推送确认生命周期。SessionView 与 DialogueReply 只携带 DialogueView/DialogueTurnView；模型请求 ID、输出摘要、AgencyCommitment 与内部 dialogue revision 永不下发客户端。卡片结果叙事只在封存结果成功提交后，通过 `narrative.show` 发送；其中 `dialogue_quote` 由服务端从不可变 DialogueTurn 投影为 DialogueTurnQuoteView，Director 不能提供 speaker 或 text。

SessionView 由 World Core 的纯投影端口从锁定 WorldSnapshot 生成：它只依据会话指定的 active human ControlBinding 确定玩家，并按玩家与当日筛选预算、卡片、GoalPlan 和对话；Dialogue 的参与者与 speaker 只投影稳定身份，不携带 `expected_revision`。session ID、view revision、basis token 以及 RenderNode/Notice 候选只由 Server 或 Stage 表现层提供；Core 不签发或校验 token，不缓存，不按 world/content 猜表现，也不把候选写回 WorldState。最终完整 View 必须通过正式 Schema，客户端永远不能取得未投影的世界字段。

ContentBundle 的 `PackBinding` 只有同时声明 `node_kind + parameters` 时才是 2D RenderNode 候选；二者必须成对出现，`node_kind` 直接引用 World Runtime 的唯一 `RenderNodeKind` 枚举。未声明该对字段的 binding 仍只负责资产、物化或 Stage 槽绑定，不能被 Server 猜成 2D 节点。2D 候选不依赖 `stage`，也不存在 `condition_law_id`：Server 只能依据锁定内容、当前 WorldState 与玩家可见事实做同步纯投影，不得在 SessionView 组装期间调用 RulePlugin、按素材类型猜节点种类或把内容自定义 fields 当成渲染参数。

Server 的唯一 2D 投影器从同一事务读取的 `WorldContentLock + WorldState + EngineSession` 工作。可见实体闭合为玩家自身、玩家唯一 active 位置关系的目标、对玩家 `public` / `known_to` 的 active 关系端点，以及包含玩家的 active Dialogue 参与者；位置关系本身是玩家固有可见事实，其他 `private` / `owner` 关系不得被推测为可见。world binding 只命中锁定的 WorldDefinition；本地 entity/relation binding 只经唯一 UUIDv5 Identity Mapper 命中 runtime 记录；definition binding 按每个可见 active Entity 的精确静态 archetype 实例化。`capability` 与 `generation_archetype` 没有 runtime 可见主体所有者，仍可承担非 2D 绑定，但不得声明 RenderNode。相同 runtime 主体与 slot 只保留显式最高 `priority`，并列必须失败；输出按稳定 ID 排序，数组顺序不成为表现真相。

Renderable PackBinding 必须在直接 `asset_id` 与 `materialization_profile_id` 之间精确二选一。直接分支只使用锁定 PackAsset 的 `AssetContentRef`；物化分支先精确命中同 world、同 entity revision、同 slot 的唯一 active VisualBinding，未命中时只允许使用该 profile 必填的 `fallback_asset_id`，不得选择默认素材。VisualBinding 的共享运行时身份只由主体种类、runtime subject ID、`subject_revision` 与 slot 构成；EntityRef 的可选 `expected_revision` 只做并发校验，不改变绑定身份。World Core 替换绑定与 SaveEnvelope 导入/升级门禁必须复用该同一身份算法，并允许不再命中当前主体 revision 的旧 active 记录继续存在但不被投影。Stage 的 world PackBinding 不得引用 `on_demand` profile，因为 MaterializationRequest 的闭合 SubjectRef 没有 world 分支；需要固定 world 素材时使用直接资产，或用 `disabled` profile 明确选择其必填 fallback。可选 `text` 由 PackBinding 直接拥有；若 text/interaction-anchor 绑定没有显式文本，且实例主体是可见 Entity，才使用该 Entity 的权威 `name`。`node_id` 由 binding ID 与 runtime 主体身份的 JCS SHA-256 派生，因此重连稳定而不建立映射表第二真相。

每条命令携带 command/message ID、session ID 与会话级 `basis_token`，用于幂等、并发拒绝和因果追踪。登录与账号鉴权属于外部网关；Engine Session 只拥有 session、world、human ControlBinding、player entity、view/world revision 与随机 nonce。`basis_token` 使用独立于 DeterministicContext 的 HMAC-SHA-256 keyring，对这些状态的 RFC 8785 JCS 摘要签名；它是不可解码的并发令牌，不是登录凭证，不使用时间 TTL，并在 View、World revision、Session 或 ControlBinding 改变时失效。客户端不接收会因隐藏事实变化而泄密的全局 world revision。SessionView delta 只能应用到匹配的 view revision，否则全量重同步；不支持的新渲染原语明确报协议不兼容，不按内容包补客户端分支。

Server 当前实现把上述状态分字段保存在 `engine_sessions`：打开 Session 时从同一 WorldState 精确解析 active human ControlBinding 与 active player Entity，session ID 与 nonce 只能由 Server 随机生成；刷新 View 以 session view revision 做 CAS，并同步当前 world revision。`command_journal` 只接受 Schema 验证且 message 同时含 `command_id` 与 `basis_token` 的 ClientEnvelope。接收顺序固定为先查 `(session_id, command_id)`：相同完整 ClientEnvelope 的 JCS 请求摘要及逐值正文直接恢复，即使其中 token 已因后续进度失效；message ID、client sequence、correlation 或正文任一不同都明确冲突；只有全新命令才锁 Session/World、确认 binding 未改变、world revision 当前并验证 HMAC。最终 accepted/rejected CommandResult 与同一 command ID、当前 view revision 绑定；`pending` 不是完成状态。

`dialogue.start/continue` 已闭合 NPC 与 System 两种 responder。玩家 Entity 只能来自 Session；Entity recipient 必须是同世界 active Entity 且恰有一个 active CharacterMind binding，System dialogue 的参与者必须恰好是玩家与 System。Human RulePlugin packet 固定提交 `R→R+1`；NPC 使用 CharacterMind，System 使用同一 Director 的 `director.system_dialogue` 模式，两者的 verified reply 都经 `dialogue.turn.append` 提交 `R+1→R+2`。System 同次输出的 DynamicDefinitionProposal / GoalPlanProposal / EventCardProposal 先整体绑定 PostgreSQL 身份，再经过锁定 Catalog 引用门禁与 operation 专属 RulePlugin。新 GoalPlan 固定 `expected_revision=0`、revision 1、active；GoalPlanDraft 的 RuleRef、FactRef、Capability 与 GenerationArchetype 必须在当前锁定世界解析。demand 节点只能落成 blocked，并携带引用同一 goal node/demand ID、request ID 在本计划内唯一且 selected archetype 精确属于 allowed 集合的 WorldExtensionRequest。有效 `goal_plan.upsert` 仍只经 `apply_packet` 把完整请求写入 WorldState；System 对话完成后不立即扩展世界。最终化逐 revision 核对 human/responder packet，并把后续每个 Definition、GoalPlan、EventCard commit 精确关联回 proposal Journal 与 RulePlugin Journal，之后才从最终 WorldState 生成 SessionView 并提取 DialogueTurnView 组成 DialogueReply。Session view revision、world revision、basis token、Server sequence/outbox 与命令完成原子提交。Human 提案拒绝只能在世界未变时结束；模型 ambiguous 或 human 已提交后的任何必要阶段拒绝保持 blocked，禁止默认 `no_effect`、固定回复或回滚已提交事实。`dialogue.close` 是独立客户端命令：Client 只提交 dialogue ID，Server 从 accepted Session 证明玩家是 active Dialogue 参与者，以 Command Journal 的全局 request ID 调用精确 `dialogue.close` resolver，并固定通用原因 `player_requested`；日末不自动关闭，客户端也不能自报 reason。

`event_card.trigger` 使用同一 Command Journal/finalizer 边界。首次接收时 Server 生成并持久化全局 packet ID，world/control 只能从 accepted Session 推导；客户端 command ID、card 内 control 或公开 card ID 都不能单独授权点击。Runtime 从卡片内封存结果构造 trigger packet；只有正式 sealed precondition failure 才改走同一 packet ID 的 invalidate 分支，其他摘要、规则或合同错误保持原错误。最终分支只从 CommittedEvent 的末尾闭合 op 推导；trigger 成功后 `dialogue_quote` 只能解析玩家可见的既有 DialogueTurn，并按 `session.view + presentation.frame(narrative.show) + command.result` 写出，invalidate 则写 `session.view + command.result`。重复命令返回同一 message ID、sequence 与正文。

`player_day.end` 使用同一个 Command Journal/finalizer 边界：命令在世界仍等于 accepted revision 时持久化 `from_day`，先提交到下一日 autonomous，再由 WorldExtension scheduler 解析全部 active pending request，之后才运行原有状态机、Director settlement、Character Reaction 与 AutomaticEvent。每一子步骤只由既有 Journal、确定性派生身份与 CommittedEvent 证明。成功必须到达 `from_day + 1` 的 player phase，并且当前 human control 恰有一个 EventBudget，随后才原子推进 Session、写 `session.view + command.result` outbox 并完成命令。若首个必需 RulePlugin 阶段拒绝且世界未变，可以正常完成 rejected；一旦已有权威 packet 提交，任何后续 unresolved 都保持 received/blocked，finalizer 不得用拒绝掩盖部分世界变化。

## 11. Materialization / Asset Engine

运行时新 Definition、Entity、NPC、地点、组织或建筑可以产生 MaterializationRequest。`on_demand` MaterializationProfile 必须通过显式 dependency ID 命中 required `asset_provider` DependencyLock；Server 的唯一 AssetProvider Registry 按该精确锁注册部署 adapter，并在 Content Activation 阶段拒绝缺失、版本不符或重复身份。`kernel.materializations.generateNext` 从 PostgreSQL outbox 以 `FOR UPDATE SKIP LOCKED` 领取 pending request，先证明 profile 所属 bundle 在该 runtime world 的 root/dependency lock 图内、fallback 等于 profile 锁定的 PackAsset、主体仍是当前 active revision，再调用唯一 Provider。Adapter 可以执行网络、文件与生成 I/O，但只能接收已验证 MaterializationRequest、同次读取的精确 EntityState/DynamicDefinitionState 和已解析 profile，返回值仍是不可信 `AssetCandidate` JSON；正式门禁要求 request / revision / generation digest 精确相等，且 provenance 必须以 `asset_provider` 指向锁定 package identity。不存在默认 Provider、缺失 Provider 降级或把 Provider 配置写入内容包；进程若在 Provider dispatch 后失联，请求保持 `generating`，不会自动重调。

Materialization Ledger 是 Request、Candidate、ReviewReceipt、AssetAcceptance 的唯一持久所有者。`kernel.materializations.submitReview` 只接收正式 Schema 的外部审核凭据，按 MaterializationProfile 精确要求 `policy` 或 `human` reviewer，并检查总 verdict 与逐项 checks 一致；Engine 不伪造自动审核结果。接受分支在同一事务写入 ReviewReceipt 与 AssetAcceptance，Acceptance 固定拥有 Server 随机 `acceptance_id` / `binding_id`、候选资产、当前世界逻辑时间和由唯一 DeterministicContext Authority 签发的完整链摘要。`ContentPacket.source` 的第三个闭合分支是 `asset_acceptance { acceptance_id }`；packet 固定 `packet_id = acceptance_id`、`cause_id = request_id`，只有一个 `visual_binding.upsert`，且 binding 必须带 `source_request_id + acceptance_id`。World Core 在持锁快照内从 Ledger 重验 Request/Candidate/Review/Acceptance 全链、精确 precondition 与唯一 op 后才允许 `apply_packet`；普通 RulePlugin 和封存 EventOutcome 均无 VisualBinding 写权限。主体 revision 已变化时 Acceptance 保留审计事实、Request 转为 `superseded`，不绑定旧资产；丢失提交响应可按同一 acceptance ID 幂等恢复。

```text
CommittedEvent / MaterializationRequest outbox
  → prove current subject revision + locked profiles
  → exact required asset_provider DependencyLock
  → composition-root AssetProvider adapter
  → untrusted AssetCandidate JSON
  → explicit policy / human ReviewReceipt
  → PostgreSQL AssetAcceptance
  → asset_acceptance ContentPacket
  → apply_packet → VisualBinding
  → subsequent SessionView / StageOpen projection embeds AssetContentRef
```

该设计吸收 GameCastle 的资产引擎思想，但不复制其代码：

- 世界提交先完成；专属资产异步产生，失败不回滚世界；
- 资产按内容 hash 寻址，文件路径不是身份；
- 请求锁定主体 definition revision、视觉槽位、风格 digest 与生成规格 digest；VisualBinding 提案不含提交事件 ID，由 apply_packet 在提交时注入；
- 候选结果必须匹配 request ID 和主体 revision，过期候选不得绑定；
- fallback 由内容包的 MaterializationProfile 显式声明，不按 slot 或资源类型猜测；
- 接受决定、绑定 hash 与来源写入独立 Ledger；提交恢复直接复用同一 Acceptance，blob 缺失显式报损坏，不静默重生成；
- WorldState 中的 VisualBinding 永远是 session scope；不可变 Pack 资产来自 ContentBundle，Shared Library 只由独立审核晋升服务写入，世界 ContentPacket 无权晋升；私人创造不自动跨世界传播。

## 12. 模型角色、上下文分区与调用协议

模型协议只使用严格、版本化 JSON Schema，不使用语义 DSL，不向模型暴露客户端运行时字典、WorldState 写句柄或 EffectOp。Server 侧每次模型内容装配通过唯一 `RuntimeWorldBindingResolver` 调用一次 `RuntimeWorldReader`，同时取得 `WorldSnapshot` 与不可变 `WorldContentLock`，再由 `ContentRuntimeCatalog.resolveWorldContentBinding` 精确得到内容包；Prompt 物化不得接受调用方传入的 `bundle_id` / `bundle_digest` / `mind_id` / `directorId`。CharacterMind 通过 Content Runtime Identity Mapper 把 runtime entity UUID 解析到当前绑定包的 CharacterMind；DirectorProfile 只由 WorldDefinition 必填 `director_profile_id` 精确选择，并必须属于同一 `world_id`。Journal 随后必须在持久化事务内锁定世界行并复核该 snapshot，不能为追求单次查询删除并发一致性门禁。

Runtime Kernel 只接受组合根显式注入的一个 ModelProvider adapter。供应商、模型、远程密钥和超时全部属于显式部署配置，不进入 ContentBundle、WorldState 或公共协议；`createRoutedModelProvider` 可组合多个单用途 adapter，但每个 `(model_profile_id, request_kind)` 必须唯一显式注册，缺失或重复都在 activation 前失败，不存在默认供应商、默认模型或回退路由。每个 Provider 必须实现同步的部署能力门禁；activation 在任何持久 dispatch 之前确认五种闭合 request kind 的所选 ModelProfile 均可处理，配置错配不得把第一条玩家命令变成 ambiguous。Server 提供两个真实、单次调用的 adapter：OpenAI Responses 要求 endpoint、API key、ModelProfile、model、timeout 与 max output tokens；本地 Ollama 要求 loopback `/api/chat` endpoint、ModelProfile、request kind、已安装 model、timeout、max output tokens、temperature 与部署方从正式 ModelOutput 合同派生的 generation Schema，不接受无鉴权远程地址。前者请求 JSON object，后者使用 native chat 的 `stream:false`、`think:false` 与结构化 format；deployment 可保留本机 grammar 支持的判别联合并合并对象交集，但 generation Schema 始终只能缩小 Provider 的生成空间，不能取代、复制或放宽正式合同。Schema 通过原生 `format` 传给 Provider，不再把巨型 Schema 文本复制进 Prompt。二者共用流式响应字节上限与严格 UTF-8 门禁，覆盖完整响应体读取超时且从不重试。Provider 输出始终是不可信 JSON，只有 ModelGateway 完成完整 Schema、JCS digest、correlation 与语义校验后才可成为 receipt。v1 不做 Engine 级模型响应缓存；Prompt block 的 digest 只用于内容身份与 Provider 自身可选的传输优化。Provider 调用在 Journal 标记 dispatched 后只执行一次；从取得 dispatch authorization 到 verified receipt 持久化之间的任何失败都报告同一 ambiguous/blocked 边界，不自动重调。

运行时只有两个模型层级：

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

不存在独立 `System.*`、`Narrator.render` 或 `materialization.spec` 文本模型入口。`request_kind` 是 ModelRequest 的唯一入口 discriminator；ModelResponse 必须回显 request_kind、resident_context_digest、dynamic_input_digest 与 output_digest。ModelGateway 先把已经 Schema 验证的 WorldSnapshot 与 ModelRequest 封成 prepared invocation；Provider 调用只接受持久化 Journal 在数据库确认 dispatched 后签发的一次性 opaque authorization。响应必须再经过 Schema、digest、correlation 与入口语义门禁，之后才能把 snapshot、request、response、VerifiedModelOutputRef、world ID 与观察 revision 封成同一份 verified receipt；从数据库恢复时也只能通过同一 Gateway 重新验证全部四份合同，禁止公开 seal 工厂。prepared invocation 与 verified receipt 的来源集合属于具体 Gateway 实例；Journal、RulePluginGateway 与提案存储只能持有配对生产实例的只读 verifier，不接受另一实例生成的对象。`failed` 输出直接成为 EngineFault，绝不签发 proof。五种入口分别校验输入与输出关联：Character resident、主观角色、知识 viewer 与角色状态机 owner 必须是同一 Entity；对话必须 active 且回复当前最后 human turn；daily/event card 的 day、actor、dialogue、proposal/outcome/gate 引用必须闭合；Character.react 必须对每个 stimulus 恰好返回一个 reaction，并精确覆盖该角色参与的 gate。Character Mind 的 commitment 只是未落地证据草案：Runtime 仅可新增 commitment_id，其余字段必须逐项保留 verified draft，再经 append-only 对话 Packet 写入。Director、System、客户端和内容包均无 commitment 写入口。EventCard 结果叙事由 Director 与语义结果一同提出并在发卡时封存，但 NPC 原话只能引用既有 turn；资产引擎直接根据 Definition、ArtProfile、MaterializationProfile 与视觉槽生成规格。

RulePluginGateway 不保存全局模型证明，也不按 request ID 猜测证明。每次 `resolve` 必须显式传入本次作用域的 verified model receipts（没有模型输入时也传空数组），并在调用 RulePlugin adapter 前确认请求内每个 proof 与某一 receipt 完全一致、receipt 属于同一 world，且 proposal、reply、commitment 或 reaction 是原 ModelResponse 的精确成员。模型 proof 的 `basis_revision` 表示模型观察世界的 revision；连续裁决同一次模型输出时它可以小于当前 RulePluginRequest revision，但不得大于当前 revision。PacketProposal 仍必须使用本次 RulePluginRequest 的当前 basis revision。

所有模型调用共用同一持久化 Journal 与 `model_invocations` 状态真相：prepared 请求与精确 WorldSnapshot 先落库，随后通过数据库状态转换进入 `dispatched_ambiguous`，事务提交后才签发一次性 Provider 调用权；该状态如果没有持久化 verified response/proof，就表示结果未知且任何进程都不得重新调用模型。`Director.daily_settlement` 额外以数据库唯一约束保证每个 `(world_id, day)` 只有一次 prepared 请求。完整 Director receipt 落库后状态只到 `response_verified`；这不等价于日结完成，NPC 反应、规则裁决和全部世界提交的完成证据属于后续业务编排，不由本基础 Journal 伪造。

### 12.1 常驻区与动态区

每次 ModelRequest 明确拆成 `resident_context` 与动态 `input`。Runtime 通过 Prompt materializer 从锁定 ContentBundle 解析有序 Prompt 文本；Provider 接收内部 `ResolvedModelInvocation`（已验证 request + 与 CacheBlockRef 逐项匹配的有序 blocks + Director event_context digests）。组装顺序：

```text
常驻前缀：common_blocks
  → Director event_context 或 Character persona_blocks
  → mode_block
动态尾部：最新 basis_revision 对应的 world/subjective view
  → objective traces / dialogue / event batch
```

缓存身份只使用内容地址 `block_id` / `resident_key` 与 `content_digest` / `resident_digest`；**禁止**人工 `block_revision`、`resident_revision`、`context_revision` 与无所有者的随机 resident/context UUID。任一常驻源变化必须产生新 digest，不得原地覆盖。Prompt 文本是只读派生物；ContentBundle 仍是唯一真相。

Kernel 只暴露闭合 `kernel.models.*`（五种 request_kind）；WorldView / KnowledgeView / Dialogue 等只能从锁定 WorldSnapshot 投影，调用方不得传入任意 View JSON。不存在公开的 `executeModel(scope, candidate)` 旁路。

### 12.2 隔离与失败

Director 不读取角色完整私有 Prompt、私有缓存或未表达的内心。角色之间也不共享私有上下文。ResidentContextRef、缓存与投影都只是可丢弃派生物；WorldState、ContentBundle lock、允许可见的 transcript 和 CommittedEvent 才是真相。

同一日终结算中，Runtime 先按目标 Entity 聚合 CharacterEvent；同一 Character Mind 一次接收事件数组，不同 Character Mind 异步并行。全部必要反应经过规则处理后结算才完成。模型失败与等待只属于编排状态，不写入 WorldState，也不产生默认 `no_effect`、跳过或兜底回答。已经进入持久化 dispatched 状态的模型调用不自动重试；缺少 verified receipt 时保持明确阻塞。

## 13. ContentBundle JSON

当前设计阶段不建立 Excel、CSV、ContentDesignIR 或内容编辑器编译链。每个外部内容包直接维护符合 `contracts/content-bundle.v1.schema.json` 的 ContentBundle JSON；这份 JSON 同时是内容作者的唯一内容源和 Engine 的发布输入。

所有引擎 JSON 摘要统一为：先按 RFC 8785（JCS）规范化目标 JSON 值，编码为 UTF-8，再计算 SHA-256，输出小写十六进制。`ContentBundle.release.bundle_digest` 只计算根对象的 `bundle` 值，不包含 `release` 包装，避免摘要自引用。`release` 不保存工作簿版本、编译器版本或另一份源摘要；ContentBundle JSON 本身就是源。

- ContentBundle JSON 面向项目方、内容 Agent 与技术内容作者，不承诺是最终策划体验；
- Engine 只做 Schema、引用、主体性、资源与世界规则校验，不从缺失字段猜默认规则，也不在运行时调用模型解释内容文件；
- 内容 JSON 可以声明内容定义并引用公开合同，但不能携带 EffectOp、WorldState 写入、模型供应商配置、客户端运行时内部对象或迁移命令；
- 已发布 Bundle 不得原地修改；任何内容变更都产生新的版本与 digest；
- 引擎仓库不保存具体内容包，不按 `pack_id`、`world_id` 或具体剧情写分支；
- 未来若增加 Excel 或可视化编辑器，它只能是同一 ContentBundle JSON 的作者界面，单向生成相同合同，不能建立第二套内容数据库或第二种运行时输入。

ContentBundle 不是预制任务全集。它提供初始世界、角色行动状态机、世界状态机、事件种子、规则语义与可行路径；运行时自由度仍由通用规则、角色独立反应、Director 事件和 System 的世界缺口工程共同产生；只有 Director 拥有事件调用上下文。

## 14. 内容版本、存档与迁移

1. SaveEnvelope 使用唯一 `world_content_lock`（`WorldContentLock`：`root_bundle_lock` PackLock + `world_definition_id`）永久绑定 base 内容包与其中的 `WorldDefinition`；依赖包另列，加载时不自动选择最新版。`WorldDefinition` 通过必填 `director_profile_id` 精确选择同包、同 `world_id` 的唯一 DirectorProfile；模型调用方不得再传 Director 选择，禁止默认、首个或跨世界兜底。
2. ContentBundle 本地 `Identifier` 到运行时 UUID 的唯一映射固定为 RFC 9562 UUIDv5：namespace 是运行时 `world_id`，name 是 UTF-8 `pack_id + "\0" + kind + "\0" + local_id`；初始实体、关系和状态机绑定分别使用 `entity`、`relation`、`state_machine_binding`。同一世界实例内映射可重算且稳定；Content Upgrade 改 local ID 时必须显式声明映射。
3. ContentBundle 的 `catalog.entities` / `catalog.relations` 是同包全部 WorldDefinition 共享的初始世界图；不同初始图必须使用不同 ContentBundle，禁止再建立隐式 world 过滤规则。每条 InitialRelation 必须声明内容侧 `InitialVisibility`；`known_to.actors` 只允许符号玩家或本包本地 Entity，创建时才映射为 runtime `actor_ids`。WorldDefinition 选择该共享图上的起点、玩家 archetype、`player_initial_components`、`player_location_relation_type_id`、`player_location_fields`、`player_location_visibility`、规则、Director 与表现配置；玩家起点 fields 必须按 relation type 的 ExtensionField 合同校验。
4. 新世界创建请求必须显式携带已验证 WorldContentLock 与玩家名。Server 生成随机 runtime world、player、human/CharacterMind ControlBinding、玩家起点关系与初始 frame UUID；内容初始 entity / relation / machine binding 使用上述 UUIDv5 映射。玩家 archetype 保持 StaticDefinitionRef，不复制静态定义组件为可变状态；只物化 WorldDefinition 的 `player_initial_components`。起点关系使用 `player_location_relation_type_id` 指向 `start_location_entity_id`，data 与 visibility 只来自同一 WorldDefinition。revision 0 不预造 EventBudget；Runtime 首次完成 `autonomous → director_settlement → player` 时，`day_cycle.advance` 才在同一权威 Packet 内创建 day-1 唯一预算，capacity 只取所选 WorldDefinition 的 `event_budget.daily_capacity`，不得由 SessionView 投影补造。内容实体/关系 provenance 固定为锁定 bundle digest，玩家及其起点关系 provenance 固定为本次 runtime world 创建。初始 machine frame 使用定义的 `initial_state_id`，固定 `indefinite + remain`。新世界固定为 world revision 0、day 1、`autonomous` phase、phase revision 0；完整 WorldSnapshot 与 WorldContentLock 先经 Schema，再在一个 PostgreSQL 事务内插入并回读精确复核。
5. SaveEnvelope 只作为导入/导出合同，不与数据库并行保存整份副本；PostgreSQL 分字段拥有 WorldState、内容/依赖/插件/Stage 锁、Save/Engine 版本、event cursor、资产摘要与迁移历史。新世界创建先组成完整 revision-0 SaveEnvelope，再与外部导入共用同一原子分解入口；导出在 repeatable-read 快照内重建并整体验证。导入只接受正式 `SaveSchemaImportRequest`：`current` 模式要求候选已经是当前版本，`migrate` 模式要求显式 `plan_id` 并先完成 Save Schema Migration；随后才做顶层关联和当前激活依赖图精确兼容门禁，并且只能创建不存在的 `world_id`，禁止覆盖现有 world、Session 或 Journal。v1 固定 `event_cursor === world_revision`；PostgreSQL 另存内部 event-history floor：本地新世界为 0，导入世界为导入 cursor，后续 `apply_packet` 同步推进 revision 与 event cursor，但不伪造导入前的 CommittedEvent。`SealedEventResult` 因此必须携带完整 DeterministicContext，任何可用 EventCard 都不能依赖存档外的历史事件才能点击。
6. 普通 `apply_packet` 不得修改 WorldContentLock、实现锁或迁移历史；唯一例外是 source_kind 固定为 `content_upgrade` 且 ops 只有一个 `content_upgrade.apply` 的封闭升级 packet。该操作不能携带任意路径修改，只能提交已经通过 SaveEnvelope Schema、关联、目标激活兼容与 transformer 专属语义门禁的完整候选。
7. 已发布 ContentBundle 不得原地修改；存档同时锁定 RulePlugin 与 StageModule 精确实现 digest，服务器保留所有活跃存档仍引用的 bundle、实现与资产 blob。
8. Save Schema Migration 与 Content Upgrade 是两条独立流程：前者只改变存档结构，禁止改变 bundle lock 或重新解释世界事实；后者只由玩家通过 `content_upgrade.accept` 显式发起，不存在启动时自动升级。数据库 DDL migration 是第三条独立流程，也不得代替或触发前两者。
9. Content Upgrade 选择的唯一身份是目标 PackLock + `migration_id`。目标 ContentBundle 必须声明精确 `from_pack_version`、`from_bundle_digest`、`to_pack_version`、`declared_mapping` 与 transformer；source/target pack ID 必须相同，禁止跨 base pack、按显示名、数组顺序或“唯一一个”猜测重绑。
10. World Core 是 `UpgradeAuthorization` 的唯一签发与验签所有者。授权摘要绑定 upgrade command、world、玩家、source revision、源 SaveEnvelope 摘要、migration、source/target bundle digest、同意文本摘要和有效期；Server 使用第三套独立部署 HMAC keyring，禁止与 DeterministicContext 或 Session basis keyring 复用。
11. Command Journal 为升级预分配全局 upgrade/packet ID 与 RulePlugin request ID。`content_upgrade_authorizations` 必须先保存授权，再允许持久化并执行 deterministic + no_io 的 `content_upgrade.transform`；只有 resolved response 摘要进入 `commit_ready` 后，World Core 才能通过独立 Pool 联接原始 RulePlugin request/response 并重验。
12. 候选 SaveEnvelope 必须保持 world/save/engine 身份，revision 与 event cursor 精确增加一，切换到目标 PackLock，保持 world_definition_id，追加且只追加一条完整 content-upgrade migration history；unresolved 非空时整条命令拒绝，禁止默认补值。
13. `content_upgrade.apply` 是唯一能在既有 world 上同时改变 WorldState、内容/依赖/插件/Stage 锁、资产摘要和迁移历史的 EffectOp；它必须是 packet 唯一 op，且由同一个 PostgreSQL `apply_packet` 事务整包提交或完整拒绝。packet 提交后的恢复只认相同 packet ID、授权与插件收据，不能重新转换。
14. DynamicDefinition、GoalPlan、WorldExtension、StageInstance 与 VisualBinding 属于存档，升级 transformer 必须显式保留、转换或拒绝；每次成功升级的迁移历史记录 source/target、实现摘要、授权、确定性上下文、执行时间与结果摘要。
15. Save Schema Migration 的机器真相是 `save-schema-migration.v1` 中的 ModuleManifest、MigrationPlan、ImportRequest 与 StoredMigrationRequest。部署显式注册受信同步 `pure + no_io` module 和计划候选；计划必须从请求源版本逐步连续到当前版本，每步精确命中 module identity、source/target Schema ref 与 implementation digest。禁止按版本号猜路径、默认计划、异步 I/O、Content Upgrade transformer 复用或未注册步骤。
16. 每个 Save migration step 先用声明的源 Schema 验证，再执行 module，再用声明的目标 Schema 验证；world、WorldState、内容/实现锁、revision、event cursor、资产与 engine contract 身份必须逐值不变，迁移历史及其 JCS digest 只能由 Server 追加。存量 world 迁移必须在 PostgreSQL world 行锁内重建候选并原子写回 `save_schema_version + migration_history + updated_at`，不调用 `apply_packet`。仓库不伪造历史 Schema、module 或 plan；部署没有真实历史制品时显式注册空数组，旧版本输入明确失败。

## 15. 首版非目标

- 离线权威模式或离线存档；
- 第三方不可信插件市场与沙箱；
- Q 版可行走世界；
- 模型生成代码、客户端运行时事件或 StageModule；
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
| 客户端、Client Runtime Host 与 StageModule 消息 | `contracts/client-bridge.v1.schema.json` |
| MaterializationRequest、资产收据与绑定 | `contracts/materialization.v1.schema.json` |
| 模型各阶段 request/response | `contracts/model-protocol.v1.schema.json` |

本文档不得复制这些 Schema 的完整字段表。字段变更只改对应 Schema；内容数据只改外部 ContentBundle JSON；架构责任变化才改本文档。
