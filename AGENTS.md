# Agent 约束

## 禁止

- **禁止测试工程**：不得创建 `tests/`、`test_*`、pytest、jest、vitest、测试夹具或冒烟脚本。验证只运行现有构建、一次性只读 JSON/Schema 校验、静态检查与人工试用；验证代码不得提交进仓库。
- **禁止硬编码内容**：World Core、协议、GDJS Host 不得出现具体世界名、人物名、剧情、功法、地点、货币或内容包分支。协议版本、闭合的通用 `EffectOp`、错误码与安全上限属于引擎合同，不属于内容硬编码。
- **禁止第二真相**：每类事实只能有一个正式所有者。外部内容包直接维护的 ContentBundle JSON 是当前唯一内容源；缓存、索引、转换结果与文档不得反向成为源文件。
- **禁止内容越权**：ContentBundle JSON 可以引用公开内容合同，但不得携带 EffectOp、WorldState 写入、模型供应商配置、GDJS 内部对象或存档迁移命令。
- **禁止旧项目迁移**：不得依赖或复制 QingYun、LuoXia、GameCastle 的业务代码、对象模型、兼容层或存档格式。GDJS 使用固定的官方运行时；旧仓库只可作为设计经验来源。
- **禁止重复门禁**：同一份未变化的产物不得反复全量验证；不得把每次措辞或局部调整升级成完整交付审计。
- **禁止临时代码**：禁止 TODO、FIXME、NotImplemented、占位数据、空 Handler、假 Provider、假插件、内存数据库、固定返回值、「先跑起来以后再改」的旁路，以及兼容旧接口。
- **禁止第二套协议模型**：不得再建立 Zod、Pydantic、class-validator、手写 DTO 等第二套字段真相；外部输入、模型输出、插件输出、GDJS 消息一律是不可信 JSON，必须先经 SchemaRegistry。
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
gdjs-host         → contracts-runtime/portable
```

额外要求：

- World Core 禁止 import 数据库、HTTP 框架、模型 Provider、GDJS、插件实现或具体内容。
- GDJS Host 禁止 import World Core。
- 浏览器侧只能引用 `@luoxia/contracts-runtime/portable`，禁止加载 Node 的 `fs` / `crypto` 实现。
- 普通业务只能 import `@luoxia/world-core`。
- 只有组合根可以 import `@luoxia/world-core/composition`。

## 接口纪律

- Content Pack 只依赖公开合同；World Core 不反向 import 具体内容包。
- 引擎只按 `contracts/content-bundle.v1.schema.json` 校验并加载外部 ContentBundle JSON；当前不维护 Excel、CSV、ContentDesignIR 或内容编辑器转换链。
- 模型、RulePlugin、StageModule、GDJS、客户端与资产流水线都不能直接写 World State。
- 只有 World Core 的 `applyPacket` 可以改变世界；`apply_packet` 是唯一权威写入口，只接收验证后的 `ContentPacket`，整包原子提交或完整拒绝。
- `ContentPacket` 只含前置条件、确定性输入与闭合 `EffectOp`；唯一例外是 `EventCardPublishOp` 内经裁决封存的惰性 `EventResultPresentation`，且 NPC 原话只能引用既有 `DialogueTurn`。它不参与规则求值；资产路径与 GDJS 指令不得混入。
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
2. 每次只实现一个明确模块；严格沿用现有骨架完善叶子实现，不得重新设计架构。
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
8. 具体模型 Provider、RulePlugin ABI、GDJS / StageModule 适配器

## 不可自行决定

遇到以下问题只报告缺口并停止，不得由实现 Agent 自行选定：

- PostgreSQL 18.x + node-postgres 是 v1 唯一的 `AtomicPacketStore`；禁止 ORM、内存库、默认连接串、自动重试、运行时建表或 migration runner
- RulePlugin / StageModule 的制品 ABI
- 固定 GDJS 版本
- 模型供应商、重试、超时和缓存策略
- 编排任务崩溃恢复策略
- Token / 签名 / TTL 规则
- DecimalString 精度和账本铸造规则
- 新协议字段或 EffectOp 类型

## 轻量工作流

- 设计阶段先对齐决策，不把每次讨论或小改都当成交付里程碑。
- 一个稳定里程碑只做一次与风险相称的总体验证；后续小改只检查受影响部分。
- 普通、可逆、低风险工作允许 Writer 自检，不强制独立验证 Agent 与独立审计 Agent。
- `sol-os`、多 Agent 双审和 writer/test/audit 接力不是默认流程；仅在用户明确要求，或存在安全、数据损坏、不可逆迁移、外部发布等具体高风险时启用。
- 若检查发现问题，修复后只复查问题及其直接影响面；只有核心合同整体变化才重新做一次总验。
- 已有充分证据即可停止，不为流程完整感继续重复检查。
- 不新建测试工程，验证证据留在任务输出，不写入仓库。
