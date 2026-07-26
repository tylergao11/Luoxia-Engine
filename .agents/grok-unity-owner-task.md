# Grok 长期任务：Luoxia Unity 全栈负责人

## 0. 当前交接状态

**2026-07-26：Headless Dialogue Gate 已通过。Unity 全部事项正式归 Grok 所有；Grok 可以执行 U0/U1，并在显式确认正式项目路径和版本锁之后执行 U2 及后续真实 Unity 实现。**

本次 Server 交接证据：

- PostgreSQL 18.4 已承载真实 world、Session、Command Journal、模型 Journal、RulePlugin Journal、CommittedEvent 与 ServerEnvelope outbox；
- 同一 Session 已通过 HTTP 完成 `dialogue.start` 与 `dialogue.continue`；
- 两条命令共提交 4 个权威 packet / event，最终 world revision 为 4、Session view revision 为 2；
- 两次 CharacterMind 调用均由本机真实 `qwen3:8b` Provider 生成并进入 `verified`；
- 四次对话 RulePlugin 调用均进入 `resolved`；
- 两条命令各持久化 3 个 ServerEnvelope，共 6 个；同进程重发与 Server 重启后的重发都恢复相同 JSON 值、message ID、sequence 和 correlation；
- 另有一次真实模型输出未形成 verified receipt，Server 正确保持 `dispatched_ambiguous`、占用该 world 执行槽并禁止自动重调，证明 blocked 边界不是文档假设；
- 新世界现在从 WorldDefinition 初始化 day-1 human EventBudget，SessionView 不再补造预算；
- CharacterSubjectiveView 已严格服从 Schema 的 EntityRef，不携带越权 revision 字段。

当前真实 Server 接缝：

- `GET /api/health`
- `POST /api/client-envelope`
- 正式外部部署与基准内容位于 `C:\Ai\Luoxia-Deployment`
- Engine 仓库仍不内置内容、插件、数据库口令、HMAC 密钥或模型默认值

`C:\Ai\Luoxia-Unity` 只是当前正式项目根目录候选，不是已创建工程或默认路径。U2 开始前必须由用户或 Codex 显式确认最终路径；不得放入任何 Editor 安装目录，也不得放入 `C:\Ai\Luoxia-Engine`。若确认的目标路径已存在非空内容，先报告精确冲突，不得覆盖。

## 1. 任务身份

你是 Luoxia 项目的 **Unity 全栈负责人**。从现在开始，所有 Unity 相关调查、工程建立、C# Runtime、网络接入、输入、UI、动态场景、表现状态机、动画、音频、资产绑定、编辑器工具、构建与平台适配均由你负责。

这是一条长期工作流，不是一次性原型任务。必须持续做到真实运行、边界闭合和可交付，不得用假 Server、假 Provider、硬编码剧情、临时脚本或第二套协议模型换取演示效果。

当前机器上已观察到的 Unity Editor 候选：

- 安装目录：`C:\Ai\Unity\2022.3.62f3c1`
- Editor：`C:\Ai\Unity\2022.3.62f3c1\Editor\Unity.exe`
- 当前尚未创建 Luoxia Unity 项目。

上述路径只属于 U0 环境证据，不构成正式 Unity Runtime、SDK 或 Package 版本选择。Grok 必须在 U2 实际创建工程时显式选择并把版本锁写入正式 Unity Host 工程及其部署配置；不得从候选路径、Hub 当前选择或本任务文档推导默认版本。

## 2. 总体产品边界

Luoxia Engine 是游戏的语义与权威运行时；Unity 是唯一客户端与表现运行时。

Luoxia Engine 负责：

- 世界语义、规则与隐藏真相；
- WorldState、Entity、Relation、Component 和 Ledger；
- 权威状态机与因果裁决；
- NPC Character Mind、Director/System 模型编排；
- Session、Command Journal、模型与插件调用 Journal；
- `apply_packet`、CommittedEvent、SessionView；
- 场景应当呈现什么的语义结果；
- 可验证的 Client/Server JSON 消息。

Unity 负责：

- 玩家输入采集；
- ClientEnvelope 的发送；
- ServerEnvelope 的接收、顺序与关联处理；
- SessionView、DialogueReply、PresentationFrame、Stage 消息的消费；
- UI、镜头、角色、动画、音频、特效；
- 根据服务端语义动态组装和绘制场景；
- 表现状态机和可丢弃的本地播放进度；
- 资产下载、缓存、实例化与 AssetBinding 消费；
- 断线重连、resync 和协议错误展示。

Unity 永远不得：

- 直接读取或修改 WorldState；
- 自行判断 NPC 应该说什么；
- 自行结算规则、AP、关系、剧情或状态机结果；
- 依据 `pack_id`、世界名、人物名或剧情写客户端分支；
- 把 Scene、GameObject、MonoBehaviour、Animator 或本地缓存变成世界真相；
- 在服务端消息缺失时猜默认结果、自动降级或生成 `no_effect`；
- 建立一套与 `contracts/*.schema.json` 并行的手写协议字段真相。

## 3. 与 Codex 的固定分工

### Codex 总控范围

Codex 负责且仅 Codex 可以改变：

- `C:\Ai\Luoxia-Engine\contracts`
- SchemaRegistry 与 Catalog
- World Core 与 `apply_packet`
- PostgreSQL DDL、Store、Journal
- Session、basis token、Command 编排
- RulePlugin 与 ModelProvider Server 接线
- HTTP/WebSocket Server 生产者
- ServerEnvelope 的权威语义、序列和恢复边界
- Engine 后续里程碑的选择、发布与验收

### Grok 独占范围

Grok 负责：

- Unity 安装和模块调查；
- 未来 Unity 项目的全部目录与 Assembly Definition 设计；
- Unity C# Client Bridge；
- Unity transport、session runtime、message router；
- 对话 UI 和输入；
- SessionView 投影消费；
- 动态场景组合、RenderNode/Presentation/Stage 消费；
- Unity 表现状态机、动画、音频、镜头和特效；
- Unity AssetBinding 与资源生命周期；
- Unity 编辑器运行、Player 构建和平台适配。

### 唯一共享接缝

双方只通过以下接缝协作：

```text
contracts/*.schema.json
        ↓
ClientEnvelope → Server transport → ServerEnvelope
        ↓
Unity 只消费经过合同验证的公开视图与表现消息
```

若 Unity 侧发现合同不足：

1. 不得直接从 Unity 调用方反推并发明字段。
2. 必须指出具体 Schema、定义、现有字段、缺失语义和实际 Unity 使用场景。
3. 将缺口交给 Codex 判断字段所有者。
4. Codex 修改并稳定合同后，Unity 才消费新版本。

不得在 Unity 工程中复制或修改一份私有 Schema 作为第二真相。

## 4. 已通过的 Headless Dialogue Gate

当前总目标明确规定：

> 暂不创建 Unity 项目；先让 Luoxia Engine 在 Server 内独立完成可恢复、可幂等、真实模型驱动的 NPC 基础对话闭环。闭环稳定后才开始 Unity Host。

该门禁的通过条件如下，现已由 Codex 以真实 PostgreSQL、真实模型和进程重启恢复证据确认：

- 真实 PostgreSQL 已承载 Session 与 Command Journal；
- `dialogue.start` 和 `dialogue.continue` 已有真实 Server 命令入口；
- 玩家发言和 NPC 发言均只经 RulePlugin + `apply_packet` 提交；
- Character Mind 使用真实 ModelProvider；
- 模型调用具备 prepared / dispatched ambiguous / verified 恢复边界；
- 同一 command 不会重复调用模型或重复追加 turn；
- Server 能产出稳定、Schema 验证的 DialogueReply、SessionView、CommandResult 和 ServerEnvelope；
- Server 进程重启后可以从持久证据恢复；
- Codex 明确发出“Headless Dialogue Gate 通过”的交接结论。

该门禁已经解除，不再阻挡 U0、U1 或 U2。它只解除 Server 基础对话依赖，不替代 U2 对正式项目路径、Unity Runtime、SDK 与 Package 版本的显式选择和工程内锁定。

## 5. Phase U0：Unity 环境预检，现在立即执行

只读检查并在你的任务输出中报告，不在 Engine 仓库创建测试报告：

1. 核实 `Unity.exe` 的 FileVersion、ProductVersion 和安装完整性。
2. 核实已安装模块，至少列出 Windows Editor 支持、WebGL、文档和实际可用的构建目标。
3. 核实 Unity 随附的 .NET/Mono、MSBuild、Package Manager 与命令行 batch mode 路径。
4. 核实 Hub 与 Editor 的实际产品身份，不把 Tuanjie Hub 目录名误判成运行时产品。
5. 检查是否已有 Luoxia Unity 项目；当前预期为没有。
6. 识别当前机器上会影响后续构建的真实缺口，但不要自行安装或删除模块。
7. 给出未来项目根目录建议，不能放进 Unity Editor 安装目录，不能污染 `C:\Ai\Luoxia-Engine` 的 Server 包边界。

U0 输出必须包含精确路径与版本证据，不接受“应该可用”。

## 6. Phase U1：Unity 接缝与实现蓝图，现在立即执行

只读检查这些真相源：

- `C:\Ai\Luoxia-Engine\AGENTS.md`
- `C:\Ai\Luoxia-Engine\README.md`
- `C:\Ai\Luoxia-Engine\docs\architecture.md`
- `C:\Ai\Luoxia-Engine\contracts\common.v1.schema.json`
- `C:\Ai\Luoxia-Engine\contracts\client-bridge.v1.schema.json`
- `C:\Ai\Luoxia-Engine\contracts\world-runtime.v1.schema.json`
- `C:\Ai\Luoxia-Engine\contracts\materialization.v1.schema.json`

完成以下分析：

1. 为每种 ClientMessage 和 ServerMessage 建立 Unity 责任映射。
2. 明确 ClientEnvelope / ServerEnvelope 的 message ID、session ID、sequence、correlation ID 所有者。
3. 明确 basis token 的保存、替换和失效行为。
4. 明确 SessionView 全量替换和 SessionDelta 严格 revision 应用规则。
5. 明确 DialogueReply 与 SessionView.dialogues 的关系，禁止形成两份冲突的对话状态。
6. 明确 PresentationFrame、StageOpen、StageUpdate、StageClose 的 Unity 生命周期。
7. 明确 RenderNode、AssetBinding、Stage visible state 的消费边界。
8. 识别当前 Schema 对 Unity JSON Schema 2020-12 验证的库能力要求。
9. 设计避免手写 DTO 成为第二真相的 C# JSON 边界。
10. 给出未来 Assembly Definition 与模块依赖图。
11. 列出只属于 Unity 的状态，以及任何必须由 Server 拥有、Unity 不得缓存为真相的状态。
12. 找出真实合同缺口；只报告，不直接改 Engine 合同。

推荐的未来 Unity 模块边界：

```text
Luoxia.Contracts
  JSON Schema 资源、验证入口、只读 JSON 文档边界

Luoxia.Transport
  HTTP/WebSocket、Envelope sequence、correlation、重连

Luoxia.Session
  session_id、basis_token、view revision、resync

Luoxia.Dialogue
  dialogue.start/continue 输入和 DialogueReply/DialogueView 消费

Luoxia.Presentation
  SessionView、RenderNode、PresentationFrame、Notice

Luoxia.Stage
  StageOpen/Update/Close、本地表现状态机、输入/Outcome proposal

Luoxia.Assets
  AssetBinding、下载、摘要核对、缓存和实例生命周期

Luoxia.UnityHost
  MonoBehaviour 组合根、场景生命周期、输入/UI/动画/音频接线
```

这只是职责建议，不是允许提前创建工程；U1 必须先验证其与现有合同是否一致。

## 7. Headless Dialogue Gate 通过后的实施阶段

### Phase U2：创建正式 Unity 项目

门禁通过后才执行：

1. 根据 U0 的真实环境证据显式选择一个已安装 Editor；不得把当前候选路径当作默认版本。
2. 项目路径由用户或 Codex 最终确认；不得放入 Editor 安装目录或 Engine 仓库。
3. 只在正式工程的 `ProjectVersion.txt`、`Packages/manifest.json`、`Packages/packages-lock.json` 及部署配置中精确锁定 Unity Runtime、SDK 和 Package Manager 依赖。
4. 建立职责清晰的 asmdef 依赖，不建立 BaseService/BaseManager 继承树。
5. 不导入 GDJS、Cocos、旧 LuoXia/QingYun/GameCastle 代码或兼容层。
6. 不创建与真实路径无关的大型测试工程或假运行时。

验收：

- Unity Editor 可以无错误打开；
- batch mode 可以编译；
- 工程自身完整记录实际使用的 Editor、SDK 与 Package 版本，不依赖本任务文档提供默认值；
- 无默认 Server URL、默认世界、默认内容或默认 token。

### Phase U3：Client Bridge 与真实 Transport

1. 从唯一正式 Schema 资源验证所有入站 ServerEnvelope。
2. 未验证 JSON 不得进入业务路由。
3. 未知 protocol version、message type、sequence gap 和字段必须明确失败。
4. 实现显式配置的 Server 地址；不得硬编码 localhost 作为生产默认。
5. 实现 message ID、correlation、sequence、ACK 与 resync。
6. 断线后不得重放具有新 command ID 的同一玩家动作；原 command 必须保留身份。
7. basis token 只使用最新 SessionView/Delta 下发值。

验收必须使用 Codex 提供的真实 Server，不使用假响应。

### Phase U4：基础 NPC 对话可玩闭环

第一条 Unity 纵向链固定为：

```text
玩家选择 NPC
  → 输入文本
  → dialogue.start ClientEnvelope
  → CommandResult / DialogueReply / SessionView
  → UI 显示权威 NPC turn
  → 玩家继续输入
  → dialogue.continue 使用同一 dialogue_id 与最新 basis_token
  → 新 NPC turn
```

要求：

- 玩家 Entity 只能来自 SessionView。
- NPC recipient 必须来自服务端投影出的稳定 EntityRef。
- UI 不预先插入“权威 NPC 回复”。
- pending/blocked/ambiguous 必须可见，不生成兜底文本。
- 同一 command 重发不得在 UI 生成重复 turn。
- DialogueReply 只作为低延迟消息；最终对话集合以同 revision 的 SessionView 为准。
- 不显示 model request ID、output digest、commitment 或隐藏 dialogue revision。

### Phase U5：SessionView 与动态场景组合

1. 设计 SessionView 的不可变快照消费。
2. RenderNode/PresentationFrame 驱动场景对象增删改。
3. 所有节点以稳定 ID 关联，不能按 GameObject 名称猜身份。
4. Unity 可维护可丢弃的对象池和播放缓存，但断线/resync 后必须能从完整 SessionView 重建。
5. 动态场景组合只解释表现语义，不重新解释世界规则。
6. 未知表现原语明确报告协议不兼容。

### Phase U6：Unity 表现状态机与 Stage Runtime

1. StageOpen 创建本地 Stage 实例。
2. StageUpdate 只更新允许的 visible state。
3. StageInput 仅提交输入意图。
4. StageOutcomeProposal 只是提案，不是世界提交。
5. StageClose 幂等清理本地表现对象。
6. 动画、镜头、音效、粒子和 UI 状态机不得反向写 WorldState。
7. 重连时本地 Stage 可以丢弃并由 Server 状态重建。

### Phase U7：资产与 Materialization 消费

1. 只消费服务端 AssetBinding。
2. 以 content digest 验证下载结果，文件路径不是资产身份。
3. 缺失资产显示合同允许的 pending/fallback，不自行生成世界事实。
4. 旧 revision 资产结果不得覆盖新绑定。
5. 资源释放、缓存、场景实例与下载任务必须有明确生命周期。

### Phase U8：交付与平台验证

1. 先完成 Windows Editor 与 Windows Player 的真实闭环。
2. 其他平台只在明确要求后扩展。
3. 使用真实 Server、真实 ContentBundle、真实 RulePlugin 和真实 ModelProvider。
4. 记录 Unity 版本、包版本、构建命令和最终 Player 结果。
5. 不把仅 Editor 可运行冒充 Player 可运行。

## 8. 编码纪律

- 优先 `interface`、组合和明确所有者。
- 不建立 `BaseManager`、`BaseService`、`BaseMessage` 继承树。
- 消息路由使用闭合 discriminator map，不写巨型反射式万能 Handler。
- 未知消息、版本、引用、sequence 和 revision 明确失败。
- 所有入站 JSON 在访问字段前通过正式 Schema。
- 不通过 `JsonUtility` 手写 DTO 复制 Schema 字段真相。
- 不用 PlayerPrefs 保存权威世界或 command 结果。
- 不使用 ScriptableObject 复制 ContentBundle 或 WorldState 真相。
- 不把 Unity Scene 作为世界定义源。
- 不加入 TODO、FIXME、空 Handler、假 Provider、固定 NPC 回复或临时兼容层。
- 中文文本和 JSON 文件统一 UTF-8，修改后检查乱码。

## 9. 工作方式与交接格式

每个阶段只做一个明确问题，输出：

- 当前阶段；
- 检查或修改的真实路径；
- 已证明的结果；
- 发现的合同缺口；
- 需要 Codex 处理的 Server 接缝；
- 下一步；
- 是否被 Headless Dialogue Gate 阻挡。

若被门禁阻挡，继续完成仍可进行的 Unity 预检、合同映射和工程设计，不得用假实现绕过。

Grok 不提交或推送 Git，除非用户明确要求。不得改动 Luoxia Engine 的 Server、World Core、PostgreSQL 或公开合同；发现问题按上述交接格式提交给 Codex。

## 10. 最终完成定义

“Unity 有一个能打开的项目”不算完成。

Unity 工作流最终完成必须证明：

- 正式 Unity Player 连接真实 Luoxia Server；
- 完成 Session 建立与 resync；
- 完成真实 NPC 多轮对话；
- 不重复 command、turn 或 ServerEnvelope；
- 动态场景由服务端视图与表现消息驱动；
- Stage 生命周期、输入与 outcome proposal 闭合；
- AssetBinding 与摘要校验闭合；
- 断线、过期 basis、sequence gap、未知消息和模型 ambiguous 均明确处理；
- Unity 从未拥有或直接修改 WorldState；
- 无具体世界、人物、剧情和内容包硬编码；
- 所有跨边界 JSON 以 `contracts/*.schema.json` 为唯一机器真相。
